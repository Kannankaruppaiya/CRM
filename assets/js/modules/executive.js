/* Executive module — GM/CEO and Admin cockpits plus the Role Design Guide.
 * Reads the summaries exposed by the sales, projects and service modules.
 */
(function () {
  'use strict';
  const { db, ui, h, util, fmt, master } = CRM;

  const safe = (fn, fallback) => { try { return fn() || fallback; } catch (e) { console.error(e); return fallback; } };
  const DIV_COLORS = { Power: 'var(--div-power)', 'Electronic Security': 'var(--div-security)', Solar: 'var(--div-solar)' };

  // ---------------------------------------------------------------- role design research
  // Each entry summarises what the requirement documents ask of the role and how the CRM serves it.
  const ROLE_DESIGN = {
    gm: { purpose: 'Management oversight across all three divisions and authorized approvals.', sees: 'Executive cockpit: revenue, pipeline, projects, service SLA, collections, policy violations.', kpis: ['Sales by division', 'Target vs achieved', 'Outstanding', 'SLA compliance', 'Open violations'], source: 'Sales §9, ES §9/§10.1, Service management dashboards' },
    admin: { purpose: 'Users, master data, workflow rules and access configuration.', sees: 'Users & access matrix, master data, audit log, import/export.', kpis: ['Active users', 'Audit events', 'Data volumes'], source: 'Sales §3, ES §9, Solar §8' },
    odm: { purpose: 'Cross-functional pending tasks, policy compliance and escalations.', sees: 'ODM cockpit: violations by rule/owner, escalation ladder, customer-risk view.', kpis: ['Open violations', 'Repeat offenders', 'Escalations closed on time'], source: 'Service doc — Policy violation & escalation matrix, ES §10.4' },
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
    pm_coordinator: { purpose: 'PM schedule, AMC renewals, overdue visits and reporting.', sees: 'PM due list, AMC expiring, warranty→AMC conversion funnel.', kpis: ['PM compliance %', 'AMC renewals', 'Conversion %'], source: 'Service doc — AMC & PM, ES §7, Solar §6' },
  };

  // ---------------------------------------------------------------- GM / CEO cockpit
  function gmHome(el) {
    const s = safe(() => CRM.sales && CRM.sales.summary(), null);
    const p = safe(() => CRM.projects && CRM.projects.summary(), null);
    const v = safe(() => CRM.service && CRM.service.summary(), null);
    el.appendChild(ui.hero(CRM.role(), ['3 divisions', 'FY 2026–27', 'Live data']));

    el.appendChild(ui.kpis([
      { label: 'Pipeline value', value: s ? fmt.lakh(s.pipelineValue) : '—', meta: s ? s.enquiries + ' enquiries' : '', color: 'var(--chart-1)', onClick: () => CRM.canSee('pipeline') && CRM.go('pipeline') },
      { label: 'Orders won', value: s ? fmt.lakh(s.wonValue) : '—', meta: s ? s.wonCount + ' orders' : '', color: 'var(--ok)' },
      { label: 'Outstanding', value: s ? fmt.lakh(s.outstanding) : '—', meta: s ? 'Collected this month ' + fmt.lakh(s.collectedThisMonth) : '', color: 'var(--warn)' },
      { label: 'Active projects', value: p ? p.active : '—', meta: p ? p.overdue + ' overdue · ' + p.materialShort + ' material short' : '', color: 'var(--div-security)' },
      { label: 'Open service calls', value: v ? v.openCalls : '—', meta: v ? v.overdueCalls + ' overdue' : '', color: 'var(--chart-4)' },
      { label: 'Attendance SLA', value: v ? fmt.pct(v.attendanceSla) : '—', meta: v ? 'Resolution SLA ' + fmt.pct(v.resolutionSla) : '', color: 'var(--chart-5)' },
      { label: 'Open violations', value: v ? v.openViolations : '—', meta: 'Policy compliance', color: 'var(--bad)', onClick: () => CRM.canSee('violations') && CRM.go('violations') },
    ]));

    const grid = h('div', { class: 'grid g2' });
    if (s && s.monthly) grid.appendChild(ui.card('Sales trend (orders won)', ui.lineChart(s.monthly.map((m) => m.label), [{ name: 'Won value', color: 'var(--chart-1)', values: s.monthly.map((m) => m.value) }], { money: true, area: true })));
    if (s && s.byDivision) grid.appendChild(ui.card('Sales by division', ui.donut(Object.keys(s.byDivision).map((k) => ({ label: k, value: s.byDivision[k] || 0, color: DIV_COLORS[k] })), { money: true, label: 'Won value' })));
    if (p && p.byStage) grid.appendChild(ui.card('Projects by stage', ui.barChart(p.byStage.map((x) => ({ label: x.label, values: [x.value] })), [{ name: 'Projects', color: 'var(--div-security)' }])));
    if (v && v.byDivision) grid.appendChild(ui.card('Open service calls by division', ui.hbars(Object.keys(v.byDivision).map((k) => ({ label: k, value: Number(v.byDivision[k]) || 0, color: DIV_COLORS[k] })))));
    if (v) grid.appendChild(ui.card('Service & PM health', ui.dl([['Attendance SLA', fmt.pct(v.attendanceSla)], ['Resolution SLA', fmt.pct(v.resolutionSla)], ['Repeat complaints', fmt.pct(v.repeatPct)], ['PM due / overdue', v.pmDue + ' / ' + v.pmOverdue], ['AMC expiring (60d)', v.amcExpiring], ['Open violations', v.openViolations]])));
    if (p) grid.appendChild(ui.card('Project execution health', ui.dl([['Large ES projects', p.large], ['Small ES jobs', p.small], ['Solar projects', p.solar], ['Overdue milestones', p.overdue], ['Material shortage', p.materialShort], ['Handover pending', p.handoverPending]])));
    el.appendChild(grid);
    el.appendChild(h('div', { class: 'mt' }, alertsCard()));
  }

  function alertsCard() {
    const list = db.all('notifications').filter((n) => n.severity === 'bad' || n.severity === 'warn').slice(-12).reverse();
    return ui.card('Latest escalations & alerts', list.length ? ui.timeline(list.map((n) => ({ when: fmt.dateTime(n.createdAt) + ' · to ' + n.to.map((r) => (CRM.role(r) || {}).name || r).join(', '), title: n.title, body: n.body, color: n.severity === 'bad' ? 'var(--bad)' : 'var(--warn)' }))) : ui.empty('No escalations', '✅'));
  }

  // ---------------------------------------------------------------- Admin console
  function adminHome(el) {
    el.appendChild(ui.hero(CRM.role(), ['System administration']));
    const staff = db.all('staff');
    const audit = (CRM.db.export().audit || []);
    const cols = ['customers', 'enquiries', 'quotations', 'orders', 'projects', 'complaints', 'assets', 'amcContracts', 'pmPlans', 'violations', 'stock', 'notifications'];
    el.appendChild(ui.kpis([
      { label: 'Active users', value: staff.filter((s) => s.active).length, meta: CRM.roles.length + ' roles', onClick: () => CRM.go('users') },
      { label: 'Customers', value: db.all('customers').length, onClick: () => CRM.go('customer360') },
      { label: 'Audit events', value: audit.length, onClick: () => CRM.go('audit') },
      { label: 'Notifications', value: db.all('notifications').length },
    ]));
    el.appendChild(h('div', { class: 'grid g2' }, [
      ui.card('Records per collection', ui.hbars(cols.map((c) => ({ label: c, value: db.all(c).length, color: 'var(--chart-1)' })))),
      ui.card('Users per role', ui.hbars(CRM.roles.map((r) => ({ label: r.name, value: staff.filter((s) => s.role === r.id).length, color: r.color })))),
    ]));
    el.appendChild(h('div', { class: 'mt' }, ui.card('Quick links', h('div', { class: 'row' }, [ui.btn('Users & access', () => CRM.go('users'), 'primary'), ui.btn('Master data', () => CRM.go('masters')), ui.btn('Audit log', () => CRM.go('audit')), ui.btn('Role design guide', () => CRM.go('roleguide'))]))));
  }

  CRM.registerHome('gm', gmHome);
  CRM.registerHome('admin', adminHome);

  // ---------------------------------------------------------------- Role design guide
  CRM.registerPage({
    id: 'roleguide', title: 'Role Design Guide', icon: '🧭', section: 'Administration', order: 98, roles: CRM.ALL.filter((r) => r !== 'vendor'),
    render(el) {
      ui.page(el, { title: 'Role Design Guide', sub: 'How each user role is designed, derived from the Sales, Electronic Security, Solar and Service requirement documents. Use the role switcher (top-right) to experience each one.' });
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
            ui.btn('Switch to this role →', () => { const s = document.getElementById('roleSelect'); s.value = r.id; s.dispatchEvent(new Event('change')); }, 'sm'),
          ]);
        })));
      });
    },
  });
})();
