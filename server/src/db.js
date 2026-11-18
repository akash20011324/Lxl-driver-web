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
  miles REAL,
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
  kind TEXT NOT NULL CHECK (kind IN ('pickup_bol', 'delivery_bol', 'fuel_receipt', 'receipt', 'driver_doc', 'unit_picture', 'seal_picture', 'load_picture')),
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
  docType TEXT NOT NULL CHECK (docType IN ('cab_card', 'registration', 'insurance', 'annual_inspection', 'ifta', 'title', 'permit', 'permit_nm', 'permit_ky', 'permit_ct', 'permit_ny_hut', 'other')),
  note TEXT,
  fileId INTEGER NOT NULL REFERENCES files(id),
  expiryDate TEXT,
  issuedDate TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS driver_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driverId INTEGER NOT NULL,
  driverName TEXT NOT NULL,
  docType TEXT NOT NULL CHECK (docType IN ('driver_license', 'driver_application', 'other')),
  note TEXT,
  fileId INTEGER NOT NULL REFERENCES files(id),
  expiryDate TEXT,
  issuedDate TEXT,
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
CREATE TABLE IF NOT EXISTS admin_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  view TEXT,
  refId INTEGER,
  createdAt TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS broker_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  brokerName TEXT NOT NULL,
  brokerCompany TEXT,
  driverId INTEGER NOT NULL REFERENCES users(id),
  loadId INTEGER REFERENCES loads(id),
  createdBy INTEGER REFERENCES users(id),
  createdAt TEXT NOT NULL,
  lastViewedAt TEXT,
  revokedAt TEXT
);

CREATE TABLE IF NOT EXISTS maintenance_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  truckId INTEGER NOT NULL REFERENCES trucks(id),
  name TEXT NOT NULL,
  intervalMi INTEGER NOT NULL,
  lastDoneMi INTEGER,
  lastDoneAt TEXT,
  alertLevel TEXT NOT NULL DEFAULT 'none',
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS maintenance_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  itemId INTEGER REFERENCES maintenance_items(id),
  truckId INTEGER NOT NULL,
  itemName TEXT NOT NULL,
  doneAt TEXT NOT NULL,
  doneMi INTEGER,
  costCents INTEGER,
  shop TEXT,
  note TEXT,
  fileId INTEGER REFERENCES files(id),
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cash_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  date TEXT NOT NULL,
  category TEXT NOT NULL,
  amountCents INTEGER NOT NULL,
  truckId INTEGER REFERENCES trucks(id),
  note TEXT,
  fileId INTEGER REFERENCES files(id),
  source TEXT NOT NULL DEFAULT 'manual',
  outlookMessageId TEXT,
  loadId INTEGER REFERENCES loads(id),
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plaidTxId TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  amountCents INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'categorized', 'ignored')),
  entryId INTEGER REFERENCES cash_entries(id),
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  category TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE (pattern, direction)
);

CREATE TABLE IF NOT EXISTS fixed_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  amountCents INTEGER NOT NULL,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL
);

