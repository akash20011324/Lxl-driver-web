/* LXL Driver — standalone web app (no build step).
   Same-origin API: all calls are fetch('/api/...').
   Spec: ~/workspace/lxl-driver-native/API_CONTRACT.md */
'use strict';

// Refresh persistence (owner's ask, 2026-11-16): remember which section
// the user was in, so refreshing the page lands back on that section
// instead of the Dashboard. Kept per browser in localStorage.
const ADMIN_VIEW_KEYS = ['dashboard', 'drivers', 'driverDocs', 'admins', 'equipment', 'loads', 'documents', 'unitDocs', 'requests', 'dispatch', 'locations', 'ratecons', 'maintenance', 'cashflow'];
function savedAdminView() {
  try {
    const v = localStorage.getItem('lxl_admin_view');
    if (v && ADMIN_VIEW_KEYS.includes(v)) return v;
  } catch (e) {}
  return 'dashboard';
}
function savedDriverView() {
  try {
    const v = localStorage.getItem('lxl_driver_view');
    if (v && ['home', 'truck', 'trailer', 'loads', 'dispatch', 'settings'].includes(v)) return v;
  } catch (e) {}
  return 'home';
}
function savedUnitDocsTarget() {
  try {
    const t = JSON.parse(localStorage.getItem('lxl_unitdocs_target') || 'null');
    if (t && (t.type === 'truck' || t.type === 'trailer') && Number.isFinite(t.id)) return t;
  } catch (e) {}
  return null;
}
function savedDriverDocsTarget() {
  try {
    const t = JSON.parse(localStorage.getItem('lxl_driverdocs_target') || 'null');
    if (t && Number.isFinite(t.id)) return t;
  } catch (e) {}
  return null;
}
function savedDispatchDriverId() {
  try {
    const n = parseInt(localStorage.getItem('lxl_dispatch_driver') || '', 10);
    if (Number.isFinite(n)) return n;
  } catch (e) {}
  return null;
}

const state = {
  token: localStorage.getItem('lxl_token') || null,
  user: null,
  adminView: savedAdminView(),
  driverView: savedDriverView(),
  unitDocsTarget: savedUnitDocsTarget(),
  driverDocsTarget: savedDriverDocsTarget(),
  yardFilter: 'all', // all | yard | road
  dispatchDriverId: savedDispatchDriverId(),
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
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
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
/* ---------- Chat wallpaper editor ---------- */
/* Pick a photo, preview it behind sample messages, zoom and drag to frame
   it, Fill vs Full picture, then Set. The framing is baked into a compressed
   JPEG, so the upload is small and the wallpaper shows up fast. If the photo
   cannot be drawn to a canvas (e.g. an exotic format), the original file is
   uploaded as before. onSet(blob) must return true on success. */
function openWallpaperEditor(file, onSet) {
  const objUrl = URL.createObjectURL(file);
  const overlay = document.createElement('div');
  overlay.className = 'wp-editor-overlay';
  overlay.innerHTML =
    '<div class="wp-editor">' +
      '<div class="wp-editor-head"><strong>Chat wallpaper</strong>' +
      '<button type="button" class="chat-wp-btn" data-wp="cancel">✕ Close</button></div>' +
      '<div class="wp-frame">' +
        '<img class="wp-img" alt="">' +
        '<div class="wp-dim"></div>' +
        '<div class="wp-sample">' +
          '<div class="msg"><div class="wp-sender">Dispatch</div>On my way to the pickup 👍<div class="meta">Dispatch · 9:41 AM</div></div>' +
          '<div class="msg mine">Copy that, rolling now<div class="meta">You · 9:42 AM · ✓✓ Seen</div></div>' +
          '<div class="msg"><div class="wp-sender">Dispatch</div>Seal number when you are loaded<div class="meta">Dispatch · 9:43 AM</div></div>' +
        '</div>' +
      '</div>' +
      '<p class="wp-hint">Drag the picture to move it. Use the slider to zoom.</p>' +
      '<div class="wp-controls">' +
        '<button type="button" class="chat-wp-btn" data-wp="zoomout" title="Zoom out">−</button>' +
        '<input type="range" class="wp-zoom" min="1" max="3" step="0.01" value="1">' +
        '<button type="button" class="chat-wp-btn" data-wp="zoomin" title="Zoom in">+</button>' +
        '<span class="wp-mode"><button type="button" class="chat-wp-btn on" data-wp="fill">Fill screen</button>' +
        '<button type="button" class="chat-wp-btn" data-wp="fit">Full picture</button></span>' +
        '<button type="button" class="chat-wp-btn" data-wp="resetview">Reset view</button>' +
      '</div>' +
      '<div class="wp-actions">' +
        '<button type="button" class="chat-wp-btn" data-wp="cancel">Cancel</button>' +
        '<button type="button" class="btn wp-set" data-wp="set">Set wallpaper</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  const frame = overlay.querySelector('.wp-frame');
  const img = overlay.querySelector('.wp-img');
  const slider = overlay.querySelector('.wp-zoom');
  let mode = 'fill';
  let zoom = 1;
  let cx = 0;
  let cy = 0;
  let iw = 0;
  let ih = 0;
  const close = () => { URL.revokeObjectURL(objUrl); overlay.remove(); };
  const layout = () => {
    if (!iw) return;
    const fw = frame.clientWidth;
    const fh = frame.clientHeight;
    const base = mode === 'fill' ? Math.max(fw / iw, fh / ih) : Math.min(fw / iw, fh / ih);
    const dw = iw * base * zoom;
    const dh = ih * base * zoom;
    if (mode === 'fill') {
      cx = Math.max(-(dw - fw) / 2, Math.min((dw - fw) / 2, cx));
      cy = Math.max(-(dh - fh) / 2, Math.min((dh - fh) / 2, cy));
    } else {
      cx = Math.max(-fw / 2, Math.min(fw / 2, cx));
      cy = Math.max(-fh / 2, Math.min(fh / 2, cy));
    }
    img.style.width = dw + 'px';
    img.style.height = dh + 'px';
    img.style.left = ((fw - dw) / 2 + cx) + 'px';
    img.style.top = ((fh - dh) / 2 + cy) + 'px';
  };
  img.addEventListener('load', () => { iw = img.naturalWidth; ih = img.naturalHeight; layout(); });
  img.addEventListener('error', async () => {
    /* The browser cannot draw this photo — fall back to uploading it as-is. */
    const ok = await onSet(file);
    close();
    if (!ok) return;
  });
  img.src = objUrl;
  let drag = null;
  frame.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, cx, cy };
    frame.setPointerCapture(e.pointerId);
  });
  frame.addEventListener('pointermove', (e) => {
    if (!drag) return;
    cx = drag.cx + (e.clientX - drag.x);
    cy = drag.cy + (e.clientY - drag.y);
    layout();
  });
  const endDrag = () => { drag = null; };
  frame.addEventListener('pointerup', endDrag);
  frame.addEventListener('pointercancel', endDrag);
  slider.addEventListener('input', () => { zoom = parseFloat(slider.value); layout(); });
  overlay.querySelectorAll('[data-wp]').forEach(btn => btn.addEventListener('click', async () => {
    const act = btn.dataset.wp;
    if (act === 'cancel') { close(); return; }
    if (act === 'zoomin') { zoom = Math.min(3, zoom + 0.25); slider.value = zoom; layout(); return; }
    if (act === 'zoomout') { zoom = Math.max(1, zoom - 0.25); slider.value = zoom; layout(); return; }
    if (act === 'fill' || act === 'fit') {
      mode = act;
      zoom = 1; slider.value = 1; cx = 0; cy = 0;
      overlay.querySelector('[data-wp="fill"]').classList.toggle('on', mode === 'fill');
      overlay.querySelector('[data-wp="fit"]').classList.toggle('on', mode === 'fit');
      layout();
      return;
    }
    if (act === 'resetview') { zoom = 1; slider.value = 1; cx = 0; cy = 0; layout(); return; }
    if (act === 'set') {
      btn.disabled = true;
      btn.textContent = 'Setting…';
      try {
        const fw = frame.clientWidth;
        const fh = frame.clientHeight;
        const k = Math.min(2, 1600 / fw);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(fw * k);
        canvas.height = Math.round(fh * k);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#04070d';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const dw = parseFloat(img.style.width) * k;
        const dh = parseFloat(img.style.height) * k;
        ctx.drawImage(img, parseFloat(img.style.left) * k, parseFloat(img.style.top) * k, dw, dh);
        const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.88));
        const ok = blob ? await onSet(blob) : await onSet(file);
        if (ok) close();
      } finally {
        btn.disabled = false;
        btn.textContent = 'Set wallpaper';
      }
    }
  }));
}

/* ---------- Unit (equipment) documents: expiry + status ---------- */
const EQUIP_DOC_LABELS = {
  cab_card: 'Cab Card', insurance: 'Insurance',
  annual_inspection: 'Annual Inspection', ifta: 'IFTA License', title: 'Title',
  permit: 'Permit',
  permit_nm: 'New Mexico Permit', permit_ky: 'Kentucky Permit',
  permit_ct: 'Connecticut Permit', permit_ny_hut: 'NY HUT Permit',
  other: 'Other',
};
const EQUIP_DOC_TYPES_ALL = Object.keys(EQUIP_DOC_LABELS);
const EQUIP_DOC_CORE = ['cab_card', 'insurance', 'annual_inspection', 'ifta', 'permit_nm', 'permit_ky', 'permit_ct', 'permit_ny_hut'];
// Truck-only types (owner's rules): IFTA and the state permits belong to
// the truck; trailers never get tiles or upload options for them.
const EQUIP_DOC_TRUCK_ONLY = ['ifta', 'permit_nm', 'permit_ky', 'permit_ct', 'permit_ny_hut'];
// Trailers have NO IFTA license (owner's rule, 2026-11-15) — IFTA is the
// truck's. Trailer tiles: cab card, insurance, annual inspection only.
const EQUIP_DOC_CORE_TRAILER = ['cab_card', 'insurance', 'annual_inspection'];

/* Status for an expiry date (YYYY-MM-DD), judged on the viewer's local
   calendar day: Expired / Expires today / Expires in N days (red up to a
   week, amber up to a month) / Active / no expiry on file. */
function equipDocStatus(expiryDate) {
  if (!expiryDate) return { key: 'none', label: 'No expiry date', cls: 'grey' };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiryDate);
  if (!m) return { key: 'none', label: 'No expiry date', cls: 'grey' };
  const exp = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((exp - today) / 86400000);
  if (days < 0) return { key: 'expired', label: 'Expired', cls: 'red', days };
  if (days === 0) return { key: 'soon', label: 'Expires today', cls: 'red', days };
  if (days <= 7) return { key: 'soon', label: 'Expires in ' + days + (days === 1 ? ' day' : ' days'), cls: 'red', days };
  if (days <= 30) return { key: 'soon', label: 'Expires in ' + days + ' days', cls: 'amber', days };
  return { key: 'active', label: 'Active', cls: 'green', days };
}

function fmtExpiry(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1];
}

/* ---------- Unit documents page (per truck / trailer) ----------
   Opened from the Documents button on a Trucks & Trailers card — its
   OWN page, nothing to do with the load Documents (BOLs). Tiles for the
   core papers (cab card, insurance, annual inspection, IFTA,
   registration) plus anything else on file. The server reads the issue
   and expiry dates off the upload by itself; the tiles show the dates
   with a live status: green Active, yellow expiring, red Expired. */
async function viewUnitDocuments(main) {
  const target = state.unitDocsTarget;
  if (!target) { renderAdminView('equipment'); return; }
  const [trucks, trailers, docs] = await Promise.all([
    api('/api/admin/trucks').catch(() => []),
    api('/api/admin/trailers').catch(() => []),
    api('/api/admin/equipment-documents?unitType=' + target.type + '&unitId=' + target.id).catch(() => []),
  ]);
  const unit = (target.type === 'truck' ? (trucks || []) : (trailers || [])).find(u => u.id === target.id);
  if (!unit) { toast('That unit no longer exists.', 'err'); renderAdminView('equipment'); return; }
  const list = Array.isArray(docs) ? docs : [];
  const desc = target.type === 'truck'
    ? [unit.year, unit.make, unit.model].filter(Boolean).join(' ')
    : (unit.make ? [unit.year, unit.make, unit.model].filter(Boolean).join(' ') : [unit.year, unit.kind].filter(Boolean).join(' '));
  const byType = new Map();
  for (const d of list) {
    if (!byType.has(d.docType)) byType.set(d.docType, []);
    byType.get(d.docType).push(d);
  }
  let nActive = 0, nSoon = 0, nExpired = 0;
  for (const d of list) {
    const st = equipDocStatus(d.expiryDate);
    if (st.key === 'active') nActive++;
    else if (st.key === 'soon') nSoon++;
    else if (st.key === 'expired') nExpired++;
  }
  const CORE = target.type === 'trailer' ? EQUIP_DOC_CORE_TRAILER : EQUIP_DOC_CORE;
  const nMissing = CORE.filter(t => !byType.has(t)).length;
  const countdown = (d) => {
    const st = equipDocStatus(d.expiryDate);
    if (st.key === 'expired') return 'Expired ' + fmtExpiry(d.expiryDate);
    if (st.key === 'soon' || st.key === 'active') return st.days + (st.days === 1 ? ' day' : ' days') + ' left · expires ' + fmtExpiry(d.expiryDate);
    return 'No expiry date — add it below';
  };
  const tileHtml = (d) => {
    const st = equipDocStatus(d.expiryDate);
    return '<div class="ud-tile ' + st.cls + '">' +
      '<div class="ud-tile-top"><span class="ud-tile-name">' + esc(EQUIP_DOC_LABELS[d.docType] || d.docType) + '</span>' +
      '<span class="doc-pill ' + st.cls + '">' + st.label + '</span></div>' +
      '<div class="ud-file">' + esc(d.filename || '') + (d.note ? ' · ' + esc(d.note) : '') + '</div>' +
      '<div class="ud-count">' + countdown(d) + '</div>' +
      '<div class="ud-dates">' +
      '<label>Issued<input type="date" data-issued-input="' + d.id + '" value="' + esc(d.issuedDate || '') + '"></label>' +
      '<label>Expires<input type="date" data-exp-input="' + d.id + '" value="' + esc(d.expiryDate || '') + '"></label></div>' +
      (d.docType === 'cab_card' ? '<div class="ud-plate">Plate <strong>' + esc(unit.plate || '— not read yet') + '</strong></div>' : '') +
      '<div class="ud-acts"><button class="btn btn-ghost btn-sm" type="button" data-unit-doc-view="' + d.id + '">View</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-tile-pick="' + d.docType + '">Replace</button>' +
      '<button class="btn btn-danger btn-sm" type="button" data-unit-doc-del="' + d.id + '">Delete</button></div></div>';
  };
  const missingTile = (t) =>
    '<div class="ud-tile missing"><div class="ud-tile-top"><span class="ud-tile-name">' + EQUIP_DOC_LABELS[t] + '</span>' +
    '<span class="doc-pill grey">Missing</span></div>' +
    '<div class="ud-count">Not uploaded yet</div>' +
    '<div class="ud-acts"><button class="btn btn-sm" type="button" data-tile-pick="' + t + '">Upload</button></div></div>';
  const coreTiles = CORE.map(t => {
    const ds = byType.get(t) || [];
    return ds.length ? ds.map(tileHtml).join('') : missingTile(t);
  }).join('');
  const extraTiles = list.filter(d => !CORE.includes(d.docType)).map(tileHtml).join('');
  main.innerHTML = '<button class="btn btn-ghost btn-sm" id="udBack" type="button">← Trucks &amp; Trailers</button>' +
    '<div class="rc-head"><h1>Documents — ' + esc(unit.unitNumber) + '</h1>' +
    (unit.yardStatus === 'road' ? '<span class="pill blue">On the Road</span>' : '<span class="pill green">In the Yard</span>') + '</div>' +
    '<p class="muted">' + esc((target.type === 'truck' ? 'Truck' : 'Trailer') + (desc ? ' · ' + desc : '') + (unit.driverName ? ' · Driver: ' + unit.driverName : '')) + '</p>' +
    '<div class="ud-summary">' +
    '<span class="doc-pill green">' + nActive + ' Active</span>' +
    '<span class="doc-pill amber">' + nSoon + ' Expiring</span>' +
    '<span class="doc-pill red">' + nExpired + ' Expired</span>' +
    '<span class="doc-pill grey">' + nMissing + ' Missing</span></div>' +
    '<p class="small muted">Upload a photo or scan of a paper and the dates are read off it automatically — check them on the tile and fix any date with the date boxes.</p>' +
    '<div class="ud-grid">' + coreTiles + extraTiles + '</div>' +
    '<div class="card"><h3>Add another document</h3>' +
    '<form class="unit-doc-form" id="udAddForm">' +
    '<div class="field"><label>Document type</label><select name="docType">' +
    EQUIP_DOC_TYPES_ALL.filter(t => target.type !== 'trailer' || !EQUIP_DOC_TRUCK_ONLY.includes(t)).map(t => '<option value="' + t + '">' + EQUIP_DOC_LABELS[t] + '</option>').join('') +
    '</select></div>' +
    '<div class="field"><label>File *</label><input type="file" name="file" required></div>' +
    '<div class="field"><label>Note</label><input name="note"></div>' +
    '<button class="btn btn-sm" type="submit">Upload</button></form></div>' +
    '<input type="file" id="udTileFile" hidden>';
  document.getElementById('udBack').addEventListener('click', () => renderAdminView('equipment'));
  const uploadFor = async (docType, file) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('unitType', target.type);
    fd.append('unitId', String(target.id));
    fd.append('docType', docType);
    try {
      const r = await api('/api/admin/equipment-documents', { method: 'POST', body: fd });
      const label = EQUIP_DOC_LABELS[docType] || docType;
      if (r && r.vehicle && r.vehicle.filled && r.vehicle.filled.length) {
        toast('Cab card read: ' + ([r.vehicle.year, r.vehicle.make, r.vehicle.model].filter(Boolean).join(' ') || 'vehicle details') + ' — now shown under the unit number.', 'ok');
      }
      if (r && r.detected && (r.detected.expiryDate || r.detected.issuedDate)) {
        toast(label + ' saved — dates read automatically' +
          (r.detected.issuedDate ? ' · issued ' + fmtExpiry(r.detected.issuedDate) : '') +
          (r.detected.expiryDate ? ' · expires ' + fmtExpiry(r.detected.expiryDate) : '') + '.', 'ok');
      } else {
        toast(label + ' saved — no dates found on it; add them on the tile.', 'ok');
      }
      renderAdminView('unitDocs');
    } catch (err) { showError(err); }
  };
  const tileFile = document.getElementById('udTileFile');
  let pendingType = null;
  main.querySelectorAll('[data-tile-pick]').forEach(b => b.addEventListener('click', () => {
    pendingType = b.dataset.tilePick;
    tileFile.value = '';
    tileFile.click();
  }));
  tileFile.addEventListener('change', () => {
    if (pendingType && tileFile.files && tileFile.files[0]) uploadFor(pendingType, tileFile.files[0]);
    pendingType = null;
  });
  main.querySelectorAll('[data-unit-doc-view]').forEach(b => b.addEventListener('click', () => {
    const d = list.find(x => String(x.id) === b.dataset.unitDocView);
    if (d) downloadFile(d.url, d.filename, true, d.mimeType);
  }));
  main.querySelectorAll('[data-unit-doc-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this document?')) return;
    try {
      await api('/api/admin/equipment-documents/' + b.dataset.unitDocDel, { method: 'DELETE' });
      toast('Document deleted.', 'ok');
      renderAdminView('unitDocs');
    } catch (err) { showError(err); }
  }));
  const patchDate = async (id, body) => {
    try {
      await api('/api/admin/equipment-documents/' + id, { method: 'PATCH', body: JSON.stringify(body) });
      toast('Date saved.', 'ok');
      renderAdminView('unitDocs');
    } catch (err) { showError(err); }
  };
  main.querySelectorAll('[data-exp-input]').forEach(inp => inp.addEventListener('change', () =>
    patchDate(inp.dataset.expInput, { expiryDate: inp.value || null })));
  main.querySelectorAll('[data-issued-input]').forEach(inp => inp.addEventListener('change', () =>
    patchDate(inp.dataset.issuedInput, { issuedDate: inp.value || null })));
  document.getElementById('udAddForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const file = form.file.files && form.file.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('unitType', target.type);
    fd.append('unitId', String(target.id));
    fd.append('docType', form.docType.value);
    if (form.note.value) fd.append('note', form.note.value);
    try {
      const r = await api('/api/admin/equipment-documents', { method: 'POST', body: fd });
      const label = EQUIP_DOC_LABELS[form.docType.value] || 'Document';
      if (r && r.detected && r.detected.expiryDate) toast(label + ' saved — expires ' + fmtExpiry(r.detected.expiryDate) + ' (read automatically).', 'ok');
      else toast(label + ' saved.', 'ok');
      renderAdminView('unitDocs');
    } catch (err) { showError(err); }
  });
}

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
  document.body.classList.remove('docs-bg');
  removeDocsBgLayer();
  document.body.classList.remove('loc-bg');
  removeLocBgLayer();
  document.body.classList.remove('loads-bg');
  removeLoadsBgLayer();
  document.body.classList.remove('trucks-bg');
  removeTrucksBgLayer();
  document.body.classList.remove('drivers-bg');
  removeDriversBgLayer();
  document.body.classList.remove('admins-bg');
  removeAdminsBgLayer();
  document.body.classList.remove('requests-bg');
  removeRequestsBgLayer();
  document.body.classList.remove('maintenance-bg');
  removeMaintenanceBgLayer();
  document.body.classList.remove('cashflow-bg');
  removeCashflowBgLayer();
  document.body.classList.remove('chat-bg');
  removeChatBgLayer();
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

const BELL_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#e8eef7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

function topbar() {
  const bell = state.user && state.user.role === 'admin'
    ? '<span class="bell-wrap"><button class="bell-btn" id="bellBtn" type="button" aria-label="Notifications" title="Notifications">' + BELL_SVG + '<span class="bell-badge" id="bellBadge" hidden></span></button>' +
      '<span class="bell-panel" id="bellPanel" hidden></span></span>'
    : '';
  return '<header class="topbar">' +
    '<img class="logo" src="assets/logo.png" alt="LXL logo">' +
    '<span class="brand">Lubana Xpress LLC</span>' +
    '<span class="spacer"></span>' + bell +
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
  ['dispatch', 'Chat'],
  ['locations', 'Tracking'],
  ['ratecons', 'Rate Cons'],
  ['maintenance', 'Maintenance'],
  ['cashflow', 'Cash Flow'],
];

function renderAdminShell() {
  const app = document.getElementById('app');
  app.innerHTML = topbar() +
    '<div class="admin-layout">' +
    '<nav class="sidebar" id="adminSidebar"></nav>' +
    '<main class="admin-main" id="adminMain"></main>' +
    '</div>';
  renderAdminSidebar();
  loadSidebarOrder();
  renderAdminView(state.adminView);
  const bellBtn = document.getElementById('bellBtn');
  if (bellBtn) bellBtn.addEventListener('click', toggleBell);
  startAdminNotifier();
}

/* ---------- Admin notifications: bell, badges, desktop popups ----------
   The bell feed (GET /api/admin/notifications) is polled every 15 s.
   It drives the bell badge, the Chat menu unread badge, the dropdown
   panel, and — when the browser allows it — real desktop notifications
   on whatever device the admin is using. */
let bellData = null;

function timeAgo(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + (h === 1 ? ' hr ago' : ' hrs ago');
  const d = Math.floor(h / 24);
  return d + (d === 1 ? ' day ago' : ' days ago');
}

function startAdminNotifier() {
  if (state.bellTimer) clearInterval(state.bellTimer);
  state.bellTimer = setInterval(pollAdminNotifications, 15000);
  pollAdminNotifications();
  if (!state.bellClickBound) {
    state.bellClickBound = true;
    document.addEventListener('click', (e) => {
      const panel = document.getElementById('bellPanel');
      if (!panel || panel.hidden) return;
      if (!e.target.closest('.bell-wrap')) panel.hidden = true;
    });
  }
}

async function pollAdminNotifications() {
  if (!state.user || state.user.role !== 'admin' || !state.token) return;
  let data;
  try { data = await api('/api/admin/notifications'); } catch { return; }
  if (!data) return;
  bellData = data;
  const bb = document.getElementById('bellBadge');
  if (bb) {
    bb.hidden = !(data.unread > 0);
    bb.textContent = data.unread > 99 ? '99+' : data.unread;
  }
  const total = data.dispatchUnread ? data.dispatchUnread.total : 0;
  if (state.dispatchUnreadTotal !== total) {
    state.dispatchUnreadTotal = total;
    if (!state.organizing) renderAdminSidebar();
  }
  const items = Array.isArray(data.items) ? data.items : [];
  const maxId = items.reduce((m, i) => Math.max(m, i.id), 0);
  if (state.lastNotifId == null) {
    state.lastNotifId = maxId;
  } else if (maxId > state.lastNotifId) {
    const fresh = items.filter(i => i.id > state.lastNotifId).sort((a, b) => a.id - b.id);
    for (const n of fresh) maybeDesktopNotify(n);
    state.lastNotifId = maxId;
  }
  const panel = document.getElementById('bellPanel');
  if (panel && !panel.hidden) renderBellPanel();
}

function maybeDesktopNotify(n) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const onTarget = state.adminView === n.view &&
      !(n.view === 'dispatch' && n.refId && n.refId !== state.dispatchDriverId);
    if (!document.hidden && onTarget) return;
    const notif = new Notification(n.title, { body: n.body || '', tag: 'lxl-' + n.id });
    notif.onclick = () => { window.focus(); openNotification(n); notif.close(); };
  } catch { /* desktop notifications are best-effort */ }
}

function openNotification(n) {
  const panel = document.getElementById('bellPanel');
  if (panel) panel.hidden = true;
  if (!n.view) return;
  if (n.view === 'dispatch' && n.refId) state.dispatchDriverId = n.refId;
  state.adminView = n.view;
  renderAdminSidebar();
  renderAdminView(n.view);
}

function renderBellPanel() {
  const panel = document.getElementById('bellPanel');
  if (!panel) return;
  const items = bellData && Array.isArray(bellData.items) ? bellData.items : [];
  const dotColor = { message: 'gold', document: 'blue', request: 'green', ratecon: 'blue', load: 'gold' };
  let foot = '';
  if ('Notification' in window && Notification.permission === 'default') {
    foot = '<button class="bell-enable" id="bellEnable" type="button">Turn on desktop notifications</button>';
  } else if ('Notification' in window && Notification.permission === 'denied') {
    foot = '<div class="bell-note">Desktop notifications are blocked in this browser.</div>';
  }
  panel.innerHTML = '<div class="bell-head">Notifications</div>' +
    (items.length ? items.map(n =>
      '<button class="bell-item' + (n.read ? '' : ' unread') + '" type="button" data-notif="' + n.id + '">' +
      '<span class="bell-dot ' + (dotColor[n.type] || 'blue') + '"></span>' +
      '<span class="bell-texts"><span class="bell-title">' + esc(n.title) + '</span>' +
      (n.body ? '<span class="bell-body">' + esc(n.body) + '</span>' : '') +
      '<span class="bell-time">' + timeAgo(n.createdAt) + '</span></span></button>').join('')
      : '<div class="bell-empty">Nothing yet — driver messages, uploads, requests and more will land here.</div>') + foot;
  panel.querySelectorAll('[data-notif]').forEach(b => b.addEventListener('click', () => {
    const n = items.find(x => x.id === parseInt(b.dataset.notif, 10));
    if (n) openNotification(n);
  }));
  const en = document.getElementById('bellEnable');
  if (en) en.addEventListener('click', async () => {
    try { await Notification.requestPermission(); } catch { /* ignore */ }
    renderBellPanel();
  });
}

async function toggleBell() {
  const panel = document.getElementById('bellPanel');
  if (!panel) return;
  if (!panel.hidden) { panel.hidden = true; return; }
  await pollAdminNotifications();
  renderBellPanel();
  panel.hidden = false;
  // Opening the bell marks everything read; the items just rendered
  // keep their unread styling for this view.
  try { await api('/api/admin/notifications/read', { method: 'POST', body: JSON.stringify({}) }); } catch { /* ignore */ }
  const bb = document.getElementById('bellBadge');
  if (bb) bb.hidden = true;
  if (bellData) bellData.unread = 0;
}

