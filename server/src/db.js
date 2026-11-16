// SQLite storage for the LXL Driver backend.
// Uses Node's built-in node:sqlite (DatabaseSync) — no native-module build.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function now() {
  return new Date().toISOString();
}

/**
 * Normalize a phone number for sign-in lookup: digits only, with a
 * leading North American country code dropped (so "(317) 555-0101",
 * "3175550101" and "+1 317-555-0101" all match the same driver).
 */
export function normalizePhone(value) {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'driver')),
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  passwordHash TEXT NOT NULL,
  phone TEXT,
  phoneNormalized TEXT UNIQUE,
  photoUrl TEXT,
  emergencyContact TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  isDemo INTEGER NOT NULL DEFAULT 0,
  isMainAdmin INTEGER NOT NULL DEFAULT 0,
  pushToken TEXT,
  notificationPrefs TEXT,
  outlookRefreshToken TEXT,
  outlookEmail TEXT,
  outlookConnectedAt TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  createdAt TEXT NOT NULL
);

-- Outlook sign-in states: kept in SQLite (not memory) so a server restart
-- or redeploy cannot wipe a sign-in that is still in progress.
CREATE TABLE IF NOT EXISTS outlook_states (
  state TEXT PRIMARY KEY,
  userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trucks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unitNumber TEXT NOT NULL UNIQUE,
  make TEXT,
  model TEXT,
  year INTEGER,
  plate TEXT,
  vin TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  yardStatus TEXT NOT NULL DEFAULT 'yard' CHECK (yardStatus IN ('yard', 'road')),
  driverId INTEGER UNIQUE REFERENCES users(id),
  odometerMi INTEGER,
  odometerUpdatedAt TEXT,
  engineHours REAL
);

