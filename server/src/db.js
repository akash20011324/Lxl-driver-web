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
  pushToken TEXT,
  notificationPrefs TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  createdAt TEXT NOT NULL
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
  driverId INTEGER UNIQUE REFERENCES users(id)
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
  pickupAt TEXT NOT NULL,
  pickupTimezone TEXT NOT NULL,
  pickupNumber TEXT,
  deliveryLocation TEXT NOT NULL,
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
  kind TEXT NOT NULL CHECK (kind IN ('pickup_bol', 'delivery_bol', 'fuel_receipt', 'receipt', 'driver_doc')),
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
