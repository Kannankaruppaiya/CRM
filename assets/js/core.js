/* Maruthi Power Control Systems — Unified CRM core runtime (Core API v2).
 * Provides: data store (localStorage + multi-tab sync), master data, roles & permissions, router, nav registry,
 * event bus, per-user notifications, audit log, config store + "Settings & Rules" page, business-hours maths,
 * periodic ticks, attachments (IndexedDB), CSV/PDF export, generic data importer and the shared UI kit.
 * Modules: sales.js (Sales CRM), projects.js (Projects & Supply Chain), service.js (Service, AMC, PM, ODM),
 * executive.js (GM cockpit & role guide). They register pages/seeds/importers/config sections through window.CRM.
 * See docs/ARCHITECTURE.md ("Core API v2") for every signature.
 */
(function () {
  'use strict';

  const STORE_KEY = 'mpcs-crm-v1';
  const COUNTER_KEY = 'mpcs-crm-v1-ids';
  const ROLE_KEY = 'mpcs-crm-role';
  const THEME_KEY = 'mpcs-crm-theme';
  const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);

  // ---------------------------------------------------------------- safe storage
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    remove(k) { try { localStorage.removeItem(k); return true; } catch (e) { return false; } },
  };

  // ---------------------------------------------------------------- dates
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** Parse anything date-like. 'YYYY-MM-DD' and 'DD/MM/YYYY' are LOCAL calendar dates (never UTC). Returns Date or null. */
  function parseDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : new Date(v.getTime());
    if (typeof v === 'number') { const d = new Date(v); return isNaN(d) ? null : d; }
    const s = String(v).trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3]); return d.getMonth() === +m[2] - 1 ? d : null; }
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    if (m) { const d = new Date(+m[3], +m[2] - 1, +m[1]); return d.getMonth() === +m[2] - 1 ? d : null; }
    m = /^(\d{1,2})[\s-]+([A-Za-z]{3,})\.?[\s-]+(\d{4})$/.exec(s);
    if (m) { const mi = MONTHS.findIndex((x) => x.toLowerCase() === m[2].slice(0, 3).toLowerCase()); if (mi >= 0) return new Date(+m[3], mi, +m[1]); }
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }
  const toDate = (v) => parseDate(v) || new Date(NaN);

  // ---------------------------------------------------------------- utils
  const util = {
    uid: () => Math.random().toString(36).slice(2, 10),
    today: () => new Date(TODAY),
    parseDate,
    iso: (d) => { const x = parseDate(d); return !x ? '' : x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); },
    addDays: (d, n) => { const x = toDate(d); x.setDate(x.getDate() + n); return x; },
    /** Add calendar months, clamped to month end: 31 Oct + 4 → 28/29 Feb. */
    addMonths: (d, n) => {
      const x = toDate(d); if (isNaN(x)) return x;
      const day = x.getDate();
      x.setDate(1); x.setMonth(x.getMonth() + Number(n || 0));
      const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
      x.setDate(Math.min(day, last));
      return x;
    },
    addHours: (d, n) => new Date(toDate(d).getTime() + n * 3600e3),
    daysBetween: (a, b) => Math.round((toDate(b) - toDate(a)) / 864e5),
    hoursBetween: (a, b) => Math.round((toDate(b) - toDate(a)) / 36e5 * 10) / 10,
    rand: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
    pick: (arr) => arr[Math.floor(Math.random() * arr.length)],
    sum: (arr, fn) => arr.reduce((s, x) => s + (Number(typeof fn === 'function' ? fn(x) : fn ? x[fn] : x) || 0), 0),
    groupBy: (arr, fn) => arr.reduce((m, x) => { const k = typeof fn === 'function' ? fn(x) : x[fn]; (m[k] = m[k] || []).push(x); return m; }, {}),
    countBy: (arr, fn) => arr.reduce((m, x) => { const k = typeof fn === 'function' ? fn(x) : x[fn]; m[k] = (m[k] || 0) + 1; return m; }, {}),
    pct: (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0),
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    initials: (name) => String(name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase(),
    debounce: (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; },
    clone: (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o))),
    fileSize: (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'),
  };

  const fmt = {
    months: MONTHS,
    /** "25 Oct 2026" */
    date: (d) => { const x = parseDate(d); return x ? x.getDate() + ' ' + MONTHS[x.getMonth()] + ' ' + x.getFullYear() : '—'; },
    /** "10:30 AM" */
    time: (d) => { const x = parseDate(d); if (!x) return '—'; let hr = x.getHours(); const ap = hr < 12 ? 'AM' : 'PM'; hr = hr % 12 || 12; return hr + ':' + String(x.getMinutes()).padStart(2, '0') + ' ' + ap; },
    /** Brand book writing mechanics: "25 Oct 2026 · 10:30 AM" */
    dateTime: (d) => { const x = parseDate(d); return x ? fmt.date(x) + ' · ' + fmt.time(x) : '—'; },
    /** "Oct 2026" */
    month: (d) => { const x = parseDate(d); return x ? MONTHS[x.getMonth()] + ' ' + x.getFullYear() : '—'; },
    money: (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN'),
    lakh: (n) => { n = Number(n) || 0; if (Math.abs(n) >= 1e7) return '₹' + (n / 1e7).toFixed(2) + ' Cr'; if (Math.abs(n) >= 1e5) return '₹' + (n / 1e5).toFixed(2) + ' L'; return fmt.money(n); },
    num: (n) => (Number(n) || 0).toLocaleString('en-IN'),
    pct: (n) => (Math.round((Number(n) || 0) * 10) / 10) + '%',
    rel: (d) => { const x = parseDate(d); if (!x) return '—'; x.setHours(0, 0, 0, 0); const days = util.daysBetween(TODAY, x); if (days === 0) return 'Today'; if (days === 1) return 'Tomorrow'; if (days === -1) return 'Yesterday'; return days > 0 ? 'in ' + days + 'd' : Math.abs(days) + 'd ago'; },
  };

  // ---------------------------------------------------------------- validation
  const validate = {
    phone: (v) => { const s = String(v || '').replace(/[\s()-]/g, ''); return /^(\+?91)?[6-9]\d{9}$/.test(s) || /^0\d{9,11}$/.test(s); },
    email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim()),
    gstin: (v) => /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(String(v || '').trim().toUpperCase()),
    pincode: (v) => /^[1-9]\d{5}$/.test(String(v || '').trim()),
    messages: {
      phone: 'Enter a 10-digit mobile number or a landline with STD code',
      email: 'Enter a valid email address, like name@company.in',
      gstin: 'GSTIN has 15 characters, like 33AABCS1234C1Z5',
      pincode: 'PIN code has 6 digits',
    },
  };

  // ---------------------------------------------------------------- event bus
  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, payload) { (listeners[evt] || []).forEach((fn) => { try { fn(payload); } catch (e) { console.error('[CRM] handler for', evt, e); } }); }

  // ---------------------------------------------------------------- roles
  // Roles consolidated from the Sales, Electronic Security, Solar and Service requirement documents.
  const ROLES = [
    { id: 'admin', name: 'CRM Administrator', group: 'Management', user: 'Karthik R', color: '#5C6066' },
    { id: 'gm', name: 'GM / CEO', group: 'Management', user: 'S. Maruthi', color: '#3A3D42' },
    { id: 'odm', name: 'ODM (Operations)', group: 'Management', user: 'Lakshmi N', color: '#45484D' },
    { id: 'sales_manager', name: 'Sales Manager', group: 'Sales', user: 'Ramesh K', color: '#EC000A' },
    { id: 'sales_coordinator', name: 'Sales Coordinator', group: 'Sales', user: 'Divya S', color: '#B80008' },
    { id: 'sales_exec', name: 'Sales Executive', group: 'Sales', user: 'Arun Kumar', color: '#EC000A' },
    { id: 'accounts', name: 'Accounts Team', group: 'Finance', user: 'Meena P', color: '#45484D' },
    { id: 'es_coordinator', name: 'Electronic Security Coordinator', group: 'Projects', user: 'Vignesh M', color: '#3A3D42' },
    { id: 'solar_coordinator', name: 'Solar Coordinator', group: 'Projects', user: 'Prakash V', color: '#137333' },
    { id: 'doc_coordinator', name: 'Documentation Coordinator', group: 'Projects', user: 'Kavya R', color: '#137333' },
    { id: 'tech_engineer', name: 'Technical Engineer', group: 'Projects', user: 'Suresh B', color: '#45484D' },
    { id: 'tech_head', name: 'Technical Head', group: 'Projects', user: 'Balaji T', color: '#3A3D42' },
    { id: 'purchase', name: 'Purchase Coordinator', group: 'Supply Chain', user: 'Gopi K', color: '#5C6066' },
    { id: 'stores', name: 'Stores / Logistics', group: 'Supply Chain', user: 'Murugan S', color: '#5C6066' },
    { id: 'install_lead', name: 'Installation Team Leader', group: 'Projects', user: 'Senthil A', color: '#45484D' },
    { id: 'vendor', name: 'External Vendor', group: 'External', user: 'Sri Sai Electricals', color: '#5C6066' },
    { id: 'service_coordinator', name: 'Service Coordinator', group: 'Service', user: 'Priya D', color: '#B80008' },
    { id: 'service_engineer', name: 'Service Engineer', group: 'Service', user: 'Manoj V', color: '#EC000A' },
    { id: 'service_centre_tech', name: 'Service Centre Technician', group: 'Service', user: 'Ganesh R', color: '#B80008' },
    { id: 'pm_coordinator', name: 'PM / AMC Coordinator', group: 'Service', user: 'Anitha J', color: '#B80008' },
  ];
  const ROLE_GROUPS = ['Management', 'Sales', 'Finance', 'Projects', 'Supply Chain', 'Service', 'External'];
  const ALL = ROLES.map((r) => r.id);
  const MGMT = ['admin', 'gm', 'odm'];
  /** Roles that may create/edit any customer. A Sales Executive may create customers and edit only those they own (customer.ownerId). */
  const CUSTOMER_EDIT_ROLES = ['admin', 'gm', 'sales_manager', 'sales_coordinator', 'service_coordinator'];

  function currentRoleId() { const r = ls.get(ROLE_KEY); return ROLES.some((x) => x.id === r) ? r : 'gm'; }
  function role(id) { return ROLES.find((r) => r.id === (id || currentRoleId())); }
  function user() {
    const r = role();
    const staff = state ? (db.all('staff').find((s) => s.role === r.id && s.primary) || db.all('staff').find((s) => s.role === r.id)) : null;
    return { id: staff ? staff.id : r.id, name: staff ? staff.name : r.user, role: r.id, roleName: r.name, division: staff ? staff.division : null, area: staff ? staff.area || null : null };
  }
  function is(...roleIds) { return roleIds.flat().includes(currentRoleId()); }

  // ---------------------------------------------------------------- data store
  let state = null;
  let suspended = false;      // true while reset/import reloads the page: nothing may be written
  let saveFailed = false;
  let persistTimer = null;
  let booted = false;
  const seeds = [];
  const counters = {};

  function readCounterKey() { try { return JSON.parse(ls.get(COUNTER_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function mergeCounters(src) { Object.keys(src || {}).forEach((k) => { const n = Number(src[k]) || 0; if (n > (counters[k] || 0)) counters[k] = n; }); }

  function load() {
    let raw = ls.get(STORE_KEY);
    try { state = raw ? JSON.parse(raw) : null; } catch (e) { state = null; }
    if (!state || typeof state !== 'object' || !state.__v) state = { __v: 1, __counters: {} };
    Object.keys(counters).forEach((k) => delete counters[k]);
    mergeCounters(state.__counters);
    mergeCounters(readCounterKey());
    applyMasters();
  }
  function persistNow() {
    clearTimeout(persistTimer); persistTimer = null;
    if (!state || suspended) return;
    state.__counters = counters;
    let ok = false, err = null;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); ok = true; } catch (e) { err = e; }
    setSaveStatus(ok, err);
  }
  function persist() { if (suspended) return; clearTimeout(persistTimer); persistTimer = setTimeout(persistNow, 150); }
  window.addEventListener('pagehide', persistNow);

  function setSaveStatus(ok, err) {
    if (!ok) {
      console.warn('[CRM] could not save', err);
      if (!saveFailed) { saveFailed = true; showBanner('save', 'Changes are not being saved. Browser storage is full or blocked, so anything you change will be lost when you close this tab. Export a backup from Master Data, then free up space.', 'bad'); ui.toast('Changes are not being saved — storage is full or blocked', 'bad'); }
    } else if (saveFailed) { saveFailed = false; hideBanner('save'); ui.toast('Saving works again', 'ok'); }
  }

  function nextId(prefix, width) {
    mergeCounters(readCounterKey()); // another tab may have issued ids since we loaded
    counters[prefix] = (counters[prefix] || 0) + 1;
    ls.set(COUNTER_KEY, JSON.stringify(counters));
    persist();
    return prefix + '-' + String(counters[prefix]).padStart(width || 4, '0');
  }
  /** Raise counters[prefix] to the highest numeric suffix already used in a collection, so generated ids never collide with seeded ones. */
  function bumpCounter(col, prefix) {
    let max = 0;
    db.all(col).forEach((r) => { const m = new RegExp('^' + prefix + '-(\\d+)$').exec(String(r.id)); if (m) max = Math.max(max, Number(m[1])); });
    if (max > (counters[prefix] || 0)) counters[prefix] = max;
  }

  const PREFIX = {
    customers: 'CUS', sites: 'SITE', products: 'PRD', staff: 'EMP', notifications: 'NTF', audit: 'AUD', attachments: 'ATT',
  };

  const db = {
    all(col) { return state[col] || (state[col] = []); },
    get(col, id) { return db.all(col).find((r) => r.id === id) || null; },
    find(col, fn) { return db.all(col).filter(fn); },
    one(col, fn) { return db.all(col).find(fn) || null; },
    insert(col, rec, opts) {
      opts = opts || {};
      const r = Object.assign({}, rec);
      if (r.id) {
        if (db.get(col, r.id)) { const e = new Error('Duplicate id ' + r.id + ' in ' + col + ' — record not saved'); console.error('[CRM]', e.message); throw e; }
      } else {
        const prefix = opts.prefix || PREFIX[col] || col.slice(0, 3).toUpperCase();
        let guard = 0;
        do { r.id = nextId(prefix, opts.width); } while (db.get(col, r.id) && ++guard < 100000);
      }
      if (!r.createdAt) r.createdAt = new Date().toISOString();
      r.updatedAt = new Date().toISOString();
      db.all(col).push(r);
      if (!opts.silent) { audit('create', col, r.id, opts.note || 'Created'); emit(col + ':created', r); emit('db:change', { col, rec: r }); }
      persist();
      return r;
    },
    update(col, id, patch, opts) {
      opts = opts || {};
      const r = db.get(col, id);
      if (!r) return null;
      const changed = Object.keys(patch).filter((k) => JSON.stringify(r[k]) !== JSON.stringify(patch[k]));
      Object.assign(r, patch, { updatedAt: new Date().toISOString() });
      if (!opts.silent && changed.length) { audit('update', col, id, opts.note || ('Updated ' + changed.slice(0, 4).join(', '))); emit(col + ':updated', r); emit('db:change', { col, rec: r }); }
      persist();
      return r;
    },
    remove(col, id) { const r = db.get(col, id); state[col] = db.all(col).filter((x) => x.id !== id); audit('delete', col, id, 'Deleted'); if (r) { emit(col + ':removed', r); emit('db:change', { col, rec: r, removed: true }); } persist(); },
    reset() {
      suspended = true; clearTimeout(persistTimer); persistTimer = null;
      ls.remove(STORE_KEY); ls.remove(COUNTER_KEY);
      files._wipe().then(() => location.reload(), () => location.reload());
    },
    export() { persistNow(); return util.clone(state); },
    /** Replace all data with an export. Throws on an invalid file or when storage is full (nothing is changed then). */
    import(obj) {
      if (!obj || typeof obj !== 'object' || !obj.__v || Array.isArray(obj)) throw new Error('This is not a Maruthi CRM export file');
      suspended = true; clearTimeout(persistTimer); persistTimer = null;
      const prev = ls.get(STORE_KEY);
      if (!ls.set(STORE_KEY, JSON.stringify(obj))) { if (prev != null) ls.set(STORE_KEY, prev); suspended = false; throw new Error('Browser storage is full — the import was not applied'); }
      ls.set(COUNTER_KEY, JSON.stringify(obj.__counters || {}));
      location.reload();
    },
  };

  function audit(action, col, id, note) {
    if (!state) return;
    let who = null;
    try { who = user(); } catch (e) { /* ignore */ }
    (state.audit = state.audit || []).push({ id: 'AUD-' + util.uid(), ts: new Date().toISOString(), role: who ? who.role : 'system', user: who ? who.name : 'system', userId: who ? who.id : null, action, col, recId: id, note });
    if (state.audit.length > 3000) state.audit.splice(0, state.audit.length - 3000);
    persist();
  }

  // Multi-tab: another tab saved → adopt its state; another tab reset → reload.
  let pendingSync = false;
  window.addEventListener('storage', (e) => {
    try { if (e.storageArea && e.storageArea !== localStorage) return; } catch (err) { return; }
    if (e.key === COUNTER_KEY) { try { mergeCounters(JSON.parse(e.newValue || '{}')); } catch (err) { /* ignore */ } return; }
    if (e.key !== STORE_KEY && e.key !== null) return;
    if (e.newValue == null) { suspended = true; clearTimeout(persistTimer); location.reload(); return; }
    let next; try { next = JSON.parse(e.newValue); } catch (err) { return; }
    if (!next || !next.__v || suspended) return;
    clearTimeout(persistTimer); persistTimer = null;
    state = next; mergeCounters(next.__counters); applyMasters();
    emit('db:sync', {});
    if (!booted) return;
    renderBell();
    const ae = document.activeElement;
    const busy = openDialogs().length || (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && !document.hidden);
    if (busy) { pendingSync = true; showBanner('sync', 'Data was changed in another tab.', 'info', [{ label: 'Refresh view', onClick: () => { pendingSync = false; hideBanner('sync'); render(); } }]); }
    else render();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (booted) runTicks(true); } });

  // ---------------------------------------------------------------- master data (shared by all modules)
  const DIVISIONS = [
    { id: 'Power', name: 'Power', color: 'var(--div-power)' },
    { id: 'Electronic Security', name: 'Electronic Security', color: 'var(--div-security)' },
    { id: 'Solar', name: 'Solar', color: 'var(--div-solar)' },
  ];
  const DIVISION_DESC = {
    Power: 'Inverters, online UPS, servo stabilizers and batteries: sales, installation, warranty, AMC and service.',
    'Electronic Security': 'CCTV, access control, biometrics, video door phones, PA and fire alarm systems: projects, installation and service.',
    Solar: 'On-grid and hybrid rooftop solar: survey, BOQ, installation, net metering, subsidy, O&M and AMC.',
  };
  const MASTER_DEFAULTS = {
    areas: ['Coimbatore North', 'Coimbatore South', 'Peelamedu', 'Gandhipuram', 'RS Puram', 'Saravanampatti', 'Tiruppur', 'Pollachi', 'Mettupalayam', 'Erode'],
    segments: ['Residential', 'Commercial', 'Industrial', 'Institutional', 'Healthcare', 'Government', 'Retail'],
    leadSources: ['Cold Calling', 'Existing Customer Reference', 'Existing Customer Business', 'Dealer', 'Website', 'Walk-in', 'Campaign'],
    paymentTerms: [{ name: '100% Advance', days: 0 }, { name: 'Against delivery', days: 0 }, { name: 'Credit 15 days', days: 15 }, { name: 'Credit 30 days', days: 30 }, { name: 'Credit 45 days', days: 45 }, { name: 'Credit 60 days', days: 60 }],
  };
  // These arrays keep their identity forever (modules hold references); edits replace their contents in place.
  const AREAS = MASTER_DEFAULTS.areas.slice();
  const SEGMENTS = MASTER_DEFAULTS.segments.slice();
  const LEAD_SOURCES = MASTER_DEFAULTS.leadSources.slice();
  const PAYMENT_TERMS = MASTER_DEFAULTS.paymentTerms.map((x) => Object.assign({}, x));
  const LISTS = { areas: AREAS, segments: SEGMENTS, leadSources: LEAD_SOURCES, paymentTerms: PAYMENT_TERMS };
  const CUSTOMER_TYPES = ['New Customer', 'Existing Customer', 'Dealer', 'Key Customer', 'Key Account'];
  const CUSTOMER_CATEGORIES = ['Priority', 'Non-Priority'];

  function applyMasters() {
    const m = (state && state.__masters) || {};
    Object.keys(LISTS).forEach((k) => { const src = Array.isArray(m[k]) ? m[k] : MASTER_DEFAULTS[k]; const arr = LISTS[k]; arr.splice(0, arr.length, ...util.clone(src)); });
    DIVISIONS.forEach((d) => { d.description = (m.divisionDesc && m.divisionDesc[d.id]) || DIVISION_DESC[d.id] || ''; });
  }
  function setMasterList(key, value, note) {
    state.__masters = state.__masters || {};
    state.__masters[key] = util.clone(value);
    applyMasters();
    audit('update', 'masters', key, note || ('Updated ' + key));
    persist();
    emit('masters:changed', { key });
  }

  const PRODUCT_CATALOG = [
    // Power
    ['Power', 'Inverter', 'Maruthi Inverter 900VA', 7800], ['Power', 'Inverter', 'Maruthi Inverter 1.5KVA', 11500], ['Power', 'Inverter', 'Maruthi Inverter 3KVA', 24500], ['Power', 'Inverter', 'Maruthi Inverter 5KVA', 41000],
    ['Power', 'Online UPS', 'Maruthi Online UPS 1KVA', 18500], ['Power', 'Online UPS', 'Maruthi Online UPS 3KVA', 42000], ['Power', 'Online UPS', 'Maruthi Online UPS 10KVA', 135000], ['Power', 'Online UPS', 'Maruthi Online UPS 20KVA', 245000], ['Power', 'Online UPS', 'Maruthi Online UPS 60KVA', 690000],
    ['Power', 'Servo Stabilizer', 'Maruthi Servo Stabilizer 10KVA', 38000], ['Power', 'Servo Stabilizer', 'Maruthi Servo Stabilizer 50KVA', 145000], ['Power', 'Servo Stabilizer', 'Maruthi Servo Stabilizer 200KVA', 465000],
    ['Power', 'Battery', 'Exide 150Ah Tubular', 15500], ['Power', 'Battery', 'SF Sonic 100Ah', 10200], ['Power', 'Battery', 'Exide SMF 26Ah', 4800],
    // Electronic Security
    ['Electronic Security', 'CCTV', 'IP Dome Camera 4MP', 4200], ['Electronic Security', 'CCTV', 'IP Bullet Camera 4MP', 4600], ['Electronic Security', 'CCTV', 'PTZ Camera 2MP 25x', 38000], ['Electronic Security', 'CCTV', 'NVR 16 Channel', 14500], ['Electronic Security', 'CCTV', 'NVR 32 Channel', 26000], ['Electronic Security', 'CCTV', 'PoE Switch 16 Port', 11800], ['Electronic Security', 'CCTV', 'Surveillance HDD 4TB', 9200],
    ['Electronic Security', 'Biometric', 'Biometric Attendance Terminal', 9800], ['Electronic Security', 'Access Control', 'Access Controller 2-Door', 16500], ['Electronic Security', 'Video Door Phone', 'Video Door Phone 7"', 12500],
    ['Electronic Security', 'PA System', 'PA Amplifier 240W', 21000], ['Electronic Security', 'Fire Alarm', 'Fire Alarm Panel 4 Zone', 18500], ['Electronic Security', 'Fire Alarm', 'Smoke Detector', 1100],
    // Solar
    ['Solar', 'On-grid', 'On-grid Rooftop 3kW', 195000], ['Solar', 'On-grid', 'On-grid Rooftop 5kW', 310000], ['Solar', 'On-grid', 'On-grid Rooftop 10kW', 590000], ['Solar', 'On-grid', 'On-grid Rooftop 50kW', 2650000],
    ['Solar', 'Hybrid', 'Hybrid Solar 3kW + Battery', 285000], ['Solar', 'Hybrid', 'Hybrid Solar 5kW + Battery', 435000],
    ['Solar', 'Components', 'Mono PERC Panel 540W', 14500], ['Solar', 'Components', 'Solar Inverter 5kW Grid-tie', 62000],
  ];

  const CUSTOMER_NAMES = [
    ['KG Hospital', 'Healthcare'], ['PSG Tech Hostel', 'Institutional'], ['Sri Krishna Textiles', 'Industrial'], ['Annapoorna Hotels', 'Commercial'], ['Lakshmi Mills', 'Industrial'],
    ['Brookefields Mall', 'Retail'], ['Ganga Hospital', 'Healthcare'], ['Kovai Medical Center', 'Healthcare'], ['Roots Industries', 'Industrial'], ['Sakthi Sugars', 'Industrial'],
    ['Amrita School', 'Institutional'], ['Rajesh Residence', 'Residential'], ['Venkatesh Villa', 'Residential'], ['CRI Pumps', 'Industrial'], ['Shanthi Gears', 'Industrial'],
    ['Coimbatore Corporation Office', 'Government'], ['Pothys Showroom', 'Retail'], ['Hotel Residency', 'Commercial'], ['Kumaraguru College', 'Institutional'], ['Suguna Foods', 'Industrial'],
    ['Elgi Equipments', 'Industrial'], ['Senthil Apartments', 'Residential'], ['Dr. Priya Clinic', 'Healthcare'], ['Thangamayil Jewellery', 'Retail'], ['Vivek Textiles', 'Industrial'],
    ['Mahalakshmi Residence', 'Residential'], ['Global Logistics Park', 'Commercial'], ['Saravana Stores', 'Retail'],
  ];
  const FIRST = ['Ravi', 'Selvam', 'Kannan', 'Deepa', 'Mohan', 'Saranya', 'Ganesh', 'Revathi', 'Kumar', 'Jayanthi', 'Bharath', 'Nithya', 'Sathish', 'Uma'];
  const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';

  function seedStaffForRole(r) {
    if (db.get('staff', 'EMP-' + r.id)) return;
    db.insert('staff', { id: 'EMP-' + r.id, name: r.user, role: r.id, primary: true, phone: '98' + util.rand(10000000, 99999999), active: true, division: r.id === 'solar_coordinator' || r.id === 'doc_coordinator' ? 'Solar' : r.id === 'es_coordinator' ? 'Electronic Security' : r.id === 'service_centre_tech' ? 'Power' : null, skills: r.id === 'service_centre_tech' ? ['Inverter', 'Online UPS', 'Battery'] : undefined }, { silent: true });
  }

  function seedMasters() {
    if (db.all('staff').length) { ROLES.forEach(seedStaffForRole); return; } // existing data: add staff for roles introduced later
    // Staff — one primary user per role plus extra field staff for realistic workloads.
    ROLES.forEach(seedStaffForRole);
    const extra = [
      ['Deepak S', 'sales_exec', 'Power', 'Coimbatore North'], ['Nandhini R', 'sales_exec', 'Electronic Security', 'Peelamedu'], ['Hari Prasad', 'sales_exec', 'Solar', 'Tiruppur'], ['Arun Kumar', null, 'Power', 'Gandhipuram'],
      ['Rajkumar P', 'service_engineer', 'Power', null], ['Dinesh K', 'service_engineer', 'Electronic Security', null], ['Saravanan M', 'service_engineer', 'Solar', null],
      ['Karthi V', 'tech_engineer', 'Electronic Security', null], ['Yuvaraj S', 'tech_engineer', 'Solar', null], ['Vel Murugan', 'install_lead', 'Solar', null],
      ['Secure Vision Installers', 'vendor', 'Electronic Security', null], ['Green Rays Contractors', 'vendor', 'Solar', null],
    ];
    extra.forEach(([name, roleId, division, area]) => {
      if (!roleId) { const p = db.get('staff', 'EMP-sales_exec'); p.division = division; p.area = area; return; }
      db.insert('staff', { name, role: roleId, primary: false, division, area, phone: '97' + util.rand(10000000, 99999999), active: true }, { silent: true });
    });

    PRODUCT_CATALOG.forEach(([division, category, name, price], i) => db.insert('products', { id: 'PRD-' + String(i + 1).padStart(3, '0'), division, category, name, price, unit: 'Nos', hsn: division === 'Solar' ? '8541' : division === 'Power' ? '8504' : '8525', warrantyMonths: division === 'Solar' ? 60 : 12, active: true }, { silent: true }));

    const owners = db.find('staff', (s) => s.role === 'sales_exec').map((s) => s.id);
    CUSTOMER_NAMES.forEach(([name, segment], i) => {
      const type = i < 6 ? 'Key Customer' : i % 7 === 0 ? 'Dealer' : i % 3 === 0 ? 'New Customer' : 'Existing Customer';
      const c = db.insert('customers', {
        id: 'CUS-' + String(1001 + i), name, segment, type, category: i < 8 ? 'Priority' : 'Non-Priority',
        contact: util.pick(FIRST) + ' ' + util.pick(['R', 'S', 'K', 'M', 'P']), phone: '9' + util.rand(100000000, 999999999),
        altContact: i % 2 ? util.pick(FIRST) + ' ' + util.pick(['R', 'S', 'K']) : '', altPhone: i % 2 ? '8' + util.rand(100000000, 999999999) : '',
        email: name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '') + '@example.in',
        area: AREAS[i % AREAS.length], gstin: i % 4 === 0 ? '' : '33AAB' + L[i % L.length] + L[(i * 7) % L.length] + util.rand(1000, 9999) + 'C1Z' + (i % 9 + 1), since: util.iso(util.addDays(TODAY, -util.rand(30, 2400))),
        ownerId: owners.length ? owners[i % owners.length] : '',
      }, { silent: true });
      const nSites = i < 4 ? 2 : 1;
      for (let s = 0; s < nSites; s++) db.insert('sites', { customerId: c.id, name: s === 0 ? 'Main Site' : 'Branch ' + s, address: (util.rand(1, 240)) + ', ' + c.area + ', Coimbatore', area: c.area, contact: c.contact, phone: c.phone, access: s ? 'Security gate pass required' : 'Reception' }, { silent: true });
    });
  }

  function nextCustomerId() { bumpCounter('customers', 'CUS'); if ((counters.CUS || 0) < 1000) counters.CUS = 1000; return nextId('CUS'); }

  const master = {
    divisions: DIVISIONS, areas: AREAS, segments: SEGMENTS, leadSources: LEAD_SOURCES, paymentTerms: PAYMENT_TERMS,
    customerTypes: CUSTOMER_TYPES, customerCategories: CUSTOMER_CATEGORIES,
    paymentTermNames: () => PAYMENT_TERMS.map((t) => t.name),
    paymentTermDays: (name) => { const t = PAYMENT_TERMS.find((x) => x.name === name); return t ? Number(t.days) || 0 : 0; },
    list: (key) => LISTS[key] || [],
    customers: () => db.all('customers'),
    customer: (id) => db.get('customers', id),
    customerCategory: (c) => (c && (c.category || (/Key/.test(c.type || '') ? 'Priority' : 'Non-Priority'))) || 'Non-Priority',
    nextCustomerId,
    sites: (customerId) => db.find('sites', (s) => !customerId || s.customerId === customerId),
    products: (division) => db.find('products', (p) => p.active !== false && (!division || p.division === division)),
    product: (id) => db.get('products', id),
    staff: (roleId, division) => db.find('staff', (s) => s.active && (!roleId || s.role === roleId) && (!division || !s.division || s.division === division)),
    staffName: (id) => { const s = db.get('staff', id); return s ? s.name : (id || '—'); },
    divisionColor: (d) => (DIVISIONS.find((x) => x.id === d) || {}).color || 'var(--muted)',
    division: (id) => DIVISIONS.find((x) => x.id === id) || null,
  };

  function canEditCustomer(c, roleId) {
    const r = roleId || currentRoleId();
    if (CUSTOMER_EDIT_ROLES.includes(r)) return true;
    if (r === 'sales_exec') return !c || (!!c.ownerId && c.ownerId === user().id);
    return false;
  }

  // ---------------------------------------------------------------- config store
  const CONFIG_DEFAULTS = {
    'gst.Power': 18, 'gst.Electronic Security': 18, 'gst.Solar': 12,
    workHours: { days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '18:30' },
    holidays: ['2026-01-01', '2026-01-15', '2026-01-16', '2026-01-26', '2026-04-14', '2026-05-01', '2026-08-15', '2026-10-02', '2026-11-08', '2026-12-25'],
    holidayNames: { '2026-01-01': 'New Year', '2026-01-15': 'Pongal', '2026-01-16': 'Thiruvalluvar Day', '2026-01-26': 'Republic Day', '2026-04-14': 'Tamil New Year', '2026-05-01': 'May Day', '2026-08-15': 'Independence Day', '2026-10-02': 'Gandhi Jayanti', '2026-11-08': 'Deepavali', '2026-12-25': 'Christmas' },
    'sla.businessHours': true,
    'reports.enabled': {},
    'reports.defaultPeriod': 'This month',
  };
  const NOTIFY_EVENTS = [
    { id: 'general', label: 'General alerts', defaults: { inapp: true, email: false, whatsapp: false } },
    { id: 'assignment', label: 'Lead / task / call assignment', defaults: { inapp: true, email: true, whatsapp: false } },
    { id: 'approval', label: 'Approval requests', defaults: { inapp: true, email: true, whatsapp: false } },
    { id: 'sla', label: 'SLA warnings and breaches', defaults: { inapp: true, email: true, whatsapp: false } },
    { id: 'escalation', label: 'Escalations and policy violations', defaults: { inapp: true, email: true, whatsapp: true } },
    { id: 'payment', label: 'Payment due and collection alerts', defaults: { inapp: true, email: true, whatsapp: false } },
    { id: 'renewal', label: 'AMC renewal and warranty expiry', defaults: { inapp: true, email: true, whatsapp: true } },
    { id: 'customer', label: 'Customer updates (complaint registered, engineer assigned, closed)', defaults: { inapp: true, email: false, whatsapp: true } },
  ];
  const REPORTS = [];
  const configSections = [];

  const config = {
    /** Stored value → registered default (core built-ins / config.defaults) → caller's fallback `def`. Always returns a copy. */
    get(key, def) {
      const c = (state && state.__config) || {};
      if (Object.prototype.hasOwnProperty.call(c, key)) return util.clone(c[key]);
      if (CONFIG_DEFAULTS[key] !== undefined) return util.clone(CONFIG_DEFAULTS[key]);
      return def;
    },
    set(key, value, note) {
      state.__config = state.__config || {};
      state.__config[key] = util.clone(value);
      audit('config', 'config', key, note || ('Changed ' + key));
      persist();
      emit('config:changed', { key, value });
      return value;
    },
    /** Register defaults for module-owned keys (does not overwrite existing defaults). */
    defaults(obj) { Object.keys(obj || {}).forEach((k) => { if (!(k in CONFIG_DEFAULTS)) CONFIG_DEFAULTS[k] = obj[k]; }); },
    gstRate(division) { const raw = config.get('gst.' + division, 18); const v = Number(raw); return raw !== '' && raw != null && isFinite(v) ? v : 18; },
    channelsFor(eventId) { const ev = NOTIFY_EVENTS.find((e) => e.id === eventId) || NOTIFY_EVENTS[0]; return Object.assign({}, ev.defaults, config.get('channels.' + ev.id, null) || {}); },
    reportEnabled(id) { const m = config.get('reports.enabled') || {}; return m[id] !== false; },
    defaultPeriod() { return config.get('reports.defaultPeriod') || 'This month'; },
  };
  function registerNotifyEvent(ev) { if (ev && ev.id && !NOTIFY_EVENTS.some((e) => e.id === ev.id)) NOTIFY_EVENTS.push({ id: ev.id, label: ev.label || ev.id, defaults: Object.assign({ inapp: true, email: false, whatsapp: false }, ev.defaults || {}) }); }
  function registerReport(r) { if (r && r.id && !REPORTS.some((x) => x.id === r.id)) REPORTS.push(Object.assign({ group: 'General' }, r)); }
  function registerConfigSection(s) { if (!s || !s.id || configSections.some((x) => x.id === s.id)) return; configSections.push(Object.assign({ roles: ['admin', 'gm'], order: 50 }, s)); }

  // ---------------------------------------------------------------- business hours
  function workingWindow(day, wh, hol) {
    if (!wh || !Array.isArray(wh.days) || !wh.days.includes(day.getDay())) return null;
    if (hol.has(util.iso(day))) return null;
    const [sh, sm] = String(wh.start || '09:30').split(':').map(Number);
    const [eh, em] = String(wh.end || '18:30').split(':').map(Number);
    const s = new Date(day); s.setHours(sh || 0, sm || 0, 0, 0);
    const e = new Date(day); e.setHours(eh || 0, em || 0, 0, 0);
    return e > s ? [s, e] : null;
  }
  function holidayDates() { return (config.get('holidays') || []).map((x) => util.iso(x && typeof x === 'object' ? x.date : x)).filter(Boolean); }
  function hoursCtx() { return { wh: config.get('workHours'), hol: new Set(holidayDates()) }; }
  /** Add working hours (Mon–Sat 09:30–18:30 by default, skipping holidays). Returns a Date. */
  function addBusinessHours(start, hours) {
    let t = toDate(start); if (isNaN(t)) return t;
    let remain = Number(hours || 0) * 3600e3;
    if (remain <= 0) return new Date(t);
    const { wh, hol } = hoursCtx();
    for (let i = 0; i < 3700 && remain > 0; i++) {
      const day = new Date(t); day.setHours(0, 0, 0, 0);
      const w = workingWindow(day, wh, hol);
      if (w) { const from = Math.max(t.getTime(), w[0].getTime()); if (from < w[1].getTime()) { const avail = w[1].getTime() - from; if (avail >= remain) return new Date(from + remain); remain -= avail; } }
      t = new Date(day); t.setDate(t.getDate() + 1);
    }
    return new Date(toDate(start).getTime() + Number(hours || 0) * 3600e3); // no working time configured: fall back to clock hours
  }
  /** Working hours between a and b (decimal hours; negative when b < a). */
  function businessHoursBetween(a, b) {
    let s = toDate(a), e = toDate(b);
    if (isNaN(s) || isNaN(e)) return 0;
    let sign = 1; if (e < s) { [s, e] = [e, s]; sign = -1; }
    const { wh, hol } = hoursCtx();
    let ms = 0;
    let day = new Date(s); day.setHours(0, 0, 0, 0);
    for (let i = 0; i < 3700 && day <= e; i++) {
      const w = workingWindow(day, wh, hol);
      if (w) { const from = Math.max(s.getTime(), w[0].getTime()); const to = Math.min(e.getTime(), w[1].getTime()); if (to > from) ms += to - from; }
      day.setDate(day.getDate() + 1);
    }
    return sign * Math.round(ms / 36e3) / 100;
  }
  /** Total paused milliseconds. intervals: [{from,to}] | [{start,end}] | [[from,to]]; an open interval runs to opts.now. Overlaps are merged. opts.businessHours counts only working time. */
  function pausedMs(intervals, opts) {
    opts = opts || {};
    const now = toDate(opts.now || new Date()).getTime();
    const list = (intervals || []).map((iv) => {
      const a = Array.isArray(iv) ? iv[0] : (iv.from || iv.start || iv.at);
      const b = Array.isArray(iv) ? iv[1] : (iv.to || iv.end || iv.until);
      const s = toDate(a).getTime(); const e = b ? toDate(b).getTime() : now;
      return [s, Math.min(e, now)];
    }).filter(([s, e]) => !isNaN(s) && !isNaN(e) && e > s).sort((x, y) => x[0] - y[0]);
    const merged = [];
    list.forEach((iv) => { const last = merged[merged.length - 1]; if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]); else merged.push(iv.slice()); });
    return merged.reduce((sum, [s, e]) => sum + (opts.businessHours ? businessHoursBetween(s, e) * 3600e3 : e - s), 0);
  }
  Object.assign(util, { addBusinessHours, businessHoursBetween, pausedMs });

  // ---------------------------------------------------------------- periodic ticks
  const ticks = [];
  let tickTimer = null;
  /** Run fn(ctx) every `everyMs` (default 60 s, minimum 5 s) while the app is open. */
  function registerTick(fn, everyMs) { ticks.push({ fn, every: Math.max(5000, Number(everyMs) || 60000), last: Date.now() }); }
  function runTicks(force) {
    if (!booted || suspended) return;
    const now = Date.now();
    // Keep TODAY correct if the app stays open past midnight.
    const mid = new Date(); mid.setHours(0, 0, 0, 0); if (mid.getTime() !== TODAY.getTime()) TODAY.setTime(mid.getTime());
    let ran = false;
    ticks.forEach((t) => {
      if (!force && now - t.last < t.every) return;
      t.last = now; ran = true;
      try { t.fn({ now: new Date(), db, util, fmt, master }); } catch (e) { console.error('[CRM] tick failed', e); }
    });
    if (ran) { renderBell(); try { renderNav(parseRoute().id); } catch (e) { /* ignore */ } emit('tick', { at: new Date() }); }
  }

  // ---------------------------------------------------------------- notifications
  let toastQueue = [];
  function pageIdOfLink(link) { return String(link || '').replace(/^#\/?/, '').split('/')[0] || 'home'; }
  function staffRoles(ids) { return [].concat(ids || []).map((id) => (db.get('staff', id) || {}).role).filter(Boolean); }
  /**
   * n: { to: roleId | [roleIds] | 'mgmt', toUser: staffId | [staffIds], title, body, link, severity: 'info'|'warn'|'bad'|'ok', key, event, channel }
   * toUser → only those users see it (to is then only used for reporting). Without toUser → every user of the `to` roles sees it.
   */
  function notify(n) {
    const to = [].concat(n.to || (n.toUser ? [] : 'gm'));
    const toUser = n.toUser ? [].concat(n.toUser).filter(Boolean) : null;
    if (n.key && db.one('notifications', (x) => x.key === n.key)) return null; // de-duplicate (requirement: avoid duplicate notifications)
    let link = n.link || '';
    if (link) {
      const pid = pageIdOfLink(link);
      const p = pages.find((x) => x.id === pid);
      const recRoles = toUser && toUser.length ? staffRoles(toUser) : to.flatMap((r) => (r === 'mgmt' ? MGMT : [r]));
      if (p && recRoles.length && !recRoles.some((r) => p.roles.includes(r))) link = '';
    }
    const ch = config.channelsFor(n.event || 'general');
    const channels = [];
    if (ch.inapp !== false) channels.push('In-app');
    if (ch.email) channels.push('Email (simulated)');
    if (ch.whatsapp) channels.push('WhatsApp (simulated)');
    if (n.channel && !channels.includes(n.channel)) channels.push(n.channel);
    const rec = db.insert('notifications', { to, toUser, title: n.title, body: n.body || '', link, severity: n.severity || 'info', key: n.key || null, event: n.event || 'general', readBy: [], inapp: ch.inapp !== false, channel: channels.join(' · ') || 'Log only' }, { silent: true, prefix: 'NTF' });
    if (state.notifications.length > 4000) state.notifications.splice(0, state.notifications.length - 4000);
    emit('notifications:created', rec);
    renderBell();
    if (booted && isMine(rec)) { toastQueue.push(rec); if (toastQueue.length === 1) setTimeout(flushToasts, 0); }
    return rec;
  }
  function flushToasts() {
    const q = toastQueue; toastQueue = [];
    if (!q.length) return;
    if (q.length === 1) ui.toast('🔔 ' + q[0].title, q[0].severity === 'info' ? '' : q[0].severity);
    else ui.toast('🔔 ' + q.length + ' new notifications', q.some((x) => x.severity === 'bad') ? 'bad' : '');
  }
  function isMine(n, u) {
    u = u || user();
    if (n.inapp === false) return false;
    if (n.toUser && n.toUser.length) return n.toUser.includes(u.id);
    const to = n.to || [];
    return to.includes(u.role) || (MGMT.includes(u.role) && to.includes('mgmt'));
  }
  function isRead(n, u) { u = u || user(); return (n.readBy || []).includes(u.id) || (n.readBy || []).includes(u.role); }
  function markRead(n, u) { u = u || user(); if (!isRead(n, u)) { n.readBy = (n.readBy || []).concat(u.id); persist(); } }
  function myNotifications() { const u = user(); return db.all('notifications').filter((n) => isMine(n, u)).reverse(); }

  // ---------------------------------------------------------------- page registry & router
  const pages = [];
  const homes = {};
  function registerPage(p) {
    // p: { id, title, icon, section, roles: [...] | 'all', order, render(el, params), badge(): number, hidden }
    if (pages.some((x) => x.id === p.id)) { console.warn('[CRM] duplicate page id', p.id); return; }
    p.roles = p.roles === 'all' || !p.roles ? ALL : p.roles;
    pages.push(p);
  }
  function registerHome(roleIds, renderFn) { [].concat(roleIds).forEach((r) => { homes[r] = renderFn; }); }
  function registerSeed(fn) { seeds.push(fn); }
  function registerRole(r) { if (!ROLES.some((x) => x.id === r.id)) { ROLES.push(r); ALL.push(r.id); } }

  function visiblePages() { const r = currentRoleId(); return pages.filter((p) => !p.hidden && p.roles.includes(r)); }
  /** canSee(pageId, roleId?) — can that role (default: current) open the page? 'home' is always allowed. */
  function canSee(pageId, roleId) { if (!pageId || pageId === 'home') return true; const p = pages.find((x) => x.id === pageId); return !!p && p.roles.includes(roleId || currentRoleId()); }

  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
  function parseRoute() {
    const hsh = location.hash.replace(/^#\/?/, '');
    const [id, ...rest] = hsh.split('/');
    return { id: safeDecode(id || 'home') || 'home', params: rest.map(safeDecode) };
  }
  function go(id, ...params) { location.hash = '#/' + [id].concat(params.map((x) => encodeURIComponent(x))).join('/'); }

  const APP_TITLE = 'Maruthi CRM';
  let contentEl, navEl;
  function render() {
    if (!contentEl) return;
    const { id, params } = parseRoute();
    pendingSync = false; hideBanner('sync');
    closeOverlays();
    contentEl.innerHTML = '';
    contentEl.scrollTop = 0;
    document.querySelector('.app').classList.remove('nav-open');
    renderNav(id);
    try {
      if (id === 'home') {
        document.title = 'My Dashboard · ' + APP_TITLE;
        const fn = homes[currentRoleId()];
        if (fn) fn(contentEl, params); else genericHome(contentEl);
        return;
      }
      const p = pages.find((x) => x.id === id);
      if (!p) { document.title = 'Page not found · ' + APP_TITLE; contentEl.innerHTML = '<div class="empty"><div class="big">🧭</div><h2>Page not found</h2><p><a href="#/home">Go to my dashboard</a></p></div>'; return; }
      if (!p.roles.includes(currentRoleId())) {
        document.title = 'Access restricted · ' + APP_TITLE;
        contentEl.innerHTML = '<div class="empty"><div class="big">🔒</div><h2>Access restricted</h2><p>The <b>' + util.esc(role().name) + '</b> role cannot open <b>' + util.esc(p.title) + '</b>.<br>Access follows role and assignment as defined in the requirement documents.</p><a class="btn primary" href="#/home">Back to my dashboard</a></div>';
        return;
      }
      document.title = p.title + ' · ' + APP_TITLE;
      p.render(contentEl, params);
    } catch (e) {
      console.error(e);
      contentEl.innerHTML = '<div class="callout bad"><b>Something went wrong rendering this page.</b><br><span class="mono">' + util.esc(e.message) + '</span></div>';
    }
  }
  function refresh() { render(); }

  function renderNav(activeId) {
    if (!navEl) return;
    const vis = visiblePages().sort((a, b) => (a.order || 50) - (b.order || 50));
    const sections = [];
    vis.forEach((p) => { const s = p.section || 'General'; if (!sections.includes(s)) sections.push(s); });
    let html = '<a href="#/home" class="' + (activeId === 'home' ? 'active' : '') + '"' + (activeId === 'home' ? ' aria-current="page"' : '') + '><span class="ico">' + ICONS.grid + '</span>My Dashboard</a>';
    sections.forEach((s) => {
      html += '<div class="nav-section" role="presentation">' + util.esc(s) + '</div>';
      vis.filter((p) => (p.section || 'General') === s).forEach((p) => {
        let count = '';
        try { const c = p.badge ? p.badge() : 0; if (c) count = '<span class="count" aria-label="' + c + ' pending">' + c + '</span>'; } catch (e) { /* ignore */ }
        const act = p.id === activeId;
        html += '<a href="#/' + util.esc(p.id) + '" class="' + (act ? 'active' : '') + '"' + (act ? ' aria-current="page"' : '') + '><span class="ico">' + navIcon(p) + '</span>' + util.esc(p.title) + count + '</a>';
      });
    });
    navEl.innerHTML = html;
  }

  // Brand book icon style: outline, 2px stroke, rounded joins, red accent stroke on the "power" element.
  const svg = (body) => '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + body + '</svg>';
  const ICONS = {
    grid: svg('<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect class="acc" x="3" y="16" width="7" height="5"/>'),
    phone: svg('<rect x="7" y="2" width="10" height="20" rx="2"/><path class="acc" d="M11 18h2"/>'),
    inbox: svg('<path d="M3 13l3-8h12l3 8v6H3z"/><path class="acc" d="M3 13h5l1 3h6l1-3h5"/>'),
    kanban: svg('<rect x="3" y="4" width="5" height="16"/><rect x="10" y="4" width="5" height="11"/><rect class="acc" x="17" y="4" width="4" height="7"/>'),
    doc: svg('<path d="M6 2h9l4 4v16H6z"/><path d="M14 2v5h5"/><path class="acc" d="M9 13h7M9 17h5"/>'),
    box: svg('<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/><path class="acc" d="M7.5 5l9 4"/>'),
    calendar: svg('<rect x="3" y="5" width="18" height="16" rx="1"/><path d="M3 10h18M8 3v4M16 3v4"/><path class="acc" d="M9 15l2 2 4-4"/>'),
    call: svg('<path d="M5 4h4l2 5-3 2a11 11 0 006 6l2-3 5 2v4a2 2 0 01-2 2A17 17 0 013 6a2 2 0 012-2"/><path class="acc" d="M15 3a6 6 0 016 6"/>'),
    trend: svg('<path d="M3 17l6-6 4 4 8-8"/><path class="acc" d="M15 7h6v6"/>'),
    users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0"/><path class="acc" d="M16 4.5a3.5 3.5 0 010 7M18 14a6 6 0 013.5 6"/>'),
    target: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle class="acc" cx="12" cy="12" r="1.5"/>'),
    upload: svg('<path d="M4 15v5h16v-5"/><path class="acc" d="M12 16V4M7 9l5-5 5 5"/>'),
    receipt: svg('<path d="M5 2h14v20l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path class="acc" d="M9 8h6M9 12h6M9 16h4"/>'),
    rupee: svg('<path d="M6 4h12M6 9h12"/><path class="acc" d="M9 4c5 0 5 9 0 9H7l8 8"/>'),
    hourglass: svg('<path d="M6 2h12M6 22h12M7 2c0 6 10 8 10 20M17 2c0 6-10 8-10 20"/><path class="acc" d="M9 19h6"/>'),
    chart: svg('<path d="M3 21h18"/><rect x="5" y="11" width="3" height="7"/><rect x="10.5" y="6" width="3" height="12"/><rect class="acc" x="16" y="3" width="3" height="15"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path class="acc" d="M12 7v5l3 2"/>'),
    alert: svg('<path d="M12 3l10 18H2z"/><path class="acc" d="M12 10v5M12 18v.5"/>'),
    building: svg('<path d="M4 21V5l8-3v19M12 8l8 3v10M2 21h20"/><path class="acc" d="M7 9v.5M7 13v.5M16 14v.5"/>'),
    pin: svg('<path d="M12 22s7-7 7-12a7 7 0 00-14 0c0 5 7 12 7 12z"/><circle class="acc" cx="12" cy="10" r="2.5"/>'),
    list: svg('<path d="M9 6h12M9 12h12M9 18h12"/><path class="acc" d="M4 6h.5M4 12h.5M4 18h.5"/>'),
    check: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path class="acc" d="M8 12l3 3 5-6"/>'),
    lock: svg('<rect x="4" y="11" width="16" height="10" rx="1"/><path d="M8 11V7a4 4 0 018 0v4"/><path class="acc" d="M12 15v2"/>'),
    shield: svg('<path d="M12 2l8 3v7c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V5z"/><path class="acc" d="M8.5 12l2.5 2.5 4.5-5"/>'),
    handshake: svg('<path d="M2 12l4-4 4 2 3-2 5 1 4 3"/><path d="M6 8v6l5 4 3-2 4-3"/><path class="acc" d="M11 12l3 3"/>'),
    scale: svg('<path d="M12 3v18M5 21h14M4 7h16"/><path d="M4 7l-2 6a3 3 0 006 0zM20 7l-2 6a3 3 0 006 0z"/><path class="acc" d="M12 3v2"/>'),
    warehouse: svg('<path d="M2 9l10-6 10 6v12H2z"/><path d="M6 21v-8h12v8"/><path class="acc" d="M6 17h12"/>'),
    cart: svg('<path d="M2 3h3l3 12h11l2-8H6"/><circle cx="9" cy="20" r="1.5"/><circle class="acc" cx="17" cy="20" r="1.5"/>'),
    truck: svg('<path d="M2 6h12v10H2zM14 10h4l3 3v3h-7"/><circle cx="6" cy="18" r="2"/><circle class="acc" cx="17" cy="18" r="2"/>'),
    recycle: svg('<path d="M7 19H4l3-5M17 19h3l-3-5M9 5l3-3 3 5"/><path class="acc" d="M7 19h10M6 13l3-6M18 13l-3-6"/>'),
    gauge: svg('<path d="M3 16a9 9 0 0118 0"/><path class="acc" d="M12 16l4-5"/><path d="M3 20h18"/>'),
    sun: svg('<path d="M3 21l3-9h12l3 9z"/><path d="M5 16.5h14M12 12v9"/><circle class="acc" cx="12" cy="5" r="2.5"/>'),
    wrench: svg('<path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/><path class="acc" d="M19 19l2 2"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/><circle class="acc" cx="12" cy="12" r=".5"/>'),
    server: svg('<rect x="3" y="4" width="18" height="7" rx="1"/><rect x="3" y="13" width="18" height="7" rx="1"/><path class="acc" d="M7 7.5h.5M7 16.5h.5"/>'),
    bolt: svg('<rect x="3" y="7" width="18" height="12" rx="1"/><path d="M7 7V5M17 7V5"/><path class="acc" d="M13 9l-3 4h4l-3 4"/>'),
    award: svg('<circle cx="12" cy="9" r="6"/><path d="M8.5 14L7 22l5-3 5 3-1.5-8"/><path class="acc" d="M10 9l1.5 1.5L14 8"/>'),
    user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/><path class="acc" d="M12 12v2"/>'),
    database: svg('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path class="acc" d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
    scroll: svg('<path d="M6 3h11a2 2 0 012 2v14a2 2 0 01-2 2H7a2 2 0 01-2-2V7H3V5a2 2 0 012-2"/><path class="acc" d="M9 9h6M9 13h6M9 17h3"/>'),
    compass: svg('<circle cx="12" cy="12" r="9"/><path class="acc" d="M15.5 8.5l-2 5-5 2 2-5z"/>'),
    message: svg('<path d="M4 4h16v12H9l-5 4z"/><path class="acc" d="M8 9h8M8 12h5"/>'),
    clip: svg('<path d="M21 11l-8.5 8.5a5 5 0 01-7-7L14 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 7"/>'),
    dot: svg('<circle class="acc" cx="12" cy="12" r="3"/>'),
  };
  // Order matters: the first matching rule wins.
  const ICON_RULES = [
    [/^settings/, 'gear'], [/role design|guide/, 'compass'], [/mobile/, 'phone'], [/vault|device schedule|credential/, 'lock'], [/pending tasks/, 'check'], [/my assigned/, 'check'],
    [/dashboard|cockpit|execution$/, 'grid'], [/lead|enquir/, 'inbox'], [/pipeline/, 'kanban'], [/quotation/, 'doc'], [/sales order/, 'box'],
    [/follow-up|follow up/, 'calendar'], [/compliance follow/, 'calendar'], [/calls|cold/, 'call'], [/ots/, 'call'], [/upsell|cross/, 'trend'], [/dealer|vendor/, 'users'],
    [/target|kpi/, 'target'], [/migration|import/, 'upload'], [/billing|invoice/, 'receipt'], [/payment|collection|subsidy/, 'rupee'], [/outstanding|ageing/, 'hourglass'],
    [/cycle/, 'clock'], [/violation|escalation|sla/, 'alert'], [/report/, 'chart'], [/project material/, 'box'], [/project|installation/, 'building'], [/survey/, 'pin'], [/boq/, 'list'],
    [/inspection|rework|quality/, 'shield'], [/handover/, 'handshake'], [/policy|rules|compliance/, 'scale'], [/stock|grn|inward/, 'warehouse'], [/purchase/, 'cart'],
    [/challan|delivery|material issue/, 'truck'], [/scrap/, 'recycle'], [/net meter/, 'gauge'], [/solar/, 'sun'], [/complaint|workbench|service centre/, 'wrench'], [/spare|standby/, 'bolt'],
    [/equipment|register|asset/, 'server'], [/amc|warranty/, 'shield'], [/preventive|^pm /, 'calendar'], [/performance/, 'award'], [/config|settings/, 'gear'],
    [/customer/, 'user'], [/users|access/, 'users'], [/master/, 'database'], [/audit/, 'scroll'], [/feedback/, 'message'], [/task/, 'check'], [/attach|document/, 'clip'],
  ];
  function navIcon(p) {
    const t = (p.title + ' ' + p.id).toLowerCase();
    const r = ICON_RULES.find(([re]) => re.test(t));
    return ICONS[r ? r[1] : 'dot'];
  }

  function genericHome(el) {
    const r = role();
    el.innerHTML = '';
    el.appendChild(ui.hero(r));
    const list = visiblePages();
    if (!list.length) { el.appendChild(ui.callout('Pages for the ' + r.name + ' role will appear here once they are set up.', 'info')); return; }
    const grid = h('div', { class: 'grid g3' });
    list.forEach((p) => grid.appendChild(h('a', { class: 'card card-body', href: '#/' + p.id }, [h('div', { class: 'ico', style: 'margin-bottom:6px', html: navIcon(p) }), h('h3', {}, p.title), h('div', { class: 'muted small' }, p.section || '')])));
    el.appendChild(grid);
  }

  // ---------------------------------------------------------------- DOM helper
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach((k) => {
      const v = attrs[k];
      if (v == null || v === false) return;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    [].concat(children == null ? [] : children).flat().forEach((c) => {
      if (c == null || c === false) return;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    });
    return el;
  }
  /** Make a non-button element operable by keyboard: Enter/Space triggers fn. */
  function keyActivate(el, fn, label) {
    el.setAttribute('tabindex', '0');
    if (!el.getAttribute('role')) el.setAttribute('role', 'button');
    if (label) el.setAttribute('aria-label', label);
    el.addEventListener('keydown', (e) => { if (e.target !== el) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); } });
    return el;
  }

  // ---------------------------------------------------------------- safe markup
  // Inline formatting allowed in ui.callout strings (no attributes except in-app links).
  const SAFE_INLINE = { B: [], STRONG: [], I: [], EM: [], BR: [], CODE: [], SMALL: [], A: ['href'] };
  // ui.calloutHtml additionally allows simple structure + class attributes.
  const SAFE_RICH = Object.assign({}, SAFE_INLINE, { SPAN: ['class'], DIV: ['class'], P: [], UL: [], OL: [], LI: [], U: [], A: ['href', 'class'], B: ['class'] });
  function sanitize(html, allow) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html == null ? '' : html);
    const frag = document.createDocumentFragment();
    (function walk(src, dst) {
      Array.from(src.childNodes).forEach((n) => {
        if (n.nodeType === 3) { dst.appendChild(document.createTextNode(n.nodeValue)); return; }
        if (n.nodeType !== 1) return;
        const okAttrs = allow[n.tagName];
        const attrs = Array.from(n.attributes);
        const attrsOk = okAttrs && attrs.every((a) => okAttrs.includes(a.name) && (a.name !== 'href' || /^(#|https?:\/\/|mailto:|tel:)/i.test(a.value.trim())));
        if (!attrsOk) { dst.appendChild(document.createTextNode(n.outerHTML)); return; } // shown as literal text
        const clean = document.createElement(n.tagName.toLowerCase());
        attrs.forEach((a) => clean.setAttribute(a.name, a.value));
        if (n.tagName === 'A' && /^https?:/i.test(clean.getAttribute('href') || '')) { clean.setAttribute('target', '_blank'); clean.setAttribute('rel', 'noopener noreferrer'); }
        walk(n, clean);
        dst.appendChild(clean);
      });
    })(tpl.content, frag);
    return frag;
  }

  // ---------------------------------------------------------------- dialogs (a11y: role=dialog, aria-modal, Escape, focus trap/restore)
  const dialogs = [];
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function openDialogs() { for (let i = dialogs.length - 1; i >= 0; i--) if (!dialogs[i].el.isConnected) dialogs.splice(i, 1); return dialogs; }
  function registerDialog(el, close) {
    const prev = document.activeElement;
    const entry = { el, close, prev };
    dialogs.push(entry);
    const first = el.querySelector('.modal-body ' + FOCUSABLE.split(',').filter((s) => !s.startsWith('a[')).join(',.modal-body ')) || el.querySelector('.modal-foot .btn.primary') || el.querySelector(FOCUSABLE);
    try { (first || el).focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    return () => {
      const i = dialogs.indexOf(entry); if (i >= 0) dialogs.splice(i, 1);
      const target = prev && prev.isConnected && prev !== document.body ? prev : contentEl;
      try { if (target) target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    };
  }
  document.addEventListener('keydown', (e) => {
    const top = openDialogs()[dialogs.length - 1];
    if (e.key === 'Escape') {
      if (top) { e.preventDefault(); top.close(); return; }
      const panel = document.querySelector('.notif-panel'); if (panel) { closeNotifPanel(true); return; }
      const sr = document.getElementById('searchResults'); if (sr && !sr.classList.contains('hidden')) sr.classList.add('hidden');
      const menu = document.querySelector('.pop-menu'); if (menu) menu.remove();
      return;
    }
    if (e.key === 'Tab' && top) {
      const f = Array.from(top.el.querySelectorAll(FOCUSABLE)).filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1];
      if (!top.el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // ---------------------------------------------------------------- banners
  function showBanner(id, text, tone, actions) {
    const host = document.getElementById('banners'); if (!host) return;
    let b = document.getElementById('banner-' + id);
    if (!b) { b = h('div', { id: 'banner-' + id, class: 'banner ' + (tone || ''), role: tone === 'bad' ? 'alert' : 'status' }); host.appendChild(b); }
    b.innerHTML = '';
    b.appendChild(h('span', {}, text));
    (actions || []).forEach((a) => b.appendChild(ui.btn(a.label, a.onClick, 'sm')));
    if (id === 'save') b.appendChild(ui.btn('Export backup', () => downloadBackup(), 'sm'));
  }
  function hideBanner(id) { const b = document.getElementById('banner-' + id); if (b) b.remove(); }
  function downloadBackup() { downloadBlob('mpcs-crm-export-' + util.iso(new Date()) + '.json', new Blob([JSON.stringify(db.export(), null, 1)], { type: 'application/json' })); }
  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name, style: 'display:none' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ---------------------------------------------------------------- UI kit
  const TONES = {
    ok: ['won', 'approved', 'completed', 'closed', 'paid', 'received', 'resolved', 'active', 'done', 'passed', 'feasible', 'delivered', 'handed over', 'commissioned', 'in stock', 'yes', 'on time', 'within sla', 'renewed', 'converted', 'priority'],
    bad: ['lost', 'rejected', 'overdue', 'breach', 'breached', 'critical', 'not feasible', 'failed', 'cancelled', 'expired', 'shortage', 'escalated', 'high', 'damaged', 'no'],
    warn: ['pending', 'negotiation', 'under discussion', 'waiting', 'on hold', 'partial', 'at risk', 'medium', 'due soon', 'revisit required', 'feasible with conditions', 'in progress', 'hold'],
    info: ['sent', 'open', 'new', 'scheduled', 'assigned', 'planned', 'submitted', 'quotation sent', 'site visit scheduled', 'contact made', 'enquiry received', 'non-priority'],
  };
  function toneFor(text) {
    const t = String(text || '').toLowerCase();
    for (const k of Object.keys(TONES)) if (TONES[k].includes(t)) return k;
    for (const k of ['bad', 'warn', 'ok']) if (TONES[k].some((w) => w.length > 3 && t.includes(w))) return k;
    return '';
  }
  function cellText(v) { if (v == null) return ''; if (v instanceof Node) return (v.textContent || '').trim(); if (v instanceof Date) return util.iso(v); return String(v); }

  const ui = {
    h,
    keyActivate,
    sanitize: (html, rich) => sanitize(html, rich ? SAFE_RICH : SAFE_INLINE),
    page(el, { title, sub, crumbs, actions }) {
      const head = h('div', { class: 'page-head' }, [
        h('div', {}, [crumbs ? h('div', { class: 'crumbs' }, crumbs) : null, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null]),
        h('div', { class: 'page-actions' }, actions || []),
      ]);
      el.appendChild(h('div', { class: 'brand-strip' }, [h('img', { src: 'assets/brand/logo-primary.png', alt: 'Maruthi Power Control Systems' }), h('span', { class: 'small muted' }, fmt.date(new Date()))]));
      el.appendChild(head);
      return head;
    },
    btn(label, onClick, cls, attrs) { return h('button', Object.assign({ class: 'btn ' + (cls || ''), type: 'button', onClick }, attrs || {}), label); },
    badge(text, tone) { return h('span', { class: 'badge ' + (tone == null ? toneFor(text) : tone) }, text == null || text === '' ? '—' : String(text)); },
    badgeHtml(text, tone) { return '<span class="badge ' + (tone == null ? toneFor(text) : tone) + '">' + util.esc(text == null || text === '' ? '—' : text) + '</span>'; },
    divTag(d) { return h('span', { class: 'div-tag', style: '--c:' + master.divisionColor(d) }, d || '—'); },
    card(title, body, opts) {
      opts = opts || {};
      return h('div', { class: 'card ' + (opts.cls || '') }, [
        title ? h('div', { class: 'card-head' }, [h('h3', {}, title), opts.actions ? h('div', { class: 'row' }, opts.actions) : null]) : null,
        h('div', { class: 'card-body' + (opts.flush ? ' flush' : '') }, body),
      ]);
    },
    kpis(items) {
      // items: [{ label, value, meta, tone: 'up'|'down', color, onClick }]
      return h('div', { class: 'kpis' }, items.map((k) => {
        const el = h('div', { class: 'kpi' + (k.onClick ? ' clickable' : ''), style: k.color ? '--kpi-c:' + k.color : null, onClick: k.onClick }, [
          h('div', { class: 'lbl' }, k.label), h('div', { class: 'val' }, k.value), k.meta ? h('div', { class: 'meta ' + (k.tone || '') }, k.meta) : null,
        ]);
        if (k.onClick) keyActivate(el, k.onClick, k.label + ': ' + cellText(k.value) + (k.meta ? ' (' + cellText(k.meta) + ')' : '') + ' — open details');
        return el;
      }));
    },
    hero(r, chips) {
      r = r || role();
      const hr = new Date().getHours();
      const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
      return h('div', { class: 'hero' }, [
        h('div', {}, [h('h1', {}, greet + ', ' + user().name), h('div', { class: 'sub' }, r.name + ' · ' + fmt.date(TODAY) + ' · Maruthi Power Control Systems')]),
        h('div', { class: 'chips' }, (chips || []).map((c) => h('span', { class: 'chip' }, c))),
      ]);
    },
    /** Sortable, filterable table.
     * opts: { columns:[{key,label,render(row)->string|Node,sort(row)->value,cls,footer,sortable,exportValue(row)}], rows, onRow(row), empty, pageSize, search:true,
     *         filters:[{key,label,options}], toolbar, actions(row)->[Node], exportName:'file.csv', caption }
     */
    table(opts) {
      const wrap = h('div', {});
      let sortKey = null, sortDir = 1, query = '', page = 0, lastRows = [];
      const fstate = {};
      const pageSize = opts.pageSize || 15;
      const filterBar = (opts.search !== false || opts.filters || opts.exportName || opts.toolbar) ? h('div', { class: 'filters' }) : null;
      if (filterBar) {
        if (opts.search !== false) filterBar.appendChild(h('input', { type: 'search', placeholder: 'Search…', 'aria-label': 'Search ' + (opts.caption || 'table'), onInput: (e) => { query = e.target.value.toLowerCase(); page = 0; draw(); } }));
        (opts.filters || []).forEach((f) => {
          const sel = h('select', { 'aria-label': 'Filter by ' + f.label, onChange: (e) => { fstate[f.key] = e.target.value; page = 0; draw(); } }, [h('option', { value: '' }, 'All ' + f.label)].concat((f.options || []).map((o) => { const ov = typeof o === 'object' ? o.value : o; return h('option', { value: ov }, typeof o === 'object' ? o.label : o); })));
          filterBar.appendChild(sel);
        });
        if (opts.toolbar) [].concat(opts.toolbar).forEach((n) => filterBar.appendChild(n));
        if (opts.exportName) filterBar.appendChild(ui.btn('⇩ CSV', () => exportCsv(opts.exportName, lastRows, opts.columns.map((c) => ({ label: c.label, value: (r) => (c.exportValue ? c.exportValue(r) : c.render ? cellText(c.render(r)) : r[c.key]) }))), 'sm', { 'aria-label': 'Export table as CSV' }));
        wrap.appendChild(filterBar);
      }
      const tw = h('div', { class: 'table-wrap' });
      const foot = h('div', { class: 'tbl-foot' });
      wrap.appendChild(tw); wrap.appendChild(foot);
      const cell = (c, r) => { const v = c.render ? c.render(r) : r[c.key]; return v instanceof Node ? v : document.createTextNode(v == null || v === '' ? '—' : String(v)); };
      function sortBy(c) { if (sortKey === c.key) sortDir = -sortDir; else { sortKey = c.key; sortDir = 1; } draw(); const th = tw.querySelector('th[data-key="' + CSS.escape(String(c.key)) + '"]'); if (th) th.focus(); }
      function draw() {
        let rows = (typeof opts.rows === 'function' ? opts.rows() : opts.rows).slice();
        Object.keys(fstate).forEach((k) => { if (fstate[k]) rows = rows.filter((r) => String(r[k]) === fstate[k]); });
        if (query) rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(query));
        if (sortKey) { const c = opts.columns.find((x) => x.key === sortKey); const fn = c.sort || ((r) => r[c.key]); rows.sort((a, b) => { const x = fn(a), y = fn(b); return (x > y ? 1 : x < y ? -1 : 0) * sortDir; }); }
        lastRows = rows;
        const total = rows.length;
        const pages = Math.max(1, Math.ceil(total / pageSize));
        if (page >= pages) page = pages - 1;
        const view = rows.slice(page * pageSize, page * pageSize + pageSize);
        const t = h('table', { class: 'tbl' }, opts.caption ? h('caption', { class: 'sr-only' }, opts.caption) : null);
        const thr = h('tr', {}, opts.columns.map((c) => {
          const sortable = c.sortable !== false;
          const th = h('th', { class: (c.cls || '') + (sortable ? ' sortable' : ''), scope: 'col', 'data-key': c.key, 'aria-sort': sortKey === c.key ? (sortDir > 0 ? 'ascending' : 'descending') : (sortable ? 'none' : null), onClick: sortable ? () => sortBy(c) : null }, c.label + (sortKey === c.key ? (sortDir > 0 ? ' ▲' : ' ▼') : ''));
          if (sortable) { th.setAttribute('tabindex', '0'); th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(c); } }); }
          return th;
        }));
        if (opts.actions) thr.appendChild(h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')));
        t.appendChild(h('thead', {}, thr));
        const tb = h('tbody');
        view.forEach((r) => {
          const tr = h('tr', { class: opts.onRow ? 'clickable' : '', onClick: opts.onRow ? (e) => { if (!e.target.closest('button,a,input,select,textarea,label')) opts.onRow(r); } : null }, opts.columns.map((c) => h('td', { class: c.cls || '' }, cell(c, r))));
          if (opts.onRow) { tr.setAttribute('tabindex', '0'); tr.addEventListener('keydown', (e) => { if (e.target === tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); opts.onRow(r); } }); }
          if (opts.actions) tr.appendChild(h('td', { class: 'nowrap right' }, opts.actions(r)));
          tb.appendChild(tr);
        });
        t.appendChild(tb);
        if (opts.columns.some((c) => c.footer)) t.appendChild(h('tfoot', {}, h('tr', {}, opts.columns.map((c) => h('td', { class: c.cls || '' }, c.footer ? String(c.footer(rows)) : '')).concat(opts.actions ? [h('td')] : []))));
        tw.innerHTML = '';
        if (!view.length) tw.appendChild(ui.empty(opts.empty || 'No records found'));
        else tw.appendChild(t);
        foot.innerHTML = '';
        foot.appendChild(h('span', { 'aria-live': 'polite' }, total + ' record' + (total === 1 ? '' : 's')));
        if (pages > 1) foot.appendChild(h('span', { class: 'row' }, [ui.btn('‹', () => { if (page > 0) { page--; draw(); } }, 'sm', { 'aria-label': 'Previous page' }), h('span', {}, (page + 1) + ' / ' + pages), ui.btn('›', () => { if (page < pages - 1) { page++; draw(); } }, 'sm', { 'aria-label': 'Next page' })]));
      }
      draw();
      wrap.redraw = draw;
      wrap.rows = () => lastRows.slice();
      return wrap;
    },
    empty(text, icon) { return h('div', { class: 'empty' }, [h('div', { class: 'big', 'aria-hidden': 'true' }, icon || '∅'), text]); },

    /** Form builder. fields: [{key,label,type:'text'|'number'|'date'|'datetime-local'|'time'|'email'|'tel'|'select'|'textarea'|'checkbox'|'readonly'|'section',
     *   options:[...]|[{value,label}], required, full, hint, placeholder, onChange(value, inputs), format:'phone'|'email'|'gstin'|'pincode', validate(value, values)->errorString|null, min, max, step, readonly}] */
    form(fields, values) {
      values = values || {};
      const el = h('div', { class: 'form' });
      const inputs = {};
      const errs = {};
      fields.forEach((f) => {
        if (f.type === 'section') { el.appendChild(h('div', { class: 'full', style: 'margin-top:6px' }, h('h3', {}, f.label))); return; }
        const id = 'f_' + f.key + '_' + util.uid();
        let input;
        const v = values[f.key] != null ? values[f.key] : (f.default != null ? f.default : '');
        if (f.type === 'select') {
          const opts = (f.options || []).slice();
          if (v !== '' && v != null && !opts.some((o) => String(typeof o === 'object' ? o.value : o) === String(v))) opts.push(v); // keep a stored value that left the master list
          input = h('select', { id }, [h('option', { value: '' }, f.placeholder || 'Select…')].concat(opts.map((o) => { const ov = typeof o === 'object' ? o.value : o; const ol = typeof o === 'object' ? o.label : o; return h('option', { value: ov, selected: String(ov) === String(v) ? true : null }, ol); })));
        } else if (f.type === 'textarea') input = h('textarea', { id, placeholder: f.placeholder || '' }, v);
        else if (f.type === 'checkbox') input = h('input', { id, type: 'checkbox', checked: v ? true : null });
        else {
          const type = f.type === 'readonly' ? 'text' : f.format === 'phone' ? 'tel' : f.format === 'email' ? 'email' : (f.type || 'text');
          input = h('input', { id, type, value: v, readonly: f.type === 'readonly' || f.readonly ? true : null, placeholder: f.placeholder || '', min: f.min, max: f.max, step: f.step, inputmode: f.format === 'phone' ? 'tel' : f.format === 'pincode' ? 'numeric' : null, autocomplete: f.autocomplete || null });
        }
        if (f.required) input.setAttribute('aria-required', 'true');
        if (f.onChange) input.addEventListener('change', () => f.onChange(input.type === 'checkbox' ? input.checked : input.value, inputs));
        inputs[f.key] = input;
        const errEl = h('div', { class: 'err', id: id + '_err', 'aria-live': 'polite' });
        errs[f.key] = errEl;
        const hintEl = f.hint ? h('div', { class: 'hint', id: id + '_hint' }, f.hint) : null;
        input.setAttribute('aria-describedby', (hintEl ? id + '_hint ' : '') + id + '_err');
        const field = h('div', { class: 'field' + (f.full || f.type === 'textarea' ? ' full' : '') }, f.type === 'checkbox'
          ? [h('label', { class: 'check-row', for: id }, [input, f.label]), hintEl, errEl]
          : [h('label', { for: id }, [f.label, f.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null]), input, hintEl, errEl]);
        el.appendChild(field);
      });
      el.values = () => {
        const out = {};
        fields.forEach((f) => { const i = inputs[f.key]; if (!i) return; out[f.key] = i.type === 'checkbox' ? i.checked : f.type === 'number' ? (i.value === '' ? null : Number(i.value)) : (f.format === 'gstin' ? i.value.trim().toUpperCase() : i.value); });
        return out;
      };
      el.validate = () => {
        let missing = false, invalid = false;
        const vals = el.values();
        fields.forEach((f) => {
          const i = inputs[f.key]; if (!i) return;
          const raw = i.type === 'checkbox' ? i.checked : String(i.value).trim();
          let msg = '';
          if (f.required && (i.type === 'checkbox' ? !raw : raw === '')) { msg = 'Required'; missing = true; }
          else if (raw !== '' && raw !== false && f.format && validate[f.format] && !validate[f.format](raw)) { msg = validate.messages[f.format]; invalid = true; }
          else if (f.type === 'number' && raw !== '' && ((f.min != null && Number(raw) < Number(f.min)) || (f.max != null && Number(raw) > Number(f.max)))) { msg = 'Enter a value' + (f.min != null ? ' from ' + f.min : '') + (f.max != null ? ' up to ' + f.max : ''); invalid = true; }
          else if (f.validate) { const m = f.validate(vals[f.key], vals); if (m) { msg = m; invalid = true; } }
          i.closest('.field').classList.toggle('invalid', !!msg);
          i.setAttribute('aria-invalid', msg ? 'true' : 'false');
          errs[f.key].textContent = msg && msg !== 'Required' ? msg : '';
        });
        if (missing) ui.toast('Please fill all mandatory fields', 'bad');
        else if (invalid) ui.toast('Please correct the highlighted fields', 'bad');
        const firstBad = el.querySelector('.field.invalid input, .field.invalid select, .field.invalid textarea');
        if (firstBad) firstBad.focus();
        return !missing && !invalid;
      };
      el.inputs = inputs;
      return el;
    },

    /** Modal dialog. opts: { title, sub, body: Node|string(trusted HTML), wide, actions:[{label, cls, onClick(close)->false keeps open}], onClose } */
    modal(opts) {
      const titleId = 'dlg_' + util.uid();
      let closed = false, release = null;
      const close = () => { if (closed) return; closed = true; ov.remove(); if (release) release(); if (opts.onClose) try { opts.onClose(); } catch (e) { console.error(e); } };
      const ov = h('div', { class: 'overlay', onClick: (e) => { if (e.target === ov) close(); } });
      const body = typeof opts.body === 'string' ? h('div', { html: opts.body }) : opts.body;
      const m = h('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
        h('div', { class: 'modal-head' }, [h('div', {}, [h('h2', { id: titleId }, opts.title), opts.sub ? h('div', { class: 'muted small' }, opts.sub) : null]), h('button', { class: 'btn ghost', type: 'button', onClick: close, 'aria-label': 'Close dialog' }, '✕')]),
        h('div', { class: 'modal-body' }, body),
        h('div', { class: 'modal-foot' }, (opts.actions || [{ label: 'Close' }]).map((a) => ui.btn(a.label, () => { const r = a.onClick ? a.onClick(close) : undefined; if (r !== false) close(); }, a.cls))),
      ]);
      ov.appendChild(m);
      document.body.appendChild(ov);
      release = registerDialog(m, close);
      return { close, el: m };
    },
    /** Right-side drawer for record details. opts: { title, sub, body, actions:[{label, cls, onClick(close), close:false}], onClose } */
    drawer(opts) {
      const titleId = 'dlg_' + util.uid();
      let closed = false, release = null;
      const close = () => { if (closed) return; closed = true; ov.remove(); d.remove(); if (release) release(); if (opts.onClose) try { opts.onClose(); } catch (e) { console.error(e); } };
      const ov = h('div', { class: 'drawer-overlay', onClick: () => close() });
      const body = typeof opts.body === 'string' ? h('div', { html: opts.body }) : opts.body;
      const d = h('div', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
        h('div', { class: 'modal-head' }, [h('div', {}, [h('h2', { id: titleId }, opts.title), opts.sub ? h('div', { class: 'muted small' }, opts.sub) : null]), h('button', { class: 'btn ghost', type: 'button', onClick: () => close(), 'aria-label': 'Close panel' }, '✕')]),
        h('div', { class: 'modal-body' }, body),
        opts.actions && opts.actions.length ? h('div', { class: 'modal-foot' }, opts.actions.map((a) => ui.btn(a.label, () => { const r = a.onClick ? a.onClick(close) : undefined; if (r !== false && a.close !== false) close(); }, a.cls))) : null,
      ]);
      document.body.appendChild(ov); document.body.appendChild(d);
      release = registerDialog(d, close);
      return { close, el: d };
    },
    /** Quick form-in-modal. onSave(values) -> false to keep open. */
    formModal(title, fields, values, onSave, opts) {
      const f = ui.form(fields, values);
      return ui.modal(Object.assign({ title, body: f, actions: [{ label: 'Cancel' }, { label: (opts && opts.saveLabel) || 'Save', cls: 'primary', onClick: () => { if (!f.validate()) return false; return onSave(f.values()); } }] }, opts || {}));
    },
    confirm(title, text, onYes) { return ui.modal({ title, body: h('p', {}, text), actions: [{ label: 'Cancel' }, { label: 'Confirm', cls: 'primary', onClick: onYes }] }); },
    toast(msg, tone) {
      let box = document.querySelector('.toasts');
      if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(box); }
      const t = h('div', { class: 'toast ' + (tone || ''), role: tone === 'bad' ? 'alert' : null }, msg);
      box.appendChild(t);
      setTimeout(() => t.remove(), tone === 'bad' ? 5000 : 3200);
    },
    tabs(items, onChange, active) {
      // items: [{id,label,count}] ; renders the active tab's content into a body container via onChange(id, body)
      const wrap = h('div');
      const bar = h('div', { class: 'tabs', role: 'tablist' });
      const body = h('div', { role: 'tabpanel', tabindex: '-1' });
      let cur = active || items[0].id;
      const pre = 'tab_' + util.uid();
      function sel(id, focus) {
        cur = id;
        bar.querySelectorAll('button').forEach((b) => { const on = b.dataset.id === id; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); b.setAttribute('tabindex', on ? '0' : '-1'); if (on) { body.setAttribute('aria-labelledby', b.id); if (focus) b.focus(); } });
        body.innerHTML = ''; onChange(id, body);
      }
      items.forEach((t, i) => bar.appendChild(h('button', { type: 'button', role: 'tab', id: pre + '_' + i, 'data-id': t.id, onClick: () => sel(t.id) }, t.label + (t.count != null ? ' (' + t.count + ')' : ''))));
      bar.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const idx = items.findIndex((t) => t.id === cur);
        const n = items[(idx + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
        e.preventDefault(); sel(n.id, true);
      });
      wrap.appendChild(bar); wrap.appendChild(body);
      setTimeout(() => sel(cur));
      return wrap;
    },
    /** Kanban board. opts: { columns:[{id,label,color}], items, colOf(item), card(item)->Node, onMove(item, toColId)->bool, sum(items)->string, onClick(item), cardLabel(item)->string }
     * Keyboard: cards are focusable (Enter opens), and when onMove is set each card has a "Move" button with a stage menu. */
    kanban(opts) {
      const board = h('div', { class: 'kanban' });
      opts.columns.forEach((c) => {
        const its = opts.items.filter((i) => opts.colOf(i) === c.id);
        const col = h('div', { class: 'kcol', 'data-col': c.id, role: 'group', 'aria-label': c.label + ' (' + its.length + ')' }, [h('div', { class: 'kcol-head' }, [h('span', {}, [h('span', { class: 'div-tag', style: '--c:' + (c.color || 'var(--brand)') }, c.label), ' ', h('span', { class: 'badge' }, its.length)]), opts.sum ? h('span', { class: 'sum' }, opts.sum(its)) : null])]);
        its.forEach((i) => {
          const card = h('div', { class: 'kcard', draggable: opts.onMove ? 'true' : null, onClick: (e) => { if (e.target.closest('.kmove')) return; if (opts.onClick) opts.onClick(i); } }, opts.card(i));
          if (opts.onClick) keyActivate(card, () => opts.onClick(i), (opts.cardLabel ? opts.cardLabel(i) : (card.textContent || '').trim().slice(0, 80)) + ' — open');
          else card.setAttribute('tabindex', '0');
          if (opts.onMove) {
            const mv = h('button', { type: 'button', class: 'btn sm ghost kmove', 'aria-haspopup': 'menu', 'aria-label': 'Move to another stage' }, 'Move ▸');
            mv.addEventListener('click', (e) => { e.stopPropagation(); popMenu(mv, opts.columns.filter((x) => x.id !== c.id).map((x) => ({ label: x.label, onClick: () => opts.onMove(i, x.id) }))); });
            card.appendChild(mv);
          }
          card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', i.id); });
          col.appendChild(card);
        });
        if (opts.onMove) {
          col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
          col.addEventListener('dragleave', () => col.classList.remove('drop'));
          col.addEventListener('drop', (e) => { e.preventDefault(); col.classList.remove('drop'); const id = e.dataTransfer.getData('text/plain'); const it = opts.items.find((x) => x.id === id); if (it && opts.colOf(it) !== c.id) opts.onMove(it, c.id); });
        }
        board.appendChild(col);
      });
      return board;
    },
    /** Small popup menu anchored to a button. items: [{label, onClick}] */
    menu: (anchor, items) => popMenu(anchor, items),
    /** Stepper. steps: [labels]; current index; blockedIndex optional */
    stepper(steps, current, blocked) {
      return h('ol', { class: 'stepper', 'aria-label': 'Progress' }, steps.map((s, i) => h('li', { class: 'step ' + (i < current ? 'done' : i === current ? (blocked ? 'blocked' : 'current') : ''), 'aria-current': i === current ? 'step' : null }, [h('div', { class: 'dot', 'aria-hidden': 'true' }, i < current ? '✓' : String(i + 1)), h('div', {}, s)])));
    },
    /** Checklist bound to an object map {item: true}. onChange(stateObj) */
    checklist(items, stateObj, onChange, readOnly) {
      stateObj = stateObj || {};
      const wrap = h('div');
      const prog = h('div', { class: 'progress', style: 'margin-bottom:8px', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(items.length) }, h('i'));
      const lbl = h('div', { class: 'small muted', style: 'margin-bottom:4px' });
      const list = h('div', { class: 'checklist' });
      function upd() { const done = items.filter((i) => stateObj[i]).length; prog.firstChild.style.width = util.pct(done, items.length) + '%'; prog.setAttribute('aria-valuenow', String(done)); prog.style.setProperty('--pc', done === items.length ? 'var(--ok)' : 'var(--chart-1)'); lbl.textContent = done + ' of ' + items.length + ' checks complete'; }
      items.forEach((it) => {
        const cb = h('input', { type: 'checkbox', checked: stateObj[it] ? true : null, disabled: readOnly ? true : null });
        const l = h('label', { class: stateObj[it] ? 'done' : '' }, [cb, h('span', {}, it)]);
        cb.addEventListener('change', () => { stateObj[it] = cb.checked; l.classList.toggle('done', cb.checked); upd(); if (onChange) onChange(stateObj); });
        list.appendChild(l);
      });
      wrap.appendChild(lbl); wrap.appendChild(prog); wrap.appendChild(list);
      upd();
      wrap.complete = () => items.every((i) => stateObj[i]);
      return wrap;
    },
    progress(pct, color) { const p = Math.min(100, Math.max(0, Number(pct) || 0)); return h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(p)), style: '--pc:' + (color || (pct >= 100 ? 'var(--ok)' : pct >= 60 ? 'var(--chart-1)' : 'var(--chart-4)')) }, h('i', { style: 'width:' + p + '%' })); },
    timeline(items) {
      // items: [{when, title, body, color}]
      return h('div', { class: 'timeline' }, items.map((i) => h('div', { class: 'tl-item' }, [h('div', { class: 'tl-dot', style: i.color ? 'background:' + i.color : null }), h('div', {}, [h('div', { class: 'when' }, i.when), h('div', { style: 'font-weight:600' }, i.title), i.body ? h('div', { class: 'small muted' }, i.body) : null])])));
    },
    dl(pairs) {
      // pairs: [[label, value|Node], ...]
      return h('dl', { class: 'dl' }, pairs.filter(Boolean).map(([k, v]) => h('div', {}, [h('dt', {}, k), h('dd', {}, v instanceof Node ? v : (v == null || v === '' ? '—' : String(v)))])));
    },
    /** Callout. A string is plain TEXT (escaped — markup shows literally, so user data can never inject HTML). Pass a Node to append it as-is.
     * For trusted module markup use ui.calloutHtml(html, tone) or callout(html, tone, { html: true }). */
    callout(text, tone, opts) {
      const el = h('div', { class: 'callout ' + (tone || ''), role: tone === 'bad' ? 'alert' : null });
      if (text instanceof Node) el.appendChild(text);
      else if (opts && opts.html) el.appendChild(sanitize(text, SAFE_RICH));
      else el.textContent = text == null ? '' : String(text);
      return el;
    },
    /** Callout with trusted module markup (still sanitised: b/strong/i/em/u/br/code/small/span[class]/div[class]/p/ul/ol/li/a[href]). Always util.esc() user data you concatenate in. */
    calloutHtml(html, tone) { return ui.callout(html, tone, { html: true }); },
    auditTrail(col, id) {
      const items = (state.audit || []).filter((a) => a.col === col && a.recId === id).slice().reverse();
      if (!items.length) return ui.empty('No audit entries yet', '📜');
      return ui.timeline(items.map((a) => ({ when: fmt.dateTime(a.ts) + ' · ' + a.user + ' (' + (role(a.role) ? role(a.role).name : a.role) + ')', title: a.action.toUpperCase(), body: a.note })));
    },

    // -------------------------------------------- charts (dependency-free SVG)
    /** Vertical bar chart. data: [{label, values:[n...]}], series:[{name,color}], opts: {height, money, label} */
    barChart(data, series, opts) {
      opts = opts || {};
      series = series || [{ name: 'Value', color: 'var(--chart-1)' }];
      const W = 600, H = opts.height || 220, P = { l: 46, r: 8, t: 10, b: 34 };
      const max = Math.max(1, ...data.flatMap((d) => d.values)) * 1.1;
      const bw = (W - P.l - P.r) / Math.max(1, data.length);
      const inner = Math.min(38, (bw * 0.72) / series.length);
      const v2s = (v) => (opts.money ? fmt.lakh(v) : fmt.num(v));
      const aria = opts.label || ('Bar chart. ' + data.slice(0, 16).map((d) => d.label + ': ' + d.values.map((v, j) => (series.length > 1 ? series[j].name + ' ' : '') + v2s(v)).join(', ')).join('; '));
      let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + util.esc(aria) + '">';
      for (let i = 0; i <= 4; i++) { const y = P.t + (H - P.t - P.b) * (i / 4); const v = max * (1 - i / 4); s += '<line x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y + '" y2="' + y + '" stroke="var(--border)" />' + '<text x="' + (P.l - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + (opts.money ? fmt.lakh(v).replace('₹', '') : Math.round(v)) + '</text>'; }
      data.forEach((d, i) => {
        const x0 = P.l + i * bw + (bw - inner * series.length) / 2;
        d.values.forEach((v, j) => { const bh = (H - P.t - P.b) * (v / max); s += '<rect x="' + (x0 + j * inner) + '" y="' + (H - P.b - bh) + '" width="' + Math.max(0, inner - 2) + '" height="' + Math.max(0, bh) + '" rx="3" fill="' + series[j].color + '"><title>' + util.esc(d.label + ' · ' + series[j].name + ': ' + v2s(v)) + '</title></rect>'; });
        s += '<text x="' + (P.l + i * bw + bw / 2) + '" y="' + (H - P.b + 16) + '" text-anchor="middle">' + util.esc(String(d.label).slice(0, 14)) + '</text>';
      });
      s += '</svg>';
      const legend = series.length > 1 ? '<div class="legend">' + series.map((x) => '<span><i style="background:' + x.color + '"></i>' + util.esc(x.name) + '</span>').join('') + '</div>' : '';
      return h('div', { class: 'chart', html: s + legend });
    },
    /** Line chart. labels:[..], series:[{name,color,values:[..],dashed}], opts: {height, money, area, label} */
    lineChart(labels, series, opts) {
      opts = opts || {};
      const W = 600, H = opts.height || 220, P = { l: 46, r: 10, t: 10, b: 30 };
      const max = Math.max(1, ...series.flatMap((x) => x.values)) * 1.1;
      const x = (i) => P.l + (W - P.l - P.r) * (labels.length < 2 ? 0.5 : i / (labels.length - 1));
      const y = (v) => P.t + (H - P.t - P.b) * (1 - v / max);
      const v2s = (v) => (opts.money ? fmt.lakh(v) : fmt.num(v));
      const aria = opts.label || ('Line chart. ' + series.map((sr) => sr.name + ': ' + labels.map((l, i) => l + ' ' + v2s(sr.values[i])).join(', ')).join('; '));
      let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + util.esc(aria.slice(0, 900)) + '">';
      for (let i = 0; i <= 4; i++) { const yy = P.t + (H - P.t - P.b) * (i / 4); s += '<line x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--border)"/><text x="' + (P.l - 6) + '" y="' + (yy + 4) + '" text-anchor="end">' + (opts.money ? fmt.lakh(max * (1 - i / 4)).replace('₹', '') : Math.round(max * (1 - i / 4))) + '</text>'; }
      labels.forEach((l, i) => { s += '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + util.esc(l) + '</text>'; });
      series.forEach((sr) => {
        const pts = sr.values.map((v, i) => x(i) + ',' + y(v)).join(' ');
        if (opts.area) s += '<polygon points="' + x(0) + ',' + (H - P.b) + ' ' + pts + ' ' + x(sr.values.length - 1) + ',' + (H - P.b) + '" fill="' + sr.color + '" opacity=".1"/>';
        s += '<polyline points="' + pts + '" fill="none" stroke="' + sr.color + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"' + (sr.dashed ? ' stroke-dasharray="5 4"' : '') + '/>';
        sr.values.forEach((v, i) => { s += '<circle cx="' + x(i) + '" cy="' + y(v) + '" r="3.2" fill="var(--surface)" stroke="' + sr.color + '" stroke-width="2"><title>' + util.esc(sr.name + ' · ' + labels[i] + ': ' + v2s(v)) + '</title></circle>'; });
      });
      s += '</svg>';
      return h('div', { class: 'chart', html: s + '<div class="legend">' + series.map((sr) => '<span><i style="background:' + sr.color + '"></i>' + util.esc(sr.name) + '</span>').join('') + '</div>' });
    },
    /** Donut. data: [{label, value, color}], opts: {money, center, label} */
    donut(data, opts) {
      opts = opts || {};
      const total = util.sum(data, (d) => d.value);
      const R = 60, C = 2 * Math.PI * R;
      let off = 0;
      const v2s = (v) => (opts.money ? fmt.lakh(v) : v);
      const aria = (opts.label || 'Total') + ' ' + v2s(total) + '. ' + data.map((d) => d.label + ': ' + v2s(d.value) + ' (' + util.pct(d.value, total) + '%)').join('; ');
      let s = '<svg viewBox="0 0 160 160" style="max-width:170px" role="img" aria-label="' + util.esc(aria) + '"><circle cx="80" cy="80" r="' + R + '" fill="none" stroke="var(--surface-3)" stroke-width="20"/>';
      data.forEach((d) => { const len = total ? (d.value / total) * C : 0; s += '<circle cx="80" cy="80" r="' + R + '" fill="none" stroke="' + d.color + '" stroke-width="20" stroke-dasharray="' + len + ' ' + (C - len) + '" stroke-dashoffset="' + (-off) + '" transform="rotate(-90 80 80)"><title>' + util.esc(d.label + ': ' + v2s(d.value)) + '</title></circle>'; off += len; });
      s += '<text x="80" y="78" text-anchor="middle" style="font-size:18px;font-weight:700;fill:var(--text)">' + util.esc(opts.center != null ? opts.center : v2s(total)) + '</text><text x="80" y="96" text-anchor="middle">' + util.esc(opts.label || 'Total') + '</text></svg>';
      const legend = '<div class="legend" style="flex-direction:column;gap:6px">' + data.map((d) => '<span><i style="background:' + d.color + '"></i>' + util.esc(d.label) + ' — <b>' + util.esc(v2s(d.value)) + '</b> (' + util.pct(d.value, total) + '%)</span>').join('') + '</div>';
      return h('div', { class: 'chart', style: 'display:flex;gap:18px;align-items:center;flex-wrap:wrap', html: s + legend });
    },
    /** Horizontal bars, e.g. target vs achieved. rows: [{label, value, target, color, text}] */
    hbars(rows, opts) {
      opts = opts || {};
      const max = Math.max(1, ...rows.map((r) => Math.max(r.value, r.target || 0)));
      return h('div', { class: 'hbar' }, rows.flatMap((r) => {
        const pct = r.target ? util.pct(r.value, r.target) : null;
        const color = r.color || (pct == null ? 'var(--chart-1)' : pct >= 100 ? 'var(--ok)' : pct >= 70 ? 'var(--chart-1)' : pct >= 40 ? 'var(--chart-4)' : 'var(--bad)');
        return [
          h('div', { class: 'small', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, r.label),
          h('div', { class: 'bar', title: r.target ? 'Target ' + r.target : '', 'aria-hidden': 'true' }, h('i', { style: 'width:' + (r.value / max * 100) + '%;background:' + color })),
          h('div', { class: 'small nowrap' }, r.text || ((opts.money ? fmt.lakh(r.value) : fmt.num(r.value)) + (r.target ? ' / ' + (opts.money ? fmt.lakh(r.target) : fmt.num(r.target)) + ' · ' + pct + '%' : ''))),
        ];
      }));
    },
  };

  function popMenu(anchor, items) {
    document.querySelectorAll('.pop-menu').forEach((m) => m.remove());
    const menu = h('div', { class: 'pop-menu', role: 'menu' }, items.map((it) => h('button', { type: 'button', role: 'menuitem', class: 'pop-item', onClick: (e) => { e.stopPropagation(); menu.remove(); it.onClick(); } }, it.label)));
    const r = anchor.getBoundingClientRect();
    menu.style.top = Math.min(window.innerHeight - 40, r.bottom + 4) + 'px';
    menu.style.left = Math.max(8, Math.min(window.innerWidth - 220, r.left)) + 'px';
    document.body.appendChild(menu);
    const btns = menu.querySelectorAll('button');
    if (btns[0]) btns[0].focus();
    menu.addEventListener('keydown', (e) => {
      const list = Array.from(btns); const i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      if (e.key === 'Escape') { e.stopPropagation(); menu.remove(); anchor.focus(); }
      if (e.key === 'Tab') menu.remove();
    });
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', off); } }), 0);
    return menu;
  }

  function closeOverlays() { document.querySelectorAll('.overlay,.drawer,.drawer-overlay,.pop-menu').forEach((e) => e.remove()); openDialogs(); }

  // ---------------------------------------------------------------- exports
  /** CSV download. columns: ['key', …] | [{key, label, value(row)}]; default = keys of the first row. Formula-injection safe, UTF-8 BOM for Excel. */
  function exportCsv(filename, rows, columns) {
    rows = rows || [];
    const cols = (columns && columns.length ? columns : Object.keys(rows[0] || {})).map((c) => (typeof c === 'string' ? { key: c, label: c } : c));
    const q = (v) => {
      let s = v == null ? '' : v instanceof Date ? util.iso(v) : v instanceof Node ? cellText(v) : typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.map((c) => q(c.label || c.key)).join(',')].concat(rows.map((r) => cols.map((c) => q(c.value ? c.value(r) : r[c.key])).join(',')));
    const name = /\.csv$/i.test(filename || '') ? filename : (filename || 'export') + '.csv';
    downloadBlob(name, new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    audit('export', 'exports', name, rows.length + ' rows exported to CSV');
    return lines.length - 1;
  }
  /** Print-friendly document (user saves as PDF from the print dialog). htmlOrNode: trusted HTML string or a DOM node (cloned). */
  function exportPdf(title, htmlOrNode, opts) {
    opts = opts || {};
    const bodyHtml = htmlOrNode instanceof Node ? htmlOrNode.outerHTML : String(htmlOrNode || '');
    const base = location.href.replace(/#.*$/, '').replace(/[^/]*$/, '');
    const frame = h('iframe', { title: 'Print preview', 'aria-hidden': 'true', style: 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden' });
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    doc.open();
    doc.write('<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><base href="' + util.esc(base) + '"><title>' + util.esc(title) + '</title>' +
      '<link rel="stylesheet" href="assets/fonts/fonts.css"><link rel="stylesheet" href="assets/css/app.css"></head><body class="print-doc">' +
      '<header class="print-head"><img src="assets/brand/logo-primary.png" alt="Maruthi Power Control Systems"><div><h1>' + util.esc(title) + '</h1><div class="muted small">' + util.esc((opts.sub ? opts.sub + ' · ' : '') + 'Generated ' + fmt.dateTime(new Date()) + ' by ' + user().name) + '</div></div></header>' +
      '<main>' + bodyHtml + '</main><footer class="print-foot">Maruthi Power Control Systems · Power · Electronic Security · Solar</footer></body></html>');
    doc.close();
    let printed = false;
    const doPrint = () => { if (printed) return; printed = true; try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (e) { ui.toast('Could not open the print dialog', 'bad'); } setTimeout(() => frame.remove(), 60000); };
    frame.addEventListener('load', () => setTimeout(doPrint, 150));
    setTimeout(doPrint, 1200);
    audit('export', 'exports', title, 'Printed / saved as PDF');
    return frame;
  }

  // ---------------------------------------------------------------- attachments (IndexedDB, localStorage fallback)
  const FILE_DB = 'mpcs-crm-files', FILE_STORE = 'files', FILE_LS = 'mpcs-crm-file-';
  const FILE_MAX = 1.5 * 1048576, FILE_BUDGET = 25 * 1048576, FILE_LS_BUDGET = 2 * 1048576;
  let idbPromise = null;
  function idb() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((res, rej) => {
      let req;
      try { if (!window.indexedDB) throw new Error('IndexedDB unavailable'); req = indexedDB.open(FILE_DB, 1); } catch (e) { rej(e); return; }
      req.onupgradeneeded = () => req.result.createObjectStore(FILE_STORE);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
      req.onblocked = () => rej(new Error('IndexedDB blocked'));
    });
    idbPromise.catch(() => { idbPromise = null; });
    return idbPromise;
  }
  function idbDo(mode, fn) { return idb().then((d) => new Promise((res, rej) => { const tx = d.transaction(FILE_STORE, mode); const req = fn(tx.objectStore(FILE_STORE)); tx.oncomplete = () => res(req && req.result); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('aborted')); })); }
  const bytesOfDataUrl = (u) => Math.round((String(u).length - String(u).indexOf(',') - 1) * 3 / 4);
  function readAsDataUrl(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error || new Error('Could not read the file')); r.readAsDataURL(blob); }); }
  function fileCanView(meta) { return !meta.viewRoles || !meta.viewRoles.length || meta.viewRoles.includes(currentRoleId()) || MGMT.includes(currentRoleId()); }

  const files = {
    MAX_BYTES: FILE_MAX, BUDGET_BYTES: FILE_BUDGET,
    usage() { const all = db.all('attachments'); return { bytes: util.sum(all, 'size'), count: all.length, limit: FILE_BUDGET }; },
    /** Store a File/Blob or data URL. meta: { recordType, recordId, label, name, viewRoles, note }. Resolves to the attachment record (same label → next version). */
    add(file, meta) {
      meta = meta || {};
      return Promise.resolve().then(() => {
        if (!meta.recordType || !meta.recordId) throw new Error('Attachment needs recordType and recordId');
        const isStr = typeof file === 'string';
        if (!file || (isStr && !/^data:/.test(file))) throw new Error('No file selected');
        const size = isStr ? bytesOfDataUrl(file) : file.size;
        if (size > FILE_MAX) throw new Error('This file is ' + util.fileSize(size) + '. The limit is 1.5 MB per file — compress or scan at a lower resolution.');
        const use = files.usage();
        if (use.bytes + size > FILE_BUDGET) throw new Error('Attachment storage is full (' + util.fileSize(use.bytes) + ' of 25 MB used). Remove old files first.');
        return (isStr ? Promise.resolve(file) : readAsDataUrl(file)).then((dataUrl) => ({ dataUrl, size, type: isStr ? (/^data:([^;,]+)/.exec(file) || [])[1] || 'application/octet-stream' : file.type || 'application/octet-stream', name: meta.name || (isStr ? (meta.label || 'capture') + (/image\/png/.test(file) ? '.png' : /image\//.test(file) ? '.jpg' : '') : file.name) }));
      }).then((f) => {
        const label = String(meta.label || f.name || 'Document').trim();
        const prev = db.find('attachments', (a) => a.recordType === meta.recordType && a.recordId === meta.recordId && a.label.toLowerCase() === label.toLowerCase());
        const version = prev.length ? Math.max(...prev.map((a) => a.version || 1)) + 1 : 1;
        const id = nextId('ATT');
        return idbDo('readwrite', (s) => s.put(f.dataUrl, id)).then(() => 'idb', () => {
          const lsUsed = util.sum(db.find('attachments', (a) => a.storage === 'ls'), 'size');
          if (lsUsed + f.size > FILE_LS_BUDGET) throw new Error('Attachment storage is unavailable in this browser and the small fallback store (2 MB) is full.');
          if (!ls.set(FILE_LS + id, f.dataUrl)) throw new Error('Could not store the file — browser storage is full or blocked');
          return 'ls';
        }).then((storage) => db.insert('attachments', { id, recordType: meta.recordType, recordId: meta.recordId, label, version, name: f.name, type: f.type, size: f.size, storage, viewRoles: meta.viewRoles || null, uploadedBy: user().id, uploadedByName: user().name, uploadedRole: currentRoleId(), note: meta.note || '' }, { note: 'Attached ' + label + ' v' + version + ' (' + f.name + ') to ' + meta.recordType + ' ' + meta.recordId }));
      });
    },
    /** Attachments on a record. Default: latest version per label (newest first). opts.allVersions → every version. */
    list(recordType, recordId, opts) {
      const all = db.find('attachments', (a) => a.recordType === recordType && a.recordId === recordId).sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
      if (opts && opts.allVersions) return all;
      const seen = {}; return all.filter((a) => { const k = a.label.toLowerCase(); if (seen[k]) return false; seen[k] = true; return true; });
    },
    versions(recordType, recordId, label) { return db.find('attachments', (a) => a.recordType === recordType && a.recordId === recordId && a.label.toLowerCase() === String(label).toLowerCase()).sort((a, b) => (b.version || 1) - (a.version || 1)); },
    has(recordType, recordId, label) { return db.all('attachments').some((a) => a.recordType === recordType && a.recordId === recordId && (!label || a.label.toLowerCase() === String(label).toLowerCase())); },
    /** Resolve to the data URL (access is audited). Rejects when the role may not view it. */
    get(id) {
      const meta = db.get('attachments', id);
      if (!meta) return Promise.reject(new Error('Attachment not found'));
      if (!fileCanView(meta)) { audit('denied', 'attachments', id, 'Blocked access to ' + meta.label + ' for ' + role().name); return Promise.reject(new Error('Your role cannot open this attachment')); }
      const fromLs = () => ls.get(FILE_LS + id);
      return (meta.storage === 'ls' ? Promise.resolve(fromLs()) : idbDo('readonly', (s) => s.get(id)).catch(fromLs)).then((d) => {
        if (!d) throw new Error('The file content is no longer available in this browser');
        audit('view', 'attachments', id, 'Opened ' + meta.label + ' v' + meta.version + ' (' + meta.recordType + ' ' + meta.recordId + ')');
        return d;
      });
    },
    /** Preview in a dialog with a download link. */
    open(id) {
      const meta = db.get('attachments', id);
      return files.get(id).then((d) => {
        const isImg = /^image\//.test(meta.type);
        const a = h('a', { class: 'btn primary', href: d, download: meta.name }, '⇩ Download');
        ui.modal({ title: meta.label + ' · v' + meta.version, sub: meta.name + ' · ' + util.fileSize(meta.size) + ' · ' + meta.uploadedByName + ' · ' + fmt.dateTime(meta.createdAt), wide: isImg, body: h('div', { class: 'stack' }, [isImg ? h('img', { src: d, alt: meta.label, class: 'att-preview' }) : ui.callout('Preview is not available for this file type. Use Download to open it.', 'info'), h('div', {}, a)]) });
      }).catch((e) => { ui.toast(e.message, 'bad'); });
    },
    remove(id) {
      const meta = db.get('attachments', id); if (!meta) return Promise.resolve();
      db.remove('attachments', id);
      ls.remove(FILE_LS + id);
      return idbDo('readwrite', (s) => s.delete(id)).catch(() => {});
    },
    _wipe() {
      try { Object.keys(localStorage).filter((k) => k.indexOf(FILE_LS) === 0).forEach((k) => ls.remove(k)); } catch (e) { /* ignore */ }
      return new Promise((res) => {
        const done = () => res();
        Promise.resolve(idbPromise).then((d) => { try { if (d) d.close(); } catch (e) { /* ignore */ } }).catch(() => {}).then(() => {
          try { const r = indexedDB.deleteDatabase(FILE_DB); r.onsuccess = done; r.onerror = done; r.onblocked = done; } catch (e) { done(); }
          setTimeout(done, 1000);
        });
      });
    },
  };

  /** Read an image File, downscale to maxSize px and re-encode as JPEG to keep attachments small. */
  function compressImage(file, maxSize, quality) {
    return readAsDataUrl(file).then((src) => new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, (maxSize || 1280) / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        try { res(c.toDataURL('image/jpeg', quality || 0.8)); } catch (e) { res(src); }
      };
      img.onerror = () => res(src);
      img.src = src;
    }));
  }

  /** Attachment list + upload for a record. opts: { roles: uploadRoles (default all but vendor), viewRoles, labels: [suggested labels], title, readOnly, accept, onChange(list) } */
  ui.attachments = function (recordType, recordId, opts) {
    opts = opts || {};
    const wrap = h('div', { class: 'attachments' });
    const canUpload = !opts.readOnly && (opts.roles ? [].concat(opts.roles).includes(currentRoleId()) : currentRoleId() !== 'vendor');
    const canView = !opts.viewRoles || [].concat(opts.viewRoles).includes(currentRoleId()) || MGMT.includes(currentRoleId());
    function draw() {
      wrap.innerHTML = '';
      if (!canView) { wrap.appendChild(ui.callout('Attachments on this record are restricted for the ' + role().name + ' role.', 'warn')); return; }
      const list = files.list(recordType, recordId);
      const head = h('div', { class: 'att-head' }, [h('b', {}, opts.title || 'Attachments'), h('span', { class: 'muted small' }, list.length ? list.length + ' document' + (list.length === 1 ? '' : 's') : ''), canUpload ? ui.btn('＋ Upload', () => uploadDialog(), 'sm', { 'aria-label': 'Upload attachment' }) : null]);
      wrap.appendChild(head);
      if (!list.length) { wrap.appendChild(h('div', { class: 'muted small att-empty' }, canUpload ? 'No files yet. Upload photos, drawings, reports or signed documents (max 1.5 MB each).' : 'No files attached.')); return; }
      const ul = h('ul', { class: 'att-list' });
      list.forEach((a) => {
        const hist = files.versions(recordType, recordId, a.label);
        const li = h('li', {}, [
          h('span', { class: 'att-ico', 'aria-hidden': 'true' }, /^image\//.test(a.type) ? '🖼' : /pdf/.test(a.type) ? '📄' : '📎'),
          h('div', { class: 'att-meta' }, [h('div', {}, [h('b', {}, a.label), ' ', h('span', { class: 'badge info' }, 'v' + (a.version || 1))]), h('div', { class: 'small muted' }, a.name + ' · ' + util.fileSize(a.size) + ' · ' + a.uploadedByName + ' · ' + fmt.dateTime(a.createdAt))]),
          h('div', { class: 'row' }, [ui.btn('Open', () => files.open(a.id), 'sm', { 'aria-label': 'Open ' + a.label }), hist.length > 1 ? ui.btn('History (' + hist.length + ')', () => historyDialog(a.label), 'sm ghost') : null]),
        ]);
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
    }
    function historyDialog(label) {
      ui.modal({ title: label + ' — version history', body: ui.table({ rows: files.versions(recordType, recordId, label), search: false, columns: [{ key: 'version', label: 'Version', render: (a) => 'v' + a.version }, { key: 'name', label: 'File' }, { key: 'uploadedByName', label: 'Uploaded by' }, { key: 'createdAt', label: 'When', render: (a) => fmt.dateTime(a.createdAt) }, { key: 'size', label: 'Size', render: (a) => util.fileSize(a.size) }], actions: (a) => [ui.btn('Open', () => files.open(a.id), 'sm')] }) });
    }
    function uploadDialog() {
      const existing = files.list(recordType, recordId).map((a) => a.label);
      const sugg = Array.from(new Set((opts.labels || []).concat(existing)));
      const listId = 'att_l_' + util.uid();
      const lblIn = h('input', { type: 'text', list: listId, id: listId + '_in', placeholder: 'e.g. Signed handover, Site photo', value: sugg[0] || '' });
      const fileIn = h('input', { type: 'file', id: listId + '_f', accept: opts.accept || 'image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt' });
      const body = h('div', { class: 'form' }, [
        h('div', { class: 'field full' }, [h('label', { for: listId + '_in' }, 'Document label'), lblIn, h('datalist', { id: listId }, sugg.map((s) => h('option', { value: s }))), h('div', { class: 'hint' }, 'Uploading with an existing label saves a new version; older versions stay available.')]),
        h('div', { class: 'field full' }, [h('label', { for: listId + '_f' }, 'File (max 1.5 MB)'), fileIn]),
      ]);
      ui.modal({ title: 'Upload attachment', sub: recordType + ' ' + recordId, body, actions: [{ label: 'Cancel' }, { label: 'Upload', cls: 'primary', onClick: (close) => {
        const f = fileIn.files[0];
        if (!f) { ui.toast('Choose a file to upload', 'bad'); return false; }
        if (!lblIn.value.trim()) { ui.toast('Add a document label', 'bad'); return false; }
        const go2 = /^image\//.test(f.type) && f.size > 400 * 1024 ? compressImage(f, 1600, 0.82) : Promise.resolve(f);
        go2.then((payload) => files.add(payload, { recordType, recordId, label: lblIn.value.trim(), name: f.name, viewRoles: opts.viewRoles })).then((rec) => { close(); ui.toast('Uploaded ' + rec.label + ' v' + rec.version, 'ok'); draw(); if (opts.onChange) opts.onChange(files.list(recordType, recordId)); }).catch((e) => ui.toast(e.message, 'bad'));
        return false;
      } }] });
    }
    draw();
    wrap.redraw = draw;
    return wrap;
  };

  /** Camera/photo input. opts: { label, value(dataUrl), onChange(dataUrl), maxSize (px, default 1280), quality } → element with getValue() / clear() */
  ui.photoCapture = function (opts) {
    opts = opts || {};
    let value = opts.value || '';
    const id = 'pc_' + util.uid();
    const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', id, class: 'sr-only' });
    const preview = h('div', { class: 'pc-preview' });
    const wrap = h('div', { class: 'photo-capture' }, [h('label', { for: id, class: 'btn sm', tabindex: '0', role: 'button' }, opts.label || '📷 Take or choose photo'), input, preview]);
    const lab = wrap.querySelector('label');
    lab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    function show() {
      preview.innerHTML = '';
      if (!value) return;
      preview.appendChild(h('img', { src: value, alt: (opts.label || 'Photo') + ' preview' }));
      preview.appendChild(ui.btn('Remove', () => { value = ''; show(); if (opts.onChange) opts.onChange(''); }, 'sm ghost'));
    }
    input.addEventListener('change', () => {
      const f = input.files[0]; input.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type)) { ui.toast('Choose an image file', 'bad'); return; }
      compressImage(f, opts.maxSize || 1280, opts.quality || 0.8).then((d) => {
        if (bytesOfDataUrl(d) > FILE_MAX) { ui.toast('Photo is too large even after compression', 'bad'); return; }
        value = d; show(); if (opts.onChange) opts.onChange(d);
      }).catch(() => ui.toast('Could not read the photo', 'bad'));
    });
    show();
    wrap.getValue = () => value;
    wrap.clear = () => { value = ''; show(); };
    return wrap;
  };

  /** Signature pad (mouse/touch/stylus) with a typed-name fallback. opts: { label, height, onChange(dataUrl) } → element with getValue() (PNG data URL or ''), isEmpty(), clear() */
  ui.signaturePad = function (opts) {
    opts = opts || {};
    const W = 600, H = opts.height || 180;
    const canvas = h('canvas', { width: W, height: H, class: 'sig-canvas', role: 'img', 'aria-label': (opts.label || 'Signature') + ' pad. Draw with mouse, finger or stylus, or type the name below.' });
    const g = canvas.getContext('2d');
    let dirty = false, drawing = false, last = null;
    function blank() { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.strokeStyle = '#D4D7DB'; g.beginPath(); g.moveTo(20, H - 30); g.lineTo(W - 20, H - 30); g.stroke(); }
    blank();
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; };
    canvas.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } e.preventDefault(); });
    canvas.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); g.strokeStyle = '#0A0A0A'; g.lineWidth = 2.4; g.lineCap = 'round'; g.lineJoin = 'round'; g.beginPath(); g.moveTo(last[0], last[1]); g.lineTo(p[0], p[1]); g.stroke(); last = p; dirty = true; });
    const end = () => { if (drawing) { drawing = false; if (opts.onChange) opts.onChange(canvas.toDataURL('image/png')); } };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointerleave', end); canvas.addEventListener('pointercancel', end);
    const tid = 'sig_' + util.uid();
    const typed = h('input', { type: 'text', id: tid, placeholder: 'Or type full name', autocomplete: 'name' });
    const wrap = h('div', { class: 'sig-pad' }, [canvas, h('div', { class: 'row' }, [h('label', { for: tid, class: 'sr-only' }, 'Type signer name instead of drawing'), typed, ui.btn('Clear', () => wrap.clear(), 'sm ghost')])]);
    wrap.isEmpty = () => !dirty && !typed.value.trim();
    wrap.clear = () => { dirty = false; typed.value = ''; blank(); if (opts.onChange) opts.onChange(''); };
    wrap.typedName = () => typed.value.trim();
    wrap.getValue = () => {
      if (!dirty && typed.value.trim()) { blank(); g.fillStyle = '#0A0A0A'; g.font = 'italic 700 46px "Barlow", Arial, sans-serif'; g.textBaseline = 'alphabetic'; g.fillText(typed.value.trim().slice(0, 30), 30, H - 42); dirty = true; }
      return dirty ? canvas.toDataURL('image/png') : '';
    };
    return wrap;
  };

  // ---------------------------------------------------------------- shell rendering
  function renderBell() {
    const dot = document.getElementById('bellDot');
    if (!dot || !state) return;
    const u = user();
    const n = myNotifications().filter((x) => !isRead(x, u)).length;
    dot.textContent = n > 99 ? '99+' : n;
    dot.classList.toggle('hidden', !n);
    const btn = document.getElementById('bellBtn');
    if (btn) btn.setAttribute('aria-label', 'Notifications' + (n ? ', ' + n + ' unread' : ''));
  }
  function closeNotifPanel(focusBell) {
    const p = document.querySelector('.notif-panel'); if (p) p.remove();
    const btn = document.getElementById('bellBtn'); if (btn) { btn.setAttribute('aria-expanded', 'false'); if (focusBell) btn.focus(); }
  }
  function openNotification(n, panel) {
    const u = user();
    markRead(n, u); renderBell(); panel.remove();
    document.getElementById('bellBtn').setAttribute('aria-expanded', 'false');
    if (!n.link) return;
    const pid = pageIdOfLink(n.link);
    if (!canSee(pid)) { ui.toast('The ' + role().name + ' role cannot open that page', 'warn'); return; }
    location.hash = n.link;
  }
  function toggleNotifPanel() {
    const host = document.getElementById('bellWrap');
    const btn = document.getElementById('bellBtn');
    if (host.querySelector('.notif-panel')) { closeNotifPanel(); return; }
    const u = user();
    const list = myNotifications().slice(0, 40);
    const panel = h('div', { class: 'notif-panel', role: 'region', 'aria-label': 'Notifications and alerts' }, [
      h('div', { class: 'card-head' }, [h('h3', {}, 'Notifications & Alerts'), ui.btn('Mark all read', () => { list.forEach((n) => markRead(n, u)); persist(); renderBell(); closeNotifPanel(true); }, 'sm ghost')]),
    ].concat(list.length ? list.map((n) => {
      const unread = !isRead(n, u);
      const item = h('div', { class: 'notif ' + (unread ? 'unread' : ''), onClick: () => openNotification(n, panel) }, [
        h('div', { class: 'row', style: 'justify-content:space-between' }, [h('b', {}, n.title), ui.badge(n.severity === 'bad' ? 'Escalation' : n.severity === 'warn' ? 'Alert' : n.severity === 'ok' ? 'Done' : 'Info', n.severity === 'info' ? 'info' : n.severity)]),
        n.body ? h('div', { class: 'small' }, n.body) : null,
        h('div', { class: 'when' }, fmt.dateTime(n.createdAt) + ' · ' + n.channel),
      ]);
      keyActivate(item, () => openNotification(n, panel), (unread ? 'Unread: ' : '') + n.title + (n.body ? '. ' + n.body : ''));
      return item;
    }) : [ui.empty('You are all caught up', '🔔')]));
    host.appendChild(panel);
    btn.setAttribute('aria-expanded', 'true');
    const first = panel.querySelector('.notif') || panel.querySelector('button');
    if (first) first.focus();
  }
  document.addEventListener('click', (e) => { const p = document.querySelector('.notif-panel'); if (p && !e.target.closest('#bellWrap')) closeNotifPanel(); });

  const searchProviders = [];
  function registerSearch(fn) { searchProviders.push(fn); } // fn(query) -> [{label, sub, link}]
  function doSearch(q) {
    const box = document.getElementById('searchResults');
    if (!q || q.length < 2) { box.classList.add('hidden'); return; }
    const ql = q.toLowerCase();
    let res = [];
    visiblePages().filter((p) => p.title.toLowerCase().includes(ql)).slice(0, 3).forEach((p) => res.push({ label: p.title, sub: 'Page · ' + (p.section || ''), link: '#/' + p.id }));
    if (canSee('customer360')) master.customers().filter((c) => (c.name + ' ' + c.id + ' ' + c.contact + ' ' + c.phone + ' ' + (c.gstin || '')).toLowerCase().includes(ql)).slice(0, 5).forEach((c) => res.push({ label: c.name, sub: 'Customer · ' + c.id + ' · ' + c.area, link: '#/customer360/' + c.id }));
    searchProviders.forEach((fn) => { try { res = res.concat(fn(ql) || []); } catch (e) { /* ignore */ } });
    res = res.filter((r) => canSee(pageIdOfLink(r.link)));
    box.innerHTML = '';
    if (!res.length) box.appendChild(h('div', { class: 'empty small', role: 'status' }, 'No matches'));
    res.slice(0, 14).forEach((r) => box.appendChild(h('a', { href: r.link, onClick: () => box.classList.add('hidden') }, [h('div', { style: 'font-weight:600' }, r.label), h('div', { class: 'small muted' }, r.sub)])));
    box.classList.remove('hidden');
  }

  function buildShell() {
    const roleSel = h('select', { id: 'roleSelect', 'aria-label': 'Demo: preview the CRM as another role', onChange: (e) => switchRole(e.target.value) },
      ROLE_GROUPS.map((g) => h('optgroup', { label: g }, ROLES.filter((r) => r.group === g).map((r) => h('option', { value: r.id, selected: r.id === currentRoleId() ? true : null }, r.name)))));
    const r = role();
    const app = h('div', { class: 'app' }, [
      h('a', { class: 'skip-link', href: '#content', onClick: (e) => { e.preventDefault(); contentEl.focus(); } }, 'Skip to content'),
      h('aside', { class: 'sidebar', 'aria-label': 'Main navigation' }, [
        h('a', { class: 'brand', href: '#/home', 'aria-label': 'Maruthi Power Control Systems — home' }, [h('img', { src: 'assets/brand/logo-reversed.png', alt: 'Maruthi Power Control Systems', width: 200, height: 36 }), h('div', { class: 'brand-sub' }, 'Unified CRM · Since 1996')]),
        h('div', { class: 'speed-bands', 'aria-hidden': 'true' }),
        navEl = h('nav', { class: 'nav', 'aria-label': 'Pages' }),
        h('div', { class: 'side-foot' }, [h('div', { class: 'tagline' }, 'Power that stays on.'), h('div', { class: 'tagline-ta', lang: 'ta' }, 'தடையில்லா மின்சாரம், தளராத நம்பிக்கை.'), h('div', {}, 'Power · Electronic Security · Solar'), h('a', { href: '#/', class: 'reset-link', role: 'button', onClick: (e) => { e.preventDefault(); ui.confirm('Reset demo data', 'This clears all local CRM data and attachments in this browser and regenerates the sample dataset. Continue?', () => db.reset()); } }, '↺ Reset demo data')]),
      ]),
      h('div', { class: 'main' }, [
        h('header', { class: 'topbar' }, [
          h('button', { class: 'icon-btn menu-btn ico', type: 'button', 'aria-label': 'Open menu', onClick: () => app.classList.toggle('nav-open'), html: svg('<path d="M4 7h16M4 12h16"/><path class="acc" d="M4 17h10"/>') }),
          h('img', { class: 'top-logo', src: 'assets/brand/logo-compact.png', alt: 'Maruthi' }),
          h('div', { class: 'search', role: 'search' }, [h('input', { type: 'search', 'aria-label': 'Search customers, enquiries, projects, complaints and pages', placeholder: 'Search customers, enquiries, projects, complaints…', onInput: util.debounce((e) => doSearch(e.target.value), 180), onBlur: () => setTimeout(() => { const sr = document.getElementById('searchResults'); if (sr && !sr.contains(document.activeElement)) sr.classList.add('hidden'); }, 200) }), h('div', { id: 'searchResults', class: 'search-results hidden', 'aria-live': 'polite' })]),
          h('div', { class: 'top-spacer' }),
          h('button', { class: 'icon-btn ico theme-btn', type: 'button', title: 'Toggle light / dark theme', 'aria-label': 'Toggle light or dark theme', onClick: toggleTheme, html: svg('<circle cx="12" cy="12" r="8"/><path class="acc" d="M12 4a8 8 0 010 16z"/>') }),
          h('div', { id: 'bellWrap', style: 'position:relative' }, [h('button', { id: 'bellBtn', class: 'icon-btn ico', type: 'button', title: 'Notifications', 'aria-label': 'Notifications', 'aria-expanded': 'false', onClick: (e) => { e.stopPropagation(); toggleNotifPanel(); } }, [h('span', { style: 'display:grid', html: svg('<path d="M6 16V11a6 6 0 0112 0v5l2 2H4z"/><path class="acc" d="M10 20a2 2 0 004 0"/>') }), h('span', { id: 'bellDot', class: 'dot hidden', 'aria-hidden': 'true' }, '0')])]),
          h('label', { class: 'role-switch', title: 'Demo only: preview each user experience. Access control here is a client-side preview, not security.' }, [h('span', { class: 'demo-tag' }, 'Demo role'), h('span', { class: 'avatar', id: 'roleAvatar', style: 'background:' + r.color, 'aria-hidden': 'true' }, util.initials(r.user)), roleSel]),
        ]),
        h('div', { id: 'banners', class: 'banners' }),
        contentEl = h('main', { class: 'content', id: 'content', tabindex: '-1' }),
      ]),
    ]);
    document.body.appendChild(app);
  }

  function switchRole(id) {
    if (!ls.set(ROLE_KEY, id)) ui.toast('Could not remember the role — storage is blocked', 'warn');
    const r = role();
    const av = document.getElementById('roleAvatar');
    av.textContent = util.initials(r.user); av.style.background = r.color;
    renderBell();
    ui.toast('Switched to ' + r.name + ' (' + user().name + ')', 'ok');
    emit('role:changed', r);
    if (location.hash === '#/home' || location.hash === '#/' || !location.hash) render(); else go('home');
  }
  function toggleTheme() {
    const root = document.documentElement;
    const cur = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    ls.set(THEME_KEY, next);
  }

  // ---------------------------------------------------------------- importers
  const importers = [];
  /** def: { id, title, collection, prefix, roles, description, columns:[{key,label,required,type:'text'|'number'|'date'|'enum'|'phone'|'email'|'gstin'|'bool',options,aliases}],
   *        map(row, ctx)->record | {error} | {skip}, dedupe(record, ctx)->reason|null, onInserted(record), after(records), sample:[[…]] } */
  function registerImporter(def) { if (!def || !def.id || importers.some((x) => x.id === def.id)) return; importers.push(Object.assign({ roles: ['admin'], columns: [] }, def)); }
  function parseCsv(text) {
    text = String(text || '').replace(/^﻿/, '');
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }
  util.parseCsv = parseCsv;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function runImporter(imp, text) {
    const grid = parseCsv(text);
    if (grid.length < 2) return { error: 'No data rows found. The first row must be the column headers.' };
    const header = grid[0].map((x) => x.trim());
    const idx = {};
    imp.columns.forEach((c) => { const names = [c.key, c.label].concat(c.aliases || []).map(norm); const i = header.findIndex((hh) => names.includes(norm(hh))); if (i >= 0) idx[c.key] = i; });
    const missingCols = imp.columns.filter((c) => c.required && idx[c.key] == null).map((c) => c.label || c.key);
    if (missingCols.length) return { error: 'Missing required column(s): ' + missingCols.join(', ') + '. Download the template to see the expected headers.' };
    const ctx = { batch: [], db, master, util };
    const results = grid.slice(1).map((cells, n) => {
      const rowNo = n + 2; const errors = []; const row = {};
      imp.columns.forEach((c) => {
        const raw = idx[c.key] == null ? '' : String(cells[idx[c.key]] == null ? '' : cells[idx[c.key]]).trim();
        if (!raw) { if (c.required) errors.push((c.label || c.key) + ' is required'); row[c.key] = c.type === 'number' ? null : ''; return; }
        if (c.type === 'number') { const v = Number(raw.replace(/[₹,\s]/g, '')); if (!isFinite(v)) errors.push((c.label || c.key) + ' must be a number'); row[c.key] = v; }
        else if (c.type === 'date') { const d = parseDate(raw); if (!d) errors.push((c.label || c.key) + ' is not a date (use DD/MM/YYYY or YYYY-MM-DD)'); row[c.key] = d ? util.iso(d) : ''; }
        else if (c.type === 'enum') { const o = (typeof c.options === 'function' ? c.options() : c.options || []).find((x) => norm(x) === norm(raw)); if (!o) errors.push((c.label || c.key) + ' "' + raw + '" is not one of: ' + (typeof c.options === 'function' ? c.options() : c.options || []).join(', ')); row[c.key] = o || raw; }
        else if (c.type === 'bool') row[c.key] = /^(y|yes|true|1)$/i.test(raw);
        else if (c.type === 'gstin') { const v = raw.toUpperCase(); if (!validate.gstin(v)) errors.push(validate.messages.gstin); row[c.key] = v; }
        else if (c.type === 'phone' || c.type === 'email') { if (!validate[c.type](raw)) errors.push((c.label || c.key) + ': ' + validate.messages[c.type]); row[c.key] = raw; }
        else row[c.key] = raw;
      });
      let rec = null, status = 'Ready', msg = '';
      if (errors.length) { status = 'Error'; msg = errors.join('; '); }
      else {
        try {
          const m = imp.map ? imp.map(row, ctx) : row;
          if (!m) { status = 'Skipped'; msg = 'Ignored by importer'; }
          else if (m.error) { status = 'Error'; msg = m.error; }
          else if (m.skip) { status = 'Skipped'; msg = m.skip; }
          else {
            rec = m;
            const dup = imp.dedupe ? imp.dedupe(rec, ctx) : null;
            if (dup) { status = 'Duplicate'; msg = dup; rec = null; } else ctx.batch.push(rec);
          }
        } catch (e) { status = 'Error'; msg = e.message; }
      }
      return { rowNo, row, rec, status, msg };
    });
    return { header, results };
  }

  function registerCoreImporters() {
    registerImporter({
      id: 'customers', title: 'Customers', collection: 'customers', prefix: 'CUS', roles: ['admin', 'sales_manager', 'sales_coordinator'],
      description: 'Customer master records. A Main Site is created for each customer from the address column.',
      columns: [
        { key: 'name', label: 'Account Name', required: true, aliases: ['Customer Name', 'Name'] }, { key: 'type', label: 'Customer Type', type: 'enum', options: CUSTOMER_TYPES, aliases: ['Type'] },
        { key: 'category', label: 'Customer Category', type: 'enum', options: CUSTOMER_CATEGORIES, aliases: ['Category'] }, { key: 'contact', label: 'Contact Name', required: true, aliases: ['Contact'] },
        { key: 'phone', label: 'Contact Number', required: true, type: 'phone', aliases: ['Phone', 'Mobile'] }, { key: 'altContact', label: 'Alternate Contact' }, { key: 'altPhone', label: 'Alternate Number', type: 'phone' },
        { key: 'email', label: 'Email', type: 'email' }, { key: 'area', label: 'Area', required: true, type: 'enum', options: () => AREAS }, { key: 'segment', label: 'Segment', type: 'enum', options: () => SEGMENTS },
        { key: 'gstin', label: 'GSTIN', type: 'gstin' }, { key: 'address', label: 'Address' },
      ],
      sample: [['Sri Lakshmi Textiles', 'Existing Customer', 'Non-Priority', 'Ravi K', '9876501234', '', '', 'accounts@srilakshmi.in', 'Tiruppur', 'Industrial', '33AACCS1234C1Z5', '12, Avinashi Road, Tiruppur']],
      map: (r) => ({ name: r.name, type: r.type || 'Existing Customer', category: r.category || (/Key/.test(r.type) ? 'Priority' : 'Non-Priority'), contact: r.contact, phone: r.phone, altContact: r.altContact, altPhone: r.altPhone, email: r.email, area: r.area, segment: r.segment || 'Commercial', gstin: r.gstin, since: util.iso(TODAY), source: 'Data import', _address: r.address }),
      dedupe: (rec, ctx) => { const d = findDuplicateCustomer(rec, null, ctx.batch); return d ? 'Matches ' + d.name + (d.id ? ' (' + d.id + ')' : ' earlier in this file') : null; },
      beforeInsert: (rec) => { const a = rec._address; delete rec._address; rec.id = nextCustomerId(); return a; },
      onInserted: (c, addr) => db.insert('sites', { customerId: c.id, name: 'Main Site', address: addr || c.area, area: c.area, contact: c.contact, phone: c.phone, access: 'Reception' }, { silent: true }),
    });
    registerImporter({
      id: 'products', title: 'Products', collection: 'products', prefix: 'PRD', roles: ['admin'],
      description: 'Product master. Products with an existing name are skipped.',
      columns: [{ key: 'division', label: 'Division', required: true, type: 'enum', options: () => DIVISIONS.map((d) => d.id) }, { key: 'category', label: 'Category', required: true }, { key: 'name', label: 'Product Name', required: true, aliases: ['Product', 'Name'] }, { key: 'price', label: 'Price', type: 'number', required: true }, { key: 'unit', label: 'Unit' }, { key: 'hsn', label: 'HSN' }, { key: 'warrantyMonths', label: 'Warranty Months', type: 'number' }],
      sample: [['Power', 'Inverter', 'Maruthi Inverter 2KVA', '17500', 'Nos', '8504', '24']],
      map: (r) => (r.price < 0 ? { error: 'Price cannot be negative' } : { division: r.division, category: r.category, name: r.name, price: r.price, unit: r.unit || 'Nos', hsn: r.hsn || '', warrantyMonths: r.warrantyMonths == null ? 12 : r.warrantyMonths, active: true }),
      dedupe: (rec, ctx) => (db.all('products').concat(ctx.batch).some((p) => p !== rec && norm(p.name) === norm(rec.name)) ? 'A product with this name already exists' : null),
    });
  }

  function findDuplicateCustomer(v, selfId, extra) {
    const nm = norm(v.name), ph = String(v.phone || '').replace(/\D/g, '').slice(-10), gst = String(v.gstin || '').toUpperCase();
    return master.customers().concat(extra || []).find((x) => x !== v && x.id !== selfId && (
      (nm && norm(x.name) === nm) || (ph.length === 10 && String(x.phone || '').replace(/\D/g, '').slice(-10) === ph) || (gst && String(x.gstin || '').toUpperCase() === gst))) || null;
  }

  // ---------------------------------------------------------------- built-in shared pages
  const ADMIN_PAGE_ROLES = ['admin', 'gm'];
  function registerCorePages() {
    registerPage({
      id: 'customer360', title: 'Customer 360', icon: '◎', section: 'Masters', order: 90,
      roles: ALL.filter((r) => r !== 'vendor'),
      render(el, [id]) {
        if (!id) {
          ui.page(el, { title: 'Customer Master', sub: 'Common customer master shared by Sales, Projects and Service', actions: canEditCustomer(null) ? [ui.btn('+ New customer', () => editCustomer(), 'primary')] : [] });
          el.appendChild(ui.card(null, ui.table({
            rows: () => master.customers().map((c) => Object.assign({}, c, { categoryX: master.customerCategory(c) })), onRow: (c) => go('customer360', c.id), caption: 'Customers', exportName: is('admin', 'gm', 'sales_manager') ? 'customers.csv' : null,
            filters: [{ key: 'type', label: 'types', options: CUSTOMER_TYPES }, { key: 'categoryX', label: 'categories', options: CUSTOMER_CATEGORIES }, { key: 'area', label: 'areas', options: AREAS }, { key: 'segment', label: 'segments', options: SEGMENTS }],
            columns: [
              { key: 'id', label: 'Customer ID', render: (c) => h('span', { class: 'mono' }, c.id) }, { key: 'name', label: 'Account name' }, { key: 'contact', label: 'Contact' }, { key: 'phone', label: 'Phone' },
              { key: 'area', label: 'Area' }, { key: 'segment', label: 'Segment' }, { key: 'type', label: 'Type', render: (c) => ui.badge(c.type, /Key/.test(c.type) ? 'violet' : c.type === 'Dealer' ? 'warn' : c.type === 'New Customer' ? 'info' : 'ok') },
              { key: 'categoryX', label: 'Category', render: (c) => ui.badge(c.categoryX, c.categoryX === 'Priority' ? 'brand' : '') },
            ],
          }), { flush: true }));
          return;
        }
        const c = master.customer(id);
        if (!c) { el.appendChild(ui.empty('Customer not found')); return; }
        const canEdit = canEditCustomer(c);
        ui.page(el, { title: c.name, crumbs: 'Customer 360 › ' + c.id, sub: (c.segment || '—') + ' · ' + (c.area || '—') + ' · Customer since ' + fmt.date(c.since), actions: [ui.btn('← All customers', () => go('customer360')), canEdit ? ui.btn('Edit', () => editCustomer(c), 'primary') : null] });
        const sections = [];
        customer360Sections.forEach((fn) => { try { const s = fn(c); if (s) sections.push(s); } catch (e) { console.error(e); } });
        const siteList = h('div', { class: 'stack', style: 'gap:10px' }, master.sites(c.id).map((s) => h('div', {}, [
          h('div', { class: 'row', style: 'justify-content:space-between' }, [h('b', {}, s.name + ' · ' + s.id), canEdit ? ui.btn('Edit', () => editSite(s), 'sm ghost', { 'aria-label': 'Edit site ' + s.name }) : null]),
          h('div', { class: 'small muted' }, s.address), h('div', { class: 'small' }, 'Access: ' + (s.access || '—') + ((s.utility && s.utility.discom) ? ' · ' + s.utility.discom : '') + ((s.utility && s.utility.consumerNo) || s.consumerNo ? ' · Consumer no. ' + ((s.utility && s.utility.consumerNo) || s.consumerNo) : '') + ((s.utility && s.utility.sanctionedLoad) || s.sanctionedLoadKw ? ' · ' + ((s.utility && s.utility.sanctionedLoad) || s.sanctionedLoadKw) + ' kW sanctioned' : '')),
        ])));
        const grid = h('div', { class: 'grid g3' }, [
          ui.card('Profile', ui.dl([['Customer ID', c.id], ['Type', ui.badge(c.type)], ['Category', ui.badge(master.customerCategory(c), master.customerCategory(c) === 'Priority' ? 'brand' : '')], ['Owner', c.ownerId ? master.staffName(c.ownerId) : '—'], ['Contact', c.contact], ['Phone', c.phone], ['Alternate contact', [c.altContact, c.altPhone].filter(Boolean).join(' · ')], ['Email', c.email], ['GSTIN', c.gstin], ['Area', c.area], ['Segment', c.segment]])),
          ui.card('Sites', siteList, { actions: canEdit ? [ui.btn('+ Site', () => editSite(null, c.id), 'sm')] : null }),
          ui.card('Relationship summary', h('div', { class: 'stack' }, sections.filter((s) => s.summary).map((s) => h('div', { class: 'row', style: 'justify-content:space-between' }, [h('span', {}, s.title), h('b', {}, s.summary)])))),
        ]);
        el.appendChild(grid);
        if (currentRoleId() !== 'accounts') el.appendChild(h('div', { class: 'mt' }, ui.card('Customer documents', ui.attachments('customers', c.id, { roles: CUSTOMER_EDIT_ROLES.concat(['sales_exec']), labels: ['Purchase order', 'GST certificate', 'Site layout', 'Agreement'] }))));
        sections.filter((s) => s.body).forEach((s) => { const b = s.body(); el.appendChild(h('div', { class: 'mt' }, ui.card(s.title, b, { flush: !!s.flush }))); });
      },
    });

    registerPage({
      id: 'audit', title: 'Audit Log', icon: '📜', section: 'Administration', order: 95, roles: ['admin', 'gm', 'odm'],
      render(el) {
        ui.page(el, { title: 'Audit Log', sub: 'Timestamped audit trail of every create, update, view of attachments, configuration change, import and export' });
        el.appendChild(ui.card(null, ui.table({
          rows: () => (state.audit || []).slice().reverse(), pageSize: 25, caption: 'Audit log', exportName: 'audit-log.csv',
          filters: [{ key: 'col', label: 'collections', options: Object.keys(util.countBy(state.audit || [], 'col')) }, { key: 'action', label: 'actions', options: Object.keys(util.countBy(state.audit || [], 'action')) }],
          columns: [{ key: 'ts', label: 'When', render: (a) => fmt.dateTime(a.ts) }, { key: 'user', label: 'User' }, { key: 'role', label: 'Role', render: (a) => (role(a.role) || {}).name || a.role }, { key: 'action', label: 'Action', render: (a) => ui.badge(a.action, a.action === 'create' ? 'ok' : a.action === 'delete' || a.action === 'denied' ? 'bad' : 'info') }, { key: 'col', label: 'Record type' }, { key: 'recId', label: 'Record', render: (a) => h('span', { class: 'mono' }, a.recId) }, { key: 'note', label: 'Details' }],
        }), { flush: true }));
      },
    });

    registerPage({
      id: 'users', title: 'Users & Access', icon: '👥', section: 'Administration', order: 96, roles: ['admin'],
      render(el) {
        ui.page(el, { title: 'Users & Role Access', sub: 'Add and edit users — role, division, area and skills drive lead assignment, engineer allocation and data scope', actions: [ui.btn('+ Add user', () => editUser(), 'primary')] });
        el.appendChild(ui.card('Staff directory', ui.table({
          rows: () => db.all('staff'), filters: [{ key: 'role', label: 'roles', options: ROLES.map((r) => ({ value: r.id, label: r.name })) }, { key: 'division', label: 'divisions', options: DIVISIONS.map((d) => d.id) }], caption: 'Staff directory', exportName: 'staff.csv',
          columns: [{ key: 'id', label: 'ID', render: (s) => h('span', { class: 'mono' }, s.id) }, { key: 'name', label: 'Name' }, { key: 'role', label: 'Role', render: (s) => (role(s.role) || {}).name || s.role }, { key: 'division', label: 'Division', render: (s) => (s.division ? ui.divTag(s.division) : 'All') }, { key: 'area', label: 'Area' }, { key: 'skills', label: 'Skills', render: (s) => (s.skills || []).join(', ') }, { key: 'phone', label: 'Phone' }, { key: 'active', label: 'Status', render: (s) => ui.badge(s.active ? 'Active' : 'Inactive') }],
          actions: (s) => [ui.btn('Edit', () => editUser(s), 'sm', { 'aria-label': 'Edit ' + s.name }), ui.btn(s.active ? 'Deactivate' : 'Activate', () => { if (s.primary && s.active) { ui.toast('The demo user for a role cannot be deactivated', 'warn'); return; } db.update('staff', s.id, { active: !s.active }); refresh(); }, 'sm')],
        }), { flush: true }));
        const matrix = h('div', { class: 'table-wrap' });
        const secs = [];
        pages.forEach((p) => { if (!secs.includes(p.section)) secs.push(p.section); });
        const t = h('table', { class: 'tbl' }, [h('caption', { class: 'sr-only' }, 'Pages visible per role and module'), h('thead', {}, h('tr', {}, [h('th', { scope: 'col' }, 'Role')].concat(secs.map((s) => h('th', { scope: 'col' }, s))))), h('tbody', {}, ROLES.map((r) => h('tr', {}, [h('th', { scope: 'row' }, r.name)].concat(secs.map((s) => { const ps = pages.filter((p) => p.section === s); const n = ps.filter((p) => p.roles.includes(r.id)).length; return h('td', {}, n ? ui.badge(n === ps.length ? 'Full' : n + '/' + ps.length, n === ps.length ? 'ok' : 'info') : h('span', { class: 'muted' }, '—')); })))))]);
        matrix.appendChild(t);
        el.appendChild(h('div', { class: 'mt' }, ui.card('Access matrix (pages visible per role and module)', matrix, { flush: true })));
      },
    });

    registerPage({
      id: 'masters', title: 'Master Data', icon: '🗂', section: 'Administration', order: 97, roles: ['admin'],
      render(el, [tab]) {
        ui.page(el, { title: 'Master Data', sub: 'Products, sites, areas, segments, lead sources, payment terms and divisions', actions: [ui.btn('Export data (JSON)', () => downloadBackup()), ui.btn('Import data (JSON)', () => importBackup())] });
        const used = (field) => (name) => db.all('customers').filter((c) => c[field] === name).length + db.all('sites').filter((s) => s[field] === name).length;
        el.appendChild(ui.tabs([{ id: 'p', label: 'Products' }, { id: 's', label: 'Sites' }, { id: 'areas', label: 'Areas' }, { id: 'segments', label: 'Segments' }, { id: 'leadSources', label: 'Lead sources' }, { id: 'terms', label: 'Payment terms' }, { id: 'div', label: 'Divisions' }], (id, body) => {
          if (id === 'p') body.appendChild(ui.card(null, ui.table({ rows: () => db.all('products'), caption: 'Products', exportName: 'products.csv', toolbar: [ui.btn('+ Product', () => editProduct(), 'sm primary')], filters: [{ key: 'division', label: 'divisions', options: DIVISIONS.map((d) => d.id) }], columns: [{ key: 'id', label: 'Code', render: (p) => h('span', { class: 'mono' }, p.id) }, { key: 'division', label: 'Division', render: (p) => ui.divTag(p.division) }, { key: 'category', label: 'Category' }, { key: 'name', label: 'Product' }, { key: 'price', label: 'Price', cls: 'right', render: (p) => fmt.money(p.price) }, { key: 'warrantyMonths', label: 'Warranty (m)', cls: 'right' }, { key: 'active', label: 'Status', render: (p) => ui.badge(p.active === false ? 'Inactive' : 'Active') }], actions: (p) => [ui.btn('Edit', () => editProduct(p), 'sm', { 'aria-label': 'Edit ' + p.name })] }), { flush: true }));
          else if (id === 's') body.appendChild(ui.card(null, ui.table({ rows: () => db.all('sites'), caption: 'Sites', toolbar: [ui.btn('+ Site', () => editSite(), 'sm primary')], columns: [{ key: 'id', label: 'Site ID', render: (s) => h('span', { class: 'mono' }, s.id) }, { key: 'customerId', label: 'Customer', render: (s) => (master.customer(s.customerId) || {}).name }, { key: 'name', label: 'Site' }, { key: 'address', label: 'Address' }, { key: 'access', label: 'Access arrangement' }], actions: (s) => [ui.btn('Edit', () => editSite(s), 'sm', { 'aria-label': 'Edit site ' + s.name })] }), { flush: true }));
          else if (id === 'areas') body.appendChild(listEditor('areas', 'Area', used('area')));
          else if (id === 'segments') body.appendChild(listEditor('segments', 'Segment', used('segment')));
          else if (id === 'leadSources') body.appendChild(listEditor('leadSources', 'Lead source', null));
          else if (id === 'terms') body.appendChild(termsEditor());
          else body.appendChild(divisionEditor());
        }, tab));
      },
    });

    registerPage({
      id: 'settings', title: 'Settings & Rules', icon: '⚙', section: 'Administration', order: 98,
      roles: Array.from(new Set(ADMIN_PAGE_ROLES.concat(configSections.flatMap((s) => s.roles || [])))),
      render(el, [tab]) {
        ui.page(el, { title: 'Settings & Rules', sub: 'Tax, working hours, holidays, notification channels, reports and module rules. Every change is recorded in the audit log.' });
        const secs = configSections.filter((s) => s.roles.includes(currentRoleId())).sort((a, b) => a.order - b.order);
        if (!secs.length) { el.appendChild(ui.empty('No settings are available for your role')); return; }
        el.appendChild(ui.tabs(secs.map((s) => ({ id: s.id, label: s.title })), (id, body) => {
          const s = secs.find((x) => x.id === id);
          try { s.render(body, { config, refresh: () => go('settings', id) }); } catch (e) { console.error(e); body.appendChild(ui.callout('This settings section failed to load: ' + e.message, 'bad')); }
        }, tab && secs.some((s) => s.id === tab) ? tab : secs[0].id));
      },
    });

    registerPage({
      id: 'dataimport', title: 'Data Import', icon: '⇪', section: 'Administration', order: 99,
      roles: Array.from(new Set(['admin'].concat(importers.flatMap((i) => i.roles || [])))),
      render(el, [which]) { renderImportPage(el, which); },
    });
  }

  function registerCoreConfigSections() {
    registerConfigSection({
      id: 'gst', title: 'GST rates', order: 10,
      render(el) {
        const rates = {}; DIVISIONS.forEach((d) => { rates[d.id] = config.gstRate(d.id); });
        const f = ui.form(DIVISIONS.map((d) => ({ key: d.id, label: d.name + ' GST %', type: 'number', min: 0, max: 28, step: 0.5, required: true })), rates);
        el.appendChild(ui.card('GST rate per division', h('div', { class: 'stack' }, [ui.callout('Quotations, orders and invoices use the division rate below. Solar defaults to 12% (composite supply); Power and Electronic Security to 18%.', 'info'), f, h('div', {}, ui.btn('Save GST rates', () => { if (!f.validate()) return; const v = f.values(); DIVISIONS.forEach((d) => { if (v[d.id] !== config.gstRate(d.id)) config.set('gst.' + d.id, v[d.id], 'GST rate for ' + d.id + ' set to ' + v[d.id] + '%'); }); ui.toast('GST rates saved', 'ok'); }, 'primary'))])));
      },
    });
    registerConfigSection({
      id: 'hours', title: 'Working hours & holidays', order: 20,
      render(el, ctx) {
        const wh = config.get('workHours');
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const boxes = dayNames.map((d, i) => { const id = 'wd_' + i + '_' + util.uid(); const cb = h('input', { type: 'checkbox', id, checked: wh.days.includes(i) ? true : null }); return { i, cb, el: h('label', { class: 'check-row', for: id }, [cb, d]) }; });
        const f = ui.form([{ key: 'start', label: 'Day starts', type: 'time', required: true }, { key: 'end', label: 'Day ends', type: 'time', required: true, validate: (v, all) => (v <= all.start ? 'End must be after start' : null) }, { key: 'applyToSla', label: 'Use working hours and holidays for SLA clocks', type: 'checkbox', full: true }], { start: wh.start, end: wh.end, applyToSla: config.get('sla.businessHours') });
        const example = h('div', { class: 'small muted' });
        const upd = () => { const now = new Date(); example.textContent = 'Example: a 4-hour SLA starting now (' + fmt.dateTime(now) + ') falls due ' + fmt.dateTime(addBusinessHours(now, 4)) + '.'; };
        upd();
        el.appendChild(ui.card('Working hours', h('div', { class: 'stack' }, [h('fieldset', { class: 'days' }, [h('legend', {}, 'Working days')].concat(boxes.map((b) => b.el))), f, example, h('div', {}, ui.btn('Save working hours', () => {
          if (!f.validate()) return;
          const days = boxes.filter((b) => b.cb.checked).map((b) => b.i);
          if (!days.length) { ui.toast('Select at least one working day', 'bad'); return; }
          const v = f.values();
          config.set('workHours', { days, start: v.start, end: v.end }, 'Working hours set to ' + days.map((d) => dayNames[d]).join(', ') + ' ' + v.start + '–' + v.end);
          config.set('sla.businessHours', !!v.applyToSla, 'SLA business hours ' + (v.applyToSla ? 'on' : 'off'));
          ui.toast('Working hours saved', 'ok'); upd();
        }, 'primary'))])));
        const names = () => config.get('holidayNames') || {};
        const setHol = (dates, nm, note) => { config.set('holidays', Array.from(new Set(dates)).sort(), note); if (nm) config.set('holidayNames', nm, note); };
        const holTable = () => ui.table({ rows: () => holidayDates().sort().map((d) => ({ id: d, date: d, name: names()[d] || 'Holiday' })), search: false, pageSize: 30, caption: 'Holidays', columns: [{ key: 'date', label: 'Date', render: (x) => fmt.date(x.date) + ' (' + dayNames[toDate(x.date).getDay()] + ')' }, { key: 'name', label: 'Holiday' }], actions: (x) => [ui.btn('Remove', () => { setHol(holidayDates().filter((d) => d !== x.date), null, 'Holiday removed: ' + x.name + ' ' + x.date); ctx.refresh(); }, 'sm', { 'aria-label': 'Remove ' + x.name })] });
        el.appendChild(h('div', { class: 'mt' }, ui.card('Holiday list', holTable(), { flush: true, actions: [ui.btn('+ Holiday', () => ui.formModal('Add holiday', [{ key: 'date', label: 'Date', type: 'date', required: true }, { key: 'name', label: 'Name', required: true }], {}, (v) => { const list = holidayDates(); if (list.includes(v.date)) { ui.toast('That date is already a holiday', 'bad'); return false; } const nm = names(); nm[v.date] = v.name; setHol(list.concat(v.date), nm, 'Holiday added: ' + v.name + ' ' + v.date); ui.toast('Holiday added', 'ok'); ctx.refresh(); }), 'sm primary')] })));
      },
    });
    registerConfigSection({
      id: 'notify', title: 'Notification channels', order: 30,
      render(el) {
        const tbl = h('table', { class: 'tbl' }, [h('caption', { class: 'sr-only' }, 'Channels per event type'), h('thead', {}, h('tr', {}, ['Event type', 'In-app', 'Email (simulated)', 'WhatsApp (simulated)'].map((x) => h('th', { scope: 'col' }, x)))), h('tbody', {}, NOTIFY_EVENTS.map((ev) => {
          const cur = config.channelsFor(ev.id);
          return h('tr', {}, [h('th', { scope: 'row' }, ev.label)].concat(['inapp', 'email', 'whatsapp'].map((ch) => {
            const cb = h('input', { type: 'checkbox', checked: cur[ch] ? true : null, 'aria-label': ev.label + ' — ' + ch });
            cb.addEventListener('change', () => { config.set('channels.' + ev.id, Object.assign({}, config.channelsFor(ev.id), { [ch]: cb.checked }), ev.label + ': ' + ch + ' ' + (cb.checked ? 'on' : 'off')); ui.toast('Saved', 'ok'); });
            return h('td', {}, cb);
          })));
        }))]);
        el.appendChild(ui.card('Channels per event type', h('div', { class: 'stack' }, [ui.callout('Email and WhatsApp are simulated in this demo: the notification records which channels it was "sent" on. In-app alerts appear in the bell and as a pop-up.', 'info'), h('div', { class: 'table-wrap' }, tbl)])));
      },
    });
    registerConfigSection({
      id: 'reports', title: 'Report configuration', order: 40,
      render(el) {
        const f = ui.form([{ key: 'period', label: 'Default report period', type: 'select', options: ['Today', 'This week', 'This month', 'This quarter', 'This financial year'], required: true }], { period: config.defaultPeriod() });
        el.appendChild(ui.card('Defaults', h('div', { class: 'stack' }, [f, h('div', {}, ui.btn('Save', () => { if (!f.validate()) return; config.set('reports.defaultPeriod', f.values().period, 'Default report period: ' + f.values().period); ui.toast('Saved', 'ok'); }, 'primary'))])));
        const en = config.get('reports.enabled') || {};
        const body = REPORTS.length ? h('div', { class: 'stack', style: 'gap:6px' }, Object.entries(util.groupBy(REPORTS, 'group')).map(([g, list]) => h('div', {}, [h('h3', { style: 'margin:8px 0 4px' }, g)].concat(list.map((r) => { const id = 'rep_' + util.uid(); const cb = h('input', { type: 'checkbox', id, checked: en[r.id] !== false ? true : null }); cb.addEventListener('change', () => { en[r.id] = cb.checked; config.set('reports.enabled', en, (cb.checked ? 'Enabled ' : 'Disabled ') + 'report ' + r.title); }); return h('label', { class: 'check-row', for: id }, [cb, r.title]); }))))) : ui.empty('Modules list their reports here once registered.');
        el.appendChild(h('div', { class: 'mt' }, ui.card('Enabled reports', body)));
      },
    });
  }

  // ---------------------------------------------------------------- master editors
  function listEditor(key, noun, usedFn) {
    const wrap = h('div');
    function draw() {
      wrap.innerHTML = '';
      const arr = LISTS[key];
      wrap.appendChild(ui.card(null, ui.table({ rows: arr.map((name, i) => ({ id: String(i), name, uses: usedFn ? usedFn(name) : null })), search: arr.length > 10, pageSize: 50, caption: noun + ' list', toolbar: [ui.btn('+ ' + noun, () => ui.formModal('Add ' + noun.toLowerCase(), [{ key: 'name', label: noun, required: true }], {}, (v) => { const n = v.name.trim(); if (arr.some((x) => norm(x) === norm(n))) { ui.toast(noun + ' already exists', 'bad'); return false; } setMasterList(key, arr.concat(n), 'Added ' + noun.toLowerCase() + ' ' + n); ui.toast('Added', 'ok'); draw(); }), 'sm primary')],
        columns: [{ key: 'name', label: noun }].concat(usedFn ? [{ key: 'uses', label: 'Used by', cls: 'right' }] : []),
        actions: (r) => [ui.btn('Rename', () => ui.formModal('Rename ' + noun.toLowerCase(), [{ key: 'name', label: noun, required: true }], { name: r.name }, (v) => { const n = v.name.trim(); if (n !== r.name && arr.some((x) => norm(x) === norm(n))) { ui.toast(noun + ' already exists', 'bad'); return false; } setMasterList(key, arr.map((x) => (x === r.name ? n : x)), 'Renamed ' + r.name + ' → ' + n); if (usedFn) { const field = key === 'areas' ? 'area' : 'segment'; ['customers', 'sites'].forEach((col) => db.all(col).filter((x) => x[field] === r.name).forEach((x) => db.update(col, x.id, { [field]: n }, { note: noun + ' renamed' }))); } ui.toast('Renamed', 'ok'); draw(); }), 'sm', { 'aria-label': 'Rename ' + r.name }),
          ui.btn('Remove', () => { if (r.uses) { ui.toast('Cannot remove — ' + r.uses + ' record(s) use it. Rename it instead.', 'bad'); return; } ui.confirm('Remove ' + r.name, 'Remove "' + r.name + '" from the ' + noun.toLowerCase() + ' list?', () => { setMasterList(key, arr.filter((x) => x !== r.name), 'Removed ' + r.name); draw(); }); }, 'sm', { 'aria-label': 'Remove ' + r.name })],
      }), { flush: true }));
    }
    draw();
    return wrap;
  }
  function termsEditor() {
    const wrap = h('div');
    const edit = (t) => ui.formModal(t ? 'Edit payment term' : 'Add payment term', [{ key: 'name', label: 'Name', required: true }, { key: 'days', label: 'Credit days', type: 'number', min: 0, max: 365, required: true }], t || { days: 30 }, (v) => {
      if (PAYMENT_TERMS.some((x) => x !== t && norm(x.name) === norm(v.name))) { ui.toast('That payment term already exists', 'bad'); return false; }
      const next = t ? PAYMENT_TERMS.map((x) => (x === t ? { name: v.name.trim(), days: v.days } : x)) : PAYMENT_TERMS.concat({ name: v.name.trim(), days: v.days });
      setMasterList('paymentTerms', next, (t ? 'Edited' : 'Added') + ' payment term ' + v.name); ui.toast('Saved', 'ok'); draw();
    });
    function draw() {
      wrap.innerHTML = '';
      wrap.appendChild(ui.card(null, ui.table({ rows: PAYMENT_TERMS.map((t, i) => Object.assign({ id: String(i), ref: t }, t)), search: false, caption: 'Payment terms', toolbar: [ui.btn('+ Payment term', () => edit(), 'sm primary')], columns: [{ key: 'name', label: 'Payment term' }, { key: 'days', label: 'Credit days', cls: 'right' }],
        actions: (r) => [ui.btn('Edit', () => edit(r.ref), 'sm'), ui.btn('Remove', () => { if (PAYMENT_TERMS.length <= 1) { ui.toast('Keep at least one payment term', 'bad'); return; } setMasterList('paymentTerms', PAYMENT_TERMS.filter((x) => x !== r.ref), 'Removed payment term ' + r.name); draw(); }, 'sm')] }), { flush: true }));
    }
    draw();
    return wrap;
  }
  function divisionEditor() {
    return ui.card(null, ui.table({ rows: () => DIVISIONS, search: false, caption: 'Divisions', columns: [{ key: 'id', label: 'Division', render: (d) => ui.divTag(d.id) }, { key: 'description', label: 'Description' }, { key: 'gst', label: 'GST', render: (d) => config.gstRate(d.id) + '%' }],
      actions: (d) => [ui.btn('Edit', () => ui.formModal('Edit ' + d.name, [{ key: 'description', label: 'Description', type: 'textarea', required: true }], { description: d.description }, (v) => { const m = Object.assign({}, (state.__masters || {}).divisionDesc || {}); m[d.id] = v.description.trim(); setMasterList('divisionDesc', m, 'Division description updated: ' + d.id); ui.toast('Saved', 'ok'); refresh(); }), 'sm', { 'aria-label': 'Edit ' + d.name })] }), { flush: true });
  }
  function editProduct(p) {
    ui.formModal(p ? 'Edit product ' + p.id : 'New product', [
      { key: 'division', label: 'Division', type: 'select', options: DIVISIONS.map((d) => d.id), required: true }, { key: 'category', label: 'Category', required: true },
      { key: 'name', label: 'Product name', required: true, full: true }, { key: 'price', label: 'Price (₹, before GST)', type: 'number', min: 0, required: true }, { key: 'unit', label: 'Unit', default: 'Nos' },
      { key: 'hsn', label: 'HSN code' }, { key: 'warrantyMonths', label: 'Warranty (months)', type: 'number', min: 0, max: 300 }, { key: 'active', label: 'Active (available for new quotations)', type: 'checkbox', default: true },
    ], p || { active: true, unit: 'Nos', warrantyMonths: 12 }, (v) => {
      if (db.all('products').some((x) => x.id !== (p && p.id) && norm(x.name) === norm(v.name))) { ui.toast('A product with this name already exists', 'bad'); return false; }
      if (p) db.update('products', p.id, v); else db.insert('products', v, { prefix: 'PRD' });
      ui.toast('Product saved', 'ok'); refresh();
    });
  }
  function editSite(s, customerId) {
    const fields = [
      { key: 'customerId', label: 'Customer', type: 'select', required: true, options: master.customers().map((c) => ({ value: c.id, label: c.name + ' (' + c.id + ')' })) },
      { key: 'name', label: 'Site name', required: true, placeholder: 'e.g. Main Site, Branch 2, Warehouse' }, { key: 'address', label: 'Address', type: 'textarea', required: true },
      { key: 'area', label: 'Area', type: 'select', options: AREAS }, { key: 'pincode', label: 'PIN code', format: 'pincode' },
      { key: 'contact', label: 'Site contact' }, { key: 'phone', label: 'Site phone', format: 'phone' }, { key: 'access', label: 'Access arrangement', placeholder: 'e.g. Reception, gate pass' },
      { type: 'section', label: 'Utility details (Solar / net metering)' },
      { key: 'u_discom', label: 'DISCOM / utility', placeholder: 'e.g. TANGEDCO' }, { key: 'u_consumerNo', label: 'Consumer no.' },
      { key: 'u_sanctionedLoad', label: 'Sanctioned load (kW)', type: 'number', min: 0 }, { key: 'u_tariff', label: 'Tariff category', placeholder: 'e.g. LT-IA Domestic' },
      { key: 'u_meterType', label: 'Meter type', type: 'select', options: ['Single phase', 'Three phase', 'Bi-directional (net meter)', 'CT-operated'] },
    ];
    const U = ['discom', 'consumerNo', 'sanctionedLoad', 'tariff', 'meterType'];
    const cid = s ? s.customerId : customerId;
    const c = cid ? master.customer(cid) : null;
    const init = s ? Object.assign({}, s) : { customerId: cid || '', area: c ? c.area : '', contact: c ? c.contact : '', phone: c ? c.phone : '', access: 'Reception' };
    const ut = Object.assign({ consumerNo: init.consumerNo, sanctionedLoad: init.sanctionedLoadKw }, init.utility || {});
    U.forEach((k) => { init['u_' + k] = ut[k]; });
    ui.formModal(s ? 'Edit site ' + s.id : 'Add site', fields, init, (v) => {
      v.utility = {}; U.forEach((k) => { if (v['u_' + k] !== '' && v['u_' + k] != null) v.utility[k] = v['u_' + k]; delete v['u_' + k]; });
      v.consumerNo = v.utility.consumerNo || ''; v.sanctionedLoadKw = v.utility.sanctionedLoad || null;
      if (!canEditCustomer(master.customer(v.customerId))) { ui.toast('You cannot edit sites for this customer', 'bad'); return false; }
      if (db.all('sites').some((x) => x.id !== (s && s.id) && x.customerId === v.customerId && norm(x.name) === norm(v.name))) { ui.toast('This customer already has a site with that name', 'bad'); return false; }
      if (s) db.update('sites', s.id, v); else db.insert('sites', v, { prefix: 'SITE' });
      ui.toast('Site saved', 'ok'); refresh();
    });
  }
  function editUser(s) {
    const fields = [
      { key: 'name', label: 'Name', required: true }, { key: 'role', label: 'Role', type: s && s.primary ? 'readonly' : 'select', required: true, options: ROLES.map((r) => ({ value: r.id, label: r.name })), hint: s && s.primary ? 'This is the demo user for the role, so the role is fixed.' : '' },
      { key: 'division', label: 'Division', type: 'select', options: DIVISIONS.map((d) => d.id), placeholder: 'All divisions' }, { key: 'area', label: 'Area', type: 'select', options: AREAS, placeholder: 'All areas' },
      { key: 'phone', label: 'Phone', format: 'phone' }, { key: 'email', label: 'Email', format: 'email' },
      { key: 'skills', label: 'Skills (comma separated)', full: true, placeholder: 'e.g. Online UPS, Inverter, CCTV, Solar on-grid', hint: 'Used to match engineers and technicians to calls.' },
      { key: 'active', label: 'Active', type: 'checkbox', default: true },
    ];
    ui.formModal(s ? 'Edit user ' + s.id : 'Add user', fields, s ? Object.assign({}, s, { skills: (s.skills || []).join(', ') }) : { active: true }, (v) => {
      const rec = { name: v.name.trim(), division: v.division || null, area: v.area || null, phone: v.phone, email: v.email, skills: String(v.skills || '').split(',').map((x) => x.trim()).filter(Boolean), active: !!v.active };
      if (!(s && s.primary)) rec.role = v.role;
      if (s && s.primary && !rec.active) { ui.toast('The demo user for a role cannot be deactivated', 'bad'); return false; }
      if (s) db.update('staff', s.id, rec, { note: 'User updated' }); else db.insert('staff', Object.assign(rec, { primary: false }), { prefix: 'EMP' });
      ui.toast('User saved', 'ok'); refresh();
    });
  }
  function importBackup() {
    const i = h('input', { type: 'file', accept: '.json,application/json' });
    i.onchange = () => {
      const f = i.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        let obj; try { obj = JSON.parse(r.result); } catch (e) { ui.toast('Could not read the file — it is not valid JSON', 'bad'); return; }
        ui.confirm('Replace all data?', 'This replaces every record in this browser with the contents of ' + f.name + '. Export a backup first if you may need the current data.', () => { try { db.import(obj); } catch (e) { ui.toast(e.message, 'bad'); } });
      };
      r.onerror = () => ui.toast('Could not read the file', 'bad');
      r.readAsText(f);
    };
    i.click();
  }

  const customer360Sections = [];
  /** Modules add sections to Customer 360: fn(customer) -> { title, summary, body()->Node, flush } */
  function registerCustomerSection(fn) { customer360Sections.push(fn); }

  function editCustomer(c) {
    if (!canEditCustomer(c)) { ui.toast('Your role cannot ' + (c ? 'edit this customer' : 'create customers'), 'bad'); return; }
    const origGst = c ? String(c.gstin || '').toUpperCase() : '';
    const fields = [
      { key: 'name', label: 'Account name', required: true }, { key: 'type', label: 'Customer type', type: 'select', required: true, options: CUSTOMER_TYPES },
      { key: 'category', label: 'Customer category', type: 'select', required: true, options: CUSTOMER_CATEGORIES, hint: 'Priority customers get priority handling in service and escalation.' },
      { key: 'segment', label: 'Segment', type: 'select', options: SEGMENTS },
      { key: 'contact', label: 'Contact name', required: true }, { key: 'phone', label: 'Contact number', required: true, format: 'phone' },
      { key: 'altContact', label: 'Alternate contact' }, { key: 'altPhone', label: 'Alternate number', format: 'phone' },
      { key: 'email', label: 'Email', format: 'email' }, { key: 'area', label: 'Area', type: 'select', options: AREAS, required: true },
      { key: 'gstin', label: 'GSTIN', placeholder: '33AABCS1234C1Z5', validate: (v) => (v && v !== origGst && !validate.gstin(v) ? validate.messages.gstin : null) },
    ];
    if (!is('sales_exec')) fields.push({ key: 'ownerId', label: 'Account owner (Sales Executive)', type: 'select', options: master.staff('sales_exec').map((s) => ({ value: s.id, label: s.name + (s.division ? ' · ' + s.division : '') })) });
    if (!c) fields.push({ key: '_address', label: 'Main site address', type: 'textarea', required: true });
    ui.formModal(c ? 'Edit customer' : 'New customer', fields, c ? Object.assign({ category: master.customerCategory(c) }, c) : { type: 'New Customer', category: 'Non-Priority' }, (v) => {
      const dup = findDuplicateCustomer(v, c && c.id);
      if (dup) { ui.toast('Duplicate prevented: ' + dup.name + ' (' + dup.id + ') has the same name, phone or GSTIN', 'bad'); return false; }
      const addr = v._address; delete v._address;
      if (c) db.update('customers', c.id, v);
      else {
        if (is('sales_exec')) v.ownerId = user().id;
        const n = db.insert('customers', Object.assign(v, { id: nextCustomerId(), since: util.iso(TODAY) }));
        db.insert('sites', { customerId: n.id, name: 'Main Site', address: addr || v.area, area: v.area, contact: v.contact, phone: v.phone, access: 'Reception' });
      }
      ui.toast('Customer saved', 'ok'); refresh();
    });
  }

  // ---------------------------------------------------------------- data import page
  function renderImportPage(el, which) {
    const mine = importers.filter((i) => i.roles.includes(currentRoleId()) || currentRoleId() === 'admin');
    ui.page(el, { title: 'Data Import', sub: 'Migrate records from spreadsheets: upload CSV, preview and validate, then insert. Every import is audited.' });
    if (!mine.length) { el.appendChild(ui.empty('No importers are available for your role')); return; }
    let imp = mine.find((i) => i.id === which) || mine[0];
    const selId = 'imp_' + util.uid();
    const sel = h('select', { id: selId, onChange: (e) => go('dataimport', e.target.value) }, mine.map((i) => h('option', { value: i.id, selected: i === imp ? true : null }, i.title)));
    const fileId = 'impf_' + util.uid();
    const fileIn = h('input', { type: 'file', id: fileId, accept: '.csv,text/csv' });
    const taId = 'impt_' + util.uid();
    const ta = h('textarea', { id: taId, rows: 6, placeholder: 'Or paste CSV here (first row = headers)', class: 'mono' });
    const out = h('div', { class: 'mt' });
    fileIn.addEventListener('change', () => { const f = fileIn.files[0]; if (!f) return; if (f.size > 5 * 1048576) { ui.toast('File is larger than 5 MB — split it into smaller files', 'bad'); return; } const r = new FileReader(); r.onload = () => { ta.value = r.result; check(); }; r.readAsText(f); });
    const template = () => exportCsvRaw((imp.id) + '-template.csv', [imp.columns.map((c) => c.label || c.key)].concat(imp.sample || []));
    function check() {
      out.innerHTML = '';
      const res = runImporter(imp, ta.value);
      if (res.error) { out.appendChild(ui.callout(res.error, 'warn')); return; }
      const ok = res.results.filter((r) => r.status === 'Ready');
      const bad = res.results.filter((r) => r.status !== 'Ready');
      out.appendChild(ui.kpis([{ label: 'Rows read', value: res.results.length }, { label: 'Ready', value: ok.length, color: 'var(--ok)' }, { label: 'Errors', value: res.results.filter((r) => r.status === 'Error').length, color: 'var(--bad)' }, { label: 'Duplicates / skipped', value: res.results.filter((r) => r.status === 'Duplicate' || r.status === 'Skipped').length, color: 'var(--chart-4)' }]));
      const preview = res.results.map((r) => Object.assign({ id: 'r' + r.rowNo, _row: r.rowNo, _status: r.status, _msg: r.msg }, r.row));
      const shown = imp.columns.slice(0, 5);
      out.appendChild(ui.card('Preview', ui.table({ rows: preview, pageSize: 20, caption: 'Import preview', filters: [{ key: '_status', label: 'statuses', options: ['Ready', 'Error', 'Duplicate', 'Skipped'] }], columns: [{ key: '_row', label: 'Row' }, { key: '_status', label: 'Status', render: (r) => ui.badge(r._status, r._status === 'Ready' ? 'ok' : r._status === 'Error' ? 'bad' : 'warn') }].concat(shown.map((c) => ({ key: c.key, label: c.label || c.key }))).concat([{ key: '_msg', label: 'Message' }]) }), { flush: true }));
      out.appendChild(h('div', { class: 'row mt' }, [
        ui.btn('Import ' + ok.length + ' valid row' + (ok.length === 1 ? '' : 's'), () => {
          if (!ok.length) { ui.toast('Nothing to import', 'warn'); return; }
          const inserted = []; const failed = [];
          ok.forEach((r) => {
            try {
              const rec = Object.assign({}, r.rec);
              const extra = imp.beforeInsert ? imp.beforeInsert(rec) : undefined;
              const n = db.insert(imp.collection, rec, { prefix: imp.prefix, note: 'Imported via ' + imp.title + ' (row ' + r.rowNo + ')' });
              if (imp.onInserted) imp.onInserted(n, extra);
              inserted.push(n);
            } catch (e) { failed.push({ rowNo: r.rowNo, msg: e.message }); }
          });
          if (imp.after) try { imp.after(inserted); } catch (e) { console.error(e); }
          audit('import', imp.collection, imp.id, inserted.length + ' row(s) imported, ' + (bad.length + failed.length) + ' rejected');
          emit('import:done', { importer: imp.id, records: inserted });
          ui.toast(inserted.length + ' record(s) imported' + (failed.length ? ', ' + failed.length + ' failed' : ''), failed.length ? 'warn' : 'ok');
          ta.value = ''; out.innerHTML = '';
          out.appendChild(ui.callout('Imported ' + inserted.length + ' record(s) into ' + imp.title + '.' + (failed.length ? ' ' + failed.length + ' failed: ' + failed.map((f) => 'row ' + f.rowNo + ' — ' + f.msg).join('; ') : ''), failed.length ? 'warn' : 'ok'));
        }, 'primary', { disabled: ok.length ? null : true }),
        bad.length ? ui.btn('⇩ Error report (' + bad.length + ')', () => exportCsv(imp.id + '-errors.csv', bad, [{ label: 'Row', value: (r) => r.rowNo }, { label: 'Status', value: (r) => r.status }, { label: 'Problem', value: (r) => r.msg }].concat(imp.columns.map((c) => ({ label: c.label || c.key, value: (r) => r.row[c.key] })))), 'sm') : null,
      ]));
    }
    el.appendChild(ui.card('Import ' + imp.title, h('div', { class: 'stack' }, [
      h('div', { class: 'form' }, [h('div', { class: 'field' }, [h('label', { for: selId }, 'What are you importing?'), sel]), h('div', { class: 'field' }, [h('label', { for: fileId }, 'CSV file'), fileIn])]),
      imp.description ? h('p', { class: 'muted small', style: 'margin:0' }, imp.description) : null,
      h('div', { class: 'small' }, [h('b', {}, 'Columns: '), imp.columns.map((c) => (c.label || c.key) + (c.required ? ' *' : '')).join(', '), '. Dates as DD/MM/YYYY or YYYY-MM-DD.']),
      h('div', { class: 'field' }, [h('label', { for: taId }, 'CSV content'), ta]),
      h('div', { class: 'row' }, [ui.btn('Validate & preview', check, 'primary'), ui.btn('⇩ Template', template, 'sm')]),
    ])));
    el.appendChild(out);
  }
  function exportCsvRaw(name, grid) {
    const q = (s) => { s = s == null ? '' : String(s); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    downloadBlob(name, new Blob(['﻿' + grid.map((r) => r.map(q).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    load();
    const t = ls.get(THEME_KEY); if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
    registerCoreConfigSections();
    registerCoreImporters();
    registerCorePages();
    const fresh = !db.all('staff').length;
    seedMasters();
    if (fresh) {
      seeds.forEach((fn) => { try { fn(db, { util, master, fmt }); } catch (e) { console.error('[CRM] seed failed', e); } });
      state.audit = [];
    }
    ['customers', 'sites', 'products', 'staff', 'attachments'].forEach((col) => bumpCounter(col, PREFIX[col]));
    persistNow();
    buildShell();
    if (saveFailed) { saveFailed = false; setSaveStatus(false, null); }
    emit('ready');
    booted = true;
    renderBell();
    window.addEventListener('hashchange', () => { render(); try { contentEl.focus({ preventScroll: true }); } catch (e) { /* ignore */ } });
    render();
    tickTimer = setInterval(() => runTicks(false), 5000);
  }

  window.CRM = {
    db, util, fmt, ui, h, master, notify, on, emit, go, refresh,
    roles: ROLES, ROLE: Object.fromEntries(ROLES.map((r) => [r.id, r.id])), ALL, MGMT, role, user, is, canSee,
    registerPage, registerHome, registerSeed, registerRole, registerSearch, registerCustomerSection,
    nextId, TODAY, persist, icons: ICONS,
    // Core API v2
    config, registerConfigSection, registerNotifyEvent, registerReport, registerTick, runTicks: () => runTicks(true),
    files, exportCsv, exportPdf, registerImporter, validate, canEditCustomer, CUSTOMER_EDIT_ROLES, audit,
    myNotifications,
    notifyPopup: true, // core shows a toast for every new notification addressed to the current user
  };
  document.addEventListener('DOMContentLoaded', boot);
})();
