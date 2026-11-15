/* LXL Driver — standalone web app (no build step).
   Same-origin API: all calls are fetch('/api/...').
   Spec: ~/workspace/lxl-driver-native/API_CONTRACT.md */
'use strict';

const state = {
  token: localStorage.getItem('lxl_token') || null,
  user: null,
  adminView: 'dashboard',
  driverView: 'home',
  yardFilter: 'all', // all | yard | road
  dispatchDriverId: null,
  driversCache: [],
  map: null,
  mapMarkers: [],
  expandedLoads: {},
  expandedPaperwork: {},
};
let timers = [];

function clearTimers() { timers.forEach(clearInterval); timers = []; }
function addTimer(fn, ms) { const id = setInterval(fn, ms); timers.push(id); return id; }

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtMoney(cents) {
  if (cents === null || cents === undefined || cents === '') return '—';
  return '$' + (Number(cents) / 100).toFixed(2);
}
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d) ? esc(s) : d.toLocaleString();
}
function fmtDateOnly(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d) ? esc(s) : d.toLocaleDateString();
}
/* Load route cell: warehouse names (when set) on the bold line, street
   addresses below. Falls back to plain addresses for older loads. */
function routeCell(l) {
  const wh = [l.pickupWarehouse, l.deliveryWarehouse].filter(Boolean).join(' → ');
  const addr = esc(l.pickupLocation) + ' → ' + esc(l.deliveryLocation);
  return wh ? '<strong>' + esc(wh) + '</strong><br><span class="muted small">' + addr + '</span>' : addr;
}
/* One-line route for summary cards: warehouse names when set, else addresses. */
function routeLine(l) {
  return esc(l.pickupWarehouse || l.pickupLocation) + ' → ' + esc(l.deliveryWarehouse || l.deliveryLocation);
}
function dollarsToCents(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Math.round(parseFloat(v) * 100);
  return isNaN(n) ? null : n;
}

/* ---------- toast / banner ---------- */
let toastTimer = null;
function toast(msg, kind) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 6000);
}
function showError(e) { toast(e && e.message ? e.message : 'Something went wrong.', 'error'); }

/* ---------- API ---------- */
async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const isForm = opts.body instanceof FormData;
  if (!isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.indexOf('application/json') !== -1) data = await res.json().catch(() => null);
  if (res.status === 401) {
    signOutLocal();
    // A failed sign-in must say so: the server's own message tells the
    // user the credentials were wrong. Every other 401 is an expired
    // session. (Before this, a wrong password also showed "Session
    // expired", which sent the owner in circles on his iPad.)
    const isLogin = path === '/api/auth/login';
    throw new Error(isLogin
      ? ((data && data.error) || 'Invalid phone number, email or password')
      : 'Session expired — please sign in again.');
  }
  if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
  return data;
}

/* ---------- file downloads (Bearer token required — plain <a href> won't work) ---------- */
async function downloadFile(url, filename, view, mimeType) {
  try {
    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + state.token } });
    if (res.status === 401) { signOutLocal(); throw new Error('Session expired — please sign in again.'); }
    if (!res.ok) throw new Error('Download failed (' + res.status + ')');
    // Give the blob an explicit type from the filename extension. A blob
    // built from a generic (octet-stream) response opens as a download
    // instead of rendering inline — that is why View used to download.
    const ext = String(filename || '').split('.').pop().toLowerCase();
    const extType = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain' }[ext];
    const type = extType || mimeType || res.headers.get('content-type') || 'application/octet-stream';
    const blob = new Blob([await res.arrayBuffer()], { type });
    const objUrl = URL.createObjectURL(blob);
    if (view) {
      window.open(objUrl, '_blank');
    } else {
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = filename || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
  } catch (e) { showError(e); }
}
window.viewFile = function (url, filename, mimeType) { downloadFile(url, filename, true, mimeType); };
window.downloadFileAction = function (url, filename, mimeType) { downloadFile(url, filename, false, mimeType); };

/* ---------- auth ---------- */
function signOutLocal() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('lxl_token');
  clearTimers();
}
async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* token may already be gone */ }
  signOutLocal();
  boot();
}
function saveSession(user, token) {
  state.token = token;
  state.user = user;
  localStorage.setItem('lxl_token', token);
}

async function boot() {
  clearTimers();
  document.body.classList.remove('rc-bg');
  removeRcBgLayer();
  document.body.classList.remove('dash-bg');
  removeDashBgLayer();
  const app = document.getElementById('app');
  app.innerHTML = '<div class="page"><p class="muted">Loading…</p></div>';
  // If we already have a token, try to resume the session.
  if (state.token) {
    try {
      const me = await api('/api/me');
      state.user = me;
      enterShell();
      return;
    } catch (e) {
      signOutLocal(); // bad/expired token — fall through to sign-in
    }
  }
  try {
    const setup = await fetch('/api/setup/status').then(r => r.json());
    let demo = { demoAvailable: false, demoDriverName: null };
    try { demo = await fetch('/api/demo/info').then(r => r.json()); } catch (e) { /* demo info is optional */ }
    if (setup.needsSetup) renderSetup();
    else renderSignin(demo);
  } catch (e) {
    app.innerHTML = '<div class="auth-wrap"><div class="auth-card">' +
      '<h1>Lubana Xpress LLC</h1><p>Could not reach the server. Make sure the LXL server is running, then try again.</p>' +
      '<p class="muted small">' + esc(e.message) + '</p>' +
      '<button class="btn" onclick="boot()">Retry</button></div></div>';
  }
}
window.boot = boot;

function authHeader(title) {
  return '<div class="logo-row"><img src="assets/logo.png" alt="LXL logo"><span class="brand">Lubana Xpress LLC</span></div>' +
    '<h1>' + esc(title) + '</h1>';
}

function renderSetup() {
  const app = document.getElementById('app');
  app.innerHTML = '<div class="auth-wrap"><div class="auth-card">' + authHeader('First-run setup') +
    '<p class="muted">No admin account exists yet. Create the first admin account to get started.</p>' +
    '<form id="setupForm">' +
    '<div class="field"><label for="su-name">Your name</label><input id="su-name" required autocomplete="name"></div>' +
    '<div class="field"><label for="su-email">Email</label><input id="su-email" type="email" required autocomplete="email"></div>' +
    '<div class="field"><label for="su-pass">Password (min 8 characters)</label><input id="su-pass" type="password" required minlength="8" autocomplete="new-password"></div>' +
    '<button class="btn w100" type="submit">Create admin account</button>' +
    '</form></div></div>';
  document.getElementById('setupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const data = await api('/api/setup/admin', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('su-name').value.trim(),
          email: document.getElementById('su-email').value.trim(),
          password: document.getElementById('su-pass').value,
        }),
      });
      saveSession(data.user, data.token);
      toast('Admin account created. Welcome, ' + data.user.name + '!', 'ok');
      enterShell();
    } catch (err) { showError(err); btn.disabled = false; }
  });
}

function renderSignin(demo) {
  const app = document.getElementById('app');
  let demoHtml = '';
  if (demo && demo.demoAvailable) {
    demoHtml = '<div class="demo-sep">— or —</div>' +
      '<button class="btn btn-ghost w100" id="demoBtn" type="button">Try the demo' +
      (demo.demoDriverName ? ' — ' + esc(demo.demoDriverName) : '') + '</button>';
  }
  app.innerHTML = '<div class="auth-wrap"><div class="auth-card">' + authHeader('Sign in') +
    '<form id="loginForm">' +
    '<div class="field"><label for="li-id">Phone number or email</label>' +
    '<input id="li-id" required autocomplete="username" placeholder="Phone number or email"></div>' +
    '<div class="field"><label for="li-pass">Password</label><input id="li-pass" type="password" required autocomplete="current-password"></div>' +
    '<button class="btn w100" type="submit">Sign in</button>' +
    '</form>' + demoHtml + '</div></div>';
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          identifier: document.getElementById('li-id').value.trim(),
          password: document.getElementById('li-pass').value,
        }),
      });
      saveSession(data.user, data.token);
      enterShell();
    } catch (err) { showError(err); btn.disabled = false; }
  });
  const demoBtn = document.getElementById('demoBtn');
  if (demoBtn) demoBtn.addEventListener('click', async () => {
    demoBtn.disabled = true;
    try {
      const data = await api('/api/demo/enter', { method: 'POST', body: JSON.stringify({ role: 'driver' }) });
      saveSession(data.user, data.token);
      toast('Signed in as demo driver.', 'ok');
      enterShell();
    } catch (err) { showError(err); demoBtn.disabled = false; }
  });
}

function enterShell() {
  clearTimers();
  if (!state.user) return boot();
  if (state.user.role === 'admin') renderAdminShell();
  else renderDriverShell();
}

function topbar() {
  return '<header class="topbar">' +
    '<img class="logo" src="assets/logo.png" alt="LXL logo">' +
    '<span class="brand">Lubana Xpress LLC</span>' +
    '<span class="spacer"></span>' +
    '<span class="who">' + esc(state.user ? state.user.name : '') + (state.user ? ' · ' + esc(state.user.role) : '') + '</span>' +
    '<button class="btn btn-ghost btn-sm" onclick="signOut()">Sign out</button>' +
    '</header>';
}
window.signOut = signOut;

/* ================= ADMIN ================= */
const ADMIN_VIEWS = [
  ['dashboard', 'Dashboard'],
  ['drivers', 'Drivers'],
  ['admins', 'Admins'],
  ['equipment', 'Trucks & Trailers'],
  ['loads', 'Loads'],
  ['documents', 'Documents'],
  ['requests', 'Requests'],
  ['dispatch', 'Dispatch'],
  ['locations', 'Locations'],
  ['ratecons', 'Rate Cons'],
];

function renderAdminShell() {
  const app = document.getElementById('app');
  app.innerHTML = topbar() +
    '<div class="admin-layout">' +
    '<nav class="sidebar" id="adminSidebar"></nav>' +
    '<main class="admin-main" id="adminMain"></main>' +
    '</div>';
  renderAdminSidebar();
  renderAdminView(state.adminView);
}

function renderAdminSidebar(pendingRequests) {
  const nav = document.getElementById('adminSidebar');
  if (!nav) return;
  nav.innerHTML = ADMIN_VIEWS.filter(([key]) => key !== 'admins' || (state.user && state.user.isMainAdmin)).map(([key, label]) => {
    const badge = (key === 'requests' && pendingRequests > 0)
      ? '<span class="badge">' + pendingRequests + '</span>' : '';
    return '<button data-view="' + key + '" class="' + (state.adminView === key ? 'active' : '') + '">' +
      esc(label) + badge + '</button>';
  }).join('');
  nav.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    state.adminView = b.dataset.view;
    renderAdminSidebar(pendingRequests);
    renderAdminView(state.adminView);
  }));
}

async function renderAdminView(view) {
  clearTimers();
  document.body.classList.remove('rc-bg');
  removeRcBgLayer();
  document.body.classList.remove('dash-bg');
  removeDashBgLayer();
  const main = document.getElementById('adminMain');
  if (!main) return;
  main.innerHTML = '<p class="muted">Loading…</p>';
  if (view === 'admins' && !(state.user && state.user.isMainAdmin)) {
    main.innerHTML = '<p class="empty">Only the main admin can manage admin accounts.</p>';
    return;
  }
  try {
    if (view === 'dashboard') await viewDashboard(main);
    else if (view === 'drivers') await viewDrivers(main);
    else if (view === 'admins') await viewAdmins(main);
    else if (view === 'equipment') await viewEquipment(main);
    else if (view === 'loads') await viewLoads(main);
    else if (view === 'documents') await viewDocuments(main);
    else if (view === 'requests') await viewRequests(main);
    else if (view === 'dispatch') await viewDispatch(main);
    else if (view === 'locations') await viewLocations(main);
    else if (view === 'ratecons') await viewRateCons(main);
  } catch (e) { main.innerHTML = '<p class="empty">Could not load this view.</p>'; showError(e); }
}

