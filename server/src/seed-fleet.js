// Real LXL fleet seed — the owner's actual trucks and trailers.
// Inserts idempotently (skips any unitNumber already present) and then
// deactivates demo mode, per API_CONTRACT.md §3: the first real fleet
// records turn demo off. No driver accounts, emails or passwords are
// invented here — drivers are created later by the admin.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, deactivateDemo } from './db.js';

const TRUCKS = [
  { unitNumber: '1301', make: 'Kenworth', model: 'T680', year: 2021 },
  { unitNumber: '1302', make: 'Freightliner', model: 'Cascadia', year: 2021 },
];

const TRAILERS = [
  { unitNumber: '531' },
  { unitNumber: '5302' },
];

export function seedRealFleet(db) {
  const inserted = [];
  const skipped = [];

  for (const t of TRUCKS) {
    const exists = db.prepare('SELECT 1 FROM trucks WHERE unitNumber = ?').get(t.unitNumber);
    if (exists) {
      skipped.push(`truck ${t.unitNumber}`);
      continue;
    }
    db.prepare(
      "INSERT INTO trucks (unitNumber, make, model, year, status, yardStatus, driverId) VALUES (?, ?, ?, ?, 'active', 'yard', NULL)",
    ).run(t.unitNumber, t.make, t.model, t.year);
    inserted.push(`truck ${t.unitNumber} (${t.make} ${t.model} ${t.year})`);
  }

  for (const t of TRAILERS) {
    const exists = db.prepare('SELECT 1 FROM trailers WHERE unitNumber = ?').get(t.unitNumber);
    if (exists) {
      skipped.push(`trailer ${t.unitNumber}`);
      continue;
    }
    db.prepare(
      "INSERT INTO trailers (unitNumber, kind, year, status, yardStatus, driverId) VALUES (?, NULL, NULL, 'active', 'yard', NULL)",
    ).run(t.unitNumber);
    inserted.push(`trailer ${t.unitNumber}`);
  }

  // Real fleet present => demo mode turns off, per the contract.
  deactivateDemo(db);

  return { inserted, skipped };
}

// Standalone: `node src/seed-fleet.js` seeds the default (or DATA_DIR) database.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const db = openDb(dataDir);
  const { inserted, skipped } = seedRealFleet(db);
  for (const line of inserted) console.log(`Inserted ${line}.`);
  for (const line of skipped) console.log(`Skipped ${line} (already present).`);
  if (inserted.length === 0 && skipped.length > 0) console.log('Real fleet already seeded — nothing inserted.');
  console.log('Demo mode deactivated.');
}