// Sidebar order: ADMIN_VIEWS is the default. An admin can rearrange
// the menu with Organize (bottom of the sidebar); the order is stored
// on their account and follows them across devices. Keys missing from
// a saved order (e.g. a newer page) keep their default relative order
// at the end.
function orderedAdminViews() {
  const visible = ADMIN_VIEWS.filter(([key]) => key !== 'admins' || (state.user && (state.user.isMainAdmin || state.user.adminKind === 'admin')));
  const saved = state.organizing && Array.isArray(state.organizeOrder)
    ? state.organizeOrder
    : (Array.isArray(state.sidebarOrder) ? state.sidebarOrder : []);
  const rank = new Map(saved.map((k, i) => [k, i]));
  return [...visible].sort((a, b) => {
    const ra = rank.has(a[0]) ? rank.get(a[0]) : 100 + ADMIN_VIEWS.findIndex(v => v[0] === a[0]);
    const rb = rank.has(b[0]) ? rank.get(b[0]) : 100 + ADMIN_VIEWS.findIndex(v => v[0] === b[0]);
    return ra - rb;
  });
}

let sidebarOrderRequested = false;
async function loadSidebarOrder() {
  if (sidebarOrderRequested) return;
  sidebarOrderRequested = true;
  // The saved order lives on the server; this fetch is the only thing
  // that applies it. A deploy restart can drop that one fetch, and the
  // old code latched the flag and silently kept the default order for
  // the whole session — the sidebar looked "reset" even though the
  // saved order was untouched. Retry through a restart window; if every
  // attempt fails, un-latch so the next shell render tries again.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await api('/api/admin/sidebar-order');
      if (res && Array.isArray(res.order)) {
        state.sidebarOrder = res.order;
        renderAdminSidebar();
      }
      return;
    } catch {
      if (!state.token) { sidebarOrderRequested = false; return; }
      if (attempt < 5) await new Promise(r => setTimeout(r, 5000));
    }
  }
  sidebarOrderRequested = false;
}

// Press-and-drag reordering in Organize mode (pointer events, so it
// works with touch on the iPad as well as a mouse): hold a row, slide
// it where it belongs, let go. state.organizeOrder follows the rows'
// DOM order; the arrows stay as a precise alternative.
function attachOrgDrag(row, nav, pendingRequests) {
  row.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    if (e.button !== undefined && e.button > 0) return;
    e.preventDefault();
    row.setPointerCapture(e.pointerId);
    row.classList.add('org-dragging');
    const startY = e.clientY;
    let shift = 0;
    const onMove = (ev) => {
      const dy = ev.clientY - startY;
      const siblings = Array.from(nav.querySelectorAll('.sidebar-org-row')).filter(r => r !== row);
      let before = null;
      for (const sib of siblings) {
        const rect = sib.getBoundingClientRect();
        if (ev.clientY < rect.top + rect.height / 2) { before = sib; break; }
      }
      const oldTop = row.offsetTop;
      if (before) nav.insertBefore(row, before);
      else nav.insertBefore(row, nav.querySelector('.sidebar-org-foot'));
      shift += row.offsetTop - oldTop;
      row.style.transform = 'translateY(' + (dy - shift) + 'px)';
    };
    const onUp = () => {
      row.classList.remove('org-dragging');
      row.style.transform = '';
      row.removeEventListener('pointermove', onMove);
      row.removeEventListener('pointerup', onUp);
      row.removeEventListener('pointercancel', onUp);
      state.organizeOrder = Array.from(nav.querySelectorAll('.sidebar-org-row')).map(r => r.dataset.key);
      renderAdminSidebar(pendingRequests);
    };
    row.addEventListener('pointermove', onMove);
    row.addEventListener('pointerup', onUp);
    row.addEventListener('pointercancel', onUp);
  });
}

function renderAdminSidebar(pendingRequests) {
  const nav = document.getElementById('adminSidebar');
  if (!nav) return;
  if (typeof pendingRequests === 'number') state.pendingRequestsCount = pendingRequests;
  const views = orderedAdminViews();
  const badge = (key) => {
    if (key === 'requests' && state.pendingRequestsCount > 0)
      return '<span class="badge">' + state.pendingRequestsCount + '</span>';
    if (key === 'dispatch' && state.dispatchUnreadTotal > 0)
      return '<span class="badge red">' + state.dispatchUnreadTotal + '</span>';
    return '';
  };
  if (state.organizing) {
    nav.innerHTML = views.map(([key, label], i) =>
      '<div class="sidebar-org-row" data-key="' + key + '"><span><span class="org-grip">⠿</span>' + esc(label) + badge(key) + '</span>' +
      '<span class="sidebar-org-btns">' +
      '<button data-move="-1" data-key="' + key + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button data-move="1" data-key="' + key + '"' + (i === views.length - 1 ? ' disabled' : '') + '>↓</button>' +
      '</span></div>').join('') +
      '<div class="sidebar-org-foot">' +
      '<button class="btn btn-sm" data-org-done="1">Done</button>' +
      '<button class="btn btn-ghost btn-sm" data-org-reset="1">Reset</button>' +
      '<button class="btn btn-ghost btn-sm" data-org-cancel="1">Cancel</button></div>';
    nav.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', () => {
      const keys = [...state.organizeOrder];
      const idx = keys.indexOf(b.dataset.key);
      const j = idx + Number(b.dataset.move);
      if (idx < 0 || j < 0 || j >= keys.length) return;
      [keys[idx], keys[j]] = [keys[j], keys[idx]];
      state.organizeOrder = keys;
      renderAdminSidebar(pendingRequests);
    }));
    nav.querySelectorAll('.sidebar-org-row').forEach(row => attachOrgDrag(row, nav, pendingRequests));
    nav.querySelector('[data-org-done]').addEventListener('click', async () => {
      const order = (state.organizeOrder || []).slice();
      try {
        await api('/api/admin/sidebar-order', { method: 'POST', body: JSON.stringify({ order }) });
      } catch (firstErr) {
        // A server restart (deploy) can drop one request — retry once
        // before giving up, and stay in Organize mode either way so a
        // failed save never throws the arrangement away.
        await new Promise(r => setTimeout(r, 1500));
        try {
          await api('/api/admin/sidebar-order', { method: 'POST', body: JSON.stringify({ order }) });
        } catch (err) { showError(err); return; }
      }
      state.sidebarOrder = order;
      state.organizing = false;
      toast('Sidebar order saved.', 'ok');
      renderAdminSidebar(pendingRequests);
    });
    nav.querySelector('[data-org-reset]').addEventListener('click', async () => {
      try {
        await api('/api/admin/sidebar-order', { method: 'POST', body: JSON.stringify({ order: [] }) });
      } catch (err) { showError(err); return; }
      state.sidebarOrder = null;
      state.organizing = false;
      toast('Sidebar back to the default order.', 'ok');
      renderAdminSidebar(pendingRequests);
    });
    nav.querySelector('[data-org-cancel]').addEventListener('click', () => {
      state.organizing = false;
      renderAdminSidebar(pendingRequests);
    });
    return;
  }
  nav.innerHTML = views.map(([key, label]) =>
    '<button data-view="' + key + '" class="' + (state.adminView === key ? 'active' : '') + '">' +
    esc(label) + badge(key) + '</button>').join('') +
    '<div class="sidebar-org"><button class="sidebar-org-open" data-organize="1">⇅ Organize</button></div>';
  nav.querySelectorAll('button[data-view]').forEach(b => b.addEventListener('click', () => {
    state.adminView = b.dataset.view;
    renderAdminSidebar(pendingRequests);
    renderAdminView(state.adminView);
  }));
  nav.querySelector('[data-organize]').addEventListener('click', () => {
    state.organizeOrder = views.map(([k]) => k);
    state.organizing = true;
    renderAdminSidebar(pendingRequests);
  });
}