/* ---------- Dashboard ---------- */
async function viewDashboard(main) {
  // Google Maps has no .remove(); dropping the reference is enough — the
  // old container is discarded with innerHTML on every view switch.
  state.dashMap = null;
  state.dashMapMarkers = [];
  state.dashMapFitted = false;
  document.body.classList.add('dash-bg'); // truck-sunset background + glass (removed on view switch)
  ensureDashBgLayer();
  const [data, trucks, trailers, loads, rcs, locs] = await Promise.all([
    api('/api/admin/overview'),
    api('/api/admin/trucks').catch(() => []),
    api('/api/admin/trailers').catch(() => []),
    api('/api/admin/loads').catch(() => []),
    api('/api/admin/rate-confirmations').catch(() => []),
    api('/api/admin/locations').catch(() => []),
  ]);
  const drivers = data.drivers || data || [];
  const list = Array.isArray(drivers) ? drivers : [];
  const counts = data.counts || {};
  const count = (key, fallback) => (counts[key] !== undefined ? counts[key] : fallback);
  const truckCount = count('trucks', Array.isArray(trucks) ? trucks.length : '—');
  const trailerCount = count('trailers', Array.isArray(trailers) ? trailers.length : '—');
  const loadList = Array.isArray(loads) ? loads : [];
  const activeLoads = count('activeLoads', loadList.filter(l => l.status === 'active').length);
  const pendingReq = count('pendingRequests', list.reduce((n, d) => n + (Number(d.pendingRequests) || 0), 0));
  const activeLoadByDriver = {};
  loadList.forEach(l => { if (l.status === 'active' && l.driverId != null) activeLoadByDriver[l.driverId] = l; });
  const rcByLoad = {};
  (Array.isArray(rcs) ? rcs : []).forEach(r => { if (r.loadId != null && r.rateCents != null) rcByLoad[r.loadId] = r; });
  const locByDriver = {};
  (Array.isArray(locs) ? locs : []).forEach(l => { locByDriver[l.driverId] = l; });
  const LIVE_MS = 15 * 60 * 1000;
  const locFresh = (loc) => !!(loc && loc.updatedAt && (Date.now() - Date.parse(loc.updatedAt) < LIVE_MS));
  const isLive = (d) => d.active !== false && locFresh(locByDriver[d.id] || d.location);
  main.innerHTML = '<div class="dash-head"><h1 style="margin:0">Dashboard</h1><span class="status-pill live"><span class="dot"></span>Live</span></div>' +
    '<div class="dash-stats">' +
    '<div class="glass-panel dash-stat"><div class="stat-num">' + count('drivers', list.length) + '</div><div class="stat-label">Drivers</div></div>' +
    '<div class="glass-panel dash-stat"><div class="stat-num">' + truckCount + '</div><div class="stat-label">Trucks</div></div>' +
    '<div class="glass-panel dash-stat"><div class="stat-num">' + trailerCount + '</div><div class="stat-label">Trailers</div></div>' +
    '<div class="glass-panel dash-stat"><div class="stat-num">' + activeLoads + '</div><div class="stat-label">Active loads</div></div>' +
    '<div class="glass-panel dash-stat"><div class="stat-num">' + pendingReq + '</div><div class="stat-label">Pending requests</div></div>' +
    '</div>' +
    '<div class="dash-main">' +
    '<div class="dash-drivers"><h2>Drivers</h2>' +
    (list.length ? list.map(d => dashDriverCard(d, activeLoadByDriver[d.id], rcByLoad, locByDriver[d.id] || d.location, isLive(d))).join('') : '<p class="empty">No drivers yet. Add one from the Drivers page.</p>') +
    '</div>' +
    '<div class="dash-track">' +
    '<div class="glass-panel"><h2 style="margin-top:0">Live tracking</h2><div id="dashMap" class="dash-map"></div><p class="small muted" id="dashMapNote" style="display:none"></p></div>' +
    '<div class="glass-panel mt" id="dashFleet"></div>' +
    '</div></div>';
  renderAdminSidebar(pendingReq);
  fillCitySlots();
  const compass = (h) => {
    if (typeof h !== 'number') return '—';
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(h / 45) % 8] + ' (' + Math.round(h) + '°)';
  };
  const speedText = (l) => (typeof l.speedMph === 'number' ? Math.round(l.speedMph) + ' mph' : '—');
  const renderFleet = (locList, driverList) => {
    const el = document.getElementById('dashFleet');
    if (!el) return;
    const drivers = driverList || list;
    const byId = {};
    locList.forEach(l => { byId[l.driverId] = l; });
    el.innerHTML = '<h2 style="margin-top:0">Fleet</h2>' + (drivers.length ? drivers.map(d => {
      const l = byId[d.id] || d.location;
      const on = d.active !== false && locFresh(l);
      const right = on
        ? (typeof l.speedMph === 'number' ? Math.round(l.speedMph) + ' mph' : 'Live')
        : (l && l.updatedAt ? 'Last seen ' + esc(fmtDate(l.updatedAt)) : 'No location yet');
      const truckNo = d.truck ? (d.truck.unitNumber || '') : (d.truckUnitNumber || '');
      const trailerNo = d.trailer ? (d.trailer.unitNumber || '') : (d.trailerUnitNumber || '');
      const citySlot = l ? '<div class="small city-slot" data-city-lat="' + esc(l.lat) + '" data-city-lng="' + esc(l.lng) + '">Locating…</div>' : '';
      return '<div class="fleet-row"><span class="fleet-dot' + (on ? '' : ' off') + '"></span><div style="flex:1;min-width:0"><strong>' + esc(d.name) + '</strong><div class="small muted">' + esc(truckNo) + (truckNo && trailerNo ? ' · ' : '') + esc(trailerNo) + '</div>' + citySlot + '</div><span class="small muted">' + right + '</span></div>';
    }).join('') : '<p class="empty">No drivers yet.</p>');
    fillCitySlots();
  };
  const refreshPills = (locList, driverList) => {
    const byId = {};
    locList.forEach(l => { byId[l.driverId] = l; });
    const drivers = driverList || list;
    drivers.forEach(d => {
      const pill = document.querySelector('[data-dash-status="' + d.id + '"]');
      if (!pill) return;
      const l = byId[d.id] || d.location;
      const on = d.active !== false && locFresh(l);
      pill.className = 'status-pill ' + (on ? 'live' : 'off');
      pill.innerHTML = '<span class="dot"></span>' + (d.active === false ? 'Inactive' : (on ? 'On the road' : 'Offline'));
    });
  };
  const drawMarkers = (locList) => {
    if (!state.dashMap || !window.google || !google.maps) return;
    (state.dashMapMarkers || []).forEach(m => m.setMap(null));
    state.dashMapMarkers = [];
    const bounds = new google.maps.LatLngBounds();
    locList.forEach(l => {
      if (l.lat === undefined || l.lng === undefined) return;
      const pos = { lat: Number(l.lat), lng: Number(l.lng) };
      const marker = new google.maps.Marker({
        position: pos, map: state.dashMap, title: l.driverName || ('Driver ' + l.driverId),
        icon: driverPinIcon(l.driverName || ''),
      });
      marker.addListener('click', () => {
        if (state.dashInfo) state.dashInfo.close();
        state.dashInfo = new google.maps.InfoWindow({
          content: '<strong>' + esc(l.driverName || ('Driver ' + l.driverId)) + '</strong><br>Near: <span id="dash-iw-city-' + l.driverId + '">Locating…</span><br>Speed: ' + speedText(l) + '<br>Heading: ' + compass(l.heading) + '<br>Last update: ' + esc(fmtDate(l.updatedAt)),
        });
        state.dashInfo.open(state.dashMap, marker);
        getCityState(l.lat, l.lng).then(place => {
          const cel = document.getElementById('dash-iw-city-' + l.driverId);
          if (cel) cel.textContent = place || '—';
        });
      });
      state.dashMapMarkers.push(marker);
      bounds.extend(pos);
    });
    if (state.dashMapMarkers.length === 1 && !state.dashMapFitted) { state.dashMap.setCenter(state.dashMapMarkers[0].getPosition()); state.dashMap.setZoom(12); state.dashMapFitted = true; }
    else if (state.dashMapMarkers.length > 1 && !state.dashMapFitted) { state.dashMap.fitBounds(bounds); state.dashMapFitted = true; }
  };
  const refreshDashboard = async () => {
    if (state.adminView !== 'dashboard') return;
    try {
      const [d2, trucks2, trailers2, loads2, rcs2, locs2] = await Promise.all([
        api('/api/admin/overview'),
        api('/api/admin/trucks').catch(() => []),
        api('/api/admin/trailers').catch(() => []),
        api('/api/admin/loads').catch(() => []),
        api('/api/admin/rate-confirmations').catch(() => []),
        api('/api/admin/locations').catch(() => []),
      ]);
      const drivers2 = d2.drivers || d2 || [];
      const list2 = Array.isArray(drivers2) ? drivers2 : [];
      const counts2 = d2.counts || {};
      const count2 = (key, fallback) => (counts2[key] !== undefined ? counts2[key] : fallback);
      const loadList2 = Array.isArray(loads2) ? loads2 : [];
      const activeLoadByDriver2 = {};
      loadList2.forEach(l => { if (l.status === 'active' && l.driverId != null) activeLoadByDriver2[l.driverId] = l; });
      const rcByLoad2 = {};
      (Array.isArray(rcs2) ? rcs2 : []).forEach(r => { if (r.loadId != null && r.rateCents != null) rcByLoad2[r.loadId] = r; });
      const locByDriver2 = {};
      (Array.isArray(locs2) ? locs2 : []).forEach(l => { locByDriver2[l.driverId] = l; });
      const locList = Array.isArray(locs2) ? locs2 : [];
      const statsEl = document.querySelector('.dash-stats');
      if (statsEl) {
        statsEl.innerHTML =
          '<div class="glass-panel dash-stat"><div class="stat-num">' + count2('drivers', list2.length) + '</div><div class="stat-label">Drivers</div></div>' +
          '<div class="glass-panel dash-stat"><div class="stat-num">' + count2('trucks', Array.isArray(trucks2) ? trucks2.length : '—') + '</div><div class="stat-label">Trucks</div></div>' +
          '<div class="glass-panel dash-stat"><div class="stat-num">' + count2('trailers', Array.isArray(trailers2) ? trailers2.length : '—') + '</div><div class="stat-label">Trailers</div></div>' +
          '<div class="glass-panel dash-stat"><div class="stat-num">' + count2('activeLoads', loadList2.filter(l => l.status === 'active').length) + '</div><div class="stat-label">Active loads</div></div>' +
          '<div class="glass-panel dash-stat"><div class="stat-num">' + count2('pendingRequests', list2.reduce((n, d) => n + (Number(d.pendingRequests) || 0), 0)) + '</div><div class="stat-label">Pending requests</div></div>';
      }
      const driversEl = document.querySelector('.dash-drivers');
      if (driversEl) {
        driversEl.innerHTML = '<h2>Drivers</h2>' +
          (list2.length ? list2.map(d => dashDriverCard(d, activeLoadByDriver2[d.id], rcByLoad2, locByDriver2[d.id] || d.location, d.active !== false && locFresh(locByDriver2[d.id] || d.location))).join('') : '<p class="empty">No drivers yet. Add one from the Drivers page.</p>');
        fillCitySlots();
      }
      renderFleet(locList, list2);
      refreshPills(locList, list2);
      if (!state.dashMap) {
        const g = await ensureGoogleMaps();
        const mapEl = document.getElementById('dashMap');
        if (!mapEl) return;
        if (!g) {
          const note = document.getElementById('dashMapNote');
          if (note) { note.style.display = 'block'; note.textContent = 'Google Maps is not set up yet — the map key is missing. Driver locations are listed below.'; }
          return;
        }
        state.dashMap = new g.Map(mapEl, { center: { lat: 39.7684, lng: -86.1581 }, zoom: 5, mapTypeId: 'hybrid', streetViewControl: false });
      }
      drawMarkers(locList);
    } catch (e) { /* keep the last good dashboard on refresh errors */ }
  };
  renderFleet(Array.isArray(locs) ? locs : []);
  await refreshDashboard();
  // The whole dashboard refreshes itself every 23 seconds — stats, driver
  // cards, fleet list and map markers — so changes pop up on their own.
  addTimer(refreshDashboard, 23000);
}
function dashDriverCard(d, load, rcByLoad, loc, live) {
  const truck = d.truck ? (d.truck.unitNumber || d.truck) : (d.truckUnitNumber || '—');
  const trailer = d.trailer ? (d.trailer.unitNumber || d.trailer) : (d.trailerUnitNumber || '—');
  const initial = String(d.name || '?').trim().charAt(0).toUpperCase();
  const status = d.active === false
    ? '<span class="status-pill off" data-dash-status="' + d.id + '"><span class="dot"></span>Inactive</span>'
    : (live
      ? '<span class="status-pill live" data-dash-status="' + d.id + '"><span class="dot"></span>On the road</span>'
      : '<span class="status-pill off" data-dash-status="' + d.id + '"><span class="dot"></span>Offline</span>');
  const chips = '<span class="chip">Truck ' + esc(truck) + '</span><span class="chip">Trailer ' + esc(trailer) + '</span>' +
    (load ? '<span class="chip">' + esc(load.reference || '') + '</span>' : '') +
    (load && rcByLoad[load.id] ? '<span class="chip gold">' + fmtMoney(rcByLoad[load.id].rateCents) + '</span>' : '');
  let route = '';
  if (load) {
    const prog = routeProgress(load);
    route = '<div class="dw-route">' +
      '<div class="dw-route-places">' + esc(shortPlace(load.pickupLocation)) + ' &rarr; ' + esc(shortPlace(load.deliveryLocation)) + '</div>' +
      (prog == null ? '' :
        '<div class="dw-route-bar"><div class="dw-route-fill" style="width:' + Math.round(prog * 100) + '%"></div></div>' +
        '<div class="dw-route-meta small muted">' + Math.round(prog * 100) + '% &middot; Pickup ' + esc(fmtShortTime(load.pickupAt, load.pickupTimezone)) + ' &rarr; Delivery ' + esc(fmtShortTime(load.deliveryAt, load.deliveryTimezone)) + '</div>') +
      '</div>';
  } else {
    route = '<p class="small muted mt">No active load</p>';
  }
  const speed = (live && loc && typeof loc.speedMph === 'number') ? ' &middot; ' + Math.round(loc.speedMph) + ' mph' : '';
  const citySlot = (live && loc && loc.lat !== undefined && loc.lng !== undefined) ? ' &middot; <span class="city-slot" data-city-lat="' + esc(loc.lat) + '" data-city-lng="' + esc(loc.lng) + '">Locating…</span>' : '';
  return '<div class="glass-panel dw">' +
    '<div class="dw-head"><div class="dw-avatar' + (d.active === false ? ' off' : '') + '">' + esc(initial) + '</div>' +
    '<div class="dw-id"><h3>' + esc(d.name) + '</h3><div class="small muted">' + esc(d.phone || '') + (d.phone && d.email ? ' · ' : '') + esc(d.email || '') + '</div></div>' +
    status + '</div>' +
    '<div class="dw-chips">' + chips + '</div>' +
    route +
    '<p class="small muted dw-foot">Pending requests: <strong>' + (Number(d.pendingRequests) || 0) + '</strong> &middot; Unread messages: <strong>' + (Number(d.unreadMessages) || 0) + '</strong>' + speed + citySlot + '</p>' +
    '</div>';
}
/* Route progress from a load's pickup/delivery times: 0 before pickup,
   1 after delivery, null when the times are missing or invalid. */
