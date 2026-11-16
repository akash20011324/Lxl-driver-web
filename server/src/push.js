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
    const row = db.prepare('SELECT pushToken FROM users WHERE id = ?').get(driverId);
    token = row ? row.pushToken : null;
  } catch (err) {
    console.error('[push] failed to read push token:', err.message);
    return;
  }
  if (!token || !Expo.isExpoPushToken(token)) return;

  try {
    const chunks = expo.chunkPushNotifications([{ to: token, title, body, sound: 'default', priority: 'high', channelId: 'lxl-default', data: { type } }]);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
  } catch (err) {
    console.error('[push] Expo send failed (non-fatal):', err.message);
  }
}
