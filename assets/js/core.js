/* Maruthi Power Control Systems — Unified CRM core runtime.
 * Provides: data store, master data, roles & permissions, router, nav registry,
 * event bus, notifications, audit log and a small UI kit shared by all modules.
 * Modules (sales.js, projects.js, service.js) register pages/seeds through window.CRM.
 */
(function () {
  'use strict';

  const STORE_KEY = 'mpcs-crm-v1';
  const ROLE_KEY = 'mpcs-crm-role';
  const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);

  // ---------------------------------------------------------------- utils
  const util = {
    uid: () => Math.random().toString(36).slice(2, 10),
    today: () => new Date(TODAY),
    iso: (d) => { const x = new Date(d); return isNaN(x) ? '' : x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); },
    addDays: (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; },
    addHours: (d, n) => new Date(new Date(d).getTime() + n * 3600e3),
    daysBetween: (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5),
    hoursBetween: (a, b) => Math.round((new Date(b) - new Date(a)) / 36e5 * 10) / 10,
    rand: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
    pick: (arr) => arr[Math.floor(Math.random() * arr.length)],
    sum: (arr, fn) => arr.reduce((s, x) => s + (Number(typeof fn === 'function' ? fn(x) : fn ? x[fn] : x) || 0), 0),
    groupBy: (arr, fn) => arr.reduce((m, x) => { const k = typeof fn === 'function' ? fn(x) : x[fn]; (m[k] = m[k] || []).push(x); return m; }, {}),
    countBy: (arr, fn) => arr.reduce((m, x) => { const k = typeof fn === 'function' ? fn(x) : x[fn]; m[k] = (m[k] || 0) + 1; return m; }, {}),
    pct: (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0),
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    initials: (name) => String(name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase(),
    debounce: (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; },
    clone: (o) => JSON.parse(JSON.stringify(o)),
  };

  const fmt = {
    date: (d) => { if (!d) return '—'; const x = new Date(d); return isNaN(x) ? '—' : x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); },
    // Brand book writing mechanics: "25 Oct 2026 · 10:30 AM"
    dateTime: (d) => { if (!d) return '—'; const x = new Date(d); if (isNaN(x)) return '—'; return fmt.date(x) + ' · ' + x.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); },
    money: (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN'),
    lakh: (n) => { n = Number(n) || 0; if (Math.abs(n) >= 1e7) return '₹' + (n / 1e7).toFixed(2) + ' Cr'; if (Math.abs(n) >= 1e5) return '₹' + (n / 1e5).toFixed(2) + ' L'; return fmt.money(n); },
    num: (n) => (Number(n) || 0).toLocaleString('en-IN'),
    pct: (n) => (Math.round((Number(n) || 0) * 10) / 10) + '%',
    rel: (d) => { if (!d) return '—'; const days = util.daysBetween(TODAY, new Date(new Date(d).setHours(0, 0, 0, 0))); if (days === 0) return 'Today'; if (days === 1) return 'Tomorrow'; if (days === -1) return 'Yesterday'; return days > 0 ? 'in ' + days + 'd' : Math.abs(days) + 'd ago'; },
  };

  // ---------------------------------------------------------------- event bus
  const listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function emit(evt, payload) { (listeners[evt] || []).forEach((fn) => { try { fn(payload); } catch (e) { console.error('[CRM] handler for', evt, e); } }); }

  // ---------------------------------------------------------------- roles
  // Roles consolidated from the Sales, Electronic Security, Solar and Service requirement documents.
  const ROLES = [
    { id: 'admin', name: 'CRM Administrator', group: 'Management', user: 'Karthik R', color: '#5C6066' },
    { id: 'gm', name: 'GM / CEO', group: 'Management', user: 'S. Maruthi', color: '#0A0A0A' },
    { id: 'odm', name: 'ODM (Operations)', group: 'Management', user: 'Lakshmi N', color: '#2B2B2B' },
    { id: 'sales_manager', name: 'Sales Manager', group: 'Sales', user: 'Ramesh K', color: '#EC000A' },
    { id: 'sales_coordinator', name: 'Sales Coordinator', group: 'Sales', user: 'Divya S', color: '#B80008' },
    { id: 'sales_exec', name: 'Sales Executive', group: 'Sales', user: 'Arun Kumar', color: '#EC000A' },
    { id: 'accounts', name: 'Accounts Team', group: 'Finance', user: 'Meena P', color: '#2B2B2B' },
    { id: 'es_coordinator', name: 'Electronic Security Coordinator', group: 'Projects', user: 'Vignesh M', color: '#0A0A0A' },
    { id: 'solar_coordinator', name: 'Solar Coordinator', group: 'Projects', user: 'Prakash V', color: '#137333' },
    { id: 'doc_coordinator', name: 'Documentation Coordinator', group: 'Projects', user: 'Kavya R', color: '#137333' },
    { id: 'tech_engineer', name: 'Technical Engineer', group: 'Projects', user: 'Suresh B', color: '#2B2B2B' },
    { id: 'tech_head', name: 'Technical Head', group: 'Projects', user: 'Balaji T', color: '#0A0A0A' },
    { id: 'purchase', name: 'Purchase Coordinator', group: 'Supply Chain', user: 'Gopi K', color: '#5C6066' },
    { id: 'stores', name: 'Stores / Logistics', group: 'Supply Chain', user: 'Murugan S', color: '#5C6066' },
    { id: 'install_lead', name: 'Installation Team Leader', group: 'Projects', user: 'Senthil A', color: '#2B2B2B' },
    { id: 'vendor', name: 'External Vendor', group: 'External', user: 'Sri Sai Electricals', color: '#5C6066' },
    { id: 'service_coordinator', name: 'Service Coordinator', group: 'Service', user: 'Priya D', color: '#B80008' },
    { id: 'service_engineer', name: 'Service Engineer', group: 'Service', user: 'Manoj V', color: '#EC000A' },
    { id: 'pm_coordinator', name: 'PM / AMC Coordinator', group: 'Service', user: 'Anitha J', color: '#B80008' },
  ];
  const ROLE_GROUPS = ['Management', 'Sales', 'Finance', 'Projects', 'Supply Chain', 'Service', 'External'];
  const ALL = ROLES.map((r) => r.id);
  const MGMT = ['admin', 'gm', 'odm'];

  function currentRoleId() { const r = localStorage.getItem(ROLE_KEY); return ROLES.some((x) => x.id === r) ? r : 'gm'; }
  function role(id) { return ROLES.find((r) => r.id === (id || currentRoleId())); }
  function user() {
    const r = role();
    const staff = db.all('staff').find((s) => s.role === r.id && s.primary) || db.all('staff').find((s) => s.role === r.id);
    return { id: staff ? staff.id : r.id, name: staff ? staff.name : r.user, role: r.id, roleName: r.name, division: staff ? staff.division : null };
  }
  function is(...roleIds) { return roleIds.flat().includes(currentRoleId()); }

  // ---------------------------------------------------------------- data store
  let state = null;
  const seeds = [];
  const counters = {};

  function load() {
    try { state = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { state = null; }
    if (!state || !state.__v) state = { __v: 1, __counters: {} };
    Object.assign(counters, state.__counters || {});
  }
  function persistNow() {
    if (!state) return;
    state.__counters = counters;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { console.warn('[CRM] storage full', e); }
  }
  const persist = util.debounce(persistNow, 150);
  window.addEventListener('pagehide', persistNow);

  function nextId(prefix, width) {
    counters[prefix] = (counters[prefix] || 0) + 1;
    persist();
    return prefix + '-' + String(counters[prefix]).padStart(width || 4, '0');
  }

  const PREFIX = {
    customers: 'CUS', sites: 'SITE', products: 'PRD', staff: 'EMP', notifications: 'NTF', audit: 'AUD',
  };

  const db = {
    all(col) { return state[col] || (state[col] = []); },
    get(col, id) { return db.all(col).find((r) => r.id === id) || null; },
    find(col, fn) { return db.all(col).filter(fn); },
    one(col, fn) { return db.all(col).find(fn) || null; },
    insert(col, rec, opts) {
      opts = opts || {};
      const r = Object.assign({}, rec);
      if (!r.id) r.id = nextId(opts.prefix || PREFIX[col] || col.slice(0, 3).toUpperCase());
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
    remove(col, id) { state[col] = db.all(col).filter((r) => r.id !== id); audit('delete', col, id, 'Deleted'); persist(); },
    reset() { localStorage.removeItem(STORE_KEY); location.reload(); },
    export() { return util.clone(state); },
    import(obj) { localStorage.setItem(STORE_KEY, JSON.stringify(obj)); location.reload(); },
  };

  function audit(action, col, id, note) {
    if (!state) return;
    const u = role();
    (state.audit = state.audit || []).push({ id: 'AUD-' + util.uid(), ts: new Date().toISOString(), role: u ? u.id : 'system', user: u ? u.user : 'system', action, col, recId: id, note });
    if (state.audit.length > 3000) state.audit.splice(0, state.audit.length - 3000);
  }

  // ---------------------------------------------------------------- master data (shared by all modules)
  const DIVISIONS = [
    { id: 'Power', name: 'Power', color: 'var(--div-power)' },
    { id: 'Electronic Security', name: 'Electronic Security', color: 'var(--div-security)' },
    { id: 'Solar', name: 'Solar', color: 'var(--div-solar)' },
  ];
  const AREAS = ['Coimbatore North', 'Coimbatore South', 'Peelamedu', 'Gandhipuram', 'RS Puram', 'Saravanampatti', 'Tiruppur', 'Pollachi', 'Mettupalayam', 'Erode'];
  const SEGMENTS = ['Residential', 'Commercial', 'Industrial', 'Institutional', 'Healthcare', 'Government', 'Retail'];

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

  function seedMasters() {
    if (db.all('staff').length) return;
    // Staff — one primary user per role plus extra field staff for realistic workloads.
    ROLES.forEach((r) => db.insert('staff', { id: 'EMP-' + r.id, name: r.user, role: r.id, primary: true, phone: '98' + util.rand(10000000, 99999999), active: true, division: r.id === 'solar_coordinator' || r.id === 'doc_coordinator' ? 'Solar' : r.id === 'es_coordinator' ? 'Electronic Security' : null }, { silent: true }));
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

    PRODUCT_CATALOG.forEach(([division, category, name, price], i) => db.insert('products', { id: 'PRD-' + String(i + 1).padStart(3, '0'), division, category, name, price, unit: 'Nos', hsn: '8504', warrantyMonths: division === 'Solar' ? 60 : 12 }, { silent: true }));

    CUSTOMER_NAMES.forEach(([name, segment], i) => {
      const type = i < 6 ? 'Key Customer' : i % 7 === 0 ? 'Dealer' : i % 3 === 0 ? 'New Customer' : 'Existing Customer';
      const c = db.insert('customers', {
        id: 'CUS-' + String(1001 + i), name, segment, type,
        contact: util.pick(FIRST) + ' ' + util.pick(['R', 'S', 'K', 'M', 'P']), phone: '9' + util.rand(100000000, 999999999),
        email: name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '') + '@example.in',
        area: AREAS[i % AREAS.length], gstin: i % 4 === 0 ? '' : '33AAB' + util.rand(1000, 9999) + 'C1Z' + (i % 9), since: util.iso(util.addDays(TODAY, -util.rand(30, 2400))),
      }, { silent: true });
      const nSites = i < 4 ? 2 : 1;
      for (let s = 0; s < nSites; s++) db.insert('sites', { customerId: c.id, name: s === 0 ? 'Main Site' : 'Branch ' + s, address: (util.rand(1, 240)) + ', ' + c.area + ', Coimbatore', contact: c.contact, phone: c.phone, access: s ? 'Security gate pass required' : 'Reception' }, { silent: true });
    });
  }

  const master = {
    divisions: DIVISIONS, areas: AREAS, segments: SEGMENTS,
    customers: () => db.all('customers'),
    customer: (id) => db.get('customers', id),
    sites: (customerId) => db.find('sites', (s) => !customerId || s.customerId === customerId),
    products: (division) => db.find('products', (p) => !division || p.division === division),
    product: (id) => db.get('products', id),
    staff: (roleId, division) => db.find('staff', (s) => s.active && (!roleId || s.role === roleId) && (!division || !s.division || s.division === division)),
    staffName: (id) => { const s = db.get('staff', id); return s ? s.name : (id || '—'); },
    divisionColor: (d) => (DIVISIONS.find((x) => x.id === d) || {}).color || 'var(--muted)',
  };

  // ---------------------------------------------------------------- notifications
  function notify(n) {
    // n: { to: roleId | [roleIds], title, body, link, severity: 'info'|'warn'|'bad'|'ok', key }
    const to = [].concat(n.to || 'gm');
    if (n.key && db.one('notifications', (x) => x.key === n.key)) return; // de-duplicate (requirement: avoid duplicate notifications)
    const rec = db.insert('notifications', { to, title: n.title, body: n.body || '', link: n.link || '', severity: n.severity || 'info', key: n.key || null, readBy: [], channel: n.channel || 'In-app' }, { silent: true, prefix: 'NTF' });
    emit('notifications:created', rec);
    renderBell();
    return rec;
  }
  function myNotifications() { const r = currentRoleId(); return db.find('notifications', (n) => n.to.includes(r) || (MGMT.includes(r) && n.to.includes('mgmt'))).slice().reverse(); }

  // ---------------------------------------------------------------- page registry & router
  const pages = [];
  const homes = {};
  function registerPage(p) {
    // p: { id, title, icon, section, roles: [...] | 'all', order, render(el, params), badge(): number, hidden }
    if (pages.some((x) => x.id === p.id)) { console.warn('[CRM] duplicate page id', p.id); return; }
    p.roles = p.roles === 'all' || !p.roles ? ALL : p.roles;
    pages.push(p);
  }
  function registerHome(roleIds, render) { [].concat(roleIds).forEach((r) => { homes[r] = render; }); }
  function registerSeed(fn) { seeds.push(fn); }
  function registerRole(r) { if (!ROLES.some((x) => x.id === r.id)) { ROLES.push(r); ALL.push(r.id); } }

  function visiblePages() { const r = currentRoleId(); return pages.filter((p) => !p.hidden && p.roles.includes(r)); }
  function canSee(pageId) { const p = pages.find((x) => x.id === pageId); return p && p.roles.includes(currentRoleId()); }

  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, '');
    const [id, ...rest] = h.split('/');
    return { id: id || 'home', params: rest.map(decodeURIComponent) };
  }
  function go(id, ...params) { location.hash = '#/' + [id].concat(params.map(encodeURIComponent)).join('/'); }

  let contentEl, navEl;
  function render() {
    const { id, params } = parseRoute();
    closeOverlays();
    contentEl.innerHTML = '';
    contentEl.scrollTop = 0;
    document.querySelector('.app').classList.remove('nav-open');
    renderNav(id);
    try {
      if (id === 'home') {
        const fn = homes[currentRoleId()];
        if (fn) fn(contentEl, params); else genericHome(contentEl);
        return;
      }
      const p = pages.find((x) => x.id === id);
      if (!p) { contentEl.innerHTML = '<div class="empty"><div class="big">🧭</div>Page not found. <a href="#/home">Go to dashboard</a></div>'; return; }
      if (!p.roles.includes(currentRoleId())) {
        contentEl.innerHTML = '<div class="empty"><div class="big">🔒</div><h2>Access restricted</h2><p>The <b>' + util.esc(role().name) + '</b> role cannot open <b>' + util.esc(p.title) + '</b>.<br>Access follows role and assignment as defined in the requirement documents.</p><a class="btn primary" href="#/home">Back to my dashboard</a></div>';
        return;
      }
      document.title = p.title + ' · Maruthi CRM';
      p.render(contentEl, params);
    } catch (e) {
      console.error(e);
      contentEl.innerHTML = '<div class="callout bad"><b>Something went wrong rendering this page.</b><br><span class="mono">' + util.esc(e.message) + '</span></div>';
    }
  }
  function refresh() { render(); }

  function renderNav(activeId) {
    const vis = visiblePages().sort((a, b) => (a.order || 50) - (b.order || 50));
    const sections = [];
    vis.forEach((p) => { const s = p.section || 'General'; if (!sections.includes(s)) sections.push(s); });
    let html = '<a href="#/home" class="' + (activeId === 'home' ? 'active' : '') + '"><span class="ico">' + ICONS.grid + '</span>My Dashboard</a>';
    sections.forEach((s) => {
      html += '<div class="nav-section">' + util.esc(s) + '</div>';
      vis.filter((p) => (p.section || 'General') === s).forEach((p) => {
        let count = '';
        try { const c = p.badge ? p.badge() : 0; if (c) count = '<span class="count">' + c + '</span>'; } catch (e) { /* ignore */ }
        html += '<a href="#/' + p.id + '" class="' + (p.id === activeId ? 'active' : '') + '"><span class="ico">' + navIcon(p) + '</span>' + util.esc(p.title) + count + '</a>';
      });
    });
    navEl.innerHTML = html;
  }

  // Brand book icon style: outline, 2px stroke, rounded joins, red accent stroke on the "power" element.
  const svg = (body) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + body + '</svg>';
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
    dot: svg('<circle class="acc" cx="12" cy="12" r="3"/>'),
  };
  // Order matters: the first matching rule wins.
  const ICON_RULES = [
    [/role design|guide/, 'compass'], [/mobile/, 'phone'], [/vault|device schedule|credential/, 'lock'], [/pending tasks/, 'check'], [/my assigned/, 'check'],
    [/dashboard|cockpit|execution$/, 'grid'], [/lead|enquir/, 'inbox'], [/pipeline/, 'kanban'], [/quotation/, 'doc'], [/sales order/, 'box'],
    [/follow-up|follow up/, 'calendar'], [/compliance follow/, 'calendar'], [/calls|cold/, 'call'], [/ots/, 'call'], [/upsell|cross/, 'trend'], [/dealer|vendor/, 'users'],
    [/target|kpi/, 'target'], [/migration|import/, 'upload'], [/billing|invoice/, 'receipt'], [/payment|collection|subsidy/, 'rupee'], [/outstanding|ageing/, 'hourglass'],
    [/cycle/, 'clock'], [/violation|escalation|sla/, 'alert'], [/report/, 'chart'], [/project material/, 'box'], [/project|installation/, 'building'], [/survey/, 'pin'], [/boq/, 'list'],
    [/inspection|rework|quality/, 'shield'], [/handover/, 'handshake'], [/policy|rules|compliance/, 'scale'], [/stock|grn|inward/, 'warehouse'], [/purchase/, 'cart'],
    [/challan|delivery|material issue/, 'truck'], [/scrap/, 'recycle'], [/net meter/, 'gauge'], [/solar/, 'sun'], [/complaint/, 'wrench'], [/spare|standby/, 'bolt'],
    [/equipment|register|asset/, 'server'], [/amc|warranty/, 'shield'], [/preventive|^pm /, 'calendar'], [/performance/, 'award'], [/config|settings/, 'gear'],
    [/customer/, 'user'], [/users|access/, 'users'], [/master/, 'database'], [/audit/, 'scroll'], [/feedback/, 'message'], [/task/, 'check'],
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

  // ---------------------------------------------------------------- UI kit
  const TONES = {
    ok: ['won', 'approved', 'completed', 'closed', 'paid', 'received', 'resolved', 'active', 'done', 'passed', 'feasible', 'delivered', 'handed over', 'commissioned', 'in stock', 'yes', 'on time', 'within sla', 'renewed', 'converted'],
    bad: ['lost', 'rejected', 'overdue', 'breach', 'breached', 'critical', 'not feasible', 'failed', 'cancelled', 'expired', 'shortage', 'escalated', 'high', 'damaged', 'no'],
    warn: ['pending', 'negotiation', 'under discussion', 'waiting', 'on hold', 'partial', 'at risk', 'medium', 'due soon', 'revisit required', 'feasible with conditions', 'in progress', 'hold'],
    info: ['sent', 'open', 'new', 'scheduled', 'assigned', 'planned', 'submitted', 'quotation sent', 'site visit scheduled', 'contact made', 'enquiry received'],
  };
  function toneFor(text) {
    const t = String(text || '').toLowerCase();
    for (const k of Object.keys(TONES)) if (TONES[k].includes(t)) return k;
    for (const k of ['bad', 'warn', 'ok']) if (TONES[k].some((w) => w.length > 3 && t.includes(w))) return k;
    return '';
  }

  const ui = {
    h,
    page(el, { title, sub, crumbs, actions }) {
      const head = h('div', { class: 'page-head' }, [
        h('div', {}, [crumbs ? h('div', { class: 'crumbs' }, crumbs) : null, h('h1', {}, title), sub ? h('div', { class: 'sub' }, sub) : null]),
        h('div', { class: 'page-actions' }, actions || []),
      ]);
      el.appendChild(h('div', { class: 'brand-strip' }, [h('img', { src: 'assets/brand/logo-primary.png', alt: 'Maruthi Power Control Systems' }), h('span', { class: 'small muted' }, fmt.date(new Date()))]));
      el.appendChild(head);
      return head;
    },
    btn(label, onClick, cls) { return h('button', { class: 'btn ' + (cls || ''), type: 'button', onClick }, label); },
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
      return h('div', { class: 'kpis' }, items.map((k) => h('div', { class: 'kpi' + (k.onClick ? ' clickable' : ''), style: k.color ? '--kpi-c:' + k.color : null, onClick: k.onClick }, [
        h('div', { class: 'lbl' }, k.label), h('div', { class: 'val' }, k.value), k.meta ? h('div', { class: 'meta ' + (k.tone || '') }, k.meta) : null,
      ])));
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
     * opts: { columns:[{key,label,render(row)->string|Node,sort(row)->value,cls,footer}], rows, onRow(row), empty, pageSize, search:true, filters:[{key,label,options}] , actions(row)->[Node] }
     */
    table(opts) {
      const wrap = h('div', {});
      let sortKey = null, sortDir = 1, query = '', page = 0;
      const fstate = {};
      const pageSize = opts.pageSize || 15;
      const filterBar = (opts.search !== false || opts.filters) ? h('div', { class: 'filters' }) : null;
      if (filterBar) {
        if (opts.search !== false) filterBar.appendChild(h('input', { type: 'search', placeholder: 'Search…', onInput: (e) => { query = e.target.value.toLowerCase(); page = 0; draw(); } }));
        (opts.filters || []).forEach((f) => {
          const sel = h('select', { onChange: (e) => { fstate[f.key] = e.target.value; page = 0; draw(); } }, [h('option', { value: '' }, 'All ' + f.label)].concat((f.options || []).map((o) => h('option', { value: o }, o))));
          filterBar.appendChild(sel);
        });
        if (opts.toolbar) [].concat(opts.toolbar).forEach((n) => filterBar.appendChild(n));
        wrap.appendChild(filterBar);
      }
      const tw = h('div', { class: 'table-wrap' });
      const foot = h('div', { class: 'tbl-foot' });
      wrap.appendChild(tw); wrap.appendChild(foot);
      const cell = (c, r) => { const v = c.render ? c.render(r) : r[c.key]; return v instanceof Node ? v : document.createTextNode(v == null || v === '' ? '—' : String(v)); };
      function draw() {
        let rows = (typeof opts.rows === 'function' ? opts.rows() : opts.rows).slice();
        Object.keys(fstate).forEach((k) => { if (fstate[k]) rows = rows.filter((r) => String(r[k]) === fstate[k]); });
        if (query) rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(query));
        if (sortKey) { const c = opts.columns.find((x) => x.key === sortKey); const fn = c.sort || ((r) => r[c.key]); rows.sort((a, b) => { const x = fn(a), y = fn(b); return (x > y ? 1 : x < y ? -1 : 0) * sortDir; }); }
        const total = rows.length;
        const pages = Math.max(1, Math.ceil(total / pageSize));
        if (page >= pages) page = pages - 1;
        const view = rows.slice(page * pageSize, page * pageSize + pageSize);
        const t = h('table', { class: 'tbl' });
        const thr = h('tr', {}, opts.columns.map((c) => h('th', { class: c.cls || '', onClick: () => { if (sortKey === c.key) sortDir = -sortDir; else { sortKey = c.key; sortDir = 1; } draw(); } }, c.label + (sortKey === c.key ? (sortDir > 0 ? ' ▲' : ' ▼') : ''))));
        if (opts.actions) thr.appendChild(h('th', {}, ''));
        t.appendChild(h('thead', {}, thr));
        const tb = h('tbody');
        view.forEach((r) => {
          const tr = h('tr', { class: opts.onRow ? 'clickable' : '', onClick: opts.onRow ? (e) => { if (!e.target.closest('button,a,input,select')) opts.onRow(r); } : null }, opts.columns.map((c) => h('td', { class: c.cls || '' }, cell(c, r))));
          if (opts.actions) tr.appendChild(h('td', { class: 'nowrap right' }, opts.actions(r)));
          tb.appendChild(tr);
        });
        t.appendChild(tb);
        if (opts.columns.some((c) => c.footer)) t.appendChild(h('tfoot', {}, h('tr', {}, opts.columns.map((c) => h('td', { class: c.cls || '' }, c.footer ? String(c.footer(rows)) : '')).concat(opts.actions ? [h('td')] : []))));
        tw.innerHTML = '';
        if (!view.length) tw.appendChild(ui.empty(opts.empty || 'No records found'));
        else tw.appendChild(t);
        foot.innerHTML = '';
        foot.appendChild(h('span', {}, total + ' record' + (total === 1 ? '' : 's')));
        if (pages > 1) foot.appendChild(h('span', { class: 'row' }, [ui.btn('‹', () => { if (page > 0) { page--; draw(); } }, 'sm'), h('span', {}, (page + 1) + ' / ' + pages), ui.btn('›', () => { if (page < pages - 1) { page++; draw(); } }, 'sm')]));
      }
      draw();
      wrap.redraw = draw;
      return wrap;
    },
    empty(text, icon) { return h('div', { class: 'empty' }, [h('div', { class: 'big' }, icon || '∅'), text]); },

    /** Form builder. fields: [{key,label,type:'text'|'number'|'date'|'datetime-local'|'select'|'textarea'|'checkbox'|'readonly',options:[...]|[{value,label}],required,full,hint,placeholder,onChange}] */
    form(fields, values) {
      values = values || {};
      const el = h('div', { class: 'form' });
      const inputs = {};
      fields.forEach((f) => {
        if (f.type === 'section') { el.appendChild(h('div', { class: 'full', style: 'margin-top:6px' }, h('h3', {}, f.label))); return; }
        const id = 'f_' + f.key + '_' + util.uid();
        let input;
        const v = values[f.key] != null ? values[f.key] : (f.default != null ? f.default : '');
        if (f.type === 'select') {
          input = h('select', { id }, [h('option', { value: '' }, f.placeholder || 'Select…')].concat((f.options || []).map((o) => { const ov = typeof o === 'object' ? o.value : o; const ol = typeof o === 'object' ? o.label : o; return h('option', { value: ov, selected: String(ov) === String(v) ? true : null }, ol); })));
        } else if (f.type === 'textarea') input = h('textarea', { id, placeholder: f.placeholder || '' }, v);
        else if (f.type === 'checkbox') input = h('input', { id, type: 'checkbox', checked: v ? true : null });
        else input = h('input', { id, type: f.type === 'readonly' ? 'text' : (f.type || 'text'), value: v, readonly: f.type === 'readonly' || f.readonly ? true : null, placeholder: f.placeholder || '', min: f.min, max: f.max, step: f.step });
        if (f.onChange) input.addEventListener('change', () => f.onChange(input.type === 'checkbox' ? input.checked : input.value, inputs));
        inputs[f.key] = input;
        const field = h('div', { class: 'field' + (f.full || f.type === 'textarea' ? ' full' : '') }, f.type === 'checkbox'
          ? [h('label', { class: 'check-row', for: id }, [input, f.label])]
          : [h('label', { for: id }, [f.label, f.required ? h('span', { class: 'req' }, ' *') : null]), input, f.hint ? h('div', { class: 'hint' }, f.hint) : null]);
        el.appendChild(field);
      });
      el.values = () => {
        const out = {};
        fields.forEach((f) => { const i = inputs[f.key]; if (!i) return; out[f.key] = i.type === 'checkbox' ? i.checked : f.type === 'number' ? (i.value === '' ? null : Number(i.value)) : i.value; });
        return out;
      };
      el.validate = () => {
        let ok = true;
        fields.forEach((f) => {
          const i = inputs[f.key]; if (!i) return;
          const bad = f.required && (i.type === 'checkbox' ? !i.checked : String(i.value).trim() === '');
          i.closest('.field').classList.toggle('invalid', bad);
          if (bad) ok = false;
        });
        if (!ok) ui.toast('Please fill all mandatory fields', 'bad');
        return ok;
      };
      el.inputs = inputs;
      return el;
    },

    /** Modal dialog. opts: { title, body: Node|string, wide, actions:[{label, cls, onClick(close)->false keeps open}] } */
    modal(opts) {
      const ov = h('div', { class: 'overlay', onClick: (e) => { if (e.target === ov) close(); } });
      const close = () => ov.remove();
      const body = typeof opts.body === 'string' ? h('div', { html: opts.body }) : opts.body;
      const m = h('div', { class: 'modal' + (opts.wide ? ' wide' : '') }, [
        h('div', { class: 'modal-head' }, [h('div', {}, [h('h2', {}, opts.title), opts.sub ? h('div', { class: 'muted small' }, opts.sub) : null]), h('button', { class: 'btn ghost', onClick: close, 'aria-label': 'Close' }, '✕')]),
        h('div', { class: 'modal-body' }, body),
        h('div', { class: 'modal-foot' }, (opts.actions || [{ label: 'Close' }]).map((a) => ui.btn(a.label, () => { const r = a.onClick ? a.onClick(close) : undefined; if (r !== false) close(); }, a.cls))),
      ]);
      ov.appendChild(m);
      document.body.appendChild(ov);
      return { close, el: m };
    },
    /** Right-side drawer for record details. */
    drawer(opts) {
      const ov = h('div', { class: 'drawer-overlay', onClick: () => close() });
      const body = typeof opts.body === 'string' ? h('div', { html: opts.body }) : opts.body;
      const d = h('div', { class: 'drawer' }, [
        h('div', { class: 'modal-head' }, [h('div', {}, [h('h2', {}, opts.title), opts.sub ? h('div', { class: 'muted small' }, opts.sub) : null]), h('button', { class: 'btn ghost', onClick: () => close() }, '✕')]),
        h('div', { class: 'modal-body' }, body),
        opts.actions && opts.actions.length ? h('div', { class: 'modal-foot' }, opts.actions.map((a) => ui.btn(a.label, () => { const r = a.onClick ? a.onClick(close) : undefined; if (r !== false && a.close !== false) close(); }, a.cls))) : null,
      ]);
      const close = () => { ov.remove(); d.remove(); };
      document.body.appendChild(ov); document.body.appendChild(d);
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
      if (!box) { box = h('div', { class: 'toasts' }); document.body.appendChild(box); }
      const t = h('div', { class: 'toast ' + (tone || '') }, msg);
      box.appendChild(t);
      setTimeout(() => t.remove(), 3200);
    },
    tabs(items, onChange, active) {
      // items: [{id,label}] ; returns {el, body} where body is container to render into
      const wrap = h('div');
      const bar = h('div', { class: 'tabs' });
      const body = h('div');
      let cur = active || items[0].id;
      function sel(id) { cur = id; bar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.id === id)); body.innerHTML = ''; onChange(id, body); }
      items.forEach((t) => bar.appendChild(h('button', { 'data-id': t.id, onClick: () => sel(t.id) }, t.label + (t.count != null ? ' (' + t.count + ')' : ''))));
      wrap.appendChild(bar); wrap.appendChild(body);
      setTimeout(() => sel(cur));
      return wrap;
    },
    /** Kanban board. opts: { columns:[{id,label,color}], items, colOf(item), card(item)->Node, onMove(item, toColId)->bool, sum(items)->string, onClick(item) } */
    kanban(opts) {
      const board = h('div', { class: 'kanban' });
      opts.columns.forEach((c) => {
        const its = opts.items.filter((i) => opts.colOf(i) === c.id);
        const col = h('div', { class: 'kcol', 'data-col': c.id }, [h('div', { class: 'kcol-head' }, [h('span', {}, [h('span', { class: 'div-tag', style: '--c:' + (c.color || 'var(--brand)') }, c.label), ' ', h('span', { class: 'badge' }, its.length)]), opts.sum ? h('span', { class: 'sum' }, opts.sum(its)) : null])]);
        its.forEach((i) => {
          const card = h('div', { class: 'kcard', draggable: opts.onMove ? 'true' : null, onClick: () => opts.onClick && opts.onClick(i) }, opts.card(i));
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
    /** Stepper. steps: [labels]; current index; blockedIndex optional */
    stepper(steps, current, blocked) {
      return h('div', { class: 'stepper' }, steps.map((s, i) => h('div', { class: 'step ' + (i < current ? 'done' : i === current ? (blocked ? 'blocked' : 'current') : '') }, [h('div', { class: 'dot' }, i < current ? '✓' : String(i + 1)), h('div', {}, s)])));
    },
    /** Checklist bound to an object map {item: true}. onChange(stateObj) */
    checklist(items, stateObj, onChange, readOnly) {
      stateObj = stateObj || {};
      const wrap = h('div');
      const prog = h('div', { class: 'progress', style: 'margin-bottom:8px' }, h('i'));
      const lbl = h('div', { class: 'small muted', style: 'margin-bottom:4px' });
      const list = h('div', { class: 'checklist' });
      function upd() { const done = items.filter((i) => stateObj[i]).length; prog.firstChild.style.width = util.pct(done, items.length) + '%'; prog.style.setProperty('--pc', done === items.length ? 'var(--ok)' : 'var(--chart-1)'); lbl.textContent = done + ' of ' + items.length + ' checks complete'; }
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
    progress(pct, color) { return h('div', { class: 'progress', style: '--pc:' + (color || (pct >= 100 ? 'var(--ok)' : pct >= 60 ? 'var(--chart-1)' : 'var(--chart-4)')) }, h('i', { style: 'width:' + Math.min(100, Math.max(0, pct)) + '%' })); },
    timeline(items) {
      // items: [{when, title, body, color}]
      return h('div', { class: 'timeline' }, items.map((i) => h('div', { class: 'tl-item' }, [h('div', { class: 'tl-dot', style: i.color ? 'background:' + i.color : null }), h('div', {}, [h('div', { class: 'when' }, i.when), h('div', { style: 'font-weight:600' }, i.title), i.body ? h('div', { class: 'small muted' }, i.body) : null])])));
    },
    dl(pairs) {
      // pairs: [[label, value|Node], ...]
      return h('dl', { class: 'dl' }, pairs.filter(Boolean).map(([k, v]) => h('div', {}, [h('dt', {}, k), h('dd', {}, v instanceof Node ? v : (v == null || v === '' ? '—' : String(v)))])));
    },
    callout(text, tone) { return h('div', { class: 'callout ' + (tone || ''), html: text }); },
    auditTrail(col, id) {
      const items = (state.audit || []).filter((a) => a.col === col && a.recId === id).slice().reverse();
      if (!items.length) return ui.empty('No audit entries yet', '📜');
      return ui.timeline(items.map((a) => ({ when: fmt.dateTime(a.ts) + ' · ' + a.user + ' (' + (role(a.role) ? role(a.role).name : a.role) + ')', title: a.action.toUpperCase(), body: a.note })));
    },

    // -------------------------------------------- charts (dependency-free SVG)
    /** Vertical bar chart. data: [{label, values:[n...]}], series:[{name,color}] */
    barChart(data, series, opts) {
      opts = opts || {};
      series = series || [{ name: 'Value', color: 'var(--chart-1)' }];
      const W = 600, H = opts.height || 220, P = { l: 46, r: 8, t: 10, b: 34 };
      const max = Math.max(1, ...data.flatMap((d) => d.values)) * 1.1;
      const bw = (W - P.l - P.r) / Math.max(1, data.length);
      const inner = Math.min(38, (bw * 0.72) / series.length);
      let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img">';
      for (let i = 0; i <= 4; i++) { const y = P.t + (H - P.t - P.b) * (i / 4); const v = max * (1 - i / 4); svg += '<line x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y + '" y2="' + y + '" stroke="var(--border)" />' + '<text x="' + (P.l - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + (opts.money ? fmt.lakh(v).replace('₹', '') : Math.round(v)) + '</text>'; }
      data.forEach((d, i) => {
        const x0 = P.l + i * bw + (bw - inner * series.length) / 2;
        d.values.forEach((v, j) => { const bh = (H - P.t - P.b) * (v / max); svg += '<rect x="' + (x0 + j * inner) + '" y="' + (H - P.b - bh) + '" width="' + (inner - 2) + '" height="' + bh + '" rx="3" fill="' + series[j].color + '"><title>' + util.esc(d.label + ' · ' + series[j].name + ': ' + (opts.money ? fmt.lakh(v) : v)) + '</title></rect>'; });
        svg += '<text x="' + (P.l + i * bw + bw / 2) + '" y="' + (H - P.b + 16) + '" text-anchor="middle">' + util.esc(String(d.label).slice(0, 14)) + '</text>';
      });
      svg += '</svg>';
      const legend = series.length > 1 ? '<div class="legend">' + series.map((s) => '<span><i style="background:' + s.color + '"></i>' + util.esc(s.name) + '</span>').join('') + '</div>' : '';
      return h('div', { class: 'chart', html: svg + legend });
    },
    /** Line chart. labels:[..], series:[{name,color,values:[..]}] */
    lineChart(labels, series, opts) {
      opts = opts || {};
      const W = 600, H = opts.height || 220, P = { l: 46, r: 10, t: 10, b: 30 };
      const max = Math.max(1, ...series.flatMap((s) => s.values)) * 1.1;
      const x = (i) => P.l + (W - P.l - P.r) * (labels.length < 2 ? 0.5 : i / (labels.length - 1));
      const y = (v) => P.t + (H - P.t - P.b) * (1 - v / max);
      let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '">';
      for (let i = 0; i <= 4; i++) { const yy = P.t + (H - P.t - P.b) * (i / 4); svg += '<line x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--border)"/><text x="' + (P.l - 6) + '" y="' + (yy + 4) + '" text-anchor="end">' + (opts.money ? fmt.lakh(max * (1 - i / 4)).replace('₹', '') : Math.round(max * (1 - i / 4))) + '</text>'; }
      labels.forEach((l, i) => { svg += '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + util.esc(l) + '</text>'; });
      series.forEach((s) => {
        const pts = s.values.map((v, i) => x(i) + ',' + y(v)).join(' ');
        if (opts.area) svg += '<polygon points="' + x(0) + ',' + (H - P.b) + ' ' + pts + ' ' + x(s.values.length - 1) + ',' + (H - P.b) + '" fill="' + s.color + '" opacity=".1"/>';
        svg += '<polyline points="' + pts + '" fill="none" stroke="' + s.color + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"' + (s.dashed ? ' stroke-dasharray="5 4"' : '') + '/>';
        s.values.forEach((v, i) => { svg += '<circle cx="' + x(i) + '" cy="' + y(v) + '" r="3.2" fill="var(--surface)" stroke="' + s.color + '" stroke-width="2"><title>' + util.esc(s.name + ' · ' + labels[i] + ': ' + (opts.money ? fmt.lakh(v) : v)) + '</title></circle>'; });
      });
      svg += '</svg>';
      return h('div', { class: 'chart', html: svg + '<div class="legend">' + series.map((s) => '<span><i style="background:' + s.color + '"></i>' + util.esc(s.name) + '</span>').join('') + '</div>' });
    },
    /** Donut. data: [{label, value, color}] */
    donut(data, opts) {
      opts = opts || {};
      const total = util.sum(data, (d) => d.value);
      const R = 60, C = 2 * Math.PI * R;
      let off = 0;
      let svg = '<svg viewBox="0 0 160 160" style="max-width:170px"><circle cx="80" cy="80" r="' + R + '" fill="none" stroke="var(--surface-3)" stroke-width="20"/>';
      data.forEach((d) => { const len = total ? (d.value / total) * C : 0; svg += '<circle cx="80" cy="80" r="' + R + '" fill="none" stroke="' + d.color + '" stroke-width="20" stroke-dasharray="' + len + ' ' + (C - len) + '" stroke-dashoffset="' + (-off) + '" transform="rotate(-90 80 80)"><title>' + util.esc(d.label + ': ' + (opts.money ? fmt.lakh(d.value) : d.value)) + '</title></circle>'; off += len; });
      svg += '<text x="80" y="78" text-anchor="middle" style="font-size:18px;font-weight:700;fill:var(--text)">' + util.esc(opts.center != null ? opts.center : (opts.money ? fmt.lakh(total) : total)) + '</text><text x="80" y="96" text-anchor="middle">' + util.esc(opts.label || 'Total') + '</text></svg>';
      const legend = '<div class="legend" style="flex-direction:column;gap:6px">' + data.map((d) => '<span><i style="background:' + d.color + '"></i>' + util.esc(d.label) + ' — <b>' + (opts.money ? fmt.lakh(d.value) : d.value) + '</b> (' + util.pct(d.value, total) + '%)</span>').join('') + '</div>';
      return h('div', { class: 'chart', style: 'display:flex;gap:18px;align-items:center;flex-wrap:wrap', html: svg + legend });
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
          h('div', { class: 'bar', title: r.target ? 'Target ' + r.target : '' }, h('i', { style: 'width:' + (r.value / max * 100) + '%;background:' + color })),
          h('div', { class: 'small nowrap' }, r.text || ((opts.money ? fmt.lakh(r.value) : fmt.num(r.value)) + (r.target ? ' / ' + (opts.money ? fmt.lakh(r.target) : fmt.num(r.target)) + ' · ' + pct + '%' : ''))),
        ];
      }));
    },
  };

  function closeOverlays() { document.querySelectorAll('.overlay,.drawer,.drawer-overlay').forEach((e) => e.remove()); }

  // ---------------------------------------------------------------- shell rendering
  function renderBell() {
    const dot = document.getElementById('bellDot');
    if (!dot) return;
    const r = currentRoleId();
    const n = myNotifications().filter((x) => !x.readBy.includes(r)).length;
    dot.textContent = n > 99 ? '99+' : n;
    dot.classList.toggle('hidden', !n);
  }
  function toggleNotifPanel() {
    const host = document.getElementById('bellWrap');
    const ex = host.querySelector('.notif-panel');
    if (ex) { ex.remove(); return; }
    const r = currentRoleId();
    const list = myNotifications().slice(0, 40);
    const panel = h('div', { class: 'notif-panel' }, [
      h('div', { class: 'card-head' }, [h('h3', {}, 'Notifications & Alerts'), ui.btn('Mark all read', () => { list.forEach((n) => { if (!n.readBy.includes(r)) n.readBy.push(r); }); persist(); renderBell(); panel.remove(); }, 'sm ghost')]),
    ].concat(list.length ? list.map((n) => h('div', { class: 'notif ' + (n.readBy.includes(r) ? '' : 'unread'), onClick: () => { if (!n.readBy.includes(r)) n.readBy.push(r); persist(); renderBell(); panel.remove(); if (n.link) location.hash = n.link; } }, [
      h('div', { class: 'row', style: 'justify-content:space-between' }, [h('b', {}, n.title), ui.badge(n.severity === 'bad' ? 'Escalation' : n.severity === 'warn' ? 'Alert' : n.severity === 'ok' ? 'Done' : 'Info', n.severity === 'info' ? 'info' : n.severity)]),
      n.body ? h('div', { class: 'small' }, n.body) : null,
      h('div', { class: 'when' }, fmt.dateTime(n.createdAt) + ' · ' + n.channel),
    ])) : [ui.empty('You are all caught up', '🔔')]));
    host.appendChild(panel);
  }

  const searchProviders = [];
  function registerSearch(fn) { searchProviders.push(fn); } // fn(query) -> [{label, sub, link}]
  function doSearch(q) {
    const box = document.getElementById('searchResults');
    if (!q || q.length < 2) { box.classList.add('hidden'); return; }
    const ql = q.toLowerCase();
    let res = [];
    master.customers().filter((c) => (c.name + c.id + c.contact + c.phone).toLowerCase().includes(ql)).slice(0, 5).forEach((c) => res.push({ label: c.name, sub: 'Customer · ' + c.id + ' · ' + c.area, link: '#/customer360/' + c.id }));
    searchProviders.forEach((fn) => { try { res = res.concat(fn(ql) || []); } catch (e) { /* ignore */ } });
    box.innerHTML = '';
    if (!res.length) box.appendChild(h('div', { class: 'empty small' }, 'No matches'));
    res.slice(0, 14).forEach((r) => box.appendChild(h('a', { href: r.link, onClick: () => box.classList.add('hidden') }, [h('div', { style: 'font-weight:600' }, r.label), h('div', { class: 'small muted' }, r.sub)])));
    box.classList.remove('hidden');
  }

  function buildShell() {
    const roleSel = h('select', { id: 'roleSelect', 'aria-label': 'Switch role', onChange: (e) => switchRole(e.target.value) },
      ROLE_GROUPS.map((g) => h('optgroup', { label: g }, ROLES.filter((r) => r.group === g).map((r) => h('option', { value: r.id, selected: r.id === currentRoleId() ? true : null }, r.name)))));
    const r = role();
    const app = h('div', { class: 'app' }, [
      h('aside', { class: 'sidebar' }, [
        h('a', { class: 'brand', href: '#/home', 'aria-label': 'Maruthi Power Control Systems — home' }, [h('img', { src: 'assets/brand/logo-reversed.png', alt: 'Maruthi Power Control Systems', width: 200, height: 36 }), h('div', { class: 'brand-sub' }, 'Unified CRM · Since 1996')]),
        h('div', { class: 'speed-bands', 'aria-hidden': 'true' }),
        navEl = h('nav', { class: 'nav' }),
        h('div', { class: 'side-foot' }, [h('div', { class: 'tagline' }, 'Power that stays on.'), h('div', { class: 'tagline-ta', lang: 'ta' }, 'தடையில்லா மின்சாரம், தளராத நம்பிக்கை.'), h('div', {}, 'Power · Electronic Security · Solar'), h('a', { href: '#/', style: 'color:var(--side-text)', onClick: (e) => { e.preventDefault(); ui.confirm('Reset demo data', 'This clears all local CRM data and regenerates the sample dataset. Continue?', () => db.reset()); } }, '↺ Reset demo data')]),
      ]),
      h('div', { class: 'main' }, [
        h('header', { class: 'topbar' }, [
          h('button', { class: 'icon-btn menu-btn ico', 'aria-label': 'Menu', onClick: () => app.classList.toggle('nav-open'), html: svg('<path d="M4 7h16M4 12h16"/><path class="acc" d="M4 17h10"/>') }),
          h('img', { class: 'top-logo', src: 'assets/brand/logo-compact.png', alt: 'Maruthi' }),
          h('div', { class: 'search' }, [h('input', { type: 'search', placeholder: 'Search customers, enquiries, projects, complaints…', onInput: util.debounce((e) => doSearch(e.target.value), 180), onBlur: () => setTimeout(() => document.getElementById('searchResults').classList.add('hidden'), 200) }), h('div', { id: 'searchResults', class: 'search-results hidden' })]),
          h('div', { class: 'top-spacer' }),
          h('button', { class: 'icon-btn ico theme-btn', title: 'Toggle theme', 'aria-label': 'Toggle theme', onClick: toggleTheme, html: svg('<circle cx="12" cy="12" r="8"/><path class="acc" d="M12 4a8 8 0 010 16z"/>') }),
          h('div', { id: 'bellWrap', style: 'position:relative' }, [h('button', { class: 'icon-btn ico', title: 'Notifications', 'aria-label': 'Notifications', onClick: toggleNotifPanel }, [h('span', { style: 'display:grid', html: svg('<path d="M6 16V11a6 6 0 0112 0v5l2 2H4z"/><path class="acc" d="M10 20a2 2 0 004 0"/>') }), h('span', { id: 'bellDot', class: 'dot hidden' }, '0')])]),
          h('label', { class: 'role-switch', title: 'Switch role to preview each user experience' }, [h('span', { class: 'avatar', id: 'roleAvatar', style: 'background:' + r.color }, util.initials(r.user)), roleSel]),
        ]),
        contentEl = h('main', { class: 'content', id: 'content' }),
      ]),
    ]);
    document.body.appendChild(app);
  }

  function switchRole(id) {
    localStorage.setItem(ROLE_KEY, id);
    const r = role();
    const av = document.getElementById('roleAvatar');
    av.textContent = util.initials(r.user); av.style.background = r.color;
    renderBell();
    ui.toast('Switched to ' + r.name + ' (' + r.user + ')', 'ok');
    emit('role:changed', r);
    if (location.hash === '#/home' || location.hash === '#/' || !location.hash) render(); else go('home');
  }
  function toggleTheme() {
    const root = document.documentElement;
    const cur = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('mpcs-crm-theme', next); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- built-in shared pages
  function registerCorePages() {
    registerPage({
      id: 'customer360', title: 'Customer 360', icon: '◎', section: 'Masters', order: 90,
      roles: ALL.filter((r) => r !== 'vendor'),
      render(el, [id]) {
        if (!id) {
          ui.page(el, { title: 'Customer Master', sub: 'Common customer master shared by Sales, Projects and Service', actions: is('admin', 'sales_manager', 'sales_exec', 'sales_coordinator') ? [ui.btn('+ New customer', () => editCustomer(), 'primary')] : [] });
          el.appendChild(ui.card(null, ui.table({
            rows: () => master.customers(), onRow: (c) => go('customer360', c.id),
            filters: [{ key: 'type', label: 'types', options: ['New Customer', 'Existing Customer', 'Dealer', 'Key Customer'] }, { key: 'area', label: 'areas', options: AREAS }, { key: 'segment', label: 'segments', options: SEGMENTS }],
            columns: [
              { key: 'id', label: 'Customer ID', render: (c) => h('span', { class: 'mono' }, c.id) }, { key: 'name', label: 'Account name' }, { key: 'contact', label: 'Contact' }, { key: 'phone', label: 'Phone' },
              { key: 'area', label: 'Area' }, { key: 'segment', label: 'Segment' }, { key: 'type', label: 'Type', render: (c) => ui.badge(c.type, c.type === 'Key Customer' ? 'violet' : c.type === 'Dealer' ? 'warn' : c.type === 'New Customer' ? 'info' : 'ok') },
            ],
          }), { flush: true }));
          return;
        }
        const c = master.customer(id);
        if (!c) { el.appendChild(ui.empty('Customer not found')); return; }
        ui.page(el, { title: c.name, crumbs: 'Customer 360 › ' + c.id, sub: c.segment + ' · ' + c.area + ' · Customer since ' + fmt.date(c.since), actions: [ui.btn('← All customers', () => go('customer360')), is('admin', 'sales_manager', 'sales_exec') ? ui.btn('Edit', () => editCustomer(c), 'primary') : null] });
        const sections = [];
        customer360Sections.forEach((fn) => { try { const s = fn(c); if (s) sections.push(s); } catch (e) { console.error(e); } });
        const grid = h('div', { class: 'grid g3' }, [
          ui.card('Profile', ui.dl([['Customer ID', c.id], ['Type', ui.badge(c.type)], ['Contact', c.contact], ['Phone', c.phone], ['Email', c.email], ['GSTIN', c.gstin], ['Area', c.area], ['Segment', c.segment]])),
          ui.card('Sites', h('div', { class: 'stack' }, master.sites(c.id).map((s) => h('div', {}, [h('b', {}, s.name + ' · ' + s.id), h('div', { class: 'small muted' }, s.address), h('div', { class: 'small' }, 'Access: ' + s.access)])))),
          ui.card('Relationship summary', h('div', { class: 'stack' }, sections.filter((s) => s.summary).map((s) => h('div', { class: 'row', style: 'justify-content:space-between' }, [h('span', {}, s.title), h('b', {}, s.summary)])))),
        ]);
        el.appendChild(grid);
        sections.filter((s) => s.body).forEach((s) => { const b = s.body(); el.appendChild(h('div', { class: 'mt' }, ui.card(s.title, b, { flush: !!s.flush }))); });
      },
    });

    registerPage({
      id: 'audit', title: 'Audit Log', icon: '📜', section: 'Administration', order: 95, roles: ['admin', 'gm', 'odm'],
      render(el) {
        ui.page(el, { title: 'Audit Log', sub: 'Timestamped audit trail of every create/update across modules' });
        el.appendChild(ui.card(null, ui.table({
          rows: () => (state.audit || []).slice().reverse(), pageSize: 25,
          filters: [{ key: 'col', label: 'collections', options: Object.keys(util.countBy(state.audit || [], 'col')) }, { key: 'action', label: 'actions', options: ['create', 'update', 'delete'] }],
          columns: [{ key: 'ts', label: 'When', render: (a) => fmt.dateTime(a.ts) }, { key: 'user', label: 'User' }, { key: 'role', label: 'Role', render: (a) => (role(a.role) || {}).name || a.role }, { key: 'action', label: 'Action', render: (a) => ui.badge(a.action, a.action === 'create' ? 'ok' : a.action === 'delete' ? 'bad' : 'info') }, { key: 'col', label: 'Record type' }, { key: 'recId', label: 'Record', render: (a) => h('span', { class: 'mono' }, a.recId) }, { key: 'note', label: 'Details' }],
        }), { flush: true }));
      },
    });

    registerPage({
      id: 'users', title: 'Users & Access', icon: '👥', section: 'Administration', order: 96, roles: ['admin'],
      render(el) {
        ui.page(el, { title: 'Users & Role Access', sub: 'Role-based access matrix consolidated from all four requirement documents', actions: [ui.btn('+ Add user', () => ui.formModal('Add user', [{ key: 'name', label: 'Name', required: true }, { key: 'role', label: 'Role', type: 'select', required: true, options: ROLES.map((r) => ({ value: r.id, label: r.name })) }, { key: 'division', label: 'Division', type: 'select', options: DIVISIONS.map((d) => d.id) }, { key: 'area', label: 'Area', type: 'select', options: AREAS }, { key: 'phone', label: 'Phone' }], {}, (v) => { db.insert('staff', Object.assign(v, { active: true })); ui.toast('User created', 'ok'); refresh(); }), 'primary')] });
        el.appendChild(ui.card('Staff directory', ui.table({
          rows: () => db.all('staff'), filters: [{ key: 'role', label: 'roles', options: ROLES.map((r) => r.id) }],
          columns: [{ key: 'id', label: 'ID', render: (s) => h('span', { class: 'mono' }, s.id) }, { key: 'name', label: 'Name' }, { key: 'role', label: 'Role', render: (s) => (role(s.role) || {}).name }, { key: 'division', label: 'Division', render: (s) => s.division ? ui.divTag(s.division) : 'All' }, { key: 'area', label: 'Area' }, { key: 'active', label: 'Status', render: (s) => ui.badge(s.active ? 'Active' : 'Inactive') }],
          actions: (s) => [ui.btn(s.active ? 'Deactivate' : 'Activate', () => { db.update('staff', s.id, { active: !s.active }); refresh(); }, 'sm')],
        }), { flush: true }));
        const matrix = h('div', { class: 'table-wrap' });
        const secs = [];
        pages.forEach((p) => { if (!secs.includes(p.section)) secs.push(p.section); });
        const t = h('table', { class: 'tbl' }, [h('thead', {}, h('tr', {}, [h('th', {}, 'Role')].concat(secs.map((s) => h('th', {}, s))))), h('tbody', {}, ROLES.map((r) => h('tr', {}, [h('td', {}, h('b', {}, r.name))].concat(secs.map((s) => { const ps = pages.filter((p) => p.section === s); const n = ps.filter((p) => p.roles.includes(r.id)).length; return h('td', {}, n ? ui.badge(n === ps.length ? 'Full' : n + '/' + ps.length, n === ps.length ? 'ok' : 'info') : h('span', { class: 'muted' }, '—')); })))))]);
        matrix.appendChild(t);
        el.appendChild(h('div', { class: 'mt' }, ui.card('Access matrix (pages visible per role and module)', matrix, { flush: true })));
      },
    });

    registerPage({
      id: 'masters', title: 'Master Data', icon: '🗂', section: 'Administration', order: 97, roles: ['admin'],
      render(el) {
        ui.page(el, { title: 'Master Data', sub: 'Product, site and configuration masters', actions: [ui.btn('Export data (JSON)', () => { const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(db.export(), null, 1)], { type: 'application/json' })), download: 'mpcs-crm-export.json' }); a.click(); }), ui.btn('Import data', () => { const i = h('input', { type: 'file', accept: '.json' }); i.onchange = () => { const r = new FileReader(); r.onload = () => { try { db.import(JSON.parse(r.result)); } catch (e) { ui.toast('Invalid file', 'bad'); } }; r.readAsText(i.files[0]); }; i.click(); })] });
        el.appendChild(ui.tabs([{ id: 'p', label: 'Products' }, { id: 's', label: 'Sites' }], (id, body) => {
          if (id === 'p') body.appendChild(ui.card(null, ui.table({ rows: () => db.all('products'), filters: [{ key: 'division', label: 'divisions', options: DIVISIONS.map((d) => d.id) }], columns: [{ key: 'id', label: 'Code', render: (p) => h('span', { class: 'mono' }, p.id) }, { key: 'division', label: 'Division', render: (p) => ui.divTag(p.division) }, { key: 'category', label: 'Category' }, { key: 'name', label: 'Product' }, { key: 'price', label: 'Price', cls: 'right', render: (p) => fmt.money(p.price) }, { key: 'warrantyMonths', label: 'Warranty (m)', cls: 'right' }] }), { flush: true }));
          else body.appendChild(ui.card(null, ui.table({ rows: () => db.all('sites'), columns: [{ key: 'id', label: 'Site ID', render: (s) => h('span', { class: 'mono' }, s.id) }, { key: 'customerId', label: 'Customer', render: (s) => (master.customer(s.customerId) || {}).name }, { key: 'name', label: 'Site' }, { key: 'address', label: 'Address' }, { key: 'access', label: 'Access arrangement' }] }), { flush: true }));
        }));
      },
    });
  }

  const customer360Sections = [];
  /** Modules add sections to Customer 360: fn(customer) -> { title, summary, body()->Node, flush } */
  function registerCustomerSection(fn) { customer360Sections.push(fn); }

  function editCustomer(c) {
    ui.formModal(c ? 'Edit customer' : 'New customer', [
      { key: 'name', label: 'Account name', required: true }, { key: 'type', label: 'Customer type', type: 'select', required: true, options: ['New Customer', 'Existing Customer', 'Dealer', 'Key Customer'] },
      { key: 'contact', label: 'Contact name', required: true }, { key: 'phone', label: 'Contact number', required: true }, { key: 'email', label: 'Email' }, { key: 'area', label: 'Area', type: 'select', options: AREAS, required: true },
      { key: 'segment', label: 'Segment', type: 'select', options: SEGMENTS }, { key: 'gstin', label: 'GSTIN' },
    ], c || { type: 'New Customer', since: util.iso(TODAY) }, (v) => {
      if (c) db.update('customers', c.id, v);
      else {
        const dup = master.customers().find((x) => x.phone === v.phone || x.name.toLowerCase() === v.name.toLowerCase());
        if (dup) { ui.toast('Duplicate prevented: ' + dup.name + ' (' + dup.id + ') already exists', 'bad'); return false; }
        const n = db.insert('customers', Object.assign(v, { since: util.iso(TODAY) }), { prefix: 'CUS' });
        db.insert('sites', { customerId: n.id, name: 'Main Site', address: v.area, contact: v.contact, phone: v.phone, access: 'Reception' });
      }
      ui.toast('Customer saved', 'ok'); refresh();
    });
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    load();
    try { const t = localStorage.getItem('mpcs-crm-theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch (e) { /* ignore */ }
    const fresh = !db.all('staff').length;
    seedMasters();
    if (fresh) {
      seeds.forEach((fn) => { try { fn(db, { util, master, fmt }); } catch (e) { console.error('[CRM] seed failed', e); } });
      state.audit = [];
      persist();
    }
    registerCorePages();
    buildShell();
    emit('ready');
    renderBell();
    window.addEventListener('hashchange', render);
    render();
  }

  window.CRM = {
    db, util, fmt, ui, h, master, notify, on, emit, go, refresh,
    roles: ROLES, ROLE: Object.fromEntries(ROLES.map((r) => [r.id, r.id])), ALL, MGMT, role, user, is, canSee,
    registerPage, registerHome, registerSeed, registerRole, registerSearch, registerCustomerSection,
    nextId, TODAY, persist, icons: ICONS,
  };
  document.addEventListener('DOMContentLoaded', boot);
})();