function routeProgress(load) {
  if (!load || !load.pickupAt || !load.deliveryAt) return null;
  const p = Date.parse(load.pickupAt), q = Date.parse(load.deliveryAt);
  if (isNaN(p) || isNaN(q) || q <= p) return null;
  return Math.max(0, Math.min(1, (Date.now() - p) / (q - p)));
}
/* "904 Edwards Dr, Lebanon IN 46052" -> "Lebanon, IN". */
function shortPlace(addr) {
  if (!addr) return '—';
  const m = String(addr).match(/,\s*([^,]+?)\s+([A-Z]{2})\s+\d{5}/);
  return m ? (m[1] + ', ' + m[2]) : String(addr).split(',').slice(-2).join(',').trim();
}
function fmtShortTime(iso, tz) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz || 'America/Indiana/Indianapolis' }); } catch (e) { return '—'; }
}
/* Google Maps loader: fetches the browser key from the server (admin-only)
   and loads the Maps JavaScript API once. Returns google.maps, or null when
   no key is configured or the script fails — callers show a fallback note. */
let googleMapsPromise = null;
async function ensureGoogleMaps() {
  if (window.google && google.maps) return google.maps;
  if (googleMapsPromise) return googleMapsPromise;
  googleMapsPromise = (async () => {
    try {
      const cfg = await api('/api/admin/maps-config').catch(() => ({}));
      const key = cfg && cfg.googleMapsApiKey;
      if (!key) return null;
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key);
        s.async = true; s.defer = true;
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
      return (window.google && google.maps) ? google.maps : null;
    } catch (e) { return null; }
  })();
  return googleMapsPromise;
}
/* Gold circle pin with the driver's initial — on-brand marker for the map. */
function driverPinIcon(name) {
  const initial = String(name || '?').trim().charAt(0).toUpperCase();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><circle cx="18" cy="18" r="16" fill="#F2B705" stroke="#111111" stroke-width="2"/><text x="18" y="24" font-size="16" font-weight="bold" text-anchor="middle" fill="#111111" font-family="Arial">' + initial + '</text></svg>';
  return { url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg), scaledSize: new google.maps.Size(36, 36), anchor: new google.maps.Point(18, 18) };
}
/* City + state for a driver position: reverse-geocodes the coordinates
   through Google (Geocoding API, same key as the maps). Results are cached
   by rounded coordinates so the 10-second refresh doesn't re-geocode the
   same spot over and over. Returns e.g. "Lebanon, IN", or null. */
const geoCache = new Map();
async function getCityState(lat, lng) {
  const key = Number(lat).toFixed(3) + ',' + Number(lng).toFixed(3);
  if (geoCache.has(key)) return geoCache.get(key);
  const pr = (async () => {
    try {
      const g = await ensureGoogleMaps();
      if (!g || !google.maps.importLibrary) return null;
      // Geocoder lives in the modular "geocoding" library — the classic
      // google.maps.Geocoder is not reliably present, which made lookups
      // silently return nothing (city/state showed "—").
      const { Geocoder } = await google.maps.importLibrary('geocoding');
      const geocoder = new Geocoder();
      const out = await new Promise((resolve) => geocoder.geocode({ location: { lat: Number(lat), lng: Number(lng) } }, (results, status) => resolve({ results, status })));
      if (out.status !== 'OK' || !out.results || !out.results.length) return null;
      const comps = out.results[0].address_components || [];
      const find = (type) => { const c = comps.find(c => (c.types || []).includes(type)); return c ? c.short_name : null; };
      const city = find('locality') || find('sublocality') || find('postal_town') || find('administrative_area_level_2');
      const state = find('administrative_area_level_1');
      return (city && state) ? (city + ', ' + state) : (city || state || null);
    } catch (e) { return null; }
  })();
  geoCache.set(key, pr);
  return pr;
}
/* Fills every .city-slot that hasn't been filled yet (each carries its
   coordinates in data-city-lat / data-city-lng). Call after any render
   that adds slots — fleet list, driver widgets, Locations table. */
function fillCitySlots() {
  document.querySelectorAll('.city-slot:not([data-city-done])').forEach(el => {
    el.setAttribute('data-city-done', '1');
    const lat = el.getAttribute('data-city-lat'), lng = el.getAttribute('data-city-lng');
    if (lat === null || lng === null) return;
    getCityState(lat, lng).then(place => {
      if (!document.contains(el)) return;
      el.textContent = place || '—';
    });
  });
}
/* The dashboard background is a real fixed layer (not a body background):
   body backgrounds are unreliable for glass — backdrop filters don't
   always see them, and iOS Safari ignores background-attachment: fixed.
   Same pattern as the Rate Cons layer. */
function ensureDashBgLayer() {
  if (!document.getElementById('dashBgLayer')) {
    const layer = document.createElement('div');
    layer.id = 'dashBgLayer';
    document.body.prepend(layer);
  }
}
function removeDashBgLayer() {
  const layer = document.getElementById('dashBgLayer');
  if (layer) layer.remove();
}

/* ---------- Drivers ---------- */
async function viewDrivers(main) {
  const drivers = await api('/api/admin/drivers');
  state.driversCache = Array.isArray(drivers) ? drivers : [];
  // /api/admin/drivers does not include assignments — merge them from /overview.
  const driverUnits = {};
  try {
    const overview = await api('/api/admin/overview');
    (Array.isArray(overview) ? overview : (overview.drivers || [])).forEach(o => {
      driverUnits[o.id] = { truck: o.truck || null, trailer: o.trailer || null };
    });
  } catch (e) { /* overview unavailable — assignment columns stay blank */ }
  main.innerHTML = '<h1>Drivers</h1>' +
    '<div class="card"><h2>Add driver</h2><form id="addDriverForm">' +
    '<div class="form-row">' +
    '<div class="field"><label for="ad-name">Name *</label><input id="ad-name" required></div>' +
    '<div class="field"><label for="ad-phone">Phone</label><input id="ad-phone" type="tel" autocomplete="tel"></div>' +
    '<div class="field"><label for="ad-email">Email</label><input id="ad-email" type="email" autocomplete="email"></div>' +
    '<div class="field"><label for="ad-pass">Password *</label><input id="ad-pass" type="password" required minlength="8" autocomplete="new-password"></div>' +
    '</div><p class="small muted">At least one of phone or email is required. Drivers sign in with their phone number or email.</p>' +
    '<div class="form-actions"><button class="btn" type="submit">Add driver</button></div>' +
    '</form></div>' +
    '<div class="card"><div class="table-wrap"><table><thead><tr>' +
    '<th>Name</th><th>Phone</th><th>Email</th><th>Truck</th><th>Trailer</th><th>Status</th><th></th>' +
    '</tr></thead><tbody>' +
    state.driversCache.map(d => { const u = driverUnits[d.id] || {}; const dTruck = u.truck || d.truck; const dTrailer = u.trailer || d.trailer; return '<tr>' +
      '<td><strong>' + esc(d.name) + '</strong></td>' +
      '<td>' + esc(d.phone || '—') + '</td><td>' + esc(d.email || '—') + '</td>' +
      '<td>' + esc(dTruck ? (dTruck.unitNumber || dTruck) : (d.truckUnitNumber || '—')) + '</td>' +
      '<td>' + esc(dTrailer ? (dTrailer.unitNumber || dTrailer) : (d.trailerUnitNumber || '—')) + '</td>' +
      '<td>' + (d.active === false ? '<span class="pill red">Inactive</span>' : '<span class="pill green">Active</span>') + '</td>' +
      '<td><button class="btn btn-ghost btn-sm" data-toggle-driver="' + d.id + '" data-active="' + (d.active === false) + '">' +
      (d.active === false ? 'Activate' : 'Deactivate') + '</button> ' +
      '<button class="btn btn-ghost btn-sm" data-reset-driver="' + d.id + '" data-driver-name="' + esc(d.name) + '">Reset password</button> ' +
      '<button class="btn btn-danger btn-sm" data-delete-driver="' + d.id + '" data-driver-name="' + esc(d.name) + '">Delete</button></td></tr>'; }).join('') +
    '</tbody></table></div>' +
    (state.driversCache.length ? '' : '<p class="empty">No drivers yet.</p>') + '</div>';

  document.getElementById('addDriverForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = document.getElementById('ad-phone').value.trim();
    const email = document.getElementById('ad-email').value.trim();
    if (!phone && !email) { toast('Enter a phone number or an email for the driver.', 'error'); return; }
    try {
      await api('/api/admin/drivers', { method: 'POST', body: JSON.stringify({
        name: document.getElementById('ad-name').value.trim(),
        phone: phone || undefined, email: email || undefined,
        password: document.getElementById('ad-pass').value,
      }) });
      toast('Driver added.', 'ok');
      renderAdminView('drivers');
    } catch (err) { showError(err); }
  });
  main.querySelectorAll('[data-toggle-driver]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.toggleDriver;
    const active = btn.dataset.active === 'true';
    if (!confirm((active ? 'Activate' : 'Deactivate') + ' this driver?')) return;
    try {
      await api('/api/admin/drivers/' + id + '/active', { method: 'POST', body: JSON.stringify({ active }) });
      toast('Driver ' + (active ? 'activated' : 'deactivated') + '.', 'ok');
      renderAdminView('drivers');
    } catch (err) { showError(err); }
  }));
  main.querySelectorAll('[data-delete-driver]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.deleteDriver;
    const name = btn.dataset.driverName || 'this driver';
    if (!confirm('Delete ' + name + '? This removes the driver profile and unassigns their truck and trailer. It cannot be undone.')) return;
    try {
      await api('/api/admin/drivers/' + id, { method: 'DELETE' });
      toast('Driver deleted.', 'ok');
      renderAdminView('drivers');
    } catch (err) { showError(err); }
  }));
  main.querySelectorAll('[data-reset-driver]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.resetDriver;
    const name = btn.dataset.driverName || 'this driver';
    const pw = prompt('New password for ' + name + ' (at least 8 characters):');
    if (pw === null) return;
    if (pw.length < 8) { toast('Password must be at least 8 characters.', 'error'); return; }
    const pw2 = prompt('Type the new password again to confirm:');
    if (pw2 === null) return;
    if (pw2 !== pw) { toast('Passwords do not match.', 'error'); return; }
    try {
      await api('/api/admin/drivers/' + id + '/password', { method: 'POST', body: JSON.stringify({ password: pw }) });
      toast('Password reset. ' + name + ' will need to sign in again with the new password.', 'ok');
    } catch (err) { showError(err); }
  }));
}

/* ---------- Admins & Dispatchers ---------- */
async function viewAdmins(main) {
  const admins = await api('/api/admin/admins');
  const list = Array.isArray(admins) ? admins : [];
  main.innerHTML = '<h1>Admins & Dispatchers</h1>' +
    '<div class="card"><h2>Add admin / dispatcher</h2><form id="addAdminForm">' +
    '<div class="form-row">' +
    '<div class="field"><label for="aa-name">Name *</label><input id="aa-name" required></div>' +
    '<div class="field"><label for="aa-email">Email *</label><input id="aa-email" type="email" required autocomplete="email"></div>' +
    '<div class="field"><label for="aa-pass">Password *</label><input id="aa-pass" type="password" required minlength="8" autocomplete="new-password"></div>' +
    '</div><p class="small muted">Admins sign in to the Admin Portal with their email and password. New admins are dispatchers: they can do everything except manage other admin accounts — only the main admin can do that.</p>' +
    '<div class="form-actions"><button class="btn" type="submit">Add admin</button></div>' +
    '</form></div>' +
    '<div class="card"><div class="table-wrap"><table><thead><tr>' +
    '<th>Name</th><th>Email</th><th>Status</th><th></th>' +
    '</tr></thead><tbody>' +
    list.map(a => '<tr>' +
      '<td><strong>' + esc(a.name) + '</strong>' + (state.user && a.id === state.user.id ? ' <span class="pill">You</span>' : '') + '</td>' +
      '<td>' + esc(a.email || '—') + '</td>' +
      '<td>' + (a.active === false ? '<span class="pill red">Inactive</span>' : '<span class="pill green">Active</span>') + '</td>' +
      '<td>' + (state.user && a.id === state.user.id ? '' : '<button class="btn btn-danger btn-sm" data-delete-admin="' + a.id + '" data-admin-name="' + esc(a.name) + '">Delete</button>') + '</td></tr>').join('') +
    '</tbody></table></div>' +
    (list.length ? '' : '<p class="empty">No admins yet.</p>') + '</div>';

  document.getElementById('addAdminForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/admins', { method: 'POST', body: JSON.stringify({
        name: document.getElementById('aa-name').value.trim(),
        email: document.getElementById('aa-email').value.trim(),
        password: document.getElementById('aa-pass').value,
      }) });
      toast('Admin added.', 'ok');
      renderAdminView('admins');
    } catch (err) { showError(err); }
  });
  main.querySelectorAll('[data-delete-admin]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.deleteAdmin;
    const name = btn.dataset.adminName || 'this admin';
    if (!confirm('Delete ' + name + '? They will no longer be able to sign in to the Admin Portal.')) return;
    try {
      await api('/api/admin/admins/' + id, { method: 'DELETE' });
      toast('Admin deleted.', 'ok');
      renderAdminView('admins');
    } catch (err) { showError(err); }
  }));
}

