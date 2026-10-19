/* Sales CRM module — Maruthi Power Control Systems
 * Source: Sales.pdf (plus Sales OTS flow and Sales/Installation policy violations from Service_requirement.pdf)
 * Owns collections: enquiries, quotations, orders, invoices, payments, followups, dealers, upsells, targets, callLogs, checkins
 * Emits:  order.won (on Sales Manager SO approval), invoice.raised, violation.raise (sales SLA breaches),
 *         ots.converted { otsId, enquiryId, execId } (Sales OTS taken into the sales pipeline),
 *         ots.outcome { otsId, enquiryId, status: 'Quotation Sent'|'Negotiation'|'Won'|'Lost', revenue, orderId, closedBy, lostReason }
 *         (Sales never writes the Service-owned `ots` collection — Service listens and updates the OTS record)
 * Listens: complaint.chargeable (service charges to collect), ots.created (Sales OTS → coordinator queue / Sales OTS desk)
 * Config:  CRM.config keys 'gst.<Division>', 'sales.sla', 'sales.escalation', 'sales.paymentEscalation', 'sales.reminders',
 *          'sales.discount', 'sales.otsIncentive' (Settings & Rules → "Sales rules & reports"); fallback store: salesConfig/CFG
 */
(function () {
  'use strict';
  const { db, ui, h, util, fmt, master } = CRM;

  // ============================================================ constants (Sales.pdf)
  const STAGES = ['Enquiry Received', 'Contact Made', 'Site Visit Scheduled', 'Site Visit Completed', 'Quotation Sent', 'Negotiation', 'Order Won', 'Order Lost'];
  const OPEN = STAGES.slice(0, 6);
  const STAGE_COLORS = ['var(--chart-5)', 'var(--steel)', 'var(--chart-1)', 'var(--chart-4)', 'var(--div-security)', 'var(--warn)', 'var(--ok)', 'var(--bad)'];
  const DIVS = ['Power', 'Electronic Security', 'Solar'];
  // Sales channels: existing-customer business and new-customer business
  const CHANNELS = ['OTS', 'Office Walk-in', 'Upselling & Cross Selling', 'Cold Calling', 'Digital Marketing', 'Referral Sales', 'Advertisements', 'Business Forums'];
  const EXISTING_CHANNELS = ['OTS', 'Office Walk-in', 'Upselling & Cross Selling'];
  const REFERRAL_TYPES = ['Vendor reference', 'Existing customer reference', 'Dealer reference', 'Staff reference'];
  const LEAD_SOURCES = ['Cold Calling', 'Existing Customer Reference', 'Existing Customer Business', 'Dealer', 'Website', 'Walk-in', 'Campaign'];
  const CUSTOMER_TYPES = ['New Customer', 'Existing Customer', 'Dealer', 'Key Customer'];
  const CALL_STATUS = ['Connected', 'Call Back Requested', 'Not Reachable', 'Busy', 'Switched Off', 'Wrong Number', 'Not Interested'];
  const FU_STATUS = ['Pending', 'Completed', 'Missed', 'Rescheduled'];
  const FU_TYPES = ['Call', 'Site Visit', 'Meeting', 'WhatsApp', 'Email'];
  const QUOTE_STATUS = ['Sent', 'Under Discussion', 'Approved', 'Rejected', 'Pending'];
  const LOST_REASONS = ['Price too high', 'Lost to competitor', 'Budget not available', 'Decision postponed', 'Product / spec mismatch', 'No response from customer', 'Other'];
  const MATERIAL = ['Available in stock', 'Partially available', 'To be procured', 'Ordered with vendor'];
  const PAY_TERMS = { '100% Advance': 0, 'Against delivery': 0, 'Credit 15 days': 15, 'Credit 30 days': 30, 'Credit 45 days': 45, 'Credit 60 days': 60 };
  const PAY_MODES = ['Cash', 'UPI', 'NEFT / RTGS', 'Cheque', 'Card'];
  const WARRANTY = ['Standard warranty – 12 months', 'Extended warranty – 24 months', 'Battery warranty – 36 months (pro-rata)', 'Comprehensive AMC – 1 year', 'Non-comprehensive AMC – 1 year', 'Solar system warranty – 5 years (panels 25 yrs perf.)'];
  const SCRAP_TYPES = ['Battery', 'Inverter', 'UPS'];
  const CALL_TYPES = ['Cold Call', 'Follow-up Call', 'Enquiry Call', 'Payment Follow-up', 'Courtesy Call'];
  const CALL_OUTCOMES = ['Interested', 'Enquiry Generated', 'Call Back Later', 'Not Interested', 'Not Reachable'];
  const UPSELL_STATUS = ['Suggested', 'Offered', 'Converted', 'Declined'];
  const ORDER_STEPS = ['Order Won', 'SO Approved', 'Invoiced', 'Delivered / Installed', 'Payment Received'];
  // Sales policy SLAs (Service_requirement §4–5) — configurable in Settings & Rules (see cfg('sales.sla'))
  const SLA = {};
  ['quoteHrs', 'siteVisitHrs', 'soHrs', 'scrapHrs', 'quoteResponseDays'].forEach((k) => Object.defineProperty(SLA, k, { get: () => Number(cfg('sales.sla')[k]) || 0 }));
  // Upsell / cross-sell suggestion rules (e.g. customer buying UPS → offer batteries / stabilizer)
  const UPSELL_RULES = [
    { when: 'Online UPS', type: 'Cross-sell', offer: 'Battery', why: 'UPS needs a battery bank' },
    { when: 'Online UPS', type: 'Cross-sell', offer: 'Servo Stabilizer', why: 'Protect UPS input from voltage swings' },
    { when: 'Inverter', type: 'Cross-sell', offer: 'Battery', why: 'Inverter backup battery' },
    { when: 'Inverter', type: 'Upsell', offer: 'Inverter', why: 'Higher KVA for more backup load' },
    { when: 'Battery', type: 'Cross-sell', offer: 'Inverter', why: 'Replace ageing inverter with batteries' },
    { when: 'Servo Stabilizer', type: 'Cross-sell', offer: 'Online UPS', why: 'Critical loads need online UPS' },
    { when: 'CCTV', type: 'Cross-sell', offer: 'Biometric', why: 'Attendance / access with surveillance' },
    { when: 'CCTV', type: 'Upsell', offer: 'CCTV', why: 'Add PTZ / extra storage' },
    { when: 'Access Control', type: 'Cross-sell', offer: 'Video Door Phone', why: 'Visitor management' },
    { when: 'On-grid', type: 'Upsell', offer: 'Hybrid', why: 'Upgrade to hybrid for backup' },
    { when: 'On-grid', type: 'Cross-sell', offer: 'Online UPS', why: 'Backup for critical loads' },
  ];

  // ============================================================ helpers
  const sum = (arr, f) => (arr || []).reduce((s, x) => s + (Number(typeof f === 'function' ? f(x) : f ? x[f] : x) || 0), 0);
  const me = () => CRM.user().id;
  const isExec = () => CRM.is('sales_exec');
  const canWork = () => CRM.is('sales_exec', 'sales_coordinator', 'sales_manager', 'admin');
  const isMgr = () => CRM.is('sales_manager', 'admin');
  const isCoord = () => CRM.is('sales_coordinator', 'sales_manager', 'admin');
  const isAcc = () => CRM.is('accounts', 'admin');
  const nowIso = () => new Date().toISOString();
  const todayIso = () => util.iso(CRM.TODAY);
  const execs = () => master.staff('sales_exec');
  const execName = (id) => (id ? master.staffName(id) : 'Unassigned');
  const scope = (list) => (isExec() ? list.filter((r) => r.execId === me()) : list);
  const allEnq = () => scope(db.all('enquiries'));
  const allQuotes = () => scope(db.all('quotations'));
  const allOrders = () => scope(db.all('orders'));
  const allInvoices = () => scope(db.all('invoices'));
  const custName = (r) => { const c = r.customerId && master.customer(r.customerId); return c ? c.name : (r.accountName || '—'); };
  // trusted markup (all user text passes through util.esc) — Core v2 ui.callout escapes, ui.calloutHtml renders markup
  const calloutH = (html, tone) => (ui.calloutHtml ? ui.calloutHtml(html, tone) : ui.callout(html, tone));
  const mono = (t) => h('span', { class: 'mono' }, t || '—');
  const lnk = (route, id) => h('a', { class: 'mono', href: '#/' + route + '/' + id }, id);
  const monthKey = (d) => util.iso(d).slice(0, 7);
  // Display formats come from CRM.fmt ("25 Oct 2026", "Oct 2026", "10:30 AM"); local fallbacks use fixed month names (no locale "Sept")
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const parseD = (v) => { if (v instanceof Date) return new Date(v); if (util.parseDate) { const x = util.parseDate(v); if (x) return x; } const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v); };
  const monthText = (d) => { const x = parseD(d); if (isNaN(x)) return '—'; return fmt.month ? fmt.month(x) : MON[x.getMonth()] + ' ' + x.getFullYear(); };
  const timeText = (d) => { if (!d) return '—'; const x = new Date(d); if (isNaN(x)) return '—'; if (fmt.time) return fmt.time(x); const hr = x.getHours(); return (hr % 12 || 12) + ':' + String(x.getMinutes()).padStart(2, '0') + ' ' + (hr >= 12 ? 'PM' : 'AM'); };
  const dayLabel = (d) => { const x = parseD(d); return WDAY[x.getDay()] + ' ' + x.getDate() + ' ' + MON[x.getMonth()]; };
  const monthLabel = (k) => monthText(k + '-01');
  const enqMonth = (d) => monthText(new Date(d));
  const inRange = (d, from, to) => { if (!d) return false; const x = util.iso(d); return x >= from && x <= to; };
  const hrsText = (n) => (n == null || isNaN(n) ? '—' : n < 48 ? (Math.round(n * 10) / 10) + ' h' : (Math.round(n / 24 * 10) / 10) + ' d');
  const stageTone = (s) => (s === 'Order Won' ? 'ok' : s === 'Order Lost' ? 'bad' : s === 'Negotiation' ? 'warn' : s === 'Enquiry Received' ? 'brand' : 'info');
  const stageBadge = (s) => ui.badge(s, stageTone(s));
  const fy = (d) => { const x = new Date(d); const y = x.getMonth() >= 3 ? x.getFullYear() : x.getFullYear() - 1; return String(y % 100).padStart(2, '0') + '-' + String((y + 1) % 100).padStart(2, '0'); };
  const capacityKw = (name, qty) => { const m = /([\d.]+)\s*kW/i.exec(name || ''); return m ? Number(m[1]) * (qty || 1) : null; };
  const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);
  const monthsBack = (n) => { const out = []; for (let i = n - 1; i >= 0; i--) { const d = new Date(CRM.TODAY); d.setDate(1); d.setMonth(d.getMonth() - i); out.push(monthKey(d)); } return out; };
  const monthRange = (k) => { const s = new Date(k + '-01T00:00:00'); const e = new Date(s); e.setMonth(e.getMonth() + 1); e.setDate(0); return [util.iso(s), util.iso(e)]; };
  const categories = (div) => [...new Set(master.products(div).map((p) => p.category))];
  // calendar week (Mon → Sun) containing d
  const weekRange = (d) => { const x = parseD(d); x.setHours(0, 0, 0, 0); const s = util.addDays(x, -((x.getDay() + 6) % 7)); return [util.iso(s), util.iso(util.addDays(s, 6))]; };

  // ---------- configuration (Core API v2 CRM.config with defaults; fallback: salesConfig/CFG record)
  const DEFAULT_GST = { Power: 18, 'Electronic Security': 18, Solar: 12 };
  const SALES_CFG = {
    'sales.sla': { quoteHrs: 24, siteVisitHrs: 24, soHrs: 24, scrapHrs: 24, quoteResponseDays: 3 },
    'sales.escalation': { l2: 6, l3: 12, l4: 24 }, // hours after SLA breach: L2 coordinator, L3 sales head, L4 management (Service_requirement §14)
    'sales.paymentEscalation': { l2: 7, l3: 15, l4: 30 }, // days overdue beyond credit policy
    'sales.reminders': { paymentDueDays: 3, scanMinutes: 5 },
    'sales.discount': { justifyAbovePct: 10 },
    'sales.otsIncentive': { salesPct: null, engineerSharePct: 50 }, // salesPct blank = Service OTS configuration
  };
  function cfg(key) {
    const d = SALES_CFG[key];
    let v = null;
    try { v = CRM.config && CRM.config.get ? CRM.config.get(key, d) : (db.get('salesConfig', 'CFG') || {})[key]; } catch (e) { v = null; }
    return d && typeof d === 'object' ? Object.assign({}, d, v && typeof v === 'object' ? v : {}) : (v == null ? d : v);
  }
  function setCfg(key, val) {
    if (CRM.config && CRM.config.set) { CRM.config.set(key, val); return; }
    if (db.get('salesConfig', 'CFG')) db.update('salesConfig', 'CFG', { [key]: val }, { note: 'Sales settings · ' + key });
    else db.insert('salesConfig', { id: 'CFG', [key]: val }, { note: 'Sales settings · ' + key });
  }
  /** GST % per division — core built-in config 'gst.<Division>' (fallback Power / ES 18 %, Solar 12 %). */
  function gstPct(div) {
    const d = DEFAULT_GST[div] != null ? DEFAULT_GST[div] : 18;
    let v = d;
    try { if (CRM.config && CRM.config.get) v = CRM.config.get('gst.' + div, d); } catch (e) { v = d; }
    v = Number(v);
    return v >= 0 && v < 100 ? v : d;
  }
  const withGst = (value, div) => Math.round((Number(value) || 0) * (1 + gstPct(div) / 100));
  const exGst = (value, div) => Math.round((Number(value) || 0) / (1 + gstPct(div) / 100));

  // ---------- notifications: per-person recipients (Core v2 toUser) and links the recipient's role can open
  const PAGE_ROLES = {};
  function canOpen(link, roleId) {
    const id = String(link || '').replace(/^#\/?/, '').split('/')[0];
    if (!id) return true;
    if (PAGE_ROLES[id]) return PAGE_ROLES[id].includes(roleId);
    if (CRM.canSee && CRM.canSee.length >= 2) { try { return !!CRM.canSee(id, roleId); } catch (e) { return true; } }
    return true;
  }
  /** Notify roles; each role gets the first link it can open (links: candidates in order of preference). */
  // notification event (drives Email / WhatsApp channel settings in Core v2) inferred from the key prefix
  const EVENT_OF = { assign: 'assignment', assignc: 'assignment', unassigned: 'assignment', ots: 'assignment', qappr: 'approval', soappr: 'approval', pol: 'escalation', paydue: 'payment', payv: 'payment', inv: 'payment', toinv: 'payment', srvinv: 'payment', fudue: 'sla', fumiss: 'sla', fumissc: 'sla', qresp: 'sla' };
  function send(roles, n, links) {
    n = Object.assign({ event: EVENT_OF[String(n.key || '').split(':')[0]] || 'general' }, n);
    links = [].concat(links || n.link || []).filter(Boolean);
    const groups = {}, order = [];
    [].concat(roles).forEach((r) => { const l = links.find((x) => canOpen(x, r)) || ''; if (!groups[l]) { groups[l] = []; order.push(l); } groups[l].push(r); });
    order.forEach((l, i) => CRM.notify(Object.assign({}, n, { to: groups[l], link: l, key: n.key && order.length > 1 ? n.key + ':' + i : n.key })));
  }
  /** Person-specific notification (an executive's own lead / quote / order) — never broadcast to every executive. */
  const sendUser = (userId, roles, n, links) => send(roles, Object.assign({}, n, userId ? { toUser: userId, key: n.key ? n.key + ':' + userId : n.key } : {}), links);

  // ---------- receivables
  const paymentsOf = (inv) => db.find('payments', (p) => p.invoiceId === inv.id);
  // Only receipts verified by Accounts reduce the outstanding; field updates stay "pending verification" until then
  const paidOf = (inv) => sum(paymentsOf(inv).filter((p) => p.verified !== false), 'value');
  const pendingOf = (inv) => sum(paymentsOf(inv).filter((p) => p.verified === false), 'value');
  const outstandingOf = (inv) => Math.max(0, Math.round((Number(inv.value) || 0) - paidOf(inv)));
  const collectableOf = (inv) => Math.max(0, outstandingOf(inv) - Math.round(pendingOf(inv)));
  const overdueDays = (inv) => (inv.dueDate ? util.daysBetween(parseD(util.iso(inv.dueDate)), CRM.TODAY) : 0);
  function invStatus(inv) {
    const o = outstandingOf(inv);
    if (o <= 0) return 'Paid';
    if (inv.dueDate && util.iso(inv.dueDate) < todayIso()) return 'Overdue';
    if (inv.dueDate && util.iso(inv.dueDate) === todayIso()) return 'Due Today';
    return paidOf(inv) > 0 ? 'Partial' : 'Unpaid';
  }
  const invTone = (s) => ({ Paid: 'ok', Overdue: 'bad', 'Due Today': 'warn', Partial: 'warn', Unpaid: 'info' }[s] || '');
  const ageBucket = (inv) => { const d = overdueDays(inv); return d <= 0 ? 'Not due' : d <= 30 ? '1-30 days' : d <= 60 ? '31-60 days' : d <= 90 ? '61-90 days' : '90+ days'; };
  const BUCKETS = ['Not due', '1-30 days', '31-60 days', '61-90 days', '90+ days'];
  const BUCKET_COLORS = ['var(--ok)', 'var(--chart-5)', 'var(--warn)', 'var(--chart-3)', 'var(--bad)'];

  // ---------- orders
  const quotesOf = (enqId) => db.find('quotations', (q) => q.enquiryId === enqId);
  const sentQuote = (enqId) => quotesOf(enqId).filter((q) => q.quoteDate && q.status !== 'Rejected').sort((a, b) => (a.quoteDate < b.quoteDate ? 1 : -1))[0];
  const orderOf = (enqId) => db.one('orders', (o) => o.enquiryId === enqId);
  const invoicesOf = (orderId) => db.find('invoices', (i) => i.orderId === orderId);
  function orderStep(o) {
    if (o.approval !== 'Approved') return 0;
    const invs = invoicesOf(o.id);
    if (!invs.length) return 1;
    if (!o.installationCompletionDate) return 2;
    return invs.every((i) => outstandingOf(i) <= 0) ? 5 : 3;
  }
  function orderStatus(o) {
    if (o.approval === 'Awaiting Approval') return 'Pending SO approval';
    if (o.approval === 'Rejected') return 'SO rejected';
    return ['Order Won', 'SO Issued', 'Invoiced', 'Installed', 'Paid', 'Paid'][orderStep(o)] || 'SO Issued';
  }

  // ---------- cycle times (auto-calculated from timestamps)
  const quoteResponseHrs = (q) => { const e = db.get('enquiries', q.enquiryId); return q.quoteDate && e ? util.hoursBetween(e.createdAt, q.quoteDate) : null; };
  const soProcessingHrs = (o) => (o.soIssuedDate && o.wonDate ? util.hoursBetween(o.wonDate, o.soIssuedDate) : null);
  const conversionDays = (o) => { const e = o.enquiryId && db.get('enquiries', o.enquiryId); return e ? Math.max(0, Math.round(util.hoursBetween(e.createdAt, o.wonDate) / 24 * 10) / 10) : null; };
  const avg = (arr) => { const a = arr.filter((x) => x != null && !isNaN(x)); return a.length ? sum(a) / a.length : null; };

  // ---------- CSV helpers (export and data migration)
  const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function downloadCsv(name, header, rows) {
    const csv = [header.map(csvCell).join(',')].concat(rows.map((r) => r.map(csvCell).join(','))).join('\n');
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    ui.toast('Exported ' + rows.length + ' rows to ' + name, 'ok');
  }
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    text = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    const clean = rows.filter((r) => r.some((x) => String(x).trim() !== ''));
    if (!clean.length) return { header: [], records: [] };
    const header = clean[0].map((x) => x.trim());
    return { header, records: clean.slice(1).map((r) => Object.fromEntries(header.map((k, i) => [k, (r[i] || '').trim()]))) };
  }

  // ============================================================ lead assignment automation (Division + Area → Sales Executive)
  const openLoad = (id) => db.find('enquiries', (e) => e.execId === id && OPEN.includes(e.stage)).length;
  function autoAssign(division, area) {
    const list = execs();
    let c = list.filter((s) => s.division === division && s.area === area), rule = 'Division + Area match';
    if (!c.length) { c = list.filter((s) => s.division === division); rule = 'Division match · least open leads'; }
    if (!c.length) { c = list.filter((s) => s.area === area); rule = 'Area match · least open leads'; }
    if (!c.length) { c = list; rule = 'Round-robin · least open leads'; }
    c = c.slice().sort((a, b) => openLoad(a.id) - openLoad(b.id));
    return { exec: c[0], rule };
  }

  // ============================================================ duplicate check against the customer master
  function findDuplicateCustomer(v) {
    const ph = digits(v.contactNumber || v.phone), nm = String(v.accountName || v.name || '').trim().toLowerCase(), em = String(v.email || '').trim().toLowerCase();
    return master.customers().find((c) => (ph.length >= 10 && digits(c.phone) === ph) || (em && String(c.email || '').toLowerCase() === em) || (nm.length > 3 && c.name.toLowerCase() === nm)) || null;
  }
  function findOpenEnquiry(v) {
    const ph = digits(v.contactNumber);
    return db.one('enquiries', (e) => OPEN.includes(e.stage) && e.division === v.division && ((v.customerId && e.customerId === v.customerId) || (ph.length >= 10 && digits(e.contactNumber) === ph)));
  }

  // ============================================================ communications log (WhatsApp / Email stubs)
  function logComm(enqId, channel, to, text) {
    const e = enqId && db.get('enquiries', enqId);
    if (!e) return;
    db.update('enquiries', e.id, { comms: (e.comms || []).concat([{ at: nowIso(), channel, to, text, by: CRM.user().name }]) }, { note: channel + ' sent to ' + to });
  }
  // Brand voice: real names, short and clear, bilingual (English + Tamil), signed "Team Maruthi".
  function waEnquiryText(e) {
    const name = e.contactName || 'there';
    return 'Hello ' + name + ', thanks for your enquiry (' + e.id + ') for ' + e.product + '. ' + (e.execId ? execName(e.execId) + ' from Maruthi' : 'Our team') + ' will call you shortly. — Team Maruthi'
      + '\n\nவணக்கம் ' + name + ', உங்கள் ' + e.product + ' விசாரணை (' + e.id + ') பெறப்பட்டது. மாருதி குழு விரைவில் உங்களை தொடர்பு கொள்ளும். — மாருதி குழு';
  }
  function sendWhatsApp(enqId, phone, text) {
    const p = digits(phone);
    window.open('https://wa.me/91' + p + '?text=' + encodeURIComponent(text), '_blank');
    logComm(enqId, 'WhatsApp', phone, text);
    ui.toast('WhatsApp opened and logged on ' + (enqId || 'record'), 'ok');
  }
  function sendEmail(enqId, email, subject, text) {
    if (!email) { ui.toast('No email address on record', 'bad'); return; }
    const a = h('a', { href: 'mailto:' + email + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(text) });
    a.click();
    logComm(enqId, 'Email', email, subject + ' — ' + text);
    ui.toast('Email draft opened and logged', 'ok');
  }
  function commButtons(e, text, subject) {
    if (!canWork()) return [];
    return [
      ui.btn('💬 WhatsApp', () => sendWhatsApp(e.id, e.contactNumber, text || waEnquiryText(e)), 'sm'),
      ui.btn('✉ Email', () => sendEmail(e.id, e.email, subject || ('Maruthi Power – ' + e.id), text || ('Dear ' + (e.contactName || 'Sir/Madam') + ',\n\nThank you for your enquiry for ' + e.product + '.\n\nRegards,\n' + CRM.user().name + '\nMaruthi Power Control Systems')), 'sm'),
    ];
  }

  // ============================================================ enquiry lifecycle
  function createEnquiry(v, opts) {
    opts = opts || {};
    const prod = master.product(v.productId) || {};
    let execId = v.execId, rule = v.execId ? 'Manual assignment' : '';
    if (!execId && !opts.unassigned) {
      if (isExec()) { execId = me(); rule = 'Self-created by executive'; } else { const a = autoAssign(v.division, v.area); execId = a.exec ? a.exec.id : ''; rule = a.rule; }
    }
    const cust = v.customerId && master.customer(v.customerId);
    const created = opts.createdAt || nowIso();
    const e = db.insert('enquiries', Object.assign({}, v, {
      date: util.iso(created), month: enqMonth(created), createdAt: created,
      accountName: cust ? cust.name : v.accountName, customerType: v.customerType || (cust ? cust.type : 'New Customer'),
      businessType: cust && cust.type !== 'New Customer' ? 'Existing Customer Business' : 'New Customer Business',
      product: prod.name || v.product || '', category: prod.category || v.category || '', quantity: Number(v.quantity) || 1,
      expectedValue: Number(v.expectedValue) || (prod.price || 0) * (Number(v.quantity) || 1),
      execId: execId || '', assignRule: rule, assignedAt: execId ? created : '', stage: opts.stage || 'Enquiry Received',
      callStatus: v.callStatus || '', progressNotes: v.progressNotes || '', followUpStatus: 'Pending', comms: [],
      isNewCustomer: !cust || cust.type === 'New Customer', siteVisitRequired: v.siteVisitRequired != null ? !!v.siteVisitRequired : v.division !== 'Power',
      stageHistory: [{ stage: opts.stage || 'Enquiry Received', at: created, by: CRM.user().name, note: 'Enquiry created via ' + (v.salesChannel || 'CRM') }],
    }), { prefix: 'ENQ', note: 'Enquiry created' + (rule ? ' · ' + rule : '') });
    if (e.otsId) CRM.emit('ots.converted', { otsId: e.otsId, enquiryId: e.id, execId: e.execId || '' });
    if (opts.quiet) return e;
    if (v.nextFollowUp) scheduleFollowUp(e, v.nextFollowUp, 'Call', 'First contact with customer', true);
    if (execId) {
      if (execId !== me()) sendUser(execId, ['sales_exec'], { title: 'New lead ' + e.id + ' assigned to you', body: e.accountName + ' · ' + e.division + ' · ' + e.product + ' (' + rule + ')', link: '#/enquiries/' + e.id, severity: 'info', key: 'assign:' + e.id + ':' + execId });
      send(['sales_coordinator'], { title: 'Lead ' + e.id + ' assigned to ' + execName(execId), body: e.accountName + ' · ' + e.division + ' · ' + e.product + ' (' + rule + ')', link: '#/enquiries/' + e.id, severity: 'info', key: 'assignc:' + e.id + ':' + execId });
    } else send(['sales_coordinator', 'sales_manager'], { title: 'Lead awaiting assignment: ' + e.id, body: e.accountName + ' · ' + e.division, link: '#/enquiries', severity: 'warn', key: 'unassigned:' + e.id });
    return e;
  }

  function assignEnquiry(e, execId, rule) {
    db.update('enquiries', e.id, { execId, assignRule: rule || 'Manual assignment by ' + CRM.role().name, assignedAt: nowIso(), assignedBy: CRM.user().name }, { note: 'Assigned to ' + execName(execId) });
    db.find('followups', (f) => f.enquiryId === e.id && f.status === 'Planned').forEach((f) => db.update('followups', f.id, { execId }, { silent: true }));
    sendUser(execId, ['sales_exec'], { title: 'Lead ' + e.id + ' assigned to you', body: e.accountName + ' · ' + e.product + (e.otsId ? ' · Sales OTS ' + e.otsId : ''), link: '#/enquiries/' + e.id, key: 'assign:' + e.id + ':' + execId });
    if (e.otsId) CRM.emit('ots.converted', { otsId: e.otsId, enquiryId: e.id, execId });
  }

  function scheduleFollowUp(e, due, type, purpose, silent) {
    return db.insert('followups', { enquiryId: e.id, customerId: e.customerId || '', accountName: e.accountName, execId: e.execId, division: e.division, dueDate: util.iso(due), type: type || 'Call', purpose: purpose || 'Follow-up', status: 'Planned' }, { prefix: 'FUP', silent: !!silent });
  }

  /** Gate rules for moving an enquiry along the 8-stage pipeline. Returns an error string or null. */
  function stageGate(e, to) {
    if (e.stage === to) return 'Already in ' + to;
    if (e.stage === 'Order Won') return 'Order already won — further changes go through the Sales Order (' + ((orderOf(e.id) || {}).id || 'SO') + ').';
    if (e.stage === 'Order Lost' && !isMgr()) return 'Only the Sales Manager can reopen a lost enquiry.';
    if (!e.execId) return 'Assign a Sales Executive before progressing this lead.';
    const q = sentQuote(e.id) || (e.stage === 'Order Lost' ? lostQuote(e.id) : null);
    if ((to === 'Quotation Sent' || to === 'Negotiation') && !q) return 'Gate: a quotation approved by the Sales Manager must be sent before moving to "' + to + '".';
    if (to === 'Order Won' && !q) return 'Gate: Order Won needs a sent quotation (Sales Manager approved).';
    if (to === 'Site Visit Completed' && !e.siteVisitDate && STAGES.indexOf(e.stage) < 2) return null; // date captured in the modal
    return null;
  }

  // the quotation that was marked Rejected when the enquiry was lost — restored when the Sales Manager reopens the lead
  const lostQuote = (enqId) => quotesOf(enqId).filter((q) => q.quoteDate && q.status === 'Rejected' && q.approval === 'Approved').sort((a, b) => (a.quoteDate < b.quoteDate ? 1 : -1))[0] || null;
  const otsStatusFor = (stage) => ({ 'Quotation Sent': 'Quotation Sent', Negotiation: 'Negotiation', 'Order Won': 'Won', 'Order Lost': 'Lost' }[stage] || '');
  function otsOutcome(e, stage, extra) {
    const status = otsStatusFor(stage);
    if (!e || !e.otsId || !status) return;
    const x = Object.assign({ otsId: e.otsId, enquiryId: e.id, status, closedBy: e.execId || '', by: e.execId || '', at: nowIso() }, extra || {});
    if (x.lostReason) x.reason = x.lostReason; // service.js reads p.reason / p.by
    CRM.emit('ots.outcome', x);
  }
  function moveStage(e, to, onDone) {
    const err = stageGate(e, to);
    if (err) { ui.toast(err, 'bad'); return; }
    const reopening = e.stage === 'Order Lost';
    const q = sentQuote(e.id) || (reopening ? lostQuote(e.id) : null);
    const tomorrow = util.iso(util.addDays(CRM.TODAY, 1));
    const fields = [
      { type: 'section', label: e.stage + ' → ' + to },
      { key: 'callStatus', label: 'Call status', type: 'select', options: CALL_STATUS, required: to === 'Contact Made' },
      { key: 'followUpStatus', label: 'Follow-up status', type: 'select', options: FU_STATUS, default: 'Completed' },
    ];
    if (to === 'Site Visit Scheduled') fields.push({ key: 'siteVisitDate', label: 'Site visit date', type: 'date', required: true, default: tomorrow });
    if (to === 'Site Visit Completed') fields.push({ key: 'siteVisitDate', label: 'Site visit date (completed)', type: 'date', required: true, default: todayIso() });
    if (to === 'Order Won') {
      fields.push(
        { type: 'section', label: 'Order won details (mandatory)' },
        { key: 'wonDate', label: 'Order won date (auto)', type: 'readonly', default: fmt.date(new Date()) },
        { key: 'poNumber', label: 'Customer PO number', required: true, placeholder: 'e.g. PO/KGH/2026/114' },
        { key: 'orderValue', label: 'Order value (₹, ex-GST)', type: 'number', required: true, default: q ? q.basicValue : e.expectedValue },
        { key: 'materialAvailability', label: 'Material availability', type: 'select', options: MATERIAL, required: true },
        { key: 'deliveryCommitDate', label: 'Delivery commitment date', type: 'date', required: true, default: (q && q.deliveryCommitment) || util.iso(util.addDays(CRM.TODAY, 7)) },
        { key: 'paymentTerms', label: 'Payment terms', type: 'select', options: Object.keys(PAY_TERMS), required: true, default: (q && q.paymentTerms) || 'Credit 30 days' },
        { key: 'wonDetails', label: 'Won details (why we won, commitments made)', type: 'textarea', required: true });
    } else if (to === 'Order Lost') {
      fields.push(
        { type: 'section', label: 'Order lost — reason is mandatory' },
        { key: 'lostReason', label: 'Lost reason', type: 'select', options: LOST_REASONS, required: true },
        { key: 'competitor', label: 'Competitor (if any)' },
        { key: 'lostDetails', label: 'Lost details', type: 'textarea', required: true });
    } else {
      fields.push({ key: 'nextFollowUp', label: 'Next follow-up date', type: 'date', required: true, default: tomorrow });
    }
    fields.push({ key: 'progressNotes', label: 'Progress notes', type: 'textarea', required: true, default: '' });
    ui.formModal('Move ' + e.id + ' to "' + to + '"', fields, {}, (v) => {
      const at = nowIso();
      const patch = { stage: to, callStatus: v.callStatus || e.callStatus, progressNotes: v.progressNotes, followUpStatus: v.followUpStatus || 'Completed', stageHistory: (e.stageHistory || []).concat([{ stage: to, at, by: CRM.user().name, note: v.progressNotes }]) };
      if (to === 'Contact Made' && !e.contactMadeAt) patch.contactMadeAt = at;
      if (v.siteVisitDate) patch.siteVisitDate = v.siteVisitDate;
      if (to === 'Site Visit Completed') patch.siteVisitDoneAt = at;
      if (v.nextFollowUp) patch.nextFollowUp = v.nextFollowUp;
      if (to === 'Order Lost') Object.assign(patch, { lostReason: v.lostReason, competitor: v.competitor, lostDetails: v.lostDetails, closedAt: at, nextFollowUp: '' });
      if (to === 'Order Won') Object.assign(patch, { wonDetails: v.wonDetails, closedAt: at, nextFollowUp: '' });
      if (reopening) Object.assign(patch, { closedAt: '', reopenedAt: at, reopenedBy: CRM.user().name, followUpStatus: 'Pending' });
      if (reopening && q && q.status === 'Rejected') db.update('quotations', q.id, { status: to === 'Negotiation' ? 'Under Discussion' : 'Sent', customerRemarks: '' }, { note: 'Quotation restored — enquiry reopened by Sales Manager' });
      // close open follow-ups of this enquiry and schedule the next one
      db.find('followups', (f) => f.enquiryId === e.id && f.status === 'Planned').forEach((f) => db.update('followups', f.id, { status: 'Completed', completedAt: at, outcome: 'Stage moved to ' + to }, { silent: true }));
      db.update('enquiries', e.id, patch, { note: 'Stage ' + e.stage + ' → ' + to });
      if (v.nextFollowUp) scheduleFollowUp(db.get('enquiries', e.id), v.nextFollowUp, to === 'Site Visit Scheduled' ? 'Site Visit' : 'Call', 'After "' + to + '"');
      if (to === 'Order Won') createOrderFromWin(db.get('enquiries', e.id), v, q);
      if (to === 'Order Lost' && q && q.status !== 'Rejected') db.update('quotations', q.id, { status: 'Rejected', customerRemarks: v.lostReason }, { note: 'Quotation rejected (order lost)' });
      if (to === 'Negotiation' && q && q.status === 'Sent') db.update('quotations', q.id, { status: 'Under Discussion' }, { note: 'Under discussion' });
      if (to === 'Order Lost') otsOutcome(e, to, { lostReason: v.lostReason });
      else if (to !== 'Order Won') otsOutcome(e, to, { quoteId: q ? q.id : '', reopened: reopening || undefined });
      ui.toast(e.id + ' moved to ' + to, to === 'Order Lost' ? 'warn' : 'ok');
      (onDone || CRM.refresh)();
    }, { sub: e.accountName + ' · ' + e.product, saveLabel: 'Move to ' + to });
  }

  // ============================================================ quotations
  /** Basic value, GST (per-division rate from configuration) and quote value net of scrap buy-back. */
  function computeQuote(lines, discountPct, scrapValue, division) {
    const gross = sum(lines, (l) => (Number(l.qty) || 0) * (Number(l.rate) || 0));
    const basicValue = Math.round(gross * (1 - (Number(discountPct) || 0) / 100));
    const gstRate = gstPct(division);
    const gst = Math.round(basicValue * gstRate / 100);
    return { gross, basicValue, gstPct: gstRate, gst, quoteValue: basicValue + gst - (Number(scrapValue) || 0) };
  }
  const quoteGstPct = (q) => (q && q.gstPct != null ? q.gstPct : gstPct(q && q.division));
  function submitQuote(q) {
    // Sales Manager approves every quotation before it is given to the customer
    if (isMgr()) { approveQuote(q, 'Self-approved by Sales Manager'); return; }
    send(['sales_manager'], { title: 'Quotation ' + q.id + ' awaiting your approval', body: q.accountName + ' · ' + fmt.money(q.quoteValue) + (q.discountPct > 5 ? ' · discount ' + q.discountPct + '%' : ''), link: '#/quotations/' + q.id, severity: 'warn', key: 'qappr:' + q.id + ':' + (q.revision || 0) });
  }
  function approveQuote(q, remarks) {
    const at = nowIso();
    db.update('quotations', q.id, { approval: 'Approved', approvedBy: CRM.user().name, approvedAt: at, approvalRemarks: remarks || '', status: 'Sent', quoteDate: at }, { note: 'Quotation approved by Sales Manager and sent (quote given date auto-set)' });
    const e = db.get('enquiries', q.enquiryId);
    if (e && STAGES.indexOf(e.stage) < 4) { db.update('enquiries', e.id, { stage: 'Quotation Sent', stageHistory: (e.stageHistory || []).concat([{ stage: 'Quotation Sent', at, by: 'System', note: 'Quotation ' + q.id + ' approved & sent' }]) }, { note: 'Stage → Quotation Sent (quotation approved)' }); otsOutcome(e, 'Quotation Sent', { quoteId: q.id, quoteValue: q.quoteValue }); }
    if (q.execId !== me()) sendUser(q.execId, ['sales_exec'], { title: 'Quotation ' + q.id + ' approved', body: q.accountName + ' · response time ' + hrsText(quoteResponseHrs(db.get('quotations', q.id))), link: '#/quotations/' + q.id, severity: 'ok', key: 'qok:' + q.id + ':' + (q.revision || 0) });
  }
  function rejectQuote(q) {
    ui.formModal('Reject quotation ' + q.id, [{ key: 'remarks', label: 'Reason / revision required', type: 'textarea', required: true }], {}, (v) => {
      db.update('quotations', q.id, { approval: 'Rejected', approvalRemarks: v.remarks, approvedBy: CRM.user().name, approvedAt: nowIso(), status: 'Pending' }, { note: 'Quotation rejected by Sales Manager: ' + v.remarks });
      sendUser(q.execId, ['sales_exec'], { title: 'Quotation ' + q.id + ' sent back for revision', body: v.remarks, link: '#/quotations/' + q.id, severity: 'warn', key: 'qrej:' + q.id + ':' + (q.revision || 0) });
      ui.toast('Quotation returned to executive', 'warn'); CRM.refresh();
    });
  }
  function setQuoteStatus(q, status) {
    const patch = { status };
    if (status === 'Approved') patch.customerApprovedAt = nowIso();
    db.update('quotations', q.id, patch, { note: 'Customer status → ' + status });
    const e = db.get('enquiries', q.enquiryId);
    if (e && status === 'Under Discussion' && STAGES.indexOf(e.stage) < 5) { db.update('enquiries', e.id, { stage: 'Negotiation', stageHistory: (e.stageHistory || []).concat([{ stage: 'Negotiation', at: nowIso(), by: CRM.user().name, note: 'Quotation under discussion' }]) }); otsOutcome(e, 'Negotiation', { quoteId: q.id }); }
    ui.toast('Quotation marked ' + status, status === 'Rejected' ? 'warn' : 'ok');
    if (status === 'Approved' && e && OPEN.includes(e.stage)) {
      ui.confirm('Customer approved the quotation', 'Convert ' + e.id + ' to Order Won now? A Sales Order must be issued within ' + SLA.soHrs + ' hours of customer approval (policy 4.3).', () => { setTimeout(() => moveStage(db.get('enquiries', e.id), 'Order Won'), 50); });
    } else if (status === 'Rejected' && e && OPEN.includes(e.stage)) {
      ui.confirm('Customer rejected the quotation', 'Mark ' + e.id + ' as Order Lost?', () => { setTimeout(() => moveStage(db.get('enquiries', e.id), 'Order Lost'), 50); });
    } else CRM.refresh();
  }

  // ============================================================ orders
  const nextCustomerId = () => 'CUS-' + (Math.max(1000, ...master.customers().map((c) => Number(String(c.id).replace(/\D/g, '')) || 0)) + 1);
  function ensureCustomer(e) {
    if (e.customerId && master.customer(e.customerId)) return e.customerId;
    const dup = findDuplicateCustomer(e);
    if (dup) { db.update('enquiries', e.id, { customerId: dup.id }, { silent: true }); return dup.id; }
    const c = db.insert('customers', { id: nextCustomerId(), name: e.accountName, type: 'New Customer', contact: e.contactName, phone: e.contactNumber, email: e.email, area: e.area, segment: e.segment || 'Commercial', since: todayIso(), source: 'Converted from ' + e.id }, { prefix: 'CUS', note: 'Prospect converted to customer on order win' });
    db.insert('sites', { customerId: c.id, name: 'Main Site', address: e.area + ', Coimbatore', contact: e.contactName, phone: e.contactNumber, access: 'Reception' }, { silent: true });
    db.update('enquiries', e.id, { customerId: c.id }, { silent: true });
    return c.id;
  }
  function divisionExtras(division, productId, qty, lines) {
    const p = master.product(productId) || {};
    const out = {};
    if (division === 'Electronic Security') {
      const cams = (lines || [{ productId, qty }]).filter((l) => /camera/i.test((master.product(l.productId) || {}).name || '')).reduce((s, l) => s + (Number(l.qty) || 0), 0);
      if (cams || p.category === 'CCTV') out.cameraCount = cams || qty;
    }
    if (division === 'Solar') { out.systemType = p.category === 'Hybrid' ? 'Hybrid' : 'On-grid'; out.capacityKw = capacityKw(p.name, qty) || Math.round((qty || 1) * 0.54 * 10) / 10; }
    return out;
  }
  function createOrderFromWin(e, v, q) {
    const customerId = ensureCustomer(e);
    if (q && q.status !== 'Approved') db.update('quotations', q.id, { status: 'Approved', customerApprovedAt: q.customerApprovedAt || nowIso() }, { note: 'Customer approved (order won)' });
    const o = db.insert('orders', Object.assign({
      enquiryId: e.id, quotationId: q ? q.id : '', customerId, accountName: e.accountName, division: e.division, execId: e.execId,
      productId: e.productId, product: e.product, quantity: e.quantity, value: Number(v.orderValue) || e.expectedValue, wonDate: nowIso(),
      poNumber: v.poNumber, materialAvailability: v.materialAvailability, deliveryCommitDate: v.deliveryCommitDate, paymentTerms: v.paymentTerms, creditDays: PAY_TERMS[v.paymentTerms] || 0,
      approval: 'Awaiting Approval', soNumber: '', soIssuedDate: '', warrantyContract: q ? q.warrantyContract : '', newCustomer: isNewCustomerId(customerId), salesChannel: e.salesChannel, leadSource: e.leadSource || '', dealerId: e.dealerId || '', otsId: e.otsId || '',
      scrapApplicable: q ? q.scrapApplicable === 'Yes' : false, scrapType: q ? q.scrapType : '', scrapQty: q ? q.scrapQty : 0, scrapCollected: false,
      installationStatus: 'Pending', installationCompletionDate: '', deliveredDate: '',
    }, divisionExtras(e.division, e.productId, e.quantity, q && q.lines)), { prefix: 'ORD', note: 'Order won from ' + e.id });
    send(['sales_manager'], { title: 'Sale order ' + o.id + ' awaiting approval', body: e.accountName + ' · ' + fmt.money(o.value) + ' · PO ' + o.poNumber, link: '#/orders/' + o.id, severity: 'warn', key: 'soappr:' + o.id });
    otsOutcome(e, 'Order Won', { orderId: o.id, revenue: o.value, quoteId: q ? q.id : '' });
    return o;
  }
  // New-customer acquisition: a customer is "new" until their first approved sale order; then promoted to Existing Customer
  const isNewCustomerId = (id) => { const c = id && master.customer(id); return !!c && c.type === 'New Customer' && !db.one('orders', (o) => o.customerId === id && o.approval === 'Approved'); };
  function promoteCustomer(customerId) {
    const c = customerId && master.customer(customerId);
    if (!c || c.type !== 'New Customer') return;
    if (master.updateCustomer) master.updateCustomer(c.id, { type: 'Existing Customer' });
    else db.update('customers', c.id, { type: 'Existing Customer', promotedAt: nowIso() }, { note: 'Customer type New → Existing (first sale order approved)' });
  }
  /** Distinct customers acquired: first approved order of a customer (flagged new at win time) falls in the period. */
  function acquisitions(from, to, match) {
    const first = {};
    db.all('orders').filter((o) => o.approval === 'Approved' && o.customerId).forEach((o) => { const f = first[o.customerId]; if (!f || o.wonDate < f.wonDate) first[o.customerId] = o; });
    return Object.values(first).filter((o) => o.newCustomer && inRange(o.wonDate, from, to) && (!match || match(o)));
  }
  function approveSO(o) {
    const at = nowIso();
    const seq = CRM.nextId('SONO').split('-')[1];
    const soNumber = 'SO/' + fy(at) + '/' + seq;
    db.update('orders', o.id, { approval: 'Approved', soNumber, soIssuedDate: at, approvedBy: CRM.user().name, approvedAt: at }, { note: 'Sale order approved · ' + soNumber + ' issued' });
    const order = db.get('orders', o.id);
    const enquiry = order.enquiryId ? db.get('enquiries', order.enquiryId) : null;
    CRM.emit('order.won', { order, enquiry });
    promoteCustomer(order.customerId);
    send(['accounts'], { title: 'Raise invoice for ' + soNumber, body: order.accountName + ' · ' + fmt.money(order.value) + ' + GST ' + gstPct(order.division) + '% · ' + order.paymentTerms, link: '#/invoices', severity: 'info', key: 'toinv:' + o.id });
    sendUser(order.execId, ['sales_exec'], { title: soNumber + ' approved', body: order.accountName + ' · SO processing ' + hrsText(soProcessingHrs(order)), link: '#/orders/' + o.id, severity: 'ok', key: 'sook:' + o.id });
    suggestUpsells(order, true);
    ui.toast(soNumber + ' issued · order handed over' + (order.division === 'Power' ? ' to Service (warranty & PM)' : ' to Projects'), 'ok');
  }
  function rejectSO(o) {
    ui.formModal('Reject sale order ' + o.id, [{ key: 'remarks', label: 'Reason', type: 'textarea', required: true }], {}, (v) => {
      db.update('orders', o.id, { approval: 'Rejected', approvalRemarks: v.remarks, approvedBy: CRM.user().name, approvedAt: nowIso() }, { note: 'SO rejected: ' + v.remarks });
      sendUser(o.execId, ['sales_exec'], { title: 'Sale order ' + o.id + ' rejected', body: v.remarks, link: '#/orders/' + o.id, severity: 'bad', key: 'sorej:' + o.id + ':' + Date.now() });
      ui.toast('Sale order rejected', 'warn'); CRM.refresh();
    });
  }

  // ============================================================ upsell / cross-sell automation
  function suggestUpsells(order, notify) {
    const p = master.product(order.productId) || {};
    const key = p.category === 'On-grid' ? 'On-grid' : p.category;
    const created = [];
    UPSELL_RULES.filter((r) => r.when === key).forEach((r) => {
      if (db.one('upsells', (u) => u.orderId === order.id && u.offerCategory === r.offer)) return;
      const cand = db.find('products', (x) => x.category === r.offer && x.id !== p.id).sort((a, b) => a.price - b.price);
      const offer = r.type === 'Upsell' ? (cand.find((x) => x.price > (p.price || 0)) || cand[cand.length - 1]) : cand[Math.min(1, cand.length - 1)];
      if (!offer) return;
      const qty = r.offer === 'Battery' ? Math.max(2, Math.min(16, Number(order.quantity) * 2)) : 1;
      created.push(db.insert('upsells', { customerId: order.customerId, accountName: order.accountName, orderId: order.id, baseProduct: order.product, type: r.type, offerCategory: r.offer, productId: offer.id, product: offer.name, quantity: qty, value: offer.price * qty, execId: order.execId, division: offer.division, status: 'Suggested', date: todayIso(), rationale: r.why, auto: true }, { prefix: 'UPS', silent: !notify }));
    });
    if (notify && created.length) sendUser(order.execId, ['sales_exec'], { title: created.length + ' upsell / cross-sell suggestions for ' + order.accountName, body: created.map((u) => u.type + ': ' + u.product).join(' · '), link: '#/upsell', severity: 'info', key: 'ups:' + order.id });
    if (notify && created.length) send(['sales_coordinator'], { title: created.length + ' upsell / cross-sell suggestions for ' + order.accountName, body: 'Owner ' + execName(order.execId), link: '#/upsell', severity: 'info', key: 'upsc:' + order.id });
    return created;
  }

  // ============================================================ invoices & payments (Accounts)
  /** Default invoice value: order value + division GST, less scrap buy-back agreed on the quotation (= quote value when unchanged). */
  function invoiceDefault(o) {
    const q = o.quotationId && db.get('quotations', o.quotationId);
    if (q && Number(q.basicValue) === Number(o.value) && q.quoteValue) return Math.round(q.quoteValue);
    return withGst(o.value, o.division) - Math.round(Number(q && q.scrapValue) || 0);
  }
  function raiseInvoice(o, existing) {
    const q = o.quotationId && db.get('quotations', o.quotationId);
    const terms = (existing && existing.paymentTerms) || o.paymentTerms || 'Credit 30 days';
    const fields = [
      { key: 'invoiceNo', label: 'Invoice number', type: 'readonly' },
      { key: 'invoiceDate', label: 'Invoice date', type: 'date', required: true, onChange: (val, inp) => { if (val) inp.dueDate.value = util.iso(util.addDays(parseD(val), PAY_TERMS[inp.paymentTerms.value] || 0)); } },
      { key: 'value', label: 'Invoice value (₹ incl. GST ' + gstPct(o.division) + '%' + (q && Number(q.scrapValue) ? ', net of scrap buy-back' : '') + ')', type: 'number', required: true },
      { key: 'paymentTerms', label: 'Payment terms', type: 'select', options: Object.keys(PAY_TERMS), required: true, onChange: (val, inp) => { inp.dueDate.value = util.iso(util.addDays(inp.invoiceDate.value ? parseD(inp.invoiceDate.value) : CRM.TODAY, PAY_TERMS[val] || 0)); } },
      { key: 'dueDate', label: 'Payment due date (auto from terms)', type: 'date', required: true },
      { key: 'confirmedWith', label: 'Confirmed with (customer contact)' },
      { key: 'hardCopySubmitted', label: 'Invoice hard copy submitted', type: 'checkbox' },
      { key: 'invoiceMailed', label: 'Invoice mailed to customer', type: 'checkbox' },
      { key: 'remarks', label: 'Remarks', type: 'textarea' },
    ];
    const invDate = existing ? existing.invoiceDate : todayIso();
    const vals = existing ? Object.assign({}, existing) : { invoiceNo: '(auto on save)', invoiceDate: invDate, value: invoiceDefault(o), paymentTerms: terms, dueDate: util.iso(util.addDays(parseD(invDate), PAY_TERMS[terms] || 0)), confirmedWith: (master.customer(o.customerId) || {}).contact || '' };
    ui.formModal(existing ? 'Update invoice ' + existing.invoiceNo : 'Raise invoice · ' + (o.soNumber || o.id), fields, vals, (v) => {
      delete v.invoiceNo;
      if (v.dueDate && v.invoiceDate && v.dueDate < v.invoiceDate) { ui.toast('Payment due date cannot be before the invoice date', 'bad'); return false; }
      if (!(v.value > 0)) { ui.toast('Invoice value must be greater than zero', 'bad'); return false; }
      if (existing) { db.update('invoices', existing.id, v, { note: 'Invoice updated by Accounts' }); ui.toast('Invoice updated', 'ok'); CRM.refresh(); return; }
      const seq = CRM.nextId('INVNO').split('-')[1];
      const inv = db.insert('invoices', Object.assign(v, { invoiceNo: 'MPCS/' + fy(parseD(v.invoiceDate)) + '/INV-' + seq, orderId: o.id, soNumber: o.soNumber, customerId: o.customerId, accountName: o.accountName, division: o.division, execId: o.execId, gstPct: gstPct(o.division), scrapValue: q ? Number(q.scrapValue) || 0 : 0, source: 'Sales' }), { prefix: 'INV', note: 'Invoice raised' });
      CRM.emit('invoice.raised', { invoice: inv });
      const nb = { title: 'Invoice ' + inv.invoiceNo + ' raised', body: inv.accountName + ' · ' + fmt.money(inv.value) + ' · due ' + fmt.date(inv.dueDate), severity: 'info', key: 'inv:' + inv.id };
      sendUser(inv.execId, ['sales_exec'], nb, ['#/orders/' + o.id]);
      send(['sales_manager'], nb, ['#/payments']);
      ui.toast('Invoice ' + inv.invoiceNo + ' raised', 'ok'); CRM.refresh();
    }, { sub: o.accountName + ' · order value ' + fmt.money(o.value) + ' + GST' });
  }
  function recordPayment(inv, opts) {
    opts = opts || {};
    const list = inv ? [inv] : allInvoices().filter((i) => collectableOf(i) > 0);
    if (!list.length) { ui.toast('No invoices with outstanding balance', 'warn'); return; }
    const fields = [
      { key: 'invoiceId', label: 'Invoice', type: 'select', required: true, options: list.map((i) => ({ value: i.id, label: i.invoiceNo + ' · ' + i.accountName + ' · O/S ' + fmt.money(outstandingOf(i)) + (pendingOf(i) ? ' (' + fmt.money(pendingOf(i)) + ' awaiting verification)' : '') })), onChange: (val, inp) => { const x = db.get('invoices', val); if (x) inp.value.value = collectableOf(x); } },
      { key: 'receivedDate', label: 'Payment received date', type: 'date', required: true, default: todayIso() },
      { key: 'value', label: 'Received value (₹)', type: 'number', required: true },
      { key: 'mode', label: 'Payment mode', type: 'select', options: PAY_MODES, required: true },
      { key: 'reference', label: 'Reference (UTR / cheque no.)' },
      { key: 'confirmedWith', label: 'Confirmed with' },
    ];
    ui.formModal(opts.title || 'Record payment received', fields, { invoiceId: list[0].id, value: collectableOf(list[0]) }, (v) => {
      const i = db.get('invoices', v.invoiceId);
      const os = collectableOf(i);
      if (!(v.value > 0)) { ui.toast('Received value must be greater than zero', 'bad'); return false; }
      if (v.value > os) { ui.toast('Received value exceeds outstanding of ' + fmt.money(os) + (pendingOf(i) ? ' (after ' + fmt.money(pendingOf(i)) + ' awaiting verification)' : ''), 'bad'); return false; }
      const verified = isAcc();
      db.insert('payments', { invoiceId: i.id, orderId: i.orderId, customerId: i.customerId, accountName: i.accountName, division: i.division, execId: i.execId, receivedDate: v.receivedDate, value: v.value, mode: v.mode, reference: v.reference, confirmedWith: v.confirmedWith, recordedBy: CRM.user().name, verified, onTime: !i.dueDate || v.receivedDate <= util.iso(i.dueDate) }, { prefix: 'PAY', note: 'Payment ' + fmt.money(v.value) + ' via ' + v.mode });
      if (v.confirmedWith) db.update('invoices', i.id, { confirmedWith: v.confirmedWith }, { silent: true });
      if (!verified) send(['accounts'], { title: 'Payment update from field: ' + i.invoiceNo, body: fmt.money(v.value) + ' via ' + v.mode + ' — please verify', link: '#/payments', severity: 'info', key: 'payv:' + i.id + ':' + Date.now() });
      ui.toast('Payment of ' + fmt.money(v.value) + ' recorded' + (verified ? ' · outstanding ' + fmt.money(outstandingOf(i)) : ' · outstanding updates once Accounts verifies it'), 'ok');
      (opts.onDone || CRM.refresh)();
    });
  }

  // ============================================================ policy monitor (Sales & Installation violations, escalation matrix)
  // Escalation ladder (Service_requirement §2/§14): breach → L1 executive · +6 h L2 coordinator · +12 h L3 sales head · +24 h L4 management (configurable)
  const LEVELS = [null, { label: 'L1 · Executive', to: ['sales_exec'] }, { label: 'L2 · Sales Coordinator', to: ['sales_coordinator'] }, { label: 'L3 · Sales Head', to: ['sales_manager'] }, { label: 'L4 · Management', to: ['gm', 'odm'] }];
  function policyBreaches() {
    const now = new Date();
    const out = [];
    const esc = cfg('sales.escalation'), pesc = cfg('sales.paymentEscalation');
    const lvl = (over) => (over < esc.l2 ? 1 : over < esc.l3 ? 2 : over < esc.l4 ? 3 : 4);
    const payLvl = (days) => (days < pesc.l2 ? 1 : days < pesc.l3 ? 2 : days < pesc.l4 ? 3 : 4); // payment delays escalate on a day-based ladder
    db.all('enquiries').forEach((e) => {
      if (!OPEN.includes(e.stage)) return;
      const age = util.hoursBetween(e.createdAt, now);
      if (age > SLA.quoteHrs && !sentQuote(e.id) && STAGES.indexOf(e.stage) < 4) out.push({ type: 'Quotation Delay', ref: 'Sales 4.1', severity: 'Low', rec: e, col: 'enquiries', link: '#/enquiries/' + e.id, owner: e.execId, division: e.division, over: age - SLA.quoteHrs, details: 'Enquiry ' + e.id + ' (' + e.accountName + ') has no quotation ' + hrsText(age) + ' after creation (SLA 24 h)' });
      if (e.siteVisitRequired && !e.siteVisitDoneAt && age > SLA.siteVisitHrs && STAGES.indexOf(e.stage) < 3) out.push({ type: 'Site Visit Delay', ref: 'Sales 4.2', severity: 'Low', rec: e, col: 'enquiries', link: '#/enquiries/' + e.id, owner: e.execId, division: e.division, over: age - SLA.siteVisitHrs, details: 'Site visit not completed for ' + e.id + ' (' + e.accountName + ') · ' + hrsText(age) + ' since enquiry (SLA 24 h)' });
    });
    db.all('quotations').forEach((q) => {
      if (q.status !== 'Approved' || !q.customerApprovedAt) return;
      const o = orderOf(q.enquiryId);
      if (o && o.soIssuedDate) return;
      const age = util.hoursBetween(q.customerApprovedAt, now);
      if (age > SLA.soHrs) out.push({ type: 'Customer Approval Pending SO', ref: 'Sales 4.3', severity: 'Medium', rec: q, col: 'quotations', link: o ? '#/orders/' + o.id : '#/quotations/' + q.id, owner: q.execId, division: q.division, over: age - SLA.soHrs, details: 'Customer approved ' + q.id + ' but SO not issued in 24 h' });
    });
    db.all('invoices').forEach((i) => {
      if (outstandingOf(i) <= 0 || !i.dueDate || util.iso(i.dueDate) >= todayIso()) return;
      const days = util.daysBetween(parseD(util.iso(i.dueDate)), CRM.TODAY);
      out.push({ type: 'Payment Collection Delay', ref: 'Installation 5.2', severity: 'Medium', rec: i, col: 'invoices', link: '#/outstanding', links: ['#/outstanding', i.orderId ? '#/orders/' + i.orderId : '#/salespolicy'], owner: i.execId, division: i.division, over: days * 24, overDays: days, level: payLvl(days), details: i.invoiceNo + ' · ' + fmt.money(outstandingOf(i)) + ' overdue ' + days + ' d beyond credit policy (' + i.paymentTerms + ')' });
    });
    db.all('orders').forEach((o) => {
      if (o.division !== 'Power' || !o.scrapApplicable || o.scrapCollected || !o.installationCompletionDate) return;
      const age = util.hoursBetween(parseD(util.iso(o.installationCompletionDate)), now);
      if (age > SLA.scrapHrs) out.push({ type: 'Scrap Collection Delay', ref: 'Installation 5.3', severity: 'Medium', rec: o, col: 'orders', link: '#/orders/' + o.id, owner: o.execId, division: o.division, over: age - SLA.scrapHrs, details: (o.scrapQty || '') + ' ' + (o.scrapType || 'scrap') + ' not collected 24 h after installation (' + (o.soNumber || o.id) + ')' });
    });
    out.forEach((b) => { if (!b.level) b.level = lvl(b.over); if (!b.links) b.links = [b.link, '#/salespolicy']; });
    return out;
  }
  let scanning = false;
  function runPolicyScan() {
    if (scanning) return; scanning = true;
    try {
      policyBreaches().forEach((b) => {
        const flags = b.rec.policyFlags || {};
        const prev = flags[b.type] || 0;
        if (!prev) CRM.emit('violation.raise', { division: b.division, type: b.type, policyRef: b.ref, owner: b.owner, severity: b.severity, recordId: b.rec.id, link: b.link, details: b.details });
        if (b.level > prev) {
          const L = LEVELS[b.level];
          const n = { title: b.type + ' · ' + L.label, body: b.details + ' · owner ' + execName(b.owner), severity: b.level >= 3 ? 'bad' : 'warn', key: 'pol:' + b.type + ':' + b.rec.id + ':L' + b.level };
          // L1 goes to the owning executive only (plus Accounts for collections); higher levels go to the ladder role
          if (b.level === 1) { if (b.owner) sendUser(b.owner, ['sales_exec'], n, b.links); if (b.type === 'Payment Collection Delay') send(['accounts'], n, b.links); else if (!b.owner) send(['sales_coordinator'], n, b.links); }
          else send(L.to, n, b.links);
          db.update(b.col, b.rec.id, { policyFlags: Object.assign({}, flags, { [b.type]: b.level }) }, { silent: true });
        }
      });
      runReminders();
    } finally { scanning = false; }
  }
  /** Automatic reminders (re-checked on every data change and on a timer): follow-ups due / missed, quotation response pending, payment due. Per executive — no team-wide broadcast. */
  function runReminders() {
    const t = todayIso(), rem = cfg('sales.reminders');
    const fus = db.find('followups', (f) => f.status === 'Planned');
    const byExec = util.groupBy(fus.filter((f) => f.dueDate <= t), (f) => f.execId || '');
    Object.keys(byExec).forEach((ex) => {
      const due = byExec[ex].filter((f) => f.dueDate === t), missed = byExec[ex].filter((f) => f.dueDate < t);
      if (!ex) return;
      if (due.length) sendUser(ex, ['sales_exec'], { title: due.length + ' follow-up' + (due.length > 1 ? 's' : '') + ' due today', body: due.slice(0, 4).map((f) => f.accountName).join(', ') + (due.length > 4 ? '…' : ''), link: '#/followups', severity: 'info', key: 'fudue:' + t });
      if (missed.length) sendUser(ex, ['sales_exec'], { title: missed.length + ' missed follow-up' + (missed.length > 1 ? 's' : ''), body: 'Past their scheduled date and still open: ' + missed.slice(0, 3).map((f) => f.accountName).join(', ') + (missed.length > 3 ? '…' : ''), link: '#/followups', severity: 'warn', key: 'fumiss:' + t });
    });
    const missedAll = fus.filter((f) => f.dueDate < t);
    if (missedAll.length) send(['sales_coordinator'], { title: missedAll.length + ' missed follow-ups across the team', body: Object.entries(util.countBy(missedAll, (f) => execName(f.execId))).map(([k, v]) => k + ' ' + v).join(' · '), link: '#/followups', severity: 'warn', key: 'fumissc:' + t });
    db.find('quotations', (q) => q.status === 'Sent' && q.quoteDate && util.daysBetween(q.quoteDate, CRM.TODAY) >= SLA.quoteResponseDays).forEach((q) => sendUser(q.execId, ['sales_exec'], { title: 'Quotation response pending: ' + q.id, body: q.accountName + ' · sent ' + fmt.rel(q.quoteDate) + ' — follow up with customer', link: '#/quotations/' + q.id, severity: 'warn', key: 'qresp:' + q.id }));
    db.find('invoices', (i) => outstandingOf(i) > 0 && i.dueDate && util.iso(i.dueDate) >= t && util.daysBetween(CRM.TODAY, parseD(util.iso(i.dueDate))) <= (Number(rem.paymentDueDays) || 0)).forEach((i) => {
      const n = { title: 'Payment due ' + fmt.rel(i.dueDate) + ': ' + i.invoiceNo, body: i.accountName + ' · ' + fmt.money(outstandingOf(i)), severity: 'info', key: 'paydue:' + i.id };
      send(['accounts'], n, ['#/payments']);
      if (i.execId) sendUser(i.execId, ['sales_exec'], n, [i.orderId ? '#/orders/' + i.orderId : '#/mobile']);
    });
  }

  // ============================================================ seed data (≈6 months relative to CRM.TODAY)
  CRM.registerSeed((sdb, ctx) => {
    const T = CRM.TODAY, NOW = new Date();
    const R = util.rand, P = util.pick;
    const iso = (d) => new Date(d).toISOString();
    const at = (daysAgo, hour) => { const d = util.addDays(T, -daysAgo); d.setHours(hour == null ? R(9, 18) : hour, R(0, 59), 0, 0); return d > NOW ? new Date(NOW.getTime() - R(20, 90) * 60e3) : d; };
    const plusH = (d, hrs) => new Date(new Date(d).getTime() + hrs * 3600e3);
    const capNow = (d) => (d > NOW ? NOW : d);
    const ex = master.staff('sales_exec');
    const arun = 'EMP-sales_exec';
    const of = (div) => ex.filter((s) => s.division === div && s.id !== arun).map((s) => s.id);
    const pool = { Power: [arun, arun].concat(of('Power')), 'Electronic Security': of('Electronic Security').concat(of('Electronic Security'), [arun]), Solar: of('Solar').concat(of('Solar'), [arun]) };
    Object.keys(pool).forEach((k) => { if (!pool[k].length) pool[k] = [arun]; });
    const customers = master.customers();
    const PROSPECTS = [['Sri Murugan Traders', 'Retail', 'Erode'], ['Kovai Spinning Mills', 'Industrial', 'Tiruppur'], ['Green Valley School', 'Institutional', 'Pollachi'], ['Arun Diagnostics', 'Healthcare', 'RS Puram'], ['Meenakshi Kalyana Mandapam', 'Commercial', 'Gandhipuram'], ['Velan Agro Foods', 'Industrial', 'Mettupalayam'], ['Sathya Residency', 'Residential', 'Saravanampatti'], ['Nila Super Market', 'Retail', 'Peelamedu'], ['Rathinam Hostel', 'Institutional', 'Coimbatore North'], ['Dhanalakshmi Finance', 'Commercial', 'Coimbatore South'], ['Karpagam Residence', 'Residential', 'Peelamedu'], ['Tirupur Knit Exports', 'Industrial', 'Tiruppur'], ['Arul Clinic', 'Healthcare', 'Erode'], ['City Warehousing', 'Commercial', 'Coimbatore North']];
    const FN = ['Ravi', 'Selvam', 'Kannan', 'Deepa', 'Mohan', 'Saranya', 'Ganesh', 'Revathi', 'Kumar', 'Bharath'];
    const prod = (name) => master.products().find((p) => p.name === name);
    function pickProduct(div) {
      const ps = master.products(div).filter((p) => p.category !== 'Components');
      if (div === 'Electronic Security' && Math.random() < 0.55) return P(ps.filter((p) => /Camera/.test(p.name)));
      if (div === 'Solar') return P(ps.filter((p) => !/50kW/.test(p.name) || Math.random() < 0.3));
      if (div === 'Power') return P(ps.filter((p) => !/60KVA|200KVA/.test(p.name) || Math.random() < 0.25));
      return P(ps);
    }
    const qtyFor = (p) => ({ Inverter: R(1, 3), 'Online UPS': R(1, 2), 'Servo Stabilizer': 1, Battery: R(2, 12), CCTV: /Camera/.test(p.name) ? R(8, 32) : R(1, 2), Biometric: R(1, 4), 'Access Control': R(1, 3), 'Video Door Phone': R(1, 6), 'PA System': R(1, 2), 'Fire Alarm': /Smoke/.test(p.name) ? R(10, 40) : 1 }[p.category] || 1);
    function linesFor(p, qty) {
      const L = [{ productId: p.id, name: p.name, qty, rate: p.price }];
      const add = (n, q) => { const x = prod(n); if (x) L.push({ productId: x.id, name: x.name, qty: q, rate: x.price }); };
      if (/Camera/.test(p.name)) { add(qty > 16 ? 'NVR 32 Channel' : 'NVR 16 Channel', 1); add('Surveillance HDD 4TB', qty > 16 ? 2 : 1); add('PoE Switch 16 Port', Math.ceil(qty / 16)); }
      if (p.category === 'Online UPS') add('SF Sonic 100Ah', 4 * qty);
      if (p.category === 'Inverter') add('Exide 150Ah Tubular', qty * (/[35]KVA/.test(p.name) ? 4 : 1));
      return L;
    }
    const chanFor = (existing) => (existing ? P(['OTS', 'Office Walk-in', 'Upselling & Cross Selling', 'Office Walk-in', 'Referral Sales']) : P(['Cold Calling', 'Digital Marketing', 'Referral Sales', 'Advertisements', 'Business Forums', 'Office Walk-in', 'Cold Calling']));
    const leadFor = (ch) => ({ OTS: 'Existing Customer Business', 'Office Walk-in': 'Walk-in', 'Upselling & Cross Selling': 'Existing Customer Business', 'Cold Calling': 'Cold Calling', 'Digital Marketing': P(['Website', 'Campaign']), 'Referral Sales': P(['Existing Customer Reference', 'Dealer']), Advertisements: 'Campaign', 'Business Forums': 'Campaign' }[ch]);
    const NOTES = { 'Contact Made': 'Spoke to customer, requirement confirmed', 'Site Visit Scheduled': 'Site visit fixed with customer', 'Site Visit Completed': 'Site surveyed, load / coverage noted', 'Quotation Sent': 'Quotation shared on mail & WhatsApp', Negotiation: 'Customer negotiating on price and delivery', 'Order Won': 'PO received from customer', 'Order Lost': 'Customer went with competitor' };

    // ---- dealers (dealer-reported monthly sales; dealer-sourced orders are linked by dealerId below)
    const dealers = [];
    const DEALERS = [['Sri Vinayaga Power Systems', 'Tiruppur', 'Power'], ['Kongu Electricals', 'Erode', 'Power'], ['Pollachi Inverter House', 'Pollachi', 'Power'], ['Mettupalayam Power Point', 'Mettupalayam', 'Power'], ['SecureNet Solutions', 'Peelamedu', 'Electronic Security'], ['SunPath Solar Agencies', 'Tiruppur', 'Solar']];
    DEALERS.forEach(([name, area, division], i) => {
      const sales = {}; monthsBack(7).forEach((mk) => { sales[mk] = R(4, 22) * 25000 * (division === 'Solar' ? 2 : 1); });
      dealers.push(sdb.insert('dealers', { name, area, division, execId: division === 'Power' ? (i % 2 ? arun : (of('Power')[0] || arun)) : P(pool[division]), contact: P(FN) + ' ' + P(['R', 'K', 'S']), phone: '94' + R(10000000, 99999999), since: util.iso(util.addDays(T, -R(300, 2400))), creditLimit: R(2, 10) * 100000, sales, status: 'Active' }, { prefix: 'DLR', silent: true }));
    });

    // ---- plan enquiries, then insert in chronological order so ENQ numbers increase with date
    const plan = [];
    for (let i = 0; i < 84; i++) {
      const ageDays = i < 16 ? R(0, 4) : i < 34 ? R(5, 25) : R(26, 178);
      const r = Math.random();
      const division = r < 0.45 ? 'Power' : r < 0.75 ? 'Electronic Security' : 'Solar';
      const existing = Math.random() < 0.68;
      plan.push({ created: at(ageDays), ageDays, division, existing });
    }
    for (let k = 0; k < 3; k++) plan.push({ created: at(R(0, 1)), ageDays: 0, division: 'Power', existing: true, ots: true });
    plan.sort((a, b) => a.created - b.created);

    let awaitingQ = 0, soPending = 0, soAwait = 0, scrapBreach = 0;
    const createdOrders = [];
    plan.forEach((pl, idx) => {
      const c = pl.existing ? P(customers) : null;
      const pr = PROSPECTS[idx % PROSPECTS.length];
      const p = pl.ots ? prod('Exide 150Ah Tubular') : pickProduct(pl.division);
      const qty = pl.ots ? R(4, 8) : qtyFor(p);
      const lines = linesFor(p, qty);
      const expectedValue = Math.round(sum(lines, (l) => l.qty * l.rate) / 1000) * 1000;
      const execId = pl.ots ? '' : P(pool[pl.division]);
      const channel = pl.ots ? 'OTS' : chanFor(!!c);
      const leadFor0 = leadFor(channel);
      const sv = pl.division !== 'Power' || Math.random() < 0.15;
      const r = Math.random();
      const outcome = pl.ots ? 'open' : pl.ageDays > 25 ? (r < 0.58 ? 'won' : r < 0.84 ? 'lost' : 'open') : pl.ageDays > 4 ? (r < 0.35 ? 'won' : r < 0.52 ? 'lost' : 'open') : 'open';
      // ---- stage timeline
      let t = pl.created; const ev = [];
      const add = (stage, hrs) => { t = plusH(t, hrs); ev.push({ stage, at: t }); };
      add('Contact Made', R(1, 6));
      if (sv) { add('Site Visit Scheduled', R(1, 3)); add('Site Visit Completed', R(4, 26)); }
      add('Quotation Sent', Math.random() < 0.72 ? R(2, 12) : R(14, 40));
      add('Negotiation', R(24, 110));
      if (outcome === 'won') add('Order Won', R(24, 200));
      if (outcome === 'lost') add('Order Lost', R(24, 200));
      let kept = ev.filter((x) => x.at <= NOW);
      if (outcome === 'open') kept = kept.slice(0, pl.ots ? 0 : pl.ageDays > 6 && kept.some((x) => x.stage === 'Quotation Sent') ? R(kept.findIndex((x) => x.stage === 'Quotation Sent') + 1, kept.length) : R(0, kept.length));
      const stage = kept.length ? kept[kept.length - 1].stage : 'Enquiry Received';
      const evAt = (s) => (kept.find((x) => x.stage === s) || {}).at;
      const isOpen = OPEN.includes(stage);
      const fuDue = isOpen ? (Math.random() < 0.25 ? util.addDays(T, -R(1, 5)) : Math.random() < 0.45 ? T : util.addDays(T, R(1, 7))) : null;
      const e = sdb.insert('enquiries', {
        createdAt: iso(pl.created), date: util.iso(pl.created), month: enqMonth(pl.created), execId, assignRule: execId ? 'Division + Area match' : '', assignedAt: execId ? iso(pl.created) : '',
        customerId: c ? c.id : '', accountName: c ? c.name : pr[0], contactName: c ? c.contact : P(FN) + ' ' + P(['R', 'S', 'K', 'M']), contactNumber: c ? c.phone : '9' + R(100000000, 999999999),
        email: c ? c.email : pr[0].toLowerCase().replace(/[^a-z]+/g, '.') + '@example.in', area: c ? c.area : pr[2], segment: c ? c.segment : pr[1], customerType: c ? c.type : 'New Customer',
        businessType: c && c.type !== 'New Customer' ? 'Existing Customer Business' : 'New Customer Business', salesChannel: channel, referralType: channel === 'Referral Sales' ? (leadFor0 === 'Dealer' ? 'Dealer reference' : P(REFERRAL_TYPES)) : '', leadSource: leadFor0,
        sourceDetails: pl.ots ? 'Sales OTS from service visit · battery qty ' + qty + ' (> 2 → Sales OTS) · awaiting coordinator assignment' : channel === 'Digital Marketing' ? P(['Google Ads form', 'Website chat', 'Facebook lead']) : channel === 'Business Forums' ? P(['CODISSIA meet', 'BNI chapter', 'Rotary expo']) : channel === 'OTS' ? 'Raised by service engineer during complaint visit' : '',
        dealerId: leadFor0 === 'Dealer' ? (P(dealers.filter((d) => d.division === pl.division)) || P(dealers) || {}).id || '' : '',
        division: pl.division, category: p.category, productId: p.id, product: p.name, quantity: qty, expectedValue, remarks: P(['', 'Budget approved', 'Comparing 2 vendors', 'Urgent requirement', 'Needs demo', '']),
        stage, callStatus: kept.length ? 'Connected' : P(['', 'Not Reachable', 'Call Back Requested']), progressNotes: NOTES[stage] || 'New enquiry logged',
        siteVisitRequired: sv, siteVisitDate: evAt('Site Visit Scheduled') ? util.iso(evAt('Site Visit Completed') || plusH(evAt('Site Visit Scheduled'), 20)) : '', siteVisitDoneAt: evAt('Site Visit Completed') ? iso(evAt('Site Visit Completed')) : '',
        contactMadeAt: evAt('Contact Made') ? iso(evAt('Contact Made')) : '', nextFollowUp: fuDue ? util.iso(fuDue) : '', followUpStatus: !isOpen ? 'Completed' : fuDue < T ? 'Missed' : 'Pending',
        isNewCustomer: !c || c.type === 'New Customer', closedAt: !isOpen ? iso(kept[kept.length - 1].at) : '',
        lostReason: stage === 'Order Lost' ? P(LOST_REASONS.slice(0, 6)) : '', lostDetails: stage === 'Order Lost' ? 'Customer finalised elsewhere' : '', competitor: stage === 'Order Lost' ? P(['Luminous', 'APC', 'Hikvision dealer', 'Tata Power Solar', '']) : '', wonDetails: stage === 'Order Won' ? 'Better service support and delivery commitment' : '',
        comms: kept.length > 2 ? [{ at: iso(kept[1].at), channel: 'WhatsApp', to: c ? c.phone : '', text: 'Shared product brochure', by: execName(execId) }].concat(evAt('Quotation Sent') ? [{ at: iso(evAt('Quotation Sent')), channel: 'Email', to: c ? c.email : '', text: 'Quotation sent', by: execName(execId) }] : []) : [],
        stageHistory: [{ stage: 'Enquiry Received', at: iso(pl.created), by: execName(execId) || 'System', note: 'Enquiry created via ' + channel }].concat(kept.map((x) => ({ stage: x.stage, at: iso(x.at), by: execName(execId), note: NOTES[x.stage] }))),
        cameraCount: /Camera/.test(p.name) ? qty : undefined,
      }, { prefix: 'ENQ', silent: true });

      // ---- follow-ups (open leads: past completed + next planned)
      if (isOpen && execId) {
        kept.slice(-2).forEach((x) => sdb.insert('followups', { enquiryId: e.id, customerId: e.customerId, accountName: e.accountName, execId, division: e.division, dueDate: util.iso(x.at), type: x.stage.includes('Site') ? 'Site Visit' : 'Call', purpose: 'Progress to ' + x.stage, status: 'Completed', completedAt: iso(x.at), outcome: NOTES[x.stage], createdAt: iso(pl.created) }, { prefix: 'FUP', silent: true }));
        sdb.insert('followups', { enquiryId: e.id, customerId: e.customerId, accountName: e.accountName, execId, division: e.division, dueDate: util.iso(fuDue), type: stage === 'Site Visit Scheduled' ? 'Site Visit' : P(['Call', 'Call', 'Meeting', 'WhatsApp']), purpose: stage === 'Negotiation' ? 'Close negotiation' : stage === 'Quotation Sent' ? 'Quotation feedback' : 'Requirement discussion', status: 'Planned', createdAt: iso(pl.created) }, { prefix: 'FUP', silent: true });
      }

      // ---- quotation
      const qAt = evAt('Quotation Sent');
      const disc = R(0, 4) * 2;
      const scrapOk = pl.division === 'Power' && /Battery|Inverter|UPS/.test(p.category) && Math.random() < 0.5;
      const qBase = { enquiryId: e.id, customerId: e.customerId, accountName: e.accountName, division: e.division, execId, lines, discountPct: disc, scrapApplicable: scrapOk ? 'Yes' : 'No', scrapType: scrapOk ? 'Battery' : '', scrapQty: scrapOk ? R(1, 6) : 0, scrapValue: scrapOk ? R(2, 8) * 500 : 0, scrapDetails: scrapOk ? 'Old batteries to be taken back as buy-back' : '', warrantyContract: pl.division === 'Solar' ? WARRANTY[5] : P(WARRANTY.slice(0, 4)), paymentTerms: P(['Credit 30 days', 'Credit 15 days', '100% Advance', 'Credit 45 days', 'Against delivery']), validityDays: 15, revision: 0 };
      Object.assign(qBase, computeQuote(lines, disc, qBase.scrapValue, pl.division));
      if (qAt) {
        let status = stage === 'Order Won' ? 'Approved' : stage === 'Order Lost' ? 'Rejected' : stage === 'Negotiation' ? 'Under Discussion' : P(['Sent', 'Sent', 'Pending']);
        let custAt = stage === 'Order Won' ? iso(plusH(evAt('Order Won'), -R(2, 20))) : '';
        if (stage === 'Negotiation' && soPending < 2 && execId) { status = 'Approved'; custAt = iso(plusH(NOW, -R(28, 40))); soPending++; }
        sdb.insert('quotations', Object.assign({}, qBase, { createdAt: iso(plusH(qAt, -R(1, 3))), quoteDate: iso(qAt), status, approval: 'Approved', approvedBy: 'Ramesh K', approvedAt: iso(qAt), deliveryCommitment: util.iso(util.addDays(qAt, R(5, 15))), customerApprovedAt: custAt, fileName: 'Quote_' + e.id + '.pdf' }), { prefix: 'QTN', silent: true });
      } else if (isOpen && execId && pl.ageDays <= 4 && ['Contact Made', 'Site Visit Completed'].includes(stage) && awaitingQ < 4) {
        awaitingQ++;
        sdb.insert('quotations', Object.assign({}, qBase, { createdAt: iso(capNow(plusH(kept[kept.length - 1].at, 2))), quoteDate: '', status: 'Pending', approval: 'Awaiting Approval', deliveryCommitment: util.iso(util.addDays(T, R(5, 12))) }), { prefix: 'QTN', silent: true });
      }

      // ---- order, invoice and payments for won enquiries
      if (stage === 'Order Won') {
        const wonAt = evAt('Order Won');
        const known = !e.customerId && sdb.one('customers', (x) => x.name === e.accountName);
        if (known) { e.customerId = known.id; e.customerType = known.type; }
        if (!e.customerId) { // prospect converted to customer on winning
          const nc = sdb.insert('customers', { id: nextCustomerId(), name: e.accountName, type: 'New Customer', contact: e.contactName, phone: e.contactNumber, email: e.email, area: e.area, segment: e.segment, gstin: '', since: util.iso(wonAt), source: 'Converted from ' + e.id }, { silent: true });
          sdb.insert('sites', { customerId: nc.id, name: 'Main Site', address: R(1, 240) + ', ' + e.area + ', Coimbatore', contact: e.contactName, phone: e.contactNumber, access: 'Reception' }, { silent: true });
          e.customerId = nc.id;
        }
        const q = sdb.one('quotations', (x) => x.enquiryId === e.id);
        const recent = util.hoursBetween(wonAt, NOW) < 60;
        const awaiting = recent && soAwait < 3; if (awaiting) soAwait++;
        const firstOrder = !sdb.one('orders', (x) => x.customerId === e.customerId && x.approval === 'Approved');
        const custRec = sdb.get('customers', e.customerId);
        const isNew = firstOrder && (!custRec || custRec.type === 'New Customer');
        const soAt = awaiting ? null : capNow(plusH(wonAt, Math.random() < 0.72 ? R(2, 20) : R(26, 60)));
        const terms = q ? q.paymentTerms : 'Credit 30 days';
        const deliv = util.addDays(soAt || wonAt, R(3, 14));
        const installed = soAt && deliv < T ? util.addDays(deliv, R(0, 3)) : null;
        const instDone = installed && installed <= T ? installed : null;
        let scrapCollected = true;
        if (q && q.scrapApplicable === 'Yes' && instDone && util.daysBetween(instDone, T) <= 4 && scrapBreach < 1) { scrapCollected = false; scrapBreach++; }
        const o = sdb.insert('orders', Object.assign({
          enquiryId: e.id, quotationId: q ? q.id : '', customerId: e.customerId, accountName: e.accountName, division: e.division, execId, productId: p.id, product: p.name, quantity: qty,
          value: q ? q.basicValue : expectedValue, wonDate: iso(wonAt), poNumber: 'PO/' + e.accountName.replace(/[^A-Z]/g, '').slice(0, 4) + '/' + R(100, 999), materialAvailability: P(MATERIAL),
          deliveryCommitDate: util.iso(deliv), paymentTerms: terms, creditDays: PAY_TERMS[terms] || 0, approval: awaiting ? 'Awaiting Approval' : 'Approved', approvedBy: awaiting ? '' : 'Ramesh K', approvedAt: soAt ? iso(soAt) : '',
          soNumber: soAt ? 'SO/' + fy(soAt) + '/' + CRM.nextId('SONO').split('-')[1] : '', soIssuedDate: soAt ? iso(soAt) : '', warrantyContract: q ? q.warrantyContract : '', newCustomer: isNew, salesChannel: channel, leadSource: e.leadSource, dealerId: e.dealerId || '',
          scrapApplicable: q ? q.scrapApplicable === 'Yes' : false, scrapType: q ? q.scrapType : '', scrapQty: q ? q.scrapQty : 0, scrapCollected: q && q.scrapApplicable === 'Yes' ? scrapCollected : false,
          installationStatus: instDone ? 'Completed' : soAt ? 'Scheduled' : 'Pending', installationCompletionDate: instDone ? util.iso(instDone) : '', deliveredDate: instDone ? util.iso(instDone) : '', createdAt: iso(wonAt),
        }, divisionExtras(e.division, p.id, qty, lines)), { prefix: 'ORD', silent: true });
        createdOrders.push(o);
        if (soAt && custRec && custRec.type === 'New Customer') Object.assign(custRec, { type: 'Existing Customer', promotedAt: iso(soAt) }); // promoted after first approved order
        if (soAt && util.daysBetween(soAt, T) >= 4 && Math.random() < 0.92) {
          const invDate = util.addDays(soAt, R(0, 3)) > T ? T : util.addDays(soAt, R(0, 3));
          const due = util.addDays(invDate, o.creditDays);
          const inv = sdb.insert('invoices', { invoiceNo: 'MPCS/' + fy(invDate) + '/INV-' + CRM.nextId('INVNO').split('-')[1], orderId: o.id, soNumber: o.soNumber, customerId: o.customerId, accountName: o.accountName, division: o.division, execId, invoiceDate: util.iso(invDate), value: withGst(o.value, o.division) - (q ? Number(q.scrapValue) || 0 : 0), gstPct: gstPct(o.division), scrapValue: q ? Number(q.scrapValue) || 0 : 0, paymentTerms: terms, dueDate: util.iso(due), hardCopySubmitted: Math.random() < 0.8, invoiceMailed: Math.random() < 0.9, confirmedWith: (master.customer(o.customerId) || {}).contact || e.contactName, source: 'Sales', createdAt: iso(invDate) }, { prefix: 'INV', silent: true });
          const pay = (d, v, mode) => sdb.insert('payments', { invoiceId: inv.id, orderId: o.id, customerId: o.customerId, accountName: o.accountName, division: o.division, execId, receivedDate: util.iso(d), value: Math.round(v), mode: mode || P(PAY_MODES), reference: 'UTR' + R(100000, 999999), confirmedWith: inv.confirmedWith, recordedBy: 'Meena P', verified: true, onTime: util.iso(d) <= inv.dueDate, createdAt: iso(d) }, { prefix: 'PAY', silent: true });
          const rr = Math.random();
          if (terms === '100% Advance') pay(invDate, inv.value, 'NEFT / RTGS');
          else if (due < T) {
            if (rr < 0.62) { const d = util.addDays(due, R(-6, 9)); pay(d > T ? T : d < invDate ? invDate : d, inv.value); }
            else if (rr < 0.84) pay(util.addDays(invDate, R(1, Math.max(1, util.daysBetween(invDate, T)))), inv.value * 0.5);
          } else if (rr < 0.25) pay(invDate, inv.value * 0.3, 'Cheque');
        }
      }
    });

    // ---- force a few payment-due-today / due-soon invoices for the daily collection list
    const futureOpen = sdb.find('invoices', (i) => i.dueDate > util.iso(T) && !sdb.find('payments', (p) => p.invoiceId === i.id).length);
    if (futureOpen[0]) futureOpen[0].dueDate = util.iso(T);
    if (futureOpen[1]) futureOpen[1].dueDate = util.iso(util.addDays(T, 2));

    // ---- ensure one Power order shows a scrap-collection delay (installation done, scrap pending)
    if (!scrapBreach) {
      // pick an order whose SO was issued before the forced installation date (installation can never precede the SO)
      const po = createdOrders.filter((o) => o.division === 'Power' && o.approval === 'Approved' && o.soIssuedDate && util.iso(o.soIssuedDate) <= util.iso(util.addDays(T, -3))).sort((a, b) => (a.wonDate < b.wonDate ? 1 : -1))[0];
      if (po) Object.assign(po, { scrapApplicable: true, scrapType: 'Battery', scrapQty: 4, scrapCollected: false, installationStatus: 'Completed', installationCompletionDate: util.iso(util.addDays(T, -2)), deliveredDate: util.iso(util.addDays(T, -2)) });
    }

    // ---- historical (migrated) orders for last-year comparison
    for (let m = 6; m <= 23; m++) {
      const n = m === 12 ? 4 : m < 12 ? R(0, 2) : R(1, 3);
      for (let k = 0; k < n; k++) {
        const d = new Date(T); d.setDate(1); d.setMonth(d.getMonth() - m); d.setDate(R(1, 27)); d.setHours(R(10, 17));
        const division = P(DIVS); const p = pickProduct(division); const qty = qtyFor(p); const c = P(customers);
        sdb.insert('orders', Object.assign({ enquiryId: '', quotationId: '', customerId: c.id, accountName: c.name, division, execId: P(pool[division]), productId: p.id, product: p.name, quantity: qty, value: Math.round(sum(linesFor(p, qty), (l) => l.qty * l.rate)), wonDate: iso(d), poNumber: 'PO/' + R(1000, 9999), materialAvailability: 'Available in stock', deliveryCommitDate: util.iso(util.addDays(d, 7)), paymentTerms: 'Credit 30 days', creditDays: 30, approval: 'Approved', approvedBy: 'Ramesh K', approvedAt: iso(plusH(d, 8)), soNumber: 'SO/' + fy(d) + '/H' + R(100, 999), soIssuedDate: iso(plusH(d, R(4, 30))), newCustomer: Math.random() < 0.3, salesChannel: 'Migrated', installationStatus: 'Completed', installationCompletionDate: util.iso(util.addDays(d, 9)), migrated: true, createdAt: iso(d) }, divisionExtras(division, p.id, qty)), { prefix: 'ORD', silent: true });
      }
    }

    // ---- upsell / cross-sell opportunities from won orders
    createdOrders.filter((o) => o.approval === 'Approved').forEach((o) => {
      suggestUpsells(o, false).forEach((u) => {
        const rr = Math.random();
        const d = util.addDays(o.wonDate, R(1, 20)) > T ? T : util.addDays(o.wonDate, R(1, 20));
        const patch = { date: util.iso(o.wonDate), createdAt: o.wonDate };
        if (rr < 0.3) Object.assign(patch, { status: 'Converted', convertedAt: util.iso(d), convertedValue: u.value });
        else if (rr < 0.55) patch.status = 'Offered';
        else if (rr < 0.7) Object.assign(patch, { status: 'Declined', declineReason: 'Not required now' });
        Object.assign(u, patch);
      });
    });

    // ---- call logs: detailed for the last 14 days + monthly summaries (migrated from Excel) before that
    ex.forEach((s) => {
      for (let d = 0; d < 14; d++) {
        const day = util.addDays(T, -d); if (day.getDay() === 0) continue;
        const n = d === 0 ? (s.id === arun ? 3 : 1) : R(1, 3);
        for (let k = 0; k < n; k++) {
          const type = Math.random() < 0.55 ? 'Cold Call' : P(['Follow-up Call', 'Enquiry Call', 'Payment Follow-up']);
          const c = P(customers); const pr = P(PROSPECTS);
          const cold = type === 'Cold Call';
          sdb.insert('callLogs', { execId: s.id, division: s.division, date: iso(at(d, R(9, 17))), type, customerId: cold ? '' : c.id, name: cold ? pr[0] : c.name, phone: cold ? '9' + R(100000000, 999999999) : c.phone, outcome: P(cold ? CALL_OUTCOMES : CALL_OUTCOMES.slice(0, 3)), durationMin: R(1, 12), notes: cold ? 'Introduced ' + s.division + ' range' : 'Discussed progress', count: 1 }, { prefix: 'CALL', silent: true });
        }
      }
      monthsBack(7).forEach((mk, i, arr) => {
        const [from] = monthRange(mk);
        const isCur = i === arr.length - 1;
        const d = new Date(from + 'T11:00:00');
        const scale = isCur ? Math.max(0, (util.daysBetween(d, T) - 13) / 26) : 1;
        if (scale <= 0) return;
        sdb.insert('callLogs', { execId: s.id, division: s.division, date: iso(d), type: 'Cold Call', name: 'Monthly cold-call summary (migrated)', outcome: 'Summary', count: Math.round(R(42, 72) * scale), summary: true }, { prefix: 'CALL', silent: true });
        sdb.insert('callLogs', { execId: s.id, division: s.division, date: iso(d), type: 'Follow-up Call', name: 'Monthly follow-up call summary (migrated)', outcome: 'Summary', count: Math.round(R(45, 80) * scale), summary: true }, { prefix: 'CALL', silent: true });
      });
    });

    // ---- monthly targets per executive and per division
    const baseRev = { Power: 450000, 'Electronic Security': 550000, Solar: 900000 };
    monthsBack(7).forEach((mk) => {
      const divT = {};
      ex.forEach((s) => {
        const t = { scope: 'exec', execId: s.id, division: s.division, month: mk, revenue: s.id === arun ? 700000 : baseRev[s.division] || 500000, calls: 110, coldCalls: 60, newCustomers: 3, upsell: 2, crossSell: 3 };
        sdb.insert('targets', t, { prefix: 'TGT', silent: true });
        const dt = divT[s.division] = divT[s.division] || { revenue: 0, calls: 0, coldCalls: 0, newCustomers: 0, upsell: 0, crossSell: 0 };
        ['revenue', 'calls', 'coldCalls', 'newCustomers', 'upsell', 'crossSell'].forEach((k) => { dt[k] += t[k]; });
      });
      DIVS.forEach((d) => sdb.insert('targets', Object.assign({ scope: 'division', division: d, month: mk }, divT[d] || { revenue: baseRev[d], calls: 110, coldCalls: 60, newCustomers: 3, upsell: 2, crossSell: 3 }), { prefix: 'TGT', silent: true }));
    });

    // ---- check-ins (mobile sales) with location mapping
    const base = { lat: 11.0168, lng: 76.9558 };
    ex.forEach((s) => {
      const days = s.id === arun ? [0, 1, 2, 3, 4, 5] : [1, 2];
      days.forEach((d) => {
        const day = util.addDays(T, -d); if (day.getDay() === 0) return;
        const inAt = at(d, 9); const loc = () => ({ lat: +(base.lat + (Math.random() - 0.5) * 0.12).toFixed(5), lng: +(base.lng + (Math.random() - 0.5) * 0.12).toFixed(5), accuracy: R(8, 40), simulated: false });
        const mine = sdb.find('enquiries', (e) => e.execId === s.id);
        const visits = d === 0 ? [] : [0, 1].map(() => { const e = P(mine.length ? mine : sdb.all('enquiries')); return { at: iso(plusH(inAt, R(1, 7))), enquiryId: e.id, accountName: e.accountName, note: P(['Site visit', 'Demo given', 'Payment collection', 'Negotiation meeting']), loc: loc() }; });
        sdb.insert('checkins', { execId: s.id, date: util.iso(day), checkInAt: iso(inAt), checkInLoc: loc(), checkOutAt: d === 0 ? '' : iso(plusH(inAt, 9)), checkOutLoc: d === 0 ? null : loc(), visits }, { prefix: 'CHK', silent: true });
      });
    });

    CRM.notify({ to: ['sales_manager'], title: 'Monthly target review', body: 'Executive and division targets for ' + monthLabel(monthKey(T)) + ' are live', link: '#/targets', severity: 'info', key: 'tgt:' + monthKey(T) });
  });

  // ============================================================ shared UI bits
  const ROLES_SALES = ['sales_exec', 'sales_coordinator', 'sales_manager', 'gm', 'admin'];
  const ROLES_MGMT_SALES = ['sales_coordinator', 'sales_manager', 'gm', 'admin'];
  const ROLES_FIN = ['accounts', 'sales_manager', 'sales_coordinator', 'gm', 'admin'];
  const fuBadge = (d) => (d ? ui.badge(fmt.rel(d), d < todayIso() ? 'bad' : d === todayIso() ? 'warn' : 'info') : h('span', { class: 'muted' }, '—'));
  const respBadge = (hrs) => (hrs == null ? h('span', { class: 'muted' }, '—') : ui.badge(hrsText(hrs), hrs <= 24 ? 'ok' : hrs <= 48 ? 'warn' : 'bad'));
  const fillSelect = (sel, opts) => { sel.innerHTML = ''; sel.appendChild(h('option', { value: '' }, 'Select…')); opts.forEach((o) => sel.appendChild(h('option', { value: typeof o === 'object' ? o.value : o }, typeof o === 'object' ? o.label : o))); };
  const execOptions = () => execs().map((s) => ({ value: s.id, label: s.name + ' · ' + (s.division || 'All') + ' · ' + (s.area || '—') }));
  const dealerOptions = () => db.all('dealers').filter((d) => d.status !== 'Inactive').map((d) => ({ value: d.id, label: d.name + ' · ' + d.area + ' · ' + d.division }));
  const prodOptions = (div, cat) => master.products(div).filter((p) => !cat || p.category === cat).map((p) => ({ value: p.id, label: p.name + ' · ' + fmt.money(p.price) }));
  const card = (title, body, opts) => ui.card(title, body, opts);
  const section = (el, node) => { el.appendChild(h('div', { class: 'mt' }, node)); };

  // ============================================================ enquiry create form (duplicate check + auto-assignment)
  function enquiryForm(prefill, opts) {
    opts = opts || {};
    prefill = Object.assign({}, prefill || {});
    const c0 = prefill.customerId && master.customer(prefill.customerId);
    if (c0) Object.assign(prefill, { accountName: c0.name, contactName: c0.contact, contactNumber: c0.phone, email: c0.email, area: c0.area, segment: c0.segment, customerType: c0.type }, Object.fromEntries(Object.entries(prefill).filter(([, v]) => v)));
    const div0 = prefill.division || CRM.user().division || 'Power';
    const recalc = (inp) => { const p = master.product(inp.productId.value); if (p) inp.expectedValue.value = p.price * (Number(inp.quantity.value) || 1); };
    const fields = [
      { type: 'section', label: 'Enquiry' },
      { key: 'enqNo', label: 'Enquiry No', type: 'readonly', default: '(auto-generated on save)' },
      { key: 'enqDate', label: 'Enquiry date · Enquiry month', type: 'readonly', default: fmt.date(new Date()) + ' · ' + enqMonth(new Date()) },
      { type: 'section', label: 'Customer — duplicate-checked against the customer master' },
      { key: 'customerId', label: 'Customer ID (existing account)', type: 'select', full: true, options: [{ value: '', label: '— New prospect (not yet in customer master) —' }].concat(master.customers().map((c) => ({ value: c.id, label: c.id + ' · ' + c.name + ' · ' + c.area }))), onChange: (val, inp) => { const c = master.customer(val); if (!c) return; inp.accountName.value = c.name; inp.contactName.value = c.contact; inp.contactNumber.value = c.phone; inp.email.value = c.email || ''; inp.area.value = c.area; inp.segment.value = c.segment || ''; inp.customerType.value = c.type; } },
      { key: 'accountName', label: 'Account name', required: true },
      { key: 'contactName', label: 'Contact name', required: true },
      { key: 'contactNumber', label: 'Contact number', required: true },
      { key: 'email', label: 'Email' },
      { key: 'area', label: 'Area', type: 'select', options: master.areas, required: true },
      { key: 'segment', label: 'Segment', type: 'select', options: master.segments, required: true },
      { key: 'customerType', label: 'Customer type', type: 'select', options: CUSTOMER_TYPES, required: true, default: 'New Customer' },
      { type: 'section', label: 'Source' },
      { key: 'salesChannel', label: 'Source (sales channel)', type: 'select', options: CHANNELS, required: true, hint: 'Existing-customer business: OTS, walk-in, upsell/cross-sell · New-customer business: cold calling, digital, referral, ads, forums, walk-in' },
      { key: 'leadSource', label: 'Lead source', type: 'select', options: LEAD_SOURCES, required: true },
      { key: 'referralType', label: 'Referral type (Referral Sales)', type: 'select', options: REFERRAL_TYPES },
      { key: 'dealerId', label: 'Dealer (dealer lead / dealer reference)', type: 'select', options: dealerOptions(), hint: 'Orders won from this lead count toward the dealer\'s monthly sales' },
      { key: 'sourceDetails', label: 'Source details', placeholder: 'Campaign, referrer name, OTS ref…' },
      { type: 'section', label: 'Requirement' },
      { key: 'division', label: 'Division', type: 'select', options: DIVS, required: true, default: div0, onChange: (val, inp) => { fillSelect(inp.category, categories(val)); fillSelect(inp.productId, prodOptions(val)); inp.siteVisitRequired.checked = val !== 'Power'; } },
      { key: 'category', label: 'Category', type: 'select', options: categories(div0), onChange: (val, inp) => fillSelect(inp.productId, prodOptions(inp.division.value, val)) },
      { key: 'productId', label: 'Product', type: 'select', options: prodOptions(div0), required: true, onChange: (v, inp) => recalc(inp) },
      { key: 'quantity', label: 'Quantity', type: 'number', required: true, default: 1, min: 1, onChange: (v, inp) => recalc(inp) },
      { key: 'expectedValue', label: 'Expected value (₹)', type: 'number', required: true, hint: 'Auto = list price × quantity (editable)' },
      { key: 'nextFollowUp', label: 'First follow-up date', type: 'date', required: true, default: util.iso(util.addDays(CRM.TODAY, 1)) },
      { key: 'siteVisitRequired', label: 'Site visit required (24 h site-visit SLA applies)', type: 'checkbox', default: div0 !== 'Power' },
      !isExec() ? { key: 'execId', label: 'Sales executive', type: 'select', options: [{ value: '', label: '⚙ Auto-assign by Division + Area' }].concat(execOptions()) } : null,
      { key: 'remarks', label: 'Remarks', type: 'textarea' },
    ].filter(Boolean);
    // values that have no visible field (e.g. the Sales OTS id) are carried through — form.values() only returns fields
    const hidden = { otsId: prefill.otsId || '' };
    let m;
    function proceed(v) {
      Object.keys(hidden).forEach((k) => { if (hidden[k] && !v[k]) v[k] = hidden[k]; });
      if ((v.leadSource === 'Dealer' || v.referralType === 'Dealer reference') && !v.dealerId) { ui.toast('Select the dealer for a dealer-sourced lead', 'bad'); return; }
      if (v.otsId && db.one('enquiries', (x) => x.otsId === v.otsId)) { ui.toast('Sales OTS ' + v.otsId + ' is already converted (' + db.one('enquiries', (x) => x.otsId === v.otsId).id + ')', 'bad'); return; }
      if (!v.customerId) {
        const dup = findDuplicateCustomer(v);
        if (dup) {
          ui.modal({ title: 'Duplicate check: customer already exists', body: h('div', { class: 'stack' }, [calloutH('<b>' + util.esc(dup.name) + '</b> (' + dup.id + ') in the customer master matches this enquiry by name / phone / email. New accounts cannot be duplicated — link the enquiry to the existing customer.', 'warn'), ui.dl([['Customer', dup.name], ['Phone', dup.phone], ['Email', dup.email], ['Area', dup.area], ['Type', dup.type]])]),
            actions: [{ label: 'Cancel' }, { label: 'Link to ' + dup.id + ' & continue', cls: 'primary', onClick: () => { Object.assign(v, { customerId: dup.id, accountName: dup.name, customerType: dup.type }); setTimeout(() => proceed(v)); } }] });
          return;
        }
      }
      const open = !v._dupOk && findOpenEnquiry(v);
      if (open) {
        ui.modal({ title: 'Open enquiry already exists', body: calloutH('<b>' + open.id + '</b> for ' + util.esc(open.accountName) + ' (' + util.esc(open.product) + ') is still open in ' + util.esc(open.division) + ' at stage <b>' + util.esc(open.stage) + '</b>, owned by ' + util.esc(execName(open.execId)) + '.', 'warn'),
          actions: [{ label: 'Open ' + open.id, onClick: () => { m.close(); CRM.go('enquiries', open.id); } }, { label: 'Create separate enquiry', cls: 'primary', onClick: () => { v._dupOk = true; setTimeout(() => proceed(v)); } }] });
        return;
      }
      delete v._dupOk; delete v.enqNo; delete v.enqDate;
      const e = createEnquiry(v, opts);
      m.close();
      ui.toast(e.id + ' created · ' + (e.execId ? 'assigned to ' + execName(e.execId) + ' (' + e.assignRule + ')' : 'awaiting assignment'), 'ok');
      if (opts.onCreated) opts.onCreated(e); else CRM.go('enquiries', e.id);
    }
    m = ui.formModal(opts.title || 'New enquiry', fields, prefill, (v) => { proceed(v); return false; }, { wide: true, saveLabel: 'Create enquiry', sub: 'All Sales.pdf enquiry fields · Customer ID duplicate check · Division + Area auto-assignment' });
    return m;
  }

  function editEnquiry(e) {
    ui.formModal('Edit ' + e.id, [
      { key: 'contactName', label: 'Contact name', required: true }, { key: 'contactNumber', label: 'Contact number', required: true }, { key: 'email', label: 'Email' },
      { key: 'area', label: 'Area', type: 'select', options: master.areas, required: true }, { key: 'segment', label: 'Segment', type: 'select', options: master.segments }, { key: 'customerType', label: 'Customer type', type: 'select', options: CUSTOMER_TYPES },
      { key: 'salesChannel', label: 'Source (sales channel)', type: 'select', options: CHANNELS, required: true }, { key: 'leadSource', label: 'Lead source', type: 'select', options: LEAD_SOURCES, required: true },
      { key: 'referralType', label: 'Referral type', type: 'select', options: REFERRAL_TYPES }, { key: 'dealerId', label: 'Dealer', type: 'select', options: dealerOptions() }, { key: 'sourceDetails', label: 'Source details' },
      { key: 'quantity', label: 'Quantity', type: 'number', required: true }, { key: 'expectedValue', label: 'Expected value (₹)', type: 'number', required: true },
      { key: 'callStatus', label: 'Call status', type: 'select', options: CALL_STATUS }, { key: 'followUpStatus', label: 'Follow-up status', type: 'select', options: FU_STATUS },
      { key: 'nextFollowUp', label: 'Next follow-up date', type: 'date' }, { key: 'siteVisitDate', label: 'Site visit date', type: 'date' },
      { key: 'siteVisitRequired', label: 'Site visit required', type: 'checkbox' }, { key: 'progressNotes', label: 'Progress notes', type: 'textarea' }, { key: 'remarks', label: 'Remarks', type: 'textarea' },
    ], e, (v) => {
      if (v.nextFollowUp && v.nextFollowUp !== e.nextFollowUp && OPEN.includes(e.stage)) scheduleFollowUp(Object.assign({}, e, v), v.nextFollowUp, 'Call', 'Rescheduled from enquiry');
      db.update('enquiries', e.id, v);
      const o = orderOf(e.id); if (o && (v.dealerId || '') !== (o.dealerId || '')) db.update('orders', o.id, { dealerId: v.dealerId || '' }, { note: 'Dealer link updated from enquiry' });
      ui.toast('Enquiry updated', 'ok'); CRM.refresh();
    }, { wide: true });
  }

  function reassignModal(e) {
    const sug = autoAssign(e.division, e.area);
    ui.formModal((e.execId ? 'Reassign ' : 'Assign ') + e.id, [
      { key: 'execId', label: 'Sales executive', type: 'select', options: execOptions(), required: true, hint: 'Suggested by rule: ' + (sug.exec ? sug.exec.name : '—') + ' (' + sug.rule + ')' },
      { key: 'reason', label: 'Reason / note' },
    ], { execId: e.execId || (sug.exec && sug.exec.id) }, (v) => { assignEnquiry(e, v.execId, v.reason ? 'Manual: ' + v.reason : null); ui.toast(e.id + ' assigned to ' + execName(v.execId), 'ok'); CRM.refresh(); });
  }

  // ============================================================ enquiries list
  const decorateEnq = (e) => Object.assign({}, e, { execName: execName(e.execId) });
  function enquiryTable(rows, opts) {
    opts = opts || {};
    return ui.table({
      rows: () => (typeof rows === 'function' ? rows() : rows).map(decorateEnq).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)), pageSize: opts.pageSize || 15,
      onRow: (e) => CRM.go('enquiries', e.id),
      filters: [{ key: 'division', label: 'divisions', options: DIVS }, { key: 'stage', label: 'stages', options: STAGES }, { key: 'salesChannel', label: 'sources', options: CHANNELS }, { key: 'leadSource', label: 'lead sources', options: LEAD_SOURCES }, { key: 'customerType', label: 'customer types', options: CUSTOMER_TYPES }].concat(isExec() ? [] : [{ key: 'execName', label: 'executives', options: execs().map((s) => s.name).concat(['Unassigned']) }]),
      columns: [
        { key: 'id', label: 'Enquiry No', render: (e) => mono(e.id) },
        { key: 'date', label: 'Date', render: (e) => fmt.date(e.date) },
        { key: 'month', label: 'Month' },
        { key: 'accountName', label: 'Account', render: (e) => h('div', {}, [h('b', {}, e.accountName), h('div', { class: 'small muted' }, (e.customerId || 'Prospect') + ' · ' + e.customerType)]) },
        { key: 'contactName', label: 'Contact', render: (e) => h('div', {}, [e.contactName, h('div', { class: 'small muted' }, e.contactNumber)]) },
        { key: 'division', label: 'Division', render: (e) => ui.divTag(e.division) },
        { key: 'product', label: 'Product', render: (e) => h('div', {}, [e.product, h('div', { class: 'small muted' }, e.category + ' · qty ' + e.quantity)]) },
        { key: 'expectedValue', label: 'Expected', cls: 'right', render: (e) => fmt.money(e.expectedValue), footer: (rs) => fmt.lakh(sum(rs, 'expectedValue')) },
        { key: 'salesChannel', label: 'Source', render: (e) => h('div', {}, [e.salesChannel, h('div', { class: 'small muted' }, e.leadSource)]) },
        { key: 'execName', label: 'Executive', render: (e) => (e.execId ? e.execName : ui.badge('Unassigned', 'warn')) },
        { key: 'stage', label: 'Stage', render: (e) => stageBadge(e.stage) },
        { key: 'nextFollowUp', label: 'Next follow-up', render: (e) => (OPEN.includes(e.stage) ? fuBadge(e.nextFollowUp) : '—') },
      ],
    });
  }
  function exportEnquiries(list) {
    const cols = ['id', 'date', 'month', 'execName', 'accountName', 'customerId', 'contactName', 'contactNumber', 'email', 'area', 'salesChannel', 'leadSource', 'sourceDetails', 'segment', 'division', 'category', 'product', 'quantity', 'expectedValue', 'stage', 'callStatus', 'progressNotes', 'siteVisitDate', 'nextFollowUp', 'followUpStatus', 'remarks'];
    downloadCsv('enquiries.csv', ['Enquiry No', 'Enquiry Date', 'Enquiry Month', 'Executive Name', 'Account Name', 'Customer ID', 'Contact Name', 'Contact Number', 'Email', 'Area', 'Source', 'Lead Source', 'Source Details', 'Segment', 'Division', 'Category', 'Product', 'Quantity', 'Expected Value', 'Sales Stage', 'Call Status', 'Progress Notes', 'Site Visit Date', 'Next Follow-up Date', 'Follow-up Status', 'Remarks'], list.map(decorateEnq).map((e) => cols.map((k) => e[k])));
  }

  function renderEnquiries(el, params) {
    if (params && params[0]) { renderEnquiryDetail(el, params[0]); return; }
    const list = allEnq();
    ui.page(el, { title: isExec() ? 'My Leads & Enquiries' : 'Leads & Enquiries', sub: isExec() ? 'Only leads assigned to you are visible' : 'Multi-source enquiry capture · auto-assignment by Division + Area', actions: [canWork() ? ui.btn('+ New enquiry', () => enquiryForm(), 'primary') : null, ui.btn('▦ Pipeline board', () => CRM.go('pipeline')), ui.btn('⇩ Export CSV', () => exportEnquiries(allEnq()))] });
    const mk = monthKey(CRM.TODAY);
    const open = list.filter((e) => OPEN.includes(e.stage)), won = list.filter((e) => e.stage === 'Order Won'), lost = list.filter((e) => e.stage === 'Order Lost');
    el.appendChild(ui.kpis([
      { label: 'Enquiries this month', value: list.filter((e) => monthKey(e.date) === mk).length, meta: list.length + ' total' },
      { label: 'Open prospects', value: open.length, meta: fmt.lakh(sum(open, 'expectedValue')) + ' pipeline', color: 'var(--chart-5)' },
      { label: 'Won', value: won.length, meta: 'Conversion ' + fmt.pct(util.pct(won.length, won.length + lost.length)), tone: 'up', color: 'var(--ok)' },
      { label: 'Lost', value: lost.length, color: 'var(--bad)' },
      { label: 'Follow-ups overdue', value: open.filter((e) => e.nextFollowUp && e.nextFollowUp < todayIso()).length, color: 'var(--warn)', onClick: () => CRM.go('followups') },
      !isExec() ? { label: 'Awaiting assignment', value: db.find('enquiries', (e) => !e.execId && OPEN.includes(e.stage)).length, color: 'var(--chart-4)' } : null,
    ].filter(Boolean)));
    const tabs = [{ id: 'all', label: 'All', count: list.length }, { id: 'open', label: 'Open', count: open.length }, { id: 'won', label: 'Won', count: won.length }, { id: 'lost', label: 'Lost', count: lost.length }];
    if (isCoord()) tabs.push({ id: 'assign', label: 'Assignment & Sales OTS', count: db.find('enquiries', (e) => !e.execId && OPEN.includes(e.stage)).length + pendingOts().length });
    el.appendChild(ui.tabs(tabs, (id, body) => {
      if (id === 'assign') { renderAssignment(body); return; }
      const rows = id === 'open' ? open : id === 'won' ? won : id === 'lost' ? lost : list;
      body.appendChild(card(null, enquiryTable(rows), { flush: true }));
    }));
  }

  // ---------- Sales OTS (from Service) + assignment queue for the Sales Coordinator
  // Service OTS record fields (service.js createOts): qty, value, brand, productType, capacity, contact, customerId, urgency, complaintId, createdBy, status
  const isSalesOts = (o) => o.otsType === 'Sales OTS' || /sales/i.test(String(o.department || o.type || ''));
  const otsEnquiry = (o) => db.one('enquiries', (e) => e.otsId === o.id);
  const otsCustomer = (o) => master.customer(o.customerId) || (o.customerName ? master.customers().find((x) => x.name === o.customerName) : null) || {};
  const otsQty = (o) => Number(o.qty != null ? o.qty : o.batteryQty) || 0;
  const otsValue = (o) => Number(o.value != null ? o.value : o.estimatedValue) || 0;
  function pendingOts() {
    return db.all('ots').filter((o) => isSalesOts(o) && !/won|lost|closed/i.test(String(o.status || '')) && !otsEnquiry(o));
  }
  function convertOts(o) {
    if (otsEnquiry(o)) { ui.toast('Sales OTS ' + o.id + ' is already converted to ' + otsEnquiry(o).id, 'warn'); return; }
    const bq = otsQty(o) || 3;
    const brand = String(o.brand || o.batteryBrand || '').toLowerCase();
    const bats = master.products().filter((x) => x.category === 'Battery');
    const p = bats.find((x) => brand && x.name.toLowerCase().includes(brand) && (!o.capacity || x.name.toLowerCase().includes(String(o.capacity).toLowerCase()))) || bats.find((x) => brand && x.name.toLowerCase().includes(brand)) || bats[0] || master.products('Power')[0];
    const c = otsCustomer(o);
    enquiryForm({ customerId: c.id || '', accountName: c.name || o.customerName || '', contactNumber: o.contact || o.contactNumber || c.phone, area: c.area, division: 'Power', category: 'Battery', productId: p.id, quantity: bq, expectedValue: otsValue(o) || p.price * bq, salesChannel: 'OTS', leadSource: 'Existing Customer Business', sourceDetails: 'Sales OTS ' + o.id + (o.complaintId ? ' · complaint ' + o.complaintId : '') + ' · ' + bq + ' × ' + (o.productType || 'Battery') + ' ' + (o.brand || '') + ' ' + (o.capacity || '') + ' (> 2 → Sales OTS)' + (o.urgency ? ' · urgency ' + o.urgency : ''), otsId: o.id, siteVisitRequired: false, remarks: o.notes || '' }, { title: 'Convert Sales OTS ' + o.id + ' to enquiry' });
  }
  // OTS incentive (OTS §8): sales % on won value; shared case (engineer raised, executive closed) split by a configurable %
  function otsIncentivePlan() {
    const ic = cfg('sales.otsIncentive');
    const svc = (db.get('serviceConfig', 'CFG') || {}).otsIncentive || {};
    const salesPct = ic.salesPct != null && ic.salesPct !== '' ? Number(ic.salesPct) : (svc.salesPct != null ? Number(svc.salesPct) : 1.5);
    const share = ic.engineerSharePct != null && ic.engineerSharePct !== '' ? Number(ic.engineerSharePct) : (svc.sharedSplit != null ? Number(svc.sharedSplit) : 50);
    return { salesPct, engineerSharePct: share };
  }
  function otsIncentive(o) {
    const e = otsEnquiry(o), ord = e && orderOf(e.id);
    const won = ord && ord.approval !== 'Rejected';
    const plan = otsIncentivePlan();
    const revenue = won ? Number(ord.value) || 0 : 0;
    const total = o.incentiveEligible === 'No' ? 0 : Math.round(revenue * plan.salesPct / 100);
    const shared = !!(o.createdBy && e && e.execId && o.createdBy !== e.execId);
    const eng = shared ? Math.round(total * plan.engineerSharePct / 100) : 0;
    return { revenue, total, shared, engineer: o.createdBy || '', engineerAmt: eng, exec: e ? e.execId : '', execAmt: total - eng, pct: plan.salesPct, split: plan.engineerSharePct };
  }
  const otsRow = (o) => { const e = otsEnquiry(o), ord = e && orderOf(e.id), c = otsCustomer(o); return Object.assign({}, o, { cust: c.name || o.customerName || '—', q: otsQty(o), v: otsValue(o), enq: e, ord, execId: e ? e.execId : '', execName: e ? execName(e.execId) : 'Not assigned', stage: e ? e.stage : 'Awaiting assignment', age: util.hoursBetween(o.createdAt, new Date()), inc: otsIncentive(o) }); };
  function renderSalesOts(el, params) {
    const all = db.all('ots').filter(isSalesOts).map(otsRow).filter((r) => !isExec() || r.execId === me());
    const pend = all.filter((r) => !r.enq && !/won|lost|closed/i.test(String(r.status || '')));
    const prog = all.filter((r) => r.enq && OPEN.includes(r.enq.stage));
    const won = all.filter((r) => r.enq && r.enq.stage === 'Order Won');
    const lost = all.filter((r) => (r.enq && r.enq.stage === 'Order Lost') || (!r.enq && /lost/i.test(String(r.status || ''))));
    const plan = otsIncentivePlan();
    ui.page(el, { title: isExec() ? 'My Sales OTS' : 'Sales OTS Desk', sub: 'Opportunities raised by Service (battery qty > 2) → Sales Coordinator assigns → executive quotes, negotiates and books the order · outcome flows back to the Service OTS record', actions: [ui.btn('⇩ Export CSV', () => downloadCsv('sales-ots.csv', ['OTS', 'Created', 'Customer', 'Qty', 'Brand', 'Capacity', 'Est. value', 'Urgency', 'Complaint', 'Raised by', 'Enquiry', 'Executive', 'Stage', 'Order', 'Order value', 'Incentive total', 'Engineer share', 'Executive share'], all.map((r) => [r.id, util.iso(r.createdAt), r.cust, r.q, r.brand, r.capacity, r.v, r.urgency, r.complaintId, execName(r.createdBy), r.enq ? r.enq.id : '', r.execName, r.stage, r.ord ? (r.ord.soNumber || r.ord.id) : '', r.inc.revenue, r.inc.total, r.inc.engineerAmt, r.inc.execAmt])), 'sm')] });
    el.appendChild(ui.kpis([
      { label: 'Awaiting assignment', value: pend.length, meta: pend.filter((r) => r.age > 24).length + ' waiting > 24 h', color: 'var(--chart-4)' },
      { label: 'In progress', value: prog.length, meta: fmt.lakh(sum(prog, 'v')) + ' estimated', color: 'var(--chart-5)' },
      { label: 'Won (orders booked)', value: won.length, meta: fmt.lakh(sum(won, (r) => r.inc.revenue)), color: 'var(--ok)' },
      { label: 'Lost', value: lost.length, color: 'var(--bad)' },
      { label: 'Conversion', value: fmt.pct(util.pct(won.length, won.length + lost.length)) },
      { label: 'Incentive (' + plan.salesPct + '% · shared ' + plan.engineerSharePct + '/' + (100 - plan.engineerSharePct) + ')', value: fmt.lakh(sum(won, (r) => r.inc.total)), color: 'var(--chart-2)' },
    ]));
    const otsLink = (o) => (canOpen('#/ots/' + o.id, CRM.role().id) ? h('a', { class: 'mono', href: '#/ots/' + o.id }, o.id) : mono(o.id));
    const base = [{ key: 'id', label: 'OTS', render: otsLink }, { key: 'createdAt', label: 'Raised', render: (r) => fmt.date(r.createdAt) }, { key: 'cust', label: 'Customer', render: (r) => h('div', {}, [h('b', {}, r.cust), h('div', { class: 'small muted' }, (r.contact || '') + (r.complaintId ? ' · ' + r.complaintId : ''))]) }, { key: 'q', label: 'Requirement', render: (r) => r.q + ' × ' + (r.productType || 'Battery') + ' ' + (r.brand || '') + ' ' + (r.capacity || '') }, { key: 'v', label: 'Est. value', cls: 'right', render: (r) => fmt.money(r.v), footer: (rs) => fmt.lakh(sum(rs, 'v')) }, { key: 'urgency', label: 'Urgency', render: (r) => ui.badge(r.urgency || '—', /hot|high|urgent/i.test(r.urgency || '') ? 'bad' : 'warn') }, { key: 'createdBy', label: 'Raised by', render: (r) => execName(r.createdBy) }];
    el.appendChild(ui.tabs([{ id: 'pend', label: 'Assignment queue', count: pend.length }, { id: 'prog', label: 'In progress', count: prog.length }, { id: 'won', label: 'Won & incentive', count: won.length }, { id: 'lost', label: 'Lost', count: lost.length }], (id, body) => {
      if (id === 'pend') {
        body.appendChild(calloutH('Each Sales OTS is an assignment task for the Sales Coordinator: convert it into an enquiry (auto- or manually assigned). The Service OTS record is updated through the <b>ots.converted</b> / <b>ots.outcome</b> events.', 'info'));
        body.appendChild(h('div', { class: 'mt' }, card(null, ui.table({ rows: pend, empty: 'No Sales OTS waiting for assignment', columns: base.concat([{ key: 'age', label: 'Waiting', render: (r) => ui.badge(hrsText(r.age), r.age > 24 ? 'bad' : 'warn'), sort: (r) => r.age }]), actions: isCoord() ? (r) => [ui.btn('Convert & assign', () => convertOts(db.get('ots', r.id)), 'sm primary')] : null }), { flush: true })));
      } else if (id === 'prog') {
        body.appendChild(card(null, ui.table({ rows: prog, onRow: (r) => CRM.go('enquiries', r.enq.id), columns: base.concat([{ key: 'execName', label: 'Executive' }, { key: 'stage', label: 'Stage', render: (r) => stageBadge(r.stage) }, { key: 'nf', label: 'Next follow-up', render: (r) => fuBadge(r.enq.nextFollowUp) }]), actions: canWork() ? (r) => [!sentQuote(r.enq.id) ? ui.btn('Quote', () => quoteModal(db.get('enquiries', r.enq.id)), 'sm') : null, ui.btn('Book order', () => moveStage(db.get('enquiries', r.enq.id), 'Order Won'), 'sm ok')] : null }), { flush: true }));
      } else if (id === 'won') {
        body.appendChild(card('Orders booked from Sales OTS · incentive ' + plan.salesPct + '% of order value · shared case: engineer ' + plan.engineerSharePct + '% / executive ' + (100 - plan.engineerSharePct) + '%', ui.table({ rows: won, columns: [{ key: 'id', label: 'OTS', render: otsLink }, { key: 'cust', label: 'Customer' }, { key: 'ord', label: 'Order', render: (r) => (r.ord ? lnk('orders', r.ord.id) : '—') }, { key: 'rev', label: 'Order value', cls: 'right', render: (r) => fmt.money(r.inc.revenue), sort: (r) => r.inc.revenue, footer: (rs) => fmt.lakh(sum(rs, (r) => r.inc.revenue)) }, { key: 'createdBy', label: 'Engineer (raised)', render: (r) => execName(r.createdBy) }, { key: 'execName', label: 'Executive (closed)' }, { key: 'tot', label: 'Incentive', cls: 'right', render: (r) => fmt.money(r.inc.total), footer: (rs) => fmt.money(sum(rs, (r) => r.inc.total)) }, { key: 'eng', label: 'Engineer share', cls: 'right', render: (r) => (r.inc.shared ? fmt.money(r.inc.engineerAmt) : '—') }, { key: 'ex', label: 'Executive share', cls: 'right', render: (r) => fmt.money(r.inc.execAmt) }, { key: 'sp', label: 'Split', render: (r) => (r.inc.shared ? ui.badge('Shared ' + r.inc.split + '/' + (100 - r.inc.split), 'violet') : ui.badge('Single', 'info')) }] }), { flush: true, actions: isMgr() ? [ui.btn('Incentive rules', () => otsIncentiveModal(), 'sm')] : null }));
      } else {
        body.appendChild(card(null, ui.table({ rows: lost, columns: base.concat([{ key: 'execName', label: 'Executive' }, { key: 'lr', label: 'Lost reason', render: (r) => (r.enq ? r.enq.lostReason || '—' : r.lostReason || '—') }]) }), { flush: true }));
      }
    }, params && params[0] && !pend.some((r) => r.id === params[0]) ? 'prog' : 'pend'));
  }
  function otsIncentiveModal() {
    const ic = cfg('sales.otsIncentive'), plan = otsIncentivePlan();
    ui.formModal('Sales OTS incentive rules', [
      { key: 'salesPct', label: 'Sales OTS incentive (% of order value) — blank = Service OTS setting', type: 'number', step: 'any', min: 0, max: 100 },
      { key: 'engineerSharePct', label: 'Shared case: engineer share (%) — executive gets the rest', type: 'number', min: 0, max: 100, required: true },
    ], { salesPct: ic.salesPct, engineerSharePct: plan.engineerSharePct }, (v) => {
      if (v.engineerSharePct < 0 || v.engineerSharePct > 100 || (v.salesPct != null && (v.salesPct < 0 || v.salesPct > 100))) { ui.toast('Percentages must be between 0 and 100', 'bad'); return false; }
      setCfg('sales.otsIncentive', { salesPct: v.salesPct, engineerSharePct: v.engineerSharePct }); ui.toast('Incentive rules saved', 'ok'); CRM.refresh();
    });
  }
  function renderAssignment(body) {
    const unassigned = db.find('enquiries', (e) => !e.execId && OPEN.includes(e.stage));
    body.appendChild(calloutH('<b>Lead assignment automation:</b> new leads are routed to the Sales Executive whose <b>Division + Area</b> match; otherwise to the least-loaded executive in the division. <b>Sales OTS</b> (battery qty &gt; 2) raised by service engineers lands here for the Sales Coordinator to assign.', 'info'));
    body.appendChild(h('div', { class: 'mt' }, card('Leads awaiting assignment (' + unassigned.length + ')', ui.table({
      rows: unassigned, search: false, empty: 'No unassigned leads — every lead has an owner',
      columns: [{ key: 'id', label: 'Enquiry', render: (e) => lnk('enquiries', e.id) }, { key: 'accountName', label: 'Account' }, { key: 'division', label: 'Division', render: (e) => ui.divTag(e.division) }, { key: 'area', label: 'Area' }, { key: 'salesChannel', label: 'Source' }, { key: 'sourceDetails', label: 'Details' }, { key: 'createdAt', label: 'Waiting', render: (e) => ui.badge(hrsText(util.hoursBetween(e.createdAt, new Date())), util.hoursBetween(e.createdAt, new Date()) > 24 ? 'bad' : 'warn') }, { key: 's', label: 'Rule suggests', render: (e) => { const a = autoAssign(e.division, e.area); return a.exec ? a.exec.name + ' · ' + a.rule : '—'; } }],
      actions: (e) => [ui.btn('Auto-assign', () => { const a = autoAssign(e.division, e.area); assignEnquiry(e, a.exec.id, a.rule); ui.toast(e.id + ' → ' + a.exec.name, 'ok'); CRM.refresh(); }, 'sm primary'), ui.btn('Choose…', () => reassignModal(e), 'sm')],
    }), { flush: true, actions: unassigned.length ? [ui.btn('Auto-assign all', () => { unassigned.forEach((e) => { const a = autoAssign(e.division, e.area); assignEnquiry(e, a.exec.id, a.rule); }); ui.toast(unassigned.length + ' leads assigned', 'ok'); CRM.refresh(); }, 'sm primary')] : null })));
    const ots = pendingOts().map(otsRow);
    body.appendChild(h('div', { class: 'mt' }, card('Sales OTS from Service (' + ots.length + ')', ots.length ? ui.table({ rows: ots, search: false, columns: [{ key: 'id', label: 'OTS ID', render: (o) => mono(o.id) }, { key: 'cust', label: 'Customer' }, { key: 'q', label: 'Battery qty' }, { key: 'brand', label: 'Brand', render: (o) => [o.brand, o.capacity].filter(Boolean).join(' ') || '—' }, { key: 'v', label: 'Est. value', render: (o) => fmt.money(o.v) }, { key: 'urgency', label: 'Urgency', render: (o) => ui.badge(o.urgency || '—', /hot|high|urgent/i.test(o.urgency || '') ? 'bad' : 'warn') }, { key: 'age', label: 'Waiting', render: (o) => ui.badge(hrsText(o.age), o.age > 24 ? 'bad' : 'warn') }], actions: (o) => [ui.btn('Convert & assign', () => convertOts(db.get('ots', o.id)), 'sm primary')] }) : ui.empty('No Sales OTS pending. Service OTS with battery qty > 2 appear here automatically.', '🔧'), { flush: true, actions: [ui.btn('Sales OTS desk', () => CRM.go('salesots'), 'sm')] })));
    const matrix = h('table', { class: 'tbl' }, [h('thead', {}, h('tr', {}, [h('th', {}, 'Area')].concat(DIVS.map((d) => h('th', {}, d))))), h('tbody', {}, master.areas.map((a) => h('tr', {}, [h('td', {}, h('b', {}, a))].concat(DIVS.map((d) => { const r = autoAssign(d, a); return h('td', {}, [r.exec ? r.exec.name : '—', h('div', { class: 'small muted' }, r.rule)]); })))))]);
    body.appendChild(h('div', { class: 'grid g2 mt' }, [card('Assignment matrix (Division × Area → Executive)', h('div', { class: 'table-wrap' }, matrix), { flush: true }), card('Executive workload (open leads)', ui.hbars(execs().map((s) => ({ label: s.name + ' · ' + (s.division || ''), value: openLoad(s.id) }))))]));
  }

  // ============================================================ enquiry detail
  function renderEnquiryDetail(el, id) {
    const e = db.get('enquiries', id);
    if (!e || (isExec() && e.execId !== me())) { el.appendChild(ui.empty(e ? 'This lead belongs to another executive (Sales Executives see only their own leads).' : 'Enquiry not found', '🔒')); return; }
    const q = sentQuote(e.id), o = orderOf(e.id);
    const open = OPEN.includes(e.stage);
    const work = canWork();
    const nextStage = open ? STAGES[Math.min(STAGES.indexOf(e.stage) + 1, 6)] : null;
    ui.page(el, { title: e.accountName, crumbs: 'Leads & Enquiries › ' + e.id, sub: e.division + ' · ' + e.product + ' × ' + e.quantity + ' · ' + execName(e.execId),
      actions: [ui.btn('← Enquiries', () => CRM.go('enquiries'))].concat(commButtons(e), work ? [
        ui.btn('☎ Log call', () => logCallModal({ enquiryId: e.id, customerId: e.customerId, name: e.accountName, phone: e.contactNumber, type: 'Follow-up Call' }), 'sm'),
        open ? ui.btn('+ Follow-up', () => followUpModal(e), 'sm') : null,
        open ? ui.btn('+ Quotation', () => quoteModal(e), 'sm') : null,
        ui.btn('Edit', () => editEnquiry(e), 'sm'),
        isCoord() ? ui.btn(e.execId ? 'Reassign' : 'Assign', () => reassignModal(e), 'sm') : null,
        open && nextStage ? ui.btn('Advance → ' + nextStage, () => moveStage(e, nextStage), 'primary') : null,
        e.stage === 'Order Lost' && isMgr() ? ui.btn('Reopen', () => moveStage(e, lostQuote(e.id) ? 'Negotiation' : 'Contact Made'), 'primary') : null,
      ] : []) });
    const steps = STAGES.slice(0, 6).concat([e.stage === 'Order Lost' ? 'Order Lost' : 'Order Won']);
    const cur = e.stage === 'Order Won' ? 7 : e.stage === 'Order Lost' ? 6 : STAGES.indexOf(e.stage);
    el.appendChild(card(null, ui.stepper(steps, cur, e.stage === 'Order Lost')));
    const breaches = policyBreaches().filter((b) => b.rec.id === e.id);
    breaches.forEach((b) => el.appendChild(h('div', { class: 'mt' }, calloutH('<b>' + b.type + ' (' + b.ref + ')</b> — ' + util.esc(b.details) + ' · escalated to ' + LEVELS[b.level].label, b.level >= 3 ? 'bad' : 'warn'))));
    if (open && work) {
      const sel = h('select', {}, [h('option', { value: '' }, 'Move to stage…')].concat(STAGES.filter((s) => s !== e.stage).map((s) => h('option', { value: s }, s))));
      sel.addEventListener('change', () => { if (sel.value) moveStage(e, sel.value); sel.value = ''; });
      el.appendChild(h('div', { class: 'row mt' }, [h('span', { class: 'small muted' }, 'Quick stage change (gates apply):'), sel]));
    }
    const resp = q ? quoteResponseHrs(q) : null;
    el.appendChild(h('div', { class: 'grid g3 mt' }, [
      h('div', { class: 'span2' }, card('Enquiry details', ui.dl([
        ['Enquiry No', e.id], ['Enquiry date', fmt.date(e.date)], ['Enquiry month', e.month], ['Executive name', execName(e.execId)],
        ['Account name', e.accountName], ['Customer ID', e.customerId ? lnk('customer360', e.customerId) : ui.badge('Prospect', 'info')], ['Contact name', e.contactName], ['Contact number', e.contactNumber],
        ['Email', e.email], ['Area', e.area], ['Source', e.salesChannel + ' · ' + (e.businessType || '')], ['Lead source', e.leadSource],
        ['Source details', [e.referralType, e.sourceDetails].filter(Boolean).join(' · ')], ['Segment', e.segment], ['Division', ui.divTag(e.division)], ['Category', e.category],
        ['Product', e.product], ['Quantity', e.quantity], ['Expected value', fmt.money(e.expectedValue)], ['Customer type', ui.badge(e.customerType)],
        ['Assignment', e.assignRule || '—'], ['Remarks', e.remarks],
      ].concat(e.otsId ? [['Sales OTS', canOpen('#/ots/' + e.otsId, CRM.role().id) ? lnk('ots', e.otsId) : e.otsId]] : [], e.dealerId ? [['Dealer', (db.get('dealers', e.dealerId) || {}).name || e.dealerId]] : [])))),
      h('div', { class: 'stack' }, [
        card('Pipeline status', ui.dl([['Sales stage', stageBadge(e.stage)], ['Call status', e.callStatus ? ui.badge(e.callStatus, e.callStatus === 'Connected' ? 'ok' : 'warn') : '—'], ['Site visit date', e.siteVisitDate ? fmt.date(e.siteVisitDate) + (e.siteVisitDoneAt ? ' ✓' : '') : (e.siteVisitRequired ? 'Required · not scheduled' : 'Not required')], ['Next follow-up', open ? fuBadge(e.nextFollowUp) : '—'], ['Follow-up status', ui.badge(e.followUpStatus || '—', e.followUpStatus === 'Missed' ? 'bad' : null)], ['Progress notes', e.progressNotes]].concat(e.stage === 'Order Lost' ? [['Lost reason', ui.badge(e.lostReason, 'bad')], ['Lost details', [e.competitor, e.lostDetails].filter(Boolean).join(' · ')]] : e.stage === 'Order Won' ? [['Won details', e.wonDetails]] : []))),
        card('Cycle times (auto)', ui.dl([['Quote response time', respBadge(resp)], ['Quote given date', q ? fmt.dateTime(q.quoteDate) : '—'], ['SO processing time', o ? respBadge(soProcessingHrs(o)) : '—'], ['Lead conversion time', o ? (conversionDays(o) + ' days') : open ? 'Open · ' + util.daysBetween(e.createdAt, CRM.TODAY) + ' days old' : '—']])),
      ]),
    ]));
    const fus = db.find('followups', (f) => f.enquiryId === e.id).sort((a, b) => (a.dueDate < b.dueDate ? 1 : -1));
    const quotes = quotesOf(e.id);
    const ups = db.find('upsells', (u) => u.enquiryId === e.id || (o && u.orderId === o.id));
    section(el, ui.tabs([
      { id: 'fu', label: 'Follow-ups', count: fus.length }, { id: 'q', label: 'Quotations', count: quotes.length }, { id: 'o', label: 'Order & payment' },
      { id: 'c', label: 'Communications', count: (e.comms || []).length }, { id: 'u', label: 'Upsell / cross-sell', count: ups.length }, { id: 'h', label: 'Stage history' }, { id: 'a', label: 'Audit trail' },
    ], (tid, body) => {
      if (tid === 'fu') body.appendChild(card(null, followUpTable(fus, { search: false }), { flush: true }));
      if (tid === 'q') body.appendChild(card(null, quoteTable(quotes, { search: false }), { flush: true }));
      if (tid === 'o') body.appendChild(o ? orderSummary(o) : ui.empty(open ? 'No order yet — move the enquiry to "Order Won" to create the sale order.' : 'No order for this enquiry.', '📦'));
      if (tid === 'c') body.appendChild(card(null, (e.comms || []).length ? ui.timeline(e.comms.slice().reverse().map((c) => ({ when: fmt.dateTime(c.at) + ' · ' + c.by, title: c.channel + ' → ' + (c.to || '—'), body: c.text, color: c.channel === 'WhatsApp' ? 'var(--ok)' : 'var(--chart-5)' }))) : ui.empty('No communications logged yet. Use WhatsApp / Email above.', '💬')));
      if (tid === 'u') body.appendChild(card(null, upsellTable(ups, { search: false }), { flush: true, actions: work ? [ui.btn('+ Upsell / cross-sell', () => upsellModal({ enquiryId: e.id, customerId: e.customerId, accountName: e.accountName, baseProduct: e.product, orderId: o ? o.id : '' }), 'sm')] : null }));
      if (tid === 'h') body.appendChild(card(null, ui.timeline((e.stageHistory || []).slice().reverse().map((s) => ({ when: fmt.dateTime(s.at) + ' · ' + (s.by || ''), title: s.stage, body: s.note, color: STAGE_COLORS[STAGES.indexOf(s.stage)] })))));
      if (tid === 'a') body.appendChild(card(null, ui.auditTrail('enquiries', e.id)));
    }));
  }

  // ============================================================ pipeline kanban (8 stages)
  function renderPipeline(el) {
    ui.page(el, { title: isExec() ? 'My Pipeline' : 'Sales Pipeline', sub: 'Drag cards between the 8 stages · gates: quotation before "Quotation Sent", PO & details for "Order Won", reason for "Order Lost"', actions: [canWork() ? ui.btn('+ New enquiry', () => enquiryForm(), 'primary') : null] });
    const st = { division: '', exec: '', q: '', closedDays: 45 };
    const bar = h('div', { class: 'filters', style: 'border:0;padding:0 0 12px' }, [
      h('input', { type: 'search', placeholder: 'Search account / product…', onInput: util.debounce((ev) => { st.q = ev.target.value.toLowerCase(); draw(); }, 150) }),
      h('select', { onChange: (ev) => { st.division = ev.target.value; draw(); } }, [h('option', { value: '' }, 'All divisions')].concat(DIVS.map((d) => h('option', { value: d }, d)))),
      isExec() ? null : h('select', { onChange: (ev) => { st.exec = ev.target.value; draw(); } }, [h('option', { value: '' }, 'All executives')].concat(execs().map((s) => h('option', { value: s.id }, s.name)))),
      h('select', { onChange: (ev) => { st.closedDays = Number(ev.target.value); draw(); } }, [['45', 'Won/Lost: last 45 days'], ['90', 'Won/Lost: last 90 days'], ['9999', 'Won/Lost: all']].map(([v, l]) => h('option', { value: v }, l))),
    ]);
    const kp = h('div'), host = h('div');
    el.appendChild(bar); el.appendChild(kp); el.appendChild(host);
    function draw() {
      const items = allEnq().filter((e) => (!st.division || e.division === st.division) && (!st.exec || e.execId === st.exec) && (!st.q || (e.accountName + e.product + e.id).toLowerCase().includes(st.q)) && (OPEN.includes(e.stage) || util.daysBetween(e.closedAt || e.updatedAt, CRM.TODAY) <= st.closedDays));
      const open = items.filter((e) => OPEN.includes(e.stage));
      kp.innerHTML = '';
      kp.appendChild(ui.kpis([
        { label: 'Open opportunities', value: open.length }, { label: 'Pipeline value', value: fmt.lakh(sum(open, 'expectedValue')), color: 'var(--chart-5)' },
        { label: 'In negotiation', value: fmt.lakh(sum(open.filter((e) => e.stage === 'Negotiation'), 'expectedValue')), color: 'var(--warn)' },
        { label: 'Follow-ups overdue', value: open.filter((e) => e.nextFollowUp && e.nextFollowUp < todayIso()).length, color: 'var(--bad)' },
      ]));
      host.innerHTML = '';
      host.appendChild(ui.kanban({
        columns: STAGES.map((s, i) => ({ id: s, label: s, color: STAGE_COLORS[i] })), items, colOf: (e) => e.stage,
        sum: (its) => fmt.lakh(sum(its, 'expectedValue')),
        card: (e) => [
          h('div', { class: 't' }, e.accountName),
          h('div', { class: 'small muted' }, e.id + ' · ' + e.product + ' × ' + e.quantity),
          h('div', { class: 'row', style: 'justify-content:space-between;margin-top:6px' }, [ui.divTag(e.division), h('b', {}, fmt.lakh(e.expectedValue))]),
          h('div', { class: 'row small muted', style: 'justify-content:space-between;margin-top:4px' }, [h('span', {}, execName(e.execId)), OPEN.includes(e.stage) && e.nextFollowUp ? fuBadge(e.nextFollowUp) : null]),
          e.callStatus && OPEN.includes(e.stage) ? h('div', { class: 'small muted', style: 'margin-top:3px' }, '☎ ' + e.callStatus + (e.siteVisitDate ? ' · visit ' + fmt.date(e.siteVisitDate) : '')) : null,
          e.stage === 'Order Lost' && e.lostReason ? h('div', { class: 'small', style: 'color:var(--bad);margin-top:3px' }, e.lostReason) : null,
        ],
        onMove: canWork() ? (e, to) => moveStage(db.get('enquiries', e.id), to, draw) : null,
        onClick: (e) => CRM.go('enquiries', e.id),
      }));
    }
    draw();
  }

  // ============================================================ quotations
  // Quotation documents: Core v2 file store (CRM.files) when present; fallback keeps files ≤ 1.5 MB in the salesFiles collection
  const QUOTE_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png';
  function storeQuoteFile(qid, file, note, onDone) {
    const done = (meta) => { db.update('quotations', qid, Object.assign({ fileName: file.name, fileSize: file.size, fileType: file.type || '', fileAt: nowIso() }, meta || {}), { note: note || 'Quotation uploaded: ' + file.name }); if (onDone) onDone(); };
    const local = () => {
      if (file.size > 1.5e6) { ui.toast('File is larger than 1.5 MB — only the file name is recorded in this demo store', 'warn'); done({ fileId: '' }); return; }
      const r = new FileReader();
      r.onload = () => { const f = db.insert('salesFiles', { recordType: 'quotations', recordId: qid, name: file.name, type: file.type || '', size: file.size, data: r.result }, { prefix: 'SFL', silent: true }); done({ fileId: f.id }); };
      r.onerror = () => done({ fileId: '' });
      r.readAsDataURL(file);
    };
    if (CRM.files && CRM.files.add) {
      // Core v2: files.add(file, meta) → Promise<attachment> (IndexedDB, 1.5 MB per file, versioned per label, access audited)
      Promise.resolve().then(() => CRM.files.add(file, { recordType: 'quotations', recordId: qid, label: 'Quotation document', note: note || '' }))
        .then((x) => done({ fileId: (x && x.id) || '', fileStore: 'core' }), (err) => ui.toast((err && err.message) || 'Could not store the file', 'bad'));
      return;
    }
    local();
  }
  function openQuoteFile(q) {
    if (q.fileStore === 'core' && CRM.files && CRM.files.open) { Promise.resolve(CRM.files.open(q.fileId)).catch((err) => ui.toast((err && err.message) || 'Could not open the file', 'bad')); return; }
    const f = q.fileId && db.get('salesFiles', q.fileId);
    if (!f || !f.data) { ui.toast('Only the file name was recorded for this quotation', 'warn'); return; }
    const a = h('a', { href: f.data, download: f.name, target: '_blank', rel: 'noopener' }); document.body.appendChild(a); a.click(); a.remove();
  }
  const quoteFileLink = (q) => (!q.fileName ? '—' : q.fileId ? h('a', { href: '#', onClick: (ev) => { ev.preventDefault(); openQuoteFile(q); } }, '📎 ' + q.fileName) : h('span', {}, '📎 ' + q.fileName));
  function quoteTable(rows, opts) {
    opts = opts || {};
    return ui.table({
      rows: () => (typeof rows === 'function' ? rows() : rows).map((q) => Object.assign({}, q, { execName: execName(q.execId), resp: quoteResponseHrs(q) })).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
      search: opts.search, onRow: (q) => quoteDrawer(db.get('quotations', q.id)),
      filters: opts.search === false ? null : [{ key: 'status', label: 'statuses', options: QUOTE_STATUS }, { key: 'approval', label: 'approvals', options: ['Awaiting Approval', 'Approved', 'Rejected'] }, { key: 'division', label: 'divisions', options: DIVS }],
      columns: [
        { key: 'id', label: 'Quote No', render: (q) => mono(q.id + (q.revision ? ' R' + q.revision : '')) },
        { key: 'enquiryId', label: 'Enquiry', render: (q) => lnk('enquiries', q.enquiryId) },
        { key: 'accountName', label: 'Account' }, { key: 'division', label: 'Division', render: (q) => ui.divTag(q.division) },
        { key: 'lines', label: 'Product details', render: (q) => (q.lines || []).map((l) => l.name + ' × ' + l.qty).join(', ').slice(0, 60) },
        { key: 'basicValue', label: 'Basic', cls: 'right', render: (q) => fmt.money(q.basicValue) },
        { key: 'quoteValue', label: 'Quote value', cls: 'right', render: (q) => fmt.money(q.quoteValue), footer: (rs) => fmt.lakh(sum(rs, 'quoteValue')) },
        { key: 'quoteDate', label: 'Quote given', render: (q) => (q.quoteDate ? fmt.date(q.quoteDate) : '—') },
        { key: 'resp', label: 'Response time', render: (q) => respBadge(q.resp), sort: (q) => q.resp || 0 },
        { key: 'status', label: 'Status', render: (q) => ui.badge(q.status) },
        { key: 'approval', label: 'Mgr approval', render: (q) => ui.badge(q.approval, q.approval === 'Approved' ? 'ok' : q.approval === 'Rejected' ? 'bad' : 'warn') },
        { key: 'execName', label: 'Executive' },
      ],
    });
  }
  function renderQuotations(el, params) {
    const list = allQuotes();
    ui.page(el, { title: 'Quotations', sub: 'Quote given date and quote response time are automatic · every quotation is approved by the Sales Manager before release', actions: [canWork() ? ui.btn('+ New quotation', () => quoteModal(), 'primary') : null, ui.btn('⇩ Export CSV', () => downloadCsv('quotations.csv', ['Quote No', 'Enquiry', 'Account', 'Division', 'Basic Value', 'Quote Value', 'Quote Given Date', 'Response Time (h)', 'Status', 'Approval', 'Warranty Contract', 'Delivery Commitment', 'Scrap Details', 'Executive'], list.map((q) => [q.id, q.enquiryId, q.accountName, q.division, q.basicValue, q.quoteValue, util.iso(q.quoteDate), quoteResponseHrs(q), q.status, q.approval, q.warrantyContract, q.deliveryCommitment, q.scrapApplicable === 'Yes' ? q.scrapQty + ' ' + q.scrapType + ' · ' + (q.scrapDetails || '') : 'No', execName(q.execId)]))) ] });
    const mk = monthKey(CRM.TODAY);
    const given = list.filter((q) => q.quoteDate && monthKey(q.quoteDate) === mk);
    const resp = given.map(quoteResponseHrs);
    const awaiting = list.filter((q) => q.approval === 'Awaiting Approval');
    const pendingResp = list.filter((q) => q.status === 'Sent' && q.quoteDate && util.daysBetween(q.quoteDate, CRM.TODAY) >= SLA.quoteResponseDays);
    el.appendChild(ui.kpis([
      { label: 'Quotes given this month', value: given.length, meta: fmt.lakh(sum(given, 'quoteValue')) },
      { label: 'Avg quote response time', value: hrsText(avg(resp)), meta: util.pct(resp.filter((x) => x <= 24).length, resp.length) + '% within 24 h', color: 'var(--chart-5)' },
      { label: 'Awaiting Sales Manager approval', value: awaiting.length, color: 'var(--warn)' },
      { label: 'Customer response pending', value: pendingResp.length, meta: '> ' + SLA.quoteResponseDays + ' days since sent', color: 'var(--bad)' },
      { label: 'Under discussion', value: fmt.lakh(sum(list.filter((q) => q.status === 'Under Discussion'), 'quoteValue')), color: 'var(--chart-4)' },
    ]));
    el.appendChild(ui.tabs([
      { id: 'all', label: 'All', count: list.length }, { id: 'await', label: 'Awaiting approval', count: awaiting.length }, { id: 'resp', label: 'Response pending', count: pendingResp.length },
      { id: 'appr', label: 'Customer approved', count: list.filter((q) => q.status === 'Approved').length }, { id: 'rej', label: 'Rejected', count: list.filter((q) => q.status === 'Rejected').length },
    ], (id, body) => {
      const rows = id === 'await' ? awaiting : id === 'resp' ? pendingResp : id === 'appr' ? list.filter((q) => q.status === 'Approved') : id === 'rej' ? list.filter((q) => q.status === 'Rejected') : list;
      if (id === 'await' && isMgr() && awaiting.length) body.appendChild(calloutH('Approve or send back each quotation. Approval auto-sets the <b>Quote Given Date</b>, moves the enquiry to <b>Quotation Sent</b> and starts the customer-response clock.', 'warn'));
      body.appendChild(h('div', { class: id === 'await' ? 'mt' : '' }, card(null, quoteTable(rows), { flush: true })));
    }, params && params[0] && (db.get('quotations', params[0]) || {}).approval === 'Awaiting Approval' ? 'await' : 'all'));
    if (params && params[0]) { const q = db.get('quotations', params[0]); if (q && (!isExec() || q.execId === me())) setTimeout(() => quoteDrawer(q), 30); }
  }

  function quoteModal(enq, existing) {
    const options = allEnq().filter((e) => OPEN.includes(e.stage) && e.execId);
    let e = enq || (existing && db.get('enquiries', existing.enquiryId)) || null;
    if (!e && !options.length) { ui.toast('No open, assigned enquiries to quote against', 'warn'); return; }
    if (e && !e.execId) { ui.toast('Assign the enquiry to an executive before quoting', 'bad'); return; }
    e = e || options[0];
    if (!existing && quotesOf(e.id).some((q) => q.approval === 'Awaiting Approval')) { ui.toast('A quotation for ' + e.id + ' is already awaiting manager approval — revise that one instead', 'warn'); return; }
    const discMax = Number(cfg('sales.discount').justifyAbovePct) || 0;
    const defLines = (en) => { const p = master.product(en.productId); return p ? [{ productId: p.id, name: p.name, qty: en.quantity, rate: p.price }] : []; };
    let lines = existing ? util.clone(existing.lines || []) : defLines(e);
    const linesHost = h('div'), totals = h('div', { class: 'callout', style: 'margin-top:10px' });
    let form;
    const vals = () => (form ? form.values() : {});
    function updTotals() {
      const v = vals(); const t = computeQuote(lines, v.discountPct, v.scrapValue, e.division);
      totals.innerHTML = 'Gross ' + fmt.money(t.gross) + ' · Discount ' + (v.discountPct || 0) + '% · <b>Basic value ' + fmt.money(t.basicValue) + '</b> · GST ' + t.gstPct + '% (' + util.esc(e.division) + ') ' + fmt.money(t.gst) + (v.scrapValue ? ' · Scrap buy-back −' + fmt.money(v.scrapValue) : '') + ' · <b>Quote value ' + fmt.money(t.quoteValue) + '</b>' + ((v.discountPct || 0) > discMax ? '<br><b style="color:var(--bad)">Discount beyond ' + discMax + '% — justification required in remarks.</b>' : '');
    }
    function drawLines() {
      linesHost.innerHTML = '';
      const prods = master.products(e.division).concat(e.division === 'Power' ? [] : master.products('Power').filter((p) => p.category === 'Online UPS' || p.category === 'Battery'));
      const t = h('table', { class: 'tbl' }, [h('thead', {}, h('tr', {}, ['Product', 'Qty', 'Rate (₹)', 'Amount', ''].map((x) => h('th', {}, x))))]);
      const tb = h('tbody');
      lines.forEach((l, i) => {
        const sel = h('select', { style: 'width:100%' }, prods.map((p) => h('option', { value: p.id, selected: p.id === l.productId ? true : null }, p.name)));
        const qty = h('input', { type: 'number', min: 1, value: l.qty, style: 'width:70px' });
        const rate = h('input', { type: 'number', min: 0, value: l.rate, style: 'width:110px' });
        const amt = h('td', { class: 'right' }, fmt.money(l.qty * l.rate));
        sel.addEventListener('change', () => { const p = master.product(sel.value); Object.assign(l, { productId: p.id, name: p.name, rate: p.price }); drawLines(); });
        qty.addEventListener('input', () => { l.qty = Number(qty.value) || 0; amt.textContent = fmt.money(l.qty * l.rate); updTotals(); });
        rate.addEventListener('input', () => { l.rate = Number(rate.value) || 0; amt.textContent = fmt.money(l.qty * l.rate); updTotals(); });
        tb.appendChild(h('tr', {}, [h('td', {}, sel), h('td', {}, qty), h('td', {}, rate), amt, h('td', {}, ui.btn('✕', () => { lines.splice(i, 1); drawLines(); }, 'sm ghost'))]));
      });
      t.appendChild(tb);
      linesHost.appendChild(h('div', { class: 'table-wrap' }, t));
      linesHost.appendChild(h('div', { class: 'row', style: 'margin-top:6px' }, ui.btn('+ Add product line', () => { const p = prods[0]; lines.push({ productId: p.id, name: p.name, qty: 1, rate: p.price }); drawLines(); }, 'sm')));
      updTotals();
    }
    const fields = [
      existing || enq ? { key: 'enquiryRef', label: 'Enquiry', type: 'readonly', default: e.id + ' · ' + e.accountName } : { key: 'enquiryId', label: 'Enquiry', type: 'select', required: true, full: true, options: options.map((x) => ({ value: x.id, label: x.id + ' · ' + x.accountName + ' · ' + x.product })), onChange: (val) => { e = db.get('enquiries', val); lines = defLines(e); drawLines(); } },
      { key: 'quoteDateInfo', label: 'Quote given date', type: 'readonly', default: 'Auto — set when the Sales Manager approves & it is sent' },
      { key: 'discountPct', label: 'Discount %', type: 'number', min: 0, max: 40, default: 0, onChange: updTotals },
      { key: 'paymentTerms', label: 'Payment terms', type: 'select', options: Object.keys(PAY_TERMS), required: true, default: 'Credit 30 days' },
      { key: 'warrantyContract', label: 'Warranty contract', type: 'select', options: WARRANTY, required: true, default: e.division === 'Solar' ? WARRANTY[5] : WARRANTY[0] },
      { key: 'deliveryCommitment', label: 'Delivery commitment date', type: 'date', required: true, default: util.iso(util.addDays(CRM.TODAY, 7)) },
      { key: 'validityDays', label: 'Quote validity (days)', type: 'number', default: 15 },
      { type: 'section', label: 'Scrap details (buy-back of old batteries / inverters / UPS)' },
      { key: 'scrapApplicable', label: 'Scrap applicable', type: 'select', options: ['No', 'Yes'], required: true, default: 'No' },
      { key: 'scrapType', label: 'Scrap type', type: 'select', options: SCRAP_TYPES },
      { key: 'scrapQty', label: 'Scrap quantity', type: 'number', min: 0 },
      { key: 'scrapValue', label: 'Scrap buy-back value (₹)', type: 'number', min: 0, onChange: updTotals },
      { key: 'scrapDetails', label: 'Scrap details', full: true },
      { key: 'remarks', label: 'Remarks / discount justification', type: 'textarea' },
    ];
    form = ui.form(fields, existing || {});
    const file = h('input', { type: 'file', accept: '.pdf,.doc,.docx,.xls,.xlsx,.jpg,.png' });
    const body = h('div', {}, [h('h3', { style: 'margin-bottom:8px' }, 'Product details & quantity'), linesHost, totals, h('div', { class: 'mt' }, form), h('div', { class: 'field mt' }, [h('label', {}, 'Quotation document (PDF / Word / Excel / image — stored with the quotation)' + (existing && existing.fileName ? ' · current: ' + existing.fileName : '')), file])]);
    drawLines();
    ui.modal({ title: existing ? 'Revise quotation ' + existing.id : 'New quotation', sub: 'Submitted for Sales Manager approval', wide: true, body, actions: [{ label: 'Cancel' }, { label: existing ? 'Save revision & resubmit' : 'Submit for approval', cls: 'primary', onClick: () => {
      if (!form.validate()) return false;
      const v = form.values();
      const good = lines.filter((l) => l.productId && l.qty > 0 && l.rate > 0);
      if (!good.length) { ui.toast('Add at least one product line with quantity and rate', 'bad'); return false; }
      if (v.scrapApplicable === 'Yes' && (!v.scrapType || !v.scrapQty)) { ui.toast('Scrap type and quantity are mandatory when scrap is applicable', 'bad'); return false; }
      if ((v.discountPct || 0) > discMax && !String(v.remarks || '').trim()) { ui.toast('Discount beyond ' + discMax + '% needs a justification in remarks', 'bad'); return false; }
      delete v.enquiryRef; delete v.quoteDateInfo;
      const en = v.enquiryId ? db.get('enquiries', v.enquiryId) : e;
      const t = computeQuote(good, v.discountPct, v.scrapValue, en.division);
      const rec = Object.assign(v, t, { lines: good, enquiryId: en.id, customerId: en.customerId, accountName: en.accountName, division: en.division, execId: en.execId, approval: 'Awaiting Approval', status: 'Pending', quoteDate: '', customerApprovedAt: '', fileName: existing ? existing.fileName || '' : '' });
      let q;
      if (existing) { rec.revision = (existing.revision || 0) + 1; q = db.update('quotations', existing.id, rec, { note: 'Quotation revised (R' + rec.revision + ') and resubmitted' }); }
      else { rec.revision = 0; q = db.insert('quotations', rec, { prefix: 'QTN', note: 'Quotation submitted for approval' }); }
      if (file.files[0]) storeQuoteFile(q.id, file.files[0]);
      submitQuote(q);
      ui.toast(q.id + (isMgr() ? ' approved & sent' : ' submitted for Sales Manager approval'), 'ok');
      CRM.refresh();
    } }] });
  }

  function quoteDrawer(q) {
    if (!q) return;
    const e = db.get('enquiries', q.enquiryId) || {};
    const step = q.approval === 'Awaiting Approval' ? 1 : q.approval === 'Rejected' ? 1 : ['Approved', 'Rejected'].includes(q.status) ? 4 : 2;
    const work = canWork();
    const statusRow = work && q.approval === 'Approved' ? h('div', { class: 'row' }, [h('span', { class: 'small muted' }, 'Customer status:')].concat(QUOTE_STATUS.filter((s) => s !== q.status).map((s) => ui.btn(s, () => { d.close(); setQuoteStatus(q, s); }, 'sm' + (s === 'Approved' ? ' ok' : s === 'Rejected' ? ' danger' : ''))))) : null;
    const upload = h('input', { type: 'file', accept: QUOTE_ACCEPT, style: 'max-width:220px' });
    upload.addEventListener('change', () => { if (upload.files[0]) storeQuoteFile(q.id, upload.files[0], null, () => { ui.toast('Quotation file attached', 'ok'); d.close(); quoteDrawer(db.get('quotations', q.id)); }); });
    const msg = 'Dear ' + (e.contactName || 'Sir/Madam') + ', please find our quotation ' + q.id + ' for ' + (q.lines || []).map((l) => l.name + ' x ' + l.qty).join(', ') + '. Quote value ' + fmt.money(q.quoteValue) + ' (incl. GST), delivery by ' + fmt.date(q.deliveryCommitment) + '. – Maruthi Power Control Systems';
    const body = h('div', { class: 'stack' }, [
      ui.stepper(['Drafted', 'Manager approval', 'Sent to customer', 'Customer decision'], step, q.approval === 'Rejected' || q.status === 'Rejected'),
      q.approval === 'Rejected' ? calloutH('<b>Sent back by Sales Manager:</b> ' + util.esc(q.approvalRemarks || ''), 'bad') : null,
      q.approval === 'Awaiting Approval' ? calloutH('Awaiting Sales Manager approval — the quote given date and response time are set on approval.', 'warn') : null,
      statusRow,
      ui.dl([['Quote No', q.id + (q.revision ? ' (R' + q.revision + ')' : '')], ['Enquiry', lnk('enquiries', q.enquiryId)], ['Account', q.accountName], ['Division', ui.divTag(q.division)], ['Quote given date (auto)', q.quoteDate ? fmt.dateTime(q.quoteDate) : '—'], ['Quote response time (auto)', respBadge(quoteResponseHrs(q))], ['Quotation status', ui.badge(q.status)], ['Approval', ui.badge(q.approval) ], ['Approved by', q.approvedBy ? q.approvedBy + ' · ' + fmt.dateTime(q.approvedAt) : '—'], ['Customer approved', q.customerApprovedAt ? fmt.dateTime(q.customerApprovedAt) : '—'], ['Basic value', fmt.money(q.basicValue)], ['GST ' + quoteGstPct(q) + '%', fmt.money(q.gst)], ['Quote value', h('b', {}, fmt.money(q.quoteValue))], ['Discount', (q.discountPct || 0) + '%'], ['Warranty contract', q.warrantyContract], ['Delivery commitment', fmt.date(q.deliveryCommitment)], ['Payment terms', q.paymentTerms], ['Validity', (q.validityDays || 15) + ' days'], ['Scrap details', q.scrapApplicable === 'Yes' ? q.scrapQty + ' × ' + q.scrapType + ' · buy-back ' + fmt.money(q.scrapValue) + (q.scrapDetails ? ' · ' + q.scrapDetails : '') : 'Not applicable'], ['Document', quoteFileLink(q)], ['Remarks', q.remarks]]),
      card('Product details', h('table', { class: 'tbl' }, [h('thead', {}, h('tr', {}, ['Product', 'Qty', 'Rate', 'Amount'].map((x) => h('th', {}, x)))), h('tbody', {}, (q.lines || []).map((l) => h('tr', {}, [h('td', {}, l.name), h('td', {}, l.qty), h('td', { class: 'right' }, fmt.money(l.rate)), h('td', { class: 'right' }, fmt.money(l.qty * l.rate))])))]), { flush: true }),
      work ? h('div', { class: 'row' }, (ui.attachments ? [] : [h('span', { class: 'small muted' }, 'Upload quotation:'), upload]).concat(q.approval === 'Approved' ? commButtons(e, msg, 'Quotation ' + q.id + ' – Maruthi Power Control Systems') : [])) : null,
      ui.attachments ? ui.attachments('quotations', q.id, { roles: ['sales_exec', 'sales_coordinator', 'sales_manager', 'admin'], labels: ['Quotation document', 'Customer PO', 'Technical proposal'], title: 'Quotation documents', accept: QUOTE_ACCEPT, onChange: (list) => { const doc = list.find((a) => /quotation/i.test(a.label)) || list[0]; if (doc && doc.id !== q.fileId) db.update('quotations', q.id, { fileName: doc.name, fileId: doc.id, fileStore: 'core' }, { note: 'Quotation document attached: ' + doc.name }); } }) : null,
      h('h3', {}, 'Audit trail'), ui.auditTrail('quotations', q.id),
    ]);
    const actions = [];
    if (isMgr() && q.approval === 'Awaiting Approval') { actions.push({ label: 'Send back', cls: 'danger', onClick: () => { rejectQuote(q); } }, { label: 'Approve & send', cls: 'ok', onClick: () => { approveQuote(q); ui.toast(q.id + ' approved & sent to customer', 'ok'); CRM.refresh(); } }); }
    if (work && q.status !== 'Approved' && q.status !== 'Rejected') actions.push({ label: 'Revise', onClick: () => { setTimeout(() => quoteModal(null, q), 20); } });
    actions.push({ label: 'Close' });
    const d = ui.drawer({ title: 'Quotation ' + q.id, sub: q.accountName + ' · ' + fmt.money(q.quoteValue), body, actions });
  }

  // ============================================================ orders (sale orders + Sales Manager approval)
  function orderTable(rows, opts) {
    opts = opts || {};
    return ui.table({
      rows: () => (typeof rows === 'function' ? rows() : rows).map((o) => Object.assign({}, o, { execName: execName(o.execId), status: orderStatus(o), so: soProcessingHrs(o) })).sort((a, b) => (a.wonDate < b.wonDate ? 1 : -1)),
      search: opts.search, onRow: (o) => orderDrawer(db.get('orders', o.id)),
      filters: opts.search === false ? null : [{ key: 'division', label: 'divisions', options: DIVS }, { key: 'status', label: 'statuses', options: ['Pending SO approval', 'SO Issued', 'Invoiced', 'Installed', 'Paid', 'SO rejected'] }, { key: 'materialAvailability', label: 'material', options: MATERIAL }],
      columns: [
        { key: 'id', label: 'Order', render: (o) => mono(o.id) }, { key: 'soNumber', label: 'SO number', render: (o) => mono(o.soNumber || '—') }, { key: 'poNumber', label: 'PO number', render: (o) => mono(o.poNumber) },
        { key: 'accountName', label: 'Account' }, { key: 'division', label: 'Division', render: (o) => ui.divTag(o.division) },
        { key: 'product', label: 'Product', render: (o) => o.product + ' × ' + o.quantity + (o.cameraCount ? ' · ' + o.cameraCount + ' cams' : '') + (o.capacityKw ? ' · ' + o.capacityKw + ' kW' : '') },
        { key: 'value', label: 'Value', cls: 'right', render: (o) => fmt.money(o.value), footer: (rs) => fmt.lakh(sum(rs, 'value')) },
        { key: 'wonDate', label: 'Won', render: (o) => fmt.date(o.wonDate) }, { key: 'soIssuedDate', label: 'SO issued', render: (o) => fmt.date(o.soIssuedDate) },
        { key: 'so', label: 'SO processing', render: (o) => respBadge(o.so), sort: (o) => o.so || 0 },
        { key: 'materialAvailability', label: 'Material' },
        { key: 'status', label: 'Status', render: (o) => ui.badge(o.status, o.status === 'Pending SO approval' ? 'warn' : o.status === 'SO rejected' ? 'bad' : o.status === 'Paid' ? 'ok' : 'info') },
        { key: 'execName', label: 'Executive' },
      ],
    });
  }
  function renderOrders(el, params) {
    const list = allOrders();
    const live = list.filter((o) => !o.migrated);
    ui.page(el, { title: 'Sales Orders', sub: 'Order won → Sales Manager SO approval → hand-over to Projects / Service · SO processing time auto-calculated', actions: [ui.btn('⇩ Export CSV', () => downloadCsv('orders.csv', ['Order', 'SO Number', 'PO Number', 'Account', 'Division', 'Product', 'Qty', 'Value', 'Order Won Date', 'SO Issued Date', 'SO Processing (h)', 'Material Availability', 'Delivery Commitment', 'Installation Completion', 'Status', 'Executive'], list.map((o) => [o.id, o.soNumber, o.poNumber, o.accountName, o.division, o.product, o.quantity, o.value, util.iso(o.wonDate), util.iso(o.soIssuedDate), soProcessingHrs(o), o.materialAvailability, o.deliveryCommitDate, o.installationCompletionDate, orderStatus(o), execName(o.execId)])))] });
    const mk = monthKey(CRM.TODAY);
    const mon = live.filter((o) => o.approval === 'Approved' && monthKey(o.wonDate) === mk);
    const so = live.map(soProcessingHrs).filter((x) => x != null);
    const awaiting = live.filter((o) => o.approval === 'Awaiting Approval' || o.approval === 'Rejected');
    const delivery = live.filter((o) => o.approval === 'Approved' && !o.installationCompletionDate);
    el.appendChild(ui.kpis([
      { label: 'Orders won this month', value: mon.length, meta: fmt.lakh(sum(mon, 'value')), color: 'var(--ok)' },
      { label: 'Awaiting SO approval', value: live.filter((o) => o.approval === 'Awaiting Approval').length, color: 'var(--warn)' },
      { label: 'Avg SO processing time', value: hrsText(avg(so)), meta: so.filter((x) => x > 24).length + ' over 24 h', color: 'var(--chart-5)' },
      { label: 'Pending delivery / installation', value: delivery.length, color: 'var(--chart-4)' },
      { label: 'To be invoiced', value: live.filter((o) => o.approval === 'Approved' && !invoicesOf(o.id).length).length, color: 'var(--bad)' },
    ]));
    el.appendChild(ui.tabs([{ id: 'all', label: 'Live orders', count: live.length }, { id: 'await', label: 'SO approval', count: awaiting.length }, { id: 'del', label: 'Delivery & installation', count: delivery.length }, { id: 'hist', label: 'Migrated history', count: list.length - live.length }], (id, body) => {
      if (id === 'del') { body.appendChild(card(null, ui.table({ rows: delivery, onRow: (o) => orderDrawer(db.get('orders', o.id)), columns: [{ key: 'soNumber', label: 'SO', render: (o) => mono(o.soNumber) }, { key: 'accountName', label: 'Account' }, { key: 'division', label: 'Division', render: (o) => ui.divTag(o.division) }, { key: 'product', label: 'Product' }, { key: 'materialAvailability', label: 'Material', render: (o) => ui.badge(o.materialAvailability, /stock/.test(o.materialAvailability) ? 'ok' : 'warn') }, { key: 'deliveryCommitDate', label: 'Delivery commitment', render: (o) => ui.badge(fmt.date(o.deliveryCommitDate), o.deliveryCommitDate < todayIso() ? 'bad' : 'info') }, { key: 'installationStatus', label: 'Installation', render: (o) => ui.badge(o.installationStatus) }, { key: 'p', label: 'Project / job stage', render: projectCell }] }), { flush: true })); return; }
      const rows = id === 'await' ? awaiting : id === 'hist' ? list.filter((o) => o.migrated) : live;
      body.appendChild(card(null, orderTable(rows), { flush: true }));
    }, params && params[0] && (db.get('orders', params[0]) || {}).approval === 'Awaiting Approval' ? 'await' : 'all'));
    if (params && params[0]) { const o = db.get('orders', params[0]); if (o && (!isExec() || o.execId === me())) setTimeout(() => orderDrawer(o), 30); }
  }
  const linkedProject = (o) => db.all('projects').find((p) => p.orderId === o.id || (o.soNumber && p.soNumber === o.soNumber));
  // Read-only view of the project's current stage for Sales (projects.js owns the workflow; CRM.projects.stageInfo preferred when exposed)
  const PRJ_WF = {
    es_large: [['so', 'SO receipt'], ['survey', 'Site survey'], ['boq', 'BOQ'], ['procurement', 'Procurement'], ['delivery', 'Material delivery'], ['planning', 'Installation planning'], ['cable', 'Cable laying'], ['nvr', 'DVR / NVR'], ['cameras', 'Camera installation'], ['testing', 'Config / Testing / Commissioning'], ['handover', 'Handover / Closure']],
    es_small: [['so', 'SO received & job created'], ['scope', 'Scope & site verified'], ['survey', 'Site visit (if required)'], ['boq', 'BOQ / material list'], ['procurement', 'Stock & purchase'], ['delivery', 'Material issued & scheduled'], ['install', 'Cable & device installation'], ['testing', 'DVR/NVR config & testing'], ['handover', 'Demo & handover'], ['activate', 'Asset / warranty / PM activation']],
    solar: [['so', 'SO receipt'], ['survey', 'Site visit & feasibility'], ['boq', 'BOQ'], ['procurement', 'Purchase & material planning'], ['delivery', 'Dispatch & site verification'], ['planning', 'Installation planning'], ['civil', 'Civil work'], ['mechanical', 'Mechanical installation'], ['electrical', 'Electrical installation'], ['commissioning', 'Testing & commissioning'], ['compliance', 'Net metering & subsidy'], ['handover', 'Customer handover']],
    es_pending: [['so', 'SO receipt / classification']],
  };
  function projectStage(p) {
    if (CRM.projects && typeof CRM.projects.stageInfo === 'function') { try { const x = CRM.projects.stageInfo(p); if (x && x.label) return x; } catch (err) { /* fall back */ } }
    const wf = PRJ_WF[p.kind] || [];
    const i = wf.findIndex(([k]) => { const x = (p.stages || {})[k]; return !(x && (x.status === 'Completed' || x.status === 'Skipped')); });
    const idx = i < 0 ? wf.length : i;
    return { label: ['Closed', 'Cancelled'].includes(p.status) ? p.status : i < 0 ? 'All stages complete' : wf[i][1], pct: wf.length ? Math.round(idx / wf.length * 100) : 0, step: Math.min(idx + 1, wf.length), steps: wf.length };
  }
  function projectCell(o) {
    const p = linkedProject(o);
    if (!p) return o.division === 'Power' ? 'Power order → Service asset & PM' : o.approval === 'Approved' ? 'Project being created' : '—';
    const st = projectStage(p);
    const ref = canOpen('#/projects/' + p.id, CRM.role().id) ? lnk('projects', p.id) : mono(p.id);
    return h('div', {}, [ref, ' · ', h('b', {}, st.label), h('div', { class: 'small muted' }, (st.steps ? 'Stage ' + st.step + ' of ' + st.steps + ' · ' : '') + (st.pct != null ? st.pct + '% complete' : '') + (p.status ? ' · ' + p.status : ''))]);
  }
  function orderSummary(o) {
    const invs = invoicesOf(o.id);
    return h('div', { class: 'stack' }, [
      card(null, ui.stepper(ORDER_STEPS, orderStep(o), o.approval === 'Rejected')),
      h('div', { class: 'grid g2' }, [
        card('Order', ui.dl([['Order', o.id], ['SO number', o.soNumber || '—'], ['PO number', o.poNumber], ['Order won date', fmt.date(o.wonDate)], ['SO issued date', fmt.date(o.soIssuedDate)], ['SO processing time', respBadge(soProcessingHrs(o))], ['Material availability', o.materialAvailability], ['Value', fmt.money(o.value)], ['Payment terms', o.paymentTerms], ['Approval', ui.badge(o.approval)]])),
        card('Installation / delivery & payment', ui.dl([['Delivery commitment', fmt.date(o.deliveryCommitDate)], ['Delivered', fmt.date(o.deliveredDate)], ['Installation completion', fmt.date(o.installationCompletionDate)], ['Installation status', ui.badge(o.installationStatus)], ['Project / job stage', projectCell(o)], ['Invoices', invs.map((i) => i.invoiceNo).join(', ') || 'Not invoiced'], ['Invoice value', fmt.money(sum(invs, 'value'))], ['Received', fmt.money(sum(invs, paidOf))], ['Outstanding', h('b', {}, fmt.money(sum(invs, outstandingOf)))]])),
      ]),
      ui.btn('Open order details', () => orderDrawer(o), 'sm'),
    ]);
  }
  function orderDrawer(o) {
    if (!o) return;
    const invs = invoicesOf(o.id);
    const work = canWork();
    const body = h('div', { class: 'stack' }, [
      ui.stepper(ORDER_STEPS, orderStep(o), o.approval === 'Rejected'),
      o.approval === 'Awaiting Approval' ? calloutH('Awaiting <b>Sales Manager approval</b>. On approval the SO number is issued and the order is handed over (' + (o.division === 'Power' ? 'Service: asset, warranty & PM plan' : 'Projects: ' + o.division + ' job') + ').', 'warn') : null,
      o.approval === 'Rejected' ? calloutH('<b>SO rejected:</b> ' + util.esc(o.approvalRemarks || ''), 'bad') : null,
      ui.dl([['Order', o.id], ['Enquiry', o.enquiryId ? lnk('enquiries', o.enquiryId) : 'Migrated'], ['Customer', o.customerId ? lnk('customer360', o.customerId) : o.accountName], ['Division', ui.divTag(o.division)], ['Product', o.product + ' × ' + o.quantity], ['Order value (ex-GST)', fmt.money(o.value)],
        o.cameraCount ? ['Camera count', o.cameraCount] : null, o.systemType ? ['System type', o.systemType] : null, o.capacityKw ? ['Capacity', o.capacityKw + ' kW'] : null,
        ['Order won date', fmt.dateTime(o.wonDate)], ['Sales order number', o.soNumber || '—'], ['PO number', o.poNumber], ['SO issued date', fmt.dateTime(o.soIssuedDate)], ['SO processing time (auto)', respBadge(soProcessingHrs(o))], ['Lead conversion time', conversionDays(o) != null ? conversionDays(o) + ' days' : '—'], ['Material availability', o.materialAvailability], ['Payment terms', o.paymentTerms], ['Warranty contract', o.warrantyContract], ['Approved by', o.approvedBy || '—'], ['Executive', execName(o.execId)]]),
      h('h3', {}, 'Installation / delivery tracking'),
      ui.dl([['Delivery commitment date', fmt.date(o.deliveryCommitDate)], ['Delivered date', fmt.date(o.deliveredDate)], ['Installation completion date', fmt.date(o.installationCompletionDate)], ['Installation status', ui.badge(o.installationStatus)], ['Scrap', o.scrapApplicable ? o.scrapQty + ' × ' + o.scrapType + ' · ' + (o.scrapCollected ? 'collected' : 'pending collection') : 'Not applicable'], ['Project / job stage', projectCell(o)]].concat(o.dealerId ? [['Dealer', (db.get('dealers', o.dealerId) || {}).name || o.dealerId]] : [], o.otsId ? [['Sales OTS', o.otsId]] : [])),
      h('h3', {}, 'Invoices & payments'),
      invs.length ? ui.table({ rows: invs, search: false, columns: [{ key: 'invoiceNo', label: 'Invoice', render: (i) => mono(i.invoiceNo) }, { key: 'invoiceDate', label: 'Date', render: (i) => fmt.date(i.invoiceDate) }, { key: 'value', label: 'Value', render: (i) => fmt.money(i.value) }, { key: 'dueDate', label: 'Due', render: (i) => fmt.date(i.dueDate) }, { key: 'o', label: 'Outstanding', render: (i) => fmt.money(outstandingOf(i)) }, { key: 's', label: 'Status', render: (i) => ui.badge(invStatus(i), invTone(invStatus(i))) }] }) : ui.empty('Not invoiced yet — Accounts raises the invoice after SO approval', '🧾'),
      h('h3', {}, 'Audit trail'), ui.auditTrail('orders', o.id),
    ]);
    const actions = [];
    if (isMgr() && o.approval === 'Awaiting Approval') actions.push({ label: 'Reject SO', cls: 'danger', onClick: () => { rejectSO(o); } }, { label: 'Approve SO', cls: 'ok', onClick: () => { approveSO(o); CRM.refresh(); } });
    if (work && o.approval === 'Rejected') actions.push({ label: 'Revise & resubmit', cls: 'primary', onClick: () => { setTimeout(() => ui.formModal('Resubmit ' + o.id, [{ key: 'poNumber', label: 'PO number', required: true }, { key: 'value', label: 'Order value', type: 'number', required: true }, { key: 'materialAvailability', label: 'Material availability', type: 'select', options: MATERIAL, required: true }, { key: 'deliveryCommitDate', label: 'Delivery commitment', type: 'date', required: true }, { key: 'paymentTerms', label: 'Payment terms', type: 'select', options: Object.keys(PAY_TERMS), required: true }], o, (v) => { db.update('orders', o.id, Object.assign(v, { approval: 'Awaiting Approval', creditDays: PAY_TERMS[v.paymentTerms] || 0 }), { note: 'SO resubmitted' }); CRM.notify({ to: ['sales_manager'], title: 'Sale order ' + o.id + ' resubmitted', link: '#/orders/' + o.id, severity: 'warn', key: 'soappr:' + o.id + ':' + Date.now() }); ui.toast('Resubmitted for approval', 'ok'); CRM.refresh(); }), 20); } });
    if (work && o.approval === 'Approved') actions.push({ label: 'Update delivery / installation', onClick: () => { setTimeout(() => deliveryModal(o), 20); } });
    if (isAcc() && o.approval === 'Approved' && !invs.length) actions.push({ label: 'Raise invoice', cls: 'primary', onClick: () => { setTimeout(() => raiseInvoice(o), 20); } });
    actions.push({ label: 'Close' });
    ui.drawer({ title: (o.soNumber || o.id) + ' · ' + o.accountName, sub: orderStatus(o) + ' · ' + fmt.money(o.value), body, actions });
  }
  function deliveryModal(o) {
    const fields = [
      { key: 'materialAvailability', label: 'Material availability', type: 'select', options: MATERIAL, required: true },
      { key: 'deliveryCommitDate', label: 'Delivery commitment date', type: 'date', required: true },
      { key: 'deliveredDate', label: 'Delivered date', type: 'date' },
      { key: 'installationStatus', label: 'Installation status', type: 'select', options: ['Pending', 'Scheduled', 'In Progress', 'Completed'], required: true },
      { key: 'installationCompletionDate', label: 'Installation completion date', type: 'date' },
    ];
    if (o.scrapApplicable) fields.push({ key: 'scrapCollected', label: 'Scrap collected (' + o.scrapQty + ' × ' + o.scrapType + ')', type: 'checkbox' });
    ui.formModal('Delivery & installation · ' + (o.soNumber || o.id), fields, o, (v) => {
      if (v.installationStatus === 'Completed' && !v.installationCompletionDate) { ui.toast('Installation completion date is mandatory to mark Completed', 'bad'); return false; }
      if (v.installationCompletionDate && v.installationStatus !== 'Completed') v.installationStatus = 'Completed';
      db.update('orders', o.id, v, { note: 'Delivery / installation updated' });
      ui.toast('Delivery tracking updated', 'ok'); CRM.refresh();
    });
  }

  // ============================================================ follow-up management
  const fuStatus = (f) => (f.status === 'Planned' ? (f.dueDate < todayIso() ? 'Missed' : f.dueDate === todayIso() ? 'Due today' : 'Scheduled') : f.status);
  const fuTone = (s) => ({ Missed: 'bad', 'Due today': 'warn', Scheduled: 'info', Completed: 'ok', Rescheduled: '' }[s]);
  const allFu = () => scope(db.all('followups'));
  function followUpTable(rows, opts) {
    opts = opts || {};
    return ui.table({
      rows: () => (typeof rows === 'function' ? rows() : rows).map((f) => Object.assign({}, f, { execName: execName(f.execId), st: fuStatus(f) })).sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1)), search: opts.search, pageSize: opts.pageSize,
      filters: opts.search === false ? null : [{ key: 'type', label: 'types', options: FU_TYPES }, { key: 'division', label: 'divisions', options: DIVS }].concat(isExec() ? [] : [{ key: 'execName', label: 'executives', options: execs().map((s) => s.name) }]),
      columns: [
        { key: 'dueDate', label: 'Due', render: (f) => h('div', {}, [fmt.date(f.dueDate), h('div', { class: 'small muted' }, fmt.rel(f.dueDate))]) },
        { key: 'accountName', label: 'Account' }, { key: 'enquiryId', label: 'Enquiry', render: (f) => (f.enquiryId ? lnk('enquiries', f.enquiryId) : '—') },
        { key: 'type', label: 'Type' }, { key: 'purpose', label: 'Purpose' }, { key: 'execName', label: 'Executive' },
        { key: 'st', label: 'Status', render: (f) => ui.badge(f.st, fuTone(f.st)) }, { key: 'outcome', label: 'Outcome' },
      ],
      actions: canWork() ? (f) => (f.status === 'Planned' ? [ui.btn('✓ Done', () => completeFollowUp(db.get('followups', f.id)), 'sm ok'), ui.btn('Reschedule', () => rescheduleFollowUp(db.get('followups', f.id)), 'sm')] : []) : null,
    });
  }
  function followUpModal(e) {
    const options = allEnq().filter((x) => OPEN.includes(x.stage) && x.execId);
    ui.formModal('Schedule follow-up', [
      e ? { key: 'ref', label: 'Enquiry', type: 'readonly', default: e.id + ' · ' + e.accountName } : { key: 'enquiryId', label: 'Enquiry', type: 'select', required: true, full: true, options: options.map((x) => ({ value: x.id, label: x.id + ' · ' + x.accountName + ' · ' + x.stage })) },
      { key: 'dueDate', label: 'Follow-up date', type: 'date', required: true, default: util.iso(util.addDays(CRM.TODAY, 1)) },
      { key: 'type', label: 'Type', type: 'select', options: FU_TYPES, required: true, default: 'Call' },
      { key: 'purpose', label: 'Purpose', required: true, full: true },
    ], {}, (v) => {
      const en = e || db.get('enquiries', v.enquiryId);
      if (v.dueDate < todayIso()) { ui.toast('Follow-up date cannot be in the past', 'bad'); return false; }
      scheduleFollowUp(en, v.dueDate, v.type, v.purpose);
      db.update('enquiries', en.id, { nextFollowUp: v.dueDate, followUpStatus: 'Pending' }, { note: 'Follow-up scheduled ' + v.dueDate });
      ui.toast('Follow-up scheduled for ' + fmt.date(v.dueDate) + ' · auto reminder set', 'ok'); CRM.refresh();
    });
  }
  function completeFollowUp(f, onDone) {
    const e = db.get('enquiries', f.enquiryId);
    ui.formModal('Complete follow-up · ' + f.accountName, [
      { key: 'outcome', label: 'Outcome', required: true, full: true },
      { key: 'callStatus', label: 'Call status', type: 'select', options: CALL_STATUS, required: true, default: 'Connected' },
      { key: 'nextFollowUp', label: 'Next follow-up date (auto-schedules)', type: 'date', default: e && OPEN.includes(e.stage) ? util.iso(util.addDays(CRM.TODAY, 3)) : '' },
      { key: 'progressNotes', label: 'Progress notes (updates the enquiry)', type: 'textarea' },
    ], {}, (v) => {
      db.update('followups', f.id, { status: 'Completed', completedAt: nowIso(), outcome: v.outcome, callStatus: v.callStatus }, { note: 'Follow-up completed: ' + v.outcome });
      if (e) {
        db.update('enquiries', e.id, { callStatus: v.callStatus, followUpStatus: 'Completed', progressNotes: v.progressNotes || v.outcome, nextFollowUp: v.nextFollowUp || '' }, { note: 'Follow-up completed' });
        if (v.nextFollowUp) { scheduleFollowUp(db.get('enquiries', e.id), v.nextFollowUp, f.type, 'Next follow-up'); db.update('enquiries', e.id, { followUpStatus: 'Pending' }, { silent: true }); }
      }
      ui.toast('Follow-up completed' + (v.nextFollowUp ? ' · next on ' + fmt.date(v.nextFollowUp) : ''), 'ok');
      (onDone || CRM.refresh)();
    });
  }
  function rescheduleFollowUp(f, date) {
    const apply = (d, reason) => {
      db.update('followups', f.id, { status: 'Rescheduled', outcome: 'Rescheduled to ' + d + (reason ? ' · ' + reason : '') }, { note: 'Rescheduled' });
      const e = db.get('enquiries', f.enquiryId);
      if (e) { scheduleFollowUp(e, d, f.type, f.purpose); db.update('enquiries', e.id, { nextFollowUp: d, followUpStatus: 'Rescheduled' }, { silent: true }); }
      ui.toast('Rescheduled to ' + fmt.date(d), 'ok'); CRM.refresh();
    };
    if (date) { apply(date, 'Moved on scheduler'); return; }
    ui.formModal('Reschedule follow-up', [{ key: 'dueDate', label: 'New date', type: 'date', required: true, default: util.iso(util.addDays(CRM.TODAY, 1)) }, { key: 'reason', label: 'Reason', required: true }], {}, (v) => { if (v.dueDate < todayIso()) { ui.toast('Pick today or a future date', 'bad'); return false; } apply(v.dueDate, v.reason); });
  }
  /** Daily task list for executives (also used on homes). */
  function dailyTasks() {
    const t = todayIso(), out = [];
    allFu().filter((f) => f.status === 'Planned' && f.dueDate <= t).sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1)).forEach((f) => out.push({ kind: f.dueDate < t ? 'Missed follow-up' : 'Follow-up', tone: f.dueDate < t ? 'bad' : 'warn', title: f.accountName + ' — ' + f.purpose, sub: f.type + ' · ' + fmt.rel(f.dueDate) + ' · ' + execName(f.execId), link: '#/enquiries/' + f.enquiryId, fu: f }));
    allEnq().filter((e) => OPEN.includes(e.stage) && e.siteVisitDate === t && !e.siteVisitDoneAt).forEach((e) => out.push({ kind: 'Site visit', tone: 'info', title: e.accountName + ' — site visit', sub: e.area + ' · ' + e.product, link: '#/enquiries/' + e.id }));
    policyBreaches().filter((b) => b.type === 'Quotation Delay' && (!isExec() || b.owner === me())).forEach((b) => out.push({ kind: 'Quotation due', tone: 'bad', title: b.rec.accountName + ' — submit quotation', sub: Math.round(b.over + 24) + ' h since enquiry (SLA 24 h)', link: b.link }));
    allInvoices().filter((i) => outstandingOf(i) > 0 && util.iso(i.dueDate) === t).forEach((i) => out.push({ kind: 'Collect payment', tone: 'warn', title: i.accountName + ' — ' + fmt.money(outstandingOf(i)), sub: i.invoiceNo + ' due today', link: ['#/payments', i.orderId ? '#/orders/' + i.orderId : '#/mobile'].find((l) => canOpen(l, CRM.role().id)) }));
    return out;
  }
  function taskList(tasks, limit) {
    if (!tasks.length) return ui.empty('Nothing pending for today 🎉', '✅');
    return h('div', { class: 'stack', style: 'gap:6px' }, tasks.slice(0, limit || 50).map((t) => h('div', { class: 'row', style: 'justify-content:space-between;padding:8px 10px;border:1px solid var(--border);border-radius:8px;flex-wrap:nowrap' }, [
      h('a', { href: t.link, style: 'color:var(--text);min-width:0' }, [h('div', { style: 'font-weight:600' }, t.title), h('div', { class: 'small muted' }, t.sub)]),
      h('div', { class: 'row', style: 'flex-wrap:nowrap' }, [ui.badge(t.kind, t.tone), t.fu && canWork() ? ui.btn('✓', () => completeFollowUp(t.fu), 'sm ok') : null]),
    ])));
  }
  function renderFollowups(el) {
    const list = allFu(), t = todayIso();
    const planned = list.filter((f) => f.status === 'Planned');
    const mk = monthKey(CRM.TODAY);
    const monthPlanned = list.filter((f) => monthKey(f.dueDate) === mk && f.dueDate <= t);
    const monthDone = monthPlanned.filter((f) => f.status !== 'Planned');
    ui.page(el, { title: isExec() ? 'My Follow-ups' : 'Follow-up Management', sub: 'Scheduling · daily task list · missed follow-up alerts · automatic reminders', actions: [canWork() ? ui.btn('+ Schedule follow-up', () => followUpModal(), 'primary') : null] });
    el.appendChild(ui.kpis([
      { label: 'Due today', value: planned.filter((f) => f.dueDate === t).length, color: 'var(--warn)' },
      { label: 'Missed (overdue)', value: planned.filter((f) => f.dueDate < t).length, color: 'var(--bad)' },
      { label: 'Completed today', value: list.filter((f) => f.status === 'Completed' && util.iso(f.completedAt) === t).length, color: 'var(--ok)' },
      { label: 'Upcoming 7 days', value: planned.filter((f) => f.dueDate > t && util.daysBetween(CRM.TODAY, f.dueDate) <= 7).length, color: 'var(--chart-5)' },
      { label: 'Completed vs planned (month)', value: monthDone.length + ' / ' + monthPlanned.length, meta: fmt.pct(util.pct(monthDone.length, monthPlanned.length)) + ' discipline' },
    ]));
    el.appendChild(ui.tabs([{ id: 'today', label: 'Daily task list' }, { id: 'sched', label: 'Scheduler (next 7 days)' }, { id: 'missed', label: 'Missed', count: planned.filter((f) => f.dueDate < t).length }, { id: 'up', label: 'Upcoming', count: planned.filter((f) => f.dueDate >= t).length }, { id: 'done', label: 'Completed' }], (id, body) => {
      if (id === 'today') {
        const tasks = dailyTasks();
        body.appendChild(h('div', { class: 'grid g2' }, [card('Today · ' + fmt.date(CRM.TODAY) + ' (' + tasks.length + ' tasks)', taskList(tasks)), card('Follow-ups by executive', ui.hbars(execs().filter((s) => !isExec() || s.id === me()).map((s) => { const mine = list.filter((f) => f.execId === s.id && f.dueDate <= t && monthKey(f.dueDate) === mk); return { label: s.name, value: mine.filter((f) => f.status !== 'Planned').length, target: mine.length }; })))]));
      } else if (id === 'sched') {
        const days = [0, 1, 2, 3, 4, 5, 6].map((d) => util.iso(util.addDays(CRM.TODAY, d)));
        const items = planned.filter((f) => f.dueDate < t || days.includes(f.dueDate));
        body.appendChild(calloutH('Drag a follow-up to another day to reschedule it. Overdue items must be moved to today or later.', 'info'));
        body.appendChild(h('div', { class: 'mt' }, ui.kanban({
          columns: [{ id: 'overdue', label: 'Overdue', color: 'var(--bad)' }].concat(days.map((d, i) => ({ id: d, label: i === 0 ? 'Today' : dayLabel(d), color: i === 0 ? 'var(--warn)' : 'var(--chart-5)' }))),
          items, colOf: (f) => (f.dueDate < t ? 'overdue' : f.dueDate),
          card: (f) => [h('div', { class: 't' }, f.accountName), h('div', { class: 'small muted' }, f.type + ' · ' + f.purpose), h('div', { class: 'small' }, execName(f.execId))],
          onMove: canWork() ? (f, to) => { if (to === 'overdue') { ui.toast('Cannot move into Overdue', 'bad'); return; } rescheduleFollowUp(db.get('followups', f.id), to); } : null,
          onClick: (f) => CRM.go('enquiries', f.enquiryId),
        })));
      } else {
        const rows = id === 'missed' ? planned.filter((f) => f.dueDate < t) : id === 'up' ? planned.filter((f) => f.dueDate >= t) : list.filter((f) => f.status !== 'Planned');
        body.appendChild(card(null, followUpTable(rows), { flush: true }));
      }
    }));
  }

  // ============================================================ cold calls / call log
  const allCalls = () => scope(db.all('callLogs'));
  const callCount = (list) => sum(list, (c) => c.count || 1);
  function logCallModal(prefill) {
    prefill = prefill || {};
    ui.formModal('Log call', [
      { key: 'type', label: 'Call type', type: 'select', options: CALL_TYPES, required: true, default: 'Cold Call' },
      { key: 'customerId', label: 'Existing customer (optional)', type: 'select', options: master.customers().map((c) => ({ value: c.id, label: c.name })), onChange: (v, inp) => { const c = master.customer(v); if (c) { inp.name.value = c.name; inp.phone.value = c.phone; } } },
      { key: 'name', label: 'Prospect / account name', required: true }, { key: 'phone', label: 'Phone', required: true },
      { key: 'outcome', label: 'Outcome', type: 'select', options: CALL_OUTCOMES, required: true },
      { key: 'durationMin', label: 'Duration (min)', type: 'number', default: 3 },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ], prefill, (v) => {
      const s = db.get('staff', isExec() ? me() : (prefill.execId || me())) || {};
      const c = db.insert('callLogs', Object.assign(v, { execId: s.role === 'sales_exec' ? s.id : (prefill.execId || me()), division: s.division || '', date: nowIso(), enquiryId: prefill.enquiryId || '', count: 1 }), { prefix: 'CALL', note: v.type + ' logged' });
      if (prefill.enquiryId) db.update('enquiries', prefill.enquiryId, { callStatus: v.outcome === 'Not Reachable' ? 'Not Reachable' : 'Connected' }, { silent: true });
      ui.toast(v.type + ' logged', 'ok');
      if (v.outcome === 'Enquiry Generated') setTimeout(() => enquiryForm({ customerId: v.customerId, accountName: v.name, contactNumber: v.phone, salesChannel: v.type === 'Cold Call' ? 'Cold Calling' : 'Office Walk-in', leadSource: v.type === 'Cold Call' ? 'Cold Calling' : 'Existing Customer Business', sourceDetails: 'From call ' + c.id }, { onCreated: (e) => { db.update('callLogs', c.id, { enquiryId: e.id }, { silent: true }); CRM.go('enquiries', e.id); } }), 50);
      else CRM.refresh();
    });
  }
  function renderCalls(el) {
    const list = allCalls(), t = todayIso(), mk = monthKey(CRM.TODAY);
    const [mFrom, mTo] = monthRange(mk);
    const tgtM = targetFor(isExec() ? 'exec' : 'all', isExec() ? me() : null, mFrom, mTo);
    const today = list.filter((c) => util.iso(c.date) === t);
    const monthCold = callCount(list.filter((c) => c.type === 'Cold Call' && monthKey(c.date) === mk));
    const dailyCold = Math.round((tgtM.coldCalls || 0) / 26);
    ui.page(el, { title: isExec() ? 'My Calls & Cold Calling' : 'Call Log & Cold Calling', sub: 'Every call counts toward call-count and cold-call targets', actions: [canWork() ? ui.btn('☎ Log call', () => logCallModal(), 'primary') : null] });
    el.appendChild(ui.kpis([
      { label: 'Calls today', value: callCount(today), meta: 'Target ' + Math.round((tgtM.calls || 0) / 26) + '/day' },
      { label: 'Cold calls today vs target', value: callCount(today.filter((c) => c.type === 'Cold Call')) + ' / ' + dailyCold, color: 'var(--chart-4)' },
      { label: 'Cold calls this month', value: monthCold + ' / ' + (tgtM.coldCalls || 0), meta: fmt.pct(util.pct(monthCold, tgtM.coldCalls)) + ' of target', color: 'var(--chart-5)' },
      { label: 'Enquiries from calls (month)', value: list.filter((c) => c.outcome === 'Enquiry Generated' && monthKey(c.date) === mk).length, color: 'var(--ok)' },
    ]));
    const days = [...Array(14)].map((_, i) => util.iso(util.addDays(CRM.TODAY, i - 13)));
    const det = list.filter((c) => !c.summary);
    el.appendChild(h('div', { class: 'grid g2' }, [
      card('Calls — last 14 days', ui.barChart(days.map((d) => ({ label: d.slice(8) + '/' + d.slice(5, 7), values: [callCount(det.filter((c) => util.iso(c.date) === d && c.type === 'Cold Call')), callCount(det.filter((c) => util.iso(c.date) === d && c.type !== 'Cold Call'))] })), [{ name: 'Cold calls', color: 'var(--chart-4)' }, { name: 'Other calls', color: 'var(--chart-1)' }], { height: 200 })),
      card('Cold calls vs target — ' + monthLabel(mk), ui.hbars(execs().filter((s) => !isExec() || s.id === me()).map((s) => ({ label: s.name, value: callCount(db.find('callLogs', (c) => c.execId === s.id && c.type === 'Cold Call' && monthKey(c.date) === mk)), target: (targetRec('exec', s.id, mk) || {}).coldCalls || 0 })))),
    ]));
    section(el, card('Call log', ui.table({
      rows: () => list.map((c) => Object.assign({}, c, { execName: execName(c.execId) })).sort((a, b) => (a.date < b.date ? 1 : -1)),
      filters: [{ key: 'type', label: 'types', options: CALL_TYPES }, { key: 'outcome', label: 'outcomes', options: CALL_OUTCOMES.concat(['Summary']) }].concat(isExec() ? [] : [{ key: 'execName', label: 'executives', options: execs().map((s) => s.name) }]),
      columns: [{ key: 'date', label: 'When', render: (c) => fmt.dateTime(c.date) }, { key: 'execName', label: 'Executive' }, { key: 'type', label: 'Type', render: (c) => ui.badge(c.type, c.type === 'Cold Call' ? 'violet' : 'info') }, { key: 'name', label: 'Prospect / customer' }, { key: 'phone', label: 'Phone' }, { key: 'outcome', label: 'Outcome', render: (c) => ui.badge(c.outcome, c.outcome === 'Enquiry Generated' || c.outcome === 'Interested' ? 'ok' : c.outcome === 'Not Interested' ? 'bad' : '') }, { key: 'count', label: 'Calls', cls: 'right', render: (c) => c.count || 1 }, { key: 'durationMin', label: 'Min', cls: 'right' }, { key: 'notes', label: 'Notes' }, { key: 'enquiryId', label: 'Enquiry', render: (c) => (c.enquiryId ? lnk('enquiries', c.enquiryId) : '—') }],
    }), { flush: true }));
  }

  // ============================================================ targets (per exec per month, per division)
  const METRICS = [['revenue', 'Sales revenue', true], ['calls', 'Call count'], ['coldCalls', 'Cold calls'], ['newCustomers', 'New customer acquisitions'], ['upsell', 'Upselling'], ['crossSell', 'Cross selling']];
  const targetRec = (sc, key, mk) => db.one('targets', (t) => t.scope === sc && t.month === mk && (sc === 'exec' ? t.execId === key : t.division === key));
  /** Pro-rated target for any date range (daily / weekly / monthly reports). sc: 'exec' | 'division' | 'all' */
  function targetFor(sc, key, from, to) {
    const out = {}; METRICS.forEach(([k]) => { out[k] = 0; });
    let d = new Date(from + 'T00:00:00'); const end = new Date(to + 'T00:00:00');
    while (d <= end) {
      const mk = monthKey(d); const [, me2] = monthRange(mk); const dim = Number(me2.slice(8));
      const segEnd = new Date(Math.min(end, new Date(me2 + 'T00:00:00')));
      const days = util.daysBetween(d, segEnd) + 1;
      const recs = sc === 'all' ? db.find('targets', (t) => t.scope === 'division' && t.month === mk) : [targetRec(sc, key, mk)].filter(Boolean);
      recs.forEach((r) => METRICS.forEach(([k]) => { out[k] += (Number(r[k]) || 0) * days / dim; }));
      d = util.addDays(segEnd, 1);
    }
    METRICS.forEach(([k, , money]) => { out[k] = money ? Math.round(out[k]) : Math.round(out[k] * 10) / 10; });
    return out;
  }
  function achievedFor(f, from, to) {
    const m = (r) => (!f.execId || r.execId === f.execId) && (!f.division || r.division === f.division);
    const ords = db.all('orders').filter((o) => o.approval === 'Approved' && inRange(o.wonDate, from, to) && m(o));
    const calls = db.all('callLogs').filter((c) => inRange(c.date, from, to) && m(c));
    const ups = db.all('upsells').filter((u) => u.status === 'Converted' && inRange(u.convertedAt, from, to) && m(u));
    return { revenue: sum(ords, 'value'), calls: callCount(calls), coldCalls: callCount(calls.filter((c) => c.type === 'Cold Call')), newCustomers: acquisitions(from, to, m).length, upsell: ups.filter((u) => u.type === 'Upsell').length, crossSell: ups.filter((u) => u.type === 'Cross-sell').length, orders: ords.length };
  }
  function tvaCell(a, t, money) {
    const pct = util.pct(a, t);
    return h('div', { style: 'min-width:120px' }, [h('div', { class: 'small' }, [h('b', {}, money ? fmt.lakh(a) : fmt.num(a)), ' / ' + (money ? fmt.lakh(t) : fmt.num(t)) + ' · ' + (t ? pct + '%' : '—')]), ui.progress(t ? pct : 0)]);
  }
  function editTarget(sc, key, mk) {
    const r = targetRec(sc, key, mk) || {};
    ui.formModal('Targets · ' + (sc === 'exec' ? execName(key) : key) + ' · ' + monthLabel(mk), METRICS.map(([k, l, money]) => ({ key: k, label: l + (money ? ' (₹)' : ' (count)'), type: 'number', required: true, min: 0 })), r, (v) => {
      if (r.id) db.update('targets', r.id, v, { note: 'Targets updated' });
      else db.insert('targets', Object.assign(v, { scope: sc, month: mk, execId: sc === 'exec' ? key : '', division: sc === 'exec' ? (db.get('staff', key) || {}).division : key }), { prefix: 'TGT' });
      ui.toast('Targets saved', 'ok'); CRM.refresh();
    });
  }
  function renderTargets(el) {
    let mk = monthKey(CRM.TODAY);
    const host = h('div');
    const picker = h('input', { type: 'month', value: mk, class: 'btn', onChange: (e) => { mk = e.target.value || mk; draw(); } });
    ui.page(el, { title: 'Targets vs Achieved', sub: 'Revenue, call counts, new customer acquisitions, cold calls, upselling and cross selling — per executive per month and per division', actions: [picker, isMgr() ? ui.btn('Copy previous month', () => { const d = new Date(mk + '-01T00:00:00'); d.setMonth(d.getMonth() - 1); const pk = monthKey(d); let n = 0; db.find('targets', (t) => t.month === pk).forEach((t) => { if (!db.one('targets', (x) => x.month === mk && x.scope === t.scope && x.execId === t.execId && x.division === t.division)) { const c = Object.assign({}, t); delete c.id; c.month = mk; db.insert('targets', c, { prefix: 'TGT' }); n++; } }); ui.toast(n + ' targets copied from ' + monthLabel(pk), n ? 'ok' : 'warn'); draw(); }) : null] });
    el.appendChild(host);
    function draw() {
      host.innerHTML = '';
      const [from, to] = monthRange(mk);
      const rows = execs().filter((s) => !isExec() || s.id === me()).map((s) => ({ id: s.id, name: s.name, division: s.division, t: targetRec('exec', s.id, mk) || {}, a: achievedFor({ execId: s.id }, from, to) }));
      const drows = DIVS.map((d) => ({ id: d, name: d, t: targetRec('division', d, mk) || {}, a: achievedFor({ division: d }, from, to) }));
      const kr = isExec() ? rows : drows; // executives see only their own figures, never division-wide revenue
      const totT = sum(kr, (r) => r.t.revenue), totA = sum(kr, (r) => r.a.revenue);
      host.appendChild(ui.kpis([{ label: (isExec() ? 'My revenue · ' : 'Revenue achieved · ') + monthLabel(mk), value: fmt.lakh(totA), meta: 'Target ' + fmt.lakh(totT) + ' · ' + util.pct(totA, totT) + '%', tone: totA >= totT ? 'up' : 'down' }].concat(METRICS.slice(1).map(([k, l]) => ({ label: l, value: sum(kr, (r) => r.a[k]) + ' / ' + sum(kr, (r) => r.t[k] || 0) })))));
      const cols = (sc) => [{ key: 'name', label: sc === 'exec' ? 'Executive' : 'Division', render: (r) => (sc === 'exec' ? h('div', {}, [h('b', {}, r.name), h('div', {}, ui.divTag(r.division))]) : ui.divTag(r.name)) }].concat(METRICS.map(([k, l, money]) => ({ key: k, label: l, render: (r) => tvaCell(r.a[k], r.t[k] || 0, money), sort: (r) => util.pct(r.a[k], r.t[k]) })));
      host.appendChild(card('Executive-wise target vs achieved', ui.table({ rows: rows, search: false, columns: cols('exec'), actions: isMgr() ? (r) => [ui.btn('Edit', () => editTarget('exec', r.id, mk), 'sm')] : null }), { flush: true }));
      if (!isExec()) section(host, card('Division-wise target vs achieved', ui.table({ rows: drows, search: false, columns: cols('division'), actions: isMgr() ? (r) => [ui.btn('Edit', () => editTarget('division', r.id, mk), 'sm')] : null }), { flush: true }));
      section(host, h('div', { class: 'grid g2' }, [card(isExec() ? 'My revenue vs target' : 'Revenue — executive', ui.hbars(rows.map((r) => ({ label: r.name, value: r.a.revenue, target: r.t.revenue || 0 })), { money: true })), isExec() ? card('New customers acquired', ui.hbars(rows.map((r) => ({ label: r.name, value: r.a.newCustomers, target: r.t.newCustomers || 0 })))) : card('Revenue — division', ui.hbars(drows.map((r) => ({ label: r.name, value: r.a.revenue, target: r.t.revenue || 0 })), { money: true }))]));
    }
    draw();
  }

  // ============================================================ upsell / cross-sell tracking
  const allUps = () => scope(db.all('upsells'));
  function upsellTable(rows, opts) {
    opts = opts || {};
    return ui.table({
      rows: () => (typeof rows === 'function' ? rows() : rows).map((u) => Object.assign({}, u, { execName: execName(u.execId) })).sort((a, b) => (a.date < b.date ? 1 : -1)), search: opts.search,
      filters: opts.search === false ? null : [{ key: 'type', label: 'types', options: ['Upsell', 'Cross-sell'] }, { key: 'status', label: 'statuses', options: UPSELL_STATUS }].concat(isExec() ? [] : [{ key: 'execName', label: 'executives', options: execs().map((s) => s.name) }]),
      columns: [{ key: 'date', label: 'Date', render: (u) => fmt.date(u.date) }, { key: 'accountName', label: 'Customer' }, { key: 'baseProduct', label: 'Bought' }, { key: 'type', label: 'Type', render: (u) => ui.badge(u.type, u.type === 'Upsell' ? 'violet' : 'brand') }, { key: 'product', label: 'Offer', render: (u) => h('div', {}, [u.product + ' × ' + u.quantity, u.rationale ? h('div', { class: 'small muted' }, u.rationale) : null]) }, { key: 'value', label: 'Value', cls: 'right', render: (u) => fmt.money(u.value), footer: (rs) => fmt.lakh(sum(rs, 'value')) }, { key: 'execName', label: 'Executive responsible' }, { key: 'status', label: 'Status', render: (u) => ui.badge(u.status, u.status === 'Converted' ? 'ok' : u.status === 'Declined' ? 'bad' : u.status === 'Offered' ? 'warn' : 'info') }, { key: 'enquiryId', label: 'Enquiry', render: (u) => (u.enquiryId ? lnk('enquiries', u.enquiryId) : '—') }],
      actions: canWork() ? (u) => (['Suggested', 'Offered'].includes(u.status) ? [
        !u.enquiryId ? ui.btn('→ Enquiry', () => { const p = master.product(u.productId) || {}; enquiryForm({ customerId: u.customerId, division: p.division, category: p.category, productId: u.productId, quantity: u.quantity, expectedValue: u.value, salesChannel: 'Upselling & Cross Selling', leadSource: 'Existing Customer Business', sourceDetails: u.type + ' on ' + u.baseProduct + ' (' + u.id + ')' }, { onCreated: (e) => { db.update('upsells', u.id, { enquiryId: e.id, status: 'Offered' }, { note: 'Enquiry ' + e.id + ' created' }); CRM.go('enquiries', e.id); } }); }, 'sm') : null,
        ui.btn('Converted', () => { db.update('upsells', u.id, { status: 'Converted', convertedAt: todayIso(), convertedValue: u.value }, { note: 'Converted' }); ui.toast(u.type + ' converted', 'ok'); CRM.refresh(); }, 'sm ok'),
        ui.btn('Declined', () => ui.formModal('Decline ' + u.id, [{ key: 'declineReason', label: 'Reason', required: true }], {}, (v) => { db.update('upsells', u.id, Object.assign(v, { status: 'Declined' })); CRM.refresh(); }), 'sm'),
      ] : []) : null,
    });
  }
  function upsellModal(prefill) {
    prefill = prefill || {};
    ui.formModal('Upsell / cross-sell opportunity', [
      { key: 'customerId', label: 'Customer', type: 'select', required: true, options: master.customers().map((c) => ({ value: c.id, label: c.name })) },
      { key: 'baseProduct', label: 'Customer bought / has', required: true },
      { key: 'type', label: 'Type', type: 'select', options: ['Upsell', 'Cross-sell'], required: true, default: 'Cross-sell' },
      { key: 'productId', label: 'Product offered', type: 'select', required: true, options: master.products().map((p) => ({ value: p.id, label: p.division + ' · ' + p.name })), onChange: (v, inp) => { const p = master.product(v); if (p) inp.value.value = p.price * (Number(inp.quantity.value) || 1); } },
      { key: 'quantity', label: 'Quantity', type: 'number', default: 1, required: true, onChange: (v, inp) => { const p = master.product(inp.productId.value); if (p) inp.value.value = p.price * (Number(v) || 1); } },
      { key: 'value', label: 'Value of upsell / cross-sell (₹)', type: 'number', required: true },
      !isExec() ? { key: 'execId', label: 'Executive responsible', type: 'select', options: execOptions(), required: true } : null,
      { key: 'rationale', label: 'Rationale', full: true },
    ].filter(Boolean), prefill, (v) => {
      const p = master.product(v.productId); const c = master.customer(v.customerId);
      db.insert('upsells', Object.assign(v, { accountName: c.name, product: p.name, offerCategory: p.category, division: p.division, execId: v.execId || me(), status: 'Suggested', date: todayIso(), enquiryId: prefill.enquiryId || '', orderId: prefill.orderId || '' }), { prefix: 'UPS', note: v.type + ' opportunity logged' });
      ui.toast('Opportunity logged', 'ok'); CRM.refresh();
    });
  }
  function renderUpsell(el) {
    const list = allUps(), mk = monthKey(CRM.TODAY);
    const conv = list.filter((u) => u.status === 'Converted');
    ui.page(el, { title: 'Upselling & Cross Selling', sub: 'Auto-suggested on every approved sale order (e.g. UPS → batteries / stabilizer) · value and executive responsible tracked', actions: [canWork() ? ui.btn('+ Opportunity', () => upsellModal(), 'primary') : null] });
    el.appendChild(ui.kpis([
      { label: 'Open opportunities', value: list.filter((u) => ['Suggested', 'Offered'].includes(u.status)).length, meta: fmt.lakh(sum(list.filter((u) => ['Suggested', 'Offered'].includes(u.status)), 'value')) },
      { label: 'Upsells converted (month)', value: conv.filter((u) => u.type === 'Upsell' && monthKey(u.convertedAt) === mk).length, color: 'var(--chart-4)' },
      { label: 'Cross-sells converted (month)', value: conv.filter((u) => u.type === 'Cross-sell' && monthKey(u.convertedAt) === mk).length, color: 'var(--chart-1)' },
      { label: 'Converted value (all time)', value: fmt.lakh(sum(conv, 'value')), color: 'var(--ok)' },
      { label: 'Conversion rate', value: fmt.pct(util.pct(conv.length, list.filter((u) => u.status !== 'Suggested').length)) },
    ]));
    el.appendChild(h('div', { class: 'grid g3' }, [
      h('div', { class: 'span2' }, card('Opportunities', upsellTable(list), { flush: true })),
      h('div', { class: 'stack' }, [
        card('Suggestion rules', h('div', { class: 'stack', style: 'gap:6px' }, UPSELL_RULES.map((r) => h('div', { class: 'small' }, [h('b', {}, r.when), ' → ', ui.badge(r.type, r.type === 'Upsell' ? 'violet' : 'brand'), ' ', r.offer, h('div', { class: 'muted' }, r.why)])))),
        card('Converted value by executive', ui.hbars(execs().filter((s) => !isExec() || s.id === me()).map((s) => ({ label: s.name, value: sum(conv.filter((u) => u.execId === s.id), 'value') })), { money: true })),
      ]),
    ]));
  }

  // ============================================================ dealer sales management
  // Monthly dealer sales = dealer-sourced orders (enquiries with Lead Source "Dealer" / dealer reference, approved SOs) + dealer-reported secondary sales (manual)
  const dealerOrders = (d, mk) => db.all('orders').filter((o) => o.dealerId === d.id && o.approval === 'Approved' && (!mk || monthKey(o.wonDate) === mk));
  const dealerAuto = (d, mk) => sum(dealerOrders(d, mk), 'value');
  const dealerManual = (d, mk) => Number((d.sales || {})[mk]) || 0;
  function renderDealers(el) {
    const list = scope(db.all('dealers'));
    const months = monthsBack(7), cur = months[6], prev = months[5];
    ui.page(el, { title: 'Dealer Sales', sub: 'Dealer name, area, dealer sales executive and monthly dealer sales — derived from dealer-sourced orders, plus dealer-reported sales', actions: canWork() ? [ui.btn('+ Dealer', () => ui.formModal('New dealer', [{ key: 'name', label: 'Dealer name', required: true }, { key: 'area', label: 'Dealer area', type: 'select', options: master.areas, required: true }, { key: 'division', label: 'Division', type: 'select', options: DIVS, required: true }, { key: 'execId', label: 'Dealer sales executive', type: 'select', options: execOptions(), required: true, default: isExec() ? me() : '' }, { key: 'contact', label: 'Contact' }, { key: 'phone', label: 'Phone' }, { key: 'creditLimit', label: 'Credit limit (₹)', type: 'number' }], {}, (v) => { if (db.one('dealers', (d) => d.name.toLowerCase() === v.name.toLowerCase())) { ui.toast('Dealer already exists', 'bad'); return false; } db.insert('dealers', Object.assign(v, { sales: {}, since: todayIso(), status: 'Active' }), { prefix: 'DLR' }); ui.toast('Dealer added', 'ok'); CRM.refresh(); })), ui.btn('Record dealer-reported sales', () => dealerSalesModal(list), 'primary')] : [] });
    const auto = (k) => sum(list, (d) => dealerAuto(d, k)), man = (k) => sum(list, (d) => dealerManual(d, k)), tot = (k) => auto(k) + man(k);
    el.appendChild(ui.kpis([{ label: 'Active dealers', value: list.length }, { label: 'Dealer sales · ' + monthLabel(cur), value: fmt.lakh(tot(cur)), meta: (tot(prev) ? (tot(cur) >= tot(prev) ? '▲ ' : '▼ ') + util.pct(Math.abs(tot(cur) - tot(prev)), tot(prev)) + '% vs ' + monthLabel(prev) : ''), tone: tot(cur) >= tot(prev) ? 'up' : 'down' }, { label: 'From dealer-sourced orders · ' + monthLabel(cur), value: fmt.lakh(auto(cur)), meta: list.reduce((n, d) => n + dealerOrders(d, cur).length, 0) + ' orders (auto)', color: 'var(--ok)' }, { label: 'Dealer-reported · ' + monthLabel(cur), value: fmt.lakh(man(cur)), color: 'var(--chart-3)' }, { label: 'Last 7 months', value: fmt.lakh(sum(months, tot)) }]));
    el.appendChild(h('div', { class: 'grid g3' }, [
      h('div', { class: 'span2' }, card('Dealers', ui.table({ rows: () => list.map((d) => Object.assign({}, d, { execName: execName(d.execId), auto: dealerAuto(d, cur), man: dealerManual(d, cur), cur: dealerAuto(d, cur) + dealerManual(d, cur), prev: dealerAuto(d, prev) + dealerManual(d, prev), six: sum(months, (m) => dealerAuto(d, m) + dealerManual(d, m)), n: dealerOrders(d).length })), filters: [{ key: 'division', label: 'divisions', options: DIVS }], columns: [{ key: 'name', label: 'Dealer name', render: (d) => h('div', {}, [h('b', {}, d.name), h('div', { class: 'small muted' }, d.id + ' · ' + (d.contact || '') + ' · ' + (d.phone || ''))]) }, { key: 'area', label: 'Dealer area' }, { key: 'division', label: 'Division', render: (d) => ui.divTag(d.division) }, { key: 'execName', label: 'Dealer sales executive' }, { key: 'auto', label: monthLabel(cur) + ' · orders', cls: 'right', render: (d) => fmt.money(d.auto) }, { key: 'man', label: monthLabel(cur) + ' · reported', cls: 'right', render: (d) => fmt.money(d.man) }, { key: 'prev', label: monthLabel(prev), cls: 'right', render: (d) => fmt.money(d.prev) }, { key: 'trend', label: 'Trend', render: (d) => ui.badge(d.cur >= d.prev ? '▲' : '▼', d.cur >= d.prev ? 'ok' : 'bad'), sort: (d) => d.cur - d.prev }, { key: 'n', label: 'Orders (all)', cls: 'right' }, { key: 'six', label: '7-month total', cls: 'right', render: (d) => fmt.lakh(d.six) }], onRow: (d) => dealerDrawer(db.get('dealers', d.id)) }), { flush: true })),
      card('Monthly dealer sales', ui.barChart(months.map((m) => ({ label: monthLabel(m), values: [auto(m), man(m)] })), [{ name: 'Dealer-sourced orders', color: 'var(--chart-1)' }, { name: 'Dealer-reported', color: 'var(--chart-3)' }], { money: true, height: 240 })),
    ]));
  }
  function dealerDrawer(d) {
    if (!d) return;
    const ords = dealerOrders(d).sort((a, b) => (a.wonDate < b.wonDate ? 1 : -1));
    ui.drawer({ title: d.name, sub: d.area + ' · ' + d.division + ' · ' + execName(d.execId), body: h('div', { class: 'stack' }, [
      ui.dl([['Dealer ID', d.id], ['Contact', [d.contact, d.phone].filter(Boolean).join(' · ')], ['Credit limit', fmt.money(d.creditLimit)], ['Since', fmt.date(d.since)], ['Dealer-sourced orders', ords.length + ' · ' + fmt.lakh(sum(ords, 'value'))]]),
      h('h3', {}, 'Dealer-sourced orders'),
      ui.table({ rows: ords, search: false, pageSize: 8, onRow: (o) => orderDrawer(db.get('orders', o.id)), empty: 'No orders from leads of this dealer yet', columns: [{ key: 'wonDate', label: 'Won', render: (o) => fmt.date(o.wonDate) }, { key: 'soNumber', label: 'SO', render: (o) => mono(o.soNumber) }, { key: 'accountName', label: 'Customer' }, { key: 'value', label: 'Value', cls: 'right', render: (o) => fmt.money(o.value) }, { key: 'execId', label: 'Executive', render: (o) => execName(o.execId) }] }),
    ]) });
  }
  function dealerSalesModal(list) {
    ui.formModal('Record dealer-reported monthly sales', [{ key: 'dealerId', label: 'Dealer', type: 'select', required: true, options: list.map((d) => ({ value: d.id, label: d.name })) }, { key: 'month', label: 'Month', type: 'month', required: true, default: monthKey(CRM.TODAY) }, { key: 'value', label: 'Dealer-reported sales value (₹) — secondary sales not booked through our orders', type: 'number', required: true, min: 0 }], {}, (v) => {
      if (!(v.value >= 0)) { ui.toast('Enter a value of zero or more', 'bad'); return false; }
      const d = db.get('dealers', v.dealerId); db.update('dealers', d.id, { sales: Object.assign({}, d.sales, { [v.month]: v.value }) }, { note: 'Monthly sales ' + v.month + ' = ' + fmt.money(v.value) });
      ui.toast('Dealer sales recorded', 'ok'); CRM.refresh();
    });
  }

  // ============================================================ mobile sales (phone-frame UI for the Sales Executive)
  function getLocation() {
    return new Promise((resolve) => {
      let done = false;
      const sim = () => { if (done) return; done = true; resolve({ lat: +(11.0168 + (Math.random() - 0.5) * 0.08).toFixed(5), lng: +(76.9558 + (Math.random() - 0.5) * 0.08).toFixed(5), accuracy: 50, simulated: true }); };
      const timer = setTimeout(sim, 5000);
      try {
        if (!navigator.geolocation) { clearTimeout(timer); sim(); return; }
        navigator.geolocation.getCurrentPosition((p) => { if (done) return; done = true; clearTimeout(timer); resolve({ lat: +p.coords.latitude.toFixed(5), lng: +p.coords.longitude.toFixed(5), accuracy: Math.round(p.coords.accuracy), simulated: false }); }, () => { clearTimeout(timer); sim(); }, { timeout: 4500, maximumAge: 60000 });
      } catch (e) { clearTimeout(timer); sim(); }
    });
  }
  const mapLink = (loc) => (loc ? h('a', { href: 'https://www.openstreetmap.org/?mlat=' + loc.lat + '&mlon=' + loc.lng + '#map=15/' + loc.lat + '/' + loc.lng, target: '_blank', rel: 'noopener' }, '📍 ' + loc.lat + ', ' + loc.lng + (loc.simulated ? ' (simulated)' : '')) : '—');
  const todayCheckin = (execId) => db.one('checkins', (c) => c.execId === execId && c.date === todayIso());
  function routeMap(chk) {
    const pts = [chk.checkInLoc].concat((chk.visits || []).map((v) => v.loc), [chk.checkOutLoc]).filter(Boolean);
    if (!pts.length) return ui.empty('No location points', '📍');
    const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
    const [a, b, c, d] = [Math.min(...lats) - 0.005, Math.max(...lats) + 0.005, Math.min(...lngs) - 0.005, Math.max(...lngs) + 0.005];
    const X = (p) => 20 + (p.lng - c) / (d - c) * 360, Y = (p) => 180 - (p.lat - a) / (b - a) * 160;
    let svg = '<svg viewBox="0 0 400 200"><rect x="0" y="0" width="400" height="200" rx="8" fill="var(--surface-3)"/>';
    svg += '<polyline fill="none" stroke="var(--brand)" stroke-width="2" stroke-dasharray="5 4" points="' + pts.map((p) => X(p) + ',' + Y(p)).join(' ') + '"/>';
    pts.forEach((p, i) => { const last = i === pts.length - 1 && chk.checkOutLoc; svg += '<circle cx="' + X(p) + '" cy="' + Y(p) + '" r="7" fill="' + (i === 0 ? 'var(--ok)' : last ? 'var(--bad)' : 'var(--chart-1)') + '"><title>' + (i === 0 ? 'Check-in' : last ? 'Check-out' : 'Visit ' + i) + ' ' + p.lat + ',' + p.lng + '</title></circle><text x="' + (X(p) + 9) + '" y="' + (Y(p) + 4) + '">' + (i === 0 ? 'IN' : last ? 'OUT' : i) + '</text>'; });
    return h('div', { class: 'chart', html: svg + '</svg><div class="legend"><span><i style="background:var(--ok)"></i>Check-in</span><span><i style="background:var(--brand)"></i>Visits</span><span><i style="background:var(--bad)"></i>Check-out</span></div>' });
  }
  function renderMobile(el) {
    ui.page(el, { title: 'Mobile Sales', sub: 'Field app for Sales Executives — create enquiries, update follow-ups & site visits, upload quotations, update order status and payments, check-in / check-out with location mapping' });
    const grid = h('div', { class: 'grid g2' });
    el.appendChild(grid);
    const screen = h('div', { class: 'phone-screen' });
    const left = isExec() ? h('div', { class: 'phone' }, screen) : card('Phone preview', calloutH('The phone app is used by Sales Executives. Switch role to <b>Sales Executive</b> to use it. Field activity of all executives is listed alongside.', 'info'));
    const chks = scope(db.all('checkins')).slice().sort((a, b) => (a.checkInAt < b.checkInAt ? 1 : -1));
    const right = h('div', { class: 'stack' }, [
      card('Check-in / check-out register', ui.table({ rows: chks.map((c) => Object.assign({}, c, { execName: execName(c.execId) })), search: !isExec(), pageSize: 8, columns: [{ key: 'date', label: 'Date', render: (c) => fmt.date(c.date) }, { key: 'execName', label: 'Executive' }, { key: 'checkInAt', label: 'In', render: (c) => h('div', {}, [timeText(c.checkInAt), h('div', { class: 'small' }, mapLink(c.checkInLoc))]) }, { key: 'checkOutAt', label: 'Out', render: (c) => (c.checkOutAt ? h('div', {}, [timeText(c.checkOutAt), h('div', { class: 'small' }, mapLink(c.checkOutLoc))]) : ui.badge('On field', 'warn')) }, { key: 'visits', label: 'Visits', render: (c) => (c.visits || []).length }], onRow: (c) => ui.drawer({ title: 'Field day · ' + execName(c.execId), sub: fmt.date(c.date), body: h('div', { class: 'stack' }, [routeMap(c), ui.timeline([{ when: fmt.dateTime(c.checkInAt), title: 'Checked in', body: mapLink(c.checkInLoc).textContent }].concat((c.visits || []).map((v) => ({ when: fmt.dateTime(v.at), title: v.note + ' · ' + (v.accountName || ''), body: v.loc ? v.loc.lat + ', ' + v.loc.lng : '' })), c.checkOutAt ? [{ when: fmt.dateTime(c.checkOutAt), title: 'Checked out' }] : []))]) }) }), { flush: true }),
      chks[0] ? card('Location mapping · ' + execName(chks[0].execId) + ' · ' + fmt.date(chks[0].date), routeMap(chks[0])) : null,
    ]);
    grid.appendChild(left); grid.appendChild(right);
    if (!isExec()) return;
    let view = 'home';
    const go = (v) => { view = v; draw(); };
    const pbtn = (label, onClick, cls) => h('button', { class: 'btn ' + (cls || ''), style: 'width:100%;justify-content:center;padding:12px 8px', onClick }, label);
    const backBar = (title) => h('div', { class: 'row', style: 'padding:12px;background:var(--surface);border-bottom:1px solid var(--border);flex-wrap:nowrap' }, [ui.btn('‹', () => go('home'), 'sm'), h('b', {}, title)]);
    const myOpen = () => allEnq().filter((e) => OPEN.includes(e.stage));
    function draw() {
      screen.innerHTML = '';
      const chk = todayCheckin(me());
      if (view === 'home') {
        const tasks = dailyTasks();
        screen.appendChild(h('div', { style: 'background:linear-gradient(105deg,var(--power-black) 72%,var(--maruthi-red) 72%);color:#fff;padding:18px 16px 16px' }, [
          h('div', { class: 'small', style: 'opacity:.8' }, fmt.date(new Date()) + ' · Maruthi Sales'),
          h('h2', { style: 'margin:4px 0 2px' }, 'Hi, ' + CRM.user().name.split(' ')[0]),
          h('div', { class: 'small', style: 'opacity:.9' }, chk ? (chk.checkOutAt ? 'Checked out at ' + timeText(chk.checkOutAt) : 'On field since ' + timeText(chk.checkInAt)) : 'Not checked in'),
        ]));
        const body = h('div', { style: 'padding:14px', class: 'stack' });
        body.appendChild(!chk ? pbtn('📍 Check in', () => { ui.toast('Fetching location…'); getLocation().then((loc) => { db.insert('checkins', { execId: me(), date: todayIso(), checkInAt: nowIso(), checkInLoc: loc, checkOutAt: '', checkOutLoc: null, visits: [] }, { prefix: 'CHK', note: 'Checked in' }); ui.toast('Checked in' + (loc.simulated ? ' (simulated location)' : ''), 'ok'); CRM.refresh(); }); }, 'primary')
          : !chk.checkOutAt ? pbtn('🏁 Check out', () => { getLocation().then((loc) => { db.update('checkins', chk.id, { checkOutAt: nowIso(), checkOutLoc: loc }, { note: 'Checked out' }); ui.toast('Checked out', 'ok'); CRM.refresh(); }); }, 'danger') : calloutH('Day closed · ' + (chk.visits || []).length + ' visits logged', 'ok'));
        body.appendChild(h('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr;gap:10px' }, [
          pbtn('➕ New enquiry', () => go('enquiry')), pbtn('📅 Follow-ups (' + tasks.filter((t) => t.fu).length + ')', () => go('followups')),
          pbtn('🏠 Site visit', () => go('visit')), pbtn('📄 Upload quote', () => go('quote')),
          pbtn('📦 Order status', () => go('order')), pbtn('₹ Payment update', () => go('payment')),
        ]));
        body.appendChild(h('h3', {}, "Today's tasks"));
        body.appendChild(taskList(tasks, 6));
        screen.appendChild(body);
      } else if (view === 'enquiry') {
        screen.appendChild(backBar('Quick enquiry'));
        const f = ui.form([
          { key: 'customerId', label: 'Existing customer', type: 'select', full: true, options: master.customers().map((c) => ({ value: c.id, label: c.name })), onChange: (v, inp) => { const c = master.customer(v); if (c) { inp.accountName.value = c.name; inp.contactName.value = c.contact; inp.contactNumber.value = c.phone; inp.area.value = c.area; } } },
          { key: 'accountName', label: 'Account name', required: true, full: true }, { key: 'contactName', label: 'Contact', required: true, full: true }, { key: 'contactNumber', label: 'Phone', required: true, full: true },
          { key: 'area', label: 'Area', type: 'select', options: master.areas, required: true, full: true, default: (db.get('staff', me()) || {}).area },
          { key: 'division', label: 'Division', type: 'select', options: DIVS, required: true, full: true, default: CRM.user().division || 'Power', onChange: (v, inp) => fillSelect(inp.productId, prodOptions(v)) },
          { key: 'productId', label: 'Product', type: 'select', options: prodOptions(CRM.user().division || 'Power'), required: true, full: true },
          { key: 'quantity', label: 'Qty', type: 'number', default: 1, required: true, full: true },
          { key: 'salesChannel', label: 'Source', type: 'select', options: CHANNELS, required: true, full: true, default: 'Office Walk-in' },
          { key: 'leadSource', label: 'Lead source', type: 'select', options: LEAD_SOURCES, required: true, full: true, default: 'Walk-in' },
        ]);
        f.style.gridTemplateColumns = '1fr';
        screen.appendChild(h('div', { style: 'padding:14px', class: 'stack' }, [f, pbtn('Save enquiry', () => {
          if (!f.validate()) return;
          const v = f.values();
          if (!v.customerId) { const dup = findDuplicateCustomer(v); if (dup) { v.customerId = dup.id; v.accountName = dup.name; ui.toast('Duplicate check: linked to existing customer ' + dup.id, 'warn'); } }
          const c = master.customer(v.customerId);
          const p = master.product(v.productId);
          const e = createEnquiry(Object.assign(v, { email: c ? c.email : '', segment: c ? c.segment : 'Commercial', customerType: c ? c.type : 'New Customer', expectedValue: p.price * (v.quantity || 1), nextFollowUp: util.iso(util.addDays(CRM.TODAY, 1)), sourceDetails: 'Created from mobile' }));
          ui.toast(e.id + ' created from mobile', 'ok'); go('home');
        }, 'primary')]));
      } else if (view === 'followups') {
        screen.appendChild(backBar('Follow-ups'));
        const fus = allFu().filter((x) => x.status === 'Planned' && x.dueDate <= util.iso(util.addDays(CRM.TODAY, 1))).sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1));
        screen.appendChild(h('div', { style: 'padding:12px', class: 'stack' }, fus.length ? fus.map((x) => h('div', { class: 'card card-body' }, [h('div', { class: 'row', style: 'justify-content:space-between' }, [h('b', {}, x.accountName), ui.badge(fuStatus(x), fuTone(fuStatus(x)))]), h('div', { class: 'small muted' }, x.type + ' · ' + x.purpose), h('div', { class: 'row', style: 'margin-top:8px' }, [ui.btn('✓ Done', () => completeFollowUp(x, draw), 'sm ok'), ui.btn('☎ Call', () => { window.open('tel:' + ((db.get('enquiries', x.enquiryId) || {}).contactNumber || '')); }, 'sm'), ui.btn('Reschedule', () => rescheduleFollowUp(x), 'sm')])])) : [ui.empty('No follow-ups due', '✅')]));
      } else if (view === 'visit') {
        screen.appendChild(backBar('Site visit'));
        const list = myOpen().filter((e) => e.siteVisitRequired || e.stage === 'Site Visit Scheduled');
        screen.appendChild(h('div', { style: 'padding:12px', class: 'stack' }, list.length ? list.map((e) => h('div', { class: 'card card-body' }, [h('b', {}, e.accountName), h('div', { class: 'small muted' }, e.id + ' · ' + e.stage + (e.siteVisitDate ? ' · visit ' + fmt.date(e.siteVisitDate) : '')), h('div', { class: 'row', style: 'margin-top:8px' }, e.siteVisitDoneAt ? [ui.badge('Visit completed', 'ok')] : [ui.btn('📍 Mark visit completed here', () => {
          const c = todayCheckin(me());
          if (!c || c.checkOutAt) { ui.toast('Check in first to log a site visit with location', 'bad'); return; }
          getLocation().then((loc) => {
            db.update('checkins', c.id, { visits: (c.visits || []).concat([{ at: nowIso(), enquiryId: e.id, accountName: e.accountName, note: 'Site visit', loc }]) }, { note: 'Visit logged at ' + e.accountName });
            const patch = { siteVisitDate: todayIso(), siteVisitDoneAt: nowIso(), progressNotes: 'Site visit completed (mobile, ' + loc.lat + ',' + loc.lng + ')' };
            if (STAGES.indexOf(e.stage) < 3) Object.assign(patch, { stage: 'Site Visit Completed', stageHistory: (e.stageHistory || []).concat([{ stage: 'Site Visit Completed', at: nowIso(), by: CRM.user().name, note: 'Logged from mobile with location' }]) });
            db.update('enquiries', e.id, patch, { note: 'Site visit completed from mobile' });
            ui.toast('Site visit recorded with location', 'ok'); draw();
          });
        }, 'sm primary')])])) : [ui.empty('No site visits pending', '🏠')]));
      } else if (view === 'quote') {
        screen.appendChild(backBar('Upload quotation'));
        const qs = allQuotes().filter((q) => q.status !== 'Rejected').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 12);
        screen.appendChild(h('div', { style: 'padding:12px', class: 'stack' }, [pbtn('+ New quotation', () => quoteModal(), 'primary')].concat(qs.map((q) => { const inp = h('input', { type: 'file', accept: QUOTE_ACCEPT, style: 'max-width:100%' }); inp.addEventListener('change', () => { if (inp.files[0]) { const nm = inp.files[0].name; storeQuoteFile(q.id, inp.files[0], 'Uploaded from mobile: ' + nm, () => { ui.toast('Uploaded ' + nm, 'ok'); draw(); }); } }); return h('div', { class: 'card card-body' }, [h('div', { class: 'row', style: 'justify-content:space-between' }, [h('b', {}, q.id), ui.badge(q.approval === 'Approved' ? q.status : q.approval)]), h('div', { class: 'small muted' }, q.accountName + ' · ' + fmt.money(q.quoteValue)), h('div', { class: 'small' }, q.fileName ? quoteFileLink(q) : '📎 No file'), inp]); }))));
      } else if (view === 'order') {
        screen.appendChild(backBar('Order status'));
        screen.appendChild(h('div', { style: 'padding:12px', class: 'stack' }, myOpen().slice(0, 15).map((e) => { const sel = h('select', { style: 'width:100%' }, [h('option', { value: '' }, 'Update stage…')].concat(STAGES.filter((s) => s !== e.stage).map((s) => h('option', { value: s }, s)))); sel.addEventListener('change', () => { if (sel.value) moveStage(e, sel.value, draw); sel.value = ''; }); return h('div', { class: 'card card-body' }, [h('div', { class: 'row', style: 'justify-content:space-between' }, [h('b', {}, e.accountName), stageBadge(e.stage)]), h('div', { class: 'small muted', style: 'margin-bottom:6px' }, e.id + ' · ' + e.product), sel]); }).concat(allOrders().filter((o) => !o.migrated).slice(-5).reverse().map((o) => h('div', { class: 'card card-body' }, [h('b', {}, o.soNumber || o.id), h('div', { class: 'small muted' }, o.accountName), ui.badge(orderStatus(o))])))));
      } else if (view === 'payment') {
        screen.appendChild(backBar('Payment update'));
        const invs = allInvoices().filter((i) => outstandingOf(i) > 0).sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1));
        screen.appendChild(h('div', { style: 'padding:12px', class: 'stack' }, invs.length ? invs.map((i) => h('div', { class: 'card card-body' }, [h('div', { class: 'row', style: 'justify-content:space-between' }, [h('b', {}, i.accountName), ui.badge(invStatus(i), invTone(invStatus(i)))]), h('div', { class: 'small muted' }, i.invoiceNo + ' · due ' + fmt.date(i.dueDate)), h('div', {}, 'Outstanding ' + fmt.money(outstandingOf(i))), ui.btn('Record collection', () => recordPayment(i, { title: 'Payment collected (field update)', onDone: draw }), 'sm primary')])) : [ui.empty('No outstanding invoices', '₹')]));
      }
    }
    draw();
  }

  // ============================================================ data migration (Excel / CSV import)
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const pickField = (rec, ...names) => { const keys = Object.keys(rec); for (const n of names) { const k = keys.find((x) => norm(x) === norm(n)); if (k && rec[k] !== '') return rec[k]; } return ''; };
  const parseDate = (s) => { s = String(s || '').trim(); if (!s) return null; let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); if (m) return new Date(+m[1], +m[2] - 1, +m[3], 10); m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(s); if (m) return new Date(+(m[3].length === 2 ? '20' + m[3] : m[3]), +m[2] - 1, +m[1], 10); const d = new Date(s); return isNaN(d) ? null : d; };
  const matchOpt = (val, opts) => opts.find((o) => norm(o) === norm(val)) || '';
  const money = (v) => Number(String(v || '').replace(/[^\d.]/g, '')) || 0;
  const yes = (v) => /^(y|yes|true|1|done)$/i.test(String(v || '').trim());
  const IMPORTERS = {
    customers: {
      label: 'Customer master', header: ['Account Name', 'Customer Type', 'Contact Name', 'Contact Number', 'Email', 'Area', 'Segment', 'GSTIN'],
      sample: [['Sri Lakshmi Textiles', 'Existing Customer', 'Ravi K', '9876501234', 'accounts@srilakshmi.in', 'Tiruppur', 'Industrial', '33AAACS1234C1Z5'], ['Vel Hospital', 'Key Customer', 'Dr. Kumar', '9842211223', 'admin@velhospital.in', 'RS Puram', 'Healthcare', '']],
      check(r, seen) {
        const d = { name: pickField(r, 'Account Name', 'Customer Name', 'Name'), type: matchOpt(pickField(r, 'Customer Type', 'Type'), CUSTOMER_TYPES) || 'Existing Customer', contact: pickField(r, 'Contact Name', 'Contact'), phone: pickField(r, 'Contact Number', 'Phone', 'Mobile'), email: pickField(r, 'Email'), area: matchOpt(pickField(r, 'Area'), master.areas) || pickField(r, 'Area'), segment: matchOpt(pickField(r, 'Segment'), master.segments) || 'Commercial', gstin: pickField(r, 'GSTIN') };
        if (!d.name || !d.phone) return { ok: false, msg: 'Account name and contact number are mandatory', d };
        const dup = findDuplicateCustomer({ accountName: d.name, contactNumber: d.phone, email: d.email });
        if (dup) return { ok: false, msg: 'Duplicate of ' + dup.id + ' (' + dup.name + ') — skipped', d, dup: true };
        if (seen.has(digits(d.phone)) || seen.has(norm(d.name))) return { ok: false, msg: 'Duplicate row in file', d, dup: true };
        seen.add(digits(d.phone)); seen.add(norm(d.name));
        return { ok: true, msg: master.areas.includes(d.area) ? 'Ready' : 'Ready (area not in master: ' + d.area + ')', d };
      },
      commit(d) { const c = db.insert('customers', Object.assign(d, { id: nextCustomerId(), since: todayIso(), source: 'Data migration' }), { prefix: 'CUS', note: 'Imported from Excel/CSV' }); db.insert('sites', { customerId: c.id, name: 'Main Site', address: d.area + ', Coimbatore', contact: d.contact, phone: d.phone, access: 'Reception' }, { silent: true }); },
      cols: ['name', 'type', 'contact', 'phone', 'area', 'segment'],
    },
    leads: {
      label: 'Lead history', header: ['Enquiry Date', 'Account Name', 'Contact Name', 'Contact Number', 'Email', 'Area', 'Segment', 'Division', 'Product', 'Quantity', 'Expected Value', 'Source', 'Lead Source', 'Source Details', 'Sales Stage', 'Executive Name', 'Remarks'],
      sample: [['12/08/2026', 'Kovai Medical Center', 'Mohan S', '9843012345', '', 'Peelamedu', 'Healthcare', 'Power', 'Maruthi Online UPS 10KVA', '2', '270000', 'Office Walk-in', 'Walk-in', 'Migrated from Excel', 'Negotiation', 'Deepak S', 'Old CRM lead'], ['03/09/2026', 'New Horizon Apartments', 'Selvam R', '9790011223', 'sec@newhorizon.in', 'Saravanampatti', 'Residential', 'Electronic Security', 'IP Dome Camera 4MP', '24', '120000', 'Digital Marketing', 'Website', 'Website form', 'Contact Made', '', '']],
      check(r) {
        const division = matchOpt(pickField(r, 'Division'), DIVS);
        const pname = pickField(r, 'Product');
        const p = division && (master.products(division).find((x) => norm(x.name) === norm(pname)) || master.products(division).find((x) => pname && norm(x.name).includes(norm(pname))));
        const ex = execs().find((s) => norm(s.name) === norm(pickField(r, 'Executive Name', 'Executive')));
        const d = { date: parseDate(pickField(r, 'Enquiry Date', 'Date')) || new Date(), accountName: pickField(r, 'Account Name'), contactName: pickField(r, 'Contact Name'), contactNumber: pickField(r, 'Contact Number', 'Phone'), email: pickField(r, 'Email'), area: matchOpt(pickField(r, 'Area'), master.areas) || master.areas[0], segment: matchOpt(pickField(r, 'Segment'), master.segments) || 'Commercial', division, productId: p ? p.id : '', product: p ? p.name : pname, quantity: Number(pickField(r, 'Quantity', 'Qty')) || 1, expectedValue: Number(String(pickField(r, 'Expected Value', 'Value')).replace(/[^\d.]/g, '')) || 0, salesChannel: matchOpt(pickField(r, 'Source'), CHANNELS) || 'Office Walk-in', leadSource: matchOpt(pickField(r, 'Lead Source'), LEAD_SOURCES) || 'Walk-in', sourceDetails: pickField(r, 'Source Details') || 'Migrated lead', stage: matchOpt(pickField(r, 'Sales Stage', 'Stage'), STAGES) || 'Enquiry Received', execId: ex ? ex.id : '', remarks: pickField(r, 'Remarks') };
        if (!d.accountName || !d.contactNumber) return { ok: false, msg: 'Account name and contact number are mandatory', d };
        if (!division) return { ok: false, msg: 'Division must be Power / Electronic Security / Solar', d };
        if (!p) return { ok: false, msg: 'Unknown product "' + pname + '" for ' + division, d };
        const dup = findDuplicateCustomer(d);
        if (dup) { d.customerId = dup.id; d.accountName = dup.name; }
        if (!d.expectedValue) d.expectedValue = p.price * d.quantity;
        return { ok: true, msg: (dup ? 'Linked to ' + dup.id : 'Prospect') + ' · ' + (ex ? ex.name : 'auto-assign'), d };
      },
      commit(d) {
        const created = d.date.toISOString();
        const e = createEnquiry(Object.assign({}, d, { date: undefined, customerType: d.customerId ? (master.customer(d.customerId) || {}).type : 'New Customer', migrated: true }), { createdAt: created, stage: d.stage, quiet: true });
        if (d.stage === 'Order Won' || d.stage === 'Order Lost') db.update('enquiries', e.id, { closedAt: created, followUpStatus: 'Completed' }, { silent: true });
      },
      cols: ['accountName', 'division', 'product', 'quantity', 'expectedValue', 'stage'],
    },
    orders: {
      label: 'Sales orders', roles: ['sales_manager', 'admin'],
      header: ['SO Number', 'PO Number', 'Order Date', 'SO Issued Date', 'Account Name', 'Contact Number', 'Division', 'Product', 'Quantity', 'Order Value', 'Payment Terms', 'Executive Name', 'Lead Source', 'Dealer Name', 'Installation Completion Date', 'New Customer'],
      sample: [['SO/25-26/H812', 'PO/KMC/2025/77', '14/09/2025', '15/09/2025', 'Kovai Medical Center', '9843012345', 'Power', 'Maruthi Online UPS 10KVA', '2', '270000', 'Credit 30 days', 'Deepak S', 'Walk-in', '', '24/09/2025', 'No'], ['SO/25-26/H813', 'PO/SVP/118', '02/10/2025', '02/10/2025', 'Sri Vinayaga Traders', '9790055511', 'Power', 'Exide 150Ah Tubular', '6', '84000', 'Against delivery', '', 'Dealer', 'Sri Vinayaga Power Systems', '06/10/2025', 'Yes']],
      check(r, seen) {
        const division = matchOpt(pickField(r, 'Division'), DIVS);
        const pname = pickField(r, 'Product');
        const p = division && (master.products(division).find((x) => norm(x.name) === norm(pname)) || master.products(division).find((x) => pname && norm(x.name).includes(norm(pname))));
        const ex = execs().find((s2) => norm(s2.name) === norm(pickField(r, 'Executive Name', 'Executive')));
        const dl = db.all('dealers').find((x) => norm(x.name) === norm(pickField(r, 'Dealer Name', 'Dealer')));
        const won = parseDate(pickField(r, 'Order Date', 'Order Won Date', 'Date'));
        const d = { soNumber: pickField(r, 'SO Number', 'Sales Order Number'), poNumber: pickField(r, 'PO Number'), wonDate: won, soIssuedDate: parseDate(pickField(r, 'SO Issued Date')) || won, accountName: pickField(r, 'Account Name', 'Customer Name'), phone: pickField(r, 'Contact Number', 'Phone'), division, productId: p ? p.id : '', product: p ? p.name : pname, quantity: Number(pickField(r, 'Quantity', 'Qty')) || 1, value: money(pickField(r, 'Order Value', 'Value')), paymentTerms: matchOpt(pickField(r, 'Payment Terms'), Object.keys(PAY_TERMS)) || 'Credit 30 days', execId: ex ? ex.id : '', leadSource: matchOpt(pickField(r, 'Lead Source'), LEAD_SOURCES) || '', dealerId: dl ? dl.id : '', installationCompletionDate: parseDate(pickField(r, 'Installation Completion Date', 'Installed On')), newCustomer: yes(pickField(r, 'New Customer')) };
        if (!d.soNumber || !d.accountName) return { ok: false, msg: 'SO number and account name are mandatory', d };
        if (!division) return { ok: false, msg: 'Division must be Power / Electronic Security / Solar', d };
        if (!won) return { ok: false, msg: 'Order date missing or not a date', d };
        if (!(d.value > 0)) return { ok: false, msg: 'Order value must be greater than zero', d };
        if (db.one('orders', (o) => norm(o.soNumber) === norm(d.soNumber)) || seen.has('so:' + norm(d.soNumber))) return { ok: false, msg: 'SO ' + d.soNumber + ' already exists — skipped', d, dup: true };
        seen.add('so:' + norm(d.soNumber));
        const cust = findDuplicateCustomer({ accountName: d.accountName, contactNumber: d.phone });
        if (cust) { d.customerId = cust.id; d.accountName = cust.name; }
        return { ok: true, msg: (cust ? 'Linked to ' + cust.id : 'New customer will be created') + (p ? '' : ' · product not in master (kept as text)') + (pickField(r, 'Dealer Name') && !dl ? ' · dealer not found' : ''), d };
      },
      collection: 'orders', prefix: 'ORD',
      toRecord: (d) => Object.assign({ enquiryId: '', quotationId: '', customerId: d.customerId || '', accountName: d.accountName, division: d.division, execId: d.execId, productId: d.productId, product: d.product, quantity: d.quantity, value: d.value, wonDate: d.wonDate.toISOString(), poNumber: d.poNumber, materialAvailability: 'Available in stock', deliveryCommitDate: '', paymentTerms: d.paymentTerms, creditDays: PAY_TERMS[d.paymentTerms] || 0, approval: 'Approved', approvedBy: 'Data migration', approvedAt: d.soIssuedDate.toISOString(), soNumber: d.soNumber, soIssuedDate: d.soIssuedDate.toISOString(), newCustomer: !!d.newCustomer, salesChannel: 'Migrated', leadSource: d.leadSource, dealerId: d.dealerId, installationStatus: d.installationCompletionDate ? 'Completed' : 'Pending', installationCompletionDate: d.installationCompletionDate ? util.iso(d.installationCompletionDate) : '', deliveredDate: d.installationCompletionDate ? util.iso(d.installationCompletionDate) : '', migrated: true, createdAt: d.wonDate.toISOString(), _phone: d.phone }, divisionExtras(d.division, d.productId, d.quantity)),
      before(rec) { if (!rec.customerId) rec.customerId = importCustomer(rec.accountName, rec._phone, rec.newCustomer ? 'New Customer' : 'Existing Customer', rec.wonDate); delete rec._phone; },
      after(rec) { promoteCustomer(rec.customerId); },
      cols: ['soNumber', 'accountName', 'division', 'product', 'quantity', 'value'],
    },
    invoices: {
      label: 'Invoices', roles: ['accounts', 'sales_manager', 'admin'],
      header: ['Invoice Number', 'Invoice Date', 'SO Number', 'Account Name', 'Division', 'Invoice Value', 'Payment Terms', 'Payment Due Date', 'Hard Copy Submitted', 'Invoice Mailed', 'Confirmed With'],
      sample: [['MPCS/25-26/INV-0815', '16/09/2025', 'SO/25-26/H812', 'Kovai Medical Center', 'Power', '318600', 'Credit 30 days', '', 'Yes', 'Yes', 'Mohan S'], ['MPCS/25-26/INV-0841', '03/10/2025', 'SO/25-26/H813', 'Sri Vinayaga Traders', 'Power', '99120', 'Against delivery', '03/10/2025', 'Yes', 'No', '']],
      check(r, seen) {
        const no = pickField(r, 'Invoice Number', 'Invoice No');
        const so = pickField(r, 'SO Number');
        const o = so ? db.one('orders', (x) => norm(x.soNumber) === norm(so)) : null;
        const date = parseDate(pickField(r, 'Invoice Date', 'Date'));
        const terms = matchOpt(pickField(r, 'Payment Terms'), Object.keys(PAY_TERMS)) || (o && o.paymentTerms) || 'Credit 30 days';
        const cust = o ? master.customer(o.customerId) : findDuplicateCustomer({ accountName: pickField(r, 'Account Name', 'Customer Name') });
        const d = { invoiceNo: no, invoiceDate: date, soNumber: o ? o.soNumber : so, orderId: o ? o.id : '', customerId: cust ? cust.id : '', accountName: cust ? cust.name : pickField(r, 'Account Name'), division: (o && o.division) || matchOpt(pickField(r, 'Division'), DIVS), execId: o ? o.execId : '', value: money(pickField(r, 'Invoice Value', 'Value')), paymentTerms: terms, dueDate: parseDate(pickField(r, 'Payment Due Date', 'Due Date')), hardCopySubmitted: yes(pickField(r, 'Hard Copy Submitted')), invoiceMailed: yes(pickField(r, 'Invoice Mailed')), confirmedWith: pickField(r, 'Confirmed With') };
        if (!no || !date) return { ok: false, msg: 'Invoice number and invoice date are mandatory', d };
        if (!(d.value > 0)) return { ok: false, msg: 'Invoice value must be greater than zero', d };
        if (!d.customerId) return { ok: false, msg: 'Customer not found — import the customer master / sales orders first', d };
        if (!d.division) return { ok: false, msg: 'Division must be Power / Electronic Security / Solar', d };
        if (db.one('invoices', (i) => norm(i.invoiceNo) === norm(no)) || seen.has(norm(no))) return { ok: false, msg: 'Invoice ' + no + ' already exists — skipped', d, dup: true };
        seen.add(norm(no));
        if (!d.dueDate) d.dueDate = util.addDays(date, PAY_TERMS[terms] || 0);
        return { ok: true, msg: (o ? 'Linked to ' + (o.soNumber || o.id) : 'No sales order link') + ' · due ' + fmt.date(d.dueDate), d };
      },
      collection: 'invoices', prefix: 'INV',
      toRecord: (d) => Object.assign({}, d, { invoiceDate: util.iso(d.invoiceDate), dueDate: util.iso(d.dueDate), gstPct: gstPct(d.division), source: 'Sales', migrated: true, createdAt: d.invoiceDate.toISOString() }),
      cols: ['invoiceNo', 'accountName', 'soNumber', 'division', 'value', 'paymentTerms'],
    },
    payments: {
      label: 'Payments / receipts', roles: ['accounts', 'sales_manager', 'admin'],
      header: ['Invoice Number', 'Received Date', 'Received Value', 'Payment Mode', 'Reference', 'Confirmed With'],
      sample: [['MPCS/25-26/INV-0815', '12/10/2025', '318600', 'NEFT / RTGS', 'UTR558812', 'Mohan S'], ['MPCS/25-26/INV-0841', '05/10/2025', '50000', 'Cheque', 'CHQ 004512', '']],
      check(r, seen) {
        const no = pickField(r, 'Invoice Number', 'Invoice No');
        const inv = db.one('invoices', (i) => norm(i.invoiceNo) === norm(no));
        const d = { invoiceNo: no, invoiceId: inv ? inv.id : '', accountName: inv ? inv.accountName : '', receivedDate: parseDate(pickField(r, 'Received Date', 'Payment Received Date', 'Date')), value: money(pickField(r, 'Received Value', 'Value', 'Amount')), mode: matchOpt(pickField(r, 'Payment Mode', 'Mode'), PAY_MODES) || 'NEFT / RTGS', reference: pickField(r, 'Reference', 'UTR'), confirmedWith: pickField(r, 'Confirmed With') };
        if (!inv) return { ok: false, msg: 'Invoice ' + (no || '?') + ' not found — import invoices first', d };
        if (!d.receivedDate) return { ok: false, msg: 'Received date missing or not a date', d };
        if (!(d.value > 0)) return { ok: false, msg: 'Received value must be greater than zero', d };
        const used = seen.used || (seen.used = {});
        const left = outstandingOf(inv) - (used[inv.id] || 0);
        if (d.value > left) return { ok: false, msg: 'Exceeds outstanding of ' + fmt.money(left), d };
        if (d.reference && db.one('payments', (p) => p.invoiceId === inv.id && norm(p.reference) === norm(d.reference))) return { ok: false, msg: 'Receipt ' + d.reference + ' already recorded — skipped', d, dup: true };
        used[inv.id] = (used[inv.id] || 0) + d.value;
        return { ok: true, msg: 'Ready · ' + (util.iso(d.receivedDate) <= util.iso(inv.dueDate) ? 'on time' : 'late') + ' vs due ' + fmt.date(inv.dueDate), d };
      },
      collection: 'payments', prefix: 'PAY',
      toRecord(d) {
        const i = db.get('invoices', d.invoiceId);
        return { invoiceId: i.id, orderId: i.orderId, customerId: i.customerId, accountName: i.accountName, division: i.division, execId: i.execId, receivedDate: util.iso(d.receivedDate), value: d.value, mode: d.mode, reference: d.reference, confirmedWith: d.confirmedWith, recordedBy: 'Data migration', verified: true, verifiedBy: CRM.user().name, onTime: !i.dueDate || util.iso(d.receivedDate) <= util.iso(i.dueDate), migrated: true, createdAt: d.receivedDate.toISOString() };
      },
      cols: ['invoiceNo', 'accountName', 'receivedDate', 'value', 'mode'],
    },
  };
  IMPORTERS.customers.roles = ['sales_manager', 'admin'];
  IMPORTERS.leads.roles = ['sales_manager', 'admin'];
  const MONEY_COLS = ['expectedValue', 'value'];
  function commitImport(imp, d) {
    if (imp.commit) { imp.commit(d); return; }
    const rec = imp.toRecord(d);
    if (imp.before) imp.before(rec);
    const n = db.insert(imp.collection, rec, { prefix: imp.prefix, note: imp.label + ' imported (data migration)' });
    if (imp.after) imp.after(n);
  }
  // Also offer the sales-history importers on the core Data Import page (Core API v2)
  if (CRM.registerImporter) ['orders', 'invoices', 'payments'].forEach((k) => {
    const imp = IMPORTERS[k];
    CRM.registerImporter({
      id: 'sales-' + k, title: 'Sales · ' + imp.label, collection: imp.collection, prefix: imp.prefix, roles: imp.roles,
      description: 'Sales data migration — same validation as Sales › Data Migration (links customers, orders and invoices; duplicates skipped).',
      columns: imp.header.map((hd) => ({ key: hd, label: hd })), sample: imp.sample,
      map(row, ctx) {
        const seen = ctx.salesSeen || (ctx.salesSeen = new Set());
        const r = imp.check(row, seen);
        if (!r.ok) return r.dup ? { skip: r.msg } : { error: r.msg };
        return imp.toRecord(r.d);
      },
      beforeInsert: imp.before ? (rec) => imp.before(rec) : undefined,
      onInserted: imp.after ? (rec) => imp.after(rec) : undefined,
    });
  });
  function importCustomer(name, phone, type, since) {
    const c = db.insert('customers', { id: nextCustomerId(), name, type: type || 'Existing Customer', contact: '', phone: phone || '', email: '', area: master.areas[0], segment: 'Commercial', since: util.iso(since || CRM.TODAY), source: 'Data migration (sales history)' }, { prefix: 'CUS', note: 'Customer created from imported sales history' });
    db.insert('sites', { customerId: c.id, name: 'Main Site', address: 'Coimbatore', contact: '', phone: phone || '', access: 'Reception' }, { silent: true });
    return c.id;
  }
  function renderImport(el) {
    ui.page(el, { title: 'Data Migration', sub: 'Import the existing CRM / Excel data — save the sheet as CSV, preview & validate, then import. Duplicates are checked against the customer master.' });
    const keys = Object.keys(IMPORTERS).filter((k) => CRM.is(...IMPORTERS[k].roles));
    if (!keys.length) { el.appendChild(ui.empty('No importers available for your role', '🔒')); return; }
    el.appendChild(calloutH('Suggested order: <b>customer master → lead history → sales orders → invoices → payments</b>. Imported orders are marked as migrated history (no hand-over to Projects / Service); imported receipts are recorded as verified.', 'info'));
    el.appendChild(ui.tabs(keys.map((k) => ({ id: k, label: IMPORTERS[k].label })), (id, body) => {
      const imp = IMPORTERS[id];
      const ta = h('textarea', { style: 'width:100%;min-height:140px;font-family:var(--mono);font-size:12px;padding:8px;border:1px solid var(--border-strong);border-radius:7px;background:var(--surface)', placeholder: 'Paste CSV here (first row = headers) or choose a file…' });
      const file = h('input', { type: 'file', accept: '.csv,.txt' });
      file.addEventListener('change', () => { const f = file.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { ta.value = r.result; preview(); }; r.readAsText(f); });
      const out = h('div', { class: 'mt' });
      function preview() {
        out.innerHTML = '';
        const { header, records } = parseCsv(ta.value);
        if (!records.length) { out.appendChild(calloutH('No data rows found. The first row must contain the headers: ' + imp.header.join(', '), 'warn')); return; }
        const seen = new Set();
        const res = records.map((r, i) => Object.assign({ row: i + 2 }, imp.check(r, seen)));
        const ok = res.filter((r) => r.ok);
        out.appendChild(calloutH('<b>' + records.length + '</b> rows read · columns: ' + util.esc(header.join(', ')) + ' · <b>' + ok.length + '</b> ready · <b>' + (res.length - ok.length) + '</b> will be skipped', ok.length ? 'ok' : 'warn'));
        out.appendChild(h('div', { class: 'mt' }, card('Preview', ui.table({ rows: res.map((r) => Object.assign({ status: r.ok ? 'Ready' : r.dup ? 'Duplicate' : 'Error', msg: r.msg }, r.d, { row: r.row })), search: false, pageSize: 10, columns: [{ key: 'row', label: 'Row' }].concat(imp.cols.map((k) => ({ key: k, label: k, render: (r) => (MONEY_COLS.includes(k) ? fmt.money(r[k]) : r[k] instanceof Date ? fmt.date(r[k]) : r[k]) })), [{ key: 'status', label: 'Status', render: (r) => ui.badge(r.status, r.status === 'Ready' ? 'ok' : r.status === 'Duplicate' ? 'warn' : 'bad') }, { key: 'msg', label: 'Validation' }]) }), { flush: true, actions: ok.length ? [ui.btn('Import ' + ok.length + ' rows', () => { ok.forEach((r) => commitImport(imp, r.d)); ui.toast(ok.length + ' ' + imp.label.toLowerCase() + ' records imported', 'ok'); ta.value = ''; out.innerHTML = ''; out.appendChild(calloutH('Imported ' + ok.length + ' records. ' + ('<a href="#/' + ({ customers: 'customer360', leads: 'enquiries', orders: 'orders', invoices: 'invoices', payments: 'payments' }[id] || 'enquiries') + '">Open ' + imp.label.toLowerCase() + '</a>'), 'ok')); }, 'primary sm')] : null })));
      }
      body.appendChild(card('Import ' + imp.label, h('div', { class: 'stack' }, [
        calloutH('Expected columns: <b>' + imp.header.join(', ') + '</b>. Dates as DD/MM/YYYY or YYYY-MM-DD. Header names are matched case-insensitively.', 'info'),
        h('div', { class: 'row' }, [ui.btn('⇩ Download template', () => downloadCsv(id + '-template.csv', imp.header, imp.sample), 'sm'), ui.btn('Load sample data', () => { ta.value = [imp.header].concat(imp.sample).map((r) => r.map(csvCell).join(',')).join('\n'); preview(); }, 'sm'), file]),
        ta, h('div', { class: 'row' }, [ui.btn('Preview & validate', preview, 'primary')]),
      ])));
      body.appendChild(out);
    }));
  }

  // ============================================================ finance: invoices (Accounts updates the invoice)
  const yesNo = (v) => ui.badge(v ? 'Yes' : 'No', v ? 'ok' : 'warn');
  function invoiceTable(rows, opts) {
    opts = opts || {};
    return ui.table({
      rows: () => (typeof rows === 'function' ? rows() : rows).map((i) => Object.assign({}, i, { st: invStatus(i), os: outstandingOf(i), paid: paidOf(i), execName: execName(i.execId) })).sort((a, b) => (a.invoiceDate < b.invoiceDate ? 1 : -1)), search: opts.search, pageSize: opts.pageSize,
      filters: opts.search === false ? null : [{ key: 'st', label: 'statuses', options: ['Paid', 'Partial', 'Unpaid', 'Due Today', 'Overdue'] }, { key: 'division', label: 'divisions', options: DIVS }, { key: 'source', label: 'sources', options: ['Sales', 'Service'] }],
      columns: [
        { key: 'invoiceNo', label: 'Invoice number', render: (i) => mono(i.invoiceNo) }, { key: 'invoiceDate', label: 'Invoice date', render: (i) => fmt.date(i.invoiceDate) },
        { key: 'soNumber', label: 'SO / ref', render: (i) => mono(i.soNumber || i.complaintId || '—') }, { key: 'accountName', label: 'Account' }, { key: 'division', label: 'Division', render: (i) => ui.divTag(i.division) },
        { key: 'value', label: 'Invoice value', cls: 'right', render: (i) => fmt.money(i.value), footer: (rs) => fmt.lakh(sum(rs, 'value')) },
        { key: 'paymentTerms', label: 'Terms' }, { key: 'dueDate', label: 'Due date', render: (i) => fmt.date(i.dueDate) },
        { key: 'paid', label: 'Received', cls: 'right', render: (i) => fmt.money(i.paid) },
        { key: 'os', label: 'Outstanding', cls: 'right', render: (i) => h('b', {}, fmt.money(i.os)), footer: (rs) => fmt.lakh(sum(rs, 'os')) },
        { key: 'hardCopySubmitted', label: 'Hard copy', render: (i) => yesNo(i.hardCopySubmitted) }, { key: 'invoiceMailed', label: 'Mailed', render: (i) => yesNo(i.invoiceMailed) },
        { key: 'confirmedWith', label: 'Confirmed with' }, { key: 'st', label: 'Status', render: (i) => ui.badge(i.st, invTone(i.st)) },
      ],
      actions: isAcc() ? (i) => [ui.btn('Update', () => raiseInvoice(db.get('orders', i.orderId) || { value: exGst(i.value, i.division), division: i.division, accountName: i.accountName, customerId: i.customerId }, db.get('invoices', i.id)), 'sm'), i.os > 0 ? ui.btn('₹ Receipt', () => recordPayment(db.get('invoices', i.id)), 'sm primary') : null] : null,
    });
  }
  function renderInvoices(el) {
    const invs = db.all('invoices');
    const toInv = db.all('orders').filter((o) => o.approval === 'Approved' && !o.migrated && !invoicesOf(o.id).length);
    const mk = monthKey(CRM.TODAY);
    ui.page(el, { title: 'Invoices', sub: 'Accounts raises & updates invoices after SO approval — invoice date, number, value, hard copy, mail and confirmation tracked', actions: [ui.btn('⇩ Export CSV', () => downloadCsv('invoices.csv', ['Invoice Number', 'Invoice Date', 'SO Number', 'Account', 'Division', 'Invoice Value', 'Payment Terms', 'Payment Due Date', 'Received', 'Outstanding', 'Hard Copy Submitted', 'Invoice Mailed', 'Confirmed With', 'Status'], invs.map((i) => [i.invoiceNo, i.invoiceDate, i.soNumber, i.accountName, i.division, i.value, i.paymentTerms, i.dueDate, paidOf(i), outstandingOf(i), i.hardCopySubmitted ? 'Yes' : 'No', i.invoiceMailed ? 'Yes' : 'No', i.confirmedWith, invStatus(i)])))] });
    el.appendChild(ui.kpis([
      { label: 'To be invoiced', value: toInv.length, meta: fmt.lakh(sum(toInv, invoiceDefault)) + ' incl. GST', color: 'var(--warn)' },
      { label: 'Invoiced this month', value: fmt.lakh(sum(invs.filter((i) => monthKey(i.invoiceDate) === mk), 'value')), color: 'var(--chart-5)' },
      { label: 'Hard copy not submitted', value: invs.filter((i) => !i.hardCopySubmitted && outstandingOf(i) > 0).length, color: 'var(--chart-4)' },
      { label: 'Not mailed', value: invs.filter((i) => !i.invoiceMailed).length, color: 'var(--chart-3)' },
      { label: 'Service charges to collect', value: fmt.lakh(sum(invs.filter((i) => i.source === 'Service'), outstandingOf)), color: 'var(--chart-4)' },
    ]));
    el.appendChild(ui.tabs([{ id: 'to', label: 'To be invoiced', count: toInv.length }, { id: 'all', label: 'Invoices', count: invs.length }], (id, body) => {
      if (id === 'to') body.appendChild(card(null, ui.table({ rows: toInv, empty: 'All approved sale orders are invoiced', columns: [{ key: 'soNumber', label: 'SO number', render: (o) => mono(o.soNumber) }, { key: 'soIssuedDate', label: 'SO issued', render: (o) => fmt.date(o.soIssuedDate) }, { key: 'accountName', label: 'Account' }, { key: 'division', label: 'Division', render: (o) => ui.divTag(o.division) }, { key: 'product', label: 'Product' }, { key: 'value', label: 'Value (ex-GST)', cls: 'right', render: (o) => fmt.money(o.value) }, { key: 'paymentTerms', label: 'Terms' }, { key: 'waiting', label: 'Waiting', render: (o) => ui.badge(fmt.rel(o.soIssuedDate), util.daysBetween(o.soIssuedDate, CRM.TODAY) > 2 ? 'bad' : 'info') }], actions: isAcc() ? (o) => [ui.btn('Raise invoice', () => raiseInvoice(db.get('orders', o.id)), 'sm primary')] : null }), { flush: true }));
      else body.appendChild(card(null, invoiceTable(invs), { flush: true }));
    }));
  }

  // ============================================================ finance: payments & collections
  function renderPayments(el) {
    const invs = allInvoices(), pays = scope(db.all('payments'));
    const t = todayIso(), mk = monthKey(CRM.TODAY);
    const dueWin = Number(cfg('sales.reminders').paymentDueDays) || 0;
    const dueSoon = invs.filter((i) => outstandingOf(i) > 0 && util.iso(i.dueDate) >= t && util.daysBetween(CRM.TODAY, parseD(util.iso(i.dueDate))) <= dueWin);
    const overdue = invs.filter((i) => invStatus(i) === 'Overdue');
    ui.page(el, { title: 'Payments & Collections', sub: 'Payment terms, due date, received date & value, payment mode, outstanding (auto), invoice hard copy / mail, confirmed with', actions: [isAcc() || canWork() ? ui.btn('+ Record payment', () => recordPayment(), 'primary') : null] });
    el.appendChild(ui.kpis([
      { label: 'Collected today', value: fmt.lakh(sum(pays.filter((p) => p.receivedDate === t), 'value')), color: 'var(--ok)' },
      { label: 'Collected this month', value: fmt.lakh(sum(pays.filter((p) => monthKey(p.receivedDate) === mk), 'value')), meta: util.pct(pays.filter((p) => monthKey(p.receivedDate) === mk && p.onTime).length, pays.filter((p) => monthKey(p.receivedDate) === mk).length) + '% as per policy', color: 'var(--ok)' },
      { label: 'Due today', value: fmt.lakh(sum(invs.filter((i) => util.iso(i.dueDate) === t), outstandingOf)), color: 'var(--warn)' },
      { label: 'Overdue', value: fmt.lakh(sum(overdue, outstandingOf)), meta: overdue.length + ' invoices', color: 'var(--bad)' },
      { label: 'Field updates to verify', value: pays.filter((p) => !p.verified).length, color: 'var(--chart-4)' },
    ]));
    if (dueSoon.length || overdue.length) el.appendChild(calloutH("<b>Payment-due alerts:</b> " + dueSoon.length + ' invoice(s) due within ' + dueWin + ' days (' + fmt.lakh(sum(dueSoon, outstandingOf)) + ') and ' + overdue.length + ' overdue beyond credit policy (' + fmt.lakh(sum(overdue, outstandingOf)) + '). Reminders go to Accounts and the executive automatically.', overdue.length ? 'bad' : 'warn'));
    section(el, ui.tabs([{ id: 'track', label: 'Payment tracking' }, { id: 'due', label: 'Due & overdue', count: dueSoon.length + overdue.length }, { id: 'rcpt', label: 'Receipts', count: pays.length }], (id, body) => {
      if (id === 'track') body.appendChild(card(null, ui.table({
        rows: () => invs.map((i) => { const ps = paymentsOf(i).sort((a, b) => (a.receivedDate < b.receivedDate ? 1 : -1)); return Object.assign({}, i, { last: ps[0] || {}, paid: paidOf(i), os: outstandingOf(i), st: invStatus(i) }); }).sort((a, b) => b.os - a.os),
        filters: [{ key: 'st', label: 'statuses', options: ['Paid', 'Partial', 'Unpaid', 'Due Today', 'Overdue'] }, { key: 'paymentTerms', label: 'terms', options: Object.keys(PAY_TERMS) }],
        columns: [{ key: 'invoiceNo', label: 'Invoice', render: (i) => mono(i.invoiceNo) }, { key: 'accountName', label: 'Account' }, { key: 'paymentTerms', label: 'Payment terms' }, { key: 'dueDate', label: 'Payment due date', render: (i) => fmt.date(i.dueDate) }, { key: 'lr', label: 'Payment received date', render: (i) => fmt.date(i.last.receivedDate) }, { key: 'paid', label: 'Received value (verified)', cls: 'right', render: (i) => h('div', {}, [fmt.money(i.paid), pendingOf(i) ? h('div', { class: 'small muted' }, '+ ' + fmt.money(pendingOf(i)) + ' to verify') : null]) }, { key: 'mode', label: 'Payment mode', render: (i) => i.last.mode || '—' }, { key: 'os', label: 'Outstanding (auto)', cls: 'right', render: (i) => h('b', {}, fmt.money(i.os)), footer: (rs) => fmt.lakh(sum(rs, 'os')) }, { key: 'hardCopySubmitted', label: 'Hard copy submitted', render: (i) => yesNo(i.hardCopySubmitted) }, { key: 'invoiceMailed', label: 'Invoice mailed', render: (i) => yesNo(i.invoiceMailed) }, { key: 'confirmedWith', label: 'Confirmed with' }, { key: 'st', label: 'Status', render: (i) => ui.badge(i.st, invTone(i.st)) }],
        actions: (i) => (i.os > 0 && (isAcc() || canWork()) ? [ui.btn('₹', () => recordPayment(db.get('invoices', i.id)), 'sm primary')] : []),
      }), { flush: true }));
      if (id === 'due') body.appendChild(card(null, invoiceTable(dueSoon.concat(overdue)), { flush: true }));
      if (id === 'rcpt') body.appendChild(card(null, ui.table({
        rows: () => pays.map((p) => Object.assign({}, p, { inv: (db.get('invoices', p.invoiceId) || {}).invoiceNo, policy: p.onTime ? 'On time' : 'Late' })).sort((a, b) => (a.receivedDate < b.receivedDate ? 1 : -1)),
        filters: [{ key: 'mode', label: 'modes', options: PAY_MODES }, { key: 'policy', label: 'policy', options: ['On time', 'Late'] }],
        columns: [{ key: 'id', label: 'Receipt', render: (p) => mono(p.id) }, { key: 'receivedDate', label: 'Received', render: (p) => fmt.date(p.receivedDate) }, { key: 'inv', label: 'Invoice', render: (p) => mono(p.inv) }, { key: 'accountName', label: 'Account' }, { key: 'value', label: 'Value', cls: 'right', render: (p) => fmt.money(p.value), footer: (rs) => fmt.lakh(sum(rs, 'value')) }, { key: 'mode', label: 'Mode' }, { key: 'reference', label: 'Reference' }, { key: 'confirmedWith', label: 'Confirmed with' }, { key: 'policy', label: 'As per policy', render: (p) => ui.badge(p.policy, p.onTime ? 'ok' : 'warn') }, { key: 'recordedBy', label: 'Recorded by' }, { key: 'verified', label: 'Verified', render: (p) => ui.badge(p.verified ? 'Verified' : 'Pending', p.verified ? 'ok' : 'warn') }],
        actions: isAcc() ? (p) => (!p.verified ? [ui.btn('Verify', () => { const inv = db.get('invoices', p.invoiceId); if (inv && p.value > outstandingOf(inv)) { ui.toast('Receipt exceeds the invoice outstanding of ' + fmt.money(outstandingOf(inv)) + ' — check for a duplicate entry', 'bad'); return; } db.update('payments', p.id, { verified: true, verifiedBy: CRM.user().name, verifiedAt: nowIso() }, { note: 'Payment verified by Accounts' }); ui.toast('Payment verified · outstanding updated', 'ok'); CRM.refresh(); }, 'sm ok')] : []) : null,
      }), { flush: true }));
    }));
  }

  // ============================================================ finance: outstanding & ageing
  function renderOutstanding(el) {
    const invs = allInvoices().filter((i) => outstandingOf(i) > 0);
    const byB = BUCKETS.map((b) => sum(invs.filter((i) => ageBucket(i) === b), outstandingOf));
    ui.page(el, { title: 'Outstanding & Ageing', sub: 'Outstanding auto-computed from invoices minus receipts · ageing by days past due date (credit policy)', actions: [ui.btn('⇩ Export CSV', () => downloadCsv('outstanding-ageing.csv', ['Invoice', 'Account', 'Division', 'Due Date', 'Days Overdue', 'Bucket', 'Outstanding', 'Executive'], invs.map((i) => [i.invoiceNo, i.accountName, i.division, i.dueDate, Math.max(0, overdueDays(i)), ageBucket(i), outstandingOf(i), execName(i.execId)])))] });
    el.appendChild(ui.kpis([{ label: 'Total outstanding', value: fmt.lakh(sum(invs, outstandingOf)), meta: invs.length + ' invoices' }].concat(BUCKETS.map((b, i) => ({ label: b, value: fmt.lakh(byB[i]), color: BUCKET_COLORS[i] })))));
    const custs = Object.values(util.groupBy(invs, 'accountName')).map((list) => { const r = { accountName: list[0].accountName, customerId: list[0].customerId, total: sum(list, outstandingOf), n: list.length }; BUCKETS.forEach((b) => { r[b] = sum(list.filter((i) => ageBucket(i) === b), outstandingOf); }); return r; }).sort((a, b) => b.total - a.total);
    el.appendChild(h('div', { class: 'grid g3' }, [
      card('Ageing buckets', ui.donut(BUCKETS.map((b, i) => ({ label: b, value: byB[i], color: BUCKET_COLORS[i] })), { money: true, label: 'Outstanding' })),
      h('div', { class: 'span2' }, card('Customer-wise ageing', ui.table({ rows: custs, search: true, pageSize: 8, onRow: (r) => r.customerId && CRM.go('customer360', r.customerId), columns: [{ key: 'accountName', label: 'Customer' }, { key: 'n', label: 'Inv.' }].concat(BUCKETS.map((b) => ({ key: b, label: b, cls: 'right', render: (r) => (r[b] ? fmt.money(r[b]) : '—') })), [{ key: 'total', label: 'Total', cls: 'right', render: (r) => h('b', {}, fmt.money(r.total)), footer: (rs) => fmt.lakh(sum(rs, 'total')) }]) }), { flush: true })),
    ]));
    section(el, card('Invoice-wise outstanding', ui.table({
      rows: () => invs.map((i) => Object.assign({}, i, { os: outstandingOf(i), od: Math.max(0, overdueDays(i)), bucket: ageBucket(i), execName: execName(i.execId) })).sort((a, b) => b.od - a.od),
      filters: [{ key: 'bucket', label: 'buckets', options: BUCKETS }, { key: 'division', label: 'divisions', options: DIVS }],
      columns: [{ key: 'invoiceNo', label: 'Invoice', render: (i) => mono(i.invoiceNo) }, { key: 'accountName', label: 'Account' }, { key: 'division', label: 'Division', render: (i) => ui.divTag(i.division) }, { key: 'dueDate', label: 'Due', render: (i) => fmt.date(i.dueDate) }, { key: 'od', label: 'Days overdue', render: (i) => ui.badge(i.od ? i.od + ' d' : 'Not due', i.od > 60 ? 'bad' : i.od > 0 ? 'warn' : 'ok') }, { key: 'os', label: 'Outstanding', cls: 'right', render: (i) => fmt.money(i.os), footer: (rs) => fmt.lakh(sum(rs, 'os')) }, { key: 'confirmedWith', label: 'Confirmed with' }, { key: 'execName', label: 'Executive' }],
      actions: (i) => { const e = db.one('enquiries', (x) => x.id === (db.get('orders', i.orderId) || {}).enquiryId) || { id: '', contactNumber: (master.customer(i.customerId) || {}).phone, email: (master.customer(i.customerId) || {}).email }; const txt = 'A gentle reminder: invoice ' + i.invoiceNo + ' for ' + fmt.money(i.os) + (parseD(util.iso(i.dueDate)) < CRM.TODAY ? ' was due on ' : ' is due on ') + fmt.date(i.dueDate) + '. — Team Maruthi, Accounts'; return [ui.btn('💬', () => sendWhatsApp(e.id, e.contactNumber, txt), 'sm'), ui.btn('✉', () => sendEmail(e.id, e.email, 'Payment reminder ' + i.invoiceNo, txt), 'sm'), (isAcc() || canWork()) ? ui.btn('₹', () => recordPayment(db.get('invoices', i.id)), 'sm primary') : null]; },
    }), { flush: true }));
  }

  // ============================================================ report centre (Daily 10 · Weekly 2 · Monthly 7)
  const fdiv = (list, f) => list.filter((r) => !f.division || r.division === f.division);
  const repExecs = (f) => execs().filter((s) => (!isExec() || s.id === me()) && (!f.division || s.division === f.division));
  const tvaColumns = (keys) => [{ label: 'Name', get: (r) => r.name, render: (r) => h('b', {}, r.name) }].concat(keys.map((k) => { const m = METRICS.find((x) => x[0] === k); return { label: m[1], get: (r) => r.a[k] + ' / ' + (r.t[k] || 0), render: (r) => tvaCell(r.a[k], r.t[k] || 0, m[2]) }; }));
  const tvaExecRows = (f) => repExecs(f).map((s) => ({ name: s.name + ' (' + (s.division || '') + ')', t: targetFor('exec', s.id, f.from, f.to), a: achievedFor({ execId: s.id }, f.from, f.to) }));
  const tvaDivRows = (f) => DIVS.filter((d) => !f.division || d === f.division).map((d) => ({ name: d, t: targetFor('division', d, f.from, f.to), a: achievedFor({ division: d }, f.from, f.to) }));
  const shiftYear = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setFullYear(d.getFullYear() + n); return util.iso(d); };
  const salesIn = (from, to, div) => sum(db.all('orders').filter((o) => o.approval === 'Approved' && inRange(o.wonDate, from, to) && (!div || o.division === div) && (!isExec() || o.execId === me())), 'value');
  const REPORTS = [
    { id: 'd1', group: 'Daily', title: 'Enquiries received & prospects', build(f) { const rows = fdiv(allEnq(), f).filter((e) => inRange(e.date, f.from, f.to)); const pros = rows.filter((e) => OPEN.includes(e.stage)); return { kpis: [{ label: 'Enquiries received', value: rows.length }, { label: 'Active prospects', value: pros.length, meta: fmt.lakh(sum(pros, 'expectedValue')) }].concat(DIVS.map((d) => ({ label: d, value: rows.filter((e) => e.division === d).length, color: master.divisionColor(d) }))), rows, columns: [{ label: 'Enquiry No', get: (e) => e.id }, { label: 'Date', get: (e) => e.date }, { label: 'Account', get: (e) => e.accountName }, { label: 'Division', get: (e) => e.division }, { label: 'Product', get: (e) => e.product + ' × ' + e.quantity }, { label: 'Expected value', get: (e) => e.expectedValue, render: (e) => fmt.money(e.expectedValue) }, { label: 'Source', get: (e) => e.salesChannel }, { label: 'Lead source', get: (e) => e.leadSource }, { label: 'Executive', get: (e) => execName(e.execId) }, { label: 'Stage', get: (e) => e.stage, render: (e) => stageBadge(e.stage) }] }; } },
    { id: 'd2', group: 'Daily', title: 'Quotations sent', build(f) { const rows = fdiv(allQuotes(), f).filter((q) => inRange(q.quoteDate, f.from, f.to)); return { kpis: [{ label: 'Quotations sent', value: rows.length }, { label: 'Quoted value', value: fmt.lakh(sum(rows, 'quoteValue')) }], rows, columns: [{ label: 'Quote No', get: (q) => q.id }, { label: 'Given date', get: (q) => util.iso(q.quoteDate) }, { label: 'Account', get: (q) => q.accountName }, { label: 'Division', get: (q) => q.division }, { label: 'Quote value', get: (q) => q.quoteValue, render: (q) => fmt.money(q.quoteValue) }, { label: 'Status', get: (q) => q.status, render: (q) => ui.badge(q.status) }, { label: 'Executive', get: (q) => execName(q.execId) }] }; } },
    { id: 'd3', group: 'Daily', title: 'Quotation response time', build(f) { const rows = fdiv(allQuotes(), f).filter((q) => inRange(q.quoteDate, f.from, f.to)); const r = rows.map(quoteResponseHrs); return { kpis: [{ label: 'Average response', value: hrsText(avg(r)) }, { label: 'Within 24 h', value: fmt.pct(util.pct(r.filter((x) => x <= 24).length, r.length)), color: 'var(--ok)' }, { label: 'Breached (> 24 h)', value: r.filter((x) => x > 24).length, color: 'var(--bad)' }], rows, columns: [{ label: 'Quote No', get: (q) => q.id }, { label: 'Enquiry', get: (q) => q.enquiryId }, { label: 'Account', get: (q) => q.accountName }, { label: 'Enquiry created', get: (q) => fmt.dateTime((db.get('enquiries', q.enquiryId) || {}).createdAt) }, { label: 'Quote given', get: (q) => fmt.dateTime(q.quoteDate) }, { label: 'Response (h)', get: (q) => quoteResponseHrs(q), render: (q) => respBadge(quoteResponseHrs(q)) }, { label: 'Executive', get: (q) => execName(q.execId) }] }; } },
    { id: 'd4', group: 'Daily', title: 'Orders won', build(f) { const rows = fdiv(allOrders(), f).filter((o) => o.approval === 'Approved' && inRange(o.wonDate, f.from, f.to)); const pend = fdiv(allOrders(), f).filter((o) => o.approval === 'Awaiting Approval' && inRange(o.wonDate, f.from, f.to)); return { kpis: [{ label: 'Orders won (SO approved)', value: rows.length }, { label: 'Order value', value: fmt.lakh(sum(rows, 'value')), color: 'var(--ok)' }, { label: 'New customers', value: acquisitions(f.from, f.to, (o) => (!f.division || o.division === f.division) && (!isExec() || o.execId === me())).length }, { label: 'Awaiting SO approval', value: pend.length, meta: fmt.lakh(sum(pend, 'value')), color: 'var(--warn)' }], rows, columns: [{ label: 'Order', get: (o) => o.id }, { label: 'Won date', get: (o) => util.iso(o.wonDate) }, { label: 'SO number', get: (o) => o.soNumber }, { label: 'PO number', get: (o) => o.poNumber }, { label: 'Account', get: (o) => o.accountName }, { label: 'Division', get: (o) => o.division }, { label: 'Product', get: (o) => o.product }, { label: 'Value', get: (o) => o.value, render: (o) => fmt.money(o.value) }, { label: 'Executive', get: (o) => execName(o.execId) }] }; } },
    { id: 'd5', group: 'Daily', title: 'Sales order processing time', build(f) { const rows = fdiv(allOrders(), f).filter((o) => inRange(o.soIssuedDate, f.from, f.to)); const r = rows.map(soProcessingHrs); return { kpis: [{ label: 'SOs issued', value: rows.length }, { label: 'Average SO processing', value: hrsText(avg(r)) }, { label: '> 24 h after approval', value: r.filter((x) => x > 24).length, color: 'var(--bad)' }], rows, columns: [{ label: 'SO number', get: (o) => o.soNumber }, { label: 'Account', get: (o) => o.accountName }, { label: 'Order won', get: (o) => fmt.dateTime(o.wonDate) }, { label: 'SO issued', get: (o) => fmt.dateTime(o.soIssuedDate) }, { label: 'Processing (h)', get: (o) => soProcessingHrs(o), render: (o) => respBadge(soProcessingHrs(o)) }, { label: 'Material', get: (o) => o.materialAvailability }] }; } },
    { id: 'd6', group: 'Daily', title: 'Payment to collect today', build(f) { const rows = fdiv(allInvoices(), f).filter((i) => outstandingOf(i) > 0 && util.iso(i.dueDate) <= f.to).sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1)); const dueNow = rows.filter((i) => util.iso(i.dueDate) >= f.from); return { kpis: [{ label: 'Due in period', value: fmt.lakh(sum(dueNow, outstandingOf)), meta: dueNow.length + ' invoices', color: 'var(--warn)' }, { label: 'Overdue carried forward', value: fmt.lakh(sum(rows.filter((i) => util.iso(i.dueDate) < f.from), outstandingOf)), color: 'var(--bad)' }, { label: 'Total to collect', value: fmt.lakh(sum(rows, outstandingOf)) }], rows, columns: [{ label: 'Invoice', get: (i) => i.invoiceNo }, { label: 'Account', get: (i) => i.accountName }, { label: 'Due date', get: (i) => i.dueDate }, { label: 'Days overdue', get: (i) => Math.max(0, overdueDays(i)) }, { label: 'Outstanding', get: (i) => outstandingOf(i), render: (i) => fmt.money(outstandingOf(i)) }, { label: 'Confirmed with', get: (i) => i.confirmedWith }, { label: 'Executive', get: (i) => execName(i.execId) }] }; } },
    { id: 'd7', group: 'Daily', title: 'Payment collected as per policy', build(f) { const rows = fdiv(scope(db.all('payments')), f).filter((p) => inRange(p.receivedDate, f.from, f.to)); const on = rows.filter((p) => p.onTime); return { kpis: [{ label: 'Collected', value: fmt.lakh(sum(rows, 'value')) }, { label: 'As per policy (on/before due)', value: fmt.lakh(sum(on, 'value')), meta: util.pct(on.length, rows.length) + '% of receipts', color: 'var(--ok)' }, { label: 'Late collections', value: rows.length - on.length, color: 'var(--bad)' }], rows, columns: [{ label: 'Receipt', get: (p) => p.id }, { label: 'Date', get: (p) => p.receivedDate }, { label: 'Account', get: (p) => p.accountName }, { label: 'Value', get: (p) => p.value, render: (p) => fmt.money(p.value) }, { label: 'Mode', get: (p) => p.mode }, { label: 'Due date', get: (p) => (db.get('invoices', p.invoiceId) || {}).dueDate }, { label: 'As per policy', get: (p) => (p.onTime ? 'Yes' : 'No'), render: (p) => ui.badge(p.onTime ? 'On time' : 'Late', p.onTime ? 'ok' : 'bad') }] }; } },
    { id: 'd8', group: 'Daily', title: 'Cold calls done vs target', build(f) { const rows = tvaExecRows(f); return { kpis: [{ label: 'Cold calls done', value: sum(rows, (r) => r.a.coldCalls) }, { label: 'Target (pro-rated)', value: Math.round(sum(rows, (r) => r.t.coldCalls)) }], rows, columns: tvaColumns(['coldCalls', 'calls']) }; } },
    { id: 'd9', group: 'Daily', title: 'Upselling & cross selling vs target', build(f) { const rows = tvaExecRows(f); return { kpis: [{ label: 'Upsells', value: sum(rows, (r) => r.a.upsell) }, { label: 'Cross-sells', value: sum(rows, (r) => r.a.crossSell) }], rows, columns: tvaColumns(['upsell', 'crossSell']) }; } },
    { id: 'd10', group: 'Daily', title: 'Follow-ups completed vs planned', build(f) { const fus = fdiv(allFu(), f).filter((x) => x.dueDate >= f.from && x.dueDate <= f.to); const rows = repExecs(f).map((s) => { const m = fus.filter((x) => x.execId === s.id); return { name: s.name, planned: m.length, done: m.filter((x) => x.status === 'Completed').length, resch: m.filter((x) => x.status === 'Rescheduled').length, missed: m.filter((x) => x.status === 'Planned' && x.dueDate < todayIso()).length }; }); return { kpis: [{ label: 'Planned', value: fus.length }, { label: 'Completed', value: fus.filter((x) => x.status === 'Completed').length, color: 'var(--ok)' }, { label: 'Missed', value: fus.filter((x) => x.status === 'Planned' && x.dueDate < todayIso()).length, color: 'var(--bad)' }], rows, columns: [{ label: 'Executive', get: (r) => r.name }, { label: 'Planned', get: (r) => r.planned }, { label: 'Completed', get: (r) => r.done, render: (r) => tvaCell(r.done, r.planned) }, { label: 'Rescheduled', get: (r) => r.resch }, { label: 'Missed', get: (r) => r.missed, render: (r) => ui.badge(r.missed, r.missed ? 'bad' : 'ok') }] }; } },
    { id: 'w1', group: 'Weekly', title: 'Executive-wise target vs achieved', build(f) { const rows = tvaExecRows(f); return { kpis: [{ label: 'Revenue', value: fmt.lakh(sum(rows, (r) => r.a.revenue)), meta: 'Target ' + fmt.lakh(sum(rows, (r) => r.t.revenue)) }], rows, columns: tvaColumns(METRICS.map((m) => m[0])) }; } },
    { id: 'w2', group: 'Weekly', title: 'Division-wise target vs achieved', build(f) { const rows = tvaDivRows(f); return { kpis: rows.map((r) => ({ label: r.name, value: fmt.lakh(r.a.revenue), meta: util.pct(r.a.revenue, r.t.revenue) + '% of ' + fmt.lakh(r.t.revenue), color: master.divisionColor(r.name) })), rows, columns: tvaColumns(METRICS.map((m) => m[0])) }; } },
    { id: 'm1', group: 'Monthly', title: 'Executive-wise target vs achieved', build(f) { return REPORTS.find((r) => r.id === 'w1').build(f); } },
    { id: 'm2', group: 'Monthly', title: 'Division-wise target vs achieved', build(f) { return REPORTS.find((r) => r.id === 'w2').build(f); } },
    { id: 'm3', group: 'Monthly', title: 'Sales comparison (vs same period last year)', build(f) {
      const lyF = shiftYear(f.from, -1), lyT = shiftYear(f.to, -1);
      const rows = DIVS.filter((d) => !f.division || d === f.division).map((d) => ({ name: d, cur: salesIn(f.from, f.to, d), ly: salesIn(lyF, lyT, d) }));
      const cur = sum(rows, 'cur'), ly = sum(rows, 'ly');
      const months = monthsBack(12);
      return { kpis: [{ label: 'Current period', value: fmt.lakh(cur) }, { label: 'Same period last year', value: fmt.lakh(ly) }, { label: 'Growth', value: ly ? (cur >= ly ? '+' : '') + util.pct(cur - ly, ly) + '%' : 'n/a', tone: cur >= ly ? 'up' : 'down', color: cur >= ly ? 'var(--ok)' : 'var(--bad)' }], rows,
        chart: card('Monthly sales — this year vs last year', ui.lineChart(months.map(monthLabel), [{ name: 'This year', color: 'var(--chart-1)', values: months.map((m) => { const [a, b] = monthRange(m); return salesIn(a, b, f.division); }) }, { name: 'Last year', color: 'var(--chart-3)', dashed: true, values: months.map((m) => { const [a, b] = monthRange(m); return salesIn(shiftYear(a, -1), shiftYear(b, -1), f.division); }) }], { money: true })),
        columns: [{ label: 'Division', get: (r) => r.name, render: (r) => ui.divTag(r.name) }, { label: 'Current (' + f.from + ' → ' + f.to + ')', get: (r) => r.cur, render: (r) => fmt.money(r.cur) }, { label: 'Last year (' + lyF + ' → ' + lyT + ')', get: (r) => r.ly, render: (r) => fmt.money(r.ly) }, { label: 'Growth %', get: (r) => (r.ly ? util.pct(r.cur - r.ly, r.ly) : ''), render: (r) => (r.ly ? ui.badge((r.cur >= r.ly ? '+' : '') + util.pct(r.cur - r.ly, r.ly) + '%', r.cur >= r.ly ? 'ok' : 'bad') : '—') }] };
    } },
    { id: 'm4', group: 'Monthly', title: 'Executive-wise cold call performance', build(f) { const rows = tvaExecRows(f).map((r, i) => Object.assign(r, { enq: db.find('callLogs', (c) => c.execId === repExecs(f)[i].id && c.type === 'Cold Call' && c.outcome === 'Enquiry Generated' && inRange(c.date, f.from, f.to)).length })); return { kpis: [{ label: 'Cold calls', value: sum(rows, (r) => r.a.coldCalls) + ' / ' + Math.round(sum(rows, (r) => r.t.coldCalls)) }, { label: 'Enquiries generated', value: sum(rows, 'enq'), color: 'var(--ok)' }], rows, columns: tvaColumns(['coldCalls']).concat([{ label: 'Enquiries generated', get: (r) => r.enq }, { label: 'Hit rate', get: (r) => util.pct(r.enq, r.a.coldCalls) + '%' }]) }; } },
    { id: 'm5', group: 'Monthly', title: 'Executive-wise upselling performance', build(f) { const rows = tvaExecRows(f).map((r, i) => Object.assign(r, { val: sum(db.find('upsells', (u) => u.execId === repExecs(f)[i].id && u.type === 'Upsell' && u.status === 'Converted' && inRange(u.convertedAt, f.from, f.to)), 'value') })); return { kpis: [{ label: 'Upsells', value: sum(rows, (r) => r.a.upsell) + ' / ' + Math.round(sum(rows, (r) => r.t.upsell)) }, { label: 'Upsell value', value: fmt.lakh(sum(rows, 'val')) }], rows, columns: tvaColumns(['upsell']).concat([{ label: 'Upsell value', get: (r) => r.val, render: (r) => fmt.money(r.val) }]) }; } },
    { id: 'm6', group: 'Monthly', title: 'Executive-wise cross selling performance', build(f) { const rows = tvaExecRows(f).map((r, i) => Object.assign(r, { val: sum(db.find('upsells', (u) => u.execId === repExecs(f)[i].id && u.type === 'Cross-sell' && u.status === 'Converted' && inRange(u.convertedAt, f.from, f.to)), 'value') })); return { kpis: [{ label: 'Cross-sells', value: sum(rows, (r) => r.a.crossSell) + ' / ' + Math.round(sum(rows, (r) => r.t.crossSell)) }, { label: 'Cross-sell value', value: fmt.lakh(sum(rows, 'val')) }], rows, columns: tvaColumns(['crossSell']).concat([{ label: 'Cross-sell value', get: (r) => r.val, render: (r) => fmt.money(r.val) }]) }; } },
    { id: 'm7', group: 'Monthly', title: 'New customer acquisition', build(f) { const rows = acquisitions(f.from, f.to, (o) => (!f.division || o.division === f.division) && (!isExec() || o.execId === me())); const t = repExecs(f).reduce((s2, x) => s2 + targetFor('exec', x.id, f.from, f.to).newCustomers, 0); return { kpis: [{ label: 'New customers acquired (distinct)', value: rows.length + ' / ' + Math.round(t), meta: 'vs target · first approved order in period' }, { label: 'First-order value', value: fmt.lakh(sum(rows, 'value')), color: 'var(--ok)' }].concat(repExecs(f).map((s2) => ({ label: s2.name, value: rows.filter((o) => o.execId === s2.id).length }))), rows, columns: [{ label: 'Customer', get: (o) => o.accountName }, { label: 'Customer ID', get: (o) => o.customerId }, { label: 'First order won', get: (o) => util.iso(o.wonDate) }, { label: 'Division', get: (o) => o.division }, { label: 'Channel', get: (o) => o.salesChannel }, { label: 'Value', get: (o) => o.value, render: (o) => fmt.money(o.value) }, { label: 'Executive', get: (o) => execName(o.execId) }, { label: 'Customer type now', get: (o) => (master.customer(o.customerId) || {}).type || '' }] }; } },
  ];
  function presetRange(group) {
    const t = todayIso();
    if (group === 'Daily') return [t, t];
    if (group === 'Weekly') return weekRange(CRM.TODAY); // calendar week Mon → Sun
    return [monthRange(monthKey(CRM.TODAY))[0], t];
  }
  // admin can switch reports on/off in Settings & Rules → Reports (Core v2 registerReport / config.reportEnabled)
  if (CRM.registerReport) REPORTS.forEach((r) => CRM.registerReport({ id: 'sales-' + r.id, title: r.title, group: 'Sales · ' + r.group, link: '#/salesreports/' + r.id }));
  const reportOn = (r) => { try { return !(CRM.config && CRM.config.reportEnabled) || CRM.config.reportEnabled('sales-' + r.id); } catch (err) { return true; } };
  // division-wide reports are management views — executives get their own figures only
  const DIV_REPORTS = ['w2', 'm2'];
  const visibleReports = () => REPORTS.filter((r) => reportOn(r) && !(isExec() && DIV_REPORTS.includes(r.id)));
  function printReport(title, node) {
    if (CRM.exportPdf) { CRM.exportPdf(title, node); return; }
    const w = window.open('', '_blank');
    if (!w) { window.print(); return; }
    const css = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((l) => '<link rel="stylesheet" href="' + util.esc(l.href) + '">').join('');
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + util.esc(title) + '</title>' + css + '<style>body{padding:24px;background:#fff}.btn,.filters,.tbl-foot button{display:none!important}</style></head><body><h1>' + util.esc(title) + '</h1>' + node.outerHTML + '</body></html>');
    w.document.close();
    setTimeout(() => { try { w.focus(); w.print(); } catch (err) { /* user can print manually */ } }, 400);
  }
  function renderReports(el, params) {
    const vis = visibleReports();
    if (!vis.length) { ui.page(el, { title: 'Sales Report Centre' }); el.appendChild(ui.empty('All sales reports are switched off in Settings & Rules → Reports', '📊')); return; }
    let rep = vis.find((r) => r.id === (params && params[0])) || vis[0];
    const [f0, t0] = presetRange(rep.group);
    const f = { from: f0, to: t0, division: '' };
    ui.page(el, { title: 'Sales Report Centre', sub: '10 daily · 2 weekly (calendar week) · 7 monthly reports with date & division filters, CSV and PDF export' + (isExec() ? ' · showing your own data' : '') });
    const nav = h('div', { class: 'stack', style: 'gap:2px' });
    const out = h('div');
    ['Daily', 'Weekly', 'Monthly'].forEach((g) => {
      nav.appendChild(h('div', { class: 'small muted', style: 'font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin:8px 0 4px' }, g + ' reports'));
      visibleReports().filter((r) => r.group === g).forEach((r, i) => nav.appendChild(h('a', { href: '#/salesreports/' + r.id, class: 'btn ' + (r.id === rep.id ? 'primary' : 'ghost'), style: 'justify-content:flex-start;white-space:normal;text-align:left' }, (i + 1) + '. ' + r.title)));
    });
    const fromI = h('input', { type: 'date', value: f.from }), toI = h('input', { type: 'date', value: f.to });
    const divS = h('select', {}, [h('option', { value: '' }, 'All divisions')].concat(DIVS.map((d) => h('option', { value: d }, d))));
    [fromI, toI, divS].forEach((x) => x.addEventListener('change', () => { f.from = fromI.value || f.from; f.to = toI.value || f.to; f.division = divS.value; draw(); }));
    const setR = (a, b) => { f.from = a; f.to = b; fromI.value = a; toI.value = b; draw(); };
    const lm = (() => { const d = new Date(CRM.TODAY); d.setDate(1); d.setMonth(d.getMonth() - 1); return monthRange(monthKey(d)); })();
    let built;
    const bar = h('div', { class: 'filters' }, [h('span', { class: 'small muted' }, 'From'), fromI, h('span', { class: 'small muted' }, 'To'), toI, divS, ui.btn('Today', () => setR(todayIso(), todayIso()), 'sm'), ui.btn('This week', () => { const [a, b] = weekRange(CRM.TODAY); setR(a, b); }, 'sm'), ui.btn('Last week', () => { const [a, b] = weekRange(util.addDays(CRM.TODAY, -7)); setR(a, b); }, 'sm'), ui.btn('This month', () => setR(monthRange(monthKey(CRM.TODAY))[0], todayIso()), 'sm'), ui.btn('Last month', () => setR(lm[0], lm[1]), 'sm'), h('span', { style: 'flex:1' }), ui.btn('⇩ Export CSV', () => downloadCsv(rep.id + '-' + rep.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + f.from + '_' + f.to + '.csv', built.columns.map((c) => c.label), built.rows.map((r) => built.columns.map((c) => c.get(r)))), 'sm primary'), ui.btn('⇩ PDF', () => printReport(rep.group + ' · ' + rep.title + ' · ' + fmt.date(parseD(f.from)) + ' → ' + fmt.date(parseD(f.to)) + (f.division ? ' · ' + f.division : ''), pdfNode()), 'sm'), ui.btn('🖶 Print', () => window.print(), 'sm')]);
    // printable copy of the current report with all rows (the on-screen table is paginated)
    const pdfNode = () => h('div', {}, [ui.kpis(built.kpis), h('table', { class: 'tbl' }, [h('thead', {}, h('tr', {}, built.columns.map((c) => h('th', {}, c.label)))), h('tbody', {}, built.rows.map((r) => h('tr', {}, built.columns.map((c) => { const v = c.get(r); return h('td', {}, v == null || v === '' ? '—' : String(v)); }))))])]);
    el.appendChild(h('div', { class: 'grid g3' }, [card('Reports', nav), h('div', { class: 'span2' }, card(null, h('div', {}, [bar, h('div', { class: 'card-body' }, out)]), { flush: true }))]));
    function draw() {
      out.innerHTML = '';
      built = rep.build(f);
      out.appendChild(h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:10px' }, [h('h2', {}, rep.group + ' · ' + rep.title), h('span', { class: 'small muted' }, fmt.date(parseD(f.from)) + ' → ' + fmt.date(parseD(f.to)) + (f.division ? ' · ' + f.division : ''))]));
      out.appendChild(ui.kpis(built.kpis));
      if (built.chart) out.appendChild(h('div', { style: 'margin-bottom:12px' }, built.chart));
      out.appendChild(ui.table({ rows: built.rows, pageSize: 12, columns: built.columns.map((c, i) => ({ key: 'c' + i, label: c.label, render: c.render || ((r) => { const v = c.get(r); return v == null || v === '' ? '—' : String(v); }), sort: (r) => c.get(r) })) }));
    }
    draw();
  }

  // ============================================================ cycle times
  function renderCycleTimes(el) {
    const qs = db.all('quotations').filter((q) => q.quoteDate), os = db.all('orders').filter((o) => !o.migrated);
    const qr = qs.map(quoteResponseHrs), sp = os.map(soProcessingHrs).filter((x) => x != null), cv = os.map(conversionDays).filter((x) => x != null);
    ui.page(el, { title: 'Sales Cycle Times', sub: 'Automatically calculated: quote response time (enquiry → quote given), SO processing time (order won → SO issued), lead conversion time (enquiry → order won)' });
    el.appendChild(ui.kpis([
      { label: 'Avg quote response time', value: hrsText(avg(qr)), meta: util.pct(qr.filter((x) => x <= 24).length, qr.length) + '% within 24 h SLA', color: 'var(--chart-5)' },
      { label: 'Avg SO processing time', value: hrsText(avg(sp)), meta: util.pct(sp.filter((x) => x <= 24).length, sp.length) + '% within 24 h', color: 'var(--chart-4)' },
      { label: 'Avg lead conversion time', value: (Math.round((avg(cv) || 0) * 10) / 10) + ' days', meta: cv.length + ' won orders', color: 'var(--ok)' },
    ]));
    const months = monthsBack(6);
    const m = (list, dateFn, valFn, mk) => avg(list.filter((x) => dateFn(x) && monthKey(dateFn(x)) === mk).map(valFn)) || 0;
    el.appendChild(h('div', { class: 'grid g2' }, [
      card('Monthly trend (hours)', ui.lineChart(months.map(monthLabel), [{ name: 'Quote response (h)', color: 'var(--chart-1)', values: months.map((k) => Math.round(m(qs, (q) => q.quoteDate, quoteResponseHrs, k))) }, { name: 'SO processing (h)', color: 'var(--chart-4)', values: months.map((k) => Math.round(m(os, (o) => o.soIssuedDate, soProcessingHrs, k))) }])),
      card('Quote response distribution', ui.barChart([['≤ 4 h', 0, 4], ['4–12 h', 4, 12], ['12–24 h', 12, 24], ['24–48 h', 24, 48], ['> 48 h', 48, 1e9]].map(([l, a, b]) => ({ label: l, values: [qr.filter((x) => x > a && x <= b || (a === 0 && x === 0)).length] })), [{ name: 'Quotations', color: 'var(--chart-2)' }])),
    ]));
    const rowsBy = (keyFn, names) => names.map((n) => { const q = qs.filter((x) => keyFn(x) === n), o = os.filter((x) => keyFn(x) === n); return { name: n, q: avg(q.map(quoteResponseHrs)), s: avg(o.map(soProcessingHrs)), c: avg(o.map(conversionDays)), nq: q.length, no: o.length }; });
    const cols = (lbl) => [{ key: 'name', label: lbl }, { key: 'nq', label: 'Quotes' }, { key: 'q', label: 'Avg quote response', render: (r) => respBadge(r.q) }, { key: 'no', label: 'Orders' }, { key: 's', label: 'Avg SO processing', render: (r) => respBadge(r.s) }, { key: 'c', label: 'Avg conversion', render: (r) => (r.c != null ? Math.round(r.c * 10) / 10 + ' d' : '—') }];
    section(el, h('div', { class: 'grid g2' }, [card('By division', ui.table({ rows: rowsBy((x) => x.division, DIVS), search: false, columns: cols('Division') }), { flush: true }), card('By executive', ui.table({ rows: rowsBy((x) => execName(x.execId), execs().map((s) => s.name)), search: false, columns: cols('Executive') }), { flush: true })]));
  }

  // ============================================================ sales SLA & escalations (policy violations)
  function renderPolicy(el) {
    const list = policyBreaches().filter((b) => !isExec() || b.owner === me());
    const types = ['Quotation Delay', 'Site Visit Delay', 'Customer Approval Pending SO', 'Payment Collection Delay', 'Scrap Collection Delay'];
    ui.page(el, { title: 'Sales SLA & Escalations', sub: 'Policy violations auto-detected and escalated: Sales Executive → Sales Coordinator → Sales Head → Management', actions: [ui.btn('⇩ Export CSV', () => downloadCsv('sales-sla-violations.csv', ['Type', 'Policy', 'Record', 'Division', 'Owner', 'Hours over SLA', 'Escalation level', 'Severity', 'Details'], list.map((b) => [b.type, b.ref, b.rec.id, b.division, execName(b.owner), Math.round(b.over), LEVELS[b.level].label, b.severity, b.details])))] });
    el.appendChild(ui.kpis(types.map((t, i) => ({ label: t, value: list.filter((b) => b.type === t).length, color: ['var(--chart-1)', 'var(--chart-4)', 'var(--warn)', 'var(--bad)', 'var(--chart-3)'][i] }))));
    el.appendChild(h('div', { class: 'grid g3' }, [
      h('div', { class: 'span2' }, card('Open violations', ui.table({ rows: list.map((b) => ({ id: b.rec.id, type: b.type, ref: b.ref, division: b.division, owner: execName(b.owner), over: b.over, overDays: b.overDays, level: LEVELS[b.level].label, lv: b.level, severity: b.severity, details: b.details, link: (b.links || [b.link]).find((l) => canOpen(l, CRM.role().id)) || '' })), onRow: (r) => { if (r.link) location.hash = r.link; else ui.toast('This record opens in a page your role cannot access', 'warn'); }, filters: [{ key: 'type', label: 'types', options: types }, { key: 'division', label: 'divisions', options: DIVS }], columns: [{ key: 'type', label: 'Violation', render: (r) => h('div', {}, [h('b', {}, r.type), h('div', { class: 'small muted' }, r.ref)]) }, { key: 'id', label: 'Record', render: (r) => mono(r.id) }, { key: 'division', label: 'Division', render: (r) => ui.divTag(r.division) }, { key: 'owner', label: 'Owner' }, { key: 'over', label: 'Over SLA by', render: (r) => (r.overDays != null ? r.overDays + ' d' : hrsText(r.over)), sort: (r) => r.over }, { key: 'level', label: 'Escalated to', render: (r) => ui.badge(r.level, r.lv >= 3 ? 'bad' : 'warn') }, { key: 'severity', label: 'Severity', render: (r) => ui.badge(r.severity, r.severity === 'Low' ? 'info' : 'warn') }, { key: 'details', label: 'Details' }] }), { flush: true })),
      h('div', { class: 'stack' }, [
        card('Policy rules (Service_requirement §4–5)', ui.dl([['4.1 Quotation delay', 'No quotation ' + SLA.quoteHrs + ' h after enquiry'], ['4.2 Site visit delay', 'Site visit not done in ' + SLA.siteVisitHrs + ' h'], ['4.3 Customer approval pending SO', 'SO not issued ' + SLA.soHrs + ' h after customer approval'], ['5.2 Payment collection delay', 'Not received within customer credit days'], ['5.3 Scrap collection delay', 'Scrap not collected ' + SLA.scrapHrs + ' h after installation (Power)']])),
        (() => { const esc = cfg('sales.escalation'), pe = cfg('sales.paymentEscalation'); return card('Escalation matrix', h('div', { class: 'stack' }, [ui.timeline([{ when: 'SLA breach', title: 'L1 · Sales Executive', color: 'var(--chart-5)' }, { when: '+' + esc.l2 + ' h', title: 'L2 · Sales Coordinator', color: 'var(--warn)' }, { when: '+' + esc.l3 + ' h', title: 'L3 · Sales Head (Sales Manager)', color: 'var(--chart-3)' }, { when: '+' + esc.l4 + ' h', title: 'L4 · Management (GM / ODM)', color: 'var(--bad)' }]), h('div', { class: 'small muted' }, 'Payment collection delays escalate by days overdue: L2 after ' + pe.l2 + ' d · L3 after ' + pe.l3 + ' d · L4 after ' + pe.l4 + ' d. Thresholds are configurable in Settings & Rules.')])); })(),
      ]),
    ]));
  }

  // ============================================================ management sales dashboard
  function summary() {
    const ords = db.all('orders').filter((o) => o.approval === 'Approved');
    const open = db.all('enquiries').filter((e) => OPEN.includes(e.stage));
    const live = ords.filter((o) => !o.migrated);
    const mk = monthKey(CRM.TODAY);
    const byDivision = {}; DIVS.forEach((d) => { byDivision[d] = sum(live.filter((o) => o.division === d), 'value'); });
    return {
      enquiries: db.all('enquiries').length, pipelineValue: sum(open, 'expectedValue'), wonValue: sum(live, 'value'), wonCount: live.length,
      outstanding: sum(db.all('invoices'), outstandingOf), collectedThisMonth: sum(db.all('payments').filter((p) => monthKey(p.receivedDate) === mk), 'value'),
      byDivision, monthly: monthsBack(6).map((k) => ({ label: monthLabel(k), value: sum(ords.filter((o) => monthKey(o.wonDate) === k), 'value') })),
    };
  }
  function renderDashboard(el) {
    let period = 'month';
    const host = h('div');
    const sel = h('select', { class: 'btn', onChange: (e) => { period = e.target.value; draw(); } }, [['month', 'This month'], ['quarter', 'Last 3 months'], ['six', 'Last 6 months'], ['fy', 'This financial year']].map(([v, l]) => h('option', { value: v }, l)));
    ui.page(el, { title: 'Sales Dashboard', sub: 'Management view — enquiries, pipeline, orders, sales by division & executive, collections and outstanding', actions: [sel, ui.btn('Reports', () => CRM.go('salesreports'))] });
    el.appendChild(host);
    function draw() {
      host.innerHTML = '';
      const t = todayIso();
      const from = period === 'month' ? monthRange(monthKey(CRM.TODAY))[0] : period === 'quarter' ? util.iso(util.addDays(CRM.TODAY, -90)) : period === 'six' ? util.iso(util.addDays(CRM.TODAY, -182)) : (CRM.TODAY.getMonth() >= 3 ? CRM.TODAY.getFullYear() : CRM.TODAY.getFullYear() - 1) + '-04-01';
      const enq = db.all('enquiries').filter((e) => inRange(e.date, from, t));
      const open = db.all('enquiries').filter((e) => OPEN.includes(e.stage));
      const ords = db.all('orders').filter((o) => o.approval === 'Approved' && inRange(o.wonDate, from, t));
      const coll = db.all('payments').filter((p) => inRange(p.receivedDate, from, t));
      const os = db.all('invoices').filter((i) => outstandingOf(i) > 0);
      const closed = enq.filter((e) => !OPEN.includes(e.stage));
      host.appendChild(ui.kpis([
        { label: 'Total enquiries', value: enq.length, meta: 'Conversion ' + util.pct(closed.filter((e) => e.stage === 'Order Won').length, closed.length) + '%', onClick: () => CRM.go('enquiries') },
        { label: 'Pipeline value', value: fmt.lakh(sum(open, 'expectedValue')), meta: open.length + ' open opportunities', color: 'var(--chart-5)', onClick: () => CRM.go('pipeline') },
        { label: 'Orders won', value: fmt.lakh(sum(ords, 'value')), meta: ords.length + ' orders', color: 'var(--ok)', onClick: () => CRM.go('orders') },
        { label: 'Payment collection', value: fmt.lakh(sum(coll, 'value')), meta: util.pct(coll.filter((p) => p.onTime).length, coll.length) + '% as per policy', color: 'var(--chart-2)', onClick: () => CRM.go('payments') },
        { label: 'Outstanding payments', value: fmt.lakh(sum(os, outstandingOf)), meta: fmt.lakh(sum(os.filter((i) => invStatus(i) === 'Overdue'), outstandingOf)) + ' overdue', color: 'var(--bad)', onClick: () => CRM.go('outstanding') },
      ]));
      const months = monthsBack(12);
      host.appendChild(h('div', { class: 'grid g3' }, [
        card('Sales by division', ui.donut(DIVS.map((d) => ({ label: d, value: sum(ords.filter((o) => o.division === d), 'value'), color: master.divisionColor(d) })), { money: true, label: 'Won' })),
        h('div', { class: 'span2' }, card('Monthly sales — this year vs last year', ui.lineChart(months.map(monthLabel), [{ name: 'This year', color: 'var(--chart-1)', values: months.map((k) => { const [a, b] = monthRange(k); return salesIn(a, b); }) }, { name: 'Same month last year', color: 'var(--chart-3)', dashed: true, values: months.map((k) => { const [a, b] = monthRange(k); return salesIn(shiftYear(a, -1), shiftYear(b, -1)); }) }], { money: true, area: true }))),
      ]));
      section(host, h('div', { class: 'grid g3' }, [
        card('Sales by executive (vs target)', ui.hbars(execs().map((s) => ({ label: s.name, value: sum(ords.filter((o) => o.execId === s.id), 'value'), target: Math.round(targetFor('exec', s.id, from, t).revenue) })), { money: true })),
        card('Pipeline by stage', ui.barChart(OPEN.map((s) => ({ label: s.replace('Site Visit ', 'SV ').replace('Enquiry ', 'Enq. '), values: [sum(open.filter((e) => e.stage === s), 'expectedValue')] })), [{ name: 'Value', color: 'var(--chart-1)' }], { money: true })),
        card('Enquiries by source', ui.hbars(CHANNELS.map((c) => ({ label: c, value: enq.filter((e) => e.salesChannel === c).length })).sort((a, b) => b.value - a.value))),
      ]));
      const top = Object.values(util.groupBy(os, 'accountName')).map((l) => ({ name: l[0].accountName, id: l[0].customerId, v: sum(l, outstandingOf), od: Math.max(...l.map(overdueDays)) })).sort((a, b) => b.v - a.v).slice(0, 8);
      section(host, h('div', { class: 'grid g2' }, [
        card('Top outstanding customers', ui.table({ rows: top, search: false, onRow: (r) => r.id && CRM.go('customer360', r.id), columns: [{ key: 'name', label: 'Customer' }, { key: 'v', label: 'Outstanding', cls: 'right', render: (r) => fmt.money(r.v) }, { key: 'od', label: 'Oldest overdue', render: (r) => ui.badge(r.od > 0 ? r.od + ' d' : 'Not due', r.od > 60 ? 'bad' : r.od > 0 ? 'warn' : 'ok') }] }), { flush: true }),
        card('Sales SLA violations', (() => { const b = policyBreaches(); return ui.hbars(['Quotation Delay', 'Site Visit Delay', 'Customer Approval Pending SO', 'Payment Collection Delay', 'Scrap Collection Delay'].map((x) => ({ label: x, value: b.filter((y) => y.type === x).length, color: 'var(--bad)' }))); })(), { actions: [ui.btn('Open', () => CRM.go('salespolicy'), 'sm')] }),
      ]));
    }
    draw();
  }

  // ============================================================ role homes
  const quick = (items) => h('div', { class: 'grid', style: 'grid-template-columns:1fr 1fr;gap:8px' }, items.filter(Boolean).map(([l, fn, cls]) => ui.btn(l, fn, cls || '')));
  CRM.registerHome('sales_exec', (el) => {
    const u = CRM.user(), st = db.get('staff', u.id) || {}, chk = todayCheckin(u.id), mk = monthKey(CRM.TODAY);
    const [mf, mt] = monthRange(mk);
    const tg = targetFor('exec', u.id, mf, mt), ac = achievedFor({ execId: u.id }, mf, mt);
    const mine = allEnq(), open = mine.filter((e) => OPEN.includes(e.stage)), fus = allFu().filter((f) => f.status === 'Planned');
    el.appendChild(ui.hero(CRM.role(), [(st.division || '') + ' division', st.area || '', chk ? (chk.checkOutAt ? 'Checked out' : '📍 On field') : 'Not checked in', fmt.pct(util.pct(ac.revenue, tg.revenue)) + ' of monthly target']));
    el.appendChild(ui.kpis([
      { label: 'My open leads', value: open.length, meta: fmt.lakh(sum(open, 'expectedValue')) + ' pipeline', onClick: () => CRM.go('pipeline') },
      { label: 'Follow-ups today', value: fus.filter((f) => f.dueDate === todayIso()).length, color: 'var(--warn)', onClick: () => CRM.go('followups') },
      { label: 'Missed follow-ups', value: fus.filter((f) => f.dueDate < todayIso()).length, color: 'var(--bad)', onClick: () => CRM.go('followups') },
      { label: 'Quotes awaiting approval', value: allQuotes().filter((q) => q.approval === 'Awaiting Approval').length, color: 'var(--chart-4)', onClick: () => CRM.go('quotations') },
      { label: 'Revenue · ' + monthLabel(mk), value: fmt.lakh(ac.revenue), meta: 'Target ' + fmt.lakh(tg.revenue), tone: ac.revenue >= tg.revenue ? 'up' : 'down', color: 'var(--ok)', onClick: () => CRM.go('targets') },
      { label: 'Calls today', value: callCount(allCalls().filter((c) => util.iso(c.date) === todayIso())) + ' / ' + Math.round(tg.calls / 26), meta: 'daily target', onClick: () => CRM.go('calls') },
    ]));
    el.appendChild(h('div', { class: 'grid g3' }, [
      h('div', { class: 'span2' }, card("Today's task list", taskList(dailyTasks(), 12), { actions: [ui.btn('All follow-ups', () => CRM.go('followups'), 'sm')] })),
      h('div', { class: 'stack' }, [
        card('Quick actions', quick([['+ New enquiry', () => enquiryForm(), 'primary'], ['☎ Log call', () => logCallModal()], ['📅 Follow-up', () => followUpModal()], ['📄 Quotation', () => quoteModal()], ['📱 Mobile app', () => CRM.go('mobile')], ['₹ Payment', () => recordPayment()]])),
        card('My targets · ' + monthLabel(mk), ui.hbars(METRICS.map(([k, l, money]) => ({ label: l, value: ac[k], target: tg[k] || 0, text: (money ? fmt.lakh(ac[k]) : ac[k]) + ' / ' + (money ? fmt.lakh(tg[k]) : tg[k]) })))),
      ]),
    ]));
    section(el, h('div', { class: 'grid g2' }, [
      card('My pipeline by stage', ui.barChart(OPEN.map((s) => ({ label: s.replace('Site Visit ', 'SV ').replace('Enquiry ', 'Enq. '), values: [open.filter((e) => e.stage === s).length] })), [{ name: 'Leads', color: 'var(--chart-1)' }], { height: 200 })),
      card('My recent enquiries', enquiryTable(mine.slice(-40), { pageSize: 6 }), { flush: true }),
    ]));
  });
  CRM.registerHome('sales_coordinator', (el) => {
    const b = policyBreaches();
    const unassigned = db.find('enquiries', (e) => !e.execId && OPEN.includes(e.stage));
    const fus = db.all('followups').filter((f) => f.status === 'Planned');
    el.appendChild(ui.hero(CRM.role(), ['Lead assignment', 'Sales OTS desk', 'Escalation L2', b.length + ' open SLA violations']));
    el.appendChild(ui.kpis([
      { label: 'Awaiting assignment', value: unassigned.length + pendingOts().length, meta: pendingOts().length + ' Sales OTS', color: 'var(--chart-4)', onClick: () => CRM.go(pendingOts().length ? 'salesots' : 'enquiries') },
      { label: 'Quotation delays', value: b.filter((x) => x.type === 'Quotation Delay').length, meta: '> 24 h without quote', color: 'var(--bad)', onClick: () => CRM.go('salespolicy') },
      { label: 'Site visit delays', value: b.filter((x) => x.type === 'Site Visit Delay').length, color: 'var(--warn)', onClick: () => CRM.go('salespolicy') },
      { label: 'Customer approved, SO pending', value: b.filter((x) => x.type === 'Customer Approval Pending SO').length, color: 'var(--chart-3)', onClick: () => CRM.go('salespolicy') },
      { label: 'Team missed follow-ups', value: fus.filter((f) => f.dueDate < todayIso()).length, color: 'var(--bad)', onClick: () => CRM.go('followups') },
      { label: 'Quotes with manager', value: db.find('quotations', (q) => q.approval === 'Awaiting Approval').length, color: 'var(--chart-5)', onClick: () => CRM.go('quotations') },
    ]));
    el.appendChild(h('div', { class: 'grid g3' }, [
      h('div', { class: 'span2' }, card('Assignment queue', ui.table({ rows: unassigned, search: false, empty: 'All leads assigned', columns: [{ key: 'id', label: 'Enquiry', render: (e) => lnk('enquiries', e.id) }, { key: 'accountName', label: 'Account' }, { key: 'division', label: 'Division', render: (e) => ui.divTag(e.division) }, { key: 'area', label: 'Area' }, { key: 'salesChannel', label: 'Source' }, { key: 's', label: 'Suggested', render: (e) => (autoAssign(e.division, e.area).exec || {}).name }], actions: (e) => [ui.btn('Auto-assign', () => { const a = autoAssign(e.division, e.area); assignEnquiry(e, a.exec.id, a.rule); ui.toast('Assigned to ' + a.exec.name, 'ok'); CRM.refresh(); }, 'sm primary'), ui.btn('Choose', () => reassignModal(e), 'sm')] }), { flush: true, actions: [ui.btn('Assignment desk', () => CRM.go('enquiries'), 'sm')] })),
      card('Quick actions', quick([['+ New enquiry', () => enquiryForm(), 'primary'], ['📅 Follow-up', () => followUpModal()], ['Pipeline', () => CRM.go('pipeline')], ['SLA monitor', () => CRM.go('salespolicy')], ['Sales OTS desk', () => CRM.go('salesots')], ['Reports', () => CRM.go('salesreports')]])),
    ]));
    section(el, h('div', { class: 'grid g2' }, [
      card('Escalations at coordinator level and above', b.filter((x) => x.level >= 2).length ? h('div', { class: 'stack', style: 'gap:6px' }, b.filter((x) => x.level >= 2).sort((a, c) => c.over - a.over).slice(0, 8).map((x) => h('a', { href: x.links.find((l) => canOpen(l, CRM.role().id)) || '#/salespolicy', style: 'color:var(--text)' }, h('div', { class: 'row', style: 'justify-content:space-between;padding:6px 8px;border:1px solid var(--border);border-radius:8px' }, [h('div', {}, [h('b', {}, x.type), h('div', { class: 'small muted' }, x.details)]), ui.badge(LEVELS[x.level].label, x.level >= 3 ? 'bad' : 'warn')])))) : ui.empty('No escalations', '✅')),
      card("Team follow-ups today (completed vs planned)", ui.hbars(execs().map((s) => { const m = db.find('followups', (f) => f.execId === s.id && f.dueDate === todayIso()); return { label: s.name, value: m.filter((f) => f.status !== 'Planned').length, target: m.length }; }))),
    ]));
  });
  CRM.registerHome('sales_manager', (el) => {
    const s = summary(), mk = monthKey(CRM.TODAY), [mf, mt] = monthRange(mk);
    const tg = targetFor('all', null, mf, mt), monthWon = salesIn(mf, mt);
    const qAw = db.find('quotations', (q) => q.approval === 'Awaiting Approval'), oAw = db.find('orders', (o) => o.approval === 'Awaiting Approval');
    const closed = db.all('enquiries').filter((e) => !OPEN.includes(e.stage));
    const qr = db.all('quotations').filter((q) => q.quoteDate && monthKey(q.quoteDate) === mk).map(quoteResponseHrs);
    el.appendChild(ui.hero(CRM.role(), [qAw.length + oAw.length + ' approvals pending', fmt.pct(util.pct(monthWon, tg.revenue)) + ' of month target', policyBreaches().length + ' SLA violations']));
    el.appendChild(ui.kpis([
      { label: 'Pipeline value', value: fmt.lakh(s.pipelineValue), color: 'var(--chart-5)', onClick: () => CRM.go('pipeline') },
      { label: 'Won this month', value: fmt.lakh(monthWon), meta: 'Target ' + fmt.lakh(tg.revenue), tone: monthWon >= tg.revenue ? 'up' : 'down', color: 'var(--ok)', onClick: () => CRM.go('targets') },
      { label: 'Approvals pending', value: qAw.length + oAw.length, meta: qAw.length + ' quotes · ' + oAw.length + ' SOs', color: 'var(--warn)' },
      { label: 'Conversion rate', value: fmt.pct(util.pct(closed.filter((e) => e.stage === 'Order Won').length, closed.length)) },
      { label: 'Avg quote response (month)', value: hrsText(avg(qr)), color: 'var(--chart-4)', onClick: () => CRM.go('cycletimes') },
      { label: 'Outstanding', value: fmt.lakh(s.outstanding), color: 'var(--bad)', onClick: () => CRM.go('outstanding') },
    ]));
    const appr = qAw.map((q) => ({ kind: 'Quotation', id: q.id, acct: q.accountName, value: q.quoteValue, by: execName(q.execId), at: q.createdAt, rec: q })).concat(oAw.map((o) => ({ kind: 'Sale order', id: o.id, acct: o.accountName, value: o.value, by: execName(o.execId), at: o.wonDate, rec: o })));
    el.appendChild(h('div', { class: 'grid g3' }, [
      h('div', { class: 'span2' }, card('Approval queue', ui.table({ rows: appr, search: false, empty: 'Nothing waiting for approval', onRow: (r) => (r.kind === 'Quotation' ? quoteDrawer(db.get('quotations', r.id)) : orderDrawer(db.get('orders', r.id))), columns: [{ key: 'kind', label: 'Type', render: (r) => ui.badge(r.kind, r.kind === 'Quotation' ? 'info' : 'violet') }, { key: 'id', label: 'Ref', render: (r) => mono(r.id) }, { key: 'acct', label: 'Account' }, { key: 'value', label: 'Value', cls: 'right', render: (r) => fmt.money(r.value) }, { key: 'by', label: 'Executive' }, { key: 'at', label: 'Waiting', render: (r) => ui.badge(hrsText(util.hoursBetween(r.at, new Date())), util.hoursBetween(r.at, new Date()) > 24 ? 'bad' : 'warn') }], actions: (r) => [ui.btn('Approve', () => { if (r.kind === 'Quotation') approveQuote(r.rec); else approveSO(r.rec); ui.toast(r.id + ' approved', 'ok'); CRM.refresh(); }, 'sm ok'), ui.btn('Review', () => (r.kind === 'Quotation' ? quoteDrawer(db.get('quotations', r.id)) : orderDrawer(db.get('orders', r.id))), 'sm')] }), { flush: true })),
      card('Sales by division (all live orders)', ui.donut(DIVS.map((d) => ({ label: d, value: s.byDivision[d], color: master.divisionColor(d) })), { money: true, label: 'Won' })),
    ]));
    section(el, h('div', { class: 'grid g2' }, [
      card('Executive performance · ' + monthLabel(mk), ui.hbars(execs().map((x) => ({ label: x.name, value: achievedFor({ execId: x.id }, mf, mt).revenue, target: (targetRec('exec', x.id, mk) || {}).revenue || 0 })), { money: true }), { actions: [ui.btn('Targets', () => CRM.go('targets'), 'sm')] }),
      card('Won value — last 6 months', ui.barChart(s.monthly.map((m) => ({ label: m.label, values: [m.value] })), [{ name: 'Won', color: 'var(--chart-2)' }], { money: true, height: 200 })),
    ]));
  });
  CRM.registerHome('accounts', (el) => {
    const invs = db.all('invoices'), t = todayIso(), mk = monthKey(CRM.TODAY);
    const toInv = db.all('orders').filter((o) => o.approval === 'Approved' && !o.migrated && !invoicesOf(o.id).length);
    const os = invs.filter((i) => outstandingOf(i) > 0);
    const due = os.filter((i) => util.iso(i.dueDate) <= util.iso(util.addDays(CRM.TODAY, 3))).sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1));
    el.appendChild(ui.hero(CRM.role(), ['Invoices & payments', toInv.length + ' to invoice', fmt.lakh(sum(os, outstandingOf)) + ' outstanding']));
    el.appendChild(ui.kpis([
      { label: 'To be invoiced', value: toInv.length, color: 'var(--warn)', onClick: () => CRM.go('invoices') },
      { label: 'Outstanding', value: fmt.lakh(sum(os, outstandingOf)), onClick: () => CRM.go('outstanding') },
      { label: 'Overdue', value: fmt.lakh(sum(os.filter((i) => invStatus(i) === 'Overdue'), outstandingOf)), color: 'var(--bad)', onClick: () => CRM.go('outstanding') },
      { label: 'Due today', value: fmt.lakh(sum(os.filter((i) => util.iso(i.dueDate) === t), outstandingOf)), color: 'var(--warn)' },
      { label: 'Collected this month', value: fmt.lakh(sum(db.all('payments').filter((p) => monthKey(p.receivedDate) === mk), 'value')), color: 'var(--ok)', onClick: () => CRM.go('payments') },
      { label: 'Field payments to verify', value: db.find('payments', (p) => !p.verified).length, color: 'var(--chart-4)', onClick: () => CRM.go('payments') },
    ]));
    el.appendChild(h('div', { class: 'grid g3' }, [
      h('div', { class: 'span2' }, card('Payments to collect (overdue, today & next 3 days)', invoiceTable(due, { search: false, pageSize: 8 }), { flush: true })),
      h('div', { class: 'stack' }, [card('Quick actions', quick([['🧾 Raise invoice', () => CRM.go('invoices'), 'primary'], ['₹ Record payment', () => recordPayment()], ['Ageing', () => CRM.go('outstanding')], ['Receipts', () => CRM.go('payments')]])), card('Ageing', ui.donut(BUCKETS.map((b, i) => ({ label: b, value: sum(os.filter((x) => ageBucket(x) === b), outstandingOf), color: BUCKET_COLORS[i] })), { money: true, label: 'O/S' }))]),
    ]));
    section(el, card('Sale orders awaiting invoice', ui.table({ rows: toInv, search: false, empty: 'All approved orders are invoiced', columns: [{ key: 'soNumber', label: 'SO', render: (o) => mono(o.soNumber) }, { key: 'accountName', label: 'Account' }, { key: 'division', label: 'Division', render: (o) => ui.divTag(o.division) }, { key: 'value', label: 'Value', cls: 'right', render: (o) => fmt.money(o.value) }, { key: 'paymentTerms', label: 'Terms' }, { key: 'soIssuedDate', label: 'SO issued', render: (o) => fmt.rel(o.soIssuedDate) }], actions: (o) => [ui.btn('Raise invoice', () => raiseInvoice(db.get('orders', o.id)), 'sm primary')] }), { flush: true }));
  });

  // ============================================================ pages
  const regPage = (p) => { PAGE_ROLES[p.id] = p.roles; CRM.registerPage(p); };
  regPage({ id: 'salesdash', title: 'Sales Dashboard', icon: '📈', section: 'Sales', order: 10, roles: ROLES_MGMT_SALES, render: renderDashboard });
  regPage({ id: 'mobile', title: 'Mobile Sales', icon: '📱', section: 'Sales', order: 10.5, roles: ROLES_SALES, render: renderMobile });
  regPage({ id: 'enquiries', title: 'Leads & Enquiries', icon: '📥', section: 'Sales', order: 11, roles: ROLES_SALES, render: renderEnquiries, badge: () => (isCoord() ? db.find('enquiries', (e) => !e.execId && OPEN.includes(e.stage)).length : 0) });
  regPage({ id: 'pipeline', title: 'Pipeline', icon: '▦', section: 'Sales', order: 12, roles: ROLES_SALES, render: renderPipeline });
  regPage({ id: 'quotations', title: 'Quotations', icon: '📄', section: 'Sales', order: 13, roles: ROLES_SALES, render: renderQuotations, badge: () => (isMgr() ? db.find('quotations', (q) => q.approval === 'Awaiting Approval').length : 0) });
  regPage({ id: 'orders', title: 'Sales Orders', icon: '📦', section: 'Sales', order: 14, roles: ROLES_SALES, render: renderOrders, badge: () => (isMgr() ? db.find('orders', (o) => o.approval === 'Awaiting Approval').length : 0) });
  regPage({ id: 'followups', title: 'Follow-ups', icon: '📅', section: 'Sales', order: 15, roles: ROLES_SALES, render: renderFollowups, badge: () => allFu().filter((f) => f.status === 'Planned' && f.dueDate <= todayIso()).length });
  regPage({ id: 'calls', title: 'Calls & Cold Calling', icon: '☎', section: 'Sales', order: 16, roles: ROLES_SALES, render: renderCalls });
  regPage({ id: 'upsell', title: 'Upsell & Cross-sell', icon: '⤴', section: 'Sales', order: 17, roles: ROLES_SALES, render: renderUpsell });
  regPage({ id: 'salesots', title: 'Sales OTS Desk', icon: '🔋', section: 'Sales', order: 17.5, roles: ROLES_SALES, render: renderSalesOts, badge: () => (isCoord() ? pendingOts().length : 0) });
  regPage({ id: 'dealers', title: 'Dealer Sales', icon: '🤝', section: 'Sales', order: 18, roles: ROLES_SALES, render: renderDealers });
  regPage({ id: 'targets', title: 'Targets', icon: '🎯', section: 'Sales', order: 19, roles: ROLES_SALES, render: renderTargets });
  regPage({ id: 'salesimport', title: 'Data Migration', icon: '⇪', section: 'Sales', order: 19.5, roles: ['sales_manager', 'accounts', 'admin'], render: renderImport });
  regPage({ id: 'invoices', title: 'Invoices', icon: '🧾', section: 'Finance', order: 20, roles: ROLES_FIN, render: renderInvoices, badge: () => (isAcc() ? db.all('orders').filter((o) => o.approval === 'Approved' && !o.migrated && !invoicesOf(o.id).length).length : 0) });
  regPage({ id: 'payments', title: 'Payments & Collections', icon: '₹', section: 'Finance', order: 21, roles: ROLES_FIN, render: renderPayments, badge: () => (isAcc() ? db.find('payments', (p) => !p.verified).length : 0) });
  regPage({ id: 'outstanding', title: 'Outstanding & Ageing', icon: '⏳', section: 'Finance', order: 22, roles: ROLES_FIN, render: renderOutstanding });
  regPage({ id: 'salesreports', title: 'Report Centre', icon: '📊', section: 'Sales Reports', order: 25, roles: ['sales_exec', 'sales_coordinator', 'sales_manager', 'gm', 'admin'], render: renderReports });
  regPage({ id: 'cycletimes', title: 'Cycle Times', icon: '⏱', section: 'Sales Reports', order: 26, roles: ROLES_MGMT_SALES, render: renderCycleTimes });
  regPage({ id: 'salespolicy', title: 'Sales SLA & Escalations', icon: '🚨', section: 'Sales Reports', order: 27, roles: ['sales_coordinator', 'sales_manager', 'gm', 'admin', 'odm'], render: renderPolicy });

  // ============================================================ admin: sales rules & report configuration (Settings & Rules)
  function renderSalesSettings(container) {
    const canEdit = CRM.is('sales_manager', 'admin');
    const block = (title, key, fields, note, toSave) => {
      const cur = cfg(key);
      const f = ui.form(fields.map((x) => Object.assign({ type: 'number', min: 0, step: 'any', required: x.required !== false }, x)), cur);
      if (!canEdit) Object.values(f.inputs).forEach((i) => { i.disabled = true; });
      return card(title, h('div', { class: 'stack' }, [note ? h('div', { class: 'small muted' }, note) : null, f, canEdit ? h('div', {}, ui.btn('Save', () => {
        if (!f.validate()) return;
        const v = f.values();
        const err = toSave ? toSave(v) : null;
        if (err) { ui.toast(err, 'bad'); return; }
        setCfg(key, Object.assign({}, cur, v)); ui.toast(title + ' saved', 'ok');
      }, 'primary sm')) : null]));
    };
    const asc = (v) => (v.l2 < v.l3 && v.l3 < v.l4 ? null : 'Levels must increase: L2 < L3 < L4');
    container.appendChild(h('div', { class: 'stack' }, [
      canEdit ? null : calloutH('Read-only — the Sales Manager or CRM Administrator can change sales rules.', 'info'),
      h('div', { class: 'grid g2' }, [
        block('Sales policy SLAs', 'sales.sla', [{ key: 'quoteHrs', label: 'Quotation within (hours of enquiry)' }, { key: 'siteVisitHrs', label: 'Site visit within (hours)' }, { key: 'soHrs', label: 'SO issued within (hours of customer approval)' }, { key: 'scrapHrs', label: 'Scrap collected within (hours of installation)' }, { key: 'quoteResponseDays', label: 'Customer response reminder after (days)' }], 'Breaches are raised as policy violations and escalated automatically.'),
        block('Escalation ladder (hours after breach)', 'sales.escalation', [{ key: 'l2', label: 'L2 · Sales Coordinator after (+h)' }, { key: 'l3', label: 'L3 · Sales Head after (+h)' }, { key: 'l4', label: 'L4 · Management (GM / ODM) after (+h)' }], 'Policy default: breach → executive, +6 h coordinator, +12 h department head, +24 h management.', asc),
        block('Payment collection escalation (days overdue)', 'sales.paymentEscalation', [{ key: 'l2', label: 'L2 · Sales Coordinator after (days)' }, { key: 'l3', label: 'L3 · Sales Head after (days)' }, { key: 'l4', label: 'L4 · Management after (days)' }], 'Day 1 past the credit period → executive + Accounts.', asc),
        block('Reminders & alerts', 'sales.reminders', [{ key: 'paymentDueDays', label: 'Payment-due reminder window (days before due)' }, { key: 'scanMinutes', label: 'Re-check reminders & escalations every (minutes)', min: 1 }], 'Follow-up due / missed reminders go to the owning executive; the coordinator gets a team digest.'),
        block('Quotation rules', 'sales.discount', [{ key: 'justifyAbovePct', label: 'Discount above which justification is mandatory (%)' }]),
        block('Sales OTS incentive', 'sales.otsIncentive', [{ key: 'salesPct', label: 'Sales OTS incentive % of order value (blank = Service setting)', required: false }, { key: 'engineerSharePct', label: 'Shared case: engineer share % (executive gets the rest)', max: 100 }], 'Applied on the Sales OTS desk to orders booked from Service opportunities.', (v) => (v.engineerSharePct > 100 ? 'Engineer share cannot exceed 100%' : null)),
      ]),
      card('GST rate by division (used on quotations and default invoice values)', ui.dl(DIVS.map((d) => [d, gstPct(d) + '%' + (CRM.config ? ' · config key gst.' + d : ' · default')]))),
      card('Reports', ui.dl([['Daily reports', '10 · default range today'], ['Weekly reports', '2 · calendar week Monday → Sunday'], ['Monthly reports', '7 · month to date'], ['Exports', 'CSV and PDF on every report'], ['Executives', 'own data only; division-wise reports hidden']])),
    ]));
  }
  if (CRM.registerConfigSection) CRM.registerConfigSection({ id: 'sales-rules', title: 'Sales rules & reports', roles: ['sales_manager', 'admin', 'gm'], render: renderSalesSettings });
  else regPage({ id: 'salessettings', title: 'Sales Settings', icon: '⚙', section: 'Sales Reports', order: 28, roles: ['sales_manager', 'admin', 'gm'], render: (el) => { ui.page(el, { title: 'Sales Settings', sub: 'Sales SLAs, escalation ladder, reminder windows, quotation and incentive rules' }); renderSalesSettings(el); } });

  // ============================================================ customer 360, global search
  // Data scope per role: sales roles see the pipeline (executives only their own); Accounts sees invoices & payments only;
  // other departments see the customer's sale orders (what was bought) without pipeline or receivables
  CRM.registerCustomerSection((c) => {
    const salesRole = CRM.is(...ROLES_SALES), finRole = CRM.is('accounts');
    const enqs = scope(db.find('enquiries', (e) => e.customerId === c.id)), ords = scope(db.find('orders', (o) => o.customerId === c.id && o.approval !== 'Rejected')), invs = scope(db.find('invoices', (i) => i.customerId === c.id));
    const os = sum(invs, outstandingOf);
    if (finRole && !salesRole) {
      return { title: 'Accounts — invoices & payments', flush: true, summary: invs.length + ' invoices · O/S ' + fmt.lakh(os),
        body: () => h('div', {}, [ui.kpis([{ label: 'Invoiced', value: fmt.lakh(sum(invs, 'value')) }, { label: 'Received', value: fmt.lakh(sum(invs, paidOf)), color: 'var(--ok)' }, { label: 'Outstanding', value: fmt.lakh(os), color: 'var(--bad)' }, { label: 'Awaiting verification', value: fmt.lakh(sum(invs, pendingOf)), color: 'var(--chart-4)' }]), invoiceTable(invs, { search: false })]) };
    }
    if (!salesRole) {
      const live = ords.filter((o) => o.approval === 'Approved');
      return { title: 'Sales orders', flush: true, summary: live.length + ' approved sale orders', body: () => ui.table({ rows: live, search: false, pageSize: 6, empty: 'No sale orders', columns: [{ key: 'soNumber', label: 'SO', render: (o) => mono(o.soNumber) }, { key: 'wonDate', label: 'Date', render: (o) => fmt.date(o.wonDate) }, { key: 'division', label: 'Division', render: (o) => ui.divTag(o.division) }, { key: 'product', label: 'Product', render: (o) => o.product + ' × ' + o.quantity }, { key: 'installationStatus', label: 'Installation', render: (o) => ui.badge(o.installationStatus) }, { key: 'warrantyContract', label: 'Warranty' }] }) };
    }
    return {
      title: 'Sales — enquiries, orders & outstanding', flush: true,
      summary: enqs.length + ' enquiries · ' + ords.length + ' orders · O/S ' + fmt.lakh(os),
      body: () => ui.tabs([{ id: 'e', label: 'Enquiries', count: enqs.length }, { id: 'o', label: 'Orders', count: ords.length }, { id: 'i', label: 'Outstanding', count: invs.filter((i) => outstandingOf(i) > 0).length }, { id: 'u', label: 'Upsell', count: scope(db.find('upsells', (u) => u.customerId === c.id)).length }], (id, body) => {
        if (id === 'e') body.appendChild(enquiryTable(enqs, { pageSize: 6 }));
        if (id === 'o') body.appendChild(orderTable(ords));
        if (id === 'i') body.appendChild(h('div', {}, [ui.kpis([{ label: 'Invoiced', value: fmt.lakh(sum(invs, 'value')) }, { label: 'Received', value: fmt.lakh(sum(invs, paidOf)), color: 'var(--ok)' }, { label: 'Outstanding', value: fmt.lakh(os), color: 'var(--bad)' }]), invoiceTable(invs, { search: false })]));
        if (id === 'u') body.appendChild(upsellTable(scope(db.find('upsells', (u) => u.customerId === c.id)), { search: false }));
      }),
    };
  });
  CRM.registerSearch((q) => {
    const res = [];
    const has = (...xs) => xs.join(' ').toLowerCase().includes(q);
    if (CRM.canSee('enquiries')) allEnq().filter((e) => has(e.id, e.accountName, e.contactName, e.contactNumber, e.product)).slice(0, 5).forEach((e) => res.push({ label: e.id + ' · ' + e.accountName, sub: 'Enquiry · ' + e.stage + ' · ' + e.product, link: '#/enquiries/' + e.id }));
    if (CRM.canSee('quotations')) allQuotes().filter((x) => has(x.id, x.accountName)).slice(0, 3).forEach((x) => res.push({ label: x.id + ' · ' + x.accountName, sub: 'Quotation · ' + x.status + ' · ' + fmt.money(x.quoteValue), link: '#/quotations/' + x.id }));
    if (CRM.canSee('orders')) allOrders().filter((o) => has(o.id, o.soNumber, o.poNumber, o.accountName)).slice(0, 3).forEach((o) => res.push({ label: (o.soNumber || o.id) + ' · ' + o.accountName, sub: 'Sales order · PO ' + o.poNumber + ' · ' + orderStatus(o), link: '#/orders/' + o.id }));
    if (CRM.canSee('invoices')) db.all('invoices').filter((i) => has(i.invoiceNo, i.accountName)).slice(0, 3).forEach((i) => res.push({ label: i.invoiceNo + ' · ' + i.accountName, sub: 'Invoice · ' + invStatus(i) + ' · O/S ' + fmt.money(outstandingOf(i)), link: '#/payments' }));
    return res;
  });

  // ============================================================ events & automations
  const SALES_COLS = ['enquiries', 'quotations', 'orders', 'invoices', 'payments', 'followups'];
  const scheduleScan = util.debounce(runPolicyScan, 400);
  CRM.on('ready', () => {
    try { promoteExistingBuyers(); } catch (e) { console.error('[sales] customer promotion', e); }
    try { runPolicyScan(); } catch (e) { console.error('[sales] policy scan', e); }
  });
  // reminders and escalations are re-checked on a timer too (not only when data changes)
  const tick = () => { try { runPolicyScan(); } catch (e) { console.error('[sales] policy scan', e); } };
  const tickMs = Math.max(1, Number(cfg('sales.reminders').scanMinutes) || 5) * 60e3;
  if (CRM.registerTick) CRM.registerTick(tick, tickMs); else setInterval(tick, tickMs);
  /** One-time data fix for stores created before promotion existed: customers with an approved order are no longer "New". */
  function promoteExistingBuyers() {
    master.customers().filter((c) => c.type === 'New Customer' && db.one('orders', (o) => o.customerId === c.id && o.approval === 'Approved')).forEach((c) => promoteCustomer(c.id));
  }
  CRM.on('db:change', (x) => { if (x && SALES_COLS.includes(x.col)) scheduleScan(); });
  // Service raised a chargeable complaint → service-charge invoice for Accounts to collect
  CRM.on('complaint.chargeable', (p) => {
    const c = (p && p.complaint) || {};
    if (!p || !p.amount || db.one('invoices', (i) => i.complaintId === c.id)) return;
    const cust = master.customer(c.customerId) || {};
    const inv = db.insert('invoices', { invoiceNo: 'MPCS/' + fy(new Date()) + '/SRV-' + CRM.nextId('INVNO').split('-')[1], orderId: '', complaintId: c.id || '', soNumber: '', customerId: c.customerId || '', accountName: cust.name || c.customerName || 'Service customer', division: c.division || 'Power', execId: '', invoiceDate: todayIso(), value: Math.round(p.amount), paymentTerms: 'Credit 15 days', dueDate: util.iso(util.addDays(CRM.TODAY, 15)), hardCopySubmitted: false, invoiceMailed: false, confirmedWith: cust.contact || '', source: 'Service' }, { prefix: 'INV', note: 'Service charges from complaint ' + (c.id || '') });
    CRM.emit('invoice.raised', { invoice: inv });
    send(['accounts'], { title: 'Service charges to collect: ' + fmt.money(p.amount), body: (cust.name || '') + ' · complaint ' + (c.id || ''), link: '#/invoices', severity: 'info', key: 'srvinv:' + (c.id || inv.id) });
  });
  // Sales OTS (battery qty > 2) from Service → Sales Coordinator assigns to an executive
  // Payload: { ots } with service.js field names (qty, value, brand, productType, capacity, contact, customerId, urgency, complaintId)
  CRM.on('ots.created', (p) => {
    const o = (p && (p.ots || p)) || {};
    if (!o.id || !isSalesOts(o)) return;
    const c = otsCustomer(o);
    // Service already alerts the coordinator for this OTS (key 'ots-<id>') — only notify when it did not
    setTimeout(() => { if (db.one('notifications', (x) => x.key === 'ots-' + o.id)) return; send(['sales_coordinator'], { title: 'Sales OTS ' + o.id + ' — assign to a Sales Executive', body: (c.name || o.customerName || 'Customer') + ' · ' + otsQty(o) + ' × ' + (o.productType || 'Battery') + (o.brand ? ' ' + o.brand : '') + ' · est. ' + fmt.money(otsValue(o)) + (o.urgency ? ' · ' + o.urgency : ''), severity: 'warn', key: 'ots:' + o.id }, ['#/ots/' + o.id, '#/salesots/' + o.id]); }, 0);
  });

  // ============================================================ public helper (GM cockpit)
  CRM.sales = { summary, autoAssign, policyBreaches, outstandingOf, targetFor, achievedFor, acquisitions, gstPct, otsIncentive: (id) => { const o = db.get('ots', id); return o ? otsIncentive(o) : null; } };
})();