async function renderAdminView(view) {
  state.adminView = view;
  try {
    localStorage.setItem('lxl_admin_view', view);
    if (view === 'unitDocs' && state.unitDocsTarget)
      localStorage.setItem('lxl_unitdocs_target', JSON.stringify(state.unitDocsTarget));
    if (view === 'driverDocs' && state.driverDocsTarget)
      localStorage.setItem('lxl_driverdocs_target', JSON.stringify(state.driverDocsTarget));
    if (state.dispatchDriverId)
      localStorage.setItem('lxl_dispatch_driver', String(state.dispatchDriverId));
  } catch (e) {}
  clearTimers();
  document.body.classList.remove('rc-bg');
  removeRcBgLayer();
  document.body.classList.remove('dash-bg');
  removeDashBgLayer();
  document.body.classList.remove('docs-bg');
  removeDocsBgLayer();
  document.body.classList.remove('loc-bg');
  removeLocBgLayer();
  document.body.classList.remove('loads-bg');
  removeLoadsBgLayer();
  document.body.classList.remove('trucks-bg');
  removeTrucksBgLayer();
  document.body.classList.remove('drivers-bg');
  removeDriversBgLayer();
  document.body.classList.remove('admins-bg');
  removeAdminsBgLayer();
  document.body.classList.remove('requests-bg');
  removeRequestsBgLayer();
  document.body.classList.remove('maintenance-bg');
  removeMaintenanceBgLayer();
  document.body.classList.remove('cashflow-bg');
  removeCashflowBgLayer();
  document.body.classList.remove('chat-bg');
  removeChatBgLayer();
  const main = document.getElementById('adminMain');
  if (!main) return;
  main.innerHTML = '<p class="muted">Loading…</p>';
  if (view === 'admins' && !(state.user && (state.user.isMainAdmin || state.user.adminKind === 'admin'))) {
    main.innerHTML = '<p class="empty">Only the main admin or an admin can manage admin accounts.</p>';
    return;
  }
  try {
    if (view === 'dashboard') await viewDashboard(main);
    else if (view === 'drivers') await viewDrivers(main);
    else if (view === 'admins') await viewAdmins(main);
    else if (view === 'equipment') await viewEquipment(main);
    else if (view === 'loads') await viewLoads(main);
    else if (view === 'documents') await viewDocuments(main);
    else if (view === 'unitDocs') await viewUnitDocuments(main);
    else if (view === 'driverDocs') await viewDriverDocuments(main);
    else if (view === 'requests') await viewRequests(main);
    else if (view === 'dispatch') await viewDispatch(main);
    else if (view === 'locations') await viewLocations(main);
    else if (view === 'ratecons') await viewRateCons(main);
    else if (view === 'maintenance') await viewMaintenance(main);
    else if (view === 'cashflow') await viewCashflow(main);
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
  const [data, trucks, trailers, loads, rcs, locs, cfData] = await Promise.all([
    api('/api/admin/overview'),
    api('/api/admin/trucks').catch(() => []),
    api('/api/admin/trailers').catch(() => []),
    api('/api/admin/loads').catch(() => []),
    api('/api/admin/rate-confirmations').catch(() => []),
    api('/api/admin/locations').catch(() => []),
    api('/api/admin/cashflow').catch(() => null),
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
  const cfMonth = (cfData && cfData.month) || null;
  let cfDonutHtml = '';
  if (cfMonth && (cfMonth.outGroups || []).length) {
    const groups = [...cfMonth.outGroups].sort((a, b) => b.amountCents - a.amountCents);
    const top = groups.slice(0, 6);
    const restAmt = groups.slice(6).reduce((sum, g) => sum + g.amountCents, 0);
    if (restAmt > 0) top.push({ category: 'Other', amountCents: restAmt });
    const totalOut = top.reduce((sum, g) => sum + g.amountCents, 0) || 1;
    const colors = ['#F2B705', '#4DA3FF', '#4ade80', '#f87171', '#c084fc', '#facc15', '#94a3b8'];
    const R = 54; const CC = 2 * Math.PI * R;
    let acc = 0;
    const segs = top.map((g, i) => {
      const frac = g.amountCents / totalOut;
      const seg = '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + colors[i % colors.length] + '" stroke-width="20" stroke-dasharray="' + (frac * CC).toFixed(2) + ' ' + (CC - frac * CC).toFixed(2) + '" stroke-dashoffset="' + (-acc * CC).toFixed(2) + '" transform="rotate(-90 70 70)"></circle>';
      acc += frac;
      return seg;
    }).join('');
    const legend = top.map((g, i) => '<div class="cf-donut-row"><span class="cf-donut-dot" style="background:' + colors[i % colors.length] + '"></span><span>' + esc(g.category) + '</span><strong>' + fmtMoney(g.amountCents) + '</strong></div>').join('');
    const mName = new Date(cfMonth.key + '-15T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    cfDonutHtml = '<div class="cf-donut-wrap"><svg width="140" height="140" viewBox="0 0 140 140">' + segs +
      '<text x="70" y="66" text-anchor="middle" fill="#F2B705" font-size="15" font-weight="700">' + fmtMoney(cfMonth.profitCents) + '</text>' +
      '<text x="70" y="84" text-anchor="middle" fill="#cbd5e1" font-size="10">profit</text></svg>' +
      '<div class="cf-donut-legend"><div class="small muted" style="margin-bottom:6px">Money out in ' + esc(mName) + ' — total ' + fmtMoney(cfMonth.outTotalCents) + ' · money in ' + fmtMoney(cfMonth.inTotalCents) + '</div>' + legend + '</div></div>';
  }
  const bb = cfData && cfData.bankBalance;
  let bankCircleHtml = '';
  if (bb && Number.isFinite(bb.currentCents)) {
    const upd = bb.at ? new Date(bb.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    // The headline is the AVAILABLE balance — the number BofA itself
    // headlines in its app (owner, 2026-11-17); the posted (ledger)
    // balance rides underneath.
    const headline = Number.isFinite(bb.availableCents) ? bb.availableCents : bb.currentCents;
    bankCircleHtml = '<div class="bank-circle">' +
      '<svg width="140" height="140" viewBox="0 0 140 140">' +
      '<circle cx="70" cy="70" r="54" fill="none" stroke="#F2B705" stroke-width="20"></circle>' +
      '<text x="70" y="66" text-anchor="middle" fill="#ffffff" font-size="16" font-weight="700">' + fmtMoney(headline) + '</text>' +
      '<text x="70" y="84" text-anchor="middle" fill="#cbd5e1" font-size="10">bank balance</text></svg>' +
      '<div class="small muted" style="text-align:center;margin-top:2px">' + esc(bb.name || 'Bank account') + (bb.mask ? ' ••' + esc(bb.mask) : '') + '</div>' +
      '<div class="small" style="text-align:center">Posted ' + fmtMoney(bb.currentCents) + '</div>' +
      (upd ? '<div class="small muted" style="text-align:center">Updated ' + esc(upd) + '</div>' : '') +
      '</div>';
  }
  main.innerHTML = '<div class="dash-head"><h1 style="margin:0">Dashboard</h1><span class="status-pill live"><span class="dot"></span>Live</span></div>' +
    '<div class="dash-stats">' +
    '<div class="glass-panel dash-stat"><div class="stat-num">' + count('drivers', list.length) + '</div><div class="stat-label">Drivers</div></div>' +
    '<div class="glass-panel dash-stat"><div class="stat-num">' + truckCount + '</div><div class="stat-label">Trucks</div></div>' +
    '<div class="glass-panel dash-stat"><div class="stat-num">' + trailerCount + '</div><div class="stat-label">Trailers</div></div>' +
    '<div class="glass-panel dash-stat"><div class="stat-num">' + activeLoads + '</div><div class="stat-label">Active loads</div></div>' +
    '<div class="glass-panel dash-stat"><div class="stat-num">' + pendingReq + '</div><div class="stat-label">Pending requests</div></div>' +
    '</div>' +
    '<div class="dash-main">' +
    '<div class="dash-left">' +
    '<div class="glass-panel" style="margin-bottom:14px"><h2 style="margin-top:0">Cash flow — this month</h2><div class="cf-circles">' + (cfDonutHtml || '<p class="empty">No cash flow recorded yet this month.</p>') + bankCircleHtml + '</div></div>' +
    '<div class="dash-drivers"><h2>Drivers</h2>' +
    (list.length ? list.map(d => dashDriverCard(d, activeLoadByDriver[d.id], rcByLoad, locByDriver[d.id] || d.location, isLive(d))).join('') : '<p class="empty">No drivers yet. Add one from the Drivers page.</p>') +
    '</div>' +
    '</div>' +
    '<div class="dash-track">' +
    '<div class="glass-panel"><h2 style="margin-top:0"><span class="live-dot off" id="dashLiveDot"></span>Live tracking</h2><div id="dashMap" class="dash-map"></div><p class="small muted" id="dashMapNote" style="display:none"></p></div>' +
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
    // The dot before "Live tracking" blinks green while at least one
    // driver is live (fresh location), grey when nobody is.
    const liveDot = document.getElementById('dashLiveDot');
    if (liveDot) {
      const anyLive = drivers.some(d => d.active !== false && locFresh(byId[d.id] || d.location));
      liveDot.className = 'live-dot' + (anyLive ? '' : ' off');
    }
    el.innerHTML = '<h2 style="margin-top:0">Fleet</h2>' + (drivers.length ? drivers.map(d => {
      const l = byId[d.id] || d.location;
      const on = d.active !== false && locFresh(l);
      const right = on
        ? (typeof l.speedMph === 'number' ? Math.round(l.speedMph) + ' mph' : 'Live')
        : (l && l.updatedAt ? 'Last seen ' + esc(fmtDate(l.updatedAt)) : 'No location yet');
      const truckNo = d.truck ? (d.truck.unitNumber || '') : (d.truckUnitNumber || '');
      const trailerNo = d.trailer ? (d.trailer.unitNumber || '') : (d.trailerUnitNumber || '');
      const citySlot = l ? '<div class="small city-slot" data-city-lat="' + esc(l.lat) + '" data-city-lng="' + esc(l.lng) + '">Locating…</div>' : '';
      return '<div class="fleet-row"><span class="fleet-dot' + (on ? '' : ' off') + '"' + (on ? ' style="background:' + driverColor(d.id) + '"' : '') + '></span><div style="flex:1;min-width:0"><strong>' + esc(d.name) + '</strong><div class="small muted">' + esc(truckNo) + (truckNo && trailerNo ? ' · ' : '') + esc(trailerNo) + '</div>' + citySlot + '</div><span class="small muted">' + right + '</span></div>';
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
        icon: driverPinIcon(l.driverName || '', l.driverId),
      });
      marker.addListener('click', () => {
        if (state.dashInfo) state.dashInfo.close();
        state.dashInfo = new google.maps.InfoWindow({
          content: '<div style="color:#111827;font-size:14px;line-height:1.55;min-width:200px"><strong>' + esc(l.driverName || ('Driver ' + l.driverId)) + '</strong><br>Near: <span id="dash-iw-city-' + l.driverId + '">Locating…</span><br>Speed: ' + speedText(l) + '<br>Heading: ' + compass(l.heading) + '<br>Last update: ' + esc(fmtDate(l.updatedAt)) + '</div>',
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
      '<div class="dw-route-places">' + routeChain(load).map(esc).join(' &rarr; ') + '</div>' +
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
    '<div class="dw-head"><div class="dw-avatar' + (d.active === false ? ' off' : '') + '"' + (d.active === false ? '' : ' style="background:' + driverColor(d.id) + ';color:#fff"') + '>' + esc(initial) + '</div>' +
    '<div class="dw-id"><h3>' + esc(d.name) + '</h3><div class="small muted">' + esc(d.phone || '') + (d.phone && d.email ? ' · ' : '') + esc(d.email || '') + '</div></div>' +
    status + '</div>' +
    '<div class="dw-chips">' + chips + '</div>' +
    route +
    '<p class="small muted dw-foot">Pending requests: <strong>' + (Number(d.pendingRequests) || 0) + '</strong> &middot; Unread messages: <strong>' + (Number(d.unreadMessages) || 0) + '</strong>' + speed + citySlot + '</p>' +
    '</div>';
}
/* Route progress for the dashboard bar, as a 0..1 fraction. Prefers the
   server's GPS-based progress (the same % the Loads page shows:
   distance travelled toward the delivery, 99 at the receiver, 100 when
   completed); falls back to the pickup/delivery time estimate only
   when the server has no GPS progress for the load yet. */
function routeProgress(load) {
  if (!load) return null;
  if (typeof load.progress === 'number') return load.progress / 100;
  if (!load.pickupAt || !load.deliveryAt) return null;
  const p = Date.parse(load.pickupAt), q = Date.parse(load.deliveryAt);
  if (isNaN(p) || isNaN(q) || q <= p) return null;
  return Math.max(0, Math.min(1, (Date.now() - p) / (q - p)));
}
/* "904 Edwards Dr, Lebanon IN 46052" -> "Lebanon, IN". Tolerant of
   missing commas / missing spaces / ALL-CAPS addresses, which is how
   the saved LXL-2038499 addresses came out ("...Lebno,IN 46052",
   "1513 N BROAD ST LANSDALE, PA 19446"). */
function titleCase(w) {
  const s = String(w || '');
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
function shortPlace(addr) {
  if (!addr) return '—';
  const s = String(addr).replace(/,/g, ', ').replace(/\s+/g, ' ').trim();
  const m = s.match(/,\s*([^,]+?)[,\s]+([A-Z]{2})\s+\d{5}/);
  if (m) return m[1].trim() + ', ' + m[2];
  // No comma between street and city: the city is the last word before "ST ZIP".
  const m2 = s.match(/^(.*?)[,\s]+([A-Z]{2})\s+\d{5}\s*$/);
  if (m2) {
    const words = m2[1].trim().split(/\s+/);
    return titleCase(words[words.length - 1] || '') + ', ' + m2[2];
  }
  const cs = cityStateOf(addr);
  if (cs) return cs.city + ', ' + cs.state;
  return s;
}
function fmtShortTime(iso, tz) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz || 'America/Indiana/Indianapolis' }); } catch (e) { return '—'; }
}
/* Google Maps loader: fetches the browser key from the server (admin-only)
   and loads the Maps JavaScript API once. Returns google.maps, or null when
   no key is configured or the script fails — callers show a fallback note. */
let googleMapsPromise = null;
let googleMapsKey = null; // kept for the REST geocode fallback below
let googleMapsKeyPromise = null;
/* Fetches + caches the browser key (admin-only endpoint). Kept separate
   from the script loader: once the map script is loaded, ensureGoogleMaps
   returns early and would never fetch the key — which is exactly why the
   REST geocode fallback silently never ran (the key stayed null). */
async function ensureGoogleMapsKey() {
  if (googleMapsKey) return googleMapsKey;
  if (!googleMapsKeyPromise) {
    googleMapsKeyPromise = api('/api/admin/maps-config').catch(() => ({})).then(cfg => {
      googleMapsKey = cfg && cfg.googleMapsApiKey ? cfg.googleMapsApiKey : null;
      return googleMapsKey;
    });
  }
  return googleMapsKeyPromise;
}
async function ensureGoogleMaps() {
  if (window.google && google.maps) return google.maps;
  if (googleMapsPromise) return googleMapsPromise;
  googleMapsPromise = (async () => {
    try {
      const key = await ensureGoogleMapsKey();
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
/* One map colour per driver, stable by driver id — no more all-gold pins.
   Akash (id 3) gets royal blue, Test Driver (id 2) gets green. */
const DRIVER_COLORS = ['#DC2626', '#EA580C', '#16A34A', '#2563EB', '#9333EA', '#0891B2', '#DB2777', '#65A30D'];
function driverColor(driverId) {
  const n = Number(driverId);
  return DRIVER_COLORS[(Number.isFinite(n) ? Math.abs(n) : 0) % DRIVER_COLORS.length];
}
/* Coloured circle pin with the driver's initial. The selected driver's
   pin is bigger with a gold ring so it stands out on the Locations map. */
function driverPinIcon(name, driverId, selected) {
  const initial = String(name || '?').trim().charAt(0).toUpperCase();
  const color = driverColor(driverId);
  if (selected) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="21" fill="' + color + '" stroke="#F2B705" stroke-width="4"/><text x="24" y="31" font-size="20" font-weight="bold" text-anchor="middle" fill="#FFFFFF" font-family="Arial">' + initial + '</text></svg>';
    return { url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg), scaledSize: new google.maps.Size(48, 48), anchor: new google.maps.Point(24, 24) };
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><circle cx="18" cy="18" r="16" fill="' + color + '" stroke="#FFFFFF" stroke-width="2"/><text x="18" y="24" font-size="16" font-weight="bold" text-anchor="middle" fill="#FFFFFF" font-family="Arial">' + initial + '</text></svg>';
  return { url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg), scaledSize: new google.maps.Size(36, 36), anchor: new google.maps.Point(18, 18) };
}
/* City + state for a driver position: reverse-geocodes the coordinates
   through Google (Geocoding API, same key as the maps). Results are cached
   by rounded coordinates so the 10-second refresh doesn't re-geocode the
   same spot over and over. Returns e.g. "Lebanon, IN", or null. */
function placeFromComponents(comps) {
  if (!comps) return null;
  const find = (type) => { const c = comps.find(c => (c.types || []).includes(type)); return c ? c.short_name : null; };
  const city = find('locality') || find('sublocality') || find('postal_town') || find('administrative_area_level_2');
  const state = find('administrative_area_level_1');
  return (city && state) ? (city + ', ' + state) : (city || state || null);
}
const geoCache = new Map();
async function getCityState(lat, lng) {
  const key = Number(lat).toFixed(3) + ',' + Number(lng).toFixed(3);
  if (geoCache.has(key)) return geoCache.get(key);
  const pr = (async () => {
    // 1) Server-side reverse-geocode — the reliable route (the browser
    // Geocoder and the REST fetch both failed silently in the live app).
    try {
      const r = await api('/api/admin/geocode?lat=' + Number(lat) + '&lng=' + Number(lng));
      if (r && r.place) return r.place;
      console.warn('city/state: server geocode returned', r && r.status, (r && r.error) || '');
    } catch (e) { console.warn('city/state: server geocode failed', e && e.message); }
    // 2) Google Maps JS Geocoder (modular "geocoding" library).
    try {
      const g = await ensureGoogleMaps();
      if (g && google.maps.importLibrary) {
        const { Geocoder } = await google.maps.importLibrary('geocoding');
        const geocoder = new Geocoder();
        const out = await new Promise((resolve) => geocoder.geocode({ location: { lat: Number(lat), lng: Number(lng) } }, (results, status) => resolve({ results, status })));
        const place = placeFromComponents(out.status === 'OK' && out.results && out.results[0] ? out.results[0].address_components : null);
        if (place) return place;
        console.warn('city/state: JS Geocoder returned', out.status);
      } else {
        console.warn('city/state: Maps API or importLibrary unavailable');
      }
    } catch (e) { console.warn('city/state: JS Geocoder failed', e && e.message); }
    // 3) Fallback: Geocoding API over plain HTTPS with the same key.
    // (The JS path stayed silent before, so a second route + a console
    // note means the next check can say WHY it failed instead of "—".)
    try {
      if (!googleMapsKey) await ensureGoogleMapsKey();
      if (!googleMapsKey) return null;
      const r = await fetch('https://maps.googleapis.com/maps/api/geocode/json?latlng=' + Number(lat) + ',' + Number(lng) + '&key=' + encodeURIComponent(googleMapsKey));
      const j = await r.json();
      const place = placeFromComponents(j.status === 'OK' && j.results && j.results[0] ? j.results[0].address_components : null);
      if (place) return place;
      console.warn('city/state: REST geocode returned', j.status, j.error_message || '');
    } catch (e) { console.warn('city/state: REST geocode failed', e && e.message); }
    return null;
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
/* The Locations background is a real fixed layer too — same pattern as
   the dashboard / Rate Cons / Documents layers. */
function ensureLocBgLayer() {
  if (!document.getElementById('locBgLayer')) {
    const layer = document.createElement('div');
    layer.id = 'locBgLayer';
    document.body.prepend(layer);
  }
}
function removeLocBgLayer() {
  const layer = document.getElementById('locBgLayer');
  if (layer) layer.remove();
}
/* The Loads background is a real fixed layer too — same pattern. */
function ensureLoadsBgLayer() {
  if (!document.getElementById('loadsBgLayer')) {
    const layer = document.createElement('div');
    layer.id = 'loadsBgLayer';
    document.body.prepend(layer);
  }
}
function removeLoadsBgLayer() {
  const layer = document.getElementById('loadsBgLayer');
  if (layer) layer.remove();
}
/* Trucks & Trailers background: the LXL reefer yard — same pattern. */
function ensureTrucksBgLayer() {
  if (!document.getElementById('trucksBgLayer')) {
    const layer = document.createElement('div');
    layer.id = 'trucksBgLayer';
    document.body.prepend(layer);
  }
}
function removeTrucksBgLayer() {
  const layer = document.getElementById('trucksBgLayer');
  if (layer) layer.remove();
}
/* Drivers background: the light-trails photo — same pattern. */
const ADMIN_CARD_COLORS = ['#2563EB', '#9333EA', '#0891B2', '#DB2777', '#EA580C', '#16A34A', '#65A30D', '#DC2626'];

function ensureRequestsBgLayer() {
  if (!document.getElementById('requestsBgLayer')) {
    const d = document.createElement('div');
    d.id = 'requestsBgLayer';
    document.body.prepend(d);
  }
}

function ensureMaintenanceBgLayer() {
  if (!document.getElementById('maintenanceBgLayer')) {
    const d = document.createElement('div');
    d.id = 'maintenanceBgLayer';
    document.body.prepend(d);
  }
}

function ensureCashflowBgLayer() {
  if (!document.getElementById('cashflowBgLayer')) {
    const d = document.createElement('div');
    d.id = 'cashflowBgLayer';
    document.body.prepend(d);
  }
}

function ensureAdminsBgLayer() {
  if (!document.getElementById('adminsBgLayer')) {
    const d = document.createElement('div');
    d.id = 'adminsBgLayer';
    document.body.prepend(d);
  }
}

function ensureDriversBgLayer() {
  if (!document.getElementById('driversBgLayer')) {
    const layer = document.createElement('div');
    layer.id = 'driversBgLayer';
    document.body.prepend(layer);
  }
}
function removeDriversBgLayer() {
  const layer = document.getElementById('driversBgLayer');
  if (layer) layer.remove();
}
function removeAdminsBgLayer() {
  const layer = document.getElementById('adminsBgLayer');
  if (layer) layer.remove();
}
function removeRequestsBgLayer() {
  const layer = document.getElementById('requestsBgLayer');
  if (layer) layer.remove();
}
function removeMaintenanceBgLayer() {
  const layer = document.getElementById('maintenanceBgLayer');
  if (layer) layer.remove();
}
function removeCashflowBgLayer() {
  const layer = document.getElementById('cashflowBgLayer');
  if (layer) layer.remove();
}
/* The Chat background is a real fixed layer too — same pattern. */
function ensureChatBgLayer() {
  if (!document.getElementById('chatBgLayer')) {
    const layer = document.createElement('div');
    layer.id = 'chatBgLayer';
    document.body.prepend(layer);
  }
}
function removeChatBgLayer() {
  const layer = document.getElementById('chatBgLayer');
  if (layer) layer.remove();
}

/* ---------- Drivers ---------- */
/* Display a stored phone number as 718-717-6440. */
function fmtPhone(p) {
  const raw = String(p || '').trim();
  if (!raw) return '—';
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6) : raw;
}

/* Drivers — Option B driver cards (owner's pick, 2026-11-16) on the
   light-trails background. Phone numbers only: email is gone from this
   section — the add form and the cards show phone, never email. Each
   card also carries a Documents button to that driver's own documents
   page (license / application / other). */
async function viewDrivers(main) {
  ensureDriversBgLayer();
  document.body.classList.add('drivers-bg');
  const drivers = await api('/api/admin/drivers');
  state.driversCache = Array.isArray(drivers) ? drivers : [];
  // /api/admin/drivers does not include assignments — merge them from /overview.
  const driverUnits = {};
  try {
    const overview = await api('/api/admin/overview');
    (Array.isArray(overview) ? overview : (overview.drivers || [])).forEach(o => {
      driverUnits[o.id] = { truck: o.truck || null, trailer: o.trailer || null };
    });
  } catch (e) { /* overview unavailable — assignment fields stay blank */ }
  const cardFor = (d) => {
    const u = driverUnits[d.id] || {};
    const dTruck = u.truck || d.truck;
    const dTrailer = u.trailer || d.trailer;
    const truckNo = dTruck ? (dTruck.unitNumber || dTruck) : (d.truckUnitNumber || '—');
    const trailerNo = dTrailer ? (dTrailer.unitNumber || dTrailer) : (d.trailerUnitNumber || '—');
    const color = driverColor(d.id);
    const initial = esc((String(d.name || '?').trim().charAt(0) || '?').toUpperCase());
    const inactive = d.active === false;
    return '<div class="driver-card">' +
      '<div class="dc-stripe" style="background:' + color + '"></div>' +
      '<div class="dc-body">' +
      '<div class="dc-head"><span class="dc-avatar" style="background:' + color + '">' + initial + '</span>' +
      '<div><div class="dc-name">' + esc(d.name) + '</div><div class="dc-sub">Driver</div></div>' +
      (inactive ? '<span class="pill red">Inactive</span>' : '<span class="pill green">Active</span>') + '</div>' +
      '<div class="dc-stats">' +
      '<div><span>PHONE</span><strong>' + esc(fmtPhone(d.phone)) + '</strong></div>' +
      '<div><span>TRUCK</span><strong>' + esc(truckNo) + '</strong></div>' +
      '<div><span>TRAILER</span><strong>' + esc(trailerNo) + '</strong></div>' +
      '<div><span>RELAY ID</span><strong>' + esc(d.relayDriverId || 'Not linked') + '</strong></div>' +
      '</div>' +
      '<div class="dc-actions">' +
      '<button class="btn btn-blue btn-sm" data-driver-docs="' + d.id + '" data-driver-name="' + esc(d.name) + '">Documents</button> ' +
      '<button class="btn btn-ghost btn-sm" data-relay-driver="' + d.id + '" data-driver-name="' + esc(d.name) + '" data-relay-id="' + esc(d.relayDriverId || '') + '">Relay ID</button> ' +
      '<button class="btn btn-ghost btn-sm" data-toggle-driver="' + d.id + '" data-active="' + inactive + '">' +
      (inactive ? 'Activate' : 'Deactivate') + '</button> ' +
      '<button class="btn btn-ghost btn-sm" data-reset-driver="' + d.id + '" data-driver-name="' + esc(d.name) + '">Reset password</button> ' +
      '<button class="btn btn-danger btn-sm" data-delete-driver="' + d.id + '" data-driver-name="' + esc(d.name) + '">Delete</button>' +
      '</div></div></div>';
  };
  main.innerHTML = '<div class="rc-head"><h1>Drivers</h1>' +
    '<button class="btn btn-blue" id="addDriverToggle" type="button">+ Add driver</button></div>' +
    '<div class="card add-unit-card" id="addDriverCard" hidden><h3>Add driver</h3><form id="addDriverForm">' +
    '<div class="form-row">' +
    '<div class="field"><label for="ad-name">Name *</label><input id="ad-name" required></div>' +
    '<div class="field"><label for="ad-phone">Phone *</label><input id="ad-phone" type="tel" autocomplete="tel" required></div>' +
    '<div class="field"><label for="ad-pass">Password *</label><input id="ad-pass" type="password" required minlength="8" autocomplete="new-password"></div>' +
    '</div><p class="small muted">Drivers sign in with their phone number.</p>' +
    '<div class="form-actions"><button class="btn btn-blue" type="submit">Add driver</button>' +
    '<button class="btn btn-ghost" type="button" data-cancel-add="addDriverForm">Cancel</button></div>' +
    '</form></div>' +
    (state.driversCache.length ? '<div class="driver-grid">' + state.driversCache.map(cardFor).join('') + '</div>' : '<p class="empty">No drivers yet.</p>');

  const addBtn = document.getElementById('addDriverToggle');
  const addCard = document.getElementById('addDriverCard');
  if (addBtn && addCard) addBtn.addEventListener('click', () => { addCard.hidden = !addCard.hidden; });
  // Cancel: throw away whatever was typed and fold the form back up.
  main.querySelectorAll('[data-cancel-add]').forEach(b => b.addEventListener('click', () => {
    const form = document.getElementById(b.dataset.cancelAdd);
    if (!form) return;
    form.reset();
    const card = form.closest('.add-unit-card');
    if (card) card.hidden = true;
  }));
  document.getElementById('addDriverForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = document.getElementById('ad-phone').value.trim();
    if (!phone) { toast('Enter the driver’s phone number.', 'error'); return; }
    try {
      const newPw = document.getElementById('ad-pass').value;
      await api('/api/admin/drivers', { method: 'POST', body: JSON.stringify({
        name: document.getElementById('ad-name').value.trim(),
        phone,
        password: newPw,
      }) });
      toast('Driver added.', 'ok');
      renderAdminView('drivers');
    } catch (err) { showError(err); }
  });
  main.querySelectorAll('[data-driver-docs]').forEach(b => b.addEventListener('click', () => {
    state.driverDocsTarget = { id: parseInt(b.dataset.driverDocs, 10), name: b.dataset.driverName || '' };
    try { localStorage.setItem('lxl_driverdocs_target', JSON.stringify(state.driverDocsTarget)); } catch (e) {}
    renderAdminView('driverDocs');
  }));
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
  main.querySelectorAll('[data-relay-driver]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.relayDriver;
    const name = btn.dataset.driverName || 'this driver';
    const current = btn.dataset.relayId || '';
    const value = prompt('Relay Driver ID for ' + name + ' — the 16-digit ID from the Relay portal (Drivers → profile → Settings). Leave empty to unlink:', current);
    if (value === null) return;
    try {
      await api('/api/admin/drivers/' + id + '/relay-id', { method: 'POST', body: JSON.stringify({ relayDriverId: value.trim() }) });
      toast(value.trim() ? ('Relay ID saved for ' + name + '.') : ('Relay ID removed for ' + name + '.'), 'ok');
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

/* ---------- Driver documents ---------- */
/* A driver's own documents page (owner's ask, 2026-11-16), built the
   same as the truck/trailer documents page: tiles, summary pills,
   issued/expiry dates read off the upload automatically. Separate from
   the BOL Documents section and from the unit documents. */
const DRIVER_DOC_LABELS = {
  driver_license: 'Driver License',
  driver_application: 'Driver Application',
  other: 'Other Documents',
};
const DRIVER_DOC_TYPES_ALL = Object.keys(DRIVER_DOC_LABELS);
const DRIVER_DOC_CORE = ['driver_license', 'driver_application', 'other'];

async function viewDriverDocuments(main) {
  const target = state.driverDocsTarget;
  if (!target) { renderAdminView('drivers'); return; }
  const [drivers, docs] = await Promise.all([
    api('/api/admin/drivers').catch(() => []),
    api('/api/admin/driver-documents?driverId=' + target.id).catch(() => []),
  ]);
  const driver = (Array.isArray(drivers) ? drivers : []).find(u => u.id === target.id);
  if (!driver) { toast('That driver no longer exists.', 'err'); renderAdminView('drivers'); return; }
  const list = Array.isArray(docs) ? docs : [];
  const byType = new Map();
  for (const d of list) {
    if (!byType.has(d.docType)) byType.set(d.docType, []);
    byType.get(d.docType).push(d);
  }
  let nActive = 0, nSoon = 0, nExpired = 0;
  for (const d of list) {
    const st = equipDocStatus(d.expiryDate);
    if (st.key === 'active') nActive++;
    else if (st.key === 'soon') nSoon++;
    else if (st.key === 'expired') nExpired++;
  }
  const nMissing = DRIVER_DOC_CORE.filter(t => !byType.has(t)).length;
  const countdown = (d) => {
    const st = equipDocStatus(d.expiryDate);
    if (st.key === 'expired') return 'Expired ' + fmtExpiry(d.expiryDate);
    if (st.key === 'soon' || st.key === 'active') return st.days + (st.days === 1 ? ' day' : ' days') + ' left · expires ' + fmtExpiry(d.expiryDate);
    return 'No expiry date — add it below';
  };
  const tileHtml = (d) => {
    const st = equipDocStatus(d.expiryDate);
    return '<div class="ud-tile ' + st.cls + '">' +
      '<div class="ud-tile-top"><span class="ud-tile-name">' + esc(DRIVER_DOC_LABELS[d.docType] || d.docType) + '</span>' +
      '<span class="doc-pill ' + st.cls + '">' + st.label + '</span></div>' +
      '<div class="ud-file">' + esc(d.filename || '') + (d.note ? ' · ' + esc(d.note) : '') + '</div>' +
      '<div class="ud-count">' + countdown(d) + '</div>' +
      '<div class="ud-dates">' +
      '<label>Issued<input type="date" data-ddoc-issued="' + d.id + '" value="' + esc(d.issuedDate || '') + '"></label>' +
      '<label>Expires<input type="date" data-ddoc-exp="' + d.id + '" value="' + esc(d.expiryDate || '') + '"></label></div>' +
      '<div class="ud-acts"><button class="btn btn-ghost btn-sm" type="button" data-ddoc-view="' + d.id + '">View</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-ddoc-pick="' + d.docType + '">Replace</button>' +
      '<button class="btn btn-danger btn-sm" type="button" data-ddoc-del="' + d.id + '">Delete</button></div></div>';
  };
  const missingTile = (t) =>
    '<div class="ud-tile missing"><div class="ud-tile-top"><span class="ud-tile-name">' + DRIVER_DOC_LABELS[t] + '</span>' +
    '<span class="doc-pill grey">Missing</span></div>' +
    '<div class="ud-count">Not uploaded yet</div>' +
    '<div class="ud-acts"><button class="btn btn-sm" type="button" data-ddoc-pick="' + t + '">Upload</button></div></div>';
  const coreTiles = DRIVER_DOC_CORE.map(t => {
    const ds = byType.get(t) || [];
    return ds.length ? ds.map(tileHtml).join('') : missingTile(t);
  }).join('');
  const extraTiles = list.filter(d => !DRIVER_DOC_CORE.includes(d.docType)).map(tileHtml).join('');
  main.innerHTML = '<button class="btn btn-ghost btn-sm" id="ddBack" type="button">← Drivers</button>' +
    '<div class="rc-head"><h1>Documents — ' + esc(driver.name) + '</h1>' +
    (driver.active === false ? '<span class="pill red">Inactive</span>' : '<span class="pill green">Active</span>') + '</div>' +
    '<p class="muted">' + esc('Driver' + (driver.phone ? ' · ' + fmtPhone(driver.phone) : '')) + '</p>' +
    '<div class="ud-summary">' +
    '<span class="doc-pill green">' + nActive + ' Active</span>' +
    '<span class="doc-pill amber">' + nSoon + ' Expiring</span>' +
    '<span class="doc-pill red">' + nExpired + ' Expired</span>' +
    '<span class="doc-pill grey">' + nMissing + ' Missing</span></div>' +
    '<p class="small muted">Upload a photo or scan of a paper and the dates are read off it automatically — check them on the tile and fix any date with the date boxes.</p>' +
    '<div class="ud-grid">' + coreTiles + extraTiles + '</div>' +
    '<div class="card"><h3>Add another document</h3>' +
    '<form class="unit-doc-form" id="ddAddForm">' +
    '<div class="field"><label>Document type</label><select name="docType">' +
    DRIVER_DOC_TYPES_ALL.map(t => '<option value="' + t + '">' + DRIVER_DOC_LABELS[t] + '</option>').join('') +
    '</select></div>' +
    '<div class="field"><label>File *</label><input type="file" name="file" required></div>' +
    '<div class="field"><label>Note</label><input name="note"></div>' +
    '<button class="btn btn-sm" type="submit">Upload</button></form></div>' +
    '<input type="file" id="ddTileFile" hidden>';
  document.getElementById('ddBack').addEventListener('click', () => renderAdminView('drivers'));
  const uploadFor = async (docType, file) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('driverId', String(target.id));
    fd.append('docType', docType);
    try {
      const r = await api('/api/admin/driver-documents', { method: 'POST', body: fd });
      const label = DRIVER_DOC_LABELS[docType] || docType;
      if (r && r.detected && (r.detected.expiryDate || r.detected.issuedDate)) {
        toast(label + ' saved — dates read automatically' +
          (r.detected.issuedDate ? ' · issued ' + fmtExpiry(r.detected.issuedDate) : '') +
          (r.detected.expiryDate ? ' · expires ' + fmtExpiry(r.detected.expiryDate) : '') + '.', 'ok');
      } else {
        toast(label + ' saved — no dates found on it; add them on the tile.', 'ok');
      }
      renderAdminView('driverDocs');
    } catch (err) { showError(err); }
  };
  const tileFile = document.getElementById('ddTileFile');
  let pendingType = null;
  main.querySelectorAll('[data-ddoc-pick]').forEach(b => b.addEventListener('click', () => {
    pendingType = b.dataset.ddocPick;
    tileFile.value = '';
    tileFile.click();
  }));
  tileFile.addEventListener('change', () => {
    if (pendingType && tileFile.files && tileFile.files[0]) uploadFor(pendingType, tileFile.files[0]);
    pendingType = null;
  });
  main.querySelectorAll('[data-ddoc-view]').forEach(b => b.addEventListener('click', () => {
    const d = list.find(x => String(x.id) === b.dataset.ddocView);
    if (d) downloadFile(d.url, d.filename, true, d.mimeType);
  }));
  main.querySelectorAll('[data-ddoc-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this document?')) return;
    try {
      await api('/api/admin/driver-documents/' + b.dataset.ddocDel, { method: 'DELETE' });
      toast('Document deleted.', 'ok');
      renderAdminView('driverDocs');
    } catch (err) { showError(err); }
  }));
  const patchDate = async (id, body) => {
    try {
      await api('/api/admin/driver-documents/' + id, { method: 'PATCH', body: JSON.stringify(body) });
      toast('Date saved.', 'ok');
      renderAdminView('driverDocs');
    } catch (err) { showError(err); }
  };
  main.querySelectorAll('[data-ddoc-exp]').forEach(inp => inp.addEventListener('change', () =>
    patchDate(inp.dataset.ddocExp, { expiryDate: inp.value || null })));
  main.querySelectorAll('[data-ddoc-issued]').forEach(inp => inp.addEventListener('change', () =>
    patchDate(inp.dataset.ddocIssued, { issuedDate: inp.value || null })));
  document.getElementById('ddAddForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const file = form.file.files && form.file.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('driverId', String(target.id));
    fd.append('docType', form.docType.value);
    if (form.note.value) fd.append('note', form.note.value);
    try {
      const r = await api('/api/admin/driver-documents', { method: 'POST', body: fd });
      const label = DRIVER_DOC_LABELS[form.docType.value] || 'Document';
      if (r && r.detected && r.detected.expiryDate) toast(label + ' saved — expires ' + fmtExpiry(r.detected.expiryDate) + ' (read automatically).', 'ok');
      else toast(label + ' saved.', 'ok');
      renderAdminView('driverDocs');
    } catch (err) { showError(err); }
  });
}

/* ---------- Admins & Dispatchers ---------- */
async function viewAdmins(main) {
  document.body.classList.add('admins-bg'); // control-room photo + liquid glass (removed on view switch)
  ensureAdminsBgLayer();
  const admins = await api('/api/admin/admins');
  const list = Array.isArray(admins) ? admins : [];
  const roleOf = (a) => a.isMainAdmin ? 'Main Admin' : (a.adminKind === 'admin' ? 'Admin' : 'Dispatcher');
  main.innerHTML =
    '<div class="rc-head"><h1>Admins & Dispatchers</h1>' +
    '<button class="btn btn-blue" type="button" data-toggle-add="addAdminCard">+ Add admin</button></div>' +
    '<div class="card add-unit-card" id="addAdminCard" hidden><h3>Add admin / dispatcher</h3><form id="addAdminForm">' +
    '<div class="form-row">' +
    '<div class="field"><label for="aa-name">Name *</label><input id="aa-name" required></div>' +
    '<div class="field"><label for="aa-email">Email *</label><input id="aa-email" type="email" required autocomplete="email"></div>' +
    '<div class="field"><label for="aa-pass">Password *</label><input id="aa-pass" type="password" required minlength="8" autocomplete="new-password"></div>' +
    '<div class="field"><label for="aa-role">Role *</label><select id="aa-role"><option value="dispatcher">Dispatcher</option><option value="admin">Admin</option></select></div>' +
    '</div><p class="small muted">Admins sign in to the Admin Portal with their email and password. Dispatchers can do everything except manage admin accounts. Admins can also add, reset and delete other admin accounts — the main admin (owner) account can never be deleted.</p>' +
    '<div class="form-actions"><button class="btn btn-blue" type="submit">Add admin</button> ' +
    '<button class="btn btn-ghost" type="button" data-cancel-add="addAdminForm">Cancel</button></div>' +
    '</form></div>' +
    (list.length ? '<div class="driver-grid">' + list.map((a, i) => {
      const color = ADMIN_CARD_COLORS[i % ADMIN_CARD_COLORS.length];
      const initial = esc((String(a.name || '?').trim().charAt(0) || '?').toUpperCase());
      const isSelf = !!(state.user && a.id === state.user.id);
      return '<div class="driver-card">' +
        '<div class="dc-stripe" style="background:' + color + '"></div>' +
        '<div class="dc-body">' +
        '<div class="dc-head"><span class="dc-avatar" style="background:' + color + '">' + initial + '</span>' +
        '<div><div class="dc-name">' + esc(a.name) + '</div><div class="dc-sub">' + roleOf(a) + (isSelf ? ' · You' : '') + '</div></div>' +
        (a.isMainAdmin ? '<span class="pill gold">Main Admin</span>' : (a.active === false ? '<span class="pill red">Inactive</span>' : '<span class="pill green">Active</span>')) + '</div>' +
        '<div class="dc-stats">' +
        '<div><span>EMAIL</span><strong>' + esc(a.email || '—') + '</strong></div>' +
        '<div><span>ROLE</span><strong>' + roleOf(a) + '</strong></div>' +
        '<div><span>ACCESS</span><strong>' + (roleOf(a) === 'Dispatcher' ? 'All but admin accounts' : 'Everything') + '</strong></div>' +
        '</div>' +
        '<div class="dc-actions">' +
        '<button class="btn btn-ghost btn-sm" data-reset-admin="' + a.id + '" data-admin-name="' + esc(a.name) + '">Reset password</button> ' +
        (isSelf || a.isMainAdmin
          ? '<span class="small muted">' + (a.isMainAdmin ? 'Main admin — can’t be deleted' : '') + '</span>'
          : '<button class="btn btn-danger btn-sm" data-delete-admin="' + a.id + '" data-admin-name="' + esc(a.name) + '">Delete</button>') +
        '</div></div></div>';
    }).join('') + '</div>' : '<p class="empty">No admins yet.</p>');

  const addCard = document.getElementById('addAdminCard');
  main.querySelector('[data-toggle-add]').addEventListener('click', () => { addCard.hidden = !addCard.hidden; });
  main.querySelector('[data-cancel-add]').addEventListener('click', () => {
    document.getElementById('addAdminForm').reset();
    addCard.hidden = true;
  });
  document.getElementById('addAdminForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPw = document.getElementById('aa-pass').value;
    try {
      await api('/api/admin/admins', { method: 'POST', body: JSON.stringify({
        name: document.getElementById('aa-name').value.trim(),
        email: document.getElementById('aa-email').value.trim(),
        password: newPw,
        adminKind: document.getElementById('aa-role').value,
      }) });
      toast('Admin added.', 'ok');
      renderAdminView('admins');
    } catch (err) { showError(err); }
  });
  main.querySelectorAll('[data-reset-admin]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.resetAdmin;
    const name = btn.dataset.adminName || 'this admin';
    const pw = prompt('New password for ' + name + ' (at least 8 characters):');
    if (pw === null) return;
    if (pw.length < 8) { toast('Password must be at least 8 characters.', 'error'); return; }
    const pw2 = prompt('Type the new password again to confirm:');
    if (pw2 === null) return;
    if (pw2 !== pw) { toast('Passwords do not match.', 'error'); return; }
    try {
      await api('/api/admin/admins/' + id + '/password', { method: 'POST', body: JSON.stringify({ password: pw }) });
      toast('Password reset. ' + name + ' will need to sign in again with the new password.', 'ok');
    } catch (err) { showError(err); }
  }));
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
  document.body.classList.add('trucks-bg'); // LXL reefer yard photo + liquid glass (removed on view switch)
  ensureTrucksBgLayer();
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
  const pairFor = (u, type) => {
    if (!u.driverId) return null;
    const pool = type === 'truck' ? rList : tList;
    return pool.find(x => x.driverId === u.driverId) || null;
  };
  main.innerHTML = '<div class="rc-head"><h1>Trucks &amp; Trailers</h1>' +
    '<button class="btn" id="addTruckToggle" type="button">+ Add truck</button></div>' +
    '<div class="chips">' + chip('all', 'All units', tList.length + rList.length) +
    chip('yard', 'In the Yard', yardCount) + chip('road', 'On the Road', roadCount) + '</div>' +
    '<div class="card add-unit-card" id="addTruckCard" hidden><h3>Add truck</h3><form id="addTruckForm"><div class="form-row">' +
    '<div class="field"><label>Unit number *</label><input name="unitNumber" required></div>' +
    '<div class="field"><label>Make</label><input name="make"></div>' +
    '<div class="field"><label>Model</label><input name="model"></div>' +
    '<div class="field"><label>Year</label><input name="year" type="number"></div>' +
    '<div class="field"><label>Plate</label><input name="plate"></div>' +
    '<div class="field"><label>VIN</label><input name="vin"></div>' +
    '</div><div class="form-actions"><button class="btn btn-blue" type="submit">Add truck</button><button class="btn btn-ghost" type="button" data-cancel-add="addTruckForm">Cancel</button></div></form></div>' +
    '<div class="unit-grid">' + tList.map(u => unitCard(u, 'truck', pairFor(u, 'truck'))).join('') + '</div>' +
    '<div class="rc-head"><h2>Trailers</h2>' +
    '<button class="btn" id="addTrailerToggle" type="button">+ Add trailer</button></div>' +
    '<div class="card add-unit-card" id="addTrailerCard" hidden><h3>Add trailer</h3><form id="addTrailerForm"><div class="form-row">' +
    '<div class="field"><label>Unit number *</label><input name="unitNumber" required></div>' +
    '<div class="field"><label>Kind / type</label><input name="kind" placeholder="e.g. Reefer"></div>' +
    '<div class="field"><label>Year</label><input name="year" type="number"></div>' +
    '<div class="field"><label>Plate</label><input name="plate"></div>' +
    '<div class="field"><label>VIN</label><input name="vin"></div>' +
    '</div><div class="form-actions"><button class="btn btn-blue" type="submit">Add trailer</button><button class="btn btn-ghost" type="button" data-cancel-add="addTrailerForm">Cancel</button></div></form></div>' +
    '<div class="unit-grid">' + rList.map(u => unitCard(u, 'trailer', pairFor(u, 'trailer'))).join('') + '</div>';

  main.querySelectorAll('[data-yard]').forEach(b => b.addEventListener('click', () => {
    state.yardFilter = b.dataset.yard;
    renderAdminView('equipment');
  }));
  const toggleCard = (btnId, cardId) => {
    const btn = document.getElementById(btnId);
    const card = document.getElementById(cardId);
    if (btn && card) btn.addEventListener('click', () => { card.hidden = !card.hidden; });
  };
  toggleCard('addTruckToggle', 'addTruckCard');
  toggleCard('addTrailerToggle', 'addTrailerCard');
  // Cancel: throw away whatever was typed and fold the form back up.
  main.querySelectorAll('[data-cancel-add]').forEach(b => b.addEventListener('click', () => {
    const form = document.getElementById(b.dataset.cancelAdd);
    if (!form) return;
    form.reset();
    const card = form.closest('.add-unit-card');
    if (card) card.hidden = true;
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
function unitCard(u, type, pair) {
  if (!unitVisible(u)) return '';
  const desc = type === 'truck'
    ? [u.year, u.make, u.model].filter(Boolean).join(' ')
    : (u.make ? [u.year, u.make, u.model].filter(Boolean).join(' ') : [u.year, u.kind].filter(Boolean).join(' '));
  const driverOpts = '<option value="">— Unassigned —</option>' + state.driversCache.map(d =>
    '<option value="' + d.id + '"' + (u.driverId === d.id ? ' selected' : '') + '>' + esc(d.name) + '</option>').join('');
  const stat = (lbl, val, gold) => '<div class="unit-stat"><div class="lbl">' + lbl + '</div>' +
    '<div class="v' + (gold ? ' gold' : '') + '">' + esc(val) + '</div></div>';
  const stats = type === 'truck'
    ? stat('DRIVER', u.driverName || 'None') +
      stat('TRAILER', pair ? pair.unitNumber : '—') +
      stat('ODOMETER', u.odometerMi != null ? Number(u.odometerMi).toLocaleString('en-US') + ' mi' : '—', true)
    : stat('DRIVER', u.driverName || 'None') +
      stat('TRUCK', pair ? pair.unitNumber : '—') +
      stat('PLATE', u.plate || '—');
  return '<div class="unit-card tile" data-unit="' + type + '" data-id="' + u.id + '">' +
    '<div class="tile-stripe ' + (u.yardStatus === 'road' ? 'road' : 'yard') + '"></div>' +
    '<div class="tile-body">' +
    '<span class="tile-status ' + (u.yardStatus === 'road' ? 'road' : 'yard') + '">' + (u.yardStatus === 'road' ? '● ON THE ROAD' : '● IN THE YARD') + '</span>' +
    '<div class="tile-num">' + esc(u.unitNumber) + '</div>' +
    '<p class="muted small">' + esc(desc || '—') + (u.vin ? ' · VIN ' + esc(u.vin) : '') + (type === 'truck' && u.plate ? ' · Plate ' + esc(u.plate) : '') + '</p>' +
    '<div class="unit-stats">' + stats + '</div>' +
    '<div class="row">' +
    '<button class="btn btn-blue btn-sm" data-doc-btn>Documents</button>' +
    '<button class="btn btn-ghost btn-sm" data-yard-toggle>Move to ' + (u.yardStatus === 'road' ? 'Yard' : 'Road') + '</button>' +
    '<select data-assign-select>' + driverOpts + '</select>' +
    '<button class="btn btn-gold btn-sm" data-assign-btn>Assign</button>' +
    '</div>' +
    (type === 'truck'
      ? (u.odometerUpdatedAt ? '<p class="muted small" style="margin-top:8px">Odometer live from TRC eLOGS · Updated ' + esc(fmtDate(u.odometerUpdatedAt)) + '</p>' : '') +
        '<details class="odo-override"><summary>Manual odometer override</summary>' +
        '<div class="row"><label class="small" for="odo-' + u.id + '">Odometer (mi)</label>' +
        '<input type="number" min="0" step="1" id="odo-' + u.id + '" data-odo-input data-odo-orig="' + (u.odometerMi ?? '') + '" value="' + (u.odometerMi ?? '') + '" placeholder="No reading yet">' +
        '<button class="btn btn-ghost btn-sm" data-odo-btn>Save odometer</button></div></details>'
      : '') +
    '</div></div>';
}
function bindUnitCards(main, type) {
  const base = type === 'truck' ? '/api/admin/trucks' : '/api/admin/trailers';
  main.querySelectorAll('.unit-card[data-unit="' + type + '"]').forEach(card => {
    const id = card.dataset.id;
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
    card.querySelector('[data-doc-btn]').addEventListener('click', () => {
      state.unitDocsTarget = { type, id: parseInt(id, 10) };
      renderAdminView('unitDocs');
    });
    if (type === 'truck') {
      const odoInput = card.querySelector('[data-odo-input]');
      card.querySelector('[data-odo-btn]').addEventListener('click', async () => {
        const raw = odoInput.value.trim();
        const miles = Number(raw);
        if (raw === '' || !Number.isFinite(miles) || miles < 0) {
          showError(new Error('Enter a valid odometer reading (0 or more).'));
          return;
        }
        // Unchanged since the card rendered — nothing to save.
        if (odoInput.dataset.odoOrig !== '' && miles === Number(odoInput.dataset.odoOrig)) return;
        try {
          await api('/api/admin/trucks/' + id + '/odometer', { method: 'POST', body: JSON.stringify({ odometerMi: miles }) });
          toast('Odometer updated.', 'ok');
          renderAdminView('equipment');
        } catch (err) { showError(err); }
      });
    }
  });
}

/* ---------- Loads ---------- */
/* ISO -> "YYYY-MM-DDTHH:mm" in local time, for datetime-local inputs. */
/* The browser's IANA timezone, sent with load pickup/delivery times so
   the server stores them against the place they were entered for. */
function browserTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Indiana/Indianapolis'; }
  catch { return 'America/Indiana/Indianapolis'; }
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}
/* City/state from a location string's last segment:
   "904 Edwards Dr, Lebanon IN 46052" -> { city: 'Lebanon', state: 'IN' } */
function cityStateOf(location) {
  if (!location) return null;
  const parts = String(location).split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const last = parts[parts.length - 1] || '';
    const m = last.match(/^(.+?)\s+([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/);
    if (m) return { city: m[1], state: m[2].toUpperCase() };
  }
  // No usable comma form — addresses typed or read off a rate con
  // with no commas and mixed case ("1 arizona way keasbey Nj 08832",
  // "601 highway 52 e opp al") used to fall back to showing the full
  // street address as the card headline (owner, 2026-11-17: show
  // only the city and state like the other loads). The state code is
  // the final word (ZIP optional); the city is what follows the
  // street part of the address.
  const s = String(location).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const m2 = s.match(/^(.*?)\s+([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/);
  if (m2) {
    const suffixes = new Set(['STREET', 'ST', 'AVENUE', 'AVE', 'ROAD', 'RD', 'BOULEVARD', 'BLVD', 'DRIVE', 'DR', 'LANE', 'LN', 'HIGHWAY', 'HWY', 'COURT', 'CT', 'PARKWAY', 'PKWY', 'CIRCLE', 'CIR', 'TRAIL', 'TRL', 'PLACE', 'PL', 'WAY']);
    const words = m2[1].split(/\s+/).filter(Boolean);
    let cut = -1;
    words.forEach((w, i) => { if (suffixes.has(w.toUpperCase().replace(/\.$/, ''))) cut = i; });
    const rest = cut >= 0 ? words.slice(cut + 1) : words;
    const cityWords = rest.filter((w) => /^[A-Za-z][A-Za-z.'-]*$/.test(w) && w.length > 1);
    if (cityWords.length) return { city: cityWords.slice(-3).map(titleCase).join(' '), state: m2[2].toUpperCase() };
  }
  return null;
}

/* The full route chain for a load as short "City, ST" places: every
   pickup in order, then every delivery (owner, 2026-11-17: show
   both pickups, then the delivery). Loads without extra stops give
   the plain pickup -> delivery pair. */
function routeChain(l) {
  const s = l && l.stops;
  if (s && Array.isArray(s.pickups) && Array.isArray(s.deliveries) && (s.pickups.length > 1 || s.deliveries.length > 1)) {
    return s.pickups.concat(s.deliveries).map((x) => shortPlace(x.location));
  }
  return [shortPlace(l.pickupLocation), shortPlace(l.deliveryLocation)];
}

/* One load as a route card: big city-pair headline, bold blue reference,
   the route line as a live progress bar (server-computed %), Edit /
   Reopen / Reactivate / Delete along the bottom. */
function loadCardHtml(l) {
  const headline = routeChain(l).map(esc).join(' <span class="lc-arrow">&rarr;</span> ');
  const pct = typeof l.progress === 'number' ? l.progress : null;
  const pillCls = l.status === 'active' ? 'blue' : l.status === 'completed' ? 'green' : 'red';
  return '<div class="load-card">' +
    '<div class="lc-top"><div class="lc-cities">' + headline + '</div>' +
    '<span class="pill ' + pillCls + '">' + esc(l.status) + '</span></div>' +
    '<div class="lc-refrow"><span class="lc-ref">' + esc(l.reference) + '</span>' +
    '<span class="lc-bol">BOL: ' + esc(l.bolStatus ? (l.bolStatus === 'clean' ? 'Clean' : 'Wrong') : '—') + '</span></div>' +
    '<div class="lc-route">' +
      '<div class="lc-end"><div class="lc-tag">PICKUP</div><div class="lc-wh">' + esc(l.pickupWarehouse || l.pickupLocation) + '</div>' +
      (l.pickupWarehouse ? '<div class="lc-addr">' + esc(l.pickupLocation) + '</div>' : '') +
      '<div class="lc-date">' + fmtDate(l.pickupAt) + '</div></div>' +
      '<div class="lc-trackwrap"><div class="lc-track">' +
        (pct !== null ? '<div class="lc-fill" style="width:' + pct + '%"></div><div class="lc-marker" style="left:' + pct + '%"></div>' : '') +
      '</div>' + (pct !== null ? '<div class="lc-pct">' + pct + '%</div>' : '') + '</div>' +
      '<div class="lc-end lc-end-r"><div class="lc-tag">DELIVERY</div><div class="lc-wh">' + esc(l.deliveryWarehouse || l.deliveryLocation) + '</div>' +
      (l.deliveryWarehouse ? '<div class="lc-addr">' + esc(l.deliveryLocation) + '</div>' : '') +
      '<div class="lc-date">' + fmtDate(l.deliveryAt) + '</div></div>' +
    '</div>' +
    (l.stops && (l.stops.pickups.length > 1 || l.stops.deliveries.length > 1)
      ? '<div class="small muted" style="margin-top:6px">Stops: ' + [...l.stops.pickups.map((s, i) => 'Pickup ' + (i + 1) + ' ' + esc(s.location)), ...l.stops.deliveries.map((s, i) => 'Delivery ' + (i + 1) + ' ' + esc(s.location))].join(' &middot; ') + '</div>'
      : '') +
    '<div class="lc-bottom"><span class="lc-driver">Driver: ' + esc(l.driverName || '—') +
      (l.truckUnit ? ' &middot; Truck ' + esc(l.truckUnit) : '') + (l.trailerUnit ? ' &middot; Trailer ' + esc(l.trailerUnit) : '') + '</span>' +
    '<span class="lc-actions"><button class="btn btn-ghost btn-sm" data-edit-load="' + l.id + '">Edit</button> ' +
      (l.status === 'active' ? '<button class="btn btn-ghost btn-sm" data-complete-load="' + l.id + '">Complete</button> ' : '') +
      (l.status === 'completed' ? '<button class="btn btn-ghost btn-sm" data-reopen-load="' + l.id + '">Reopen</button> ' : '') +
      (l.status === 'cancelled' ? '<button class="btn btn-ghost btn-sm" data-reactivate-load="' + l.id + '">Reactivate</button> ' : '') +
      '<button class="btn btn-danger-o btn-sm" data-delete-load="' + l.id + '">Delete</button></span></div>' +
  '</div>';
}

async function viewLoads(main) {
  state.editingLoadId = null;
  document.body.classList.add('loads-bg'); // reefer dock-row photo + liquid glass (removed on view switch)
  ensureLoadsBgLayer();
  const [loads, drivers] = await Promise.all([api('/api/admin/loads'), api('/api/admin/drivers')]);
  state.driversCache = Array.isArray(drivers) ? drivers : [];
  const driverOptions = (sel) =>
    state.driversCache.map((d) => '<option value="' + d.id + '"' + (String(d.id) === String(sel) ? ' selected' : '') + '>' + esc(d.name) + '</option>').join('');
  const list = Array.isArray(loads) ? loads : [];
  main.innerHTML = '<div class="loads-page">' +
    '<div class="loads-head"><h1>Loads</h1><button class="btn" type="button" id="toggleAssignBtn">+ Add load</button></div>' +
    '<div class="card" id="assignCard" hidden><h2>Assign load</h2><form id="addLoadForm">' +
    '<label>Driver<select id="al-driver" required>' + driverOptions() + '</select></label>' +
    '<label>Reference<input id="al-ref" required placeholder="e.g. LXL-1001"></label>' +
    '<div id="al-pickups"><div class="al-stop-block">' +
    '<label>Pickup location<input id="al-pickup" class="al-s-loc" required placeholder="City, ST or full address"></label>' +
    '<label>Pickup warehouse name <span class="muted">(optional)</span><input id="al-pickup-wh" class="al-s-wh" placeholder="e.g. Walmart DC 6048"></label>' +
    '<label>Pickup date &amp; time<input id="al-pickup-at" class="al-s-at" type="datetime-local" required></label>' +
    '<label>Pickup number<input id="al-pickup-no" class="al-s-no" placeholder="Optional"></label>' +
    '</div></div>' +
    '<div style="text-align:right;margin:2px 0 10px"><button class="btn btn-sm" type="button" id="al-add-pickup">+ Pickup</button></div>' +
    '<div id="al-deliveries"><div class="al-stop-block">' +
    '<label>Delivery location<input id="al-delivery" class="al-s-loc" required placeholder="City, ST or full address"></label>' +
    '<label>Delivery warehouse name <span class="muted">(optional)</span><input id="al-delivery-wh" class="al-s-wh" placeholder="e.g. Costco Depot"></label>' +
    '<label>Delivery date &amp; time<input id="al-delivery-at" class="al-s-at" type="datetime-local" required></label>' +
    '<label>Delivery number<input id="al-delivery-no" class="al-s-no" placeholder="Optional"></label>' +
    '</div></div>' +
    '<div style="text-align:right;margin:2px 0 10px"><button class="btn btn-sm" type="button" id="al-add-delivery">+ Delivery</button></div>' +
    '<label>Notes<textarea id="al-notes" rows="2" placeholder="Optional"></textarea></label>' +
    '<button class="btn" type="submit">Assign load</button></form></div>' +
    (list.length
      ? '<div class="load-list">' + list.map(loadCardHtml).join('') + '</div>'
      : '<div class="card"><p class="empty">No loads yet.</p></div>') +
    '</div>';

  const assignCard = document.getElementById('assignCard');
  const toggleBtn = document.getElementById('toggleAssignBtn');
  const setAssignOpen = (open) => {
    assignCard.hidden = !open;
    toggleBtn.textContent = open ? 'Close' : '+ Add load';
  };
  toggleBtn.addEventListener('click', () => setAssignOpen(assignCard.hidden));

  const form = document.getElementById('addLoadForm');

  // Multi-stop support: "+ Pickup" / "+ Delivery" add another stop
  // block (location, warehouse, date & time, and its own pickup /
  // delivery number). The default stays one pickup + one delivery.
  const stopBlockHtml = (kind, n) => {
    const cap = kind === 'pickup' ? 'Pickup' : 'Delivery';
    return '<div class="al-stop-block"><div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px"><strong>' + cap + ' ' + n + '</strong>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-remove-stop>Remove</button></div>' +
      '<label>' + cap + ' location<input class="al-s-loc" required placeholder="City, ST or full address"></label>' +
      '<label>' + cap + ' warehouse name <span class="muted">(optional)</span><input class="al-s-wh" placeholder="e.g. ' + (kind === 'pickup' ? 'Walmart DC 6048' : 'Costco Depot') + '"></label>' +
      '<label>' + cap + ' date &amp; time<input class="al-s-at" type="datetime-local" required></label>' +
      '<label>' + cap + ' number<input class="al-s-no" placeholder="Optional"></label></div>';
  };
  const renumberStops = (containerId, kind) => {
    document.querySelectorAll('#' + containerId + ' .al-stop-block').forEach((b, i) => {
      const h = b.querySelector('strong');
      if (h) h.textContent = (kind === 'pickup' ? 'Pickup ' : 'Delivery ') + (i + 1);
    });
  };
  const addStopBlock = (kind, values, insertFirst) => {
    const container = document.getElementById(kind === 'pickup' ? 'al-pickups' : 'al-deliveries');
    if (container.querySelectorAll('.al-stop-block').length >= 4) { toast('Up to 4 stops of each kind per load.', 'err'); return null; }
    const wrap = document.createElement('div');
    wrap.innerHTML = stopBlockHtml(kind, container.querySelectorAll('.al-stop-block').length + 1);
    const block = wrap.firstElementChild;
    if (insertFirst) container.insertBefore(block, container.firstElementChild);
    else container.appendChild(block);
    if (values) {
      block.querySelector('.al-s-loc').value = values.location || '';
      block.querySelector('.al-s-wh').value = values.warehouse || '';
      block.querySelector('.al-s-at').value = values.at ? toLocalInput(values.at) : '';
      block.querySelector('.al-s-no').value = values.number || '';
    }
    renumberStops(container.id, kind);
    return block;
  };
  document.getElementById('al-add-pickup').addEventListener('click', () => addStopBlock('pickup'));
  document.getElementById('al-add-delivery').addEventListener('click', () => addStopBlock('delivery'));
  form.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-stop]');
    if (!btn) return;
    const block = btn.closest('.al-stop-block');
    const container = block.parentElement;
    const kind = container.id === 'al-pickups' ? 'pickup' : 'delivery';
    block.remove();
    renumberStops(container.id, kind);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const readBlock = (b) => ({
      location: b.querySelector('.al-s-loc').value.trim(),
      warehouse: b.querySelector('.al-s-wh').value.trim() || undefined,
      at: b.querySelector('.al-s-at').value ? new Date(b.querySelector('.al-s-at').value).toISOString() : undefined,
      number: b.querySelector('.al-s-no').value.trim() || undefined,
    });
    const pickups = [...document.querySelectorAll('#al-pickups .al-stop-block')].map(readBlock);
    const deliveries = [...document.querySelectorAll('#al-deliveries .al-stop-block')].map(readBlock);
    const p0 = pickups[0];
    const dN = deliveries[deliveries.length - 1];
    const body = {
      driverId: Number(document.getElementById('al-driver').value),
      reference: document.getElementById('al-ref').value.trim(),
      pickupLocation: p0.location,
      pickupWarehouse: p0.warehouse,
      pickupAt: p0.at,
      pickupTimezone: browserTimezone(),
      pickupNumber: p0.number,
      deliveryLocation: dN.location,
      deliveryWarehouse: dN.warehouse,
      deliveryAt: dN.at,
      deliveryTimezone: browserTimezone(),
      deliveryNumber: dN.number,
      notes: document.getElementById('al-notes').value.trim() || undefined,
      stops: { pickups, deliveries },
    };
    try {
      if (state.editingLoadId) {
        await api('/api/admin/loads/' + state.editingLoadId + '/edit', { method: 'POST', body: JSON.stringify(body) });
        toast('Load updated.', 'ok');
      } else {
        await api('/api/admin/loads', { method: 'POST', body: JSON.stringify(body) });
        toast('Load assigned.', 'ok');
      }
      state.editingLoadId = null;
      renderAdminView('loads');
    } catch (err) { showError(err); }
  });

  main.querySelectorAll('[data-edit-load]').forEach((b) => b.addEventListener('click', () => {
    const l = list.find((x) => String(x.id) === b.dataset.editLoad);
    if (!l) return;
    state.editingLoadId = l.id;
    document.getElementById('al-driver').value = String(l.driverId);
    document.getElementById('al-ref').value = l.reference || '';
    document.getElementById('al-pickup').value = l.pickupLocation || '';
    document.getElementById('al-pickup-wh').value = l.pickupWarehouse || '';
    document.getElementById('al-pickup-at').value = toLocalInput(l.pickupAt);
    document.getElementById('al-pickup-no').value = l.pickupNumber || '';
    document.getElementById('al-delivery').value = l.deliveryLocation || '';
    document.getElementById('al-delivery-wh').value = l.deliveryWarehouse || '';
    document.getElementById('al-delivery-at').value = toLocalInput(l.deliveryAt);
    document.getElementById('al-delivery-no').value = l.deliveryNumber || '';
    document.getElementById('al-notes').value = l.notes || '';
    // Multi-stop loads: rebuild the extra stop blocks. Extra pickups
    // append after Pickup 1; extra deliveries go BEFORE the final
    // delivery block (which holds the load's delivery fields), so the
    // on-screen order stays the travel order.
    if (l.stops) {
      (l.stops.pickups || []).slice(1).forEach((s) => addStopBlock('pickup', s));
      [...(l.stops.deliveries || []).slice(0, -1)].reverse().forEach((s) => addStopBlock('delivery', s, true));
    }
    form.closest('.card').querySelector('h2').textContent = 'Edit load ' + (l.reference || '');
    form.querySelector('button[type="submit"]').textContent = 'Save changes';
    let cancelBtn = document.getElementById('cancelEditBtn');
    if (!cancelBtn) {
      cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn-ghost';
      cancelBtn.id = 'cancelEditBtn';
      cancelBtn.textContent = 'Close';
      cancelBtn.style.marginLeft = '8px';
      form.querySelector('button[type="submit"]').after(cancelBtn);
      cancelBtn.addEventListener('click', () => { state.editingLoadId = null; renderAdminView('loads'); });
    }
    setAssignOpen(true);
    assignCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  main.querySelectorAll('[data-delete-load]').forEach((b) => b.addEventListener('click', async () => {
    const l = list.find((x) => String(x.id) === b.dataset.deleteLoad);
    if (!confirm('Delete load ' + (l ? l.reference : '') + '? This removes the load completely. This can\'t be undone.')) return;
    try {
      await api('/api/admin/loads/' + b.dataset.deleteLoad, { method: 'DELETE' });
      toast('Load deleted.', 'ok');
      renderAdminView('loads');
    } catch (err) { showError(err); }
  }));

  main.querySelectorAll('[data-complete-load]').forEach((b) => b.addEventListener('click', async () => {
    // Two-step in-page confirm (native window.confirm is auto-dismissed
    // by some browsers, which silently cancelled the action).
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1';
      b.textContent = 'Confirm complete?';
      setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = 'Complete'; } }, 5000);
      return;
    }
    try {
      await api('/api/admin/loads/' + b.dataset.completeLoad + '/status', { method: 'POST', body: JSON.stringify({ status: 'completed' }) });
      toast('Load marked completed.', 'ok');
      renderAdminView('loads');
    } catch (err) { showError(err); }
  }));
  main.querySelectorAll('[data-reopen-load]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Reopen this load? It becomes active again for the driver.')) return;
    try {
      await api('/api/admin/loads/' + b.dataset.reopenLoad + '/status', { method: 'POST', body: JSON.stringify({ status: 'active' }) });
      toast('Load reopened.', 'ok');
      renderAdminView('loads');
    } catch (err) { showError(err); }
  }));
  main.querySelectorAll('[data-reactivate-load]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('/api/admin/loads/' + b.dataset.reactivateLoad + '/status', { method: 'POST', body: JSON.stringify({ status: 'active' }) });
      toast('Load reactivated.', 'ok');
      renderAdminView('loads');
    } catch (err) { showError(err); }
  }));
}

/* ---------- Documents (fleet-wide) ---------- */
/* ---------- Documents ---------- */
/* Full-page paperwork background + liquid glass, same fixed-layer
   pattern as Rate Cons (see ensureRcBgLayer). */
function ensureDocsBgLayer() {
  if (!document.getElementById('docsBgLayer')) {
    const layer = document.createElement('div');
    layer.id = 'docsBgLayer';
    document.body.prepend(layer);
  }
}
function removeDocsBgLayer() {
  const layer = document.getElementById('docsBgLayer');
  if (layer) layer.remove();
}

// Click-anywhere-to-compact: registered by viewDocuments, replaced on
// every visit. It self-guards on #docsPage existing, so it stays inert
// on other views. Clicks on the type buttons, inside an open panel, in
// the send bar or in the send window do not compact.
let docsCompactHandler = null;
function setDocsCompactHandler(fn) {
  if (docsCompactHandler) document.removeEventListener('click', docsCompactHandler);
  docsCompactHandler = fn;
  if (fn) document.addEventListener('click', fn);
}

async function viewDocuments(main) {
  document.body.classList.add('docs-bg');
  ensureDocsBgLayer();
  const [docs, loads, outlook] = await Promise.all([
    api('/api/admin/documents'),
    api('/api/admin/loads').catch(() => []),
    api('/api/admin/outlook/status').catch(() => ({ configured: false, connected: false, email: null })),
  ]);
  const KINDS = {
    pickup: { kinds: ['pickup_bol'], label: 'Pickup BOLs', empty: 'No pickup BOLs yet' },
    unit: { kinds: ['unit_picture'], label: 'Unit Pictures', empty: 'No unit pictures yet' },
    seal: { kinds: ['seal_picture'], label: 'Seal Pictures', empty: 'No seal pictures yet' },
    load: { kinds: ['load_picture'], label: 'Load Pictures', empty: 'No load pictures yet' },
    fuel: { kinds: ['fuel_receipt', 'receipt'], label: 'Fuel Receipts', empty: 'No fuel receipts yet' },
    delivery: { kinds: ['delivery_bol'], label: 'Delivery BOL', empty: 'No delivery BOL yet' },
  };
  const TYPE_ORDER = ['pickup', 'unit', 'seal', 'load', 'fuel', 'delivery'];
  const docList = (Array.isArray(docs) ? docs : []).filter(d => d.loadId != null && TYPE_ORDER.some(t => KINDS[t].kinds.includes(d.kind)));
  const loadList = (Array.isArray(loads) ? loads : []).filter(l => l && l.reference);
  const byLoad = new Map();
  for (const d of docList) {
    if (!byLoad.has(d.loadId)) byLoad.set(d.loadId, []);
    byLoad.get(d.loadId).push(d);
  }
  // EVERY load gets a document section here — active and completed,
  // with or without papers yet (owner, 2026-11-17: "every load we
  // have, mine and Arsh's, all of them"). Ordered latest trip first:
  // newest pickup on top, oldest at the bottom.
  const tripTime = (l) => {
    for (const v of [l.pickupAt, l.deliveryAt, l.createdAt]) {
      const t = Date.parse(v || '');
      if (!Number.isNaN(t)) return t;
    }
    return 0;
  };
  const shown = loadList.slice().sort((a, b) => tripTime(b) - tripTime(a));
  const docById = new Map(docList.map(d => [d.id, d]));
  const selected = new Set();
  const shortPlace = (a) => (a || '').split(',').pop().replace(/\s*\d{5}(-\d{4})?\s*$/, '').trim();
  const typeDocs = (loadId, t) => (byLoad.get(loadId) || []).filter(d => KINDS[t].kinds.includes(d.kind));
  // Nothing opens by itself — every panel stays closed until its
  // type button is tapped (owner's rule, 2026-11-15).
  const openKey = null;

  const docRow = (d) => {
    const meta = [d.driverName || null, d.amountCents != null ? fmtMoney(d.amountCents) : null, fmtDate(d.createdAt)].filter(Boolean).join(' • ');
    return '<div class="doc-row"><input type="checkbox" data-doc-check="' + d.id + '">' +
      '<div class="doc-row-main"><div class="doc-row-title">' + esc(d.label || d.filename || '—') + '</div>' +
      '<div class="muted small">' + esc(meta) + '</div></div>' +
      '<button class="btn btn-ghost btn-sm" data-doc-view="' + d.id + '">View</button></div>';
  };
  const panelHtml = (load, t) => {
    const items = typeDocs(load.id, t);
    const key = load.id + ':' + t;
    return '<div class="doc-panel" data-doc-panel="' + key + '"' + (key === openKey ? '' : ' hidden') + '>' +
      (items.length
        ? '<label class="doc-selectall"><input type="checkbox" data-doc-all="' + key + '"> Select all</label>' + items.map(docRow).join('')
        : '<p class="empty">' + KINDS[t].empty + '</p>') +
      '<div class="doc-upload"><label class="btn btn-ghost btn-sm">+ Upload file<input type="file" hidden data-doc-upload="' + load.id + ':' + KINDS[t].kinds[0] + '"></label></div></div>';
  };
  const sectionHtml = (load) => {
    const badge = load.bolStatus
      ? '<span class="pill ' + (String(load.bolStatus).toLowerCase() === 'clean' ? 'green' : 'red') + '">BOL: ' + esc(String(load.bolStatus).toUpperCase()) + '</span>'
      : '';
    const statusPill = load.status === 'active'
      ? '<span class="doc-status"><span class="dot"></span>Active load</span>'
      : load.status === 'completed'
        ? '<span class="doc-status done"><span class="dot"></span>Completed</span>'
        : (load.status ? '<span class="doc-status done"><span class="dot"></span>' + esc(String(load.status)) + '</span>' : '');
    const equip = [load.truckUnit ? 'Truck ' + load.truckUnit : null, load.trailerUnit ? 'Trailer ' + load.trailerUnit : null].filter(Boolean).join(' / ');
    return '<div class="card doc-load" data-ref="' + esc(load.reference) + '"><div class="doc-load-head"><div>' +
      '<div class="doc-load-ref">' + esc(load.reference) + '</div>' +
      '<div class="muted">' + esc(shortPlace(load.pickupLocation)) + ' → ' + esc(shortPlace(load.deliveryLocation)) +
      (load.driverName ? ' · ' + esc(load.driverName) : '') + (equip ? ' · ' + esc(equip) : '') + '</div>' +
      '<div class="muted small">Pickup ' + fmtDate(load.pickupAt) + ' → Delivery ' + fmtDate(load.deliveryAt) + '</div>' +
      '</div><div class="doc-load-side">' + statusPill + badge + '</div></div>' +
      '<div class="doc-btns">' + TYPE_ORDER.map(t =>
        '<button class="doc-btn' + (load.id + ':' + t === openKey ? ' active' : '') + '" data-doc-btn="' + load.id + ':' + t + '">' +
        KINDS[t].label + ' (' + typeDocs(load.id, t).length + ')</button>').join('') + '</div>' +
      TYPE_ORDER.map(t => panelHtml(load, t)).join('') + '</div>';
  };

  main.innerHTML = '<div class="docs-page" id="docsPage">' +
    '<div class="rc-head"><h1>Documents</h1>' +
    '<input id="docsSearch" class="docs-search" type="search" placeholder="Search load # — e.g. 2038499" autocomplete="off"></div>' +

    '<p class="docs-quote">“Every mile counts. Every paper proves it.”</p>' +
    (shown.length ? shown.map(sectionHtml).join('') : '<div class="card"><p class="empty">No documents yet.</p></div>') +
    '<p class="docs-nomatch" id="docsNoMatch" hidden>No load matches that number.</p>' +
    '<div class="docs-sendbar" id="docsSendBar" hidden><span id="docsSendCount"></span>' +
    '<button class="btn" id="docsSendOpen">Send to broker</button>' +
    '<button class="btn btn-ghost" id="docsSendClear">Clear</button></div></div>';

  const docsSearch = document.getElementById('docsSearch');
  if (docsSearch) docsSearch.addEventListener('input', () => {
    const q = docsSearch.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    let visible = 0;
    main.querySelectorAll('.doc-load').forEach((card) => {
      const ref = (card.dataset.ref || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const show = !q || ref.indexOf(q) !== -1;
      card.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    const none = document.getElementById('docsNoMatch');
    if (none) none.hidden = !(q && visible === 0);
  });

  const updateSendBar = () => {
    const bar = document.getElementById('docsSendBar');
    if (!bar) return;
    bar.hidden = selected.size === 0;
    const count = document.getElementById('docsSendCount');
    if (count) count.textContent = selected.size + ' file' + (selected.size === 1 ? '' : 's') + ' selected';
  };

  main.querySelectorAll('[data-doc-btn]').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.docBtn;
    const loadId = key.split(':')[0];
    const panel = main.querySelector('[data-doc-panel="' + key + '"]');
    const willOpen = panel.hidden;
    main.querySelectorAll('[data-doc-panel]').forEach(p => { if (p.dataset.docPanel.split(':')[0] === loadId) p.hidden = true; });
    main.querySelectorAll('[data-doc-btn]').forEach(x => { if (x.dataset.docBtn.split(':')[0] === loadId) x.classList.remove('active'); });
    if (willOpen) { panel.hidden = false; b.classList.add('active'); }
  }));
  main.querySelectorAll('[data-doc-upload]').forEach(inp => inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const parts = String(inp.dataset.docUpload).split(':');
    const fd = new FormData();
    fd.append('file', f);
    fd.append('kind', parts[1]);
    fd.append('loadId', parts[0]);
    try {
      await api('/api/admin/documents', { method: 'POST', body: fd });
      toast('File uploaded.', 'ok');
      renderAdminView('documents');
    } catch (err) { showError(err); }
  }));
  main.querySelectorAll('[data-doc-check]').forEach(c => c.addEventListener('change', () => {
    const id = Number(c.dataset.docCheck);
    if (c.checked) selected.add(id); else selected.delete(id);
    updateSendBar();
  }));
  main.querySelectorAll('[data-doc-all]').forEach(c => c.addEventListener('change', () => {
    const panel = c.closest('.doc-panel');
    panel.querySelectorAll('[data-doc-check]').forEach(x => {
      x.checked = c.checked;
      const id = Number(x.dataset.docCheck);
      if (c.checked) selected.add(id); else selected.delete(id);
    });
    updateSendBar();
  }));
  main.querySelectorAll('[data-doc-view]').forEach(b => b.addEventListener('click', () => {
    const d = docById.get(Number(b.dataset.docView));
    if (d) downloadFile(d.url, d.filename, true, d.mimeType);
  }));

  setDocsCompactHandler((e) => {
    const page = document.getElementById('docsPage');
    if (!page) return;
    if (document.getElementById('docsModal')) return;
    if (e.target.closest('[data-doc-btn]') || e.target.closest('.doc-panel') || e.target.closest('#docsSendBar') || e.target.closest('#docsSearch')) return;
    page.querySelectorAll('[data-doc-panel]').forEach(p => { p.hidden = true; });
    page.querySelectorAll('[data-doc-btn]').forEach(x => x.classList.remove('active'));
  });

  /* ----- Send to broker ----- */
  const closeSendModal = () => { const m = document.getElementById('docsModal'); if (m) m.remove(); };
  const connectOutlook = async () => {
    try {
      const res = await api('/api/admin/outlook/auth-url');
      window.open(res.url, '_blank');
      toast('Sign in to Microsoft in the new tab, then come back here.', 'ok');
    } catch (err) { showError(err); }
  };
  const loadConversations = async () => {
    const body = document.getElementById('docsModalBody');
    if (!body) return;
    if (!outlook.configured) { body.innerHTML = '<p class="muted">Outlook email is not set up on the server yet.</p>'; return; }
    if (!outlook.connected) {
      body.innerHTML = '<p class="muted">Connect your Outlook mailbox — then pick the broker conversation and send the files in that thread.</p>' +
        '<div class="form-actions"><button class="btn btn-sm" id="docsOutlookConnect">Connect Outlook</button></div>';
      document.getElementById('docsOutlookConnect').addEventListener('click', connectOutlook);
      return;
    }
    body.innerHTML = '<p class="muted">Loading your inbox…</p>';
    try {
      const convs = await api('/api/admin/outlook/conversations');
      const list = Array.isArray(convs) ? convs : [];
      body.innerHTML = '<p class="small muted">Connected as <strong>' + esc(outlook.email || '') + '</strong> — tap the conversation to send to.</p>' +
        (list.length
          ? '<input id="docsConvSearch" class="docs-search" type="search" placeholder="Search broker — name, email or subject" autocomplete="off" style="width:100%;margin-bottom:10px">' +
            list.map(c => '<button class="conv-row" data-conv="' + esc(c.conversationId) + '"><span class="conv-main">' +
            '<span class="conv-name">' + esc(c.fromName || c.fromEmail || '') + '</span>' +
            '<span class="conv-subject">' + esc(c.subject || '') + '</span>' +
            '<span class="conv-snippet muted small">' + esc(c.snippet || '') + '</span></span>' +
            '<span class="conv-date muted small">' + fmtDate(c.lastAt) + '</span></button>').join('') +
            '<p class="empty" id="docsConvNone" hidden>No conversation matches that search.</p>'
          : '<p class="empty">No conversations in your inbox yet.</p>');
      body.querySelectorAll('[data-conv]').forEach(b => b.addEventListener('click', () => loadThread(b.dataset.conv)));
      const convSearch = document.getElementById('docsConvSearch');
      if (convSearch) convSearch.addEventListener('input', () => {
        const q = convSearch.value.trim().toLowerCase();
        let visible = 0;
        body.querySelectorAll('[data-conv]').forEach((row) => {
          const show = !q || row.textContent.toLowerCase().includes(q);
          row.style.display = show ? '' : 'none';
          if (show) visible++;
        });
        const none = document.getElementById('docsConvNone');
        if (none) none.hidden = !(q && visible === 0);
      });
    } catch (err) {
      body.innerHTML = '<p class="muted">' + esc(err.message || 'Could not load conversations.') + '</p>';
    }
  };
  const loadThread = async (conversationId) => {
    const body = document.getElementById('docsModalBody');
    if (!body) return;
    body.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const t = await api('/api/admin/outlook/thread?conversationId=' + encodeURIComponent(conversationId));
      const files = [...selected].map(id => docById.get(id)).filter(Boolean);
      body.innerHTML = '<button class="btn btn-ghost btn-sm" id="docsThreadBack">← All conversations</button>' +
        '<p class="small" style="margin-top:10px">To: <strong>' + esc(t.toName || '') + '</strong> &lt;' + esc(t.toEmail || '') + '&gt;<br>' +
        '<span class="muted">' + esc(t.subject || '') + '</span></p>' +
        '<div class="thread-list">' + (t.messages || []).map(m =>
          '<div class="thread-msg' + (m.mine ? ' mine' : '') + '"><div><strong>' + esc(m.fromName || '') + '</strong> ' +
          '<span class="muted small">' + fmtDate(m.at) + '</span></div>' +
          '<div class="thread-text">' + esc(m.text || '') + '</div></div>').join('') + '</div>' +
        '<div class="field"><label>Message</label><textarea id="docsSendText" rows="3" placeholder="Add a note for the broker…"></textarea></div>' +
        '<p class="small"><strong>Files attached (' + files.length + '):</strong><br>' + files.map(f => esc(f.filename || f.label || '')).join('<br>') + '</p>' +
        '<div class="form-actions"><button class="btn" id="docsSendNow">Send</button></div>' +
        '<p id="docsSendResult" class="small mt"></p>';
      document.getElementById('docsThreadBack').addEventListener('click', loadConversations);
      document.getElementById('docsSendNow').addEventListener('click', async () => {
        const btn = document.getElementById('docsSendNow');
        btn.disabled = true;
        btn.textContent = 'Sending…';
        try {
          await api('/api/admin/outlook/send-documents', {
            method: 'POST',
            body: JSON.stringify({ conversationId, body: document.getElementById('docsSendText').value, documentIds: [...selected] }),
          });
          toast('Sent to ' + (t.toName || 'the broker') + ' with ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '.', 'ok');
          selected.clear();
          main.querySelectorAll('[data-doc-check]').forEach(x => { x.checked = false; });
          updateSendBar();
          closeSendModal();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Send';
          const res = document.getElementById('docsSendResult');
          if (res) res.innerHTML = '<span style="color:#f87171">' + esc(err.message || 'Send failed.') + '</span>' +
            (/reconnect/i.test(err.message || '') ? ' <button class="btn btn-sm" id="docsReconnect">Reconnect Outlook</button>' : '');
          const rc = document.getElementById('docsReconnect');
          if (rc) rc.addEventListener('click', connectOutlook);
        }
      });
    } catch (err) {
      body.innerHTML = '<p class="muted">' + esc(err.message || 'Could not load the conversation.') + '</p>';
    }
  };
  const openSendModal = () => {
    closeSendModal();
    const modal = document.createElement('div');
    modal.id = 'docsModal';
    modal.className = 'docs-modal-backdrop';
    modal.innerHTML = '<div class="docs-modal"><div class="docs-modal-head"><strong>Send to broker</strong>' +
      '<button class="btn btn-ghost btn-sm" id="docsModalClose">✕</button></div><div id="docsModalBody"><p class="muted">Loading…</p></div></div>';
    document.body.appendChild(modal);
    document.getElementById('docsModalClose').addEventListener('click', closeSendModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeSendModal(); });
    loadConversations();
  };
  document.getElementById('docsSendOpen').addEventListener('click', openSendModal);
  document.getElementById('docsSendClear').addEventListener('click', () => {
    selected.clear();
    main.querySelectorAll('[data-doc-check]').forEach(x => { x.checked = false; });
    updateSendBar();
  });
}