/* ---------- Trucks & Trailers (yard board + paperwork) ---------- */
async function viewEquipment(main) {
  const [trucks, trailers, drivers] = await Promise.all([
    api('/api/admin/trucks'), api('/api/admin/trailers'), api('/api/admin/drivers'),
  ]);
  state.driversCache = Array.isArray(drivers) ? drivers : [];
  const tList = Array.isArray(trucks) ? trucks : [];
  const rList = Array.isArray(trailers) ? trailers : [];
  const yardCount = tList.concat(rList).filter(u => u.yardStatus === 'yard').length;
  const roadCount = tList.concat(rList).filter(u => u.yardStatus === 'road').length;
  const chip = (key, label, n) => '<button class="chip' + (state.yardFilter === key ? ' active' : '') +
    '" data-yard="' + key + '">' + esc(label) + ' (' + n + ')</button>';
  main.innerHTML = '<h1>Trucks &amp; Trailers</h1>' +
    '<div class="chips">' + chip('all', 'All units', tList.length + rList.length) +
    chip('yard', 'In the Yard', yardCount) + chip('road', 'On the Road', roadCount) + '</div>' +
    '<h2>Trucks</h2><div id="truckList">' + tList.map(u => unitCard(u, 'truck')).join('') + '</div>' +
    '<div class="card"><h3>Add truck</h3><form id="addTruckForm"><div class="form-row">' +
    '<div class="field"><label>Unit number *</label><input name="unitNumber" required></div>' +
    '<div class="field"><label>Make</label><input name="make"></div>' +
    '<div class="field"><label>Model</label><input name="model"></div>' +
    '<div class="field"><label>Year</label><input name="year" type="number"></div>' +
    '<div class="field"><label>Plate</label><input name="plate"></div>' +
    '<div class="field"><label>VIN</label><input name="vin"></div>' +
    '</div><div class="form-actions"><button class="btn" type="submit">Add truck</button></div></form></div>' +
    '<h2>Trailers</h2><div id="trailerList">' + rList.map(u => unitCard(u, 'trailer')).join('') + '</div>' +
    '<div class="card"><h3>Add trailer</h3><form id="addTrailerForm"><div class="form-row">' +
    '<div class="field"><label>Unit number *</label><input name="unitNumber" required></div>' +
    '<div class="field"><label>Kind / type</label><input name="kind" placeholder="e.g. Dry van"></div>' +
    '<div class="field"><label>Year</label><input name="year" type="number"></div>' +
    '<div class="field"><label>Plate</label><input name="plate"></div>' +
    '<div class="field"><label>VIN</label><input name="vin"></div>' +
    '</div><div class="form-actions"><button class="btn" type="submit">Add trailer</button></div></form></div>';

  main.querySelectorAll('[data-yard]').forEach(b => b.addEventListener('click', () => {
    state.yardFilter = b.dataset.yard;
    renderAdminView('equipment');
  }));
  bindUnitCards(main, 'truck');
  bindUnitCards(main, 'trailer');
  document.getElementById('addTruckForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { unitNumber: f.get('unitNumber').trim() };
    ['make', 'model', 'plate', 'vin'].forEach(k => { if (f.get(k)) body[k] = f.get(k).trim(); });
    if (f.get('year')) body.year = parseInt(f.get('year'), 10);
    try { await api('/api/admin/trucks', { method: 'POST', body: JSON.stringify(body) }); toast('Truck added.', 'ok'); renderAdminView('equipment'); }
    catch (err) { showError(err); }
  });
  document.getElementById('addTrailerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { unitNumber: f.get('unitNumber').trim() };
    ['kind', 'plate', 'vin'].forEach(k => { if (f.get(k)) body[k] = f.get(k).trim(); });
    if (f.get('year')) body.year = parseInt(f.get('year'), 10);
    try { await api('/api/admin/trailers', { method: 'POST', body: JSON.stringify(body) }); toast('Trailer added.', 'ok'); renderAdminView('equipment'); }
    catch (err) { showError(err); }
  });
}

function unitVisible(u) {
  if (state.yardFilter === 'all') return true;
  return u.yardStatus === state.yardFilter;
}
function unitCard(u, type) {
  if (!unitVisible(u)) return '';
  const desc = type === 'truck'
    ? [u.year, u.make, u.model].filter(Boolean).join(' ')
    : [u.year, u.kind].filter(Boolean).join(' ');
  const driverOpts = '<option value="">— Unassigned —</option>' + state.driversCache.map(d =>
    '<option value="' + d.id + '"' + (u.driverId === d.id ? ' selected' : '') + '>' + esc(d.name) + '</option>').join('');
  const key = type + '-' + u.id;
  const open = state.expandedPaperwork[key];
  return '<div class="unit-card" data-unit="' + type + '" data-id="' + u.id + '">' +
    '<div class="flex-between"><span class="unit-no">' + esc(u.unitNumber) + '</span>' +
    (u.yardStatus === 'road' ? '<span class="pill blue">On the Road</span>' : '<span class="pill green">In the Yard</span>') + '</div>' +
    '<p class="muted small">' + esc(desc || '—') + (u.plate ? ' · Plate ' + esc(u.plate) : '') + (u.vin ? ' · VIN ' + esc(u.vin) : '') + '</p>' +
    '<p class="small">Assigned driver: <strong>' + esc(u.driverName || 'None') + '</strong></p>' +
    '<div class="row">' +
    '<button class="btn btn-ghost btn-sm" data-yard-toggle>Move to ' + (u.yardStatus === 'road' ? 'Yard' : 'Road') + '</button>' +
    '<select data-assign-select>' + driverOpts + '</select>' +
    '<button class="btn btn-ghost btn-sm" data-assign-btn>Assign</button>' +
    '<button class="btn btn-ghost btn-sm" data-paperwork-btn>' + (open ? 'Hide paperwork' : 'Paperwork') + '</button>' +
    '</div><div class="docs-list" data-paperwork></div></div>';
}
function bindUnitCards(main, type) {
  const base = type === 'truck' ? '/api/admin/trucks' : '/api/admin/trailers';
  main.querySelectorAll('.unit-card[data-unit="' + type + '"]').forEach(card => {
    const id = card.dataset.id;
    const key = type + '-' + id;
    card.querySelector('[data-yard-toggle]').addEventListener('click', async () => {
      const cur = card.querySelector('.pill').textContent.indexOf('Road') !== -1 ? 'road' : 'yard';
      try {
        await api(base + '/' + id + '/yard-status', { method: 'POST', body: JSON.stringify({ yardStatus: cur === 'road' ? 'yard' : 'road' }) });
        toast('Yard status updated.', 'ok');
        renderAdminView('equipment');
      } catch (err) { showError(err); }
    });
    card.querySelector('[data-assign-btn]').addEventListener('click', async () => {
      const sel = card.querySelector('[data-assign-select]');
      const driverId = sel.value ? parseInt(sel.value, 10) : null;
      try {
        await api(base + '/' + id + '/assign', { method: 'POST', body: JSON.stringify({ driverId }) });
        toast(driverId ? 'Driver assigned.' : 'Driver unassigned.', 'ok');
        renderAdminView('equipment');
      } catch (err) { showError(err); }
    });
    card.querySelector('[data-paperwork-btn]').addEventListener('click', async () => {
      state.expandedPaperwork[key] = !state.expandedPaperwork[key];
      const box = card.querySelector('[data-paperwork]');
      if (!state.expandedPaperwork[key]) { box.innerHTML = ''; card.querySelector('[data-paperwork-btn]').textContent = 'Paperwork'; return; }
      card.querySelector('[data-paperwork-btn]').textContent = 'Hide paperwork';
      box.innerHTML = '<p class="muted small">Loading paperwork…</p>';
      try {
        const docs = await api('/api/admin/equipment-documents?unitType=' + type + '&unitId=' + id);
        const list = Array.isArray(docs) ? docs : [];
        box.innerHTML = (list.length ? '<div class="table-wrap"><table><thead><tr><th>Type</th><th>File</th><th>Note</th><th>Date</th><th></th></tr></thead><tbody>' +
          list.map(d => '<tr><td>' + esc(d.docType) + '</td><td>' + esc(d.filename) + '</td><td>' + esc(d.note || '—') + '</td><td>' + fmtDateOnly(d.createdAt) + '</td>' +
          '<td><button class="btn btn-ghost btn-sm" data-view-doc="' + d.id + '">View</button> ' +
          '<button class="btn btn-danger btn-sm" data-del-doc="' + d.id + '">Delete</button></td></tr>').join('') + '</tbody></table></div>'
          : '<p class="empty">No paperwork on file for this unit.</p>') +
          '<form class="inline-form mt" data-doc-form><div class="field"><label>Document type</label><select name="docType">' +
          ['registration', 'insurance', 'annual_inspection', 'title', 'permit', 'other'].map(t => '<option value="' + t + '">' + t.replace('_', ' ') + '</option>').join('') +
          '</select></div><div class="field"><label>File *</label><input type="file" name="file" required></div>' +
          '<div class="field"><label>Note</label><input name="note"></div>' +
          '<button class="btn btn-sm" type="submit">Upload</button></form>';
        box.querySelectorAll('[data-view-doc]').forEach(b => b.addEventListener('click', () => {
          const d = list.find(x => String(x.id) === b.dataset.viewDoc);
          if (d) downloadFile(d.url, d.filename, true, d.mimeType);
        }));
        box.querySelectorAll('[data-del-doc]').forEach(b => b.addEventListener('click', async () => {
          if (!confirm('Delete this document?')) return;
          try { await api('/api/admin/equipment-documents/' + b.dataset.delDoc, { method: 'DELETE' }); toast('Document deleted.', 'ok'); state.expandedPaperwork[key] = false; renderAdminView('equipment'); }
          catch (err) { showError(err); }
        }));
        box.querySelector('[data-doc-form]').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          fd.append('unitType', type);
          fd.append('unitId', id);
          try {
            await api('/api/admin/equipment-documents', { method: 'POST', body: fd });
            toast('Document uploaded.', 'ok');
            state.expandedPaperwork[key] = false;
            renderAdminView('equipment');
          } catch (err) { showError(err); }
        });
      } catch (err) { box.innerHTML = '<p class="empty">Could not load paperwork.</p>'; showError(err); }
    });
    // Auto-open paperwork if it was open before a re-render.
    if (state.expandedPaperwork[key]) card.querySelector('[data-paperwork-btn]').click();
  });
}

