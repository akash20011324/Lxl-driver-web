// LXL Driver backend API — contract: ~/workspace/lxl-driver-native/API_CONTRACT.md
// Plain JavaScript (ESM), Node + Express, node:sqlite storage.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, now, withTransaction, getMeta, setMeta, demoAvailable, deactivateDemo, normalizePhone } from './db.js';
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

function parseStops(raw) {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (s && Array.isArray(s.pickups) && Array.isArray(s.deliveries) && s.pickups.length && s.deliveries.length) return s;
  } catch { /* not JSON — ignore */ }
  return null;
}

// One-line summary of every stop, appended to the load notes so any
// client (including the current driver app build) shows all stops.
function stopsSummary(stops) {
  const fmt = (kind, s, i) => kind + ' ' + (i + 1) + ': ' + (s.warehouse || s.location) + (s.warehouse ? ' (' + s.location + ')' : '')
    + (s.at ? ' — ' + new Date(s.at).toLocaleString('en-US', { timeZone: 'America/Indiana/Indianapolis', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
    + (s.number ? ', #' + s.number : '');
  return 'Stops — ' + [...stops.pickups.map((s, i) => fmt('Pickup', s, i)), ...stops.deliveries.map((s, i) => fmt('Delivery', s, i))].join('; ');
}

function notesWithStops(notes, stops) {
  const base = String(notes || '').split('\n').filter((line) => !line.startsWith('Stops — ')).join('\n').trim();
  if (!stops) return base || null;
  const summary = stopsSummary(stops);
  return base ? base + '\n' + summary : summary;
}

// Sanitize a stops payload from the assign/edit forms. Returns null
// unless there is at least one valid pickup and delivery AND more
// than the default single pickup + single delivery.
function cleanStopsPayload(raw) {
  if (!raw || !Array.isArray(raw.pickups) || !Array.isArray(raw.deliveries)) return null;
  const clean = (s) => {
    if (!s || !String(s.location || '').trim()) return null;
    return {
      location: String(s.location).trim(),
      warehouse: s.warehouse && String(s.warehouse).trim() ? String(s.warehouse).trim() : null,
      at: s.at && String(s.at) ? String(s.at) : null,
      number: s.number && String(s.number).trim() ? String(s.number).trim() : null,
    };
  };
  const pickups = raw.pickups.map(clean).filter(Boolean).slice(0, 4);
  const deliveries = raw.deliveries.map(clean).filter(Boolean).slice(0, 4);
  if (!pickups.length || !deliveries.length) return null;
  if (pickups.length === 1 && deliveries.length === 1) return null;
  return { pickups, deliveries };
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
    stops: parseStops(l.stops),
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
  if (req.query.admin_consent) {
    return res.status(200).send('<h1>Admin consent granted</h1><p>Dispatchers can now connect their Outlook mailbox from the Rate Confirmations page in LXL Driver.</p><p><a href="/">Back to LXL Driver</a></p>');
  }
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
      if (d > DELIVERY_GEOFENCE_M && !(req.body && req.body.confirmFar)) {
        // Distance is a WARNING, not a hard block (owner's call,
        // 2026-11-16): a wrong map pin must never trap a driver who
        // has actually delivered. The app turns this 409 into
        // "You're X away — are you sure you want to complete the
        // load?" and resends with confirmFar to finish.
        return res.status(409).json({
          error: `You're ${formatDistance(d)} from the delivery location — are you sure you want to complete the load?`,
          code: 'FAR_FROM_DELIVERY',
          distanceM: Math.round(d),
        });
      }
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

function cashGroupBy(list) {
  const m = new Map();
  for (const e of list) m.set(e.category, (m.get(e.category) || 0) + e.amountCents);
  return [...m.entries()].map(([category, amountCents]) => ({ category, amountCents })).sort((a, b) => b.amountCents - a.amountCents);
}

function cashMergedEntries() {
  const entryRows = db.prepare(
    `SELECT e.*, t.unitNumber AS truckUnit FROM cash_entries e
     LEFT JOIN trucks t ON t.id = e.truckId ORDER BY e.date DESC, e.id DESC LIMIT 200`,
  ).all();
  const entries = entryRows.map((e) => ({
    id: e.id, direction: e.direction, date: e.date, category: e.category, amountCents: e.amountCents,
    truckId: e.truckId ?? null, truckUnit: e.truckUnit ?? null, note: e.note ?? null,
    loadId: e.loadId ?? null, source: e.source, virtual: false,
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
    source: 'advance', virtual: true,
  }));
  return { entries, advanceRows, all: [...entries, ...advances] };
}

// Aggregates (totals, monthly groups, per-truck months) must cover EVERY
// entry since May 2026 — the display list is capped at 200 rows, and
// summing the capped list silently drops the oldest entries.
function cashAllEntries() {
  const entryRows = db.prepare('SELECT direction, date, category, amountCents, truckId, loadId FROM cash_entries').all();
  const entries = entryRows.map((e) => ({
    direction: e.direction, date: e.date, category: e.category, amountCents: e.amountCents,
    truckId: e.truckId ?? null, loadId: e.loadId ?? null,
  }));
  const advanceRows = db.prepare(
    `SELECT r.id, r.amountCents, r.decidedAt, r.driverId, u.name AS driverName FROM requests r
     LEFT JOIN users u ON u.id = r.driverId
     WHERE r.type = 'advance' AND r.status = 'approved' AND r.amountCents IS NOT NULL`,
  ).all();
  const advances = advanceRows.map((a) => ({
    direction: 'out', date: String(a.decidedAt || '').slice(0, 10), category: 'Driver advance',
    amountCents: a.amountCents, truckId: null, loadId: null, driverId: a.driverId,
  }));
  return { entries, advanceRows, all: [...entries, ...advances] };
}

// Per-truck monthly profit: revenue from rate cons booked that month,
// minus fuel (the fuel receipts the driver uploaded — on his loads,
// plus any he uploaded without a load), driver pay (each load's road
// miles x $0.65), maintenance/repairs and other tagged costs. Owner's
// rule, 2026-11-17: this Trucks profit section uses receipts + mileage
// pay; the company Cash Flow totals still run on the Pilot weekly bill
// and the entered entries.
function truckMonthlyFor(monthParam, entries, advanceRows) {
  const inMonth = (e) => (e.date || '').startsWith(monthParam);
  const truckRows = db.prepare('SELECT * FROM trucks ORDER BY unitNumber').all();
  const loadsInMonth = truckRows.map((t) => (t.driverId ? db.prepare('SELECT COUNT(*) AS n FROM loads WHERE driverId = ? AND substr(pickupAt, 1, 7) = ?').get(t.driverId, monthParam).n : 0));
  const totalLoadsMonth = loadsInMonth.reduce((s, n) => s + n, 0);
  const trucks = truckRows.map((t, ti) => {
    const trips = t.driverId ? db.prepare(
      `SELECT l.id AS loadId, l.reference AS reference, rc.rateCents AS rateCents, l.miles AS miles FROM loads l
       JOIN rate_confirmations rc ON rc.loadId = l.id
       WHERE l.driverId = ? AND rc.rateCents IS NOT NULL AND substr(rc.pickupDate, 1, 7) = ? ORDER BY l.id DESC`,
    ).all(t.driverId, monthParam).map((trip) => {
      const parts = tripProfitParts(trip);
      return { loadId: trip.loadId, reference: trip.reference, rateCents: trip.rateCents, miles: trip.miles > 0 ? trip.miles : null, fuelCents: parts.fuelCents, driverPayCents: parts.driverPayCents, otherCents: parts.otherCents, expensesCents: parts.expensesCents, profitCents: trip.rateCents - parts.expensesCents };
    }) : [];
    const sumCatM = (cats) => entries.filter((e) => e.direction === 'out' && e.truckId === t.id && inMonth(e) && cats.includes(e.category)).reduce((s, e) => s + e.amountCents, 0);
    const revenueCents = trips.reduce((s, x) => s + x.rateCents, 0);
    const unattachedFuelCents = t.driverId ? db.prepare("SELECT COALESCE(SUM(amountCents), 0) AS s FROM documents WHERE kind = 'fuel_receipt' AND loadId IS NULL AND driverId = ? AND substr(createdAt, 1, 7) = ?").get(t.driverId, monthParam).s : 0;
    const fuelCents = trips.reduce((s, x) => s + x.fuelCents, 0) + unattachedFuelCents;
    // Driver pay is for ALL the loads the driver did this month
    // (owner, 2026-11-17) — not only the ones with a rate con — so it
    // is summed over every load on the loads table for the month.
    const monthLoadMiles = t.driverId ? db.prepare("SELECT COALESCE(SUM(miles), 0) AS s FROM loads WHERE driverId = ? AND status != 'cancelled' AND miles > 0 AND substr(pickupAt, 1, 7) = ?").get(t.driverId, monthParam).s : 0;
    const driverPayCents = Math.round(monthLoadMiles * DRIVER_PAY_PER_MILE_CENTS);
    const maintCents = sumCatM(['Maintenance', 'Repairs']);
    const knownM = new Set(['Driver pay', 'Maintenance', 'Repairs']);
    const otherCents = entries.filter((e) => e.direction === 'out' && e.truckId === t.id && inMonth(e) && !knownM.has(e.category) && !e.category.startsWith('Fuel')).reduce((s, e) => s + e.amountCents, 0);
    const costs = fuelCents + driverPayCents + maintCents + otherCents;
    return { truckId: t.id, unitNumber: t.unitNumber, trips, revenueCents, fuelCents, driverPayCents, maintCents, otherCents, profitCents: revenueCents - costs, loadsInMonth: loadsInMonth[ti] };
  });
  return { trucks, monthFuelTotalCents: trucks.reduce((s, t) => s + t.fuelCents, 0), totalLoadsMonth };
}

// How many monthly occurrences of a fixed payment fall in
// [its start month .. throughMonth]. A fixed payment's start month is
// the month of its createdAt (the setup backdated the truck/trailer
// payments to the month each obligation actually began).
function fixedMonthsThrough(f, throughMonth) {
  const start = String(f.createdAt || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(start) || start > throughMonth) return 0;
  const sy = Number(start.slice(0, 4)); const sm = Number(start.slice(5, 7));
  const ty = Number(throughMonth.slice(0, 4)); const tm = Number(throughMonth.slice(5, 7));
  return (ty - sy) * 12 + (tm - sm) + 1;
}

admin.get('/cashflow', async (req, res) => {
  // Trucks profit pays drivers by the mile: fill in road miles for any
  // load still missing them (cached on the load afterwards).
  try {
    const needMiles = db.prepare("SELECT * FROM loads WHERE miles IS NULL AND status != 'cancelled' ORDER BY id DESC LIMIT 12").all();
    for (const l of needMiles) { try { await ensureLoadMiles(l); } catch { /* best effort */ } }
  } catch { /* miles column may not exist yet */ }
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
  const agg = cashAllEntries();
  const receivedCents = agg.entries.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amountCents, 0);
  const outCents = agg.all.filter((e) => e.direction === 'out').reduce((s, e) => s + e.amountCents, 0);
  const weekly = [];
  const todayD = new Date();
  for (let i = 7; i >= 0; i--) {
    const end = new Date(todayD); end.setDate(end.getDate() - i * 7);
    const start = new Date(end); start.setDate(start.getDate() - 6);
    const sStr = start.toISOString().slice(0, 10);
    const eStr = end.toISOString().slice(0, 10);
    weekly.push({
      weekStart: sStr,
      inCents: agg.all.filter((e) => e.direction === 'in' && e.date >= sStr && e.date <= eStr).reduce((s, e) => s + e.amountCents, 0),
      outCents: agg.all.filter((e) => e.direction === 'out' && e.date >= sStr && e.date <= eStr).reduce((s, e) => s + e.amountCents, 0),
    });
  }
  // Fixed monthly payments (owner's fixed costs) — counted in the monthly
  // profit automatically, never entered by hand.
  const fixed = db.prepare('SELECT * FROM fixed_payments WHERE active = 1 ORDER BY category').all()
    .map((f) => ({ id: f.id, category: f.category, amountCents: f.amountCents, note: f.note ?? null, createdAt: f.createdAt }));
  // Monthly P&L: factoring money in, every expense group out, then profit.
  const inMonth = (e) => (e.date || '').startsWith(monthParam);
  const groupBy = (list) => {
    const m = new Map();
    for (const e of list) m.set(e.category, (m.get(e.category) || 0) + e.amountCents);
    return [...m.entries()].map(([category, amountCents]) => ({ category, amountCents })).sort((a, b) => b.amountCents - a.amountCents);
  };
  const monthIn = groupBy(agg.all.filter((e) => e.direction === 'in' && inMonth(e)));
  let monthOut = groupBy(agg.all.filter((e) => e.direction === 'out' && inMonth(e)));
  for (const f of fixed) if (fixedMonthsThrough(f, monthParam) > 0) monthOut.push({ category: f.category, amountCents: f.amountCents, fixed: true });
  // One box per category (owner, 2026-11-17): fixed payments merge
  // into their category group instead of showing as separate tiles —
  // the two truck payments + Garrett trailer rent are ONE
  // "Truck payment · fixed" box.
  {
    const m = new Map();
    for (const g of monthOut) {
      const cur = m.get(g.category) || { category: g.category, amountCents: 0 };
      cur.amountCents += g.amountCents;
      if (g.fixed) cur.fixed = true;
      m.set(g.category, cur);
    }
    monthOut = [...m.values()].sort((a, b) => b.amountCents - a.amountCents);
  }
  const monthInTotal = monthIn.reduce((s, x) => s + x.amountCents, 0);
  const monthOutTotal = monthOut.reduce((s, x) => s + x.amountCents, 0);
  // Per-truck: trip revenue from rate cons (via the load's driver), costs
  // from the entries tagged to the truck, profit after fuel + driver pay.
  const truckRows = db.prepare('SELECT * FROM trucks ORDER BY unitNumber').all();
  const trucksOut = truckRows.map((t) => {
    const trips = t.driverId ? db.prepare(
      `SELECT l.id AS loadId, l.reference AS reference, rc.rateCents AS rateCents, l.miles AS miles FROM loads l
       JOIN rate_confirmations rc ON rc.loadId = l.id
       WHERE l.driverId = ? AND rc.rateCents IS NOT NULL ORDER BY l.id DESC`,
    ).all(t.driverId).map((trip) => {
      const parts = tripProfitParts(trip);
      return { loadId: trip.loadId, reference: trip.reference, rateCents: trip.rateCents, miles: trip.miles > 0 ? trip.miles : null, fuelCents: parts.fuelCents, driverPayCents: parts.driverPayCents, otherCents: parts.otherCents, expensesCents: parts.expensesCents, profitCents: trip.rateCents - parts.expensesCents };
    }) : [];
    const sumCat = (cats) => entries.filter((e) => e.direction === 'out' && e.truckId === t.id && cats.includes(e.category)).reduce((s, e) => s + e.amountCents, 0);
    const revenueCents = trips.reduce((s, x) => s + x.rateCents, 0);
    // Trucks-profit fuel = the driver's uploaded fuel receipts (on his
    // loads + any uploaded without a load); driver pay = miles x $0.65.
    const unattachedFuelCents = t.driverId ? db.prepare("SELECT COALESCE(SUM(amountCents), 0) AS s FROM documents WHERE kind = 'fuel_receipt' AND loadId IS NULL AND driverId = ?").get(t.driverId).s : 0;
    const fuelCents = trips.reduce((s, x) => s + x.fuelCents, 0) + unattachedFuelCents;
    // All-time driver pay likewise covers every load the driver did,
    // not only the rate-con trips listed above.
    const allLoadMiles = t.driverId ? db.prepare("SELECT COALESCE(SUM(miles), 0) AS s FROM loads WHERE driverId = ? AND status != 'cancelled' AND miles > 0").get(t.driverId).s : 0;
    const driverPayCents = Math.round(allLoadMiles * DRIVER_PAY_PER_MILE_CENTS);
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
  const totals = { inGroups: groupBy(agg.all.filter((e) => e.direction === 'in')), outGroups: groupBy(agg.all.filter((e) => e.direction === 'out')) };
  // All-time totals also count fixed payments — one occurrence per
  // month from each payment's start month through the current month —
  // so the since-May figures keep the truck/trailer payments even
  // though their bank debits no longer create entries.
  const currentMonth = new Date().toISOString().slice(0, 7);
  let fixedAllTimeCents = 0;
  {
    const m = new Map(totals.outGroups.map((g) => [g.category, g.amountCents]));
    for (const f of fixed) {
      const months = fixedMonthsThrough(f, currentMonth);
      if (!months) continue;
      fixedAllTimeCents += f.amountCents * months;
      m.set(f.category, (m.get(f.category) || 0) + f.amountCents * months);
    }
    totals.outGroups = [...m.entries()].map(([category, amountCents]) => ({ category, amountCents })).sort((a, b) => b.amountCents - a.amountCents);
  }
  const outCentsTotal = outCents + fixedAllTimeCents;
  const tm = truckMonthlyFor(monthParam, agg.entries, advanceRows);
  const loads = db.prepare(
    `SELECT l.id, l.reference, u.name AS driverName FROM loads l
     LEFT JOIN users u ON u.id = l.driverId ORDER BY l.id DESC LIMIT 50`,
  ).all().map((l) => ({ id: l.id, reference: l.reference, driverName: l.driverName ?? null }));
  let bankBalance = null;
  try { bankBalance = JSON.parse(getMeta(db, 'bank_balance') || 'null'); } catch { bankBalance = null; }
  res.json({
    bookedCents: rcTotal, receivedCents, outCents: outCentsTotal, netCents: receivedCents - outCentsTotal, weekly, bankBalance,
    entries: all.slice(0, 60), fixed,
    bankPending: db.prepare("SELECT * FROM bank_transactions WHERE status = 'pending' ORDER BY date DESC, id DESC LIMIT 40").all()
      .map((t) => ({ id: t.id, date: t.date, name: t.name, amountCents: t.amountCents, direction: t.direction })),
    month: { key: monthParam, inGroups: monthIn, outGroups: monthOut, inTotalCents: monthInTotal, outTotalCents: monthOutTotal, profitCents: monthInTotal - monthOutTotal },
    trucks: trucksOut, loads, totals, truckMonthly: tm.trucks, monthFuelTotalCents: tm.monthFuelTotalCents,
  });
});
admin.get('/cashflow/report.csv', (req, res) => {
  const section = ['total', 'monthly', 'trucks'].includes(req.query.section) ? req.query.section : 'monthly';
  const monthParam = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  const { entries, advanceRows, all } = cashAllEntries();
  const fixed = db.prepare('SELECT * FROM fixed_payments WHERE active = 1 ORDER BY category').all();
  const money = (c) => (Number(c || 0) / 100).toFixed(2);
  const q = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  const L = [];
  if (section === 'total') {
    const rcTotal = db.prepare('SELECT COALESCE(SUM(rateCents), 0) AS s FROM rate_confirmations').get().s;
    const inT = all.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amountCents, 0);
    let outT = all.filter((e) => e.direction === 'out').reduce((s, e) => s + e.amountCents, 0);
    L.push(q('LXL Cash Flow — Company total (since May 2026)'));
    L.push(['Category', 'Money in', 'Money out'].map(q).join(','));
    const cats = new Map();
    for (const g of cashGroupBy(all.filter((e) => e.direction === 'in'))) cats.set(g.category, { i: g.amountCents, o: 0 });
    for (const g of cashGroupBy(all.filter((e) => e.direction === 'out'))) { const c = cats.get(g.category) || { i: 0, o: 0 }; c.o = g.amountCents; cats.set(g.category, c); }
    // Fixed payments count toward the all-time total too (one per
    // month from each payment's start month through the current one).
    {
      const curMonth = new Date().toISOString().slice(0, 7);
      for (const f of fixed) {
        const months = fixedMonthsThrough(f, curMonth);
        if (!months) continue;
        const c = cats.get(f.category) || { i: 0, o: 0 }; c.o += f.amountCents * months; cats.set(f.category, c);
        outT += f.amountCents * months;
      }
    }
    for (const [cat, v] of cats) L.push([cat, money(v.i), money(v.o)].map(q).join(','));
    L.push(['TOTAL', money(inT), money(outT)].map(q).join(','));
    L.push([q('Booked (rate cons)'), q(money(rcTotal))].join(','));
    L.push([q('Net (received - out)'), q(money(inT - outT))].join(','));
  } else if (section === 'monthly') {
    const inMonth = (e) => (e.date || '').startsWith(monthParam);
    const mIn = cashGroupBy(all.filter((e) => e.direction === 'in' && inMonth(e)));
    const mOutRaw = cashGroupBy(all.filter((e) => e.direction === 'out' && inMonth(e)));
    for (const f of fixed) if (fixedMonthsThrough(f, monthParam) > 0) mOutRaw.push({ category: f.category, amountCents: f.amountCents, fixed: true });
    const mOutMap = new Map();
    for (const g of mOutRaw) {
      const cur = mOutMap.get(g.category) || { category: g.category, amountCents: 0, fixed: false };
      cur.amountCents += g.amountCents;
      if (g.fixed) cur.fixed = true;
      mOutMap.set(g.category, cur);
    }
    const mOut = [...mOutMap.values()].sort((a, b) => b.amountCents - a.amountCents)
      .map((g) => ({ category: g.category + (g.fixed ? ' (fixed)' : ''), amountCents: g.amountCents }));
    const inT = mIn.reduce((s, x) => s + x.amountCents, 0);
    const outT = mOut.reduce((s, x) => s + x.amountCents, 0);
    L.push(q('LXL Cash Flow — Monthly profit and loss — ' + monthParam));
    L.push(q('Money in'));
    L.push(['Category', 'Amount'].map(q).join(','));
    for (const g of mIn) L.push([g.category, money(g.amountCents)].map(q).join(','));
    L.push(['Total in', money(inT)].map(q).join(','));
    L.push(q('Money out'));
    L.push(['Category', 'Amount'].map(q).join(','));
    for (const g of mOut) L.push([g.category, money(g.amountCents)].map(q).join(','));
    L.push(['Total out', money(outT)].map(q).join(','));
    L.push(['PROFIT', money(inT - outT)].map(q).join(','));
  } else {
    const tm = truckMonthlyFor(monthParam, entries, advanceRows);
    L.push(q('LXL Cash Flow — Per-truck — ' + monthParam));
    L.push(q('Fuel note: the Pilot weekly total for the month (' + money(tm.monthFuelTotalCents) + ') is split across trucks by their share of the month loads.'));
    L.push(['Truck', 'Revenue', 'Fuel', 'Driver pay', 'Maintenance and repairs', 'Other', 'Profit'].map(q).join(','));
    for (const t of tm.trucks) L.push(['Truck ' + t.unitNumber, money(t.revenueCents), money(t.fuelCents), money(t.driverPayCents), money(t.maintCents), money(t.otherCents), money(t.profitCents)].map(q).join(','));
    L.push('');
    L.push(q('Trips'));
    L.push(['Truck', 'Load', 'Rate', 'Trip expenses', 'Trip profit'].map(q).join(','));
    for (const t of tm.trucks) for (const trip of t.trips) L.push(['Truck ' + t.unitNumber, trip.reference, money(trip.rateCents), money(trip.expensesCents), money(trip.profitCents)].map(q).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lxl-cashflow-' + section + '-' + monthParam + '.csv"');
  res.send(L.join('\n'));
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
  const labels = ['NET PAYMENT', 'NET PAID', 'TOTAL PAID', 'AMOUNT PAID', 'PAYMENT AMOUNT', 'NET AMOUNT', 'SCHEDULE TOTAL', 'TOTAL NET', 'AMOUNT DUE', 'TOTAL DUE', 'BALANCE DUE', 'TOTAL AMOUNT', 'GRAND TOTAL', 'TOTAL'];
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
  if (s.includes('otr') || (s.includes('schedule') && /(complet|paid|payment|fund)/.test(s))) return { direction: 'in', category: 'Factoring payment' };
  if (s.includes('pilot')) return { direction: 'out', category: 'Fuel (Pilot weekly)' };
  if (/toll|e-zpass|ezpass|prepass|bestpass|pay by plate/.test(s)) return { direction: 'out', category: 'Tolls' };
  if (/parking|park/.test(s)) return { direction: 'out', category: 'Parking' };
  if (/factor|remittance|payment advice|funding|settlement/.test(s)) return { direction: 'in', category: 'Factoring payment' };
  if (/us ?premium|premium finance/.test(s)) return { direction: 'out', category: 'Insurance' };
  if (/garrett|gsf|trailer rental/.test(s)) return { direction: 'out', category: 'Trailer rental' };
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
// Auto-categorization (owner's ask, 2026-11-16: "I cannot stay there and
// click categorize categorize"). Confident built-in rules first, then rules
// LEARNED from the owner's own manual picks (a learned rule wins — his call
// beats the guess). Anything unsure stays 'pending' for a one-tap pick, and
// that pick teaches the system the pattern for next time.
const BANK_AGGREGATORS = new Set(['INTUIT', 'PAYPAL', 'VENMO', 'SQUARE', 'CASHAPP']);
function bankKeys(name) {
  const tokens = String(name || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const primary = tokens.slice(0, tokens[0] === 'ZELLE' ? 5 : 3).join(' ');
  const keys = [primary];
  if (BANK_AGGREGATORS.has(tokens[0]) && tokens.length > 2) keys.push(tokens.slice(0, 2).join(' '));
  return keys;
}
function bankKey(name) { return bankKeys(name)[0] || ''; }
function builtinBankCategory(name, direction, amountCents) {
  const s = String(name || '').toUpperCase();
  if (direction === 'in') {
    if (s.includes('OTR') || s.includes('BOLT')) return 'Factoring payment';
    return null;
  }
  if (s.includes('PILOT') && amountCents >= 50000) return 'Fuel (Pilot weekly)';
  if (s.includes('PREPASS') || s.includes('EZPASS') || s.includes('E-ZPASS') || s.includes('TOLL')) return 'Tolls';
  if (s.includes('PARK')) return 'Parking';
  // Transport Funding / Meteore / Garrett return null here on purpose:
  // they are fixed monthly payments (see autoCategorizeTx, which marks
  // their bank debits ignored so they never double-count).
  if (s.includes('USPREMIUMFINANCE') || s.includes('PREMIUM FINANCE')) return 'Insurance';
  if (s.includes('ZELLE') && (s.includes('AKASHDEEP') || s.includes('ARSH'))) return 'Driver pay';
  if (s.includes('WIRE TRANSFER FEE') || s.includes('SERVICE CHARGE') || s.includes('MONTHLY FEE') || s.includes('RINGCENTRAL')) return 'Office expenses';
  return null;
}
function matchBankCategory(tx) {
  for (const key of bankKeys(tx.name)) {
    const learned = db.prepare('SELECT category FROM bank_rules WHERE pattern = ? AND direction = ?').get(key, tx.direction);
    if (learned) return learned.category;
  }
  return builtinBankCategory(tx.name, tx.direction, tx.amountCents);
}
function autoCategorizeTx(tx) {
  // Covered by fixed monthly payments (owner, 2026-11-17): the two
  // Transport Funding truck payments (the 1302 one posts under the
  // name Meteore) and the Garrett Freight Solutions trailer rent are
  // counted as fixed payments, so their bank debits must never also
  // become cash entries — mark them ignored instead.
  const nm = String(tx.name || '').toUpperCase();
  if (tx.direction === 'out' && (nm.includes('TRANSPORT FUNDIN') || nm.includes('METEORE') || nm.includes('GARRETT'))) {
    db.prepare("UPDATE bank_transactions SET status = 'ignored', entryId = NULL WHERE id = ?").run(tx.id);
    return true;
  }
  const category = matchBankCategory(tx);
  if (!category) return false;
  const r = db.prepare('INSERT INTO cash_entries (direction, date, category, amountCents, truckId, note, source, loadId, createdAt) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?)')
    .run(tx.direction, tx.date, category, tx.amountCents, tx.name, 'bank', now());
  db.prepare("UPDATE bank_transactions SET status = 'categorized', entryId = ? WHERE id = ?").run(r.lastInsertRowid, tx.id);
  return true;
}
function sweepBankPending() {
  const pending = db.prepare("SELECT * FROM bank_transactions WHERE status = 'pending'").all();
  let n = 0;
  for (const tx of pending) if (autoCategorizeTx(tx)) n += 1;
  return n;
}

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
  const bal = req.body && req.body.balance;
  if (bal && Number.isFinite(Number(bal.currentCents))) {
    setMeta(db, 'bank_balance', JSON.stringify({
      currentCents: Math.round(Number(bal.currentCents)),
      availableCents: Number.isFinite(Number(bal.availableCents)) ? Math.round(Number(bal.availableCents)) : null,
      name: String(bal.name || '').slice(0, 80),
      mask: String(bal.mask || '').slice(0, 8),
      at: Date.now(),
    }));
  }
  const autoCategorized = sweepBankPending();
  const unknowns = db.prepare("SELECT id, name, date, amountCents, direction FROM bank_transactions WHERE status = 'pending' ORDER BY date DESC, id DESC LIMIT 25").all();
  res.json({ ok: true, added, autoCategorized, unknowns });
});

app.post('/api/sync/bank/categorize', (req, res) => {
  const key = process.env.BANK_SYNC_KEY;
  if (!key) return err(res, 503, 'Bank sync is not configured');
  if (req.get('x-sync-key') !== key) return err(res, 401, 'Bad sync key');
  const decisions = (req.body && req.body.decisions) || [];
  let done = 0;
  for (const d of decisions) {
    if (!d || !d.id || !d.category) continue;
    const tx = db.prepare("SELECT * FROM bank_transactions WHERE id = ? AND status = 'pending'").get(d.id);
    if (!tx) continue;
    const r = db.prepare('INSERT INTO cash_entries (direction, date, category, amountCents, truckId, note, source, loadId, createdAt) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?)')
      .run(tx.direction, tx.date, String(d.category), tx.amountCents, tx.name, 'bank', now());
    db.prepare("UPDATE bank_transactions SET status = 'categorized', entryId = ? WHERE id = ?").run(r.lastInsertRowid, tx.id);
    for (const k of bankKeys(tx.name))
      db.prepare('INSERT OR IGNORE INTO bank_rules (pattern, direction, category, createdAt) VALUES (?, ?, ?, ?)')
        .run(k, tx.direction, String(d.category), now());
    done += 1;
  }
  sweepBankPending();
  res.json({ ok: true, done });
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
  for (const key of bankKeys(tx.name))
    db.prepare('INSERT OR REPLACE INTO bank_rules (pattern, direction, category, createdAt) VALUES (?, ?, ?, ?)')
      .run(key, tx.direction, String(category).trim(), now());
  sweepBankPending();
  res.json({ ok: true, entryId: r.lastInsertRowid });
});

admin.post('/cashflow/bank/:id/ignore', (req, res) => {
  const tx = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(req.params.id);
  if (!tx) return err(res, 404, 'Bank transaction not found');
  db.prepare("UPDATE bank_transactions SET status = 'ignored' WHERE id = ?").run(tx.id);
  res.json({ ok: true });
});

// Process any backlog once at boot (e.g. right after a deploy).
try { sweepBankPending(); } catch { /* bank tables not ready yet */ }

admin.post('/cashflow/outlook-preview', async (req, res) => {
  try {
    const { messageId, attachmentId } = req.body || {};
    if (!messageId || !attachmentId) return err(res, 400, 'messageId and attachmentId are required');
    const user = getUserById(req.user.id);
    const accessToken = await outlookAccessToken(user);
    const msg = await outlookGraph(accessToken,
      `/me/messages/${encodeURIComponent(messageId)}?$select=subject,from,receivedDateTime`);
    const { att, fileBuffer } = await outlookAttachmentBuffer(user, messageId, attachmentId);
    let amountCents = null;
    let text = '';
    try { text = await extractFileText(fileBuffer); amountCents = detectCashAmountCents(text); } catch { /* detection is best-effort */ }
    const from = (msg.from && msg.from.emailAddress && (msg.from.emailAddress.name || msg.from.emailAddress.address)) || '';
    const contentType = att.contentType || '';
    res.json({
      amountCents, subject: msg.subject ?? '', from,
      date: msg.receivedDateTime ? String(msg.receivedDateTime).slice(0, 10) : new Date().toISOString().slice(0, 10),
      fileName: att.name || 'attachment',
      textPreview: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 700),
      imageDataUri: contentType.startsWith('image/') && fileBuffer.length <= 2500000
        ? `data:${contentType};base64,${fileBuffer.toString('base64')}` : null,
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
  // Active loads first; within each group the most RECENT trip on
  // top (by pickup date, not by when the row happened to be created
  // — imported history would otherwise bury today's loads).
  const rows = db.prepare("SELECT * FROM loads ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END, pickupAt DESC, createdAt DESC, id DESC").all();
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

// Admin document upload (added 2026-11-17): dispatch files paperwork
// for loads the drivers ran before the app or outside it — before this,
// only drivers could upload, so historical PODs had nowhere to go. The
// document is filed under the load's driver.
admin.post('/documents', upload.single('file'), (req, res) => {
  const { kind, loadId, category, label, amountCents } = req.body || {};
  if (!req.file) return err(res, 400, 'file is required');
  if (!DOC_KINDS.includes(kind)) return err(res, 400, 'Invalid document kind');
  let load = null;
  if (loadId) {
    load = db.prepare('SELECT * FROM loads WHERE id = ?').get(loadId);
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
      amountCents != null && amountCents !== '' ? Number(amountCents) : null,
      fileId,
      load ? load.driverId : null,
      now(),
    ).lastInsertRowid;
  const row = db
    .prepare('SELECT d.*, f.originalFilename, f.mimeType FROM documents d JOIN files f ON f.id = d.fileId WHERE d.id = ?')
    .get(id);
  res.status(201).json(serializeDocument(row));
});

admin.post('/loads', (req, res) => {
  const {
    driverId,
    reference,
    pickupTimezone,
    deliveryTimezone,
    notes,
  } = req.body || {};
  // Multi-stop loads: when the form sends extra pickups/deliveries,
  // the load's own columns become the FIRST pickup and the LAST
  // delivery; the full stop list is stored as JSON.
  const stops = cleanStopsPayload(req.body && req.body.stops);
  const p0 = stops ? stops.pickups[0] : {
    location: req.body.pickupLocation, warehouse: req.body.pickupWarehouse,
    at: req.body.pickupAt, number: req.body.pickupNumber,
  };
  const dN = stops ? stops.deliveries[stops.deliveries.length - 1] : {
    location: req.body.deliveryLocation, warehouse: req.body.deliveryWarehouse,
    at: req.body.deliveryAt, number: req.body.deliveryNumber,
  };
  const pickupLocation = p0.location; const pickupWarehouse = p0.warehouse;
  const pickupAt = p0.at; const pickupNumber = p0.number;
  const deliveryLocation = dN.location; const deliveryWarehouse = dN.warehouse;
  const deliveryAt = dN.at; const deliveryNumber = dN.number;
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
      "INSERT INTO loads (reference, driverId, pickupLocation, pickupWarehouse, pickupAt, pickupTimezone, pickupNumber, deliveryLocation, deliveryWarehouse, deliveryAt, deliveryTimezone, deliveryNumber, notes, stops, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
    )
    .run(
      lxlLoadRef(reference),
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
      notesWithStops(notes, stops),
      stops ? JSON.stringify(stops) : null,
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
  if (status !== 'cancelled' && status !== 'active' && status !== 'completed') return err(res, 400, 'status must be "cancelled", "active" or "completed"');
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(req.params.id);
  if (!load) return err(res, 404, 'Load not found');
  withTransaction(db, () => {
    // Admin completion (added 2026-11-17): historical loads entered by
    // dispatch have no driver-app completion, so admins can close them
    // out. The completion time is the delivery time.
    if (status === 'completed' && load.status !== 'completed') {
      db.prepare("UPDATE loads SET status = 'completed', completedAt = COALESCE(completedAt, deliveryAt, ?) WHERE id = ?").run(now(), load.id);
    } else if (status === 'active' && load.status === 'completed') {
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
  let { pickupLocation, pickupWarehouse, pickupNumber, deliveryLocation, deliveryWarehouse, deliveryNumber, notes } = req.body || {};
  // Multi-stop edit: the full stop list replaces the stored one and
  // the primary columns follow its first pickup / last delivery.
  const stops = cleanStopsPayload(req.body && req.body.stops);
  if (stops) {
    const p0 = stops.pickups[0];
    const dN = stops.deliveries[stops.deliveries.length - 1];
    pickupLocation = p0.location; pickupWarehouse = p0.warehouse; pickupNumber = p0.number;
    deliveryLocation = dN.location; deliveryWarehouse = dN.warehouse; deliveryNumber = dN.number;
    notes = notesWithStops(notes, stops);
    db.prepare('UPDATE loads SET stops = ? WHERE id = ?').run(JSON.stringify(stops), load.id);
  } else if (req.body && req.body.stops) {
    // The form sent a single pickup + single delivery — clear any
    // stored multi-stop list and its notes summary.
    db.prepare('UPDATE loads SET stops = NULL WHERE id = ?').run(load.id);
    notes = notesWithStops(notes, null);
  }
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

async function geocodeGoogleForward(q) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key || !q) return null;
  try {
    const r = await fetch(
      'https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(key),
      { headers: { Referer: 'https://app.lubanaxpress.com/' } },
    );
    const j = await r.json();
    if (j.status === 'OK' && j.results && j.results[0] && j.results[0].geometry && j.results[0].geometry.location) {
      const loc = j.results[0].geometry.location;
      if (Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) return { lat: loc.lat, lng: loc.lng };
    }
  } catch { /* fall through to the next source */ }
  return null;
}

async function geocodeNominatimAddress(q) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
      { headers: { 'User-Agent': 'LXL-Driver/1.0 (lubanaxpress.com)' } },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows || !rows[0]) return null;
    // A highway-class result is just a point somewhere on the street,
    // not the address — treat it as a miss.
    if (rows[0].class === 'highway') return null;
    const lat = Number(rows[0].lat);
    const lng = Number(rows[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

async function geocodeCensus(address) {
  try {
    const r = await fetch(
      'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=' + encodeURIComponent(address),
    );
    if (!r.ok) return null;
    const j = await r.json();
    const m = j && j.result && j.result.addressMatches && j.result.addressMatches[0];
    if (!m || !m.coordinates) return null;
    const lat = Number(m.coordinates.y);
    const lng = Number(m.coordinates.x);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

async function geocodeAddress(address, warehouse) {
  if (!address) return null;
  // Google first: rooftop-accurate for street addresses. Nominatim
  // cannot resolve many US house numbers and drops the pin at a
  // generic point on the street — that wrong pin blocked a driver
  // from completing a delivery he was standing at (2026-11-16).
  if (warehouse) {
    const byBiz = await geocodeGoogleForward(`${warehouse}, ${address}`);
    if (byBiz) return byBiz;
  }
  const byGoogle = await geocodeGoogleForward(address);
  if (byGoogle) return byGoogle;
  // US Census geocoder: its TIGER street-segment interpolation is
  // far more accurate for US street addresses than Nominatim (which
  // put the Lansdale pin a mile from the building, 2026-11-16).
  const byCensus = await geocodeCensus(address);
  if (byCensus) return byCensus;
  const direct = await geocodeNominatimAddress(address);
  if (direct) return direct;
  // A street-level point still beats the city center as a last
  // resort before the city fallback below.
  const street = await geocodeQuery(address);
  if (street) return street;
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
  const coords = await geocodeAddress(load.deliveryLocation, load.deliveryWarehouse);
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
  const coords = await geocodeAddress(load.pickupLocation, load.pickupWarehouse);
  if (!coords) return null;
  db.prepare('UPDATE loads SET pickupLat = ?, pickupLng = ? WHERE id = ?').run(
    coords.lat,
    coords.lng,
    load.id,
  );
  return coords;
}

// Trucks profit (owner's rule, 2026-11-17): driver pay for a load is
// its road miles x $0.65, and the load's fuel cost is the fuel receipts
// the driver uploaded on that load — NOT the entered Driver pay
// entries and NOT the Pilot weekly split. Company Cash Flow totals are
// unaffected (Pilot weekly stays the fuel there).
const DRIVER_PAY_PER_MILE_CENTS = 65;

function cityStateOf(location) {
  const parts = String(location || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = parts[i].match(/^([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/i);
    if (m && i > 0) return parts[i - 1] + ', ' + m[1].toUpperCase();
  }
  // No comma before the state: "... Kent OH 44240" as one segment.
  const whole = String(location || '').match(/([A-Za-z][A-Za-z .'-]*?)\s+([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/);
  if (whole) return whole[1].trim() + ', ' + whole[2].toUpperCase();
  return null;
}

async function nominatimSearch(q) {
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(q), { headers: { 'User-Agent': 'LXL-Driver/1.0 (lubanaxpress.com)' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const rows = await r.json();
    if (rows && rows[0]) {
      const la = Number(rows[0].lat), lo = Number(rows[0].lon);
      if (Number.isFinite(la) && Number.isFinite(lo)) return { lat: la, lng: lo };
    }
  } catch { /* caller falls through */ }
  return null;
}

// Photon (Komoot) place search — a separate host from Nominatim, used
// first for city lookups because Nominatim rate-limits the server's
// datacenter IP during backfill bursts (three loads stayed mile-less
// through several retries on 2026-11-17 while their addresses were
// perfectly ordinary).
async function photonSearch(q) {
  try {
    const r = await fetch('https://photon.komoot.io/api/?limit=1&q=' + encodeURIComponent(q), { headers: { 'User-Agent': 'LXL-Driver/1.0 (lubanaxpress.com)' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json();
    const f = j && j.features && j.features[0];
    if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) return null;
    const lng = Number(f.geometry.coordinates[0]), lat = Number(f.geometry.coordinates[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch { /* caller falls through */ }
  return null;
}

// Fast coordinates for the miles calculation: the stored/gate pin when
// there is one, otherwise a city-level Nominatim lookup (plenty
// accurate for road miles, and far faster than the full address chain),
// then the raw address text, then the full geocode chain.
async function milesCoords(load, kind) {
  const lat = kind === 'pickup' ? load.pickupLat : load.deliveryLat;
  const lng = kind === 'pickup' ? load.pickupLng : load.deliveryLng;
  if (typeof lat === 'number' && typeof lng === 'number') return { lat, lng };
  const text = kind === 'pickup' ? load.pickupLocation : load.deliveryLocation;
  const cs = cityStateOf(text);
  if (cs) { const hit = await photonSearch(cs); if (hit) return hit; }
  if (cs) { const hit = await nominatimSearch(cs); if (hit) return hit; }
  if (text && String(text).trim().length > 3) { const hit = await photonSearch(String(text).trim()); if (hit) return hit; }
  if (text && String(text).trim().length > 3) { const hit = await nominatimSearch(String(text).trim()); if (hit) return hit; }
  return kind === 'pickup' ? ensurePickupCoords(load) : ensureDeliveryCoords(load);
}

// Road miles for a load, cached on loads.miles: OSRM public routing
// first, straight-line distance x 1.18 as the fallback. A load whose
// route cannot be resolved gets miles = -1 so it is not retried on
// every request (the boot backfill gives it one more try per boot).
async function ensureLoadMiles(load) {
  if (typeof load.miles === 'number' && load.miles !== 0) return load.miles > 0 ? load.miles : null;
  const p = await milesCoords(load, 'pickup');
  const dl = await milesCoords(load, 'delivery');
  let miles = null;
  if (p && dl) {
    try {
      const r = await fetch('https://router.project-osrm.org/route/v1/driving/' + p.lng + ',' + p.lat + ';' + dl.lng + ',' + dl.lat + '?overview=false', { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j = await r.json();
        const dist = j && j.routes && j.routes[0] && j.routes[0].distance;
        if (Number.isFinite(dist) && dist > 0) miles = dist / 1609.344;
      }
    } catch { /* fall through to the straight-line estimate */ }
    if (miles == null) {
      const m = distanceMeters(p.lat, p.lng, dl.lat, dl.lng);
      if (Number.isFinite(m) && m > 0) miles = (m / 1609.344) * 1.18;
    }
  }
  try { db.prepare('UPDATE loads SET miles = ? WHERE id = ?').run(miles != null && miles > 0 ? Math.round(miles * 10) / 10 : -1, load.id); } catch { /* miles column may not exist yet */ }
  return miles != null && miles > 0 ? Math.round(miles * 10) / 10 : null;
}

function loadFuelReceiptCents(loadId) {
  return db.prepare("SELECT COALESCE(SUM(amountCents), 0) AS s FROM documents WHERE loadId = ? AND kind = 'fuel_receipt'").get(loadId).s;
}

// One trip's profit parts under the Trucks-profit rules: fuel = the
// receipts uploaded on the load, driver pay = miles x $0.65, other =
// cash out entries tagged to the load (fuel/driver-pay categories
// excluded so nothing double-counts).
function tripProfitParts(trip) {
  const fuelCents = loadFuelReceiptCents(trip.loadId);
  const driverPayCents = typeof trip.miles === 'number' && trip.miles > 0 ? Math.round(trip.miles * DRIVER_PAY_PER_MILE_CENTS) : 0;
  const otherCents = db.prepare("SELECT COALESCE(SUM(amountCents), 0) AS s FROM cash_entries WHERE loadId = ? AND direction = 'out' AND category NOT LIKE 'Fuel%' AND category != 'Driver pay'").get(trip.loadId).s;
  return { fuelCents, driverPayCents, otherCents, expensesCents: fuelCents + driverPayCents + otherCents };
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
  const res = await fetch(path.startsWith('http') ? path : `https://graph.microsoft.com/v1.0${path}`, {
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

// An amount followed by a weight unit is a WEIGHT, not money — the
// Armstrong PDFs print "41545.67L" for the load's pounds, and the
// fallback reader took it for a $41,545.67 rate (2026-11-16).
// A bare amount (no $) shortly after the word "weight" is the
// weight column's value, not money (the RXO header row flattens to
// "Total Weight (lbs.) ... 31928.00" with no unit after the number).
function nearWeightLabel(text, idx) {
  return /weight/i.test(text.slice(Math.max(0, idx - 64), idx));
}

function isWeightAmount(text, idx, len) {
  const tail = text.slice(idx + len, idx + len + 6);
  return /^\s*(?:lbs?|kgs?|tons?)\b/i.test(tail) || /^L\b/.test(tail);
}

function detectRateCents(text) {
  // Keyword-anchored first: the total is what gets paid.
  const patterns = [
    /TOTAL\s+RATE\s*:?\s*(?:USD\s*)?\$?\s*([\d,]+\.\d{2})/i,
    /LINE\s+HAUL(?:\s+RATE)?\s*:?\s*(?:USD\s*)?\$?\s*([\d,]+\.\d{2})/i,
    /TOTAL\s+(?:PAY|AMOUNT|CHARGES?|DUE)\s*:?\s*(?:USD\s*)?\$?\s*([\d,]+\.\d{2})/i,
    /FLAT\s+RATE\s*:?\s*(?:USD\s*)?\$?\s*([\d,]+\.\d{2})/i,
    /TOTAL\s+(?:\w+\s+)?PAY\s*:?\s*(?:USD\s*)?\$?\s*([\d,]+\.\d{2})/i,
    /TOTAL\s*:?\s*(?:USD\s*)?\$?\s*([\d,]+\.\d{2})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const c = amountToCents(m[1]);
      if (c != null && !isWeightAmount(text, m.index, m[0].length)) return c;
    }
  }
  // Fallback: largest plausible dollar amount in the document (fees and
  // fines are smaller; cargo-insurance figures are way above the cap).
  let best = null;
  for (const m of text.matchAll(/\$?\s*([\d,]+\.\d{2})/g)) {
    const c = amountToCents(m[1]);
    if (c != null && !isWeightAmount(text, m.index, m[0].length) && (m[0].includes('$') || !nearWeightLabel(text, m.index)) && (best == null || c > best)) best = c;
  }
  return best;
}


function detectRateCentsDetailed(text) {
  // Same detection as detectRateCents, but reports whether the amount
  // came from a labeled rate field and the text around the match, so
  // the cleanup pass can tell a real rate from a stray big number.
  const patterns = [
    /TOTAL\s+RATE\s*:?\s*(?:USD\s*)?\$?\s*([\d,]+\.\d{2})/i,
    /LINE\s+HAUL(?:\s+RATE)?\s*:?\s*(?:USD\s*)?\$?\s*([\d,]+\.\d{2})/i,
    /TOTAL\s+(?:PAY|AMOUNT|CHARGES?|DUE)\s*:?\s*(?:USD\s*)?\$?\s*([\d,]+\.\d{2})/i,
    /FLAT\s+RATE\s*:?\s*(?:USD\s*)?\$?\s*([\d,]+\.\d{2})/i,
    /TOTAL\s+(?:\w+\s+)?PAY\s*:?\s*(?:USD\s*)?\$?\s*([\d,]+\.\d{2})/i,
    /TOTAL\s*:?\s*(?:USD\s*)?\$?\s*([\d,]+\.\d{2})/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const c = amountToCents(m[1]);
      if (c != null && !isWeightAmount(text, m.index, m[0].length)) return { cents: c, labeled: true, context: text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30) };
    }
  }
  let best = null;
  let bestIdx = -1;
  let bestRaw = '';
  for (const m of text.matchAll(/\$?\s*([\d,]+\.\d{2})/g)) {
    const c = amountToCents(m[1]);
    if (c != null && !isWeightAmount(text, m.index, m[0].length) && (m[0].includes('$') || !nearWeightLabel(text, m.index)) && (best == null || c > best)) { best = c; bestIdx = m.index; bestRaw = m[0]; }
  }
  return { cents: best, labeled: false, context: bestIdx >= 0 ? text.slice(Math.max(0, bestIdx - 70), bestIdx + bestRaw.length + 30) : '' };
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

function isCarrierName(name) {
  // The carrier on every rate con is the owner's own company — it is
  // NEVER the broker, whichever spelling the PDF uses.
  return /LUBANA|LUBAN\b|\bLXL\b/i.test(String(name || ''));
}

function lxlLoadRef(ref) {
  // Load numbers are always shown as LXL-<broker load number>.
  const r = String(ref || '').trim().toUpperCase();
  if (!r) return '';
  if (r.startsWith('LXL-')) return r;
  if (/^\d/.test(r)) return 'LXL-' + r;
  return r;
}

function detectBroker(text, subject) {
  // The broker is read from the rate confirmation document itself: a
  // labelled broker field first, then the issuing company in the
  // letterhead — never the carrier block (that is Lubana Xpress).
  const t = cleanRateText(text).replace(/\bAttn?\s*:?\s*[A-Z][A-Za-z]+/g, ' ');
  const bad = (n) => !n || isCarrierName(n) || /OTR SOLUTIONS/i.test(n);
  // 1) Labelled broker field: "Broker: Armstrong Transport Group".
  const lm = t.match(/(?:Brokerage\s*:|Broker\s*:|Booked by\s*:?|Issued by\s*:?)\s*([A-Za-z0-9][A-Za-z0-9&'.,\- ]{2,70})/i);
  if (lm) {
    const cand = cleanBrokerName(lm[1].split(/\s+(?:MC|DOT|Phone|Tel|Fax|Email|Address|Load|Date|Ref|Pro)\b/i)[0]);
    if (!bad(cand) && /^[A-Z0-9]/.test(cand) && !/^[A-Z]{1,3}[-\s]?\d/.test(cand) && /LLC|Inc|Ltd|Corp|Co\.|Group|Transport|Logistics|Freight|Express|Trucking/i.test(cand)) return cand;
  }
  // 2) Subject: "... from <broker>" at the end (the D & L pattern).
  if (subject) {
    const m = String(subject).match(/\bfrom\s+(.+?)\s*$/i);
    if (m) { const c = cleanBrokerName(m[1]); if (!bad(c)) return c; }
  }
  // 3) Company-like names anywhere in the document, scored: a name the
  //    email subject also mentions and the letterhead zone count most;
  //    anything inside the carrier block is ignored.
  const subjTokens = new Set(String(subject || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4));
  const cz = t.search(/Carrier\s*:/i);
  const scores = new Map();
  const consider = (raw, idx) => {
    const name = cleanBrokerName(raw);
    if (bad(name)) return;
    if (/^[A-Z]{1,3}[-\s]?\d/.test(name)) return; // "MC-1813953 ..." is an ID, not a name
    if (cz >= 0 && idx > cz && idx < cz + 220) return;
    let s = 1;
    if (idx < 1600) s += 50;
    const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4);
    if (words.some((w) => subjTokens.has(w))) s += 100;
    scores.set(name, (scores.get(name) || 0) + s);
  };
  // Every suffix (LLC, Inc, TRANSPORT, LOGISTICS...) anchors its own
  // candidate: walk back up to 3 name tokens from the suffix. Anchoring
  // per suffix means a rejected name (the carrier block) can never
  // swallow the real broker's name the way a left-to-right scan can.
  const STOP_TOK = /^(MC|DOT|REF|LOAD|DATE|PRO|RATE|CONFIRMATION|CARRIER|SHIPPER|RECEIVER|CONSIGNEE|TOTAL|PHONE|TEL|FAX|EMAIL|ADDRESS|INFORMATION|DETAILS|NUMBER|BILL|SIGNED|COPY)$/i;
  const sufRe = /(LLC|Inc\.?|Ltd\.?|Corp\.?|Co\.?|TRANSPORT\w*|LOGISTICS|FREIGHT|EXPRESS|TRUCKING|GROUP)\b/g;
  let sm;
  while ((sm = sufRe.exec(t))) {
    const end = sm.index + sm[0].length;
    let nameEnd = end;
    if (!/^(LLC|Inc|Ltd|Corp)/i.test(sm[0])) {
      const tm = t.slice(end, end + 8).match(/^\s*,\s*(LLC|Inc\.?|Ltd\.?|Corp\.?)\b/i);
      if (tm) nameEnd = end + tm[0].length;
    }
    const toks = t.slice(Math.max(0, sm.index - 120), sm.index).split(/\s+/).filter(Boolean);
    const nameToks = [t.slice(sm.index, nameEnd)];
    for (let i = toks.length - 1; i >= 0 && nameToks.length < 4; i--) {
      const tok = toks[i];
      if (!/^[A-Z&][A-Za-z0-9&'.,\-]*$/.test(tok)) break;
      if (STOP_TOK.test(tok.replace(/[^A-Za-z]/g, ''))) break;
      nameToks.unshift(tok);
    }
    consider(nameToks.join(' '), sm.index);
  }
  let best = null;
  for (const [name, score] of scores) if (!best || score > best.score || (score === best.score && name.length > best.name.length)) best = { name, score };
  return best ? best.name : null;
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
         WHERE (r.rateCents IS NULL OR r.broker IS NULL OR r.broker LIKE '%LUBAN%') AND f.storedFilename IS NOT NULL`,
      )
      .all();
    for (const row of rows) {
      try {
        const buf = fs.readFileSync(path.join(UPLOADS_DIR, row.storedFilename));
        const d = await extractRateConDetails(buf);
        const curBad = !row.broker || isCarrierName(row.broker) || /OTR SOLUTIONS/i.test(row.broker);
        const nb = curBad ? (d.broker ?? null) : row.broker;
        // Only a LABELED rate may fill a missing rate. The fallback
        // (largest amount on the page) kept resurrecting weights and
        // declared values on BOLs and dispatch sheets that print no
        // rate at all — documents verified by eye stay rate-less.
        let labeledRate = null;
        if (row.rateCents == null) {
          try {
            const t2 = cleanRateText(await pdfTextFromBuffer(buf));
            const det = t2 ? detectRateCentsDetailed(t2) : null;
            if (det && det.labeled) labeledRate = det.cents;
          } catch { /* keep null */ }
        }
        const nr = row.rateCents != null ? row.rateCents : labeledRate;
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

// One-time verification (owner, 2026-11-16: "open the rc and verify
// the states"): re-read every stored rate confirmation, pull the
// route from its pickup/delivery sections, and correct the stored
// pickup/delivery states — plus the route cities on loads the import
// created from those RCs. Runs once; the marker row in one_off_jobs
// keeps later boots from redoing it.
async function verifyRateConStates() {
  try {
    db.prepare('CREATE TABLE IF NOT EXISTS one_off_jobs (name TEXT PRIMARY KEY, doneAt TEXT)').run();
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get('rc-state-verify-2026-11-16')) return;
    const rows = db.prepare(
      `SELECT r.id, r.reference, r.pickupState, r.deliveryState, r.rateCents, r.loadId, f.storedFilename
       FROM rate_confirmations r LEFT JOIN files f ON f.id = r.fileId WHERE f.storedFilename IS NOT NULL`,
    ).all();
    let corrected = 0;
    let loadsFixed = 0;
    for (const row of rows) {
      try {
        const buf = fs.readFileSync(path.join(UPLOADS_DIR, row.storedFilename));
        const text = await extractFileText(buf);
        if (row.rateCents != null && row.rateCents > 2000000 && text) {
          const amt = (row.rateCents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          const at = text.indexOf(amt);
          console.log(`rc verify: big rate ${row.reference} $${amt} context: ${at >= 0 ? JSON.stringify(text.slice(Math.max(0, at - 70), at + 30)) : '(amount string not found in text)'}`);
        }
        const route = extractRcRouteAnchored(text || '');
        if (!route) continue;
        const [pu, dl] = route;
        if (pu.state !== row.pickupState || dl.state !== row.deliveryState) {
          db.prepare('UPDATE rate_confirmations SET pickupState = ?, deliveryState = ? WHERE id = ?').run(pu.state, dl.state, row.id);
          corrected += 1;
          console.log(`rc verify: ${row.reference} states ${row.pickupState}->${row.deliveryState} corrected to ${pu.state}->${dl.state} (${pu.city} -> ${dl.city})`);
        }
        if (row.loadId) {
          const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(row.loadId);
          if (load && load.notes === 'Imported from a rate confirmation email') {
            const np = `${pu.city}, ${pu.state}${pu.zip ? ' ' + pu.zip : ''}`;
            const nd = `${dl.city}, ${dl.state}${dl.zip ? ' ' + dl.zip : ''}`;
            if (np !== load.pickupLocation || nd !== load.deliveryLocation) {
              db.prepare('UPDATE loads SET pickupLocation = ?, deliveryLocation = ?, pickupLat = NULL, pickupLng = NULL, deliveryLat = NULL, deliveryLng = NULL WHERE id = ?')
                .run(np, nd, load.id);
              loadsFixed += 1;
              console.log(`rc verify: load ${load.reference} route corrected to ${np} -> ${nd}`);
            }
          }
        }
      } catch (e) {
        console.error(`rc verify failed for RC ${row.id}`, e);
      }
    }
    db.prepare('INSERT OR REPLACE INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run('rc-state-verify-2026-11-16', now());
    console.log(`rc verify: checked ${rows.length} rate cons, corrected ${corrected} state pairs, ${loadsFixed} load routes`);
  } catch (e) {
    console.error('rc verify failed', e);
  }
}

// One-time repair: a few rate confirmations imported before the
// date validation carry impossible stored dates ("365-24-07T...").
// Re-read those documents and restore real pickup/delivery dates
// (falling back to the linked load's dates). Runs once.
function isRealIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
async function repairRateConDates() {
  try {
    db.prepare('CREATE TABLE IF NOT EXISTS one_off_jobs (name TEXT PRIMARY KEY, doneAt TEXT)').run();
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get('rc-date-repair-2026-11-16')) return;
    const rows = db.prepare(
      `SELECT r.id, r.reference, r.pickupDate, r.deliveryDate, r.loadId, f.storedFilename
       FROM rate_confirmations r LEFT JOIN files f ON f.id = r.fileId`,
    ).all();
    let fixed = 0;
    for (const row of rows) {
      const badP = !isRealIsoDate(row.pickupDate);
      const badD = !isRealIsoDate(row.deliveryDate);
      if (!badP && !badD) continue;
      let p = badP ? null : row.pickupDate;
      let d = badD ? null : row.deliveryDate;
      try {
        if (row.storedFilename) {
          const buf = fs.readFileSync(path.join(UPLOADS_DIR, row.storedFilename));
          const text = await extractFileText(buf);
          const dates = extractRcDates(text || '');
          if (dates.length) {
            if (!p) p = dates[0];
            if (!d) d = dates[dates.length - 1];
          }
        }
      } catch (e) { /* fall through to the load fallback */ }
      if ((!p || !d) && row.loadId) {
        const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(row.loadId);
        if (load) {
          if (!p) p = dateInZone(load.pickupAt, load.pickupTimezone);
          if (!d) d = dateInZone(load.deliveryAt, load.deliveryTimezone);
        }
      }
      if (p && d && isRealIsoDate(p) && isRealIsoDate(d)) {
        db.prepare('UPDATE rate_confirmations SET pickupDate = ?, deliveryDate = ? WHERE id = ?').run(p, d, row.id);
        fixed += 1;
        console.log(`rc dates: ${row.reference} ${row.pickupDate} -> ${row.deliveryDate} repaired to ${p} -> ${d}`);
      } else {
        console.log(`rc dates: ${row.reference} still unrepairable (pickup=${row.pickupDate}, delivery=${row.deliveryDate})`);
      }
    }
    db.prepare('INSERT OR REPLACE INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run('rc-date-repair-2026-11-16', now());
    console.log(`rc dates: repaired ${fixed} rate cons`);
  } catch (e) {
    console.error('rc dates repair failed', e);
  }
}

// One-time Rate Cons cleanup (owner, 2026-11-16: "Clean up the Rate
// Cons list", "Check all the rate confirmation", "Not all the loads
// are added", "the pickup and delivery states [are] wrongs").
// Re-reads EVERY stored rate confirmation and, from its document:
// fixes pickup/delivery states and the linked imported load's route,
// repairs impossible dates, corrects rates that a labeled rate field
// proves wrong, renames word-only junk references to the document's
// real load number, deletes junk rows with no load number in the
// document, merges duplicate rows for the same load (the file-hash
// check cannot catch copies whose misread rate differed), and
// creates the completed load for every rate con that lacks one
// (driver: name on the RC, else truck number, else trailer number).
// Big or ambiguous rates are logged, never guessed. Runs once.
async function cleanupRateCons() {
  try {
    db.prepare('CREATE TABLE IF NOT EXISTS one_off_jobs (name TEXT PRIMARY KEY, doneAt TEXT)').run();
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get('rc-cleanup-2026-11-16')) return;
    const rows = db.prepare('SELECT r.*, f.storedFilename FROM rate_confirmations r LEFT JOIN files f ON f.id = r.fileId').all();
    const info = new Map();
    let statesFixed = 0, loadRoutesFixed = 0, datesFixed = 0, ratesFixed = 0;
    let junkDeleted = 0, renamed = 0, dupDeleted = 0, dupLoadsDeleted = 0, loadsCreated = 0, loadsLinked = 0;
    const fileShared = (fileId, exceptId) => fileId ? db.prepare('SELECT COUNT(*) AS c FROM rate_confirmations WHERE fileId = ? AND id != ?').get(fileId, exceptId).c : 0;
    const deleteRcRow = (row) => {
      db.prepare('DELETE FROM rate_confirmations WHERE id = ?').run(row.id);
      if (row.fileId && !fileShared(row.fileId, row.id)) {
        const f = db.prepare('SELECT * FROM files WHERE id = ?').get(row.fileId);
        db.prepare('DELETE FROM files WHERE id = ?').run(row.fileId);
        if (f) { try { fs.unlinkSync(path.join(UPLOADS_DIR, f.storedFilename)); } catch { /* already gone */ } }
      }
    };
    // Phase A: re-read every document; fix states, load routes, dates, proven rates.
    for (const row of rows) {
      let text = '';
      if (row.storedFilename) {
        try { text = await extractFileText(fs.readFileSync(path.join(UPLOADS_DIR, row.storedFilename))); } catch { text = ''; }
      }
      const fields = extractRcLoadFields(text || '', '');
      const route = extractRcRouteAnchored(text || '');
      const det = detectRateCentsDetailed(text || '');
      info.set(row.id, { text, fields, route, det });
      if (route) {
        const [pu, dl] = route;
        if (pu.state !== row.pickupState || dl.state !== row.deliveryState) {
          db.prepare('UPDATE rate_confirmations SET pickupState = ?, deliveryState = ? WHERE id = ?').run(pu.state, dl.state, row.id);
          row.pickupState = pu.state; row.deliveryState = dl.state; statesFixed += 1;
          console.log(`rc cleanup: ${row.reference} states corrected to ${pu.state}->${dl.state}`);
        }
        if (row.loadId) {
          const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(row.loadId);
          if (load && load.notes === 'Imported from a rate confirmation email') {
            const np = `${pu.city}, ${pu.state}${pu.zip ? ' ' + pu.zip : ''}`;
            const nd = `${dl.city}, ${dl.state}${dl.zip ? ' ' + dl.zip : ''}`;
            if (np !== load.pickupLocation || nd !== load.deliveryLocation) {
              db.prepare('UPDATE loads SET pickupLocation = ?, deliveryLocation = ?, pickupLat = NULL, pickupLng = NULL, deliveryLat = NULL, deliveryLng = NULL WHERE id = ?').run(np, nd, load.id);
              loadRoutesFixed += 1;
              console.log(`rc cleanup: load ${load.reference} route corrected to ${np} -> ${nd}`);
            }
          }
        }
      }
      if (!isRealIsoDate(row.pickupDate) || !isRealIsoDate(row.deliveryDate)) {
        const dates = fields.dates;
        const p = isRealIsoDate(row.pickupDate) ? row.pickupDate : (dates[0] || null);
        const d = isRealIsoDate(row.deliveryDate) ? row.deliveryDate : (dates[dates.length - 1] || dates[0] || null);
        if (p && d) {
          db.prepare('UPDATE rate_confirmations SET pickupDate = ?, deliveryDate = ? WHERE id = ?').run(p, d, row.id);
          row.pickupDate = p; row.deliveryDate = d; datesFixed += 1;
          console.log(`rc cleanup: ${row.reference} dates repaired to ${p} -> ${d}`);
        }
      }
      if (det.labeled && det.cents != null && det.cents !== row.rateCents) {
        if (det.cents <= 1500000 && (row.rateCents == null || row.rateCents <= 1500000)) {
          console.log(`rc cleanup: ${row.reference} rate ${row.rateCents} corrected to ${det.cents} (labeled: ${JSON.stringify(det.context)})`);
          db.prepare('UPDATE rate_confirmations SET rateCents = ? WHERE id = ?').run(det.cents, row.id);
          row.rateCents = det.cents; ratesFixed += 1;
        } else {
          console.log(`rc cleanup: ${row.reference} BIG RATE DISPUTE stored=${row.rateCents} labeled=${det.cents} context: ${JSON.stringify(det.context)} (left unchanged)`);
        }
      } else if (row.rateCents != null && row.rateCents > 1500000) {
        console.log(`rc cleanup: ${row.reference} BIG RATE $${(row.rateCents / 100).toFixed(2)} labeled=${det.labeled} detected=${det.cents} context: ${JSON.stringify(det.context || '(none)')}`);
      } else if (!det.labeled && det.cents != null && row.rateCents != null && det.cents !== row.rateCents) {
        console.log(`rc cleanup: ${row.reference} rate mismatch stored=${row.rateCents} fallback-detected=${det.cents} (kept stored)`);
      }
    }
    // Phase B: junk references (no digits — a word the parser grabbed).
    const keyOf = (ref) => refKey(String(ref || '').replace(/^LXL-?/i, ''));
    for (const row of rows) {
      const inf = info.get(row.id);
      row._junk = !/\d/.test(String(row.reference || ''));
      row._docKey = inf && inf.fields.loadRef ? refKey(inf.fields.loadRef) : null;
      if (!row._junk && row._docKey && row._docKey !== keyOf(row.reference)) {
        console.log(`rc cleanup: ${row.reference} document shows load number ${inf.fields.loadRef} (kept stored reference)`);
      }
    }
    for (const row of rows) {
      if (!row._junk || row._docKey) continue;
      // No load number anywhere in the document: not a usable rate con.
      if (row.loadId) {
        const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(row.loadId);
        if (load && load.notes === 'Imported from a rate confirmation email' && load.reference === row.reference) {
          const docs = db.prepare('SELECT COUNT(*) AS c FROM documents WHERE loadId = ?').get(load.id).c;
          if (docs === 0) { db.prepare('DELETE FROM loads WHERE id = ?').run(load.id); dupLoadsDeleted += 1; }
        }
      }
      deleteRcRow(row);
      info.delete(row.id);
      row._deleted = true;
      junkDeleted += 1;
      console.log(`rc cleanup: deleted junk rate con ${row.reference} (no load number in its document)`);
    }
    // Phase C: rename lone junk rows to the real number; merge duplicates.
    const groups = new Map();
    for (const row of rows) {
      if (row._deleted) continue;
      const key = row._junk ? row._docKey : keyOf(row.reference);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    for (const group of groups.values()) {
      if (group.length === 1 && group[0]._junk) {
        const row = group[0];
        const newRef = lxlLoadRef(info.get(row.id).fields.loadRef);
        if (row.loadId) {
          const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(row.loadId);
          if (load && load.notes === 'Imported from a rate confirmation email' && load.reference === row.reference) {
            db.prepare('UPDATE loads SET reference = ? WHERE id = ?').run(newRef, load.id);
          }
        }
        db.prepare('UPDATE rate_confirmations SET reference = ? WHERE id = ?').run(newRef, row.id);
        console.log(`rc cleanup: junk reference ${row.reference} renamed to ${newRef}`);
        row.reference = newRef; renamed += 1;
        continue;
      }
      if (group.length < 2) continue;
      const scored = group.map((row) => {
        const inf = info.get(row.id);
        let score = 0;
        if (inf.det.labeled && inf.det.cents === row.rateCents) score += 2;
        if (row.loadId) score += 1;
        if (!row._junk) score += 1;
        return { row, score };
      }).sort((a, b) => b.score - a.score || a.row.id - b.row.id);
      const kept = scored[0].row;
      for (const { row: loser } of scored.slice(1)) {
        if (loser.loadId && loser.loadId !== kept.loadId) {
          const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(loser.loadId);
          if (load) {
            const docs = db.prepare('SELECT COUNT(*) AS c FROM documents WHERE loadId = ?').get(load.id).c;
            const otherRc = db.prepare('SELECT COUNT(*) AS c FROM rate_confirmations WHERE loadId = ? AND id != ?').get(load.id, loser.id).c;
            if (load.notes === 'Imported from a rate confirmation email' && docs === 0 && otherRc === 0) {
              db.prepare('DELETE FROM loads WHERE id = ?').run(load.id);
              dupLoadsDeleted += 1;
              console.log(`rc cleanup: deleted duplicate load ${load.reference} (from duplicate rate con ${loser.reference})`);
            } else if (!kept.loadId) {
              db.prepare('UPDATE rate_confirmations SET loadId = ? WHERE id = ?').run(load.id, kept.id);
              kept.loadId = load.id;
              console.log(`rc cleanup: rate con ${kept.reference} now linked to load ${load.reference} (kept from the duplicate)`);
            }
          }
        }
        deleteRcRow(loser);
        info.delete(loser.id);
        loser._deleted = true;
        dupDeleted += 1;
        console.log(`rc cleanup: deleted duplicate rate con ${loser.reference} (kept the other copy for ${kept.reference})`);
      }
    }
    // Phase D: every remaining rate con gets its load.
    const remaining = db.prepare('SELECT * FROM rate_confirmations').all();
    const stillMissing = [];
    for (const row of remaining) {
      if (row.loadId) continue;
      const existing = db.prepare('SELECT * FROM loads WHERE reference = ?').get(row.reference);
      if (existing) {
        db.prepare('UPDATE rate_confirmations SET loadId = ? WHERE id = ?').run(existing.id, row.id);
        loadsLinked += 1;
        console.log(`rc cleanup: ${row.reference} linked to its existing load`);
        continue;
      }
      const inf = info.get(row.id);
      if (!inf) { stillMissing.push(row.reference + ' (document unreadable)'); continue; }
      const f = inf.fields;
      if (f.places.length < 2 || f.dates.length < 1) { stillMissing.push(`${row.reference} (places=${f.places.length} dates=${f.dates.length})`); continue; }
      const driverId = resolveImportedDriverId(f);
      if (!driverId) { stillMissing.push(row.reference + ' (no driver name or truck/trailer number on the rate con)'); continue; }
      const p = f.places[0];
      const d = f.places[f.places.length - 1];
      const pDate = f.dates[0];
      const dDate = f.dates[f.dates.length - 1] || f.dates[0];
      const id = db.prepare(
        "INSERT INTO loads (reference, driverId, pickupLocation, pickupAt, pickupTimezone, deliveryLocation, deliveryAt, deliveryTimezone, notes, status, completedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)",
      ).run(row.reference, driverId, `${p.city}, ${p.state}${p.zip ? ' ' + p.zip : ''}`, `${pDate}T09:00:00`, 'America/Indiana/Indianapolis',
        `${d.city}, ${d.state}${d.zip ? ' ' + d.zip : ''}`, `${dDate}T17:00:00`, 'America/Indiana/Indianapolis',
        'Imported from a rate confirmation email', `${dDate}T17:00:00`, now()).lastInsertRowid;
      db.prepare('UPDATE rate_confirmations SET loadId = ? WHERE id = ?').run(id, row.id);
      loadsCreated += 1;
      console.log(`rc cleanup: created load for ${row.reference} (${p.city}, ${p.state} -> ${d.city}, ${d.state})`);
    }
    db.prepare('INSERT OR REPLACE INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run('rc-cleanup-2026-11-16', now());
    console.log(`rc cleanup: checked ${rows.length} rate cons — states fixed ${statesFixed}, load routes fixed ${loadRoutesFixed}, dates fixed ${datesFixed}, rates fixed ${ratesFixed}, junk deleted ${junkDeleted}, references renamed ${renamed}, duplicates deleted ${dupDeleted}, duplicate loads deleted ${dupLoadsDeleted}, loads created ${loadsCreated}, loads linked ${loadsLinked}, still missing loads ${stillMissing.length}${stillMissing.length ? ' — ' + stillMissing.join('; ') : ''}`);
  } catch (e) {
    console.error('rc cleanup failed', e);
  }
}

// One-off (owner, 2026-11-16): the Scotlynn load LXL-1580304 was
// CANCELLED the morning it was booked — "don't upload it". The bulk
// import created a load card for it (with a garbage route) before the
// cancellation was known. Delete that load card; no RC row was ever
// filed for it. Guarded: only when it has no documents attached.
async function removeCancelledScotlynnLoad() {
  try {
    const marker = 'remove-cancelled-1580304-2026-11-16';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const load = db.prepare('SELECT id FROM loads WHERE reference = ?').get('LXL-1580304');
    if (load) {
      const docs = db.prepare('SELECT COUNT(*) AS c FROM documents WHERE loadId = ?').get(load.id).c;
      if (!docs) {
        db.prepare('DELETE FROM loads WHERE id = ?').run(load.id);
        console.log('cleanup: deleted cancelled Scotlynn load LXL-1580304 (id ' + load.id + ')');
      } else {
        console.log('cleanup: LXL-1580304 has ' + docs + ' documents — NOT deleted');
      }
    } else {
      console.log('cleanup: LXL-1580304 load not present — nothing to delete');
    }
    const rc = db.prepare('SELECT id FROM rate_confirmations WHERE reference = ?').get('LXL-1580304');
    if (rc) console.log('cleanup: an RC row for LXL-1580304 exists (id ' + rc.id + ') — left for manual review');
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
  } catch (e) { console.error('remove cancelled load failed:', e.message); }
}

// Adjudication (2026-11-16): corrections verified by READING the rate
// confirmation documents themselves (the automatic reader had taken
// load WEIGHTS — "41545.67L" — for rates on the Armstrong PDFs, and
// four rows carried stray words as their reference). Every value here
// is quoted from its document; the owner's word confirmed 4820080-1
// (DE -> KY, $1,500) before the document was opened.
async function adjudicateRateCons() {
  try {
    const marker = 'rc-adjudication-2026-11-16';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('rc adjudication: ' + m);
    const akash = db.prepare("SELECT id FROM users WHERE role = 'driver' AND name LIKE '%akash%' ORDER BY id LIMIT 1").get();
    const akashId = akash ? akash.id : null;
    // 1. Armstrong rates, read off the documents' RATE DETAILS lines.
    const rateFix = [['LXL-4820080-1', 150000], ['LXL-4701372-1', 400000], ['LXL-4731383-1', 230000]];
    for (const [ref, cents] of rateFix) {
      const r = db.prepare('UPDATE rate_confirmations SET rateCents = ? WHERE reference = ?').run(cents, ref);
      if (r.changes) log(ref + ' rate set to $' + (cents / 100).toFixed(2) + ' (was a weight)');
    }
    // 2. Routes read off the documents.
    db.prepare("UPDATE rate_confirmations SET pickupState = 'DE', deliveryState = 'KY' WHERE reference = 'LXL-4820080-1'").run();
    const fixLoadRoute = (ref, pu, dl) => {
      const r = db.prepare('UPDATE loads SET pickupLocation = ?, deliveryLocation = ?, pickupLat = NULL, pickupLng = NULL, deliveryLat = NULL, deliveryLng = NULL WHERE reference = ?').run(pu, dl, ref);
      if (r.changes) log(ref + ' load route set to ' + pu + ' -> ' + dl);
    };
    fixLoadRoute('LXL-4820080-1', 'Wilmington, DE 19801', 'Louisville, KY 40243');
    fixLoadRoute('LXL-4701372-1', 'Louisville, KY 40214', 'Terrell, TX 75160');
    // 3. ALBANY is C.H. Robinson's copy of load 569202874 — a duplicate
    // of the row already filed under the real number. Delete it.
    const deleteRcRow = (row, why) => {
      db.prepare('DELETE FROM rate_confirmations WHERE id = ?').run(row.id);
      if (row.fileId) {
        const shared = db.prepare('SELECT COUNT(*) AS c FROM rate_confirmations WHERE fileId = ?').get(row.fileId).c;
        if (!shared) {
          const f = getFileRow(row.fileId);
          db.prepare('DELETE FROM files WHERE id = ?').run(row.fileId);
          if (f) { try { fs.unlinkSync(path.join(UPLOADS_DIR, f.storedFilename)); } catch { /* already gone */ } }
        }
      }
      log('deleted rate con ' + row.reference + ' — ' + why);
    };
    const albany = db.prepare("SELECT * FROM rate_confirmations WHERE reference = 'ALBANY'").get();
    if (albany) deleteRcRow(albany, 'C.H. Robinson copy of load 569202874 (duplicate)');
    // EXECUTIVE is not a rate confirmation at all: it is the TQL
    // carrier-setup packet from 2026-05-05, read in full (8 pages —
    // no load, no stops, no rate; the "$2,000" on the row came from
    // the packet's fuel-advance policy text). Delete the row, and
    // its load too when the load is a documentless import artifact.
    const execRow = db.prepare("SELECT * FROM rate_confirmations WHERE reference = 'EXECUTIVE'").get();
    if (execRow) deleteRcRow(execRow, 'a TQL carrier-setup packet from 2026-05-05, not a rate confirmation');
    const execLoad = db.prepare("SELECT * FROM loads WHERE reference = 'EXECUTIVE'").get();
    if (execLoad) {
      const docs = db.prepare('SELECT COUNT(*) AS c FROM documents WHERE loadId = ?').get(execLoad.id).c;
      if (!docs && execLoad.notes === 'Imported from a rate confirmation email') {
        db.prepare('DELETE FROM loads WHERE id = ?').run(execLoad.id);
        log('deleted the EXECUTIVE load artifact');
      } else {
        log('EXECUTIVE load kept — has documents or was not import-created');
      }
    }
    // 4. Stray-word references renamed to the load numbers printed on
    // their documents.
    const renames = [
      ['ATTN', 'LXL-356391', 'Unlimited Logistics'],
      ['DATE', 'LXL-10425782', 'WJW Associates Ltd'],
      ['BELOW', 'LXL-71142', null],
      ['RATE', 'LXL-9751800', null],
    ];
    for (const [oldRef, newRef, broker] of renames) {
      const rc = db.prepare('SELECT * FROM rate_confirmations WHERE reference = ?').get(oldRef);
      if (!rc) { log('rename skipped — no row ' + oldRef); continue; }
      if (db.prepare('SELECT id FROM rate_confirmations WHERE reference = ?').get(newRef)) { log('rename ' + oldRef + ' -> ' + newRef + ' skipped — target row exists'); continue; }
      if (broker) db.prepare('UPDATE rate_confirmations SET reference = ?, broker = ? WHERE id = ?').run(newRef, broker, rc.id);
      else db.prepare('UPDATE rate_confirmations SET reference = ? WHERE id = ?').run(newRef, rc.id);
      const lr = db.prepare('UPDATE loads SET reference = ? WHERE reference = ?').run(newRef, oldRef);
      log('renamed rate con ' + oldRef + ' -> ' + newRef + (lr.changes ? ' (and its load)' : ''));
    }
    // 5. Trinity 9751800: the document's pickup is Logansport, IN on
    // 2026-07-27 (the row carried the document's own date and a
    // Delaware letterhead state).
    db.prepare("UPDATE rate_confirmations SET pickupState = 'IN', pickupDate = '2026-07-27', deliveryDate = '2026-07-30' WHERE reference = 'LXL-9751800'").run();
    // 6. Loads for the renamed rows: fix or create from the documents,
    // assigned to the driver the document names (Akashdeep, both).
    const ensureLoad = (ref, pu, dl, puDate, dlDate) => {
      let load = db.prepare('SELECT * FROM loads WHERE reference = ?').get(ref);
      if (!load) {
        if (!akashId) { log(ref + ': no load and driver unresolved — left for manual assignment'); return null; }
        const puAt = puDate + 'T09:00:00';
        const dlAt = dlDate + 'T17:00:00';
        const info = db.prepare("INSERT INTO loads (reference, driverId, pickupLocation, pickupAt, pickupTimezone, deliveryLocation, deliveryAt, deliveryTimezone, notes, status, completedAt, createdAt) VALUES (?, ?, ?, ?, 'America/Indiana/Indianapolis', ?, ?, 'America/Indiana/Indianapolis', 'Imported from a rate confirmation email', 'completed', ?, ?)").run(ref, akashId, pu, puAt, dl, dlAt, dlAt, new Date().toISOString());
        load = db.prepare('SELECT * FROM loads WHERE id = ?').get(info.lastInsertRowid);
        log(ref + ': created completed load (driver Akash)');
      }
      return load;
    };
    const settleLoad = (ref, pu, dl, puDate, dlDate) => {
      const load = ensureLoad(ref, pu, dl, puDate, dlDate);
      if (!load) return;
      db.prepare('UPDATE loads SET pickupLocation = ?, deliveryLocation = ?, pickupAt = ?, deliveryAt = ?, completedAt = ?, driverId = COALESCE(?, driverId), pickupLat = NULL, pickupLng = NULL, deliveryLat = NULL, deliveryLng = NULL WHERE id = ?')
        .run(pu, dl, puDate + 'T09:00:00', dlDate + 'T17:00:00', dlDate + 'T17:00:00', akashId, load.id);
      db.prepare('UPDATE rate_confirmations SET loadId = ? WHERE reference = ?').run(load.id, ref);
      log(ref + ': load settled to ' + pu + ' -> ' + dl + ', ' + puDate + ' -> ' + dlDate);
    };
    settleLoad('LXL-356391', 'Hatfield, PA 19440', 'Fort Lauderdale, FL 33316', '2026-09-23', '2026-09-25');
    settleLoad('LXL-9751800', 'Logansport, IN 46947', 'Hidalgo, TX 78557', '2026-07-27', '2026-07-30');
    // 7. Five more documents read in full in the manual pass.
    // FreightSource 0105681: the row carried a letterhead route and
    // no rate; the document is Eufaula AL -> Assonet MA at $3,400.
    db.prepare("UPDATE rate_confirmations SET broker = 'FreightSource LLC', pickupState = 'AL', deliveryState = 'MA', pickupDate = '2026-10-30', deliveryDate = '2026-11-01', rateCents = 340000 WHERE reference = 'LXL-0105681'").run();
    log('LXL-0105681 set to AL -> MA, $3,400.00 (FreightSource document)');
    // The Tyson and Coca-Cola rows hold BOLs, not rate confirmations:
    // fix routes/dates from the BOLs and build their loads — both
    // BOLs show trailer 531, which is Akash's trailer.
    db.prepare("UPDATE rate_confirmations SET pickupDate = '2026-10-08', deliveryDate = '2026-10-10' WHERE reference = 'LXL-5010292603'").run();
    db.prepare("UPDATE rate_confirmations SET pickupState = 'FL', deliveryState = 'IL', pickupDate = '2026-09-26', deliveryDate = '2026-09-27' WHERE reference = 'LXL-0311311324'").run();
    settleLoad('LXL-5010292603', 'Carthage, TX 75633', 'Abingdon, VA 24210', '2026-10-08', '2026-10-10');
    settleLoad('LXL-0311311324', 'Polk City, FL 33668', 'Danville, IL 61834', '2026-09-26', '2026-09-27');
    // Integrity Express dispatch sheets print no rate — the $100 on
    // both rows is a GPS fine in the terms. Clear it to unknown, fix
    // 3012815's broker (RLS is the consignee) and pickup state (CA),
    // and set both loads' cities from the sheets.
    db.prepare("UPDATE rate_confirmations SET rateCents = NULL WHERE reference IN ('LXL-3020150', 'LXL-3012815')").run();
    log('LXL-3020150 / LXL-3012815 rate cleared — the $100 was a fine in the dispatch-sheet terms');
    db.prepare("UPDATE rate_confirmations SET broker = 'Integrity Express Logistics', pickupState = 'CA' WHERE reference = 'LXL-3012815'").run();
    fixLoadRoute('LXL-3020150', 'Newark, NJ 07114', 'Reynolds, IN 47980');
    fixLoadRoute('LXL-3012815', 'Wilmington, CA 90744', 'Newfield, NJ 08344');
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('rc adjudication failed', e); }
}

// Adjudication round 2 (2026-11-16): the remaining documents from the
// manual pass were read — more letterhead routes, two totals that
// include accessorials, and two loads whose documents DO identify
// the driver (3318 names Arsh / truck 1302; 130113554 prints Akash's
// phone as the driver phone).
async function adjudicateRateCons2() {
  try {
    const marker = 'rc-adjudication2-2026-11-16';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('rc adjudication2: ' + m);
    const driverByName = (frag) => db.prepare("SELECT id FROM users WHERE role = 'driver' AND name LIKE ? ORDER BY id LIMIT 1").get('%' + frag + '%');
    const akash = driverByName('akash');
    const arsh = driverByName('arsh');
    const upd = (sql, params, msg) => { const r = db.prepare(sql).run(...params); if (r.changes && msg) log(msg); };
    // Route / broker / date corrections read off the documents.
    upd("UPDATE rate_confirmations SET deliveryState = 'PA' WHERE reference = 'LXL-682545'", [], 'LXL-682545 delivery state GA->PA corrected to PA (Greencastle, document)');
    upd("UPDATE rate_confirmations SET broker = 'C.H. Robinson' WHERE reference = 'LXL-569202874'", [], 'LXL-569202874 broker set to C.H. Robinson (O&W is the receiver)');
    upd("UPDATE rate_confirmations SET broker = 'PTG Logistics LLC' WHERE reference = 'LXL-9841352'", [], 'LXL-9841352 broker set to PTG Logistics LLC');
    upd("UPDATE rate_confirmations SET deliveryState = 'NJ', pickupDate = '2026-08-03', broker = 'SPI Logistics' WHERE reference = 'SPT-691666'", [], 'SPT-691666 set to TX -> NJ, pickup 2026-08-03, SPI Logistics (document)');
    upd("UPDATE rate_confirmations SET broker = 'SPI Logistics' WHERE reference = 'SPT-724956'", [], 'SPT-724956 broker set to SPI Logistics');
    upd("UPDATE rate_confirmations SET broker = 'DeGroot Logistics Inc', pickupDate = '2026-07-06', deliveryDate = '2026-07-07' WHERE reference = 'LXL-183569'", [], 'LXL-183569 broker/dates set from its document');
    upd("UPDATE rate_confirmations SET pickupState = 'CA', pickupDate = '2026-06-05' WHERE reference = 'LXL-2991353'", [], 'LXL-2991353 pickup set to CA, 2026-06-05 (document)');
    // 3318's document total is $1,650 (line haul $1,500 + $150 GPS
    // fee); the row carried only the line haul.
    upd('UPDATE rate_confirmations SET rateCents = 165000 WHERE reference = ?', ['LXL-3318'], 'LXL-3318 rate set to $1,650.00 (document total)');
    // Loads for the two documents that identify their driver.
    const settleFor = (ref, drv, pu, dl, puDate, dlDate) => {
      if (!drv) { log(ref + ': driver row not found — load not created'); return; }
      let load = db.prepare('SELECT * FROM loads WHERE reference = ?').get(ref);
      if (!load) {
        const puAt = puDate + 'T09:00:00';
        const dlAt = dlDate + 'T17:00:00';
        const info = db.prepare("INSERT INTO loads (reference, driverId, pickupLocation, pickupAt, pickupTimezone, deliveryLocation, deliveryAt, deliveryTimezone, notes, status, completedAt, createdAt) VALUES (?, ?, ?, ?, 'America/Indiana/Indianapolis', ?, ?, 'America/Indiana/Indianapolis', 'Imported from a rate confirmation email', 'completed', ?, ?)").run(ref, drv.id, pu, puAt, dl, dlAt, dlAt, new Date().toISOString());
        load = db.prepare('SELECT * FROM loads WHERE id = ?').get(info.lastInsertRowid);
        log(ref + ': created completed load');
      }
      db.prepare('UPDATE loads SET pickupLocation = ?, deliveryLocation = ?, pickupAt = ?, deliveryAt = ?, completedAt = ?, driverId = ?, pickupLat = NULL, pickupLng = NULL, deliveryLat = NULL, deliveryLng = NULL WHERE id = ?')
        .run(pu, dl, puDate + 'T09:00:00', dlDate + 'T17:00:00', dlDate + 'T17:00:00', drv.id, load.id);
      db.prepare('UPDATE rate_confirmations SET loadId = ? WHERE reference = ?').run(load.id, ref);
      log(ref + ': load settled to ' + pu + ' -> ' + dl + ', ' + puDate + ' -> ' + dlDate);
    };
    settleFor('LXL-3318', arsh, 'Martinsburg, WV', 'Atlanta, GA', '2026-10-29', '2026-10-30');
    settleFor('LXL-130113554', akash, 'Fort Wayne, IN 46804', 'Colton, CA 92324', '2026-07-08', '2026-07-10');
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('rc adjudication2 failed', e); }
}

// Adjudication round 3 (2026-11-16): EVERY remaining rate con
// document was read in the manual pass. More letterhead routes
// (three IEL "Cincinnati" pickups were really TX / MS / GA), one
// reversed route (133549), one more weight read as a rate
// (3002349's $2,694.14 is kilograms), the Mega load's second drop
// (2784209 ends in Georgia), Hill Bros 3215414 (GA -> PA, as the
// owner said), and the Tyson load's rate from its Uber Freight
// booking ($4,000 — the row's file is the BOL Aisha sent).
async function adjudicateRateCons3() {
  try {
    const marker = 'rc-adjudication3-2026-11-16';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('rc adjudication3: ' + m);
    const driverByName = (frag) => db.prepare("SELECT id FROM users WHERE role = 'driver' AND name LIKE ? ORDER BY id LIMIT 1").get('%' + frag + '%');
    const akash = driverByName('akash');
    const arsh = driverByName('arsh');
    const upd = (sql, params, msg) => { const r = db.prepare(sql).run(...params); if (r.changes && msg) log(msg); };
    // --- rate confirmation rows, from their documents ---
    upd("UPDATE rate_confirmations SET pickupState = 'GA', deliveryState = 'IN', rateCents = 140000, broker = 'CBR Brokerage, Inc.' WHERE reference = 'LXL-133549'", [], 'LXL-133549: route was reversed — GA -> IN, total payable $1,400 (CBR document)');
    upd("UPDATE rate_confirmations SET pickupDate = '2026-09-20', broker = 'J&A Transportation LLC' WHERE reference = 'LXL-31366'", [], 'LXL-31366: pickup 2026-09-20, broker J&A Transportation LLC');
    upd("UPDATE rate_confirmations SET broker = 'Uber Freight' WHERE reference = 'LXL-6679538394'", [], 'LXL-6679538394: broker Uber Freight');
    upd("UPDATE rate_confirmations SET rateCents = NULL, broker = 'Integrity Express Logistics', pickupState = 'NJ', deliveryDate = '2026-06-29' WHERE reference = 'LXL-3002349'", [], 'LXL-3002349: $2,694.14 was a kg weight — rate cleared; broker IEL; pickup NJ; final delivery 2026-06-29');
    upd("UPDATE rate_confirmations SET broker = 'Center Valley Logistics Inc' WHERE reference = 'LXL-1902308'", [], 'LXL-1902308: broker Center Valley Logistics Inc');
    upd("UPDATE rate_confirmations SET pickupState = 'TX', deliveryDate = '2026-06-18' WHERE reference = 'LXL-2999658'", [], 'LXL-2999658: pickup Mount Pleasant TX, delivery 2026-06-18');
    upd("UPDATE rate_confirmations SET broker = 'American Freight Movers' WHERE reference = 'LXL-3845'", [], 'LXL-3845: broker American Freight Movers');
    upd("UPDATE rate_confirmations SET pickupState = 'MS', pickupDate = '2026-06-13', deliveryDate = '2026-06-15' WHERE reference = 'LXL-2996825'", [], 'LXL-2996825: pickup Laurel MS 2026-06-13, delivery 2026-06-15');
    upd("UPDATE rate_confirmations SET pickupState = 'GA', pickupDate = '2026-06-12', deliveryDate = '2026-06-16' WHERE reference = 'LXL-2998288'", [], 'LXL-2998288: pickup Lake City GA 2026-06-12, delivery 2026-06-16');
    upd("UPDATE rate_confirmations SET pickupDate = '2026-11-12', broker = 'JEAR Logistics, LLC' WHERE reference = 'LXL-1197586'", [], 'LXL-1197586: pickup 2026-11-12, broker JEAR Logistics');
    upd("UPDATE rate_confirmations SET broker = 'Capital Logistics Inc' WHERE reference = 'LXL-1007821'", [], 'LXL-1007821: broker Capital Logistics Inc');
    upd("UPDATE rate_confirmations SET deliveryState = 'GA', deliveryDate = '2026-10-28', broker = 'MegaCorp Logistics' WHERE reference = 'LXL-2784209'", [], 'LXL-2784209: final drop Dacula GA 2026-10-28 (owner was right), broker MegaCorp Logistics');
    upd("UPDATE rate_confirmations SET broker = 'Ascent Global Logistics' WHERE reference = 'LXL-60429234'", [], 'LXL-60429234: broker Ascent Global Logistics');
    upd("UPDATE rate_confirmations SET pickupState = 'GA', deliveryState = 'PA', pickupDate = '2026-10-17', broker = 'Hill Bros. Logistics, Inc.' WHERE reference = 'LXL-3215414'", [], 'LXL-3215414: Arabi GA -> Pottsville PA (owner was right), broker Hill Bros. Logistics');
    upd("UPDATE rate_confirmations SET broker = 'Fortus Group Inc' WHERE reference = 'ATL-001229'", [], 'ATL-001229: broker Fortus Group Inc');
    upd("UPDATE rate_confirmations SET rateCents = 400000, broker = 'Uber Freight' WHERE reference = 'LXL-5010292603'", [], 'LXL-5010292603: rate $4,000.00 from its Uber Freight booking (row file is the BOL)');
    // --- loads: routes, drivers, dates from the documents ---
    const fixLoad = (ref, f) => {
      const load = db.prepare('SELECT * FROM loads WHERE reference = ?').get(ref);
      if (!load) { log(ref + ': load not found for fix'); return; }
      const sets = []; const vals = [];
      if (f.pu) { sets.push('pickupLocation = ?'); vals.push(f.pu); }
      if (f.dl) { sets.push('deliveryLocation = ?'); vals.push(f.dl); }
      if (f.puAt) { sets.push('pickupAt = ?'); vals.push(f.puAt); }
      if (f.dlAt) { sets.push('deliveryAt = ?', 'completedAt = ?'); vals.push(f.dlAt, f.dlAt); }
      if (f.driver) { sets.push('driverId = ?'); vals.push(f.driver.id); }
      sets.push('pickupLat = NULL', 'pickupLng = NULL', 'deliveryLat = NULL', 'deliveryLng = NULL');
      db.prepare('UPDATE loads SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals, load.id);
      log(ref + ': load fixed from its document');
    };
    if (arsh) {
      fixLoad('LXL-133549', { pu: 'Tifton, GA 31793', dl: 'Shelbyville, IN', puAt: '2026-10-10T09:00:00', dlAt: '2026-10-12T17:00:00', driver: arsh });
      fixLoad('LXL-1007821', { driver: arsh });
      fixLoad('LXL-2784209', { dl: 'Dacula, GA 30019', dlAt: '2026-10-28T17:00:00', driver: arsh });
    }
    if (akash) {
      fixLoad('LXL-31366', { puAt: '2026-09-20T09:00:00', driver: akash });
      fixLoad('LXL-60418390', { dl: 'Sun Valley, CA 91352', driver: akash });
      fixLoad('LXL-3002349', { pu: 'Elizabeth, NJ 07201', dl: 'Riverside, CA 92507', dlAt: '2026-06-29T17:00:00', driver: akash });
    }
    fixLoad('LXL-3215414', { pu: 'Arabi, GA 31712', dl: 'Pottsville, PA 17901', puAt: '2026-10-17T09:00:00' });
    fixLoad('LXL-1197586', { puAt: '2026-11-12T09:00:00' });
    // --- loads to create (documents name Akash as driver) ---
    const createFor = (ref, drv, pu, dl, puDate, dlDate) => {
      if (!drv) { log(ref + ': driver unresolved — not created'); return; }
      if (db.prepare('SELECT id FROM loads WHERE reference = ?').get(ref)) { log(ref + ': load already exists'); return; }
      const puAt = puDate + 'T09:00:00';
      const dlAt = dlDate + 'T17:00:00';
      const info = db.prepare("INSERT INTO loads (reference, driverId, pickupLocation, pickupAt, pickupTimezone, deliveryLocation, deliveryAt, deliveryTimezone, notes, status, completedAt, createdAt) VALUES (?, ?, ?, ?, 'America/Indiana/Indianapolis', ?, ?, 'America/Indiana/Indianapolis', 'Imported from a rate confirmation email', 'completed', ?, ?)").run(ref, drv.id, pu, puAt, dl, dlAt, dlAt, new Date().toISOString());
      db.prepare('UPDATE rate_confirmations SET loadId = ? WHERE reference = ?').run(info.lastInsertRowid, ref);
      log(ref + ': created completed load (' + pu + ' -> ' + dl + ')');
    };
    createFor('LXL-2999658', akash, 'Mount Pleasant, TX 75455', 'South El Monte, CA 91733', '2026-06-16', '2026-06-18');
    createFor('LXL-2996825', akash, 'Laurel, MS 39440', 'Laredo, TX 78045', '2026-06-13', '2026-06-15');
    createFor('LXL-2998288', akash, 'Lake City, GA 30260', 'Rancho Cucamonga, CA 91730', '2026-06-12', '2026-06-16');
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('rc adjudication3 failed', e); }
}

// Adjudication round 4 (2026-11-16): the RXO confirmation uploaded
// through Add RC was mis-read by the automatic reader — it took the
// word TOTAL (from the "Order # / Total Weight" column headers) as
// the load number and the 31,928 lb weight as the rate. The document
// itself was read in Outlook: RXO load 24237218, Wilmington IL ->
// Port St Lucie FL, $6,500, driver Akashdeep Singh. Also clears the
// rates the boot backfill may have refilled onto documents that
// print no rate (two IEL dispatch sheets and the Coca-Cola BOL).
async function adjudicateRateCons4() {
  try {
    const marker = 'rc-adjudication4-2026-11-16';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('rc adjudication4: ' + m);
    for (const ref of ['LXL-0311311324', 'LXL-3020150', 'LXL-3012815']) {
      const row = db.prepare('SELECT rateCents FROM rate_confirmations WHERE reference = ?').get(ref);
      if (row && row.rateCents != null) {
        db.prepare('UPDATE rate_confirmations SET rateCents = NULL WHERE reference = ?').run(ref);
        log(ref + ': rate cleared (was ' + row.rateCents + ' — its document prints no rate)');
      }
    }
    const rc = db.prepare("SELECT * FROM rate_confirmations WHERE reference = 'TOTAL'").get();
    if (rc) {
      db.prepare("UPDATE rate_confirmations SET reference = 'LXL-24237218', broker = 'RXO, Inc.', pickupState = 'IL', deliveryState = 'FL', pickupDate = '2026-09-28', deliveryDate = '2026-09-30', rateCents = 650000 WHERE id = ?").run(rc.id);
      log('TOTAL rate con renamed to LXL-24237218 (RXO, IL -> FL, $6,500)');
    }
    const load = db.prepare("SELECT * FROM loads WHERE reference = 'TOTAL'").get();
    if (load) {
      db.prepare("UPDATE loads SET reference = 'LXL-24237218', pickupLocation = 'Wilmington, IL 60481', deliveryLocation = 'Port St Lucie, FL 34987', pickupAt = '2026-09-28T09:00:00', deliveryAt = '2026-09-30T17:00:00', status = 'completed', completedAt = '2026-09-30T17:00:00', pickupLat = NULL, pickupLng = NULL, deliveryLat = NULL, deliveryLng = NULL WHERE id = ?").run(load.id);
      if (rc) db.prepare('UPDATE rate_confirmations SET loadId = ? WHERE id = ?').run(load.id, rc.id);
      log('TOTAL load renamed to LXL-24237218 and settled (Wilmington IL -> Port St Lucie FL, completed)');
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('rc adjudication4 failed', e); }
}

// Adjudication round 5 (2026-11-16): two owner corrections plus a
// rate hunt. LXL-2996825's broker is Integrity Express Logistics
// (owner: "that's Integrity Express not worldwide logistics" — its
// document is an IEL dispatch sheet; the detector had picked a
// consignee-side name). LXL-0311311324's broker is Werner
// Enterprises (its booking thread is with twilliams@werner.com,
// Route #2004576602, Polk City FL -> Danville IL); its rate
// confirmation lives behind the Werner Bridge login, so the rate
// is hunted on the OTR factoring schedules, which list each paid
// load's gross by the broker's load number.
async function adjudicateRateCons5() {
  try {
    const marker = 'rc-adjudication5-2026-11-16';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('rc adjudication5: ' + m);
    const u1 = db.prepare("UPDATE rate_confirmations SET broker = 'Integrity Express Logistics' WHERE reference = 'LXL-2996825'").run();
    if (u1.changes) log('LXL-2996825: broker -> Integrity Express Logistics (owner correction)');
    const u2 = db.prepare("UPDATE rate_confirmations SET broker = 'Werner Enterprises' WHERE reference = 'LXL-0311311324'").run();
    if (u2.changes) log('LXL-0311311324: broker -> Werner Enterprises (Werner booking thread, Route #2004576602)');
    // --- hunt the Werner rate on the OTR schedules ---
    try {
      const row = db.prepare("SELECT rateCents FROM rate_confirmations WHERE reference = 'LXL-0311311324'").get();
      if (row && row.rateCents == null) {
        const users = db.prepare('SELECT * FROM users WHERE outlookRefreshToken IS NOT NULL ORDER BY isMainAdmin DESC, id').all();
        let found = false;
        for (const u of users) {
          if (found) break;
          let accessToken;
          try { accessToken = await outlookAccessToken(u); } catch { continue; }
          const page = await outlookGraph(accessToken, '/me/messages?$search=%22schedule%20has%20posted%22&$top=50&$select=id,subject,receivedDateTime,hasAttachments').catch(() => null);
          const msgs = ((page && page.value) || []).filter((m) => m.hasAttachments && /schedule/i.test(m.subject || '') && String(m.receivedDateTime || '') >= '2026-09-25' && String(m.receivedDateTime || '') <= '2026-10-25');
          log('schedule hunt: ' + msgs.length + ' candidate schedule email(s) in ' + (u.outlookEmail || u.name));
          let checked = 0;
          for (const m of msgs) {
            if (found || checked >= 12) break;
            const atts = await outlookGraph(accessToken, `/me/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size`).catch(() => null);
            for (const a of ((atts && atts.value) || [])) {
              if (!a.id || (a.size || 0) >= 12000000 || !((a.contentType || '').includes('pdf') || /\.pdf$/i.test(a.name || ''))) continue;
              checked += 1;
              const { fileBuffer } = await outlookAttachmentBuffer(u, m.id, a.id).catch(() => ({}));
              if (!fileBuffer || !fileBuffer.length) continue;
              const text = await extractFileText(fileBuffer).catch(() => '');
              const idx = text.indexOf('2004576602');
              if (idx < 0) continue;
              const ctx = text.slice(Math.max(0, idx - 60), idx + 200);
              log('schedule context for 2004576602: ' + ctx.replace(/\s+/g, ' ').slice(0, 240));
              const amts = [...text.slice(idx, idx + 200).matchAll(/\$?\s*([\d,]+\.\d{2})/g)]
                .map((x) => amountToCents(x[1])).filter((c) => c != null && c >= 20000 && c <= 5000000);
              if (amts.length) {
                db.prepare("UPDATE rate_confirmations SET rateCents = ? WHERE reference = 'LXL-0311311324'").run(amts[0]);
                log('LXL-0311311324: rate set to ' + amts[0] + ' (OTR schedule gross for Route #2004576602)');
                found = true;
              }
            }
          }
        }
        if (!found) log('LXL-0311311324: Route #2004576602 not found on the Sep-Oct OTR schedules — rate left blank');
      }
    } catch (e) { console.error('rc adjudication5 schedule hunt failed', e); }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('rc adjudication5 failed', e); }
}

// Adjudication round 6 (2026-11-16): fixes from the full read-back
// after the Aisha-mailbox sweep. The sweep re-imported two loads
// that were already filed, creating duplicate rows with wrong data
// (SPT-691666 as TX->TX $5,500 no broker; LXL-183569 as "LOGISTICS"
// $1,700) — the verified rows (SPI $5,700 TX->NJ; DeGroot $1,928)
// are kept and the duplicates deleted. The Werner row for
// LXL-0311311324 keeps the real rate confirmation the owner
// supplied (Route #2004576602, $2,100) and drops the bill-of-lading
// row. The Uber row LXL-5010292603 still holds a Tyson BOL — the
// real confirmation's upload was turned away by the duplicate
// check (same reference + rate + dates), so the BOL row is removed
// here and the real confirmation is filed right after this deploy.
// The three D&L Victorville loads (created by hand in the portal)
// are marked completed.
async function adjudicateRateCons6() {
  try {
    const marker = 'rc-adjudication6-2026-11-16';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('rc adjudication6: ' + m);
    const deleteRcFully = (row, why) => {
      db.prepare('DELETE FROM rate_confirmations WHERE id = ?').run(row.id);
      if (row.fileId) {
        const usedElsewhere = db.prepare('SELECT id FROM rate_confirmations WHERE fileId = ? LIMIT 1').get(row.fileId)
          || db.prepare('SELECT id FROM documents WHERE fileId = ? LIMIT 1').get(row.fileId);
        if (!usedElsewhere) {
          const f = db.prepare('SELECT storedFilename FROM files WHERE id = ?').get(row.fileId);
          db.prepare('DELETE FROM files WHERE id = ?').run(row.fileId);
          if (f && f.storedFilename) { try { fs.unlinkSync(path.join(UPLOADS_DIR, f.storedFilename)); } catch { /* already gone */ } }
        }
      }
      log('deleted rate con ' + row.reference + ' (id ' + row.id + ') — ' + why);
    };
    // 1. SPT-691666 duplicate (keep the verified SPI TX->NJ $5,700 row)
    {
      const rows = db.prepare("SELECT * FROM rate_confirmations WHERE reference = 'SPT-691666'").all();
      const keep = rows.find((r) => r.deliveryState === 'NJ') || rows[0];
      for (const r of rows) if (!keep || r.id !== keep.id) deleteRcFully(r, 'sweep duplicate of the verified SPI row');
    }
    // 2. LXL-183569 duplicate (keep the verified DeGroot $1,928 row)
    {
      const rows = db.prepare("SELECT * FROM rate_confirmations WHERE reference = 'LXL-183569'").all();
      const keep = rows.find((r) => r.rateCents === 192800) || rows[0];
      for (const r of rows) if (!keep || r.id !== keep.id) deleteRcFully(r, 'sweep duplicate of the verified DeGroot row');
    }
    // 3. Werner LXL-0311311324: keep the real confirmation, drop the BOL row
    {
      const WERNER_HASH = '6906e102f93224914739281f0168c9cb86f252decface722d2bb2630507eae99';
      const rows = db.prepare("SELECT * FROM rate_confirmations WHERE reference = 'LXL-0311311324'").all();
      const keep = rows.find((r) => r.fileHash === WERNER_HASH) || rows.find((r) => r.rateCents === 210000);
      if (keep) {
        db.prepare("UPDATE rate_confirmations SET broker = 'Werner Enterprises', rateCents = 210000, pickupState = 'FL', deliveryState = 'IL', pickupDate = '2026-09-25', deliveryDate = '2026-09-27' WHERE id = ?").run(keep.id);
        log('LXL-0311311324: kept the real Werner confirmation ($2,100, pickup 2026-09-25 per the document)');
        for (const r of rows) if (r.id !== keep.id) deleteRcFully(r, 'bill of lading filed as the rate confirmation');
      } else log('LXL-0311311324: WARNING — no Werner confirmation row found');
    }
    // 4. Uber LXL-5010292603: remove the BOL row so the real confirmation can be filed
    {
      const UBER_HASH = 'e5dcad9a6af498a0aedced002ce859c4555ee6c8072c7332191257d4293eac96';
      const rows = db.prepare("SELECT * FROM rate_confirmations WHERE reference = 'LXL-5010292603'").all();
      for (const r of rows) if (r.fileHash !== UBER_HASH) deleteRcFully(r, 'Tyson BOL filed as the rate confirmation — real Uber confirmation is filed after this deploy');
    }
    // 5. The three hand-created D&L Victorville loads are completed trips
    {
      const u = db.prepare("UPDATE loads SET status = 'completed', completedAt = deliveryAt WHERE reference IN ('LXL-1882819', 'LXL-1891120', 'LXL-1891143') AND status = 'active'").run();
      if (u.changes) log('marked ' + u.changes + ' D&L Victorville load(s) completed');
    }
    // 6. SPT-738485 (from Aisha's mailbox) is an SPI Logistics load
    {
      const u = db.prepare("UPDATE rate_confirmations SET broker = 'SPI Logistics' WHERE reference = 'SPT-738485' AND (broker IS NULL OR broker = '')").run();
      if (u.changes) log('SPT-738485: broker -> SPI Logistics');
    }

    // 7. SPT-738485: create the live load for Arsh from the SPI
    // document (owner's instruction — the tender names the carrier
    // contact, but the owner assigns this load to Arshdeep) and
    // link the rate con row to it. Pickup Sylacauga, AL 35151
    // (Harrell's Fertilizer) 2026-11-16, delivery Sewell, NJ 08080
    // (Scott Farm Nursery) 2026-11-17, $2,600 — read off the
    // document itself.
    {
      const arsh = db.prepare("SELECT id FROM users WHERE role = 'driver' AND name LIKE '%arsh%' ORDER BY id LIMIT 1").get();
      const rc = db.prepare("SELECT * FROM rate_confirmations WHERE reference = 'SPT-738485'").get();
      let load = db.prepare("SELECT * FROM loads WHERE reference = 'SPT-738485'").get();
      if (!load && arsh) {
        const info = db.prepare("INSERT INTO loads (reference, driverId, pickupLocation, pickupAt, pickupTimezone, deliveryLocation, deliveryAt, deliveryTimezone, notes, status, completedAt, createdAt) VALUES ('SPT-738485', ?, 'Sylacauga, AL 35151', '2026-11-16T09:00:00', 'America/Indiana/Indianapolis', 'Sewell, NJ 08080', '2026-11-17T17:00:00', 'America/Indiana/Indianapolis', 'Added from the SPI rate confirmation (owner assigned to Arshdeep)', 'active', NULL, ?)").run(arsh.id, new Date().toISOString());
        load = db.prepare('SELECT * FROM loads WHERE id = ?').get(info.lastInsertRowid);
        log('SPT-738485: created ACTIVE load for Arshdeep — Sylacauga, AL 35151 -> Sewell, NJ 08080');
        notifyDriver(db, arsh.id, 'load_assigned', 'New load assigned', 'Load SPT-738485: Sylacauga, AL → Sewell, NJ.').catch(() => {});
      }
      if (load && rc && rc.loadId !== load.id) {
        db.prepare('UPDATE rate_confirmations SET loadId = ? WHERE id = ?').run(load.id, rc.id);
        log('SPT-738485: rate con linked to its load');
      }
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('rc adjudication6 failed', e); }
}

// One-time adjudication round 7 (2026-11-16): final fixes after the
// Ali-mailbox sweep. Deletes the two duplicates the sweep re-imported
// (same misread copies as round 6 removed), pins broker/rate values
// read off the actual documents for the Scotlynn, Watco and Uber rows
// the upload parser could not read, repairs IEL load pickup cities
// and the LXL-2998288 route from the verified document reads, clears
// the $100 GPS-fine figure the import took as the rate on IEL
// LXL-3127767 (same proven pattern as LXL-3020150 / LXL-3012815),
// fixes the Corcoran delivery date (document: Mon 2026-11-02), and
// restores the LXL-1882819 load that disappeared during the sweep.
async function adjudicateRateCons7() {
  try {
    const marker = 'rc-adjudication7-2026-11-16';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('rc adjudication7: ' + m);
    const deleteRcFully = (row, why) => {
      db.prepare('DELETE FROM rate_confirmations WHERE id = ?').run(row.id);
      if (row.fileId) {
        const usedElsewhere = db.prepare('SELECT id FROM rate_confirmations WHERE fileId = ? LIMIT 1').get(row.fileId)
          || db.prepare('SELECT id FROM documents WHERE fileId = ? LIMIT 1').get(row.fileId);
        if (!usedElsewhere) {
          const f = db.prepare('SELECT storedFilename FROM files WHERE id = ?').get(row.fileId);
          db.prepare('DELETE FROM files WHERE id = ?').run(row.fileId);
          if (f && f.storedFilename) { try { fs.unlinkSync(path.join(UPLOADS_DIR, f.storedFilename)); } catch { /* already gone */ } }
        }
      }
      log('deleted rate con ' + row.reference + ' (id ' + row.id + ') — ' + why);
    };
    // 1. SPT-691666 duplicate AGAIN (keep the verified SPI TX->NJ $5,700 row)
    {
      const rows = db.prepare("SELECT * FROM rate_confirmations WHERE reference = 'SPT-691666'").all();
      const keep = rows.find((r) => r.deliveryState === 'NJ') || rows.find((r) => r.rateCents === 570000) || rows[0];
      for (const r of rows) if (!keep || r.id !== keep.id) deleteRcFully(r, 'sweep duplicate of the verified SPI row (came back in the Ali sweep)');
    }
    // 2. LXL-183569 duplicate AGAIN (keep the verified DeGroot $1,928 row)
    {
      const rows = db.prepare("SELECT * FROM rate_confirmations WHERE reference = 'LXL-183569'").all();
      const keep = rows.find((r) => r.rateCents === 192800) || rows[0];
      for (const r of rows) if (!keep || r.id !== keep.id) deleteRcFully(r, 'sweep duplicate of the verified DeGroot row (came back in the Ali sweep)');
    }
    // 3. Scotlynn LXL-1557524: values from the verified read of the
    // document (Lebanon IN -> Boca Raton FL, $5,700, driver Akash);
    // the upload parser could read neither broker nor rate.
    {
      const u = db.prepare("UPDATE rate_confirmations SET broker = 'Scotlynn USA Division', rateCents = 570000 WHERE reference = 'LXL-1557524'").run();
      if (u.changes) log('LXL-1557524: broker -> Scotlynn USA Division, rate -> $5,700 (per the document)');
      const l = db.prepare("UPDATE loads SET status = 'completed', completedAt = deliveryAt WHERE reference = 'LXL-1557524' AND status = 'active'").run();
      if (l.changes) log('LXL-1557524: load marked completed');
    }
    // 4. Watco LXL-2321747: broker name from the document (the upload
    // read the letterhead 'Supply Chain Services, LLC'); delivered
    // 2026-11-16, so the load is completed.
    {
      const u = db.prepare("UPDATE rate_confirmations SET broker = 'Watco Logistics' WHERE reference = 'LXL-2321747'").run();
      if (u.changes) log('LXL-2321747: broker -> Watco Logistics');
      const l = db.prepare("UPDATE loads SET status = 'completed', completedAt = deliveryAt WHERE reference = 'LXL-2321747' AND status = 'active'").run();
      if (l.changes) log('LXL-2321747: load marked completed');
    }
    // 5. Uber LXL-5010292603: broker string cleanup (the upload read
    // 'Commodity FREIGHT' off the real confirmation).
    {
      const u = db.prepare("UPDATE rate_confirmations SET broker = 'Uber Freight' WHERE reference = 'LXL-5010292603'").run();
      if (u.changes) log('LXL-5010292603: broker -> Uber Freight');
    }
    // 6. LXL-3845: full broker name from the document; link to its load.
    {
      const u = db.prepare("UPDATE rate_confirmations SET broker = 'American Freight Movers' WHERE reference = 'LXL-3845'").run();
      if (u.changes) log('LXL-3845: broker -> American Freight Movers');
      const rc = db.prepare("SELECT * FROM rate_confirmations WHERE reference = 'LXL-3845'").get();
      const load = db.prepare("SELECT * FROM loads WHERE reference = 'LXL-3845'").get();
      if (rc && load && rc.loadId !== load.id) {
        db.prepare('UPDATE rate_confirmations SET loadId = ? WHERE id = ?').run(load.id, rc.id);
        log('LXL-3845: rate con linked to its load');
      }
    }
    // 7. LXL-2998288: the sweep restored the row with the OLD wrong
    // extraction (OH, 6/11 -> 6/11). Document-verified: Lake City, GA
    // 2026-06-12 -> Rancho Cucamonga, CA 2026-06-16, $5,000, Akash.
    {
      const u = db.prepare("UPDATE rate_confirmations SET pickupState = 'GA', deliveryState = 'CA', pickupDate = '2026-06-12', deliveryDate = '2026-06-16' WHERE reference = 'LXL-2998288'").run();
      if (u.changes) log('LXL-2998288: rate con -> GA->CA, 2026-06-12 -> 2026-06-16 (per the document)');
      const l = db.prepare("UPDATE loads SET pickupLocation = 'Lake City, GA 30260', pickupAt = '2026-06-12T09:00:00', deliveryAt = '2026-06-16T17:00:00', completedAt = '2026-06-16T17:00:00', pickupLat = NULL, pickupLng = NULL, deliveryLat = NULL, deliveryLng = NULL WHERE reference = 'LXL-2998288'").run();
      if (l.changes) log('LXL-2998288: load route -> Lake City, GA 30260 -> Rancho Cucamonga, CA');
    }
    // 8+9. IEL load pickup cities: the import used the IEL letterhead
    // (Cincinnati, OH). Documents say Laurel, MS (2996825) and
    // Mount Pleasant, TX (2999658).
    {
      const a = db.prepare("UPDATE loads SET pickupLocation = 'Laurel, MS 39440', pickupLat = NULL, pickupLng = NULL WHERE reference = 'LXL-2996825'").run();
      if (a.changes) log('LXL-2996825: load pickup -> Laurel, MS 39440 (per the document)');
      const b = db.prepare("UPDATE loads SET pickupLocation = 'Mount Pleasant, TX 75455', pickupLat = NULL, pickupLng = NULL WHERE reference = 'LXL-2999658'").run();
      if (b.changes) log('LXL-2999658: load pickup -> Mount Pleasant, TX 75455 (per the document)');
    }
    // 10. Corcoran LXL-127657: delivery date from the document
    // (pickup Sat 2026-10-31, delivery Mon 2026-11-02; the import
    // stored the 10/29 signature date as the delivery date).
    {
      const u = db.prepare("UPDATE rate_confirmations SET deliveryDate = '2026-11-02' WHERE reference = 'LXL-127657'").run();
      if (u.changes) log('LXL-127657: deliveryDate -> 2026-11-02 (per the document)');
    }
    // 11. IEL LXL-3127767: $100 is the GPS-fine figure on IEL dispatch
    // sheets, not a rate (proven on LXL-3020150 and LXL-3012815,
    // which print no rate at all). Clear it.
    {
      const u = db.prepare("UPDATE rate_confirmations SET rateCents = NULL WHERE reference = 'LXL-3127767' AND rateCents = 10000").run();
      if (u.changes) log('LXL-3127767: cleared the $100 GPS-fine figure (no rate on the IEL sheet)');
    }
    // 12. Restore load LXL-1882819 (D&L, Lebanon IN -> Victorville CA,
    // 2026-06-02 -> 2026-06-05, $3,900, Akash) — created by hand on
    // 2026-11-16, verified completed, then disappeared during the
    // Ali sweep. Re-create it completed and re-link its rate con.
    {
      const akash = db.prepare("SELECT id FROM users WHERE role = 'driver' AND name LIKE '%akash%' ORDER BY id LIMIT 1").get();
      let load = db.prepare("SELECT * FROM loads WHERE reference = 'LXL-1882819'").get();
      if (!load && akash) {
        const info = db.prepare("INSERT INTO loads (reference, driverId, pickupLocation, pickupAt, pickupTimezone, deliveryLocation, deliveryAt, deliveryTimezone, notes, status, completedAt, createdAt) VALUES ('LXL-1882819', ?, 'Lebanon, IN 46052', '2026-06-02T09:00:00', 'America/Indiana/Indianapolis', 'Victorville, CA 92395', '2026-06-05T17:00:00', 'America/Indiana/Indianapolis', 'Restored — created from the D & L rate confirmation on 2026-11-16; the load disappeared during the Ali mailbox sweep', 'completed', '2026-06-05T17:00:00', ?)").run(akash.id, new Date().toISOString());
        load = db.prepare('SELECT * FROM loads WHERE id = ?').get(info.lastInsertRowid);
        log('LXL-1882819: load restored (completed, Akash)');
      }
      const rc = db.prepare("SELECT * FROM rate_confirmations WHERE reference = 'LXL-1882819'").get();
      if (load && rc && rc.loadId !== load.id) {
        db.prepare('UPDATE rate_confirmations SET loadId = ? WHERE id = ?').run(load.id, rc.id);
        log('LXL-1882819: rate con linked to its load');
      }
    }
    // 13. Uber LXL-4771874926 (hand-filed from the real confirmation:
    // Lebanon IN 2026-09-10 -> Riverside CA 2026-09-14, $5,300,
    // Truck 1301 = Akash): pin broker/rate and complete the load.
    {
      const u = db.prepare("UPDATE rate_confirmations SET broker = 'Uber Freight', rateCents = 530000 WHERE reference = 'LXL-4771874926'").run();
      if (u.changes) log('LXL-4771874926: broker -> Uber Freight, rate -> $5,300 (per the document)');
      const l = db.prepare("UPDATE loads SET status = 'completed', completedAt = deliveryAt WHERE reference = 'LXL-4771874926' AND status = 'active'").run();
      if (l.changes) log('LXL-4771874926: load marked completed');
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('rc adjudication7 failed', e); }
}

// One-time adjudication round 8 (2026-11-16): the owner's decisions
// on the cleanup report and on the 11 rate-cons-without-loads list.
// (1) LXL-103455 rate goes by the OTR schedule: $2,100 (LXLD-51).
// (2) The five hand-filed loads are completed. (3) RXO broker
// normalized to the document header. (4) Cooke LXL-155408 pinned to
// its document ($4,300, GA->TX, 2026-10-19 -> 2026-10-22; document
// prints PRO 155408, names J&P Logistics as carrier — owner: it is
// an LXL load, driver Arsh). (5) Miller LXL-0202782 rate con row
// inserted from OTR schedule LXLD-22 ($11,000, paid; no file — the
// confirmation is a scanned copy in a dispatcher's mailbox and the
// Add RC form requires a file). (6) Loads created + linked for the
// eight confirmations the owner verified as real with drivers:
// 682545 Arsh, 569202874 Akash, SPT-691666 Akash, 34410 Akash,
// 183569 Akash, 71142 Akash, 0105681 Arsh, 2991353 Akash,
// SPT-724956 Arsh (routes and dates from the verified document
// reads). (7) LXL-9841352 deleted —
// owner: FAKE load. (8) LXL-127657 deleted — owner: load CANCELLED.
// (All 11 list items received verdicts.)
async function adjudicateRateCons8() {
  try {
    const marker = 'rc-adjudication8-2026-11-16';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('rc adjudication8: ' + m);
    const deleteRcFully = (row, why) => {
      db.prepare('DELETE FROM rate_confirmations WHERE id = ?').run(row.id);
      if (row.fileId) {
        const usedElsewhere = db.prepare('SELECT id FROM rate_confirmations WHERE fileId = ? LIMIT 1').get(row.fileId)
          || db.prepare('SELECT id FROM documents WHERE fileId = ? LIMIT 1').get(row.fileId);
        if (!usedElsewhere) {
          const f = db.prepare('SELECT storedFilename FROM files WHERE id = ?').get(row.fileId);
          db.prepare('DELETE FROM files WHERE id = ?').run(row.fileId);
          if (f && f.storedFilename) { try { fs.unlinkSync(path.join(UPLOADS_DIR, f.storedFilename)); } catch { /* already gone */ } }
        }
      }
      log('deleted rate con ' + row.reference + ' (id ' + row.id + ') — ' + why);
    };
    // 1. 103455 by OTR
    {
      const u = db.prepare("UPDATE rate_confirmations SET rateCents = 210000 WHERE reference = 'LXL-103455'").run();
      if (u.changes) log('LXL-103455: rate -> $2,100 (OTR schedule LXLD-51, per the owner)');
    }
    // 2. Complete the five hand-filed loads
    {
      const u = db.prepare("UPDATE loads SET status = 'completed', completedAt = deliveryAt WHERE reference IN ('LXL-1987085', 'LXL-24533992', 'LXL-31418-55364', 'LXL-0202782', 'LXL-155408') AND status = 'active'").run();
      if (u.changes) log('marked ' + u.changes + ' hand-filed load(s) completed');
    }
    // 3. RXO broker string
    {
      const u = db.prepare("UPDATE rate_confirmations SET broker = 'RXO, Inc.' WHERE reference = 'LXL-24533992'").run();
      if (u.changes) log('LXL-24533992: broker -> RXO, Inc.');
    }
    // 4. Cooke pins
    {
      const u = db.prepare("UPDATE rate_confirmations SET broker = 'Cooke Transportation Services, LLC', rateCents = 430000, pickupState = 'GA', deliveryState = 'TX', pickupDate = '2026-10-19', deliveryDate = '2026-10-22' WHERE reference = 'LXL-155408'").run();
      if (u.changes) log('LXL-155408: pinned to the Cooke document ($4,300, GA->TX, 2026-10-19 -> 2026-10-22)');
    }
    // 5. Miller rate con row from the OTR schedule (no file)
    {
      const load = db.prepare("SELECT * FROM loads WHERE reference = 'LXL-0202782'").get();
      const existing = db.prepare("SELECT id FROM rate_confirmations WHERE reference = 'LXL-0202782'").get();
      if (load && !existing) {
        db.prepare("INSERT INTO rate_confirmations (reference, loadId, broker, pickupState, deliveryState, pickupDate, deliveryDate, rateCents, fileId, createdAt) VALUES ('LXL-0202782', ?, 'Miller Brokerage Services LLC', 'CA', 'NJ', '2026-09-02', '2026-09-06', 1100000, NULL, ?)").run(load.id, new Date().toISOString());
        log('LXL-0202782: rate con row created from OTR schedule LXLD-22 ($11,000, no file — confirmation is a scanned copy in a dispatcher mailbox)');
      } else if (existing) {
        log('LXL-0202782: rate con row already exists, left as is');
      } else {
        log('LXL-0202782: WARNING — load not found, rate con row not created');
      }
    }
    // 6. Create the confirmed-real loads and link their rate cons
    {
      const akash = db.prepare("SELECT id FROM users WHERE role = 'driver' AND name LIKE '%akash%' ORDER BY id LIMIT 1").get();
      const arsh = db.prepare("SELECT id FROM users WHERE role = 'driver' AND name LIKE '%arsh%' ORDER BY id LIMIT 1").get();
      const jobs = [
        { ref: 'LXL-682545', driver: arsh, from: 'Atlanta, GA', to: 'Greencastle, PA', p: '2026-10-28', d: '2026-10-29' },
        { ref: 'LXL-569202874', driver: akash, from: 'Albany, GA 31705', to: 'Ypsilanti, MI 48198', p: '2026-09-30', d: '2026-10-02' },
        { ref: 'SPT-691666', driver: akash, from: 'McAllen, TX', to: 'Passaic, NJ', p: '2026-08-03', d: '2026-08-07' },
        { ref: 'LXL-34410', driver: akash, from: 'Pharr, TX', to: 'Houston, TX', p: '2026-08-01', d: '2026-08-02' },
        { ref: 'LXL-183569', driver: akash, from: 'Philadelphia, PA', to: 'Greenwood, IN', p: '2026-07-06', d: '2026-07-07' },
        { ref: 'LXL-71142', driver: akash, from: 'Elizabeth, NJ 07201', to: 'Cincinnati, OH 45241', p: '2026-08-26', d: '2026-08-27' },
        { ref: 'LXL-0105681', driver: arsh, from: 'Eufaula, AL 36027', to: 'Assonet, MA 02702', p: '2026-10-30', d: '2026-11-01' },
        { ref: 'LXL-2991353', driver: akash, from: 'Los Alamitos, CA', to: 'Brooklyn, NY', p: '2026-06-05', d: '2026-06-09' },
        { ref: 'SPT-724956', driver: arsh, from: 'Vineland, NJ', to: 'Valdosta, GA', p: '2026-10-15', d: '2026-10-17' },
      ];
      for (const j of jobs) {
        if (!j.driver) { log(j.ref + ': WARNING — driver not found, load not created'); continue; }
        let load = db.prepare('SELECT * FROM loads WHERE reference = ?').get(j.ref);
        if (!load) {
          const info = db.prepare("INSERT INTO loads (reference, driverId, pickupLocation, pickupAt, pickupTimezone, deliveryLocation, deliveryAt, deliveryTimezone, notes, status, completedAt, createdAt) VALUES (?, ?, ?, ?, 'America/Indiana/Indianapolis', ?, ?, 'America/Indiana/Indianapolis', 'Load created from the rate confirmation (owner confirmed the load and driver 2026-11-16)', 'completed', ?, ?)").run(j.ref, j.driver.id, j.from, j.p + 'T09:00:00', j.to, j.d + 'T17:00:00', j.d + 'T17:00:00', new Date().toISOString());
          load = db.prepare('SELECT * FROM loads WHERE id = ?').get(info.lastInsertRowid);
          log(j.ref + ': created completed load ' + j.from + ' -> ' + j.to);
        }
        const rc = db.prepare('SELECT * FROM rate_confirmations WHERE reference = ?').get(j.ref);
        if (load && rc && rc.loadId !== load.id) {
          db.prepare('UPDATE rate_confirmations SET loadId = ? WHERE id = ?').run(load.id, rc.id);
          log(j.ref + ': rate con linked to its load');
        }
      }
    }
    // 7. PTG LXL-9841352 — owner: FAKE load
    {
      const row = db.prepare("SELECT * FROM rate_confirmations WHERE reference = 'LXL-9841352'").get();
      if (row) deleteRcFully(row, 'owner confirmed this load is FAKE (2026-11-16)');
    }
    // 8. Corcoran LXL-127657 — owner: load CANCELLED
    {
      const row = db.prepare("SELECT * FROM rate_confirmations WHERE reference = 'LXL-127657'").get();
      if (row) deleteRcFully(row, 'owner confirmed this load was CANCELLED (2026-11-16)');
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('rc adjudication8 failed', e); }
}

// One-time removal (2026-11-16): the four IEL dispatch-sheet loads
// (LXL-3020150, LXL-3012815, LXL-3002349, LXL-3127767) come out of
// the Loads list on the owner's instruction — their documents are
// dispatch sheets, not rate confirmations. Their rate con rows are
// already gone (same ruling). LXL-TEST1 is NOT touched.
async function removeDispatchSheetLoads() {
  try {
    const marker = 'remove-dispatch-sheet-loads-2026-11-16';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('rc adjudication9: ' + m);
    const refs = ['LXL-3020150', 'LXL-3012815', 'LXL-3002349', 'LXL-3127767'];
    for (const ref of refs) {
      const load = db.prepare('SELECT id FROM loads WHERE reference = ?').get(ref);
      if (!load) { log(ref + ': load not found, skipped'); continue; }
      const docs = db.prepare('DELETE FROM documents WHERE loadId = ?').run(load.id);
      db.prepare('DELETE FROM loads WHERE id = ?').run(load.id);
      log(ref + ': load deleted' + (docs.changes ? ' (with ' + docs.changes + ' document row(s))' : ''));
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('rc adjudication9 failed', e); }
}

// One-time fix (2026-11-17): truck/trailer payment categories. The
// owner has TWO truck payments — Transport Funding $1,783.97 (1301,
// already correct) and a Meteore debit (1302; the 2026-11-02 $1,749.44
// debit sat in a generic category, so Cash Flow showed only one truck
// payment) — and the Garrett Freight Solutions Zelle payments are the
// TRAILER rent, which he wants counted with the truck payments too.
// Re-categorize every Meteore and Garrett bank entry as Truck payment
// and teach the bank rules (keys derived per transaction) so future
// debits land there automatically.
async function fixTruckPaymentCategories() {
  try {
    const marker = 'fix-truck-payment-categories-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('truck payment categories fix: ' + m);
    const txs = db.prepare("SELECT * FROM bank_transactions WHERE direction = 'out' AND entryId IS NOT NULL AND (name LIKE 'Meteore%' OR name LIKE '%GARRETT%')").all();
    for (const tx of txs) {
      const u = db.prepare("UPDATE cash_entries SET category = 'Truck payment' WHERE id = ? AND category != 'Truck payment'").run(tx.entryId);
      if (u.changes) log('bank tx ' + tx.id + ' (' + tx.date + ', $' + (tx.amountCents / 100).toFixed(2) + ') -> Truck payment');
      for (const k of bankKeys(tx.name))
        db.prepare("INSERT OR REPLACE INTO bank_rules (pattern, direction, category, createdAt) VALUES (?, 'out', 'Truck payment', ?)").run(k, now());
    }
    log('bank rules for Meteore/Garrett -> Truck payment saved');
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('truck payment categories fix failed', e); }
}

// Fixed truck/trailer payments (owner approved 2026-11-17): the two
// truck payments and the Garrett trailer rent move OUT of bank entries
// and INTO fixed monthly payments, so each is counted exactly once —
// as a fixed payment. Both truck loans are with Transport Funding;
// the 1302 payment posts to the bank under the name Meteore. The
// fixed rows are backdated to the month each obligation began
// (Transport Funding Jun 2026, Garrett Aug 2026, Meteore Nov 2026)
// so past months and the all-time totals count them correctly.
async function setupFixedTruckPayments() {
  try {
    const marker = 'fixed-truck-payments-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('fixed truck payments: ' + m);
    const wanted = [
      { amountCents: 178397, note: 'Transport Funding — Truck 1301', createdAt: '2026-06-01T00:00:00.000Z' },
      { amountCents: 174944, note: 'Transport Funding — Truck 1302 (posts as Meteore)', createdAt: '2026-11-01T00:00:00.000Z' },
      { amountCents: 245804, note: 'Garrett Freight Solutions — trailer rent', createdAt: '2026-08-01T00:00:00.000Z' },
    ];
    for (const w of wanted) {
      const exists = db.prepare("SELECT id FROM fixed_payments WHERE category = 'Truck payment' AND amountCents = ? AND active = 1").get(w.amountCents);
      if (!exists) {
        db.prepare('INSERT INTO fixed_payments (category, amountCents, note, createdAt) VALUES (?, ?, ?, ?)').run('Truck payment', w.amountCents, w.note, w.createdAt);
        log('added fixed ' + w.note + ' $' + (w.amountCents / 100).toFixed(2) + ' from ' + w.createdAt.slice(0, 7));
      }
    }
    // Remove the bank entries for these three payees (all months) and
    // mark their bank transactions ignored so they never come back.
    const txs = db.prepare("SELECT * FROM bank_transactions WHERE direction = 'out' AND (UPPER(name) LIKE '%TRANSPORT FUNDIN%' OR UPPER(name) LIKE '%METEORE%' OR UPPER(name) LIKE '%GARRETT%')").all();
    const keys = new Set();
    for (const tx of txs) {
      // Clear the reference first — cash_entries is FK-referenced by
      // bank_transactions.entryId, so the entry can only be deleted
      // after the transaction lets go of it.
      const entryId = tx.entryId;
      db.prepare("UPDATE bank_transactions SET status = 'ignored', entryId = NULL WHERE id = ?").run(tx.id);
      if (entryId) {
        db.prepare('DELETE FROM cash_entries WHERE id = ?').run(entryId);
        log('removed bank entry for tx ' + tx.id + ' (' + tx.date + ', $' + (tx.amountCents / 100).toFixed(2) + ')');
      }
      for (const k of bankKeys(tx.name)) keys.add(k);
    }
    for (const k of keys) db.prepare('DELETE FROM bank_rules WHERE pattern = ?').run(k);
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done (' + txs.length + ' bank tx ignored)');
  } catch (e) { console.error('fixed truck payments failed', e); }
}

// Follow-up to the fixed-payments setup: the bank truncates the
// Transport Funding debit name to "TRANSPORT FUNDIN" (no final G),
// so the first pass matched none of those transactions and their
// entries survived — double-counting next to the new fixed payment.
// This pass uses the truncated prefix and removes them.
async function fixTransportFundingFixed() {
  try {
    const marker = 'fixed-truck-payments-tf-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('fixed truck payments TF: ' + m);
    const txs = db.prepare("SELECT * FROM bank_transactions WHERE direction = 'out' AND UPPER(name) LIKE '%TRANSPORT FUNDIN%'").all();
    const keys = new Set();
    for (const tx of txs) {
      const entryId = tx.entryId;
      db.prepare("UPDATE bank_transactions SET status = 'ignored', entryId = NULL WHERE id = ?").run(tx.id);
      if (entryId) {
        db.prepare('DELETE FROM cash_entries WHERE id = ?').run(entryId);
        log('removed bank entry for tx ' + tx.id + ' (' + tx.date + ', $' + (tx.amountCents / 100).toFixed(2) + ')');
      }
      for (const k of bankKeys(tx.name)) keys.add(k);
    }
    for (const k of keys) db.prepare('DELETE FROM bank_rules WHERE pattern = ?').run(k);
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done (' + txs.length + ' bank tx ignored)');
  } catch (e) { console.error('fixed truck payments TF failed', e); }
}

// Manual add (owner, 2026-11-17): RTC Transportation load 001 528772
// would not upload — the RC writes its stops without commas
// ("Keasbey NJ 08832"), which the reader missed (fixed in
// scanRcPlaces). Read from the document itself: pickup US Beverage
// Packers LLC, Keasbey NJ 08832, appt 11/17/26 17:00; delivery
// HT Hackney, Opp AL 36467, appt 11/19/26 10:00AM; Amount $2,950.00.
// The owner assigned it to Akash.
async function addRtc528772Load() {
  try {
    const marker = 'rtc-528772-manual-add-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('rtc 528772 add: ' + m);
    let load = db.prepare("SELECT * FROM loads WHERE reference = 'LXL-528772'").get();
    if (!load) {
      const driver = db.prepare("SELECT id FROM users WHERE role = 'driver' AND active = 1 AND LOWER(name) LIKE '%akash%'").get();
      if (!driver) { log('SKIPPED — Akash driver row not found'); return; }
      const id = db.prepare(
        "INSERT INTO loads (reference, driverId, pickupLocation, pickupWarehouse, pickupAt, pickupTimezone, deliveryLocation, deliveryWarehouse, deliveryAt, deliveryTimezone, notes, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
      ).run('LXL-528772', driver.id,
        'Keasbey, NJ 08832', 'US Beverage Packers LLC', '2026-11-17T17:00:00', 'America/New_York',
        'Opp, AL 36467', 'HT Hackney', '2026-11-19T10:00:00', 'America/Chicago',
        'Broker: RTC Transportation. BOL 5358088, PO 302120, EDI 3871671, PU 777278. Juice, 42,085 lbs — PROTECT FROM FREEZING. MacroPoint required.',
        now()).lastInsertRowid;
      load = db.prepare('SELECT * FROM loads WHERE id = ?').get(id);
      log('created load LXL-528772 for Akash (Keasbey, NJ -> Opp, AL)');
    } else {
      log('load LXL-528772 already exists (id ' + load.id + ')');
    }
    // Rate con: link the row the failed upload created if it is
    // there; otherwise create it from the document. Either way the
    // rate is the document's Amount column: $2,950.00.
    const rows = db.prepare("SELECT * FROM rate_confirmations WHERE reference LIKE '%528772%'").all();
    if (rows.length > 1) log('WARNING: ' + rows.length + ' RC rows match 528772');
    const row = rows.find((r) => !r.loadId) || rows[0];
    if (row) {
      db.prepare("UPDATE rate_confirmations SET loadId = ?, rateCents = ?, broker = COALESCE(broker, 'RTC Transportation'), pickupState = 'NJ', deliveryState = 'AL', pickupDate = '2026-11-17', deliveryDate = '2026-11-19' WHERE id = ?")
        .run(load.id, 295000, row.id);
      log('linked existing RC row ' + row.id + ' and set rate $2,950.00');
    } else {
      const r = db.prepare('INSERT INTO rate_confirmations (reference, loadId, broker, rateCents, pickupState, deliveryState, pickupDate, deliveryDate, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('LXL-528772', load.id, 'RTC Transportation', 295000, 'NJ', 'AL', '2026-11-17', '2026-11-19', now());
      log('created RC row ' + r.lastInsertRowid + ' at $2,950.00 (no file)');
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('rtc 528772 add failed', e); }
}

// Merge (owner, 2026-11-17): the same RTC job also got created as
// LXL-001528772 (the "001" series prefix glued to the load number,
// full street addresses as the locations) when the rate con was
// uploaded from the laptop. One job = one load: fold the duplicate
// into LXL-528772, keeping whichever rate con row carries the
// uploaded PDF file, and move its documents over.
async function mergeRtc528772Loads() {
  try {
    const marker = 'rtc-528772-merge-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('rtc 528772 merge: ' + m);
    const good = db.prepare("SELECT * FROM loads WHERE reference = 'LXL-528772'").get();
    const dup = db.prepare("SELECT * FROM loads WHERE reference = 'LXL-001528772'").get();
    if (!dup) {
      log('no LXL-001528772 duplicate load — nothing to merge');
    } else if (!good) {
      db.prepare("UPDATE loads SET reference = 'LXL-528772', pickupLocation = 'Keasbey, NJ 08832', deliveryLocation = 'Opp, AL 36467' WHERE id = ?").run(dup.id);
      db.prepare("UPDATE rate_confirmations SET reference = 'LXL-528772' WHERE loadId = ?").run(dup.id);
      log('renamed LXL-001528772 to LXL-528772 and cleaned its route');
    } else {
      const docs = db.prepare('UPDATE documents SET loadId = ? WHERE loadId = ?').run(good.id, dup.id);
      const goodRcs = db.prepare('SELECT * FROM rate_confirmations WHERE loadId = ?').all(good.id);
      const dupRcs = db.prepare('SELECT * FROM rate_confirmations WHERE loadId = ?').all(dup.id);
      for (const r of dupRcs) {
        const clash = goodRcs.find((g) => g.rateCents === r.rateCents && g.pickupDate === r.pickupDate && g.deliveryDate === r.deliveryDate);
        if (clash) {
          if (r.fileId && !clash.fileId) {
            db.prepare('UPDATE rate_confirmations SET fileId = ?, fileHash = ? WHERE id = ?').run(r.fileId, r.fileHash, clash.id);
            log('moved the RC file onto row ' + clash.id);
          }
          db.prepare('DELETE FROM rate_confirmations WHERE id = ?').run(r.id);
          log('deleted duplicate RC row ' + r.id);
        } else {
          db.prepare("UPDATE rate_confirmations SET loadId = ?, reference = 'LXL-528772' WHERE id = ?").run(good.id, r.id);
          log('moved RC row ' + r.id + ' onto LXL-528772');
        }
      }
      db.prepare("UPDATE rate_confirmations SET reference = 'LXL-528772' WHERE reference = 'LXL-001528772'").run();
      db.prepare('DELETE FROM loads WHERE id = ?').run(dup.id);
      log('merged LXL-001528772 into LXL-528772 (documents moved: ' + docs.changes + ')');
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('rtc 528772 merge failed', e); }
}

// Circle Logistics 2661800 fix (owner, 2026-11-17): the portal read
// the route as DE -> DE, but the job is TWO pickups in Delaware and
// a delivery in Georgia, and it belongs to Arsh (truck 1302). From
// Circle's dispatch email: pickup Milford, DE 11/17/2026, delivery
// Rincon, GA 11/19/2026; the second DE pickup is only in the RC PDF,
// so read the stops out of the stored rate con file itself.
async function fixCircle2661800() {
  try {
    const marker = 'circle-2661800-fix-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('circle 2661800 fix: ' + m);
    const arsh = db.prepare("SELECT id FROM users WHERE role = 'driver' AND active = 1 AND LOWER(name) LIKE '%arsh%'").get();
    if (!arsh) { log('SKIPPED — Arsh driver row not found'); return; }
    const rc = db.prepare("SELECT r.*, f.storedFilename, f.originalFilename FROM rate_confirmations r LEFT JOIN files f ON f.id = r.fileId WHERE r.reference LIKE '%2661800%'").get();
    // Read every address out of the stored RC document, in order.
    let places = [];
    if (rc && rc.storedFilename) {
      try {
        const buf = fs.readFileSync(path.join(UPLOADS_DIR, rc.storedFilename));
        const text = await extractFileText(buf);
        places = scanRcPlaces(String(text || '').replace(/\s+/g, ' '), 0);
        log('places in RC: ' + places.map((p) => p.city + ', ' + p.state + (p.zip ? ' ' + p.zip : '')).join(' | '));
      } catch (e) { log('could not read stored RC file: ' + e.message); }
    } else {
      log('no RC row/file found for 2661800 — using the dispatch email route only');
    }
    const ga = places.find((p) => p.state === 'GA');
    const gaIdx = ga ? ga.idx : Number.MAX_SAFE_INTEGER;
    const deCities = [];
    for (const p of places) {
      if (p.state !== 'DE' || p.idx > gaIdx) continue;
      if (!deCities.some((x) => x.city === p.city)) deCities.push(p);
    }
    const fmt = (p) => p.city + ', ' + p.state + (p.zip ? ' ' + p.zip : '');
    const pickup1 = deCities[0] ? fmt(deCities[0]) : 'Milford, DE';
    const delivery = ga ? fmt(ga) : 'Rincon, GA';
    let stops = null;
    if (deCities.length >= 2) {
      stops = {
        pickups: deCities.slice(0, 4).map((p) => ({ location: fmt(p), warehouse: null, at: '2026-11-17T09:00:00', number: null })),
        deliveries: [{ location: delivery, warehouse: null, at: '2026-11-19T17:00:00', number: null }],
      };
      log('two-plus DE pickups found: ' + deCities.map((p) => p.city).join(', '));
    } else {
      log('WARNING: only ' + deCities.length + ' DE pickup(s) read from the RC — stops not set');
    }
    let load = db.prepare("SELECT * FROM loads WHERE reference = 'LXL-2661800'").get();
    const notesBase = 'Broker: Circle Logistics, Inc. Dispatcher Zeke O\u2019Dell 260-208-4500 x2034. MacroPoint tracking required.';
    if (!load) {
      const id = db.prepare(
        'INSERT INTO loads (reference, driverId, pickupLocation, pickupAt, pickupTimezone, deliveryLocation, deliveryAt, deliveryTimezone, stops, notes, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'active\', ?)',
      ).run('LXL-2661800', arsh.id, pickup1, '2026-11-17T09:00:00', 'America/New_York', delivery, '2026-11-19T17:00:00', 'America/New_York',
        stops ? JSON.stringify(stops) : null, notesWithStops(notesBase, stops), now()).lastInsertRowid;
      load = db.prepare('SELECT * FROM loads WHERE id = ?').get(id);
      log('created load LXL-2661800 for Arsh: ' + pickup1 + ' -> ' + delivery);
    } else {
      db.prepare('UPDATE loads SET driverId = ?, pickupLocation = ?, deliveryLocation = ?, stops = ?, notes = ? WHERE id = ?')
        .run(arsh.id, pickup1, delivery, stops ? JSON.stringify(stops) : load.stops, notesWithStops(load.notes || notesBase, stops || (load.stops ? JSON.parse(load.stops) : null)), load.id);
      log('fixed load LXL-2661800: driver Arsh (1302), ' + pickup1 + ' -> ' + delivery);
    }
    if (rc) {
      db.prepare("UPDATE rate_confirmations SET loadId = ?, pickupState = 'DE', deliveryState = 'GA', pickupDate = '2026-11-17', deliveryDate = '2026-11-19' WHERE id = ?")
        .run(load.id, rc.id);
      if (rc.originalFilename && rc.originalFilename.includes('DE-DE')) {
        db.prepare('UPDATE files SET originalFilename = ? WHERE id = ?')
          .run(rc.originalFilename.replace('DE-DE', 'DE-GA'), rc.fileId);
      }
      log('rate con row ' + rc.id + ' corrected to DE -> GA and linked to the load');
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('circle 2661800 fix failed', e); }
}

// RTC 528772 rate link (owner, 2026-11-17): the dashboard rate chip
// needs a rate con that is both LINKED to the load and RATED. The
// surviving load's row (from the laptop upload) has no rate — the
// reader will not take RTC's unlabeled Amount column as a rate —
// and the $2,950 row from the first add is orphaned on the deleted
// duplicate. Keep exactly one row on the load (the one carrying the
// uploaded PDF), rate it $2,950.00 from the document, delete the
// rest, and log the resulting rate con count and booked total.
async function fixRtc528772Rate() {
  try {
    const marker = 'rtc-528772-rate-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('rtc 528772 rate: ' + m);
    const load = db.prepare("SELECT * FROM loads WHERE reference = 'LXL-528772'").get();
    if (!load) { log('SKIPPED — load LXL-528772 not found'); }
    else {
      const rows = db.prepare("SELECT * FROM rate_confirmations WHERE reference LIKE '%528772%'").all();
      for (const r of rows) log('row ' + r.id + ' loadId=' + r.loadId + ' rateCents=' + r.rateCents + ' fileId=' + r.fileId);
      let keep = rows.find((r) => r.fileId) || rows.find((r) => r.loadId === load.id) || rows[0] || null;
      if (!keep) {
        const r = db.prepare('INSERT INTO rate_confirmations (reference, loadId, broker, rateCents, pickupState, deliveryState, pickupDate, deliveryDate, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run('LXL-528772', load.id, 'RTC Transportation', 295000, 'NJ', 'AL', '2026-11-17', '2026-11-19', now());
        keep = db.prepare('SELECT * FROM rate_confirmations WHERE id = ?').get(r.lastInsertRowid);
        log('created row ' + keep.id + ' at $2,950.00');
      } else {
        if (keep.loadId !== load.id || keep.reference !== 'LXL-528772') {
          db.prepare("UPDATE rate_confirmations SET loadId = ?, reference = 'LXL-528772' WHERE id = ?").run(load.id, keep.id);
          log('linked row ' + keep.id + ' to LXL-528772');
        }
        if (keep.rateCents !== 295000) {
          db.prepare('UPDATE rate_confirmations SET rateCents = 295000 WHERE id = ?').run(keep.id);
          log('set rate $2,950.00 on row ' + keep.id);
        }
      }
      for (const r of rows) {
        if (r.id !== keep.id) {
          db.prepare('DELETE FROM rate_confirmations WHERE id = ?').run(r.id);
          log('deleted duplicate row ' + r.id);
        }
      }
      const total = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(rateCents), 0) AS s FROM rate_confirmations').get();
      log('rate cons now: ' + total.c + ' rows, booked $' + (total.s / 100).toFixed(2));
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('rtc 528772 rate failed', e); }
}

// RTC 528772 delivery time (owner screenshot, 2026-11-17): the
// surviving laptop-created load carries a 10:00 PM delivery, but
// the rate confirmation appointment is 11/19/26 10:00 AM at
// HT Hackney in Opp, AL (Central Time). Match the document.
async function fixRtc528772DeliveryTime() {
  try {
    const marker = 'rtc-528772-delivery-time-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const load = db.prepare("SELECT id, deliveryAt FROM loads WHERE reference = 'LXL-528772'").get();
    if (load) {
      db.prepare("UPDATE loads SET deliveryAt = '2026-11-19T10:00:00', deliveryTimezone = 'America/Chicago' WHERE id = ?").run(load.id);
      console.log('rtc 528772 delivery time: was ' + load.deliveryAt + ', set to 2026-11-19T10:00:00 America/Chicago');
    } else {
      console.log('rtc 528772 delivery time: load not found');
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
  } catch (e) { console.error('rtc 528772 delivery time failed', e); }
}

// LXL-1197586 driver fix (owner, 2026-11-17): the GA -> MA load was
// sitting under Akash / truck 1301, but it is Arshdeep's load —
// truck 1302. Reassign the load (and its filed documents) to
// Arshdeep with truck 1302 / trailer 5302.
async function fixLoad1197586Driver() {
  try {
    const marker = 'fix-load-1197586-driver-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('load 1197586 driver: ' + m);
    const arsh = db.prepare("SELECT id FROM users WHERE name LIKE 'Arshdeep%' ORDER BY id LIMIT 1").get();
    const load = db.prepare("SELECT * FROM loads WHERE reference = 'LXL-1197586'").get();
    if (!arsh || !load) { log('skipped arsh=' + (arsh ? arsh.id : 'none') + ' load=' + (load ? load.id : 'none')); return; }
    const truck = db.prepare("SELECT id FROM trucks WHERE unitNumber = '1302'").get();
    const trailer = db.prepare("SELECT id FROM trailers WHERE unitNumber = '5302'").get();
    log('before driverId=' + load.driverId + ' truckId=' + (load.truckId ?? null) + ' trailerId=' + (load.trailerId ?? null));
    const cols = db.prepare('PRAGMA table_info(loads)').all().map((c) => c.name);
    let sql = 'UPDATE loads SET driverId = ?';
    const args = [arsh.id];
    if (cols.includes('truckId') && truck) { sql += ', truckId = ?'; args.push(truck.id); }
    if (cols.includes('trailerId') && trailer) { sql += ', trailerId = ?'; args.push(trailer.id); }
    sql += ' WHERE id = ?'; args.push(load.id);
    db.prepare(sql).run(...args);
    const docs = db.prepare('UPDATE documents SET driverId = ? WHERE loadId = ?').run(arsh.id, load.id);
    const after = db.prepare('SELECT driverId, truckId, trailerId FROM loads WHERE id = ?').get(load.id);
    log('after driverId=' + after.driverId + ' truckId=' + (after.truckId ?? null) + ' trailerId=' + (after.trailerId ?? null) + '; documents moved: ' + docs.changes);
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('load 1197586 driver fix failed', e); }
}

// One-time cash flow reconciliation fix (2026-11-16, owner approved
// after the manual bank-vs-portal check): (1) remove the
// Outlook-imported Factoring payment of $3,972.50 dated 2026-11-16 —
// the same OTR money arrives through the bank feed, so the email
// import double-counts it; (2) remove the Outlook-imported 'fuel'
// entry of $5,450.00 dated 2026-11-16 (category Other) — Pilot
// weekly belongs in Fuel and arrives via the bank drafts;
// (3) re-categorize any Garrett bank entry not already in
// 'Trailer rental' (the portal was exactly one $2,458.04 month
// short of the bank). Deletes run only on an exact single match.
async function fixCashflowReconciliation() {
  try {
    const marker = 'cashflow-recon-fix-2026-11-16';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('cashflow recon fix: ' + m);
    // 1. Outlook factoring duplicate
    {
      const rows = db.prepare("SELECT * FROM cash_entries WHERE source = 'outlook' AND direction = 'in' AND category = 'Factoring payment' AND amountCents = 397250 AND date = '2026-11-16'").all();
      if (rows.length === 1) {
        db.prepare('DELETE FROM cash_entries WHERE id = ?').run(rows[0].id);
        log('deleted Outlook factoring import id ' + rows[0].id + ' (+$3,972.50, 2026-11-16) — bank feed carries this money');
      } else {
        log('WARNING: expected exactly 1 Outlook factoring entry of $3,972.50 on 2026-11-16, found ' + rows.length + ' — skipped');
      }
    }
    // 2. Outlook fuel import in Other
    {
      const rows = db.prepare("SELECT * FROM cash_entries WHERE source = 'outlook' AND direction = 'out' AND category = 'Other' AND amountCents = 545000 AND date = '2026-11-16'").all();
      if (rows.length === 1) {
        db.prepare('DELETE FROM cash_entries WHERE id = ?').run(rows[0].id);
        log('deleted Outlook fuel import id ' + rows[0].id + ' (-$5,450.00, 2026-11-16, was in Other) — Pilot weekly arrives via the bank');
      } else {
        log('WARNING: expected exactly 1 Outlook Other entry of $5,450.00 on 2026-11-16, found ' + rows.length + ' — skipped');
      }
    }
    // 3. Garrett rent category
    {
      const rows = db.prepare("SELECT bt.id AS btId, bt.date, bt.amountCents, bt.entryId, ce.category FROM bank_transactions bt JOIN cash_entries ce ON ce.id = bt.entryId WHERE bt.name LIKE '%GARRETT%' AND bt.direction = 'out' AND bt.status = 'categorized'").all();
      let moved = 0;
      for (const r of rows) {
        if (r.category !== 'Trailer rental') {
          db.prepare("UPDATE cash_entries SET category = 'Trailer rental' WHERE id = ?").run(r.entryId);
          log('Garrett ' + r.date + ' $' + (r.amountCents / 100).toFixed(2) + ': category ' + r.category + ' -> Trailer rental');
          moved++;
        }
      }
      if (!moved) log('Garrett: all bank entries already in Trailer rental');
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('cashflow recon fix failed', e); }
}

// One-time removal (2026-11-16): a second Outlook factoring import
// (+$3,241.25, dated 2026-11-16) landed after the reconciliation
// fix earlier the same evening — the same double-count pattern
// (OTR schedule money imported from email while the bank feed
// already carries it). Removed on the owner's standing instruction
// One-time adjudication round 9 (2026-11-17): undo what the mailbox
// sweep re-imported earlier today. The 2026-11-16 cleanup had deleted
// these rows on the owner's rulings, which erased their dedupe
// fingerprints, so the sweep treated them as new: the four IEL
// dispatch-sheet rows ($100 GPS fines, not rate cons) WITH loads, the
// CANCELLED Corcoran LXL-127657 ($2,350) and the FAKE PTG LXL-9841352
// ($12,000) as rate cons, plus empty shell rate-con rows for the two
// Armstrong loads (a POD image filed as a rate con — the loads and
// their PODs stay). Pairs with the permanent guards added the same
// day: the do-not-import list in createRateCon, the OTR-schedule gate
// in the import, and PDFs-only in the import's rate-con phase.
async function adjudicateRateCons9() {
  try {
    const marker = 'rc-adjudication9-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('rc adjudication9: ' + m);
    const deleteFileIfUnused = (fileId) => {
      if (!fileId) return;
      const usedElsewhere = db.prepare('SELECT id FROM rate_confirmations WHERE fileId = ? LIMIT 1').get(fileId)
        || db.prepare('SELECT id FROM documents WHERE fileId = ? LIMIT 1').get(fileId);
      if (!usedElsewhere) {
        const f = db.prepare('SELECT storedFilename FROM files WHERE id = ?').get(fileId);
        db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
        if (f && f.storedFilename) { try { fs.unlinkSync(path.join(UPLOADS_DIR, f.storedFilename)); } catch { /* already gone */ } }
      }
    };
    const deleteRcFully = (row, why) => {
      db.prepare('DELETE FROM rate_confirmations WHERE id = ?').run(row.id);
      deleteFileIfUnused(row.fileId);
      log('deleted rate con ' + row.reference + ' (id ' + row.id + ') — ' + why);
    };
    const deleteLoadFully = (load, why) => {
      for (const rc of db.prepare('SELECT * FROM rate_confirmations WHERE loadId = ?').all(load.id)) deleteRcFully(rc, why);
      for (const doc of db.prepare('SELECT * FROM documents WHERE loadId = ?').all(load.id)) {
        db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
        deleteFileIfUnused(doc.fileId);
      }
      db.prepare('DELETE FROM loads WHERE id = ?').run(load.id);
      log('deleted load ' + load.reference + ' (id ' + load.id + ') — ' + why);
    };
    // 1. IEL dispatch sheets: rate cons AND their loads out (again).
    for (const ref of ['LXL-3127767', 'LXL-3020150', 'LXL-3012815', 'LXL-3002349']) {
      for (const rc of db.prepare('SELECT * FROM rate_confirmations WHERE reference = ?').all(ref)) deleteRcFully(rc, 'IEL dispatch sheet, not a rate confirmation (owner ruling 2026-11-16; re-imported by the 2026-11-17 sweep)');
      for (const load of db.prepare('SELECT * FROM loads WHERE reference = ?').all(ref)) deleteLoadFully(load, 'IEL dispatch-sheet load (owner ruling 2026-11-16; re-created by the 2026-11-17 sweep)');
    }
    // 2. Cancelled Corcoran + fake PTG: rate cons out (no loads exist).
    for (const ref of ['LXL-127657', 'LXL-9841352']) {
      for (const rc of db.prepare('SELECT * FROM rate_confirmations WHERE reference = ?').all(ref)) deleteRcFully(rc, ref === 'LXL-127657' ? 'CANCELLED Corcoran load (owner ruling 2026-11-16; re-imported by the 2026-11-17 sweep)' : 'FAKE PTG load (owner ruling 2026-11-16; re-imported by the 2026-11-17 sweep)');
    }
    // 3. Armstrong shell rows: rate cons with no rate and no broker —
    // the loads and their filed PODs are NOT touched.
    for (const ref of ['LXL-4837432-1', 'LXL-4750931-1']) {
      for (const rc of db.prepare("SELECT * FROM rate_confirmations WHERE reference = ? AND rateCents IS NULL AND (broker IS NULL OR broker = '')").all(ref)) deleteRcFully(rc, 'empty shell row (POD image filed as a rate con by the 2026-11-17 sweep); the load itself stays, no rate con per the owner');
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('rc adjudication9 failed', e); }
}

// from that fix. Exact-single-match guard.
async function removeOutlookFactoring2() {
  try {
    const marker = 'cashflow-recon-fix2-2026-11-16';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('cashflow recon fix2: ' + m);
    const rows = db.prepare("SELECT * FROM cash_entries WHERE source = 'outlook' AND direction = 'in' AND category = 'Factoring payment' AND amountCents = 324125 AND date = '2026-11-16'").all();
    if (rows.length === 1) {
      db.prepare('DELETE FROM cash_entries WHERE id = ?').run(rows[0].id);
      log('deleted Outlook factoring import id ' + rows[0].id + ' (+$3,241.25, 2026-11-16) — bank feed carries this money');
    } else {
      log('WARNING: expected exactly 1 Outlook factoring entry of $3,241.25 on 2026-11-16, found ' + rows.length + ' — skipped');
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('cashflow recon fix2 failed', e); }
}

// One-time backfill (2026-11-16): documents uploaded before the
// dash-date fix (Indiana cab cards: '01-JUN-2026 TO 31-MAY-2027')
// got no auto-read dates. Re-run detection on every equipment /
// driver document still missing a date and fill only the blanks.
async function backfillDocDates() {
  try {
    // v2 (owner, 2026-11-16): a full re-check, not just filling blanks.
    // Every uploaded document is re-read and its stored issued/expiry
    // dates are corrected to what the document itself says — including
    // clearing a wrong expiry on NO EXPIRY documents. Detection that
    // finds nothing leaves hand-entered dates untouched.
    const marker = 'doc-dates-recheck-2026-11-16-v4';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('doc dates recheck: ' + m);
    const jobs = [
      ['equipment_documents', 'equipment doc'],
      ['driver_documents', 'driver doc'],
    ];
    for (const [table, label] of jobs) {
      const rows = db.prepare(
        'SELECT d.id, d.expiryDate, d.issuedDate, f.storedFilename FROM ' + table + ' d JOIN files f ON f.id = d.fileId'
      ).all();
      for (const r of rows) {
        let buf = null;
        try { buf = fs.readFileSync(path.join(UPLOADS_DIR, r.storedFilename)); } catch { /* missing file: keep stored dates */ }
        if (!buf) { log(label + ' ' + r.id + ': file unreadable — stored dates kept'); continue; }
        const { found, noExpiry } = await detectDocDatesFull(buf);
        if (!found.issuedDate && !found.expiryDate && !noExpiry) { log(label + ' ' + r.id + ': no dates in document — stored dates kept'); continue; }
        let newIssued = r.issuedDate, newExpiry = r.expiryDate;
        if (found.issuedDate) newIssued = found.issuedDate;
        if (found.expiryDate) newExpiry = found.expiryDate;
        if (noExpiry) newExpiry = null;
        if (newIssued !== r.issuedDate || newExpiry !== r.expiryDate) {
          db.prepare('UPDATE ' + table + ' SET issuedDate = ?, expiryDate = ? WHERE id = ?')
            .run(newIssued, newExpiry, r.id);
          log(label + ' ' + r.id + ': issued ' + (r.issuedDate || '—') + ' -> ' + (newIssued || '—') + ', expiry ' + (r.expiryDate || '—') + ' -> ' + (newExpiry || '—'));
        } else {
          log(label + ' ' + r.id + ': dates already match the document');
        }
      }
      if (!rows.length) log(label + ': no documents');
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('doc dates recheck failed', e); }
}

async function createRateCon({ loadId, reference, pickupState, deliveryState, pickupDate, deliveryDate, broker, rateCents, fileBuffer, fileName, mimeType, subject }) {
  // No duplicates, ever: the same file (by sha256 fingerprint) is the
  // same rate confirmation, whichever mailbox or upload it came from.
  const fileHash = fileBuffer ? crypto.createHash('sha256').update(fileBuffer).digest('hex') : null;
  if (fileHash) {
    const dup = db.prepare('SELECT r.*, f.originalFilename, f.mimeType FROM rate_confirmations r LEFT JOIN files f ON f.id = r.fileId WHERE r.fileHash = ?').get(fileHash);
    if (dup) { const out = serializeRateCon(dup); out.duplicate = true; return out; }
  }
  // Pick a load and the file is named from the load — no typing. Typed
  // fields still win when given (older clients send them).
  let load = null;
  if (loadId) {
    load = db.prepare('SELECT * FROM loads WHERE id = ?').get(Number(loadId));
    if (!load) throw Object.assign(new Error('Load not found'), { status: 404 });
  }
  const ref = lxlLoadRef(reference || (load && load.reference) || '');
  // Owner-ruled-out load numbers (2026-11-16 cleanup; a sweep re-imported
  // them on 2026-11-17 because deleting the rows erased their dedupe
  // fingerprints): Corcoran 127657 is CANCELLED, PTG 9841352 and WJW
  // 10425782 are FAKE, Scotlynn 1580304 is CANCELLED, and the four IEL
  // numbers are dispatch sheets, not rate confirmations (their $100 is
  // a GPS fine). Never create a rate con for these again.
  const bareRef = String(ref || '').replace(/^LXL-/i, '');
  if (['127657', '9841352', '10425782', '1580304', '3020150', '3012815', '3002349', '3127767'].includes(bareRef))
    throw Object.assign(new Error('This load number is on the do-not-import list (cancelled, fake, or not a rate confirmation)'), { status: 400 });
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
  if (finalRate != null) {
    const dup = db.prepare('SELECT r.*, f.originalFilename, f.mimeType FROM rate_confirmations r LEFT JOIN files f ON f.id = r.fileId WHERE r.reference = ? AND r.rateCents = ? AND r.pickupDate = ? AND r.deliveryDate = ?').get(ref, finalRate, pDate, dDate);
    if (dup) { const out = serializeRateCon(dup); out.duplicate = true; return out; }
  }
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
      'INSERT INTO rate_confirmations (reference, loadId, broker, pickupState, deliveryState, pickupDate, deliveryDate, rateCents, fileId, fileHash, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
      fileHash,
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
    let useLoadId = loadId || null;
    let auto = null;
    if (!useLoadId && fileBuffer) {
      auto = await findOrCreateLoadFromRc(fileBuffer, undefined);
      if (auto.duplicateRc) return res.status(201).json({ ...serializeRateCon(auto.duplicateRc), duplicate: true });
      useLoadId = auto.load.id;
    }
    const rc = await createRateCon({ loadId: useLoadId, reference, pickupState, deliveryState, pickupDate, deliveryDate, broker, rateCents, fileBuffer, fileName, mimeType });
    res.status(201).json(auto ? { ...rc, loadCreated: auto.created, loadReference: auto.load.reference, loadRoute: auto.load.pickupLocation + ' → ' + auto.load.deliveryLocation } : rc);
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
// --- Bulk rate-confirmation import helpers ---------------------------------
// The owner's mailbox holds every broker rate confirmation. Each RC also
// carries the load itself (reference, route, dates, truck/trailer, driver
// name), so importing one rebuilds the historical load as COMPLETED with
// everything in its place — and the RC on it feeds Cash Flow's booked total.
function rcNormDate(y, mo, d) {
  const yy = Number(y) < 100 ? 2000 + Number(y) : Number(y);
  const mm = Number(mo);
  const dd = Number(d);
  if (!yy || yy < 2024 || yy > 2028 || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const dt = new Date(yy, mm - 1, dd);
  if (dt.getFullYear() !== yy || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${yy}-${p(mm)}-${p(dd)}`;
}
const RC_STREET_SUFFIX = /\b(STREET|ST|AVENUE|AVE|BOULEVARD|BLVD|ROAD|RD|DRIVE|DR|LANE|LN|COURT|CT|HIGHWAY|HWY|PARKWAY|PKWY|CIRCLE|CIR|PLACE|PL|TRAIL|TRL|WAY)\b/gi;
function cleanCityName(city) {
  // Flattened RC text glues the street line onto the city ("TH STREET RANCHO
  // CUCAMONGA, CA 91730"). Cut through the last street-suffix word so only the
  // real city remains. A suffix as the FIRST word is left alone ("ST. LOUIS").
  let c = String(city || '').trim().replace(/\s+/g, ' ');
  // Drop lead-in label words the address regex can swallow ("Delivery
  // Lansdale", "to Valdosta", "Pickup Chicago").
  const leadWords = new Set(['PICKUP', 'DELIVERY', 'ORIGIN', 'DESTINATION', 'FROM', 'TO', 'AT', 'PU', 'DL', 'SHIP', 'SHIPPING', 'RECEIVING', 'CONSIGNEE', 'SHIPPER']);
  const tokens = c.split(' ');
  while (tokens.length > 1 && leadWords.has(tokens[0].toUpperCase().replace(/[^A-Z]/g, ''))) tokens.shift();
  c = tokens.join(' ');
  const matches = [...c.matchAll(RC_STREET_SUFFIX)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const before = c.slice(0, m.index).trim();
    const after = c.slice(m.index + m[0].length).replace(/^[.\s]+/, '').trim();
    if (before && after) return after;
    if (!before) break;
  }
  return c;
}
function validDatePart(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!m) return false;
  const y = +m[1]; const mo = +m[2]; const d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}
function repairImportedLoadData() {
  // One-time cleanup for loads the bulk import created with a garbage date or
  // a street fragment in the city name. Only touches import-created loads.
  try {
    const loads = db.prepare("SELECT * FROM loads WHERE notes = 'Imported from a rate confirmation email'").all();
    for (const l of loads) {
      const upd = {};
      for (const k of ['pickupLocation', 'deliveryLocation']) {
        const v = String(l[k] || '');
        const m = /^(.*),\s*([A-Z]{2})\s+(\d{5})/.exec(v);
        if (m) { const nv = `${cleanCityName(m[1])}, ${m[2]} ${m[3]}`; if (nv !== v) upd[k] = nv; }
      }
      if (!validDatePart(l.pickupAt) || !validDatePart(l.deliveryAt)) {
        const rc = db.prepare('SELECT pickupDate, deliveryDate FROM rate_confirmations WHERE loadId = ?').get(l.id);
        if (!validDatePart(l.pickupAt)) upd.pickupAt = (rc && validDatePart(rc.pickupDate)) ? rc.pickupDate + 'T09:00:00' : (validDatePart(l.deliveryAt) ? String(l.deliveryAt).slice(0, 10) + 'T09:00:00' : String(l.createdAt || '').slice(0, 10) + 'T09:00:00');
        if (!validDatePart(l.deliveryAt)) upd.deliveryAt = (rc && validDatePart(rc.deliveryDate)) ? rc.deliveryDate + 'T17:00:00' : String(upd.pickupAt || l.pickupAt).slice(0, 10) + 'T17:00:00';
      }
      const keys = Object.keys(upd);
      if (keys.length) db.prepare(`UPDATE loads SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map((k) => upd[k]), l.id);
    }
  } catch (e) { console.error('repairImportedLoadData', e); }
}
function extractRcDates(text) {
  const out = [];
  const push = (v) => { if (v && !out.includes(v)) out.push(v); };
  const re = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g;
  let m;
  while ((m = re.exec(text))) push(rcNormDate(m[3], m[1], m[2]));
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const re2 = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/gi;
  while ((m = re2.exec(text))) push(rcNormDate(m[3], months[m[1].slice(0, 3).toLowerCase()], m[2]));
  return out;
}
// Words that are never a city — instruction/label text the place
// scanner must not mistake for a pickup or delivery city.
const JUNK_CITIES = new Set(['REMOVE', 'DELETE', 'VOID', 'TOTAL', 'AMOUNT', 'INVOICE', 'PAGE', 'COPY', 'ORIGINAL']);
const US_STATE_CODES = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY']);
const US_STATE_NAMES = { ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC' };
// ZIP-prefix rescue: OCR (and the odd broker typo) can garble the
// two-letter state code ("KY" read as "XY"). The ZIP code's first
// three digits still pin the state, so when the state token is not a
// valid code but the ZIP prefix maps to exactly one state, trust the
// ZIP. A valid state token always wins over the ZIP.
const ZIP3_RANGES = [[5, 5, 'NY'], [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'], [50, 59, 'VT'], [60, 69, 'CT'], [70, 89, 'NJ'], [100, 149, 'NY'], [150, 196, 'PA'], [197, 199, 'DE'], [200, 205, 'DC'], [206, 219, 'MD'], [220, 246, 'VA'], [247, 268, 'WV'], [270, 289, 'NC'], [290, 299, 'SC'], [300, 319, 'GA'], [320, 349, 'FL'], [350, 369, 'AL'], [370, 385, 'TN'], [386, 399, 'MS'], [400, 427, 'KY'], [430, 459, 'OH'], [460, 479, 'IN'], [480, 499, 'MI'], [500, 528, 'IA'], [530, 549, 'WI'], [550, 567, 'MN'], [570, 577, 'SD'], [580, 588, 'ND'], [590, 599, 'MT'], [600, 629, 'IL'], [630, 658, 'MO'], [660, 679, 'KS'], [680, 693, 'NE'], [700, 714, 'LA'], [716, 729, 'AR'], [730, 749, 'OK'], [750, 799, 'TX'], [800, 816, 'CO'], [820, 831, 'WY'], [832, 838, 'ID'], [840, 847, 'UT'], [850, 865, 'AZ'], [870, 884, 'NM'], [890, 898, 'NV'], [900, 961, 'CA'], [967, 968, 'HI'], [970, 979, 'OR'], [980, 994, 'WA'], [995, 999, 'AK']];
function stateFromZip3(z3) {
  const n = Number(z3);
  for (const [a, b, st] of ZIP3_RANGES) if (n >= a && n <= b) return st;
  return null;
}

function scanRcPlaces(t, base) {
  // Every "City, ST (ZIP)" form in one text, in document order.
  // Brokers write addresses many ways: "City, ST 12345", "City, ST"
  // with no ZIP, and "City, Full State Name".
  const found = [];
  const add = (city, state, zip, idx) => {
    const c = cleanCityName(city);
    if (!c || !US_STATE_CODES.has(state)) return;
    if (JUNK_CITIES.has(c.toUpperCase())) return;
    if (!found.some((p) => p.city === c && p.state === state)) found.push({ city: c, state, zip: zip || '', idx });
  };
  if (!t) return found;
  let m;
  const nameAlt = Object.keys(US_STATE_NAMES).join('|');
  const reZip = /([A-Z][A-Za-z .'-]{1,30}),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?/g;
  while ((m = reZip.exec(t))) add(m[1], m[2], m[3], base + m.index);
  // No-comma addresses ("Keasbey NJ 08832" — RTC/Power9 writes city
  // and state separated by a space only, and the reader missed the
  // stops entirely, owner report 2026-11-17). Guarded harder than
  // the comma forms: the ZIP prefix must agree with the state code,
  // and a leading single-letter token (a street direction, the "E"
  // in "601 Highway 52 E") is dropped before the city is cleaned.
  const reNoComma = /([A-Z][A-Za-z .'-]{1,30})\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?/g;
  while ((m = reNoComma.exec(t))) {
    if (stateFromZip3(m[3].slice(0, 3)) !== m[2]) continue;
    let city = m[1];
    const toks = city.split(/\s+/);
    if (toks.length > 1 && toks[0].length === 1) city = toks.slice(1).join(' ');
    add(city, m[2], m[3], base + m.index);
  }
  const reZipBad = /([A-Z][A-Za-z .'-]{1,30}),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?/g;
  while ((m = reZipBad.exec(t))) {
    if (US_STATE_CODES.has(m[2])) continue;
    const st = stateFromZip3(m[3].slice(0, 3));
    if (st) add(m[1], st, m[3], base + m.index);
  }
  const reNameZip = new RegExp('([A-Z][A-Za-z .\'-]{1,30}),\\s*(' + nameAlt + ')\\s+(\\d{5})', 'gi');
  while ((m = reNameZip.exec(t))) add(m[1], US_STATE_NAMES[m[2].toUpperCase()], m[3], base + m.index);
  const reName = new RegExp('([A-Z][A-Za-z .\'-]{1,30}),\\s*(' + nameAlt + ')\\b', 'gi');
  while ((m = reName.exec(t))) add(m[1], US_STATE_NAMES[m[2].toUpperCase()], '', base + m.index);
  const reNoZip = /([A-Z][A-Za-z .'-]{1,30}),\s*([A-Z]{2})\b(?!\s*\d)/g;
  while ((m = reNoZip.exec(t))) add(m[1], m[2], '', base + m.index);
  found.sort((a, b) => a.idx - b.idx);
  return found;
}

const RC_PICKUP_LABEL = /\b(PICK[\s-]?UP|ORIGIN|SHIPPER|SHIP[\s-]?FROM|LOAD(?:ING)?\s+(?:AT|FROM))\b/gi;
const RC_DELIVERY_LABEL = /\b(DELIVER(?:Y|ING)?|DESTINATION|CONSIGNEE|RECEIVER|RECEIVING|UNLOAD(?:ING)?|DROP[\s-]?OFF)\b/gi;

function extractRcRouteAnchored(text) {
  // The route lives in the document's pickup and delivery sections.
  // Letterhead, broker-HQ and carrier addresses appear earlier in the
  // text, so a plain first-two-addresses read keeps landing on those
  // (owner, 2026-11-16: "pickup and delivery states are wrong — open
  // the rc and verify the states"). Anchor on the section labels:
  // first address after a pickup label (and before the delivery
  // label), first address after the delivery label.
  if (!text) return null;
  const flat = String(text).replace(/\s+/g, ' ');
  const places = scanRcPlaces(flat, 0);
  if (places.length < 2) return null;
  const anchors = (re) => { const out = []; let m; re.lastIndex = 0; while ((m = re.exec(flat))) out.push(m.index); return out; };
  const pus = anchors(RC_PICKUP_LABEL);
  const dls = anchors(RC_DELIVERY_LABEL);
  for (const p of pus) {
    for (const d of dls) {
      if (d <= p) continue;
      const pu = places.find((x) => x.idx > p && x.idx < d);
      const dl = places.find((x) => x.idx > d && x.idx < d + 1500);
      if (pu && dl) return [pu, dl].map(({ city, state, zip }) => ({ city, state, zip }));
    }
  }
  // Side-by-side stop blocks (RTC style): both section labels sit on
  // one header line, before both addresses, so the window above
  // finds no pickup. Take the first address after the pickup label,
  // then the first address after it that also follows the delivery
  // label.
  for (const p of pus) {
    const pu = places.find((x) => x.idx > p);
    if (!pu) continue;
    for (const d of dls) {
      if (d <= p) continue;
      const dl = places.find((x) => x.idx > Math.max(d, pu.idx));
      if (dl) return [pu, dl].map(({ city, state, zip }) => ({ city, state, zip }));
    }
  }
  return null;
}

function extractRcPlaces(text, subject) {
  // Anchored route first (the pickup/delivery sections); if the
  // document has no usable section labels, fall back to every address
  // in document order, then the email subject (brokers often put the
  // route there).
  const anchored = extractRcRouteAnchored(text || '');
  if (anchored) return anchored;
  let found = scanRcPlaces(text || '', 0);
  if (found.length < 2) found = found.concat(scanRcPlaces(subject || '', 1000000000));
  found.sort((a, b) => a.idx - b.idx);
  const seen = new Set();
  return found
    .filter((p) => { const k = p.city + '|' + p.state; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(({ city, state, zip }) => ({ city, state, zip }));
}
function extractRcLoadFields(text, subject) {
  const all = `${subject || ''}\n${text || ''}`;
  const lxl = all.match(/LXL[-\s]?(\d{4,})/i);
  // Take the first labeled capture that contains a digit — column
  // headers can put a plain word after a label (the RXO sheet's
  // "Order #" column is followed by "Total Weight", and the reader
  // filed the load as "TOTAL").
  let loadRef = null;
  for (const m of all.matchAll(/(?:load|order|reference|ref|pro|shipment|trip|booking)\s*(?:#|no\.?|number|id)?\s*[:#]\s*(?:\d{1,3}\s+)?([A-Z0-9][A-Z0-9-]{3,20})/gi)) {
    if (/\d/.test(m[1])) { loadRef = m[1].toUpperCase(); break; }
  }
  if (!loadRef && subject) {
    const sm = subject.match(/(?:load|invoice|po|ref(?:erence)?)\s*#?\s*(\d{5,10}(?:-\d{1,3})?)/i)
      || subject.match(/(\d{5,10}(?:-\d{1,3})?)\s*$/)
      || (/confirmation/i.test(subject) ? subject.match(/\b(\d{6,10}(?:-\d{1,3})?)\b/) : null);
    if (sm) loadRef = sm[1].toUpperCase();
  }
  const truck = all.match(/(?:truck|tractor)\s*(?:#|no\.?|number|unit)?\s*[:#]?\s*(\d{3,5})\b/i);
  const trailer = all.match(/trailer\s*(?:#|no\.?|number|unit)?\s*[:#]?\s*(\d{3,5})\b/i);
  return {
    lxlRef: lxl ? 'LXL-' + lxl[1] : null,
    loadRef,
    truckNo: truck ? truck[1] : null,
    trailerNo: trailer ? trailer[1] : null,
    driverHint: /\bakash/i.test(all) ? 'akash' : /\barsh/i.test(all) ? 'arsh' : null,
    places: extractRcPlaces(text || '', subject || ''),
    dates: extractRcDates(text || ''),
  };
}
function resolveImportedDriverId(f) {
  if (f.driverHint) {
    const d = db.prepare("SELECT id FROM users WHERE role = 'driver' AND active = 1 AND LOWER(name) LIKE ?")
      .get('%' + f.driverHint + '%');
    if (d) return d.id;
  }
  if (f.truckNo) {
    const t = db.prepare('SELECT driverId FROM trucks WHERE unitNumber = ?').get(f.truckNo);
    if (t && t.driverId) return t.driverId;
  }
  if (f.trailerNo) {
    const t = db.prepare('SELECT driverId FROM trailers WHERE unitNumber = ?').get(f.trailerNo);
    if (t && t.driverId) return t.driverId;
  }
  return null;
}

function extractScheduleRefs(text) {
  // OTR "Schedule of Accounts" PDFs list each paid load by its invoice /
  // load number — the same number the broker puts on the rate
  // confirmation. Collect those numbers; ignore money (decimals,
  // $-prefixed), date fragments, and our own MC number.
  const refs = new Set();
  const t = text || '';
  for (const m of t.matchAll(/\b\d{6,10}(?:-\d{1,3})?\b/g)) {
    const tok = m[0];
    const before = t.slice(Math.max(0, m.index - 4), m.index);
    if (/MC-?\s*$/.test(before)) continue;
    if (/\$\s*$/.test(before)) continue;
    const after = t.slice(m.index + tok.length, m.index + tok.length + 3);
    if (/^\.\d/.test(after) || /^\//.test(after)) continue;
    refs.add(tok.toUpperCase());
    const stripped = tok.replace(/^0+/, '');
    if (stripped) refs.add(stripped.toUpperCase());
  }
  return refs;
}

function refKey(ref) {
  if (!ref) return null;
  return String(ref).toUpperCase().trim().replace(/^0+(?=\d)/, '');
}

// Bulk-import runs live in memory (single-instance server). Phase 1
// reads every OTR schedule in every connected mailbox and builds the
// set of PAID load numbers; phase 2 imports only the rate
// confirmations whose load number is in that set. A cancelled load is
// never on a schedule, so its rate confirmation is held out.
// Import runs live in SQLite: a full mailbox scan can take far longer
// than any in-memory TTL, and a server restart must not lose the paid
// list or restart the scan from zero.
function saveRcImportRun(run) {
  db.prepare('INSERT OR REPLACE INTO rc_import_runs (id, startedAt, paidRefs, scheduleHashes, examined, schedules, mailboxErrors, mailboxes, cursor, epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(run.id, run.startedAt, JSON.stringify([...run.paidRefs]), JSON.stringify([...run.scheduleHashes]), JSON.stringify([...run.examined]), run.schedules, JSON.stringify(run.mailboxErrors), JSON.stringify(run.mailboxes), run.cursorJson || null, run.epoch || RC_IMPORT_EPOCH);
}
const RC_IMPORT_EPOCH = 'ocr1-2026-11-16';
function rcImportRun(runId) {
  if (!runId) {
    const latest = db.prepare('SELECT id FROM rc_import_runs ORDER BY startedAt DESC LIMIT 1').get();
    if (latest) runId = latest.id;
  }
  if (runId) {
    const row = db.prepare('SELECT * FROM rc_import_runs WHERE id = ?').get(runId);
    if (row && row.epoch !== RC_IMPORT_EPOCH) db.prepare('DELETE FROM rc_import_runs WHERE id = ?').run(runId);
    else if (row) {
      return {
        id: row.id, startedAt: row.startedAt,
        paidRefs: new Set(JSON.parse(row.paidRefs || '[]')),
        scheduleHashes: new Set(JSON.parse(row.scheduleHashes || '[]')),
        examined: new Set(JSON.parse(row.examined || '[]')),
        schedules: row.schedules || 0,
        mailboxes: JSON.parse(row.mailboxes || '[]'),
        mailboxErrors: JSON.parse(row.mailboxErrors || '[]'),
        savedCursor: row.cursor ? JSON.parse(row.cursor) : null,
        epoch: row.epoch || null,
      };
    }
  }
  const run = {
    id: crypto.randomBytes(8).toString('hex'),
    startedAt: Date.now(),
    paidRefs: new Set(),
    scheduleHashes: new Set(),
    examined: new Set(),
    schedules: 0,
    mailboxes: db.prepare('SELECT id, name, outlookEmail FROM users WHERE outlookRefreshToken IS NOT NULL ORDER BY isMainAdmin DESC, id ASC').all(),
    mailboxErrors: [],
  };
  run.epoch = RC_IMPORT_EPOCH;
  saveRcImportRun(run);
  return run;
}

admin.post('/rate-confirmations/import-all', async (req, res) => {
  try {
    const body = req.body || {};
    let state = null;
    if (body.cursor) {
      try { state = JSON.parse(Buffer.from(String(body.cursor), 'base64url').toString('utf8')); } catch { state = null; }
    }
    if (!state || typeof state !== 'object' || !state.phase) state = { runId: null, phase: 'sched', m: 0, link: null };
    const run = rcImportRun(state.runId);
    if (!body.cursor && run.savedCursor && run.savedCursor.phase) state = { ...run.savedCursor, runId: run.id };
    state.runId = run.id;
    const counts = { imported: 0, loadsCreated: 0, alreadyHave: 0, notRc: 0, skipped: 0, heldOut: 0, skippedSubjects: [], heldOutSubjects: [], bolsAdded: 0, bolsDuplicate: 0, bolsUnmatched: 0, bolsUnmatchedSubjects: [] };
    const deadline = Date.now() + 40000;
    let processed = 0;
    const finish = (done) => {
      const nextCursor = done ? null : Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
      if (done) db.prepare('DELETE FROM rc_import_runs WHERE id = ?').run(run.id);
      else { run.cursorJson = JSON.stringify(state); saveRcImportRun(run); }
      res.json({
        ...counts,
        phase: state.phase,
        mailboxes: run.mailboxes.map((u) => u.outlookEmail || u.name),
        mailboxErrors: run.mailboxErrors,
        schedules: run.schedules,
        schedulesSeen: run.schedulesSeen || 0,
        lastSkip: run.lastSkip || '',
        paidLoads: run.paidRefs.size,
        nextCursor,
        done,
      });
    };
    while (Date.now() < deadline) {
      if (state.m >= run.mailboxes.length) {
        if (state.phase === 'sched') { state.phase = 'rc'; state.m = 0; state.link = null; continue; }
        if (state.phase === 'rc') { state.phase = 'bol'; state.m = 0; state.link = null; continue; }
        return finish(true);
      }
      const mbUser = getUserById(run.mailboxes[state.m].id);
      let accessToken;
      try {
        accessToken = await outlookAccessToken(mbUser);
      } catch {
        const label = mbUser.outlookEmail || mbUser.name;
        if (!run.mailboxErrors.includes(label)) run.mailboxErrors.push(label);
        state.m += 1; state.link = null; continue;
      }
      const pageUrl = state.link || (state.phase === 'bol'
        ? '/me/mailFolders/sentitems/messages?$top=50&$orderby=sentDateTime%20desc&$select=id,subject,sentDateTime,hasAttachments'
        : '/me/messages?$top=50&$orderby=receivedDateTime%20desc&$select=id,subject,from,receivedDateTime,hasAttachments');
      const page = await outlookGraph(accessToken, pageUrl);
      const messages = page.value || [];
      let budgetHit = false;
      for (const m of messages) {
        if (Date.now() >= deadline || processed >= 10) { budgetHit = true; break; }
        const subject = m.subject || '';
        const exKey = state.phase + ':' + state.m + ':' + m.id;
        if (state.phase === 'bol') {
          if (!m.hasAttachments) continue;
          if (run.examined.has(exKey)) continue;
          let attsCache = null;
          if (!/bol|bill of lading|proof of delivery|\bpod\b/i.test(subject)) {
            try {
              const peek = await outlookGraph(accessToken, `/me/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size`);
              attsCache = peek.value || [];
            } catch { continue; }
            if (!attsCache.some((a) => /bol|pod|lading/i.test(a.name || ''))) continue;
          }
          run.examined.add(exKey);
          processed += 1;
          try {
            const atts = attsCache ? { value: attsCache } : await outlookGraph(accessToken, `/me/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size`);
            const files = (atts.value || []).filter((a) => a.id && ((a.contentType || '').includes('pdf') || /\.pdf$/i.test(a.name || '') || (a.contentType || '').startsWith('image/')) && (a.size || 0) < 12000000);
            if (!files.length) continue;
            const namesText = files.map((a) => a.name || '').join(' ');
            const f = extractRcLoadFields(namesText, subject);
            let ref = f.loadRef || f.lxlRef;
            if (!ref) {
              const bare = (subject + ' ' + namesText).match(/\b(\d{6,10}(?:-\d{1,3})?)\b/);
              if (bare) ref = bare[1].toUpperCase();
            }
            let load = null;
            if (f.lxlRef) load = db.prepare('SELECT * FROM loads WHERE reference = ?').get(f.lxlRef);
            if (!load && ref) load = db.prepare('SELECT * FROM loads WHERE reference = ?').get(lxlLoadRef(ref));
            if (!load && ref) load = db.prepare('SELECT * FROM loads WHERE reference = ?').get(ref);
            if (!load) {
              counts.bolsUnmatched += 1;
              if (counts.bolsUnmatchedSubjects.length < 10) counts.bolsUnmatchedSubjects.push(subject);
              continue;
            }
            for (const att of files) {
              const { fileBuffer } = await outlookAttachmentBuffer(mbUser, m.id, att.id);
              if (!fileBuffer || !fileBuffer.length) continue;
              const h = crypto.createHash('sha256').update(fileBuffer).digest('hex');
              const dup = db.prepare('SELECT d.id FROM documents d JOIN files fl ON fl.id = d.fileId WHERE d.loadId = ? AND fl.fileHash = ?').get(load.id, h);
              if (dup) { counts.bolsDuplicate += 1; continue; }
              const kind = /deliver|proof|\bpod\b|signed|receipt/i.test(subject + ' ' + (att.name || '')) ? 'delivery_bol' : 'pickup_bol';
              const ext = path.extname(att.name || '') || '.pdf';
              const stored = crypto.randomBytes(16).toString('hex') + ext;
              fs.writeFileSync(path.join(UPLOADS_DIR, stored), fileBuffer);
              const fileId = db.prepare('INSERT INTO files (storedFilename, originalFilename, mimeType, ownerType, ownerId, driverId, fileHash, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .run(stored, att.name || stored, att.contentType || 'application/octet-stream', 'document', null, load.driverId, h, now()).lastInsertRowid;
              db.prepare('INSERT INTO documents (kind, loadId, category, label, amountCents, fileId, driverId, createdAt) VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?)')
                .run(kind, load.id, fileId, load.driverId, now());
              counts.bolsAdded += 1;
            }
          } catch (e) {
            counts.skipped += 1;
            if (counts.skippedSubjects.length < 10) counts.skippedSubjects.push(subject + ' (bol error)');
          }
        } else if (state.phase === 'sched') {
          if (!/schedule has posted/i.test(subject) || !m.hasAttachments) continue;
          if (run.examined.has(exKey)) continue;
          run.examined.add(exKey);
          processed += 1;
          run.schedulesSeen = (run.schedulesSeen || 0) + 1;
          try {
            const atts = await outlookGraph(accessToken, `/me/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size`);
            for (const a of (atts.value || [])) {
              if (!a.id || (a.size || 0) >= 12000000 || !((a.contentType || '').includes('pdf') || /\.pdf$/i.test(a.name || ''))) continue;
              const { fileBuffer } = await outlookAttachmentBuffer(mbUser, m.id, a.id);
              if (!fileBuffer || !fileBuffer.length) continue;
              const h = crypto.createHash('sha256').update(fileBuffer).digest('hex');
              if (run.scheduleHashes.has(h)) continue;
              run.scheduleHashes.add(h);
              const text = await extractFileText(fileBuffer).catch(() => '');
              const refs = extractScheduleRefs(text);
              if (refs.size) { run.schedules += 1; for (const r of refs) run.paidRefs.add(r); }
            }
          } catch { /* unreadable schedule — totals only */ }
        } else {
          if (!m.hasAttachments) continue;
          if (run.examined.has(exKey)) continue;
          if (!/rate|confirm|load|tender|booking|signed|agreement|\d{5,}/i.test(subject)) { run.examined.add(exKey); counts.notRc += 1; continue; }
          run.examined.add(exKey);
          if (db.prepare('SELECT id FROM rate_confirmations WHERE outlookMessageId = ?').get(m.id)) { counts.alreadyHave += 1; continue; }
          processed += 1;
          try {
            const atts = await outlookGraph(accessToken, `/me/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size`);
            // PDFs only in the rate-con phase: image attachments on
            // "Rate Confirmation" threads are signed BOLs/PODs, and
            // filing one as a rate con created empty shell rows
            // (2026-11-17). Paperwork images belong to the BOL phase.
            const files = (atts.value || []).filter((a) => a.id && ((a.contentType || '').includes('pdf') || /\.pdf$/i.test(a.name || '')) && (a.size || 0) < 12000000);
            let handled = false;
            for (const att of files) {
              const { fileBuffer } = await outlookAttachmentBuffer(mbUser, m.id, att.id);
              if (!fileBuffer || !fileBuffer.length) continue;
              let text = '';
              try { text = await extractFileText(fileBuffer); } catch { /* unreadable file */ }
              const isRc = /rate\s+confirmation|load\s+confirmation|rate\s+agreement/i.test(text) || /rate\s+confirmation|load\s+confirmation/i.test(subject);
              if (!isRc) continue;
              handled = true;
              const f = extractRcLoadFields(text, subject);
              const key = refKey(f.loadRef) || refKey(f.lxlRef);
              const onSchedule = !!key && run.paidRefs.has(key);
              if (!key) {
                counts.heldOut += 1;
                if (counts.heldOutSubjects.length < 10) counts.heldOutSubjects.push(subject + ' (no load number found)');
                break;
              }
              // Owner's rule (2026-11-16, enforced 2026-11-17): a rate
              // confirmation is imported ONLY if its load number appears
              // on an OTR paid schedule. Before this check the import let
              // off-schedule mail in "on your say-so", which re-created
              // cancelled/fake/dispatch-sheet rows the owner had removed.
              if (!onSchedule && run.paidRefs && run.paidRefs.size > 0) {
                counts.heldOut += 1;
                if (counts.heldOutSubjects.length < 10) counts.heldOutSubjects.push(subject + ' (not on any OTR schedule)');
                break;
              }
              let load = null;
              if (f.lxlRef) load = db.prepare('SELECT * FROM loads WHERE reference = ?').get(f.lxlRef);
              if (!load && f.loadRef) load = db.prepare('SELECT * FROM loads WHERE reference = ?').get(lxlLoadRef(f.loadRef));
              if (!load && f.loadRef) load = db.prepare('SELECT * FROM loads WHERE reference = ?').get(f.loadRef);
              if (!load && (f.lxlRef || f.loadRef) && f.places.length >= 2 && f.dates.length >= 1) {
                const driverId = resolveImportedDriverId(f);
                if (driverId) {
                  const p = f.places[0];
                  const d = f.places[f.places.length - 1];
                  const pDate = f.dates[0];
                  const dDate = f.dates[f.dates.length - 1] || f.dates[0];
                  const id = db.prepare(
                    "INSERT INTO loads (reference, driverId, pickupLocation, pickupAt, pickupTimezone, deliveryLocation, deliveryAt, deliveryTimezone, notes, status, completedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)",
                  ).run(lxlLoadRef(f.lxlRef || f.loadRef), driverId,
                    `${p.city}, ${p.state}${p.zip ? ' ' + p.zip : ''}`, `${pDate}T09:00:00`, 'America/Indiana/Indianapolis',
                    `${d.city}, ${d.state}${d.zip ? ' ' + d.zip : ''}`, `${dDate}T17:00:00`, 'America/Indiana/Indianapolis',
                    'Imported from a rate confirmation email', `${dDate}T17:00:00`, now()).lastInsertRowid;
                  load = db.prepare('SELECT * FROM loads WHERE id = ?').get(id);
                  counts.loadsCreated += 1;
                }
              }
              if (load) {
                if (db.prepare('SELECT id FROM rate_confirmations WHERE loadId = ?').get(load.id)) { counts.alreadyHave += 1; break; }
                const row = await createRateCon({ loadId: load.id, fileBuffer, fileName: att.name || 'rate-confirmation.pdf', mimeType: att.contentType || 'application/pdf', subject });
                if (row.duplicate) counts.alreadyHave += 1;
                else { db.prepare('UPDATE rate_confirmations SET outlookMessageId = ? WHERE id = ?').run(m.id, row.id); counts.imported += 1; if (!onSchedule) counts.unverified = (counts.unverified || 0) + 1; }
              } else if ((f.lxlRef || f.loadRef) && f.places.length >= 2 && f.dates.length >= 1) {
                const p = f.places[0];
                const d = f.places[f.places.length - 1];
                const row = await createRateCon({ reference: f.lxlRef || f.loadRef, pickupState: p.state, deliveryState: d.state, pickupDate: f.dates[0], deliveryDate: f.dates[f.dates.length - 1] || f.dates[0], fileBuffer, fileName: att.name || 'rate-confirmation.pdf', mimeType: att.contentType || 'application/pdf', subject });
                if (row.duplicate) counts.alreadyHave += 1;
                else { db.prepare('UPDATE rate_confirmations SET outlookMessageId = ? WHERE id = ?').run(m.id, row.id); counts.imported += 1; if (!onSchedule) counts.unverified = (counts.unverified || 0) + 1; }
              } else {
                counts.skipped += 1;
                run.lastSkip = subject + ' (text=' + text.length + ' places=' + f.places.length + ' dates=' + f.dates.length + ')';
                if (counts.skippedSubjects.length < 10) counts.skippedSubjects.push(run.lastSkip);
              }
              break;
            }
            if (!handled) counts.notRc += 1;
          } catch (e) {
            counts.skipped += 1;
            run.lastSkip = subject + ' (error: ' + String((e && e.message) || e).slice(0, 90) + ')';
            console.error('rc import skip:', subject, '-', e && e.message);
            if (counts.skippedSubjects.length < 10) counts.skippedSubjects.push(subject + ' (error: ' + String((e && e.message) || e).slice(0, 90) + ')');
          }
        }
      }
      if (budgetHit) return finish(false); // re-fetch this page next call; examined-set + dedupe make it harmless
      state.link = page['@odata.nextLink'] || null;
      if (!state.link) state.m += 1;
    }
    return finish(false);
  } catch (e) {
    if (e.status) return err(res, e.status, e.message);
    console.error('ratecon import-all failed', e);
    return err(res, 500, 'Import failed — try again');
  }
});


// Add-RC auto-load (owner, 2026-11-16): when a dispatcher picks a rate
// confirmation from email (or uploads the file) without choosing a
// load, the system creates the load FROM the rate confirmation —
// LXL- reference from the broker load number, pickup/delivery city +
// state from the RC's pickup/delivery sections, driver from the name
// / truck / trailer on the RC — as an ACTIVE load, and files the RC
// on it. If a load with that reference already exists, the RC simply
// attaches to it.
async function findOrCreateLoadFromRc(fileBuffer, subject) {
  const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const dup = db.prepare('SELECT * FROM rate_confirmations WHERE fileHash = ?').get(fileHash);
  if (dup) return { duplicateRc: dup };
  const text = await extractFileText(fileBuffer);
  const f = extractRcLoadFields(text || '', subject || '');
  const ref = f.lxlRef || (f.loadRef ? lxlLoadRef(f.loadRef) : null);
  if (!ref) throw Object.assign(new Error('No load number could be read from this rate confirmation — pick the load manually.'), { status: 400 });
  let load = db.prepare('SELECT * FROM loads WHERE reference = ?').get(ref);
  if (!load && f.loadRef) load = db.prepare('SELECT * FROM loads WHERE reference = ?').get(f.loadRef);
  if (load) return { load, created: false };
  if (f.places.length < 2 || f.dates.length < 1)
    throw Object.assign(new Error(`Load ${ref} is new, but its pickup/delivery cities or dates could not be read from the rate confirmation — add the load manually, then attach this RC to it.`), { status: 400 });
  const driverId = resolveImportedDriverId(f);
  if (!driverId)
    throw Object.assign(new Error(`Load ${ref} is new, but no driver name or truck/trailer number could be read from the rate confirmation — add the load manually, then attach this RC to it.`), { status: 400 });
  const p = f.places[0];
  const d = f.places[f.places.length - 1];
  const pDate = f.dates[0];
  const dDate = f.dates[f.dates.length - 1] || f.dates[0];
  const id = db.prepare(
    "INSERT INTO loads (reference, driverId, pickupLocation, pickupAt, pickupTimezone, deliveryLocation, deliveryAt, deliveryTimezone, notes, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
  ).run(ref, driverId, `${p.city}, ${p.state}${p.zip ? ' ' + p.zip : ''}`, `${pDate}T09:00:00`, 'America/Indiana/Indianapolis',
    `${d.city}, ${d.state}${d.zip ? ' ' + d.zip : ''}`, `${dDate}T17:00:00`, 'America/Indiana/Indianapolis',
    'Created from a rate confirmation', now()).lastInsertRowid;
  load = db.prepare('SELECT * FROM loads WHERE id = ?').get(id);
  notifyDriver(db, driverId, 'load_assigned', 'New load assigned', `Load ${load.reference}: ${load.pickupLocation} → ${load.deliveryLocation}.`).catch(() => {});
  return { load, created: true };
}

admin.post('/rate-confirmations/from-outlook', async (req, res) => {
  try {
    const { loadId, messageId, attachmentId, subject } = req.body || {};
    if (!messageId || !attachmentId)
      return err(res, 400, 'messageId and attachmentId are required');
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
    let useLoadId = loadId ? Number(loadId) : null;
    let auto = null;
    if (!useLoadId) {
      auto = await findOrCreateLoadFromRc(fileBuffer, subject);
      if (auto.duplicateRc) return res.status(201).json({ ...serializeRateCon(auto.duplicateRc), duplicate: true });
      useLoadId = auto.load.id;
    }
    const rc = await createRateCon({ loadId: useLoadId, fileBuffer, fileName: att.name || 'rate-confirmation.pdf', mimeType: att.contentType || 'application/pdf', subject });
    res.status(201).json(auto ? { ...rc, loadCreated: auto.created, loadReference: auto.load.reference, loadRoute: auto.load.pickupLocation + ' → ' + auto.load.deliveryLocation } : rc);
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
// --- OCR for scanned PDFs ---------------------------------------------------
// Many broker rate cons (most Armstrong ones) are scanned images inside
// a PDF: no text layer at all, so every text-based check reads them as
// empty. Pull the embedded page images out with pdf.js and OCR them
// with the same tesseract setup the photo path uses.
const PNG_CRC_TABLE = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function pngCrc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = PNG_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePngRgba(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
function pdfImageToPng(img) {
  // Downscale while converting: a 300-DPI scan is 2550x3300+, and a
  // full-size RGBA copy plus the OCR engine is what tipped the small
  // server over during the first OCR import (2026-11-16). Tesseract
  // reads 1800px-wide pages just as well, at a fraction of the memory.
  const w = img.width;
  const h = img.height;
  const data = img.data;
  if (!w || !h || !data) return null;
  const MAXW = 1800;
  const tw = Math.min(w, MAXW);
  const th = Math.max(1, Math.round(h * (tw / w)));
  let sample;
  if (data.length === w * h * 4) {
    sample = (x, y) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  } else if (data.length === w * h * 3) {
    sample = (x, y) => { const i = (y * w + x) * 3; return [data[i], data[i + 1], data[i + 2]]; };
  } else if (data.length === w * h) {
    sample = (x, y) => { const v = data[y * w + x]; return [v, v, v]; };
  } else if (data.length === Math.ceil(w / 8) * h) {
    const rowBytes = Math.ceil(w / 8);
    sample = (x, y) => { const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1; const v = bit ? 255 : 0; return [v, v, v]; };
  } else return null;
  const rgba = new Uint8Array(tw * th * 4);
  for (let ty = 0; ty < th; ty++) {
    const sy = Math.min(h - 1, Math.floor((ty * h) / th));
    for (let tx = 0; tx < tw; tx++) {
      const sx = Math.min(w - 1, Math.floor((tx * w) / tw));
      const [r, g, b] = sample(sx, sy);
      const j = (ty * tw + tx) * 4;
      rgba[j] = r;
      rgba[j + 1] = g;
      rgba[j + 2] = b;
      rgba[j + 3] = 255;
    }
  }
  return encodePngRgba(tw, th, rgba);
}
// One OCR at a time, process-wide: tesseract workers are heavy, and
// two import rounds (or an import plus a receipt scan) running OCR
// concurrently is what knocked the portal over with 502s.
let ocrQueue = Promise.resolve();
function ocrPdfImagesQueued(buf) {
  const run = ocrQueue.then(() => ocrPdfImages(buf));
  ocrQueue = run.catch(() => {});
  return run;
}
async function ocrPdfPages(buf) {
  // Rasterize the pages and OCR the renders. Filled forms printed to
  // PDF (e.g. ACORD certificates via Microsoft Print to PDF) keep their
  // values as vector glyphs — no usable text layer and no embedded
  // image — so only a rendered page shows them. The canvas package is
  // an optional pdfjs dependency: if it is absent, skip quietly.
  let canvasMod;
  try { canvasMod = await import('@napi-rs/canvas'); } catch { return ''; }
  if (!globalThis.DOMMatrix && canvasMod.DOMMatrix) globalThis.DOMMatrix = canvasMod.DOMMatrix;
  if (!globalThis.Path2D && canvasMod.Path2D) globalThis.Path2D = canvasMod.Path2D;
  if (!globalThis.ImageData && canvasMod.ImageData) globalThis.ImageData = canvasMod.ImageData;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const worker = await createWorker('eng', undefined, {
    errorHandler: (e) => console.error('page-raster tesseract error', e),
  });
  try {
    let out = '';
    const pages = Math.min(doc.numPages, 3);
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = canvasMod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const { data } = await worker.recognize(canvas.toBuffer('image/png'));
      out += '\n' + (data.text || '');
    }
    return out;
  } finally {
    try { await worker.terminate(); } catch { /* already gone */ }
  }
}
function ocrPdfPagesQueued(buf) {
  const run = ocrQueue.then(() => ocrPdfPages(buf));
  ocrQueue = run.catch(() => {});
  return run;
}
async function getPdfImage(page, name) {
  const grab = (objs) => new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v || null); } };
    try { objs.get(name, finish); } catch { finish(null); }
    const t = setTimeout(() => finish(null), 3000);
    if (t.unref) t.unref();
  });
  return (await grab(page.objs)) || (await grab(page.commonObjs));
}
async function ocrPdfImages(buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const worker = await createWorker('eng', undefined, {
    errorHandler: (e) => console.error('pdf OCR tesseract worker error', e),
  });
  let out = '';
  try {
    const pages = Math.min(doc.numPages, 2);
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const ops = await page.getOperatorList();
      const names = [];
      for (let k = 0; k < ops.fnArray.length; k++) {
        if (ops.fnArray[k] === pdfjs.OPS.paintImageXObject) {
          const nm = ops.argsArray[k][0];
          if (!names.includes(nm)) names.push(nm);
        }
      }
      for (const nm of names) {
        const img = await getPdfImage(page, nm);
        if (!img || img.width < 200 || img.height < 200) continue;
        const png = pdfImageToPng(img);
        if (!png) continue;
        const { data } = await worker.recognize(png);
        if (data && data.text) out += data.text + '\n';
      }
    }
  } finally {
    try { await worker.terminate(); } catch { /* already gone */ }
  }
  return out;
}

async function extractFileText(buf) {
  const isPdf = buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF';
  const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (isPdf) {
    const text = cleanRateText(await pdfTextFromBuffer(buf));
    if (text.length >= 200) return text;
    // Scanned / image-only PDF: no usable text layer. Read the page
    // images with OCR instead — slower, but the document still counts.
    try {
      const ocr = cleanRateText(await ocrPdfImagesQueued(buf));
      if (ocr.length > text.length) return ocr;
    } catch (e) {
      console.error('pdf OCR fallback failed', e);
    }
    return text;
  }
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
  // Dash-separated month names: Indiana cab cards print the validity
  // period as '01-JUN-2026 TO 31-MAY-2027' — the space-only patterns
  // above missed those dates entirely (owner's cards, 2026-11-16).
  const rxMon3 = /\b(\d{1,2})-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*-(\d{4})\b/gi;
  while ((m = rxMon3.exec(text))) push(toIso(+m[3], MONTHS_RX[m[2].slice(0, 3).toLowerCase()], +m[1]), m.index);
  const rxMon4 = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*-(\d{1,2})-(\d{4})\b/gi;
  while ((m = rxMon4.exec(text))) push(toIso(+m[3], MONTHS_RX[m[1].slice(0, 3).toLowerCase()], +m[2]), m.index);
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
  // Permanent documents (e.g. Indiana trailer cab cards) print
  // "VALIDITY PERIOD 12-OCT-2026 TO NO EXPIRY" — the one date is the
  // start of validity, never an expiry.
  if (/no\s+expir\w*/i.test(text)) {
    const uniq0 = [...new Set(dates.map(d => d.iso))].sort();
    return uniq0.length ? { issuedDate: uniq0[0] } : {};
  }  let expiry = dateNearLabel(text, dates, /expir\w*|valid\s+(through|until|thru|to)|exp\.?\s*date|coverage\s+(ends|through|until)/i);
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
async function detectDocDatesFull(buf) {
  // { found, noExpiry } for a document buffer. First pass: the text
  // layer. Second pass (PDFs only, when the first found no dates): OCR
  // the page images — filled-form PDFs such as ACORD insurance
  // certificates keep their values in the image layer, not the text
  // layer, so the text pass sees the blank form and finds nothing.
  let text = '';
  try { text = await extractFileText(buf); } catch { /* keep empty */ }
  let found = detectDocDates(text);
  let noExpiry = /no\s+expir\w*/i.test(text);
  const isPdf = buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF';
  if (!found.issuedDate && !found.expiryDate && isPdf) {
    try {
      const ocrText = cleanRateText(await ocrPdfImagesQueued(buf));
      const ocrFound = detectDocDates(ocrText);
      if (ocrFound.issuedDate || ocrFound.expiryDate) {
        found = ocrFound;
        noExpiry = /no\s+expir\w*/i.test(ocrText);
        console.log('doc dates: OCR pass found dates', found);
      }
    } catch (e) { console.error('doc dates OCR pass failed', e); }
  }
  if (!found.issuedDate && !found.expiryDate && isPdf) {
    try {
      const rasterText = cleanRateText(await ocrPdfPagesQueued(buf));
      const rasterFound = detectDocDates(rasterText);
      if (rasterFound.issuedDate || rasterFound.expiryDate) {
        found = rasterFound;
        noExpiry = /no\s+expir\w*/i.test(rasterText);
        console.log('doc dates: page-raster OCR found dates', found);
      }
    } catch (e) { console.error('doc dates page-raster OCR failed', e); }
  }
  return { found, noExpiry };
}
async function detectDatesForFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const { found } = await detectDocDatesFull(buf);
    console.log('equipment-doc dates', { bytes: buf.length, ...found });
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
// The portal page and its script/style must never be served from a
// device cache: a dispatch tablet that kept an old app.js showed
// pre-fix load cards for hours while the data was already correct
// (owner, 2026-11-17). no-store makes every fresh page load pick up
// the latest deploy.
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html' || req.path === '/app.js' || req.path === '/styles.css') {
    res.set('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/files/')) return err(res, 404, 'Not found');
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) { res.set('Cache-Control', 'no-store'); return res.sendFile(indexPath); }
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
  repairImportedLoadData();
  void (async () => { await verifyRateConStates(); await repairRateConDates(); await cleanupRateCons(); await removeCancelledScotlynnLoad(); await adjudicateRateCons(); await adjudicateRateCons2(); await adjudicateRateCons3(); await adjudicateRateCons4(); await adjudicateRateCons5(); await adjudicateRateCons6(); await adjudicateRateCons7(); await adjudicateRateCons8(); await adjudicateRateCons9(); await fixTruckPaymentCategories(); await setupFixedTruckPayments(); await fixTransportFundingFixed(); await addRtc528772Load(); await mergeRtc528772Loads(); await fixCircle2661800(); await fixRtc528772Rate(); await fixRtc528772DeliveryTime(); await fixLoad1197586Driver(); await removeDispatchSheetLoads(); await fixCashflowReconciliation(); await removeOutlookFactoring2(); await backfillDocDates(); })();
  // Re-derive active loads' gate pins with the current geocoder on
  // boot: a stale pin from a weaker geocode must not block a delivery.
  try { db.prepare("UPDATE loads SET deliveryLat = NULL, deliveryLng = NULL, pickupLat = NULL, pickupLng = NULL WHERE status = 'active'").run(); } catch { /* columns may not exist on first boot */ }
  // Backfill road miles for the Trucks profit section (driver pay =
  // miles x $0.65), shortly after boot so the pin reset above settles.
  setTimeout(() => {
    void (async () => {
      try {
        // One retry per boot for loads whose route failed last time.
        try { db.prepare("UPDATE loads SET miles = NULL WHERE miles = -1").run(); } catch { /* ignore */ }
        const rows = db.prepare("SELECT * FROM loads WHERE miles IS NULL AND status != 'cancelled'").all();
        for (const l of rows) { try { await ensureLoadMiles(l); } catch { /* best effort */ } await new Promise((r) => setTimeout(r, 350)); }
      } catch { /* miles column may not exist yet */ }
    })();
  }, 20000);
});
