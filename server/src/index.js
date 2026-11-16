// LXL Driver backend API — contract: ~/workspace/lxl-driver-native/API_CONTRACT.md
// Plain JavaScript (ESM), Node + Express, node:sqlite storage.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, now, withTransaction, getMeta, demoAvailable, deactivateDemo, normalizePhone } from './db.js';
import { seedDemo } from './seed.js';
import { seedRealFleet } from './seed-fleet.js';
import { notifyDriver } from './push.js';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker } from 'tesseract.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const db = openDb(DATA_DIR);

// Web build only: on a fresh database (no drivers, trucks, trailers or
// loads yet), seed the real LXL fleet so a fresh deploy is one-click.
// Opt out with SEED_REAL_FLEET=0 (e.g. when running the native smoke test,
// which expects an empty fleet for its demo seed).
if (process.env.SEED_REAL_FLEET !== '0') {
  const fleetEmpty =
    db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'driver'").get().c === 0 &&
    db.prepare('SELECT COUNT(*) AS c FROM trucks').get().c === 0 &&
    db.prepare('SELECT COUNT(*) AS c FROM trailers').get().c === 0 &&
    db.prepare('SELECT COUNT(*) AS c FROM loads').get().c === 0;
  if (fleetEmpty) {
    const { inserted } = seedRealFleet(db);
    console.log(`Real fleet seeded: ${inserted.join(', ')}`);
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const err = (res, status, message) => res.status(status).json({ error: message });

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    role: u.role,
    name: u.name,
    email: u.email,
    phone: u.phone ?? null,
    photoUrl: u.photoUrl ?? null,
    emergencyContact: u.emergencyContact ?? null,
    active: !!u.active,
    isMainAdmin: !!u.isMainAdmin,
    adminKind: u.adminKind || 'dispatcher',
    createdAt: u.createdAt,
  };
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, userId, createdAt) VALUES (?, ?, ?)').run(token, userId, now());
  return token;
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getDriverName(driverId) {
  const row = db.prepare('SELECT name FROM users WHERE id = ?').get(driverId);
  return row ? row.name : null;
}

// Unit number for a truck/trailer: by the load's own assignment when it
// has one, else by the driver's current assignment (table is an internal
// constant — 'trucks' or 'trailers' — never user input).
function unitNumberOf(table, id, driverId) {
  if (id) {
    const r = db.prepare(`SELECT unitNumber FROM ${table} WHERE id = ?`).get(id);
    if (r) return r.unitNumber;
  }
  if (driverId) {
    const r = db.prepare(`SELECT unitNumber FROM ${table} WHERE driverId = ?`).get(driverId);
    if (r) return r.unitNumber;
  }
  return null;
}

function serializeTruck(t) {
  if (!t) return null;
  return {
    id: t.id,
    unitNumber: t.unitNumber,
    make: t.make ?? null,
    model: t.model ?? null,
    year: t.year ?? null,
    plate: t.plate ?? null,
    vin: t.vin ?? null,
    status: t.status,
    yardStatus: t.yardStatus,
    driverId: t.driverId ?? null,
    driverName: t.driverId ? getDriverName(t.driverId) : null,
    odometerMi: t.odometerMi ?? null,
    odometerUpdatedAt: t.odometerUpdatedAt ?? null,
    engineHours: t.engineHours ?? null,
  };
}

function serializeTrailer(t) {
  if (!t) return null;
  return {
    id: t.id,
    unitNumber: t.unitNumber,
    kind: t.kind ?? null,
    make: t.make ?? null,
    model: t.model ?? null,
    year: t.year ?? null,
    plate: t.plate ?? null,
    vin: t.vin ?? null,
    status: t.status,
    yardStatus: t.yardStatus,
    driverId: t.driverId ?? null,
    driverName: t.driverId ? getDriverName(t.driverId) : null,
  };
}

function serializeLoad(l) {
  if (!l) return null;
  return {
    id: l.id,
    reference: l.reference,
    driverId: l.driverId,
    driverName: getDriverName(l.driverId),
    pickupLocation: l.pickupLocation,
    pickupWarehouse: l.pickupWarehouse ?? null,
    pickupAt: l.pickupAt,
    pickupTimezone: l.pickupTimezone,
    pickupNumber: l.pickupNumber ?? null,
    deliveryLocation: l.deliveryLocation,
    deliveryWarehouse: l.deliveryWarehouse ?? null,
    deliveryAt: l.deliveryAt,
    deliveryTimezone: l.deliveryTimezone,
    deliveryNumber: l.deliveryNumber ?? null,
    notes: l.notes ?? null,
    status: l.status,
    bolStatus: l.bolStatus ?? null,
    completedAt: l.completedAt ?? null,
    truckUnit: unitNumberOf('trucks', l.truckId, l.driverId),
    trailerUnit: unitNumberOf('trailers', l.trailerId, l.driverId),
    progress: loadProgress(l),
  };
}

function serializeDocument(d) {
  return {
    id: d.id,
    kind: d.kind,
    loadId: d.loadId ?? null,
    category: d.category ?? null,
    label: d.label ?? null,
    amountCents: d.amountCents ?? null,
    filename: d.originalFilename,
    mimeType: d.mimeType,
    url: `/files/${d.fileId}`,
    createdAt: d.createdAt,
    driverId: d.driverId,
    driverName: getDriverName(d.driverId),
  };
}

function serializeRequest(r) {
  return {
    id: r.id,
    driverId: r.driverId,
    driverName: getDriverName(r.driverId),
    type: r.type,
    amountCents: r.amountCents ?? null,
    reason: r.reason,
    details: r.details ?? null,
    truckId: r.truckId ?? null,
    status: r.status,
    adminNote: r.adminNote ?? null,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt ?? null,
  };
}

function serializeMessage(m) {
  let attachment = null;
  if (m.fileId) {
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(m.fileId);
    if (f) {
      attachment = {
        fileId: f.id,
        filename: f.originalFilename,
        mimeType: f.mimeType,
        url: `/files/${f.id}`,
      };
    }
  }
  return {
    id: m.id,
    driverId: m.driverId,
    sender: m.sender,
    senderName: m.senderName ?? null,
    body: m.body,
    createdAt: m.createdAt,
    read: !!m.read,
    delivered: !!m.deliveredAt,
    attachment,
  };
}

// Admin bell feed: one row per event the admins should see (driver
// message, document upload, request, load completed, rate con added).
// Written by notifyAdmins at each event site; never throws.
function notifyAdmins(type, title, body, view, refId) {
  try {
    db.prepare(
      'INSERT INTO admin_notifications (type, title, body, view, refId, createdAt, read) VALUES (?, ?, ?, ?, ?, ?, 0)',
    ).run(type, title, body ?? null, view ?? null, refId ?? null, now());
  } catch (e) {
    console.error('[notify] admin notification failed:', e.message);
  }
}

function serializeAdminNotification(n) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body ?? null,
    view: n.view ?? null,
    refId: n.refId ?? null,
    createdAt: n.createdAt,
    read: !!n.read,
  };
}

// Per-user chat wallpaper (WhatsApp-style): each admin and driver can
// set their own chat background picture.
function chatWallpaperUrlFor(user) {
  return user && user.chatWallpaperFileId ? `/files/${user.chatWallpaperFileId}` : null;
}

function setChatWallpaper(req, res) {
  if (!req.file) return err(res, 400, 'file is required');
  const fileId = insertFileRow(req.file, 'chat_wallpaper', null, req.user.id);
  db.prepare('UPDATE users SET chatWallpaperFileId = ? WHERE id = ?').run(fileId, req.user.id);
  res.json({ url: `/files/${fileId}` });
}

function serializeEquipmentDoc(d) {
  return {
    id: d.id,
    unitType: d.unitType,
    unitId: d.unitId,
    unitNumber: d.unitNumber,
    docType: d.docType,
    note: d.note ?? null,
    expiryDate: d.expiryDate ?? null,
    issuedDate: d.issuedDate ?? null,
    filename: d.originalFilename,
    mimeType: d.mimeType,
    url: `/files/${d.fileId}`,
    createdAt: d.createdAt,
  };
}

function serializeDriverDoc(d) {
  return {
    id: d.id,
    driverId: d.driverId,
    driverName: d.driverName,
    docType: d.docType,
    note: d.note ?? null,
    expiryDate: d.expiryDate ?? null,
    issuedDate: d.issuedDate ?? null,
    filename: d.originalFilename,
    mimeType: d.mimeType,
    url: `/files/${d.fileId}`,
    createdAt: d.createdAt,
  };
}

function serializeRateCon(r) {
  return {
    id: r.id,
    reference: r.reference,
    loadId: r.loadId ?? null,
    broker: r.broker ?? null,
    pickupState: r.pickupState,
    deliveryState: r.deliveryState,
    pickupDate: r.pickupDate,
    deliveryDate: r.deliveryDate,
    rateCents: r.rateCents ?? null,
    filename: r.originalFilename ?? null,
    mimeType: r.mimeType ?? null,
    url: r.fileId ? `/files/${r.fileId}` : null,
    createdAt: r.createdAt,
  };
}

function serializeNotification(n) {
  return {
    id: n.id,
    driverId: n.driverId,
    type: n.type,
    title: n.title,
    body: n.body,
    createdAt: n.createdAt,
    read: !!n.read,
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return err(res, 401, 'Authentication required');
  const row = db
    .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.userId WHERE s.token = ?')
    .get(m[1]);
  if (!row) return err(res, 401, 'Invalid or expired session');
  if (!row.active) return err(res, 403, 'Account is deactivated');
  req.user = row;
  req.token = m[1];
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) return err(res, 403, 'Forbidden');
    next();
  };
}

const requireAdmin = requireRole('admin');

// Only the main admin (the owner, first admin account) can manage admin
// accounts. Dispatchers can do everything else in the portal.
const requireMainAdmin = (req, res, next) => {
  if (req.user.role !== 'admin' || !req.user.isMainAdmin)
    return err(res, 403, 'Only the main admin can manage admin accounts');
  next();
};

// Admin accounts are managed by the main admin (owner) or by an admin whose
// kind is 'admin'. Dispatchers (adminKind 'dispatcher') cannot manage them.
const requireAdminManager = (req, res, next) => {
  if (req.user.role !== 'admin' || !(req.user.isMainAdmin || req.user.adminKind === 'admin'))
    return err(res, 403, 'Only the main admin or an admin can manage admin accounts');
  next();
};
const requireDriver = requireRole('driver');

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '');
      cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function insertFileRow(file, ownerType, ownerId, driverId) {
  return db
    .prepare(
      'INSERT INTO files (storedFilename, originalFilename, mimeType, ownerType, ownerId, driverId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      file.filename,
      file.originalname,
      file.mimetype,
      ownerType,
      ownerId ?? null,
      driverId ?? null,
      now(),
    ).lastInsertRowid;
}

function getFileRow(id) {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id);
}

// ---------------------------------------------------------------------------
// Setup / auth (no token unless noted)
// ---------------------------------------------------------------------------
app.get('/api/setup/status', (_req, res) => {
  const needsSetup = !db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
  const driverCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'driver'").get().c;
  res.json({ needsSetup, driverCount });
});

app.post('/api/setup/admin', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return err(res, 400, 'name, email and password are required');
  if (typeof password !== 'string' || password.length < 8)
    return err(res, 400, 'Password must be at least 8 characters');
  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get())
    return err(res, 409, 'An admin account already exists');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email))
    return err(res, 409, 'Email is already in use');
  const ts = now();
  const id = db
    .prepare("INSERT INTO users (role, name, email, passwordHash, isMainAdmin, active, createdAt) VALUES ('admin', ?, ?, ?, 1, 1, ?)")
    .run(name, email, bcrypt.hashSync(password, 10), ts).lastInsertRowid;
  const user = getUserById(id);
  res.status(201).json({ user: publicUser(user), token: createSession(id) });
});

// Microsoft redirects here after an admin signs in to Outlook. The
// sign-in is started from the Rate Confirmations page; the state value
// ties the callback to the admin who started it.
app.get('/api/outlook/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query || {};
  const safe = (s) => String(s || '').replace(/[<>&"]/g, '');
  const fail = (msg) =>
    res.status(400).send(`<h1>Outlook connection failed</h1><p>${safe(msg)}</p><p><a href="/">Back to LXL Driver</a></p>`);
  if (error) return fail(error_description || error);
  const pending = state ? db.prepare('SELECT userId, createdAt FROM outlook_states WHERE state = ?').get(state) : null;
  if (!pending || Date.now() - pending.createdAt > OUTLOOK_STATE_TTL_MS) {
    if (state) db.prepare('DELETE FROM outlook_states WHERE state = ?').run(state);
    return fail('This sign-in link expired — start again from the Rate Confirmations page.');
  }
  db.prepare('DELETE FROM outlook_states WHERE state = ?').run(state);
  try {
    const tokens = await outlookTokenRequest({
      client_id: OUTLOOK_CLIENT_ID,
      client_secret: OUTLOOK_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: OUTLOOK_REDIRECT_URI,
      scope: OUTLOOK_SCOPES,
    });
    if (!tokens.refresh_token) return fail('Microsoft did not return a lasting connection — try again.');
    const me = await outlookGraph(tokens.access_token, '/me?$select=mail,userPrincipalName');
    const email = me.mail || me.userPrincipalName || null;
    db.prepare('UPDATE users SET outlookRefreshToken = ?, outlookEmail = ?, outlookConnectedAt = ? WHERE id = ?').run(
      tokens.refresh_token,
      email,
      now(),
      pending.userId,
    );
    res.redirect('https://app.lubanaxpress.com/');
  } catch (e) {
    console.error('outlook callback failed', e);
    return fail('Microsoft sign-in failed — try again from the Rate Confirmations page.');
  }
});

app.post('/api/auth/login', (req, res) => {
  // Drivers sign in with a phone number OR an email, plus password.
  // Admins sign in with email only (admins have no phone on file).
  // `identifier` is the current field; `email` is still accepted.
  const { identifier, email, password } = req.body || {};
  const raw = identifier ?? email;
  if (!raw || !password) return err(res, 400, 'phone number or email and password are required');
  const value = String(raw).trim();
  let user = null;
  if (value.includes('@')) {
    user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(value);
  } else {
    const digits = normalizePhone(value);
    if (digits) user = db.prepare('SELECT * FROM users WHERE phoneNormalized = ?').get(digits);
  }
  if (!user || !bcrypt.compareSync(password, user.passwordHash))
    return err(res, 401, 'Invalid phone number, email or password');
  if (!user.active) return err(res, 403, 'Account is deactivated');
  // A driver signing in is heading out: their truck and trailer move to
  // On the Road on their own (owner's rule, 2026-11-15).
  if (user.role === 'driver') {
    try {
      db.prepare("UPDATE trucks SET yardStatus = 'road' WHERE driverId = ?").run(user.id);
      db.prepare("UPDATE trailers SET yardStatus = 'road' WHERE driverId = ?").run(user.id);
    } catch { /* never block a sign-in */ }
  }
  res.json({ user: publicUser(user), token: createSession(user.id) });
});

app.post('/api/auth/logout', auth, (req, res) => {
  // A driver signing out is off duty and back at the yard: their truck and
  // trailer move to In the Yard on their own (owner's rule, 2026-11-15).
  if (req.user && req.user.role === 'driver') {
    try {
      const t = db.prepare("UPDATE trucks SET yardStatus = 'yard' WHERE driverId = ? AND yardStatus != 'yard'").run(req.user.id);
      db.prepare("UPDATE trailers SET yardStatus = 'yard' WHERE driverId = ?").run(req.user.id);
      if (t.changes) {
        const truck = db.prepare('SELECT unitNumber FROM trucks WHERE driverId = ?').get(req.user.id);
        notifyAdmins('equipment', 'Truck back in the yard', (req.user.name || 'A driver') + ' signed out — truck ' + (truck ? truck.unitNumber : '') + ' moved to In the Yard.').catch(() => {});
      }
    } catch { /* never block a sign-out */ }
  }
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json(publicUser(req.user));
});

// Change password — admin only. Drivers cannot change their own password;
// only an admin can set a driver's password (POST /api/admin/drivers/:id/password).
app.post('/api/auth/change-password', auth, requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return err(res, 400, 'currentPassword and newPassword are required');
  if (typeof newPassword !== 'string' || newPassword.length < 8)
    return err(res, 400, 'New password must be at least 8 characters');
  if (!bcrypt.compareSync(currentPassword, req.user.passwordHash))
    return err(res, 401, 'Current password is incorrect');
  db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), req.user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------
app.get('/api/demo/info', (_req, res) => {
  const available = demoAvailable(db);
  let demoDriverName = null;
  let demoDriverPhone = null;
  if (available) {
    const row = db.prepare("SELECT name, phone FROM users WHERE isDemo = 1 AND role = 'driver' LIMIT 1").get();
    demoDriverName = row ? row.name : null;
    demoDriverPhone = row ? row.phone ?? null : null;
  }
  res.json({ demoAvailable: available, demoDriverName, demoDriverPhone });
});

app.post('/api/demo/enter', (req, res) => {
  const { role } = req.body || {};
  if (role !== 'driver') return err(res, 400, 'role must be "driver"');
  if (!demoAvailable(db)) return err(res, 403, 'Demo mode is no longer available');
  const demo = db.prepare("SELECT * FROM users WHERE isDemo = 1 AND role = 'driver' AND active = 1 LIMIT 1").get();
  if (!demo) return err(res, 403, 'Demo mode is no longer available');
  res.json({ user: publicUser(demo), token: createSession(demo.id) });
});

app.post('/api/admin/seed-demo', auth, requireAdmin, (req, res) => {
  const fleetEmpty =
    db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'driver'").get().c === 0 &&
    db.prepare('SELECT COUNT(*) AS c FROM trucks').get().c === 0 &&
    db.prepare('SELECT COUNT(*) AS c FROM trailers').get().c === 0 &&
    db.prepare('SELECT COUNT(*) AS c FROM loads').get().c === 0;
  if (!fleetEmpty) return res.json({ seeded: false });
  seedDemo(db, UPLOADS_DIR);
  res.json({ seeded: true });
});

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
const driver = express.Router();
driver.use(auth, requireDriver);

driver.get('/home', (req, res) => {
  const truck = db.prepare('SELECT * FROM trucks WHERE driverId = ?').get(req.user.id);
  const trailer = db.prepare('SELECT * FROM trailers WHERE driverId = ?').get(req.user.id);
  const activeLoad = db
    .prepare("SELECT * FROM loads WHERE driverId = ? AND status = 'active' ORDER BY createdAt DESC LIMIT 1")
    .get(req.user.id);
  const pendingRequests = db
    .prepare("SELECT COUNT(*) AS c FROM requests WHERE driverId = ? AND status = 'pending'")
    .get(req.user.id).c;
  const unreadMessages = db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE driverId = ? AND sender = 'dispatch' AND read = 0")
    .get(req.user.id).c;
  res.json({
    truck: serializeTruck(truck),
    trailer: serializeTrailer(trailer),
    activeLoad: serializeLoad(activeLoad),
    pendingRequests,
    unreadMessages,
  });
});

driver.get('/loads/active', (req, res) => {
  const load = db
    .prepare("SELECT * FROM loads WHERE driverId = ? AND status = 'active' ORDER BY createdAt DESC LIMIT 1")
    .get(req.user.id);
  res.json(serializeLoad(load));
});

driver.get('/loads/history', (req, res) => {
  const rows = db
    .prepare("SELECT * FROM loads WHERE driverId = ? AND status != 'active' ORDER BY createdAt DESC")
    .all(req.user.id);
  res.json(rows.map(serializeLoad));
});

driver.post('/loads/:id/complete', async (req, res) => {
  try {
    const load = db.prepare('SELECT * FROM loads WHERE id = ? AND driverId = ?').get(req.params.id, req.user.id);
    if (!load) return err(res, 404, 'Load not found');
    if (load.status !== 'active') return err(res, 400, 'Only an active load can be completed');
    // Gate 1: the BOL result must be marked first.
    if (!load.bolStatus) return err(res, 400, 'Mark the BOL result first — tap Clean BOL or Wrong BOL.');
    // Gate 2: the driver must be at the delivery location.
    const coords = await ensureDeliveryCoords(load);
    if (coords) {
      const { latitude, longitude } = req.body || {};
      let here = null;
      let hereAt = null;
      if (typeof latitude === 'number' && typeof longitude === 'number' && Number.isFinite(latitude) && Number.isFinite(longitude)) {
        here = { lat: latitude, lng: longitude };
      } else {
        const loc = db.prepare('SELECT * FROM locations WHERE driverId = ?').get(req.user.id);
        if (loc) {
          here = { lat: loc.lat, lng: loc.lng };
          hereAt = loc.updatedAt;
        }
      }
      if (!here) return err(res, 400, 'No location yet — open the app so it reports your position, then try again.');
      if (hereAt && Date.now() - new Date(hereAt).getTime() > LOCATION_FRESH_MS)
        return err(res, 400, 'Your location is stale — open the app so it reports your position, then try again.');
      const d = distanceMeters(here.lat, here.lng, coords.lat, coords.lng);
      if (d > DELIVERY_GEOFENCE_M)
        return err(res, 400, `You're ${formatDistance(d)} from the delivery location — complete the load once you've arrived at ${load.deliveryLocation}.`);
    }
    withTransaction(db, () => {
      db.prepare("UPDATE loads SET status = 'completed', completedAt = ? WHERE id = ?").run(now(), load.id);
      // Unit is back in the yard once the load is done.
      db.prepare("UPDATE trucks SET yardStatus = 'yard' WHERE driverId = ?").run(req.user.id);
      db.prepare("UPDATE trailers SET yardStatus = 'yard' WHERE driverId = ?").run(req.user.id);
    });
    notifyAdmins('load', `${req.user.name} completed ${load.reference}`, `${load.pickupLocation} → ${load.deliveryLocation}`, 'loads', load.id);
    res.json(serializeLoad(db.prepare('SELECT * FROM loads WHERE id = ?').get(load.id)));
  } catch (e) {
    console.error('complete load failed', e);
    return err(res, 500, 'Could not complete the load');
  }
});

driver.post('/loads/:id/bol-status', (req, res) => {
  const { status } = req.body || {};
  if (status !== 'clean' && status !== 'wrong') return err(res, 400, 'status must be "clean" or "wrong"');
  const load = db.prepare('SELECT * FROM loads WHERE id = ? AND driverId = ?').get(req.params.id, req.user.id);
  if (!load) return err(res, 404, 'Load not found');
  db.prepare('UPDATE loads SET bolStatus = ? WHERE id = ?').run(status, load.id);
  res.json(serializeLoad(db.prepare('SELECT * FROM loads WHERE id = ?').get(load.id)));
});

driver.get('/trucks/for-request', (_req, res) => {
  res.json(db.prepare('SELECT * FROM trucks ORDER BY unitNumber').all().map(serializeTruck));
});

driver.post('/trucks/request-change', (req, res) => {
  const { truckId, reason } = req.body || {};
  if (!truckId || !reason) return err(res, 400, 'truckId and reason are required');
  const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(truckId);
  if (!truck) return err(res, 404, 'Truck not found');
  if (truck.driverId === req.user.id) return err(res, 400, 'That truck is already assigned to you');
  const ts = now();
  const id = db
    .prepare(
      "INSERT INTO requests (driverId, type, reason, details, truckId, status, createdAt) VALUES (?, 'unit_change', ?, ?, ?, 'pending', ?)",
    )
    .run(req.user.id, reason, `Requested truck ${truck.unitNumber}`, truckId, ts).lastInsertRowid;
  res.status(201).json(serializeRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(id)));
});