/* ---------- Requests ---------- */
async function viewRequests(main) {
  document.body.classList.add('requests-bg'); // dispatch request-board photo + liquid glass (removed on view switch)
  ensureRequestsBgLayer();
  const reqs = await api('/api/admin/requests');
  const list = Array.isArray(reqs) ? reqs : [];
  const pending = list.filter(r => r.status === 'pending').length;
  renderAdminSidebar(pending);
  const typeLabel = (t) => String(t || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const card = (r) => {
    const color = driverColor(r.driverId);
    const initial = esc((String(r.driverName || '?').trim().charAt(0) || '?').toUpperCase());
    const pill = r.status === 'pending' ? '<span class="pill gold">Pending</span>'
      : r.status === 'approved' ? '<span class="pill green">Approved</span>' : '<span class="pill red">Denied</span>';
    let foot = '';
    if (r.status === 'pending') {
      foot = '<div class="dc-actions rq-actions">' +
        '<input class="rq-note" data-note="' + r.id + '" placeholder="Note — reason required if denying">' +
        '<button class="btn btn-sm" data-approve="' + r.id + '">Approve</button> ' +
        '<button class="btn btn-danger btn-sm" data-deny="' + r.id + '">Deny</button></div>';
    } else {
      foot = '<div class="rq-decided">' +
        (r.adminNote
          ? (r.status === 'denied'
            ? '<p class="rq-denied-reason">Decline reason: ' + esc(r.adminNote) + '</p>'
            : '<p class="small muted">Admin note: ' + esc(r.adminNote) + '</p>')
          : '') +
        '<p class="small muted">Decided ' + (r.decidedAt ? fmtDate(r.decidedAt) : '') + '</p></div>';
    }
    return '<div class="driver-card">' +
      '<div class="dc-stripe" style="background:' + color + '"></div>' +
      '<div class="dc-body">' +
      '<div class="dc-head"><span class="dc-avatar" style="background:' + color + '">' + initial + '</span>' +
      '<div><div class="dc-name">' + esc(r.driverName || '—') + '</div><div class="dc-sub">' + esc(typeLabel(r.type)) + '</div></div>' +
      pill + '</div>' +
      '<div class="rq-reason">' + esc(r.reason || '') + '</div>' +
      (r.details ? '<div class="rq-details">' + esc(r.details) + '</div>' : '') +
      '<div class="rq-amount">' + fmtMoney(r.amountCents) + '</div>' +
      foot +
      '</div></div>';
  };
  main.innerHTML = '<div class="rc-head"><h1>Requests</h1><span class="muted">' + pending + ' pending</span></div>' +
    (list.length ? '<div class="driver-grid">' + list.map(card).join('') + '</div>' : '<p class="empty">No requests yet.</p>');
  const decide = async (id, decision) => {
    const noteEl = main.querySelector('[data-note="' + id + '"]');
    try {
      await api('/api/admin/requests/' + id + '/decide', { method: 'POST', body: JSON.stringify({ decision, note: noteEl ? noteEl.value.trim() || undefined : undefined }) });
      toast('Request ' + decision + '.', 'ok');
      renderAdminView('requests');
    } catch (err) { showError(err); }
  };
  main.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', () => decide(b.dataset.approve, 'approved')));
  main.querySelectorAll('[data-deny]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.deny;
    const noteEl = main.querySelector('[data-note="' + id + '"]');
    const reason = noteEl ? noteEl.value.trim() : '';
    if (!reason) {
      toast('Write the reason for declining in the note box first.', 'error');
      if (noteEl) noteEl.focus();
      return;
    }
    if (!confirm('Deny this request?\n\nReason: ' + reason)) return;
    decide(id, 'denied');
  }));
}