CREATE TABLE IF NOT EXISTS trailers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unitNumber TEXT NOT NULL UNIQUE,
  kind TEXT,
  year INTEGER,
  plate TEXT,
  vin TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  yardStatus TEXT NOT NULL DEFAULT 'yard' CHECK (yardStatus IN ('yard', 'road')),
  driverId INTEGER UNIQUE REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS loads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL,
  driverId INTEGER NOT NULL REFERENCES users(id),
  pickupLocation TEXT NOT NULL,
  pickupWarehouse TEXT,
  pickupAt TEXT NOT NULL,
  pickupTimezone TEXT NOT NULL,
  pickupNumber TEXT,
  pickupLat REAL,
  pickupLng REAL,
  deliveryLocation TEXT NOT NULL,
  deliveryWarehouse TEXT,
  deliveryLat REAL,
  deliveryLng REAL,
  deliveryAt TEXT NOT NULL,
  deliveryTimezone TEXT NOT NULL,
  deliveryNumber TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  bolStatus TEXT CHECK (bolStatus IN ('clean', 'wrong')),
  completedAt TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  storedFilename TEXT NOT NULL,
  originalFilename TEXT NOT NULL,
  mimeType TEXT NOT NULL,
  ownerType TEXT NOT NULL,
  ownerId INTEGER,
  driverId INTEGER REFERENCES users(id),
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('pickup_bol', 'delivery_bol', 'fuel_receipt', 'receipt', 'driver_doc', 'unit_picture', 'seal_picture')),
  loadId INTEGER REFERENCES loads(id),
  category TEXT,
  label TEXT,
  amountCents INTEGER,
  fileId INTEGER NOT NULL REFERENCES files(id),
  driverId INTEGER NOT NULL REFERENCES users(id),
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driverId INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('advance', 'unit_change', 'time_off', 'reimbursement', 'other', 'truck_problem')),
  amountCents INTEGER,
  reason TEXT NOT NULL,
  details TEXT,
  truckId INTEGER REFERENCES trucks(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  adminNote TEXT,
  createdAt TEXT NOT NULL,
  decidedAt TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driverId INTEGER NOT NULL REFERENCES users(id),
  sender TEXT NOT NULL CHECK (sender IN ('driver', 'dispatch')),
  senderName TEXT,
  body TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS locations (
  driverId INTEGER PRIMARY KEY REFERENCES users(id),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  speedMph REAL,
  heading REAL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS equipment_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unitType TEXT NOT NULL CHECK (unitType IN ('truck', 'trailer')),
  unitId INTEGER NOT NULL,
  unitNumber TEXT NOT NULL,
  docType TEXT NOT NULL CHECK (docType IN ('registration', 'insurance', 'annual_inspection', 'title', 'permit', 'other')),
  note TEXT,
  fileId INTEGER NOT NULL REFERENCES files(id),
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL,
  loadId INTEGER REFERENCES loads(id),
  broker TEXT,
  pickupState TEXT NOT NULL,
  deliveryState TEXT NOT NULL,
  pickupDate TEXT NOT NULL,
  deliveryDate TEXT NOT NULL,
  rateCents INTEGER,
  fileId INTEGER REFERENCES files(id),
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driverId INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
`;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'lxl.db'));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  // Migrate databases created before phone sign-in: add the normalized
  // phone column (fresh databases get it from the schema above) and
  // backfill it from the stored display phone numbers.
  const columns = db.prepare('PRAGMA table_info(users)').all();
  if (!columns.some((c) => c.name === 'phoneNormalized')) {
    db.exec('ALTER TABLE users ADD COLUMN phoneNormalized TEXT');
  }
  for (const u of db
    .prepare('SELECT id, phone FROM users WHERE phone IS NOT NULL AND phoneNormalized IS NULL')
    .all()) {
    const normalized = normalizePhone(u.phone);
    if (normalized) {
      db.prepare('UPDATE users SET phoneNormalized = ? WHERE id = ?').run(normalized, u.id);
    }
  }
  // Migrate databases created before dispatcher roles: the main admin
  // (the first admin account, created at setup) can manage admin
  // accounts; later admins are dispatchers.
  if (!columns.some((c) => c.name === 'isMainAdmin')) {
    db.exec('ALTER TABLE users ADD COLUMN isMainAdmin INTEGER NOT NULL DEFAULT 0');
    db.prepare(
      "UPDATE users SET isMainAdmin = 1 WHERE role = 'admin' AND id = (SELECT id FROM users WHERE role = 'admin' ORDER BY createdAt ASC, id ASC LIMIT 1)",
    ).run();
  }
  // Migrate databases created before sidebar organizing: each admin's
  // preferred sidebar order (JSON array of view keys, NULL = default).
  if (!columns.some((c) => c.name === 'sidebarOrder')) {
    db.exec('ALTER TABLE users ADD COLUMN sidebarOrder TEXT');
  }
  // Migrate databases created before live speed: add speed (mph) and
  // heading (degrees) to the stored driver location (fresh databases get
  // them from the schema above).
  const locColumns = db.prepare('PRAGMA table_info(locations)').all();
  if (!locColumns.some((c) => c.name === 'speedMph')) {
    db.exec('ALTER TABLE locations ADD COLUMN speedMph REAL');
  }
  if (!locColumns.some((c) => c.name === 'heading')) {
    db.exec('ALTER TABLE locations ADD COLUMN heading REAL');
  }
  // Migrate databases created before TRC odometer readings: the latest
  // Pickup coordinates per load (fresh databases get them from the
  // schema above) — the Loads page progress % needs both route ends.
  const loadsCoordColumns = db.prepare('PRAGMA table_info(loads)').all();
  if (!loadsCoordColumns.some((c) => c.name === 'pickupLat')) {
    db.exec('ALTER TABLE loads ADD COLUMN pickupLat REAL');
  }
  if (!loadsCoordColumns.some((c) => c.name === 'pickupLng')) {
    db.exec('ALTER TABLE loads ADD COLUMN pickupLng REAL');
  }
  // ELD odometer (and engine hours) per truck, shown live on the admin
  // Locations page (fresh databases get them from the schema above).
  const truckColumns = db.prepare('PRAGMA table_info(trucks)').all();
  if (!truckColumns.some((c) => c.name === 'odometerMi')) {
    db.exec('ALTER TABLE trucks ADD COLUMN odometerMi INTEGER');
  }
  if (!truckColumns.some((c) => c.name === 'odometerUpdatedAt')) {
    db.exec('ALTER TABLE trucks ADD COLUMN odometerUpdatedAt TEXT');
  }
  if (!truckColumns.some((c) => c.name === 'engineHours')) {
    db.exec('ALTER TABLE trucks ADD COLUMN engineHours REAL');
  }
  // One-time seed of the first verified TRC eLOGS odometer readings
  // (2026-11-15: unit 1301 at 5:52 PM ET, unit 1302 at 6:00 PM ET).
  // Guarded on odometerMi IS NULL, so it fills only trucks that have
  // no reading yet and can never overwrite a newer one on later boots.
  db.prepare(
    "UPDATE trucks SET odometerMi = 546610, engineHours = 14698, odometerUpdatedAt = '2026-11-15T22:52:00.000Z' WHERE unitNumber = '1301' AND odometerMi IS NULL",
  ).run();
  db.prepare(
    "UPDATE trucks SET odometerMi = 679888, engineHours = 17438.8, odometerUpdatedAt = '2026-11-15T23:00:00.000Z' WHERE unitNumber = '1302' AND odometerMi IS NULL",
  ).run();
  // Migrate databases created before warehouse names: add the pickup /
  // delivery warehouse (facility) name to loads (fresh databases get
  // them from the schema above).
  const loadColumns = db.prepare('PRAGMA table_info(loads)').all();
  if (!loadColumns.some((c) => c.name === 'pickupWarehouse')) {
    db.exec('ALTER TABLE loads ADD COLUMN pickupWarehouse TEXT');
  }
  if (!loadColumns.some((c) => c.name === 'deliveryWarehouse')) {
    db.exec('ALTER TABLE loads ADD COLUMN deliveryWarehouse TEXT');
  }
  // Migrate databases created before the delivery-location gate: store
  // the geocoded delivery coordinates on the load (fresh databases get
  // them from the schema above).
  if (!loadColumns.some((c) => c.name === 'deliveryLat')) {
    db.exec('ALTER TABLE loads ADD COLUMN deliveryLat REAL');
  }
  if (!loadColumns.some((c) => c.name === 'deliveryLng')) {
    db.exec('ALTER TABLE loads ADD COLUMN deliveryLng REAL');
  }
  // Migrate databases created before sender names: record who sent each
  // message (the admin's name — Akash, Ali, …) so the driver sees who is
  // chatting with them (fresh databases get it from the schema above).
  const msgColumns = db.prepare('PRAGMA table_info(messages)').all();
  if (!msgColumns.some((c) => c.name === 'senderName')) {
    db.exec('ALTER TABLE messages ADD COLUMN senderName TEXT');
  }
  // Migrate databases created before Outlook connections: each admin can
  // connect their own Outlook mailbox so rate confirmations can be pulled
  // from their email (fresh databases get them from the schema above).
  if (!columns.some((c) => c.name === 'outlookRefreshToken')) {
    db.exec('ALTER TABLE users ADD COLUMN outlookRefreshToken TEXT');
  }
  if (!columns.some((c) => c.name === 'outlookEmail')) {
    db.exec('ALTER TABLE users ADD COLUMN outlookEmail TEXT');
  }
  if (!columns.some((c) => c.name === 'outlookConnectedAt')) {
    db.exec('ALTER TABLE users ADD COLUMN outlookConnectedAt TEXT');
  }
  // Migrate databases created before unit / seal pictures: widen the
  // documents kind CHECK to allow 'unit_picture' and 'seal_picture'.
  // SQLite cannot alter a CHECK in place, so rebuild the table (fresh
  // databases get the new list from the schema above).
  const docTable = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'documents'")
    .get();
  if (docTable && !docTable.sql.includes('unit_picture')) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec(`CREATE TABLE documents_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('pickup_bol', 'delivery_bol', 'fuel_receipt', 'receipt', 'driver_doc', 'unit_picture', 'seal_picture')),
  loadId INTEGER REFERENCES loads(id),
  category TEXT,
  label TEXT,
  amountCents INTEGER,
  fileId INTEGER NOT NULL REFERENCES files(id),
  driverId INTEGER NOT NULL REFERENCES users(id),
  createdAt TEXT NOT NULL
)`);
      db.exec(
        'INSERT INTO documents_new (id, kind, loadId, category, label, amountCents, fileId, driverId, createdAt) SELECT id, kind, loadId, category, label, amountCents, fileId, driverId, createdAt FROM documents',
      );
      db.exec('DROP TABLE documents');
      db.exec('ALTER TABLE documents_new RENAME TO documents');
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('demo_active', '0')").run();
  return db;
}

/** Run fn inside a single BEGIN IMMEDIATE transaction (atomic check-and-set). */
export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // already rolled back
    }
    throw err;
  }
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** Demo is available while demo_active=1 AND a demo driver exists. */
export function demoAvailable(db) {
  if (getMeta(db, 'demo_active') !== '1') return false;
  const row = db
    .prepare("SELECT id FROM users WHERE isDemo = 1 AND role = 'driver' AND active = 1 LIMIT 1")
    .get();
  return !!row;
}

/**
 * The FIRST real driver/truck/trailer/load created by the admin deactivates
 * demo. Call after each such creation (never from the seed itself).
 */
export function deactivateDemo(db) {
  setMeta(db, 'demo_active', '0');
}