driver.get('/trailers/available', (req, res) => {
  const rows = db.prepare("SELECT * FROM trailers WHERE status = 'active' ORDER BY unitNumber").all();
  res.json(
    rows.map((t) => {
      const s = serializeTrailer(t);
      s.isOwn = t.driverId === req.user.id;
      return s;
    }),
  );
});

// Trailer change is immediate, no admin approval — but the check-and-set must
// be atomic so two drivers grabbing the same trailer cannot both succeed.
driver.post('/trailers/change', (req, res) => {
  const { trailerId } = req.body || {};
  if (!trailerId) return err(res, 400, 'trailerId is required');
  let result;
  try {
    result = withTransaction(db, () => {
      const trailer = db.prepare('SELECT * FROM trailers WHERE id = ?').get(trailerId);
      if (!trailer) return { status: 404, error: 'Trailer not found' };
      if (trailer.status !== 'active') return { status: 400, error: 'Trailer is not active' };
      if (trailer.driverId && trailer.driverId !== req.user.id)
        return { status: 409, error: 'Trailer was just taken by another driver' };
      if (trailer.driverId === req.user.id)
        return { status: 200, trailer: serializeTrailer(trailer) };
      db.prepare('UPDATE trailers SET driverId = NULL WHERE driverId = ?').run(req.user.id);
      db.prepare('UPDATE trailers SET driverId = ? WHERE id = ?').run(req.user.id, trailerId);
      return { status: 200, trailer: serializeTrailer(db.prepare('SELECT * FROM trailers WHERE id = ?').get(trailerId)) };
    });
  } catch (e) {
    return err(res, 500, e.message);
  }
  if (result.error) return err(res, result.status, result.error);
  res.json(result.trailer);
});

driver.post('/trailers/release', (req, res) => {
  db.prepare('UPDATE trailers SET driverId = NULL WHERE driverId = ?').run(req.user.id);
  res.json({ ok: true });
});

driver.get('/requests', (req, res) => {
  const rows = db.prepare('SELECT * FROM requests WHERE driverId = ? ORDER BY createdAt DESC, id DESC').all(req.user.id);
  res.json(rows.map(serializeRequest));
});

const REQUEST_TYPES = ['advance', 'unit_change', 'time_off', 'reimbursement', 'other', 'truck_problem'];

driver.post('/requests', (req, res) => {
  const { type, amountCents, reason, details, truckId } = req.body || {};
  if (!REQUEST_TYPES.includes(type)) return err(res, 400, 'Invalid request type');
  if (!reason) return err(res, 400, 'reason is required');
  if (type === 'unit_change' && truckId) {
    const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(truckId);
    if (!truck) return err(res, 404, 'Truck not found');
  }
  const ts = now();
  const id = db
    .prepare(
      'INSERT INTO requests (driverId, type, amountCents, reason, details, truckId, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(req.user.id, type, amountCents ?? null, reason, details ?? null, truckId ?? null, 'pending', ts).lastInsertRowid;
  notifyAdmins('request', `${req.user.name} sent a request`, `${type} — ${reason}`, 'requests', id);
  res.status(201).json(serializeRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(id)));
});

// Delete chat messages FOR EVERYONE (owner's rule, 2026-11-15): the rows
// and any attachment files go away for both sides of the thread.
function deleteMessagesForEveryone(rows) {
  if (!rows.length) return 0;
  const ids = rows.map(r => r.id);
  const fileIds = rows.map(r => r.fileId).filter(Boolean);
  db.prepare('DELETE FROM messages WHERE id IN (' + ids.map(() => '?').join(',') + ')').run(...ids);
  for (const fid of fileIds) {
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(fid);
    if (!f) continue;
    db.prepare('DELETE FROM files WHERE id = ?').run(fid);
    try {
      fs.unlinkSync(path.join(UPLOADS_DIR, f.storedFilename));
    } catch {
      // file already gone — ignore
    }
  }
  return ids.length;
}
// Delete-for-everyone window (owner's rule, 2026-11-15): a message can
// only be deleted for everyone within 7 minutes of being sent. After
// that it stays in the thread for both sides.
const DELETE_WINDOW_MS = 7 * 60 * 1000;
function pickMessageRows(driverId, ids) {
  const clean = (Array.isArray(ids) ? ids : []).map(Number).filter(n => Number.isFinite(n) && n > 0);
  if (!clean.length) return null;
  return db
    .prepare('SELECT * FROM messages WHERE driverId = ? AND id IN (' + clean.map(() => '?').join(',') + ')')
    .all(driverId, ...clean);
}
function splitDeletable(rows) {
  const fresh = [];
  let oldCount = 0;
  for (const r of rows) {
    if (Date.now() - Date.parse(r.createdAt) <= DELETE_WINDOW_MS) fresh.push(r);
    else oldCount++;
  }
  return { fresh, oldCount };
}

driver.get('/messages', (req, res) => {
  // Fetching the thread means the messages reached this device
  // (delivered) and are now on screen (read).
  db.prepare("UPDATE messages SET deliveredAt = ? WHERE driverId = ? AND sender = 'dispatch' AND deliveredAt IS NULL").run(now(), req.user.id);
  db.prepare("UPDATE messages SET read = 1 WHERE driverId = ? AND sender = 'dispatch'").run(req.user.id);
  const rows = db.prepare('SELECT * FROM messages WHERE driverId = ? ORDER BY id ASC').all(req.user.id);
  res.json(rows.map(serializeMessage));
});

driver.post('/messages', (req, res) => {
  const { body } = req.body || {};
  if (!body || !String(body).trim()) return err(res, 400, 'body is required');
  const id = db
    .prepare("INSERT INTO messages (driverId, sender, senderName, body, createdAt, read) VALUES (?, 'driver', ?, ?, ?, 0)")
    .run(req.user.id, req.user.name, String(body).trim(), now()).lastInsertRowid;
  const text = String(body).trim();
  notifyAdmins('message', `New message from ${req.user.name}`, text.length > 90 ? text.slice(0, 90) + '…' : text, 'dispatch', req.user.id);
  res.status(201).json(serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id)));
});

// Driver sends a photo or file in the chat (multipart, field "file";
// optional caption in the "body" field).
driver.post('/messages/attachment', upload.single('file'), (req, res) => {
  if (!req.file) return err(res, 400, 'file is required');
  const caption = req.body && req.body.body ? String(req.body.body).trim() : '';
  const fileId = insertFileRow(req.file, 'message', null, req.user.id);
  const id = db
    .prepare("INSERT INTO messages (driverId, sender, senderName, body, createdAt, read, fileId) VALUES (?, 'driver', ?, ?, ?, 0, ?)")
    .run(req.user.id, req.user.name, caption, now(), fileId).lastInsertRowid;
  const isImage = String(req.file.mimetype || '').startsWith('image/');
  notifyAdmins('message', `New message from ${req.user.name}`, caption || (isImage ? '📎 Photo' : '📎 ' + (req.file.originalname || 'File')), 'dispatch', req.user.id);
  res.status(201).json(serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id)));
});

driver.delete('/messages', (req, res) => {
  const rows = pickMessageRows(req.user.id, (req.body || {}).ids);
  if (!rows) return err(res, 400, 'ids are required');
  const { fresh, oldCount } = splitDeletable(rows);
  if (!fresh.length) return err(res, 400, 'Messages older than 7 minutes can no longer be deleted for everyone.');
  res.json({ ok: true, deleted: deleteMessagesForEveryone(fresh), skippedOld: oldCount });
});

driver.get('/chat-wallpaper', (req, res) => {
  res.json({ url: chatWallpaperUrlFor(req.user) });
});

driver.post('/chat-wallpaper', upload.single('file'), setChatWallpaper);

driver.delete('/chat-wallpaper', (req, res) => {
  db.prepare('UPDATE users SET chatWallpaperFileId = NULL WHERE id = ?').run(req.user.id);
  res.json({ url: null });
});

driver.get('/documents', (req, res) => {
  const { loadId } = req.query;
  let rows;
  if (loadId) {
    rows = db
      .prepare('SELECT d.*, f.originalFilename, f.mimeType FROM documents d JOIN files f ON f.id = d.fileId WHERE d.driverId = ? AND d.loadId = ? ORDER BY d.createdAt DESC, d.id DESC')
      .all(req.user.id, loadId);
  } else {
    rows = db
      .prepare('SELECT d.*, f.originalFilename, f.mimeType FROM documents d JOIN files f ON f.id = d.fileId WHERE d.driverId = ? ORDER BY d.createdAt DESC, d.id DESC')
      .all(req.user.id);
  }
  res.json(rows.map(serializeDocument));
});

const DOC_KINDS = ['pickup_bol', 'delivery_bol', 'fuel_receipt', 'receipt', 'driver_doc', 'unit_picture', 'seal_picture'];

// Read the total off a receipt before it is uploaded: PDFs via pdf.js
// text, images via on-device-style OCR (tesseract.js). The file is
// read and discarded — nothing is stored. Always answers 200 with
// { amount } (null when nothing could be read) so the app can just
// leave the amount field blank for typing.
driver.post('/receipt-amount', upload.single('file'), async (req, res) => {
  if (!req.file) return res.json({ amount: null });
  const tmp = req.file.path;
  try {
    const buf = fs.readFileSync(tmp);
    let text = '';
    const isPdf = buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF';
    // JPEG FF D8 FF, PNG 89 50 4E 47 — anything else (empty, truncated
    // or an unknown format) never reaches tesseract: a bad image makes
    // its worker reject, and without an errorHandler that rejection is
    // re-thrown outside any promise chain and kills the whole Node
    // process (Render logs 2026-11-15: "Error attempting to read
    // image" + "truncated file", process exited, sign-ins 502'd).
    const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const isPng = buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (isPdf) {
      text = cleanRateText(await pdfTextFromBuffer(buf));
    } else if ((isJpeg || isPng) && buf.length > 1024) {
      // errorHandler is REQUIRED: without it, a rejected OCR job makes
      // tesseract's worker throw outside the promise chain and the
      // uncaught exception kills the server process.
      const worker = await createWorker('eng', undefined, {
        errorHandler: (e) => console.error('receipt-amount tesseract worker error', e),
      });
      try {
        const { data } = await worker.recognize(buf);
        text = cleanRateText(data.text || '');
      } finally {
        try {
          await worker.terminate();
        } catch {
          // already gone — ignore
        }
      }
    } else {
      console.log('receipt-amount', { bytes: buf.length, isPdf, textLen: 0, amount: null, skipped: 'unreadable-file' });
      return res.json({ amount: null });
    }
    const cents = detectReceiptTotalCents(text);
    // Log the outcome (never the file) so a missed total on a real
    // receipt can be diagnosed from the Render logs: textLen 0 on a
    // PDF means it has no text layer (image-only scan).
    console.log('receipt-amount', { bytes: buf.length, isPdf, textLen: text.length, amount: cents == null ? null : cents / 100 });
    res.json({ amount: cents == null ? null : cents / 100 });
  } catch (e) {
    console.error('receipt-amount failed', e);
    res.json({ amount: null });
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already gone — ignore
    }
  }
});

driver.post('/documents', upload.single('file'), (req, res) => {
  const { kind, loadId, category, label, amountCents } = req.body || {};
  if (!req.file) return err(res, 400, 'file is required');
  if (!DOC_KINDS.includes(kind)) return err(res, 400, 'Invalid document kind');
  let load = null;
  if (loadId) {
    load = db.prepare('SELECT * FROM loads WHERE id = ? AND driverId = ?').get(loadId, req.user.id);
    if (!load) return err(res, 404, 'Load not found');
  }
  const fileId = insertFileRow(req.file, 'document', null, req.user.id);
  const id = db
    .prepare(
      'INSERT INTO documents (kind, loadId, category, label, amountCents, fileId, driverId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      kind,
      load ? load.id : null,
      category ?? null,
      label ?? null,
      amountCents != null ? Number(amountCents) : null,
      fileId,
      req.user.id,
      now(),
    ).lastInsertRowid;
  const row = db
    .prepare('SELECT d.*, f.originalFilename, f.mimeType FROM documents d JOIN files f ON f.id = d.fileId WHERE d.id = ?')
    .get(id);
  const DOC_LABELS = {
    pickup_bol: 'a pickup BOL',
    delivery_bol: 'a delivery BOL',
    fuel_receipt: 'a fuel receipt',
    receipt: 'a receipt',
    unit_picture: 'a unit picture',
    seal_picture: 'a seal picture',
    driver_doc: 'a document',
  };
  notifyAdmins(
    'document',
    `${req.user.name} uploaded ${DOC_LABELS[kind] || 'a document'}`,
    load ? load.reference : null,
    'documents',
    load ? load.id : null,
  );
  res.status(201).json(serializeDocument(row));
});

// A driver can delete his own uploads (e.g. a wrong BOL page). The file
// row and the stored file go with it. If the last BOL page for a load is
// gone, the BOL result no longer stands — clear it so the load cannot be
// completed without a BOL on file.
driver.delete('/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return err(res, 404, 'Document not found');
  if (doc.driverId !== req.user.id) return err(res, 403, 'Forbidden');
  const file = getFileRow(doc.fileId);
  withTransaction(db, () => {
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    db.prepare('DELETE FROM files WHERE id = ?').run(doc.fileId);
    if ((doc.kind === 'pickup_bol' || doc.kind === 'delivery_bol') && doc.loadId) {
      const remaining = db
        .prepare("SELECT COUNT(*) AS n FROM documents WHERE loadId = ? AND kind IN ('pickup_bol', 'delivery_bol')")
        .get(doc.loadId).n;
      if (remaining === 0) {
        db.prepare('UPDATE loads SET bolStatus = NULL WHERE id = ?').run(doc.loadId);
      }
    }
  });
  if (file) {
    try {
      fs.unlinkSync(path.join(UPLOADS_DIR, file.storedFilename));
    } catch {
      // file already gone — ignore
    }
  }
  res.json({ ok: true });
});

driver.post('/photo', upload.single('photo'), (req, res) => {
  if (!req.file) return err(res, 400, 'photo is required');
  const fileId = insertFileRow(req.file, 'photo', null, req.user.id);
  const photoUrl = `/files/${fileId}`;
  db.prepare('UPDATE users SET photoUrl = ? WHERE id = ?').run(photoUrl, req.user.id);
  res.json({ photoUrl });
});

driver.post('/location', async (req, res) => {
  const { lat, lng, speedMph, heading } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng))
    return err(res, 400, 'lat and lng are required numbers');
  const speed = typeof speedMph === 'number' && Number.isFinite(speedMph) && speedMph >= 0 ? speedMph : null;
  const head = typeof heading === 'number' && Number.isFinite(heading) && heading >= 0 && heading < 360 ? heading : null;
  db.prepare('INSERT INTO locations (driverId, lat, lng, speedMph, heading, updatedAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(driverId) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, speedMph = excluded.speedMph, heading = excluded.heading, updatedAt = excluded.updatedAt')
    .run(req.user.id, lat, lng, speed, head, now());
  // The app is alive on the driver's phone and checking in — any
  // dispatch messages waiting count as delivered to the device.
  db.prepare("UPDATE messages SET deliveredAt = ? WHERE driverId = ? AND sender = 'dispatch' AND deliveredAt IS NULL").run(now(), req.user.id);
  // BOL departure reminder (owner's ask, 2026-11-15): if the driver was
  // at the pickup and then leaves/drives off WITHOUT uploading the
  // pickup BOL, push him once — "Please upload the BOL". State lives on
  // the load row so it fires exactly once per load.
  try {
    const load = db
      .prepare("SELECT * FROM loads WHERE driverId = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
      .get(req.user.id);
    if (load) {
      const coords = await ensurePickupCoords(load);
      if (coords) {
        const d = distanceMeters(lat, lng, coords.lat, coords.lng);
        if (d <= 500 && !load.pickupVisitedAt) {
          db.prepare('UPDATE loads SET pickupVisitedAt = ? WHERE id = ?').run(now(), load.id);
        } else if (load.pickupVisitedAt && !load.bolReminderAt && d > 800 && (speed == null || speed >= 5)) {
          const bol = db
            .prepare("SELECT COUNT(*) AS n FROM documents WHERE loadId = ? AND kind = 'pickup_bol'")
            .get(load.id);
          if (!bol || bol.n === 0) {
            db.prepare('UPDATE loads SET bolReminderAt = ? WHERE id = ?').run(now(), load.id);
            notifyDriver(
              db, req.user.id, 'bol_reminder', 'Please upload the BOL',
              'You left the pickup for load ' + load.reference + ' without uploading the BOL. Please upload the pickup BOL in the app.',
            ).catch(() => {});
          }
        }
      }
    }
  } catch (e) {
    console.error('bol reminder check failed', e);
  }
  res.json({ ok: true });
});

const PUSH_SOUNDS = ['note', 'glass'];
driver.get('/push-sound', (req, res) => {
  const row = db.prepare('SELECT pushSound FROM users WHERE id = ?').get(req.user.id);
  res.json({ sound: row && row.pushSound ? row.pushSound : null, options: PUSH_SOUNDS });
});
driver.post('/push-sound', (req, res) => {
  const s = (req.body || {}).sound;
  if (s !== null && !PUSH_SOUNDS.includes(s)) return err(res, 400, 'Unknown sound');
  db.prepare('UPDATE users SET pushSound = ? WHERE id = ?').run(s, req.user.id);
  res.json({ ok: true, sound: s });
});

driver.post('/push-token', (req, res) => {
  const { expoPushToken } = req.body || {};
  if (!expoPushToken || typeof expoPushToken !== 'string') return err(res, 400, 'expoPushToken is required');
  db.prepare('UPDATE users SET pushToken = ? WHERE id = ?').run(expoPushToken, req.user.id);
  res.json({ ok: true });
});

driver.get('/notifications', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM notifications WHERE driverId = ? ORDER BY createdAt DESC, id DESC')
    .all(req.user.id);
  res.json(rows.map(serializeNotification));
});

driver.post('/notification-prefs', (req, res) => {
  const { prefs } = req.body || {};
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs))
    return err(res, 400, 'prefs must be an object');
  db.prepare('UPDATE users SET notificationPrefs = ? WHERE id = ?').run(JSON.stringify(prefs), req.user.id);
  res.json({ ok: true });
});

driver.post('/profile', (req, res) => {
  const { phone, emergencyContact } = req.body || {};
  if (phone !== undefined && phone !== null && String(phone).trim() !== '') {
    const phoneNormalized = normalizePhone(phone);
    if (phoneNormalized) {
      const clash = db
        .prepare('SELECT 1 FROM users WHERE phoneNormalized = ? AND id != ?')
        .get(phoneNormalized, req.user.id);
      if (clash) return err(res, 409, 'Phone number is already in use');
    }
    db.prepare('UPDATE users SET phone = ?, phoneNormalized = ? WHERE id = ?').run(
      String(phone).trim(),
      normalizePhone(phone),
      req.user.id,
    );
  }
  db.prepare('UPDATE users SET emergencyContact = COALESCE(?, emergencyContact) WHERE id = ?')
    .run(emergencyContact ?? null, req.user.id);
  res.json(publicUser(getUserById(req.user.id)));
});

driver.get('/equipment-documents', (req, res) => {
  const { unitType, unitId } = req.query;
  if (unitType !== 'truck' && unitType !== 'trailer') return err(res, 400, 'unitType must be "truck" or "trailer"');
  if (!unitId) return err(res, 400, 'unitId is required');
  const table = unitType === 'truck' ? 'trucks' : 'trailers';
  const unit = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(unitId);
  if (!unit) return err(res, 404, 'Unit not found');
  if (unit.driverId !== req.user.id) return err(res, 403, 'That unit is not assigned to you');
  const rows = db
    .prepare(
      'SELECT e.*, f.originalFilename, f.mimeType FROM equipment_documents e JOIN files f ON f.id = e.fileId WHERE e.unitType = ? AND e.unitId = ? ORDER BY e.createdAt DESC, e.id DESC',
    )
    .all(unitType, unitId);
  res.json(rows.map(serializeEquipmentDoc));
});

app.use('/api/driver', driver);

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
const admin = express.Router();
admin.use(auth, requireAdmin);

admin.get('/overview', (_req, res) => {
  const drivers = db.prepare("SELECT * FROM users WHERE role = 'driver' ORDER BY name").all();
  res.json(
    drivers.map((d) => {
      const truck = db.prepare('SELECT * FROM trucks WHERE driverId = ?').get(d.id);
      const trailer = db.prepare('SELECT * FROM trailers WHERE driverId = ?').get(d.id);
      const location = db.prepare('SELECT * FROM locations WHERE driverId = ?').get(d.id);
      const pendingRequests = db
        .prepare("SELECT COUNT(*) AS c FROM requests WHERE driverId = ? AND status = 'pending'")
        .get(d.id).c;
      const unreadMessages = db
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE driverId = ? AND sender = 'driver' AND read = 0")
        .get(d.id).c;
      return {
        ...publicUser(d),
        truck: serializeTruck(truck),
        trailer: serializeTrailer(trailer),
        location: location
          ? { driverId: location.driverId, driverName: d.name, lat: location.lat, lng: location.lng, updatedAt: location.updatedAt }
          : null,
        pendingRequests,
        unreadMessages,
      };
    }),
  );
});

admin.get('/drivers', (_req, res) => {
  res.json(db.prepare("SELECT * FROM users WHERE role = 'driver' ORDER BY name").all().map(publicUser));
});