/* ---------- Maintenance (admin) ---------- */
async function viewMaintenance(main) {
  document.body.classList.add('maintenance-bg'); // truck shop photo + liquid glass (removed on view switch)
  ensureMaintenanceBgLayer();
  const data = await api('/api/admin/maintenance');
  const trucks = (data && data.trucks) || [];
  const log = (data && data.log) || [];
  const fmtMi = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
  const statusPill = (s) => s === 'overdue' ? '<span class="pill red">Overdue</span>'
    : s === 'soon' ? '<span class="pill gold">Due soon</span>'
    : s === 'unset' ? '<span class="pill">Not set</span>' : '<span class="pill green">OK</span>';
  const barColor = (s) => s === 'overdue' ? '#DC2626' : s === 'soon' ? '#F2B705' : '#16A34A';
  const itemRow = (t, it) => {
    const left = it.status === 'unset' ? 'Set when it was last done to start tracking'
      : it.status === 'overdue' ? Math.abs(it.remainingMi).toLocaleString('en-US') + ' mi OVERDUE'
      : it.remainingMi.toLocaleString('en-US') + ' mi left';
    return '<div class="maint-item">' +
      '<div class="maint-item-top"><strong>' + esc(it.name) + '</strong>' + statusPill(it.status) +
      '<span class="maint-left">' + left + '</span></div>' +
      '<div class="maint-bar"><div class="maint-fill" style="width:' + (it.pct || 0) + '%;background:' + barColor(it.status) + '"></div></div>' +
      '<div class="maint-meta">Every ' + fmtMi(it.intervalMi) + ' mi' +
      (it.lastDoneMi !== null && it.lastDoneMi !== undefined ? ' · Last done at ' + fmtMi(it.lastDoneMi) + ' mi' + (it.lastDoneAt ? ' · ' + esc(String(it.lastDoneAt).slice(0, 10)) : '') : ' · Last done not recorded') +
      (it.drivenMi !== null && it.drivenMi !== undefined ? ' · Driven since: ' + fmtMi(it.drivenMi) + ' mi' : '') + '</div>' +
      '<div class="maint-actions">' +
      '<button class="btn btn-sm" data-done="' + it.id + '">Mark done</button> ' +
      '<button class="btn-ghost btn-sm" data-setlast="' + it.id + '">Set last done</button> ' +
      '<button class="btn-ghost btn-sm" data-remind="' + it.id + '" data-name="' + esc(it.name) + '">Remind driver</button> ' +
      '<button class="btn-ghost btn-sm" data-delitem="' + it.id + '" data-name="' + esc(it.name) + '">Delete</button></div>' +
      '<form class="maint-done-form hidden" data-doneform="' + it.id + '">' +
      '<div class="form-grid">' +
      '<label>Cost $ <input name="cost" type="number" min="0" step="0.01" placeholder="0.00"></label>' +
      '<label>Shop <input name="shop" placeholder="Shop name"></label>' +
      '<label>Note <input name="note" placeholder="Optional"></label>' +
      '<label>Invoice <input name="file" type="file" accept="image/*,.pdf"></label>' +
      '</div>' +
      '<div class="form-actions"><button class="btn btn-sm" type="submit">Save — service done</button> ' +
      '<button class="btn-ghost btn-sm" type="button" data-donecancel="' + it.id + '">Cancel</button></div>' +
      '<p class="small muted">Saving restarts the counter from the truck\'s current miles (' + fmtMi(t.odometerMi) + ') and adds the cost to Cash Flow.</p></form>' +
      '<form class="maint-done-form hidden" data-lastform="' + it.id + '">' +
      '<div class="form-grid">' +
      '<label>Last done at (miles) <input name="lastDoneMi" type="number" min="0" step="any" required placeholder="e.g. 543400"></label>' +
      '<label>Date (optional) <input name="lastDoneDate" type="date"></label>' +
      '</div>' +
      '<div class="form-actions"><button class="btn btn-sm" type="submit">Save</button> ' +
      '<button class="btn-ghost btn-sm" type="button" data-lastcancel="' + it.id + '">Cancel</button></div></form>' +
      '</div>';
  };
  const truckPanel = (t) => '<section class="maint-panel">' +
    '<div class="maint-panel-head"><div><span class="maint-unit">' + esc(t.unitNumber) + '</span> ' +
    '<span class="muted">' + esc(t.desc || '') + '</span></div>' +
    '<div class="maint-odo">' + fmtMi(t.odometerMi) + ' <span>mi · live from TRC</span></div></div>' +
    (t.items.length ? t.items.map((it) => itemRow(t, it)).join('') : '<p class="empty">No services tracked for this truck yet.</p>') +
    '<form class="maint-add-form" data-additem="' + t.id + '">' +
    '<input name="name" placeholder="New service — e.g. Drive Tires" required> ' +
    '<input name="intervalMi" type="number" min="1" placeholder="Every … miles" required> ' +
    '<button class="btn-ghost btn-sm" type="submit">+ Add service</button></form>' +
    '</section>';
  const logRows = log.map((l) => '<div class="cf-row"><div class="cf-row-main"><strong>' + esc(l.itemName) + '</strong> ' +
    '<span class="muted">· Truck ' + esc(l.truckUnit || '') + (l.shop ? ' · ' + esc(l.shop) : '') + (l.note ? ' · ' + esc(l.note) : '') + '</span></div>' +
    '<span class="muted">' + esc(String(l.doneAt || '').slice(0, 10)) + (l.doneMi ? ' · ' + fmtMi(l.doneMi) + ' mi' : '') + '</span>' +
    '<span class="cf-amt out">' + (l.costCents ? '−' + fmtMoney(l.costCents) : '—') + '</span>' +
    (l.url ? '<a class="btn-ghost btn-sm" href="' + l.url + '" target="_blank" rel="noopener">Invoice</a>' : '') + '</div>').join('');
  main.innerHTML = '<div class="rc-head"><h1>Maintenance</h1><span class="muted">Miles update by themselves from TRC — you only tap “Mark done”.</span></div>' +
    (trucks.length ? trucks.map(truckPanel).join('') : '<p class="empty">No trucks yet.</p>') +
    '<h2 class="cf-h2">Recent service history</h2>' + (logRows || '<p class="empty">Nothing serviced yet.</p>');
  main.querySelectorAll('[data-done]').forEach((b) => b.addEventListener('click', () => {
    const f = main.querySelector('[data-doneform="' + b.dataset.done + '"]');
    if (f) f.classList.toggle('hidden');
  }));
  main.querySelectorAll('[data-donecancel]').forEach((b) => b.addEventListener('click', () => {
    const f = main.querySelector('[data-doneform="' + b.dataset.donecancel + '"]');
    if (f) { f.reset(); f.classList.add('hidden'); }
  }));
  main.querySelectorAll('[data-doneform]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/maintenance/items/' + f.dataset.doneform + '/done', { method: 'POST', body: new FormData(f) });
      toast('Service marked done.', 'ok');
      renderAdminView('maintenance');
    } catch (err) { showError(err); }
  }));
  main.querySelectorAll('[data-setlast]').forEach((b) => b.addEventListener('click', () => {
    const f = main.querySelector('[data-lastform="' + b.dataset.setlast + '"]');
    if (f) { f.classList.toggle('hidden'); const inp = f.querySelector('[name="lastDoneMi"]'); if (inp) inp.focus(); }
  }));
  main.querySelectorAll('[data-lastcancel]').forEach((b) => b.addEventListener('click', () => {
    const f = main.querySelector('[data-lastform="' + b.dataset.lastcancel + '"]');
    if (f) { f.reset(); f.classList.add('hidden'); }
  }));
  main.querySelectorAll('[data-lastform]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const mi = Number(fd.get('lastDoneMi'));
    if (!Number.isFinite(mi) || mi < 0) { toast('Enter the miles as a number.', 'error'); return; }
    const body = { lastDoneMi: Math.round(mi) };
    const dt = fd.get('lastDoneDate');
    if (dt) body.lastDoneAt = dt;
    try {
      await api('/api/admin/maintenance/items/' + f.dataset.lastform, { method: 'PATCH', body: JSON.stringify(body) });
      toast('Last done saved.', 'ok');
      renderAdminView('maintenance');
    } catch (err) { showError(err); }
  }));
  main.querySelectorAll('[data-remind]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('/api/admin/maintenance/items/' + b.dataset.remind + '/remind', { method: 'POST', body: JSON.stringify({}) });
      toast('Reminder sent to the driver.', 'ok');
    } catch (err) { showError(err); }
  }));
  main.querySelectorAll('[data-delitem]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Stop tracking "' + b.dataset.name + '"? Its service history stays saved.')) return;
    try {
      await api('/api/admin/maintenance/items/' + b.dataset.delitem, { method: 'DELETE' });
      renderAdminView('maintenance');
    } catch (err) { showError(err); }
  }));
  main.querySelectorAll('[data-additem]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    try {
      await api('/api/admin/maintenance/items', {
        method: 'POST',
        body: JSON.stringify({ truckId: Number(f.dataset.additem), name: String(fd.get('name') || '').trim(), intervalMi: Number(fd.get('intervalMi')) }),
      });
      toast('Service added.', 'ok');
      renderAdminView('maintenance');
    } catch (err) { showError(err); }
  }));
}

/* ---------- Cash Flow (admin) ---------- */
let cfOutlookPick = null; // { messageId, attachmentId, subject } while an Outlook import is staged

let rcImportDoneMsg = ''; // last import result, kept visible across re-renders
let cfMonthKey = ''; // YYYY-MM shown in the monthly P&L; '' = current month

