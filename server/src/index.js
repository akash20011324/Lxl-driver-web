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
  };
}

function serializeTrailer(t) {
  if (!t) return null;
  return {
    id: t.id,
    unitNumber: t.unitNumber,
    kind: t.kind ?? null,
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
    pickupAt: l.pickupAt,
    pickupTimezone: l.pickupTimezone,
    pickupNumber: l.pickupNumber ?? null,
    deliveryLocation: l.deliveryLocation,
    deliveryAt: l.deliveryAt,
    deliveryTimezone: l.deliveryTimezone,
    deliveryNumber: l.deliveryNumber ?? null,
    notes: l.notes ?? null,
    status: l.status,
    bolStatus: l.bolStatus ?? null,
    completedAt: l.completedAt ?? null,
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
  return {
    id: m.id,
    driverId: m.driverId,
    sender: m.sender,
    body: m.body,
    createdAt: m.createdAt,
    read: !!m.read,
  };
}

function serializeEquipmentDoc(d) {
  return {
    id: d.id,
    unitType: d.unitType,
    unitId: d.unitId,
    unitNumber: d.unitNumber,
    docType: d.docType,
    note: d.note ?? null,
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
    .prepare("INSERT INTO users (role, name, email, passwordHash, active, createdAt) VALUES ('admin', ?, ?, ?, 1, ?)")
    .run(name, email, bcrypt.hashSync(password, 10), ts).lastInsertRowid;
  const user = getUserById(id);
  res.status(201).json({ user: publicUser(user), token: createSession(id) });
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
  res.json({ user: publicUser(user), token: createSession(user.id) });
});

app.post('/api/auth/logout', auth, (req, res) => {
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

driver.post('/loads/:id/complete', (req, res) => {
  const load = db.prepare('SELECT * FROM loads WHERE id = ? AND driverId = ?').get(req.params.id, req.user.id);
  if (!load) return err(res, 404, 'Load not found');
  if (load.status !== 'active') return err(res, 400, 'Only an active load can be completed');
  withTransaction(db, () => {
    db.prepare("UPDATE loads SET status = 'completed', completedAt = ? WHERE id = ?").run(now(), load.id);
    // Unit is back in the yard once the load is done.
    db.prepare("UPDATE trucks SET yardStatus = 'yard' WHERE driverId = ?").run(req.user.id);
    db.prepare("UPDATE trailers SET yardStatus = 'yard' WHERE driverId = ?").run(req.user.id);
  });
  res.json(serializeLoad(db.prepare('SELECT * FROM loads WHERE id = ?').get(load.id)));
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
  res.status(201).json(serializeRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(id)));
});

driver.get('/messages', (req, res) => {
  db.prepare("UPDATE messages SET read = 1 WHERE driverId = ? AND sender = 'dispatch'").run(req.user.id);
  const rows = db.prepare('SELECT * FROM messages WHERE driverId = ? ORDER BY id ASC').all(req.user.id);
  res.json(rows.map(serializeMessage));
});

driver.post('/messages', (req, res) => {
  const { body } = req.body || {};
  if (!body || !String(body).trim()) return err(res, 400, 'body is required');
  const id = db
    .prepare("INSERT INTO messages (driverId, sender, body, createdAt, read) VALUES (?, 'driver', ?, ?, 0)")
    .run(req.user.id, String(body).trim(), now()).lastInsertRowid;
  res.status(201).json(serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id)));
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

const DOC_KINDS = ['pickup_bol', 'delivery_bol', 'fuel_receipt', 'receipt', 'driver_doc'];

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
  res.status(201).json(serializeDocument(row));
});

driver.post('/photo', upload.single('photo'), (req, res) => {
  if (!req.file) return err(res, 400, 'photo is required');
  const fileId = insertFileRow(req.file, 'photo', null, req.user.id);
  const photoUrl = `/files/${fileId}`;
  db.prepare('UPDATE users SET photoUrl = ? WHERE id = ?').run(photoUrl, req.user.id);
  res.json({ photoUrl });
});

driver.post('/location', (req, res) => {
  const { lat, lng } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng))
    return err(res, 400, 'lat and lng are required numbers');
  db.prepare('INSERT INTO locations (driverId, lat, lng, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(driverId) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, updatedAt = excluded.updatedAt')
    .run(req.user.id, lat, lng, now());
  res.json({ ok: true });
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
  res.json(
    db.prepare('SELECT * FROM loads ORDER BY createdAt DESC, id DESC').all().map(serializeLoad),
  );
});

admin.post('/loads', (req, res) => {
  const {
    driverId,
    reference,
    pickupLocation,
    pickupAt,
    pickupTimezone,
    pickupNumber,
    deliveryLocation,
    deliveryAt,
    deliveryTimezone,
    deliveryNumber,
    notes,
  } = req.body || {};
  if (!driverId || !reference || !pickupLocation || !pickupAt || !pickupTimezone || !deliveryLocation || !deliveryAt || !deliveryTimezone)
    return err(res, 400, 'driverId, reference, pickup and delivery details are required');
  const driverUser = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(driverId);
  if (!driverUser) return err(res, 404, 'Driver not found');
  const ts = now();
  const id = db
    .prepare(
      "INSERT INTO loads (reference, driverId, pickupLocation, pickupAt, pickupTimezone, pickupNumber, deliveryLocation, deliveryAt, deliveryTimezone, deliveryNumber, notes, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
    )
    .run(
      reference,
      driverId,
      pickupLocation,
      pickupAt,
      pickupTimezone,
      pickupNumber ?? null,
      deliveryLocation,
      deliveryAt,
      deliveryTimezone,
      deliveryNumber ?? null,
      notes ?? null,
      ts,
    ).lastInsertRowid;
  deactivateDemo(db); // first real load deactivates demo
  const load = serializeLoad(db.prepare('SELECT * FROM loads WHERE id = ?').get(id));
  notifyDriver(db, driverId, 'load_assigned', 'New load assigned', `Load ${reference}: ${pickupLocation} → ${deliveryLocation}.`).catch(() => {});
  res.status(201).json(load);
});