// Admins & dispatchers — any admin can add another Admin Portal login.
// Dispatchers sign in with email + password, same as the owner.
admin.get('/admins', requireAdminManager, (_req, res) => {
  res.json(db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY name").all().map(publicUser));
});

admin.post('/admins', requireAdminManager, (req, res) => {
  const { name, email, password, adminKind } = req.body || {};
  const kind = adminKind === 'admin' ? 'admin' : 'dispatcher';
  if (!name || !email || !password) return err(res, 400, 'name, email and password are required');
  if (typeof password !== 'string' || password.length < 8)
    return err(res, 400, 'Password must be at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(email))
    return err(res, 409, 'Email is already in use');
  const ts = now();
  const id = db
    .prepare("INSERT INTO users (role, name, email, passwordHash, active, createdAt, adminKind) VALUES ('admin', ?, ?, ?, 1, ?, ?)")
    .run(name, email, bcrypt.hashSync(password, 10), ts, kind).lastInsertRowid;
  res.status(201).json(publicUser(getUserById(id)));
});

// Remove an admin / dispatcher login. You cannot delete your own account,
// and the last active admin cannot be deleted.
admin.delete('/admins/:id', requireAdminManager, (req, res) => {
  const adminUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'admin'").get(req.params.id);
  if (!adminUser) return err(res, 404, 'Admin not found');
  if (adminUser.isMainAdmin) return err(res, 400, 'The main admin account cannot be deleted');
  if (adminUser.id === req.user.id) return err(res, 400, 'You cannot delete your own admin account');
  const count = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
  if (count <= 1) return err(res, 400, 'The last admin account cannot be deleted');
  db.prepare('DELETE FROM sessions WHERE userId = ?').run(adminUser.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(adminUser.id);
  res.json({ ok: true });
});

// Reset an admin / dispatcher's password (owner's ask, 2026-11-16). The
// manager types the new password; the admin's sessions are ended. Only the
// main admin can reset the main admin's password.
admin.post('/admins/:id/password', requireAdminManager, (req, res) => {
  const pw = (req.body || {}).password;
  if (typeof pw !== 'string' || pw.length < 8)
    return err(res, 400, 'New password must be at least 8 characters');
  const adminUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'admin'").get(req.params.id);
  if (!adminUser) return err(res, 404, 'Admin not found');
  if (adminUser.isMainAdmin && !req.user.isMainAdmin)
    return err(res, 403, 'Only the main admin can reset the main admin password');
  withTransaction(db, () => {
    db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(bcrypt.hashSync(pw, 10), adminUser.id);
    db.prepare('DELETE FROM sessions WHERE userId = ?').run(adminUser.id);
  });
  res.json({ ok: true });
});

admin.post('/drivers', (req, res) => {
  const { name, email, password, phone } = req.body || {};
  if (!name || !password) return err(res, 400, 'name and password are required');
  const emailValue = typeof email === 'string' && email.trim() ? email.trim() : null;
  const phoneValue = typeof phone === 'string' && phone.trim() ? phone.trim() : null;
  if (!emailValue && !phoneValue) return err(res, 400, 'a phone number or an email is required');
  if (typeof password !== 'string' || password.length < 8)
    return err(res, 400, 'Password must be at least 8 characters');
  if (emailValue && db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(emailValue))
    return err(res, 409, 'Email is already in use');
  const phoneNormalized = normalizePhone(phoneValue);
  if (phoneNormalized && db.prepare('SELECT 1 FROM users WHERE phoneNormalized = ?').get(phoneNormalized))
    return err(res, 409, 'Phone number is already in use');
  const ts = now();
  const id = db
    .prepare("INSERT INTO users (role, name, email, passwordHash, phone, phoneNormalized, active, createdAt) VALUES ('driver', ?, ?, ?, ?, ?, 1, ?)")
    .run(name, emailValue, bcrypt.hashSync(password, 10), phoneValue, phoneNormalized, ts).lastInsertRowid;
  deactivateDemo(db); // first real driver deactivates demo
  res.status(201).json(publicUser(getUserById(id)));
});

admin.post('/drivers/:id/active', (req, res) => {
  const { active } = req.body || {};
  if (typeof active !== 'boolean') return err(res, 400, 'active must be a boolean');
  const driverUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(req.params.id);
  if (!driverUser) return err(res, 404, 'Driver not found');
  withTransaction(db, () => {
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, driverUser.id);
    if (!active) {
      // Deactivating a driver frees their truck and trailer — otherwise
      // the unit stays assigned to someone who can no longer use it and
      // no other driver's request for it can ever be approved.
      db.prepare('UPDATE trucks SET driverId = NULL WHERE driverId = ?').run(driverUser.id);
      db.prepare('UPDATE trailers SET driverId = NULL WHERE driverId = ?').run(driverUser.id);
    }
  });
  res.json(publicUser(getUserById(driverUser.id)));
});

// Delete a driver profile. Blocked when the driver has loads on record —
// a load (and its BOLs/receipts) is company history and must not be
// destroyed with the profile; deactivate the driver instead. The demo
// driver cannot be deleted. Anything else belonging only to the driver
// (truck/trailer assignment, messages, notifications, requests, location,
// driver documents) is removed with the profile, in one transaction.
admin.delete('/drivers/:id', (req, res) => {
  const driverUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(req.params.id);
  if (!driverUser) return err(res, 404, 'Driver not found');
  if (driverUser.isDemo) return err(res, 400, 'The demo driver cannot be deleted');
  const loadCount = db.prepare('SELECT COUNT(*) AS n FROM loads WHERE driverId = ?').get(driverUser.id).n;
  if (loadCount > 0)
    return err(
      res,
      400,
      'This driver has loads on record and cannot be deleted. Deactivate the driver instead to keep the load history.',
    );
  withTransaction(db, () => {
    db.prepare('UPDATE trucks SET driverId = NULL WHERE driverId = ?').run(driverUser.id);
    db.prepare('UPDATE trailers SET driverId = NULL WHERE driverId = ?').run(driverUser.id);
    db.prepare('DELETE FROM locations WHERE driverId = ?').run(driverUser.id);
    db.prepare('DELETE FROM messages WHERE driverId = ?').run(driverUser.id);
    db.prepare('DELETE FROM notifications WHERE driverId = ?').run(driverUser.id);
    db.prepare('DELETE FROM requests WHERE driverId = ?').run(driverUser.id);
    // Driver documents (e.g. licence copies) belong to the driver alone —
    // remove them and their stored files. Load documents cannot exist
    // here: every load document belongs to a load, and loads block deletion.
    const docs = db
      .prepare("SELECT * FROM documents WHERE driverId = ? AND kind = 'driver_doc'")
      .all(driverUser.id);
    for (const doc of docs) {
      const f = getFileRow(doc.fileId);
      db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
      db.prepare('DELETE FROM files WHERE id = ?').run(doc.fileId);
      if (f) {
        try {
          fs.unlinkSync(path.join(UPLOADS_DIR, f.storedFilename));
        } catch {
          // file already gone — ignore
        }
      }
    }
    db.prepare('UPDATE files SET driverId = NULL WHERE driverId = ?').run(driverUser.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(driverUser.id);
  });
  res.json({ ok: true });
});

// Reset a driver's password (admin only). The admin types the new password;
// the driver's sessions are ended, so they must sign in again with it.
// The demo driver's password cannot be reset.
admin.post('/drivers/:id/password', (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length < 8)
    return err(res, 400, 'New password must be at least 8 characters');
  const driverUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(req.params.id);
  if (!driverUser) return err(res, 404, 'Driver not found');
  if (driverUser.isDemo) return err(res, 400, 'The demo driver password cannot be reset');
  withTransaction(db, () => {
    db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), driverUser.id);
    db.prepare('DELETE FROM sessions WHERE userId = ?').run(driverUser.id);
  });
  res.json({ ok: true });
});

admin.get('/trucks', (_req, res) => {
  res.json(db.prepare('SELECT * FROM trucks ORDER BY unitNumber').all().map(serializeTruck));
});