/* ---------- Loads ---------- */
async function viewLoads(main) {
  const [loads, drivers] = await Promise.all([api('/api/admin/loads'), api('/api/admin/drivers')]);
  state.driversCache = Array.isArray(drivers) ? drivers : [];
  const list = Array.isArray(loads) ? loads : [];
  main.innerHTML = '<h1>Loads</h1>' +
    '<div class="card"><h2>Assign load</h2><form id="addLoadForm">' +
    '<div class="form-row">' +
    '<div class="field"><label>Driver *</label><select id="al-driver" required>' +
    state.driversCache.map(d => '<option value="' + d.id + '">' + esc(d.name) + '</option>').join('') + '</select></div>' +
    '<div class="field"><label>Reference *</label><input id="al-ref" required placeholder="e.g. LXL-2482"></div>' +
    '<div class="field"><label>Pickup location *</label><input id="al-pickup" required></div>' +
    '<div class="field"><label>Pickup warehouse name</label><input id="al-pickup-wh" placeholder="e.g. Walmart DC 6094"></div>' +
    '<div class="field"><label>Pickup date &amp; time *</label><input id="al-pickup-at" type="datetime-local" required></div>' +
    '<div class="field"><label>Pickup number</label><input id="al-pickup-no"></div>' +
    '<div class="field"><label>Delivery location *</label><input id="al-delivery" required></div>' +
    '<div class="field"><label>Delivery warehouse name</label><input id="al-delivery-wh" placeholder="e.g. Amazon PHL6"></div>' +
    '<div class="field"><label>Delivery date &amp; time *</label><input id="al-delivery-at" type="datetime-local" required></div>' +
    '<div class="field"><label>Delivery number</label><input id="al-delivery-no"></div>' +
    '</div><div class="field"><label>Notes</label><textarea id="al-notes" rows="2"></textarea></div>' +
    '<div class="form-actions"><button class="btn" type="submit">Assign load</button></div></form></div>' +
    '<div class="card"><div class="table-wrap"><table><thead><tr>' +
    '<th>Reference</th><th>Driver</th><th>Pickup → Delivery</th><th>Dates</th><th>Status</th><th>BOL</th><th></th>' +
    '</tr></thead><tbody>' +
    list.map(l => '<tr><td><strong>' + esc(l.reference) + '</strong></td>' +
      '<td>' + esc(l.driverName || '—') + '</td>' +
      '<td>' + routeCell(l) + '</td>' +
      '<td>' + fmtDate(l.pickupAt) + '<br>' + fmtDate(l.deliveryAt) + '</td>' +
      '<td><span class="pill ' + (l.status === 'active' ? 'blue' : l.status === 'completed' ? 'green' : 'red') + '">' + esc(l.status) + '</span></td>' +
      '<td>' + esc(l.bolStatus || '—') + '</td>' +
      '<td>' + (l.status === 'active'
        ? '<button class="btn btn-danger btn-sm" data-cancel-load="' + l.id + '">Cancel</button>'
        : l.status === 'completed'
          ? '<button class="btn btn-ghost btn-sm" data-reopen-load="' + l.id + '">Reopen</button>'
        : l.status === 'cancelled'
          ? '<button class="btn btn-ghost btn-sm" data-reactivate-load="' + l.id + '">Reactivate</button>' : '') + '</td></tr>').join('') +
    '</tbody></table></div>' + (list.length ? '' : '<p class="empty">No loads yet.</p>') + '</div>';

  document.getElementById('addLoadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = id => document.getElementById(id).value.trim();
    const body = {
      driverId: parseInt(v('al-driver'), 10),
      reference: v('al-ref'),
      pickupLocation: v('al-pickup'),
      pickupAt: new Date(v('al-pickup-at')).toISOString(),
      deliveryLocation: v('al-delivery'),
      deliveryAt: new Date(v('al-delivery-at')).toISOString(),
    };
    if (v('al-pickup-wh')) body.pickupWarehouse = v('al-pickup-wh');
    if (v('al-delivery-wh')) body.deliveryWarehouse = v('al-delivery-wh');
    if (v('al-pickup-no')) body.pickupNumber = v('al-pickup-no');
    if (v('al-delivery-no')) body.deliveryNumber = v('al-delivery-no');
    if (v('al-notes')) body.notes = v('al-notes');
    try { await api('/api/admin/loads', { method: 'POST', body: JSON.stringify(body) }); toast('Load assigned.', 'ok'); renderAdminView('loads'); }
    catch (err) { showError(err); }
  });
  main.querySelectorAll('[data-cancel-load]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Cancel this load?')) return;
    try { await api('/api/admin/loads/' + b.dataset.cancelLoad + '/status', { method: 'POST', body: JSON.stringify({ status: 'cancelled' }) }); toast('Load cancelled.', 'ok'); renderAdminView('loads'); }
    catch (err) { showError(err); }
  }));
  main.querySelectorAll('[data-reactivate-load]').forEach(b => b.addEventListener('click', async () => {
    try { await api('/api/admin/loads/' + b.dataset.reactivateLoad + '/status', { method: 'POST', body: JSON.stringify({ status: 'active' }) }); toast('Load reactivated.', 'ok'); renderAdminView('loads'); }
    catch (err) { showError(err); }
  }));
  main.querySelectorAll('[data-reopen-load]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Reopen this load? It goes back to active.')) return;
    try { await api('/api/admin/loads/' + b.dataset.reopenLoad + '/status', { method: 'POST', body: JSON.stringify({ status: 'active' }) }); toast('Load reopened.', 'ok'); renderAdminView('loads'); }
    catch (err) { showError(err); }
  }));
}

/* ---------- Documents (fleet-wide) ---------- */
async function viewDocuments(main) {
  const docs = await api('/api/admin/documents');
  const list = Array.isArray(docs) ? docs : [];
  main.innerHTML = '<h1>Documents</h1><p class="muted">BOLs and receipts from across the fleet.</p>' +
    '<div class="card"><div class="table-wrap"><table><thead><tr>' +
    '<th>Label</th><th>Kind</th><th>Driver</th><th>Load</th><th>Amount</th><th>Date</th><th></th>' +
    '</tr></thead><tbody>' +
    list.map(d => '<tr><td>' + esc(d.label || d.filename || '—') + '</td><td>' + esc(d.kind) + '</td>' +
      '<td>' + esc(d.driverName || '—') + '</td><td>' + esc(d.loadId ? ('#' + d.loadId) : '—') + '</td>' +
      '<td>' + fmtMoney(d.amountCents) + '</td><td>' + fmtDate(d.createdAt) + '</td>' +
      '<td><button class="btn btn-ghost btn-sm" data-doc-view="' + d.id + '">View</button></td></tr>').join('') +
    '</tbody></table></div>' + (list.length ? '' : '<p class="empty">No documents yet.</p>') + '</div>';
  main.querySelectorAll('[data-doc-view]').forEach(b => b.addEventListener('click', () => {
    const d = list.find(x => String(x.id) === b.dataset.docView);
    if (d) downloadFile(d.url, d.filename, true, d.mimeType);
  }));
}

/* ---------- Requests ---------- */
async function viewRequests(main) {
  const reqs = await api('/api/admin/requests');
  const list = Array.isArray(reqs) ? reqs : [];
  const pending = list.filter(r => r.status === 'pending').length;
  renderAdminSidebar(pending);
  main.innerHTML = '<h1>Requests</h1><p class="muted">' + pending + ' pending.</p>' +
    '<div class="card"><div class="table-wrap"><table><thead><tr>' +
    '<th>Driver</th><th>Type</th><th>Reason / details</th><th>Amount</th><th>Status</th><th>Decision</th>' +
    '</tr></thead><tbody>' +
    list.map(r => '<tr><td><strong>' + esc(r.driverName || '—') + '</strong></td>' +
      '<td>' + esc(r.type) + '</td>' +
      '<td><strong>' + esc(r.reason || '') + '</strong>' + (r.details ? '<br><span class="muted">' + esc(r.details) + '</span>' : '') + (r.adminNote ? '<br><span class="muted">Admin note: ' + esc(r.adminNote) + '</span>' : '') + '</td>' +
      '<td>' + fmtMoney(r.amountCents) + '</td>' +
      '<td><span class="pill ' + (r.status === 'pending' ? 'gold' : r.status === 'approved' ? 'green' : 'red') + '">' + esc(r.status) + '</span></td>' +
      '<td>' + (r.status === 'pending'
        ? '<input class="small" style="width:130px;margin-bottom:6px" placeholder="Note (optional)" data-note="' + r.id + '"><br>' +
          '<button class="btn btn-sm" data-approve="' + r.id + '">Approve</button> ' +
          '<button class="btn btn-danger btn-sm" data-deny="' + r.id + '">Deny</button>'
        : '<span class="muted small">' + (r.decidedAt ? fmtDate(r.decidedAt) : '') + '</span>') + '</td></tr>').join('') +
    '</tbody></table></div>' + (list.length ? '' : '<p class="empty">No requests yet.</p>') + '</div>';
  const decide = async (id, decision) => {
    const noteEl = main.querySelector('[data-note="' + id + '"]');
    try {
      await api('/api/admin/requests/' + id + '/decide', { method: 'POST', body: JSON.stringify({ decision, note: noteEl ? noteEl.value.trim() || undefined : undefined }) });
      toast('Request ' + decision + '.', 'ok');
      renderAdminView('requests');
    } catch (err) { showError(err); }
  };
  main.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', () => decide(b.dataset.approve, 'approved')));
  main.querySelectorAll('[data-deny]').forEach(b => b.addEventListener('click', () => decide(b.dataset.deny, 'denied')));
}

/* ---------- Dispatch (admin) ---------- */
async function viewDispatch(main) {
  const drivers = await api('/api/admin/drivers');
  state.driversCache = Array.isArray(drivers) ? drivers : [];
  if (!state.dispatchDriverId && state.driversCache.length) state.dispatchDriverId = state.driversCache[0].id;
  main.innerHTML = '<h1>Dispatch</h1><div class="grid2" style="grid-template-columns: 260px 1fr; align-items: start;">' +
    '<div class="card"><h3>Drivers</h3><div id="dispatchDriverList">' +
    state.driversCache.map(d => '<button class="btn btn-ghost w100 mb" style="text-align:left" data-dispatch-driver="' + d.id + '">' + esc(d.name) + '</button>').join('') +
    '</div></div>' +
    '<div class="card"><h3 id="dispatchTitle">Messages</h3>' +
    '<div class="msg-list" id="dispatchThread"><p class="muted">Loading…</p></div>' +
    '<form id="dispatchSendForm" class="inline-form"><div class="field"><label>Message</label><input id="dispatchBody" required placeholder="Type a message to the driver…"></div>' +
    '<button class="btn" type="submit">Send</button></form>' +
    '<p class="muted small">Thread refreshes every 15 seconds.</p></div></div>';

  const loadThread = async () => {
    if (!state.dispatchDriverId || state.adminView !== 'dispatch') return;
    try {
      const msgs = await api('/api/admin/messages/' + state.dispatchDriverId);
      const list = Array.isArray(msgs) ? msgs : [];
      const d = state.driversCache.find(x => x.id === state.dispatchDriverId);
      document.getElementById('dispatchTitle').textContent = 'Messages — ' + (d ? d.name : '');
      const thread = document.getElementById('dispatchThread');
      if (thread) thread.innerHTML = list.length ? list.map(m =>
        '<div class="msg' + (m.sender === 'dispatch' ? ' mine' : '') + '">' + esc(m.body) +
        '<div class="meta">' + esc(m.sender === 'dispatch' ? (m.senderName || 'Dispatch') : (d ? d.name : 'Driver')) + ' · ' + fmtDate(m.createdAt) + '</div></div>').join('')
        : '<p class="empty">No messages yet.</p>';
    } catch (e) { /* keep the old thread visible on a transient failure */ }
  };
  main.querySelectorAll('[data-dispatch-driver]').forEach(b => b.addEventListener('click', () => {
    state.dispatchDriverId = parseInt(b.dataset.dispatchDriver, 10);
    loadThread();
  }));
  document.getElementById('dispatchSendForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = document.getElementById('dispatchBody').value.trim();
    if (!body || !state.dispatchDriverId) return;
    try {
      await api('/api/admin/messages/' + state.dispatchDriverId, { method: 'POST', body: JSON.stringify({ body }) });
      document.getElementById('dispatchBody').value = '';
      loadThread();
    } catch (err) { showError(err); }
  });
  await loadThread();
  addTimer(loadThread, 15000);
}

/* ---------- Locations (live map) ---------- */
async function viewLocations(main) {
  main.innerHTML = '<h1>Locations</h1><p class="muted">Live locations of your drivers — last known position shows even after a driver signs out. Refreshes every 10 seconds.</p>' +
    '<div id="map"></div><div id="locList" class="mt"></div>';
  state.locMap = null;
  state.locMapMarkers = [];
  const compass = (h) => {
    if (typeof h !== 'number') return '—';
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(h / 45) % 8] + ' (' + Math.round(h) + '°)';
  };
  const speedText = (l) => (typeof l.speedMph === 'number' ? Math.round(l.speedMph) + ' mph' : '—');
  const renderList = (locs) => {
    const el = document.getElementById('locList');
    if (!el) return;
    el.innerHTML = locs.length
      ? '<div class="card"><div class="table-wrap"><table><thead><tr><th>Driver</th><th>Speed</th><th>Latitude</th><th>Longitude</th><th>City / State</th><th>Last update</th></tr></thead><tbody>' +
        locs.map(l => '<tr><td><strong>' + esc(l.driverName || ('Driver ' + l.driverId)) + '</strong></td><td>' + speedText(l) + '</td><td>' + esc(l.lat) + '</td><td>' + esc(l.lng) + '</td><td><span class="city-slot" data-city-lat="' + esc(l.lat) + '" data-city-lng="' + esc(l.lng) + '">Locating…</span></td><td>' + fmtDate(l.updatedAt) + '</td></tr>').join('') +
        '</tbody></table></div>'
      : '<p class="empty">No driver locations yet — a location appears once a driver signs in and shares theirs.</p>';
    fillCitySlots();
  };
  const loadLocs = async () => {
    if (state.adminView !== 'locations') return;
    try {
      const locs = await api('/api/admin/locations');
      const list = Array.isArray(locs) ? locs : [];
      renderList(list);
      const mapEl = document.getElementById('map');
      if (mapEl && !state.locMap) {
        const g = await ensureGoogleMaps();
        if (!g) {
          mapEl.outerHTML = '<div class="card"><p><strong>Map unavailable</strong> — Google Maps is not set up yet (the map key is missing). Driver locations are listed below.</p></div>';
        } else {
          state.locMap = new g.Map(mapEl, { center: { lat: 39.7684, lng: -86.1581 }, zoom: 5, mapTypeId: 'hybrid', streetViewControl: false });
        }
      }
      if (state.locMap && window.google && google.maps) {
        (state.locMapMarkers || []).forEach(m => m.setMap(null));
        state.locMapMarkers = [];
        const bounds = new google.maps.LatLngBounds();
        list.forEach(l => {
          if (l.lat === undefined || l.lng === undefined) return;
          const pos = { lat: Number(l.lat), lng: Number(l.lng) };
          const marker = new google.maps.Marker({
            position: pos, map: state.locMap, title: l.driverName || ('Driver ' + l.driverId),
            icon: driverPinIcon(l.driverName || ''),
          });
          marker.addListener('click', () => {
            if (state.locInfo) state.locInfo.close();
            state.locInfo = new google.maps.InfoWindow({
              content: '<strong>' + esc(l.driverName || ('Driver ' + l.driverId)) + '</strong><br>Near: <span id="loc-iw-city-' + l.driverId + '">Locating…</span><br>Speed: ' + speedText(l) + '<br>Heading: ' + compass(l.heading) + '<br>Last update: ' + esc(fmtDate(l.updatedAt)),
            });
            state.locInfo.open(state.locMap, marker);
            getCityState(l.lat, l.lng).then(place => {
              const cel = document.getElementById('loc-iw-city-' + l.driverId);
              if (cel) cel.textContent = place || '—';
            });
          });
          state.locMapMarkers.push(marker);
          bounds.extend(pos);
        });
        if (state.locMapMarkers.length === 1) { state.locMap.setCenter(state.locMapMarkers[0].getPosition()); state.locMap.setZoom(12); }
        else if (state.locMapMarkers.length > 1) { state.locMap.fitBounds(bounds); }
      }
    } catch (e) { showError(e); }
  };
  await loadLocs();
  addTimer(loadLocs, 10000);
}