-- Relay Payments fuel transactions, imported by the server's Relay sync
-- (owner, 2026-11-18). Import/read only: rows here NEVER post to Cash
-- Flow on their own — how Relay fuel counts in the company books is a
-- separate owner decision. Amounts are REAL dollars parsed from the
-- string amounts Relay sends; items/raw keep the full per-product
-- detail. transaction_id is Relay's own unique id (the dedupe key).
CREATE TABLE IF NOT EXISTS relay_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL UNIQUE,
  created_at TEXT,
  driver_integration_id TEXT,
  driver_id INTEGER REFERENCES users(id),
  driver_name TEXT,
  truck_number TEXT,
  merchant_name TEXT,
  location_name TEXT,
  city TEXT,
  state TEXT,
  store_number TEXT,
  total_paid REAL,
  total_retail REAL,
  total_saved REAL,
  cash_advance REAL,
  is_direct_bill INTEGER,
  fuel_code_type TEXT,
  items TEXT,
  raw TEXT,
  imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relay_tx_created ON relay_transactions (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_relay_tx_driver ON relay_transactions (driver_integration_id);
`;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'lxl.db'));
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  // Cash Flow v2: entries can be tagged to a trip (load).
  try {
    const ceCols = db.prepare('PRAGMA table_info(cash_entries)').all();
    if (ceCols.length && !ceCols.some((c) => c.name === 'loadId'))
      db.exec('ALTER TABLE cash_entries ADD COLUMN loadId INTEGER REFERENCES loads(id)');
  } catch { /* table may not exist yet on a brand-new database */ }
  // Trucks profit v2: road miles cached on each load (driver pay in the
  // Trucks profit section = miles x $0.65, owner's rule 2026-11-17).
  try {
    const loadCols = db.prepare('PRAGMA table_info(loads)').all();
    if (loadCols.length && !loadCols.some((c) => c.name === 'miles'))
      db.exec('ALTER TABLE loads ADD COLUMN miles REAL');
  } catch { /* table may not exist yet on a brand-new database */ }
  // Multi-stop loads (owner, 2026-11-17): the full pickup/delivery
  // stop list as JSON ({pickups:[...], deliveries:[...]}); the load's
  // own pickup/delivery columns stay the FIRST pickup and the LAST
  // delivery so routing, pins and completion keep working as before.
  try {
    const loadCols2 = db.prepare('PRAGMA table_info(loads)').all();
    if (loadCols2.length && !loadCols2.some((c) => c.name === 'stops'))
      db.exec('ALTER TABLE loads ADD COLUMN stops TEXT');
  } catch { /* table may not exist yet on a brand-new database */ }
  // Bulk RC import: remember which Outlook message each rate con came from.
  try {
    const rcCols = db.prepare('PRAGMA table_info(rate_confirmations)').all();
    if (rcCols.length && !rcCols.some((c) => c.name === 'outlookMessageId'))
      db.exec('ALTER TABLE rate_confirmations ADD COLUMN outlookMessageId TEXT');
  } catch { /* table may not exist yet on a brand-new database */ }
  // Duplicate-proofing: every rate con file is fingerprinted (sha256).
  try {
    const rcCols2 = db.prepare('PRAGMA table_info(rate_confirmations)').all();
    if (rcCols2.length && !rcCols2.some((c) => c.name === 'fileHash'))
      db.exec('ALTER TABLE rate_confirmations ADD COLUMN fileHash TEXT');
  } catch { /* table may not exist yet on a brand-new database */ }
  // Bulk RC import runs persist across restarts and long scans.
  try { db.exec('CREATE TABLE IF NOT EXISTS rc_import_runs (id TEXT PRIMARY KEY, startedAt INTEGER, paidRefs TEXT, scheduleHashes TEXT, examined TEXT, schedules INTEGER DEFAULT 0, mailboxErrors TEXT, mailboxes TEXT, cursor TEXT)'); } catch { /* created by schema on fresh databases */ }
  try { db.exec('ALTER TABLE rc_import_runs ADD COLUMN cursor TEXT'); } catch { /* column already there */ }
  try { db.exec('ALTER TABLE rc_import_runs ADD COLUMN epoch TEXT'); } catch { /* column already there */ }
  // Load numbers always carry the company prefix: LXL-<broker number>.
  // Rows imported before the rule get prefixed once, here at boot.
  try {
    db.exec("UPDATE loads SET reference = 'LXL-' || reference WHERE reference NOT LIKE 'LXL-%' AND substr(reference, 1, 1) GLOB '[0-9]' AND NOT EXISTS (SELECT 1 FROM loads l2 WHERE l2.reference = 'LXL-' || loads.reference)");
    db.exec("UPDATE rate_confirmations SET reference = 'LXL-' || reference WHERE reference NOT LIKE 'LXL-%' AND substr(reference, 1, 1) GLOB '[0-9]' AND NOT EXISTS (SELECT 1 FROM rate_confirmations r2 WHERE r2.reference = 'LXL-' || rate_confirmations.reference)");
  } catch { /* tables may not exist yet on a brand-new database */ }
  // BOL import dedupe: email-imported files carry a sha256 fingerprint.
  try {
    const fCols = db.prepare('PRAGMA table_info(files)').all();
    if (fCols.length && !fCols.some((c) => c.name === 'fileHash'))
      db.exec('ALTER TABLE files ADD COLUMN fileHash TEXT');
  } catch { /* table may not exist yet on a brand-new database */ }
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
  // Migrate databases created before email signatures: the admin's
  // Outlook signature (HTML), captured from their own sent mail and
  // appended to Documents sends so portal emails carry it just like
  // Outlook-sent ones do.
  if (!columns.some((c) => c.name === 'emailSignatureHtml')) {
    db.exec('ALTER TABLE users ADD COLUMN emailSignatureHtml TEXT');
  }
  // Per-user chat wallpaper (WhatsApp-style): each admin and driver can
  // set their own chat background picture; stored as a files row.
  if (!columns.some((c) => c.name === 'pushSound')) {
    db.exec('ALTER TABLE users ADD COLUMN pushSound TEXT');
  }
  if (!columns.some((c) => c.name === 'chatWallpaperFileId')) {
    db.exec('ALTER TABLE users ADD COLUMN chatWallpaperFileId INTEGER REFERENCES files(id)');
  }
  if (!columns.some((c) => c.name === 'adminKind')) {
    db.exec("ALTER TABLE users ADD COLUMN adminKind TEXT DEFAULT 'dispatcher'");
  }
  // Relay Payments: the driver's 16-digit Relay Driver ID — the TMS
  // Fuel API's Integration_ID — matched against imported Relay fuel
  // transactions so each driver sees only his own. NULL until an admin
  // fills it in; transactions with no matching driver stay unlinked.
  if (!columns.some((c) => c.name === 'relay_driver_id')) {
    db.exec('ALTER TABLE users ADD COLUMN relay_driver_id TEXT');
  }
  // BOL departure reminder state on loads: when the driver was last seen
  // at the pickup, and when the "please upload the BOL" push was sent.
  const loadCols2 = db.prepare('PRAGMA table_info(loads)').all();
  if (!loadCols2.some((c) => c.name === 'pickupVisitedAt')) {
    db.exec('ALTER TABLE loads ADD COLUMN pickupVisitedAt TEXT');
  }
  if (!loadCols2.some((c) => c.name === 'bolReminderAt')) {
    db.exec('ALTER TABLE loads ADD COLUMN bolReminderAt TEXT');
  }
  // Trailers get make/model too (cab-card auto-read fills them, the same
  // as trucks) — fresh databases still use the base schema above.
  const trailerColumns = db.prepare('PRAGMA table_info(trailers)').all();
  if (!trailerColumns.some((c) => c.name === 'make')) {
    db.exec('ALTER TABLE trailers ADD COLUMN make TEXT');
  }
  if (!trailerColumns.some((c) => c.name === 'model')) {
    db.exec('ALTER TABLE trailers ADD COLUMN model TEXT');
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
  // Migrate databases created before chat attachments: a message can
  // carry one file (photo / PDF) stored in the files table.
  const msgFileColumns = db.prepare('PRAGMA table_info(messages)').all();
  if (!msgFileColumns.some((c) => c.name === 'fileId')) {
    db.exec('ALTER TABLE messages ADD COLUMN fileId INTEGER REFERENCES files(id)');
  }
  // Delivered receipts: set when the driver's app next checks in
  // (location post or message fetch) after a dispatch message was sent.
  if (!msgFileColumns.some((c) => c.name === 'deliveredAt')) {
    db.exec('ALTER TABLE messages ADD COLUMN deliveredAt TEXT');
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
  // Migrate databases created before load pictures: widen the documents
  // kind CHECK to allow 'load_picture' (owner, 2026-11-17). Same table
  // rebuild as the unit/seal migration above.
  const docTable2 = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'documents'")
    .get();
  if (docTable2 && !docTable2.sql.includes('load_picture')) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec(`CREATE TABLE documents_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('pickup_bol', 'delivery_bol', 'fuel_receipt', 'receipt', 'driver_doc', 'unit_picture', 'seal_picture', 'load_picture')),
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
  // Migrate equipment_documents: add the expiryDate column and widen the
  // docType CHECK (cab card + IFTA). SQLite cannot alter a CHECK in place,
  // so rebuild the table when the new types are missing.
  const eqCols = db.prepare('PRAGMA table_info(equipment_documents)').all();
  if (eqCols.length && !eqCols.some(c => c.name === 'expiryDate')) {
    db.exec('ALTER TABLE equipment_documents ADD COLUMN expiryDate TEXT');
  }
  const eqCols2 = db.prepare('PRAGMA table_info(equipment_documents)').all();
  if (eqCols2.length && !eqCols2.some(c => c.name === 'issuedDate')) {
    db.exec('ALTER TABLE equipment_documents ADD COLUMN issuedDate TEXT');
  }
  const eqTable = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'equipment_documents'")
    .get();
  if (eqTable && !eqTable.sql.includes('cab_card')) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec(`CREATE TABLE equipment_documents_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unitType TEXT NOT NULL CHECK (unitType IN ('truck', 'trailer')),
  unitId INTEGER NOT NULL,
  unitNumber TEXT NOT NULL,
  docType TEXT NOT NULL CHECK (docType IN ('cab_card', 'registration', 'insurance', 'annual_inspection', 'ifta', 'title', 'permit', 'other')),
  note TEXT,
  fileId INTEGER NOT NULL REFERENCES files(id),
  expiryDate TEXT,
  issuedDate TEXT,
  createdAt TEXT NOT NULL
)`);
      db.exec(
        'INSERT INTO equipment_documents_new (id, unitType, unitId, unitNumber, docType, note, fileId, expiryDate, issuedDate, createdAt) SELECT id, unitType, unitId, unitNumber, docType, note, fileId, expiryDate, issuedDate, createdAt FROM equipment_documents',
      );
      db.exec('DROP TABLE equipment_documents');
      db.exec('ALTER TABLE equipment_documents_new RENAME TO equipment_documents');
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
  // Migrate equipment_documents again: widen the docType CHECK for the
  // state permit types (NM / KY / CT permits + NY HUT, owner 2026-11-18).
  // Rebuild when the new types are missing from the table definition.
  const eqTable2 = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'equipment_documents'")
    .get();
  if (eqTable2 && !eqTable2.sql.includes('permit_nm')) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec(`CREATE TABLE equipment_documents_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unitType TEXT NOT NULL CHECK (unitType IN ('truck', 'trailer')),
  unitId INTEGER NOT NULL,
  unitNumber TEXT NOT NULL,
  docType TEXT NOT NULL CHECK (docType IN ('cab_card', 'registration', 'insurance', 'annual_inspection', 'ifta', 'title', 'permit', 'permit_nm', 'permit_ky', 'permit_ct', 'permit_ny_hut', 'other')),
  note TEXT,
  fileId INTEGER NOT NULL REFERENCES files(id),
  expiryDate TEXT,
  issuedDate TEXT,
  createdAt TEXT NOT NULL
)`);
      db.exec(
        'INSERT INTO equipment_documents_new (id, unitType, unitId, unitNumber, docType, note, fileId, expiryDate, issuedDate, createdAt) SELECT id, unitType, unitId, unitNumber, docType, note, fileId, expiryDate, issuedDate, createdAt FROM equipment_documents',
      );
      db.exec('DROP TABLE equipment_documents');
      db.exec('ALTER TABLE equipment_documents_new RENAME TO equipment_documents');
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