admin.post('/trucks', (req, res) => {
  const { id, unitNumber, make, model, year, plate, vin, status } = req.body || {};
  if (!unitNumber) return err(res, 400, 'unitNumber is required');
  if (status && status !== 'active' && status !== 'inactive') return err(res, 400, 'Invalid status');
  const existing = id ? db.prepare('SELECT * FROM trucks WHERE id = ?').get(id) : null;
  if (existing) {
    db.prepare(
      'UPDATE trucks SET unitNumber = ?, make = ?, model = ?, year = ?, plate = ?, vin = ?, status = ? WHERE id = ?',
    ).run(
      unitNumber,
      make ?? existing.make,
      model ?? existing.model,
      year ?? existing.year,
      plate ?? existing.plate,
      vin ?? existing.vin,
      status ?? existing.status,
      id,
    );
    return res.json(serializeTruck(db.prepare('SELECT * FROM trucks WHERE id = ?').get(id)));
  }
  try {
    const newId = db
      .prepare('INSERT INTO trucks (unitNumber, make, model, year, plate, vin, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(unitNumber, make ?? null, model ?? null, year ?? null, plate ?? null, vin ?? null, status ?? 'active')
      .lastInsertRowid;
    deactivateDemo(db); // first real truck deactivates demo
    res.status(201).json(serializeTruck(db.prepare('SELECT * FROM trucks WHERE id = ?').get(newId)));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return err(res, 409, 'A truck with that unit number already exists');
    throw e;
  }
});

admin.post('/trucks/:id/assign', (req, res) => {
  const { driverId } = req.body || {};
  let result;
  try {
    result = withTransaction(db, () => {
      const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(req.params.id);
      if (!truck) return { status: 404, error: 'Truck not found' };
      if (driverId != null) {
        const driverUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(driverId);
        if (!driverUser) return { status: 404, error: 'Driver not found' };
        if (truck.driverId && truck.driverId !== driverId)
          return { status: 409, error: 'Truck is already assigned to another driver' };
        // One truck per driver: release any other truck this driver holds.
        db.prepare('UPDATE trucks SET driverId = NULL WHERE driverId = ? AND id != ?').run(driverId, truck.id);
        db.prepare('UPDATE trucks SET driverId = ? WHERE id = ?').run(driverId, truck.id);
      } else {
        db.prepare('UPDATE trucks SET driverId = NULL WHERE id = ?').run(truck.id);
      }
      return { status: 200, truck: serializeTruck(db.prepare('SELECT * FROM trucks WHERE id = ?').get(truck.id)) };
    });
  } catch (e) {
    return err(res, 500, e.message);
  }
  if (result.error) return err(res, result.status, result.error);
  res.json(result.truck);
});

admin.post('/trucks/:id/yard-status', (req, res) => {
  const { yardStatus } = req.body || {};
  if (yardStatus !== 'yard' && yardStatus !== 'road') return err(res, 400, 'yardStatus must be "yard" or "road"');
  const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(req.params.id);
  if (!truck) return err(res, 404, 'Truck not found');
  db.prepare('UPDATE trucks SET yardStatus = ? WHERE id = ?').run(yardStatus, truck.id);
  res.json(serializeTruck(db.prepare('SELECT * FROM trucks WHERE id = ?').get(truck.id)));
});

// Latest ELD odometer for a truck (pulled from TRC eLOGS). Stores the
// newest reading on the truck row; the Locations page reads it back via
// /api/admin/locations and /api/admin/trucks. recordedAt is when the ELD
// recorded the reading (defaults to now); engineHours is optional and
// only overwritten when a value is sent.
admin.post('/trucks/:id/odometer', (req, res) => {
  const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(req.params.id);
  if (!truck) return err(res, 404, 'Truck not found');
  const { odometerMi, engineHours, recordedAt } = req.body || {};
  const miles = Number(odometerMi);
  if (odometerMi === undefined || odometerMi === null || !Number.isFinite(miles) || miles < 0)
    return err(res, 400, 'odometerMi must be a non-negative number');
  let hours = null;
  if (engineHours !== undefined && engineHours !== null && engineHours !== '') {
    hours = Number(engineHours);
    if (!Number.isFinite(hours) || hours < 0) return err(res, 400, 'engineHours must be a non-negative number');
  }
  let at = now();
  if (recordedAt) {
    const d = new Date(recordedAt);
    if (isNaN(d)) return err(res, 400, 'recordedAt must be a valid date');
    at = d.toISOString();
  }
  db.prepare('UPDATE trucks SET odometerMi = ?, odometerUpdatedAt = ?, engineHours = COALESCE(?, engineHours) WHERE id = ?')
    .run(Math.round(miles), at, hours, truck.id);
  try { checkMaintAlerts(truck.id); } catch (e) { console.error('maintenance alerts failed', e); }
  res.json(serializeTruck(db.prepare('SELECT * FROM trucks WHERE id = ?').get(truck.id)));
});

// --- Maintenance + Cash Flow (owner's sections, 2026-11-16) ----------------
// Maintenance runs off the TRC-fed odometer: each truck carries service
// items with an interval in miles; the portal shows miles left, and the
// odometer save path raises a bell alert when an item gets due soon or
// overdue. Cash Flow: money in (factoring / broker payments) and money out
// (Pilot weekly fuel, tolls, maintenance, truck payment, …) — entered by
// hand, staged from Outlook emails (amount read from the attachment, the
// admin confirms before saving), auto-added when a maintenance service is
// marked done, plus approved driver advances counted automatically.
// Driver fuel receipts are NOT cash flow (owner's rule) — only the Pilot
// weekly bill counts as fuel.
const MAINT_DUE_SOON_MI = 1000;

function maintComputed(item, truck) {
  const currentMi = truck && truck.odometerMi !== null && truck.odometerMi !== undefined ? truck.odometerMi : null;
  if (item.lastDoneMi === null || item.lastDoneMi === undefined || currentMi === null)
    return { currentMi, drivenMi: null, remainingMi: null, status: 'unset', pct: 0 };
  const drivenMi = Math.max(0, currentMi - item.lastDoneMi);
  const remainingMi = item.intervalMi - drivenMi;
  const status = remainingMi <= 0 ? 'overdue' : remainingMi <= MAINT_DUE_SOON_MI ? 'soon' : 'ok';
  return { currentMi, drivenMi, remainingMi, status, pct: Math.min(100, Math.round((drivenMi / item.intervalMi) * 100)) };
}

function serializeMaintItem(item, truck) {
  return {
    id: item.id, truckId: item.truckId, name: item.name, intervalMi: item.intervalMi,
    lastDoneMi: item.lastDoneMi ?? null, lastDoneAt: item.lastDoneAt ?? null,
    ...maintComputed(item, truck),
  };
}

function ensureDefaultMaintItems(truckId) {
  const n = db.prepare('SELECT COUNT(*) AS c FROM maintenance_items WHERE truckId = ?').get(truckId).c;
  if (n > 0) return;
  const ins = db.prepare('INSERT INTO maintenance_items (truckId, name, intervalMi, createdAt) VALUES (?, ?, ?, ?)');
  ins.run(truckId, 'PM Service', 20000, now());
  ins.run(truckId, 'Steer Tires', 100000, now());
}

function checkMaintAlerts(truckId) {
  const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(truckId);
  if (!truck) return;
  ensureDefaultMaintItems(truckId);
  for (const item of db.prepare('SELECT * FROM maintenance_items WHERE truckId = ?').all(truckId)) {
    const c = maintComputed(item, truck);
    if (c.status === 'soon' && item.alertLevel === 'none') {
      notifyAdmins('maintenance', 'Maintenance due soon',
        `Truck ${truck.unitNumber} — ${item.name} is due in ${c.remainingMi.toLocaleString('en-US')} mi (at ${c.currentMi.toLocaleString('en-US')} mi).`, 'maintenance', item.id);
      if (truck.driverId)
        notifyDriver(db, truck.driverId, 'maintenance', `${item.name} is needed`,
          `Truck ${truck.unitNumber} — ${item.name} is due in ${c.remainingMi.toLocaleString('en-US')} mi.`).catch(() => {});
      db.prepare("UPDATE maintenance_items SET alertLevel = 'soon' WHERE id = ?").run(item.id);
    } else if (c.status === 'overdue' && item.alertLevel !== 'overdue') {
      notifyAdmins('maintenance', 'Maintenance OVERDUE',
        `Truck ${truck.unitNumber} — ${item.name} is ${Math.abs(c.remainingMi).toLocaleString('en-US')} mi overdue (at ${c.currentMi.toLocaleString('en-US')} mi).`, 'maintenance', item.id);
      if (truck.driverId)
        notifyDriver(db, truck.driverId, 'maintenance', `${item.name} is OVERDUE`,
          `Truck ${truck.unitNumber} — ${item.name} is ${Math.abs(c.remainingMi).toLocaleString('en-US')} mi overdue. Please get it serviced.`).catch(() => {});
      db.prepare("UPDATE maintenance_items SET alertLevel = 'overdue' WHERE id = ?").run(item.id);
    }
  }
}

admin.get('/maintenance', (_req, res) => {
  const trucks = db.prepare('SELECT * FROM trucks ORDER BY unitNumber').all();
  for (const t of trucks) ensureDefaultMaintItems(t.id);
  const log = db.prepare(
    `SELECT l.*, t.unitNumber AS truckUnit, f.id AS fid FROM maintenance_log l
     LEFT JOIN trucks t ON t.id = l.truckId LEFT JOIN files f ON f.id = l.fileId
     ORDER BY l.id DESC LIMIT 30`,
  ).all().map((l) => ({
    id: l.id, truckId: l.truckId, truckUnit: l.truckUnit ?? null, itemName: l.itemName,
    doneAt: l.doneAt, doneMi: l.doneMi ?? null, costCents: l.costCents ?? null,
    shop: l.shop ?? null, note: l.note ?? null, url: l.fileId ? `/files/${l.fileId}` : null,
  }));
  res.json({
    trucks: trucks.map((t) => ({
      id: t.id, unitNumber: t.unitNumber,
      desc: [t.year, t.make, t.model].filter(Boolean).join(' ') || null,
      odometerMi: t.odometerMi ?? null,
      items: db.prepare('SELECT * FROM maintenance_items WHERE truckId = ? ORDER BY intervalMi').all(t.id)
        .map((it) => serializeMaintItem(it, t)),
    })),
    log,
  });
});

admin.post('/maintenance/items', (req, res) => {
  const { truckId, name, intervalMi, lastDoneMi } = req.body || {};
  const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(Number(truckId));
  if (!truck) return err(res, 404, 'Truck not found');
  if (!name || !String(name).trim()) return err(res, 400, 'name is required');
  const interval = Number(intervalMi);
  if (!Number.isFinite(interval) || interval <= 0) return err(res, 400, 'intervalMi must be a positive number of miles');
  const r = db.prepare('INSERT INTO maintenance_items (truckId, name, intervalMi, lastDoneMi, lastDoneAt, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(truck.id, String(name).trim(), Math.round(interval),
      lastDoneMi !== undefined && lastDoneMi !== null && lastDoneMi !== '' ? Math.round(Number(lastDoneMi)) : null,
      lastDoneMi !== undefined && lastDoneMi !== null && lastDoneMi !== '' ? now() : null, now());
  res.status(201).json(serializeMaintItem(db.prepare('SELECT * FROM maintenance_items WHERE id = ?').get(r.lastInsertRowid), truck));
});

admin.patch('/maintenance/items/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM maintenance_items WHERE id = ?').get(req.params.id);
  if (!item) return err(res, 404, 'Service not found');
  const { name, intervalMi, lastDoneMi } = req.body || {};
  const updates = {};
  if (name !== undefined && String(name).trim()) updates.name = String(name).trim();
  if (intervalMi !== undefined) {
    const v = Number(intervalMi);
    if (!Number.isFinite(v) || v <= 0) return err(res, 400, 'intervalMi must be a positive number of miles');
    updates.intervalMi = Math.round(v);
  }
  if (lastDoneMi !== undefined) {
    updates.lastDoneMi = lastDoneMi === null || lastDoneMi === '' ? null : Math.round(Number(lastDoneMi));
    updates.alertLevel = 'none';
    if (req.body.lastDoneAt !== undefined)
      updates.lastDoneAt = req.body.lastDoneAt || null;
    else if (updates.lastDoneMi === null)
      updates.lastDoneAt = null;
  }
  const keys = Object.keys(updates);
  if (keys.length) {
    db.prepare(`UPDATE maintenance_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => updates[k]), item.id);
  }
  const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(item.truckId);
  res.json(serializeMaintItem(db.prepare('SELECT * FROM maintenance_items WHERE id = ?').get(item.id), truck));
});

admin.delete('/maintenance/items/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM maintenance_items WHERE id = ?').get(req.params.id);
  if (!item) return err(res, 404, 'Service not found');
  db.prepare('DELETE FROM maintenance_items WHERE id = ?').run(item.id);
  res.json({ ok: true });
});

admin.post('/maintenance/items/:id/done', upload.single('file'), (req, res) => {
  const item = db.prepare('SELECT * FROM maintenance_items WHERE id = ?').get(req.params.id);
  if (!item) return err(res, 404, 'Service not found');
  const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(item.truckId);
  const costDollars = Number(req.body && req.body.cost);
  const costCents = Number.isFinite(costDollars) && costDollars > 0 ? Math.round(costDollars * 100) : null;
  const doneMiBody = Number(req.body && req.body.doneMi);
  const doneMi = Number.isFinite(doneMiBody) && doneMiBody > 0 ? Math.round(doneMiBody)
    : (truck && truck.odometerMi !== null && truck.odometerMi !== undefined ? truck.odometerMi : null);
  const todayStr = new Date().toISOString().slice(0, 10);
  const fileId = req.file ? insertFileRow(req.file, 'maintenance_invoice', null, req.user.id) : null;
  db.prepare('INSERT INTO maintenance_log (itemId, truckId, itemName, doneAt, doneMi, costCents, shop, note, fileId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(item.id, item.truckId, item.name, todayStr, doneMi, costCents,
      (req.body && req.body.shop) || null, (req.body && req.body.note) || null, fileId, now());
  db.prepare("UPDATE maintenance_items SET lastDoneMi = ?, lastDoneAt = ?, alertLevel = 'none' WHERE id = ?")
    .run(doneMi, todayStr, item.id);
  if (costCents) {
    db.prepare('INSERT INTO cash_entries (direction, date, category, amountCents, truckId, note, fileId, source, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('out', todayStr, 'Maintenance', costCents, item.truckId,
        `${item.name} — Truck ${truck ? truck.unitNumber : ''}${req.body && req.body.shop ? ' · ' + req.body.shop : ''}`, fileId, 'maintenance', now());
  }
  res.json(serializeMaintItem(db.prepare('SELECT * FROM maintenance_items WHERE id = ?').get(item.id), truck));
});

admin.post('/maintenance/items/:id/remind', (req, res) => {
  const item = db.prepare('SELECT * FROM maintenance_items WHERE id = ?').get(req.params.id);
  if (!item) return err(res, 404, 'Service not found');
  const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(item.truckId);
  if (!truck || !truck.driverId) return err(res, 400, 'No driver is assigned to that truck');
  const c = maintComputed(item, truck);
  const when = c.remainingMi === null ? 'due now'
    : c.remainingMi <= 0 ? `${Math.abs(c.remainingMi).toLocaleString('en-US')} mi OVERDUE`
    : `due in ${c.remainingMi.toLocaleString('en-US')} mi`;
  notifyDriver(db, truck.driverId, 'maintenance', `${item.name} is needed`,
    `Truck ${truck.unitNumber} — ${item.name} is ${when}.`).catch(() => {});
  res.json({ ok: true });
});

// --- Cash Flow ---
function cashAmountFromBody(body) {
  const dollars = Number(body && body.amount);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

admin.get('/cashflow', (req, res) => {
  const monthParam = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  const rcTotal = db.prepare('SELECT COALESCE(SUM(rateCents), 0) AS s FROM rate_confirmations').get().s;
  const entryRows = db.prepare(
    `SELECT e.*, t.unitNumber AS truckUnit FROM cash_entries e
     LEFT JOIN trucks t ON t.id = e.truckId ORDER BY e.date DESC, e.id DESC LIMIT 200`,
  ).all();
  const entries = entryRows.map((e) => ({
    id: e.id, direction: e.direction, date: e.date, category: e.category, amountCents: e.amountCents,
    truckId: e.truckId ?? null, truckUnit: e.truckUnit ?? null, note: e.note ?? null,
    loadId: e.loadId ?? null, source: e.source, url: e.fileId ? `/files/${e.fileId}` : null, virtual: false,
  }));
  const advanceRows = db.prepare(
    `SELECT r.id, r.amountCents, r.decidedAt, r.driverId, u.name AS driverName FROM requests r
     LEFT JOIN users u ON u.id = r.driverId
     WHERE r.type = 'advance' AND r.status = 'approved' AND r.amountCents IS NOT NULL`,
  ).all();
  const advances = advanceRows.map((a) => ({
    id: 'adv-' + a.id, direction: 'out', date: String(a.decidedAt || '').slice(0, 10),
    category: 'Driver advance', amountCents: a.amountCents, truckId: null, truckUnit: null,
    driverId: a.driverId, note: a.driverName ? 'Advance — ' + a.driverName : 'Advance',
    source: 'advance', url: null, virtual: true,
  }));
  const all = [...entries, ...advances].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const receivedCents = entries.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amountCents, 0);
  const outCents = all.filter((e) => e.direction === 'out').reduce((s, e) => s + e.amountCents, 0);
  const weekly = [];
  const todayD = new Date();
  for (let i = 7; i >= 0; i--) {
    const end = new Date(todayD); end.setDate(end.getDate() - i * 7);
    const start = new Date(end); start.setDate(start.getDate() - 6);
    const sStr = start.toISOString().slice(0, 10);
    const eStr = end.toISOString().slice(0, 10);
    weekly.push({
      weekStart: sStr,
      inCents: all.filter((e) => e.direction === 'in' && e.date >= sStr && e.date <= eStr).reduce((s, e) => s + e.amountCents, 0),
      outCents: all.filter((e) => e.direction === 'out' && e.date >= sStr && e.date <= eStr).reduce((s, e) => s + e.amountCents, 0),
    });
  }
  // Fixed monthly payments (owner's fixed costs) — counted in the monthly
  // profit automatically, never entered by hand.
  const fixed = db.prepare('SELECT * FROM fixed_payments WHERE active = 1 ORDER BY category').all()
    .map((f) => ({ id: f.id, category: f.category, amountCents: f.amountCents, note: f.note ?? null }));
  // Monthly P&L: factoring money in, every expense group out, then profit.
  const inMonth = (e) => (e.date || '').startsWith(monthParam);
  const groupBy = (list) => {
    const m = new Map();
    for (const e of list) m.set(e.category, (m.get(e.category) || 0) + e.amountCents);
    return [...m.entries()].map(([category, amountCents]) => ({ category, amountCents })).sort((a, b) => b.amountCents - a.amountCents);
  };
  const monthIn = groupBy(all.filter((e) => e.direction === 'in' && inMonth(e)));
  const monthOut = groupBy(all.filter((e) => e.direction === 'out' && inMonth(e)));
  for (const f of fixed) monthOut.push({ category: f.category, amountCents: f.amountCents, fixed: true });
  const monthInTotal = monthIn.reduce((s, x) => s + x.amountCents, 0);
  const monthOutTotal = monthOut.reduce((s, x) => s + x.amountCents, 0);
  // Per-truck: trip revenue from rate cons (via the load's driver), costs
  // from the entries tagged to the truck, profit after fuel + driver pay.
  const truckRows = db.prepare('SELECT * FROM trucks ORDER BY unitNumber').all();
  const trucksOut = truckRows.map((t) => {
    const trips = t.driverId ? db.prepare(
      `SELECT l.id AS loadId, l.reference AS reference, rc.rateCents AS rateCents FROM loads l
       JOIN rate_confirmations rc ON rc.loadId = l.id
       WHERE l.driverId = ? AND rc.rateCents IS NOT NULL ORDER BY l.id DESC`,
    ).all(t.driverId).map((trip) => {
      const exp = db.prepare("SELECT COALESCE(SUM(amountCents), 0) AS s FROM cash_entries WHERE loadId = ? AND direction = 'out'").get(trip.loadId).s;
      return { loadId: trip.loadId, reference: trip.reference, rateCents: trip.rateCents, expensesCents: exp, profitCents: trip.rateCents - exp };
    }) : [];
    const sumCat = (cats) => entries.filter((e) => e.direction === 'out' && e.truckId === t.id && cats.includes(e.category)).reduce((s, e) => s + e.amountCents, 0);
    const revenueCents = trips.reduce((s, x) => s + x.rateCents, 0);
    const fuelCents = entries.filter((e) => e.direction === 'out' && e.truckId === t.id && e.category.startsWith('Fuel')).reduce((s, e) => s + e.amountCents, 0);
    const driverPayCents = sumCat(['Driver pay'])
      + advanceRows.filter((a) => {
        const truckOfDriver = db.prepare('SELECT id FROM trucks WHERE driverId = ?').get(a.driverId);
        return truckOfDriver && truckOfDriver.id === t.id;
      }).reduce((s, a) => s + a.amountCents, 0);
    const maintCents = sumCat(['Maintenance', 'Repairs']);
    const known = new Set(['Driver pay', 'Maintenance', 'Repairs']);
    const otherCents = entries.filter((e) => e.direction === 'out' && e.truckId === t.id && !known.has(e.category) && !e.category.startsWith('Fuel')).reduce((s, e) => s + e.amountCents, 0);
    const costs = fuelCents + driverPayCents + maintCents + otherCents;
    return {
      truckId: t.id, unitNumber: t.unitNumber, trips,
      revenueCents, fuelCents, driverPayCents, maintCents, otherCents,
      profitCents: revenueCents - costs,
    };
  });
  const loads = db.prepare(
    `SELECT l.id, l.reference, u.name AS driverName FROM loads l
     LEFT JOIN users u ON u.id = l.driverId ORDER BY l.id DESC LIMIT 50`,
  ).all().map((l) => ({ id: l.id, reference: l.reference, driverName: l.driverName ?? null }));
  res.json({
    bookedCents: rcTotal, receivedCents, outCents, netCents: receivedCents - outCents, weekly,
    entries: all.slice(0, 60), fixed,
    bankPending: db.prepare("SELECT * FROM bank_transactions WHERE status = 'pending' ORDER BY date DESC, id DESC LIMIT 40").all()
      .map((t) => ({ id: t.id, date: t.date, name: t.name, amountCents: t.amountCents, direction: t.direction })),
    month: { key: monthParam, inGroups: monthIn, outGroups: monthOut, inTotalCents: monthInTotal, outTotalCents: monthOutTotal, profitCents: monthInTotal - monthOutTotal },
    trucks: trucksOut, loads,
  });
});

admin.post('/cashflow/fixed', (req, res) => {
  const { category, note } = req.body || {};
  const amountCents = cashAmountFromBody(req.body);
  if (!category || !String(category).trim()) return err(res, 400, 'category is required');
  if (!amountCents) return err(res, 400, 'amount must be a positive number');
  const r = db.prepare('INSERT INTO fixed_payments (category, amountCents, note, createdAt) VALUES (?, ?, ?, ?)')
    .run(String(category).trim(), amountCents, note ? String(note) : null, now());
  res.status(201).json({ id: r.lastInsertRowid, ok: true });
});

admin.delete('/cashflow/fixed/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM fixed_payments WHERE id = ?').get(req.params.id);
  if (!f) return err(res, 404, 'Fixed payment not found');
  db.prepare('DELETE FROM fixed_payments WHERE id = ?').run(f.id);
  res.json({ ok: true });
});

admin.post('/cashflow/entries', upload.single('file'), (req, res) => {
  const { direction, category, date, truckId, note, loadId } = req.body || {};
  if (direction !== 'in' && direction !== 'out') return err(res, 400, 'direction must be "in" or "out"');
  const amountCents = cashAmountFromBody(req.body);
  if (!amountCents) return err(res, 400, 'amount must be a positive number');
  if (!category || !String(category).trim()) return err(res, 400, 'category is required');
  const dateStr = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
  const fileId = req.file ? insertFileRow(req.file, 'cash_entry', null, req.user.id) : null;
  const r = db.prepare('INSERT INTO cash_entries (direction, date, category, amountCents, truckId, note, fileId, source, loadId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(direction, dateStr, String(category).trim(), amountCents,
      truckId ? Number(truckId) : null, note ? String(note) : null, fileId, 'manual',
      loadId ? Number(loadId) : null, now());
  res.status(201).json({ id: r.lastInsertRowid, ok: true });
});

admin.delete('/cashflow/entries/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM cash_entries WHERE id = ?').get(req.params.id);
  if (!e) return err(res, 404, 'Entry not found');
  db.prepare('DELETE FROM cash_entries WHERE id = ?').run(e.id);
  res.json({ ok: true });
});

function detectCashAmountCents(text) {
  const labels = ['NET PAYMENT', 'NET PAID', 'TOTAL PAID', 'AMOUNT PAID', 'PAYMENT AMOUNT', 'AMOUNT DUE', 'TOTAL DUE', 'BALANCE DUE', 'TOTAL AMOUNT', 'GRAND TOTAL', 'TOTAL'];
  const lines = String(text || '').split(/\r?\n/);
  const money = /\$\s?([\d,]+\.\d{2})/;
  for (const label of labels) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toUpperCase().includes(label)) {
        const here = lines[i].match(money);
        if (here) return Math.round(parseFloat(here[1].replace(/,/g, '')) * 100);
        if (lines[i + 1]) {
          const next = lines[i + 1].match(money);
          if (next) return Math.round(parseFloat(next[1].replace(/,/g, '')) * 100);
        }
      }
    }
  }
  return detectRateCents(text);
}

function suggestCashKind(subject, from) {
  const s = `${subject || ''} ${from || ''}`.toLowerCase();
  if (s.includes('pilot')) return { direction: 'out', category: 'Fuel (Pilot weekly)' };
  if (/toll|e-zpass|ezpass|prepass|bestpass|pay by plate/.test(s)) return { direction: 'out', category: 'Tolls' };
  if (/factor|remittance|payment advice|funding|settlement/.test(s)) return { direction: 'in', category: 'Factoring payment' };
  return { direction: 'out', category: 'Other' };
}

async function outlookAttachmentBuffer(user, messageId, attachmentId) {
  const accessToken = await outlookAccessToken(user);
  const att = await outlookGraph(accessToken,
    `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
  if (!att.contentBytes) throw Object.assign(new Error('That attachment has no file to download — pick a file attachment (PDF).'), { status: 400 });
  const fileBuffer = Buffer.from(att.contentBytes, 'base64');
  if (!fileBuffer.length) throw Object.assign(new Error('That attachment is empty.'), { status: 400 });
  return { att, fileBuffer, accessToken };
}

// --- Bank transactions inbox (Cash Flow) -----------------------------------
// The bank (Plaid) talks to Muse, not to this server: a sync on Muse's side
// posts new transactions here with a shared key. They land as 'pending' and
// count for NOTHING until an admin categorizes one — categorizing creates
// the cash entry. Profit always comes from the categorized books, never
// from raw bank totals (owner's rule, 2026-11-16).
app.post('/api/sync/bank', (req, res) => {
  const key = process.env.BANK_SYNC_KEY;
  if (!key) return err(res, 503, 'Bank sync is not configured');
  if (req.get('x-sync-key') !== key) return err(res, 401, 'Bad sync key');
  const list = (req.body && req.body.transactions) || [];
  let added = 0;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO bank_transactions (plaidTxId, date, name, amountCents, direction, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const t of list) {
    if (!t || !t.id || !t.date || !Number.isFinite(Number(t.amountCents))) continue;
    const r = ins.run(String(t.id), String(t.date).slice(0, 10), String(t.name || '').slice(0, 200),
      Math.round(Number(t.amountCents)), t.direction === 'in' ? 'in' : 'out', now());
    if (r.changes) added += 1;
  }
  res.json({ ok: true, added });
});

admin.post('/cashflow/bank/:id/categorize', (req, res) => {
  const tx = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(req.params.id);
  if (!tx) return err(res, 404, 'Bank transaction not found');
  if (tx.status !== 'pending') return err(res, 400, 'That transaction is already handled');
  const { category, truckId, loadId, note } = req.body || {};
  if (!category || !String(category).trim()) return err(res, 400, 'category is required');
  const r = db.prepare('INSERT INTO cash_entries (direction, date, category, amountCents, truckId, note, source, loadId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(tx.direction, tx.date, String(category).trim(), tx.amountCents,
      truckId ? Number(truckId) : null, note ? String(note) : tx.name, 'bank',
      loadId ? Number(loadId) : null, now());
  db.prepare("UPDATE bank_transactions SET status = 'categorized', entryId = ? WHERE id = ?").run(r.lastInsertRowid, tx.id);
  res.json({ ok: true, entryId: r.lastInsertRowid });
});

admin.post('/cashflow/bank/:id/ignore', (req, res) => {
  const tx = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(req.params.id);
  if (!tx) return err(res, 404, 'Bank transaction not found');
  db.prepare("UPDATE bank_transactions SET status = 'ignored' WHERE id = ?").run(tx.id);
  res.json({ ok: true });
});

admin.post('/cashflow/outlook-preview', async (req, res) => {
  try {
    const { messageId, attachmentId } = req.body || {};
    if (!messageId || !attachmentId) return err(res, 400, 'messageId and attachmentId are required');
    const user = getUserById(req.user.id);
    const accessToken = await outlookAccessToken(user);
    const msg = await outlookGraph(accessToken,
      `/me/messages/${encodeURIComponent(messageId)}?$select=subject,from,receivedDateTime`);
    const { fileBuffer } = await outlookAttachmentBuffer(user, messageId, attachmentId);
    let amountCents = null;
    try { amountCents = detectCashAmountCents(await extractFileText(fileBuffer)); } catch { /* detection is best-effort */ }
    const from = (msg.from && msg.from.emailAddress && (msg.from.emailAddress.name || msg.from.emailAddress.address)) || '';
    res.json({
      amountCents, subject: msg.subject ?? '', from,
      date: msg.receivedDateTime ? String(msg.receivedDateTime).slice(0, 10) : new Date().toISOString().slice(0, 10),
      ...suggestCashKind(msg.subject, from),
    });
  } catch (e) {
    if (e.status) return err(res, e.status, e.message);
    console.error('cashflow outlook preview failed', e);
    return err(res, 500, 'Could not read that email attachment');
  }
});

admin.post('/cashflow/entries/from-outlook', async (req, res) => {
  try {
    const { messageId, attachmentId, direction, category, date, truckId, note, loadId } = req.body || {};
    if (!messageId || !attachmentId) return err(res, 400, 'messageId and attachmentId are required');
    if (direction !== 'in' && direction !== 'out') return err(res, 400, 'direction must be "in" or "out"');
    const amountCents = cashAmountFromBody(req.body);
    if (!amountCents) return err(res, 400, 'amount must be a positive number');
    if (!category || !String(category).trim()) return err(res, 400, 'category is required');
    const user = getUserById(req.user.id);
    const { att, fileBuffer } = await outlookAttachmentBuffer(user, messageId, attachmentId);
    // Files live on disk (multer pattern): write the buffer, then the row.
    const safeName = String(att.name || 'outlook-attachment.pdf').replace(/[^A-Za-z0-9._-]/g, '_');
    let storedName = `cash-${Date.now()}-${safeName}`;
    let n = 1;
    while (fs.existsSync(path.join(UPLOADS_DIR, storedName))) { storedName = `cash-${Date.now()}-${n}-${safeName}`; n += 1; }
    fs.writeFileSync(path.join(UPLOADS_DIR, storedName), fileBuffer);
    const fileId = db.prepare(
      'INSERT INTO files (storedFilename, originalFilename, mimeType, ownerType, ownerId, driverId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(storedName, att.name || storedName, att.contentType || 'application/pdf', 'cash_entry', null, req.user.id, now()).lastInsertRowid;
    const dateStr = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10);
    const r = db.prepare('INSERT INTO cash_entries (direction, date, category, amountCents, truckId, note, fileId, source, outlookMessageId, loadId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(direction, dateStr, String(category).trim(), amountCents,
        truckId ? Number(truckId) : null, note ? String(note) : null, fileId, 'outlook', String(messageId),
        loadId ? Number(loadId) : null, now());
    res.status(201).json({ id: r.lastInsertRowid, ok: true });
  } catch (e) {
    if (e.status) return err(res, e.status, e.message);
    console.error('cashflow from-outlook failed', e);
    return err(res, 500, 'Could not pull the file from Outlook');
  }
});

admin.get('/trailers', (_req, res) => {
  res.json(db.prepare('SELECT * FROM trailers ORDER BY unitNumber').all().map(serializeTrailer));
});

admin.post('/trailers', (req, res) => {
  const { id, unitNumber, kind, year, plate, vin, status } = req.body || {};
  if (!unitNumber) return err(res, 400, 'unitNumber is required');
  if (status && status !== 'active' && status !== 'inactive') return err(res, 400, 'Invalid status');
  const existing = id ? db.prepare('SELECT * FROM trailers WHERE id = ?').get(id) : null;
  if (existing) {
    db.prepare(
      'UPDATE trailers SET unitNumber = ?, kind = ?, year = ?, plate = ?, vin = ?, status = ? WHERE id = ?',
    ).run(
      unitNumber,
      kind ?? existing.kind,
      year ?? existing.year,
      plate ?? existing.plate,
      vin ?? existing.vin,
      status ?? existing.status,
      id,
    );
    return res.json(serializeTrailer(db.prepare('SELECT * FROM trailers WHERE id = ?').get(id)));
  }
  try {
    const newId = db
      .prepare('INSERT INTO trailers (unitNumber, kind, year, plate, vin, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(unitNumber, kind ?? null, year ?? null, plate ?? null, vin ?? null, status ?? 'active')
      .lastInsertRowid;
    deactivateDemo(db); // first real trailer deactivates demo
    res.status(201).json(serializeTrailer(db.prepare('SELECT * FROM trailers WHERE id = ?').get(newId)));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return err(res, 409, 'A trailer with that unit number already exists');
    throw e;
  }
});

admin.post('/trailers/:id/assign', (req, res) => {
  const { driverId } = req.body || {};
  let result;
  try {
    result = withTransaction(db, () => {
      const trailer = db.prepare('SELECT * FROM trailers WHERE id = ?').get(req.params.id);
      if (!trailer) return { status: 404, error: 'Trailer not found' };
      if (driverId != null) {
        const driverUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(driverId);
        if (!driverUser) return { status: 404, error: 'Driver not found' };
        if (trailer.driverId && trailer.driverId !== driverId)
          return { status: 409, error: 'Trailer is already assigned to another driver' };
        db.prepare('UPDATE trailers SET driverId = NULL WHERE driverId = ? AND id != ?').run(driverId, trailer.id);
        db.prepare('UPDATE trailers SET driverId = ? WHERE id = ?').run(driverId, trailer.id);
      } else {
        db.prepare('UPDATE trailers SET driverId = NULL WHERE id = ?').run(trailer.id);
      }
      return { status: 200, trailer: serializeTrailer(db.prepare('SELECT * FROM trailers WHERE id = ?').get(trailer.id)) };
    });
  } catch (e) {
    return err(res, 500, e.message);
  }
  if (result.error) return err(res, result.status, result.error);
  res.json(result.trailer);
});

admin.post('/trailers/:id/yard-status', (req, res) => {
  const { yardStatus } = req.body || {};
  if (yardStatus !== 'yard' && yardStatus !== 'road') return err(res, 400, 'yardStatus must be "yard" or "road"');
  const trailer = db.prepare('SELECT * FROM trailers WHERE id = ?').get(req.params.id);
  if (!trailer) return err(res, 404, 'Trailer not found');
  db.prepare('UPDATE trailers SET yardStatus = ? WHERE id = ?').run(yardStatus, trailer.id);
  res.json(serializeTrailer(db.prepare('SELECT * FROM trailers WHERE id = ?').get(trailer.id)));
});

admin.get('/loads', (_req, res) => {
  const rows = db.prepare('SELECT * FROM loads ORDER BY createdAt DESC, id DESC').all();
  // Fill any missing route coords in the background so the progress %
  // appears on the next refresh.
  for (const l of rows) {
    if (l.status === 'active') {
      if (typeof l.pickupLat !== 'number') void ensurePickupCoords(l);
      if (typeof l.deliveryLat !== 'number') void ensureDeliveryCoords(l);
    }
  }
  res.json(rows.map(serializeLoad));
});

admin.post('/loads', (req, res) => {
  const {
    driverId,
    reference,
    pickupLocation,
    pickupWarehouse,
    pickupAt,
    pickupTimezone,
    pickupNumber,
    deliveryLocation,
    deliveryWarehouse,
    deliveryAt,
    deliveryTimezone,
    deliveryNumber,
    notes,
  } = req.body || {};
  if (!driverId || !reference || !pickupLocation || !pickupAt || !deliveryLocation || !deliveryAt)
    return err(res, 400, 'driverId, reference, pickup and delivery details are required');
  // Timezone is no longer asked in the form — the time is entered in the
  // admin's local time and stored as UTC; keep the company-base zone as
  // metadata for older clients.
  const tz = 'America/Indiana/Indianapolis';
  const driverUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(driverId);
  if (!driverUser) return err(res, 404, 'Driver not found');
  const ts = now();
  const id = db
    .prepare(
      "INSERT INTO loads (reference, driverId, pickupLocation, pickupWarehouse, pickupAt, pickupTimezone, pickupNumber, deliveryLocation, deliveryWarehouse, deliveryAt, deliveryTimezone, deliveryNumber, notes, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
    )
    .run(
      reference,
      driverId,
      pickupLocation,
      pickupWarehouse ?? null,
      pickupAt,
      pickupTimezone || tz,
      pickupNumber ?? null,
      deliveryLocation,
      deliveryWarehouse ?? null,
      deliveryAt,
      deliveryTimezone || tz,
      deliveryNumber ?? null,
      notes ?? null,
      ts,
    ).lastInsertRowid;
  deactivateDemo(db); // first real load deactivates demo
  const load = serializeLoad(db.prepare('SELECT * FROM loads WHERE id = ?').get(id));
  // Geocode the delivery address in the background so the
  // delivery-location gate has coordinates by delivery day.
  void ensureDeliveryCoords(db.prepare('SELECT * FROM loads WHERE id = ?').get(id));
  void ensurePickupCoords(db.prepare('SELECT * FROM loads WHERE id = ?').get(id));
  notifyDriver(db, driverId, 'load_assigned', 'New load assigned', `Load ${reference}: ${pickupWarehouse || pickupLocation} → ${deliveryWarehouse || deliveryLocation}.`).catch(() => {});
  res.status(201).json(load);
});

admin.post('/loads/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (status !== 'cancelled' && status !== 'active') return err(res, 400, 'status must be "cancelled" or "active"');
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(req.params.id);
  if (!load) return err(res, 404, 'Load not found');
  withTransaction(db, () => {
    // Reopening a load completed too early: clear the completion time
    // and put the driver's units back on the road.
    if (status === 'active' && load.status === 'completed') {
      db.prepare("UPDATE loads SET status = 'active', completedAt = NULL WHERE id = ?").run(load.id);
      db.prepare("UPDATE trucks SET yardStatus = 'road' WHERE driverId = ?").run(load.driverId);
      db.prepare("UPDATE trailers SET yardStatus = 'road' WHERE driverId = ?").run(load.driverId);
    } else {
      db.prepare('UPDATE loads SET status = ? WHERE id = ?').run(status, load.id);
    }
  });
  res.json(serializeLoad(db.prepare('SELECT * FROM loads WHERE id = ?').get(load.id)));
});

// Edit a load's addresses (admin only): fixes typos like the LXL-2038499
// pickup "Lebno". Times, driver and reference never change here.
admin.post('/loads/:id/edit', (req, res) => {
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(req.params.id);
  if (!load) return err(res, 404, 'Load not found');
  const { pickupLocation, pickupWarehouse, pickupNumber, deliveryLocation, deliveryWarehouse, deliveryNumber, notes } = req.body || {};
  const clean = (v) => (v && String(v).trim() ? String(v).trim() : null);
  db.prepare(
    'UPDATE loads SET pickupLocation = COALESCE(?, pickupLocation), pickupWarehouse = ?, pickupNumber = ?, deliveryLocation = COALESCE(?, deliveryLocation), deliveryWarehouse = ?, deliveryNumber = ?, notes = ? WHERE id = ?',
  ).run(
    clean(pickupLocation),
    pickupWarehouse ?? null,
    pickupNumber ?? null,
    clean(deliveryLocation),
    deliveryWarehouse ?? null,
    deliveryNumber ?? null,
    notes ?? null,
    load.id,
  );
  // A new delivery address invalidates the cached coords so the
  // delivery gate re-geocodes the new address.
  if (clean(deliveryLocation) && clean(deliveryLocation) !== load.deliveryLocation) {
    db.prepare('UPDATE loads SET deliveryLat = NULL, deliveryLng = NULL WHERE id = ?').run(load.id);
  }
  if (clean(pickupLocation) && clean(pickupLocation) !== load.pickupLocation) {
    db.prepare('UPDATE loads SET pickupLat = NULL, pickupLng = NULL WHERE id = ?').run(load.id);
  }
  res.json(serializeLoad(db.prepare('SELECT * FROM loads WHERE id = ?').get(load.id)));
});

// Delete a load outright (admin only): the load, its documents and
// their stored files go; rate confirmations keep their record with the
// load link cleared. Replaces the old cancel flow in the portal.
admin.delete('/loads/:id', (req, res) => {
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(req.params.id);
  if (!load) return err(res, 404, 'Load not found');
  const docs = db.prepare('SELECT * FROM documents WHERE loadId = ?').all(load.id);
  const storedFiles = docs.map((d) => getFileRow(d.fileId)).filter(Boolean);
  withTransaction(db, () => {
    db.prepare('DELETE FROM documents WHERE loadId = ?').run(load.id);
    for (const d of docs) db.prepare('DELETE FROM files WHERE id = ?').run(d.fileId);
    db.prepare('UPDATE rate_confirmations SET loadId = NULL WHERE loadId = ?').run(load.id);
    db.prepare('DELETE FROM loads WHERE id = ?').run(load.id);
  });
  for (const f of storedFiles) {
    try {
      fs.unlinkSync(path.join(UPLOADS_DIR, f.storedFilename));
    } catch {
      // file already gone — ignore
    }
  }
  res.json({ ok: true });
});

admin.get('/requests', (_req, res) => {
  const rows = db
    .prepare("SELECT * FROM requests ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, createdAt DESC, id DESC")
    .all();
  res.json(rows.map(serializeRequest));
});

admin.post('/requests/:id/decide', (req, res) => {
  const { decision, note } = req.body || {};
  if (decision !== 'approved' && decision !== 'denied') return err(res, 400, 'decision must be "approved" or "denied"');
  // Denying a request requires a reason (owner's ask, 2026-11-16) — the
  // driver sees it as the decline reason.
  if (decision === 'denied' && !(typeof note === 'string' && note.trim()))
    return err(res, 400, 'A reason is required when denying a request');
  let result;
  try {
    result = withTransaction(db, () => {
      const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
      if (!request) return { status: 404, error: 'Request not found' };
      if (request.status !== 'pending') return { status: 400, error: 'Request has already been decided' };
      if (decision === 'approved' && request.type === 'unit_change' && request.truckId) {
        const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(request.truckId);
        if (!truck) return { status: 404, error: 'Requested truck not found' };
        if (truck.driverId && truck.driverId !== request.driverId) {
          const holder = db.prepare('SELECT name FROM users WHERE id = ?').get(truck.driverId);
          return {
            status: 409,
            error: holder
              ? `Requested truck is assigned to ${holder.name}`
              : 'Requested truck is no longer available',
          };
        }
        // Release the driver's current truck, then assign the requested one.
        db.prepare('UPDATE trucks SET driverId = NULL WHERE driverId = ?').run(request.driverId);
        db.prepare('UPDATE trucks SET driverId = ? WHERE id = ?').run(request.driverId, truck.id);
      }
      db.prepare("UPDATE requests SET status = ?, adminNote = ?, decidedAt = ? WHERE id = ?").run(
        decision,
        note ?? null,
        now(),
        request.id,
      );
      return { status: 200, request: serializeRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id)) };
    });
  } catch (e) {
    return err(res, 500, e.message);
  }
  if (result.error) return err(res, result.status, result.error);
  const r = result.request;
  notifyDriver(
    db,
    r.driverId,
    'request_decided',
    `Request ${r.status}`,
    `Your ${r.type} request was ${r.status}${r.adminNote ? `: ${r.adminNote}` : '.'}`,
  ).catch(() => {});
  res.json(r);
});