/* ---------- Rate Cons ---------- */
/* The RC full-page background is a real fixed layer (not a body
   background): body backgrounds are unreliable for glass — backdrop
   filters don't always see them, and iOS Safari ignores
   background-attachment: fixed. A fixed div paints behind everything
   and the glass blurs it properly. */
function ensureRcBgLayer() {
  if (!document.getElementById('rcBgLayer')) {
    const layer = document.createElement('div');
    layer.id = 'rcBgLayer';
    document.body.prepend(layer);
  }
}
function removeRcBgLayer() {
  const layer = document.getElementById('rcBgLayer');
  if (layer) layer.remove();
}
async function viewRateCons(main) {
  state.rcOutlook = null;
  document.body.classList.add('rc-bg'); // full-page money background + glass (removed on view switch)
  ensureRcBgLayer();
  const [rcs, loads, outlook] = await Promise.all([
    api('/api/admin/rate-confirmations'),
    api('/api/admin/loads').catch(() => []),
    api('/api/admin/outlook/status').catch(() => ({ configured: false, connected: false, email: null })),
  ]);
  const list = Array.isArray(rcs) ? rcs : [];
  const loadList = (Array.isArray(loads) ? loads : []).filter(l => l && l.reference);
  const shortPlace = (a) => (a || '').split(',').pop().replace(/\s*\d{5}(-\d{4})?\s*$/, '').trim();
  const stateOf = (a) => { const m = (a || '').match(/\b([A-Z]{2})\s+\d{5}/); return m ? m[1] : ''; };
  const dateOf = (iso, tz) => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Indiana/Indianapolis', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); }
    catch { return (iso || '').slice(0, 10); }
  };
  const previewName = (l, ext) => l ? l.reference + '_' + stateOf(l.pickupLocation) + '-' + stateOf(l.deliveryLocation) + '_' + dateOf(l.pickupAt, l.pickupTimezone) + '_to_' + dateOf(l.deliveryAt, l.deliveryTimezone) + '.' + (ext || 'pdf') : '';
  const loadOptions = loadList.map(l => '<option value="' + l.id + '">' + esc(l.reference) + ' · ' + esc(shortPlace(l.pickupLocation)) + ' → ' + esc(shortPlace(l.deliveryLocation)) + '</option>').join('');
  main.innerHTML = '<div class="rc-page"><div class="rc-head"><h1>Rate Confirmations</h1><button class="btn" id="rcAddBtn" aria-expanded="false">+ Add RC</button></div><div id="rcAddWrap" style="display:none">' +
    '<div class="card"><h2>Upload rate confirmation</h2>' +
    (loadList.length ? '<form id="rcForm">' +
    '<div class="form-row">' +
    '<div class="field"><label>File *</label><input type="file" name="file" id="rcFile" required></div>' +
    '<div class="field"><label>Load *</label><select name="loadId" id="rcLoad" required>' + loadOptions + '</select></div>' +
    '</div><p class="small muted">Pick the load — the file is automatically renamed to <code id="rcPreview"></code>.</p>' +
    '<div class="form-actions"><button class="btn" type="submit">Upload</button></div>' +
    '<p id="rcResult" class="small mt"></p></form>'
    : '<p class="empty">No loads yet — assign a load first, then upload its rate confirmation here.</p>') +
    '</div>' +
    '<div class="card"><h2>From Outlook email</h2>' +
    (outlook && outlook.configured
      ? (outlook.connected
        ? '<p class="small">Connected as <strong>' + esc(outlook.email || '') + '</strong> — pick the RC email, then the file.</p>' +
          '<div class="form-actions"><button class="btn btn-sm" id="outlookPick">Pick from Outlook</button> <button class="btn btn-ghost btn-sm" id="outlookDisconnect">Disconnect</button></div>'
        : '<p class="small muted">Connect your Outlook mailbox — then the RC comes straight from the email you pick, no downloading.</p>' +
          '<div class="form-actions"><button class="btn btn-sm" id="outlookConnect">Connect Outlook</button></div>')
      : '<p class="small muted">Outlook email is not set up on the server yet.</p>') +
    '<div id="outlookPicker" style="display:none" class="mt"></div>' +
    '<p id="outlookChosen" class="small mt"></p></div></div>' +
    '<div class="card"><div class="rc-search"><input id="rcSearch" type="search" placeholder="Search rate confirmations — reference, broker, route…"></div><div class="table-wrap"><table><thead><tr>' +
    '<th>Reference</th><th>Broker</th><th>Route</th><th>Dates</th><th>Rate</th><th>File</th><th></th>' +
    '</tr></thead><tbody>' +
    list.map(r => '<tr><td><strong>' + esc(r.reference) + '</strong></td>' +
      '<td>' + esc(r.broker || '—') + '</td>' +
      '<td>' + esc(r.pickupState) + ' → ' + esc(r.deliveryState) + '</td>' +
      '<td>' + fmtDateOnly(r.pickupDate) + ' → ' + fmtDateOnly(r.deliveryDate) + '</td>' +
      '<td>' + fmtMoney(r.rateCents) + '</td>' +
      '<td>' + esc(r.filename || '—') + '</td>' +
      '<td><button class="btn btn-ghost btn-sm" data-rc-view="' + r.id + '">View</button> ' +
      '<button class="btn btn-ghost btn-sm" data-rc-dl="' + r.id + '">Download</button> ' +
      '<button class="btn btn-danger btn-sm" data-rc-del="' + r.id + '">Delete</button></td></tr>').join('') +
    '</tbody></table></div><p class="empty" id="rcNoMatch" style="display:none">No rate confirmations match your search.</p>' + (list.length ? '' : '<p class="empty">No rate confirmations yet.</p>') + '</div></div>';

  const rcForm = document.getElementById('rcForm');
  if (rcForm) {
    const updatePreview = () => {
      const sel = document.getElementById('rcLoad');
      const f = document.getElementById('rcFile');
      const l = loadList.find(x => String(x.id) === (sel && sel.value));
      const pickedName = (state.rcOutlook && state.rcOutlook.name) || (f && f.files && f.files[0] ? f.files[0].name : '');
      const ext = pickedName ? (pickedName.split('.').pop() || 'pdf') : 'pdf';
      const pv = document.getElementById('rcPreview');
      if (pv) pv.textContent = previewName(l, ext);
    };
    document.getElementById('rcLoad').addEventListener('change', updatePreview);
    document.getElementById('rcFile').addEventListener('change', updatePreview);
    updatePreview();
    rcForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const loadId = document.getElementById('rcLoad').value;
      try {
        let res;
        if (state.rcOutlook) {
          res = await api('/api/admin/rate-confirmations/from-outlook', { method: 'POST', body: JSON.stringify({ loadId, messageId: state.rcOutlook.messageId, attachmentId: state.rcOutlook.attachmentId, subject: state.rcOutlook.subject }) });
        } else {
          const fd = new FormData(rcForm);
          res = await api('/api/admin/rate-confirmations', { method: 'POST', body: fd });
        }
        const saved = (res && (res.filename || (res.rateConfirmation && res.rateConfirmation.filename))) || '';
        document.getElementById('rcResult').textContent = saved ? 'Saved as: ' + saved : 'Uploaded.';
        toast('Rate confirmation uploaded' + (saved ? ' as ' + saved : '') + '.', 'ok');
        renderAdminView('ratecons');
      } catch (err) { showError(err); }
    });
  }
  // Outlook: connect this admin's mailbox, pick the RC email + file.
  const outlookConnect = document.getElementById('outlookConnect');
  if (outlookConnect) outlookConnect.addEventListener('click', async () => {
    try {
      const res = await api('/api/admin/outlook/auth-url');
      window.open(res.url, '_blank');
      toast('Sign in to Microsoft in the new tab, then come back here.', 'ok');
    } catch (err) { showError(err); }
  });
  const outlookDisconnect = document.getElementById('outlookDisconnect');
  if (outlookDisconnect) outlookDisconnect.addEventListener('click', async () => {
    try {
      await api('/api/admin/outlook/disconnect', { method: 'POST', body: JSON.stringify({}) });
      toast('Outlook disconnected.', 'ok');
      renderAdminView('ratecons');
    }
    catch (err) { showError(err); }
  });
  const outlookPick = document.getElementById('outlookPick');
  if (outlookPick) outlookPick.addEventListener('click', () => loadOutlookMessages(''));
  async function loadOutlookMessages(search) {
    const picker = document.getElementById('outlookPicker');
    if (!picker) return;
    picker.style.display = 'block';
    picker.innerHTML = '<p class="muted small">Loading emails…</p>';
    try {
      const msgs = await api('/api/admin/outlook/messages' + (search ? '?search=' + encodeURIComponent(search) : ''));
      const list = Array.isArray(msgs) ? msgs : [];
      picker.innerHTML = '<div class="field"><label>Search emails</label><input id="outlookSearch" placeholder="Broker name, load number…" value="' + esc(search || '') + '"></div>' +
        (list.length ? list.map(m =>
          '<div class="card outlook-msg" data-outlook-msg="' + esc(m.id) + '" style="cursor:pointer">' +
          '<strong>' + esc(m.subject) + '</strong><p class="small muted">' + esc(m.from) + ' · ' + fmtDate(m.receivedAt) + (m.hasAttachments ? ' · has attachments' : '') + '</p>' +
          '<div class="outlook-atts"></div></div>').join('')
        : '<p class="empty">No emails with attachments found.</p>');
      document.getElementById('outlookSearch').addEventListener('change', (e) => loadOutlookMessages(e.target.value.trim()));
      picker.querySelectorAll('.outlook-msg').forEach(el => el.addEventListener('click', async () => {
        const box = el.querySelector('.outlook-atts');
        if (!box || box.dataset.loaded) return;
        box.dataset.loaded = '1';
        box.innerHTML = '<p class="muted small">Loading attachments…</p>';
        try {
          const atts = await api('/api/admin/outlook/messages/' + encodeURIComponent(el.dataset.outlookMsg) + '/attachments');
          const arr = Array.isArray(atts) ? atts : [];
          box.innerHTML = arr.length ? arr.map(a =>
            '<button class="btn btn-sm" data-outlook-att="' + esc(a.id) + '" data-outlook-att-name="' + esc(a.name) + '">' + esc(a.name) + (a.size ? ' (' + Math.round(a.size / 1024) + ' KB)' : '') + '</button> ').join('')
            : '<p class="small muted">No attachments on this email.</p>';
          box.querySelectorAll('[data-outlook-att]').forEach(b => b.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const subject = el.querySelector('strong').textContent;
            state.rcOutlook = { messageId: el.dataset.outlookMsg, attachmentId: b.dataset.outlookAtt, name: b.dataset.outlookAttName, subject };
            const fileInput = document.getElementById('rcFile');
            if (fileInput) fileInput.required = false;
            const chosen = document.getElementById('outlookChosen');
            if (chosen) chosen.innerHTML = 'Selected from Outlook: <strong>' + esc(b.dataset.outlookAttName) + '</strong> — ' + esc(subject) + ' <button class="btn btn-ghost btn-sm" id="outlookClear">Clear</button>';
            document.getElementById('outlookClear').addEventListener('click', () => {
              state.rcOutlook = null;
              if (fileInput) fileInput.required = true;
              if (chosen) chosen.textContent = '';
            });
            const pv = document.getElementById('rcPreview');
            if (pv) {
              const sel = document.getElementById('rcLoad');
              const l = loadList.find(x => String(x.id) === (sel && sel.value));
              const ext = (b.dataset.outlookAttName.split('.').pop() || 'pdf');
              pv.textContent = previewName(l, ext);
            }
            toast('Attachment selected — pick the load and Upload.', 'ok');
          }));
        } catch (err) { box.innerHTML = '<p class="empty">Could not load attachments.</p>'; showError(err); }
      }));
    } catch (err) { picker.innerHTML = '<p class="empty">Could not load emails.</p>'; showError(err); }
  }
  main.querySelectorAll('[data-rc-view]').forEach(b => b.addEventListener('click', () => {
    const r = list.find(x => String(x.id) === b.dataset.rcView);
    if (r && r.url) downloadFile(r.url, r.filename, true, r.mimeType);
  }));
  main.querySelectorAll('[data-rc-dl]').forEach(b => b.addEventListener('click', () => {
    const r = list.find(x => String(x.id) === b.dataset.rcDl);
    if (r && r.url) downloadFile(r.url, r.filename, false, r.mimeType);
  }));
  main.querySelectorAll('[data-rc-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this rate confirmation?')) return;
    try { await api('/api/admin/rate-confirmations/' + b.dataset.rcDel, { method: 'DELETE' }); toast('Rate confirmation deleted.', 'ok'); renderAdminView('ratecons'); }
    catch (err) { showError(err); }
  }));
  // + Add RC: the upload + Outlook boxes live behind this button.
  const rcAddBtn = document.getElementById('rcAddBtn');
  const rcAddWrap = document.getElementById('rcAddWrap');
  if (rcAddBtn && rcAddWrap) rcAddBtn.addEventListener('click', () => {
    const open = rcAddWrap.style.display === 'none';
    rcAddWrap.style.display = open ? '' : 'none';
    rcAddBtn.textContent = open ? '× Close' : '+ Add RC';
    rcAddBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  // Search the table: reference, broker, route, dates, rate, filename.
  // Normalizes both sides so "dandl" finds "D & L" (the & reads as "and").
  const norm = s => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]/g, '');
  const rcSearch = document.getElementById('rcSearch');
  if (rcSearch) rcSearch.addEventListener('input', () => {
    const q = norm(rcSearch.value.trim());
    let visible = 0;
    main.querySelectorAll('.rc-page tbody tr').forEach(tr => {
      const hit = !q || norm(tr.textContent).includes(q);
      tr.style.display = hit ? '' : 'none';
      if (hit) visible++;
    });
    const nm = document.getElementById('rcNoMatch');
    if (nm) nm.style.display = visible ? 'none' : 'block';
  });
}

