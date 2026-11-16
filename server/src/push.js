// Expo Push notifications + in-app notification feed.
// Contract §3: when a request is decided, a dispatch message is sent, or a
// load is assigned, send an Expo push to the affected driver's registered
// push token (if any). The in-app feed row is always recorded.
import { Expo } from 'expo-server-sdk';
import { now } from './db.js';

const expo = new Expo();

/**
 * Record a notification for a driver and, if they have a valid Expo push
 * token, send the push. Never throws — push delivery must not break the
 * request that triggered it.
 */
export async function notifyDriver(db, driverId, type, title, body) {
  try {
    db.prepare(
      'INSERT INTO notifications (driverId, type, title, body, createdAt, read) VALUES (?, ?, ?, ?, ?, 0)',
    ).run(driverId, type, title, body, now());
  } catch (err) {
    console.error('[push] failed to record notification:', err.message);
    return;
  }

  let token = null;
  try {
    const row = db.prepare('SELECT pushToken, pushSound FROM users WHERE id = ?').get(driverId);
    token = row ? row.pushToken : null;
    var pushSound = row && row.pushSound ? String(row.pushSound) : null;
  } catch (err) {
    console.error('[push] failed to read push token:', err.message);
    return;
  }
  if (!token) {
    console.log('[push] driver ' + driverId + ' has NO push token — in-app notification only');
    return;
  }
  if (!Expo.isExpoPushToken(token)) {
    console.log('[push] driver ' + driverId + ' push token is not a valid Expo token — in-app only');
    return;
  }

  try {
    const chunks = expo.chunkPushNotifications([{ to: token, title, body, sound: pushSound ? pushSound + '.wav' : 'default', priority: 'high', channelId: pushSound ? 'lxl-' + pushSound : 'lxl-default', data: { type } }]);
    for (const chunk of chunks) {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      console.log('[push] tickets for driver ' + driverId + ': ' + JSON.stringify(tickets));
      const ids = (tickets || []).filter(t => t && t.status === 'ok' && t.id).map(t => t.id);
      if (ids.length) {
        // Delivery receipts land a few seconds later; log any APNs-level
        // error (DeviceNotRegistered, InvalidCredentials, ...) so a
        // silent phone can be diagnosed from the server logs.
        setTimeout(async () => {
          try {
            const receipts = await expo.getPushNotificationReceiptsAsync(ids);
            console.log('[push] receipts for driver ' + driverId + ': ' + JSON.stringify(receipts));
          } catch (e) {
            console.error('[push] receipt check failed:', e.message);
          }
        }, 5000);
      }
    }
  } catch (err) {
    console.error('[push] Expo send failed (non-fatal):', err.message);
  }
}