admin.get('/documents', (_req, res) => {
  const rows = db
    .prepare('SELECT d.*, f.originalFilename, f.mimeType FROM documents d JOIN files f ON f.id = d.fileId ORDER BY d.createdAt DESC, d.id DESC')
    .all();
  res.json(rows.map(serializeDocument));
});

// Each admin's own sidebar order (view keys, in the order they arranged
// them with the sidebar's Organize mode). NULL / empty = default order.
admin.get('/sidebar-order', (req, res) => {
  const user = getUserById(req.user.id);
  let order = null;
  try {
    order = user && user.sidebarOrder ? JSON.parse(user.sidebarOrder) : null;
  } catch {
    order = null;
  }
  res.json({ order: Array.isArray(order) && order.length ? order : null });
});

admin.post('/sidebar-order', (req, res) => {
  if (!Array.isArray(req.body?.order)) return err(res, 400, 'order must be an array');
  const order = [...new Set(req.body.order.filter((k) => typeof k === 'string' && /^[a-z]+$/.test(k)))].slice(0, 20);
  db.prepare('UPDATE users SET sidebarOrder = ? WHERE id = ?').run(order.length ? JSON.stringify(order) : null, req.user.id);
  res.json({ ok: true, order: order.length ? order : null });
});

admin.get('/locations', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT l.*, u.name AS driverName FROM locations l
       JOIN users u ON u.id = l.driverId
       WHERE u.role = 'driver'
       ORDER BY l.updatedAt DESC`,
    )
    .all();
  res.json(
    rows.map((r) => {
      // The driver's current truck/trailer ride along so the Locations
      // cards can show the units and the truck's live ELD odometer.
      const truck = db.prepare('SELECT * FROM trucks WHERE driverId = ?').get(r.driverId);
      const trailer = db.prepare('SELECT unitNumber FROM trailers WHERE driverId = ?').get(r.driverId);
      return {
        driverId: r.driverId,
        driverName: r.driverName,
        lat: r.lat,
        lng: r.lng,
        speedMph: r.speedMph,
        heading: r.heading,
        updatedAt: r.updatedAt,
        truckId: truck ? truck.id : null,
        truckUnit: truck ? truck.unitNumber : null,
        trailerUnit: trailer ? trailer.unitNumber : null,
        odometerMi: truck ? (truck.odometerMi ?? null) : null,
        odometerUpdatedAt: truck ? (truck.odometerUpdatedAt ?? null) : null,
        engineHours: truck ? (truck.engineHours ?? null) : null,
      };
    }),
  );
});

// The public broker tracking page (no login — the link token is the
// key). Self-contained: polls /api/track/<token> every 13 seconds and
// draws the driver's live position plus the load's route and progress.
function trackPageHtml(mapsKey) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Load Tracking — Lubana Xpress LLC</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; background: #05070d; color: #eef2f8; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 18px 14px 40px; }
  .brand { display: flex; align-items: center; gap: 10px; border-bottom: 2px solid #F2B705; padding-bottom: 10px; }
  .brand img.logo { height: 40px; width: auto; display: block; }
  .brand .co { color: #9fb0c9; font-size: 14px; }
  .card { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; padding: 16px; margin-top: 14px; }
  .ref { font-size: 22px; font-weight: 700; color: #4DA3FF; }
  .pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; background: #1E40AF; color: #fff; margin-left: 8px; vertical-align: middle; }
  .pill.done { background: #b8860b; }
  .route { display: flex; gap: 12px; margin-top: 12px; }
  .route .end { flex: 1; }
  .route .lab { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #F2B705; }
  .route .addr { font-size: 15px; margin-top: 3px; }
  .route .when { color: #9fb0c9; font-size: 13px; margin-top: 2px; }
  .route .arrow { align-self: center; color: #4DA3FF; font-size: 20px; }
  .track { height: 10px; background: rgba(255,255,255,0.12); border-radius: 999px; margin-top: 16px; position: relative; }
  .fill { height: 100%; background: linear-gradient(90deg, #1E40AF, #F2B705); border-radius: 999px; width: 0%; transition: width 0.6s; }
  .pct { color: #F2B705; font-weight: 700; margin-top: 6px; font-size: 14px; }
  #map { height: 340px; border-radius: 14px; margin-top: 14px; border: 1px solid rgba(255,255,255,0.12); }
  .driver { display: flex; flex-wrap: wrap; gap: 8px 22px; font-size: 15px; }
  .driver b { color: #fff; }
  .muted { color: #9fb0c9; font-size: 13px; }
  .banner { background: rgba(242,183,5,0.15); border: 1px solid #F2B705; color: #ffd94d; border-radius: 12px; padding: 12px 14px; margin-top: 14px; font-weight: 600; }
  .dead { text-align: center; padding: 60px 20px; color: #9fb0c9; }
  .foot { text-align: center; color: #5f7089; font-size: 12px; margin-top: 22px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><img class="logo" src="/assets/logo.png" alt="LXL"><div class="co">Lubana Xpress LLC &middot; Live load tracking</div></div>
  <div id="app"><p class="muted" style="padding:20px 4px">Loading tracking&hellip;</p></div>
  <div class="foot">Tracking provided by Lubana Xpress LLC &middot; This page refreshes automatically</div>
</div>
<script>
  var token = location.pathname.split('/').pop();
  var map = null, mapDiv = null, driverMarker = null, mapReady = false, timer = null;
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmt(dt) { if (!dt) return ''; try { return new Date(dt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } }
  function ago(dt) { if (!dt) return ''; var m = Math.max(0, Math.round((Date.now() - new Date(dt).getTime()) / 60000)); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; return Math.round(m / 60) + ' hr ago'; }
  function initMap() { mapReady = true; if (window.__pending) render(window.__pending); }
  function truckIcon() {
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><circle cx='24' cy='24' r='21' fill='#1E40AF' stroke='#F2B705' stroke-width='3'/><g fill='#ffffff'><rect x='9' y='17' width='17' height='11' rx='1'/><path d='M27 21h5.2L36 25v3h-9z'/><circle cx='14.5' cy='30' r='2.7'/><circle cx='24' cy='30' r='2.7'/><circle cx='33' cy='30' r='2.7'/></g></svg>";
    return { url: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), scaledSize: new google.maps.Size(46, 46), anchor: new google.maps.Point(23, 23) };
  }
  function drawMap(d) {
    if (!mapReady || !window.google || !d.location) return;
    var pos = { lat: d.location.lat, lng: d.location.lng };
    // render() rebuilds the page HTML on every poll; it moves the live
    // map div into the new markup, so the map below should still match
    // the div in the document. If it doesn't (page state changed), drop
    // the stale map and build a fresh one on the current div.
    if (map && document.getElementById('map') !== mapDiv) { map = null; driverMarker = null; mapDiv = null; }
    if (!map) {
      mapDiv = document.getElementById('map');
      map = new google.maps.Map(mapDiv, { center: pos, zoom: 9, mapTypeId: 'hybrid' });
      new google.maps.TrafficLayer().setMap(map);
      driverMarker = new google.maps.Marker({ map: map, title: d.driverName, icon: truckIcon(), zIndex: 10 });
      if (d.load && d.load.pickupLat != null) new google.maps.Marker({ map: map, position: { lat: d.load.pickupLat, lng: d.load.pickupLng }, label: 'P', title: 'Pickup' });
      if (d.load && d.load.deliveryLat != null) new google.maps.Marker({ map: map, position: { lat: d.load.deliveryLat, lng: d.load.deliveryLng }, label: 'D', title: 'Delivery' });
    } else {
      google.maps.event.trigger(map, 'resize');
    }
    driverMarker.setPosition(pos);
    map.setCenter(pos);
  }
  function render(d) {
    window.__pending = d;
    var el = document.getElementById('app');
    if (!d.load) { el.innerHTML = '<div class="card">Your load is being prepared. Tracking will appear here once the driver is assigned.</div>'; return; }
    var L = d.load;
    var done = L.status === 'completed';
    var html = '';
    if (done) html += '<div class="banner">Delivered &mdash; this load is complete. Tracking has ended.</div>';
    html += '<div class="card"><span class="ref">' + esc(L.reference) + '</span><span class="pill' + (done ? ' done' : '') + '">' + (done ? 'Completed' : 'In transit') + '</span>';
    html += '<div class="route"><div class="end"><div class="lab">Pickup</div><div class="addr">' + (L.pickupWarehouse ? esc(L.pickupWarehouse) + ' &middot; ' : '') + esc(L.pickupLocation) + '</div><div class="when">' + fmt(L.pickupAt) + '</div></div><div class="arrow">&#8594;</div>';
    html += '<div class="end"><div class="lab">Delivery</div><div class="addr">' + (L.deliveryWarehouse ? esc(L.deliveryWarehouse) + ' &middot; ' : '') + esc(L.deliveryLocation) + '</div><div class="when">' + fmt(L.deliveryAt) + '</div></div></div>';
    if (L.progress != null) html += '<div class="track"><div class="fill" style="width:' + L.progress + '%"></div></div><div class="pct">' + L.progress + '% of the route covered</div>';
    html += '</div>';
    html += '<div id="map"></div>';
    html += '<div class="card"><div class="driver"><div>Driver: <b>' + esc(d.driverName) + '</b></div>';
    if (d.truckUnit) html += '<div>Truck: <b>' + esc(d.truckUnit) + '</b></div>';
    if (d.trailerUnit) html += '<div>Trailer: <b>' + esc(d.trailerUnit) + '</b></div>';
    if (d.location) html += '<div>Speed: <b>' + (d.location.speedMph != null ? Math.round(d.location.speedMph) + ' mph' : '&mdash;') + '</b></div>';
    if (d.location && d.location.place) html += '<div>Location: <b>' + esc(d.location.place) + '</b></div>';
    html += '</div>';
    html += '<p class="muted" style="margin:10px 0 0">' + (d.location ? 'Last location update ' + ago(d.location.updatedAt) : 'Waiting for the driver&rsquo;s first location update&hellip;') + '</p></div>';
    // Keep the live Google Map alive across re-renders: move its div
    // into the new markup instead of letting innerHTML destroy it.
    var prevMapDiv = document.getElementById('map');
    el.innerHTML = html;
    if (prevMapDiv && map) {
      var freshMapDiv = document.getElementById('map');
      if (freshMapDiv && freshMapDiv !== prevMapDiv) freshMapDiv.replaceWith(prevMapDiv);
    }
    drawMap(d);
    if (done && timer) { clearInterval(timer); timer = null; }
  }
  function load() {
    fetch('/api/track/' + token).then(function (r) {
      if (!r.ok) throw new Error('dead');
      return r.json();
    }).then(render).catch(function () {
      document.getElementById('app').innerHTML = '<div class="dead"><h2>This tracking link is no longer active</h2><p>Please contact Lubana Xpress LLC for an update on your load.</p></div>';
      if (timer) { clearInterval(timer); timer = null; }
    });
  }
  load();
  timer = setInterval(load, 13000);
</script>
${mapsKey ? '<script async src="https://maps.googleapis.com/maps/api/js?key=' + mapsKey + '&callback=initMap"></script>' : ''}
</body>
</html>`;
}

/* ---------- Broker tracking access ---------- */
// A broker gets a private link that shows ONE driver's live location
// for ONE load — nothing else in the portal. Admins create and revoke
// accesses on the Tracking page; an access also ends on its own when
// its load is completed (the public payload reports the completed
// status and the page stops tracking).
function serializeBrokerAccess(a) {
  const load = a.loadId ? db.prepare('SELECT reference, status FROM loads WHERE id = ?').get(a.loadId) : null;
  return {
    id: a.id,
    brokerName: a.brokerName,
    brokerCompany: a.brokerCompany || null,
    driverId: a.driverId,
    driverName: getDriverName(a.driverId),
    loadId: a.loadId,
    loadReference: load ? load.reference : null,
    loadStatus: load ? load.status : null,
    url: `/track/${a.token}`,
    createdAt: a.createdAt,
    lastViewedAt: a.lastViewedAt || null,
  };
}

admin.get('/broker-access', (_req, res) => {
  const rows = db.prepare('SELECT * FROM broker_access WHERE revokedAt IS NULL ORDER BY createdAt DESC').all();
  res.json(rows.map(serializeBrokerAccess));
});

admin.post('/broker-access', (req, res) => {
  const { brokerName, brokerCompany, driverId, loadId } = req.body || {};
  const name = String(brokerName || '').trim();
  if (!name) return err(res, 400, 'Give the broker a name');
  const driver = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'driver'").get(Number(driverId));
  if (!driver) return err(res, 400, 'Pick a driver');
  let load = null;
  if (loadId) {
    load = db.prepare('SELECT id, driverId FROM loads WHERE id = ?').get(Number(loadId));
    if (!load || load.driverId !== driver.id) return err(res, 400, 'That load is not assigned to this driver');
  } else {
    load = db.prepare("SELECT id FROM loads WHERE driverId = ? AND status = 'active' ORDER BY createdAt DESC").get(driver.id);
  }
  const token = crypto.randomBytes(24).toString('base64url');
  const info = db.prepare(
    'INSERT INTO broker_access (token, brokerName, brokerCompany, driverId, loadId, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(token, name, String(brokerCompany || '').trim() || null, driver.id, load ? load.id : null, req.user.id, new Date().toISOString());
  res.json(serializeBrokerAccess(db.prepare('SELECT * FROM broker_access WHERE id = ?').get(info.lastInsertRowid)));
});

admin.delete('/broker-access/:id', (req, res) => {
  const info = db.prepare('UPDATE broker_access SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL')
    .run(new Date().toISOString(), Number(req.params.id));
  if (!info.changes) return err(res, 404, 'That access is already gone');
  res.json({ ok: true });
});

// The public tracking payload: only what a broker needs for their one
// load. No other drivers, no documents, no rates, no admin data.
// "City, ST" for a position, for the public broker tracking page.
// Google first, Nominatim fallback (same sources as the admin geocode
// route), cached per ~1 km cell so the broker page's frequent polls
// stay cheap.
const placeCache = new Map();
async function reversePlace(lat, lng) {
  const ck = lat.toFixed(2) + ',' + lng.toFixed(2);
  if (placeCache.has(ck)) return placeCache.get(ck);
  let place = null;
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (key) {
    try {
      const r = await fetch('https://maps.googleapis.com/maps/api/geocode/json?latlng=' + lat + ',' + lng + '&key=' + encodeURIComponent(key), { headers: { Referer: 'https://app.lubanaxpress.com/' } });
      const j = await r.json();
      if (j.status === 'OK' && j.results && j.results.length) {
        const comps = j.results[0].address_components || [];
        const find = (t) => { const c = comps.find((x) => (x.types || []).includes(t)); return c ? c.short_name : null; };
        const city = find('locality') || find('sublocality') || find('postal_town') || find('administrative_area_level_2');
        const state = find('administrative_area_level_1');
        place = city && state ? city + ', ' + state : city || state || null;
      }
    } catch { /* fall through to Nominatim */ }
  }
  if (!place) {
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng + '&zoom=10&addressdetails=1', { headers: { 'User-Agent': 'LXL-Driver/1.0 (lubanaxpress.com)' } });
      if (r.ok) {
        const j = await r.json();
        const a = j.address || {};
        const city = a.city || a.town || a.village || a.municipality || a.county || null;
        const iso = a['ISO3166-2-lvl4'] || '';
        const state = (iso.indexOf('US-') === 0 ? iso.slice(3) : null) || a.state_code || a.state || null;
        place = city && state ? city + ', ' + state : city || state || null;
      }
    } catch { /* place stays null */ }
  }
  if (place) placeCache.set(ck, place);
  return place;
}

async function brokerTrackPayload(token) {
  const a = db.prepare('SELECT * FROM broker_access WHERE token = ? AND revokedAt IS NULL').get(String(token));
  if (!a) return null;
  if (!a.lastViewedAt || Date.now() - new Date(a.lastViewedAt).getTime() > 60000) {
    db.prepare('UPDATE broker_access SET lastViewedAt = ? WHERE id = ?').run(new Date().toISOString(), a.id);
  }
  const driver = getUserById(a.driverId);
  const truck = db.prepare('SELECT unitNumber FROM trucks WHERE driverId = ?').get(a.driverId);
  const trailer = db.prepare('SELECT unitNumber FROM trailers WHERE driverId = ?').get(a.driverId);
  const loc = db.prepare('SELECT * FROM locations WHERE driverId = ? ORDER BY updatedAt DESC').get(a.driverId);
  let loadRow = a.loadId ? db.prepare('SELECT * FROM loads WHERE id = ?').get(a.loadId) : null;
  if (!loadRow) {
    loadRow = db.prepare("SELECT * FROM loads WHERE driverId = ? AND status = 'active' ORDER BY createdAt DESC").get(a.driverId);
  }
  const s = loadRow ? serializeLoad(loadRow) : null;
  const location = loc ? { lat: loc.lat, lng: loc.lng, speedMph: loc.speedMph, heading: loc.heading, updatedAt: loc.updatedAt } : null;
  if (location) {
    try { location.place = await reversePlace(loc.lat, loc.lng); } catch { location.place = null; }
  }
  return {
    brokerName: a.brokerName,
    brokerCompany: a.brokerCompany || null,
    driverName: driver ? driver.name : 'Driver',
    truckUnit: truck ? truck.unitNumber : null,
    trailerUnit: trailer ? trailer.unitNumber : null,
    location,
    load: s ? {
      reference: s.reference,
      status: s.status,
      progress: s.progress,
      pickupLocation: s.pickupLocation,
      pickupWarehouse: s.pickupWarehouse,
      pickupAt: s.pickupAt,
      deliveryLocation: s.deliveryLocation,
      deliveryWarehouse: s.deliveryWarehouse,
      deliveryAt: s.deliveryAt,
      pickupLat: loadRow.pickupLat ?? null,
      pickupLng: loadRow.pickupLng ?? null,
      deliveryLat: loadRow.deliveryLat ?? null,
      deliveryLng: loadRow.deliveryLng ?? null,
    } : null,
  };
}