/* ================= DRIVER ================= */
const DRIVER_VIEWS = [
  ['home', 'Home'],
  ['truck', 'My Truck'],
  ['trailer', 'My Trailer'],
  ['loads', 'My Loads'],
  ['dispatch', 'Dispatch'],
  ['settings', 'Settings'],
];

function renderDriverShell() {
  const app = document.getElementById('app');
  app.innerHTML = topbar() +
    '<nav class="driver-tabs" id="driverTabs"></nav>' +
    '<div class="page" id="driverMain"></div>';
  renderDriverTabs();
  renderDriverView(state.driverView);
}

function renderDriverTabs() {
  const nav = document.getElementById('driverTabs');
  if (!nav) return;
  nav.innerHTML = DRIVER_VIEWS.map(([key, label]) =>
    '<button data-view="' + key + '" class="' + (state.driverView === key ? 'active' : '') + '">' + esc(label) + '</button>').join('');
  nav.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    state.driverView = b.dataset.view;
    renderDriverTabs();
    renderDriverView(state.driverView);
  }));
}

function goDriver(view) {
  state.driverView = view;
  renderDriverTabs();
  renderDriverView(view);
  window.scrollTo(0, 0);
}
window.goDriver = goDriver;

async function renderDriverView(view) {
  clearTimers();
  const main = document.getElementById('driverMain');
  if (!main) return;
  main.innerHTML = '<p class="muted">Loading…</p>';
  try {
    if (view === 'home') await viewDriverHome(main);
    else if (view === 'truck') await viewDriverTruck(main);
    else if (view === 'trailer') await viewDriverTrailer(main);
    else if (view === 'loads') await viewDriverLoads(main);
    else if (view === 'dispatch') await viewDriverDispatch(main);
    else if (view === 'settings') await viewDriverSettings(main);
  } catch (e) { main.innerHTML = '<p class="empty">Could not load this view.</p>'; showError(e); }
}

function detailBox(label, value, goldBorder) {
  return '<div class="detail-box' + (goldBorder ? ' gold-border' : '') + '"><div class="k">' + esc(label) + '</div><div class="v">' + esc(value || '—') + '</div></div>';
}

/* ---------- Driver Home ---------- */
async function viewDriverHome(main) {
  const home = await api('/api/driver/home');
  const truck = home.truck || null;
  const trailer = home.trailer || null;
  const load = home.activeLoad || null;
  main.innerHTML = '<h1>Hello, ' + esc(state.user.name) + '</h1>' +
    '<div class="home-grid">' +
    '<button class="home-box" onclick="goDriver(\'truck\')">My Truck<span class="sub">' + esc(truck ? truck.unitNumber : 'Not assigned') + '</span></button>' +
    '<button class="home-box" onclick="goDriver(\'trailer\')">My Trailer<span class="sub">' + esc(trailer ? trailer.unitNumber : 'Not assigned') + '</span></button>' +
    '<button class="home-box gold" onclick="goDriver(\'loads\')">Upload Receipts<span class="sub">BOLs &amp; fuel receipts</span></button>' +
    '<button class="home-box" onclick="goDriver(\'dispatch\')">Contact Dispatch' + (home.unreadMessages ? '<span class="sub">' + home.unreadMessages + ' unread message' + (home.unreadMessages > 1 ? 's' : '') + '</span>' : '<span class="sub">Message dispatch</span>') + '</button>' +
    '</div>' +
    '<div class="card"><h2>Active load</h2>' +
    (load
      ? '<p><strong>' + esc(load.reference) + '</strong> · <span class="pill ' + (load.bolStatus === 'wrong' ? 'red' : 'blue') + '">BOL: ' + esc(load.bolStatus || 'pending') + '</span></p>' +
        '<p>' + routeLine(load) + '</p>' +
        '<p class="muted small">Pickup: ' + fmtDate(load.pickupAt) + '<br>Delivery: ' + fmtDate(load.deliveryAt) + '</p>' +
        '<button class="btn" onclick="goDriver(\'loads\')">Open load</button>'
      : '<p class="empty">No active load right now.</p>') +
    (home.pendingRequests ? '<p class="small mt">You have <strong>' + home.pendingRequests + '</strong> pending request' + (home.pendingRequests > 1 ? 's' : '') + '. See Settings → My Requests.</p>' : '') +
    '</div>';
}

/* ---------- My Truck ---------- */
async function viewDriverTruck(main) {
  const home = await api('/api/driver/home');
  const truck = home.truck || null;
  const options = await api('/api/driver/trucks/for-request').catch(() => []);
  const trucks = Array.isArray(options) ? options : [];
  main.innerHTML = '<h1>My Truck</h1>' +
    (truck
      ? '<div class="grid2">' +
        detailBox('Unit number', truck.unitNumber, true) +
        detailBox('Make / Model', [truck.make, truck.model].filter(Boolean).join(' ') || '—') +
        detailBox('Year', truck.year) +
        detailBox('Plate', truck.plate) +
        detailBox('VIN', truck.vin) +
        detailBox('Yard status', truck.yardStatus === 'road' ? 'On the Road' : 'In the Yard') +
        '</div>'
      : '<div class="card"><p class="empty">No truck assigned to you yet. Ask dispatch.</p></div>') +
    '<div class="card"><h2>Request approval to change unit number</h2>' +
    '<p class="muted small">A truck change needs admin approval. Pick a truck and tell dispatch why.</p>' +
    '<form id="truckReqForm"><div class="form-row">' +
    '<div class="field"><label>Truck *</label><select id="tr-truck" required>' +
    trucks.map(t => '<option value="' + t.id + '">' + esc(t.unitNumber) + ' — ' + esc([t.year, t.make, t.model].filter(Boolean).join(' ')) + (t.driverName ? ' (assigned to ' + esc(t.driverName) + ')' : ' (available)') + '</option>').join('') +
    '</select></div>' +
    '<div class="field"><label>Reason *</label><input id="tr-reason" required placeholder="e.g. Truck in the shop"></div>' +
    '</div><div class="form-actions"><button class="btn" type="submit">Send request</button></div></form></div>';

  const form = document.getElementById('truckReqForm');
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/driver/trucks/request-change', { method: 'POST', body: JSON.stringify({
        truckId: parseInt(document.getElementById('tr-truck').value, 10),
        reason: document.getElementById('tr-reason').value.trim(),
      }) });
      toast('Truck change request sent to dispatch.', 'ok');
      renderDriverView('truck');
    } catch (err) { showError(err); }
  });
}

/* ---------- My Trailer ---------- */
async function viewDriverTrailer(main) {
  const trailers = await api('/api/driver/trailers/available');
  const list = Array.isArray(trailers) ? trailers : [];
  const mine = list.find(t => t.isMine || t.own || (t.driverId && state.user && t.driverId === state.user.id));
  main.innerHTML = '<h1>My Trailer</h1>' +
    (mine ? '<p>Your trailer: <strong>' + esc(mine.unitNumber) + '</strong> <button class="btn btn-danger btn-sm" id="releaseTrailer">Release trailer</button></p>'
          : '<p class="muted">You have no trailer assigned. Pick one below — it takes effect immediately.</p>') +
    '<div class="grid2">' + list.map(t => {
      const isMine = mine && t.id === mine.id;
      const takenBy = t.driverName || (t.driverId ? 'another driver' : null);
      return '<div class="card"><div class="flex-between"><h3 style="margin:0">' + esc(t.unitNumber) + '</h3>' +
        (isMine ? '<span class="pill gold">Your trailer</span>' : takenBy ? '<span class="pill red">Taken</span>' : '<span class="pill green">Available</span>') + '</div>' +
        '<p class="muted small">' + esc([t.year, t.kind].filter(Boolean).join(' ') || '—') + (t.plate ? ' · Plate ' + esc(t.plate) : '') + '</p>' +
        (takenBy && !isMine ? '<p class="small">Assigned to: <strong>' + esc(takenBy) + '</strong></p>' : '') +
        (!isMine && !takenBy ? '<button class="btn" data-take-trailer="' + t.id + '">Take this trailer</button>' : '') +
        '</div>';
    }).join('') + '</div>' +
    (list.length ? '' : '<p class="empty">No trailers in the fleet yet.</p>');

  main.querySelectorAll('[data-take-trailer]').forEach(b => b.addEventListener('click', async () => {
    try {
      await api('/api/driver/trailers/change', { method: 'POST', body: JSON.stringify({ trailerId: parseInt(b.dataset.takeTrailer, 10) }) });
      toast('Trailer changed — effective immediately.', 'ok');
      renderDriverView('trailer');
    } catch (err) { showError(err); }
  }));
  const rel = document.getElementById('releaseTrailer');
  if (rel) rel.addEventListener('click', async () => {
    if (!confirm('Release your current trailer?')) return;
    try {
      await api('/api/driver/trailers/release', { method: 'POST', body: JSON.stringify({}) });
      toast('Trailer released.', 'ok');
      renderDriverView('trailer');
    } catch (err) { showError(err); }
  });
}

/* ---------- My Loads ---------- */
async function viewDriverLoads(main) {
  const [active, history] = await Promise.all([
    api('/api/driver/loads/active'),
    api('/api/driver/loads/history'),
  ]);
  const past = Array.isArray(history) ? history : [];
  main.innerHTML = '<h1>My Loads</h1>' +
    '<div class="card"><h2>Active load</h2>' +
    (active ? activeLoadHtml(active) : '<p class="empty">No active load right now.</p>') + '</div>' +
    '<h2>Past Loads</h2>' +
    (past.length ? past.map(pastLoadHtml).join('') : '<p class="empty">No past loads yet.</p>');

  if (active) bindActiveLoad(main, active);
  main.querySelectorAll('[data-past-load]').forEach(row => row.addEventListener('click', async (e) => {
    if (e.target.closest('button')) return;
    const id = row.dataset.pastLoad;
    const body = document.getElementById('past-' + id);
    if (!body) return;
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    if (!open && !state.expandedLoads[id]) {
      state.expandedLoads[id] = true;
      body.innerHTML = '<p class="muted small">Loading documents…</p>';
      try {
        const docs = await api('/api/driver/documents?loadId=' + id);
        const list = Array.isArray(docs) ? docs : [];
        body.innerHTML = list.length
          ? '<div class="table-wrap"><table><thead><tr><th>Label</th><th>Kind</th><th>Amount</th><th>Date</th><th></th></tr></thead><tbody>' +
            list.map(d => '<tr><td>' + esc(d.label || d.filename || '—') + '</td><td>' + esc(d.kind) + '</td><td>' + fmtMoney(d.amountCents) + '</td><td>' + fmtDate(d.createdAt) + '</td>' +
            '<td><button class="btn btn-ghost btn-sm" data-past-doc="' + d.id + '">View</button></td></tr>').join('') + '</tbody></table></div>'
          : '<p class="empty">No documents for this load.</p>';
        body.querySelectorAll('[data-past-doc]').forEach(b => b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const d = list.find(x => String(x.id) === b.dataset.pastDoc);
          if (d) downloadFile(d.url, d.filename, true, d.mimeType);
        }));
      } catch (err) { body.innerHTML = '<p class="empty">Could not load documents.</p>'; showError(err); }
    }
  }));
}

