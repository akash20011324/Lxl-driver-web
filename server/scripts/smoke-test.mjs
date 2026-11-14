// Smoke test for the LXL Driver backend.
// Boots the server against a TEMPORARY database (DATA_DIR in a temp dir)
// and exercises the contract's core flows. Prints PASS/FAIL per step and
// exits non-zero on any failure.
//
// Usage: node scripts/smoke-test.mjs   (run from server/)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(ROOT, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxl-smoke-'));
const PORT = 31000 + Math.floor(Math.random() * 900);

const results = [];
let failures = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
}

const base = `http://127.0.0.1:${PORT}`;
async function req(method, p, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form; // FormData sets its own content-type
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${p}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON (file download etc.)
  }
  return { status: res.status, json, text };
}

async function waitReady(deadlineMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const r = await req('GET', '/api/setup/status');
      if (r.status === 200) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const child = spawn('node', ['src/index.js'], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: tmpDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d.toString()));
child.stderr.on('data', (d) => (serverLog += d.toString()));

const cleanup = () => {
  try {
    child.kill('SIGTERM');
  } catch {
    // already dead
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
};
process.on('exit', cleanup);

try {
  if (!(await waitReady())) {
    check('server boots and responds to GET /api/setup/status', false, serverLog.slice(-500));
    throw new Error('server did not start');
  }
  check('server boots and responds to GET /api/setup/status', true);

  // 1. Setup status on a fresh DB
  let r = await req('GET', '/api/setup/status');
  check('setup status: needsSetup=true, driverCount=0', r.status === 200 && r.json.needsSetup === true && r.json.driverCount === 0, JSON.stringify(r.json));

  // 2. Setup admin
  r = await req('POST', '/api/setup/admin', { body: { name: 'Akash Lubana', email: 'akash@lxl.local', password: 'AdminPass123!' } });
  const adminToken = r.json && r.json.token;
  check('setup admin creates admin + token', r.status === 201 && !!adminToken && r.json.user.role === 'admin', `status=${r.status} ${r.text.slice(0, 200)}`);
  r = await req('POST', '/api/setup/admin', { body: { name: 'Second', email: 'second@lxl.local', password: 'AdminPass123!' } });
  check('second setup admin returns 409', r.status === 409, `status=${r.status}`);

  // 3. Demo seed (fleet empty) + demo enter
  r = await req('POST', '/api/admin/seed-demo', { token: adminToken });
  check('seed-demo seeds demo fleet', r.status === 200 && r.json.seeded === true, `status=${r.status} ${r.text.slice(0, 200)}`);
  r = await req('GET', '/api/demo/info');
  check('demo info: available, driver Harpreet Singh, demo phone (317) 555-0101', r.status === 200 && r.json.demoAvailable === true && r.json.demoDriverName === 'Harpreet Singh' && r.json.demoDriverPhone === '(317) 555-0101', JSON.stringify(r.json));
  r = await req('POST', '/api/demo/enter', { body: { role: 'driver' } });
  const demoToken = r.json && r.json.token;
  check('demo enter issues session for Harpreet Singh', r.status === 200 && !!demoToken && r.json.user.name === 'Harpreet Singh', `status=${r.status} ${r.text.slice(0, 200)}`);
  r = await req('GET', '/api/driver/home', { token: demoToken });
  check('demo driver home shows truck 101, trailer T-201, load LXL-2481',
    r.status === 200 && r.json.truck?.unitNumber === '101' && r.json.trailer?.unitNumber === 'T-201' && r.json.activeLoad?.reference === 'LXL-2481',
    `status=${r.status} ${r.text.slice(0, 300)}`);
  r = await req('POST', '/api/admin/seed-demo', { token: adminToken });
  check('seed-demo again returns seeded=false', r.status === 200 && r.json.seeded === false, JSON.stringify(r.json));

  // 4. Create real drivers — first real record deactivates demo
  r = await req('POST', '/api/admin/drivers', { token: adminToken, body: { name: 'Test Driver One', email: 'one@test.local', password: 'DriverPass123!', phone: '(317) 555-1001' } });
  const driver1 = r.json;
  check('create driver 1', r.status === 201 && driver1.id && driver1.email === 'one@test.local', `status=${r.status} ${r.text.slice(0, 200)}`);
  r = await req('POST', '/api/admin/drivers', { token: adminToken, body: { name: 'Test Driver Two', email: 'two@test.local', password: 'DriverPass123!' } });
  const driver2 = r.json;
  check('create driver 2', r.status === 201 && driver2.id, `status=${r.status} ${r.text.slice(0, 200)}`);

  r = await req('GET', '/api/demo/info');
  check('demo deactivates after first real record', r.status === 200 && r.json.demoAvailable === false, JSON.stringify(r.json));
  r = await req('POST', '/api/demo/enter', { body: { role: 'driver' } });
  check('demo enter after deactivation returns 403', r.status === 403, `status=${r.status}`);

  // 5. Create truck/trailer
  r = await req('POST', '/api/admin/trucks', { token: adminToken, body: { unitNumber: '201', make: 'Kenworth', model: 'T680', year: 2021, vin: '1XKYD49X6MJ999001' } });
  const truck201 = r.json;
  check('create truck 201', r.status === 201 && truck201.unitNumber === '201', `status=${r.status} ${r.text.slice(0, 200)}`);
  r = await req('POST', '/api/admin/trucks', { token: adminToken, body: { unitNumber: '202', make: 'Peterbilt', model: '579', year: 2022 } });
  const truck202 = r.json;
  check('create truck 202', r.status === 201 && truck202.unitNumber === '202', `status=${r.status}`);
  r = await req('POST', '/api/admin/trailers', { token: adminToken, body: { unitNumber: 'T-301', kind: 'Dry Van', year: 2021 } });
  const trailer301 = r.json;
  check('create trailer T-301', r.status === 201 && trailer301.unitNumber === 'T-301', `status=${r.status}`);
  r = await req('POST', '/api/admin/trailers', { token: adminToken, body: { unitNumber: 'T-302', kind: 'Reefer', year: 2022 } });
  const trailer302 = r.json;
  check('create trailer T-302', r.status === 201 && trailer302.unitNumber === 'T-302', `status=${r.status}`);

  // 6. Assign truck + trailer to driver 1
  r = await req('POST', `/api/admin/trucks/${truck201.id}/assign`, { token: adminToken, body: { driverId: driver1.id } });
  check('assign truck 201 to driver 1', r.status === 200 && r.json.driverId === driver1.id, `status=${r.status} ${r.text.slice(0, 200)}`);
  r = await req('POST', `/api/admin/trucks/${truck201.id}/assign`, { token: adminToken, body: { driverId: driver2.id } });
  check('assign same truck to driver 2 returns 409', r.status === 409, `status=${r.status}`);
  r = await req('POST', `/api/admin/trailers/${trailer301.id}/assign`, { token: adminToken, body: { driverId: driver1.id } });
  check('assign trailer T-301 to driver 1', r.status === 200 && r.json.driverId === driver1.id, `status=${r.status} ${r.text.slice(0, 200)}`);

  // 7. Create load for driver 1
  r = await req('POST', '/api/admin/loads', {
    token: adminToken,
    body: {
      driverId: driver1.id,
      reference: 'LXL-TEST-1',
      pickupLocation: 'Indianapolis, IN',
      pickupAt: '2026-11-14T13:00:00.000Z',
      pickupTimezone: 'America/Indianapolis',
      deliveryLocation: 'Dallas, TX',
      deliveryAt: '2026-11-15T15:00:00.000Z',
      deliveryTimezone: 'America/Chicago',
    },
  });
  const load1 = r.json;
  check('create load LXL-TEST-1 for driver 1', r.status === 201 && load1.reference === 'LXL-TEST-1' && load1.status === 'active', `status=${r.status} ${r.text.slice(0, 200)}`);

  // Driver logins
  r = await req('POST', '/api/auth/login', { body: { email: 'one@test.local', password: 'DriverPass123!' } });
  const driver1Token = r.json && r.json.token;
  check('driver 1 login', r.status === 200 && !!driver1Token, `status=${r.status}`);
  r = await req('POST', '/api/auth/login', { body: { email: 'two@test.local', password: 'DriverPass123!' } });
  const driver2Token = r.json && r.json.token;
  check('driver 2 login', r.status === 200 && !!driver2Token, `status=${r.status}`);

  // Driver sign-in accepts a phone number OR an email
  r = await req('POST', '/api/auth/login', { body: { identifier: '(317) 555-1001', password: 'DriverPass123!' } });
  check('driver 1 login by phone (formatted)', r.status === 200 && !!r.json.token, `status=${r.status}`);
  r = await req('POST', '/api/auth/login', { body: { identifier: '+13175551001', password: 'DriverPass123!' } });
  check('driver 1 login by phone (+1 digits)', r.status === 200 && !!r.json.token, `status=${r.status}`);
  r = await req('POST', '/api/auth/login', { body: { identifier: 'one@test.local', password: 'DriverPass123!' } });
  check('driver 1 login by identifier=email', r.status === 200 && !!r.json.token, `status=${r.status}`);
  r = await req('POST', '/api/auth/login', { body: { identifier: '3175551001', password: 'WrongPass!' } });
  check('login with wrong password returns 401', r.status === 401, `status=${r.status}`);
  r = await req('POST', '/api/auth/login', { body: { identifier: '3175559999', password: 'DriverPass123!' } });
  check('login with unknown phone returns 401', r.status === 401, `status=${r.status}`);
  r = await req('POST', '/api/admin/drivers', { token: adminToken, body: { name: 'Test Driver Three', password: 'DriverPass123!', phone: '317-555-1003' } });
  const driver3 = r.json;
  check('create driver 3 with phone only (no email)', r.status === 201 && driver3.id && driver3.email === null && driver3.phone === '317-555-1003', `status=${r.status} ${r.text.slice(0, 200)}`);
  r = await req('POST', '/api/auth/login', { body: { identifier: '3175551003', password: 'DriverPass123!' } });
  check('driver 3 login by phone', r.status === 200 && !!r.json.token, `status=${r.status}`);
  r = await req('POST', '/api/admin/drivers', { token: adminToken, body: { name: 'No Contact', password: 'DriverPass123!' } });
  check('create driver with neither phone nor email returns 400', r.status === 400, `status=${r.status}`);
  r = await req('POST', '/api/admin/drivers', { token: adminToken, body: { name: 'Dup Phone', email: 'dup@test.local', password: 'DriverPass123!', phone: '(317) 555-1001' } });
  check('create driver with duplicate phone returns 409', r.status === 409, `status=${r.status}`);
  r = await req('POST', '/api/admin/drivers', { token: adminToken, body: { name: 'Dup Email', email: 'one@test.local', password: 'DriverPass123!', phone: '(317) 555-1004' } });
  check('create driver with duplicate email returns 409', r.status === 409, `status=${r.status}`);
  r = await req('POST', '/api/auth/login', { body: { identifier: 'akash@lxl.local', password: 'AdminPass123!' } });
  check('admin login by email still works', r.status === 200 && r.json.user.role === 'admin', `status=${r.status}`);

  // Load assignment produced a notification for driver 1
  r = await req('GET', '/api/driver/notifications', { token: driver1Token });
  check('load assignment creates driver notification', r.status === 200 && Array.isArray(r.json) && r.json.some((n) => n.type === 'load_assigned'), JSON.stringify(r.json).slice(0, 200));

  // 8. Trailer change (immediate, no approval)
  r = await req('POST', '/api/driver/trailers/change', { token: driver1Token, body: { trailerId: trailer302.id } });
  check('driver 1 trailer change to T-302 (immediate)', r.status === 200 && r.json.unitNumber === 'T-302' && r.json.driverId === driver1.id, `status=${r.status} ${r.text.slice(0, 200)}`);
  r = await req('GET', '/api/driver/home', { token: driver1Token });
  check('driver 1 home now shows trailer T-302', r.status === 200 && r.json.trailer?.unitNumber === 'T-302', JSON.stringify(r.json).slice(0, 300));
  r = await req('GET', `/api/admin/trailers`, { token: adminToken });
  const t301 = Array.isArray(r.json) ? r.json.find((t) => t.unitNumber === 'T-301') : null;
  check('previous trailer T-301 released by change', !!t301 && t301.driverId === null, JSON.stringify(t301));

  // 9. Trailer change conflict → 409
  r = await req('POST', '/api/driver/trailers/change', { token: driver2Token, body: { trailerId: trailer302.id } });
  check('driver 2 trailer change to taken T-302 returns 409', r.status === 409, `status=${r.status} ${r.text.slice(0, 200)}`);
  r = await req('GET', '/api/driver/home', { token: driver2Token });
  check('driver 2 still has no trailer after 409', r.status === 200 && r.json.trailer === null, JSON.stringify(r.json).slice(0, 200));

  // 10. Submit unit_change request, admin approves, truck applies
  r = await req('POST', '/api/driver/trucks/request-change', { token: driver1Token, body: { truckId: truck202.id, reason: 'Truck 201 has a warning light' } });
  const unitReq = r.json;
  check('submit unit_change request for truck 202', r.status === 201 && unitReq.type === 'unit_change' && unitReq.status === 'pending', `status=${r.status} ${r.text.slice(0, 200)}`);
  r = await req('GET', '/api/admin/requests', { token: adminToken });
  check('admin sees pending request first', r.status === 200 && Array.isArray(r.json) && r.json.some((x) => x.id === unitReq.id), `status=${r.status}`);
  r = await req('POST', `/api/admin/requests/${unitReq.id}/decide`, { token: adminToken, body: { decision: 'approved', note: 'Approved — swap to 202' } });
  check('admin approves unit_change request', r.status === 200 && r.json.status === 'approved', `status=${r.status} ${r.text.slice(0, 200)}`);
  r = await req('GET', '/api/driver/home', { token: driver1Token });
  check('approved unit change applies: driver 1 now on truck 202', r.status === 200 && r.json.truck?.unitNumber === '202', JSON.stringify(r.json).slice(0, 300));
  r = await req('GET', '/api/admin/trucks', { token: adminToken });
  const t201 = Array.isArray(r.json) ? r.json.find((t) => t.unitNumber === '201') : null;
  check('old truck 201 released after approved change', !!t201 && t201.driverId === null, JSON.stringify(t201));
  r = await req('GET', '/api/driver/notifications', { token: driver1Token });
  check('request decision creates driver notification', r.status === 200 && Array.isArray(r.json) && r.json.some((n) => n.type === 'request_decided'), JSON.stringify(r.json).slice(0, 200));

  // 11. Upload a document + download it back
  const form = new FormData();
  form.append('file', new Blob(['fake fuel receipt content'], { type: 'text/plain' }), 'fuel-receipt.txt');
  form.append('kind', 'fuel_receipt');
  form.append('loadId', String(load1.id));
  form.append('label', 'Fuel receipt — LXL-TEST-1');
  form.append('amountCents', '41310');
  r = await req('POST', '/api/driver/documents', { token: driver1Token, form });
  const doc = r.json;
  check('upload document (fuel receipt $413.10)', r.status === 201 && doc.kind === 'fuel_receipt' && doc.amountCents === 41310 && !!doc.url, `status=${r.status} ${r.text.slice(0, 200)}`);
  if (doc && doc.url) {
    r = await req('GET', doc.url, { token: driver1Token });
    check('download own uploaded file', r.status === 200 && r.text.includes('fake fuel receipt'), `status=${r.status}`);
    r = await req('GET', doc.url, { token: driver2Token });
    check("other driver cannot download someone else's file (403)", r.status === 403, `status=${r.status}`);
  }

  // 12. Update location; admin sees it
  r = await req('POST', '/api/driver/location', { token: driver1Token, body: { lat: 39.7684, lng: -86.1581 } });
  check('driver 1 posts location', r.status === 200 && r.json.ok === true, `status=${r.status} ${r.text.slice(0, 200)}`);
  r = await req('GET', '/api/admin/locations', { token: adminToken });
  check('admin locations shows driver 1 GPS', r.status === 200 && Array.isArray(r.json) && r.json.some((l) => l.driverId === driver1.id && l.lat === 39.7684), JSON.stringify(r.json).slice(0, 300));

  // 13. Auth guards
  r = await req('GET', '/api/driver/home');
  check('unauthenticated driver home returns 401', r.status === 401, `status=${r.status}`);
  r = await req('GET', '/api/admin/drivers', { token: driver1Token });
  check('driver cannot access admin endpoint (403)', r.status === 403, `status=${r.status}`);
  r = await req('GET', '/api/setup/status');
  check('setup status now: needsSetup=false', r.status === 200 && r.json.needsSetup === false, JSON.stringify(r.json));

  // 14. Complete the load
  r = await req('POST', `/api/driver/loads/${load1.id}/complete`, { token: driver1Token });
  check('driver completes load', r.status === 200 && r.json.status === 'completed' && !!r.json.completedAt, `status=${r.status} ${r.text.slice(0, 200)}`);
  r = await req('GET', '/api/driver/loads/history', { token: driver1Token });
  check('completed load appears in history', r.status === 200 && Array.isArray(r.json) && r.json.some((l) => l.id === load1.id), `status=${r.status}`);
} catch (e) {
  console.error('Smoke test crashed:', e);
  failures += 1;
}

console.log(`\n${results.filter((x) => x.ok).length}/${results.length} steps passed${failures ? ` — ${failures} FAILED` : ''}`);
cleanup();
process.exit(failures ? 1 : 0);