app.get('/api/track/:token', async (req, res) => {
  const payload = await brokerTrackPayload(req.params.token);
  if (!payload) return err(res, 404, 'This tracking link is no longer active');
  res.json(payload);
});

app.get('/track/:token', (_req, res) => {
  res.type('html').send(trackPageHtml(process.env.GOOGLE_MAPS_API_KEY || ''));
});

// Google Maps browser key for the admin portal maps (Dashboard + Locations).
// Admin-only; the key itself is referrer-restricted to the portal domains.
admin.get('/maps-config', (_req, res) => {
  res.json({ googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || null });
});

// Reverse-geocode lat/lng -> "City, ST" on the server. The browser routes
// both proved unreliable (importLibrary not reliably present; the Geocoding
// web service doesn't answer browser fetches). Google is tried first; if
// it denies the call (API not enabled / key restriction), Nominatim —
// already used by this server for delivery addresses — is the fallback.
admin.get('/geocode', async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return err(res, 400, 'lat and lng are required');
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (key) {
    try {
      const r = await fetch('https://maps.googleapis.com/maps/api/geocode/json?latlng=' + lat + ',' + lng + '&key=' + encodeURIComponent(key), { headers: { Referer: 'https://app.lubanaxpress.com/' } });
      const j = await r.json();
      if (j.status === 'OK' && j.results && j.results.length) {
        const comps = j.results[0].address_components || [];
        const find = (type) => { const c = comps.find(c => (c.types || []).includes(type)); return c ? c.short_name : null; };
        const city = find('locality') || find('sublocality') || find('postal_town') || find('administrative_area_level_2');
        const state = find('administrative_area_level_1');
        const place = (city && state) ? (city + ', ' + state) : (city || state || null);
        if (place) { console.log('geocode google OK', lat, lng, '->', place); return res.json({ place, status: 'OK', source: 'google' }); }
      }
      console.log('geocode google failed', lat, lng, j.status, j.error_message || '');
    } catch (e) { console.log('geocode google error', lat, lng, String((e && e.message) || e)); }
  } else {
    console.log('geocode google skipped: NO_KEY');
  }
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng + '&zoom=10&addressdetails=1', { headers: { 'User-Agent': 'LXL-Driver/1.0 (lubanaxpress.com)' } });
    if (r.ok) {
      const j = await r.json();
      const a = j.address || {};
      const city = a.city || a.town || a.village || a.municipality || a.county || null;
      const iso = a['ISO3166-2-lvl4'] || '';
      const state = (iso.indexOf('US-') === 0 ? iso.slice(3) : null) || a.state_code || a.state || null;
      const place = (city && state) ? (city + ', ' + state) : (city || state || null);
      if (place) { console.log('geocode nominatim OK', lat, lng, '->', place); return res.json({ place, status: 'OK', source: 'nominatim' }); }
      console.log('geocode nominatim no place', lat, lng, JSON.stringify(a));
    } else {
      console.log('geocode nominatim HTTP', r.status);
    }
  } catch (e) { console.log('geocode nominatim error', lat, lng, String((e && e.message) || e)); }
  return res.json({ place: null, status: 'FAILED' });
});

admin.get('/messages/:driverId', (req, res) => {
  const driverUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(req.params.driverId);
  if (!driverUser) return err(res, 404, 'Driver not found');
  db.prepare("UPDATE messages SET read = 1 WHERE driverId = ? AND sender = 'driver'").run(driverUser.id);
  const rows = db.prepare('SELECT * FROM messages WHERE driverId = ? ORDER BY id ASC').all(driverUser.id);
  res.json(rows.map(serializeMessage));
});

admin.post('/messages/:driverId', (req, res) => {
  const { body } = req.body || {};
  if (!body || !String(body).trim()) return err(res, 400, 'body is required');
  const driverUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(req.params.driverId);
  if (!driverUser) return err(res, 404, 'Driver not found');
  const id = db
    .prepare("INSERT INTO messages (driverId, sender, senderName, body, createdAt, read) VALUES (?, 'dispatch', ?, ?, ?, 0)")
    .run(driverUser.id, req.user.name, String(body).trim(), now()).lastInsertRowid;
  notifyDriver(db, driverUser.id, 'dispatch_message', `Message from ${req.user.name}`, String(body).trim()).catch(() => {});
  res.status(201).json(serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id)));
});

// Admin sends a photo or file in the chat (multipart, field "file";
// optional caption in the "body" field).
admin.post('/messages/:driverId/attachment', upload.single('file'), (req, res) => {
  if (!req.file) return err(res, 400, 'file is required');
  const driverUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(req.params.driverId);
  if (!driverUser) return err(res, 404, 'Driver not found');
  const caption = req.body && req.body.body ? String(req.body.body).trim() : '';
  const fileId = insertFileRow(req.file, 'message', null, driverUser.id);
  const id = db
    .prepare("INSERT INTO messages (driverId, sender, senderName, body, createdAt, read, fileId) VALUES (?, 'dispatch', ?, ?, ?, 0, ?)")
    .run(driverUser.id, req.user.name, caption, now(), fileId).lastInsertRowid;
  notifyDriver(db, driverUser.id, 'dispatch_message', `Message from ${req.user.name}`, caption || '📎 Attachment').catch(() => {});
  res.status(201).json(serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id)));
});

admin.delete('/messages/:driverId', (req, res) => {
  const driverUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(req.params.driverId);
  if (!driverUser) return err(res, 404, 'Driver not found');
  const rows = pickMessageRows(driverUser.id, (req.body || {}).ids);
  if (!rows) return err(res, 400, 'ids are required');
  const { fresh, oldCount } = splitDeletable(rows);
  if (!fresh.length) return err(res, 400, 'Messages older than 7 minutes can no longer be deleted for everyone.');
  res.json({ ok: true, deleted: deleteMessagesForEveryone(fresh), skippedOld: oldCount });
});

admin.get('/chat-wallpaper', (req, res) => {
  res.json({ url: chatWallpaperUrlFor(req.user) });
});

admin.post('/chat-wallpaper', upload.single('file'), setChatWallpaper);

admin.delete('/chat-wallpaper', (req, res) => {
  db.prepare('UPDATE users SET chatWallpaperFileId = NULL WHERE id = ?').run(req.user.id);
  res.json({ url: null });
});

// Bell feed for the admin top bar: latest events + unread counts. The
// portal polls this every 15 s to drive the bell badge, the Chat menu
// badge and desktop notifications.
admin.get('/notifications', (_req, res) => {
  const items = db
    .prepare('SELECT * FROM admin_notifications ORDER BY id DESC LIMIT 30')
    .all()
    .map(serializeAdminNotification);
  const unread = db.prepare('SELECT COUNT(*) AS c FROM admin_notifications WHERE read = 0').get().c;
  const byDriverRows = db
    .prepare("SELECT driverId, COUNT(*) AS c FROM messages WHERE sender = 'driver' AND read = 0 GROUP BY driverId")
    .all();
  const byDriver = {};
  let total = 0;
  for (const r of byDriverRows) {
    byDriver[r.driverId] = r.c;
    total += r.c;
  }
  res.json({ items, unread, dispatchUnread: { total, byDriver } });
});

admin.post('/notifications/read', (_req, res) => {
  db.prepare('UPDATE admin_notifications SET read = 1 WHERE read = 0').run();
  res.json({ ok: true });
});

// Chat page (Option B): one row per driver with the last message, the
// unread count, live location and the active load for the side panel.
admin.get('/dispatch/conversations', async (_req, res) => {
  const drivers = db.prepare("SELECT * FROM users WHERE role = 'driver' ORDER BY name").all();
  const out = [];
  for (const d of drivers) {
    const truck = db.prepare('SELECT * FROM trucks WHERE driverId = ?').get(d.id);
    const trailer = db.prepare('SELECT * FROM trailers WHERE driverId = ?').get(d.id);
    const location = db.prepare('SELECT * FROM locations WHERE driverId = ?').get(d.id);
    const lastRow = db.prepare('SELECT * FROM messages WHERE driverId = ? ORDER BY id DESC LIMIT 1').get(d.id);
    const unread = db
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE driverId = ? AND sender = 'driver' AND read = 0")
      .get(d.id).c;
    const activeLoad = db
      .prepare("SELECT * FROM loads WHERE driverId = ? AND status = 'active' ORDER BY createdAt DESC LIMIT 1")
      .get(d.id);
    let place = null;
    if (location) {
      try {
        place = await reversePlace(location.lat, location.lng);
      } catch {
        place = null;
      }
    }
    out.push({
      driver: publicUser(d),
      truck: serializeTruck(truck),
      trailer: serializeTrailer(trailer),
      location: location
        ? {
            lat: location.lat,
            lng: location.lng,
            speedMph: location.speedMph ?? null,
            heading: location.heading ?? null,
            updatedAt: location.updatedAt,
            place,
          }
        : null,
      lastMessage: lastRow ? serializeMessage(lastRow) : null,
      unread,
      activeLoad: activeLoad ? serializeLoad(activeLoad) : null,
    });
  }
  // Drivers with the newest conversation first; quiet drivers last.
  out.sort((a, b) => {
    const ta = a.lastMessage ? a.lastMessage.createdAt : '';
    const tb = b.lastMessage ? b.lastMessage.createdAt : '';
    return tb.localeCompare(ta);
  });
  res.json(out);
});

// Delivery-location gate: a load can only be completed at the delivery
// address. The delivery coordinates are geocoded (OpenStreetMap Nominatim,
// no key) when the load is assigned and cached on the load; the driver's
// position at completion must be within the fence.
const DELIVERY_GEOFENCE_M = 500;
const LOCATION_FRESH_MS = 15 * 60 * 1000;

function distanceMeters(lat1, lng1, lat2, lng2) {
  const r = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * r * Math.asin(Math.sqrt(a));
}

function formatDistance(m) {
  if (m < 1609) return `${Math.round(m)} m`;
  return `${(m / 1609.34).toFixed(1)} mi`;
}

async function geocodeAddress(address) {
  if (!address) return null;
  const direct = await geocodeQuery(address);
  if (direct) return direct;
  // Street-level misses are common for rural/industrial addresses —
  // fall back to the city/state/ZIP segment; city-level coordinates
  // are accurate enough for route distances.
  const parts = String(address).split(',').map((s) => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  const m = last.match(/^(.+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (m) return geocodeQuery(`${m[1]}, ${m[2]} ${m[3]}`);
  if (parts.length > 1) return geocodeQuery(last);
  return null;
}

async function geocodeQuery(q) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
      { headers: { 'User-Agent': 'LXL-Driver/1.0 (lubanaxpress.com)' } },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows || !rows[0]) return null;
    const lat = Number(rows[0].lat);
    const lng = Number(rows[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

// Delivery coordinates for a load: stored ones first, otherwise geocode
// the delivery address now and cache it on the load. Null when the
// address cannot be geocoded — then the location gate cannot run and
// completion falls back to the BOL check only.
async function ensureDeliveryCoords(load) {
  if (typeof load.deliveryLat === 'number' && typeof load.deliveryLng === 'number')
    return { lat: load.deliveryLat, lng: load.deliveryLng };
  const coords = await geocodeAddress(load.deliveryLocation);
  if (!coords) return null;
  db.prepare('UPDATE loads SET deliveryLat = ?, deliveryLng = ? WHERE id = ?').run(
    coords.lat,
    coords.lng,
    load.id,
  );
  return coords;
}

// Pickup coordinates, same pattern as delivery: stored first, otherwise
// geocode and cache. The Loads page progress % needs both route ends.
async function ensurePickupCoords(load) {
  if (typeof load.pickupLat === 'number' && typeof load.pickupLng === 'number')
    return { lat: load.pickupLat, lng: load.pickupLng };
  const coords = await geocodeAddress(load.pickupLocation);
  if (!coords) return null;
  db.prepare('UPDATE loads SET pickupLat = ?, pickupLng = ? WHERE id = ?').run(
    coords.lat,
    coords.lng,
    load.id,
  );
  return coords;
}

// How far an active load has travelled toward its delivery, as a whole
// percentage for the admin Loads page progress line. From the driver's
// latest GPS fix: the share of the pickup→delivery distance no longer
// remaining. At the receiver (within the 500 m completion gate) it reads
// 99; only a completed load reads 100. Null when it cannot be computed
// (cancelled load, no GPS fix yet, or route coords not geocoded yet).
function loadProgress(l) {
  if (l.status === 'completed') return 100;
  if (l.status !== 'active') return null;
  if (typeof l.pickupLat !== 'number' || typeof l.pickupLng !== 'number') return null;
  if (typeof l.deliveryLat !== 'number' || typeof l.deliveryLng !== 'number') return null;
  const loc = db.prepare('SELECT lat, lng FROM locations WHERE driverId = ?').get(l.driverId);
  if (!loc) return null;
  const total = distanceMeters(l.pickupLat, l.pickupLng, l.deliveryLat, l.deliveryLng);
  if (!Number.isFinite(total) || total < 1000) return null;
  const remaining = distanceMeters(loc.lat, loc.lng, l.deliveryLat, l.deliveryLng);
  if (remaining <= 500) return 99;
  const pct = Math.round(100 * (1 - remaining / total));
  return Math.max(0, Math.min(98, pct));
}

// ---------------------------------------------------------------------------
// Outlook (Microsoft Graph): each admin connects their OWN Outlook mailbox
// so rate confirmations can be pulled from the email they pick. Needs a
// Microsoft app registration: OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET as
// env vars (see render.yaml). The refresh token is stored on the admin's
// user row; the access token is refreshed on demand and never stored.
// ---------------------------------------------------------------------------
const OUTLOOK_CLIENT_ID = process.env.OUTLOOK_CLIENT_ID || '';
const OUTLOOK_CLIENT_SECRET = process.env.OUTLOOK_CLIENT_SECRET || '';
const OUTLOOK_REDIRECT_URI =
  process.env.OUTLOOK_REDIRECT_URI || 'https://app.lubanaxpress.com/api/outlook/callback';
const OUTLOOK_TENANT = process.env.OUTLOOK_TENANT || 'common';
// Scopes asked at connect time (auth URL + code exchange). Mail.Send +
// Mail.ReadWrite were added for the Documents page's Send to broker
// (sending, plus drafts for large-file upload sessions): existing
// connections were granted the read scopes only, so they must
// reconnect once before sending works (the send endpoint reports
// that as a 401).
const OUTLOOK_SCOPES = 'Mail.Read Mail.Send Mail.ReadWrite offline_access User.Read';
// Refresh scope for read flows — a subset every connection already has,
// so refreshing a read token can never fail on the newer Mail.Send scope.
// User.Read is needed for the /me call that reads the connected mailbox address.
const OUTLOOK_READ_SCOPES = 'Mail.Read offline_access User.Read';
const OUTLOOK_STATE_TTL_MS = 30 * 60 * 1000; // Outlook sign-in states live in SQLite so a restart cannot wipe them

function outlookConfigured() {
  return !!OUTLOOK_CLIENT_ID && !!OUTLOOK_CLIENT_SECRET;
}

function outlookAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: OUTLOOK_CLIENT_ID,
    response_type: 'code',
    redirect_uri: OUTLOOK_REDIRECT_URI,
    scope: OUTLOOK_SCOPES,
    state,
  });
  return `https://login.microsoftonline.com/${OUTLOOK_TENANT}/oauth2/v2.0/authorize?${params}`;
}

async function outlookTokenRequest(body) {
  const res = await fetch(
    `https://login.microsoftonline.com/${OUTLOOK_TENANT}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error_description || data.error || 'Microsoft sign-in failed');
    e.code = data.error || 'token_failed';
    throw e;
  }
  return data;
}

async function outlookAccessToken(user) {
  if (!user.outlookRefreshToken) {
    const e = new Error('Outlook is not connected for this account — connect it first.');
    // 409, not 401: the web app treats any 401 as an expired app
    // session and signs the admin out — an Outlook problem must
    // never do that.
    e.status = 409;
    throw e;
  }
  try {
    const data = await outlookTokenRequest({
      client_id: OUTLOOK_CLIENT_ID,
      client_secret: OUTLOOK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: user.outlookRefreshToken,
      scope: OUTLOOK_READ_SCOPES,
    });
    // Graph rotates refresh tokens — keep the newest one.
    if (data.refresh_token && data.refresh_token !== user.outlookRefreshToken) {
      db.prepare('UPDATE users SET outlookRefreshToken = ? WHERE id = ?').run(data.refresh_token, user.id);
    }
    return data.access_token;
  } catch (e) {
    if (e.code === 'invalid_grant') {
      db.prepare('UPDATE users SET outlookRefreshToken = NULL, outlookEmail = NULL, outlookConnectedAt = NULL WHERE id = ?').run(user.id);
      const gone = new Error('Outlook needs to be connected again — the permission was revoked or expired.');
      gone.status = 409;
      throw gone;
    }
    throw e;
  }
}

async function outlookGraph(accessToken, path) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error((data.error && data.error.message) || 'Outlook request failed');
    e.status = res.status;
    throw e;
  }
  return data;
}

// Graph request with a method + JSON body (reply / send flows).
async function outlookGraphReq(accessToken, method, path, body) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error((data.error && data.error.message) || 'Outlook request failed');
    e.status = res.status;
    throw e;
  }
  return data;
}

// Attach one stored file to a draft message. Files up to 3 MB go in a
// single request; larger files use an attachment upload session and
// are PUT to Microsoft in chunks (the session URL is pre-authorized —
// no Authorization header may be sent with the chunks).
const GRAPH_SIMPLE_ATTACH_LIMIT = 3 * 1024 * 1024;
const GRAPH_CHUNK = 5 * 1024 * 1024; // a multiple of 320 KiB, as Graph requires

async function attachFileToDraft(accessToken, draftId, doc) {
  const filePath = path.join(UPLOADS_DIR, doc.storedFilename);
  const size = fs.statSync(filePath).size;
  if (size <= GRAPH_SIMPLE_ATTACH_LIMIT) {
    await outlookGraphReq(accessToken, 'POST', `/me/messages/${encodeURIComponent(draftId)}/attachments`, {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: doc.originalFilename,
      contentType: doc.mimeType || 'application/octet-stream',
      contentBytes: fs.readFileSync(filePath).toString('base64'),
    });
    return;
  }
  const session = await outlookGraphReq(accessToken, 'POST', `/me/messages/${encodeURIComponent(draftId)}/attachments/createUploadSession`, {
    AttachmentItem: {
      attachmentType: 'file',
      name: doc.originalFilename,
      size,
      contentType: doc.mimeType || 'application/octet-stream',
    },
  });
  const uploadUrl = session.uploadUrl;
  if (!uploadUrl) throw new Error('Microsoft did not start the large-file upload');
  const fd = fs.openSync(filePath, 'r');
  try {
    let offset = 0;
    while (offset < size) {
      const len = Math.min(GRAPH_CHUNK, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const up = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${offset}-${offset + len - 1}/${size}`,
        },
        body: buf,
      });
      if (!up.ok) throw new Error(`Large-file upload failed at byte ${offset}`);
      offset += len;
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Access token that may SEND mail (Documents → Send to broker). The
// stored refresh token only carries Mail.Send after the admin has
// reconnected once since that scope was added; before that Microsoft
// rejects the refresh and we surface a reconnect prompt (409).
async function outlookSendAccessToken(user) {
  if (!user.outlookRefreshToken) {
    const e = new Error('Outlook is not connected for this account — connect it first.');
    e.status = 409;
    throw e;
  }
  try {
    const data = await outlookTokenRequest({
      client_id: OUTLOOK_CLIENT_ID,
      client_secret: OUTLOOK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: user.outlookRefreshToken,
      scope: 'Mail.Send Mail.ReadWrite offline_access',
    });
    if (data.refresh_token && data.refresh_token !== user.outlookRefreshToken) {
      db.prepare('UPDATE users SET outlookRefreshToken = ? WHERE id = ?').run(data.refresh_token, user.id);
    }
    return data.access_token;
  } catch (e) {
    const gone = new Error('Sending needs one extra Outlook permission — reconnect Outlook once, then send again.');
    gone.status = 409;
    gone.code = 'needs_reconnect';
    throw gone;
  }
}

// Plain text from a Graph message body (thread display).
function graphBodyText(m) {
  const b = m.body;
  if (!b || !b.content) return m.bodyPreview || '';
  if (b.contentType === 'text') return b.content;
  return b.content
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

// Two-letter state code from a load address like "904 Edwards Dr, Lebanon IN 46052".
function stateFromAddress(address) {
  if (!address) return null;
  const m = String(address).match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\s*$/);
  if (m) return m[1];
  const tail = String(address).split(',').pop() || '';
  const m2 = tail.match(/\b([A-Z]{2})\b/);
  return m2 ? m2[1] : null;
}

// Local calendar date (YYYY-MM-DD) of an ISO timestamp in the load's zone.
function dateInZone(iso, tz) {
  if (!iso) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'America/Indiana/Indianapolis',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(iso));
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return String(iso).slice(0, 10);
  }
}

admin.get('/rate-confirmations', (_req, res) => {
  const rows = db
    .prepare(
      'SELECT r.*, f.originalFilename, f.mimeType FROM rate_confirmations r LEFT JOIN files f ON f.id = r.fileId ORDER BY r.createdAt DESC, r.id DESC',
    )
    .all();
  res.json(rows.map(serializeRateCon));
});

// Save a rate confirmation, naming the file from the load. Shared by the
// file-upload endpoint and the Outlook endpoint. Throws an Error with
// .status (400/404) for bad input.
// --- Rate confirmation auto-detection ------------------------------------
// Read the rate ($ amount) and broker name out of an RC PDF so the admin
// never has to type them. Runs on every upload, and once at startup for
// any RC row saved before this existed. Never breaks the upload: on any
// failure it returns {} and the row keeps nulls.
async function pdfTextFromBuffer(fileBuffer) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fileBuffer) }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(' ') + '\n';
  }
  return text;
}