function activeLoadHtml(l) {
  return '<p><strong>' + esc(l.reference) + '</strong> · <span class="pill ' + (l.bolStatus === 'wrong' ? 'red' : l.bolStatus === 'clean' ? 'green' : 'blue') + '">BOL: ' + esc(l.bolStatus || 'pending') + '</span></p>' +
    '<div class="grid2">' +
    '<div class="detail-box"><div class="k">Pickup</div><div class="v" style="font-size:16px">' + esc(l.pickupWarehouse || l.pickupLocation) + '</div><div class="muted small">' + (l.pickupWarehouse ? esc(l.pickupLocation) + '<br>' : '') + fmtDate(l.pickupAt) + (l.pickupNumber ? '<br>Ref: ' + esc(l.pickupNumber) : '') + '</div></div>' +
    '<div class="detail-box"><div class="k">Delivery</div><div class="v" style="font-size:16px">' + esc(l.deliveryWarehouse || l.deliveryLocation) + '</div><div class="muted small">' + (l.deliveryWarehouse ? esc(l.deliveryLocation) + '<br>' : '') + fmtDate(l.deliveryAt) + (l.deliveryNumber ? '<br>Ref: ' + esc(l.deliveryNumber) : '') + '</div></div>' +
    '</div>' +
    (l.notes ? '<p class="small mt">Notes: ' + esc(l.notes) + '</p>' : '') +
    '<div class="grid2 mt">' +
    '<div><h3>Upload BOL scan</h3><form id="bolForm" class="inline-form">' +
    '<div class="field"><label>Kind</label><select name="kind"><option value="pickup_bol">Pickup BOL</option><option value="delivery_bol">Delivery BOL</option></select></div>' +
    '<div class="field"><label>File *</label><input type="file" name="file" required></div>' +
    '<button class="btn btn-sm" type="submit">Upload BOL</button></form></div>' +
    '<div><h3>Upload receipt</h3><form id="receiptForm" class="inline-form">' +
    '<div class="field"><label>Kind</label><select name="kind"><option value="fuel_receipt">Fuel receipt</option><option value="receipt">Other receipt</option></select></div>' +
    '<div class="field"><label>Amount ($)</label><input name="amount" type="number" step="0.01" min="0"></div>' +
    '<div class="field"><label>File *</label><input type="file" name="file" required></div>' +
    '<button class="btn btn-sm" type="submit">Upload receipt</button></form></div>' +
    '</div>' +
    '<div class="form-actions">' +
    '<button class="btn btn-green btn-sm" id="bolClean">Clean BOL</button>' +
    '<button class="btn btn-danger btn-sm" id="bolWrong">Wrong BOL</button>' +
    '<button class="btn btn-gold" id="completeLoad">Complete load</button>' +
    '</div>';
}

function bindActiveLoad(main, load) {
  const upload = async (form, kind) => {
    const fd = new FormData(form);
    fd.append('loadId', String(load.id));
    const amount = fd.get('amount');
    if (amount !== null && amount !== '') {
      const cents = dollarsToCents(amount);
      if (cents !== null) fd.append('amountCents', String(cents));
    }
    fd.delete('amount');
    try {
      await api('/api/driver/documents', { method: 'POST', body: fd });
      toast((kind === 'bol' ? 'BOL' : 'Receipt') + ' uploaded.', 'ok');
      renderDriverView('loads');
    } catch (err) { showError(err); }
  };
  const bolForm = document.getElementById('bolForm');
  if (bolForm) bolForm.addEventListener('submit', (e) => { e.preventDefault(); upload(bolForm, 'bol'); });
  const receiptForm = document.getElementById('receiptForm');
  if (receiptForm) receiptForm.addEventListener('submit', (e) => { e.preventDefault(); upload(receiptForm, 'receipt'); });
  const bolStatus = async (status) => {
    try {
      await api('/api/driver/loads/' + load.id + '/bol-status', { method: 'POST', body: JSON.stringify({ status }) });
      toast('BOL marked ' + status + '.', 'ok');
      renderDriverView('loads');
    } catch (err) { showError(err); }
  };
  document.getElementById('bolClean').addEventListener('click', () => bolStatus('clean'));
  document.getElementById('bolWrong').addEventListener('click', () => bolStatus('wrong'));
  document.getElementById('completeLoad').addEventListener('click', async () => {
    if (!load.bolStatus) { showError(new Error('Mark the BOL result first — tap Clean BOL or Wrong BOL.')); return; }
    if (!confirm('Mark this load complete?')) return;
    const body = {};
    try {
      const pos = await new Promise((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition((p) => resolve(p), () => resolve(null), { timeout: 8000, maximumAge: 60000 });
      });
      if (pos) { body.latitude = pos.coords.latitude; body.longitude = pos.coords.longitude; }
    } catch { /* complete without coords — the server falls back to the last reported location */ }
    try {
      await api('/api/driver/loads/' + load.id + '/complete', { method: 'POST', body: JSON.stringify(body) });
      toast('Load completed.', 'ok');
      renderDriverView('loads');
    } catch (err) { showError(err); }
  });
}

function pastLoadHtml(l) {
  return '<div class="card" style="cursor:pointer" data-past-load="' + l.id + '">' +
    '<div class="flex-between"><strong>' + esc(l.reference) + '</strong>' +
    '<span class="pill ' + (l.status === 'completed' ? 'green' : 'red') + '">' + esc(l.status) + '</span></div>' +
    '<p class="small">' + routeLine(l) + '</p>' +
    '<p class="muted small">' + fmtDate(l.pickupAt) + ' → ' + fmtDate(l.deliveryAt) + ' · BOL: ' + esc(l.bolStatus || '—') + ' · tap for details &amp; documents</p>' +
    '<div id="past-' + l.id + '" style="display:none"></div></div>';
}

/* ---------- Driver Dispatch ---------- */
async function viewDriverDispatch(main) {
  main.innerHTML = '<h1>Dispatch</h1><div class="card">' +
    '<div class="msg-list" id="driverThread"><p class="muted">Loading…</p></div>' +
    '<form id="driverSendForm" class="inline-form"><div class="field"><label>Message</label><input id="driverBody" required placeholder="Type a message to dispatch…"></div>' +
    '<button class="btn" type="submit">Send</button></form>' +
    '<p class="muted small">Thread refreshes every 15 seconds.</p></div>';
  const loadThread = async () => {
    if (state.driverView !== 'dispatch') return;
    try {
      const msgs = await api('/api/driver/messages');
      const list = Array.isArray(msgs) ? msgs : [];
      const thread = document.getElementById('driverThread');
      if (thread) thread.innerHTML = list.length ? list.map(m =>
        '<div class="msg' + (m.sender === 'driver' ? ' mine' : '') + '">' + esc(m.body) +
        '<div class="meta">' + esc(m.sender === 'driver' ? 'You' : (m.senderName || 'Dispatch')) + ' · ' + fmtDate(m.createdAt) + '</div></div>').join('')
        : '<p class="empty">No messages yet. Say hello to dispatch.</p>';
    } catch (e) { /* keep old thread on transient failure */ }
  };
  document.getElementById('driverSendForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = document.getElementById('driverBody').value.trim();
    if (!body) return;
    try {
      await api('/api/driver/messages', { method: 'POST', body: JSON.stringify({ body }) });
      document.getElementById('driverBody').value = '';
      loadThread();
    } catch (err) { showError(err); }
  });
  await loadThread();
  addTimer(loadThread, 15000);
}

/* ---------- Driver Settings ---------- */
async function viewDriverSettings(main) {
  const [reqs, notes] = await Promise.all([
    api('/api/driver/requests'),
    api('/api/driver/notifications'),
  ]);
  const reqList = Array.isArray(reqs) ? reqs : [];
  const noteList = Array.isArray(notes) ? notes : [];
  main.innerHTML = '<h1>Settings</h1>' +
    '<div class="card"><div class="flex-between"><div><h2 style="margin:0">' + esc(state.user.name) + '</h2>' +
    '<p class="muted small">' + esc(state.user.phone || '') + (state.user.phone && state.user.email ? ' · ' : '') + esc(state.user.email || '') + '</p></div>' +
    (state.user.photoUrl ? '<img src="' + esc(state.user.photoUrl) + '" alt="Driver photo" style="height:72px;width:72px;object-fit:cover;border-radius:50%;border:2px solid var(--gold)">' : '') +
    '</div>' +
    '<form id="photoForm" class="inline-form mt"><div class="field"><label>Profile photo</label><input type="file" name="photo" accept="image/*" required></div>' +
    '<button class="btn btn-sm" type="submit">Upload photo</button></form></div>' +
    '<div class="card"><h2>Contact info</h2><form id="profileForm"><div class="form-row">' +
    '<div class="field"><label>Phone</label><input id="pf-phone" type="tel" value="' + esc(state.user.phone || '') + '"></div>' +
    '<div class="field"><label>Emergency contact</label><input id="pf-emergency" value="' + esc(state.user.emergencyContact || '') + '"></div>' +
    '</div><div class="form-actions"><button class="btn" type="submit">Save</button></div></form></div>' +
    '<div class="card"><h2>My Requests</h2>' +
    '<form id="newReqForm"><div class="form-row">' +
    '<div class="field"><label>Type *</label><select id="nr-type">' +
    ['advance', 'unit_change', 'time_off', 'reimbursement', 'other', 'truck_problem'].map(t => '<option value="' + t + '">' + t.replace('_', ' ') + '</option>').join('') + '</select></div>' +
    '<div class="field"><label>Amount ($)</label><input id="nr-amount" type="number" step="0.01" min="0"></div>' +
    '<div class="field"><label>Reason *</label><input id="nr-reason" required></div>' +
    '<div class="field"><label>Details</label><input id="nr-details"></div>' +
    '</div><div class="form-actions"><button class="btn" type="submit">Send request</button></div></form>' +
    (reqList.length ? '<div class="table-wrap mt"><table><thead><tr><th>Type</th><th>Reason</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>' +
      reqList.map(r => '<tr><td>' + esc(r.type) + '</td><td><strong>' + esc(r.reason || '') + '</strong>' + (r.details ? '<br><span class="muted">' + esc(r.details) + '</span>' : '') + (r.adminNote ? '<br><span class="muted">Admin: ' + esc(r.adminNote) + '</span>' : '') + '</td><td>' + fmtMoney(r.amountCents) + '</td>' +
      '<td><span class="pill ' + (r.status === 'pending' ? 'gold' : r.status === 'approved' ? 'green' : 'red') + '">' + esc(r.status) + '</span></td><td>' + fmtDate(r.createdAt) + '</td></tr>').join('') +
      '</tbody></table></div>' : '<p class="empty">No requests yet.</p>') + '</div>' +
    '<div class="card"><h2>Notifications</h2>' +
    (noteList.length ? noteList.map(n => '<p class="small" style="border-bottom:1px solid var(--border);padding-bottom:8px">' + esc(n.title || n.message || n.body || JSON.stringify(n)) + '<br><span class="muted">' + fmtDate(n.createdAt) + '</span></p>').join('')
      : '<p class="empty">No notifications.</p>') + '</div>';

  document.getElementById('photoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/driver/photo', { method: 'POST', body: new FormData(e.target) });
      if (res && res.photoUrl) state.user.photoUrl = res.photoUrl;
      toast('Photo uploaded.', 'ok');
      renderDriverView('settings');
    } catch (err) { showError(err); }
  });
  document.getElementById('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/driver/profile', { method: 'POST', body: JSON.stringify({
        phone: document.getElementById('pf-phone').value.trim() || undefined,
        emergencyContact: document.getElementById('pf-emergency').value.trim() || undefined,
      }) });
      state.user.phone = document.getElementById('pf-phone').value.trim();
      state.user.emergencyContact = document.getElementById('pf-emergency').value.trim();
      toast('Contact info saved.', 'ok');
    } catch (err) { showError(err); }
  });
  document.getElementById('newReqForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cents = dollarsToCents(document.getElementById('nr-amount').value);
    const body = {
      type: document.getElementById('nr-type').value,
      reason: document.getElementById('nr-reason').value.trim(),
    };
    if (cents !== null) body.amountCents = cents;
    const details = document.getElementById('nr-details').value.trim();
    if (details) body.details = details;
    try {
      await api('/api/driver/requests', { method: 'POST', body: JSON.stringify(body) });
      toast('Request sent.', 'ok');
      renderDriverView('settings');
    } catch (err) { showError(err); }
  });
}

/* ---------- boot ---------- */
document.addEventListener('DOMContentLoaded', boot);