async function cfDownload(section) {
  try {
    const q = '/api/admin/cashflow/report.csv?section=' + section + (cfMonthKey ? '&month=' + cfMonthKey : '');
    const r = await fetch(q, { headers: { Authorization: 'Bearer ' + (localStorage.getItem('lxl_token') || '') } });
    if (!r.ok) throw new Error('download failed');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lxl-cashflow-' + section + (cfMonthKey ? '-' + cfMonthKey : '') + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) { toast('Could not download the report.', 'err'); }
}

function cfShiftMonth(delta) {
  const base = cfMonthKey || new Date().toISOString().slice(0, 7);
  const dt = new Date(base + '-15T12:00:00');
  dt.setMonth(dt.getMonth() + delta);
  cfMonthKey = dt.toISOString().slice(0, 7);
  renderAdminView('cashflow');
}

async function viewCashflow(main) {
  document.body.classList.add('cashflow-bg'); // office desk photo + liquid glass (removed on view switch)
  ensureCashflowBgLayer();
  const [data, trucks, outlook] = await Promise.all([
    api('/api/admin/cashflow' + (cfMonthKey ? '?month=' + cfMonthKey : '')),
    api('/api/admin/trucks').catch(() => []),
    api('/api/admin/outlook/status').catch(() => ({ configured: false, connected: false, email: null })),
  ]);
  const d = data || {};
  const entries = d.entries || [];
  const weekly = d.weekly || [];
  const mo = d.month || { key: '', inGroups: [], outGroups: [], inTotalCents: 0, outTotalCents: 0, profitCents: 0 };
  const fixed = d.fixed || [];
  const truckStats = d.trucks || [];
  const truckMonthStats = d.truckMonthly || [];
  const totals = d.totals || { inGroups: [], outGroups: [] };
  const loads = d.loads || [];
  const maxW = Math.max(1, ...weekly.map((w) => Math.max(w.inCents, w.outCents)));
  const weekCols = weekly.map((w) => '<div class="cf-week">' +
    '<div class="cf-bars"><div class="cf-bar in" style="height:' + Math.round((w.inCents / maxW) * 100) + '%" title="In ' + fmtMoney(w.inCents) + '"></div>' +
    '<div class="cf-bar out" style="height:' + Math.round((w.outCents / maxW) * 100) + '%" title="Out ' + fmtMoney(w.outCents) + '"></div></div>' +
    '<span>' + esc(String(w.weekStart).slice(5)) + '</span></div>').join('');
  const truckOpts = '<option value="">All trucks / company</option>' + (trucks || []).map((t) => '<option value="' + t.id + '">Truck ' + esc(t.unitNumber) + '</option>').join('');
  const loadOpts = '<option value="">No specific trip</option>' + loads.map((l) => '<option value="' + l.id + '">' + esc(l.reference) + (l.driverName ? ' · ' + esc(l.driverName) : '') + '</option>').join('');
  const groupRows = (groups, sign) => groups.length ? groups.map((g) => '<div class="cf-group"><span>' + esc(g.category) + (g.fixed ? ' <span class="cf-src">Fixed</span>' : '') + '</span><strong>' + sign + fmtMoney(g.amountCents) + '</strong></div>').join('') : '<p class="small muted">Nothing this month yet.</p>';
  const monthName = mo.key ? new Date(mo.key + '-15T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '';
  const fixedRows = fixed.map((f) => '<div class="cf-row"><div class="cf-row-main"><strong>' + esc(f.category) + '</strong> ' +
    '<span class="muted">' + (f.note ? '· ' + esc(f.note) : '') + '</span></div><span class="cf-src">Fixed · monthly</span>' +
    '<span class="cf-amt out">−' + fmtMoney(f.amountCents) + '</span>' +
    '<button class="btn-ghost btn-sm" data-delfixed="' + f.id + '">Delete</button></div>').join('');
  const truckPanels = truckStats.map((t) => '<section class="maint-panel">' +
    '<div class="maint-panel-head"><div><span class="maint-unit">' + esc(t.unitNumber) + '</span></div>' +
    '<div class="maint-odo">' + fmtMoney(t.profitCents) + ' <span>profit</span></div></div>' +
    '<div class="cf-truck-stats">' +
    '<span>Made <strong>' + fmtMoney(t.revenueCents) + '</strong></span>' +
    '<span>Fuel · receipts <strong>−' + fmtMoney(t.fuelCents) + '</strong></span>' +
    '<span>Driver pay · mi × 65¢ <strong>−' + fmtMoney(t.driverPayCents) + '</strong></span>' +
    '<span>Maintenance <strong>−' + fmtMoney(t.maintCents) + '</strong></span>' +
    '<span>Other <strong>−' + fmtMoney(t.otherCents) + '</strong></span></div>' +
    (t.trips.length ? t.trips.map((trip) => '<div class="cf-row"><div class="cf-row-main"><strong>' + esc(trip.reference) + '</strong></div>' +
      '<span class="muted">Rate ' + fmtMoney(trip.rateCents) + (trip.miles ? ' · ' + trip.miles + ' mi' : '') + '</span>' +
      '<span class="muted">' + (trip.fuelCents != null ? 'Fuel −' + fmtMoney(trip.fuelCents) + ' · Pay −' + fmtMoney(trip.driverPayCents) + (trip.otherCents ? ' · Other −' + fmtMoney(trip.otherCents) : '') : 'Trip expenses −' + fmtMoney(trip.expensesCents)) + '</span>' +
      '<span class="cf-amt ' + (trip.profitCents >= 0 ? 'in' : 'out') + '">' + (trip.profitCents >= 0 ? '+' : '−') + fmtMoney(Math.abs(trip.profitCents)) + '</span></div>').join('')
      : '<p class="empty">No trips with a rate con yet for this truck.</p>') +
    '</section>').join('');
  const truckMonthPanels = truckMonthStats.map((t) => '<section class="maint-panel">' +
    '<div class="maint-panel-head"><div><span class="maint-unit">' + esc(t.unitNumber) + '</span></div>' +
    '<div class="maint-odo">' + fmtMoney(t.profitCents) + ' <span>profit — ' + esc(monthName) + '</span></div></div>' +
    '<div class="cf-truck-stats">' +
    '<span>Made <strong>' + fmtMoney(t.revenueCents) + '</strong></span>' +
    '<span>Fuel · receipts <strong>−' + fmtMoney(t.fuelCents) + '</strong></span>' +
    '<span>Driver pay · mi × 65¢ <strong>−' + fmtMoney(t.driverPayCents) + '</strong></span>' +
    '<span>Maintenance <strong>−' + fmtMoney(t.maintCents) + '</strong></span>' +
    '<span>Other <strong>−' + fmtMoney(t.otherCents) + '</strong></span></div>' +
    (t.trips.length ? t.trips.map((trip) => '<div class="cf-row"><div class="cf-row-main"><strong>' + esc(trip.reference) + '</strong></div>' +
      '<span class="muted">Rate ' + fmtMoney(trip.rateCents) + (trip.miles ? ' · ' + trip.miles + ' mi' : '') + '</span>' +
      '<span class="muted">' + (trip.fuelCents != null ? 'Fuel −' + fmtMoney(trip.fuelCents) + ' · Pay −' + fmtMoney(trip.driverPayCents) + (trip.otherCents ? ' · Other −' + fmtMoney(trip.otherCents) : '') : 'Trip expenses −' + fmtMoney(trip.expensesCents)) + '</span>' +
      '<span class="cf-amt ' + (trip.profitCents >= 0 ? 'in' : 'out') + '">' + (trip.profitCents >= 0 ? '+' : '−') + fmtMoney(Math.abs(trip.profitCents)) + '</span></div>').join('')
      : '<p class="empty">No trips booked this month for this truck.</p>') +
    '</section>').join('');
  const bankPending = d.bankPending || [];
  const bankSuggest = (name, dir) => {
    const s = String(name || '').toLowerCase();
    if (dir === 'in') return /otr|factor|bolt/.test(s) ? 'Factoring payment' : 'Other';
    if (s.includes('pilot')) return 'Fuel (Pilot weekly)';
    if (/prepass|e-zpass|ezpass|toll/.test(s)) return 'Tolls';
    if (/zelle/.test(s)) return 'Driver pay';
    if (/intuit|ringcentral|google|apple/.test(s)) return 'Office expenses';
    if (/insurance|geico|progressive/.test(s)) return 'Insurance';
    if (/leasing|lease|payment.*truck|truck.*payment/.test(s)) return 'Truck payment';
    return 'Other';
  };
  const bankCats = (dir, name) => {
    const opts = dir === 'in'
      ? ['Factoring payment', 'Broker payment', 'Other']
      : ['Fuel (Pilot weekly)', 'Tolls', 'Parking', 'Maintenance', 'Repairs', 'Driver pay', 'Dispatch pay', 'Truck payment', 'Trailer rental', 'Insurance', 'Office expenses', 'Other'];
    const sel = bankSuggest(name, dir);
    return opts.map((o) => '<option' + (o === sel ? ' selected' : '') + '>' + o + '</option>').join('');
  };
  const bankRow = (t) => '<div class="cf-row"><div class="cf-row-main"><strong>' + esc(t.name) + '</strong></div>' +
    '<span class="muted">' + esc(t.date) + '</span>' +
    '<span class="cf-amt ' + (t.direction === 'in' ? 'in' : 'out') + '">' + (t.direction === 'in' ? '+' : '−') + fmtMoney(t.amountCents) + '</span>' +
    '<select id="bankcat-' + t.id + '">' + bankCats(t.direction, t.name) + '</select>' +
    '<button class="btn btn-sm" data-bankcat="' + t.id + '">Categorize</button> ' +
    '<button class="btn-ghost btn-sm" data-bankignore="' + t.id + '">Ignore</button></div>';
  const entryRow = (e) => '<div class="cf-row"><div class="cf-row-main"><strong>' + esc(e.category) + '</strong> ' +
    '<span class="muted">' + (e.truckUnit ? '· Truck ' + esc(e.truckUnit) + ' ' : '') + (e.note ? '· ' + esc(e.note) : '') + '</span></div>' +
    '<span class="cf-src">' + esc(e.source === 'outlook' ? 'Outlook' : e.source === 'maintenance' ? 'Maintenance' : e.source === 'advance' ? 'Advance' : e.source === 'bank' ? 'Bank' : 'Manual') + '</span>' +
    '<span class="muted">' + esc(e.date || '') + '</span>' +
    '<span class="cf-amt ' + (e.direction === 'in' ? 'in' : 'out') + '">' + (e.direction === 'in' ? '+' : '−') + fmtMoney(e.amountCents) + '</span>' +
    (e.url ? '<a class="btn-ghost btn-sm" href="' + e.url + '" target="_blank" rel="noopener">File</a>' : '') +
    (e.virtual ? '' : '<button class="btn-ghost btn-sm" data-delentry="' + e.id + '">Delete</button>') + '</div>';
  // ---- Design 6 (KPI Wall + donut) display blocks, chosen 2026-11-17 ----
  const CF6_PALETTE = ['#F2B705', '#3B82F6', '#34d399', '#a78bfa', '#fb7185', '#22d3ee', '#f97316', '#94a3b8', '#e879f9', '#84cc16', '#facc15', '#38bdf8'];
  const cf6Tile = (label, cents, cls, sub) => '<div class="cf6-tile ' + (cls || '') + '"><div class="cf6-lab">' + label + '</div><div class="cf6-val">' + fmtMoney(cents) + '</div>' + (sub ? '<div class="cf6-sub">' + sub + '</div>' : '') + '</div>';
  const cf6Share = (part, total) => total > 0 ? Math.round((part / total) * 100) + '% of money out' : '';
  const bb = d.bankBalance || null;
  const bbWhen = bb && bb.at ? new Date(bb.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const kpiWall = cf6Tile('Money in — ' + monthName, mo.inTotalCents, 'pos') +
    cf6Tile('Money out — ' + monthName, mo.outTotalCents, 'neg') +
    cf6Tile('Profit — ' + monthName, mo.profitCents, mo.profitCents >= 0 ? 'pos' : 'neg', mo.inTotalCents ? Math.round((mo.profitCents / mo.inTotalCents) * 100) + '% of money in' : '') +
    (bb ? '<div class="cf6-tile gold"><div class="cf6-lab">Bank — ' + esc(bb.name || 'Bank') + ' ••' + esc(bb.mask || '') + '</div><div class="cf6-val">' + fmtMoney(Number.isFinite(bb.availableCents) ? bb.availableCents : bb.currentCents) + '</div><div class="cf6-sub">Posted ' + fmtMoney(bb.currentCents) + (bbWhen ? ' · ' + esc(bbWhen) : '') + '</div></div>' : cf6Tile('Bank', 0, 'gold', 'Not connected'));
  const outSorted = [...(mo.outGroups || [])].sort((a, b) => b.amountCents - a.amountCents);
  const cf6Donut = (() => {
    const total = mo.outTotalCents || 0;
    const R = 62, C = 2 * Math.PI * R;
    let off = 0, segs = '';
    outSorted.forEach((g, i) => {
      const frac = total > 0 ? g.amountCents / total : 0;
      const len = Math.max(frac * C - 2, 0);
      segs += '<circle cx="80" cy="80" r="' + R + '" fill="none" stroke="' + CF6_PALETTE[i % CF6_PALETTE.length] + '" stroke-width="21" stroke-dasharray="' + len + ' ' + (C - len) + '" stroke-dashoffset="' + (-off) + '" transform="rotate(-90 80 80)"/>';
      off += frac * C;
    });
    return '<svg width="160" height="160" viewBox="0 0 160 160">' + segs +
      '<text x="80" y="74" text-anchor="middle" fill="#8494ab" font-size="11" font-weight="700">MONEY OUT</text>' +
      '<text x="80" y="95" text-anchor="middle" fill="#fff" font-size="15" font-weight="900">' + fmtMoney(total) + '</text></svg>';
  })();
  const cf6Legend = outSorted.map((g, i) => '<div class="cf6-lrow"><span class="cf6-dot" style="background:' + CF6_PALETTE[i % CF6_PALETTE.length] + '"></span><span>' + esc(g.category) + (g.fixed ? ' · fixed' : '') + '</span><span class="cf6-amt">' + fmtMoney(g.amountCents) + '</span><span class="cf6-pct">' + (mo.outTotalCents ? Math.round((g.amountCents / mo.outTotalCents) * 100) + '%' : '') + '</span></div>').join('');
  const cf6WeekRows = weekly.map((w) => '<tr><td>' + esc(String(w.weekStart).slice(5)) + '</td><td class="n" style="color:#4ade80">' + fmtMoney(w.inCents) + '</td><td class="n" style="color:#f87171">' + fmtMoney(w.outCents) + '</td><td class="n" style="color:' + (w.inCents - w.outCents >= 0 ? '#4ade80' : '#f87171') + '">' + fmtMoney(w.inCents - w.outCents) + '</td></tr>').join('');
  const cf6ExpTiles = outSorted.map((g) => cf6Tile(g.category + (g.fixed ? ' · fixed' : ''), g.amountCents, 'neg', cf6Share(g.amountCents, mo.outTotalCents))).join('');
  const cf6IncTiles = [...(mo.inGroups || [])].sort((a, b) => b.amountCents - a.amountCents).map((g) => cf6Tile(g.category, g.amountCents, 'pos')).join('');
  const cf6TruckRows = truckMonthStats.map((t) => '<tr><td><strong>' + esc(t.unitNumber) + '</strong></td><td class="n">' + (t.loadsInMonth != null ? t.loadsInMonth : (t.trips ? t.trips.length : 0)) + '</td><td class="n">' + fmtMoney(t.revenueCents) + '</td><td class="n">' + fmtMoney(t.fuelCents) + '</td><td class="n">' + fmtMoney(t.driverPayCents) + '</td><td class="n">' + fmtMoney(t.maintCents) + '</td><td class="n">' + fmtMoney(t.otherCents) + '</td><td class="n" style="color:' + (t.profitCents >= 0 ? '#4ade80' : '#f87171') + ';font-weight:800">' + fmtMoney(t.profitCents) + '</td><td class="n">' + (t.revenueCents ? Math.round((t.profitCents / t.revenueCents) * 100) + '%' : '—') + '</td></tr>').join('');
  const allTimeWall = cf6Tile('Booked (rate cons)', d.bookedCents || 0, '') +
    cf6Tile('Received', d.receivedCents || 0, 'pos') +
    cf6Tile('Paid out', d.outCents || 0, 'neg') +
    cf6Tile('Net', d.netCents || 0, (d.netCents || 0) >= 0 ? 'pos' : 'neg');
  const cf6ExpTilesAll = [...(totals.outGroups || [])].sort((a, b) => b.amountCents - a.amountCents).map((g) => cf6Tile(g.category + (g.fixed ? ' · fixed' : ''), g.amountCents, 'neg', cf6Share(g.amountCents, d.outCents || 0))).join('');
  const cf6IncTilesAll = [...(totals.inGroups || [])].sort((a, b) => b.amountCents - a.amountCents).map((g) => cf6Tile(g.category, g.amountCents, 'pos')).join('');
  main.innerHTML = '<div class="rc-head"><h1>Cash Flow</h1><span>' +
    '<button class="btn-blue btn" id="cfOutlookBtn">Import from Outlook</button> ' +
    '<button class="btn-ghost btn" id="cfAddToggle">+ Add entry</button></span></div>' +
    '<div class="cf6-monthbar"><button class="btn-ghost btn-sm" id="cfMonthPrev">‹ Prev</button><strong>' + esc(monthName) + '</strong><span><input type="month" id="cfMonthInput" value="' + esc(mo.key || '') + '"> <button class="btn-ghost btn-sm" id="cfMonthGo">Show month</button></span><button class="btn-ghost btn-sm" id="cfMonthNext">Next ›</button></div>' +
    '<div class="cf6-wall">' + kpiWall + '</div>' +
    '<div class="cf6-grid2">' +
    '<section class="cf6-panel"><div class="cf6-sect">Where the money went — ' + esc(monthName) + '</div><div class="cf6-donutwrap">' + cf6Donut + '<div class="cf6-legend">' + cf6Legend + '</div></div></section>' +
    '<section class="cf6-panel"><div class="cf6-sect">Weekly — last 8 weeks</div><table class="cf6-table"><tr><th>Week</th><th class="n">In</th><th class="n">Out</th><th class="n">Net</th></tr>' + cf6WeekRows + '</table></section></div>' +
    '<div class="cf6-sect">Expenses by category — ' + esc(monthName) + '</div><div class="cf6-wall">' + cf6ExpTiles + '</div>' +
    '<div class="cf6-sect">Income by category — ' + esc(monthName) + '</div><div class="cf6-wall">' + cf6IncTiles + '</div>' +
    '<div class="cf6-sect">Trucks — ' + esc(monthName) + '</div>' +
    '<section class="cf6-panel"><table class="cf6-table"><tr><th>Truck</th><th class="n">Loads</th><th class="n">Revenue</th><th class="n">Fuel (receipts)</th><th class="n">Pay (mi × $0.65)</th><th class="n">Maint.</th><th class="n">Other</th><th class="n">Profit</th><th class="n">Margin</th></tr>' + cf6TruckRows + '</table>' +
    '<div class="form-actions"><button class="btn-ghost btn-sm" id="cfDlMonthly">⬇ Download ' + esc(monthName) + ' report (CSV)</button> <button class="btn-ghost btn-sm" id="cfDlTrucks">⬇ Download per-truck ' + esc(monthName) + ' report (CSV)</button></div></section>' +
    '<section class="card hidden" id="cfOutlookCard"><h3>Import from Outlook</h3>' +
    (outlook.connected
      ? '<p class="small muted">Connected: ' + esc(outlook.email || '') + ' — pick the factoring payment, toll bill or Pilot weekly email; the amount is read from its attachment and you confirm it before saving.</p>' +
        '<div class="form-actions"><input id="cfMailSearch" placeholder="Search — pilot, toll, factoring…"> <button class="btn btn-sm" id="cfMailSearchBtn">Search</button></div>' +
        '<div id="cfMailList"><p class="small muted">Loading emails…</p></div>' +
        '<div id="cfOutlookPreview"></div>'
      : '<p class="small muted">Connect the Outlook mailbox to import factoring payments, toll bills and the Pilot weekly fuel report.</p>' +
        '<div class="form-actions"><button class="btn btn-sm" id="cfOutlookConnect">Connect Outlook</button></div>') +
    '</section>' +
    '<section class="card add-unit-card hidden" id="cfAddCard"><h3 id="cfFormTitle">Add entry</h3>' +
    '<p class="small muted hidden" id="cfFromOutlookNote"></p>' +
    '<form id="cfEntryForm"><div class="form-grid">' +
    '<label>In / Out <select name="direction"><option value="out">Money out</option><option value="in">Money in</option></select></label>' +
    '<label>Category <select name="category"><option>Fuel (Pilot weekly)</option><option>Tolls</option><option>Parking</option><option>Maintenance</option><option>Repairs</option><option>Driver pay</option><option>Dispatch pay</option><option>Truck payment</option><option>Trailer rental</option><option>Insurance</option><option>Office expenses</option><option>Factoring payment</option><option>Broker payment</option><option>Other</option></select></label>' +
    '<label>Amount $ <input name="amount" type="number" min="0" step="0.01" required placeholder="0.00"></label>' +
    '<label>Date <input name="date" type="date" required></label>' +
    '<label>Truck <select name="truckId">' + truckOpts + '</select></label>' +
    '<label>Trip (load) <select name="loadId">' + loadOpts + '</select></label>' +
    '<label>Note <input name="note" placeholder="Optional"></label>' +
    '<label id="cfFileLabel">Receipt <input name="file" type="file" accept="image/*,.pdf"></label>' +
    '</div><div class="form-actions"><button class="btn" type="submit">Save entry</button> ' +
    '<button class="btn-ghost" type="button" id="cfAddCancel">Cancel</button></div></form></section>' +
    '<div class="cf6-sect">All time — since May 2026</div><div class="cf6-wall">' + allTimeWall + '</div>' +
    '<div class="cf6-sect">Expenses by category — all time</div><div class="cf6-wall">' + cf6ExpTilesAll + '</div>' +
    '<div class="cf6-sect">Income by category — all time</div><div class="cf6-wall">' + cf6IncTilesAll + '</div>' +
    '<div class="form-actions"><button class="btn-ghost btn-sm" id="cfDlTotal">⬇ Download total report (CSV)</button></div>' +
    '<h2 class="cf-h2">Fixed monthly payments</h2>' +
    '<p class="small muted">Set once — they count automatically in every month\'s profit above. Don\'t add these by hand as entries too.</p>' +
    (fixedRows || '<p class="empty">No fixed payments yet.</p>') +
    '<form class="maint-add-form" id="cfFixedForm">' +
    '<select name="category"><option>Truck payment</option><option>Trailer rental</option><option>Insurance</option><option>Dispatch pay</option><option>Office expenses</option><option>Other</option></select> ' +
    '<input name="amount" type="number" min="0" step="0.01" placeholder="Amount $ / month" required> ' +
    '<input name="note" placeholder="Note — e.g. Truck 1301"> ' +
    '<button class="btn-ghost btn-sm" type="submit">+ Add fixed payment</button></form>' +
    '<h2 class="cf-h2">Bank transactions — categorize</h2>' +
    '<p class="small muted">Straight from your bank account — most of these categorize themselves (factoring money in, Pilot weekly to Fuel, tolls, driver Zelles to Driver pay). Only the ones the system cannot place wait here: categorize one once and it learns that pattern for next time. Your profit comes from the categorized books, never from the bank total.</p>' +
    (bankPending.length ? bankPending.map(bankRow).join('') : '<p class="empty">Nothing waiting — every bank transaction is handled.</p>') +
    '<h2 class="cf-h2">Entries</h2>' +
    (entries.length ? entries.map(entryRow).join('') : '<p class="empty">No entries yet — import from Outlook or add the first one.</p>') +
    '<p class="small muted">Company books above run on the Pilot weekly bill for fuel. In the trucks table, fuel is the driver\'s uploaded receipts and driver pay is miles × $0.65. Approved driver advances are counted automatically in the company books.</p>';
  const addCard = main.querySelector('#cfAddCard');
  const outlookCard = main.querySelector('#cfOutlookCard');
  const form = main.querySelector('#cfEntryForm');
  const toggleCard = (card) => {
    if (!card) return;
    const opening = card.classList.contains('hidden');
    card.classList.toggle('hidden');
    card.style.display = opening ? '' : 'none';
    if (opening) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const addToggleBtn = main.querySelector('#cfAddToggle');
  if (addToggleBtn) addToggleBtn.addEventListener('click', () => toggleCard(addCard));
  const outlookBtn = main.querySelector('#cfOutlookBtn');
  if (outlookBtn) outlookBtn.addEventListener('click', () => toggleCard(outlookCard));
  const dateInput = form ? form.querySelector('[name="date"]') : null;
  if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
  main.querySelector('#cfAddCancel').addEventListener('click', () => { cfOutlookPick = null; form.reset(); addCard.classList.add('hidden'); addCard.style.display = 'none'; });
  main.querySelector('#cfMonthGo').addEventListener('click', () => {
    const v = main.querySelector('#cfMonthInput').value;
    if (v) { cfMonthKey = v; renderAdminView('cashflow'); }
  });
  const cfPrev = main.querySelector('#cfMonthPrev');
  if (cfPrev) cfPrev.addEventListener('click', () => cfShiftMonth(-1));
  const cfNext = main.querySelector('#cfMonthNext');
  if (cfNext) cfNext.addEventListener('click', () => cfShiftMonth(1));
  const cfDlT = main.querySelector('#cfDlTotal');
  if (cfDlT) cfDlT.addEventListener('click', () => cfDownload('total'));
  const cfDlM = main.querySelector('#cfDlMonthly');
  if (cfDlM) cfDlM.addEventListener('click', () => cfDownload('monthly'));
  const cfDlK = main.querySelector('#cfDlTrucks');
  if (cfDlK) cfDlK.addEventListener('click', () => cfDownload('trucks'));
  main.querySelector('#cfFixedForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/admin/cashflow/fixed', { method: 'POST', body: JSON.stringify({ category: fd.get('category'), amount: fd.get('amount'), note: fd.get('note') || undefined }) });
      toast('Fixed payment added.', 'ok');
      renderAdminView('cashflow');
    } catch (err) { showError(err); }
  });
  main.querySelectorAll('[data-delfixed]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this fixed payment?')) return;
    try {
      await api('/api/admin/cashflow/fixed/' + b.dataset.delfixed, { method: 'DELETE' });
      renderAdminView('cashflow');
    } catch (err) { showError(err); }
  }));
  main.querySelectorAll('[data-bankcat]').forEach((b) => b.addEventListener('click', async () => {
    const sel = main.querySelector('#bankcat-' + b.dataset.bankcat);
    try {
      await api('/api/admin/cashflow/bank/' + b.dataset.bankcat + '/categorize', { method: 'POST', body: JSON.stringify({ category: sel ? sel.value : 'Other' }) });
      toast('Categorized — it counts now.', 'ok');
      renderAdminView('cashflow');
    } catch (err) { showError(err); }
  }));
  main.querySelectorAll('[data-bankignore]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('/api/admin/cashflow/bank/' + b.dataset.bankignore + '/ignore', { method: 'POST', body: JSON.stringify({}) });
      renderAdminView('cashflow');
    } catch (err) { showError(err); }
  }));
  const connectBtn = main.querySelector('#cfOutlookConnect');
  if (connectBtn) connectBtn.addEventListener('click', async () => {
    try {
      const res = await api('/api/admin/outlook/auth-url');
      window.open(res.url, '_blank');
      toast('Sign in to Microsoft in the new tab, then come back here.', 'ok');
    } catch (err) { showError(err); }
  });
  const loadMail = async (search) => {
    const box = main.querySelector('#cfMailList');
    if (!box) return;
    box.innerHTML = '<p class="small muted">Loading emails…</p>';
    try {
      const msgs = await api('/api/admin/outlook/messages' + (search ? '?search=' + encodeURIComponent(search) : ''));
      if (!Array.isArray(msgs) || !msgs.length) { box.innerHTML = '<p class="small muted">No emails found.</p>'; return; }
      box.innerHTML = msgs.map((m) => '<div class="cf-row"><div class="cf-row-main"><strong>' + esc(m.subject || '(no subject)') + '</strong> ' +
        '<span class="muted">· ' + esc(m.from || '') + '</span></div><span class="muted">' + esc(String(m.receivedAt || '').slice(0, 10)) + '</span>' +
        '<button class="btn-ghost btn-sm" data-cfmail="' + esc(m.id) + '" data-subject="' + esc(m.subject || '') + '">Use this email</button></div>').join('');
      box.querySelectorAll('[data-cfmail]').forEach((b) => b.addEventListener('click', async () => {
        try {
          const atts = await api('/api/admin/outlook/messages/' + encodeURIComponent(b.dataset.cfmail) + '/attachments');
          const files = (atts || []).filter((a) => a.id);
          if (!files.length) { toast('That email has no file attachment.', 'error'); return; }
          const att = files[0];
          const prevBox = main.querySelector('#cfOutlookPreview');
          if (prevBox) prevBox.innerHTML = '<p class="small muted">Reading the file…</p>';
          const prev = await api('/api/admin/cashflow/outlook-preview', { method: 'POST', body: JSON.stringify({ messageId: b.dataset.cfmail, attachmentId: att.id }) });
          if (prevBox) {
            prevBox.innerHTML = '<div class="cf-preview"><h4>Preview — check this is the right file</h4>' +
              '<p><strong>' + esc(prev.fileName || 'attachment') + '</strong> <span class="muted">· from ' + esc(prev.from || '') + ' · ' + esc(prev.date || '') + '</span></p>' +
              '<p class="small muted">' + esc(prev.subject || '') + '</p>' +
              (prev.imageDataUri
                ? '<img class="cf-preview-img" src="' + prev.imageDataUri + '" alt="Attachment preview">'
                : (prev.textPreview ? '<div class="cf-preview-text">' + esc(prev.textPreview) + '…</div>' : '<p class="small muted">No readable text in this file.</p>')) +
              '<p>Detected: <strong>' + (prev.amountCents ? fmtMoney(prev.amountCents) : 'no amount found') + '</strong> · looks like <strong>' + esc(prev.category || 'Other') + '</strong> (' + (prev.direction === 'in' ? 'money in' : 'money out') + ')</p>' +
              '<div class="form-actions"><button class="btn btn-sm" id="cfPreviewUse">Use this file</button> ' +
              '<button class="btn-ghost btn-sm" id="cfPreviewCancel">Choose a different file</button></div></div>';
            prevBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const useBtn = prevBox.querySelector('#cfPreviewUse');
            if (useBtn) useBtn.addEventListener('click', () => {
              cfOutlookPick = { messageId: b.dataset.cfmail, attachmentId: att.id };
              form.elements.direction.value = prev.direction || 'out';
              if (prev.category) form.elements.category.value = prev.category;
              if (prev.amountCents) form.elements.amount.value = (prev.amountCents / 100).toFixed(2);
              if (prev.date) form.elements.date.value = prev.date;
              const note = main.querySelector('#cfFromOutlookNote');
              note.textContent = 'From Outlook: “' + (prev.subject || b.dataset.subject || '') + '” — check the amount, then Save. The email attachment is saved with the entry.';
              note.classList.remove('hidden');
              main.querySelector('#cfFormTitle').textContent = 'Confirm import';
              const fl = main.querySelector('#cfFileLabel');
              if (fl) fl.classList.add('hidden');
              addCard.classList.remove('hidden');
              addCard.style.display = '';
              outlookCard.classList.add('hidden');
              outlookCard.style.display = 'none';
              addCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
            const cancelBtn = prevBox.querySelector('#cfPreviewCancel');
            if (cancelBtn) cancelBtn.addEventListener('click', () => { prevBox.innerHTML = ''; });
          }
        } catch (err) { showError(err); }
      }));
    } catch (err) { box.innerHTML = '<p class="small muted">Could not load emails.</p>'; }
  };
  if (outlook.connected) loadMail('');
  const searchBtn = main.querySelector('#cfMailSearchBtn');
  if (searchBtn) searchBtn.addEventListener('click', () => loadMail(main.querySelector('#cfMailSearch').value.trim()));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      if (cfOutlookPick) {
        await api('/api/admin/cashflow/entries/from-outlook', {
          method: 'POST',
          body: JSON.stringify({
            messageId: cfOutlookPick.messageId, attachmentId: cfOutlookPick.attachmentId,
            direction: fd.get('direction'), category: fd.get('category'),
            amount: fd.get('amount'), date: fd.get('date'),
            truckId: fd.get('truckId') || undefined, loadId: fd.get('loadId') || undefined,
            note: fd.get('note') || undefined,
          }),
        });
        cfOutlookPick = null;
      } else {
        await api('/api/admin/cashflow/entries', { method: 'POST', body: fd });
      }
      toast('Entry saved.', 'ok');
      renderAdminView('cashflow');
    } catch (err) { showError(err); }
  });
  main.querySelectorAll('[data-delentry]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this entry?')) return;
    try {
      await api('/api/admin/cashflow/entries/' + b.dataset.delentry, { method: 'DELETE' });
      renderAdminView('cashflow');
    } catch (err) { showError(err); }
  }));
}