function cleanRateText(text) {
  // Strip control chars pdf.js leaves behind, collapse whitespace.
  return String(text || '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function amountToCents(s) {
  const n = parseFloat(String(s).replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 50 || n > 50000) return null;
  return Math.round(n * 100);
}

function detectRateCents(text) {
  // Keyword-anchored first: the total is what gets paid.
  const patterns = [
    /TOTAL\s+RATE\s*:?\s*\$?\s*([\d,]+\.\d{2})/i,
    /LINE\s+HAUL(?:\s+RATE)?\s*:?\s*\$?\s*([\d,]+\.\d{2})/i,
    /TOTAL\s+(?:PAY|AMOUNT|CHARGES?|DUE)\s*:?\s*\$?\s*([\d,]+\.\d{2})/i,
    /FLAT\s+RATE\s*:?\s*\$?\s*([\d,]+\.\d{2})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const c = amountToCents(m[1]);
      if (c != null) return c;
    }
  }
  // Fallback: largest plausible dollar amount in the document (fees and
  // fines are smaller; cargo-insurance figures are way above the cap).
  let best = null;
  for (const m of text.matchAll(/\$?\s*([\d,]+\.\d{2})/g)) {
    const c = amountToCents(m[1]);
    if (c != null && (best == null || c > best)) best = c;
  }
  return best;
}

function detectReceiptTotalCents(text) {
  // Receipt totals are smaller than rate-cons ($1–$10,000: a fuel fill,
  // a toll, a parking fee). Keyword-anchored first, then the largest
  // plausible amount on the page.
  const toCents = (s) => {
    const n = parseFloat(String(s).replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 1 || n > 10000) return null;
    return Math.round(n * 100);
  };
  const patterns = [
    /TOTAL\s+DUE\s*:?\s*\$?\s*([\d,]+\.\d{2})/i,
    /GRAND\s+TOTAL\s*:?\s*\$?\s*([\d,]+\.\d{2})/i,
    /TOTAL\s+AMOUNT\s*:?\s*\$?\s*([\d,]+\.\d{2})/i,
    /AMOUNT\s+DUE\s*:?\s*\$?\s*([\d,]+\.\d{2})/i,
    /BALANCE\s+DUE\s*:?\s*\$?\s*([\d,]+\.\d{2})/i,
    /TOTAL\s+CHARGE\s*:?\s*\$?\s*([\d,]+\.\d{2})/i,
    /TOTAL\s+SALE\s*:?\s*\$?\s*([\d,]+\.\d{2})/i,
    /AMOUNT\s+PAID\s*:?\s*\$?\s*([\d,]+\.\d{2})/i,
    /\bTOTAL\b\s*:?\s*\$?\s*([\d,]+\.\d{2})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const c = toCents(m[1]);
      if (c != null) return c;
    }
  }
  let best = null;
  for (const m of text.matchAll(/\$?\s*([\d,]+\.\d{2})/g)) {
    const c = toCents(m[1]);
    if (c != null && (best == null || c > best)) best = c;
  }
  return best;
}

function cleanBrokerName(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.)]+$/g, '').trim() || null;
}

function detectBroker(text, subject) {
  // Email subject first: "Carrier Rate Confirmation Pro # 2038499 from
  // D & L TRANSPORT, LLC" — the broker is everything after "from".
  if (subject) {
    const m = String(subject).match(/\bfrom\s+(.+?)\s*$/i);
    if (m && m[1].trim().length > 1) return cleanBrokerName(m[1]);
  }
  // PDF text: drop "Att: <name>" headers (they sit in front of the broker
  // name), then take the first company-like name near the top.
  const head = cleanRateText(text).slice(0, 2000).replace(/\bAttn?\s*:?\s*[A-Z][A-Za-z]+/g, '');
  const m = head.match(/([A-Z][A-Za-z0-9&'.,\- ]{1,60}?(?:LLC|Inc\.?|Ltd\.?|Corp\.?|Co\.?))\b/);
  if (m) return cleanBrokerName(m[1]);
  const m2 = head.match(/([A-Z][A-Za-z0-9&'.,\- ]{1,60}?(?:TRANSPORT|LOGISTICS|FREIGHT|EXPRESS|TRUCKING))\b/);
  if (m2) return cleanBrokerName(m2[1]);
  return null;
}

async function extractRateConDetails(fileBuffer, subject) {
  try {
    if (!fileBuffer || fileBuffer.length < 4 || fileBuffer.subarray(0, 4).toString('ascii') !== '%PDF') return {};
    const text = cleanRateText(await pdfTextFromBuffer(fileBuffer));
    if (!text) return {};
    return { broker: detectBroker(text, subject), rateCents: detectRateCents(text) };
  } catch (e) {
    console.error('rate-con auto-detect failed', e);
    return {};
  }
}

// One-time backfill: RC rows saved before auto-detection get their rate
// and broker read from the stored PDF the next time the server starts.
async function backfillRateConDetails() {
  try {
    const rows = db
      .prepare(
        `SELECT r.id, r.rateCents, r.broker, f.storedFilename FROM rate_confirmations r
         LEFT JOIN files f ON f.id = r.fileId
         WHERE (r.rateCents IS NULL OR r.broker IS NULL) AND f.storedFilename IS NOT NULL`,
      )
      .all();
    for (const row of rows) {
      try {
        const buf = fs.readFileSync(path.join(UPLOADS_DIR, row.storedFilename));
        const d = await extractRateConDetails(buf);
        const nb = row.broker ?? d.broker ?? null;
        const nr = row.rateCents != null ? row.rateCents : (d.rateCents ?? null);
        if (nb !== row.broker || nr !== row.rateCents) {
          db.prepare('UPDATE rate_confirmations SET broker = ?, rateCents = ? WHERE id = ?').run(nb, nr, row.id);
          console.log(`rate-con backfill: RC ${row.id} broker=${nb} rateCents=${nr}`);
        }
      } catch (e) {
        console.error(`rate-con backfill failed for RC ${row.id}`, e);
      }
    }
  } catch (e) {
    console.error('rate-con backfill failed', e);
  }
}

async function createRateCon({ loadId, reference, pickupState, deliveryState, pickupDate, deliveryDate, broker, rateCents, fileBuffer, fileName, mimeType, subject }) {
  // Pick a load and the file is named from the load — no typing. Typed
  // fields still win when given (older clients send them).
  let load = null;
  if (loadId) {
    load = db.prepare('SELECT * FROM loads WHERE id = ?').get(Number(loadId));
    if (!load) throw Object.assign(new Error('Load not found'), { status: 404 });
  }
  const ref = reference || (load && load.reference);
  const pState = pickupState || (load && stateFromAddress(load.pickupLocation));
  const dState = deliveryState || (load && stateFromAddress(load.deliveryLocation));
  const pDate = pickupDate || (load && dateInZone(load.pickupAt, load.pickupTimezone));
  const dDate = deliveryDate || (load && dateInZone(load.deliveryAt, load.deliveryTimezone));
  if (!ref || !pState || !dState || !pDate || !dDate)
    throw Object.assign(new Error('Pick a load, or fill in reference, pickup/delivery state and dates'), { status: 400 });
  const ext = fileName ? path.extname(fileName || '') : '';
  const autoName = `${ref}_${pState}-${dState}_${pDate}_to_${dDate}${ext}`;
  // Auto-detect rate + broker from the PDF when they weren't typed.
  // Typed values still win when given (older clients send them).
  let detected = {};
  if ((!broker || rateCents == null) && fileBuffer) detected = await extractRateConDetails(fileBuffer, subject);
  const finalBroker = broker ?? detected.broker ?? null;
  const finalRate = rateCents != null ? Number(rateCents) : (detected.rateCents ?? null);
  let fileId = null;
  if (fileBuffer) {
    // Avoid clobbering an existing file with the same auto-generated name.
    let finalName = autoName;
    let n = 1;
    while (fs.existsSync(path.join(UPLOADS_DIR, finalName))) {
      finalName = `${ref}_${pState}-${dState}_${pDate}_to_${dDate}-${n}${ext}`;
      n += 1;
    }
    fs.writeFileSync(path.join(UPLOADS_DIR, finalName), fileBuffer);
    fileId = db
      .prepare(
        'INSERT INTO files (storedFilename, originalFilename, mimeType, ownerType, ownerId, driverId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(finalName, finalName, mimeType || 'application/octet-stream', 'rate_confirmation', null, null, now()).lastInsertRowid;
  }
  const id = db
    .prepare(
      'INSERT INTO rate_confirmations (reference, loadId, broker, pickupState, deliveryState, pickupDate, deliveryDate, rateCents, fileId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      ref,
      loadId ? Number(loadId) : null,
      finalBroker,
      pState,
      dState,
      pDate,
      dDate,
      finalRate,
      fileId,
      now(),
    ).lastInsertRowid;
  const row = db
    .prepare('SELECT r.*, f.originalFilename, f.mimeType FROM rate_confirmations r LEFT JOIN files f ON f.id = r.fileId WHERE r.id = ?')
    .get(id);
  // No file: still report the auto-generated name as the filename.
  if (!fileId) row.originalFilename = autoName;
  const out = serializeRateCon(row);
  notifyAdmins(
    'ratecon',
    'Rate confirmation added',
    `${out.broker || '—'} · ${out.rateCents != null ? '$' + (Number(out.rateCents) / 100).toFixed(2) : 'rate —'}`,
    'ratecons',
    out.id,
  );
  return out;
}

admin.post('/rate-confirmations', upload.single('file'), async (req, res) => {
  const { loadId, reference, pickupState, deliveryState, pickupDate, deliveryDate, broker, rateCents } = req.body || {};
  try {
    let fileBuffer = null;
    let fileName = null;
    let mimeType = null;
    if (req.file) {
      fileBuffer = fs.readFileSync(req.file.path);
      fileName = req.file.originalname;
      mimeType = req.file.mimetype;
      fs.unlinkSync(req.file.path);
    }
    res.status(201).json(
      await createRateCon({ loadId, reference, pickupState, deliveryState, pickupDate, deliveryDate, broker, rateCents, fileBuffer, fileName, mimeType }),
    );
  } catch (e) {
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {}
    }
    if (e.status) return err(res, e.status, e.message);
    throw e;
  }
});

// Pull the RC file from the signed-in admin's own Outlook mailbox instead
// of uploading it: pick the email, pick the attachment, pick the load.
admin.post('/rate-confirmations/from-outlook', async (req, res) => {
  try {
    const { loadId, messageId, attachmentId, subject } = req.body || {};
    if (!loadId || !messageId || !attachmentId)
      return err(res, 400, 'loadId, messageId and attachmentId are required');
    const user = getUserById(req.user.id);
    const accessToken = await outlookAccessToken(user);
    const att = await outlookGraph(
      accessToken,
      `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    if (!att.contentBytes)
      return err(res, 400, 'That attachment has no file to download — pick a file attachment (PDF).');
    const fileBuffer = Buffer.from(att.contentBytes, 'base64');
    if (!fileBuffer.length) return err(res, 400, 'That attachment is empty.');
    res.status(201).json(
      await createRateCon({ loadId, fileBuffer, fileName: att.name || 'rate-confirmation.pdf', mimeType: att.contentType || 'application/pdf', subject }),
    );
  } catch (e) {
    if (e.status) return err(res, e.status, e.message);
    console.error('rate-con from outlook failed', e);
    return err(res, 500, 'Could not pull the file from Outlook');
  }
});

// Outlook: connect this admin's own mailbox, list RC emails, pull the file.
admin.get('/outlook/status', (req, res) => {
  const user = getUserById(req.user.id);
  res.json({ configured: outlookConfigured(), connected: !!user.outlookRefreshToken, email: user.outlookEmail ?? null });
});

admin.get('/outlook/auth-url', (req, res) => {
  if (!outlookConfigured())
    return err(res, 400, 'Outlook is not set up on the server yet — the main admin needs to finish the Microsoft setup.');
  const state = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO outlook_states (state, userId, createdAt) VALUES (?, ?, ?)').run(state, req.user.id, Date.now());
  db.prepare('DELETE FROM outlook_states WHERE createdAt < ?').run(Date.now() - OUTLOOK_STATE_TTL_MS);
  res.json({ url: outlookAuthUrl(state) });
});

admin.post('/outlook/disconnect', (req, res) => {
  db.prepare('UPDATE users SET outlookRefreshToken = NULL, outlookEmail = NULL, outlookConnectedAt = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

admin.get('/outlook/messages', async (req, res) => {
  try {
    const user = getUserById(req.user.id);
    const accessToken = await outlookAccessToken(user);
    const search = (req.query.search || '').trim();
    const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    // NOTE: do NOT combine $filter with $orderby here — Exchange rejects
    // hasAttachments + orderby with "The restriction or sort order is too
    // complex for this operation." And $filter alone returns the OLDEST
    // matching messages first (the first $top in store order), which hid
    // every recent email behind the mailbox's earliest ones. So: pull
    // the newest 500 messages with $orderby only, keep the ones with
    // attachments in code, newest first, take 20.
    const path = search
      ? `/me/messages?${q({ $search: `"${search}"`, $top: '20', $select: 'id,subject,from,receivedDateTime,hasAttachments' })}`
      : `/me/messages?${q({ $orderby: 'receivedDateTime desc', $top: '500', $select: 'id,subject,from,receivedDateTime,hasAttachments' })}`;
    const data = await outlookGraph(accessToken, path);
    let list = (data.value || []).map((m) => ({
      id: m.id,
      subject: m.subject ?? '(no subject)',
      from: (m.from && m.from.emailAddress && (m.from.emailAddress.name || m.from.emailAddress.address)) || '',
      receivedAt: m.receivedDateTime,
      hasAttachments: !!m.hasAttachments,
    }));
    list.sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0));
    if (!search) list = list.filter((m) => m.hasAttachments).slice(0, 20);
    res.json(list);
  } catch (e) {
    if (e.status) return err(res, e.status, e.message);
    console.error('outlook messages failed', e);
    return err(res, 500, 'Could not list Outlook emails');
  }
});

admin.get('/outlook/messages/:id/attachments', async (req, res) => {
  try {
    const user = getUserById(req.user.id);
    const accessToken = await outlookAccessToken(user);
    const data = await outlookGraph(
      accessToken,
      `/me/messages/${encodeURIComponent(req.params.id)}/attachments?$select=id,name,size,contentType`,
    );
    res.json((data.value || []).map((a) => ({ id: a.id, name: a.name, size: a.size ?? null, contentType: a.contentType ?? null })));
  } catch (e) {
    if (e.status) return err(res, e.status, e.message);
    console.error('outlook attachments failed', e);
    return err(res, 500, 'Could not list attachments');
  }
});

// --- Documents → Send to broker -------------------------------------------
// The Documents page picks a conversation from the admin's own Outlook
// inbox, shows the thread in order, and replies in that same thread with
// the selected BOL / receipt files attached.

function conversationContact(messages, ownEmail) {
  // The broker side of a thread: the newest sender who is not the
  // mailbox owner. Falls back to the newest message's sender.
  const own = (ownEmail || '').toLowerCase();
  const sorted = [...messages].sort((a, b) => new Date(b.receivedDateTime || 0) - new Date(a.receivedDateTime || 0));
  for (const m of sorted) {
    const ea = m.from && m.from.emailAddress;
    if (ea && ea.address && ea.address.toLowerCase() !== own) {
      return { name: ea.name || ea.address, email: ea.address };
    }
  }
  const first = sorted[0] && sorted[0].from && sorted[0].from.emailAddress;
  return first ? { name: first.name || first.address || '', email: first.address || '' } : { name: '', email: '' };
}

admin.get('/outlook/conversations', async (req, res) => {
  try {
    const user = getUserById(req.user.id);
    const accessToken = await outlookAccessToken(user);
    const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const data = await outlookGraph(
      accessToken,
      `/me/mailFolders/inbox/messages?${q({ $top: '60', $orderby: 'receivedDateTime desc', $select: 'id,conversationId,subject,from,receivedDateTime,bodyPreview' })}`,
    );
    const byConv = new Map();
    for (const m of data.value || []) {
      if (!m.conversationId) continue;
      if (!byConv.has(m.conversationId)) byConv.set(m.conversationId, []);
      byConv.get(m.conversationId).push(m);
    }
    const list = [...byConv.entries()].map(([conversationId, msgs]) => {
      const latest = msgs[0]; // the inbox query is newest-first
      const contact = conversationContact(msgs, user.outlookEmail);
      return {
        conversationId,
        subject: latest.subject ?? '(no subject)',
        fromName: contact.name,
        fromEmail: contact.email,
        lastAt: latest.receivedDateTime,
        snippet: latest.bodyPreview || '',
      };
    });
    list.sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));
    res.json(list.slice(0, 25));
  } catch (e) {
    if (e.status) return err(res, e.status, e.message);
    console.error('outlook conversations failed', e);
    return err(res, 500, 'Could not list Outlook conversations');
  }
});

admin.get('/outlook/thread', async (req, res) => {
  try {
    const user = getUserById(req.user.id);
    const accessToken = await outlookAccessToken(user);
    const conversationId = String(req.query.conversationId || '');
    if (!conversationId) return err(res, 400, 'conversationId is required');
    const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const data = await outlookGraph(
      accessToken,
      `/me/messages?${q({ $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`, $top: '50', $select: 'id,subject,from,receivedDateTime,body,bodyPreview' })}`,
    );
    const msgs = [...(data.value || [])].sort((a, b) => new Date(a.receivedDateTime || 0) - new Date(b.receivedDateTime || 0));
    const contact = conversationContact(msgs, user.outlookEmail);
    const own = (user.outlookEmail || '').toLowerCase();
    res.json({
      conversationId,
      subject: (msgs[0] && msgs[0].subject) || '(no subject)',
      toName: contact.name,
      toEmail: contact.email,
      messages: msgs.map((m) => ({
        id: m.id,
        fromName: (m.from && m.from.emailAddress && (m.from.emailAddress.name || m.from.emailAddress.address)) || '',
        fromEmail: (m.from && m.from.emailAddress && m.from.emailAddress.address) || '',
        mine: ((m.from && m.from.emailAddress && m.from.emailAddress.address) || '').toLowerCase() === own,
        at: m.receivedDateTime,
        text: graphBodyText(m),
      })),
    });
  } catch (e) {
    if (e.status) return err(res, e.status, e.message);
    console.error('outlook thread failed', e);
    return err(res, 500, 'Could not load the conversation');
  }
});

// The sender's Outlook signature lives only in their mailbox (Graph
// has no signature API), so capture it from their own sent mail: the
// signature block in the sender's part of a message, before the quoted
// thread starts. The "Get Outlook for iOS" placeholder is not a
// signature and is rejected.
function extractSignatureHtml(html) {
  if (!html) return null;
  const own = String(html).split('divRplyFwdMsg')[0];
  const markers = ['id="ms-outlook-mobile-signature"', "id='ms-outlook-mobile-signature'", 'id="Signature"', 'id="x_Signature"'];
  let start = -1;
  for (const mk of markers) {
    const i = own.indexOf(mk);
    if (i !== -1) { start = own.lastIndexOf('<div', i); break; }
  }
  if (start === -1) return null;
  let end = own.indexOf('<hr', start);
  if (end === -1) end = own.length;
  let block = own.slice(start, end).trim();
  if (!block || block.includes('aka.ms/o0ukef')) return null;
  if (!block.endsWith('>')) block = block.slice(0, block.lastIndexOf('>') + 1);
  return block.length > 40 ? block : null;
}

// The admin's signature: the stored copy once captured; on first use,
// capture it from their recent sent mail (newest first) and store it.
async function getUserSignatureHtml(user, readToken) {
  if (user.emailSignatureHtml) return user.emailSignatureHtml;
  try {
    const data = await outlookGraph(readToken, '/me/mailFolders/sentitems/messages?$top=10&$select=body');
    for (const msg of data.value || []) {
      const sig = extractSignatureHtml(msg.body && msg.body.content);
      if (sig) {
        db.prepare('UPDATE users SET emailSignatureHtml = ? WHERE id = ?').run(sig, user.id);
        return sig;
      }
    }
  } catch { /* the signature is optional — send without it */ }
  return null;
}

admin.post('/outlook/send-documents', async (req, res) => {
  let draftId = null;
  let sendToken = null;
  try {
    const user = getUserById(req.user.id);
    const { conversationId, body } = req.body || {};
    const documentIds = Array.isArray(req.body?.documentIds) ? req.body.documentIds : [];
    if (!conversationId) return err(res, 400, 'Pick a conversation first');
    if (!documentIds.length) return err(res, 400, 'Select at least one file to send');
    const docs = documentIds.map((id) => {
      const d = db
        .prepare('SELECT d.*, f.originalFilename, f.mimeType, f.storedFilename FROM documents d JOIN files f ON f.id = d.fileId WHERE d.id = ?')
        .get(id);
      if (!d) throw Object.assign(new Error('One of the selected files no longer exists'), { status: 400 });
      return d;
    });
    for (const d of docs) {
      if (!fs.existsSync(path.join(UPLOADS_DIR, d.storedFilename))) return err(res, 400, `File ${d.originalFilename} is missing on the server`);
    }
    const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const readToken = await outlookAccessToken(user);
    // No $orderby here: Exchange rejects filter+orderby on different
    // properties ("The restriction or sort order is too complex"), so
    // the newest message in the thread is picked client-side instead.
    const latest = await outlookGraph(
      readToken,
      `/me/messages?${q({ $filter: `conversationId eq '${String(conversationId).replace(/'/g, "''")}'`, $top: '50', $select: 'id,receivedDateTime' })}`,
    );
    const lastMsg = (latest.value || []).slice().sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime))[0];
    if (!lastMsg) return err(res, 404, 'That conversation could not be found');
    sendToken = await outlookSendAccessToken(user);
    // Build the reply as a draft first: files over 3 MB can only be
    // attached through upload sessions, which exist on drafts. Then
    // send the draft — it lands in the same conversation.
    const draft = await outlookGraphReq(sendToken, 'POST', `/me/messages/${encodeURIComponent(lastMsg.id)}/createReply`, {});
    draftId = draft.id;
    const note = String(body || '').trim() || 'Please see the attached documents.';
    const cur = await outlookGraph(sendToken, `/me/messages/${encodeURIComponent(draftId)}?$select=body`);
    const escHtml = note.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    const existing = (cur.body && cur.body.content) || '';
    // Append the sender's Outlook signature under the note, the same
    // place Outlook itself puts it (before the quoted thread).
    const sigHtml = await getUserSignatureHtml(user, readToken);
    await outlookGraphReq(sendToken, 'PATCH', `/me/messages/${encodeURIComponent(draftId)}`, {
      body: { contentType: 'html', content: `<p>${escHtml}</p>` + (sigHtml || '<br>') + existing },
    });
    for (const d of docs) {
      await attachFileToDraft(sendToken, draftId, d);
    }
    await outlookGraphReq(sendToken, 'POST', `/me/messages/${encodeURIComponent(draftId)}/send`);
    draftId = null;
    res.json({ ok: true, sent: docs.length });
  } catch (e) {
    if (draftId && sendToken) {
      try {
        await outlookGraphReq(sendToken, 'DELETE', `/me/messages/${encodeURIComponent(draftId)}`);
      } catch { /* best effort */ }
    }
    if (e.status) return err(res, e.status, e.message);
    console.error('outlook send-documents failed', e);
    return err(res, 500, 'Could not send the email');
  }
});

admin.delete('/rate-confirmations/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM rate_confirmations WHERE id = ?').get(req.params.id);
  if (!row) return err(res, 404, 'Rate confirmation not found');
  db.prepare('DELETE FROM rate_confirmations WHERE id = ?').run(row.id);
  if (row.fileId) {
    const f = getFileRow(row.fileId);
    db.prepare('DELETE FROM files WHERE id = ?').run(row.fileId);
    if (f) {
      try {
        fs.unlinkSync(path.join(UPLOADS_DIR, f.storedFilename));
      } catch {
        // file already gone — ignore
      }
    }
  }
  res.json({ ok: true });
});

// --- Equipment document date auto-detection -------------------------------
// Read the issue + expiry dates off an uploaded cab card / insurance /
// inspection so the admin does not have to type them. PDFs via pdf.js
// text, photos via tesseract OCR (same guarded pattern as receipt-amount:
// the errorHandler is REQUIRED or a bad image kills the process). Never
// throws — on any failure it returns {} and the dates stay blank for
// manual entry.
async function extractFileText(buf) {
  const isPdf = buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF';
  const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (isPdf) return cleanRateText(await pdfTextFromBuffer(buf));
  if ((isJpeg || isPng) && buf.length > 1024) {
    const worker = await createWorker('eng', undefined, {
      errorHandler: (e) => console.error('equipment-doc tesseract worker error', e),
    });
    try {
      const { data } = await worker.recognize(buf);
      return cleanRateText(data.text || '');
    } finally {
      try { await worker.terminate(); } catch { /* already gone */ }
    }
  }
  return '';
}

const MONTHS_RX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function toIso(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 2015 || y > new Date().getUTCFullYear() + 7) return null;
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
function findAllDates(text) {
  const out = [];
  const push = (iso, idx) => { if (iso) out.push({ iso, idx }); };
  let m;
  const rxNum = /\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/g;
  while ((m = rxNum.exec(text))) push(toIso(+m[3], +m[1], +m[2]), m.index);
  const rxNum2 = /\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2})\b/g;
  while ((m = rxNum2.exec(text))) push(toIso(2000 + (+m[3]), +m[1], +m[2]), m.index);
  const rxIso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = rxIso.exec(text))) push(toIso(+m[1], +m[2], +m[3]), m.index);
  const rxMon = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi;
  while ((m = rxMon.exec(text))) push(toIso(+m[3], MONTHS_RX[m[1].slice(0, 3).toLowerCase()], +m[2]), m.index);
  const rxMon2 = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/gi;
  while ((m = rxMon2.exec(text))) push(toIso(+m[3], MONTHS_RX[m[2].slice(0, 3).toLowerCase()], +m[1]), m.index);
  return out.sort((a, b) => a.idx - b.idx);
}
function dateNearLabel(text, dates, labelRx) {
  const m = labelRx.exec(text);
  if (!m) return null;
  const after = dates.find(d => d.idx >= m.index && d.idx - m.index <= 48);
  return after ? after.iso : null;
}
function detectDocDates(text) {
  if (!text) return {};
  const dates = findAllDates(text);
  if (!dates.length) return {};
  let expiry = dateNearLabel(text, dates, /expir\w*|valid\s+(through|until|thru|to)|exp\.?\s*date|coverage\s+(ends|through|until)/i);
  let issued = dateNearLabel(text, dates, /issu\w*|effective|date\s+issued|inception/i);
  const uniq = [...new Set(dates.map(d => d.iso))].sort();
  if (!expiry && uniq.length) expiry = uniq[uniq.length - 1];
  if (!issued && uniq.length > 1) issued = uniq[0];
  if (issued && expiry && issued > expiry) issued = null;
  if (issued === expiry) issued = null;
  const out = {};
  if (issued) out.issuedDate = issued;
  if (expiry) out.expiryDate = expiry;
  return out;
}
async function detectDatesForFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const text = await extractFileText(buf);
    const found = detectDocDates(text);
    console.log('equipment-doc dates', { bytes: buf.length, textLen: text.length, ...found });
    return found;
  } catch (e) {
    console.error('equipment-doc date detection failed', e);
    return {};
  }
}

