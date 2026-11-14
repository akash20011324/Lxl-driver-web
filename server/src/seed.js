// Demo seed data — contract §4.
// Inserts the exact demo fleet. Demo accounts get random, unpublished
// passwords; demo entry is only via POST /api/demo/enter (server-issued
// session), never via a shared password.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, now, setMeta, normalizePhone } from './db.js';

function randomPasswordHash() {
  // Random, unpublished — never printed or returned anywhere.
  return bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
}

function writePlaceholder(uploadsDir, filename, text) {
  const stored = `${crypto.randomBytes(8).toString('hex')}-${filename}`;
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, stored), text);
  return { storedFilename: stored, originalFilename: filename, mimeType: 'text/plain' };
}

export function seedDemo(db, uploadsDir) {
  const ts = now();

  const insertFile = (f, ownerType, ownerId, driverId) =>
    db
      .prepare(
        'INSERT INTO files (storedFilename, originalFilename, mimeType, ownerType, ownerId, driverId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(f.storedFilename, f.originalFilename, f.mimeType, ownerType, ownerId, driverId, ts)
      .lastInsertRowid;

  const placeholderDoc = (filename, text, driverId) => {
    const f = writePlaceholder(uploadsDir, filename, text);
    return insertFile(f, 'document', null, driverId);
  };

  // ---- Drivers -----------------------------------------------------------
  // Demo driver Harpreet Singh signs in with demo phone (317) 555-0101
  // or demo email; the other demo drivers have phones too.
  const mkDriver = (name, email, phone, isDemo) =>
    db
      .prepare(
        "INSERT INTO users (role, name, email, passwordHash, phone, phoneNormalized, active, isDemo, createdAt) VALUES ('driver', ?, ?, ?, ?, ?, 1, ?, ?)",
      )
      .run(name, email, randomPasswordHash(), phone, normalizePhone(phone), isDemo ? 1 : 0, ts).lastInsertRowid;

  const harpreetId = mkDriver('Harpreet Singh', 'demo.harpreet@lxl.local', '(317) 555-0101', true);
  const gurpreetId = mkDriver('Gurpreet Singh', 'demo.gurpreet@lxl.local', '(317) 555-0102', false);
  const simranId = mkDriver('Simran Kaur', 'demo.simran@lxl.local', '(317) 555-0103', false);

  // ---- Trucks ------------------------------------------------------------
  const mkTruck = (unitNumber, make, model, year, plate, vin, driverId, yardStatus) =>
    db
      .prepare(
        'INSERT INTO trucks (unitNumber, make, model, year, plate, vin, status, yardStatus, driverId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(unitNumber, make, model, year, plate, vin, 'active', yardStatus, driverId)
      .lastInsertRowid;

  const truck101 = mkTruck(
    '101',
    'Kenworth',
    'T680',
    2021,
    'IN-101-LXL',
    '1XKYD49X6MJ455325',
    harpreetId,
    'road',
  );
  const truck102 = mkTruck('102', 'Peterbilt', '579', 2022, 'IN-102-LXL', '1XPBD49X6ND789012', gurpreetId, 'road');
  const truck103 = mkTruck('103', 'Freightliner', 'Cascadia', 2020, 'IN-103-LXL', '3AKJHHDRXLSK45678', simranId, 'yard');
  const truck104 = mkTruck('104', 'Kenworth', 'T680', 2023, 'IN-104-LXL', '1XKYD49X6PJ901234', null, 'yard');

  // ---- Trailers ----------------------------------------------------------
  const mkTrailer = (unitNumber, kind, year, plate, vin, driverId, yardStatus) =>
    db
      .prepare(
        'INSERT INTO trailers (unitNumber, kind, year, plate, vin, status, yardStatus, driverId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(unitNumber, kind, year, plate, vin, 'active', yardStatus, driverId).lastInsertRowid;

  const trailer201 = mkTrailer('T-201', 'Dry Van', 2021, 'TR-201-IN', '1GRAA0621MB123456', harpreetId, 'road');
  const trailer202 = mkTrailer('T-202', 'Reefer', 2022, 'TR-202-IN', '1GRAA0622NB234567', gurpreetId, 'road');
  const trailer203 = mkTrailer('T-203', 'Dry Van', 2020, 'TR-203-IN', '1GRAA0620LB345678', simranId, 'yard');
  const trailer204 = mkTrailer('T-204', 'Flatbed', 2023, 'TR-204-IN', '1GRAA0623PB456789', null, 'yard');

  // ---- Loads -------------------------------------------------------------
  const mkLoad = (reference, driverId, pickupLocation, pickupAt, pickupTimezone, deliveryLocation, deliveryAt, deliveryTimezone, notes, status, completedAt) =>
    db
      .prepare(
        'INSERT INTO loads (reference, driverId, pickupLocation, pickupAt, pickupTimezone, deliveryLocation, deliveryAt, deliveryTimezone, notes, status, completedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(reference, driverId, pickupLocation, pickupAt, pickupTimezone, deliveryLocation, deliveryAt, deliveryTimezone, notes, status, completedAt, ts)
      .lastInsertRowid;

  const load2481 = mkLoad(
    'LXL-2481',
    harpreetId,
    'Indianapolis, IN',
    '2026-11-13T13:00:00.000Z',
    'America/Indianapolis',
    'Dallas, TX',
    '2026-11-14T15:00:00.000Z',
    'America/Chicago',
    'Demo active load — Indianapolis to Dallas.',
    'active',
    null,
  );
  const load2482 = mkLoad(
    'LXL-2482',
    gurpreetId,
    'Chicago, IL',
    '2026-11-13T14:00:00.000Z',
    'America/Chicago',
    'Atlanta, GA',
    '2026-11-15T16:00:00.000Z',
    'America/New_York',
    'Demo active load — Chicago to Atlanta.',
    'active',
    null,
  );
  const load2483 = mkLoad(
    'LXL-2483',
    simranId,
    'Indianapolis, IN',
    '2026-11-10T13:00:00.000Z',
    'America/Indianapolis',
    'Columbus, OH',
    '2026-11-11T15:00:00.000Z',
    'America/New_York',
    'Demo completed load — Indianapolis to Columbus.',
    'completed',
    '2026-11-11T15:30:00.000Z',
  );
  mkLoad(
    'LXL-2480',
    harpreetId,
    'Indianapolis, IN',
    '2026-11-09T13:00:00.000Z',
    'America/Indianapolis',
    'Nashville, TN',
    '2026-11-10T15:00:00.000Z',
    'America/Chicago',
    'Demo cancelled load — Indianapolis to Nashville.',
    'cancelled',
    null,
  );

  // ---- Documents for LXL-2481 --------------------------------------------
  const mkDoc = (kind, loadId, category, label, amountCents, fileId, driverId) =>
    db
      .prepare(
        'INSERT INTO documents (kind, loadId, category, label, amountCents, fileId, driverId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(kind, loadId, category, label, amountCents, fileId, driverId, ts).lastInsertRowid;

  mkDoc(
    'pickup_bol',
    load2481,
    null,
    'Pickup BOL — LXL-2481',
    null,
    placeholderDoc('pickup-bol-LXL-2481.txt', 'Demo placeholder: pickup BOL for load LXL-2481 (Indianapolis, IN).', harpreetId),
    harpreetId,
  );
  mkDoc(
    'fuel_receipt',
    load2481,
    'fuel',
    'Fuel receipt — LXL-2481',
    41310,
    placeholderDoc('fuel-receipt-LXL-2481.txt', 'Demo placeholder: fuel receipt $413.10 for load LXL-2481.', harpreetId),
    harpreetId,
  );
  mkDoc(
    'receipt',
    load2481,
    'toll',
    'Toll receipt — LXL-2481',
    1840,
    placeholderDoc('toll-receipt-LXL-2481.txt', 'Demo placeholder: toll receipt $18.40 for load LXL-2481.', harpreetId),
    harpreetId,
  );

  // ---- Requests ----------------------------------------------------------
  const mkRequest = (driverId, type, amountCents, reason, details, truckId, status, adminNote, decidedAt) =>
    db
      .prepare(
        'INSERT INTO requests (driverId, type, amountCents, reason, details, truckId, status, adminNote, createdAt, decidedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(driverId, type, amountCents, reason, details, truckId, status, adminNote, ts, decidedAt)
      .lastInsertRowid;

  mkRequest(harpreetId, 'advance', 50000, 'Fuel advance for Dallas run', 'Need fuel money before the Dallas delivery.', null, 'pending', null, null);
  mkRequest(gurpreetId, 'time_off', null, 'Time off next weekend', 'Family event — need Saturday and Sunday off.', null, 'pending', null, null);
  mkRequest(simranId, 'unit_change', null, 'Requesting truck 104', 'Truck 103 has a warning light; would like to swap to 104.', truck104, 'pending', null, null);
  mkRequest(harpreetId, 'truck_problem', null, 'Air leak on trailer T-201', 'Hearing air leaking near the rear axle of T-201.', null, 'pending', null, null);
  mkRequest(gurpreetId, 'reimbursement', 12000, 'Reimbursement — scale ticket', 'Paid $120 for a scale ticket out of pocket.', null, 'approved', 'Approved — attach receipt next time.', '2026-11-12T18:00:00.000Z');

  // ---- Dispatch messages --------------------------------------------------
  const mkMessage = (driverId, sender, body, read) =>
    db
      .prepare('INSERT INTO messages (driverId, sender, body, createdAt, read) VALUES (?, ?, ?, ?, ?)')
      .run(driverId, sender, body, ts, read ? 1 : 0).lastInsertRowid;

  mkMessage(harpreetId, 'dispatch', 'Harpreet, load LXL-2481 is ready. Pickup in Indianapolis today, delivery Dallas tomorrow.', 0);
  mkMessage(harpreetId, 'driver', 'On my way to pickup now.', 1);
  mkMessage(gurpreetId, 'dispatch', 'Gurpreet, your Chicago pickup is confirmed for today.', 0);

  // ---- Live locations ------------------------------------------------------
  db.prepare('INSERT OR REPLACE INTO locations (driverId, lat, lng, updatedAt) VALUES (?, ?, ?, ?)')
    .run(harpreetId, 39.7684, -86.1581, ts);
  db.prepare('INSERT OR REPLACE INTO locations (driverId, lat, lng, updatedAt) VALUES (?, ?, ?, ?)')
    .run(gurpreetId, 41.8781, -87.6298, ts);

  // ---- Per-unit paperwork --------------------------------------------------
  const mkEquipDoc = (unitType, unitId, unitNumber, docType) => {
    const f = writePlaceholder(
      uploadsDir,
      `${unitType}-${unitNumber}-${docType}.txt`,
      `Demo placeholder: ${docType} for ${unitType} ${unitNumber}.`,
    );
    const fileId = insertFile(f, 'equipment', null, null);
    db.prepare(
      'INSERT INTO equipment_documents (unitType, unitId, unitNumber, docType, note, fileId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(unitType, unitId, unitNumber, docType, 'Demo paperwork', fileId, ts);
  };
  for (const [unitId, unitNumber] of [
    [truck101, '101'],
    [truck102, '102'],
    [truck103, '103'],
    [truck104, '104'],
  ]) {
    mkEquipDoc('truck', unitId, unitNumber, 'registration');
    mkEquipDoc('truck', unitId, unitNumber, 'insurance');
    mkEquipDoc('truck', unitId, unitNumber, 'annual_inspection');
  }
  for (const [unitId, unitNumber] of [
    [trailer201, 'T-201'],
    [trailer202, 'T-202'],
    [trailer203, 'T-203'],
    [trailer204, 'T-204'],
  ]) {
    mkEquipDoc('trailer', unitId, unitNumber, 'registration');
    mkEquipDoc('trailer', unitId, unitNumber, 'annual_inspection');
  }

  // ---- Rate confirmations --------------------------------------------------
  const mkRateCon = (reference, loadId, broker, pickupState, deliveryState, pickupDate, deliveryDate, rateCents) => {
    const filename = `${reference}_${pickupState}-${deliveryState}_${pickupDate}_to_${deliveryDate}.txt`;
    const f = writePlaceholder(
      uploadsDir,
      filename,
      `Demo placeholder: rate confirmation ${reference} ${pickupState} -> ${deliveryState}, $${(rateCents / 100).toFixed(2)}.`,
    );
    const fileId = insertFile(f, 'rate_confirmation', null, null);
    db.prepare(
      'INSERT INTO rate_confirmations (reference, loadId, broker, pickupState, deliveryState, pickupDate, deliveryDate, rateCents, fileId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(reference, loadId, broker, pickupState, deliveryState, pickupDate, deliveryDate, rateCents, fileId, ts);
  };
  mkRateCon('LXL-2481', load2481, 'Demo Broker LLC', 'IN', 'TX', '2026-11-13', '2026-11-14', 285000);
  mkRateCon('LXL-2482', load2482, 'Demo Broker LLC', 'IL', 'GA', '2026-11-13', '2026-11-15', 240000);
  mkRateCon('LXL-2483', load2483, 'Demo Broker LLC', 'IN', 'OH', '2026-11-10', '2026-11-11', 95000);

  // ---- Notifications -------------------------------------------------------
  db.prepare('INSERT INTO notifications (driverId, type, title, body, createdAt, read) VALUES (?, ?, ?, ?, ?, 0)')
    .run(harpreetId, 'load_assigned', 'New load assigned', 'Load LXL-2481: Indianapolis, IN → Dallas, TX.', ts);
  db.prepare('INSERT INTO notifications (driverId, type, title, body, createdAt, read) VALUES (?, ?, ?, ?, ?, 0)')
    .run(harpreetId, 'dispatch_message', 'Message from dispatch', 'Load LXL-2481 is ready. Pickup in Indianapolis today.', ts);

  setMeta(db, 'demo_active', '1');

  return {
    drivers: { harpreetId, gurpreetId, simranId },
    trucks: { truck101, truck102, truck103, truck104 },
    trailers: { trailer201, trailer202, trailer203, trailer204 },
    loads: { load2481, load2482, load2483 },
  };
}

// Standalone: `node src/seed.js` seeds the default (or DATA_DIR) database.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const uploadsDir = path.join(dataDir, 'uploads');
  const db = openDb(dataDir);
  const fleetEmpty =
    db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'driver'").get().c === 0 &&
    db.prepare('SELECT COUNT(*) AS c FROM trucks').get().c === 0 &&
    db.prepare('SELECT COUNT(*) AS c FROM trailers').get().c === 0 &&
    db.prepare('SELECT COUNT(*) AS c FROM loads').get().c === 0;
  if (!fleetEmpty) {
    console.log('Fleet tables are not empty — seed skipped.');
    process.exit(0);
  }
  seedDemo(db, uploadsDir);
  console.log('Demo fleet seeded.');
}