/* ---------- Dispatch (admin) ---------- */
async function viewDispatch(main) {
  document.body.classList.add('chat-bg');
  ensureChatBgLayer();
  main.innerHTML = '<div class="chat-page"><h1>Chat</h1>' +
    '<div class="chat-layout">' +
      '<div class="chat-convos" id="chatConvos"><p class="muted">Loading…</p></div>' +
      '<div class="chat-panel">' +
        '<div class="chat-head" id="chatHead"></div>' +
        '<div class="chat-msgs" id="chatMsgs"><p class="muted">Loading…</p></div>' +
        '<div class="chat-attach-chip" id="chatAttachChip" hidden></div>' +
        '<div class="chat-delbar" id="chatDelBar" hidden><span id="chatDelCount"></span>' +
        '<button class="btn btn-danger btn-sm" id="chatDelBtn" type="button">Delete for everyone</button>' +
        '<button class="btn btn-ghost btn-sm" id="chatDelCancel" type="button">Cancel</button></div>' +
        '<form id="chatForm" class="chat-composer">' +
          '<button class="chat-attach-btn" id="chatAttachBtn" type="button" title="Attach a picture or file">📎</button>' +
          '<input type="file" id="chatFile" hidden>' +
          '<input type="file" id="chatWpFile" accept="image/*" hidden>' +
          '<input id="chatBody" placeholder="Type a message to the driver…" autocomplete="off">' +
          '<button class="btn" type="submit">Send</button>' +
        '</form>' +
        '<p class="muted small chat-note">Chat refreshes every 15 seconds.</p>' +
      '</div>' +
      '<aside class="chat-context" id="chatContext"></aside>' +
    '</div></div>';

  const LIVE_MS = 15 * 60 * 1000;
  let stagedFile = null;
  let threadList = [];
  let selectMode = false;
  const selectedMsgIds = new Set();
  const updateDelBar = () => {
    const bar = document.getElementById('chatDelBar');
    if (!bar) return;
    bar.hidden = !(selectMode && selectedMsgIds.size);
    const cnt = document.getElementById('chatDelCount');
    if (cnt) cnt.textContent = selectedMsgIds.size + ' selected';
  };
  const exitSelectMode = () => {
    selectMode = false;
    selectedMsgIds.clear();
    updateDelBar();
    renderHead();
    renderThread(threadList);
  };
  const initials = (name) => {
    const w = String(name || '?').trim().split(/\s+/);
    return ((w[0] || '')[0] + ((w[1] || '')[0] || '')).toUpperCase() || '?';
  };
  const selected = () => (state.chatConvos || []).find(c => c.driver.id === state.dispatchDriverId) || null;
  const attPreview = (m) => {
    if (!m) return 'No messages yet';
    if (m.body) return m.body;
    if (m.attachment) return m.attachment.mimeType && m.attachment.mimeType.startsWith('image/')
      ? '📎 Photo' : '📎 ' + (m.attachment.filename || 'File');
    return '';
  };

  const renderConvos = () => {
    const el = document.getElementById('chatConvos');
    if (!el) return;
    const convos = state.chatConvos || [];
    el.innerHTML = convos.length ? convos.map(c =>
      '<button class="convo-row' + (c.driver.id === state.dispatchDriverId ? ' active' : '') + '" type="button" data-convo="' + c.driver.id + '">' +
      '<span class="chat-avatar" style="background:' + driverColor(c.driver.id) + '">' + esc(initials(c.driver.name)) + '</span>' +
      '<span class="convo-mid"><span class="convo-name">' + esc(c.driver.name) + '</span>' +
      '<span class="convo-last">' + esc(attPreview(c.lastMessage)) + '</span></span>' +
      '<span class="convo-side">' + (c.lastMessage ? '<span class="convo-time">' + timeAgo(c.lastMessage.createdAt) + '</span>' : '') +
      (c.unread > 0 && c.driver.id !== state.dispatchDriverId ? '<span class="convo-unread">' + c.unread + '</span>' : '') + '</span></button>').join('')
      : '<p class="empty">No drivers yet.</p>';
    el.querySelectorAll('[data-convo]').forEach(b => b.addEventListener('click', () => {
      selectMode = false;
      selectedMsgIds.clear();
      updateDelBar();
      state.dispatchDriverId = parseInt(b.dataset.convo, 10);
      try { localStorage.setItem('lxl_dispatch_driver', String(state.dispatchDriverId)); } catch (e) {}
      renderConvos();
      renderHead();
      renderContext();
      loadThread();
    }));
  };

  const statusLine = (c) => {
    if (!c.location) return 'No location yet';
    const fresh = Date.now() - Date.parse(c.location.updatedAt) < LIVE_MS;
    if (!fresh) return 'Last update ' + timeAgo(c.location.updatedAt);
    const spd = typeof c.location.speedMph === 'number' ? Math.round(c.location.speedMph) : 0;
    return (spd > 2 ? 'Driving · ' + spd + ' mph' : 'Online') + (c.location.place ? ' · ' + c.location.place : '');
  };

  const renderHead = () => {
    const el = document.getElementById('chatHead');
    if (!el) return;
    const c = selected();
    if (!c) { el.innerHTML = ''; return; }
    el.innerHTML = '<span class="chat-avatar lg" style="background:' + driverColor(c.driver.id) + '">' + esc(initials(c.driver.name)) + '</span>' +
      '<span class="chat-head-texts"><span class="chat-head-name">' + esc(c.driver.name) + '</span>' +
      '<span class="chat-head-sub">' + esc(statusLine(c)) + '</span></span>' +
      '<span class="chat-head-unit">' + (c.truck ? 'Truck ' + esc(c.truck.unitNumber) : '') +
      (c.trailer ? ' · Trailer ' + esc(c.trailer.unitNumber) : '') + '</span>' +
      '<span class="chat-head-wp"><button class="chat-wp-btn" id="chatSelectBtn" type="button" title="Select messages to delete">🗑 Select</button>' +
      '<button class="chat-wp-btn" id="chatWpBtn" type="button" title="Change chat wallpaper">🖼 Wallpaper</button>' +
      '<button class="chat-wp-btn" id="chatWpReset" type="button" title="Remove wallpaper"' + (state.chatWpServerUrl ? '' : ' disabled') + '>✕ Remove</button></span>';
    const selBtn = document.getElementById('chatSelectBtn');
    if (selBtn) selBtn.addEventListener('click', () => {
      if (selectMode) exitSelectMode();
      else { selectMode = true; renderHead(); renderThread(threadList); }
    });
    const wpBtn = document.getElementById('chatWpBtn');
    if (wpBtn) wpBtn.addEventListener('click', () => document.getElementById('chatWpFile').click());
    const wpReset = document.getElementById('chatWpReset');
    if (wpReset) wpReset.addEventListener('click', async () => {
      try { await api('/api/admin/chat-wallpaper', { method: 'DELETE' }); } catch { /* ignore */ }
      state.chatWpServerUrl = null;
      applyWallpaper();
      renderHead();
    });
  };

  const renderContext = () => {
    const el = document.getElementById('chatContext');
    if (!el) return;
    const c = selected();
    if (!c) { el.innerHTML = ''; return; }
    const l = c.activeLoad;
    const loadCard = l
      ? '<div class="ctx-card"><div class="ctx-title">Active load</div>' +
        '<div class="ctx-ref">' + esc(l.reference) + '</div>' +
        '<div class="ctx-route">' + esc(shortPlace(l.pickupLocation)) + ' → ' + esc(shortPlace(l.deliveryLocation)) + '</div>' +
        '<div class="ctx-bar"><div class="ctx-fill" style="width:' + (l.progress || 0) + '%"></div></div>' +
        '<div class="ctx-pct">' + (l.progress || 0) + '% · delivery ' + fmtDate(l.deliveryAt) + '</div>' +
        '<div class="ctx-actions"><button class="btn btn-ghost btn-sm" type="button" data-ctx="documents">Documents</button>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-ctx="tracking">Tracking</button></div></div>'
      : '<div class="ctx-card"><div class="ctx-title">Active load</div><p class="muted small">No active load.</p></div>';
    const truckCard = '<div class="ctx-card"><div class="ctx-title">Truck</div>' +
      '<div class="ctx-sub">' + (c.truck ? esc(c.truck.unitNumber) + (c.trailer ? ' · Trailer ' + esc(c.trailer.unitNumber) : '') : 'No truck assigned') +
      (c.truck && c.truck.odometerMi != null ? '<br>' + Number(c.truck.odometerMi).toLocaleString('en-US') + ' mi' : '') + '</div></div>';
    el.innerHTML = loadCard + truckCard;
    el.querySelectorAll('[data-ctx]').forEach(b => b.addEventListener('click', () => {
      const v = b.dataset.ctx === 'documents' ? 'documents' : 'locations';
      state.adminView = v;
      renderAdminSidebar();
      renderAdminView(v);
    }));
  };

  const hydrateImages = (root) => {
    root.querySelectorAll('img[data-att-img]').forEach(async (img) => {
      const url = img.dataset.attImg;
      if (!url || img.dataset.loaded) return;
      img.dataset.loaded = '1';
      try {
        if (!state.attUrlCache) state.attUrlCache = new Map();
        if (!state.attUrlCache.has(url)) {
          const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + state.token } });
          if (!res.ok) return;
          state.attUrlCache.set(url, URL.createObjectURL(await res.blob()));
        }
        img.src = state.attUrlCache.get(url);
      } catch { /* leave the placeholder */ }
    });
  };

  const renderThread = (list) => {
    const thread = document.getElementById('chatMsgs');
    if (!thread) return;
    const c = selected();
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
    thread.innerHTML = list.length ? list.map(m => {
      const mine = m.sender === 'dispatch';
      let inner = '';
      if (m.attachment) {
        if (m.attachment.mimeType && m.attachment.mimeType.startsWith('image/')) {
          inner += '<img class="chat-img" data-att-img="' + esc(m.attachment.url) + '" data-att-open="' + m.attachment.fileId + '" alt="' + esc(m.attachment.filename || 'Photo') + '">';
        } else {
          inner += '<button class="chat-file" type="button" data-att-open="' + m.attachment.fileId + '">📄 ' + esc(m.attachment.filename || 'File') + '</button>';
        }
      }
      if (m.body) inner += '<span>' + esc(m.body) + '</span>';
      const status = mine
        ? ' · <span class="tick' + (m.read ? ' seen' : '') + '">' + (m.read ? '✓✓ Seen' : m.delivered ? '✓ Delivered' : '✓ Sent') + '</span>'
        : '';
      const tooOld = Date.now() - Date.parse(m.createdAt) > 7 * 60 * 1000;
      const selBox = selectMode
        ? '<input type="checkbox" class="chat-sel" data-sel-msg="' + m.id + '"' + (selectedMsgIds.has(m.id) ? ' checked' : '') + (tooOld ? ' disabled title="Older than 7 minutes — can no longer be deleted for everyone"' : '') + '>'
        : '';
      return '<div class="chat-row' + (mine ? ' mine' : '') + (selectMode ? ' selecting' : '') + '">' + selBox + '<div class="chat-bubble' + (mine ? ' mine' : '') + '">' + inner + '</div>' +
        '<div class="chat-meta' + (mine ? ' mine' : '') + '">' + esc(mine ? (m.senderName || 'Dispatch') : (c ? c.driver.name : 'Driver')) + ' · ' + fmtDate(m.createdAt) + status + '</div></div>';
    }).join('') : '<p class="empty">No messages yet.</p>';
    thread.querySelectorAll('[data-sel-msg]').forEach(cb => cb.addEventListener('change', () => {
      const id = parseInt(cb.dataset.selMsg, 10);
      if (cb.checked) selectedMsgIds.add(id); else selectedMsgIds.delete(id);
      updateDelBar();
    }));
    thread.querySelectorAll('[data-att-open]').forEach(el => el.addEventListener('click', () => {
      const m = list.find(x => x.attachment && x.attachment.fileId === parseInt(el.dataset.attOpen, 10));
      if (m) downloadFile(m.attachment.url, m.attachment.filename, true, m.attachment.mimeType);
    }));
    hydrateImages(thread);
    if (nearBottom) thread.scrollTop = thread.scrollHeight;
  };

  const applyWallpaper = async () => {
    const msgs = document.getElementById('chatMsgs');
    if (!msgs) return;
    const url = state.chatWpServerUrl;
    if (!url) { msgs.style.backgroundImage = ''; return; }
    try {
      if (!state.attUrlCache) state.attUrlCache = new Map();
      if (!state.attUrlCache.has(url)) {
        const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + state.token } });
        if (!res.ok) return;
        state.attUrlCache.set(url, URL.createObjectURL(await res.blob()));
      }
      msgs.style.backgroundImage = 'linear-gradient(rgba(4, 9, 18, 0.62), rgba(4, 9, 18, 0.62)), url("' + state.attUrlCache.get(url) + '")';
      msgs.style.backgroundSize = 'cover';
      msgs.style.backgroundPosition = 'center';
    } catch { /* wallpaper is cosmetic */ }
  };

  const loadThread = async () => {
    if (!state.dispatchDriverId || state.adminView !== 'dispatch') return;
    try {
      const msgs = await api('/api/admin/messages/' + state.dispatchDriverId);
      threadList = Array.isArray(msgs) ? msgs : [];
      // Drop selections for messages that no longer exist.
      const alive = new Set(threadList.map(m => m.id));
      [...selectedMsgIds].forEach(id => { if (!alive.has(id)) selectedMsgIds.delete(id); });
      updateDelBar();
      renderThread(threadList);
    } catch { /* keep the old thread visible on a transient failure */ }
  };

  const refreshConvos = async () => {
    try {
      const convos = await api('/api/admin/dispatch/conversations');
      state.chatConvos = Array.isArray(convos) ? convos : [];
    } catch { return; }
    if (!state.chatConvos.some(c => c.driver.id === state.dispatchDriverId)) {
      state.dispatchDriverId = state.chatConvos.length ? state.chatConvos[0].driver.id : null;
    }
    state.driversCache = state.chatConvos.map(c => c.driver);
    renderConvos();
    renderHead();
    renderContext();
  };

  const delBtn = document.getElementById('chatDelBtn');
  if (delBtn) delBtn.addEventListener('click', async () => {
    const ids = [...selectedMsgIds];
    if (!ids.length || !state.dispatchDriverId) return;
    if (!confirm('Delete ' + ids.length + ' message' + (ids.length === 1 ? '' : 's') + ' for everyone? The driver will no longer see them either.')) return;
    try {
      const r = await api('/api/admin/messages/' + state.dispatchDriverId, { method: 'DELETE', body: JSON.stringify({ ids }) });
      toast('Deleted ' + (r && r.deleted != null ? r.deleted : ids.length) + ' message' + (ids.length === 1 ? '' : 's') + ' for everyone.' + (r && r.skippedOld ? ' ' + r.skippedOld + ' skipped — older than 7 minutes.' : ''), 'ok');
      exitSelectMode();
      loadThread();
      refreshConvos();
    } catch (err) { showError(err); }
  });
  const delCancel = document.getElementById('chatDelCancel');
  if (delCancel) delCancel.addEventListener('click', exitSelectMode);

  const chip = document.getElementById('chatAttachChip');
  const fileInput = document.getElementById('chatFile');
  const renderChip = () => {
    if (!stagedFile) { chip.hidden = true; chip.innerHTML = ''; return; }
    chip.hidden = false;
    chip.innerHTML = '<span>📎 ' + esc(stagedFile.name) + '</span><button type="button" id="chatAttachClear" title="Remove attachment">✕</button>';
    document.getElementById('chatAttachClear').addEventListener('click', () => {
      stagedFile = null;
      fileInput.value = '';
      renderChip();
    });
  };
  document.getElementById('chatAttachBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    stagedFile = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
    renderChip();
  });
  const wpInput = document.getElementById('chatWpFile');
  wpInput.addEventListener('change', () => {
    const f = wpInput.files && wpInput.files[0];
    wpInput.value = '';
    if (!f) return;
    openWallpaperEditor(f, async (blob) => {
      try {
        const fd = new FormData();
        fd.append('file', blob, 'chat-wallpaper.jpg');
        const out = await api('/api/admin/chat-wallpaper', { method: 'POST', body: fd });
        state.chatWpServerUrl = out && out.url ? out.url : null;
        if (state.chatWpServerUrl) {
          if (!state.attUrlCache) state.attUrlCache = new Map();
          state.attUrlCache.set(state.chatWpServerUrl, URL.createObjectURL(blob));
        }
        await applyWallpaper();
        renderHead();
        toast('Chat wallpaper set.', 'ok');
        return true;
      } catch (err) { showError(err); return false; }
    });
  });

  document.getElementById('chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const bodyEl = document.getElementById('chatBody');
    const body = bodyEl.value.trim();
    if (!state.dispatchDriverId || (!body && !stagedFile)) return;
    try {
      if (stagedFile) {
        const fd = new FormData();
        fd.append('file', stagedFile);
        if (body) fd.append('body', body);
        await api('/api/admin/messages/' + state.dispatchDriverId + '/attachment', { method: 'POST', body: fd });
        stagedFile = null;
        fileInput.value = '';
        renderChip();
      } else {
        await api('/api/admin/messages/' + state.dispatchDriverId, { method: 'POST', body: JSON.stringify({ body }) });
      }
      bodyEl.value = '';
      await loadThread();
      refreshConvos();
    } catch (err) { showError(err); }
  });

  try {
    const wp = await api('/api/admin/chat-wallpaper');
    state.chatWpServerUrl = wp && wp.url ? wp.url : null;
  } catch { state.chatWpServerUrl = null; }
  await refreshConvos();
  await loadThread();
  applyWallpaper();
  const thread = document.getElementById('chatMsgs');
  if (thread) thread.scrollTop = thread.scrollHeight;
  pollAdminNotifications();
  addTimer(async () => { await refreshConvos(); await loadThread(); }, 15000);
}

/* ---------- Locations (live map) ---------- */
async function viewLocations(main) {
  document.body.classList.add('loc-bg'); // daytime highway photo + liquid glass (removed on view switch)
  ensureLocBgLayer();
  main.innerHTML = '<div class="loc-page">' +
    '<div class="loc-head"><div class="loc-head-text"><h1>Tracking</h1><p class="muted">Live locations of your drivers — last known position shows even after a driver signs out. Refreshes every 10 seconds. The road colours on the map are live traffic.</p></div>' +
    '<button class="btn loc-add-broker" id="addBrokerBtn" type="button">+ Add broker</button></div>' +
    '<div class="loc-layout" id="locLayout">' +
      '<div class="loc-map-panel"><div id="map"></div><p class="small loc-map-note" id="locMapNote" style="display:none"></p></div>' +
      '<div class="loc-search"><input id="locSearch" type="search" placeholder="Search driver — name, truck, trailer or city" autocomplete="off"></div>' +
      '<p class="loc-nomatch" id="locNoMatch" style="display:none">No driver matches that search.</p>' +
      '<p class="empty loc-empty" id="locEmpty" style="display:none">No driver locations yet — a location appears once a driver signs in and shares theirs.</p>' +
    '</div>' +
    '<div class="loc-brokers" id="locBrokers"></div></div>';
  state.locMap = null;
  state.locMapMarkers = [];
  state.locTraffic = null;
  state.locMapFitted = false;
  const LIVE_MS = 15 * 60 * 1000; // same freshness window as the dashboard's live dot
  const compass = (h) => {
    if (typeof h !== 'number') return '—';
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(h / 45) % 8] + ' (' + Math.round(h) + '°)';
  };
  const speedText = (l) => (typeof l.speedMph === 'number' ? Math.round(l.speedMph) + ' mph' : '—');
  const isLive = (l) => !!(l && l.updatedAt && (Date.now() - Date.parse(l.updatedAt) < LIVE_MS));
  const fmtMiles = (v) => Number(v).toLocaleString('en-US');
  // Clicking a driver card selects that driver: the card lights up gold,
  // his pin grows a gold ring, the map centers on him (traffic stays on)
  // and his popup opens. Clicking anywhere else pops the selection out.
  // The selection survives the 10s refresh (the popup is re-opened on
  // the rebuilt marker).
  let selectedDriverId = null;
  let searchQuery = '';
  let lastLocs = [];
  const byDriver = {}; // driverId -> { loc, marker }
  const layout = document.getElementById('locLayout');
  // The map panel spans grid rows sized by the search bar and the first
  // card, so its height changes as cards render / the search filters /
  // the window resizes — nudge Google Maps to resize (keeping the
  // center) or it can paint grey or clipped.
  const nudgeMap = () => {
    if (!state.locMap || !window.google || !google.maps) return;
    const c = state.locMap.getCenter();
    google.maps.event.trigger(state.locMap, 'resize');
    if (c) state.locMap.setCenter(c);
  };
  state.locNudgeMap = nudgeMap;
  if (!state.locResizeBound) {
    state.locResizeBound = true;
    window.addEventListener('resize', () => {
      if (state.adminView === 'locations' && state.locNudgeMap) state.locNudgeMap();
    });
  }
  const openDriverPopup = (l, marker) => {
    if (state.locInfo) state.locInfo.close();
    state.locInfo = new google.maps.InfoWindow({
      content: '<div style="color:#111827;font-size:14px;line-height:1.55;min-width:200px"><strong>' + esc(l.driverName || ('Driver ' + l.driverId)) + '</strong><br>Near: <span id="loc-iw-city-' + l.driverId + '">Locating…</span><br>Speed: ' + speedText(l) + '<br>Heading: ' + compass(l.heading) + '<br>Last update: ' + esc(fmtDate(l.updatedAt)) + '</div>',
    });
    state.locInfo.open(state.locMap, marker);
    getCityState(l.lat, l.lng).then(place => {
      const cel = document.getElementById('loc-iw-city-' + l.driverId);
      if (cel) cel.textContent = place || '—';
    });
  };
  const paintSelection = () => {
    if (layout) layout.querySelectorAll('.loc-card').forEach(card => {
      card.classList.toggle('selected', Number(card.dataset.driverId) === selectedDriverId);
    });
    Object.keys(byDriver).forEach(id => {
      const rec = byDriver[id];
      if (rec && rec.marker) rec.marker.setIcon(driverPinIcon(rec.loc.driverName || '', rec.loc.driverId, Number(id) === selectedDriverId));
    });
  };
  const selectDriver = (driverId) => {
    selectedDriverId = driverId;
    paintSelection();
    const hit = byDriver[driverId];
    if (hit && state.locMap) {
      state.locMap.setCenter({ lat: Number(hit.loc.lat), lng: Number(hit.loc.lng) });
      state.locMap.setZoom(15);
      openDriverPopup(hit.loc, hit.marker);
    }
    nudgeMap();
  };
  const deselectDriver = () => {
    if (selectedDriverId === null) return;
    selectedDriverId = null;
    paintSelection();
    if (state.locInfo) state.locInfo.close();
    nudgeMap();
  };
  const cardHtml = (l) => {
    const live = isLive(l);
    const units = [l.truckUnit ? 'Truck ' + l.truckUnit : null, l.trailerUnit ? 'Trailer ' + l.trailerUnit : null].filter(Boolean).join(' · ') || 'No truck / trailer assigned';
    const search = (String(l.driverName || '') + ' truck ' + (l.truckUnit || '') + ' trailer ' + (l.trailerUnit || '')).toLowerCase();
    const odo = (l.odometerMi === null || l.odometerMi === undefined)
      ? '<div class="loc-mileage-v">—</div>'
      : '<div class="loc-mileage-v">' + fmtMiles(l.odometerMi) + ' <span>mi</span></div>';
    const caption = 'Live from TRC eLOGS — the truck\'s ELD odometer' + (l.odometerUpdatedAt ? ' · ' + esc(fmtDate(l.odometerUpdatedAt)) : '');
    return '<article class="loc-card' + (selectedDriverId !== null && l.driverId === selectedDriverId ? ' selected' : '') + '" data-driver-id="' + l.driverId + '" data-search="' + esc(search) + '">' +
      '<div class="loc-card-head"><div class="loc-card-id"><h3>' + esc(l.driverName || ('Driver ' + l.driverId)) + '</h3><div class="loc-units">' + esc(units) + '</div></div>' +
      '<span class="status-pill' + (live ? '' : ' off') + '"><span class="dot"></span>' + (live ? 'Driving' : 'Offline') + '</span></div>' +
      '<div class="loc-speed"><span class="loc-speed-num">' + (typeof l.speedMph === 'number' ? Math.round(l.speedMph) : '—') + '</span><span class="loc-speed-unit">mph</span><span class="loc-speed-label">SPEED</span></div>' +
      '<div class="loc-meta">' +
        '<div><span class="k">Near</span><span class="city-slot" data-city-lat="' + esc(l.lat) + '" data-city-lng="' + esc(l.lng) + '">Locating…</span></div>' +
        '<div><span class="k">Coordinates</span>' + esc(Number(l.lat).toFixed(5)) + ', ' + esc(Number(l.lng).toFixed(5)) + '</div>' +
        '<div><span class="k">Heading</span>' + compass(l.heading) + '</div>' +
        '<div><span class="k">Last update</span>' + esc(fmtDate(l.updatedAt)) + '</div>' +
      '</div>' +
      '<div class="loc-mileage"><div class="loc-mileage-k">TRUCK MILEAGE · LIVE</div>' + odo +
      '<div class="loc-mileage-cap">' + caption + '</div></div>' +
    '</article>';
  };
  // Cards are direct children of the grid layout (after the placed map
  // panel and search bar), so they auto-flow in API order: first card
  // beside the map, the rest underneath it two per row. Filtered-out
  // cards are display:none, so the visible ones reflow with no gaps.
  const renderCards = (locs) => {
    if (!layout) return;
    layout.querySelectorAll('.loc-card').forEach(el => el.remove());
    const anchor = document.getElementById('locNoMatch');
    if (locs.length && anchor) anchor.insertAdjacentHTML('beforebegin', locs.map(cardHtml).join(''));
    const empty = document.getElementById('locEmpty');
    if (empty) empty.style.display = locs.length ? 'none' : '';
    fillCitySlots();
    applyFilter();
  };
  const applyFilter = () => {
    if (!layout) return;
    const q = searchQuery.trim().toLowerCase();
    let visible = 0;
    layout.querySelectorAll('.loc-card').forEach(card => {
      const hit = !q || (card.dataset.search || '').includes(q) || card.textContent.toLowerCase().includes(q);
      card.style.display = hit ? '' : 'none';
      const rec = byDriver[Number(card.dataset.driverId)];
      if (rec && rec.marker) rec.marker.setVisible(hit);
      if (hit) visible += 1;
    });
    const noMatch = document.getElementById('locNoMatch');
    if (noMatch) noMatch.style.display = (q && lastLocs.length && visible === 0) ? '' : 'none';
    if (selectedDriverId !== null) {
      const sel = layout.querySelector('.loc-card[data-driver-id="' + selectedDriverId + '"]');
      if (!sel || sel.style.display === 'none') deselectDriver();
    }
    nudgeMap();
  };
  const loadLocs = async () => {
    if (state.adminView !== 'locations') return;
    try {
      const locs = await api('/api/admin/locations');
      const list = Array.isArray(locs) ? locs : [];
      lastLocs = list;
      const mapEl = document.getElementById('map');
      if (mapEl && !state.locMap) {
        const g = await ensureGoogleMaps();
        if (!g) {
          mapEl.style.display = 'none';
          const note = document.getElementById('locMapNote');
          if (note) { note.style.display = 'block'; note.textContent = 'Map unavailable — Google Maps is not set up yet (the map key is missing). Driver locations are shown in the cards.'; }
        } else {
          state.locMap = new g.Map(mapEl, { center: { lat: 39.7684, lng: -86.1581 }, zoom: 5, mapTypeId: 'hybrid', streetViewControl: false });
          // Live traffic ON by default: green / amber / red road colours
          // show at a glance whether a driver is stuck in traffic. The
          // built-in Map | Satellite control stays available.
          state.locTraffic = new google.maps.TrafficLayer();
          state.locTraffic.setMap(state.locMap);
          // The panel reaches its final size only after the grid lays
          // out — resize the map into it or it can paint grey.
          requestAnimationFrame(nudgeMap);
          setTimeout(nudgeMap, 350);
        }
      }
      renderCards(list);
      if (state.locMap && window.google && google.maps) {
        (state.locMapMarkers || []).forEach(m => m.setMap(null));
        state.locMapMarkers = [];
        for (const k of Object.keys(byDriver)) delete byDriver[k];
        const bounds = new google.maps.LatLngBounds();
        list.forEach(l => {
          if (l.lat === undefined || l.lng === undefined) return;
          const pos = { lat: Number(l.lat), lng: Number(l.lng) };
          const marker = new google.maps.Marker({
            position: pos, map: state.locMap, title: l.driverName || ('Driver ' + l.driverId),
            icon: driverPinIcon(l.driverName || '', l.driverId, selectedDriverId !== null && l.driverId === selectedDriverId),
          });
          marker.addListener('click', () => selectDriver(l.driverId));
          state.locMapMarkers.push(marker);
          byDriver[l.driverId] = { loc: l, marker };
          bounds.extend(pos);
        });
        applyFilter(); // sync marker visibility with the search box
        if (selectedDriverId !== null && byDriver[selectedDriverId]) {
          // Keep the selected driver's popup open across refreshes, but
          // don't re-center — the user may have panned the map.
          openDriverPopup(byDriver[selectedDriverId].loc, byDriver[selectedDriverId].marker);
        } else if (!state.locMapFitted && state.locMapMarkers.length === 1) {
          state.locMap.setCenter(state.locMapMarkers[0].getPosition()); state.locMap.setZoom(12); state.locMapFitted = true;
        } else if (!state.locMapFitted && state.locMapMarkers.length > 1) {
          state.locMap.fitBounds(bounds); state.locMapFitted = true;
        }
        nudgeMap();
      }
    } catch (e) { showError(e); }
  };
  // Card clicks select the driver; clicks anywhere else in the layout
  // (but not on the map itself or in the search box) pop the selection
  // out — the same behaviour as the approved preview.
  layout.addEventListener('click', (e) => {
    const card = e.target.closest('.loc-card');
    if (card) { selectDriver(Number(card.dataset.driverId)); return; }
    if (e.target.closest('.loc-map-panel') || e.target.closest('.loc-search')) return;
    deselectDriver();
  });
  const searchInput = document.getElementById('locSearch');
  if (searchInput) searchInput.addEventListener('input', () => { searchQuery = searchInput.value || ''; applyFilter(); });
  const addBrokerBtn = document.getElementById('addBrokerBtn');
  if (addBrokerBtn) addBrokerBtn.addEventListener('click', () => openBrokerModal());
  renderBrokerAccesses();
  await loadLocs();
  addTimer(loadLocs, 10000);
}

