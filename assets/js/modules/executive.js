/* Executive module — GM/CEO and Admin cockpits, the consolidated management layer and the Role Design Guide.
 * Pages: Management Dashboard (projects total/ongoing/delayed/completed, stage-wise, project risk level,
 *        policy-violation dashboard with delayed stages, vendor & engineer delays, department / coordinator
 *        scores with violation penalty) and Management Reports (consolidated DRM / WRM / MRM across Sales,
 *        Projects, Service & PM, SLA, revenue, targets and an action-owner register, CSV/PDF export).
 * Reads (never writes) the other modules' collections and their CRM.sales / CRM.projects / CRM.service exports.
 * Emits:  report.dispatch { report, period, from, to, division, channel, to:[roleIds] } — integration hook for
 *         e-mail / WhatsApp distribution of DRM/WRM/MRM (simulated in this build).
 * Notify event: mgmt.report (channels configurable in Settings & Rules → Notification channels).
 * Config: exec.violationPenalty, exec.coordinatorPenalty, exec.scoreWindowDays, exec.riskDays, exec.reportRecipients
 */
(function () {
  'use strict';
  const { db, ui, h, util, fmt, master } = CRM;

  const safe = (fn, fallback) => { try { const r = fn(); return r == null ? fallback : r; } catch (e) { console.error(e); return fallback; } };
  const cfg = (k, d) => safe(() => (CRM.config ? CRM.config.get(k, d) : d), d);
  const MG = CRM.MGMT || ['admin', 'gm', 'odm'];
  const DIVS = ['Power', 'Electronic Security', 'Solar'];
  const DIV_COLORS = { Power: 'var(--div-power)', 'Electronic Security': 'var(--div-security)', Solar: 'var(--div-solar)' };
  const DAY = 864e5;
  const esc = (s) => util.esc(s == null ? '' : String(s));
  const note = (html, kind) => (ui.calloutHtml ? ui.calloutHtml(html, kind) : ui.callout(html, kind));
  const canSee = (id) => safe(() => CRM.canSee(id), false);
  const go = (id, arg) => { if (canSee(id)) CRM.go(id, arg); };
  const sName = (id) => (id ? master.staffName(id) : '—');
  const roleName = (rid) => { const r = rid ? CRM.roles.find((x) => x.id === rid) : null; return r ? r.name : (rid || '—'); };

  // ---------------------------------------------------------------- date helpers (local, YYYY-MM-DD safe)
  function parseD(v) {
    if (!v) return null;
    if (v instanceof Date) return v;
    if (CRM.util.parseDate) { const d = safe(() => CRM.util.parseDate(v), null); if (d) return d; }
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d); }
    const d = new Date(v); return isNaN(d) ? null : d;
  }
  const day0 = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const today = () => day0(CRM.TODAY || new Date());
  const addD = (d, n) => new Date(day0(d).getTime() + n * DAY);
  const inR = (v, a, b) => { const d = parseD(v); return !!d && d >= a && d < b; };
  const isPast = (v) => { const d = parseD(v); return !!d && d < today(); };
  const daysLate = (v) => { const d = parseD(v); return d ? Math.max(0, Math.round((today() - day0(d)) / DAY)) : 0; };
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const pctTxt = (v) => (v == null ? '—' : fmt.pct(v));
  const sum = (l, f) => l.reduce((a, x) => a + (Number(typeof f === 'function' ? f(x) : x[f]) || 0), 0);
  function fyRange(ref) {
    const r = ref || today(); const y = r.getMonth() >= 3 ? r.getFullYear() : r.getFullYear() - 1;
    return { from: new Date(y, 3, 1), to: new Date(y + 1, 3, 1), label: 'FY ' + y + '–' + String(y + 1).slice(2) };
  }
  const monthLabel = (d) => (fmt.month ? fmt.month(d) : d.toLocaleString('en-GB', { month: 'short', year: 'numeric' }));

  // ---------------------------------------------------------------- shared data accessors
  // One migrated-order rule everywhere in this module: migrated (historical) orders are real approved orders and
  // count wherever their won date falls in the period; the FY window keeps pre-FY history out of FY totals.
  const approvedOrders = () => db.all('orders').filter((o) => o.approval === 'Approved' && o.wonDate);
  const openEnquiries = () => db.all('enquiries').filter((e) => !['Order Won', 'Order Lost'].includes(e.stage));
  function outstandingOf(inv) {
    if (CRM.sales && typeof CRM.sales.outstandingOf === 'function') return safe(() => CRM.sales.outstandingOf(inv), 0);
    return Math.max(0, (Number(inv.value) || 0) - sum(db.all('payments').filter((p) => p.invoiceId === inv.id), 'value'));
  }
  const byDiv = (div) => (r) => !div || div === 'All' || r.division === div;

  // projects
  const STAGE_LABEL = { so: 'Sales order', scope: 'Scope', survey: 'Site survey', boq: 'BOQ', procurement: 'Procurement', delivery: 'Material delivery', planning: 'Planning', cable: 'Cabling', nvr: 'NVR / DVR', cameras: 'Cameras', install: 'Installation', civil: 'Civil work', mechanical: 'Mechanical', electrical: 'Electrical', testing: 'Testing', commissioning: 'Commissioning', compliance: 'Compliance', handover: 'Handover', activate: 'Activation' };
  const stageName = (k) => STAGE_LABEL[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : '—');
  const SDONE = (s) => !!s && (s.status === 'Completed' || s.status === 'Skipped');
  const pActive = (p) => !['Closed', 'Cancelled'].includes(p.status);
  const pTarget = (p) => p.revisedDate || p.committedDate;
  const lateStages = (p) => Object.keys(p.stages || {}).filter((k) => { const s = p.stages[k]; return s && !SDONE(s) && isPast(s.due); });
  const lateTasks = (p) => (p.tasks || []).filter((t) => t.status !== 'Completed' && t.status !== 'Cancelled' && isPast(t.due));
  const pDelayed = (p) => pActive(p) && (isPast(pTarget(p)) || lateStages(p).length > 0);
  function pProgress(p) { const ks = Object.keys(p.stages || {}); return ks.length ? ks.filter((k) => SDONE(p.stages[k])).length / ks.length : 0; }
  const linkOf = (col, id) => '#/' + col + '/' + id;

  // service
  const svcOpen = (c) => c.status !== 'Closed' && c.status !== 'Cancelled';
  const sla = (c, kind) => (CRM.service && typeof CRM.service.slaState === 'function' ? safe(() => CRM.service.slaState(c, kind), 'N/A') : 'N/A');
  const svcOverdue = (c) => svcOpen(c) && ['ack', 'attend', 'resolve'].some((k) => sla(c, k) === 'Breached');
  const vOpen = (v) => !['Closed', 'Exception'].includes(v.status);
  const vAt = (v) => v.incidentAt || v.createdAt;
  const pmGrace = () => Number(cfg('service.pmGraceDays', 7)) || 7;
  const pmOnTime = (v) => !!v.completedDate && (parseD(v.completedDate) - parseD(v.dueDate)) / DAY <= pmGrace();
  const pmOverdue = (v) => !v.completedDate && isPast(v.dueDate);

  function projViolations(p) { return db.all('violations').filter((v) => (v.col === 'projects' && v.recId === p.id) || (v.link && v.link === linkOf('projects', p.id))); }

  /** Project risk level: Low / Medium / High, with reasons. */
  function projRisk(p) {
    if (!pActive(p)) return null;
    const reasons = []; let pts = 0;
    const tgt = parseD(pTarget(p));
    if (tgt && tgt < today()) { pts += 3; reasons.push('Past committed date by ' + daysLate(tgt) + ' d'); }
    const ls = lateStages(p); if (ls.length) { pts += Math.min(3, ls.length); reasons.push(ls.length + ' stage(s) overdue: ' + ls.map(stageName).join(', ')); }
    const lt = lateTasks(p); if (lt.length) { pts += 1; reasons.push(lt.length + ' task(s) overdue'); }
    const vs = projViolations(p).filter(vOpen); const sev = vs.filter((v) => ['Critical', 'High'].includes(v.severity));
    if (sev.length) { pts += 2; reasons.push(sev.length + ' high/critical violation(s) open'); } else if (vs.length) { pts += 1; reasons.push(vs.length + ' open violation(s)'); }
    const prog = pProgress(p);
    if (tgt && tgt >= today()) {
      const left = Math.round((tgt - today()) / DAY);
      const start = parseD(p.orderDate || p.createdAt) || today();
      const span = Math.max(1, (tgt - start) / DAY); const elapsed = Math.min(1, Math.max(0, (today() - start) / DAY / span));
      if (left <= Number(cfg('exec.riskDays', 7)) && prog < 0.75) { pts += 2; reasons.push('Committed date in ' + left + ' d with ' + Math.round(prog * 100) + '% stages done'); } else if (elapsed - prog > 0.3) { pts += 1; reasons.push('Progress ' + Math.round(prog * 100) + '% vs ' + Math.round(elapsed * 100) + '% of time elapsed'); }
    }
    if (db.all('dcs').some((d) => d.projectId === p.id && d.status === 'Discrepancy')) { pts += 1; reasons.push('Open material discrepancy'); }
    return { level: pts >= 4 ? 'High' : pts >= 2 ? 'Medium' : 'Low', pts, reasons, progress: Math.round(prog * 100) };
  }
  const RISK_TONE = { High: 'bad', Medium: 'warn', Low: 'ok' };

  // ---------------------------------------------------------------- export helpers (Core API v2 with local fallbacks)
  function plainRows(rows, cols) { return rows.map((r) => { const o = {}; cols.forEach((c) => { const v = c.csv ? c.csv(r) : r[c.key]; o[c.key] = v == null ? '' : v; }); return o; }); }
  function exportCsv(name, rows, cols) {
    const plain = plainRows(rows, cols); const cc = cols.map((c) => ({ key: c.key, label: c.label }));
    if (typeof CRM.exportCsv === 'function') { try { CRM.exportCsv(name, plain, cc); return; } catch (e) { console.error(e); } }
    const q = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const csv = [cc.map((c) => q(c.label)).join(',')].concat(plain.map((r) => cc.map((c) => q(r[c.key])).join(','))).join('\r\n');
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })), download: name.replace(/\.csv$/i, '') + '.csv' });
    document.body.appendChild(a); a.click(); a.remove();
  }
  function exportPdf(title, node) {
    if (typeof CRM.exportPdf === 'function') { try { CRM.exportPdf(title, node); return; } catch (e) { console.error(e); } }
    const w = window.open('', '_blank');
    if (!w) { window.print(); return; }
    const css = new URL('assets/css/app.css', location.href).href;
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title><link rel="stylesheet" href="' + css + '"><style>body{padding:24px;background:#fff}.no-print{display:none!important}</style></head><body><h1>' + esc(title) + '</h1>' + node.outerHTML + '</body></html>');
    w.document.close(); setTimeout(() => { try { w.focus(); w.print(); } catch (e) { /* ignore */ } }, 400);
  }

  // ---------------------------------------------------------------- role design research
  // Each entry summarises what the requirement documents ask of the role and how the CRM serves it.
  const ROLE_DESIGN = {
    gm: { purpose: 'Management oversight across all three divisions and authorized approvals.', sees: 'Executive cockpit: revenue, pipeline, projects, service SLA, collections, policy violations; Management Dashboard and consolidated DRM / WRM / MRM.', kpis: ['Sales by division', 'Target vs achieved', 'Outstanding', 'SLA compliance', 'Open violations', 'Project risk'], source: 'Sales §9, ES §9/§10.1/§11, Solar §10, Service management dashboards' },
    admin: { purpose: 'Users, master data, workflow rules and access configuration.', sees: 'Users & access matrix, master data, Settings & Rules, data import, audit log, import/export.', kpis: ['Active users', 'Audit events', 'Data volumes'], source: 'Sales §3, ES §9, Solar §8' },
    odm: { purpose: 'Cross-functional pending tasks, policy compliance and escalations.', sees: 'ODM cockpit: violations by rule/owner, escalation ladder, customer-risk view, department & coordinator scores.', kpis: ['Open violations', 'Repeat offenders', 'Escalations closed on time', 'Department score'], source: 'Service doc — Policy violation & escalation matrix, ES §10.4' },
    sales_manager: { purpose: 'Assign leads, monitor pipeline, approve quotations & sale orders, track executive performance.', sees: 'Team pipeline, approval queues, executive target vs achieved, reports.', kpis: ['Pipeline value', 'Quote response time', 'Conversion %', 'Target vs achieved'], source: 'Sales §3.2, §7, §9' },
    sales_coordinator: { purpose: 'Route OTS / enquiries to executives and keep follow-ups disciplined.', sees: 'Unassigned enquiries, follow-up board, quotation turnaround.', kpis: ['Unassigned leads', 'Missed follow-ups', 'Quote TAT'], source: 'Service doc — Sales OTS flow' },
    sales_exec: { purpose: 'Create enquiries, follow up, send quotations, update orders and communication — own leads only.', sees: 'My day: follow-ups due, my pipeline, my targets, mobile check-in/out.', kpis: ['Calls vs target', 'Follow-ups done vs planned', 'Upsell/cross-sell', 'My revenue'], source: 'Sales §3.1, §11, §12' },
    accounts: { purpose: 'Invoices, payments received and outstanding; chargeable service & AMC billing.', sees: 'Collections today, ageing buckets, invoice submission status.', kpis: ['Collected vs due', 'Outstanding ageing', 'Payment per policy %'], source: 'Sales §3.3, §6, ES §9' },
    es_coordinator: { purpose: 'Own Electronic Security projects/jobs: allocation, schedule and handover.', sees: 'Large vs small jobs by stage, overdue milestones, material readiness.', kpis: ['Installation on-time %', 'Handover on-time %', 'Material readiness %'], source: 'ES §4, §5, §10.2' },
    solar_coordinator: { purpose: 'End-to-end solar project coordination, schedules and handover.', sees: 'Solar projects by stage, net-metering & subsidy status, vendor progress.', kpis: ['Commissioning on-time %', 'Net-metering ageing', 'Subsidy pending'], source: 'Solar §3, §9' },
    doc_coordinator: { purpose: 'Net-metering and subsidy documentation, submissions and follow-ups.', sees: 'Document checklists, application status, pending follow-ups (sensitive docs restricted).', kpis: ['Applications pending', 'Days at utility', 'Subsidy released'], source: 'Solar §3.9, §3.10, §8' },
    tech_engineer: { purpose: 'Site survey, BOQ, installation, configuration and service — assigned work only.', sees: 'Field task list, survey forms, BOQ drafts, checklists.', kpis: ['Survey on-time %', 'BOQ turnaround', 'First-time pass %'], source: 'ES §4.2–4.10, Solar §3.2–3.8' },
    tech_head: { purpose: 'Technical approvals: BOQ, design, inspection and commissioning.', sees: 'Approval queue, failed inspections, secure credential vault.', kpis: ['Approvals pending', 'Rework count', 'Inspection pass %'], source: 'ES §4.3, §4.10, Solar §3.3' },
    purchase: { purpose: 'Procurement, suppliers and delivery follow-up.', sees: 'Shortages vs BOQ, PR/PO pipeline, supplier delays.', kpis: ['Purchase initiation time', 'Supplier on-time %', 'Cost variance'], source: 'ES §4.4, Solar §3.4, Service doc — Purchase' },
    stores: { purpose: 'GRN, stock issue, DC, dispatch, returns and scrap.', sees: 'GRN queue, DCs to dispatch, returns to reconcile.', kpis: ['GRN pending', 'DC dispatched today', 'Unreconciled returns'], source: 'ES §4.5, Service doc — GRN/DC/Scrap' },
    install_lead: { purpose: 'Daily installation progress and checklist completion.', sees: 'Today’s sites, cable/device checklists, pending work.', kpis: ['Tasks due today', 'Overdue tasks', 'Cable variance'], source: 'ES §4.7–4.9, Solar §3.7' },
    vendor: { purpose: 'Assigned installation tasks and completion evidence only.', sees: 'Only own assigned tasks — no costs, other customers or other vendors.', kpis: ['Assigned tasks', 'Completed on time'], source: 'ES §9, Solar §8' },
    service_coordinator: { purpose: 'Complaint assignment, SLA monitoring and escalation.', sees: 'Live call queue with SLA clocks, engineer workload, repeat complaints.', kpis: ['Ack SLA', 'Attendance SLA', 'Resolution SLA', 'Repeat %'], source: 'Service doc, ES §6, Solar §5' },
    service_engineer: { purpose: 'Attendance, diagnosis, repair and service report — own calls only.', sees: 'Mobile call list, check-in, diagnosis, spares, customer confirmation.', kpis: ['Calls today', 'First-visit resolution', 'Reports pending'], source: 'Service doc, ES §6.3' },
    service_centre_tech: { purpose: 'Bench repair of products shifted to the Service Centre: inward (GRN), testing, repair and dispatch.', sees: 'Service-centre job queue, inward/outward status, spares used, ready-for-dispatch list.', kpis: ['Jobs in bench', 'Turnaround time', 'Ready for dispatch'], source: 'Service doc — Service Centre / GRN / DC flow' },
    pm_coordinator: { purpose: 'PM schedule, AMC renewals, overdue visits and reporting.', sees: 'PM due list, AMC expiring, warranty→AMC conversion funnel.', kpis: ['PM compliance %', 'AMC renewals', 'Conversion %'], source: 'Service doc — AMC & PM, ES §7, Solar §6' },
  };

  // ---------------------------------------------------------------- GM / CEO cockpit
  function salesSnapshot(range) {
    const ords = approvedOrders().filter((o) => inR(o.wonDate, range.from, range.to));
    const open = openEnquiries();
    const byDivision = {}; DIVS.forEach((d) => { byDivision[d] = sum(ords.filter((o) => o.division === d), 'value'); });
    const mStart = new Date(today().getFullYear(), today().getMonth(), 1);
    const months = []; for (let i = 5; i >= 0; i--) { const a = new Date(mStart.getFullYear(), mStart.getMonth() - i, 1); months.push({ label: monthLabel(a), from: a, to: new Date(a.getFullYear(), a.getMonth() + 1, 1) }); }
    return {
      open, pipelineValue: sum(open, 'expectedValue'), orders: ords, wonValue: sum(ords, 'value'), migrated: ords.filter((o) => o.migrated).length, byDivision,
      outstanding: sum(db.all('invoices'), outstandingOf), collectedThisMonth: sum(db.all('payments').filter((p) => inR(p.receivedDate, mStart, addD(today(), 1))), 'value'),
      monthly: months.map((m) => ({ label: m.label, value: sum(approvedOrders().filter((o) => inR(o.wonDate, m.from, m.to)), 'value') })),
    };
  }
  function projectCounts(div) {
    const ps = db.all('projects').filter(byDiv(div)).filter((p) => p.status !== 'Cancelled');
    const act = ps.filter(pActive);
    return { list: ps, total: ps.length, ongoing: act.length, delayed: act.filter(pDelayed).length, completed: ps.filter((p) => p.status === 'Closed').length, highRisk: act.filter((p) => (projRisk(p) || {}).level === 'High').length };
  }

  function gmHome(el) {
    const fy = fyRange();
    const s = salesSnapshot(fy);
    const p = safe(() => CRM.projects && CRM.projects.summary(), null);
    const v = safe(() => CRM.service && CRM.service.summary(), null);
    const pc = projectCounts();
    el.appendChild(ui.hero(CRM.role(), ['3 divisions', fy.label + ' (Apr–Mar)', 'Live data']));

    el.appendChild(ui.kpis([
      { label: 'Pipeline value', value: fmt.lakh(s.pipelineValue), meta: s.open.length + ' open enquiries', color: 'var(--chart-1)', onClick: canSee('pipeline') ? () => go('pipeline') : null },
      { label: 'Orders won · ' + fy.label, value: fmt.lakh(s.wonValue), meta: s.orders.length + ' orders' + (s.migrated ? ' (incl. ' + s.migrated + ' migrated)' : ''), color: 'var(--ok)', onClick: canSee('orders') ? () => go('orders') : null },
      { label: 'Outstanding', value: fmt.lakh(s.outstanding), meta: 'Collected this month ' + fmt.lakh(s.collectedThisMonth), color: 'var(--warn)', onClick: canSee('outstanding') ? () => go('outstanding') : null },
      { label: 'Projects', value: pc.total, meta: pc.ongoing + ' ongoing · ' + pc.completed + ' completed · ' + pc.delayed + ' delayed', color: 'var(--div-security)', onClick: () => go('mgmt-dash') },
      { label: 'Open service calls', value: v ? v.openCalls : '—', meta: v ? v.overdueCalls + ' overdue' : '', color: 'var(--chart-4)', onClick: canSee('complaints') ? () => go('complaints') : null },
      { label: 'Attendance SLA', value: v ? fmt.pct(v.attendanceSla) : '—', meta: v ? 'Resolution SLA ' + fmt.pct(v.resolutionSla) : '', color: 'var(--chart-5)' },
      { label: 'Open violations', value: v ? v.openViolations : db.all('violations').filter(vOpen).length, meta: 'Policy compliance', color: 'var(--bad)', onClick: canSee('violations') ? () => go('violations') : null },
    ]));

    el.appendChild(h('div', { class: 'row', style: 'margin:4px 0 14px' }, [ui.btn('Management dashboard', () => go('mgmt-dash'), 'primary'), ui.btn('DRM / WRM / MRM', () => go('mgmt-reports'))]));

    const grid = h('div', { class: 'grid g2' });
    grid.appendChild(ui.card('Sales trend — orders won (last 6 months)', ui.lineChart(s.monthly.map((m) => m.label), [{ name: 'Won value', color: 'var(--chart-1)', values: s.monthly.map((m) => m.value) }], { money: true, area: true })));
    grid.appendChild(ui.card('Sales by division · ' + fy.label, ui.donut(DIVS.map((k) => ({ label: k, value: s.byDivision[k] || 0, color: DIV_COLORS[k] })), { money: true, label: 'Won value' })));
    if (p && p.byStage) grid.appendChild(ui.card('Active projects by stage', ui.barChart(p.byStage.map((x) => ({ label: x.label, values: [x.value] })), [{ name: 'Projects', color: 'var(--div-security)' }])));
    if (v && v.byDivision) grid.appendChild(ui.card('Open service calls by division', ui.hbars(Object.keys(v.byDivision).map((k) => ({ label: k, value: Number(v.byDivision[k]) || 0, color: DIV_COLORS[k] })))));
    if (v) grid.appendChild(ui.card('Service & PM health', ui.dl([['Attendance SLA', fmt.pct(v.attendanceSla)], ['Resolution SLA', fmt.pct(v.resolutionSla)], ['Repeat complaints', fmt.pct(v.repeatPct)], ['PM due / overdue', v.pmDue + ' / ' + v.pmOverdue], ['AMC expiring (60d)', v.amcExpiring], ['Open violations', v.openViolations]])));
    grid.appendChild(ui.card('Project execution health', ui.dl([['Total projects', pc.total], ['Ongoing / completed', pc.ongoing + ' / ' + pc.completed], ['Delayed', pc.delayed], ['High risk', pc.highRisk]].concat(p ? [['Large ES projects', p.large], ['Small ES jobs', p.small], ['Solar projects', p.solar], ['Material shortage', p.materialShort], ['Handover pending', p.handoverPending]] : []))));
    el.appendChild(grid);
    el.appendChild(h('div', { class: 'mt' }, alertsCard()));
  }

  function alertsCard() {
    const list = db.all('notifications').filter((n) => n.severity === 'bad' || n.severity === 'warn').slice(-12).reverse();
    return ui.card('Latest escalations & alerts', list.length ? ui.timeline(list.map((n) => ({ when: fmt.dateTime(n.createdAt) + ' · to ' + ([].concat(n.to || []).map((r) => (r === 'mgmt' ? 'Management' : roleName(r))).concat(n.toUser ? [sName(n.toUser)] : []).join(', ') || '—'), title: n.title, body: n.body, color: n.severity === 'bad' ? 'var(--bad)' : 'var(--warn)' }))) : ui.empty('No escalations', '✅'));
  }

  // ---------------------------------------------------------------- Admin console
  const COLLECTIONS = [
    ['Core', ['customers', 'sites', 'products', 'staff', 'notifications', 'audit', 'files']],
    ['Sales', ['enquiries', 'followups', 'quotations', 'orders', 'invoices', 'payments', 'upsells', 'callLogs', 'targets', 'dealers', 'checkins']],
    ['Projects & supply chain', ['projects', 'surveys', 'boqs', 'purchaseRequests', 'purchaseOrders', 'grns', 'stock', 'dcs', 'scrap', 'netMetering', 'subsidies', 'credVault']],
    ['Service & governance', ['assets', 'complaints', 'amcContracts', 'amcOpportunities', 'pmPlans', 'pmVisits', 'violations', 'escalations', 'feedback', 'spareRequests', 'ots', 'serviceConfig']],
  ];
  const count = (c) => { const l = db.all(c); return Array.isArray(l) ? l.length : 0; };

  function adminHome(el) {
    el.appendChild(ui.hero(CRM.role(), ['System administration', 'Client-side demo · local storage']));
    const staff = db.all('staff');
    const auditN = count('audit');
    const rows = []; COLLECTIONS.forEach(([g, cols]) => cols.forEach((c) => rows.push({ group: g, col: c, n: count(c) })));
    el.appendChild(ui.kpis([
      { label: 'Active users', value: staff.filter((s) => s.active).length, meta: CRM.roles.length + ' roles', onClick: () => go('users') },
      { label: 'Customers', value: count('customers'), onClick: () => go('customer360') },
      { label: 'Audit events', value: auditN, meta: 'last 3,000 kept', onClick: () => go('audit') },
      { label: 'Notifications', value: count('notifications') },
      { label: 'Records', value: sum(rows, 'n').toLocaleString('en-IN'), meta: rows.length + ' collections' },
    ]));
    const cols = [{ key: 'group', label: 'Module' }, { key: 'col', label: 'Collection', render: (r) => h('code', {}, r.col) }, { key: 'n', label: 'Records', cls: 'right' }];
    el.appendChild(h('div', { class: 'grid g2' }, [
      ui.card('Records per collection', ui.table({ rows, columns: cols, search: false, pageSize: 50, filters: [{ key: 'group', label: 'modules', options: COLLECTIONS.map((x) => x[0]) }], toolbar: [ui.btn('Export CSV', () => exportCsv('records-per-collection', rows, cols), 'sm')] }), { flush: true }),
      h('div', { class: 'stack' }, [
        ui.card('Records by module', ui.hbars(COLLECTIONS.map(([g, cs]) => ({ label: g, value: sum(cs, count), color: 'var(--chart-1)' })))),
        ui.card('Users per role', ui.hbars(CRM.roles.map((r) => ({ label: r.name, value: staff.filter((s) => s.role === r.id).length, color: r.color })))),
      ]),
    ]));
    const links = [['Users & access', 'users', 'primary'], ['Settings & Rules', 'settings'], ['Data import', 'dataimport'], ['Master data', 'masters'], ['Audit log', 'audit'], ['Management dashboard', 'mgmt-dash'], ['DRM / WRM / MRM', 'mgmt-reports'], ['Role design guide', 'roleguide']].filter(([, id]) => canSee(id));
    el.appendChild(h('div', { class: 'mt' }, ui.card('Quick links', h('div', { class: 'row' }, links.map(([l, id, k]) => ui.btn(l, () => go(id), k))))));
  }

  CRM.registerHome('gm', gmHome);
  CRM.registerHome('admin', adminHome);

  // ================================================================ Management Dashboard
  function tableCard(title, rows, cols, opts) {
    opts = opts || {};
    const tb = rows.length ? ui.table({ rows, columns: cols, onRow: opts.onRow, search: !!opts.search, pageSize: opts.pageSize || 10, filters: opts.filters }) : ui.empty(opts.empty || 'Nothing to show', '✅');
    const actions = (opts.actions || []).concat(opts.csv && rows.length ? [ui.btn('CSV', () => exportCsv(opts.csv, rows, cols), 'sm no-print')] : []);
    return ui.card(title, tb, { flush: !!rows.length, actions: actions.length ? actions : null });
  }
  const linkCell = (page, id) => (canSee(page) ? h('a', { href: linkOf(page, id) }, id) : h('code', {}, id));

  function engineerDelays() {
    const map = {};
    const row = (id) => (map[id] = map[id] || { id, name: sName(id), role: roleName((db.get('staff', id) || {}).role), calls: 0, lateAttend: 0, tasks: 0, lateTasks: 0, pm: 0, viol: 0 });
    const since = addD(today(), -30);
    db.all('complaints').forEach((c) => {
      if (!c.engineerId) return;
      if (svcOverdue(c)) row(c.engineerId).calls++;
      if (c.attendedAt && inR(c.attendedAt, since, addD(today(), 1)) && sla(c, 'attend') === 'Breached') row(c.engineerId).lateAttend++;
    });
    db.all('projects').forEach((p) => (p.tasks || []).forEach((t) => {
      if (!t.assignee) return;
      if (t.status !== 'Completed' && t.status !== 'Cancelled' && isPast(t.due)) row(t.assignee).tasks++;
      if (t.doneAt && t.due && inR(t.doneAt, since, addD(today(), 1)) && day0(parseD(t.doneAt)) > parseD(t.due)) row(t.assignee).lateTasks++;
    }));
    db.all('pmVisits').forEach((v) => { if (v.engineerId && pmOverdue(v)) row(v.engineerId).pm++; });
    db.all('violations').forEach((v) => { if (v.ownerId && vOpen(v) && map[v.ownerId]) map[v.ownerId].viol++; });
    return Object.values(map).map((r) => Object.assign(r, { total: r.calls + r.lateAttend + r.tasks + r.lateTasks + r.pm })).filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
  }

  function vendorDelays() {
    const vendors = new Set(db.all('staff').filter((s) => s.role === 'vendor').map((s) => s.id));
    const out = [];
    db.all('projects').forEach((p) => (p.tasks || []).forEach((t) => {
      const vid = vendors.has(t.assignee) ? t.assignee : null;
      if (!vid) return;
      const late = t.status !== 'Completed' && t.status !== 'Cancelled' && isPast(t.due);
      const lateDone = t.doneAt && t.due && day0(parseD(t.doneAt)) > parseD(t.due);
      if (late || lateDone) out.push({ vendor: sName(vid), project: p.id, task: t.title || t.kind || t.id, due: t.due, status: late ? 'Overdue' : 'Completed late', days: late ? daysLate(t.due) : Math.round((day0(parseD(t.doneAt)) - parseD(t.due)) / DAY) });
    }));
    db.all('purchaseOrders').forEach((po) => {
      const due = po.expectedDate || po.deliveryDate || po.expectedDelivery;
      if (due && isPast(due) && !['Received', 'Closed', 'Cancelled', 'Completed'].includes(po.status)) out.push({ vendor: po.supplier || po.vendor || '—', project: po.projectId || '—', task: 'PO ' + po.id + ' delivery', due, status: 'Supplier delay', days: daysLate(due) });
    });
    return out.sort((a, b) => b.days - a.days);
  }

  function delayedStages(div) {
    const out = [];
    db.all('projects').filter(byDiv(div)).filter(pActive).forEach((p) => lateStages(p).forEach((k) => out.push({ project: p.id, division: p.division, customer: (master.customer(p.customerId) || {}).name || p.customerId, stage: stageName(k), due: p.stages[k].due, days: daysLate(p.stages[k].due), owner: sName(p.coordinator) })));
    return out.sort((a, b) => b.days - a.days);
  }

  // ---- department & coordinator scores (violation penalty)
  function windowDays() { return Number(cfg('exec.scoreWindowDays', 90)) || 90; }
  function deptScores() {
    const wd = windowDays(); const from = addD(today(), -wd + 1); const to = addD(today(), 1);
    const pen = Number(cfg('exec.violationPenalty', 1.5));
    const vs = db.all('violations');
    const calls = db.all('complaints').filter((c) => inR(c.createdAt, from, to));
    const att = calls.filter((c) => ['Met', 'Breached'].includes(sla(c, 'attend')));
    const pays = db.all('payments').filter((p) => inR(p.receivedDate, from, to));
    const pmDue = db.all('pmVisits').filter((v) => inR(v.dueDate, from, today()));
    const tasks = db.all('projects').flatMap((p) => p.tasks || []).filter((t) => t.due && inR(t.due, from, today()));
    const ps = db.all('projects').filter((p) => p.status !== 'Cancelled' && (pActive(p) || inR(p.closedAt, from, to)));
    const pOn = ps.filter((p) => (pActive(p) ? !pDelayed(p) : (p.handoverAt || p.closedAt) && day0(parseD(p.handoverAt || p.closedAt)) <= (parseD(pTarget(p)) || today())));
    const ops = {
      Sales: ['Payments collected per policy', pct(pays.filter((p) => p.onTime).length, pays.length)],
      Projects: ['Projects on schedule', pct(pOn.length, ps.length)],
      Installation: ['Installation tasks on time', pct(tasks.filter((t) => t.doneAt && day0(parseD(t.doneAt)) <= parseD(t.due)).length, tasks.length)],
      Service: ['Attendance SLA', pct(att.filter((c) => sla(c, 'attend') === 'Met').length, att.length)],
      AMC: ['PM compliance', pct(pmDue.filter(pmOnTime).length, pmDue.length)],
    };
    const depts = Array.from(new Set(Object.keys(ops).concat(vs.map((v) => v.department || v.area).filter(Boolean))));
    return depts.map((d) => {
      const mine = vs.filter((v) => (v.department || v.area) === d);
      const inWin = mine.filter((v) => inR(vAt(v), from, to));
      const open = mine.filter(vOpen); const crit = open.filter((v) => v.severity === 'Critical');
      const closed = mine.filter((v) => v.closedAt && inR(v.closedAt, from, to));
      const onTime = pct(closed.filter((v) => !v.dueDate || day0(parseD(v.closedAt)) <= parseD(v.dueDate)).length, closed.length);
      const op = ops[d] || ['—', null];
      const base = op[1] == null ? (onTime == null ? 100 : onTime) : (onTime == null ? op[1] : 0.6 * op[1] + 0.4 * onTime);
      const penalty = Math.round((inWin.length * pen + crit.length * 3) * 10) / 10;
      return { dept: d, kpiLabel: op[0], kpi: op[1], viol: inWin.length, open: open.length, crit: crit.length, onTime, base: Math.round(base), penalty, score: Math.max(0, Math.min(100, Math.round(base - penalty))) };
    }).sort((a, b) => a.score - b.score);
  }

  const COORD_ROLES = ['sales_coordinator', 'es_coordinator', 'solar_coordinator', 'doc_coordinator', 'service_coordinator', 'pm_coordinator'];
  function coordinatorScores() {
    const wd = windowDays(); const from = addD(today(), -wd + 1); const to = addD(today(), 1);
    const pen = Number(cfg('exec.coordinatorPenalty', 2));
    const vs = db.all('violations');
    const kpiFor = (s) => {
      if (s.role === 'sales_coordinator') { const e = db.all('enquiries').filter((x) => inR(x.createdAt, from, to)); return ['Enquiries assigned within 2h', pct(e.filter((x) => x.assignedAt && (new Date(x.assignedAt) - new Date(x.createdAt)) <= 2 * 36e5).length, e.length)]; }
      if (s.role === 'es_coordinator' || s.role === 'solar_coordinator') { const ps = db.all('projects').filter((p) => p.coordinator === s.id && p.status !== 'Cancelled' && (pActive(p) || inR(p.closedAt, from, to))); return ['Projects on schedule', pct(ps.filter((p) => (pActive(p) ? !pDelayed(p) : day0(parseD(p.handoverAt || p.closedAt)) <= (parseD(pTarget(p)) || today()))).length, ps.length)]; }
      if (s.role === 'doc_coordinator') { const l = db.all('netMetering').concat(db.all('subsidies')).filter((x) => x.updatedAt); const stuck = l.filter((x) => !/Completed|Disbursed|Approved|Rejected|Not applicable/i.test(x.status || '') && (today() - day0(new Date(x.updatedAt))) / DAY > 15); return ['Applications moving (< 15 d idle)', pct(l.length - stuck.length, l.length)]; }
      if (s.role === 'service_coordinator') { const c = db.all('complaints').filter((x) => inR(x.createdAt, from, to) && (!x.coordinatorId || x.coordinatorId === s.id)).filter((x) => ['Met', 'Breached'].includes(sla(x, 'ack'))); return ['Acknowledgement SLA', pct(c.filter((x) => sla(x, 'ack') === 'Met').length, c.length)]; }
      if (s.role === 'pm_coordinator') { const d = db.all('pmVisits').filter((v) => inR(v.dueDate, from, today())); return ['PM compliance', pct(d.filter(pmOnTime).length, d.length)]; }
      return ['—', null];
    };
    return db.all('staff').filter((s) => s.active && COORD_ROLES.includes(s.role)).map((s) => {
      const mine = vs.filter((v) => v.ownerId === s.id || (!v.ownerId && v.ownerRole === s.role));
      const inWin = mine.filter((v) => inR(vAt(v), from, to)); const crit = mine.filter((v) => vOpen(v) && v.severity === 'Critical');
      const [lbl, k] = kpiFor(s); const base = k == null ? 100 : k;
      const penalty = Math.round((inWin.length * pen + crit.length * 3) * 10) / 10;
      return { id: s.id, name: s.name, role: roleName(s.role), kpiLabel: lbl, kpi: k, viol: inWin.length, open: mine.filter(vOpen).length, penalty, score: Math.max(0, Math.min(100, Math.round(base - penalty))) };
    }).sort((a, b) => a.score - b.score);
  }
  const scoreBadge = (n) => ui.badge(String(n), n >= 85 ? 'ok' : n >= 70 ? 'warn' : 'bad');

  function renderMgmtDash(el) {
    let div = 'All';
    const host = h('div');
    const sel = h('select', { class: 'btn', onChange: (e) => { div = e.target.value; draw(); } }, ['All'].concat(DIVS).map((d) => h('option', { value: d }, d === 'All' ? 'All divisions' : d)));
    ui.page(el, { title: 'Management Dashboard', sub: 'Projects (total · ongoing · delayed · completed · stage-wise), project risk, policy-violation dashboard and department / coordinator scores', actions: [sel, ui.btn('DRM / WRM / MRM', () => go('mgmt-reports')), ui.btn('Export PDF', () => exportPdf('Management Dashboard — ' + (div === 'All' ? 'All divisions' : div) + ' — ' + fmt.date(today()), host))] });
    el.appendChild(host);
    function draw() {
      host.innerHTML = '';
      const pc = projectCounts(div);
      const act = pc.list.filter(pActive);
      const risks = act.map((p) => Object.assign({ p }, projRisk(p))).sort((a, b) => b.pts - a.pts);
      const vs = db.all('violations').filter((v) => div === 'All' || !v.division || v.division === div);
      const vOpenL = vs.filter(vOpen);
      const ds = delayedStages(div);
      host.appendChild(ui.kpis([
        { label: 'Total projects', value: pc.total, meta: 'excl. cancelled', color: 'var(--chart-1)', onClick: canSee('projects') ? () => go('projects') : null },
        { label: 'Ongoing', value: pc.ongoing, color: 'var(--div-security)' },
        { label: 'Delayed', value: pc.delayed, meta: 'past committed date or stage overdue', color: 'var(--bad)' },
        { label: 'Completed', value: pc.completed, meta: pct(pc.completed, pc.total) == null ? '' : fmt.pct(pct(pc.completed, pc.total)) + ' of total', color: 'var(--ok)' },
        { label: 'High-risk projects', value: risks.filter((r) => r.level === 'High').length, meta: risks.filter((r) => r.level === 'Medium').length + ' medium', color: 'var(--chart-4)' },
        { label: 'Non-compliance (open)', value: vOpenL.length, meta: vOpenL.filter((v) => v.severity === 'Critical').length + ' critical', color: 'var(--warn)', onClick: canSee('violations') ? () => go('violations') : null },
      ]));

      // stage-wise progress
      const sumP = safe(() => CRM.projects && CRM.projects.summary(), null);
      const stageRows = div === 'All' && sumP && sumP.byStage ? sumP.byStage : (() => { const c = {}; act.forEach((p) => { const k = Object.keys(p.stages || {}).find((x) => !SDONE(p.stages[x])); const l = stageName(k); c[l] = (c[l] || 0) + 1; }); return Object.keys(c).map((l) => ({ label: l, value: c[l] })); })();
      host.appendChild(h('div', { class: 'grid g2' }, [
        ui.card('Stage-wise progress (active projects)', stageRows.length ? ui.barChart(stageRows.map((x) => ({ label: x.label, values: [x.value] })), [{ name: 'Projects', color: 'var(--div-security)' }]) : ui.empty('No active projects')),
        ui.card('Projects by division', ui.table({ search: false, rows: DIVS.filter((d) => div === 'All' || d === div).map((d) => Object.assign({ d }, projectCounts(d))), columns: [{ key: 'd', label: 'Division', render: (r) => ui.divTag(r.d) }, { key: 'total', label: 'Total', cls: 'right' }, { key: 'ongoing', label: 'Ongoing', cls: 'right' }, { key: 'delayed', label: 'Delayed', cls: 'right' }, { key: 'completed', label: 'Completed', cls: 'right' }, { key: 'highRisk', label: 'High risk', cls: 'right' }] }), { flush: true }),
      ]));

      // project risk register
      const riskCols = [{ key: 'id', label: 'Project', render: (r) => linkCell('projects', r.p.id), csv: (r) => r.p.id }, { key: 'division', label: 'Division', render: (r) => ui.divTag(r.p.division), csv: (r) => r.p.division }, { key: 'customer', label: 'Customer', render: (r) => (master.customer(r.p.customerId) || {}).name || r.p.customerId, csv: (r) => (master.customer(r.p.customerId) || {}).name || r.p.customerId }, { key: 'committed', label: 'Committed', render: (r) => fmt.date(pTarget(r.p)), csv: (r) => pTarget(r.p) || '' }, { key: 'progress', label: 'Stages done', render: (r) => r.progress + '%', csv: (r) => r.progress }, { key: 'level', label: 'Risk', render: (r) => ui.badge(r.level, RISK_TONE[r.level]) }, { key: 'reasons', label: 'Why', render: (r) => h('span', { class: 'small' }, r.reasons.join(' · ') || '—'), csv: (r) => r.reasons.join('; ') }, { key: 'owner', label: 'Coordinator', render: (r) => sName(r.p.coordinator), csv: (r) => sName(r.p.coordinator) }];
      host.appendChild(h('div', { class: 'mt' }, tableCard('Project risk level', risks, riskCols, { onRow: (r) => go('projects', r.p.id), csv: 'project-risk', filters: [{ key: 'level', label: 'risk levels', options: ['High', 'Medium', 'Low'] }], pageSize: 10, empty: 'No active projects' })));

      // policy violation dashboard
      host.appendChild(h('h2', { style: 'margin:22px 0 10px' }, 'Policy violation dashboard'));
      const eng = engineerDelays(); const ven = vendorDelays();
      host.appendChild(h('div', { class: 'grid g2' }, [
        tableCard('Delayed stages', ds, [{ key: 'project', label: 'Project', render: (r) => linkCell('projects', r.project) }, { key: 'stage', label: 'Stage' }, { key: 'due', label: 'Due', render: (r) => fmt.date(r.due) }, { key: 'days', label: 'Days late', cls: 'right' }, { key: 'owner', label: 'Coordinator' }], { onRow: (r) => go('projects', r.project), csv: 'delayed-stages', empty: 'No delayed stages' }),
        ui.card('Non-compliance by department (open / total)', ui.hbars(Object.entries(util.countBy(vs, (v) => v.department || v.area || 'Other')).sort((a, b) => b[1] - a[1]).map(([d, n]) => ({ label: d, value: vOpenL.filter((v) => (v.department || v.area || 'Other') === d).length, target: n, color: 'var(--bad)' })))),
        tableCard('Engineer delays', eng, [{ key: 'name', label: 'Engineer / owner' }, { key: 'role', label: 'Role' }, { key: 'calls', label: 'Calls past SLA', cls: 'right' }, { key: 'lateAttend', label: 'Late attendance (30d)', cls: 'right' }, { key: 'tasks', label: 'Tasks overdue', cls: 'right' }, { key: 'lateTasks', label: 'Tasks late (30d)', cls: 'right' }, { key: 'pm', label: 'PM overdue', cls: 'right' }, { key: 'viol', label: 'Open violations', cls: 'right' }], { csv: 'engineer-delays', empty: 'No engineer delays' }),
        tableCard('Vendor & supplier delays', ven, [{ key: 'vendor', label: 'Vendor / supplier' }, { key: 'project', label: 'Project' }, { key: 'task', label: 'Work' }, { key: 'due', label: 'Due', render: (r) => fmt.date(r.due) }, { key: 'status', label: 'Status', render: (r) => ui.badge(r.status, r.status === 'Completed late' ? 'warn' : 'bad') }, { key: 'days', label: 'Days', cls: 'right' }], { csv: 'vendor-delays', empty: 'No vendor delays' }),
      ]));

      // scores
      host.appendChild(h('h2', { style: 'margin:22px 0 10px' }, 'Department & coordinator scores'));
      host.appendChild(note('Score = operational KPI (and violation closure on time) − <b>' + esc(cfg('exec.violationPenalty', 1.5)) + '</b> per violation for departments / <b>' + esc(cfg('exec.coordinatorPenalty', 2)) + '</b> for coordinators in the last ' + windowDays() + ' days − 3 per open critical violation. Engineer scores are on Engineer Performance. Weights are editable in Settings &amp; Rules.', 'info'));
      host.appendChild(h('div', { class: 'grid g2 mt' }, [
        tableCard('Department performance score', deptScores(), [{ key: 'dept', label: 'Department' }, { key: 'kpi', label: 'Operational KPI', render: (r) => h('span', {}, [pctTxt(r.kpi), h('div', { class: 'small muted' }, r.kpiLabel)]), csv: (r) => (r.kpi == null ? '' : r.kpi) }, { key: 'viol', label: 'Violations', cls: 'right' }, { key: 'open', label: 'Open', cls: 'right' }, { key: 'onTime', label: 'Closed on time', render: (r) => pctTxt(r.onTime) }, { key: 'penalty', label: 'Penalty', cls: 'right', render: (r) => '−' + r.penalty }, { key: 'score', label: 'Score', render: (r) => scoreBadge(r.score) }], { csv: 'department-scores' }),
        tableCard('Coordinator score', coordinatorScores(), [{ key: 'name', label: 'Coordinator', render: (r) => h('span', {}, [r.name, h('div', { class: 'small muted' }, r.role)]), csv: (r) => r.name + ' (' + r.role + ')' }, { key: 'kpi', label: 'KPI', render: (r) => h('span', {}, [pctTxt(r.kpi), h('div', { class: 'small muted' }, r.kpiLabel)]), csv: (r) => (r.kpi == null ? '' : r.kpi) }, { key: 'viol', label: 'Violations', cls: 'right' }, { key: 'open', label: 'Open', cls: 'right' }, { key: 'penalty', label: 'Penalty', cls: 'right', render: (r) => '−' + r.penalty }, { key: 'score', label: 'Score', render: (r) => scoreBadge(r.score) }], { csv: 'coordinator-scores', empty: 'No coordinators' }),
      ]));
    }
    draw();
  }

  // ================================================================ Consolidated DRM / WRM / MRM
  const PERIODS = { DRM: 'Daily Management Report', WRM: 'Weekly Management Report', MRM: 'Monthly Management Report' };
  function enabledPeriods() { const l = Object.keys(PERIODS).filter((k) => safe(() => (CRM.config && CRM.config.reportEnabled ? CRM.config.reportEnabled('exec-' + k.toLowerCase()) : true), true)); return l.length ? l : ['DRM']; }
  function periodRange(per, ref) {
    const r = day0(ref); const to = addD(r, 1);
    if (per === 'DRM') return { from: r, to };
    if (per === 'WRM') return { from: addD(r, -6), to };
    return { from: new Date(r.getFullYear(), r.getMonth(), 1), to };
  }

  function buildReport(per, ref, div) {
    const { from, to } = periodRange(per, ref);
    const D = byDiv(div); const inP = (v) => inR(v, from, to);
    // sales & revenue
    const enq = db.all('enquiries').filter(D).filter((e) => inP(e.createdAt || e.date));
    const quotes = db.all('quotations').filter(D).filter((q) => inP(q.quoteDate));
    const won = approvedOrders().filter(D).filter((o) => inP(o.wonDate));
    const inv = db.all('invoices').filter(D).filter((i) => inP(i.invoiceDate));
    const pay = db.all('payments').filter(D).filter((p) => inP(p.receivedDate));
    const osList = db.all('invoices').filter(D).filter((i) => outstandingOf(i) > 0);
    const svcRev = sum(db.all('complaints').filter(D).filter((c) => c.chargeable && inP(c.closedAt)), 'charges');
    // targets (month of ref): exec-level targets summed per division
    const mk = ref.getFullYear() + '-' + String(ref.getMonth() + 1).padStart(2, '0');
    const mFrom = new Date(ref.getFullYear(), ref.getMonth(), 1); const mTo = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
    const tg = db.all('targets').filter((t) => t.month === mk && (t.scope || 'exec') === 'exec').filter(D);
    const execIds = Array.from(new Set(tg.map((t) => t.execId).filter(Boolean)));
    const monthWon = approvedOrders().filter(D).filter((o) => inR(o.wonDate, mFrom, mTo));
    const targetRows = execIds.map((id) => { const t = sum(tg.filter((x) => x.execId === id), 'revenue'); const a = sum(monthWon.filter((o) => o.execId === id), 'value'); return { exec: sName(id), target: t, achieved: a, pct: pct(a, t) }; });
    const targetTotal = sum(tg, 'revenue'); const achievedTotal = sum(monthWon, 'value');
    // projects
    const ps = db.all('projects').filter(D).filter((p) => p.status !== 'Cancelled');
    const act = ps.filter(pActive);
    const milestones = ps.reduce((n, p) => n + Object.keys(p.stages || {}).filter((k) => SDONE(p.stages[k]) && inP(p.stages[k].doneAt)).length, 0);
    const completed = ps.filter((p) => inP(p.closedAt));
    const planned = ps.filter((p) => inP(p.committedDate));
    const plannedDone = planned.filter((p) => p.status === 'Closed');
    const tasksDue = ps.flatMap((p) => (p.tasks || []).map((t) => Object.assign({ projectId: p.id }, t))).filter((t) => inP(t.due));
    const tasksDone = tasksDue.filter((t) => t.status === 'Completed');
    const discrep = db.all('dcs').filter((d) => d.status === 'Discrepancy' && (div === 'All' || ps.some((p) => p.id === d.projectId)));
    const risky = act.map((p) => ({ p, r: projRisk(p) })).filter((x) => x.r && x.r.level === 'High');
    // service & PM
    const calls = db.all('complaints').filter(D);
    const recv = calls.filter((c) => inP(c.createdAt)); const closed = calls.filter((c) => inP(c.closedAt));
    const attP = calls.filter((c) => inP(c.attendedAt)); const resP = calls.filter((c) => inP(c.resolvedAt));
    const attSla = pct(attP.filter((c) => sla(c, 'attend') === 'Met').length, attP.length);
    const resSla = pct(resP.filter((c) => sla(c, 'resolve') === 'Met').length, resP.length);
    const ackP = calls.filter((c) => inP(c.ackAt)); const ackSla = pct(ackP.filter((c) => sla(c, 'ack') === 'Met').length, ackP.length);
    const pmDue = db.all('pmVisits').filter(D).filter((v) => inP(v.dueDate)); const pmDone = db.all('pmVisits').filter(D).filter((v) => inP(v.completedDate));
    const pmComp = pct(pmDue.filter(pmOnTime).length, pmDue.filter((v) => v.completedDate || isPast(v.dueDate)).length);
    const fb = db.all('feedback').filter((f) => inP(f.createdAt) && (div === 'All' || (db.get('complaints', f.complaintId) || {}).division === div));
    const csat = fb.length ? Math.round((sum(fb, 'rating') / fb.length) * 10) / 10 : null;
    const repeat = recv.filter((c) => c.repeatOf).length;
    // governance
    const vs = db.all('violations').filter((v) => div === 'All' || !v.division || v.division === div);
    const vRaised = vs.filter((v) => inP(vAt(v))); const vClosed = vs.filter((v) => inP(v.closedAt));
    const esc2 = db.all('escalations').filter(D).filter((e) => inP(e.date || e.createdAt));
    const blockers = Object.entries(util.countBy(vRaised, 'title')).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8);

    // action-owner register (current state, as of report date)
    const actions = [];
    act.filter(pDelayed).forEach((p) => { const last = (p.dateRevisions || []).slice(-1)[0]; actions.push({ area: 'Project', ref: p.id, page: 'projects', item: 'Project delayed' + (lateStages(p).length ? ' — ' + lateStages(p).map(stageName).join(', ') : ''), owner: sName(p.coordinator), due: pTarget(p), days: daysLate(pTarget(p)), plan: last ? 'Revised to ' + fmt.date(last.to) + ' — ' + last.reason : (p.revisedDate ? 'Revised to ' + fmt.date(p.revisedDate) : 'Recovery plan required') }); });
    act.forEach((p) => lateTasks(p).forEach((t) => actions.push({ area: 'Installation task', ref: p.id, page: 'projects', item: t.title || t.kind || 'Task', owner: sName(t.assignee), due: t.due, days: daysLate(t.due), plan: '' })));
    calls.filter(svcOverdue).forEach((c) => actions.push({ area: 'Service call', ref: c.id, page: 'complaints', item: (c.category || 'Complaint') + ' · ' + ((master.customer(c.customerId) || {}).name || ''), owner: sName(c.engineerId || c.coordinatorId), due: c.commitAt || c.createdAt, days: daysLate(c.createdAt), plan: c.status || '' }));
    db.all('pmVisits').filter(D).filter(pmOverdue).forEach((v) => actions.push({ area: 'PM visit', ref: v.id, page: 'pm', item: 'PM overdue · ' + ((master.customer(v.customerId) || {}).name || v.customerId), owner: sName(v.engineerId), due: v.dueDate, days: daysLate(v.dueDate), plan: v.scheduledDate ? 'Scheduled ' + fmt.date(v.scheduledDate) : '' }));
    vs.filter((v) => vOpen(v) && v.dueDate && isPast(v.dueDate)).forEach((v) => actions.push({ area: 'Violation', ref: v.id, page: 'violations', item: v.title + (v.severity ? ' (' + v.severity + ')' : ''), owner: sName(v.ownerId) || v.ownerRole, due: v.dueDate, days: daysLate(v.dueDate), plan: v.correctiveAction || '' }));
    db.all('escalations').filter(D).filter((e) => e.status !== 'Resolved' && e.status !== 'Closed').forEach((e) => actions.push({ area: 'Escalation', ref: e.id, page: 'escalations', item: e.reason || 'Customer escalation', owner: sName(e.ownerId), due: e.date, days: daysLate(e.date), plan: e.resolution || '' }));
    osList.filter((i) => i.dueDate && isPast(i.dueDate)).forEach((i) => actions.push({ area: 'Collection', ref: i.id, page: 'invoices', item: 'Outstanding ' + fmt.lakh(outstandingOf(i)) + ' · ' + (i.accountName || ''), owner: sName(i.execId), due: i.dueDate, days: daysLate(i.dueDate), plan: '' }));
    actions.sort((a, b) => b.days - a.days);

    const kpis = [
      ['Sales', 'Enquiries received', enq.length], ['Sales', 'Quotations sent', quotes.length], ['Sales', 'Orders won (count)', won.length], ['Revenue', 'Orders won (value)', won.length ? sum(won, 'value') : 0, 'money'],
      ['Revenue', 'Invoiced', sum(inv, 'value'), 'money'], ['Revenue', 'Collected', sum(pay, 'value'), 'money'], ['Revenue', 'Service revenue (chargeable calls closed)', svcRev, 'money'], ['Revenue', 'Outstanding (as of today)', sum(osList, outstandingOf), 'money'],
      ['Targets', 'Monthly revenue target (' + monthLabel(mFrom) + ')', targetTotal, 'money'], ['Targets', 'Achieved month to date', achievedTotal, 'money'], ['Targets', 'Achievement %', pct(achievedTotal, targetTotal), 'pct'],
      ['Projects', 'Milestones completed', milestones], ['Projects', 'Projects completed', completed.length], ['Projects', 'Planned completions (committed in period)', planned.length], ['Projects', 'Planned completions achieved', plannedDone.length],
      ['Projects', 'Installation tasks due / done', tasksDue.length + ' / ' + tasksDone.length], ['Projects', 'Active projects', act.length], ['Projects', 'Delayed projects (now)', act.filter(pDelayed).length], ['Projects', 'High-risk projects (now)', risky.length], ['Projects', 'Open material issues (DC discrepancy)', discrep.length],
      ['Service', 'Calls received', recv.length], ['Service', 'Calls closed', closed.length], ['Service', 'Open calls (now)', calls.filter(svcOpen).length], ['Service', 'Calls past SLA (now)', calls.filter(svcOverdue).length], ['Service', 'Repeat complaints', repeat],
      ['SLA', 'Acknowledgement SLA', ackSla, 'pct'], ['SLA', 'Attendance SLA', attSla, 'pct'], ['SLA', 'Resolution SLA', resSla, 'pct'],
      ['PM', 'PM visits due', pmDue.length], ['PM', 'PM visits completed', pmDone.length], ['PM', 'PM compliance', pmComp, 'pct'], ['Quality', 'Customer satisfaction (avg of ' + fb.length + ')', csat == null ? null : csat + ' / 5'],
      ['Governance', 'Violations raised', vRaised.length], ['Governance', 'Violations closed', vClosed.length], ['Governance', 'Open critical violations (now)', vs.filter((v) => vOpen(v) && v.severity === 'Critical').length], ['Governance', 'Customer escalations', esc2.length],
    ].map(([area, metric, value, kind]) => ({ area, metric, value, display: value == null ? '—' : kind === 'money' ? fmt.lakh(value) : kind === 'pct' ? pctTxt(value) : String(value) }));

    return { per, from, to, div, kpis, targetRows, actions, blockers, risky, completed, enq, won, pay, recv, closed, attSla, resSla, pmComp, vRaised, milestones };
  }

  function renderMgmtReports(el) {
    let per = enabledPeriods()[0], div = 'All', ref = today();
    const host = h('div');
    const perSel = h('select', { class: 'btn', onChange: (e) => { per = e.target.value; draw(); } }, enabledPeriods().map((k) => h('option', { value: k }, k + ' — ' + PERIODS[k].replace(' Management Report', ''))));
    const divSel = h('select', { class: 'btn', onChange: (e) => { div = e.target.value; draw(); } }, ['All'].concat(DIVS).map((d) => h('option', { value: d }, d === 'All' ? 'All divisions' : d)));
    const dateIn = h('input', { type: 'date', class: 'btn', value: util.iso(today()), max: util.iso(today()), onChange: (e) => { const d = parseD(e.target.value); if (d) { ref = d; draw(); } } });
    let cur = null;
    const csvBtn = ui.btn('Export CSV', () => { if (!cur) return; const name = cur.per + '-' + (div === 'All' ? 'all' : div.replace(/\s+/g, '-').toLowerCase()) + '-' + util.iso(ref); exportCsv(name + '-summary', cur.kpis, [{ key: 'area', label: 'Area' }, { key: 'metric', label: 'Metric' }, { key: 'display', label: 'Value' }]); exportCsv(name + '-actions', cur.actions, ACTION_COLS); }, 'sm');
    const pdfBtn = ui.btn('Export PDF', () => cur && exportPdf(PERIODS[cur.per] + ' (' + cur.per + ') — ' + (div === 'All' ? 'All divisions' : div) + ' — ' + fmt.date(ref), host), 'sm');
    const sendBtn = ui.btn('Send to management', () => dispatch(), 'sm primary');
    ui.page(el, { title: 'Management Reports — DRM / WRM / MRM', sub: 'Consolidated daily, weekly and monthly management reports across Sales, Projects, Service & PM: progress, pending work, SLA compliance, revenue, targets, quality, escalations and action owners', actions: [perSel, divSel, dateIn, csvBtn, pdfBtn, sendBtn] });
    el.appendChild(host);

    function dispatch() {
      if (!cur) return;
      const to = [].concat(cfg('exec.reportRecipients', ['gm', 'odm']));
      const ch = safe(() => (CRM.config && CRM.config.channelsFor ? CRM.config.channelsFor('mgmt.report') : null), null) || { inapp: true, email: true };
      const channel = ['In-app'].concat(ch.email ? ['Email (simulated)'] : [], ch.whatsapp ? ['WhatsApp (simulated)'] : []).join(' · ');
      const payload = { report: cur.per, period: PERIODS[cur.per], from: util.iso(cur.from), to: util.iso(addD(cur.to, -1)), division: div, channel, recipients: to, summary: cur.kpis.map((k) => ({ metric: k.metric, value: k.display })) };
      safe(() => CRM.emit('report.dispatch', payload), null);
      safe(() => CRM.notify({ to, title: cur.per + ' ' + fmt.date(ref) + ' — ' + (div === 'All' ? 'all divisions' : div), body: cur.actions.length + ' open actions · ' + cur.kpis.filter((k) => ['Orders won (value)', 'Attendance SLA', 'Projects completed'].includes(k.metric)).map((k) => k.metric + ' ' + k.display).join(' · '), link: '#/mgmt-reports', severity: 'info', event: 'mgmt.report', key: 'report:' + cur.per + ':' + div + ':' + util.iso(ref) }), null);
      ui.toast(cur.per + ' queued to ' + to.join(', ') + ' via ' + channel + ' — integration hook, no message actually sent', 'ok');
    }

    function draw() {
      host.innerHTML = '';
      const r = buildReport(per, ref, div); cur = r;
      const lastDay = addD(r.to, -1);
      const scope = { DRM: 'daily progress, pending work, material issues, service calls, escalations and action owners', WRM: 'weekly milestone & installation progress, SLA compliance, planned vs actual, delays, recovery plans and recurring blockers', MRM: 'monthly objectives & targets, project completion, revenue-linked status, service performance, PM and quality' }[per];
      host.appendChild(note('<b>' + esc(PERIODS[per]) + ' (' + per + ')</b> · ' + esc(div === 'All' ? 'All divisions' : div) + ' · ' + esc(fmt.date(r.from)) + (per === 'DRM' ? '' : ' – ' + esc(fmt.date(lastDay))) + ' · covers ' + esc(scope) + '.', 'info'));
      const pick = (m) => (r.kpis.find((k) => k.metric === m) || {}).display;
      host.appendChild(h('div', { class: 'mt' }, ui.kpis([
        { label: 'Enquiries', value: r.enq.length, meta: pick('Quotations sent') + ' quotations sent', color: 'var(--chart-1)' },
        { label: 'Orders won', value: pick('Orders won (value)'), meta: r.won.length + ' orders', color: 'var(--ok)' },
        { label: 'Collected', value: pick('Collected'), meta: 'Outstanding ' + pick('Outstanding (as of today)'), color: 'var(--chart-2)' },
        { label: 'Projects completed', value: r.completed.length, meta: r.milestones + ' milestones · ' + pick('Delayed projects (now)') + ' delayed', color: 'var(--div-security)' },
        { label: 'Service calls', value: r.recv.length + ' / ' + r.closed.length, meta: 'received / closed · ' + pick('Calls past SLA (now)') + ' past SLA', color: 'var(--chart-4)' },
        { label: 'Attendance SLA', value: pctTxt(r.attSla), meta: 'Resolution ' + pctTxt(r.resSla) + ' · PM ' + pctTxt(r.pmComp), color: 'var(--chart-5)' },
        { label: 'Violations raised', value: r.vRaised.length, meta: pick('Open critical violations (now)') + ' critical open', color: 'var(--bad)' },
      ])));

      const areas = Array.from(new Set(r.kpis.map((k) => k.area)));
      const grid = h('div', { class: 'grid g3' });
      areas.forEach((a) => grid.appendChild(ui.card(a, ui.dl(r.kpis.filter((k) => k.area === a).map((k) => [k.metric, k.display])))));
      host.appendChild(grid);

      const second = h('div', { class: 'grid g2 mt' });
      if (per === 'MRM' || r.targetRows.length) second.appendChild(tableCard('Monthly targets vs achieved — ' + monthLabel(new Date(ref.getFullYear(), ref.getMonth(), 1)), r.targetRows, [{ key: 'exec', label: 'Executive' }, { key: 'target', label: 'Target', cls: 'right', render: (x) => fmt.lakh(x.target) }, { key: 'achieved', label: 'Achieved', cls: 'right', render: (x) => fmt.lakh(x.achieved) }, { key: 'pct', label: 'Achievement', render: (x) => (x.pct == null ? '—' : ui.badge(fmt.pct(x.pct), x.pct >= 100 ? 'ok' : x.pct >= 70 ? 'warn' : 'bad')), csv: (x) => x.pct }], { empty: 'No targets set for this month', csv: 'targets-' + util.iso(ref).slice(0, 7) }));
      if (per !== 'DRM') second.appendChild(ui.card('Recurring blockers (rule raised ≥ 2× in period)', r.blockers.length ? ui.hbars(r.blockers.map(([t, n]) => ({ label: t, value: n, color: 'var(--bad)' }))) : ui.empty('No recurring blockers', '✅')));
      second.appendChild(tableCard('High-risk projects', r.risky, [{ key: 'id', label: 'Project', render: (x) => linkCell('projects', x.p.id), csv: (x) => x.p.id }, { key: 'cust', label: 'Customer', render: (x) => (master.customer(x.p.customerId) || {}).name || x.p.customerId, csv: (x) => (master.customer(x.p.customerId) || {}).name }, { key: 'why', label: 'Why', render: (x) => h('span', { class: 'small' }, x.r.reasons.join(' · ')), csv: (x) => x.r.reasons.join('; ') }], { onRow: (x) => go('projects', x.p.id), empty: 'No high-risk projects' }));
      if (second.childNodes.length) host.appendChild(second);

      host.appendChild(h('div', { class: 'mt' }, tableCard('Action register — pending work & owners (' + r.actions.length + ')', r.actions, ACTION_COLS, { onRow: (x) => go(x.page, x.ref), search: true, pageSize: 15, filters: [{ key: 'area', label: 'areas', options: Array.from(new Set(r.actions.map((x) => x.area))) }], csv: 'action-register-' + util.iso(ref), empty: 'No pending actions' })));
    }
    draw();
  }
  const ACTION_COLS = [
    { key: 'area', label: 'Area' },
    { key: 'ref', label: 'Ref', render: (x) => linkCell(x.page, x.ref) },
    { key: 'item', label: 'Pending item' },
    { key: 'owner', label: 'Action owner' },
    { key: 'due', label: 'Due', render: (x) => fmt.date(x.due), csv: (x) => (x.due ? util.iso(parseD(x.due)) : '') },
    { key: 'days', label: 'Days late', cls: 'right', render: (x) => (x.days ? ui.badge(x.days + ' d', x.days > 7 ? 'bad' : 'warn') : '—'), csv: (x) => x.days },
    { key: 'plan', label: 'Recovery plan / note', render: (x) => h('span', { class: 'small' }, x.plan || '—') },
  ];

  if (typeof CRM.registerNotifyEvent === 'function') safe(() => CRM.registerNotifyEvent({ id: 'mgmt.report', label: 'Management reports (DRM / WRM / MRM)', defaults: { inapp: true, email: true, whatsapp: false } }), null);
  if (typeof CRM.registerReport === 'function') Object.keys(PERIODS).forEach((k) => safe(() => CRM.registerReport({ id: 'exec-' + k.toLowerCase(), title: PERIODS[k] + ' (' + k + ')', group: 'Management' }), null));
  CRM.registerPage({ id: 'mgmt-dash', title: 'Management Dashboard', icon: '◫', section: 'Management', order: 5, roles: MG, render: renderMgmtDash });
  CRM.registerPage({ id: 'mgmt-reports', title: 'DRM / WRM / MRM Reports', icon: '🗠', section: 'Management', order: 6, roles: MG, render: renderMgmtReports });

  // ---------------------------------------------------------------- Settings & Rules section (Core API v2, optional)
  if (typeof CRM.registerConfigSection === 'function') {
    safe(() => CRM.registerConfigSection({
      id: 'exec-mgmt', title: 'Management reports & scores', roles: ['admin', 'gm'], order: 80,
      render(c) {
        const fields = [
          ['exec.violationPenalty', 'Department score — penalty per violation', 1.5],
          ['exec.coordinatorPenalty', 'Coordinator score — penalty per violation', 2],
          ['exec.scoreWindowDays', 'Score window (days)', 90],
          ['exec.riskDays', 'Project risk — days before committed date to flag low progress', 7],
        ];
        const inputs = {};
        c.appendChild(h('div', { class: 'grid g2' }, fields.map(([k, l, d]) => h('label', { class: 'stack', style: 'gap:4px' }, [h('span', { class: 'small muted' }, l), (inputs[k] = h('input', { type: 'number', step: 'any', min: '0', value: String(cfg(k, d)) }))]))));
        const rec = h('input', { value: [].concat(cfg('exec.reportRecipients', ['gm', 'odm'])).join(', ') });
        c.appendChild(h('label', { class: 'stack mt', style: 'gap:4px' }, [h('span', { class: 'small muted' }, 'DRM/WRM/MRM recipients (role ids, comma separated) — delivered in-app; e-mail/WhatsApp via the report.dispatch hook (simulated)'), rec]));
        c.appendChild(h('div', { class: 'row mt' }, ui.btn('Save', () => {
          fields.forEach(([k, , d]) => { const n = Number(inputs[k].value); CRM.config.set(k, isFinite(n) && n >= 0 ? n : d, 'Management settings: ' + k); });
          const roles = rec.value.split(',').map((s) => s.trim()).filter((s) => CRM.roles.some((x) => x.id === s));
          CRM.config.set('exec.reportRecipients', roles.length ? roles : ['gm', 'odm'], 'Management report recipients');
          ui.toast('Management settings saved', 'ok');
        }, 'primary')));
      },
    }), null);
  }

  // ---------------------------------------------------------------- Role design guide (Help)
  CRM.registerPage({
    id: 'roleguide', title: 'Role Design Guide', icon: '🧭', section: 'Help', order: 99, roles: CRM.ALL.filter((r) => r !== 'vendor'),
    render(el) {
      const mgmt = CRM.is(MG);
      ui.page(el, { title: 'Role Design Guide', sub: 'How each user role is designed, derived from the Sales, Electronic Security, Solar and Service requirement documents.' + (mgmt ? ' Management can preview any role with the role switcher (a client-side demo preview — access is not enforced server-side).' : '') });
      const groups = util.groupBy(CRM.roles, 'group');
      Object.keys(groups).forEach((g) => {
        el.appendChild(h('h2', { style: 'margin:18px 0 10px' }, g));
        el.appendChild(h('div', { class: 'grid g3' }, groups[g].map((r) => {
          const d = ROLE_DESIGN[r.id] || {};
          return h('div', { class: 'card card-body stack', style: 'gap:8px' }, [
            h('div', { class: 'row' }, [h('span', { class: 'avatar', style: 'background:' + r.color }, util.initials(r.user)), h('div', {}, [h('h3', {}, r.name), h('div', { class: 'small muted' }, 'Demo user: ' + r.user)])]),
            h('div', {}, d.purpose || ''),
            h('div', { class: 'small' }, [h('b', {}, 'Sees: '), d.sees || '']),
            h('div', { class: 'row' }, (d.kpis || []).map((k) => ui.badge(k, 'brand'))),
            h('div', { class: 'small muted' }, 'Source: ' + (d.source || '—')),
            mgmt ? ui.btn('Preview this role →', () => { const s = document.getElementById('roleSelect'); if (s) { s.value = r.id; s.dispatchEvent(new Event('change')); } }, 'sm') : null,
          ]);
        })));
      });
    },
  });
})();