admin.post('/loads/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (status !== 'cancelled' && status !== 'active') return err(res, 400, 'status must be "cancelled" or "active"');
  const load = db.prepare('SELECT * FROM loads WHERE id = ?').get(req.params.id);
  if (!load) return err(res, 404, 'Load not found');
  db.prepare('UPDATE loads SET status = ? WHERE id = ?').run(status, load.id);
  res.json(serializeLoad(db.prepare('SELECT * FROM loads WHERE id = ?').get(load.id)));
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

admin.get('/locations', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT l.*, u.name AS driverName FROM locations l
       JOIN users u ON u.id = l.driverId
       WHERE u.role = 'driver' AND EXISTS (SELECT 1 FROM sessions s WHERE s.userId = l.driverId)
       ORDER BY l.updatedAt DESC`,
    )
    .all();
  res.json(
    rows.map((r) => ({ driverId: r.driverId, driverName: r.driverName, lat: r.lat, lng: r.lng, updatedAt: r.updatedAt })),
  );
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
    .prepare("INSERT INTO messages (driverId, sender, body, createdAt, read) VALUES (?, 'dispatch', ?, ?, 0)")
    .run(driverUser.id, String(body).trim(), now()).lastInsertRowid;
  notifyDriver(db, driverUser.id, 'dispatch_message', 'Message from dispatch', String(body).trim()).catch(() => {});
  res.status(201).json(serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id)));
});

admin.get('/rate-confirmations', (_req, res) => {
  const rows = db
    .prepare(
      'SELECT r.*, f.originalFilename, f.mimeType FROM rate_confirmations r LEFT JOIN files f ON f.id = r.fileId ORDER BY r.createdAt DESC, r.id DESC',
    )
    .all();
  res.json(rows.map(serializeRateCon));
});

admin.post('/rate-confirmations', upload.single('file'), (req, res) => {
  const { loadId, reference, pickupState, deliveryState, pickupDate, deliveryDate, broker, rateCents } = req.body || {};
  if (!reference || !pickupState || !deliveryState || !pickupDate || !deliveryDate)
    return err(res, 400, 'reference, pickupState, deliveryState, pickupDate and deliveryDate are required');
  const ext = req.file ? path.extname(req.file.originalname || '') : '';
  const autoName = `${reference}_${pickupState}-${deliveryState}_${pickupDate}_to_${deliveryDate}${ext}`;
  let fileId = null;
  if (req.file) {
    const target = path.join(UPLOADS_DIR, autoName);
    // Avoid clobbering an existing file with the same auto-generated name.
    let finalName = autoName;
    let n = 1;
    while (fs.existsSync(path.join(UPLOADS_DIR, finalName))) {
      finalName = `${reference}_${pickupState}-${deliveryState}_${pickupDate}_to_${deliveryDate}-${n}${ext}`;
      n += 1;
    }
    fs.renameSync(req.file.path, path.join(UPLOADS_DIR, finalName));
    fileId = db
      .prepare(
        'INSERT INTO files (storedFilename, originalFilename, mimeType, ownerType, ownerId, driverId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(finalName, finalName, req.file.mimetype, 'rate_confirmation', null, null, now()).lastInsertRowid;
  }
  const id = db
    .prepare(
      'INSERT INTO rate_confirmations (reference, loadId, broker, pickupState, deliveryState, pickupDate, deliveryDate, rateCents, fileId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      reference,
      loadId ? Number(loadId) : null,
      broker ?? null,
      pickupState,
      deliveryState,
      pickupDate,
      deliveryDate,
      rateCents != null ? Number(rateCents) : null,
      fileId,
      now(),
    ).lastInsertRowid;
  const row = db
    .prepare('SELECT r.*, f.originalFilename, f.mimeType FROM rate_confirmations r LEFT JOIN files f ON f.id = r.fileId WHERE r.id = ?')
    .get(id);
  // No uploaded file: still report the auto-generated name as the filename.
  if (!fileId) row.originalFilename = autoName;
  res.status(201).json(serializeRateCon(row));
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

const EQUIP_DOC_TYPES = ['registration', 'insurance', 'annual_inspection', 'title', 'permit', 'other'];

admin.post('/equipment-documents', upload.single('file'), (req, res) => {
  const { unitType, unitId, docType, note } = req.body || {};
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
      'INSERT INTO equipment_documents (unitType, unitId, unitNumber, docType, note, fileId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(unitType, unitId, unit.unitNumber, docType, note ?? null, fileId, now()).lastInsertRowid;
  const row = db
    .prepare('SELECT e.*, f.originalFilename, f.mimeType FROM equipment_documents e JOIN files f ON f.id = e.fileId WHERE e.id = ?')
    .get(id);
  res.status(201).json(serializeEquipmentDoc(row));
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
  res.type(file.mimeType);
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
});
