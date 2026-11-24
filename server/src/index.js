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
    relayDriverId: u.relay_driver_id ?? null,
    relayStartCode: u.relay_start_code ?? null,
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
  const fmtAt = (at) => {
    const str = String(at);
    // Naive wall-clock times render as-is (parsed as UTC, shown in UTC);
    // legacy UTC instants render in the company-base zone.
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(str)) {
      const d = new Date(str);
      return isNaN(d) ? str : d.toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
    return new Date(str).toLocaleString('en-US', { timeZone: 'America/Indiana/Indianapolis', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const fmt = (kind, s, i) => kind + ' ' + (i + 1) + ': ' + (s.warehouse || s.location) + (s.warehouse ? ' (' + s.location + ')' : '')
    + (s.at ? ' — ' + fmtAt(s.at) : '')
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

// The driver's CURRENT load (owner's rule, 2026-11-19): among the
// driver's unfinished loads (status 'active'), the current load is
// the EARLIEST assigned one. A load assigned later must NOT take
// over Home — or anywhere else that shows "the current load" —
// while an earlier load is still incomplete; the next assigned
// load becomes current only once the previous one is completed
// (or cancelled). Assignment order is the row creation order:
// createdAt, with the AUTOINCREMENT id as the monotonic tiebreak
// for rows created in the same instant.
function currentLoadForDriver(driverId) {
  return db
    .prepare("SELECT * FROM loads WHERE driverId = ? AND status = 'active' ORDER BY createdAt ASC, id ASC LIMIT 1")
    .get(driverId);
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
    // Road miles for the trip (portal fills this in lazily); the app's
    // My Loads ledger needs it for miles + $0.65/mi pay per load.
    miles: l.miles ?? null,
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
  // Owner's rule (2026-11-19): portal notifications also pop up on the
  // admin's phone. Admins can't sign into the app, so mirror the event
  // as a push to any DRIVER account that belongs to an admin — matched
  // by the same phone number or email (in this fleet that is the
  // owner's own driver account). Fire-and-forget; never throws.
  try {
    const targets = db
      .prepare(
        `SELECT DISTINCT d.id AS id FROM users d
         WHERE d.role = 'driver' AND d.active = 1 AND d.pushToken IS NOT NULL
           AND (
             (d.phoneNormalized IS NOT NULL AND d.phoneNormalized IN
               (SELECT phoneNormalized FROM users WHERE role = 'admin' AND phoneNormalized IS NOT NULL))
             OR (d.email IS NOT NULL AND LOWER(d.email) IN
               (SELECT LOWER(email) FROM users WHERE role = 'admin' AND email IS NOT NULL))
           )`,
      )
      .all();
    for (const t of targets) {
      notifyDriver(db, t.id, type, title, body ?? '').catch(() => {});
    }
    if (targets.length) {
      console.log('[notify] admin notification mirrored as push to driver account(s): ' + targets.map((t) => t.id).join(', '));
    }
  } catch (e) {
    console.error('[notify] admin push mirror failed:', e.message);
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
// The mobile app is for DRIVERS ONLY (owner's rule, 2026-11-18): every admin
// account — the main admin, admins and dispatchers, including any admin added
// in the portal later — signs in on the web portal, never in the app. The app
// identifies itself through its native networking stack (iOS CFNetwork /
// Android okhttp, neither of which appears in a browser user-agent) or the
// explicit x-lxl-client: app header the app sends.
function isAppClient(req) {
  if (String(req.headers['x-lxl-client'] || '') === 'app') return true;
  const ua = String(req.headers['user-agent'] || '');
  return /CFNetwork|okhttp/i.test(ua) && !/Mozilla/i.test(ua);
}
const ADMIN_APP_BLOCK_MESSAGE =
  "Admin accounts can't use the app — please use the web portal.";

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return err(res, 401, 'Authentication required');
  const row = db
    .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.userId WHERE s.token = ?')
    .get(m[1]);
  if (!row) return err(res, 401, 'Invalid or expired session');
  if (!row.active) return err(res, 403, 'Account is deactivated');
  // Drivers-only app: an admin session is refused when the request comes
  // from the mobile app (covers admins who signed in before this rule).
  if (row.role === 'admin' && isAppClient(req))
    return err(res, 403, ADMIN_APP_BLOCK_MESSAGE);
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
  // Drivers-only app: admins (any kind, incl. future portal-added admins)
  // are refused app sign-in; the same credentials work on the web portal.
  if (user.role === 'admin' && isAppClient(req))
    return err(res, 403, ADMIN_APP_BLOCK_MESSAGE);
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
  const activeLoad = currentLoadForDriver(req.user.id);
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
  const load = currentLoadForDriver(req.user.id);
  res.json(serializeLoad(load));
});

driver.get('/loads/history', (req, res) => {
  const rows = db
    .prepare("SELECT * FROM loads WHERE driverId = ? AND status != 'active' ORDER BY createdAt DESC")
    .all(req.user.id);
  res.json(rows.map(serializeLoad));
});

// My Loads statement (owner, 2026-11-19): completed loads grouped by
// month, in strict pickup order, with the deadhead legs between loads
// shown and counted in the month miles and pay. The page layout in the
// app is unchanged — this payload carries the same rows plus the
// deadhead entries and the updated totals.
driver.get('/loads/statement', async (req, res) => {
  try {
    res.json(await buildDriverStatement(req.user.id));
  } catch (e) {
    console.error('driver statement failed', e);
    return err(res, 500, 'Could not build the statement');
  }
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
  const hadTrailer = db.prepare('SELECT id FROM trailers WHERE driverId = ?').get(req.user.id);
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
  // Dispatch sees trailer changes in the bell too (owner, 2026-11-19:
  // notifications for everything, both ways).
  if (result.trailer && result.trailer.unitNumber && (!hadTrailer || hadTrailer.id !== Number(trailerId))) {
    notifyAdmins('trailer', `${req.user.name} changed trailer`, `Now on trailer ${result.trailer.unitNumber}`, 'equipment', null);
  }
  res.json(result.trailer);
});

driver.post('/trailers/release', (req, res) => {
  const before = db.prepare('SELECT * FROM trailers WHERE driverId = ?').get(req.user.id);
  db.prepare('UPDATE trailers SET driverId = NULL WHERE driverId = ?').run(req.user.id);
  if (before) {
    notifyAdmins('trailer', `${req.user.name} released a trailer`, `Trailer ${before.unitNumber} is unassigned`, 'equipment', null);
  }
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

const DOC_KINDS = ['pickup_bol', 'delivery_bol', 'fuel_receipt', 'receipt', 'driver_doc', 'unit_picture', 'seal_picture', 'load_picture'];

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
    load_picture: 'a load picture',
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

// ---------------------------------------------------------------------------
// Payroll (owner, 2026-11-19)
// ---------------------------------------------------------------------------
// Two systems that never mix: My Loads is the SYSTEM's math from the
// loads; a payroll trip sheet is the DRIVER's own numbers — what he
// says his miles, fuel and expenses were (the photo auto-read is only
// a starting point, he corrects it before submitting). Dispatch
// answers with a final statement; the driver approves or rejects it
// (a rejection needs his reason); only an approved statement can be
// marked paid, after dispatch actually pays him outside the app.
function serializePayrollTrip(t) {
  if (!t) return null;
  const fileInfo = (fileId) => {
    if (!fileId) return null;
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
    if (!f) return null;
    return { fileId: f.id, filename: f.originalFilename, mimeType: f.mimeType, url: `/files/${f.id}` };
  };
  return {
    id: t.id,
    driverId: t.driverId,
    driverName: getDriverName(t.driverId),
    label: t.label ?? null,
    periodStart: t.periodStart ?? null,
    periodEnd: t.periodEnd ?? null,
    sheet: fileInfo(t.sheetFileId),
    driverNumbers: {
      totalMiles: t.driverMiles ?? null,
      totalFuelCents: t.driverFuelCents ?? null,
      expensesCents: t.driverExpensesCents ?? null,
    },
    statement: fileInfo(t.statementFileId),
    statementNumbers: t.statementFileId
      ? {
          totalMiles: t.stmtMiles ?? null,
          totalFuelCents: t.stmtFuelCents ?? null,
          expensesCents: t.stmtExpensesCents ?? null,
          additionsCents: t.additionsCents ?? null,
          deductionsCents: t.deductionsCents ?? null,
          netPayCents: t.netPayCents ?? null,
        }
      : null,
    status: t.status,
    rejectReason: t.rejectReason ?? null,
    createdAt: t.createdAt,
    statementAt: t.statementAt ?? null,
    decidedAt: t.decidedAt ?? null,
    paidAt: t.paidAt ?? null,
  };
}

// Best-effort read of a trip sheet / statement's headline numbers from
// its text (PDF text layer or OCR, via extractFileText). Whoever
// submits always sees these numbers and can correct them before
// anything is final — a miss just leaves the box blank for typing.
function detectTripSheetNumbers(text) {
  const out = { totalMiles: null, totalFuelCents: null, expensesCents: null };
  if (!text) return out;
  const t = String(text);
  const num = (s) => {
    const n = Number(String(s).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  let m = t.match(/total\s*miles?\s*[:\-]?\s*([\d,]+(?:\.\d+)?)/i);
  if (!m) m = t.match(/([\d,]+(?:\.\d+)?)\s*(?:total\s*)?miles/i);
  if (m) out.totalMiles = num(m[1]);
  const moneyAfter = (rx) => {
    const mm = t.match(rx);
    if (!mm) return null;
    const n = num(mm[1]);
    return n == null ? null : Math.round(n * 100);
  };
  out.totalFuelCents =
    moneyAfter(/total\s*fuel\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i) ??
    moneyAfter(/fuel\s*total\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i) ??
    moneyAfter(/fuel\s*[:\-]\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i);
  out.expensesCents =
    moneyAfter(/total\s*expenses?\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i) ??
    moneyAfter(/expenses?\s*[:\-]\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i);
  return out;
}

async function readTripSheetNumbers(buf) {
  try {
    const text = await extractFileText(buf);
    return detectTripSheetNumbers(text);
  } catch (e) {
    console.error('trip sheet read failed', e);
    return { totalMiles: null, totalFuelCents: null, expensesCents: null };
  }
}

const payrollNum = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Auto-read a sheet photo before it is submitted: the app shows the
// detected miles / fuel / expenses and the driver corrects them.
// Nothing is stored here.
driver.post('/payroll/read-sheet', upload.single('file'), async (req, res) => {
  if (!req.file) return res.json({ totalMiles: null, totalFuelCents: null, expensesCents: null });
  try {
    const buf = fs.readFileSync(req.file.path);
    res.json(await readTripSheetNumbers(buf));
  } catch (e) {
    console.error('read-sheet failed', e);
    res.json({ totalMiles: null, totalFuelCents: null, expensesCents: null });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch { /* already gone */ }
  }
});

// The driver submits his trip sheet: the photo plus HIS numbers.
driver.post('/payroll/trips', upload.single('file'), (req, res) => {
  if (!req.file) return err(res, 400, 'file is required');
  const { label, periodStart, periodEnd, totalMiles, totalFuelCents, expensesCents } = req.body || {};
  const fileId = insertFileRow(req.file, 'payroll_sheet', null, req.user.id);
  const id = db
    .prepare(
      `INSERT INTO payroll_trips (driverId, label, periodStart, periodEnd, sheetFileId, driverMiles, driverFuelCents, driverExpensesCents, status, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`,
    )
    .run(
      req.user.id,
      label ? String(label).slice(0, 120) : null,
      periodStart ?? null,
      periodEnd ?? null,
      fileId,
      payrollNum(totalMiles),
      payrollNum(totalFuelCents),
      payrollNum(expensesCents),
      now(),
    ).lastInsertRowid;
  notifyAdmins('payroll', `${req.user.name} submitted a trip sheet`, label ? String(label) : 'Payroll', 'payroll', req.user.id);
  res.status(201).json(serializePayrollTrip(db.prepare('SELECT * FROM payroll_trips WHERE id = ?').get(id)));
});

driver.get('/payroll/trips', (req, res) => {
  const rows = db.prepare('SELECT * FROM payroll_trips WHERE driverId = ? ORDER BY createdAt DESC, id DESC').all(req.user.id);
  res.json(rows.map(serializePayrollTrip));
});

driver.get('/payroll/trips/:id', (req, res) => {
  const trip = db.prepare('SELECT * FROM payroll_trips WHERE id = ? AND driverId = ?').get(req.params.id, req.user.id);
  if (!trip) return err(res, 404, 'Trip not found');
  res.json(serializePayrollTrip(trip));
});

// The driver approves the admin's final statement on his trip page.
driver.post('/payroll/trips/:id/approve', (req, res) => {
  const trip = db.prepare('SELECT * FROM payroll_trips WHERE id = ? AND driverId = ?').get(req.params.id, req.user.id);
  if (!trip) return err(res, 404, 'Trip not found');
  if (trip.status !== 'statement_uploaded') return err(res, 400, 'There is no statement waiting for your approval');
  db.prepare("UPDATE payroll_trips SET status = 'approved', decidedAt = ? WHERE id = ?").run(now(), trip.id);
  notifyAdmins('payroll', `${req.user.name} approved his statement`, trip.label || 'Payroll', 'payroll', trip.driverId);
  res.json(serializePayrollTrip(db.prepare('SELECT * FROM payroll_trips WHERE id = ?').get(trip.id)));
});

// Rejection requires the driver's reason — dispatch reads it in the
// portal, talks to him, and uploads a corrected statement.
driver.post('/payroll/trips/:id/reject', (req, res) => {
  const { reason } = req.body || {};
  if (!reason || !String(reason).trim()) return err(res, 400, 'Say why you are rejecting the statement');
  const trip = db.prepare('SELECT * FROM payroll_trips WHERE id = ? AND driverId = ?').get(req.params.id, req.user.id);
  if (!trip) return err(res, 404, 'Trip not found');
  if (trip.status !== 'statement_uploaded') return err(res, 400, 'There is no statement waiting for your approval');
  db.prepare("UPDATE payroll_trips SET status = 'rejected', rejectReason = ?, decidedAt = ? WHERE id = ?")
    .run(String(reason).trim().slice(0, 1000), now(), trip.id);
  notifyAdmins('payroll', `${req.user.name} rejected his statement`, String(reason).trim().slice(0, 300), 'payroll', trip.driverId);
  res.json(serializePayrollTrip(db.prepare('SELECT * FROM payroll_trips WHERE id = ?').get(trip.id)));
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
    const load = currentLoadForDriver(req.user.id);
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

// ---------------------------------------------------------------------------
// Relay Payments fuel transactions (owner, 2026-11-18)
// The server polls Relay's TMS Fuel API and stores the transactions in
// relay_transactions for the admin portal and the driver app to read.
// IMPORT ONLY: nothing here posts to Cash Flow — how Relay fuel counts
// in the company books is still the owner's decision (the standing rule
// is that Pilot weekly billing is the only fuel in Cash Flow). The API
// key is read from the RELAY_API_KEY environment variable ONLY — never
// stored in the database, the code, a log line, or any response. When
// the variable is unset the sync is disabled and quietly does nothing.
// ---------------------------------------------------------------------------
const RELAY_API_BASE = 'https://app.relaypayments.com';
const RELAY_SYNC_INTERVAL_MS = 30 * 60 * 1000;

// Relay sends every money/quantity as a string ("613.64", "78.352") —
// parse tolerantly: real numbers pass through, junk becomes null.
function relayMoney(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Number.parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function relayText(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function relayTransactionCount() {
  try {
    return db.prepare('SELECT COUNT(*) AS c FROM relay_transactions').get().c;
  } catch {
    return 0;
  }
}

function serializeRelayTransaction(t) {
  if (!t) return null;
  let items = [];
  try {
    items = t.items ? JSON.parse(t.items) : [];
  } catch {
    items = [];
  }
  return {
    id: t.id,
    transactionId: t.transaction_id,
    createdAt: t.created_at ?? null,
    driverId: t.driver_id ?? null,
    driverIntegrationId: t.driver_integration_id ?? null,
    driverName: t.driver_name ?? null,
    truckNumber: t.truck_number ?? null,
    merchantName: t.merchant_name ?? null,
    locationName: t.location_name ?? null,
    city: t.city ?? null,
    state: t.state ?? null,
    storeNumber: t.store_number ?? null,
    totalPaid: t.total_paid ?? null,
    totalRetail: t.total_retail ?? null,
    totalSaved: t.total_saved ?? null,
    cashAdvance: t.cash_advance ?? null,
    isDirectBill:
      t.is_direct_bill === null || t.is_direct_bill === undefined ? null : !!t.is_direct_bill,
    fuelCodeType: t.fuel_code_type ?? null,
    items,
    importedAt: t.imported_at,
  };
}

let relaySyncRunning = false;

/**
 * One Relay sync pass. Returns { enabled, added, total } (plus an error
 * note on failure). With no RELAY_API_KEY configured this is a no-op.
 * The window is rolling: from the newest stored transaction minus one
 * day (so a late correction still lands) — or the last 7 days on the
 * first run — up to now. Both date params are ALWAYS sent, correctly
 * formatted: Relay silently returns the ENTIRE history when they are
 * missing or malformed. Transactions dedupe on Relay's transaction_id.
 */
async function syncRelayTransactions() {
  const apiKey = process.env.RELAY_API_KEY;
  if (!apiKey) return { enabled: false, added: 0, total: relayTransactionCount() };
  if (relaySyncRunning) return { enabled: true, added: 0, total: relayTransactionCount() };
  relaySyncRunning = true;
  try {
    const latest = db.prepare('SELECT MAX(created_at) AS m FROM relay_transactions').get()?.m;
    const end = new Date();
    let start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (latest) {
      const t = new Date(latest).getTime();
      if (Number.isFinite(t)) start = new Date(t - 24 * 60 * 60 * 1000);
    }
    // The key goes ONLY in the Authorization header, as the raw key
    // (no "Bearer" prefix) — Relay rejects anything else with a 403.
    const url =
      RELAY_API_BASE +
      '/api/fuel/transactions/?dtstart=' +
      encodeURIComponent(start.toISOString()) +
      '&dtend=' +
      encodeURIComponent(end.toISOString());
    const resp = await fetch(url, {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) {
      console.error(`Relay sync: Relay API answered HTTP ${resp.status}`);
      return {
        enabled: true,
        added: 0,
        total: relayTransactionCount(),
        error: `Relay API HTTP ${resp.status}`,
      };
    }
    const list = await resp.json().catch(() => null);
    if (!Array.isArray(list)) {
      console.error('Relay sync: unexpected response shape from Relay API');
      return {
        enabled: true,
        added: 0,
        total: relayTransactionCount(),
        error: 'Unexpected Relay API response',
      };
    }
    const insert = db.prepare(
      `INSERT OR IGNORE INTO relay_transactions
        (transaction_id, created_at, driver_integration_id, driver_id, driver_name, truck_number,
         merchant_name, location_name, city, state, store_number, total_paid, total_retail,
         total_saved, cash_advance, is_direct_bill, fuel_code_type, items, raw, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let added = 0;
    for (const tx of list) {
      try {
        if (!tx || typeof tx !== 'object' || !tx.transaction_id) continue;
        const drv = tx.driver && typeof tx.driver === 'object' ? tx.driver : {};
        const integrationId = relayText(drv.integration_id);
        const driverName = relayText([drv.first_name, drv.last_name].filter(Boolean).join(' '));
        let driverId = null;
        if (integrationId) {
          const u = db
            .prepare("SELECT id FROM users WHERE relay_driver_id = ? AND role = 'driver'")
            .get(integrationId);
          if (u) driverId = u.id;
        }
        const prompts = Array.isArray(tx.prompts) ? tx.prompts : [];
        const truckPrompt = prompts.find(
          (p) => p && typeof p.label === 'string' && p.label.trim().toLowerCase() === 'truck #',
        );
        const merchant = tx.merchant && typeof tx.merchant === 'object' ? tx.merchant : {};
        const loc = tx.location && typeof tx.location === 'object' ? tx.location : {};
        const items = (Array.isArray(tx.fuel_items) ? tx.fuel_items : []).map((fi) => ({
          type: relayText(fi?.fuel_type),
          description: relayText(fi?.fuel_type_description),
          gallons: relayMoney(fi?.volume),
          retailPricePerUnit: relayMoney(fi?.retail_price_per_unit),
          discountedPricePerUnit: relayMoney(fi?.discounted_price_per_unit),
          totalRetailPrice: relayMoney(fi?.total_retail_price),
          totalDiscountedPrice: relayMoney(fi?.total_discounted_price),
          discountAmount: relayMoney(fi?.discount_amount),
        }));
        const r = insert.run(
          String(tx.transaction_id),
          relayText(tx.created_at),
          integrationId,
          driverId,
          driverName,
          truckPrompt ? relayText(truckPrompt.value) : null,
          relayText(merchant.name),
          relayText(loc.name),
          relayText(loc.city),
          relayText(loc.state),
          relayText(loc.fuel_merchant_location_id),
          relayMoney(tx.total_amount_paid),
          relayMoney(tx.total_retail_price),
          relayMoney(tx.total_amount_saved),
          relayMoney(tx.cash_advance),
          tx.is_direct_bill === null || tx.is_direct_bill === undefined
            ? null
            : tx.is_direct_bill
              ? 1
              : 0,
          relayText(tx.fuel_code_type),
          JSON.stringify(items),
          JSON.stringify(tx),
          now(),
        );
        if (r.changes) added += 1;
      } catch {
        // One malformed transaction must never sink the whole sync.
      }
    }
    // Link rows that were imported before a driver's Relay ID was on
    // file (or whose driver was created after the import).
    try {
      db.prepare(
        `UPDATE relay_transactions
            SET driver_id = (SELECT u.id FROM users u
                              WHERE u.relay_driver_id = relay_transactions.driver_integration_id
                                AND u.role = 'driver')
          WHERE driver_id IS NULL AND driver_integration_id IS NOT NULL`,
      ).run();
    } catch {
      // best effort
    }
    if (added) console.log(`Relay sync: imported ${added} new fuel transaction(s)`);
    return { enabled: true, added, total: relayTransactionCount() };
  } catch (e) {
    console.error('Relay sync failed:', e?.message || 'unknown error');
    return { enabled: true, added: 0, total: relayTransactionCount(), error: 'Relay sync failed' };
  } finally {
    relaySyncRunning = false;
  }
}

// The driver's own Relay fuel transactions — only the ones Relay
// reports under his Relay Driver ID. A driver with no Relay ID on file
// simply has none yet.
driver.get('/relay/transactions', (req, res) => {
  const relayId = req.user.relay_driver_id;
  if (!relayId) return res.json([]);
  const rows = db
    .prepare(
      'SELECT * FROM relay_transactions WHERE driver_integration_id = ? ORDER BY created_at DESC, id DESC LIMIT 200',
    )
    .all(String(relayId));
  res.json(rows.map(serializeRelayTransaction));
});

// ---------------------------------------------------------------------------
// Nearby Pilot / Flying J stations for the driver app (build 33, owner,
// 2026-11-18). LXL fuels ONLY at Pilot / Flying J (Relay codes work
// there and nowhere else), so the map shows those stops and no others.
//
// Builds 30–32 looked stations up LIVE from the public OpenStreetMap
// Overpass mirrors at request time. That is not a viable production
// dependency: the mirrors are routinely at capacity (overpass-api.de
// 502s), block datacenter IPs (overpass.openstreetmap.fr answered 403
// "only available to white-listed usages"), or take 30–60 s — while
// the app gives up at ~15 s, so on the owner's phone the Fuel map sat
// on a black "Finding fuel stops near you…" spinner forever.
//
// The endpoint therefore answers from the server's OWN dataset:
// pilot-stations.json, a one-time OpenStreetMap pull of every Pilot /
// Flying J fuel stop in North America ({name, brand, lat, lng}),
// loaded once at boot. The answer is computed in-process — no network
// call in the request path — and returns in well under a second:
// every dataset stop within 100 km of the driver, nearest first.
// Refreshing the dataset is a maintenance task (re-run the pull and
// redeploy), never a runtime dependency.
// ---------------------------------------------------------------------------
const PILOT_STATIONS = (() => {
  try {
    const file = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'pilot-stations.json',
    );
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = (Array.isArray(parsed) ? parsed : []).filter(
      (s) =>
        s &&
        typeof s.lat === 'number' &&
        typeof s.lng === 'number' &&
        typeof s.name === 'string',
    );
    console.log(`Pilot/Flying J dataset loaded: ${list.length} stations`);
    return list;
  } catch (e) {
    console.error(`Pilot/Flying J dataset failed to load: ${e.message}`);
    return [];
  }
})();

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const p1 = (aLat * Math.PI) / 180;
  const p2 = (bLat * Math.PI) / 180;
  const dp = ((bLat - aLat) * Math.PI) / 180;
  const dl = ((bLng - aLng) * Math.PI) / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

driver.get('/fuel-stations', (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    return err(res, 400, 'Numeric lat and lng query parameters are required.');
  }
  const center = { lat, lng };
  const stations = [];
  for (let i = 0; i < PILOT_STATIONS.length; i += 1) {
    const s = PILOT_STATIONS[i];
    const d = haversineKm(lat, lng, s.lat, s.lng);
    if (d > 100) continue;
    stations.push({
      id: `pilot/${i}`,
      name: s.name,
      brand: s.brand ?? null,
      lat: s.lat,
      lng: s.lng,
      isPilot: true,
      distanceKm: Math.round(d * 100) / 100,
    });
  }
  stations.sort((a, b) => a.distanceKm - b.distanceKm);
  return res.json({ center, stations, pilots: stations.length, cached: false });
});

// ---------------------------------------------------------------------------
// One-time Relay fuel codes — "Fuel B" (owner, 2026-11-18): the driver
// taps "Fuel Here" at a Pilot / Flying J inside the LXL app; the
// server asks Relay to issue a one-time fuel code for that driver and
// returns it for display, so the driver never leaves LXL for the
// Relay app or Safari.
//
// VERIFIED CONTRACT (build 33, 2026-11-18 — Relay's official TMS Fuel
// OpenAPI spec, tmsfuel.yaml at docs.relaypayments.com, live-tested
// against Relay STAGING; builds 30–32 guessed a different shape and
// every issuance failed):
//   POST {RELAY_API_BASE}/api/integrations/fuelcodes/
//   Authorization: the raw API key as the ENTIRE header (as the sync).
//   Body: { driver_id: "<dr_…>", type: "fuel",
//           constraint_amount: "700" }   // a STRING, and required
//   driver_id is Relay's EXTERNAL driver id (dr_…), NOT the 16-digit
//   Integration_ID we store in users.relay_driver_id — sending the
//   integration id returns 400 "invalid driver id". The dr_ id is
//   resolved at issuance time from GET /api/integrations/drivers/
//   (entries carry both id and integration_id), cached in memory,
//   with a fallback to the driver.id retained in a stored Relay
//   transaction's raw payload. No location_id is sent — LXL has no
//   Relay location IDs, and omitting it keeps the code valid at any
//   Pilot / Flying J.
//   Response: HTTP 200, the OneTimeCode object at top level; the code
//   is its `code` field. The schema has NO expires_at — the app shows
//   an expiry only when one is provided, so none is returned.
// A driver with no Relay ID on file gets a clear 409 relay_not_linked;
// an unresolvable driver gets 502 relay_driver_unresolved — the
// server NEVER guesses an ID. Relay errors are logged server-side
// with their HTTP status and message (never the key, never an issued
// code) and surfaced honestly to the app. Issuance is audit-logged
// (driver, station, time — the code itself is never stored or
// logged, and the API key never appears anywhere).
// ---------------------------------------------------------------------------
const RELAY_FUEL_CODES_URL = RELAY_API_BASE + '/api/integrations/fuelcodes/';
const RELAY_DRIVERS_URL = RELAY_API_BASE + '/api/integrations/drivers/';
// $700 cap per code — covers a full fill (the owner's largest recent
// fill was ~$614). Sent as a string: the schema requires that type.
const RELAY_FUEL_CODE_CONSTRAINT = '700';

// Shared one-time-code DELETE at Relay (build 34): the driver cancel
// route and the ADMIN cancel route both land here. Relay soft-deletes
// the code; per the spec that is only allowed while the code is in
// `created` status. Returns { ok: true } on Relay's 2xx, otherwise
// { ok: false, status, relayMsg } — or { ok: false, networkError: true,
// error } when Relay could not be reached at all.
async function relayDeleteFuelCode(apiKey, codeId) {
  let resp;
  let data = null;
  try {
    resp = await fetch(RELAY_FUEL_CODES_URL + encodeURIComponent(codeId), {
      method: 'DELETE',
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(20000),
    });
    data = await resp.json().catch(() => null);
  } catch (e) {
    return { ok: false, networkError: true, error: e };
  }
  if (resp.ok) return { ok: true, status: resp.status };
  return {
    ok: false,
    status: resp.status,
    relayMsg:
      relayText(data?.message) || relayText(data?.error) || relayText(data?.detail),
  };
}

// Relay's fuel-code LIST endpoint requires dtstart/dtend; the admin
// "active codes" view asks for TODAY's codes — today at 00:00 in
// America/New_York (fleet time) as RFC3339 with the ET offset.
function relayEtStartOfTodayRfc3339() {
  const at = new Date();
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const part = (t) => dateParts.find((p) => p.type === t)?.value || '';
  const offsetName =
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'longOffset',
    })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value || 'GMT-05:00';
  const offset = offsetName.replace('GMT', '') || '+00:00';
  return `${part('year')}-${part('month')}-${part('day')}T00:00:00${offset}`;
}

// integration_id (16-digit, stored on the user) -> Relay external
// driver id (dr_…). Resolved lazily and cached for the life of the
// process; a miss re-checks Relay rather than trusting a stale map.
const relayDriverIdCache = new Map();

async function resolveRelayDriverId(apiKey, integrationId) {
  const cached = relayDriverIdCache.get(integrationId);
  if (cached) return cached;
  // Primary: Relay's own driver directory.
  try {
    const resp = await fetch(RELAY_DRIVERS_URL, {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(20000),
    });
    if (resp.ok) {
      const list = await resp.json().catch(() => null);
      if (Array.isArray(list)) {
        for (const entry of list) {
          const ext = relayText(entry?.id);
          const integ = relayText(entry?.integration_id);
          if (ext && integ) relayDriverIdCache.set(integ, ext);
        }
        const hit = relayDriverIdCache.get(integrationId);
        if (hit) return hit;
        console.error(
          `Relay fuel code: driver directory answered but has no entry for integration_id ${integrationId}`,
        );
      } else {
        console.error('Relay fuel code: driver directory returned an unexpected shape');
      }
    } else {
      console.error(`Relay fuel code: driver directory answered HTTP ${resp.status}`);
    }
  } catch (e) {
    console.error(`Relay fuel code: driver directory request failed: ${e?.message || 'unknown error'}`);
  }
  // Fallback: the driver's own imported transactions retain Relay's
  // full payload, whose driver object carries the same dr_ id.
  try {
    const row = db
      .prepare(
        'SELECT raw FROM relay_transactions WHERE driver_integration_id = ? AND raw IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(integrationId);
    if (row?.raw) {
      const raw = JSON.parse(row.raw);
      const ext = relayText(raw?.driver?.id);
      if (ext) {
        relayDriverIdCache.set(integrationId, ext);
        return ext;
      }
    }
  } catch (e) {
    console.error(`Relay fuel code: transaction fallback failed: ${e?.message || 'unknown error'}`);
  }
  return null;
}

driver.post('/relay/fuel-code', async (req, res) => {
  const relayId = relayText(req.user.relay_driver_id);
  if (!relayId) {
    return res.status(409).json({
      error: 'relay_not_linked',
      message: "Your Relay account isn't linked yet — dispatch is setting it up.",
    });
  }
  const apiKey = process.env.RELAY_API_KEY;
  if (!apiKey) return err(res, 503, 'Relay is not configured on the server yet.');
  // Recorded in the audit log only — the Relay call itself takes no
  // location (see the contract note above).
  const locationId = relayText(req.body?.fuel_merchant_location_id);
  const driverId = await resolveRelayDriverId(apiKey, relayId);
  if (!driverId) {
    console.error(
      `Relay fuel code: could not resolve a Relay driver id for driver ${req.user.id} (integration_id ${relayId})`,
    );
    return res.status(502).json({
      error: 'relay_driver_unresolved',
      message:
        'Your Relay driver account could not be matched yet. Try again in a moment, or let dispatch know.',
    });
  }
  let data = null;
  let status = 0;
  try {
    const resp = await fetch(RELAY_FUEL_CODES_URL, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        driver_id: driverId,
        type: 'fuel',
        constraint_amount: RELAY_FUEL_CODE_CONSTRAINT,
      }),
      signal: AbortSignal.timeout(30000),
    });
    status = resp.status;
    data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const relayMsg =
        relayText(data?.message) || relayText(data?.error) || relayText(data?.detail);
      console.error(
        `Relay fuel code: Relay API answered HTTP ${status} for driver ${req.user.id}` +
          (relayMsg ? `: ${relayMsg}` : ''),
      );
      return err(
        res,
        502,
        relayMsg
          ? `Relay said: ${relayMsg}`
          : 'Relay could not issue a fuel code right now. Try again in a moment.',
      );
    }
  } catch (e) {
    console.error(
      `Relay fuel code: request to Relay failed for driver ${req.user.id}: ${e?.message || 'unknown error'}`,
    );
    return err(
      res,
      502,
      'Could not reach Relay to issue a fuel code. Check your signal and try again.',
    );
  }
  // The OneTimeCode object is at the top level; the code is `code`.
  const code =
    data && (typeof data.code === 'string' || typeof data.code === 'number')
      ? String(data.code).trim()
      : null;
  if (!code) {
    console.error(
      `Relay fuel code: HTTP ${status} response carried no code for driver ${req.user.id}`,
    );
    return err(res, 502, 'Relay answered but sent no fuel code. Try again in a moment.');
  }
  const reference =
    data && (typeof data.id === 'string' || typeof data.id === 'number')
      ? String(data.id)
      : null;
  try {
    db.prepare(
      'INSERT INTO relay_fuel_code_log (driver_id, driver_integration_id, fuel_merchant_location_id, relay_reference, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(req.user.id, relayId, locationId, reference, now());
  } catch (e) {
    console.error('Relay fuel code: audit log insert failed', e);
  }
  console.log(
    `Relay fuel code issued for driver ${req.user.id}${locationId ? ` at location ${locationId}` : ''}`,
  );
  // Build 34: the app also gets Relay's reference for the code
  // (code_id — the handle the Cancel button deletes by; it is not
  // the code itself) and the driver's Relay START CODE, which the
  // pump asks for BEFORE the fuel code. Relay delivers the start
  // code by SMS only — the API has no field for it — so it is data:
  // the per-driver value dispatch stored from the driver's Relay
  // text wins, then the fleet-wide RELAY_START_CODE env var.
  const startCode =
    relayText(req.user.relay_start_code) ||
    relayText(process.env.RELAY_START_CODE) ||
    null;
  // No expires_at exists in Relay's schema — the app renders an
  // expiry only when one is provided.
  res.json({ code, code_id: reference, start_code: startCode, expiresAt: null });
});

// Cancel a one-time Relay fuel code (build 34, owner): the driver
// issued a code in the app and is not going to use it — the app's
// Cancel button lands here with Relay's code reference (code_id).
// Relay soft-deletes the code (DELETE /api/integrations/fuelcodes/
// {id}); per the spec that is only allowed while the code is in
// `created` status — a code already active at a pump or used cannot
// be cancelled, and Relay's own message is surfaced when it refuses.
// The cancellation is audit-logged (driver, reference, time — never
// the code itself, which the server never stores).
driver.post('/relay/fuel-code/cancel', async (req, res) => {
  const relayId = relayText(req.user.relay_driver_id);
  if (!relayId) {
    return res.status(409).json({
      error: 'relay_not_linked',
      message: "Your Relay account isn't linked yet — dispatch is setting it up.",
    });
  }
  const apiKey = process.env.RELAY_API_KEY;
  if (!apiKey) return err(res, 503, 'Relay is not configured on the server yet.');
  const codeId = relayText(req.body?.code_id);
  if (!codeId || !codeId.startsWith('code_')) {
    return err(res, 400, 'That fuel code reference looks invalid.');
  }
  const result = await relayDeleteFuelCode(apiKey, codeId);
  if (result.networkError) {
    console.error(
      `Relay fuel code cancel: request to Relay failed for driver ${req.user.id}: ${result.error?.message || 'unknown error'}`,
    );
    return err(
      res,
      502,
      'Could not reach Relay to cancel the code. Check your signal and try again.',
    );
  }
  if (!result.ok) {
    console.error(
      `Relay fuel code cancel: Relay API answered HTTP ${result.status} for driver ${req.user.id}` +
        (result.relayMsg ? `: ${result.relayMsg}` : ''),
    );
    return err(
      res,
      502,
      result.relayMsg
        ? `Relay said: ${result.relayMsg}`
        : 'Relay could not cancel that code. It may already be in use at the pump.',
    );
  }
  try {
    db.prepare(
      'INSERT INTO relay_fuel_code_cancellations (driver_id, driver_integration_id, relay_reference, created_at) VALUES (?, ?, ?, ?)',
    ).run(req.user.id, relayId, codeId, now());
  } catch (e) {
    console.error('Relay fuel code cancel: audit log insert failed', e);
  }
  console.log(`Relay fuel code cancelled for driver ${req.user.id} (ref ${codeId})`);
  res.json({ ok: true });
});

// The driver's Relay fuel POLICY assignment (build 34, owner — he
// holds a Pilot policy in Relay and wants it visible in the app, not
// just one-time codes). Verified against Relay's official TMS Fuel
// OpenAPI spec (tmsfuel.yaml, read 2026-11-18):
//   GET /fuel/policies/policy-assignments/{driver_id}
//     -> PolicyAssignmentFuelPolicy {id, policy_id, policy_name,
//        enabled, limits: [{type, mode, amount, unit, frequency,
//        usage, remaining}]}; 404 when the driver has no assignment.
//   The spec's path template carries {driver_id} but declares the
//   parameter "in: query" — both styles are tried. Policies are
//   created/edited ONLY in the Relay portal; this API is view-only,
//   and one-time codes are NOT subject to the policy (Relay's own
//   wording) — this endpoint only SURFACES the real assignment.
// Base-path note: the spec mounts everything under
// /api/integrations, but the live transactions route is
// /api/fuel/transactions/ — both mounts are tried, and which one
// answered (plus the response's keys, never the key) is logged once
// per fetch so the live shape can be verified after deploy.
const relayPolicyCache = new Map(); // userId -> { at, payload }
const RELAY_POLICY_CACHE_MS = 5 * 60 * 1000;

const RELAY_POLICY_LIMIT_LABELS = {
  PolicyLimitTypeDef: 'DEF',
  PolicyLimitTypeReefer: 'Reefer fuel',
  PolicyLimitTypeCash: 'Cash',
  PolicyLimitTypeNonFuel: 'Non-fuel',
  PolicyLimitTypeNonFuelAdditive: 'Additives',
  PolicyLimitTypeNonFuelOil: 'Oil',
  PolicyLimitTypeNonFuelScales: 'Scales',
  PolicyLimitTypeCardGeneral: 'Fuel',
  PolicyLimitTypeCardCATScales: 'CAT scales',
  PolicyLimitTypeGas: 'Gasoline',
  PolicyLimitTypeLumper: 'Lumper',
};

function relayPolicyLimitLabel(rawType) {
  const t = relayText(rawType);
  if (!t) return 'Limit';
  if (RELAY_POLICY_LIMIT_LABELS[t]) return RELAY_POLICY_LIMIT_LABELS[t];
  // Unknown enum value: prettify rather than show the raw token —
  // "PolicyLimitTypeDiesel" -> "Diesel".
  const stripped = t.replace(/^PolicyLimitType/, '');
  const spaced = stripped.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced || t;
}

driver.get('/relay/policy', async (req, res) => {
  const relayId = relayText(req.user.relay_driver_id);
  if (!relayId) {
    return res.status(409).json({
      error: 'relay_not_linked',
      message: "Your Relay account isn't linked yet — dispatch is setting it up.",
    });
  }
  const apiKey = process.env.RELAY_API_KEY;
  if (!apiKey) return err(res, 503, 'Relay is not configured on the server yet.');
  const cached = relayPolicyCache.get(req.user.id);
  if (cached && Date.now() - cached.at < RELAY_POLICY_CACHE_MS) {
    return res.json(cached.payload);
  }
  const driverId = await resolveRelayDriverId(apiKey, relayId);
  if (!driverId) {
    console.error(
      `Relay policy: could not resolve a Relay driver id for driver ${req.user.id} (integration_id ${relayId})`,
    );
    return res.status(502).json({
      error: 'relay_driver_unresolved',
      message:
        'Your Relay driver account could not be matched yet. Try again in a moment, or let dispatch know.',
    });
  }
  const enc = encodeURIComponent(driverId);
  const attempts = [
    `${RELAY_API_BASE}/api/integrations/fuel/policies/policy-assignments/${enc}`,
    `${RELAY_API_BASE}/api/integrations/fuel/policies/policy-assignments/?driver_id=${enc}`,
    `${RELAY_API_BASE}/api/fuel/policies/policy-assignments/${enc}`,
    `${RELAY_API_BASE}/api/fuel/policies/policy-assignments/?driver_id=${enc}`,
  ];
  let lastRelayMsg = null;
  for (const url of attempts) {
    let resp;
    let data = null;
    try {
      resp = await fetch(url, {
        headers: { Authorization: apiKey },
        signal: AbortSignal.timeout(20000),
      });
      data = await resp.json().catch(() => null);
    } catch (e) {
      console.error(
        `Relay policy: request failed for driver ${req.user.id}: ${e?.message || 'unknown error'}`,
      );
      return err(
        res,
        502,
        'Could not reach Relay to read your fuel policy. Try again in a moment.',
      );
    }
    console.log(
      `Relay policy: ${url.replace(RELAY_API_BASE, '')} -> HTTP ${resp.status}, keys: ${
        data && typeof data === 'object' ? Object.keys(data).join(',') : '(none)'
      }`,
    );
    if (resp.ok && data && typeof data === 'object') {
      const limits = (Array.isArray(data.limits) ? data.limits : []).map((l) => ({
        label: relayPolicyLimitLabel(l?.type),
        amount: relayText(l?.amount),
        unit: relayText(l?.unit),
        period: relayText(l?.frequency),
        used: relayText(l?.usage),
        remaining: relayText(l?.remaining),
      }));
      const payload = {
        assigned: true,
        policy_name: relayText(data.policy_name) || relayText(data.name) || null,
        enabled: data.enabled !== false,
        limits,
      };
      relayPolicyCache.set(req.user.id, { at: Date.now(), payload });
      return res.json(payload);
    }
    if (resp.status === 404) {
      // Maybe the wrong mount/style — try the next one. Remember the
      // message: a genuine "assignment not found" 404 is how the
      // loop ends; anything else is reported honestly below.
      lastRelayMsg =
        relayText(data?.message) || relayText(data?.error) || relayText(data?.detail) || lastRelayMsg;
      continue;
    }
    const relayMsg =
      relayText(data?.message) || relayText(data?.error) || relayText(data?.detail);
    console.error(
      `Relay policy: Relay API answered HTTP ${resp.status} for driver ${req.user.id}` +
        (relayMsg ? `: ${relayMsg}` : ''),
    );
    return err(
      res,
      502,
      relayMsg
        ? `Relay said: ${relayMsg}`
        : 'Relay could not read your fuel policy right now. Try again in a moment.',
    );
  }
  // Every style 404'd. Relay's assignment endpoint 404s when the
  // driver has no policy assignment — that is the genuine answer;
  // anything that reads like a routing/unknown-endpoint error is
  // still surfaced in the log above for post-deploy verification.
  console.log(
    `Relay policy: no assignment found for driver ${req.user.id} (Relay: ${lastRelayMsg || '404'})`,
  );
  const payload = { assigned: false };
  relayPolicyCache.set(req.user.id, { at: Date.now(), payload });
  res.json(payload);
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

// One driver's My Loads statement (same payload the driver app gets) —
// system math from his loads, deadhead legs included.
admin.get('/drivers/:id/statement', async (req, res) => {
  const driverUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(req.params.id);
  if (!driverUser) return err(res, 404, 'Driver not found');
  try {
    res.json(await buildDriverStatement(driverUser.id));
  } catch (e) {
    console.error('admin statement failed', e);
    return err(res, 500, 'Could not build the statement');
  }
});

// Driver bank details for payroll (owner, 2026-11-19): where dispatch
// sends his pay. Admin-editable; the full account number is never in
// publicUser — it only travels through the Payroll endpoints.
admin.post('/drivers/:id/bank', (req, res) => {
  const driverUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(req.params.id);
  if (!driverUser) return err(res, 404, 'Driver not found');
  const { bankName, routingNumber, accountNumber } = req.body || {};
  const clean = (v) => (typeof v === 'string' ? v.trim().slice(0, 80) : v == null ? null : null);
  db.prepare('UPDATE users SET bankName = ?, bankRouting = ?, bankAccount = ? WHERE id = ?')
    .run(clean(bankName), clean(routingNumber), clean(accountNumber), driverUser.id);
  const u = db.prepare('SELECT bankName, bankRouting, bankAccount FROM users WHERE id = ?').get(driverUser.id);
  res.json({ driverId: driverUser.id, bankName: u.bankName ?? null, routingNumber: u.bankRouting ?? null, accountNumber: u.bankAccount ?? null });
});

// ---------------------------------------------------------------------------
// Payroll (admin side)
// ---------------------------------------------------------------------------
// Folder-list payload: every driver with his bank details and payroll
// counts. Folders derive from the drivers list itself, so a new driver
// login has a Payroll folder from day one.
admin.get('/payroll/drivers', (_req, res) => {
  const drivers = db.prepare("SELECT * FROM users WHERE role = 'driver' ORDER BY name").all();
  res.json(
    drivers.map((d) => {
      const truck = db.prepare('SELECT * FROM trucks WHERE driverId = ?').get(d.id);
      const trailer = db.prepare('SELECT * FROM trailers WHERE driverId = ?').get(d.id);
      const counts = db
        .prepare(
          `SELECT
             SUM(CASE WHEN status = 'received' THEN 1 ELSE 0 END) AS received,
             SUM(CASE WHEN status = 'statement_uploaded' THEN 1 ELSE 0 END) AS awaitingDriver,
             SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
             SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
             SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paidCount,
             COALESCE(SUM(CASE WHEN status = 'paid' THEN netPayCents ELSE 0 END), 0) AS paidTotalCents,
             COUNT(*) AS trips
           FROM payroll_trips WHERE driverId = ?`,
        )
        .get(d.id);
      const pendingCount = (counts.received || 0) + (counts.awaitingDriver || 0) + (counts.approved || 0) + (counts.rejected || 0);
      return {
        ...publicUser(d),
        truck: serializeTruck(truck),
        trailer: serializeTrailer(trailer),
        bank: { bankName: d.bankName ?? null, routingNumber: d.bankRouting ?? null, accountNumber: d.bankAccount ?? null },
        payroll: {
          trips: counts.trips || 0,
          received: counts.received || 0,
          awaitingDriver: counts.awaitingDriver || 0,
          approved: counts.approved || 0,
          rejected: counts.rejected || 0,
          pendingCount,
          paidCount: counts.paidCount || 0,
          paidTotalCents: counts.paidTotalCents || 0,
        },
      };
    }),
  );
});

admin.get('/payroll/trips', (req, res) => {
  const { driverId } = req.query;
  const rows = driverId
    ? db.prepare('SELECT * FROM payroll_trips WHERE driverId = ? ORDER BY createdAt DESC, id DESC').all(driverId)
    : db.prepare('SELECT * FROM payroll_trips ORDER BY createdAt DESC, id DESC').all();
  res.json(rows.map(serializePayrollTrip));
});

admin.get('/payroll/trips/:id', (req, res) => {
  const trip = db.prepare('SELECT * FROM payroll_trips WHERE id = ?').get(req.params.id);
  if (!trip) return err(res, 404, 'Trip not found');
  res.json(serializePayrollTrip(trip));
});

// Read the staged statement file and hand back the detected numbers
// for the three boxes (miles / fuel / expenses). Nothing is stored —
// the admin checks the file, adjusts the numbers, and only the final
// Upload statement call below saves anything.
admin.post('/payroll/trips/:id/statement-detect', upload.single('file'), async (req, res) => {
  const trip = db.prepare('SELECT * FROM payroll_trips WHERE id = ?').get(req.params.id);
  if (!trip) return err(res, 404, 'Trip not found');
  if (!req.file) return err(res, 400, 'file is required');
  try {
    const buf = fs.readFileSync(req.file.path);
    res.json(await readTripSheetNumbers(buf));
  } catch (e) {
    console.error('statement-detect failed', e);
    res.json({ totalMiles: null, totalFuelCents: null, expensesCents: null });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch { /* already gone */ }
  }
});

// Upload the final statement (PDF or picture) with the admin's
// numbers. Any of the three boxes left blank is filled from the
// file's own detected numbers. Net pay defaults to miles x $0.65 +
// additions - deductions when the admin does not type it. The trip
// goes to the driver for approval with a push.
admin.post('/payroll/trips/:id/statement', upload.single('file'), async (req, res) => {
  const trip = db.prepare('SELECT * FROM payroll_trips WHERE id = ?').get(req.params.id);
  if (!trip) return err(res, 404, 'Trip not found');
  if (trip.status !== 'received' && trip.status !== 'rejected')
    return err(res, 400, 'This trip is not waiting for a statement');
  if (!req.file) return err(res, 400, 'file is required');
  const body = req.body || {};
  let detected = null;
  if (payrollNum(body.totalMiles) == null || payrollNum(body.totalFuelCents) == null || payrollNum(body.expensesCents) == null) {
    try {
      detected = await readTripSheetNumbers(fs.readFileSync(req.file.path));
    } catch { /* detection is best-effort */ }
  }
  const pick = (v, d) => {
    const n = payrollNum(v);
    return n != null ? n : d != null ? d : null;
  };
  const miles = pick(body.totalMiles, detected && detected.totalMiles);
  const fuelCents = pick(body.totalFuelCents, detected && detected.totalFuelCents);
  const expensesCents = pick(body.expensesCents, detected && detected.expensesCents);
  const additionsCents = payrollNum(body.additionsCents);
  const deductionsCents = payrollNum(body.deductionsCents);
  let netPayCents = payrollNum(body.netPayCents);
  if (netPayCents == null && miles != null) {
    netPayCents = Math.round(miles * DRIVER_PAY_PER_MILE_CENTS) + (additionsCents || 0) - (deductionsCents || 0);
  }
  const fileId = insertFileRow(req.file, 'payroll_statement', null, trip.driverId);
  db.prepare(
    `UPDATE payroll_trips SET statementFileId = ?, stmtMiles = ?, stmtFuelCents = ?, stmtExpensesCents = ?,
       additionsCents = ?, deductionsCents = ?, netPayCents = ?, status = 'statement_uploaded', statementAt = ?, decidedAt = NULL
     WHERE id = ?`,
  ).run(fileId, miles, fuelCents, expensesCents, additionsCents, deductionsCents, netPayCents, now(), trip.id);
  notifyDriver(
    db,
    trip.driverId,
    'payroll_statement',
    'Your statement has been uploaded',
    'Please head to the app and view it.',
  ).catch(() => {});
  res.json(serializePayrollTrip(db.prepare('SELECT * FROM payroll_trips WHERE id = ?').get(trip.id)));
});

// Mark paid — only after the driver approved, and only once dispatch
// has actually paid him outside the app.
admin.post('/payroll/trips/:id/mark-paid', (req, res) => {
  const trip = db.prepare('SELECT * FROM payroll_trips WHERE id = ?').get(req.params.id);
  if (!trip) return err(res, 404, 'Trip not found');
  if (trip.status !== 'approved') return err(res, 400, 'The driver has not approved this statement yet');
  db.prepare("UPDATE payroll_trips SET status = 'paid', paidAt = ? WHERE id = ?").run(now(), trip.id);
  notifyDriver(
    db,
    trip.driverId,
    'payroll_paid',
    'You got paid',
    `Your ${trip.label || 'trip'} statement was marked paid.`,
  ).catch(() => {});
  res.json(serializePayrollTrip(db.prepare('SELECT * FROM payroll_trips WHERE id = ?').get(trip.id)));
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

// Set or clear a driver's Relay Driver ID (the TMS Fuel API's
// Integration_ID, a 16-digit number from the Relay portal). Dispatch
// links the driver here so his Relay transactions match him in the app
// and the server can issue him one-time fuel codes. An empty value
// unlinks. Admin only (this whole router is admin-gated).
admin.post('/drivers/:id/relay-id', (req, res) => {
  const driverUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(req.params.id);
  if (!driverUser) return err(res, 404, 'Driver not found');
  const raw = req.body?.relayDriverId;
  const value = raw === null || raw === undefined ? '' : String(raw).trim();
  if (value && !/^[0-9A-Za-z-]{6,32}$/.test(value))
    return err(res, 400, 'That Relay Driver ID looks invalid');
  db.prepare('UPDATE users SET relay_driver_id = ? WHERE id = ?').run(value || null, driverUser.id);
  res.json({ ok: true, relayDriverId: value || null });
});

// Set or clear a driver's Relay START CODE (build 34). Relay texts
// the driver a short numeric start code with each one-time fuel
// code — he enters it at the pump BEFORE the fuel code. The Relay
// API has no field for it, so dispatch stores here the number from
// the driver's own Relay text; the app then shows it as Step 1 in
// the Fuel Here sheet. An empty value clears it (the fleet-wide
// RELAY_START_CODE env var, when set, is the fallback). Admin only.
admin.post('/drivers/:id/relay-start-code', (req, res) => {
  const driverUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(req.params.id);
  if (!driverUser) return err(res, 404, 'Driver not found');
  const raw = req.body?.relayStartCode;
  const value = raw === null || raw === undefined ? '' : String(raw).trim();
  if (value && !/^[0-9]{4,8}$/.test(value))
    return err(res, 400, 'That Relay start code looks invalid — it is the 4–8 digit number from the driver’s Relay text.');
  db.prepare('UPDATE users SET relay_start_code = ? WHERE id = ?').run(value || null, driverUser.id);
  res.json({ ok: true, relayStartCode: value || null });
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

// Edit a truck's descriptive fields only (make / model / year / plate /
// vin) — e.g. typing in a plate or VIN the document reader could not
// pull off a cab card. Unit number, status, driver assignment and
// odometer are managed by their own endpoints and cannot change here.
admin.patch('/trucks/:id', (req, res) => {
  const truck = db.prepare('SELECT * FROM trucks WHERE id = ?').get(req.params.id);
  if (!truck) return err(res, 404, 'Truck not found');
  const body = req.body || {};
  const sets = [];
  const vals = [];
  for (const field of ['make', 'model', 'year', 'plate', 'vin']) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    let value = body[field];
    if (typeof value === 'string') {
      value = value.trim();
      if (field === 'plate' || field === 'vin') value = value.toUpperCase();
      if (value === '') value = null;
    }
    sets.push(field + ' = ?');
    vals.push(value ?? null);
  }
  if (!sets.length) return err(res, 400, 'Nothing to update');
  vals.push(truck.id);
  db.prepare('UPDATE trucks SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
  res.json(serializeTruck(db.prepare('SELECT * FROM trucks WHERE id = ?').get(truck.id)));
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
function truckMonthlyFor(monthParam, entries, advanceRows, deadheadByDriver) {
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
    // Deadhead legs between the month's loads count in the driver's
    // miles and pay too (owner, 2026-11-19) — precomputed by the
    // caller because the routing lookup is async.
    const monthDeadheadMiles = t.driverId && deadheadByDriver ? (deadheadByDriver.get(t.driverId) || 0) : 0;
    const driverPayCents = Math.round((monthLoadMiles + monthDeadheadMiles) * DRIVER_PAY_PER_MILE_CENTS);
    const maintCents = sumCatM(['Maintenance', 'Repairs']);
    const knownM = new Set(['Driver pay', 'Maintenance', 'Repairs']);
    const otherCents = entries.filter((e) => e.direction === 'out' && e.truckId === t.id && inMonth(e) && !knownM.has(e.category) && !e.category.startsWith('Fuel')).reduce((s, e) => s + e.amountCents, 0);
    const costs = fuelCents + driverPayCents + maintCents + otherCents;
    return { truckId: t.id, unitNumber: t.unitNumber, trips, revenueCents, fuelCents, driverPayCents, loadedMiles: monthLoadMiles, deadheadMiles: monthDeadheadMiles, maintCents, otherCents, profitCents: revenueCents - costs, loadsInMonth: loadsInMonth[ti] };
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
  // Deadhead legs (delivery -> next pickup) count in driver miles and
  // pay everywhere Trucks profit is shown (owner, 2026-11-19). The
  // routing lookups are async, so both maps are built once here and
  // handed to the synchronous profit builders below.
  const deadheadMonthMap = await monthDeadheadByDriver(monthParam);
  const deadheadAllTimeMap = await allTimeDeadheadByDriver();
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
    const allDeadheadMiles = t.driverId ? (deadheadAllTimeMap.get(t.driverId) || 0) : 0;
    const driverPayCents = Math.round((allLoadMiles + allDeadheadMiles) * DRIVER_PAY_PER_MILE_CENTS);
    const maintCents = sumCat(['Maintenance', 'Repairs']);
    const known = new Set(['Driver pay', 'Maintenance', 'Repairs']);
    const otherCents = entries.filter((e) => e.direction === 'out' && e.truckId === t.id && !known.has(e.category) && !e.category.startsWith('Fuel')).reduce((s, e) => s + e.amountCents, 0);
    const costs = fuelCents + driverPayCents + maintCents + otherCents;
    return {
      truckId: t.id, unitNumber: t.unitNumber, trips,
      revenueCents, fuelCents, driverPayCents, loadedMiles: allLoadMiles, deadheadMiles: allDeadheadMiles, maintCents, otherCents,
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
  const tm = truckMonthlyFor(monthParam, agg.entries, advanceRows, deadheadMonthMap);
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
admin.get('/cashflow/report.csv', async (req, res) => {
  const section = ['total', 'monthly', 'trucks'].includes(req.query.section) ? req.query.section : 'monthly';
  const monthParam = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  const deadheadMonthMap = await monthDeadheadByDriver(monthParam);
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
    const tm = truckMonthlyFor(monthParam, entries, advanceRows, deadheadMonthMap);
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

// Edit a trailer's descriptive fields only (kind / year / plate / vin) —
// e.g. typing in a plate or VIN the document reader could not pull off
// a cab card. Unit number, status and driver assignment are managed by
// their own endpoints and cannot change here.
admin.patch('/trailers/:id', (req, res) => {
  const trailer = db.prepare('SELECT * FROM trailers WHERE id = ?').get(req.params.id);
  if (!trailer) return err(res, 404, 'Trailer not found');
  const body = req.body || {};
  const sets = [];
  const vals = [];
  for (const field of ['kind', 'year', 'plate', 'vin']) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    let value = body[field];
    if (typeof value === 'string') {
      value = value.trim();
      if (field === 'plate' || field === 'vin') value = value.toUpperCase();
      if (value === '') value = null;
    }
    sets.push(field + ' = ?');
    vals.push(value ?? null);
  }
  if (!sets.length) return err(res, 400, 'Nothing to update');
  vals.push(trailer.id);
  db.prepare('UPDATE trailers SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
  res.json(serializeTrailer(db.prepare('SELECT * FROM trailers WHERE id = ?').get(trailer.id)));
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
  // A dispatch upload to the driver's load notifies him too (owner,
  // 2026-11-19: notifications for everything, both ways).
  if (load && load.driverId) {
    notifyDriver(
      db,
      load.driverId,
      'document',
      'Dispatch added a document',
      `${load.reference} — ${label || kind.replace(/_/g, ' ')}`,
    ).catch(() => {});
  }
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
  // Tell the driver (fire-and-forget): the stored display ref
  // (LXL-<broker number>) + route — the same 'load_assigned' body the
  // Add-RC auto-load path sends.
  notifyDriver(db, driverId, 'load_assigned', 'New load assigned', `Load ${load.reference}: ${load.pickupLocation} → ${load.deliveryLocation}.`).catch(() => {});
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
  const updatedLoad = db.prepare('SELECT * FROM loads WHERE id = ?').get(load.id);
  // The driver hears about status changes dispatch makes (owner,
  // 2026-11-19: every event notifies, both ways).
  if (updatedLoad.driverId && updatedLoad.status !== load.status) {
    const titles = { completed: 'Load completed', active: 'Load reopened', cancelled: 'Load cancelled' };
    notifyDriver(
      db,
      updatedLoad.driverId,
      'load_status',
      titles[updatedLoad.status] || 'Load updated',
      `Load ${updatedLoad.reference}: ${updatedLoad.pickupLocation} → ${updatedLoad.deliveryLocation}.`,
    ).catch(() => {});
  }
  res.json(serializeLoad(updatedLoad));
});

// Edit a load (admin only): fixes typos like the LXL-2038499 pickup
// "Lebno", and reassigns the driver when the form's driver differs
// from the load's — the portal's edit form always sends its driver
// dropdown, which this endpoint used to ignore. A reassignment pushes
// 'New load assigned' to the new driver, exactly like a fresh create.
// Times and reference never change here.
admin.post('/loads/:id/edit', (req, res) => {
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(req.params.id);
  if (!load) return err(res, 404, 'Load not found');
  // Reassignment: only when the body names a different, valid driver.
  // An absent/empty driverId leaves the assignment untouched (loads
  // are never unassigned through edit).
  const requestedDriverId = req.body && req.body.driverId != null && req.body.driverId !== '' ? Number(req.body.driverId) : null;
  const reassignTo = requestedDriverId !== null && Number.isFinite(requestedDriverId) && requestedDriverId !== load.driverId ? requestedDriverId : null;
  if (reassignTo !== null) {
    const newDriver = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(reassignTo);
    if (!newDriver) return err(res, 404, 'Driver not found');
  }
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
  // Date & time edits (owner bug report, 2026-11-19: "I edit the
  // load's times and it keeps putting the old time"). The form sends
  // new pickup/delivery date-times — top-level fields, and inside
  // the stops payload — but this endpoint never wrote those columns,
  // so every time edit was silently dropped and the load kept its
  // original times. Persist them exactly as sent (the form's ISO
  // strings — the same values the create endpoint stores), with a
  // multi-stop payload's first pickup / last delivery winning, and
  // the timezones the form sends riding along.
  const validTs = (v) => (v && Number.isFinite(Date.parse(String(v))) ? String(v) : null);
  const newPickupAt = validTs(stops ? stops.pickups[0].at : (req.body || {}).pickupAt);
  const newDeliveryAt = validTs(stops ? stops.deliveries[stops.deliveries.length - 1].at : (req.body || {}).deliveryAt);
  const newPickupTz = (req.body || {}).pickupTimezone ? String(req.body.pickupTimezone) : null;
  const newDeliveryTz = (req.body || {}).deliveryTimezone ? String(req.body.deliveryTimezone) : null;
  if (newPickupAt || newDeliveryAt || newPickupTz || newDeliveryTz) {
    db.prepare(
      'UPDATE loads SET pickupAt = COALESCE(?, pickupAt), deliveryAt = COALESCE(?, deliveryAt), pickupTimezone = COALESCE(?, pickupTimezone), deliveryTimezone = COALESCE(?, deliveryTimezone) WHERE id = ?',
    ).run(newPickupAt, newDeliveryAt, newPickupTz, newDeliveryTz, load.id);
  }
  if (reassignTo !== null) {
    db.prepare('UPDATE loads SET driverId = ? WHERE id = ?').run(reassignTo, load.id);
  }
  const updated = db.prepare('SELECT * FROM loads WHERE id = ?').get(load.id);
  if (reassignTo !== null) {
    // Tell the new driver (fire-and-forget — never blocks the save).
    notifyDriver(db, reassignTo, 'load_assigned', 'New load assigned', `Load ${updated.reference}: ${updated.pickupLocation} → ${updated.deliveryLocation}.`).catch(() => {});
  } else if (updated.driverId && updated.status === 'active') {
    // Same driver, changed details: he hears about the edit too
    // (owner, 2026-11-19: notifications for everything, both ways).
    notifyDriver(db, updated.driverId, 'load_updated', 'Load updated', `Load ${updated.reference}: ${updated.pickupLocation} → ${updated.deliveryLocation} — check the load for the new details.`).catch(() => {});
  }
  res.json(serializeLoad(updated));
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
    db.prepare('DELETE FROM deadhead_legs WHERE fromLoadId = ? OR toLoadId = ?').run(load.id, load.id);
    db.prepare('DELETE FROM broker_access WHERE loadId = ?').run(load.id);
    db.prepare('UPDATE cash_entries SET loadId = NULL WHERE loadId = ?').run(load.id);
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

// An admin can delete any load document (e.g. a duplicate BOL page that
// was uploaded into the wrong category). Same cleanup as the driver's
// own delete: the file row and the stored file go with it, and if the
// last BOL page for a load is gone, the BOL result no longer stands —
// clear it so the load cannot be completed without a BOL on file.
admin.delete('/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return err(res, 404, 'Document not found');
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
    load = currentLoadForDriver(driver.id);
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
    loadRow = currentLoadForDriver(a.driverId);
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
    const activeLoad = currentLoadForDriver(d.id);
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

// ---------------------------------------------------------------------------
// Deadhead miles + the My Loads statement (owner, 2026-11-19)
// ---------------------------------------------------------------------------
// Road miles between two coordinates: OSRM public routing first,
// straight-line x 1.18 as the fallback — the same recipe ensureLoadMiles
// uses for a load's own miles.
async function roadMilesBetweenCoords(a, b) {
  try {
    const r = await fetch('https://router.project-osrm.org/route/v1/driving/' + a.lng + ',' + a.lat + ';' + b.lng + ',' + b.lat + '?overview=false', { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const j = await r.json();
      const dist = j && j.routes && j.routes[0] && j.routes[0].distance;
      if (Number.isFinite(dist) && dist > 0) return Math.round((dist / 1609.344) * 10) / 10;
    }
  } catch { /* fall through to the straight-line estimate */ }
  const m = distanceMeters(a.lat, a.lng, b.lat, b.lng);
  if (Number.isFinite(m) && m > 0) return Math.round(((m / 1609.344) * 1.18) * 10) / 10;
  return null;
}

// Deadhead miles for one pair: from a load's delivery to the same
// driver's next pickup. Cached in deadhead_legs (miles = -1 when the
// route cannot be resolved, so the pair is not recomputed on every
// request). The two loads' stored coordinates are used when present;
// milesCoords geocodes the city/address otherwise.
async function ensureDeadheadMiles(fromLoad, toLoad) {
  try {
    const cached = db.prepare('SELECT miles FROM deadhead_legs WHERE fromLoadId = ? AND toLoadId = ?').get(fromLoad.id, toLoad.id);
    if (cached) return typeof cached.miles === 'number' && cached.miles > 0 ? cached.miles : null;
  } catch { /* table may not exist yet */ }
  const from = await milesCoords(fromLoad, 'delivery');
  const to = await milesCoords(toLoad, 'pickup');
  let miles = null;
  if (from && to) miles = await roadMilesBetweenCoords(from, to);
  try {
    db.prepare('INSERT OR REPLACE INTO deadhead_legs (fromLoadId, toLoadId, miles, createdAt) VALUES (?, ?, ?, ?)')
      .run(fromLoad.id, toLoad.id, miles != null && miles > 0 ? miles : -1, now());
  } catch { /* cache is best-effort */ }
  return miles != null && miles > 0 ? miles : null;
}

// A driver's loads in strict pickup order (earliest first), optionally
// restricted to one month (by pickup date) and a status set.
function loadsInPickupOrder(driverId, { month = null, statuses = ['completed'] } = {}) {
  const statusList = statuses.map(() => '?').join(',');
  let sql = `SELECT * FROM loads WHERE driverId = ? AND status IN (${statusList})`;
  const args = [driverId, ...statuses];
  if (month) {
    sql += ' AND substr(pickupAt, 1, 7) = ?';
    args.push(month);
  }
  sql += ' ORDER BY pickupAt ASC, id ASC';
  return db.prepare(sql).all(...args);
}

// The deadhead legs between consecutive loads of an ordered list.
// A leg whose route cannot be resolved comes back with miles: null —
// the statement lists it openly instead of hiding it, and totals
// count it as 0.
async function deadheadLegsFor(orderedLoads) {
  const legs = [];
  for (let i = 0; i + 1 < orderedLoads.length; i++) {
    const fromLoad = orderedLoads[i];
    const toLoad = orderedLoads[i + 1];
    const miles = await ensureDeadheadMiles(fromLoad, toLoad);
    legs.push({ fromLoad, toLoad, miles });
  }
  return legs;
}

const sumLegMiles = (legs) => Math.round(legs.reduce((s, l) => s + (l.miles || 0), 0) * 10) / 10;

// Deadhead miles per driver for one month (Trucks profit): legs
// between consecutive non-cancelled loads picked up that month.
async function monthDeadheadByDriver(monthParam) {
  const out = new Map();
  const driverIds = db.prepare("SELECT DISTINCT driverId FROM loads WHERE driverId IS NOT NULL AND status != 'cancelled' AND substr(pickupAt, 1, 7) = ?").all(monthParam).map((r) => r.driverId);
  for (const driverId of driverIds) {
    const loads = loadsInPickupOrder(driverId, { month: monthParam, statuses: ['active', 'completed'] });
    out.set(driverId, sumLegMiles(await deadheadLegsFor(loads)));
  }
  return out;
}

// Deadhead miles per driver across all his non-cancelled loads.
async function allTimeDeadheadByDriver() {
  const out = new Map();
  const driverIds = db.prepare("SELECT DISTINCT driverId FROM loads WHERE driverId IS NOT NULL AND status != 'cancelled'").all().map((r) => r.driverId);
  for (const driverId of driverIds) {
    const loads = loadsInPickupOrder(driverId, { statuses: ['active', 'completed'] });
    out.set(driverId, sumLegMiles(await deadheadLegsFor(loads)));
  }
  return out;
}

// The My Loads statement for one driver: per month, his completed
// loads in strict pickup order (earliest first) with a deadhead entry
// between each delivery and the next pickup. Month miles = loaded +
// deadhead; pay = total miles x $0.65. This is the SYSTEM's math from
// the loads themselves — never the driver's payroll trip sheet (the
// two never mix, owner's rule 2026-11-19).
async function buildDriverStatement(driverId) {
  const initial = db.prepare("SELECT * FROM loads WHERE driverId = ? AND status = 'completed' ORDER BY pickupAt ASC, id ASC").all(driverId);
  for (const l of initial) {
    if (!(typeof l.miles === 'number' && l.miles > 0)) {
      try { await ensureLoadMiles(l); } catch { /* best effort */ }
    }
  }
  const rows = db.prepare("SELECT * FROM loads WHERE driverId = ? AND status = 'completed' ORDER BY pickupAt ASC, id ASC").all(driverId);
  const byMonth = new Map();
  for (const l of rows) {
    const month = String(l.pickupAt || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(l);
  }
  const months = [];
  for (const [month, loads] of byMonth) {
    const legs = await deadheadLegsFor(loads);
    const entries = [];
    let loadedMiles = 0;
    let deadheadMiles = 0;
    loads.forEach((l, i) => {
      const miles = typeof l.miles === 'number' && l.miles > 0 ? l.miles : null;
      if (miles) loadedMiles += miles;
      entries.push({
        type: 'load',
        load: serializeLoad(l),
        miles,
        payCents: miles ? Math.round(miles * DRIVER_PAY_PER_MILE_CENTS) : null,
      });
      const leg = legs[i];
      if (leg) {
        if (leg.miles) deadheadMiles += leg.miles;
        entries.push({
          type: 'deadhead',
          fromLoadId: leg.fromLoad.id,
          toLoadId: leg.toLoad.id,
          fromReference: leg.fromLoad.reference,
          toReference: leg.toLoad.reference,
          fromLocation: leg.fromLoad.deliveryLocation,
          toLocation: leg.toLoad.pickupLocation,
          miles: leg.miles,
          payCents: leg.miles ? Math.round(leg.miles * DRIVER_PAY_PER_MILE_CENTS) : null,
        });
      }
    });
    loadedMiles = Math.round(loadedMiles * 10) / 10;
    deadheadMiles = Math.round(deadheadMiles * 10) / 10;
    const totalMiles = Math.round((loadedMiles + deadheadMiles) * 10) / 10;
    months.push({
      month,
      entries,
      loadsCompleted: loads.length,
      loadedMiles,
      deadheadMiles,
      totalMiles,
      payCents: Math.round(totalMiles * DRIVER_PAY_PER_MILE_CENTS),
    });
  }
  months.sort((a, b) => (a.month < b.month ? 1 : -1));
  return { driverId, months };
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

// --- OTR Factoring (owner, 2026-11-23) ----------------------------------
// One row per load for the portal's OTR Factoring section, rendered
// directly under Rate Confirmations: paperwork readiness (RC / BOL /
// POD on file) plus where the load stands with OTR Solutions.
// The real OTR API send is NOT wired yet — OTR was asked for a Carrier
// Integration access key on 2026-11-23 and it has not been issued, so
// "Submit to OTR" only QUEUES the packet here (status 'queued' + a
// bell notification) and admins move the status by hand until the API
// sync lands. Nothing here ever fakes an external send to OTR.
const FACTORING_STATUSES = ['not_submitted', 'queued', 'submitted', 'purchased', 'paid'];

// "City, ST" out of a stored load location — handles the comma form
// ("1550 Jackson Ferry Rd, Montgomery, AL 36606", "Montgomery, AL")
// and the comma-less form ("Keasbey NJ 08832").
function factoringCityState(location) {
  const raw = String(location || '').trim();
  if (!raw) return { city: null, state: null };
  const stMatch = raw.match(/\b([A-Za-z]{2})\s+\d{5}(?:-\d{4})?\s*$/) || raw.match(/\b([A-Za-z]{2})\s*$/);
  const state = stMatch ? stMatch[1].toUpperCase() : null;
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  let city = null;
  if (parts.length >= 2) {
    city = parts[parts.length - 2].replace(/\s+[A-Za-z]{2}\s+\d{5}.*$/, '').trim() || null;
  } else if (state) {
    city = raw.replace(/\s*[A-Za-z]{2}\s*\d{5}(?:-\d{4})?\s*$/, '').trim() || null;
  }
  return { city, state };
}

// The rate con that belongs to a load: the row linked by loadId,
// falling back to a reference match. A row carrying the actual file
// wins over a file-less row; newest wins ties.
function factoringRateConFor(load) {
  const rows = db
    .prepare('SELECT * FROM rate_confirmations WHERE loadId = ? OR reference = ? ORDER BY id DESC')
    .all(load.id, load.reference);
  if (!rows.length) return null;
  return rows.find((r) => r.loadId === load.id && r.fileId) || rows.find((r) => r.fileId) || rows.find((r) => r.loadId === load.id) || rows[0];
}

function serializeFactoringLoad(l) {
  const rc = factoringRateConFor(l);
  const docs = db
    .prepare(
      "SELECT kind, COUNT(*) AS n FROM documents WHERE loadId = ? AND kind IN ('pickup_bol', 'delivery_bol') GROUP BY kind",
    )
    .all(l.id);
  const pickup = factoringCityState(l.pickupLocation);
  const delivery = factoringCityState(l.deliveryLocation);
  return {
    loadId: l.id,
    reference: l.reference,
    broker: rc ? (rc.broker ?? null) : null,
    pickupCity: pickup.city,
    pickupState: (rc && rc.pickupState) || pickup.state,
    deliveryCity: delivery.city,
    deliveryState: (rc && rc.deliveryState) || delivery.state,
    rateCents: rc ? (rc.rateCents ?? null) : null,
    driverId: l.driverId ?? null,
    driverName: getDriverName(l.driverId),
    loadStatus: l.status,
    // Paperwork on file: the RC document itself, the pickup BOL
    // (documents kind 'pickup_bol' — the "Pickup BOLs" category) and
    // the delivery paperwork / POD (kind 'delivery_bol').
    hasRateCon: !!(rc && rc.fileId),
    hasBol: docs.some((d) => d.kind === 'pickup_bol' && d.n > 0),
    hasPod: docs.some((d) => d.kind === 'delivery_bol' && d.n > 0),
    factoringStatus: FACTORING_STATUSES.includes(l.factoringStatus) ? l.factoringStatus : 'not_submitted',
    submittedAt: l.factoringSubmittedAt ?? null,
    otrReference: l.factoringOtrReference ?? null,
  };
}

admin.get('/factoring', (_req, res) => {
  const loads = db.prepare('SELECT * FROM loads ORDER BY createdAt DESC, id DESC').all();
  res.json(loads.map(serializeFactoringLoad));
});

// Queue a load's packet for OTR. Requires the RC file — without it
// there is nothing to factor. Stamps the queue time and rings the
// admin bell like every other portal event.
admin.post('/factoring/:loadId/submit', (req, res) => {
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(req.params.loadId);
  if (!load) return err(res, 404, 'Load not found');
  const rc = factoringRateConFor(load);
  if (!rc || !rc.fileId)
    return err(res, 400, 'This load has no rate confirmation file yet — add the RC before queueing it for OTR.');
  const ts = now();
  db.prepare("UPDATE loads SET factoringStatus = 'queued', factoringSubmittedAt = ? WHERE id = ?").run(ts, load.id);
  notifyAdmins(
    'factoring',
    `${load.reference} queued for OTR factoring`,
    `${rc.broker || 'Unknown broker'}${rc.rateCents != null ? ' · $' + (rc.rateCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''} — packet ready to send to OTR`,
    'ratecons',
    load.id,
  );
  const updated = db.prepare('SELECT * FROM loads WHERE id = ?').get(load.id);
  res.json(serializeFactoringLoad(updated));
});

// The one place a load's factoring status is written, shared by the
// admin status endpoint and the OTR sync endpoint below so both stamp
// factoringSubmittedAt identically: resetting to not_submitted clears
// the stamp; moving to any other status stamps it if the load was
// never queued/submitted here. An undefined otrReference keeps the
// stored one; any other value is trimmed (max 80 chars) and an empty
// result clears it. Returns the updated load row.
function applyFactoringStatus(load, status, otrReference) {
  const ref =
    otrReference === undefined
      ? (load.factoringOtrReference ?? null)
      : String(otrReference || '').trim().slice(0, 80) || null;
  let submittedAt = load.factoringSubmittedAt ?? null;
  if (status === 'not_submitted') submittedAt = null;
  else if (!submittedAt) submittedAt = now();
  db.prepare('UPDATE loads SET factoringStatus = ?, factoringSubmittedAt = ?, factoringOtrReference = ? WHERE id = ?').run(
    status,
    submittedAt,
    ref,
    load.id,
  );
  return db.prepare('SELECT * FROM loads WHERE id = ?').get(load.id);
}

// Manual status upkeep until the OTR API sync replaces it: set the
// status and (optionally) OTR's reference for the load.
admin.post('/factoring/:loadId/status', (req, res) => {
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(req.params.loadId);
  if (!load) return err(res, 404, 'Load not found');
  const { status, otrReference } = req.body || {};
  if (!FACTORING_STATUSES.includes(status))
    return err(res, 400, 'Status must be one of: ' + FACTORING_STATUSES.join(', '));
  res.json(serializeFactoringLoad(applyFactoringStatus(load, status, otrReference)));
});

// --- OTR factoring sync (owner, 2026-11-23) -------------------------------
// The standing sync job reads OTR's portal in a browser but cannot use
// the admin API (the admin Bearer token lives in the portal page), so
// it writes through this narrow path instead: two routes guarded by a
// shared secret in the "x-otr-sync-secret" header, compared in
// constant time. When OTR_SYNC_SECRET is not set on the server the
// routes answer 503 to everything — the sync stays off until the
// secret is configured. Sync writes deliberately raise NO admin bell:
// the sync runs every few minutes and would spam it.
function otrSyncGuard(req, res, next) {
  const expected = process.env.OTR_SYNC_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'sync not configured' });
  const provided = req.get('x-otr-sync-secret');
  if (!provided) return res.status(401).json({ ok: false });
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false });
  next();
}

app.get('/api/factoring-sync', otrSyncGuard, (_req, res) => {
  const loads = db.prepare('SELECT * FROM loads ORDER BY createdAt DESC, id DESC').all();
  res.json({
    ok: true,
    loads: loads.map((l) => ({
      id: l.id,
      reference: l.reference,
      factoringStatus: FACTORING_STATUSES.includes(l.factoringStatus) ? l.factoringStatus : 'not_submitted',
      factoringSubmittedAt: l.factoringSubmittedAt ?? null,
      factoringOtrReference: l.factoringOtrReference ?? null,
    })),
  });
});

// Body: {"updates":[{"reference":"LXL-1201115","status":"submitted",
// "otrReference":"LXLD-60 · Inv 1201115A"}, ...]}. Each update is
// validated and applied independently — one bad item never fails the
// batch; its result entry says why.
app.post('/api/factoring-sync', otrSyncGuard, (req, res) => {
  const updates = req.body && Array.isArray(req.body.updates) ? req.body.updates : null;
  if (!updates) return res.status(400).json({ ok: false, error: 'updates must be an array' });
  const results = updates.map((u) => {
    const reference = u && typeof u.reference === 'string' && u.reference.trim() ? u.reference : null;
    if (!reference)
      return { reference: u && u.reference !== undefined ? u.reference : null, ok: false, error: 'invalid reference' };
    if (!FACTORING_STATUSES.includes(u.status)) return { reference, ok: false, error: 'invalid status' };
    if (
      u.otrReference !== undefined &&
      u.otrReference !== null &&
      (typeof u.otrReference !== 'string' || u.otrReference.length > 120)
    )
      return { reference, ok: false, error: 'invalid otrReference' };
    const load = db.prepare('SELECT * FROM loads WHERE reference = ?').get(reference);
    if (!load) return { reference, ok: false, error: 'load not found' };
    applyFactoringStatus(load, u.status, u.otrReference === null ? undefined : u.otrReference);
    return { reference, ok: true };
  });
  res.json({ ok: true, results });
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
    // Rehmann-style load table (owner, 2026-11-19): the rate sits in an
    // "Amount" column with no $ sign and no TOTAL label — the flattened
    // row reads "Weight Equipment Amount 1,080 Juice 42,085 V/R
    // 2,950.00". The weight prints without decimals, so the first
    // decimal amount after the header is the rate.
    /WEIGHT\s+EQUIPMENT\s+AMOUNT\s+[\d,]+\s+.{0,60}?([\d,]+\.\d{2})/i,
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
    // Rehmann-style "Amount" column in the load table — see detectRateCents.
    /WEIGHT\s+EQUIPMENT\s+AMOUNT\s+[\d,]+\s+.{0,60}?([\d,]+\.\d{2})/i,
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
    if (!fileBuffer || fileBuffer.length < 4) return {};
    // Open the document itself and read EVERYTHING (owner, 2026-11-23):
    // the full text pipeline — PDF text layer, embedded-image OCR,
    // page-raster OCR, photo OCR — not just the PDF text layer, so
    // scanned and photographed rate confirmations read too. Returns
    // every field the upload/Outlook flows need: amount, broker, load
    // number, pickup and delivery city/state/ZIP, and both dates.
    const text = await extractFileText(fileBuffer);
    if (!text) return {};
    const f = extractRcLoadFields(text, subject || '');
    const places = f.places || [];
    const first = places[0] || null;
    const last = places.length > 1 ? places[places.length - 1] : null;
    return {
      broker: detectBroker(text, subject),
      rateCents: detectRateCents(text),
      reference: f.lxlRef || (f.loadRef ? lxlLoadRef(f.loadRef) : null),
      pickupCity: first ? first.city : null,
      pickupState: first ? first.state : null,
      pickupZip: first ? (first.zip || null) : null,
      deliveryCity: last ? last.city : null,
      deliveryState: last ? last.state : null,
      deliveryZip: last ? (last.zip || null) : null,
      pickupDate: f.dates && f.dates.length ? f.dates[0] : null,
      deliveryDate: f.dates && f.dates.length ? f.dates[f.dates.length - 1] : null,
    };
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

// One-time correction (owner, 2026-11-19): the ATS rate confirmation
// LXL-217990 was parsed reversed at manual upload — stored as NJ -> GA
// with delivery 2026-11-18, but the document itself says pickup
// BOSTIK INC., Conyers, GA on 2026-11-19 and delivery DAVCO SUPPLY,
// Burlington, NJ on 2026-11-20. The linked load is already correct;
// only the RC row (and its file's display name) is fixed here. Runs
// once; the marker row in one_off_jobs keeps later boots from
// redoing it.
async function fixAtsRc217990() {
  try {
    db.prepare('CREATE TABLE IF NOT EXISTS one_off_jobs (name TEXT PRIMARY KEY, doneAt TEXT)').run();
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get('rc-ats-217990-fix-2026-11-19')) return;
    const rows = db.prepare(
      `SELECT r.id, r.reference, r.pickupState, r.deliveryState, r.deliveryDate, r.fileId, f.originalFilename
       FROM rate_confirmations r LEFT JOIN files f ON f.id = r.fileId
       WHERE r.reference = 'LXL-217990' OR r.reference = '217990'`,
    ).all();
    if (!rows.length) {
      console.log('rc ats fix: RC LXL-217990 not found — nothing to correct');
    }
    for (const row of rows) {
      if (row.pickupState === 'GA' && row.deliveryState === 'NJ' && row.deliveryDate === '2026-11-20') {
        console.log(`rc ats fix: RC ${row.id} already correct`);
      } else {
        db.prepare('UPDATE rate_confirmations SET pickupState = ?, deliveryState = ?, deliveryDate = ? WHERE id = ?')
          .run('GA', 'NJ', '2026-11-20', row.id);
        console.log(`rc ats fix: RC ${row.id} set GA->NJ, delivery 2026-11-20`);
      }
      // The stored file's DISPLAY name embeds the wrong route/dates
      // (LXL-217990_NJ-GA_2026-11-19_to_2026-11-18...): fix the display
      // name only — storedFilename and the file on disk never change.
      if (row.fileId && row.originalFilename && row.originalFilename.startsWith('LXL-217990_NJ-GA_2026-11-19_to_2026-11-18')) {
        db.prepare('UPDATE files SET originalFilename = ? WHERE id = ?')
          .run('LXL-217990_GA-NJ_2026-11-19_to_2026-11-20.pdf', row.fileId);
      }
    }
    db.prepare('INSERT OR REPLACE INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run('rc-ats-217990-fix-2026-11-19', now());
  } catch (e) {
    console.error('rc ats fix failed', e);
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

// One-off (owner, 2026-11-17): the driver app shows only city/state for
// LXL-528772 — no street address. Dump the load row and the full RC text
// to the boot log so the exact street addresses can be read off the RC
// document itself and written back onto the load.
async function dumpRc528772() {
  try {
    const marker = 'dump-rc-528772-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const load = db.prepare('SELECT id, reference, pickupLocation, pickupWarehouse, deliveryLocation, deliveryWarehouse, stops FROM loads WHERE reference LIKE ?').get('%528772');
    console.log('rcdump: load = ' + JSON.stringify(load));
    const rc = db.prepare('SELECT r.id, r.reference, f.storedFilename, f.originalFilename FROM rate_confirmations r LEFT JOIN files f ON f.id = r.fileId WHERE r.reference LIKE ?').get('%528772');
    console.log('rcdump: rc = ' + JSON.stringify(rc));
    if (rc && rc.storedFilename) {
      const buf = fs.readFileSync(path.join(UPLOADS_DIR, rc.storedFilename));
      const text = cleanRateText(await pdfTextFromBuffer(buf));
      console.log('rcdump: RC TEXT BEGIN\n' + text.slice(0, 6000) + '\nrcdump: RC TEXT END');
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
  } catch (e) { console.error('rcdump failed:', e.message); }
}

// One-off (owner, 2026-11-17): the RC row for LXL-528772 has no stored
// file, so pull the RC PDF from the connected mailboxes and log its text
// to read the street addresses off the document itself.
async function fetchRc528772() {
  try {
    const marker = 'fetch-rc-528772-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('rcfetch: ' + m);
    const users = db.prepare('SELECT * FROM users WHERE outlookRefreshToken IS NOT NULL ORDER BY isMainAdmin DESC, id').all();
    log('mailboxes: ' + users.map((u) => u.outlookEmail || u.name).join(', '));
    let downloaded = 0;
    for (const u of users) {
      if (downloaded >= 6) break;
      let accessToken;
      try { accessToken = await outlookAccessToken(u); } catch { log('no token for ' + (u.outlookEmail || u.name)); continue; }
      const page = await outlookGraph(accessToken, '/me/messages?$search=' + encodeURIComponent('"528772"') + '&$top=25&$select=id,subject,receivedDateTime,hasAttachments').catch(() => null);
      const msgs = ((page && page.value) || []);
      log(msgs.length + ' message(s) in ' + (u.outlookEmail || u.name) + (msgs.length ? ' — ' + msgs.map((m) => m.subject || '(no subject)').join(' || ') : ''));
      for (const m of msgs) {
        if (downloaded >= 6) break;
        if (!m.hasAttachments) continue;
        const atts = await outlookGraph(accessToken, `/me/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size`).catch(() => null);
        for (const a of ((atts && atts.value) || [])) {
          if (downloaded >= 6) break;
          if (!a.id || (a.size || 0) >= 12000000) continue;
          const isPdf = (a.contentType || '').includes('pdf') || /\.pdf$/i.test(a.name || '');
          if (!isPdf) continue;
          const got = await outlookAttachmentBuffer(u, m.id, a.id).catch(() => ({}));
          if (!got.fileBuffer || !got.fileBuffer.length) { log('attachment "' + (a.name || '') + '" could not be downloaded'); continue; }
          downloaded += 1;
          const text = cleanRateText(await pdfTextFromBuffer(got.fileBuffer).catch(() => ''));
          log('attachment "' + (a.name || '') + '" from [' + (m.subject || '') + '] chars=' + text.length);
          if (text.length) log('RC TEXT BEGIN\n' + text.slice(0, 6000) + '\nRC TEXT END');
        }
      }
    }
    log('attachments downloaded: ' + downloaded);
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
  } catch (e) { console.error('rcfetch failed:', e.message); }
}

// One-off (owner, 2026-11-17): write the street addresses read off the
// LXL-528772 rate confirmation onto the load — pickup US Beverage
// Packers LLC, 1 Arizona Way, Keasbey NJ 08832; delivery HT Hackney
// Opp, 601 Highway 52 E, Opp AL 36467. Pins are cleared so they
// re-derive from the full street addresses.
async function fixRc528772Addresses() {
  try {
    const marker = 'fix-rc-528772-addresses-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const before = db.prepare('SELECT id, pickupLocation, pickupWarehouse, deliveryLocation, deliveryWarehouse FROM loads WHERE reference = ?').get('LXL-528772');
    console.log('rcaddr: before = ' + JSON.stringify(before));
    if (before) {
      db.prepare('UPDATE loads SET pickupLocation = ?, pickupWarehouse = ?, deliveryLocation = ?, deliveryWarehouse = ?, pickupLat = NULL, pickupLng = NULL, deliveryLat = NULL, deliveryLng = NULL WHERE id = ?')
        .run('1 Arizona Way, Keasbey, NJ 08832', 'US Beverage Packers LLC', '601 Highway 52 E, Opp, AL 36467', 'HT Hackney Opp', before.id);
      const after = db.prepare('SELECT id, pickupLocation, pickupWarehouse, deliveryLocation, deliveryWarehouse FROM loads WHERE id = ?').get(before.id);
      console.log('rcaddr: after = ' + JSON.stringify(after));
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
  } catch (e) { console.error('rcaddr failed:', e.message); }
}

// One-off (owner, 2026-11-17): the plate number lives on the cab card.
// Re-run the cab-card vehicle read over every uploaded cab card and
// fill each unit's EMPTY fields (plate above all, plus VIN/year/make/
// model), so the plate shows beside the cab card's dates in the portal
// and flows to the driver app's My Truck / My Trailer (the serializers
// already carry it). Then dump every unit's stored values for read-back.
async function backfillUnitPlates() {
  try {
    const marker = 'unit-plate-backfill-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('unitplate: ' + m);
    const docs = db.prepare(
      "SELECT e.unitType, e.unitId, e.unitNumber, f.storedFilename FROM equipment_documents e JOIN files f ON f.id = e.fileId WHERE e.docType = 'cab_card'"
    ).all();
    log(docs.length + ' cab card(s) on file');
    for (const d of docs) {
      const table = d.unitType === 'truck' ? 'trucks' : 'trailers';
      const unit = db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(d.unitId);
      if (!unit) { log(d.unitNumber + ': unit row missing — skipped'); continue; }
      const found = await detectVehicleForFile(path.join(UPLOADS_DIR, d.storedFilename));
      const sets = [];
      const vals = [];
      const filled = [];
      for (const key of ['year', 'make', 'model', 'vin', 'plate']) {
        if (found[key] != null && (unit[key] == null || unit[key] === '')) {
          sets.push(key + ' = ?');
          vals.push(found[key]);
          filled.push(key + '=' + found[key]);
        }
      }
      if (sets.length) {
        db.prepare('UPDATE ' + table + ' SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals, d.unitId);
        log(d.unitNumber + ': filled ' + filled.join(', '));
      } else {
        log(d.unitNumber + ': nothing new read (plate on unit: ' + (unit.plate || '—') + ')');
      }
    }
    for (const t of db.prepare('SELECT unitNumber, year, make, model, plate, vin FROM trucks ORDER BY unitNumber').all()) {
      log('TRUCK ' + JSON.stringify(t));
    }
    for (const t of db.prepare('SELECT unitNumber, year, make, kind, plate, vin FROM trailers ORDER BY unitNumber').all()) {
      log('TRAILER ' + JSON.stringify(t));
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
  } catch (e) { console.error('unitplate failed:', e.message); }
}

// One-off v2 (2026-11-17): the first backfill read NO plates — the old
// plate pattern slid into the next label on "LICENSE PLATE NUMBER:"
// cards and failed its own digit check. detectVehicleInfo now tries
// the labelled forms in order with space-free captures. This pass
// re-runs the read with the fixed patterns; when a card still yields
// no plate it logs the card's PLATE/LICENCE text lines verbatim so the
// exact printed format is on record. Trailer 5302's plate (PG46309)
// was read off its cab card by eye on 2026-11-16 and is on record; if
// the reader still misses it, it is set from that record.
async function backfillUnitPlates2() {
  try {
    const marker = 'unit-plate-backfill-2026-11-17-v2';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('unitplate2: ' + m);
    const docs = db.prepare(
      "SELECT e.unitType, e.unitId, e.unitNumber, f.storedFilename FROM equipment_documents e JOIN files f ON f.id = e.fileId WHERE e.docType = 'cab_card'"
    ).all();
    for (const d of docs) {
      const table = d.unitType === 'truck' ? 'trucks' : 'trailers';
      const unit = db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(d.unitId);
      if (!unit) { log(d.unitNumber + ': unit row missing — skipped'); continue; }
      const filePath = path.join(UPLOADS_DIR, d.storedFilename);
      const found = await detectVehicleForFile(filePath);
      const sets = [];
      const vals = [];
      const filled = [];
      for (const key of ['year', 'make', 'model', 'vin', 'plate']) {
        if (found[key] != null && (unit[key] == null || unit[key] === '')) {
          sets.push(key + ' = ?');
          vals.push(found[key]);
          filled.push(key + '=' + found[key]);
        }
      }
      if (sets.length) {
        db.prepare('UPDATE ' + table + ' SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals, d.unitId);
        log(d.unitNumber + ': filled ' + filled.join(', '));
      } else {
        log(d.unitNumber + ': nothing new read (plate on unit: ' + (unit.plate || '—') + ')');
      }
      const fresh = db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(d.unitId);
      if (!fresh.plate) {
        try {
          const text = await extractFileText(fs.readFileSync(filePath));
          const ctx = String(text).split(/\r?\n/).map(s => s.trim()).filter(s => /plate|licen[cs]e/i.test(s)).slice(0, 6);
          if (ctx.length) for (const line of ctx) log('CTX ' + d.unitNumber + ' | ' + line.slice(0, 140));
          else log('CTX ' + d.unitNumber + ' | no PLATE/LICENCE line in extracted text (len ' + String(text).length + ')');
        } catch (e) { log('CTX ' + d.unitNumber + ' | text read failed: ' + e.message); }
      }
    }
    const t5302 = db.prepare("SELECT * FROM trailers WHERE unitNumber = '5302'").get();
    if (t5302 && !t5302.plate) {
      db.prepare("UPDATE trailers SET plate = 'PG46309' WHERE id = ?").run(t5302.id);
      log('5302: plate set to PG46309 from the value read off its cab card on 2026-11-16');
    }
    for (const t of db.prepare('SELECT unitNumber, year, make, model, plate, vin FROM trucks ORDER BY unitNumber').all()) {
      log('TRUCK ' + JSON.stringify(t));
    }
    for (const t of db.prepare('SELECT unitNumber, year, make, kind, plate, vin FROM trailers ORDER BY unitNumber').all()) {
      log('TRAILER ' + JSON.stringify(t));
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
  } catch (e) { console.error('unitplate2 failed:', e.message); }
}

// One-off v3 (2026-11-17, DIAGNOSTIC ONLY — writes nothing): v2 still
// read no plate for trucks 1301/1302. Their cards' extracted text has
// very long lines (the jurisdictions block is one line), so the plate
// label and its value are likely separated inside a line, or the label
// itself is worded differently. Log a window of flattened text around
// every "plate"/"licen" mention and around the unit's VIN (the plate
// sits in the same table block as the VIN on Indiana IRP cards) so the
// exact printed format is on record before the matcher is touched again.
async function dumpCabCardPlateContext() {
  try {
    const marker = 'unit-plate-context-2026-11-17-v3';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('unitplate3: ' + m);
    const docs = db.prepare(
      "SELECT e.unitType, e.unitId, e.unitNumber, f.storedFilename FROM equipment_documents e JOIN files f ON f.id = e.fileId WHERE e.docType = 'cab_card'"
    ).all();
    for (const d of docs) {
      const table = d.unitType === 'truck' ? 'trucks' : 'trailers';
      const unit = db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(d.unitId);
      if (!unit || unit.plate) { log(d.unitNumber + ': plate already set (' + (unit && unit.plate) + ') — skipped'); continue; }
      let text = '';
      try { text = await extractFileText(fs.readFileSync(path.join(UPLOADS_DIR, d.storedFilename))); }
      catch (e) { log(d.unitNumber + ': text read failed: ' + e.message); continue; }
      const flat = String(text).replace(/\s+/g, ' ');
      log(d.unitNumber + ': text length ' + flat.length);
      let n = 0;
      for (const m of flat.matchAll(/plate|licen[cs]e/gi)) {
        if (n >= 6) break;
        const s = Math.max(0, m.index - 60);
        log('HIT ' + d.unitNumber + ' #' + (++n) + ' | ' + flat.slice(s, m.index + 130));
      }
      if (!n) log(d.unitNumber + ': no plate/licence mention in text at all');
      if (unit.vin) {
        const vi = flat.toUpperCase().indexOf(String(unit.vin).toUpperCase());
        if (vi >= 0) log('VINWIN ' + d.unitNumber + ' | ' + flat.slice(Math.max(0, vi - 180), vi + 200));
        else log('VINWIN ' + d.unitNumber + ' | VIN not found in card text');
      }
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
  } catch (e) { console.error('unitplate3 failed:', e.message); }
}

// One-off (2026-11-17): plates verified MANUALLY at the owner's request
// by reading the actual cab card documents in the portal. The cards
// label the field "APPORTIONED LICENSE PLATE NO." — 1301: 3988293,
// 1302: 4020482, 5302: PG46309 (already set in v2, matches the card).
// 5302's card also shows Year 2012, Make WAB (Wabash) — filled here
// where empty. Trailer 531 has NO cab card on file (insurance +
// annual inspection only), so there is no plate to read for it.
// Fills only EMPTY fields; never overwrites.
async function setVerifiedPlates() {
  try {
    const marker = 'unit-plates-manual-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('unitplate4: ' + m);
    const setIfEmpty = (table, unitNumber, fields) => {
      const unit = db.prepare('SELECT * FROM ' + table + ' WHERE unitNumber = ?').get(unitNumber);
      if (!unit) { log(unitNumber + ': unit row missing'); return; }
      const sets = [];
      const vals = [];
      const done = [];
      for (const [key, val] of Object.entries(fields)) {
        if (unit[key] == null || unit[key] === '') { sets.push(key + ' = ?'); vals.push(val); done.push(key + '=' + val); }
      }
      if (sets.length) {
        db.prepare('UPDATE ' + table + ' SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals, unit.id);
        log(unitNumber + ': set ' + done.join(', ') + ' (read off its cab card)');
      } else {
        log(unitNumber + ': fields already filled — untouched');
      }
    };
    setIfEmpty('trucks', '1301', { plate: '3988293' });
    setIfEmpty('trucks', '1302', { plate: '4020482' });
    setIfEmpty('trailers', '5302', { year: 2012, make: 'Wabash' });
    for (const t of db.prepare('SELECT unitNumber, year, make, model, plate, vin FROM trucks ORDER BY unitNumber').all()) {
      log('TRUCK ' + JSON.stringify(t));
    }
    for (const t of db.prepare('SELECT unitNumber, year, make, kind, plate, vin FROM trailers ORDER BY unitNumber').all()) {
      log('TRAILER ' + JSON.stringify(t));
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
  } catch (e) { console.error('unitplate4 failed:', e.message); }
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
    // Resolve Arshdeep through truck 1302's assigned driver (the
    // name-prefix match found nobody on the first run, 2026-11-17).
    const truck = db.prepare("SELECT id, driverId FROM trucks WHERE unitNumber = '1302'").get();
    let arsh = truck && truck.driverId ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(truck.driverId) : null;
    if (!arsh) arsh = db.prepare("SELECT id, name FROM users WHERE name LIKE '%Arsh%' ORDER BY id LIMIT 1").get();
    const load = db.prepare("SELECT * FROM loads WHERE reference = 'LXL-1197586'").get();
    if (!arsh || !load) {
      log('skipped arsh=' + (arsh ? arsh.id : 'none') + ' load=' + (load ? load.id : 'none'));
      for (const u of db.prepare('SELECT id, name FROM users ORDER BY id').all()) log('user ' + u.id + ' = ' + JSON.stringify(u.name));
      return;
    }
    log('arsh resolved: id=' + arsh.id + ' name=' + JSON.stringify(arsh.name));
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
    const after = db.prepare('SELECT driverId FROM loads WHERE id = ?').get(load.id);
    log('after driverId=' + after.driverId + '; documents moved: ' + docs.changes);
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('load 1197586 driver fix failed', e); }
}

// The two Uber Freight loads from the missing-loads hunt (owner
// confirmed 2026-11-17: both are Arshdeep's, truck 1302). Routes and
// rates are labelled in Uber's own RC emails; PODs were processed by
// Uber, and both invoices sit on OTR paid schedules (LXLD-43 and
// LXLD-40) — the loads ran and were paid, they were just never
// entered. Added as completed loads with rate con rows, following
// the portal's existing Uber convention (LXL-<number>).
async function addMissingUberLoads() {
  try {
    const marker = 'add-missing-uber-loads-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('missing uber loads: ' + m);
    const truck = db.prepare("SELECT driverId FROM trucks WHERE unitNumber = '1302'").get();
    const arsh = truck && truck.driverId ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(truck.driverId) : null;
    if (!arsh) { log('skipped — Arsh not resolved'); return; }
    const defs = [
      { ref: 'LXL-6988101101', rcRef: '6988101101', rateCents: 250000,
        pickupLocation: 'Fairburn, GA 30213', pickupWarehouse: 'Mondelez International - Atlanta 3PL, 5355 Campbellton Fairburn Rd',
        pickupAt: '2026-10-20T09:00:00', pickupTimezone: 'America/New_York',
        deliveryLocation: 'Middletown, PA', deliveryAt: '2026-10-22T17:00:00', deliveryTimezone: 'America/New_York',
        pState: 'GA', dState: 'PA', pDate: '2026-10-20', dDate: '2026-10-22',
        notes: 'Uber Freight UF-6988101101. POD processed by Uber 2026-10-22. On OTR schedule LXLD-43. Added 2026-11-17 from the missing-loads hunt (owner confirmed: Arsh load).' },
      { ref: 'LXL-1428399333', rcRef: '1428399333', rateCents: 527800,
        pickupLocation: 'Anderson, IN 46011', pickupWarehouse: 'US DC Interstate Anderson, 7445 S Layton Rd',
        pickupAt: '2026-10-14T09:00:00', pickupTimezone: 'America/New_York',
        deliveryLocation: 'Ashland, VA', deliveryAt: '2026-10-16T17:00:00', deliveryTimezone: 'America/New_York',
        pState: 'IN', dState: 'VA', pDate: '2026-10-14', dDate: '2026-10-16',
        notes: 'Uber Freight UF-1428399333. POD processed by Uber 2026-10-16. On OTR schedule LXLD-40. Added 2026-11-17 from the missing-loads hunt (owner confirmed: Arsh load).' },
    ];
    for (const d of defs) {
      let loadId;
      const existing = db.prepare('SELECT id FROM loads WHERE reference = ?').get(d.ref);
      if (existing) {
        loadId = existing.id;
        log(d.ref + ' load already there, checking its rate con');
      } else {
        const ins = db.prepare(`INSERT INTO loads (reference, driverId, pickupLocation, pickupWarehouse, pickupAt, pickupTimezone, deliveryLocation, deliveryAt, deliveryTimezone, notes, status, completedAt, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`)
          .run(d.ref, arsh.id, d.pickupLocation, d.pickupWarehouse, d.pickupAt, d.pickupTimezone, d.deliveryLocation, d.deliveryAt, d.deliveryTimezone, d.notes, d.deliveryAt, new Date().toISOString());
        loadId = ins.lastInsertRowid;
      }
      const rc = db.prepare('SELECT id FROM rate_confirmations WHERE reference = ? OR loadId = ?').get(d.rcRef, loadId);
      if (!rc) {
        db.prepare(`INSERT INTO rate_confirmations (reference, loadId, broker, pickupState, deliveryState, pickupDate, deliveryDate, rateCents, fileId, createdAt)
          VALUES (?, ?, 'Uber Freight', ?, ?, ?, ?, ?, NULL, ?)`)
          .run(d.rcRef, loadId, d.pState, d.dState, d.pDate, d.dDate, d.rateCents, new Date().toISOString());
      }
      log('added ' + d.ref + ' for ' + arsh.name + ' at $' + (d.rateCents / 100).toFixed(2));
    }
    const t = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(rateCents), 0) AS s FROM rate_confirmations').get();
    log('rate cons now: ' + t.n + ' rows, booked $' + (t.s / 100).toFixed(2));
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('missing uber loads failed', e); }
}

// Find the rate cons for Akash's 3 missing loads ON THE PORTAL
// (owner, 2026-11-17: "Check the rc on the portal"). The mailbox
// import read some of these attachments server-side (the Pro #26257
// email yielded text) — if it saved the files, their text can be
// read here exactly like the Circle RC was. Read-only diagnostic:
// log every matching rate con row, file and document, and run the
// RC readers over any stored file found.
async function findMissingRcFiles() {
  try {
    const marker = 'find-missing-rc-files-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('missing rc files: ' + m);
    const targets = ['4700709', '26257', '409386'];
    for (const t of targets) {
      const rcs = db.prepare('SELECT id, reference, broker, rateCents, fileId, loadId FROM rate_confirmations WHERE reference LIKE ?').all('%' + t + '%');
      for (const r of rcs) log(t + ': rc row ' + r.id + ' ref=' + r.reference + ' broker=' + (r.broker || '') + ' rateCents=' + r.rateCents + ' fileId=' + r.fileId + ' loadId=' + r.loadId);
      if (!rcs.length) log(t + ': no rate con row');
      const files = db.prepare('SELECT id, storedFilename, originalFilename FROM files WHERE originalFilename LIKE ? OR storedFilename LIKE ?').all('%' + t + '%', '%' + t + '%');
      for (const f of files) log(t + ': file ' + f.id + ' original=' + f.originalFilename + ' stored=' + f.storedFilename);
      if (!files.length) log(t + ': no file by name');
      const docs = db.prepare('SELECT id, kind, label, fileId, loadId FROM documents WHERE label LIKE ?').all('%' + t + '%');
      for (const d of docs) log(t + ': document ' + d.id + ' kind=' + d.kind + ' label=' + d.label + ' fileId=' + d.fileId + ' loadId=' + d.loadId);
      const fileIds = new Set();
      for (const r of rcs) if (r.fileId) fileIds.add(r.fileId);
      for (const f of files) fileIds.add(f.id);
      for (const d of docs) if (d.fileId) fileIds.add(d.fileId);
      for (const fid of fileIds) {
        const f = getFileRow(fid);
        if (!f || !f.storedFilename) { log(t + ': fileId ' + fid + ' has no stored file'); continue; }
        try {
          const buf = fs.readFileSync(path.join(UPLOADS_DIR, f.storedFilename));
          const text = String(await extractFileText(buf) || '').replace(/\s+/g, ' ');
          log(t + ': file ' + fid + ' text chars=' + text.length);
          const places = scanRcPlaces(text, 0);
          log(t + ': places: ' + places.map((p) => p.city + ', ' + p.state + (p.zip ? ' ' + p.zip : '')).join(' | '));
          const det = extractRateConDetails(text);
          log(t + ': rate read: ' + JSON.stringify(det));
          const fields = extractRcLoadFields(text);
          log(t + ': fields: ' + JSON.stringify(fields));
        } catch (e) { log(t + ': could not read file ' + fid + ': ' + e.message); }
      }
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('missing rc files failed', e); }
}

// Fetch the 3 missing RCs from the connected mailboxes themselves
// (owner, 2026-11-17: "look rc in my email"). The portal's Graph
// connection can download attachments even though they were never
// saved as portal files. Read-only: for each target load number,
// search every connected mailbox, download the PDF attachments on
// matching messages, and log the places + rate the RC readers find.
async function fetchMissingRcFromMailboxes() {
  try {
    const marker = 'fetch-missing-rc-mail-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('missing rc mail: ' + m);
    const targets = ['4700709', '26257', '409386'];
    const users = db.prepare('SELECT * FROM users WHERE outlookRefreshToken IS NOT NULL ORDER BY isMainAdmin DESC, id').all();
    log('mailboxes connected: ' + users.map((u) => u.outlookEmail || u.name).join(', '));
    for (const t of targets) {
      let downloaded = 0;
      for (const u of users) {
        if (downloaded >= 12) break;
        let accessToken;
        try { accessToken = await outlookAccessToken(u); } catch { log(t + ': no token for ' + (u.outlookEmail || u.name)); continue; }
        const page = await outlookGraph(accessToken, '/me/messages?$search=' + encodeURIComponent('"' + t + '"') + '&$top=25&$select=id,subject,receivedDateTime,hasAttachments,bodyPreview').catch(() => null);
        const msgs = ((page && page.value) || []);
        log(t + ': ' + msgs.length + ' message(s) in ' + (u.outlookEmail || u.name) + (msgs.length ? ' — ' + msgs.map((m) => m.subject || '(no subject)').join(' || ') : ''));
        for (const m of msgs) {
          if (downloaded >= 12) break;
          if (!m.hasAttachments) {
            const bp = String(m.bodyPreview || '').replace(/\s+/g, ' ').trim();
            if (bp) log(t + ': no-attachment body preview [' + (m.subject || '') + ']: ' + bp.slice(0, 220));
            continue;
          }
          const atts = await outlookGraph(accessToken, `/me/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size`).catch(() => null);
          for (const a of ((atts && atts.value) || [])) {
            if (downloaded >= 12) break;
            if (!a.id || (a.size || 0) >= 12000000) continue;
            const isPdf = (a.contentType || '').includes('pdf') || /\.pdf$/i.test(a.name || '');
            const isImg = /image\//.test(a.contentType || '') || /\.(png|jpe?g)$/i.test(a.name || '');
            if (!isPdf && !isImg) continue;
            const got = await outlookAttachmentBuffer(u, m.id, a.id).catch(() => ({}));
            if (!got.fileBuffer || !got.fileBuffer.length) { log(t + ': attachment "' + (a.name || '') + '" could not be downloaded'); continue; }
            downloaded += 1;
            const text = String(await extractFileText(got.fileBuffer).catch(() => '') || '').replace(/\s+/g, ' ');
            log(t + ': attachment "' + (a.name || '') + '" from [' + (m.subject || '') + '] text chars=' + text.length);
            if (!text.length) continue;
            const places = scanRcPlaces(text, 0);
            log(t + ': places: ' + (places.map((p) => p.city + ', ' + p.state + (p.zip ? ' ' + p.zip : '')).join(' | ') || 'none'));
            log(t + ': rate read: ' + JSON.stringify(extractRateConDetails(text)));
            log(t + ': fields: ' + JSON.stringify(extractRcLoadFields(text)));
            const idx = text.indexOf(t);
            if (idx >= 0) log(t + ': context: ' + text.slice(Math.max(0, idx - 80), idx + 220));
          }
        }
      }
      log(t + ': attachments downloaded: ' + downloaded);
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('missing rc mail failed', e); }
}

// Fetch v2 — precision pass (the v1 $search matched quoted threads
// across the mailboxes and the 12-download cap filled with other
// loads' BOLs). This pass keeps only messages whose SUBJECT names
// the load, prefers attachments whose NAME names it, verifies the
// target number inside the document text, and logs the anchored
// pickup/delivery fields instead of every place in the document.
async function fetchMissingRcFromMailboxes2() {
  try {
    const marker = 'fetch-missing-rc-mail2-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('missing rc mail2: ' + m);
    const targets = ['4700709', '26257', '409386'];
    const users = db.prepare('SELECT * FROM users WHERE outlookRefreshToken IS NOT NULL ORDER BY isMainAdmin DESC, id').all();
    for (const t of targets) {
      let downloaded = 0;
      for (const u of users) {
        if (downloaded >= 8) break;
        let accessToken;
        try { accessToken = await outlookAccessToken(u); } catch { continue; }
        const page = await outlookGraph(accessToken, '/me/messages?$search=' + encodeURIComponent('"' + t + '"') + '&$top=50&$select=id,subject,receivedDateTime,hasAttachments').catch(() => null);
        const msgs = ((page && page.value) || []).filter((m) => String(m.subject || '').includes(t));
        log(t + ': subject-matched messages in ' + (u.outlookEmail || u.name) + ': ' + msgs.length + (msgs.length ? ' — ' + msgs.map((m) => m.subject).join(' || ') : ''));
        for (const m of msgs) {
          if (downloaded >= 8) break;
          if (!m.hasAttachments) continue;
          const atts = await outlookGraph(accessToken, `/me/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size`).catch(() => null);
          const list = ((atts && atts.value) || []).filter((a) => a.id && (a.size || 0) < 12000000 && ((a.contentType || '').includes('pdf') || /\.pdf$/i.test(a.name || '') || /image\//.test(a.contentType || '') || /\.(png|jpe?g)$/i.test(a.name || '')));
          list.sort((a, b) => (String(b.name || '').includes(t) ? 1 : 0) - (String(a.name || '').includes(t) ? 1 : 0));
          for (const a of list) {
            if (downloaded >= 8) break;
            const got = await outlookAttachmentBuffer(u, m.id, a.id).catch(() => ({}));
            if (!got.fileBuffer || !got.fileBuffer.length) continue;
            downloaded += 1;
            const text = String(await extractFileText(got.fileBuffer).catch(() => '') || '').replace(/\s+/g, ' ');
            const has = text.includes(t);
            log(t + ': [' + (u.outlookEmail || u.name) + '] "' + (a.name || '') + '" on [' + (m.subject || '') + '] chars=' + text.length + ' containsNumber=' + has);
            if (!text.length) continue;
            log(t + ': fields: ' + JSON.stringify(extractRcLoadFields(text)));
            log(t + ': rate read: ' + JSON.stringify(extractRateConDetails(text)));
            const places = scanRcPlaces(text, 0);
            log(t + ': places: ' + (places.slice(0, 6).map((p) => p.city + ', ' + p.state + (p.zip ? ' ' + p.zip : '')).join(' | ') || 'none'));
          }
        }
      }
      log(t + ': attachments downloaded: ' + downloaded);
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('missing rc mail2 failed', e); }
}

// Fetch v3 — read the actual words. v2 found the right threads but
// the anchored readers came back with fragments (Armstrong: Holland
// OH + Phoneton OH in one document, Roswell GA in another; Joy Ride:
// Auburn IN amid garbled OCR; New City: the signed confirmation sits
// in Aisha's mailbox, which v2's download cap never reached). This
// pass searches the mailbox that holds each document FIRST, prefers
// attachments whose name carries the load number, and logs short
// text excerpts around the key words so the pickup/delivery labels
// can be read directly.
async function fetchMissingRcFromMailboxes3() {
  try {
    const marker = 'fetch-missing-rc-mail3-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('missing rc mail3: ' + m);
    const jobs = [
      { t: '4700709', mailboxHint: 'lxlus13', words: ['Holland', 'Phoneton', 'Roswell', 'Pickup', 'Deliver', 'Consignee', 'Shipper'] },
      { t: '26257', mailboxHint: 'lxlus13', words: ['Auburn', 'Pickup', 'Deliver', 'Consignee', 'Shipper', 'Origin', 'Destination'] },
      { t: '409386', mailboxHint: 'aisha', words: ['Pickup', 'Deliver', 'Consignee', 'Shipper', 'Origin', 'Destination', 'Beer', 'Brew'] },
    ];
    const allUsers = db.prepare('SELECT * FROM users WHERE outlookRefreshToken IS NOT NULL').all();
    for (const job of jobs) {
      const users = [...allUsers].sort((a, b) => (String(a.outlookEmail || '').toLowerCase().includes(job.mailboxHint) ? 0 : 1) - (String(b.outlookEmail || '').toLowerCase().includes(job.mailboxHint) ? 0 : 1));
      let logged = 0;
      for (const u of users) {
        if (logged >= 3) break;
        let accessToken;
        try { accessToken = await outlookAccessToken(u); } catch { continue; }
        const page = await outlookGraph(accessToken, '/me/messages?$search=' + encodeURIComponent('"' + job.t + '"') + '&$top=50&$select=id,subject,hasAttachments').catch(() => null);
        const msgs = ((page && page.value) || []).filter((m) => String(m.subject || '').includes(job.t) && m.hasAttachments);
        for (const m of msgs) {
          if (logged >= 3) break;
          const atts = await outlookGraph(accessToken, `/me/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size`).catch(() => null);
          const list = ((atts && atts.value) || []).filter((a) => a.id && (a.size || 0) < 12000000 && ((a.contentType || '').includes('pdf') || /\.pdf$/i.test(a.name || '') || /image\//.test(a.contentType || '') || /\.(png|jpe?g)$/i.test(a.name || '')));
          list.sort((a, b) => (String(b.name || '').includes(job.t) ? 1 : 0) - (String(a.name || '').includes(job.t) ? 1 : 0));
          for (const a of list) {
            if (logged >= 3) break;
            const got = await outlookAttachmentBuffer(u, m.id, a.id).catch(() => ({}));
            if (!got.fileBuffer || !got.fileBuffer.length) continue;
            const text = String(await extractFileText(got.fileBuffer).catch(() => '') || '').replace(/\s+/g, ' ');
            if (!text.includes(job.t)) continue;
            const fields = extractRcLoadFields(text);
            const score = (fields.places ? fields.places.length : 0) + (fields.dates && fields.dates.length ? 1 : 0);
            log(job.t + ': doc "' + (a.name || '') + '" in ' + (u.outlookEmail || u.name) + ' chars=' + text.length + ' score=' + score + ' places=' + JSON.stringify(fields.places || []) + ' dates=' + JSON.stringify(fields.dates || []));
            if (score === 0) continue;
            logged += 1;
            for (const w of job.words) {
              const idx = text.toLowerCase().indexOf(w.toLowerCase());
              if (idx >= 0) log(job.t + ': ~' + w + '~: ' + text.slice(Math.max(0, idx - 120), idx + 260));
            }
          }
        }
      }
      log(job.t + ': excerpted docs: ' + logged);
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('missing rc mail3 failed', e); }
}

// Add Akash's Armstrong + Joy Ride loads — routes READ from the
// documents in his own mailbox (fetch v3, 2026-11-17):
// - Armstrong 4700709-1: the OTR invoice screenshot in the thread
//   reads "Ship From Holland, OH 43528 / Ship To Phoneton, OH 45371",
//   Amount $1100.00, broker Armstrong Transport Group. Pickup Oct 2,
//   delivered Oct 3 (paperwork dispute Oct 5, clean BOL sent).
// - Joy Ride Pro #26257: the signed RC reads Stop 0 Punta Gorda, FL
//   appt 10/24/26 -> Stop 1 WALMART, 1729 State Rd 8, Auburn, IN
//   46706, appt 10/26/26 04:00. Melons, reefer 55F. Truck 1301.
//   Rate found on the RC itself: TOTAL RATE 2200.00.
// - New City 409386: the broker confirmation + worksheet read
//   Origin Saddle Brook, NJ -> Destination Indianapolis, IN,
//   Total Payable $1500.00 flat. Beer, delivered Sep 9 11 AM appt.
async function addMissingAkashLoads() {
  try {
    const marker = 'add-missing-akash-loads-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('missing akash loads: ' + m);
    const truck1301 = db.prepare("SELECT driverId FROM trucks WHERE unitNumber = '1301'").get();
    const akash = (truck1301 && truck1301.driverId && db.prepare('SELECT id, name FROM users WHERE id = ?').get(truck1301.driverId))
      || db.prepare("SELECT id, name FROM users WHERE LOWER(name) LIKE '%akash%'").get();
    if (!akash) { log('SKIPPED — Akash driver row not found'); return; }
    const defs = [
      {
        ref: 'LXL-4700709-1', rcRef: '4700709-1', broker: 'Armstrong Transport Group',
        pickupLocation: 'Holland, OH 43528', pickupWarehouse: null, pickupAt: '2026-10-02T09:00:00', pickupTimezone: 'America/New_York',
        deliveryLocation: 'Phoneton, OH 45371', deliveryAt: '2026-10-03T17:00:00', deliveryTimezone: 'America/New_York',
        pState: 'OH', dState: 'OH', pDate: '2026-10-02', dDate: '2026-10-03', rateCents: 110000,
        notes: 'Broker: Armstrong Transport Group (Neil Johnson). Route and $1,100 amount read from the OTR invoice screenshot in the rate con email thread (Ship From Holland, OH 43528 / Ship To Phoneton, OH 45371). Paperwork dispute Oct 5 — clean BOL sent.',
      },
      {
        ref: 'LXL-26257', rcRef: '26257', broker: 'Joy Ride Express',
        pickupLocation: 'Punta Gorda, FL', pickupWarehouse: 'JDI Shed, 1300 SR 31', pickupAt: '2026-10-24T09:00:00', pickupTimezone: 'America/New_York',
        deliveryLocation: 'Auburn, IN 46706', deliveryWarehouse: 'Walmart, 1729 State Rd 8', deliveryAt: '2026-10-26T04:00:00', deliveryTimezone: 'America/New_York',
        pState: 'FL', dState: 'IN', pDate: '2026-10-24', dDate: '2026-10-26', rateCents: 220000,
        notes: 'Broker: Joy Ride Express (Stephen Nickels). Melons, 42,000 lbs — reefer set at 55F. Route, appointments and the $2,200 total rate read from the signed rate confirmation in the mailbox (LINE HAUL RATE 2200.00 / TOTAL RATE 2200.00; JDI Shed Punta Gorda appt 10/24/26 -> Walmart Auburn, IN appt 10/26/26 04:00).',
      },
      {
        ref: 'LXL-409386', rcRef: '409386', broker: 'New City Logistics',
        pickupLocation: 'Saddle Brook, NJ', pickupWarehouse: null, pickupAt: '2026-09-08T09:00:00', pickupTimezone: 'America/New_York',
        deliveryLocation: 'Indianapolis, IN', deliveryWarehouse: null, deliveryAt: '2026-09-09T11:00:00', deliveryTimezone: 'America/New_York',
        pState: 'NJ', dState: 'IN', pDate: '2026-09-08', dDate: '2026-09-09', rateCents: 150000,
        notes: 'Broker: New City Logistics (Alessandra Milazzo). BEER, 18 pallets, 42,500 lbs. Container MSMU8861260, PO # IWEI062226di, Release # WHS26309. Route and the $1,500 flat line haul read from the broker confirmation + worksheet in the mailbox (Bill of Lading Origin Saddle Brook, NJ / Destination Indianapolis, IN; Total Payable to Carrier $1500.00). Delivery appt Sep 9, 11:00 AM.',
      },
    ];
    for (const d of defs) {
      let loadId;
      const existing = db.prepare('SELECT id FROM loads WHERE reference = ?').get(d.ref);
      if (existing) { loadId = existing.id; log(d.ref + ' load already there, checking its rate con'); }
      else {
        const ins = db.prepare(`INSERT INTO loads (reference, driverId, pickupLocation, pickupWarehouse, pickupAt, pickupTimezone, deliveryLocation, deliveryWarehouse, deliveryAt, deliveryTimezone, notes, status, completedAt, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`)
          .run(d.ref, akash.id, d.pickupLocation, d.pickupWarehouse || null, d.pickupAt, d.pickupTimezone, d.deliveryLocation, d.deliveryWarehouse || null, d.deliveryAt, d.deliveryTimezone, d.notes, d.deliveryAt, new Date().toISOString());
        loadId = ins.lastInsertRowid;
      }
      if (d.rcRef && d.rateCents) {
        const rc = db.prepare('SELECT id FROM rate_confirmations WHERE reference = ? OR loadId = ?').get(d.rcRef, loadId);
        if (!rc) {
          db.prepare(`INSERT INTO rate_confirmations (reference, loadId, broker, pickupState, deliveryState, pickupDate, deliveryDate, rateCents, fileId, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
            .run(d.rcRef, loadId, d.broker, d.pState, d.dState, d.pDate, d.dDate, d.rateCents, new Date().toISOString());
        }
      }
      log('added ' + d.ref + ' for ' + akash.name + (d.rateCents ? ' at $' + (d.rateCents / 100).toFixed(2) : ' (no rate)'));
    }
    const tot = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(rateCents), 0) AS s FROM rate_confirmations').get();
    log('rate cons now: ' + tot.n + ' rows, booked $' + (tot.s / 100).toFixed(2));
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('missing akash loads failed', e); }
}

// Final micro-pass: (a) New City 409386 — read the signed
// confirmation in AISHA's mailbox (v3's report cut before its
// lines); (b) Joy Ride 26257 — hunt the rate line in the signed RC.
async function fetchMissingRcFinal() {
  try {
    const marker = 'fetch-missing-rc-final-2026-11-17';
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get(marker)) return;
    const log = (m) => console.log('missing rc mail4: ' + m);
    const allUsers = db.prepare('SELECT * FROM users WHERE outlookRefreshToken IS NOT NULL').all();
    const hunts = [
      { t: '409386', hint: 'aisha', nameHint: '409386', words: ['Pickup', 'Deliver', 'Shipper', 'Consignee', 'Origin', 'Destination', 'Rate', 'Total'] },
      { t: '26257', hint: 'lxlus13', nameHint: 'Signed_RateConfirmation', words: ['Rate', 'Total', 'Line Haul', 'Amount', '$'] },
    ];
    for (const h of hunts) {
      const users = [...allUsers].sort((a, b) => (String(a.outlookEmail || '').toLowerCase().includes(h.hint) ? 0 : 1) - (String(b.outlookEmail || '').toLowerCase().includes(h.hint) ? 0 : 1));
      let logged = 0;
      for (const u of users) {
        if (logged >= 2) break;
        let accessToken;
        try { accessToken = await outlookAccessToken(u); } catch { continue; }
        const page = await outlookGraph(accessToken, '/me/messages?$search=' + encodeURIComponent('"' + h.t + '"') + '&$top=50&$select=id,subject,hasAttachments').catch(() => null);
        const msgs = ((page && page.value) || []).filter((m) => String(m.subject || '').includes(h.t) && m.hasAttachments);
        for (const m of msgs) {
          if (logged >= 2) break;
          const atts = await outlookGraph(accessToken, `/me/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size`).catch(() => null);
          const list = ((atts && atts.value) || []).filter((a) => a.id && (a.size || 0) < 12000000 && ((a.contentType || '').includes('pdf') || /\.pdf$/i.test(a.name || '')));
          list.sort((a, b) => (String(b.name || '').includes(h.nameHint) ? 1 : 0) - (String(a.name || '').includes(h.nameHint) ? 1 : 0));
          for (const a of list) {
            if (logged >= 2) break;
            if (!String(a.name || '').includes(h.nameHint) && logged > 0) continue;
            const got = await outlookAttachmentBuffer(u, m.id, a.id).catch(() => ({}));
            if (!got.fileBuffer || !got.fileBuffer.length) continue;
            const text = String(await extractFileText(got.fileBuffer).catch(() => '') || '').replace(/\s+/g, ' ');
            if (!text.includes(h.t)) continue;
            logged += 1;
            const fields = extractRcLoadFields(text);
            log(h.t + ': doc "' + (a.name || '') + '" in ' + (u.outlookEmail || u.name) + ' chars=' + text.length + ' places=' + JSON.stringify(fields.places || []) + ' dates=' + JSON.stringify(fields.dates || []) + ' rate=' + JSON.stringify(extractRateConDetails(text)));
            for (const w of h.words) {
              const idx = text.toLowerCase().indexOf(w.toLowerCase());
              if (idx >= 0) log(h.t + ': ~' + w + '~: ' + text.slice(Math.max(0, idx - 100), idx + 280));
            }
          }
        }
      }
      log(h.t + ': docs read: ' + logged);
    }
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run(marker, new Date().toISOString());
    log('done');
  } catch (e) { console.error('missing rc mail4 failed', e); }
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
  // Read the document itself whenever anything is still missing
  // (owner, 2026-11-23): one full read of the RC — amount, broker,
  // load number, pickup/delivery states and dates — fills whatever
  // wasn't typed and doesn't come from a picked load. Precedence:
  // typed values win, then the picked load, then the document.
  let detected = {};
  if (fileBuffer && (!broker || rateCents == null || !(reference || (load && load.reference)) || !(pickupState || load) || !(deliveryState || load) || !(pickupDate || load) || !(deliveryDate || load)))
    detected = await extractRateConDetails(fileBuffer, subject);
  const ref = lxlLoadRef(reference || (load && load.reference) || detected.reference || '');
  // Owner-ruled-out load numbers (2026-11-16 cleanup; a sweep re-imported
  // them on 2026-11-17 because deleting the rows erased their dedupe
  // fingerprints): Corcoran 127657 is CANCELLED, PTG 9841352 and WJW
  // 10425782 are FAKE, Scotlynn 1580304 is CANCELLED, and the four IEL
  // numbers are dispatch sheets, not rate confirmations (their $100 is
  // a GPS fine). Never create a rate con for these again.
  const bareRef = String(ref || '').replace(/^LXL-/i, '');
  if (['127657', '9841352', '10425782', '1580304', '3020150', '3012815', '3002349', '3127767'].includes(bareRef))
    throw Object.assign(new Error('This load number is on the do-not-import list (cancelled, fake, or not a rate confirmation)'), { status: 400 });
  const pState = pickupState || (load && stateFromAddress(load.pickupLocation)) || detected.pickupState || null;
  const dState = deliveryState || (load && stateFromAddress(load.deliveryLocation)) || detected.deliveryState || null;
  const pDate = pickupDate || (load && dateInZone(load.pickupAt, load.pickupTimezone)) || detected.pickupDate || null;
  const dDate = deliveryDate || (load && dateInZone(load.deliveryAt, load.deliveryTimezone)) || detected.deliveryDate || null;
  if (!ref || !pState || !dState || !pDate || !dDate)
    throw Object.assign(new Error('Pick a load, or fill in reference, pickup/delivery state and dates'), { status: 400 });
  const ext = fileName ? path.extname(fileName || '') : '';
  const autoName = `${ref}_${pState}-${dState}_${pDate}_to_${dDate}${ext}`;
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
    res.status(201).json(auto ? { ...rc, loadCreated: auto.created, loadUnassigned: !!auto.unassigned, loadReference: auto.load.reference, loadRoute: auto.load.pickupLocation + ' → ' + auto.load.deliveryLocation } : rc);
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

// Read the rate off an RC file WITHOUT saving anything, so the upload
// form can show the detected amount in an editable box before the
// admin commits (owner, 2026-11-19). Uses the exact same extraction
// as createRateCon — labeled rate lines only, never weights or page
// totals. Persists nothing: no RC row, no load, no file row.
admin.post('/rate-confirmations/detect', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return err(res, 400, 'No file uploaded');
    const fileBuffer = fs.readFileSync(req.file.path);
    try { fs.unlinkSync(req.file.path); } catch {}
    const detected = await extractRateConDetails(fileBuffer);
    // The full read (owner, 2026-11-23): everything the system opened
    // the document and read — amount, broker, load number, route and
    // dates — so the form can show it all before the admin commits.
    res.json({
      rateCents: detected.rateCents ?? null,
      broker: detected.broker ?? null,
      reference: detected.reference ?? null,
      pickupCity: detected.pickupCity ?? null,
      pickupState: detected.pickupState ?? null,
      pickupZip: detected.pickupZip ?? null,
      deliveryCity: detected.deliveryCity ?? null,
      deliveryState: detected.deliveryState ?? null,
      deliveryZip: detected.deliveryZip ?? null,
      pickupDate: detected.pickupDate ?? null,
      deliveryDate: detected.deliveryDate ?? null,
    });
  } catch (e) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    if (e.status) return err(res, e.status, e.message);
    throw e;
  }
});

// Correct the amount on an existing rate confirmation (owner,
// 2026-11-19). Only rateCents changes; the booked totals and the
// per-driver folder sums read it live, so they follow on re-render.
admin.patch('/rate-confirmations/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM rate_confirmations WHERE id = ?').get(req.params.id);
  if (!row) return err(res, 404, 'Rate confirmation not found');
  const rateCents = req.body ? req.body.rateCents : undefined;
  if (typeof rateCents !== 'number' || !Number.isFinite(rateCents) || rateCents < 0 || rateCents > 100000000)
    return err(res, 400, 'Amount must be a number of cents between 0 and 100000000');
  db.prepare('UPDATE rate_confirmations SET rateCents = ? WHERE id = ?').run(Math.round(rateCents), row.id);
  const updated = db
    .prepare('SELECT r.*, f.originalFilename, f.mimeType FROM rate_confirmations r LEFT JOIN files f ON f.id = r.fileId WHERE r.id = ?')
    .get(row.id);
  res.json(serializeRateCon(updated));
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
  const leadWords = new Set(['PICKUP', 'DELIVERY', 'ORIGIN', 'DESTINATION', 'FROM', 'TO', 'AT', 'PU', 'DL', 'SHIP', 'SHIPPING', 'RECEIVING', 'CONSIGNEE', 'SHIPPER', 'AM', 'PM']);
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
// One-off (2026-11-18, build-26 fix round): the two IEL loads LXL-2996825
// and LXL-2999658 pre-date adjudication round 3 (its createFor skipped them
// because the loads already existed), so while round 3 corrected their
// rate_confirmations rows and a later job fixed their pickup cities, their
// loads.pickupAt / deliveryAt / completedAt were never repaired — the
// driver app grouped them under a wrong month (they rendered as a
// "December" statement in My Loads). Set the load dates from the same
// document values round 3 put on the RC rows (2996825: Laurel MS pickup
// 2026-06-13, delivery 2026-06-15; 2999658: pickup 2026-06-16, delivery
// 2026-06-18). The pre-fix values are logged first so the stored format
// is visible in the boot log, and any OTHER load whose stored dates do
// not start with a valid ISO date part is logged (not touched).
// Marker-guarded; runs once. If neither load exists yet, the marker is
// NOT written, so it retries on the next boot.
async function fixIelLoadDates() {
  try {
    db.prepare('CREATE TABLE IF NOT EXISTS one_off_jobs (name TEXT PRIMARY KEY, doneAt TEXT)').run();
    if (db.prepare('SELECT name FROM one_off_jobs WHERE name = ?').get('iel-load-dates-fix-2026-11-18')) return;
    const fixes = [
      { reference: 'LXL-2996825', pickupAt: '2026-06-13T09:00:00', deliveryAt: '2026-06-15T17:00:00' },
      { reference: 'LXL-2999658', pickupAt: '2026-06-16T09:00:00', deliveryAt: '2026-06-18T17:00:00' },
    ];
    let found = 0;
    for (const f of fixes) {
      const load = db.prepare('SELECT id, pickupAt, deliveryAt, completedAt, status FROM loads WHERE reference = ?').get(f.reference);
      if (!load) { console.log('iel-load-dates-fix: load not found (yet)', f.reference); continue; }
      found++;
      console.log('iel-load-dates-fix: before', f.reference, JSON.stringify({ pickupAt: load.pickupAt, deliveryAt: load.deliveryAt, completedAt: load.completedAt, status: load.status }));
      db.prepare('UPDATE loads SET pickupAt = ?, deliveryAt = ?, completedAt = ? WHERE id = ?')
        .run(f.pickupAt, f.deliveryAt, load.status === 'completed' ? f.deliveryAt : load.completedAt, load.id);
      console.log('iel-load-dates-fix: after', f.reference, JSON.stringify({ pickupAt: f.pickupAt, deliveryAt: f.deliveryAt }));
    }
    if (!found) return; // write the marker only once the loads were seen
    const odd = db.prepare('SELECT reference, pickupAt, deliveryAt, completedAt FROM loads').all()
      .filter((l) => !validDatePart(l.pickupAt) || !validDatePart(l.deliveryAt) || (l.completedAt && !validDatePart(l.completedAt)));
    for (const l of odd) console.log('iel-load-dates-fix: non-ISO load dates (left untouched)', JSON.stringify(l));
    db.prepare('INSERT INTO one_off_jobs (name, doneAt) VALUES (?, ?)').run('iel-load-dates-fix-2026-11-18', new Date().toISOString());
  } catch (e) { console.error('iel-load-dates-fix failed', e); }
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
// --- Full stop details from an RC (owner, 2026-11-19): a load the
// system creates from a rate confirmation must be COMPLETE — facility
// name, street address, city/state/ZIP, the stop's reference/pickup
// number and its appointment time — not just city and state. Every
// piece is read from the stop's own block in the document (the text
// immediately around the anchored city match), never from letterhead,
// and any piece that is not plainly there stays null, never guessed.
const RC_STREET_AT_RE = /(\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,4}?(?:STREET|ST|AVENUE|AVE|BOULEVARD|BLVD|ROAD|RD|DRIVE|DR|LANE|LN|COURT|CT|HIGHWAY|HWY|PARKWAY|PKWY|CIRCLE|CIR|PLACE|PL|TRAIL|TRL|WAY|LOOP))\b/y;
const RC_STOP_LABEL_RE = /(PICK[\s-]?UP|PICK|STOP\s*\d+|DELIVER(?:Y|ING)?|DROP[\s-]?OFF|ORIGIN|DESTINATION|SHIPPER|RECEIVER|CONSIGNEE|UNLOAD(?:ING)?)/gi;
function cleanRcFacility(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  // Strip stacked section labels / stop numbers the window may start
  // with ("Stop 1 - Pick Up", "PICK 1", "Shipper").
  for (let i = 0; i < 4; i++) {
    const next = s
      .replace(/^(?:STOP\s*\d+|PICK[\s-]?UP|PICK|DELIVER(?:Y|ING)?|DROP[\s-]?OFF|ORIGIN|DESTINATION|SHIPPER|RECEIVER|CONSIGNEE|UNLOAD(?:ING)?)\b[\s\-–—:.#]*\s*/i, '')
      .replace(/^\d{1,2}\b[\s\-–—:.#]*\s*/, '');
    if (next === s) break;
    s = next;
  }
  s = s.replace(/[\s,;:\-–—]+$/, '').trim();
  if (!s || s.length < 2 || s.length > 60) return null;
  if (s.split(' ').length > 7) return null;
  if (/\d{1,2}\/\d{1,2}\//.test(s) || s.includes('@')) return null;
  if (/phone|contact|notes?|appointment|scheduling|special|reqs?|instructions/i.test(s)) return null;
  if (!/[A-Za-z]{2,}/.test(s)) return null;
  return s;
}
function rcTimeToHHMM(h, m, ap) {
  let hh = Number(h);
  const mm = Number(m);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || mm > 59) return null;
  if (ap) {
    const up = String(ap).toUpperCase();
    if (up === 'PM' && hh < 12) hh += 12;
    if (up === 'AM' && hh === 12) hh = 0;
  }
  if (hh > 23) return null;
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}
function rcPlaceOccurrences(text, place) {
  // Every occurrence of this stop's city/state(/ZIP) in the document.
  // (scanRcPlaces dedupes to the first mention — often the header —
  // so occurrences are found directly here.)
  if (!text || !place || !place.city || !place.state) return [];
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idxs = new Set();
  const pats = [];
  if (place.zip) pats.push(new RegExp(esc(place.city) + ',?\\s+' + esc(place.state) + '\\s+' + esc(place.zip), 'gi'));
  pats.push(new RegExp(esc(place.city) + ',\\s*' + esc(place.state) + '\\b', 'gi'));
  for (const re of pats) {
    let m;
    while ((m = re.exec(text))) idxs.add(m.index);
  }
  return [...idxs].sort((a, b) => a - b);
}
function rcDateTokens(text) {
  // Every date in the text with its position, ISO-normalized — the
  // same two formats extractRcDates reads.
  const out = [];
  const push = (iso, idx, len) => { if (iso) out.push({ iso, idx, len }); };
  let m;
  const re = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g;
  while ((m = re.exec(text))) push(rcNormDate(m[3], m[1], m[2]), m.index, m[0].length);
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const re2 = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/gi;
  while ((m = re2.exec(text))) push(rcNormDate(m[3], months[m[1].slice(0, 3).toLowerCase()], m[2]), m.index, m[0].length);
  return out.sort((a, b) => a.idx - b.idx);
}
function extractRcStopDetail(text, place, loadRef, expectedDate, cutIdx) {
  const out = { street: null, warehouse: null, time: null, number: null };
  if (!text || !place || !place.city || !place.state) return out;
  const occ = rcPlaceOccurrences(text, place);
  if (!occ.length) return out;
  // Prefer the occurrence immediately preceded by a street address —
  // that is the stop block; the header/letterhead mention of the same
  // city has no street in front of it. Street candidates are tried
  // from the rightmost number backwards: the real street number is
  // the LAST number before the city, and a looser scan would swallow
  // the stop number + facility name into the "street" ("PICK 1
  // NEWCOLD 904 EDWARDS DR" -> street must be "904 EDWARDS DR").
  let chosen = occ[0];
  let street = null;
  let streetStart = -1;
  for (const idx of occ) {
    const winFrom = Math.max(0, idx - 220);
    let found = null;
    for (let pos = idx - 1; pos >= winFrom; pos--) {
      if (!/\d/.test(text[pos]) || (pos > 0 && !/\s/.test(text[pos - 1]))) continue;
      RC_STREET_AT_RE.lastIndex = pos;
      const mm = RC_STREET_AT_RE.exec(text);
      if (mm && pos + mm[0].length <= idx && idx - (pos + mm[0].length) <= 4) {
        found = { street: mm[1].replace(/\s+/g, ' ').trim(), start: pos };
        break;
      }
    }
    if (found) {
      chosen = idx;
      street = found.street;
      streetStart = found.start;
      break;
    }
  }
  if (street) {
    out.street = street;
    // Facility name: the text between the stop's section label and
    // the street number.
    const before = text.slice(Math.max(0, streetStart - 100), streetStart);
    RC_STOP_LABEL_RE.lastIndex = 0;
    let lm;
    let labelEnd = -1;
    while ((lm = RC_STOP_LABEL_RE.exec(before))) labelEnd = lm.index + lm[0].length;
    if (labelEnd >= 0) out.warehouse = cleanRcFacility(before.slice(labelEnd));
  }
  // Appointment time + the stop's reference number sit in the stop
  // block, just after the address — and never past the OTHER stop's
  // address, so a close-together delivery block can't leak its time
  // or number into the pickup (or the reverse).
  let afterEnd = chosen + 420;
  if (cutIdx && cutIdx > chosen && cutIdx < afterEnd) afterEnd = cutIdx;
  const after = text.slice(chosen, afterEnd);
  const afterFull = text.slice(chosen, chosen + 420);
  // Appointment time, strongest signal first:
  // 1. Anchored to the stop's OWN date — brokers print the stop as
  //    "Date: 11/19/2026 Time: 2:00 PM", "11/19/2026 @ 14:00" or
  //    "11/19/2026 2:00 PM". The time must follow that date within a
  //    few characters (an optional "Time:"/"Appt:" label between),
  //    so a neighbouring "Shipping/Receiving Hours: 08:00-16:00"
  //    range can never win. This search runs on the UNCUT window:
  //    the anchor date makes the other stop's time unreachable (its
  //    date differs, or precedes this window), while the cut itself
  //    can land mid-time when the other stop's city capture starts
  //    early ("...2:00 PM Consignee Delivery Pendleton, IN").
  if (expectedDate) {
    for (const tok of rcDateTokens(afterFull)) {
      if (tok.iso !== expectedDate) continue;
      const tail = afterFull.slice(tok.idx + tok.len, tok.idx + tok.len + 30);
      const dm = /^[^0-9A-Za-z]{0,4}(?:at\s+|time\s*[:\-]?\s*|appt\.?\s*[:\-]?\s*)?(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(tail);
      if (dm) { out.time = rcTimeToHHMM(dm[1], dm[2], dm[3]); break; }
    }
  }
  // 2. Behind an appointment label. A window ("2:00 PM - 3:00 PM",
  //    "14:00 - 15:00") yields its START — the lazy span lands on
  //    the first time after the label. FCFS stops print no
  //    appointment time ("Appointment Time:" left blank) and keep
  //    the defaults.
  if (!out.time) {
    const tm = /(?:appointment|appt\.?|date\/time|sched(?:uled)?)\D{0,30}?(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(after)
      || /\b(?:pickup|delivery)?\s*time\s*[:\-]\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(after)
      || /\d{1,2}\/\d{1,2}\/\d{2,4}\s*@\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/.exec(after);
    if (tm) out.time = rcTimeToHHMM(tm[1], tm[2], tm[3]);
  }
  const bareRef = loadRef ? String(loadRef).toUpperCase().replace(/^LXL-/, '') : null;
  const numRes = [
    /\bref(?:erence)?\s*#\s*([A-Z0-9][A-Z0-9-]{2,24})/i,
    /\b(?:facility|shipper|pickup|delivery|consignee|receiver)\s+ref(?:erence)?\s*(?:#|no\.?|number)\s*:?\s*([A-Z0-9][A-Z0-9-]{2,24})/i,
    /\bappt(?:ointment)?\s+notes?\s*[:#]\s*([A-Z0-9][A-Z0-9-]{2,24})/i,
    /\b(?:pickup|delivery)\s*(?:#|no\.?|number)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,24})/i,
  ];
  for (const re of numRes) {
    const nm = re.exec(after);
    // A real stop number carries a digit; pure-letter captures are
    // regex bleed from words like "Reference" itself.
    if (nm && nm[1] && /\d/.test(nm[1]) && (!bareRef || nm[1].toUpperCase() !== bareRef)) {
      out.number = nm[1].toUpperCase();
      break;
    }
  }
  return out;
}
// The load fields an RC's stop blocks provide: full street address
// when the document prints one (else city/state/ZIP, as before), the
// facility name, the stop's reference number, and its appointment
// time (else the long-standing 09:00 pickup / 17:00 delivery
// defaults).
function rcStopLoadFields(f) {
  const p = f.places[0];
  const d = f.places[f.places.length - 1];
  const pd = f.pickupDetail || {};
  const dd = f.deliveryDetail || {};
  const loc = (place, det) => (det.street
    ? `${det.street}, ${place.city}, ${place.state}${place.zip ? ' ' + place.zip : ''}`
    : `${place.city}, ${place.state}${place.zip ? ' ' + place.zip : ''}`);
  return {
    pickupLocation: loc(p, pd),
    pickupWarehouse: pd.warehouse || null,
    pickupNumber: pd.number || null,
    pickupTime: pd.time || '09:00',
    deliveryLocation: loc(d, dd),
    deliveryWarehouse: dd.warehouse || null,
    deliveryNumber: dd.number || null,
    deliveryTime: dd.time || '17:00',
  };
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
  const places = extractRcPlaces(text || '', subject || '');
  const dates = extractRcDates(text || '');
  // Full stop details (facility, street, appointment time, stop
  // reference number) for the first pickup and the last delivery.
  // Each stop's search window ends where the other stop's address
  // begins, and its time is anchored to its own date (the first
  // date for the pickup, the last for the delivery — the same
  // pairing the load dates have always used).
  let pickupDetail = null;
  let deliveryDetail = null;
  if (text && places.length >= 2) {
    const dOcc = rcPlaceOccurrences(text, places[places.length - 1]);
    pickupDetail = extractRcStopDetail(text, places[0], loadRef, dates[0], dOcc.length ? dOcc[0] : 0);
    deliveryDetail = extractRcStopDetail(text, places[places.length - 1], loadRef, dates[dates.length - 1] || dates[0], 0);
  }
  return {
    lxlRef: lxl ? 'LXL-' + lxl[1] : null,
    loadRef,
    truckNo: truck ? truck[1] : null,
    trailerNo: trailer ? trailer[1] : null,
    driverHint: /\bakash/i.test(all) ? 'akash' : /\barsh/i.test(all) ? 'arsh' : null,
    places,
    dates,
    pickupDetail,
    deliveryDetail,
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
// Owner's RECENT-ONLY rule (2026-11-19): the bulk RC import pulls
// only the recent/latest rate confirmations arriving in the
// mailboxes — never a full-history sweep. Old mailbox RCs include
// cancelled / not-legit loads the owner then had to delete by hand.
// An email counts as recent when it arrived within the last
// RC_IMPORT_RECENT_DAYS days of the import run (the owner first set
// a 7-day window, then corrected it to 3 days on 2026-11-19).
const RC_IMPORT_RECENT_DAYS = 3;
function rcMessageIsRecent(receivedDateTime, nowMs = Date.now()) {
  const t = Date.parse(receivedDateTime || '');
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= RC_IMPORT_RECENT_DAYS * 24 * 60 * 60 * 1000;
}
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

// One budgeted step of the bulk RC import state machine (sched ->
// rc -> bol across every connected mailbox). This is the single
// internal entry point shared by the admin route below — which the
// portal drives one step per HTTP call — and the daily scheduler
// further down, which drives it in-process until the run completes.
// Steps are single-flight: rcImportStepRunning makes a step requested
// mid-step return { busy: true } without touching any state, so the
// route and the scheduler can never execute the import in parallel.
// rawState is a parsed cursor object (or null); resumeSaved mirrors
// the route's no-cursor call — resume the persisted run's saved
// cursor instead of starting over.
let rcImportStepRunning = false;
async function runRcImportStep(rawState, { resumeSaved = false } = {}) {
  if (rcImportStepRunning) return { busy: true };
  rcImportStepRunning = true;
  try {
    let state = rawState && typeof rawState === 'object' && rawState.phase ? rawState : null;
    if (!state) state = { runId: null, phase: 'sched', m: 0, link: null };
    const run = rcImportRun(state.runId);
    if (resumeSaved && run.savedCursor && run.savedCursor.phase) state = { ...run.savedCursor, runId: run.id };
    state.runId = run.id;
    const counts = { imported: 0, loadsCreated: 0, alreadyHave: 0, notRc: 0, skipped: 0, skippedOld: 0, heldOut: 0, skippedSubjects: [], heldOutSubjects: [], bolsAdded: 0, bolsDuplicate: 0, bolsUnmatched: 0, bolsUnmatchedSubjects: [] };
    const deadline = Date.now() + 40000;
    let processed = 0;
    const finish = (done) => {
      const nextCursor = done ? null : Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
      if (done) db.prepare('DELETE FROM rc_import_runs WHERE id = ?').run(run.id);
      else { run.cursorJson = JSON.stringify(state); saveRcImportRun(run); }
      return {
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
      };
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
      let hitOldBoundary = false;
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
            if (!load || !load.driverId) {
              // No load — or the load is still UNASSIGNED (created
              // from an RC with no driver/truck on it): documents
              // require a driver, so its BOLs wait until an admin
              // assigns the load.
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
          if (!rcMessageIsRecent(m.receivedDateTime)) {
            // RECENT-ONLY (owner, 2026-11-19): this email arrived
            // more than RC_IMPORT_RECENT_DAYS ago — it is never
            // imported, only tallied as skippedOld. Pages are
            // newest-first, so every later message in this mailbox
            // is older still: hitOldBoundary stops the paging below
            // instead of sweeping the mailbox's whole history.
            run.examined.add(exKey);
            counts.skippedOld += 1;
            hitOldBoundary = true;
            continue;
          }
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
              // Owner's CORRECTED rule (2026-11-19): the OTR paid
              // schedule is only for Cash Flow — it is NOT a gate for
              // rate confirmations. Every genuine RC imports from the
              // emails without it; one that is not on a schedule is
              // only tallied as `unverified` after import below. (The
              // 2026-11-16/17 schedule hold-out was removed.)
              let load = null;
              if (f.lxlRef) load = db.prepare('SELECT * FROM loads WHERE reference = ?').get(f.lxlRef);
              if (!load && f.loadRef) load = db.prepare('SELECT * FROM loads WHERE reference = ?').get(lxlLoadRef(f.loadRef));
              if (!load && f.loadRef) load = db.prepare('SELECT * FROM loads WHERE reference = ?').get(f.loadRef);
              if (!load && (f.lxlRef || f.loadRef) && f.places.length >= 2 && f.dates.length >= 1) {
                const driverId = resolveImportedDriverId(f);
                const pDate = f.dates[0];
                const dDate = f.dates[f.dates.length - 1] || f.dates[0];
                const sf = rcStopLoadFields(f);
                const id = db.prepare(
                  "INSERT INTO loads (reference, driverId, pickupLocation, pickupWarehouse, pickupAt, pickupTimezone, pickupNumber, deliveryLocation, deliveryWarehouse, deliveryAt, deliveryTimezone, deliveryNumber, notes, status, completedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)",
                ).run(lxlLoadRef(f.lxlRef || f.loadRef), driverId,
                  sf.pickupLocation, sf.pickupWarehouse, `${pDate}T${sf.pickupTime}:00`, 'America/Indiana/Indianapolis', sf.pickupNumber,
                  sf.deliveryLocation, sf.deliveryWarehouse, `${dDate}T${sf.deliveryTime}:00`, 'America/Indiana/Indianapolis', sf.deliveryNumber,
                  'Imported from a rate confirmation email', `${dDate}T${sf.deliveryTime}:00`, now()).lastInsertRowid;
                load = db.prepare('SELECT * FROM loads WHERE id = ?').get(id);
                counts.loadsCreated += 1;
                if (!driverId) {
                  // Owner's auto-assign rule (2026-11-19): no driver
                  // name and no truck/trailer number on the RC — the
                  // load is created UNASSIGNED and the admins get a
                  // bell notification to assign it by hand.
                  counts.loadsUnassigned = (counts.loadsUnassigned || 0) + 1;
                  notifyAdmins(
                    'load_needs_assignment',
                    'Load needs a driver',
                    `${load.reference} · ${load.pickupLocation} → ${load.deliveryLocation} — created from a rate confirmation with no driver or truck number on it. Assign a driver.`,
                    'loads',
                    load.id,
                  );
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
      if (state.phase === 'rc' && hitOldBoundary) {
        // RECENT-ONLY: the rc phase reached emails older than the
        // window and the mailbox is paged newest-first, so the rest
        // of it is older still — stop paging this mailbox instead of
        // sweeping its full history.
        state.link = null;
        state.m += 1;
      } else {
        state.link = page['@odata.nextLink'] || null;
        if (!state.link) state.m += 1;
      }
    }
    return finish(false);
  } finally {
    rcImportStepRunning = false;
  }
}

admin.post('/rate-confirmations/import-all', async (req, res) => {
  try {
    const body = req.body || {};
    let state = null;
    if (body.cursor) {
      try { state = JSON.parse(Buffer.from(String(body.cursor), 'base64url').toString('utf8')); } catch { state = null; }
    }
    const step = await runRcImportStep(state, { resumeSaved: !body.cursor });
    if (step.busy) {
      // A step is executing this instant (another admin call, or the
      // daily scheduler driving the same run in-process). Answer with
      // a no-progress step that hands the client back its position —
      // its driver loop simply calls again; nothing was touched. The
      // echoed cursor is the client's own when it sent one, else the
      // persisted run's saved cursor, else a fresh state.
      const savedRow = db.prepare('SELECT cursor FROM rc_import_runs ORDER BY startedAt DESC LIMIT 1').get();
      let echoState = state && state.phase ? state : null;
      if (!echoState && savedRow && savedRow.cursor) { try { echoState = JSON.parse(savedRow.cursor); } catch { echoState = null; } }
      if (!echoState || !echoState.phase) echoState = { runId: null, phase: 'sched', m: 0, link: null };
      return res.json({
        imported: 0, loadsCreated: 0, alreadyHave: 0, notRc: 0, skipped: 0, skippedOld: 0, heldOut: 0, skippedSubjects: [], heldOutSubjects: [], bolsAdded: 0, bolsDuplicate: 0, bolsUnmatched: 0, bolsUnmatchedSubjects: [],
        phase: echoState.phase,
        mailboxes: [],
        mailboxErrors: [],
        lastSkip: '',
        nextCursor: Buffer.from(JSON.stringify(echoState), 'utf8').toString('base64url'),
        done: false,
        busy: true,
      });
    }
    return res.json(step);
  } catch (e) {
    if (e.status) return err(res, e.status, e.message);
    console.error('ratecon import-all failed', e);
    return err(res, 500, 'Import failed — try again');
  }
});

// ---------------------------------------------------------------------------
// Daily automatic RC import (owner, 2026-11-19): the server checks the
// connected mailboxes BY ITSELF once a day — at ~06:00 America/Chicago
// — and imports the recent rate confirmations through the very same
// import-all machinery above: same phases, blocklist, dedupe, 3-day
// recency, no OTR gate, and the assignment + admin-notification
// behavior. No admin session and no manual trigger are involved — the
// scheduler drives runRcImportStep in-process until the run completes.
//
// Overlap safety: steps are single-flight (a step requested mid-step
// returns { busy: true } and this driver waits), and the run itself
// is the persisted, resumable state machine — so when a run is
// already in progress (an admin importing from the portal, or an
// earlier daily run cut short by a deploy), the daily driver
// CONTINUES that run from its saved cursor instead of starting a
// parallel one. If the portal finishes the run between this driver's
// steps, the run row disappears and the driver treats that as
// completion rather than starting a second run.
//
// When it fires: maybeRunDailyRcImport is called on boot and then
// every 30 minutes (the Relay sync pattern). It starts the import
// only when the Chicago time is at/after RC_DAILY_IMPORT_HOUR AND the
// persisted last-daily date (meta) is not today — so a boot/deploy
// fires ONLY as a catch-up when today's run was missed, and a normal
// day sees exactly one run, at ~06:00 Chicago.
// ---------------------------------------------------------------------------
const RC_DAILY_IMPORT_HOUR = (() => { const h = Number(process.env.RC_DAILY_IMPORT_HOUR); return Number.isFinite(h) && h >= 0 ? h : 6; })();
const RC_DAILY_IMPORT_CHECK_MS = 30 * 60 * 1000;
const RC_IMPORT_LAST_DAILY_KEY = 'rc_import_last_daily_date';

function rcChicagoNow(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowMs));
  const part = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) % 24 };
}

function rcDailyImportDue(nowMs = Date.now()) {
  const { date, hour } = rcChicagoNow(nowMs);
  if (hour < RC_DAILY_IMPORT_HOUR) return false;
  return getMeta(db, RC_IMPORT_LAST_DAILY_KEY) !== date;
}

let rcDailyImportRunning = false;
async function runDailyRcImport() {
  if (rcDailyImportRunning) return;
  rcDailyImportRunning = true;
  const { date } = rcChicagoNow();
  const totals = { imported: 0, loadsCreated: 0, alreadyHave: 0, notRc: 0, skipped: 0, skippedOld: 0, heldOut: 0, bolsAdded: 0, loadsUnassigned: 0 };
  try {
    const existing = db.prepare('SELECT id FROM rc_import_runs ORDER BY startedAt DESC LIMIT 1').get();
    console.log(`[rc-import] daily import starting for ${date}${existing ? ` — continuing in-progress run ${existing.id}` : ' — fresh run'}`);
    let done = false;
    const stopAt = Date.now() + 25 * 60 * 1000;
    while (!done && Date.now() < stopAt) {
      const step = await runRcImportStep(null, { resumeSaved: true });
      if (step.busy) {
        // A portal-driven step holds the single flight right now —
        // wait for it; the run's saved cursor keeps our place.
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const k of Object.keys(totals)) totals[k] += step[k] || 0;
      if (step.done) { done = true; break; }
      // The run row disappears when a run completes. If it is gone
      // without our step reporting done, the portal drove the same
      // run to completion between our steps — that is completion;
      // do NOT start a second run.
      if (!db.prepare('SELECT id FROM rc_import_runs LIMIT 1').get()) { done = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (done) {
      setMeta(db, RC_IMPORT_LAST_DAILY_KEY, date);
      console.log(`[rc-import] daily import finished for ${date}: imported=${totals.imported} loadsCreated=${totals.loadsCreated} alreadyHave=${totals.alreadyHave} notRc=${totals.notRc} skipped=${totals.skipped} skippedOld=${totals.skippedOld} heldOut=${totals.heldOut} bolsAdded=${totals.bolsAdded} loadsUnassigned=${totals.loadsUnassigned}`);
    } else {
      console.log(`[rc-import] daily import for ${date} not finished within the step budget — the persisted run continues on the next check (imported=${totals.imported} loadsCreated=${totals.loadsCreated} so far)`);
    }
  } catch (e) {
    console.error('[rc-import] daily import failed:', (e && e.message) || e);
  } finally {
    rcDailyImportRunning = false;
  }
}

function maybeRunDailyRcImport() {
  if (rcDailyImportRunning) return;
  if (!rcDailyImportDue()) return;
  void runDailyRcImport();
}


// Add-RC auto-load (owner, 2026-11-16): when a dispatcher picks a rate
// confirmation from email (or uploads the file) without choosing a
// load, the system creates the load FROM the rate confirmation —
// LXL- reference from the broker load number, full pickup/delivery
// addresses from the RC's pickup/delivery sections, driver from the
// name / truck / trailer on the RC — as an ACTIVE load, and files the
// RC on it. If a load with that reference already exists, the RC
// simply attaches to it. Auto-assign rule (owner, 2026-11-19): if
// the RC names no driver and no truck/trailer number, the load is
// created UNASSIGNED and the admins are notified to assign it.
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
  const pDate = f.dates[0];
  const dDate = f.dates[f.dates.length - 1] || f.dates[0];
  const sf = rcStopLoadFields(f);
  const id = db.prepare(
    "INSERT INTO loads (reference, driverId, pickupLocation, pickupWarehouse, pickupAt, pickupTimezone, pickupNumber, deliveryLocation, deliveryWarehouse, deliveryAt, deliveryTimezone, deliveryNumber, notes, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
  ).run(ref, driverId, sf.pickupLocation, sf.pickupWarehouse, `${pDate}T${sf.pickupTime}:00`, 'America/Indiana/Indianapolis', sf.pickupNumber,
    sf.deliveryLocation, sf.deliveryWarehouse, `${dDate}T${sf.deliveryTime}:00`, 'America/Indiana/Indianapolis', sf.deliveryNumber,
    'Created from a rate confirmation', now()).lastInsertRowid;
  load = db.prepare('SELECT * FROM loads WHERE id = ?').get(id);
  if (driverId) {
    notifyDriver(db, driverId, 'load_assigned', 'New load assigned', `Load ${load.reference}: ${load.pickupLocation} → ${load.deliveryLocation}.`).catch(() => {});
  } else {
    // Owner's auto-assign rule (2026-11-19): no driver name and no
    // truck/trailer number on the RC — the load is still created,
    // left UNASSIGNED, and the admins get a bell notification to
    // assign it by hand. Never guess a driver.
    notifyAdmins(
      'load_needs_assignment',
      'Load needs a driver',
      `${load.reference} · ${load.pickupLocation} → ${load.deliveryLocation} — created from a rate confirmation with no driver or truck number on it. Assign a driver.`,
      'loads',
      load.id,
    );
  }
  return { load, created: true, unassigned: !driverId };
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
    res.status(201).json(auto ? { ...rc, loadCreated: auto.created, loadUnassigned: !!auto.unassigned, loadReference: auto.load.reference, loadRoute: auto.load.pickupLocation + ' → ' + auto.load.deliveryLocation } : rc);
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

function conversationRecipients(messages, ownEmails) {
  // Everyone in the conversation chain except the mailbox owner: every
  // sender and every To/Cc recipient across ALL messages in the thread,
  // deduped by address. Senders come first (newest sender first — the
  // primary contact), then the remaining recipients in thread order.
  // The owner sends to all of them, not just the last person who wrote.
  const own = new Set((ownEmails || []).filter(Boolean).map((e) => String(e).toLowerCase()));
  const seen = new Map();
  const add = (ea) => {
    if (!ea || !ea.address) return;
    const key = String(ea.address).toLowerCase();
    if (own.has(key) || seen.has(key)) return;
    seen.set(key, { name: ea.name || ea.address, email: ea.address });
  };
  const sorted = [...messages].sort((a, b) => new Date(b.receivedDateTime || 0) - new Date(a.receivedDateTime || 0));
  for (const m of sorted) add(m.from && m.from.emailAddress);
  for (const m of sorted) {
    for (const r of m.toRecipients || []) add(r && r.emailAddress);
    for (const r of m.ccRecipients || []) add(r && r.emailAddress);
  }
  return [...seen.values()];
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
      `/me/messages?${q({ $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`, $top: '50', $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview' })}`,
    );
    const msgs = [...(data.value || [])].sort((a, b) => new Date(a.receivedDateTime || 0) - new Date(b.receivedDateTime || 0));
    const contact = conversationContact(msgs, user.outlookEmail);
    const recipients = conversationRecipients(msgs, [user.outlookEmail, user.email]);
    const own = (user.outlookEmail || '').toLowerCase();
    res.json({
      conversationId,
      subject: (msgs[0] && msgs[0].subject) || '(no subject)',
      toName: contact.name,
      toEmail: contact.email,
      recipients,
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

// Portal-sent mail carries the signature the portal appended, not the
// one Outlook currently uses, so it must never count as sync evidence.
// Three tells: the stamp the portal now embeds in its own sends; the
// appended signature div sitting directly against the note's </p>
// (Outlook always wraps its own text in divs before the signature);
// and an extracted block that contains the stored signature verbatim.
function isPortalSentBody(html) {
  if (!html) return false;
  if (html.includes('lxl-portal-sent')) return true;
  const own = String(html).split('divRplyFwdMsg')[0];
  const markers = ['id="ms-outlook-mobile-signature"', "id='ms-outlook-mobile-signature'", 'id="Signature"', 'id="x_Signature"'];
  for (const mk of markers) {
    const i = own.indexOf(mk);
    if (i === -1) continue;
    const start = own.lastIndexOf('<div', i);
    return start > 0 && own.slice(Math.max(0, start - 4), start) === '</p>';
  }
  return false;
}

// The admin's signature, AUTO-SYNCED from Outlook (owner, 2026-11-19):
// on every send, re-read the sender's newest sent mail and mirror the
// signature Outlook is currently putting on their emails, so changing
// the signature in Outlook updates the portal by itself — nobody has to
// ask for a re-sync. Portal-sent messages are skipped as evidence: they
// carry a stamped marker, and an unstamped older one is recognised
// because its extracted block contains the stored signature verbatim
// (the portal appended it) instead of being a fresh capture of it.
async function getUserSignatureHtml(user, readToken) {
  const stored = user.emailSignatureHtml || null;
  try {
    const data = await outlookGraph(readToken, '/me/mailFolders/sentitems/messages?$top=10&$select=body,receivedDateTime');
    const msgs = (data.value || []).slice().sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));
    for (const msg of msgs) {
      const html = msg.body && msg.body.content;
      if (!html || isPortalSentBody(html)) continue;
      const sig = extractSignatureHtml(html);
      if (!sig) continue;
      if (!stored) {
        db.prepare('UPDATE users SET emailSignatureHtml = ? WHERE id = ?').run(sig, user.id);
        return sig;
      }
      if (sig === stored) return stored;
      if (sig.includes(stored)) continue;
      db.prepare('UPDATE users SET emailSignatureHtml = ? WHERE id = ?').run(sig, user.id);
      return sig;
    }
  } catch { /* the signature is optional — fall back to the stored copy */ }
  return stored;
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
      `/me/messages?${q({ $filter: `conversationId eq '${String(conversationId).replace(/'/g, "''")}'`, $top: '50', $select: 'id,receivedDateTime,from,toRecipients,ccRecipients' })}`,
    );
    const threadMsgs = latest.value || [];
    const lastMsg = threadMsgs.slice().sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime))[0];
    if (!lastMsg) return err(res, 404, 'That conversation could not be found');
    // The email goes to EVERYONE in the conversation chain, not just
    // the last person who wrote (owner's rule, 2026-11-19).
    const recipients = conversationRecipients(threadMsgs, [user.outlookEmail, user.email]);
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
      body: { contentType: 'html', content: `<!-- lxl-portal-sent --><p>${escHtml}</p>` + (sigHtml || '<br>') + existing },
    });
    // createReply alone would address only the newest message's sender;
    // widen the draft to every participant in the chain. If this fails
    // the whole send fails (the draft is cleaned up below) rather than
    // silently emailing one person.
    if (recipients.length) {
      await outlookGraphReq(sendToken, 'PATCH', `/me/messages/${encodeURIComponent(draftId)}`, {
        toRecipients: recipients.map((r) => ({ emailAddress: { address: r.email, name: r.name } })),
      });
    }
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
    let best = cleanRateText(await pdfTextFromBuffer(buf));
    if (best.length >= 200) return best;
    // Scanned / image-only PDF: no usable text layer. Read the page
    // images with OCR instead — slower, but the document still counts.
    try {
      const ocr = cleanRateText(await ocrPdfImagesQueued(buf));
      if (ocr.length > best.length) best = ocr;
    } catch (e) {
      console.error('pdf OCR fallback failed', e);
    }
    if (best.length >= 200) return best;
    // Print-to-PDF documents (e.g. Microsoft Print to PDF) keep their
    // values as vector glyphs — no text layer and no embedded image —
    // so only a rendered page shows them. Rasterize the pages and OCR
    // the renders (owner, 2026-11-23: an uploaded rate confirmation
    // the system "cannot read" is exactly this case).
    try {
      const raster = cleanRateText(await ocrPdfPagesQueued(buf));
      if (raster.length > best.length) best = raster;
    } catch (e) {
      console.error('pdf raster OCR fallback failed', e);
    }
    return best;
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
  // Plate: try the labelled forms in order. The capture may not contain
  // spaces — a space means the match slid into the next label (the old
  // single pattern captured "PLATE NUMBER" / "NUMBER" off a card reading
  // "LICENSE PLATE NUMBER: PG46309" and then failed the digit check, so
  // no plate was ever read).
  const platePatterns = [
    /\blicen[cs]e\s+plate\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-]{3,9})/i,
    /\bplate\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-]{3,9})/i,
    /\blicen[cs]e\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-]{3,9})/i,
  ];
  for (const re of platePatterns) {
    const m = flat.match(re);
    if (!m) continue;
    const p = m[1].trim().toUpperCase();
    if (/[0-9]/.test(p) && p.length >= 4 && p.length <= 10 && !/^(NUMBER|PLATE|LICENSE|STATE|CLASS)$/.test(p)) { out.plate = p; break; }
  }
  // Indiana IRP cab cards extract column-flattened: every label prints
  // in one block and every value in another, so the plate is nowhere
  // near its "APPORTIONED LICENSE PLATE NO." label. In the values block
  // the order is fixed — VIN, ZIP+4, PLATE, then "UNLADEN WEIGHT" —
  // verified against the extracted text of the 1301/1302/5302 cards
  // (unitplate3 diagnostic, 2026-11-17). Use it as a fallback whenever
  // a VIN was read but no labelled plate matched.
  if (!out.plate && out.vin) {
    const vi = upper.indexOf(out.vin);
    if (vi >= 0) {
      const win = upper.slice(vi, vi + 220);
      const m = win.match(/\b\d{5}-\d{4}\s+([A-Z0-9][A-Z0-9\-]{3,9})\s+UNLADEN\b/);
      if (m && /[0-9]/.test(m[1])) out.plate = m[1];
    }
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

const EQUIP_DOC_TYPES = ['cab_card', 'registration', 'insurance', 'annual_inspection', 'ifta', 'title', 'permit', 'permit_nm', 'permit_ky', 'permit_ct', 'permit_ny_hut', 'other'];
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

// Relay Payments: read the imported fuel transactions (newest first),
// and run one sync on demand. Import/read only — Relay fuel never
// posts to Cash Flow from here. Responses carry counts only, never any
// key material; with RELAY_API_KEY unset the sync reports enabled:false.
admin.get('/relay/transactions', (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM relay_transactions ORDER BY created_at DESC, id DESC LIMIT 200')
    .all();
  res.json(rows.map(serializeRelayTransaction));
});

admin.post('/relay/sync', async (_req, res) => {
  const result = await syncRelayTransactions();
  res.json({ ok: true, ...result });
});

// Active Relay fuel codes for one driver (build 34, URGENT owner ask
// 2026-11-18): the build-33 server never stored a code's Relay id, so
// the only way to find — and cancel — a live code (the test code
// issued on the owner's own driver account that afternoon) is Relay's
// LIST endpoint:
//   GET /api/integrations/fuelcodes/?driver_id={dr_id}
//       &dtstart={today 00:00 ET, RFC3339}&dtend={now, RFC3339}
// The date params are REQUIRED, and the endpoint returns codes in
// active or locked status. The full code value is returned to the
// admin portal on purpose: this is the company's own admin surface,
// and Relay's own app displays the full code too. On 404 the
// /api/fuel/ mount is tried as well (the same base-path uncertainty
// as the policy read). Relay errors surface honestly as 502s with
// Relay's message.
admin.get('/relay/fuel-codes', async (req, res) => {
  const userId = relayText(req.query?.user_id);
  if (!userId) return err(res, 400, 'user_id is required.');
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!target) return err(res, 404, 'Driver not found.');
  const relayId = relayText(target.relay_driver_id);
  if (!relayId) return err(res, 409, 'That driver has no Relay Driver ID on file.');
  const apiKey = process.env.RELAY_API_KEY;
  if (!apiKey) return err(res, 503, 'Relay is not configured on the server yet.');
  const driverId = await resolveRelayDriverId(apiKey, relayId);
  if (!driverId) {
    return err(
      res,
      502,
      'Relay could not match that driver yet — no Relay driver record or transaction found.',
    );
  }
  const qs =
    '?driver_id=' +
    encodeURIComponent(driverId) +
    '&dtstart=' +
    encodeURIComponent(relayEtStartOfTodayRfc3339()) +
    '&dtend=' +
    encodeURIComponent(new Date().toISOString());
  const attempts = [
    RELAY_FUEL_CODES_URL + qs,
    RELAY_API_BASE + '/api/fuel/fuelcodes/' + qs,
  ];
  let lastMsg = null;
  for (const url of attempts) {
    let resp;
    let data = null;
    try {
      resp = await fetch(url, {
        headers: { Authorization: apiKey },
        signal: AbortSignal.timeout(20000),
      });
      data = await resp.json().catch(() => null);
    } catch (e) {
      console.error(
        `Relay fuel codes list: request failed for user ${target.id}: ${e?.message || 'unknown error'}`,
      );
      return err(res, 502, 'Could not reach Relay to list fuel codes.');
    }
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data?.data)
          ? data.data
          : null;
    console.log(
      `Relay fuel codes list: ${url.replace(RELAY_API_BASE, '').split('?')[0]} -> HTTP ${resp.status}, ` +
        (list
          ? `${list.length} code(s)`
          : `keys: ${data && typeof data === 'object' ? Object.keys(data).join(',') : '(none)'}`),
    );
    if (resp.ok) {
      const codes = (list || [])
        .map((c) => ({
          code_id: relayText(c?.id),
          code: relayText(c?.code),
          constraint_amount: relayText(c?.constraint_amount),
          type: relayText(c?.type),
          status: relayText(c?.status),
          created_at: relayText(c?.created_at),
        }))
        .filter((c) => c.code_id);
      return res.json(codes);
    }
    if (resp.status === 404) {
      lastMsg =
        relayText(data?.message) || relayText(data?.error) || relayText(data?.detail) || lastMsg;
      continue;
    }
    const relayMsg =
      relayText(data?.message) || relayText(data?.error) || relayText(data?.detail);
    return err(
      res,
      502,
      relayMsg ? `Relay said: ${relayMsg}` : `Relay answered HTTP ${resp.status} listing fuel codes.`,
    );
  }
  return err(
    res,
    502,
    lastMsg ? `Relay said: ${lastMsg}` : 'Relay could not list fuel codes.',
  );
});

// Admin cancel of a driver's one-time Relay code — the same Relay
// DELETE as the driver route (shared helper above), audit-logged
// into relay_fuel_code_cancellations with the ADMIN's user id in the
// driver_id column (the code's driver is identifiable from Relay's
// own records via the reference).
admin.post('/relay/fuel-codes/cancel', async (req, res) => {
  const apiKey = process.env.RELAY_API_KEY;
  if (!apiKey) return err(res, 503, 'Relay is not configured on the server yet.');
  const codeId = relayText(req.body?.code_id);
  if (!codeId || !codeId.startsWith('code_')) {
    return err(res, 400, 'That fuel code reference looks invalid.');
  }
  const result = await relayDeleteFuelCode(apiKey, codeId);
  if (result.networkError) {
    console.error(
      `Relay admin fuel code cancel: request to Relay failed for admin ${req.user.id}: ${result.error?.message || 'unknown error'}`,
    );
    return err(res, 502, 'Could not reach Relay to cancel the code.');
  }
  if (!result.ok) {
    console.error(
      `Relay admin fuel code cancel: Relay API answered HTTP ${result.status} for admin ${req.user.id}` +
        (result.relayMsg ? `: ${result.relayMsg}` : ''),
    );
    return err(
      res,
      502,
      result.relayMsg
        ? `Relay said: ${result.relayMsg}`
        : 'Relay could not cancel that code. It may already be in use at the pump.',
    );
  }
  try {
    db.prepare(
      'INSERT INTO relay_fuel_code_cancellations (driver_id, driver_integration_id, relay_reference, created_at) VALUES (?, ?, ?, ?)',
    ).run(req.user.id, null, codeId, now());
  } catch (e) {
    console.error('Relay admin fuel code cancel: audit log insert failed', e);
  }
  console.log(`Relay fuel code cancelled by admin ${req.user.id} (ref ${codeId})`);
  res.json({ ok: true });
});

app.use('/api/admin', admin);

// ---------------------------------------------------------------------------
// Files — token required; caller must own the file or be an admin.
// ---------------------------------------------------------------------------
// The one access rule for a file, shared by the file route itself and by
// the download-token mint below: admins reach everything; a driver only
// their own files, their units' equipment documents, and their own
// profile photo.
function canAccessFile(user, file) {
  if (user.role === 'admin') return true;
  if (file.driverId === user.id) return true;
  if (file.ownerType === 'equipment') {
    const doc = db.prepare('SELECT * FROM equipment_documents WHERE fileId = ?').get(file.id);
    if (doc) {
      const table = doc.unitType === 'truck' ? 'trucks' : 'trailers';
      const unit = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(doc.unitId);
      if (unit && unit.driverId === user.id) return true;
    }
  }
  // The caller's own profile photo: the files row can predate the
  // current account (photo uploaded by a very old build, account
  // later recreated), leaving the row's driverId pointing at a dead
  // user id. users.photoUrl pointing at this exact file proves the
  // photo is the caller's own, so allow it.
  const me = db.prepare('SELECT photoUrl FROM users WHERE id = ?').get(user.id);
  return !!(me && me.photoUrl === `/files/${file.id}`);
}

// One-time download links. A portal Download click cannot ride a plain
// <a href> — file auth is a Bearer header — and the old fallback
// (fetch → blob → synthetic anchor click) does not actually save the
// file in every browser: Safari drops the programmatic blob download
// while View, which opens the same blob in a tab, works (owner report,
// 2026-11-19: every rate confirmation views fine but won't download).
// So the portal mints a single-use token bound to one file (60 s) and
// navigates to /files/:id?download=1&dt=… — the browser then saves the
// server's attachment response natively, with its own download UI.
const fileDownloadTokens = new Map(); // token -> { fileId, userId, expiresAt }
function pruneFileDownloadTokens() {
  const t = Date.now();
  for (const [k, v] of fileDownloadTokens) if (v.expiresAt <= t) fileDownloadTokens.delete(k);
}

app.post('/files/:id/download-token', auth, (req, res) => {
  const file = getFileRow(req.params.id);
  if (!file) return err(res, 404, 'File not found');
  if (!canAccessFile(req.user, file)) return err(res, 403, 'Forbidden');
  pruneFileDownloadTokens();
  const token = crypto.randomBytes(24).toString('base64url');
  fileDownloadTokens.set(token, { fileId: file.id, userId: req.user.id, expiresAt: Date.now() + 60 * 1000 });
  res.json({ downloadUrl: `/files/${file.id}?download=1&dt=${token}` });
});

// Bearer session (via auth) OR a one-time download token from the mint
// above. A presented token is consumed whether it checks out or not,
// so a link cannot be replayed or probed.
function fileAuth(req, res, next) {
  const dt = req.query.dt;
  if (dt) {
    const rec = fileDownloadTokens.get(String(dt));
    if (rec) fileDownloadTokens.delete(String(dt));
    if (rec && rec.fileId === Number(req.params.id) && rec.expiresAt > Date.now()) {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(rec.userId);
      if (u && u.active) { req.user = u; return next(); }
    }
    return err(res, 401, 'Authentication required');
  }
  return auth(req, res, next);
}

app.get('/files/:id', fileAuth, (req, res) => {
  const file = getFileRow(req.params.id);
  if (!file) return err(res, 404, 'File not found');
  if (!canAccessFile(req.user, file)) return err(res, 403, 'Forbidden');
  const filePath = path.join(UPLOADS_DIR, file.storedFilename);
  if (!fs.existsSync(filePath)) return err(res, 404, 'File not found');
  // Sniff the real type from the file's magic bytes. Photos uploaded by
  // very old builds can be stored with no extension and a generic
  // mimeType (application/octet-stream); serving that type makes iOS
  // refuse to decode the image (the black profile photo bug). A sniffed
  // image/PDF type therefore WINS over the extension map and the stored
  // mimeType below. Generic ftyp brands are deliberately NOT sniffed —
  // voice-note .m4a/.mp4 files share the ftyp box and must keep the
  // extension-based type.
  let sniffedType = null;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const head = Buffer.alloc(16);
      const bytesRead = fs.readSync(fd, head, 0, 16, 0);
      const b = head.subarray(0, bytesRead);
      if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) sniffedType = 'image/jpeg';
      else if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) sniffedType = 'image/png';
      else if (b.length >= 4 && b.toString('latin1', 0, 4) === 'GIF8') sniffedType = 'image/gif';
      else if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') sniffedType = 'image/webp';
      else if (b.length >= 4 && b.toString('latin1', 0, 4) === '%PDF') sniffedType = 'application/pdf';
      else if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
        const brand = b.toString('latin1', 8, 12);
        if (['heic', 'heix', 'mif1', 'msf1', 'hevc'].includes(brand)) sniffedType = 'image/heic';
        else if (['avif', 'avis'].includes(brand)) sniffedType = 'image/avif';
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* sniffing is best-effort; fall through to extension/mime */ }
  // View must open inline (PDF in a browser tab); Download forces a save.
  // The stored mimeType can be generic (e.g. from an email attachment), so
  // prefer the type implied by the file extension when it is known.
  const ext = path.extname(file.storedFilename).toLowerCase();
  const extType = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.mp3': 'audio/mpeg' }[ext];
  const type = sniffedType || extType || (file.mimeType && file.mimeType !== 'application/octet-stream' ? file.mimeType : 'application/octet-stream');
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
  // Relay fuel-transaction sync: once on boot, then every 30 minutes.
  // A quiet no-op unless RELAY_API_KEY is set in the environment.
  void syncRelayTransactions();
  setInterval(() => {
    void syncRelayTransactions();
  }, RELAY_SYNC_INTERVAL_MS);
  // Daily automatic RC import (owner, 2026-11-19): checked on boot
  // and every 30 minutes; the Chicago-hour + persisted last-run-date
  // gate inside maybeRunDailyRcImport makes a boot fire ONLY as a
  // catch-up when today's ~06:00 Chicago run was missed.
  maybeRunDailyRcImport();
  setInterval(() => {
    maybeRunDailyRcImport();
  }, RC_DAILY_IMPORT_CHECK_MS);
  void (async () => { await verifyRateConStates(); await repairRateConDates(); await cleanupRateCons(); await removeCancelledScotlynnLoad(); await adjudicateRateCons(); await adjudicateRateCons2(); await adjudicateRateCons3(); await adjudicateRateCons4(); await adjudicateRateCons5(); await adjudicateRateCons6(); await adjudicateRateCons7(); await adjudicateRateCons8(); await adjudicateRateCons9(); await fixIelLoadDates(); await fixTruckPaymentCategories(); await setupFixedTruckPayments(); await fixTransportFundingFixed(); await addRtc528772Load(); await mergeRtc528772Loads(); await fixCircle2661800(); await fixRtc528772Rate(); await fixRtc528772DeliveryTime(); await fixLoad1197586Driver(); await addMissingUberLoads(); await findMissingRcFiles(); await fetchMissingRcFromMailboxes(); await fetchMissingRcFromMailboxes2(); await fetchMissingRcFromMailboxes3(); await addMissingAkashLoads(); await fetchMissingRcFinal(); await removeDispatchSheetLoads(); await fixCashflowReconciliation(); await removeOutlookFactoring2(); await dumpRc528772(); await fetchRc528772(); await fixRc528772Addresses(); await backfillDocDates(); await backfillUnitPlates(); await backfillUnitPlates2(); await dumpCabCardPlateContext(); await setVerifiedPlates(); await fixAtsRc217990(); })();
  // Re-derive active loads' gate pins with the current geocoder on
  // boot: a stale pin from a weaker geocode must not block a delivery.
  try { db.prepare("UPDATE loads SET deliveryLat = NULL, deliveryLng = NULL, pickupLat = NULL, pickupLng = NULL WHERE status = 'active'").run(); } catch { /* columns may not exist on first boot */ }
  // Photo self-heal (black-avatar fix): a profile photo whose files row
  // or on-disk file is gone can never load — the app would keep trying
  // to render it and sit on a black circle on every screen. Clear the
  // stale photoUrl at boot so the app falls back to the driver's
  // initials instead. Wrapped so it can never take the server down.
  try {
    const photoUsers = db.prepare('SELECT id, photoUrl FROM users WHERE photoUrl IS NOT NULL').all();
    for (const u of photoUsers) {
      const m = /^\/files\/(\d+)$/.exec(String(u.photoUrl).trim());
      const row = m ? getFileRow(m[1]) : null;
      if (!row || !fs.existsSync(path.join(UPLOADS_DIR, row.storedFilename))) {
        db.prepare('UPDATE users SET photoUrl = NULL WHERE id = ?').run(u.id);
        console.log(`[photo-heal] cleared stale photoUrl for user ${u.id}`);
      }
    }
  } catch (e) { console.error('[photo-heal] failed', e); }
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