/* ---------- Broker tracking access (Tracking page) ---------- */
// The list under the map: every live broker link, with copy + delete.
// Access ends on its own when the load completes; Delete ends it now.
async function renderBrokerAccesses() {
  const host = document.getElementById('locBrokers');
  if (!host) return;
  let rows = [];
  try { rows = await api('/api/admin/broker-access'); } catch { host.innerHTML = ''; return; }
  if (!rows.length) {
    host.innerHTML = '<h2 class="loc-brokers-title">Broker access</h2>' +
      '<p class="muted">No broker has tracking access right now. Use <strong>+ Add broker</strong> to give a broker a link that shows only their driver&rsquo;s live location for their load.</p>';
    return;
  }
  host.innerHTML = '<h2 class="loc-brokers-title">Broker access</h2>' + rows.map((a) => {
    const full = location.origin + a.url;
    const ended = a.loadStatus === 'completed';
    return '<div class="broker-card">' +
      '<div class="broker-main"><strong>' + esc(a.brokerName) + '</strong>' +
      (a.brokerCompany ? ' <span class="muted">&middot; ' + esc(a.brokerCompany) + '</span>' : '') +
      '<div class="muted small">Driver: ' + esc(a.driverName || '') + (a.loadReference ? ' &middot; Load ' + esc(a.loadReference) : ' &middot; driver&rsquo;s active load') +
      (ended ? ' &middot; <span class="broker-ended">Load completed &mdash; tracking ended</span>' : ' &middot; <span class="broker-live">Live</span>') + '</div>' +
      '<div class="muted small">Created ' + esc(fmtDate(a.createdAt)) + (a.lastViewedAt ? ' &middot; Last opened ' + esc(fmtDate(a.lastViewedAt)) : ' &middot; Not opened yet') + '</div></div>' +
      '<div class="broker-actions"><input class="broker-link" readonly value="' + esc(full) + '">' +
      '<button class="btn small" data-copy-broker="' + a.id + '" type="button">Copy link</button>' +
      '<button class="btn danger small" data-delete-broker="' + a.id + '" type="button">Delete</button></div>' +
      '</div>';
  }).join('') +
    '<p class="muted small">Access ends on its own when the load is completed. Deleting ends it right away &mdash; the broker&rsquo;s link stops working immediately.</p>';
  host.querySelectorAll('[data-copy-broker]').forEach((btn) => btn.addEventListener('click', async () => {
    const input = btn.parentElement.querySelector('.broker-link');
    try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
    toast('Tracking link copied.', 'ok');
  }));
  host.querySelectorAll('[data-delete-broker]').forEach((btn) => btn.addEventListener('click', async () => {
    const a = rows.find((r) => r.id === Number(btn.dataset.deleteBroker));
    if (!confirm('Delete tracking access for ' + (a ? a.brokerName : 'this broker') + '? Their link stops working right away.')) return;
    try {
      await api('/api/admin/broker-access/' + btn.dataset.deleteBroker, { method: 'DELETE' });
      toast('Broker access deleted.', 'ok');
      renderBrokerAccesses();
    } catch (e) { showError(e); }
  }));
}

function closeBrokerModal() { const m = document.getElementById('brokerModal'); if (m) m.remove(); }

async function openBrokerModal() {
  closeBrokerModal();
  let drivers = [], loads = [];
  try {
    [drivers, loads] = await Promise.all([api('/api/admin/drivers'), api('/api/admin/loads')]);
  } catch (e) { showError(e); return; }
  const modal = document.createElement('div');
  modal.id = 'brokerModal';
  modal.className = 'docs-modal-backdrop';
  modal.innerHTML = '<div class="docs-modal broker-modal"><div class="docs-modal-head"><strong>Give a broker tracking access</strong>' +
    '<button class="icon-btn" id="brokerClose" type="button" aria-label="Close">&#10005;</button></div>' +
    '<p class="muted small" style="margin:0 0 10px">The broker gets a private link showing only this driver&rsquo;s live location for this load &mdash; no login, nothing else in the portal. Access ends on its own when the load completes; you can delete it anytime.</p>' +
    '<form id="brokerForm" class="broker-form">' +
    '<label>Broker name<input id="brokerName" required placeholder="e.g. Sonja Ross"></label>' +
    '<label>Company <span class="muted">(optional)</span><input id="brokerCompany" placeholder="e.g. D &amp; L Transport"></label>' +
    '<label>Driver<select id="brokerDriver" required>' + drivers.map((d) => '<option value="' + d.id + '">' + esc(d.name) + '</option>').join('') + '</select></label>' +
    '<label>Load<select id="brokerLoad"></select></label>' +
    '<p class="error" id="brokerError" style="display:none"></p>' +
    '<div class="broker-form-actions"><button class="btn btn-ghost" id="brokerCancel" type="button">Cancel</button>' +
    '<button class="btn" type="submit">Create access</button></div></form></div>';
  document.body.appendChild(modal);
  const loadSel = modal.querySelector('#brokerLoad');
  const fillLoads = () => {
    const did = Number(modal.querySelector('#brokerDriver').value);
    const mine = loads.filter((l) => l.driverId === did);
    const active = mine.filter((l) => l.status === 'active');
    const rest = mine.filter((l) => l.status !== 'active');
    loadSel.innerHTML = '<option value="">Driver&rsquo;s active load (automatic)</option>' +
      active.map((l) => '<option value="' + l.id + '">' + esc(l.reference) + ' &mdash; active</option>').join('') +
      rest.map((l) => '<option value="' + l.id + '">' + esc(l.reference) + ' &mdash; ' + esc(l.status) + '</option>').join('');
  };
  fillLoads();
  modal.querySelector('#brokerDriver').addEventListener('change', fillLoads);
  modal.querySelector('#brokerClose').addEventListener('click', closeBrokerModal);
  modal.querySelector('#brokerCancel').addEventListener('click', closeBrokerModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeBrokerModal(); });
  modal.querySelector('#brokerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = modal.querySelector('#brokerError');
    try {
      await api('/api/admin/broker-access', {
        method: 'POST',
        body: JSON.stringify({
          brokerName: modal.querySelector('#brokerName').value,
          brokerCompany: modal.querySelector('#brokerCompany').value,
          driverId: Number(modal.querySelector('#brokerDriver').value),
          loadId: loadSel.value ? Number(loadSel.value) : null,
        }),
      });
      closeBrokerModal();
      toast('Broker access created &mdash; copy the link from the list below.', 'ok');
      renderBrokerAccesses();
    } catch (err2) {
      errEl.textContent = err2.message || 'Could not create access';
      errEl.style.display = 'block';
    }
  });
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
  const list = (Array.isArray(rcs) ? rcs : []).slice().sort((a, b) => String(b.pickupDate || '').localeCompare(String(a.pickupDate || '')));
  const loadList = (Array.isArray(loads) ? loads : []).filter(l => l && l.reference);
  const shortPlace = (a) => (a || '').split(',').pop().replace(/\s*\d{5}(-\d{4})?\s*$/, '').trim();
  const stateOf = (a) => { const m = (a || '').match(/\b([A-Z]{2})\s+\d{5}/); return m ? m[1] : ''; };
  const dateOf = (iso, tz) => {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Indiana/Indianapolis', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); }
    catch { return (iso || '').slice(0, 10); }
  };
  const previewName = (l, ext) => l ? l.reference + '_' + stateOf(l.pickupLocation) + '-' + stateOf(l.deliveryLocation) + '_' + dateOf(l.pickupAt, l.pickupTimezone) + '_to_' + dateOf(l.deliveryAt, l.deliveryTimezone) + '.' + (ext || 'pdf') : '';
  const loadOptions = loadList.map(l => '<option value="' + l.id + '">' + esc(l.reference) + ' · ' + esc(shortPlace(l.pickupLocation)) + ' → ' + esc(shortPlace(l.deliveryLocation)) + '</option>').join('');
  // Option B + D stats (owner's pick 2026-11-15): totals over ALL rate
  // cons — booked total, how many, and the average load.
  const totalCents = list.reduce((s, r) => s + (Number(r.rateCents) || 0), 0);
  const avgCents = list.length ? Math.round(totalCents / list.length) : 0;
  const chipOf = (name) => {
    const n = String(name || '').trim();
    if (!n) return '—';
    const m = n.match(/([A-Za-z])\s*&\s*([A-Za-z])/);
    if (m) return (m[1] + '&' + m[2]).toUpperCase();
    const words = n.replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(Boolean);
    return (((words[0] || '')[0] || '') + ((words[1] || '')[0] || '')).toUpperCase() || '—';
  };
  const rcStats = '<div class="rc-stats">' +
    '<div class="rc-stat"><div class="num">' + fmtMoney(totalCents) + '</div><div class="lab">Booked total</div></div>' +
    '<div class="rc-stat"><div class="num">' + list.length + '</div><div class="lab">Rate cons</div></div>' +
    '<div class="rc-stat"><div class="num">' + fmtMoney(avgCents) + '</div><div class="lab">Average load</div></div></div>';
  main.innerHTML = '<div class="rc-page"><div class="rc-head"><h1>Rate Confirmations</h1><button class="btn" id="rcAddBtn" aria-expanded="false">+ Add RC</button></div>' + rcStats + '<div id="rcAddWrap" style="display:none">' +
    '<div class="card"><h2>Upload rate confirmation</h2>' +
    '<form id="rcForm">' +
    '<div class="form-row">' +
    '<div class="field"><label>File *</label><input type="file" name="file" id="rcFile" required></div>' +
    '<div class="field"><label>Load</label><select name="loadId" id="rcLoad"><option value="">✨ Create the load automatically from this RC</option>' + loadOptions + '</select></div>' +
    '</div><p class="small muted">Auto: the system reads the RC and creates the load — LXL reference, pickup and delivery city/state, driver from the RC — and the file is renamed to <code id="rcPreview"></code>. Or pick an existing load to attach it to.</p>' +
    '<div class="form-actions"><button class="btn" type="submit">Upload</button></div>' +
    '<p id="rcResult" class="small mt"></p></form>' +
    '</div>' +
    '<div class="card"><h2>From Outlook email</h2>' +
    (outlook && outlook.configured
      ? (outlook.connected
        ? '<p class="small">Connected as <strong>' + esc(outlook.email || '') + '</strong> — pick the RC email, then the file.</p>' +
          '<div class="form-actions"><button class="btn btn-sm" id="outlookPick">Pick from Outlook</button> <button class="btn btn-sm" id="rcImportAll">Import ALL rate confirmations</button> <button class="btn btn-ghost btn-sm" id="outlookDisconnect">Disconnect</button></div>' +
          '<p id="rcImportStatus" class="small mt"></p>'
        : '<p class="small muted">Connect your Outlook mailbox — then the RC comes straight from the email you pick, no downloading.</p>' +
          '<div class="form-actions"><button class="btn btn-sm" id="outlookConnect">Connect Outlook</button></div>')
      : '<p class="small muted">Outlook email is not set up on the server yet.</p>') +
    '<div id="outlookPicker" style="display:none" class="mt"></div>' +
    '<p id="outlookChosen" class="small mt"></p></div></div>' +
    '<div class="card"><div class="rc-search"><input id="rcSearch" type="search" placeholder="Search rate confirmations — reference, broker, route…"></div><div class="rc-rows">' +
    list.map(r => '<div class="rc-row" data-rc-row>' +
      '<span class="rc-chip">' + esc(chipOf(r.broker)) + '</span>' +
      '<span class="rc-ref">' + esc(r.reference) + '</span>' +
      '<span class="rc-broker">' + esc(r.broker || '—') + '</span>' +
      '<span class="rc-route">' + esc(r.pickupState) + ' → ' + esc(r.deliveryState) + '</span>' +
      '<span class="rc-dates">' + fmtDateOnly(r.pickupDate) + ' → ' + fmtDateOnly(r.deliveryDate) + '</span>' +
      '<span class="rc-file">' + esc(r.filename || '') + '</span>' +
      '<span class="rc-rate">' + fmtMoney(r.rateCents) + '</span>' +
      '<span class="rc-btns"><button class="btn btn-ghost btn-sm" data-rc-view="' + r.id + '">View</button> ' +
      '<button class="btn btn-ghost btn-sm" data-rc-dl="' + r.id + '">Download</button> ' +
      '<button class="btn btn-danger btn-sm" data-rc-del="' + r.id + '">Delete</button></span></div>').join('') +
    '</div><p class="empty" id="rcNoMatch" style="display:none">No rate confirmations match your search.</p>' + (list.length ? '' : '<p class="empty">No rate confirmations yet.</p>') + '</div></div>';

  const rcForm = document.getElementById('rcForm');
  if (rcForm) {
    const updatePreview = () => {
      const sel = document.getElementById('rcLoad');
      const f = document.getElementById('rcFile');
      const l = loadList.find(x => String(x.id) === (sel && sel.value));
      const pickedName = (state.rcOutlook && state.rcOutlook.name) || (f && f.files && f.files[0] ? f.files[0].name : '');
      const ext = pickedName ? (pickedName.split('.').pop() || 'pdf') : 'pdf';
      const pv = document.getElementById('rcPreview');
      if (pv) pv.textContent = l ? previewName(l, ext) : '(named from the RC)';
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
        const loadMsg = res && res.loadReference ? (res.loadCreated ? ' Load ' + res.loadReference + ' created: ' + (res.loadRoute || '') + '.' : ' Attached to load ' + res.loadReference + '.') : '';
        document.getElementById('rcResult').textContent = (saved ? 'Saved as: ' + saved : 'Uploaded.') + loadMsg;
        toast('Rate confirmation uploaded' + (saved ? ' as ' + saved : '') + '.' + loadMsg, 'ok');
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
  const rcStatusEl = document.getElementById('rcImportStatus');
  if (rcStatusEl && rcImportDoneMsg) rcStatusEl.textContent = rcImportDoneMsg;
  const rcImportAll = document.getElementById('rcImportAll');
  if (rcImportAll) rcImportAll.addEventListener('click', async () => {
    const status = document.getElementById('rcImportStatus');
    rcImportAll.disabled = true;
    const tot = { imported: 0, loadsCreated: 0, alreadyHave: 0, notRc: 0, skipped: 0, heldOut: 0, unverified: 0, bolsAdded: 0, bolsDuplicate: 0, bolsUnmatched: 0 };
    const skippedSubjects = [];
    const heldOutSubjects = [];
    const bolsUnmatchedSubjects = [];
    let cursor = null;
    let mailboxes = [];
    let schedules = 0;
    let paidLoads = 0;
    let lastPhase = 'sched';
    let lastSkip = '';
    let finished = false;
    try {
      for (let round = 0; round < 5000; round++) {
        if (status) status.textContent = 'Working… ' + ({ sched: 'reading OTR schedules to build the paid-load list', rc: 'importing rate confirmations', bol: 'filing BOLs into the loads' }[lastPhase] || lastPhase) + '. So far: ' + tot.imported + ' imported, ' + tot.loadsCreated + ' loads created, ' + tot.heldOut + ' held out, ' + tot.bolsAdded + ' BOLs filed. Paid loads found: ' + paidLoads + '.' + (lastSkip ? ' Last skipped: ' + lastSkip : '');
        const r = await api('/api/admin/rate-confirmations/import-all', { method: 'POST', body: JSON.stringify({ cursor }) });
        tot.imported += r.imported || 0;
        tot.loadsCreated += r.loadsCreated || 0;
        tot.alreadyHave += r.alreadyHave || 0;
        tot.notRc += r.notRc || 0;
        tot.skipped += r.skipped || 0;
        tot.heldOut += r.heldOut || 0;
        tot.unverified += r.unverified || 0;
        tot.bolsAdded += r.bolsAdded || 0;
        tot.bolsDuplicate += r.bolsDuplicate || 0;
        tot.bolsUnmatched += r.bolsUnmatched || 0;
        (r.bolsUnmatchedSubjects || []).forEach((x) => { if (bolsUnmatchedSubjects.length < 10) bolsUnmatchedSubjects.push(x); });
        (r.skippedSubjects || []).forEach((x) => { if (skippedSubjects.length < 10) skippedSubjects.push(x); });
        (r.heldOutSubjects || []).forEach((x) => { if (heldOutSubjects.length < 10) heldOutSubjects.push(x); });
        if (Array.isArray(r.mailboxes) && r.mailboxes.length) mailboxes = r.mailboxes;
        if (typeof r.schedules === 'number') schedules = r.schedules;
        if (typeof r.paidLoads === 'number') paidLoads = r.paidLoads;
        cursor = r.nextCursor;
        if (r.phase) lastPhase = r.phase;
        if (r.lastSkip) lastSkip = r.lastSkip;
        if (r.done || !cursor) { finished = true; break; }
      }
      if (!finished) {
        if (status) status.textContent = 'Still working — the import is not finished yet. Click "Import ALL rate confirmations" again and it continues where it left off (nothing is ever imported twice). Progress so far: ' + tot.imported + ' imported, ' + tot.loadsCreated + ' loads created, ' + tot.heldOut + ' held out, ' + tot.bolsAdded + ' BOLs filed.';
        rcImportAll.disabled = false;
        return;
      }
      if (status) status.textContent = 'Done — scanned mailbox(es): ' + (mailboxes.join(', ') || 'none connected') + '. ' +
        'Found ' + schedules + ' OTR schedules covering ' + paidLoads + ' paid loads. ' +
        'Imported ' + tot.imported + ' rate confirmations and created ' + tot.loadsCreated + ' past loads (completed, assigned to their drivers). ' +
        (tot.unverified ? tot.unverified + ' of them were not on any OTR schedule (imported on your say-so — a cancelled one can be deleted from its load). ' : '') +
        tot.alreadyHave + ' were already there (a duplicate is never imported twice). ' +
        (tot.heldOut ? tot.heldOut + ' rate confirmations were LEFT OUT — no load number could be read from them' + (heldOutSubjects.length ? ': ' + heldOutSubjects.join(' · ') : '') + '. ' : '') +
        tot.notRc + ' emails were not rate confirmations.' +
        (tot.bolsAdded || tot.bolsUnmatched ? ' Added ' + tot.bolsAdded + ' BOLs into the loads\' Documents' + (tot.bolsDuplicate ? ' (' + tot.bolsDuplicate + ' duplicate BOLs skipped)' : '') + (tot.bolsUnmatched ? '; ' + tot.bolsUnmatched + ' BOL emails could not be matched to an imported load' + (bolsUnmatchedSubjects.length ? ': ' + bolsUnmatchedSubjects.join(' · ') : '') : '') + '. ' : '') +
        (tot.skipped ? ' ' + tot.skipped + ' could not be read fully' + (skippedSubjects.length ? ': ' + skippedSubjects.join(' · ') : '') + '.' : '');
      rcImportDoneMsg = status ? status.textContent : '';
      toast('Import finished: ' + tot.imported + ' rate confirmations, ' + tot.loadsCreated + ' loads created, ' + tot.heldOut + ' held out.', 'ok');
      setTimeout(() => renderAdminView('ratecons'), 2500);
    } catch (err) { showError(err); if (status) status.textContent = 'Import stopped — you can run it again, already-imported ones are skipped.'; }
    rcImportAll.disabled = false;
  });

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
            toast('Attachment selected — press Upload: the load is created automatically from the RC, or pick a load first to attach it.', 'ok');
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
  // Search the list: reference, broker, route, dates, rate, filename.
  // Normalizes both sides so "dandl" finds "D & L" (the & reads as "and").
  const norm = s => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]/g, '');
  const rcSearch = document.getElementById('rcSearch');
  if (rcSearch) rcSearch.addEventListener('input', () => {
    const q = norm(rcSearch.value.trim());
    let visible = 0;
    main.querySelectorAll('[data-rc-row]').forEach(row => {
      const hit = !q || norm(row.textContent).includes(q);
      row.style.display = hit ? '' : 'none';
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
  ['dispatch', 'Chat'],
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
  state.driverView = view;
  try { localStorage.setItem('lxl_driver_view', view); } catch (e) {}
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

function stopDetailLine(label, s) {
  return '<div class="small" style="margin-top:4px"><strong>' + label + ':</strong> ' + esc(s.warehouse || s.location) +
    (s.warehouse ? ' <span class="muted">(' + esc(s.location) + ')</span>' : '') +
    (s.at ? ' &middot; ' + fmtDate(s.at) : '') + (s.number ? ' &middot; Ref: ' + esc(s.number) : '') + '</div>';
}

function activeLoadHtml(l) {
  return '<p><strong>' + esc(l.reference) + '</strong> · <span class="pill ' + (l.bolStatus === 'wrong' ? 'red' : l.bolStatus === 'clean' ? 'green' : 'blue') + '">BOL: ' + esc(l.bolStatus || 'pending') + '</span></p>' +
    '<div class="grid2">' +
    '<div class="detail-box"><div class="k">Pickup</div><div class="v" style="font-size:16px">' + esc(l.pickupWarehouse || l.pickupLocation) + '</div><div class="muted small">' + (l.pickupWarehouse ? esc(l.pickupLocation) + '<br>' : '') + fmtDate(l.pickupAt) + (l.pickupNumber ? '<br>Ref: ' + esc(l.pickupNumber) : '') + '</div></div>' +
    '<div class="detail-box"><div class="k">Delivery</div><div class="v" style="font-size:16px">' + esc(l.deliveryWarehouse || l.deliveryLocation) + '</div><div class="muted small">' + (l.deliveryWarehouse ? esc(l.deliveryLocation) + '<br>' : '') + fmtDate(l.deliveryAt) + (l.deliveryNumber ? '<br>Ref: ' + esc(l.deliveryNumber) : '') + '</div></div>' +
    '</div>' +
    (l.stops && (l.stops.pickups.length > 1 || l.stops.deliveries.length > 1)
      ? '<div class="detail-box mt"><div class="k">All stops</div>' + [...l.stops.pickups.map((s, i) => stopDetailLine('Pickup ' + (i + 1), s)), ...l.stops.deliveries.map((s, i) => stopDetailLine('Delivery ' + (i + 1), s))].join('') + '</div>'
      : '') +
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
  main.innerHTML = '<h1>Chat</h1><div class="card">' +
    '<div class="flex-between"><span class="muted small">Your chat with dispatch</span>' +
    '<span><button class="chat-wp-btn" id="drvWpBtn" type="button">🖼 Wallpaper</button>' +
    '<button class="chat-wp-btn" id="drvWpReset" type="button" disabled>✕ Remove</button></span></div>' +
    '<input type="file" id="drvWpFile" accept="image/*" hidden>' +
    '<div class="msg-list" id="driverThread"><p class="muted">Loading…</p></div>' +
    '<div class="chat-attach-chip" id="drvAttachChip" hidden></div>' +
    '<form id="driverSendForm" class="chat-composer">' +
    '<button class="chat-attach-btn" id="drvAttachBtn" type="button" title="Attach a picture or file">📎</button>' +
    '<input type="file" id="drvFile" hidden>' +
    '<input id="driverBody" placeholder="Type a message to dispatch…" autocomplete="off">' +
    '<button class="btn" type="submit">Send</button></form>' +
    '<p class="muted small">Thread refreshes every 15 seconds.</p></div>';

  let stagedFile = null;
  const threadEl = () => document.getElementById('driverThread');

  const hydrate = (root) => {
    root.querySelectorAll('img[data-att-img]').forEach(async (img) => {
      const url = img.dataset.attImg;
      if (!url || img.dataset.loaded) return;
      img.dataset.loaded = '1';
      try {
        if (!state.attUrlCache) state.attUrlCache = new Map();
        if (!state.attUrlCache.has(url)) {
          const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + state.token } });
          if (!res.ok) return;
          state.attUrlCache.set(url, URL.createObjectURL(await res.blob()));
        }
        img.src = state.attUrlCache.get(url);
      } catch { /* leave the placeholder */ }
    });
  };

  const applyWallpaper = async () => {
    const el = threadEl();
    if (!el) return;
    const url = state.drvWpServerUrl;
    if (!url) { el.style.backgroundImage = ''; return; }
    try {
      if (!state.attUrlCache) state.attUrlCache = new Map();
      if (!state.attUrlCache.has(url)) {
        const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + state.token } });
        if (!res.ok) return;
        state.attUrlCache.set(url, URL.createObjectURL(await res.blob()));
      }
      el.style.backgroundImage = 'linear-gradient(rgba(4, 9, 18, 0.62), rgba(4, 9, 18, 0.62)), url("' + state.attUrlCache.get(url) + '")';
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
    } catch { /* wallpaper is cosmetic */ }
  };

  const loadThread = async () => {
    if (state.driverView !== 'dispatch') return;
    try {
      const msgs = await api('/api/driver/messages');
      const list = Array.isArray(msgs) ? msgs : [];
      const thread = threadEl();
      if (!thread) return;
      thread.innerHTML = list.length ? list.map(m => {
        const mine = m.sender === 'driver';
        let inner = '';
        if (m.attachment) {
          if (m.attachment.mimeType && m.attachment.mimeType.startsWith('image/')) {
            inner += '<img class="chat-img" data-att-img="' + esc(m.attachment.url) + '" data-att-open="' + m.attachment.fileId + '" alt="' + esc(m.attachment.filename || 'Photo') + '">';
          } else {
            inner += '<button class="chat-file" type="button" data-att-open="' + m.attachment.fileId + '">📄 ' + esc(m.attachment.filename || 'File') + '</button>';
          }
        }
        inner += esc(m.body || '');
        const status = mine ? ' · ' + (m.read ? '✓✓ Seen' : '✓ Sent') : '';
        return '<div class="msg' + (mine ? ' mine' : '') + '">' + inner +
          '<div class="meta">' + esc(mine ? 'You' : (m.senderName || 'Dispatch')) + ' · ' + fmtDate(m.createdAt) + status + '</div></div>';
      }).join('') : '<p class="empty">No messages yet. Say hello to dispatch.</p>';
      thread.querySelectorAll('[data-att-open]').forEach(el => el.addEventListener('click', () => {
        const m = list.find(x => x.attachment && x.attachment.fileId === parseInt(el.dataset.attOpen, 10));
        if (m) downloadFile(m.attachment.url, m.attachment.filename, true, m.attachment.mimeType);
      }));
      hydrate(thread);
    } catch (e) { /* keep old thread on transient failure */ }
  };

  const chip = document.getElementById('drvAttachChip');
  const fileInput = document.getElementById('drvFile');
  const renderChip = () => {
    if (!stagedFile) { chip.hidden = true; chip.innerHTML = ''; return; }
    chip.hidden = false;
    chip.innerHTML = '<span>📎 ' + esc(stagedFile.name) + '</span><button type="button" id="drvAttachClear" title="Remove attachment">✕</button>';
    document.getElementById('drvAttachClear').addEventListener('click', () => {
      stagedFile = null;
      fileInput.value = '';
      renderChip();
    });
  };
  document.getElementById('drvAttachBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    stagedFile = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
    renderChip();
  });

  document.getElementById('driverSendForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const bodyEl = document.getElementById('driverBody');
    const body = bodyEl.value.trim();
    if (!body && !stagedFile) return;
    try {
      if (stagedFile) {
        const fd = new FormData();
        fd.append('file', stagedFile);
        if (body) fd.append('body', body);
        await api('/api/driver/messages/attachment', { method: 'POST', body: fd });
        stagedFile = null;
        fileInput.value = '';
        renderChip();
      } else {
        await api('/api/driver/messages', { method: 'POST', body: JSON.stringify({ body }) });
      }
      bodyEl.value = '';
      loadThread();
    } catch (err) { showError(err); }
  });

  document.getElementById('drvWpBtn').addEventListener('click', () => document.getElementById('drvWpFile').click());
  document.getElementById('drvWpFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    openWallpaperEditor(f, async (blob) => {
      try {
        const fd = new FormData();
        fd.append('file', blob, 'chat-wallpaper.jpg');
        const out = await api('/api/driver/chat-wallpaper', { method: 'POST', body: fd });
        state.drvWpServerUrl = out && out.url ? out.url : null;
        document.getElementById('drvWpReset').disabled = !state.drvWpServerUrl;
        if (state.drvWpServerUrl) {
          if (!state.attUrlCache) state.attUrlCache = new Map();
          state.attUrlCache.set(state.drvWpServerUrl, URL.createObjectURL(blob));
        }
        await applyWallpaper();
        toast('Chat wallpaper set.', 'ok');
        return true;
      } catch (err) { showError(err); return false; }
    });
  });
  document.getElementById('drvWpReset').addEventListener('click', async () => {
    try { await api('/api/driver/chat-wallpaper', { method: 'DELETE' }); } catch { /* ignore */ }
    state.drvWpServerUrl = null;
    document.getElementById('drvWpReset').disabled = true;
    applyWallpaper();
  });

  try {
    const wp = await api('/api/driver/chat-wallpaper');
    state.drvWpServerUrl = wp && wp.url ? wp.url : null;
  } catch { state.drvWpServerUrl = null; }
  const resetBtn = document.getElementById('drvWpReset');
  if (resetBtn) resetBtn.disabled = !state.drvWpServerUrl;
  await loadThread();
  applyWallpaper();
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