// ---- Cab-card vehicle recognition (owner's ask, 2026-11-15) ----------
// When a cab card is uploaded for a truck or trailer, read the vehicle
// off the card — year, make, model (plus VIN and plate when shown) — and
// fill the unit's EMPTY fields with them, so the year/make/model shows
// under the unit number on the Trucks & Trailers page. Existing values
// are never overwritten.
const VEHICLE_MAKES = [
  ['KENWORTH', 'Kenworth'], ['FREIGHTLINER', 'Freightliner'], ['PETERBILT', 'Peterbilt'],
  ['INTERNATIONAL', 'International'], ['VOLVO', 'Volvo'], ['MACK', 'Mack'],
  ['UTILITY', 'Utility'], ['WABASH', 'Wabash'], ['GREAT DANE', 'Great Dane'],
  ['HYUNDAI', 'Hyundai'], ['STOUGHTON', 'Stoughton'], ['VANGUARD', 'Vanguard'],
  ['MANAC', 'Manac'], ['FONTAINE', 'Fontaine'], ['REITNOUER', 'Reitnouer'],
  ['TRAIL KING', 'Trail King'], ['EAST', 'East'], ['WESTERN STAR', 'Western Star'],
];
const VEHICLE_MODELS = [
  'T680', 'T880', 'T800', 'W900', 'W990', 'T370', 'CASCADIA', 'CORONADO', 'COLUMBIA',
  'LT625', 'LT', 'PROSTAR', 'DURASTAR', 'VNL 760', 'VNL 860', 'VNL', 'VNR', 'VHD',
  '579', '567', '389', '379', '589', 'ANTHEM', 'PINNACLE', 'GRANITE',
  '3000R', '4000D', 'DURAPLATE', 'CHAMPION', 'CHAPARRAL', 'SSL', 'REEFER',
];
function detectVehicleInfo(text) {
  if (!text) return {};
  const flat = String(text).replace(/\s+/g, ' ');
  const upper = flat.toUpperCase();
  const out = {};
  const vinM = upper.match(/\b[A-HJ-NPR-Z0-9]{17}\b/);
  if (vinM) out.vin = vinM[0];
  let make = null;
  let makeIdx = -1;
  for (const [raw, canon] of VEHICLE_MAKES) {
    const i = upper.indexOf(raw);
    if (i >= 0) { make = canon; makeIdx = i; break; }
  }
  if (make) out.make = make;
  // Year: an explicit label first, then a year printed just before the
  // make (cab cards commonly read "2021 KENWORTH T680"). Never a bare
  // year from anywhere on the card — issue/expiry years would poison it.
  const yrLabel = flat.match(/(?:year|yr)\s*[:#]?\s*((?:19|20)\d{2})\b/i);
  if (yrLabel) out.year = parseInt(yrLabel[1], 10);
  else if (makeIdx > 0) {
    const before = upper.slice(Math.max(0, makeIdx - 24), makeIdx);
    const yrs = [...before.matchAll(/\b((?:19|20)\d{2})\b/g)];
    if (yrs.length) out.year = parseInt(yrs[yrs.length - 1][1], 10);
  }
  if (out.year && (out.year < 1990 || out.year > new Date().getFullYear() + 1)) delete out.year;
  // Model: a label wins; otherwise a known model token near the make.
  // A known token inside the captured text beats the raw capture (OCR
  // often glues the next field onto it, e.g. "3000R IN" for "3000R VIN:").
  const modelDisplay = (raw) =>
    (/\d/.test(raw) || raw.length <= 5 || raw.includes(' ')) ? raw : raw.charAt(0) + raw.slice(1).toLowerCase();
  const mdlLabel = flat.match(/(?:model|mdl)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9 \-]{1,14})/i);
  if (mdlLabel) {
    const cand = mdlLabel[1].trim().split(/\s{2,}|\b(?:VIN|PLATE|LICENSE|YEAR|MAKE)\b/i)[0].trim();
    const known = VEHICLE_MODELS.find(mdl => cand.toUpperCase().includes(mdl));
    if (known) out.model = modelDisplay(known);
    else if (cand && cand.length >= 2) out.model = cand.split(/\s+/).slice(0, 2).join(' ');
  }
  if (!out.model) {
    const hay = makeIdx >= 0 ? upper.slice(makeIdx, makeIdx + 60) : upper;
    const known = VEHICLE_MODELS.find(mdl => hay.includes(mdl));
    if (known) out.model = modelDisplay(known);
  }
  const plateM = flat.match(/(?:plate|lic(?:ense)?\s*(?:no\.?|number|#)?)\s*[:#]?\s*([A-Z0-9][A-Z0-9 \-]{3,11})/i);
  if (plateM) {
    const p = plateM[1].trim().replace(/\s+/g, ' ');
    if (/[0-9]/.test(p) && p.length <= 10) out.plate = p;
  }
  return out;
}
async function detectVehicleForFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const text = await extractFileText(buf);
    const found = detectVehicleInfo(text);
    console.log('cab-card vehicle read', { bytes: buf.length, textLen: text.length, ...found });
    return found;
  } catch (e) {
    console.error('cab-card vehicle detection failed', e);
    return {};
  }
}

admin.get('/equipment-documents', (req, res) => {
  const { unitType, unitId } = req.query;
  let rows;
  if (unitType && unitId) {
    rows = db
      .prepare(
        'SELECT e.*, f.originalFilename, f.mimeType FROM equipment_documents e JOIN files f ON f.id = e.fileId WHERE e.unitType = ? AND e.unitId = ? ORDER BY e.createdAt DESC, e.id DESC',
      )
      .all(unitType, unitId);
  } else {
    rows = db
      .prepare(
        'SELECT e.*, f.originalFilename, f.mimeType FROM equipment_documents e JOIN files f ON f.id = e.fileId ORDER BY e.createdAt DESC, e.id DESC',
      )
      .all();
  }
  res.json(rows.map(serializeEquipmentDoc));
});

const EQUIP_DOC_TYPES = ['cab_card', 'registration', 'insurance', 'annual_inspection', 'ifta', 'title', 'permit', 'other'];
const EXPIRY_RE = /^\d{4}-\d{2}-\d{2}$/;

admin.post('/equipment-documents', upload.single('file'), async (req, res) => {
  const { unitType, unitId, docType, note, expiryDate } = req.body || {};
  if (expiryDate && !EXPIRY_RE.test(expiryDate)) return err(res, 400, 'expiryDate must be YYYY-MM-DD');
  if (!req.file) return err(res, 400, 'file is required');
  if (unitType !== 'truck' && unitType !== 'trailer') return err(res, 400, 'unitType must be "truck" or "trailer"');
  if (!unitId) return err(res, 400, 'unitId is required');
  if (!EQUIP_DOC_TYPES.includes(docType)) return err(res, 400, 'Invalid docType');
  const table = unitType === 'truck' ? 'trucks' : 'trailers';
  const unit = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(unitId);
  if (!unit) return err(res, 404, 'Unit not found');
  const fileId = insertFileRow(req.file, 'equipment', null, null);
  const id = db
    .prepare(
      'INSERT INTO equipment_documents (unitType, unitId, unitNumber, docType, note, fileId, expiryDate, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(unitType, unitId, unit.unitNumber, docType, note ?? null, fileId, expiryDate || null, now()).lastInsertRowid;
  // Auto-read the dates off the document when the admin did not type
  // them (or did not type both). Detection never fails the upload.
  let detected = {};
  {
    detected = await detectDatesForFile(req.file.path);
    const fillExpiry = !expiryDate && detected.expiryDate ? detected.expiryDate : null;
    const fillIssued = detected.issuedDate || null;
    if (fillExpiry || fillIssued) {
      db.prepare('UPDATE equipment_documents SET expiryDate = COALESCE(?, expiryDate), issuedDate = COALESCE(?, issuedDate) WHERE id = ?')
        .run(fillExpiry, fillIssued, id);
    }
  }
  // Cab card: read the vehicle off the card and fill the unit's empty
  // year/make/model/VIN/plate so it shows under the unit number.
  let vehicle = null;
  if (docType === 'cab_card') {
    const found = await detectVehicleForFile(req.file.path);
    const filled = [];
    const sets = [];
    const vals = [];
    for (const key of ['year', 'make', 'model', 'vin', 'plate']) {
      if (found[key] != null && (unit[key] == null || unit[key] === '')) {
        sets.push(key + ' = ?');
        vals.push(found[key]);
        filled.push(key);
      }
    }
    if (sets.length) {
      db.prepare('UPDATE ' + table + ' SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals, unitId);
      const fresh = db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(unitId);
      vehicle = { filled, year: fresh.year ?? null, make: fresh.make ?? null, model: fresh.model ?? null };
    } else if (Object.keys(found).length) {
      vehicle = { filled, year: unit.year ?? null, make: unit.make ?? null, model: unit.model ?? null };
    }
  }
  const row = db
    .prepare('SELECT e.*, f.originalFilename, f.mimeType FROM equipment_documents e JOIN files f ON f.id = e.fileId WHERE e.id = ?')
    .get(id);
  const out = serializeEquipmentDoc(row);
  out.detected = detected;
  if (vehicle) out.vehicle = vehicle;
  res.status(201).json(out);
});

admin.patch('/equipment-documents/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM equipment_documents WHERE id = ?').get(req.params.id);
  if (!row) return err(res, 404, 'Equipment document not found');
  const body = req.body || {};
  const hasExp = Object.prototype.hasOwnProperty.call(body, 'expiryDate');
  const hasIss = Object.prototype.hasOwnProperty.call(body, 'issuedDate');
  if (!hasExp && !hasIss) return err(res, 400, 'Nothing to update');
  const sets = [];
  const vals = [];
  if (hasExp) {
    if (body.expiryDate && !EXPIRY_RE.test(body.expiryDate)) return err(res, 400, 'expiryDate must be YYYY-MM-DD');
    sets.push('expiryDate = ?');
    vals.push(body.expiryDate || null);
  }
  if (hasIss) {
    if (body.issuedDate && !EXPIRY_RE.test(body.issuedDate)) return err(res, 400, 'issuedDate must be YYYY-MM-DD');
    sets.push('issuedDate = ?');
    vals.push(body.issuedDate || null);
  }
  vals.push(row.id);
  db.prepare('UPDATE equipment_documents SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
  const updated = db
    .prepare('SELECT e.*, f.originalFilename, f.mimeType FROM equipment_documents e JOIN files f ON f.id = e.fileId WHERE e.id = ?')
    .get(row.id);
  res.json(serializeEquipmentDoc(updated));
});

admin.delete('/equipment-documents/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM equipment_documents WHERE id = ?').get(req.params.id);
  if (!row) return err(res, 404, 'Equipment document not found');
  db.prepare('DELETE FROM equipment_documents WHERE id = ?').run(row.id);
  const f = getFileRow(row.fileId);
  db.prepare('DELETE FROM files WHERE id = ?').run(row.fileId);
  if (f) {
    try {
      fs.unlinkSync(path.join(UPLOADS_DIR, f.storedFilename));
    } catch {
      // ignore
    }
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Driver documents (owner's ask, 2026-11-16): a per-driver documents page,
// deliberately separate from the BOL Documents section and from the
// truck/trailer unit documents. Same behavior as unit documents: tiles,
// issued/expiry dates read off the upload automatically, status from the
// expiry date. Types: driver_license, driver_application, other.
// ---------------------------------------------------------------------------
const DRIVER_DOC_TYPES = ['driver_license', 'driver_application', 'other'];

admin.get('/driver-documents', (req, res) => {
  const { driverId } = req.query;
  let rows;
  if (driverId) {
    rows = db
      .prepare(
        'SELECT e.*, f.originalFilename, f.mimeType FROM driver_documents e JOIN files f ON f.id = e.fileId WHERE e.driverId = ? ORDER BY e.createdAt DESC, e.id DESC',
      )
      .all(driverId);
  } else {
    rows = db
      .prepare(
        'SELECT e.*, f.originalFilename, f.mimeType FROM driver_documents e JOIN files f ON f.id = e.fileId ORDER BY e.createdAt DESC, e.id DESC',
      )
      .all();
  }
  res.json(rows.map(serializeDriverDoc));
});

admin.post('/driver-documents', upload.single('file'), async (req, res) => {
  const { driverId, docType, note, expiryDate } = req.body || {};
  if (expiryDate && !EXPIRY_RE.test(expiryDate)) return err(res, 400, 'expiryDate must be YYYY-MM-DD');
  if (!req.file) return err(res, 400, 'file is required');
  if (!driverId) return err(res, 400, 'driverId is required');
  if (!DRIVER_DOC_TYPES.includes(docType)) return err(res, 400, 'Invalid docType');
  const driver = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(driverId);
  if (!driver) return err(res, 404, 'Driver not found');
  const fileId = insertFileRow(req.file, 'driver_document', driverId, driverId);
  const id = db
    .prepare(
      'INSERT INTO driver_documents (driverId, driverName, docType, note, fileId, expiryDate, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(driverId, driver.name, docType, note ?? null, fileId, expiryDate || null, now()).lastInsertRowid;
  // Auto-read the dates off the document (same as unit documents).
  let detected = {};
  {
    detected = await detectDatesForFile(req.file.path);
    const fillExpiry = !expiryDate && detected.expiryDate ? detected.expiryDate : null;
    const fillIssued = detected.issuedDate || null;
    if (fillExpiry || fillIssued) {
      db.prepare('UPDATE driver_documents SET expiryDate = COALESCE(?, expiryDate), issuedDate = COALESCE(?, issuedDate) WHERE id = ?')
        .run(fillExpiry, fillIssued, id);
    }
  }
  const row = db
    .prepare('SELECT e.*, f.originalFilename, f.mimeType FROM driver_documents e JOIN files f ON f.id = e.fileId WHERE e.id = ?')
    .get(id);
  const out = serializeDriverDoc(row);
  out.detected = detected;
  res.status(201).json(out);
});

admin.patch('/driver-documents/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM driver_documents WHERE id = ?').get(req.params.id);
  if (!row) return err(res, 404, 'Driver document not found');
  const body = req.body || {};
  const hasExp = Object.prototype.hasOwnProperty.call(body, 'expiryDate');
  const hasIss = Object.prototype.hasOwnProperty.call(body, 'issuedDate');
  if (!hasExp && !hasIss) return err(res, 400, 'Nothing to update');
  const sets = [];
  const vals = [];
  if (hasExp) {
    if (body.expiryDate && !EXPIRY_RE.test(body.expiryDate)) return err(res, 400, 'expiryDate must be YYYY-MM-DD');
    sets.push('expiryDate = ?');
    vals.push(body.expiryDate || null);
  }
  if (hasIss) {
    if (body.issuedDate && !EXPIRY_RE.test(body.issuedDate)) return err(res, 400, 'issuedDate must be YYYY-MM-DD');
    sets.push('issuedDate = ?');
    vals.push(body.issuedDate || null);
  }
  vals.push(row.id);
  db.prepare('UPDATE driver_documents SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
  const updated = db
    .prepare('SELECT e.*, f.originalFilename, f.mimeType FROM driver_documents e JOIN files f ON f.id = e.fileId WHERE e.id = ?')
    .get(row.id);
  res.json(serializeDriverDoc(updated));
});

admin.delete('/driver-documents/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM driver_documents WHERE id = ?').get(req.params.id);
  if (!row) return err(res, 404, 'Driver document not found');
  db.prepare('DELETE FROM driver_documents WHERE id = ?').run(row.id);
  const f = getFileRow(row.fileId);
  db.prepare('DELETE FROM files WHERE id = ?').run(row.fileId);
  if (f) {
    try {
      fs.unlinkSync(path.join(UPLOADS_DIR, f.storedFilename));
    } catch {
      // ignore
    }
  }
  res.json({ ok: true });
});

app.use('/api/admin', admin);

// ---------------------------------------------------------------------------
// Files — token required; caller must own the file or be an admin.
// ---------------------------------------------------------------------------
app.get('/files/:id', auth, (req, res) => {
  const file = getFileRow(req.params.id);
  if (!file) return err(res, 404, 'File not found');
  if (req.user.role !== 'admin') {
    let allowed = file.driverId === req.user.id;
    if (!allowed && file.ownerType === 'equipment') {
      const doc = db.prepare('SELECT * FROM equipment_documents WHERE fileId = ?').get(file.id);
      if (doc) {
        const table = doc.unitType === 'truck' ? 'trucks' : 'trailers';
        const unit = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(doc.unitId);
        allowed = !!unit && unit.driverId === req.user.id;
      }
    }
    if (!allowed) return err(res, 403, 'Forbidden');
  }
  const filePath = path.join(UPLOADS_DIR, file.storedFilename);
  if (!fs.existsSync(filePath)) return err(res, 404, 'File not found');
  // View must open inline (PDF in a browser tab); Download forces a save.
  // The stored mimeType can be generic (e.g. from an email attachment), so
  // prefer the type implied by the file extension when it is known.
  const ext = path.extname(file.storedFilename).toLowerCase();
  const extType = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain' }[ext];
  const type = extType || (file.mimeType && file.mimeType !== 'application/octet-stream' ? file.mimeType : 'application/octet-stream');
  res.type(type);
  res.set('Content-Disposition', (req.query.download === '1' ? 'attachment' : 'inline') + '; filename="' + String(file.originalFilename || file.storedFilename).replace(/"/g, '') + '"');
  res.sendFile(filePath);
});

// ---------------------------------------------------------------------------
// Static frontend (web build only) + SPA fallback
// Serves the repo-root public/ directory (created by the frontend builder)
// from the same process. Placed AFTER all /api/* and /files/* routes so
// API 404s still return JSON. Resolved relative to this file, not cwd.
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/files/')) return err(res, 404, 'Not found');
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  return err(res, 404, 'Not found');
});

// ---------------------------------------------------------------------------
// Errors / 404 / start
// ---------------------------------------------------------------------------
app.use((_req, res) => err(res, 404, 'Not found'));

app.use((e, _req, res, _next) => {
  if (e && e.code === 'LIMIT_FILE_SIZE') return err(res, 400, 'File is too large (max 25 MB)');
  if (e && e.name === 'MulterError') return err(res, 400, e.message);
  console.error(e);
  err(res, 500, 'Server error');
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`LXL Driver API listening on http://localhost:${PORT} (data: ${DATA_DIR})`);
  backfillRateConDetails();
});
