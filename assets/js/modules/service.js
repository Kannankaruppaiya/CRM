/* Service, AMC, Preventive Maintenance & Governance (ODM) module — Maruthi Power Control Systems CRM.
 * Sources: Service_requirement (complaints, OTS, AMC, PM, division call types, policy violation & escalation),
 * Electronic_security §6–8, §10.3–13 and Solar §5–6, §9–12.
 * Owns: assets, complaints (incl. the installation record), amcContracts, amcOpportunities, pmPlans, pmVisits, violations, escalations,
 *       feedback, spareRequests, ots, serviceConfig. Reads (never writes): enquiries, quotations, orders, invoices, payments, projects,
 *       grns, dcs, stock. Scrap: requested via 'scrap.create.requested' (fallback insert with the projects schema if nobody handles it).
 * Emits: ots.created, complaint.chargeable (once per amount), project.installation.requested {complaint},
 *        installation.updated / installation.completed {orderId, complaintId, ...}, stock.issue.requested / stock.return.requested /
 *        stock.consumed {productId, stockId, qty, toEngineer, complaintId, spareRequestId}, service.centre.stage {complaintId, grnId, stageName, grnStatus},
 *        customer.message {channel, customerId, to, template, text} (simulated Email/WhatsApp hook).
 * Listens: violation.raise, project.handover, order.won, ots.converted {otsId, enquiryId}, ots.outcome, grns:updated.
 */
(function () {
  'use strict';
  const { db, ui, h, util, fmt, master } = CRM;
  const HR = 36e5;
  const DIVS = ['Power', 'Electronic Security', 'Solar'];
  const MG = ['admin', 'gm', 'odm'];
  const DIV_COLOR = { Power: 'var(--div-power)', 'Electronic Security': 'var(--div-security)', Solar: 'var(--div-solar)' };

  // ================================================================ masters (from the documents)
  const SOURCES = ['CUG Number', 'Landline', 'Phone', 'WhatsApp', 'Email', 'Website', 'Walk-in', 'Sales Executive', 'Service Engineer', 'Customer Visit', 'Monitoring Alert', 'PM Visit'];
  const SERVICE_TYPES = ['On-call', 'AMC', 'Warranty', 'Complimentary'];
  // Call types reconcile Service doc §2.2 (Breakdown / Installation / PM / Inspection) with the §9 master (Service / Installation / PM / Pre-sale):
  // "Service" is the breakdown call (shown as "Service / Breakdown"), Inspection is added as its own type.
  const ES_CALLS = ['Service', 'Installation', 'Project Installation', 'Preventive Maintenance (PM)', 'Inspection', 'Pre-Sale Support'];
  const CALL_TYPES = { Power: ['Service', 'Installation', 'Preventive Maintenance (PM)', 'Inspection', 'Pre-Sale Support'], 'Electronic Security': ES_CALLS, Solar: ES_CALLS };
  const ALL_CALL_TYPES = ['Service', 'Breakdown'].concat(ES_CALLS.slice(1));
  const callTypeLabel = (v) => (v === 'Service' || v === 'Breakdown' ? 'Service / Breakdown' : v);
  const callTypeOpts = (d) => (CALL_TYPES[d] || CALL_TYPES.Power).map((v) => ({ value: v, label: callTypeLabel(v) }));
  const isBreakdown = (c) => ['Service', 'Breakdown'].includes(c.callType) && c.category !== 'Preventive maintenance finding';
  const PRIORITIES = ['Critical', 'High', 'Low'];
  const CATEGORIES = {
    Power: ['UPS not working', 'Inverter not working', 'Low battery backup', 'Battery issue (SF/Exide)', 'Stabilizer fault', 'Output voltage fluctuation', 'Overload / tripping', 'Burning smell / sparking', 'Noise / heating', 'Display / alarm issue', 'Installation support', 'Preventive maintenance finding', 'Other technical complaint'],
    'Electronic Security': ['Camera not working', 'No video / poor image quality', 'DVR/NVR not working', 'Recording failure or missing playback', 'Hard disk failure', 'Network / IP connectivity problem', 'Remote viewing failure', 'Power supply / UPS issue', 'Camera cable or connector issue', 'Biometric device issue', 'Access control failure', 'Video door phone issue', 'PA system fault', 'Fire alarm fault', 'Configuration or user access issue', 'Preventive maintenance finding', 'Other technical complaint'],
    Solar: ['Generation below expected level', 'Inverter fault / shutdown', 'Module damage', 'DC/AC wiring issue', 'Earthing / electrical protection issue', 'Monitoring or communication failure', 'Net-metering / grid-related issue', 'Water ingress or mounting structure issue', 'Battery / hybrid system issue', 'Preventive maintenance finding', 'Other technical complaint'],
  };
  const SAFETY_CATS = ['Fire alarm fault', 'Burning smell / sparking', 'Earthing / electrical protection issue'];
  const SYSTEM_TYPES = { Power: ['UPS', 'Inverter', 'Servo Stabilizer', 'Battery'], 'Electronic Security': ['CCTV', 'Access Control', 'Biometric', 'PA System', 'Video Door Phone', 'Fire Alarm', 'Other'], Solar: ['On-grid', 'Hybrid'] };
  const OPEN_SUBS = ['Product shifted to Service Centre', 'Observation Required (TRC)', 'Battery issue – SF/Exide coordination', 'Waiting for spares', 'Waiting for customer', 'Supplier warranty claim (OEM)', 'Waiting for vendor'];
  const SUB_SUPPLIER = OPEN_SUBS[5];
  // SLA clocks pause while the call waits on the customer, spares or a vendor/supplier (Service doc §5, ES §12)
  const PAUSE_SUBS = ['Waiting for spares', 'Waiting for customer', 'Battery issue – SF/Exide coordination', SUB_SUPPLIER, 'Waiting for vendor'];
  const isPauseSub = (s) => PAUSE_SUBS.includes(s);
  const VENDOR_BRANDS = { Power: ['SF', 'Exide', 'Amaron', 'Others'], 'Electronic Security': ['Hikvision', 'CP Plus', 'Dahua', 'Honeywell', 'Others'], Solar: ['Waaree (modules)', 'Adani (modules)', 'Growatt (inverter)', 'Sungrow (inverter)', 'Others'] };
  const ROOT_CAUSES = ['Equipment fault', 'Shading', 'Grid', 'Weather', 'Customer-side', 'Installation workmanship', 'Other'];
  const STEPS = ['Registered', 'Acknowledgement', 'Priority & warranty/AMC validation', 'Remote diagnosis / engineer assignment', 'Customer commitment', 'Attendance & diagnosis', 'Spare approval / issue', 'Repair & functional testing', 'Service report & customer confirmation', 'Authorized closure & feedback'];
  const TEST_CHECKS = {
    Power: ['Input / output voltage verified', 'Battery backup tested on load', 'Load test performed', 'Charging current checked', 'Alarms & display functional', 'Earthing verified'],
    'Electronic Security': ['Live view verified on all affected cameras/devices', 'Recording & playback verified', 'Remote viewing verified (if in scope)', 'Device power supply stable', 'Functional test of access / biometric / alarm / PA', 'Date-time sync verified'],
    Solar: ['Inverter fault cleared & restarted', 'Generation reading recorded', 'DC string voltage checked', 'AC output & grid sync verified', 'Earthing & protection verified', 'Monitoring communication restored'],
  };
  const SC_STAGES = { free: ['Inward (GRN)', 'Processing', 'Testing', 'Repair', 'Delivered'], paid: ['Inward (GRN)', 'Processing', 'Testing', 'Quotation', 'Customer approval', 'Repair', 'Delivered', 'Payment received'] };
  const VENDOR_STAGES = ['Raised', 'Under review', 'Replacement approved', 'Replaced / serviced', 'Closed'];
  const OTS_STATUS = ['Open', 'In Progress', 'Quotation Sent', 'Negotiation', 'Won', 'Lost'];
  const OPP_STATUS = ['Open', 'Under Follow-up', 'Quotation Sent', 'Negotiation', 'Won', 'Lost'];
  const PM_FLOW = ['PM Due', 'Visit Planned', 'Customer Confirmation', 'Engineer Assigned', 'Visit Completed', 'Checklist Submitted', 'Findings Recorded', 'Corrective Action Created', 'Report Approved', 'Next PM Scheduled'];
  const EQ_TYPES = ['CCTV', 'Access Control', 'Biometric', 'PA System', 'Video Door Phone', 'Fire Alarm', 'UPS', 'Inverter', 'Servo Stabilizer', 'Battery', 'Solar'];
  const eqTypeOf = (cat) => ({ 'Online UPS': 'UPS', Inverter: 'Inverter', 'Servo Stabilizer': 'Servo Stabilizer', Battery: 'Battery', CCTV: 'CCTV', Biometric: 'Biometric', 'Access Control': 'Access Control', 'Video Door Phone': 'Video Door Phone', 'PA System': 'PA System', 'Fire Alarm': 'Fire Alarm', 'On-grid': 'Solar', Hybrid: 'Solar', Components: 'Solar' }[cat] || 'UPS');
  function eqTypeFor(cat, division, name) {
    const known = eqTypeOf(cat); if (known !== 'UPS' || /UPS/i.test(cat || '')) return known;
    const t = (cat || '') + ' ' + (name || '');
    if (division === 'Solar') return 'Solar';
    if (division === 'Power') return /inverter/i.test(t) ? 'Inverter' : /batter/i.test(t) ? 'Battery' : /stabil/i.test(t) ? 'Servo Stabilizer' : 'UPS';
    return /bio/i.test(t) ? 'Biometric' : /access/i.test(t) ? 'Access Control' : /fire|smoke|detector/i.test(t) ? 'Fire Alarm' : /\bPA\b|amplifier|speaker/i.test(t) ? 'PA System' : /door/i.test(t) ? 'Video Door Phone' : 'CCTV';
  }
  const REC = ['Record defects, photographs and corrective actions', 'Submit PM report and customer acknowledgement'];
  const PWR = ['Cleaning done', 'Voltage check (input / output)', 'Battery check', 'Load test', 'General inspection', 'Remarks recorded'];
  const DEFAULT_CHECKLISTS = {
    CCTV: ['Inspect camera housings, mounting and physical condition', 'Check camera image quality, focus and viewing angle', 'Check night vision / IR operation where applicable', 'Inspect visible cable routes, connectors and terminations', 'Verify DVR/NVR health and recording status', 'Check hard disk health and available recording capacity', 'Verify playback for selected cameras', 'Check date/time and recording schedules', 'Verify network connectivity and remote viewing if included', 'Inspect power supplies, UPS and related protection', 'Review device faults and available logs'].concat(REC),
    'Access Control': ['Inspect controller, enclosure and tamper switch', 'Test card / PIN readers at each door', 'Verify EM lock, door sensor and door-release operation', 'Check exit switch and emergency break-glass', 'Verify power supply and battery backup', 'Review access logs and time sync', 'Verify user database and access rights', 'Inspect cabling and terminations'].concat(REC),
    Biometric: ['Clean fingerprint sensor / face camera', 'Test enrolment and verification', 'Check date/time and attendance log download', 'Verify network / USB connectivity', 'Check power adapter and backup', 'Inspect mounting and enclosure'].concat(REC),
    'PA System': ['Check amplifier output and ventilation', 'Test every zone and speaker', 'Check microphone and paging console', 'Verify emergency / pre-recorded announcements', 'Inspect speaker cabling and line voltage', 'Check power supply and backup'].concat(REC),
    'Video Door Phone': ['Test outdoor unit camera and call button', 'Check indoor monitor audio and video', 'Verify door release / lock operation', 'Check intercom between units', 'Inspect wiring and power adapter', 'Check weather sealing of outdoor unit'].concat(REC),
    'Fire Alarm': ['Check panel status, faults and event log', 'Zone-wise functional test', 'Smoke / heat detector test', 'Manual call point test', 'Hooter / sounder and strobe test', 'Battery backup and charger check', 'Verify interfaces (lift / AHU / PA) where applicable', 'Inspect cabling and end-of-line devices'].concat(REC),
    UPS: PWR.slice(0, 5).concat(['Fan, filter and thermal check', 'Alarm and event log review', 'Earthing check', 'Remarks recorded']),
    Inverter: PWR.slice(0, 5).concat(['Charging current check', 'Earthing check', 'Remarks recorded']),
    'Servo Stabilizer': ['Cleaning done', 'Voltage check (input / output)', 'Carbon brush and variac inspection', 'Relay / contactor check', 'Load test', 'General inspection', 'Remarks recorded'],
    Battery: ['Cleaning and terminal greasing', 'Voltage check per battery', 'Specific gravity / electrolyte top-up', 'Backup / load test', 'General inspection', 'Remarks recorded'],
    Solar: ['Visual inspection of solar modules', 'Inspection of mounting structures and fasteners', 'Cable, connector and conduit inspection', 'Inverter health and fault review', 'AC/DC protection and earthing inspection', 'Monitoring and generation-data review', 'Battery inspection for applicable hybrid systems', 'Cleaning requirement assessment', 'Site safety and access observations', 'Customer feedback and operating concerns', 'Photographs and measurements', 'Defects and recommended corrective actions'],
  };

  // ---------------------------------------------------------------- policy rules (ODM) — configurable table
  const R = (id, area, name, policyRef, cond, threshold, severity, extra) => Object.assign({ id, area, name, policyRef, cond, threshold, severity, enabled: true, levels: [0, 6, 12, 24, 48], startLevel: 1 }, extra || {});
  // Rules whose timing comes from the SLA matrix (the single source of truth), never from the rule threshold
  const SLA_RULES = ['SVC-ACK', 'SVC-ATT-P', 'SVC-ATT-ES', 'SVC-RES'];
  const DEFAULT_RULES = [
    R('SAL-QUO', 'Sales', 'Quotation delay', 'PV-4.1', 'Enquiry generated but quotation not submitted within 24 hours (Sales Executive → Sales Coordinator → Sales Head)', 24, 'Low'),
    R('SAL-SV', 'Sales', 'Site visit delay', 'PV-4.2', 'Enquiry generated but site visit not completed within 24 hours', 24, 'Low'),
    R('SAL-SO', 'Sales', 'Customer approval pending SO', 'PV-4.3', 'Customer approved quotation but Sales Order not issued within 24 hours of approval', 24, 'Medium'),
    R('INS-DLY', 'Installation', 'Installation delay', 'PV-5.1', 'Sales Order issued but installation not completed within 24 hours', 24, 'Medium'),
    R('INS-PAY', 'Installation', 'Payment collection delay', 'PV-5.2', 'Installation completed but payment not received as per approved credit policy (customer credit days)', 720, 'Medium'),
    R('INS-SCR', 'Installation', 'Scrap collection delay', 'PV-5.3', 'Installation completed but scrap not collected within 24 hours', 24, 'Low'),
    R('INS-COM', 'Installation', 'Commissioning certificate delay', 'PV-5.4', 'Installation completed but commissioning certificate not submitted within 48 hours', 48, 'Medium'),
    R('SVC-ACK', 'Service', 'Complaint acknowledgement delay', 'PV-6.1', 'Complaint registered but customer not acknowledged within the SLA matrix acknowledgement time (30 minutes; Critical 15 minutes)', null, 'Medium'),
    R('SVC-ATT-P', 'Service', 'Attendance delay – Power', 'PV-6.2', 'Power: High priority not attended within 4 hours / Low priority within 24 hours (from SLA configuration)', null, 'High'),
    R('SVC-ATT-ES', 'Service', 'Attendance delay – Electronic Security & Solar', 'PV-6.3', 'Complaint not attended within the SLA matrix attendance time (24 hours; safety-critical and Solar complaint-type overrides from SLA configuration)', null, 'High'),
    R('SVC-CHG', 'Service', 'Service charges collection delay', 'PV-6.4', 'Complaint resolved but service charges not collected', 24, 'Medium'),
    R('SVC-TRC', 'Service', 'TRC open delay', 'PV-6.5', 'Complaint attended but open due to TRC (To Return Check / observation pending) > 36 hours', 36, 'Medium'),
    R('SVC-OPEN1', 'Service', 'Open call delay – Level 1', 'PV-6.6', 'Call attended but still open > 36 hours', 36, 'Medium'),
    R('SVC-OPEN2', 'Service', 'Open call delay – Level 2', 'PV-6.7', 'Call attended but open in the 36–48 hour band — raised at Level 2 (Team Leader / Coordinator) with High severity', 40, 'High', { startLevel: 2 }),
    R('SVC-STBY', 'Service', 'Standby material delay', 'PV-6.8', 'Standby product supplied but not collected within 7 days', 168, 'Medium'),
    R('SVC-RES', 'Service', 'Resolution SLA breach', 'ES-6.4', 'Call not resolved within the approved resolution SLA', null, 'High'),
    R('PM-OVD', 'Service', 'PM overdue / report missing', 'ES-7.3', 'Preventive maintenance not completed within the approved due window (7 days)', 168, 'Medium'),
    R('CX-ESC', 'Customer', 'Customer escalation', 'PV-7.1', 'Customer escalation recorded (date, reason, severity, responsible department)', 0, 'Critical', { startLevel: 3 }),
    R('CX-NEG', 'Customer', 'Negative feedback alert', 'PV-7.3', 'Customer rating ≤ 2/5 — immediate escalation to department head', 0, 'Critical', { startLevel: 3 }),
    R('AMC-QUO', 'AMC', 'AMC due – quotation not submitted', 'PV-8.1', 'AMC renewal due but quotation not submitted within TAT (30 days before expiry)', 0, 'Medium'),
    R('AMC-PAY', 'AMC', 'AMC billed – payment pending', 'PV-8.2', 'AMC invoice generated but payment not received as per agreed payment terms', 720, 'Medium'),
    R('PRJ-STG', 'Projects', 'Project stage delay', 'PV-9', 'Project stage / planned completion overdue (ES & Solar)', 0, 'High'),
  ];
  // Five-level structure (Policy doc §2): Executive/Engineer → TL/Coordinator → Department Head → Operations Manager → Management.
  // Roles per level are configurable (Settings & Rules / Service Configuration → Escalation ladder).
  const DEFAULT_LADDER = {
    Sales: [['sales_exec'], ['sales_coordinator'], ['sales_manager'], ['odm'], ['gm']],
    Installation: [['install_lead', 'service_engineer'], ['service_coordinator', 'es_coordinator', 'solar_coordinator'], ['tech_head'], ['odm'], ['gm']],
    Service: [['service_engineer'], ['service_coordinator', 'pm_coordinator'], ['service_coordinator'], ['odm'], ['gm']],
    Customer: [['service_coordinator'], ['service_coordinator', 'pm_coordinator'], ['service_coordinator'], ['odm'], ['gm']],
    AMC: [['pm_coordinator'], ['service_coordinator'], ['accounts', 'pm_coordinator'], ['odm'], ['gm']],
    Projects: [['tech_engineer', 'install_lead'], ['es_coordinator', 'solar_coordinator'], ['tech_head'], ['odm'], ['gm']],
  };
  const LADDER = DEFAULT_LADDER; // department keys (the role lists come from ladderOf())
  const LEVEL_NAMES = ['L1 · Executive / Engineer', 'L2 · Team Leader / Coordinator', 'L3 · Department Head', 'L4 · Operations Manager', 'L5 · Management'];
  const MAX_LVL = LEVEL_NAMES.length;
  const CFG_VERSION = 2;
  const SOLAR_TYPE_SLA = { 'Inverter fault / shutdown': { attend: 24, resolve: 48 }, 'Generation below expected level': { attend: 48, resolve: 96 }, 'Module damage': { attend: 48, resolve: 120 }, 'Earthing / electrical protection issue': { attend: 4, resolve: 24 }, 'Monitoring or communication failure': { attend: 48, resolve: 72 } };

  function defaultConfig() {
    const sla = {};
    const crit = { ack: 0.25, attend: 4, resolve: 24 };
    sla.Power = { Critical: { ack: 0.25, attend: 2, resolve: 12 }, High: { ack: 0.5, attend: 4, resolve: 24 }, Low: { ack: 0.5, attend: 24, resolve: 48 } };
    sla['Electronic Security'] = { Critical: crit, High: { ack: 0.5, attend: 24, resolve: 48 }, Low: { ack: 0.5, attend: 24, resolve: 72 } };
    sla.Solar = { Critical: crit, High: { ack: 0.5, attend: 24, resolve: 48 }, Low: { ack: 0.5, attend: 24, resolve: 96 } };
    const engineers = {};
    master.staff('service_engineer').forEach((s, i) => { engineers[s.id] = engDefaults(s, i); });
    const checklistVersion = {}; EQ_TYPES.forEach((t) => { checklistVersion[t] = 'v1.0'; });
    return {
      id: 'CFG', sla, repeatWindowDays: 30, negativeRating: 2, creditDays: 30, pmGraceDays: 7, discountLimit: 10,
      pmFrequency: { Power: 4, 'Electronic Security': 4, Solar: 6 }, amcTargetMonthly: 250000,
      amcPricing: { Comprehensive: { pct: 12, perKva: 450, perBattery: 1200 }, 'Non-Comprehensive': { pct: 7, perKva: 250, perBattery: 600 } },
      otsIncentive: { servicePct: 2, salesPct: 1.5, sharedSplit: 50 },
      checklists: util.clone(DEFAULT_CHECKLISTS), checklistVersion, rules: util.clone(DEFAULT_RULES), engineers,
      cfgVersion: CFG_VERSION,
      // SLA calendar per division: '24x7' (clock hours) or 'business' (work hours & holidays from core settings)
      slaCalendar: { Power: '24x7', 'Electronic Security': 'business', Solar: 'business' },
      slaByType: { Solar: util.clone(SOLAR_TYPE_SLA) },
      amcPmVisitsPerYear: 3, pmFrequencyEq: {}, otsBatteryThreshold: 2, otsNonBattery: 'Sales OTS', observationHours: 24,
      ladder: util.clone(DEFAULT_LADDER), reminderDays: { amc: [60, 30], warranty: [90, 30] },
      customerChannels: { amcRenewal: ['Email', 'WhatsApp'], warrantyExpiry: ['Email', 'WhatsApp'] },
      penalty: { engineer: 1.5, coordinator: 2, sales: 3, department: 2 },
    };
  }
  function migrateCfg(c) {
    const d = defaultConfig(); const patch = { cfgVersion: CFG_VERSION };
    Object.keys(d).forEach((k) => { if (c[k] === undefined) patch[k] = d[k]; });
    const have = new Set((c.rules || []).map((r) => r.id));
    patch.rules = (c.rules || []).map((r) => {
      const x = Object.assign({}, r); const lv = (x.levels || [0, 6, 12, 24]).slice(); while (lv.length < MAX_LVL) lv.push(lv[lv.length - 1] * 2 || 48); x.levels = lv;
      const def = DEFAULT_RULES.find((y) => y.id === x.id);
      if (x.id === 'SVC-OPEN2' && Number(x.threshold) === 48 && def) Object.assign(x, { threshold: def.threshold, startLevel: def.startLevel, cond: def.cond });
      if (SLA_RULES.includes(x.id)) { x.threshold = null; if (def) x.cond = def.cond; }
      return x;
    }).concat(DEFAULT_RULES.filter((r) => !have.has(r.id)).map((r) => util.clone(r)));
    return db.update('serviceConfig', 'CFG', patch, { silent: true }) || Object.assign(c, patch);
  }
  function engDefaults(s, i) {
    const skills = s.division === 'Power' ? ['UPS', 'Inverter', 'Battery'] : s.division === 'Electronic Security' ? ['Security'] : s.division === 'Solar' ? ['Solar'] : ['UPS', 'Inverter', 'Battery', 'Security'];
    return { skills, experience: ['Senior', 'Mid', 'Senior', 'Junior'][i % 4], areas: master.areas.filter((a, j) => (j + i) % 3 === 0), availability: 'Available', level: i % 2 ? 'Field' : 'Field + Service Centre' };
  }
  function cfg() {
    let c = db.get('serviceConfig', 'CFG');
    if (!c) c = db.insert('serviceConfig', defaultConfig(), { silent: true });
    else if ((c.cfgVersion || 1) < CFG_VERSION) c = migrateCfg(c);
    return c;
  }
  const ladderOf = (area) => { const l = (cfg().ladder || {})[area] || DEFAULT_LADDER[area] || DEFAULT_LADDER.Service; return l.length >= MAX_LVL ? l : l.concat(DEFAULT_LADDER.Service.slice(l.length)); };
  const saveCfg = (patch, note) => db.update('serviceConfig', 'CFG', patch, { note: note || 'Configuration updated' });
  const rule = (id) => cfg().rules.find((r) => r.id === id) || DEFAULT_RULES.find((r) => r.id === id);
  const engProfile = (id) => { const c = cfg(); if (!c.engineers[id]) { const s = db.get('staff', id); c.engineers[id] = engDefaults(s || {}, 0); } return c.engineers[id]; };

  // ================================================================ generic helpers
  const now = () => new Date();
  const T0 = () => new Date(CRM.TODAY);
  const hrsSince = (d) => (Date.now() - new Date(d).getTime()) / HR;
  const cfgGet = (k, d) => { try { return CRM.config && CRM.config.get ? CRM.config.get(k, d) : d; } catch (e) { return d; } };
  // YYYY-MM-DD is a local calendar date (new Date('YYYY-MM-DD') would be UTC midnight)
  function parseD(v) {
    if (v instanceof Date) return new Date(v.getTime());
    if (CRM.util && CRM.util.parseDate) { const r = CRM.util.parseDate(v); if (r && !isNaN(r)) return r; }
    const m = typeof v === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  }
  // month arithmetic with end-of-month clamp (31 Jan + 1 month = 28/29 Feb, not 2/3 Mar)
  function addMonths(d, n) {
    if (CRM.util && CRM.util.addMonths) { const r = CRM.util.addMonths(parseD(d), n); if (r && !isNaN(r)) return new Date(r); }
    const x = parseD(d); const day = x.getDate(); x.setDate(1); x.setMonth(x.getMonth() + n);
    x.setDate(Math.min(day, new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate())); return x;
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtTime = (d) => (fmt.time ? fmt.time(d) : String(fmt.dateTime(d)).split(' · ').pop());
  const esc = (s) => util.esc(s);
  // callouts: user text is always rendered as text; markup only through calloutHtml (core v2) with escaped values
  const txtCallout = (text, tone) => h('div', { class: 'callout ' + (tone || '') }, String(text == null ? '' : text));
  const htmlCallout = (html, tone) => (ui.calloutHtml ? ui.calloutHtml(html, tone) : h('div', { class: 'callout ' + (tone || ''), html }));
  // ---- business-hours SLA calendar (core CRM.util.businessHoursBetween / addBusinessHours when present)
  const hmin = (s) => { const p = String(s || '0:0').split(':').map(Number); return (p[0] || 0) * 60 + (p[1] || 0); };
  const workHours = () => { const w = cfgGet('workHours', null) || {}; return { days: w.days || [1, 2, 3, 4, 5, 6], start: w.start || '09:30', end: w.end || '18:30' }; };
  const holidaySet = () => new Set(cfgGet('holidays', []) || []);
  function bizHoursBetween(a, b) {
    a = new Date(a); b = new Date(b); if (!(b > a)) return 0;
    if (CRM.util && CRM.util.businessHoursBetween) { const r = Number(CRM.util.businessHoursBetween(a, b)); if (!isNaN(r)) return r; }
    const w = workHours(); const hol = holidaySet(); const s = hmin(w.start); const e = hmin(w.end); let tot = 0;
    const d = new Date(a.getFullYear(), a.getMonth(), a.getDate());
    for (let i = 0; d <= b && i < 1200; i++, d.setDate(d.getDate() + 1)) {
      if (!w.days.includes(d.getDay()) || hol.has(util.iso(d))) continue;
      const x = Math.max(d.getTime() + s * 6e4, a.getTime()); const y = Math.min(d.getTime() + e * 6e4, b.getTime());
      if (y > x) tot += (y - x) / HR;
    }
    return tot;
  }
  function addBizHours(start, hrs) {
    start = new Date(start);
    if (CRM.util && CRM.util.addBusinessHours) { const r = CRM.util.addBusinessHours(start, hrs); if (r && !isNaN(new Date(r))) return new Date(r); }
    const w = workHours(); const hol = holidaySet(); const s = hmin(w.start); const e = hmin(w.end); let left = hrs * HR;
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    for (let i = 0; i < 1200; i++, d.setDate(d.getDate() + 1)) {
      if (!w.days.includes(d.getDay()) || hol.has(util.iso(d))) continue;
      const x = Math.max(d.getTime() + s * 6e4, start.getTime()); const y = d.getTime() + e * 6e4;
      if (y <= x) continue;
      if (y - x >= left) return new Date(x + left);
      left -= y - x;
    }
    return new Date(start.getTime() + hrs * HR);
  }
  // ---- photo / signature evidence (core ui.photoCapture / ui.signaturePad when present, else an honest simulation)
  const nodeOf = (n) => (n instanceof Node ? n : n && (n.el || n.node || n.element));
  function readWidget(n) {
    try {
      const v = typeof n.getValue === 'function' ? n.getValue() : typeof n.get === 'function' ? n.get() : n.value !== undefined ? n.value : (n.dataset || {}).value;
      if (Array.isArray(v)) return v.length ? v : '';
      return v || '';
    } catch (e) { return ''; }
  }
  // Evidence is stored as real attachments (CRM.files → IndexedDB). The record keeps a reference 'ATT:<label>'; gates check the attachment exists.
  // A typed-name signature (pad unavailable) is kept as text. Without CRM.files a small value is kept inline, a large one is not stored (gate fails).
  const storable = (v) => v || '';
  const evPending = {};
  const isDataUrl = (x) => typeof x === 'string' && /^data:/.test(x);
  function storeEv(value, recordType, recordId, key, label) {
    const list = (Array.isArray(value) ? value : [value]).filter(Boolean);
    if (!list.length) return '';
    if (!list.some(isDataUrl)) return Array.isArray(value) ? list.join(', ') : value;
    if (!(CRM.files && CRM.files.add)) { try { return JSON.stringify(value).length <= 4000 ? value : ''; } catch (e) { return ''; } }
    const pk = recordType + ':' + recordId + ':' + label;
    evPending[pk] = (evPending[pk] || 0) + 1;
    Promise.all(list.filter(isDataUrl).map((d, i) => CRM.files.add(d, { recordType, recordId, label: list.length > 1 ? label + ' ' + (i + 1) : label })))
      .catch((err) => { ui.toast(label + ' was not saved: ' + err.message, 'bad'); const r = db.get(recordType, recordId); if (r && r[key] === 'ATT:' + label) db.update(recordType, recordId, { [key]: '' }, { note: label + ' could not be stored' }); })
      .then(() => { evPending[pk]--; });
    return 'ATT:' + label;
  }
  /** Evidence present: an inline value, or an 'ATT:<label>' reference whose attachment exists (or is still being written). */
  function evOk(rec, recordType, key) {
    const v = rec && rec[key];
    if (!v) return false;
    if (typeof v !== 'string' || !/^ATT:/.test(v)) return true;
    const label = v.slice(4);
    if (evPending[recordType + ':' + rec.id + ':' + label] > 0) return true;
    return !!(CRM.files && db.all('attachments').some((a) => a.recordType === recordType && a.recordId === rec.id && (a.label === label || a.label.indexOf(label + ' ') === 0)));
  }
  function evidenceWidget(e) {
    const fn = e.kind === 'photo' ? ui.photoCapture : ui.signaturePad;
    if (typeof fn === 'function') {
      const w = safe(() => fn({ label: e.label, required: !!e.required, multiple: e.kind === 'photo' }), null); const n = nodeOf(w);
      if (n) return { node: h('div', { class: 'field full' }, [h('label', {}, [e.label, e.required ? h('span', { class: 'req' }, ' *') : null]), n]), get: () => storable(readWidget(w)) };
    }
    if (e.kind === 'signature') {
      const i = h('input', { type: 'text', value: e.default || '', placeholder: 'Customer name' });
      return { node: h('div', { class: 'field' }, [h('label', {}, [e.label, e.required ? h('span', { class: 'req' }, ' *') : null]), i, h('div', { class: 'hint' }, 'Signature pad unavailable — typed name recorded as acknowledgement (simulated)')]), get: () => i.value.trim() };
    }
    const cb = h('input', { type: 'checkbox' });
    return { node: h('div', { class: 'field' }, [h('label', { class: 'check-row' }, [cb, e.label + ' (simulated upload — camera capture unavailable)'])]), get: () => (cb.checked ? 'simulated' : '') };
  }
  // form + evidence in one modal; onSave(values) receives evidence under its keys
  function evModal(title, fields, values, evidence, onSave, opts) {
    const f = ui.form(fields, values || {});
    const ws = (evidence || []).map((e) => Object.assign({ e }, evidenceWidget(e)));
    const body = h('div', { class: 'stack' }, [f].concat(ws.length ? [h('div', { class: 'form' }, ws.map((w) => w.node))] : []));
    return ui.modal(Object.assign({ title, wide: ws.length > 1, body, actions: [{ label: 'Cancel' }, { label: (opts && opts.saveLabel) || 'Save', cls: 'primary', onClick: () => {
      if (!f.validate()) return false;
      const v = f.values(); let ok = true;
      ws.forEach((w) => { v[w.e.key] = w.get(); if (w.e.required && !v[w.e.key]) ok = false; });
      if (!ok) { ui.toast('Photo / signature evidence is mandatory', 'bad'); return false; }
      const r = onSave(v); if (r !== false) reopenAfter(() => {}); return r;
    } }] }, opts && opts.sub ? { sub: opts.sub } : {}));
  }
  function exportPdf(title, node) {
    if (CRM.exportPdf) return CRM.exportPdf(title, node);
    const w = window.open('', '_blank'); if (!w) { ui.toast('Allow pop-ups to print / save as PDF', 'warn'); return; }
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>body{font:13px system-ui,sans-serif;margin:24px;color:#111}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 6px;text-align:left}button,select,input{display:none}</style></head><body><h2>' + esc(title) + '</h2>' + (node ? node.innerHTML : '') + '</body></html>');
    w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  }
  const pdfBtn = (title, getNode) => ui.btn('Export PDF', () => exportPdf(title + ' · ' + fmt.date(CRM.TODAY), getNode()), 'sm');
  const dtLocal = (d) => { const x = new Date(d); return util.iso(x) + 'T' + String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0'); };
  const dur = (hrs) => { const a = Math.abs(hrs); return a < 1 ? Math.round(a * 60) + 'm' : a < 48 ? (Math.round(a * 10) / 10) + 'h' : Math.round(a / 24) + 'd'; };
  const me = () => CRM.user().id;
  const roleIs = (...r) => CRM.is(...r);
  const isCoord = () => roleIs('service_coordinator', 'admin');
  const isMgmt = () => roleIs('admin', 'gm', 'odm');
  const staffOpts = (role) => master.staff(role).map((s) => ({ value: s.id, label: s.name + (s.division ? ' · ' + s.division : '') }));
  const custOpts = () => master.customers().map((c) => ({ value: c.id, label: c.name + ' · ' + c.id }));
  const custName = (id) => (master.customer(id) || {}).name || id || '—';
  const link = (href, text) => h('a', { href, onClick: (e) => e.stopPropagation() }, text);
  const mono = (t) => h('span', { class: 'mono' }, t);
  const tone = (s) => ({ Met: 'ok', Breached: 'bad', 'At risk': 'warn', Running: 'info', Paused: 'violet', 'N/A': '' }[s] || '');
  const pctOf = (a, b) => util.pct(a, b);
  const months = (n) => { const out = []; for (let i = n - 1; i >= 0; i--) { const d = addMonths(new Date(CRM.TODAY.getFullYear(), CRM.TODAY.getMonth(), 1), -i); out.push({ key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), label: MON[d.getMonth()], start: d }); } return out; };
  const monthKey = (d) => d ? util.iso(d).slice(0, 7) : '';
  const anyField = (o, keys) => { for (const k of keys) if (o && o[k]) return o[k]; return null; };
  const sevTone = (s) => ({ Low: 'info', Medium: 'warn', High: 'bad', Critical: 'violet' }[s] || '');
  const clean = (o) => { const r = {}; Object.keys(o || {}).forEach((k) => { if (o[k] !== undefined && o[k] !== null && o[k] !== '') r[k] = o[k]; }); return r; };
  const safe = (fn, fb) => { try { return fn(); } catch (e) { console.warn('[service]', e); return fb; } };
  function setOptions(sel, options, value) {
    sel.innerHTML = '';
    sel.appendChild(h('option', { value: '' }, 'Select…'));
    options.forEach((o) => { const v = typeof o === 'object' ? o.value : o; const l = typeof o === 'object' ? o.label : o; sel.appendChild(h('option', { value: v, selected: String(v) === String(value) ? true : null }, l)); });
  }
  function exportCSV(name, columns, rows) {
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const val = (c, r) => { if (c.csv) return c.csv(r); const v = c.render ? c.render(r) : r[c.key]; return v instanceof Node ? v.textContent : v; };
    const lines = [columns.map((c) => q(c.label)).join(',')].concat(rows.map((r) => columns.map((c) => q(val(c, r))).join(',')));
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' })), download: name.replace(/[^a-z0-9]+/gi, '_') + '_' + util.iso(CRM.TODAY) + '.csv' });
    document.body.appendChild(a); a.click(); a.remove();
    ui.toast('Exported ' + rows.length + ' rows to CSV', 'ok');
  }
  function reopenAfter(fn) { CRM.refresh(); setTimeout(fn, 0); }
  function routeDrawer(id, open) { if (!id) return; setTimeout(() => { open(id); try { history.replaceState(null, '', location.hash.split('/').slice(0, 2).join('/')); } catch (e) { /* ignore */ } }, 0); }

  // ================================================================ assets & coverage
  const notBefore = (dateStr) => dateStr && parseD(dateStr) >= CRM.TODAY;
  function activeAmcFor(asset) { return db.one('amcContracts', (a) => a.status === 'Active' && (a.assetIds || []).includes(asset.id) && notBefore(a.end)); }
  function coverageOf(asset) {
    if (!asset) return { type: 'Not available', until: null };
    const amc = activeAmcFor(asset);
    if (amc) return { type: 'AMC', until: amc.end, amc };
    if (asset.warrantyEnd && notBefore(asset.warrantyEnd)) return { type: 'Warranty', until: asset.warrantyEnd };
    return { type: 'Expired', until: asset.amcEnd || asset.warrantyEnd };
  }
  // division-aware: a Power AMC never covers an Electronic Security / Solar complaint
  function customerAmcStatus(cid, division) {
    const list = db.find('amcContracts', (a) => a.customerId === cid && (!division || a.division === division));
    if (list.some((a) => a.status === 'Active' && notBefore(a.end))) return 'Active';
    return list.length ? 'Expired' : 'Not Available';
  }
  const amcStatusLine = (cid) => DIVS.map((d) => [d, customerAmcStatus(cid, d)]).filter(([, s]) => s !== 'Not Available').map(([d, s]) => d.replace('Electronic Security', 'ES') + ' ' + s).join(' · ') || 'Not Available';
  function capacityOf(p, a) {
    if (a.capacity) return a.capacity;
    if (a.capacityKw) return a.capacityKw + ' kW';
    if (a.capacityKva) return a.capacityKva + ' kVA';
    const m = /(\d+(?:\.\d+)?)\s*(kW|kVA|KVA|Ah|VA)\b/i.exec(((p && p.name) || a.name || '') + ' ' + (a.model || ''));
    return m ? m[1] + ' ' + m[2].replace(/^kva$/i, 'kVA') : '';
  }
  function createAsset(a, opts) {
    const p = a.productId ? master.product(a.productId) : null;
    const install = a.installDate || util.iso(CRM.TODAY);
    const wm = a.warrantyMonths || (p && p.warrantyMonths) || (a.division === 'Solar' ? 60 : 12);
    const div = (p && p.division) || a.division;
    return db.insert('assets', Object.assign({
      division: div, category: (p && p.category) || a.category || '', eqType: eqTypeFor((p && p.category) || a.category, div, (p && p.name) || a.name),
      name: (p && p.name) || a.name || 'Equipment', make: a.make || (p && p.brand) || (p && /Exide/.test(p.name) ? 'Exide' : p && /SF/.test(p.name) ? 'SF Sonic' : div === 'Power' ? 'Maruthi' : '—'), model: a.model || (p && p.name) || a.name,
      serial: a.serial || ('SN' + util.rand(100000, 999999)), location: a.location || '', channel: a.channel || '', tag: a.tag || '', qty: a.qty || 1, capacity: capacityOf(p, a),
      installDate: install, commissionDate: a.commissionDate || install, warrantyStart: install, warrantyEnd: util.iso(util.addDays(addMonths(install, wm), -1)),
      status: 'Active', history: [{ at: install, text: (a.installPending ? 'Supplied — installation pending (warranty provisional from SO date)' : 'Installed & commissioned') + (a.projectId ? ' (project ' + a.projectId + ')' : a.orderId ? ' (SO ' + (a.soNumber || a.orderId) + ')' : '') }],
    }, clean(a), { warrantyMonths: wm }), Object.assign({ prefix: 'EQP' }, opts || {}));
  }
  // Warranty and PM run from the ACTUAL installation date — re-based when the installation call closes
  function applyInstallDate(orderId, dateIso, opts) {
    if (!orderId || !dateIso) return 0;
    const o = Object.assign({ silent: true }, opts || {});
    const assets = db.find('assets', (a) => a.orderId === orderId);
    assets.forEach((a) => {
      if (a.installDate === dateIso && !a.installPending) return;
      db.update('assets', a.id, { installDate: dateIso, commissionDate: dateIso, warrantyStart: dateIso, warrantyEnd: util.iso(util.addDays(addMonths(dateIso, a.warrantyMonths || 12), -1)), installPending: false, history: (a.history || []).concat([{ at: dateIso, text: 'Installation completed — warranty starts ' + fmt.date(dateIso) }]) }, Object.assign({ note: 'Warranty re-based on installation date' }, o));
    });
    db.find('pmPlans', (pl) => pl.orderId === orderId).forEach((pl) => {
      const a0 = db.get('assets', (pl.assetIds || [])[0]) || {};
      db.update('pmPlans', pl.id, { coverageEnd: a0.warrantyEnd || pl.coverageEnd }, o);
      const pend = db.find('pmVisits', (v) => v.planId === pl.id && !v.completedDate).sort((x, y) => (x.dueDate > y.dueDate ? 1 : -1));
      pend.forEach((v, i) => db.update('pmVisits', v.id, { dueDate: util.iso(addMonths(dateIso, (i + 1) * (pl.frequencyMonths || 4))) }, o));
      syncPlan(pl.id, o);
    });
    return assets.length;
  }

  // ================================================================ complaints — SLA, coverage, repeat, assignment
  const isOpen = (c) => c.status !== 'Closed' && c.status !== 'Cancelled';
  // SLA matrix is the single source of truth (division × priority), optionally refined per complaint type (Solar §5.3)
  const SLA_FALLBACK = { ack: 0.5, attend: 24, resolve: 48 };
  function slaOf(c) {
    const s = cfg().sla[c.division] || cfg().sla.Power; const base = Object.assign({}, SLA_FALLBACK, s[c.priority] || s.Low);
    const bt = ((cfg().slaByType || {})[c.division] || {})[c.category];
    if (bt) ['ack', 'attend', 'resolve'].forEach((k) => { const v = Number(bt[k]); if (bt[k] !== '' && bt[k] != null && v > 0) base[k] = Math.min(Number(base[k]) || v, v); });
    return base;
  }
  function slaHours(c, kind) { const v = Number(slaOf(c)[kind]); return v > 0 ? v : SLA_FALLBACK[kind]; }
  const bizMode = (c) => (cfg().slaCalendar || {})[c.division] === 'business';
  const span = (c, a, b) => (bizMode(c) ? bizHoursBetween(a, b) : Math.max(0, (new Date(b) - new Date(a)) / HR));
  // hours the clock was paused (waiting for customer / spares / vendor) between registration and `until`
  function pausedHours(c, kind, until) {
    if (kind === 'ack' || !(c.pauses || []).length) return 0;
    const end = new Date(until); const st = new Date(c.createdAt);
    return util.sum(c.pauses, (p) => { const a = new Date(Math.max(new Date(p.from), st)); const b = new Date(Math.min(p.to ? new Date(p.to) : Date.now(), end)); return b > a ? span(c, a, b) : 0; });
  }
  const _slaCache = new Map();
  function elapsedSla(c, kind, until) {
    const u = new Date(until); const key = c.id + '|' + kind + '|' + (c.updatedAt || '') + '|' + Math.floor(u.getTime() / 6e4);
    if (_slaCache.has(key)) return _slaCache.get(key);
    const v = span(c, c.createdAt, u) - pausedHours(c, kind, u);
    if (_slaCache.size > 6000) _slaCache.clear();
    _slaCache.set(key, v); return v;
  }
  const isPaused = (c) => isOpen(c) && isPauseSub(c.openSub);
  function dueAt(c, kind) {
    const total = slaHours(c, kind) + pausedHours(c, kind, Date.now());
    return bizMode(c) ? addBizHours(c.createdAt, total) : new Date(new Date(c.createdAt).getTime() + total * HR);
  }
  const doneAt = (c, kind) => (kind === 'ack' ? c.ackAt : kind === 'attend' ? c.attendedAt : c.resolvedAt);
  function slaState(c, kind) {
    const hrs = slaHours(c, kind); const done = doneAt(c, kind);
    if (done) return elapsedSla(c, kind, done) <= hrs ? 'Met' : 'Breached';
    if (!isOpen(c)) return 'N/A';
    const left = hrs - elapsedSla(c, kind, Date.now());
    if (left < 0) return 'Breached';
    if (kind !== 'ack' && isPaused(c)) return 'Paused';
    return left < hrs * 0.25 ? 'At risk' : 'Running';
  }
  function slaBadge(c, kind) {
    const s = slaState(c, kind); const done = doneAt(c, kind); const hrs = slaHours(c, kind);
    const el = done ? elapsedSla(c, kind, done) : s === 'N/A' ? 0 : elapsedSla(c, kind, Date.now());
    const t = done ? dur(el) : s === 'N/A' ? '' : (el <= hrs ? 'due in ' + dur(hrs - el) : 'over by ' + dur(el - hrs));
    const ph = pausedHours(c, kind, done || Date.now());
    return h('span', { title: kind + ' SLA ' + dur(hrs) + (bizMode(c) ? ' (business hours)' : ' (24×7)') + (ph ? ' · paused ' + dur(ph) : '') + ' · due ' + fmt.dateTime(dueAt(c, kind)) }, [ui.badge(s, tone(s)), t ? h('span', { class: 'small muted' }, ' ' + t) : null]);
  }
  // overdue = an SLA clock that is still running and already breached (a late but completed acknowledgement no longer counts)
  const overdue = (c) => isOpen(c) && (slaState(c, 'resolve') === 'Breached' || (!c.attendedAt && slaState(c, 'attend') === 'Breached') || (!c.ackAt && slaState(c, 'ack') === 'Breached'));
  // SLA candidate for the policy engine, using the same SLA clock (calendar + pauses)
  function slaBreachCand(c, kind, doneTs, extra) {
    const hrs = slaHours(c, kind); const until = doneTs || Date.now();
    if (elapsedSla(c, kind, until) <= hrs) return null;
    return Object.assign({ incidentAt: dueAt(c, kind).toISOString(), cleared: !!doneTs, clearedAt: doneTs || null }, extra);
  }
  // open/close pause intervals whenever the waiting sub-status changes
  function pausePatch(c, patch) {
    if (!('openSub' in patch) && !('closedAt' in patch)) return;
    const m = Object.assign({}, c, patch); const was = isPauseSub(c.openSub) && !c.closedAt; const is = isPauseSub(m.openSub) && !m.closedAt;
    const t = now().toISOString(); const ps = (c.pauses || []).map((p) => Object.assign({}, p));
    const closeLast = () => { const l = ps[ps.length - 1]; if (l && !l.to) l.to = t; };
    if (was && (!is || m.openSub !== c.openSub)) closeLast();
    if (is && (!was || m.openSub !== c.openSub)) ps.push({ from: t, reason: m.openSub });
    if (was || is) patch.pauses = ps;
  }
  function deriveStatus(c) {
    if (c.status === 'Cancelled') return 'Cancelled';
    if (c.closedAt) return 'Closed';
    if (!c.attendedAt) return 'Open';
    if ((c.openSub && c.step <= 8) || c.step === 6) return 'Waiting';
    return 'In Progress';
  }
  function isSafety(v) { return SAFETY_CATS.includes(v.category) || v.systemType === 'Fire Alarm'; }
  function findRepeat(v, excludeId) {
    const win = cfg().repeatWindowDays;
    const created = new Date(v.createdAt || Date.now());
    const prev = db.find('complaints', (c) => c.id !== excludeId && c.customerId === v.customerId && (v.assetId ? c.assetId === v.assetId : c.division === v.division && c.category === v.category) && new Date(c.createdAt) < created && util.daysBetween(c.createdAt, created) <= win && c.callType !== 'Installation');
    return prev.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
  }
  const skillFor = (c) => (c.division === 'Electronic Security' ? 'Security' : c.division === 'Solar' ? 'Solar' : /Battery/.test(c.systemType + c.category) ? 'Battery' : /Inverter/.test(c.systemType + c.category) ? 'Inverter' : 'UPS');
  const openLoad = (engId) => db.find('complaints', (x) => x.engineerId === engId && isOpen(x)).length;
  function suggestEngineers(c) {
    const cust = master.customer(c.customerId) || {};
    return master.staff('service_engineer').map((e) => {
      const p = engProfile(e.id); let score = 50; const why = [];
      if (p.skills.includes(skillFor(c))) { score += 30; why.push('skill ' + skillFor(c)); }
      if (!e.division || e.division === c.division) { score += 10; why.push('product knowledge'); }
      if ((p.areas || []).includes(cust.area)) { score += 15; why.push('covers ' + cust.area); }
      if (c.priority !== 'Low' && p.experience === 'Senior') { score += 8; why.push('senior for ' + c.priority); }
      const load = openLoad(e.id); score -= load * 5; why.push(load + ' open calls');
      if (p.availability !== 'Available') { score -= 40; why.push(p.availability); }
      return { e, score: Math.max(0, score), why, load };
    }).sort((a, b) => b.score - a.score);
  }
  function classificationOk(c) {
    if (c.serviceType === 'On-call') return !!(c.chargeable && Number(c.charges) > 0);
    if (c.serviceType === 'AMC') return c.coverage === 'AMC' && !c.chargeable;
    if (c.serviceType === 'Warranty') return (c.coverage === 'Warranty' || c.coverage === 'AMC') && !c.chargeable;
    if (c.serviceType === 'Complimentary') return !c.chargeable && !!c.complimentaryReason;
    return false;
  }
  const spareReqs = (cid) => db.find('spareRequests', (s) => s.complaintId === cid);
  const testList = (c) => TEST_CHECKS[c.division] || TEST_CHECKS.Power;
  const needsApproval = (c) => !!(c.chargeable || c.repeatOf || c.priority === 'Critical' || c.reopenCount);
  function closureGates(c) {
    const reqs = spareReqs(c.id);
    const g = [
      { label: 'Diagnosis and work performed recorded', ok: !!(c.diagnosis && c.actionTaken) },
      { label: 'Equipment tested after repair (' + testList(c).length + ' checks)', ok: testList(c).every((t) => (c.tests || {})[t]) },
      { label: 'Spare parts used and returned recorded', ok: reqs.every((s) => ['Used', 'Returned', 'Rejected'].includes(s.status)) },
      { label: 'Customer confirmation recorded', ok: !!c.customerConfirmed },
      { label: 'Service report submitted', ok: !!c.serviceReportNo },
      { label: 'Follow-up / repeat visit created if problem remains', ok: c.problemResolved !== false || !!c.followUpId },
      { label: 'Warranty / AMC / chargeable classification correct', ok: classificationOk(c), hint: c.serviceType + ' · coverage ' + c.coverage + (c.chargeable ? ' · chargeable ' + fmt.money(c.charges) : '') },
    ];
    if (c.vendorComplaint) g.push({ label: (c.vendorComplaint.kind === 'Supplier warranty' ? 'Supplier warranty claim (' + c.vendorComplaint.brand + ')' : 'External vendor (SF/Exide) complaint') + ' closed', ok: c.vendorComplaint.status === 'Closed' });
    if (isReplacement(c)) g.push({ label: 'Scrap entry recorded for the replaced battery (linked to complaint' + (grnFor(c) ? ' / GRN ' + grnFor(c).id : '') + ')', ok: scrapFor(c).length > 0 });
    if (c.observation && !c.observation.outcome) g.push({ label: 'Observation (Case 2) revisit outcome recorded', ok: false });
    if (c.callType === 'Installation') {
      const d = installDocs(c); const pay = c.instPayment || {};
      g.push({ label: 'Installation completed (engineer update)', ok: !!c.installedAt });
      g.push({ label: 'Payment status & mode recorded', ok: !!(pay.status && pay.mode), hint: pay.status ? pay.status + ' · ' + (pay.mode || '—') : 'not recorded' });
      if (c.scrapApplicable) g.push({ label: 'Scrap entry created (' + (c.scrapQty || 0) + ' × ' + (c.scrapType || 'scrap') + ')', ok: !!(c.scrapId || scrapFor(c).length) });
      g.push({ label: 'Installation photo proof (stored attachment)', ok: evOk(c, 'complaints', 'instPhotos') });
      g.push({ label: 'DC and invoice attached', ok: !!(d.dc && d.invoice), hint: 'DC ' + (d.dc || '—') + ' · invoice ' + (d.invoice || '—') });
    }
    if (c.serviceCentre) { const st = c.chargeable ? SC_STAGES.paid : SC_STAGES.free; g.push({ label: 'Service centre cycle complete (' + st[st.length - 1] + ')', ok: c.serviceCentre.stage >= st.length - 1 }); }
    if (c.standby && !c.standby.collectedAt) g.push({ label: 'Standby material collected back', ok: false });
    if (needsApproval(c)) g.push({ label: 'Closure approval (chargeable / repeat / critical / reopened)', ok: !!c.closureApprovedBy });
    return g;
  }

  function timelineOf(c) {
    const ev = [];
    const add = (at, title, body, color) => { if (at) ev.push({ at, when: fmt.dateTime(at), title, body, color }); };
    add(c.createdAt, 'Complaint registered', 'Source: ' + c.source + (c.reportedBy ? ' · reported by ' + c.reportedBy : ''));
    add(c.ackAt, 'Acknowledged by coordinator', 'Customer called, details verified' + (c.chargesInformed ? ', service charges informed' : ''));
    add(c.validatedAt, 'Priority & coverage validated', c.priority + ' · ' + c.serviceType + ' · coverage ' + c.coverage);
    add(c.assignedAt, 'Engineer assigned', master.staffName(c.engineerId) + (c.remoteNote ? ' · remote: ' + c.remoteNote : ''));
    add(c.committedAt, 'Customer commitment recorded', 'Visit committed for ' + fmt.dateTime(c.commitAt));
    add(c.attendedAt, 'Engineer attended (check-in)', c.geo ? 'Geo-tag ' + c.geo : '', 'var(--chart-5)');
    add(c.diagnosedAt, 'Diagnosis recorded', c.diagnosis);
    add(c.repairedAt, 'Repair & testing complete', c.actionTaken);
    add(c.reportAt, 'Service report & customer confirmation', (c.serviceReportNo || '') + ' · ' + (c.confirmMode || ''));
    add(c.closedAt, 'Call closed', c.closureApprovedBy ? 'Approved by ' + master.staffName(c.closureApprovedBy) : '', 'var(--ok)');
    (c.notes || []).forEach((n) => add(n.at, n.text, n.by, 'var(--chart-4)'));
    return ev.sort((a, b) => new Date(a.at) - new Date(b.at));
  }
  function note(c, text) { db.update('complaints', c.id, { notes: (c.notes || []).concat([{ at: now().toISOString(), by: CRM.user().name, text }]) }, { note: text }); }

  function createComplaint(v, opts) {
    opts = opts || {};
    v = clean(v);
    const asset = v.assetId ? db.get('assets', v.assetId) : null;
    const cov = asset ? coverageOf(asset) : { type: customerAmcStatus(v.customerId, v.division) === 'Active' ? 'AMC' : 'Expired', until: null };
    const serviceType = v.serviceType || (v.callType === 'Installation' ? 'Warranty' : cov.type === 'AMC' ? 'AMC' : cov.type === 'Warranty' ? 'Warranty' : 'On-call');
    const safety = isSafety(v);
    const priority = safety ? 'Critical' : (v.priority || 'Low');
    const rep = v.callType === 'Installation' ? null : findRepeat(v);
    const cust = master.customer(v.customerId) || {};
    const rec = db.insert('complaints', Object.assign({
      coordinatorId: 'EMP-service_coordinator', step: 1, status: 'Open', visits: 0, reopenCount: 0, notes: [], tests: {},
      address: v.address || ((master.sites(v.customerId)[0] || {}).address) || cust.area, contact: v.contact || cust.phone,
      productDetails: asset ? asset.name : v.productDetails, serial: asset ? asset.serial : v.serial, projectId: (asset && asset.projectId) || v.projectId, capacity: asset ? asset.capacity : v.capacity,
      systemType: v.systemType || (asset ? (asset.eqType === 'Solar' ? (/Hybrid/.test(asset.name) ? 'Hybrid' : 'On-grid') : asset.eqType) : ''),
    }, v, {
      priority, safetyCritical: safety, serviceType, coverage: cov.type, coverageUntil: cov.until, chargeable: serviceType === 'On-call', charges: v.charges || 0,
      prevCount: db.find('complaints', (c) => c.customerId === v.customerId).length, repeatOf: rep ? rep.id : null,
      lastPmDate: asset ? ((db.find('pmVisits', (p) => (p.assetIds || []).includes(asset.id) && p.completedDate).sort((a, b) => b.completedDate > a.completedDate ? 1 : -1)[0]) || {}).completedDate || null : null,
    }), { prefix: 'CMP', silent: opts.silent });
    if (!opts.silent) {
      const lk = '#/complaints/' + rec.id;
      CRM.notify({ to: ['service_coordinator'], title: (safety ? '🔥 SAFETY-CRITICAL ' : '') + 'New complaint ' + rec.id + ' — SLA clock started', body: custName(rec.customerId) + ' · ' + rec.division + ' · ' + rec.category + ' · ' + priority + ' · ack due in ' + dur(slaHours(rec, 'ack')), link: lk, severity: safety ? 'bad' : 'info', key: 'cmp-new-' + rec.id });
      CRM.notify({ to: ['service_coordinator'], title: 'SMS/WhatsApp to customer: Complaint registered', body: 'Hello ' + (cust.contact || 'there') + ', we\'ve received your request (' + rec.id + '). Our technician will call you shortly. — Team Maruthi', link: lk, channel: 'SMS / WhatsApp', key: 'cmp-sms-' + rec.id });
      if (safety) CRM.notify({ to: ['odm', 'gm'], title: 'Safety-critical call ' + rec.id, body: rec.category + ' at ' + custName(rec.customerId) + ' — dedicated priority & escalation policy applies', link: lk, severity: 'bad', key: 'cmp-safe-' + rec.id });
      if (rep) CRM.notify({ to: ['service_coordinator'], title: 'Repeat complaint detected: ' + rec.id, body: 'Same ' + (rec.assetId ? 'equipment ' + rec.assetId : 'category') + ' as ' + rep.id + ' within ' + cfg().repeatWindowDays + ' days', link: lk, severity: 'warn', key: 'cmp-rep-' + rec.id });
      if (rec.callType === 'Pre-Sale Support') CRM.notify({ to: ['sales_coordinator'], title: 'Pre-sale support request ' + rec.id, body: custName(rec.customerId) + ' · ' + rec.description, link: lk, key: 'cmp-pre-' + rec.id });
      if (rec.callType === 'Project Installation') {
        CRM.notify({ to: [rec.division === 'Solar' ? 'solar_coordinator' : 'es_coordinator'], title: 'Project installation request ' + rec.id, body: 'Routed to the Project Installation workflow · ' + custName(rec.customerId), link: lk, key: 'cmp-prj-' + rec.id });
        CRM.emit('project.installation.requested', { complaint: rec });
      }
      evaluateSoon();
    }
    return rec;
  }
  function updC(c, patch, noteText) {
    pausePatch(c, patch);
    const merged = Object.assign({}, c, patch);
    patch.status = deriveStatus(merged);
    const r = db.update('complaints', c.id, patch, { note: noteText });
    evaluateSoon();
    return r;
  }

  // ================================================================ OTS (Opportunity Through Service)
  // Battery count drives Service (≤ threshold) vs Sales (> threshold) OTS; the threshold applies to batteries only —
  // other products (UPS, inverter, cameras, modules…) follow the configured rule (default: Sales OTS, a product sale)
  function otsType(qty, productType) {
    if (productType && productType !== 'Battery') return cfg().otsNonBattery || 'Sales OTS';
    return Number(qty) <= (Number(cfg().otsBatteryThreshold) || 2) ? 'Service OTS' : 'Sales OTS';
  }
  const OTS_PRODUCTS = { Power: ['Battery', 'UPS', 'Inverter', 'Servo Stabilizer'], 'Electronic Security': ['Battery', 'Camera', 'DVR / NVR', 'Hard disk', 'Access control device', 'Other'], Solar: ['Battery', 'Inverter', 'Solar module', 'Other'] };
  function createOts(v) {
    const type = otsType(v.qty, v.productType || 'Battery');
    const isSvc = type === 'Service OTS';
    const rec = db.insert('ots', Object.assign({ status: 'Open', createdBy: me(), createdAt: now().toISOString() }, v, {
      otsType: type, department: isSvc ? 'Service' : 'Sales', assignedTo: isSvc ? (v.assignedTo || v.createdBy || me()) : null, incentiveEligible: 'Yes',
      division: v.division || 'Power', customerName: custName(v.customerId), product: (v.qty || 1) + ' × ' + (v.productType || 'Battery') + ' ' + (v.brand || '') + ' ' + (v.capacity || ''), source: 'Service',
      notes: 'From complaint ' + (v.complaintId || '—') + ' · est. ' + fmt.money(v.value) + ' · urgency ' + (v.urgency || '—'),
    }), { prefix: 'OTS' });
    if (!isSvc) CRM.emit('ots.created', { ots: rec });
    if (isSvc) {
      CRM.notify({ to: ['service_coordinator'], title: 'Service OTS ' + rec.id + ' created (popup + email)', body: rec.qty + ' × ' + rec.productType + ' · ' + fmt.money(rec.value) + ' · ' + custName(rec.customerId), link: '#/ots/' + rec.id, key: 'ots-' + rec.id });
      CRM.notify({ to: ['accounts'], title: 'Billing readiness: Service OTS ' + rec.id, body: 'Possible battery replacement billing for ' + custName(rec.customerId), link: '#/ots/' + rec.id, key: 'ots-acc-' + rec.id });
    } else CRM.notify({ to: ['sales_coordinator'], title: 'Sales OTS ' + rec.id + ' — assign to a Sales Executive', body: rec.qty + ' × ' + rec.productType + ' · ' + rec.customerName + ' · ' + fmt.money(rec.value) + ' · assignment task', link: '#/ots/' + rec.id, severity: 'warn', key: 'ots-' + rec.id });
    return rec;
  }
  // Sales converted an OTS into an enquiry → mark it converted (outcome written back here, by the owner of the ots collection)
  CRM.on('ots.converted', (p) => {
    const o = p && p.otsId && db.get('ots', p.otsId); if (!o) return;
    db.update('ots', o.id, clean({ converted: true, enquiryId: p.enquiryId || o.enquiryId, convertedAt: o.convertedAt || now().toISOString(), assignedTo: p.execId || o.assignedTo, status: o.status === 'Open' ? 'In Progress' : o.status }), { note: 'Converted to enquiry ' + (p.enquiryId || '') });
  });
  // Sales writes the enquiry outcome back: Quotation Sent / Negotiation / Won / Lost (a reopened Lost enquiry may return to Negotiation)
  CRM.on('ots.outcome', (p) => {
    const o = p && p.otsId && db.get('ots', p.otsId); if (!o || !OTS_STATUS.includes(p.status)) return;
    if (o.status === 'Won' && p.status !== 'Won') return;
    if (o.status === 'Lost' && !['Negotiation', 'Quotation Sent', 'Won'].includes(p.status)) return;
    const patch = clean({ status: p.status, quoteId: p.quoteId, orderId: p.orderId, quoteNo: p.quoteId || o.quoteNo });
    if (p.status === 'Won') Object.assign(patch, { revenue: Number(p.revenue || o.value) || 0, closedBy: p.by || o.assignedTo, closedAt: now().toISOString(), lostReason: '' });
    else if (p.status === 'Lost') Object.assign(patch, { revenue: 0, lostReason: p.reason || o.lostReason || 'Lost in Sales', closedBy: p.by || o.assignedTo, closedAt: now().toISOString() });
    else if (o.status === 'Lost') Object.assign(patch, { closedAt: null, closedBy: null, lostReason: '', reopenedAt: now().toISOString() });
    db.update('ots', o.id, patch, { note: 'Sales outcome: ' + p.status + (o.status === 'Lost' && p.status !== 'Lost' ? ' (reopened)' : '') });
  });
  function otsIncentive(o) {
    if (o.status !== 'Won' || o.incentiveEligible === 'No') return 0;
    const ic = cfg().otsIncentive; const pct = o.otsType === 'Service OTS' ? ic.servicePct : ic.salesPct;
    return Math.round((Number(o.revenue || o.value) || 0) * pct / 100);
  }

  // ================================================================ AMC — pricing, opportunities, activation, automation
  function amcQuoteAmount(q) {
    const p = cfg().amcPricing[q.amcType] || cfg().amcPricing.Comprehensive;
    const assets = (q.assetIds || []).map((id) => db.get('assets', id)).filter(Boolean);
    const base = util.sum(assets, (a) => ((master.product(a.productId) || {}).price || 20000) * (a.qty || 1) * p.pct / 100);
    return Math.max(1500, Math.round((base + (Number(q.capacity) || 0) * p.perKva + (Number(q.batteries) || 0) * p.perBattery) / 100) * 100);
  }
  function oppScore(o) {
    let s = o.type === 'AMC Renewal' ? 60 : 40;
    const c = master.customer(o.customerId) || {};
    if (c.type === 'Key Customer') s += 10;
    if ((o.followups || []).length) s += 8;
    if (o.quote && ['Opened', 'Accepted'].includes(o.quote.status)) s += 15;
    if (db.find('feedback', (f) => f.customerId === o.customerId && f.rating <= cfg().negativeRating).length) s -= 20;
    if (db.find('complaints', (x) => x.customerId === o.customerId && util.daysBetween(x.createdAt, CRM.TODAY) < 90).length > 3) s -= 10;
    return Math.max(5, Math.min(95, s));
  }
  // ---- follow-up tasks (collection serviceTasks): one open task per AMC opportunity, re-created on every logged follow-up
  const FOLLOW_UP_DAYS = 2;
  function openTask(t, opts) {
    const cur = db.one('serviceTasks', (x) => x.refId === t.refId && x.type === t.type && x.status === 'Open');
    if (cur) return db.update('serviceTasks', cur.id, { dueDate: t.dueDate, assignedTo: t.assignedTo || cur.assignedTo }, Object.assign({ note: 'Due date ' + t.dueDate }, opts || {}));
    return db.insert('serviceTasks', Object.assign({ status: 'Open', createdBy: (CRM.user() || {}).id }, t), Object.assign({ prefix: 'SVT' }, opts || {}));
  }
  function closeTasks(refId, outcome, opts) {
    db.find('serviceTasks', (x) => x.refId === refId && x.status === 'Open').forEach((x) => db.update('serviceTasks', x.id, { status: 'Done', doneAt: now().toISOString(), outcome: outcome || '' }, Object.assign({ note: 'Task closed: ' + (outcome || '') }, opts || {})));
  }
  const oppTask = (o, due, opts) => openTask({ type: 'AMC follow-up', refCol: 'amcOpportunities', refId: o.id, title: 'Follow up ' + o.type + ' ' + o.id + ' · ' + custName(o.customerId), division: o.division, customerId: o.customerId, assignedTo: o.assignedTo || 'EMP-pm_coordinator', dueDate: due, link: '#/amc/' + o.id }, opts);
  function createOpp(v, opts) {
    const due = v.nextFollowUp || util.iso(util.addDays(CRM.TODAY, FOLLOW_UP_DAYS));
    const rec = db.insert('amcOpportunities', Object.assign({ status: 'Open', followups: [], assignedTo: 'EMP-pm_coordinator', createdBy: me(), quote: null, nextFollowUp: due }, v), Object.assign({ prefix: 'AMO' }, opts || {}));
    if (!['Won', 'Lost'].includes(rec.status)) oppTask(rec, rec.nextFollowUp || due, opts && opts.silent ? { silent: true } : undefined);
    return rec;
  }
  // opportunity closed (Won / Lost) or reassigned → close / re-own its open follow-up task
  CRM.on('amcOpportunities:updated', (o) => safe(() => {
    if (!o) return;
    if (['Won', 'Lost'].includes(o.status)) closeTasks(o.id, o.status);
    else { const t = db.one('serviceTasks', (x) => x.refId === o.id && x.status === 'Open'); if (t && o.assignedTo && t.assignedTo !== o.assignedTo) db.update('serviceTasks', t.id, { assignedTo: o.assignedTo }, { silent: true }); }
  }, null));
  function activateAmc(o) {
    const prev = o.contractId ? db.get('amcContracts', o.contractId) : null;
    const start = prev && notBefore(prev.end) ? util.addDays(parseD(prev.end), 1) : T0();
    const q = o.quote || {};
    const visits = amcVisits();
    const c = db.insert('amcContracts', {
      customerId: o.customerId, siteId: o.siteId, division: o.division, assetIds: o.assetIds || [], type: q.amcType || 'Comprehensive',
      start: util.iso(start), end: util.iso(util.addDays(addMonths(start, 12), -1)), value: q.amount || o.estValue, status: 'Active',
      pmFrequencyMonths: Math.round(12 / visits), pmVisitsPerYear: visits, oppId: o.id, renewedFrom: prev ? prev.id : null, createdBy: o.createdBy, closedBy: me(),
      billing: { status: 'To be billed' }, lastPmDate: null, nextPmDue: null,
    }, { prefix: 'AMC' });
    if (prev) db.update('amcContracts', prev.id, { status: 'Renewed', renewedTo: c.id });
    (o.assetIds || []).forEach((id) => db.update('assets', id, { amcId: c.id, amcStart: c.start, amcEnd: c.end }, { silent: true }));
    createPmPlanForAmc(c);
    CRM.notify({ to: ['pm_coordinator', 'accounts'], title: 'AMC activated ' + c.id + ' — ' + custName(c.customerId), body: c.type + ' · ' + fmt.money(c.value) + ' · ' + fmt.date(c.start) + ' → ' + fmt.date(c.end) + ' · ' + visits + ' PM visits auto-scheduled · ready for billing', link: '#/amc/' + c.id, severity: 'ok', key: 'amc-act-' + c.id });
    CRM.notify({ to: ['pm_coordinator'], title: 'Email to customer: AMC renewal confirmation', body: 'Renewal confirmation sent to ' + custName(c.customerId), channel: 'Email', link: '#/amc/' + c.id, key: 'amc-conf-' + c.id });
    return c;
  }
  // 60/30/0-day AMC renewal and 90/30-day warranty conversion triggers (Service doc AMC §5.1, §5.2)
  // customer-facing reminder (Email / WhatsApp per channel config) — simulated delivery; integration hook = 'customer.message' event
  function remindCustomer(kind, rec, stage, text, lk) {
    const chans = cfgGet('channels.' + kind, null) || (cfg().customerChannels || {})[kind] || ['Email', 'WhatsApp'];
    const cust = master.customer(rec.customerId) || {};
    const title = kind === 'amcRenewal' ? 'AMC renewal reminder' : 'Warranty expiry reminder';
    [].concat(chans).forEach((ch) => {
      const to = ch === 'Email' ? (cust.email || cust.name) : (cust.phone || cust.name);
      const n = CRM.notify({ to: ['pm_coordinator'], title: ch + ' to customer: ' + title + ' (' + stage + ')', body: 'To ' + to + ' · ' + text, channel: ch + ' (simulated)', link: lk, key: 'cust-' + kind + '-' + rec.id + '-' + stage + '-' + ch });
      if (n) CRM.emit('customer.message', { channel: ch, customerId: rec.customerId, to, template: kind, stage, text, ref: rec.id });
    });
  }
  const stageOf = (days, list) => { if (days <= 0) return 'On expiry'; const t = list.slice().sort((a, b) => a - b).find((x) => days <= x); return (t || Math.max.apply(null, list)) + ' days'; };
  function runAmcAutomation(silent) {
    let created = 0;
    const rd = cfg().reminderDays || { amc: [60, 30], warranty: [90, 30] };
    const amcWin = Math.max.apply(null, rd.amc || [60]); const wtyWin = Math.max.apply(null, rd.warranty || [90]);
    db.all('amcContracts').forEach((c) => {
      const days = util.daysBetween(CRM.TODAY, parseD(c.end));
      if (c.status === 'Active' && days < 0) db.update('amcContracts', c.id, { status: 'Expired' }, { silent: true, note: 'AMC expired' });
      if (!['Active', 'Expired'].includes(c.status) || days > amcWin || days < -45) return;
      const stage = stageOf(days, rd.amc || [60, 30]);
      let opp = db.one('amcOpportunities', (o) => o.contractId === c.id);
      if (!opp) {
        opp = createOpp({ type: 'AMC Renewal', customerId: c.customerId, siteId: c.siteId, division: c.division, assetIds: c.assetIds, contractId: c.id, estValue: Math.round(c.value * 1.05), expectedClose: util.iso(util.addDays(c.end, -5)), trigger: stage + ' before expiry', productDetails: (c.assetIds || []).map((id) => (db.get('assets', id) || {}).name).filter(Boolean).slice(0, 3).join(', ') }, { silent: !!silent });
        created++;
      }
      CRM.notify({ to: ['pm_coordinator'], title: 'AMC renewal alert (' + stage + '): ' + custName(c.customerId), body: c.id + ' expires ' + fmt.date(c.end) + ' · opportunity ' + opp.id + ' assigned to coordinator', link: '#/amc/' + opp.id, severity: days <= 0 ? 'bad' : 'warn', key: 'amc-ren-' + c.id + '-' + stage });
      if (days > 0 && c.status === 'Active') remindCustomer('amcRenewal', c, stage, 'Your ' + c.division + ' AMC ' + c.id + ' expires on ' + fmt.date(c.end) + '. Renew now to keep free service and 3 preventive maintenance visits. — Team Maruthi', '#/amc/' + c.id);
    });
    const groups = {};
    db.all('assets').forEach((a) => {
      if (a.status !== 'Active' || activeAmcFor(a)) return;
      const days = util.daysBetween(CRM.TODAY, parseD(a.warrantyEnd));
      if (days < 0 || days > wtyWin) return;
      const k = a.customerId + '|' + a.division; (groups[k] = groups[k] || []).push(a);
    });
    Object.keys(groups).forEach((k) => {
      const list = groups[k]; const a0 = list[0]; const days = util.daysBetween(CRM.TODAY, parseD(a0.warrantyEnd));
      const stage = stageOf(days, rd.warranty || [90, 30]);
      let opp = db.one('amcOpportunities', (o) => o.type === 'Warranty Conversion' && o.customerId === a0.customerId && o.division === a0.division && !['Won', 'Lost'].includes(o.status));
      if (!opp && !db.one('amcOpportunities', (o) => o.type === 'Warranty Conversion' && (o.assetIds || []).includes(a0.id))) {
        opp = createOpp({ type: 'Warranty Conversion', customerId: a0.customerId, siteId: a0.siteId, division: a0.division, assetIds: list.map((x) => x.id), estValue: amcQuoteAmount({ assetIds: list.map((x) => x.id), amcType: 'Comprehensive' }), expectedClose: a0.warrantyEnd, trigger: stage + ' before warranty expiry', productDetails: list.map((x) => x.name).slice(0, 3).join(', ') }, { silent: !!silent });
        created++;
      }
      if (opp) CRM.notify({ to: ['pm_coordinator'], title: 'Warranty → AMC conversion (' + stage + '): ' + custName(a0.customerId), body: list.length + ' asset(s) warranty ends ' + fmt.date(a0.warrantyEnd) + ' · tagged “Warranty Conversion”', link: '#/amc/' + opp.id, severity: 'warn', key: 'wty-' + k + '-' + stage });
      remindCustomer('warrantyExpiry', { id: k.replace('|', '-'), customerId: a0.customerId }, stage, 'Warranty on your ' + list.map((x) => x.name).slice(0, 2).join(', ') + ' ends on ' + fmt.date(a0.warrantyEnd) + '. Convert to an AMC for uninterrupted cover. — Team Maruthi', opp ? '#/amc/' + opp.id : '#/amc');
    });
    return created;
  }

  // ================================================================ PM — plans, visits, next-date logic, automation
  const checklistFor = (type) => cfg().checklists[type] || cfg().checklists.UPS;
  function pmState(v) {
    if (v.completedDate) return 'Completed';
    if (v.status === 'Cancelled') return 'Cancelled';
    if (parseD(v.dueDate) < CRM.TODAY) return 'Overdue';
    return v.scheduledDate ? 'Scheduled' : 'Due';
  }
  const pmOnTime = (v) => v.completedDate && util.daysBetween(parseD(v.dueDate), parseD(v.completedDate)) <= cfg().pmGraceDays;
  // all AMCs get the same configurable number of PM visits a year (Service doc PM §2: 3 visits, every 4 months)
  const amcVisits = () => Math.max(1, Math.min(12, Number(cfg().amcPmVisitsPerYear) || 3));
  const pmFreqFor = (division, eqType) => Number((cfg().pmFrequencyEq || {})[eqType]) || cfg().pmFrequency[division] || 4;
  function bestEngineerFor(division) { const l = master.staff('service_engineer').filter((s) => s.division === division); return (l[0] || master.staff('service_engineer')[0] || {}).id; }
  function createPmPlanForAmc(c, opts) {
    const assets = (c.assetIds || []).map((id) => db.get('assets', id)).filter(Boolean);
    const type = assets[0] ? assets[0].eqType : (c.division === 'Solar' ? 'Solar' : c.division === 'Power' ? 'UPS' : 'CCTV');
    const visits = Number(c.pmVisitsPerYear) || amcVisits();
    const freq = Number(c.pmFrequencyMonths) || Math.round(12 / visits);
    const plan = db.insert('pmPlans', { amcId: c.id, customerId: c.customerId, siteId: c.siteId, division: c.division, systemType: type, assetIds: c.assetIds || [], deviceCount: util.sum(assets, (a) => a.qty || 1), capacity: assets.map((a) => a.capacity).filter(Boolean).join(', '), projectId: (assets[0] || {}).projectId || null, coverage: 'AMC', frequencyMonths: freq, coordinatorId: 'EMP-pm_coordinator', engineerId: bestEngineerFor(c.division), checklistVersion: cfg().checklistVersion[type] || 'v1.0', lastPmDate: null, active: true }, Object.assign({ prefix: 'PMP' }, opts || {}));
    const n = Math.max(1, Math.min(visits, Math.floor(12 / freq) || 1));
    for (let i = 1; i <= n; i++) createPmVisit(plan, util.iso(util.addDays(addMonths(c.start, i * freq), -1)), opts);
    syncPlan(plan.id, opts);
    return plan;
  }
  function createPmVisit(plan, due, opts) {
    return db.insert('pmVisits', { planId: plan.id, amcId: plan.amcId || null, customerId: plan.customerId, siteId: plan.siteId, division: plan.division, systemType: plan.systemType, assetIds: plan.assetIds, dueDate: due, scheduledDate: null, engineerId: plan.engineerId, stage: 0, checklist: {}, findings: '', defects: false }, Object.assign({ prefix: 'PMV' }, opts || {}));
  }
  function syncPlan(planId, opts) {
    const plan = db.get('pmPlans', planId); if (!plan) return;
    const vs = db.find('pmVisits', (v) => v.planId === planId);
    const done = vs.filter((v) => v.completedDate).sort((a, b) => (a.completedDate > b.completedDate ? -1 : 1))[0];
    const next = vs.filter((v) => !v.completedDate && v.status !== 'Cancelled').sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1))[0];
    const o = Object.assign({ silent: true }, opts || {});
    db.update('pmPlans', planId, { lastPmDate: done ? done.completedDate : null, nextDue: next ? next.dueDate : null }, o);
    if (plan.amcId) db.update('amcContracts', plan.amcId, { lastPmDate: done ? done.completedDate : null, nextPmDue: next ? next.dueDate : null }, o);
  }
  // next-PM-date logic after a completed visit (Service doc PM §5.2; Solar §6.4)
  function scheduleNextPm(v) {
    const plan = db.get('pmPlans', v.planId); if (!plan) return null;
    const pending = db.find('pmVisits', (x) => x.planId === plan.id && !x.completedDate && x.id !== v.id);
    let nv = null;
    if (!pending.length) {
      const amc = plan.amcId ? db.get('amcContracts', plan.amcId) : null;
      const limit = amc ? parseD(amc.end) : plan.coverageEnd ? parseD(plan.coverageEnd) : addMonths(CRM.TODAY, 24);
      const nd = addMonths(v.completedDate, plan.frequencyMonths || 4);
      if (nd <= limit) nv = createPmVisit(plan, util.iso(nd));
    }
    syncPlan(plan.id, { silent: false });
    return nv;
  }
  function runPmAutomation() {
    db.all('pmVisits').forEach((v) => {
      if (v.completedDate || v.status === 'Cancelled') return;
      const days = util.daysBetween(CRM.TODAY, v.dueDate);
      const lk = '#/pm/' + v.id;
      if (days >= 0 && days <= 7 && !v.scheduledDate) CRM.notify({ to: ['pm_coordinator'], title: 'PM approaching due date: ' + custName(v.customerId), body: v.id + ' · ' + v.systemType + ' · due ' + fmt.date(v.dueDate) + ' — plan visit & assign engineer', link: lk, severity: 'info', key: 'pm-due-' + v.id });
      if (days < 0) CRM.notify({ to: ['pm_coordinator', 'service_engineer'], title: 'PM overdue: ' + custName(v.customerId), body: v.id + ' was due ' + fmt.date(v.dueDate) + ' (' + Math.abs(days) + 'd overdue) · owner ' + master.staffName(v.engineerId), link: lk, severity: 'warn', key: 'pm-od-' + v.id });
      if (days < -cfg().pmGraceDays) CRM.notify({ to: ['odm', 'service_coordinator'], title: 'PM overdue escalated to manager: ' + v.id, body: custName(v.customerId) + ' · ' + Math.abs(days) + ' days overdue', link: lk, severity: 'bad', key: 'pm-od2-' + v.id });
    });
  }
  function runSlaAlerts() {
    db.all('complaints').forEach((c) => {
      if (!isOpen(c) || hrsSince(c.createdAt) > 24 * 10) return;
      const lk = '#/complaints/' + c.id;
      if (!c.ackAt && slaState(c, 'ack') === 'Breached') CRM.notify({ to: ['service_coordinator'], title: 'Acknowledgement SLA breached: ' + c.id, body: custName(c.customerId) + ' · not acknowledged within ' + dur(slaHours(c, 'ack')), link: lk, severity: 'bad', key: 'sla-ack-' + c.id });
      // Case 2 observation: revisit due / overdue
      const ob = c.observation;
      if (ob && !ob.outcome && ob.revisitAt && hrsSince(ob.revisitAt) > -2) CRM.notify({ to: ['service_engineer', 'service_coordinator'], title: 'Observation revisit ' + (hrsSince(ob.revisitAt) > 0 ? 'overdue' : 'due') + ': ' + c.id, body: custName(c.customerId) + ' · monitoring window ' + ob.hours + 'h · revisit ' + fmt.dateTime(ob.revisitAt) + ' · ' + master.staffName(c.engineerId), link: lk, severity: hrsSince(ob.revisitAt) > 0 ? 'bad' : 'warn', key: 'obs-' + c.id + '-' + ob.revisitAt });
      ['attend', 'resolve'].forEach((k) => {
        const s = slaState(c, k);
        if (s === 'At risk') CRM.notify({ to: ['service_coordinator', 'service_engineer'], title: 'Service SLA at risk (' + k + '): ' + c.id, body: custName(c.customerId) + ' · due ' + fmt.dateTime(dueAt(c, k)), link: lk, severity: 'warn', key: 'sla-risk-' + k + '-' + c.id });
        if (s === 'Breached') CRM.notify({ to: ['service_coordinator', 'service_engineer'], title: (k === 'attend' ? 'Attendance' : 'Resolution') + ' SLA breached: ' + c.id, body: custName(c.customerId) + ' · ' + c.priority + ' · ' + slaHours(c, k) + 'h SLA', link: lk, severity: 'bad', key: 'sla-br-' + k + '-' + c.id });
      });
    });
  }

  // ================================================================ ODM — policy evaluation engine
  // Each detector returns candidates { recId, col, link, division, customerId, ownerId, start, incidentAt, cleared, clearedAt, evidence, severity? }.
  const WINDOW_DAYS = 120;
  const recent = (d, days) => d && util.daysBetween(d, CRM.TODAY) <= (days || WINDOW_DAYS);
  const closedLike = (s) => /lost|won|closed|drop|cancel|convert|order|reject/i.test(String(s || ''));
  const hrsAdd = (d, hrs) => new Date(new Date(d).getTime() + hrs * HR);
  // rule threshold in hours; a blank threshold falls back to the documented default instead of 0 h
  const thr = (r, def) => (r.threshold === null || r.threshold === undefined || r.threshold === '' || isNaN(Number(r.threshold)) ? def : Number(r.threshold));
  function breachCand(startAt, hrs, doneAtTs, extra) {
    const due = hrsAdd(startAt, hrs);
    if (doneAtTs) { if (new Date(doneAtTs) <= due) return null; return Object.assign({ incidentAt: due.toISOString(), cleared: true, clearedAt: doneAtTs }, extra); }
    if (Date.now() <= due) return null;
    return Object.assign({ incidentAt: due.toISOString(), cleared: false }, extra);
  }
  const cmpBase = (c) => ({ recId: c.id, col: 'complaints', link: '#/complaints/' + c.id, division: c.division, customerId: c.customerId });
  const svcCalls = () => db.all('complaints').filter((c) => c.status !== 'Cancelled' && recent(c.createdAt) && !['Installation', 'Project Installation', 'Pre-Sale Support'].includes(c.callType));
  const salesOwner = (x) => x.execId || x.ownerId || x.assignedTo || x.salesExecId || x.execId || x.executiveId || 'EMP-sales_exec';
  const DETECTORS = {
    'SVC-ACK': () => svcCalls().map((c) => slaBreachCand(c, 'ack', c.ackAt, Object.assign(cmpBase(c), { ownerId: c.coordinatorId, evidence: 'Registered ' + fmt.dateTime(c.createdAt) + ' · SLA ' + dur(slaHours(c, 'ack')) + (c.ackAt ? ' · acknowledged ' + fmt.dateTime(c.ackAt) : ' · not acknowledged') }))),
    'SVC-ATT-P': () => svcCalls().filter((c) => c.division === 'Power').map((c) => slaBreachCand(c, 'attend', c.attendedAt || (c.closedAt && c.remote ? c.closedAt : null), Object.assign(cmpBase(c), { ownerId: c.engineerId || c.coordinatorId, severity: c.priority === 'Low' ? 'Medium' : 'High', evidence: c.priority + ' priority · SLA ' + slaHours(c, 'attend') + 'h · ' + (c.attendedAt ? 'attended ' + fmt.dateTime(c.attendedAt) : 'not attended') }))),
    'SVC-ATT-ES': () => svcCalls().filter((c) => c.division !== 'Power').map((c) => slaBreachCand(c, 'attend', c.attendedAt || (c.closedAt && c.remote ? c.closedAt : null), Object.assign(cmpBase(c), { ownerId: c.engineerId || c.coordinatorId, severity: c.priority === 'Critical' ? 'Critical' : 'High', evidence: c.division + ' · ' + c.priority + ' · SLA ' + slaHours(c, 'attend') + 'h · ' + (c.attendedAt ? 'attended ' + fmt.dateTime(c.attendedAt) : 'not attended') }))),
    'SVC-RES': () => svcCalls().map((c) => slaBreachCand(c, 'resolve', c.resolvedAt, Object.assign(cmpBase(c), { ownerId: c.engineerId || c.coordinatorId, evidence: 'Resolution SLA ' + slaHours(c, 'resolve') + 'h · ' + (c.resolvedAt ? 'resolved ' + fmt.dateTime(c.resolvedAt) : 'still open') }))),
    'SVC-OPEN1': (r) => svcCalls().filter((c) => c.attendedAt && (isOpen(c) || recent(c.closedAt, 60))).map((c) => breachCand(c.attendedAt, thr(r, 36), c.closedAt, Object.assign(cmpBase(c), { ownerId: c.engineerId, evidence: 'Attended ' + fmt.dateTime(c.attendedAt) + ' · open ' + dur(((c.closedAt ? new Date(c.closedAt) : Date.now()) - new Date(c.attendedAt)) / HR) }))),
    'SVC-OPEN2': (r) => svcCalls().filter((c) => c.attendedAt && (isOpen(c) || recent(c.closedAt, 60))).map((c) => breachCand(c.attendedAt, thr(r, 40), c.closedAt, Object.assign(cmpBase(c), { ownerId: c.engineerId, evidence: 'Attended but open in the 36–48h band (> ' + thr(r, 40) + 'h · ' + (c.openSub || 'no sub-status') + ')' }))),
    'SVC-TRC': (r) => svcCalls().filter((c) => c.attendedAt && c.trcAt).map((c) => breachCand(c.trcAt, thr(r, 36), c.closedAt || c.trcClearedAt, Object.assign(cmpBase(c), { ownerId: c.engineerId, evidence: 'Observation (TRC) since ' + fmt.dateTime(c.trcAt) }))),
    'SVC-CHG': (r) => db.all('complaints').filter((c) => c.chargeable && c.resolvedAt && recent(c.resolvedAt)).map((c) => breachCand(c.resolvedAt, thr(r, 24), (c.payment || {}).receivedAt, Object.assign(cmpBase(c), { ownerId: c.engineerId || c.coordinatorId, evidence: 'Charges ' + fmt.money(c.charges) + ' · payment ' + ((c.payment || {}).status || 'Pending') }))),
    'SVC-STBY': (r) => db.all('complaints').filter((c) => c.standby && c.standby.issuedAt && recent(c.standby.issuedAt)).map((c) => breachCand(c.standby.issuedAt, thr(r, 168), c.standby.collectedAt, Object.assign(cmpBase(c), { ownerId: c.engineerId, evidence: 'Standby ' + c.standby.item + ' issued ' + fmt.date(c.standby.issuedAt) }))),
    'PM-OVD': (r) => db.all('pmVisits').filter((v) => v.status !== 'Cancelled' && recent(v.dueDate, 150) && parseD(v.dueDate) <= CRM.TODAY).map((v) => breachCand(v.dueDate + 'T18:00:00', thr(r, 168), v.completedDate ? v.completedDate + 'T18:00:00' : null, { recId: v.id, col: 'pmVisits', link: '#/pm/' + v.id, division: v.division, customerId: v.customerId, ownerId: v.engineerId, evidence: v.systemType + ' PM due ' + fmt.date(v.dueDate) + (v.completedDate ? ' · done ' + fmt.date(v.completedDate) : ' · not completed') })),
    'CX-ESC': () => db.all('escalations').map((e) => ({ recId: e.id, col: 'escalations', link: '#/escalations', division: e.division, customerId: e.customerId, ownerId: e.ownerId, incidentAt: e.date, cleared: e.status === 'Resolved', clearedAt: e.resolvedAt, severity: e.severity === 'Low' ? 'High' : 'Critical', evidence: e.reason + ' · responsible: ' + e.department })),
    'CX-NEG': () => db.all('feedback').filter((f) => f.rating <= cfg().negativeRating).map((f) => ({ recId: f.id, col: 'feedback', link: f.complaintId ? '#/complaints/' + f.complaintId : '#/escalations', division: f.division, customerId: f.customerId, ownerId: f.engineerId, incidentAt: f.createdAt, cleared: !!f.actionAt, clearedAt: f.actionAt, evidence: 'Rating ' + f.rating + '/5 · “' + (f.comment || '') + '”' })),
    'AMC-QUO': () => db.all('amcContracts').filter((c) => ['Active', 'Expired'].includes(c.status) && util.daysBetween(CRM.TODAY, c.end) <= 30 && util.daysBetween(CRM.TODAY, c.end) > -60).map((c) => {
      const o = db.one('amcOpportunities', (x) => x.contractId === c.id);
      const sent = o && o.quote && o.quote.sentAt;
      return breachCand(util.addDays(c.end, -30), 0, sent || (o && o.status === 'Won' ? o.closedAt : null), { recId: c.id, col: 'amcContracts', link: '#/amc/' + (o ? o.id : c.id), division: c.division, customerId: c.customerId, ownerId: o ? o.assignedTo : 'EMP-pm_coordinator', evidence: 'AMC ' + c.id + ' expires ' + fmt.date(c.end) + ' · ' + (o ? 'opportunity ' + o.id + ' ' + o.status : 'no opportunity') });
    }),
    'AMC-PAY': () => db.all('amcContracts').filter((c) => c.billing && c.billing.billedAt && recent(c.billing.billedAt, 200)).map((c) => breachCand(c.billing.billedAt, (master.customer(c.customerId) || {}).creditDays * 24 || rule('AMC-PAY').threshold, c.billing.paidAt, { recId: c.id, col: 'amcContracts', link: '#/amc/' + c.id, division: c.division, customerId: c.customerId, ownerId: 'EMP-accounts', evidence: 'Invoice ' + c.billing.invoiceNo + ' · ' + fmt.money(c.billing.amount) + ' billed ' + fmt.date(c.billing.billedAt) })),
    'INS-DLY': (r) => db.all('complaints').filter((c) => c.callType === 'Installation' && c.orderId && recent(c.createdAt)).map((c) => {
      const o = db.get('orders', c.orderId) || {};
      const start = anyField(o, ['soIssuedDate', 'approvedAt']) || c.createdAt;
      const done = c.closedAt || c.installedAt || (o.installationCompletionDate ? o.installationCompletionDate + 'T18:00:00' : null);
      return breachCand(start, thr(r, 24), done, Object.assign(cmpBase(c), { ownerId: c.engineerId || c.coordinatorId, evidence: 'SO ' + (c.soNumber || c.orderId) + ' issued ' + fmt.dateTime(start) + ' · installation ' + (done ? 'completed ' + fmt.dateTime(done) : 'pending') }));
    }),
    'INS-SCR': (r) => {
      const own = db.all('complaints').filter((c) => c.callType === 'Installation' && c.scrapApplicable && c.closedAt && recent(c.closedAt) && !(db.get('orders', c.orderId) || {}).hasOwnProperty('scrapCollected')).map((c) => breachCand(c.closedAt, thr(r, 24), c.scrapCollectedAt, Object.assign(cmpBase(c), { ownerId: c.engineerId, evidence: 'Scrap applicable at installation · ' + (c.scrapCollectedAt ? 'collected ' + fmt.date(c.scrapCollectedAt) : 'not collected') })));
      const ext = CRM.projects ? [] : db.all('scrap').filter((s) => recent(s.createdAt) && !anyField(s, ['collectedAt', 'collectedDate']) && /identif|pending|to collect/i.test(s.status || 'pending')).map((s) => breachCand(s.createdAt, thr(r, 24), null, { recId: s.id, col: 'scrap', link: '', division: s.division || 'Power', customerId: s.customerId, ownerId: s.collectedBy || s.engineerId, evidence: 'Scrap ' + (s.scrapType || s.type || '') + ' × ' + (s.quantity || s.qty || 1) + ' · status ' + (s.status || 'pending') }));
      return own.concat(ext);
    },
    'INS-COM': (r) => db.all('projects').filter((p) => recent(p.createdAt, 200)).map((p) => {
      const inst = anyField(p, ['installCompletedAt', 'installedAt', 'installationCompletedAt']);
      if (!inst) return null;
      return breachCand(inst, thr(r, 48), anyField(p, ['commissionedAt', 'commissioningCertAt', 'commissioningReportAt', 'commissioningAt']), { recId: p.id, col: 'projects', link: '', division: p.division, customerId: p.customerId, ownerId: p.engineerId || p.ownerId || p.coordinatorId, evidence: 'Installation completed ' + fmt.date(inst) + ' · commissioning certificate pending' });
    }),
    'INS-PAY': () => {
      const pays = db.all('payments');
      return db.all('orders').filter((o) => recent(anyField(o, ['date', 'soDate', 'createdAt']), 150) && Number(o.value) > 0).map((o) => {
        const paid = util.sum(pays.filter((p) => p.orderId === o.id || (p.soNumber && p.soNumber === o.soNumber)), (p) => p.amount);
        if (Number(o.value) - paid <= 1) return null;
        const cd = (master.customer(o.customerId) || {}).creditDays || cfg().creditDays;
        return breachCand(anyField(o, ['date', 'soDate', 'createdAt']), cd * 24, null, { recId: o.id, col: 'orders', link: '', division: o.division, customerId: o.customerId, ownerId: salesOwner(o), evidence: 'SO ' + (o.soNumber || o.id) + ' · outstanding ' + fmt.money(Number(o.value) - paid) + ' beyond ' + cd + ' credit days' });
      });
    },
    'SAL-QUO': (r) => {
      const qs = db.all('quotations');
      return db.all('enquiries').filter((e) => recent(e.createdAt, 60) && !/lost|drop|cancel/i.test(e.status || e.stage || '')).map((e) => {
        const q = qs.filter((x) => x.enquiryId === e.id).sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1))[0];
        return breachCand(anyField(e, ['enquiryDate', 'createdAt']), thr(r, 24), q ? (q.sentAt || q.date || q.createdAt) : (closedLike(e.status || e.stage) ? e.updatedAt : null), { recId: e.id, col: 'enquiries', link: '', division: e.division, customerId: e.customerId, ownerId: salesOwner(e), evidence: 'Enquiry ' + e.id + ' · ' + (q ? 'quotation ' + q.id + ' submitted ' + fmt.dateTime(q.sentAt || q.createdAt) : 'no quotation') });
      });
    },
    'SAL-SV': (r) => db.all('enquiries').filter((e) => recent(e.createdAt, 60) && (e.siteVisitRequired === true || (e.siteVisitRequired !== false && e.division !== 'Power')) && !/lost|drop|cancel/i.test(e.status || e.stage || '')).map((e) => {
      const done = anyField(e, ['siteVisitDoneAt', 'siteVisitCompletedAt', 'visitDoneAt', 'surveyDoneAt', 'siteVisitAt']) || (e.siteVisit && (e.siteVisit.completedAt || e.siteVisit.doneAt || e.siteVisit.date)) || (db.one('quotations', (q) => q.enquiryId === e.id) || {}).createdAt;
      return breachCand(anyField(e, ['enquiryDate', 'createdAt']), thr(r, 24), done, { recId: e.id, col: 'enquiries', link: '', division: e.division, customerId: e.customerId, ownerId: salesOwner(e), evidence: 'Site visit ' + (done ? 'completed ' + fmt.dateTime(done) : 'not completed') });
    }),
    'SAL-SO': (r) => {
      const orders = db.all('orders');
      return db.all('quotations').filter((q) => /approv|accept/i.test(q.status || '') || q.customerApprovedAt).map((q) => {
        const appr = anyField(q, ['customerApprovedAt', 'approvedAt', 'acceptedAt', 'updatedAt']);
        if (!recent(appr, 60)) return null;
        const o = orders.find((x) => x.quotationId === q.id || (q.enquiryId && x.enquiryId === q.enquiryId));
        return breachCand(appr, thr(r, 24), o ? anyField(o, ['date', 'soDate', 'createdAt']) : null, { recId: q.id, col: 'quotations', link: '', division: q.division, customerId: q.customerId, ownerId: salesOwner(q), evidence: 'Quotation ' + q.id + ' approved ' + fmt.dateTime(appr) + ' · ' + (o ? 'SO ' + (o.soNumber || o.id) : 'no Sales Order') });
      });
    },
    'PRJ-STG': () => db.all('projects').map((p) => {
      const end = anyField(p, ['committedDate', 'plannedEnd', 'expectedCompletion', 'targetDate', 'dueDate', 'plannedEndDate']);
      if (!end || p.handoverAt || /closed|handover|handed|complete|cancel|hold/i.test(p.status || p.stage || '')) return null;
      return breachCand(end, 24, null, { recId: p.id, col: 'projects', link: '', division: p.division, customerId: p.customerId, ownerId: p.coordinator || p.engineer || p.engineerId || p.ownerId || p.coordinatorId, evidence: (p.name || p.title || p.id) + ' · committed completion ' + fmt.date(end) + ' · stage ' + (p.stage || p.status || '—') });
    }),
  };

  function levelFor(r, c) {
    const over = ((c.cleared && c.clearedAt ? new Date(c.clearedAt) : Date.now()) - new Date(c.incidentAt)) / HR;
    let lvl = r.startLevel || 1;
    (r.levels || [0, 6, 12, 24, 48]).slice(1).forEach((off, i) => { if (off != null && off !== '' && over >= Number(off) && i + 2 > lvl) lvl = i + 2; });
    return Math.min(MAX_LVL, lvl);
  }
  function ladderRoles(area, lvl) { const l = ladderOf(area); return l[Math.max(0, Math.min(MAX_LVL - 1, lvl - 1))] || ['odm']; }
  const ESC_CHANNEL = 'In-app + Email';
  function ownerRoleOf(id) { const s = db.get('staff', id); return s ? s.role : (CRM.roles.some((r) => r.id === id) ? id : null); }

  function upsertViolation(r, c, opts) {
    const key = c.key || (r.id + ':' + c.recId);
    let v = db.one('violations', (x) => x.key === key);
    const lvl = levelFor(r, c);
    const fresh = !c.cleared && hrsSince(c.incidentAt) < 72;
    if (!v) {
      v = db.insert('violations', {
        key, ruleId: r.id, policyRef: r.policyRef, title: r.name, area: r.area, department: r.area, division: c.division || null, col: c.col, recId: c.recId, link: c.link, customerId: c.customerId || null,
        ownerId: c.ownerId || null, ownerRole: ownerRoleOf(c.ownerId), incidentAt: new Date(c.incidentAt).toISOString(), detectedAt: now().toISOString(), evidence: c.evidence || '', severity: c.severity || r.severity,
        kind: 'Confirmed', correctiveAction: '', dueDate: util.iso(util.addDays(new Date(Math.max(Date.now(), new Date(c.incidentAt))), (c.severity || r.severity) === 'Critical' ? 1 : 3)),
        escalationLevel: lvl, escalationLog: [{ at: now().toISOString(), level: lvl, to: ladderRoles(r.area, lvl) }], status: 'Open', cleared: !!c.cleared, clearedAt: c.clearedAt || null,
      }, { prefix: 'VIO', silent: true });
      if (fresh && !(opts && opts.quiet)) {
        CRM.notify({ to: ladderRoles(r.area, lvl).concat(['odm']), title: 'Policy violation: ' + r.name, body: v.id + ' · ' + custName(v.customerId) + ' · ' + v.evidence + ' · ' + LEVEL_NAMES[lvl - 1], link: '#/violations/' + v.id, severity: ['High', 'Critical'].includes(v.severity) ? 'bad' : 'warn', channel: ESC_CHANNEL, key: 'vio-' + key + '-L' + lvl });
      }
      return 1;
    }
    const patch = {};
    if (!v.cleared && c.cleared) { patch.cleared = true; patch.clearedAt = c.clearedAt; }
    if (!['Closed', 'Exception'].includes(v.status) && lvl > (v.escalationLevel || 1) && !v.cleared) {
      patch.escalationLevel = lvl; patch.escalationLog = (v.escalationLog || []).concat([{ at: now().toISOString(), level: lvl, to: ladderRoles(r.area, lvl) }]);
      if (!(opts && opts.quiet)) CRM.notify({ to: ladderRoles(r.area, lvl), title: 'Escalated to ' + LEVEL_NAMES[lvl - 1] + ': ' + r.name, body: v.id + ' · ' + custName(v.customerId) + ' · ' + v.evidence, link: '#/violations/' + v.id, severity: 'bad', channel: ESC_CHANNEL, key: 'vio-' + key + '-L' + lvl });
    }
    if (Object.keys(patch).length) db.update('violations', v.id, patch, { silent: true });
    return 0;
  }
  // Rules the Sales module evaluates itself with its own fields (raised to us through violation.raise)
  const OWNED_ELSEWHERE = { 'SAL-QUO': () => !!CRM.sales, 'SAL-SV': () => !!CRM.sales, 'SAL-SO': () => !!CRM.sales, 'INS-PAY': () => !!CRM.sales };
  const EXT_MAP = [[/^quotation delay/i, 'SAL-QUO'], [/^site visit delay/i, 'SAL-SV'], [/approval pending so/i, 'SAL-SO'], [/payment collection delay/i, 'INS-PAY'], [/scrap collection delay/i, 'INS-SCR'], [/^installation delay/i, 'INS-DLY'], [/commissioning certificate/i, 'INS-COM']];
  function evaluatePolicies(opts) {
    let created = 0;
    db.all('violations').filter((v) => v.external && !v.cleared && !['Closed', 'Exception'].includes(v.status)).forEach((v) => { const r = rule(v.ruleId) || { id: v.ruleId, name: v.title, area: v.area, levels: [0, 6, 12, 24, 48], startLevel: 1 }; upsertViolation(r, { key: v.key, recId: v.recId, incidentAt: v.incidentAt, cleared: false }, hrsSince(v.incidentAt) > 24 * 7 ? { quiet: true } : opts); });
    cfg().rules.filter((r) => r.enabled).forEach((r) => {
      const fn = DETECTORS[r.id]; if (!fn || (OWNED_ELSEWHERE[r.id] && OWNED_ELSEWHERE[r.id]())) return;
      const list = safe(() => (fn(r) || []).filter(Boolean), []);
      list.sort((a, b) => new Date(b.incidentAt) - new Date(a.incidentAt)).slice(0, 40).forEach((c) => { created += upsertViolation(r, c, opts); });
    });
    return created;
  }
  const evaluateSoon = util.debounce(() => { safe(() => evaluatePolicies(), 0); }, 600);
  function runAutomation(opts) {
    const a = safe(() => runAmcAutomation(opts && opts.silent), 0);
    safe(() => runPmAutomation(), 0);
    safe(() => runSlaAlerts(), 0);
    const v = safe(() => evaluatePolicies(opts), 0);
    return { opps: a, violations: v };
  }
  const repeatViolations = (v) => db.find('violations', (x) => x.ruleId === v.ruleId && x.ownerId && x.ownerId === v.ownerId).length;

  function raiseCustomerEscalation(v) {
    const e = db.insert('escalations', Object.assign({ status: 'Open', date: now().toISOString(), loggedBy: me() }, v), { prefix: 'ESC' });
    evaluatePolicies();
    CRM.notify({ to: ['odm', 'gm', 'service_coordinator'], title: 'Customer escalation ' + e.id + ' (' + e.severity + ')', body: custName(e.customerId) + ' · ' + e.reason + ' · responsible: ' + e.department, link: '#/escalations', severity: 'bad', key: 'esc-' + e.id });
    return e;
  }
  function recordFeedback(c, v) {
    const type = v.rating >= 4 ? 'Positive' : v.rating === 3 ? 'Neutral' : 'Negative';
    const f = db.insert('feedback', { complaintId: c ? c.id : null, customerId: c ? c.customerId : v.customerId, division: c ? c.division : v.division, engineerId: c ? c.engineerId : null, rating: Number(v.rating), type, comment: v.comment || '', channel: v.channel || 'Call' }, { prefix: 'FBK' });
    if (c) db.update('complaints', c.id, { feedbackId: f.id, rating: f.rating, step: 10 }, { note: 'Feedback captured: ' + f.rating + '/5' });
    if (f.rating <= cfg().negativeRating) {
      CRM.notify({ to: ['odm', 'gm', 'service_coordinator'], title: 'Negative feedback alert: ' + f.rating + '/5', body: custName(f.customerId) + (c ? ' · ' + c.id : '') + ' — immediate escalation to department head', link: c ? '#/complaints/' + c.id : '#/escalations', severity: 'bad', key: 'neg-' + f.id });
      evaluatePolicies();
    }
    return f;
  }

  // ================================================================ cross-module events
  CRM.on('violation.raise', (p) => {
    if (!p) return;
    const m = EXT_MAP.find(([re]) => re.test(p.type || ''));
    const mr = m ? rule(m[1]) : null;
    const key = (mr ? mr.id : 'EXT:' + (p.type || 'Violation')) + ':' + (p.recordId || p.link || p.details || util.uid());
    if (db.one('violations', (x) => x.key === key)) return;
    const owner = p.owner || null; const isStaff = owner && db.get('staff', owner);
    const area = mr ? mr.area : /sale|quot|enquir/i.test(p.type + p.policyRef) ? 'Sales' : /install|scrap|commission/i.test(p.type + p.policyRef) ? 'Installation' : /amc/i.test(p.type) ? 'AMC' : /service|complaint|pm/i.test(p.type) ? 'Service' : 'Projects';
    const sev = p.severity || (mr ? mr.severity : 'Medium');
    const v = db.insert('violations', {
      key, ruleId: mr ? mr.id : 'EXT', external: true, policyRef: p.policyRef || (mr ? mr.policyRef : '—'), title: mr ? mr.name : (p.type || 'Policy violation'), area, department: area, division: p.division || null, col: p.col || null, recId: p.recordId || null, link: p.link || '', customerId: p.customerId || null,
      ownerId: isStaff ? owner : null, ownerRole: isStaff ? isStaff.role : owner, incidentAt: p.at || now().toISOString(), detectedAt: now().toISOString(), evidence: p.details || '', severity: sev, kind: p.warning ? 'Warning' : 'Confirmed',
      correctiveAction: '', dueDate: util.iso(util.addDays(CRM.TODAY, sev === 'Critical' ? 1 : 3)), escalationLevel: 1, escalationLog: [{ at: now().toISOString(), level: 1, to: ['odm'] }], status: 'Open', cleared: false,
    }, { prefix: 'VIO', silent: true });
    if (!p.silent) CRM.notify({ to: ['odm'].concat(ownerRoleOf(owner) ? [ownerRoleOf(owner)] : []), title: 'Policy violation raised: ' + v.title, body: (p.details || '') + ' · ' + (p.policyRef || ''), link: '#/violations/' + v.id, severity: ['High', 'Critical'].includes(sev) ? 'bad' : 'warn', channel: ESC_CHANNEL, key: 'vio-' + key });
  });

  function pmPlanFromAssets(assets, base, opts) {
    if (!assets.length) return null;
    const a0 = assets[0];
    const freq = pmFreqFor(a0.division, a0.eqType);
    const plan = db.insert('pmPlans', Object.assign({ customerId: a0.customerId, siteId: a0.siteId, division: a0.division, systemType: a0.eqType, assetIds: assets.map((a) => a.id), deviceCount: util.sum(assets, (a) => a.qty || 1), capacity: assets.map((a) => a.capacity).filter(Boolean).join(', '), projectId: a0.projectId || null, orderId: a0.orderId || null, coverage: 'Warranty', coverageEnd: a0.warrantyEnd, frequencyMonths: freq, coordinatorId: 'EMP-pm_coordinator', engineerId: bestEngineerFor(a0.division), checklistVersion: cfg().checklistVersion[a0.eqType] || 'v1.0', lastPmDate: null, active: true }, base || {}), Object.assign({ prefix: 'PMP' }, opts || {}));
    createPmVisit(plan, util.iso(addMonths(a0.installDate, freq)), opts);
    syncPlan(plan.id, opts);
    return plan;
  }
  // project.handover equipment row → asset fields (make, model, camera tag separate from channel, capacity, warranty dates/terms)
  function handoverAsset(p, e, site) {
    const inst = util.iso(e.installDate || p.handoverAt || p.closedAt || CRM.TODAY);
    const wStart = e.warrantyStart ? util.iso(e.warrantyStart) : null, wEnd = e.warrantyEnd ? util.iso(e.warrantyEnd) : null;
    const wm = wStart && wEnd ? Math.max(1, Math.round(util.daysBetween(wStart, util.addDays(parseD(wEnd), 1)) / 30.44)) : undefined;
    return { customerId: p.customerId, siteId: site, projectId: p.id, division: p.division || (master.product(e.productId) || {}).division || 'Electronic Security', productId: e.productId, name: e.name, category: e.type, make: e.make || e.brand, model: e.model, serial: e.serial, location: e.location, channel: e.channel || '', tag: e.tag || '', capacity: e.capacity || (e.capacityKw ? e.capacityKw + ' kW' : p.capacityKw ? p.capacityKw + ' kW' : ''), qty: e.qty || 1, installDate: inst, commissionDate: util.iso(anyField(p, ['commissionedAt', 'commissioningAt', 'commissioningCertAt']) || inst), warrantyStart: wStart, warrantyEnd: wEnd, warrantyMonths: wm, warrantyTerms: e.warrantyTerms, commissioningReportNo: p.commissioningReportNo };
  }
  CRM.on('project.handover', (payload) => {
    const p = (payload && payload.project) || null; if (!p) return;
    if (db.one('assets', (a) => a.projectId === p.id)) return;
    const site = p.siteId || (master.sites(p.customerId)[0] || {}).id;
    const eq = (payload.equipment && payload.equipment.length) ? payload.equipment : [{ productId: p.productId, name: p.product || p.name || p.title }];
    const assets = eq.map((e) => createAsset(handoverAsset(p, e, site)));
    const groups = util.groupBy(assets, 'eqType');
    const plans = Object.keys(groups).map((k) => pmPlanFromAssets(groups[k]));
    CRM.notify({ to: ['pm_coordinator'], title: 'Handover received: ' + (p.name || p.title || p.id), body: assets.length + ' assets registered · warranty activated · ' + plans.length + ' PM plan(s) created for ' + custName(p.customerId), link: '#/pm', severity: 'ok', key: 'handover-' + p.id });
    CRM.notify({ to: ['service_coordinator'], title: 'New installed base: ' + custName(p.customerId), body: assets.length + ' equipment records added to the asset register (' + (p.division || '') + ')', link: '#/assets', key: 'handover-svc-' + p.id });
  });
  // projects.js created the installation project for a "Project Installation" call → link the complaint to it
  CRM.on('project.installation.created', (p) => safe(() => {
    const c = p && p.complaintId && db.get('complaints', p.complaintId);
    if (c && p.projectId && c.projectId !== p.projectId) db.update('complaints', c.id, { projectId: p.projectId }, { note: 'Linked to installation project ' + p.projectId });
  }, null));
  CRM.on('order.won', (payload) => {
    const o = (payload && payload.order) || null;
    if (!o || o.division !== 'Power' || db.one('assets', (a) => a.orderId === o.id) || db.one('complaints', (c) => c.orderId === o.id && c.callType === 'Installation')) return;
    powerOrderToService(o, false);
  });
  // Sales edits the SO (installation completed / scrap collected) → keep the single installation record and warranty in sync
  CRM.on('orders:updated', (o) => safe(() => {
    if (!o || o.division !== 'Power') return;
    const call = db.one('complaints', (c) => c.orderId === o.id && c.callType === 'Installation');
    if (o.installationCompletionDate) {
      if (call && !call.installedAt) updC(call, { installedAt: parseD(o.installationCompletionDate).toISOString() }, 'Installation completion synced from SO');
      if (db.one('assets', (a) => a.orderId === o.id && a.installPending)) applyInstallDate(o.id, util.iso(parseD(o.installationCompletionDate)));
    }
    if (call && o.scrapCollected && call.scrapApplicable && !call.scrapCollectedAt) updC(db.get('complaints', call.id), { scrapCollectedAt: now().toISOString() }, 'Scrap collection synced from SO');
  }, null));
  function powerOrderToService(o, silent) {
    const prod = master.product(o.productId) || master.products('Power').find((p) => p.name === o.product) || master.products('Power')[0];
    const qty = Math.max(1, Number(o.quantity) || 1);
    const site = o.siteId || (master.sites(o.customerId)[0] || {}).id;
    // provisional dates from the SO; warranty/PM are re-based on the actual installation date when the installation call closes
    const done = o.installationCompletionDate || o.installDate || null;
    const inst = done || util.iso(anyField(o, ['soIssuedDate', 'date', 'soDate', 'wonDate', 'createdAt']) || CRM.TODAY);
    const opt = silent ? { silent: true } : undefined;
    const assets = [];
    for (let i = 0; i < Math.min(qty, 3); i++) assets.push(createAsset({ customerId: o.customerId, siteId: site, orderId: o.id, soNumber: o.soNumber, division: 'Power', productId: prod.id, installDate: inst, installPending: !done, qty: qty > 3 && i === 2 ? qty - 2 : 1 }, opt));
    pmPlanFromAssets(assets, {}, opt);
    const isBatt = /Battery/i.test(prod.category + ' ' + prod.name);
    const call = createComplaint({ division: 'Power', customerId: o.customerId, siteId: site, assetId: assets[0].id, callType: 'Installation', category: 'Installation support', priority: 'Low', source: 'Sales Executive', description: 'Installation of ' + qty + ' × ' + prod.name + ' (SO ' + (o.soNumber || o.id) + ')', orderId: o.id, soNumber: o.soNumber, billValue: o.value, productType: prod.category, model: prod.name, qty,
      battery: isBatt ? { brand: /Exide/i.test(prod.name) ? 'Exide' : /SF/i.test(prod.name) ? 'SF' : (prod.brand || ''), model: prod.name, qty, capacity: capacityOf(prod, {}) } : null,
      instPayment: { mode: /advance/i.test(o.paymentTerms || '') ? 'UPI' : /credit/i.test(o.paymentTerms || '') ? 'Credit' : '', status: 'Pending', terms: o.paymentTerms || '' },
      scrapApplicable: o.scrapApplicable != null ? !!o.scrapApplicable : /Battery|Inverter/.test(prod.category), scrapType: o.scrapType || (isBatt ? 'Battery' : ''), scrapQty: Number(o.scrapQty) || 0,
      createdAt: silent ? new Date(String(anyField(o, ['soIssuedDate', 'createdAt']) || inst).slice(0, 10) + 'T10:30:00').toISOString() : undefined }, { silent });
    if (!silent) {
      CRM.notify({ to: ['service_coordinator'], title: 'Installation request auto-created from SO ' + (o.soNumber || o.id), body: call.id + ' · ' + qty + ' × ' + prod.name + ' · ' + custName(o.customerId) + ' (popup + email)', link: '#/complaints/' + call.id, key: 'inst-' + o.id });
      CRM.notify({ to: ['pm_coordinator'], title: 'Power order: warranty & PM plan activated', body: assets.length + ' asset(s) for ' + custName(o.customerId) + ' · warranty ' + (prod.warrantyMonths || 12) + ' months', link: '#/assets', key: 'po-pm-' + o.id });
    }
    return { assets, call };
  }

  // ================================================================ seed data (realistic, last ~6 months)
  const DESC = {
    'UPS not working': 'UPS not powering on after mains failure; continuous beep', 'Inverter not working': 'Inverter shows overload and trips within minutes', 'Low battery backup': 'Backup dropped from 3 hours to 40 minutes',
    'Battery issue (SF/Exide)': 'Battery bulging; terminals corroded, backup very low', 'Stabilizer fault': 'Servo stabilizer output stuck at 260V', 'Output voltage fluctuation': 'Output voltage fluctuating on load',
    'Camera not working': 'Two cameras at gate show no signal', 'No video / poor image quality': 'Night image hazy on parking cameras', 'DVR/NVR not working': 'NVR hangs and reboots frequently', 'Recording failure or missing playback': 'No playback for last 3 days',
    'Hard disk failure': 'HDD not detected on NVR', 'Remote viewing failure': 'Mobile app shows device offline', 'Fire alarm fault': 'Fire panel showing zone 3 fault with hooter sounding', 'Biometric device issue': 'Biometric not accepting fingerprints',
    'Generation below expected level': 'Generation 30% below last month on sunny days', 'Inverter fault / shutdown': 'Solar inverter shows grid fault and shuts down', 'Monitoring or communication failure': 'Monitoring portal not updating since a week',
  };
  const SPARES = { Power: ['SMPS card', 'Charging card', 'Cooling fan', 'Exide 150Ah Tubular battery', 'Carbon brush set', 'Control PCB', 'MOSFET set'], 'Electronic Security': ['Surveillance HDD 4TB', 'IP Dome Camera 4MP', 'PoE adapter', 'SMPS 12V 10A', 'RJ45 connector set', 'Smoke detector', 'Fire panel battery 12V 7Ah'], Solar: ['DC SPD', 'MC4 connector set', 'AC MCB 32A', 'WiFi data logger', 'String fuse'] };

  CRM.registerSeed((dbx, ctx) => {
    const { util: U } = ctx;
    cfg();
    const S = { silent: true };
    const NOW = Date.now();
    const iso = (ms) => new Date(Math.min(ms, NOW - 60e3)).toISOString();
    const engs = master.staff('service_engineer');
    const engFor = (d) => { const l = engs.filter((e) => e.division === d).map((e) => e.id); if (d !== 'Solar') l.push('EMP-service_engineer', 'EMP-service_engineer'); return U.pick(l.length ? l : ['EMP-service_engineer']); };
    const custs = master.customers();

    // ---- installed base (assets)
    const AGES = [330, 300, 345, 280, 520, 700, 910, 1130, 160, 75, 430, 820, 610, 1000];
    const pickProd = (d, cat) => U.pick(master.products(d).filter((p) => !cat || p.category === cat));
    custs.forEach((c, i) => {
      const site = (master.sites(c.id)[0] || {}).id;
      const divs = [['Power', 'Electronic Security'], ['Electronic Security'], ['Power', 'Solar'], ['Power'], ['Solar', 'Electronic Security']][i % 5];
      divs.forEach((d, j) => {
        const inst = U.iso(U.addDays(CRM.TODAY, -(AGES[(i * 2 + j) % AGES.length] + U.rand(0, 15))));
        const base = { customerId: c.id, siteId: site, division: d, installDate: inst };
        if (d === 'Power') {
          const p = pickProd('Power', U.pick(['Online UPS', 'Online UPS', 'Inverter', 'Servo Stabilizer']));
          createAsset(Object.assign({ productId: p.id, location: U.pick(['Server room', 'Electrical room', 'Ground floor', 'Office']) }, base), S);
          if (p.category !== 'Servo Stabilizer') createAsset(Object.assign({ productId: pickProd('Power', 'Battery').id, location: 'Battery rack', qty: U.pick([1, 2, 4, 8]) }, base), S);
        } else if (d === 'Electronic Security') {
          createAsset(Object.assign({ productId: pickProd(d, 'CCTV').id && master.products(d).find((p) => /NVR 16/.test(p.name)).id, location: 'Security cabin rack' }, base), S);
          ['Main gate', 'Parking'].forEach((loc, k) => createAsset(Object.assign({ productId: master.products(d).find((p) => /Bullet|Dome/.test(p.name) && (k ? /Dome/ : /Bullet/).test(p.name)).id, location: loc, channel: 'CH-0' + (k + 1) }, base), S));
          const extra = { Healthcare: 'Fire Alarm', Industrial: 'Biometric', Residential: 'Video Door Phone', Institutional: 'PA System', Commercial: 'Access Control' }[c.segment];
          if (extra && i % 2 === 0) createAsset(Object.assign({ productId: pickProd(d, extra).id, location: extra === 'Fire Alarm' ? 'Ground floor lobby' : 'Entrance' }, base), S);
        } else {
          const p = pickProd('Solar', /Residential/.test(c.segment) ? 'Hybrid' : 'On-grid');
          createAsset(Object.assign({ productId: p.id, location: 'Rooftop', capacityKw: Number((p.name.match(/(\d+)kW/) || [0, 5])[1]) }, base), S);
        }
      });
    });

    // ---- AMC contracts (+ PM plans with 3 visits) for out-of-warranty installed base
    const ENDS = [-25, -6, 9, 22, 41, 57, 88, 130, 175, 220, 265, 300, 340, 18, 150];
    let ei = 0;
    const groups = U.groupBy(dbx.all('assets'), (a) => a.customerId + '|' + a.division);
    Object.keys(groups).forEach((k, gi) => {
      const list = groups[k]; const a0 = list[0];
      if (a0.division === 'Solar' || parseD(a0.warrantyEnd) >= CRM.TODAY || gi % 4 === 3) return;
      const end = U.addDays(CRM.TODAY, ENDS[ei++ % ENDS.length]);
      const start = U.addDays(addMonths(end, -12), 1);
      const type = gi % 3 ? 'Comprehensive' : 'Non-Comprehensive';
      const value = amcQuoteAmount({ assetIds: list.map((a) => a.id), amcType: type, batteries: util.sum(list.filter((a) => a.eqType === 'Battery'), (a) => a.qty) });
      const renewed = gi % 3 === 1;
      let prevId = null;
      if (renewed) prevId = dbx.insert('amcContracts', { customerId: a0.customerId, siteId: a0.siteId, division: a0.division, assetIds: list.map((a) => a.id), type, start: U.iso(addMonths(start, -12)), end: U.iso(U.addDays(start, -1)), value: Math.round(value * 0.93 / 100) * 100, status: 'Renewed', pmFrequencyMonths: 4, pmVisitsPerYear: 3, billing: { status: 'Paid', invoiceNo: 'INV-AMC-' + U.rand(1000, 1999), amount: Math.round(value * 0.93), billedAt: U.iso(addMonths(start, -12)), paidAt: U.iso(U.addDays(addMonths(start, -12), 12)) }, createdAt: addMonths(start, -12).toISOString() }, { prefix: 'AMC', silent: true }).id;
      const billedAt = U.addDays(start, 3);
      const billing = billedAt > CRM.TODAY ? { status: 'To be billed' } : (gi % 5 === 2 ? { status: 'Billed', invoiceNo: 'INV-AMC-' + U.rand(2000, 2999), amount: value, billedAt: U.iso(billedAt), paymentStatus: 'Pending' } : { status: 'Paid', invoiceNo: 'INV-AMC-' + U.rand(2000, 2999), amount: value, billedAt: U.iso(billedAt), paymentStatus: 'Received', paidAt: U.iso(U.addDays(billedAt, U.rand(4, 26))), mode: U.pick(['Bank Transfer', 'UPI', 'Cheque']) });
      const c = dbx.insert('amcContracts', { customerId: a0.customerId, siteId: a0.siteId, division: a0.division, assetIds: list.map((a) => a.id), type, start: U.iso(start), end: U.iso(end), value, status: end < CRM.TODAY ? 'Expired' : 'Active', pmFrequencyMonths: 4, pmVisitsPerYear: 3, renewedFrom: prevId, billing, createdBy: 'EMP-pm_coordinator', closedBy: 'EMP-pm_coordinator', createdAt: U.addDays(start, -4).toISOString() }, { prefix: 'AMC', silent: true });
      if (prevId) dbx.update('amcContracts', prevId, { renewedTo: c.id }, S);
      list.forEach((a) => dbx.update('assets', a.id, { amcId: c.id, amcEnd: c.end }, S));
      const plan = createPmPlanForAmc(c, S);
      dbx.find('pmVisits', (v) => v.planId === plan.id).forEach((v, vi) => {
        const dd = parseD(v.dueDate); const late = U.daysBetween(dd, CRM.TODAY);
        if (late > 0 && !(late < 40 && (gi + vi) % 4 === 0)) {
          const off = (gi + vi) % 6 === 0 ? U.rand(9, 20) : U.rand(-6, 4);
          const done = U.addDays(dd, off) > CRM.TODAY ? U.addDays(CRM.TODAY, -1) : U.addDays(dd, off);
          const ck = {}; checklistFor(v.systemType).forEach((t) => { ck[t] = true; });
          const defects = (gi + vi) % 7 === 0;
          dbx.update('pmVisits', v.id, { stage: 9, scheduledDate: U.iso(U.addDays(done, -3)), visitAt: U.addDays(done, 0).toISOString(), completedDate: U.iso(done), checklist: ck, checklistVersion: 'v1.0', photosBefore: true, photosAfter: true, signature: (master.customer(v.customerId) || {}).contact, customerAck: true, findings: defects ? 'Defects observed — corrective action raised' : 'All checks normal; cleaned and tested', defects, reportApproved: true, reportApprovedBy: 'EMP-pm_coordinator' }, S);
        } else if (late <= 0 && late > -20) {
          dbx.update('pmVisits', v.id, { stage: (gi + vi) % 3 + 1, scheduledDate: (gi + vi) % 3 ? U.iso(U.addDays(dd, -2)) : null }, S);
        }
      });
      syncPlan(plan.id, S);
    });
    // warranty PM plans: keep ~12 months of PM history — move the first cycle forward, then complete past cycles
    function catchUp(plan, gi) {
      if (!plan) return;
      let v = dbx.one('pmVisits', (x) => x.planId === plan.id); if (!v) return; let due = parseD(v.dueDate);
      while (due < U.addDays(CRM.TODAY, -365)) due = addMonths(due, plan.frequencyMonths);
      dbx.update('pmVisits', v.id, { dueDate: U.iso(due) }, S); v = dbx.get('pmVisits', v.id);
      for (let n = 0; n < 6 && parseD(v.dueDate) < U.addDays(CRM.TODAY, -10); n++) {
        if (n > 0 && gi % 6 === 0 && util.daysBetween(parseD(v.dueDate), CRM.TODAY) < 40) break; // leave one overdue
        const ck = {}; checklistFor(v.systemType).forEach((t) => { ck[t] = true; });
        dbx.update('pmVisits', v.id, { stage: 9, completedDate: U.iso(U.addDays(v.dueDate, U.rand(-3, 6))), checklist: ck, photosBefore: true, photosAfter: true, signature: 'Customer', customerAck: true, reportApproved: true, findings: 'Normal' }, S);
        v = createPmVisit(plan, U.iso(addMonths(v.dueDate, plan.frequencyMonths)), S);
      }
      syncPlan(plan.id, S);
    }
    Object.keys(groups).forEach((k, gi) => {
      const list = groups[k]; const a0 = list[0];
      if (a0.division === 'Power' || parseD(a0.warrantyEnd) < CRM.TODAY || gi % 2) return;
      catchUp(pmPlanFromAssets(list, { coverage: 'Warranty' }, S), gi);
    });

    // ---- complaints: lifecycle generator
    const allAssets = dbx.all('assets');
    const assetsOf = (d) => allAssets.filter((a) => a.division === d && a.eqType !== 'Battery');
    const SRC = ['CUG Number', 'CUG Number', 'Landline', 'WhatsApp', 'Phone', 'Email', 'Sales Executive', 'Walk-in', 'Website'];
    function life(c, step, t) {
      const created = new Date(c.createdAt).getTime();
      const p = {};
      const eng = t.eng || engFor(c.division);
      if (step >= 2) { p.ackAt = iso(created + (t.ackMin != null ? t.ackMin : (U.rand(1, 9) === 1 ? U.rand(35, 95) : U.rand(4, 26))) * 6e4); p.ackChecks = { called: true, verified: true }; p.chargesInformed = c.coverage === 'Expired'; }
      if (step >= 3) p.validatedAt = iso(new Date(p.ackAt).getTime() + 5 * 6e4);
      if (step >= 4) { p.assignedAt = iso(new Date(p.validatedAt).getTime() + U.rand(8, 40) * 6e4); p.engineerId = eng; }
      if (step >= 5) { p.committedAt = iso(new Date(p.assignedAt).getTime() + 5 * 6e4); p.commitAt = iso(created + (t.commitH != null ? t.commitH : slaHours(c, 'attend') * 0.7) * HR); }
      if (step >= 6) {
        const attH = t.attH != null ? t.attH : slaHours(c, 'attend') * (U.rand(1, 7) === 1 ? U.rand(110, 220) / 100 : U.rand(15, 85) / 100);
        p.attendedAt = iso(Math.max(new Date(p.committedAt).getTime() + 6e4, created + attH * HR)); p.visits = 1; p.geo = (11 + U.rand(0, 99) / 1000).toFixed(4) + ', ' + (76.9 + U.rand(0, 99) / 1000).toFixed(4);
        p.diagnosedAt = iso(new Date(p.attendedAt).getTime() + 30 * 6e4); p.diagnosis = 'Checked ' + (c.productDetails || 'system') + ': ' + U.pick(['loose connection found', 'faulty component identified', 'configuration issue', 'power supply failure', 'component worn out']);
        if (c.division === 'Solar') { p.rootCause = U.pick(ROOT_CAUSES); p.faultCode = U.pick(['E-021 Grid over-voltage', 'E-034 Isolation fault', 'W-12 Comm loss', '—']); }
      }
      if (step >= 8) { p.repairedAt = iso(new Date(p.attendedAt).getTime() + (t.repH != null ? t.repH : (U.rand(1, 4) === 1 ? U.rand(30, 70) : U.rand(1, 8))) * HR); p.actionTaken = U.pick(['Replaced faulty part and tested on load', 'Reconfigured and verified', 'Cleaned, re-terminated and tested', 'Firmware updated and tested']); const ts = {}; testList(c).forEach((x) => { ts[x] = true; }); p.tests = ts; p.problemResolved = true; }
      if (step >= 9) { p.reportAt = iso(new Date(p.repairedAt).getTime() + 15 * 6e4); p.serviceReportNo = 'SR-' + c.id.slice(4); p.customerConfirmed = true; p.confirmMode = U.pick(['On-site digital signature', 'OTP confirmation', 'Phone confirmation']); p.signature = (master.customer(c.customerId) || {}).contact; p.photosBefore = true; p.photosAfter = true; }
      if (t.closed) {
        p.closedAt = iso(new Date(p.reportAt).getTime() + 10 * 6e4); p.resolvedAt = p.closedAt;
        if (needsApproval(Object.assign({}, c, p))) p.closureApprovedBy = 'EMP-service_coordinator';
        if (c.chargeable) { const paid = U.rand(1, 5) > 1 || t.unpaid === false; p.payment = paid && !t.unpaid ? { status: 'Received', mode: U.pick(['Cash', 'UPI', 'Bank Transfer']), invoiceNo: 'SINV-' + U.rand(3000, 3999), receivedAt: iso(new Date(p.closedAt).getTime() + U.rand(1, 20) * HR) } : { status: 'Pending', invoiceNo: 'SINV-' + U.rand(3000, 3999) }; }
      }
      p.step = t.closed ? 9 : step;
      Object.assign(p, t.extra || {});
      if (isPauseSub(p.openSub) && !p.closedAt) p.pauses = [{ from: p.repairedAt || p.diagnosedAt || p.attendedAt || iso(NOW - HR), reason: p.openSub }];
      const merged = Object.assign({}, c, p); p.status = deriveStatus(merged);
      dbx.update('complaints', c.id, p, S);
      return dbx.get('complaints', c.id);
    }
    function mk(spec) {
      let a = spec.asset;
      if (!a) { const pool = assetsOf(spec.div || U.pick(['Power', 'Power', 'Electronic Security', 'Electronic Security', 'Solar'])); a = U.pick(pool); }
      const d = a.division;
      const cats = CATEGORIES[d].filter((x) => !['Installation support', 'Preventive maintenance finding', 'Other technical complaint'].includes(x) && (spec.allowSafety || !SAFETY_CATS.includes(x)));
      const cat = spec.cat || (d === 'Electronic Security' ? (a.eqType === 'Fire Alarm' ? 'Fire alarm fault' : a.eqType === 'Biometric' ? 'Biometric device issue' : U.pick(cats.filter((x) => !/Biometric|Access|Video door|PA system|Fire/.test(x)))) : d === 'Power' ? (a.eqType === 'Servo Stabilizer' ? 'Stabilizer fault' : U.pick(cats.filter((x) => x !== 'Stabilizer fault'))) : U.pick(cats));
      const created = NOW - spec.ageH * HR;
      const pri = spec.pri || (U.rand(1, 10) <= (d === 'Power' ? 4 : 3) ? 'High' : 'Low');
      const c = createComplaint({ division: d, customerId: a.customerId, siteId: a.siteId, assetId: a.id, callType: 'Service', category: cat, priority: pri, source: spec.source || U.pick(SRC), description: DESC[cat] || cat + ' reported at ' + (a.location || 'site'), reportedBy: (master.customer(a.customerId) || {}).contact, createdAt: new Date(created).toISOString(), altContact: '9' + U.rand(100000000, 999999999) }, S);
      if (c.chargeable) dbx.update('complaints', c.id, { charges: U.rand(5, 35) * 100 }, S);
      return life(dbx.get('complaints', c.id), spec.step, spec);
    }
    // historical (closed) calls — oldest first so repeat detection links correctly
    const hist = [];
    for (let i = 0; i < 66; i++) hist.push(U.rand(30, 180 * 24));
    hist.push(3, 6, 9, 28, 50); // closed today / yesterday
    hist.sort((a, b) => b - a);
    const made = [];
    hist.forEach((ageH, i) => {
      const repeatOn = i > 5 && i % 9 === 0 ? made[made.length - 1 - U.rand(0, 2)] : null;
      const spec = { ageH, step: 9, closed: true, eng: i % 3 === 0 ? 'EMP-service_engineer' : null };
      if (repeatOn) { const a = dbx.get('assets', repeatOn.assetId); if (a) { spec.asset = a; spec.cat = repeatOn.category; spec.ageH = Math.max(1, (NOW - new Date(repeatOn.createdAt).getTime()) / HR - U.rand(48, 400)); } }
      if (spec.asset && spec.asset.division === 'Solar') spec.eng = null;
      if (spec.ageH < 30) spec.attH = 0.4 + Math.min(spec.ageH / 4, 2), spec.repH = 0.5;
      made.push(mk(spec));
    });
    // live queue (open calls in every stage)
    const E = 'EMP-service_engineer';
    const engD = (d) => (engs.find((e) => e.division === d) || {}).id || E;
    const live = [
      { ageH: 0.15, step: 1, div: 'Power', pri: 'High' }, { ageH: 1.6, step: 1, div: 'Electronic Security', pri: 'Low' }, { ageH: 0.4, step: 1, div: 'Solar' },
      { ageH: 2, step: 2, div: 'Power', pri: 'High', ackMin: 18 }, { ageH: 3, step: 3, div: 'Electronic Security', cat: 'Fire alarm fault', allowSafety: true, ackMin: 9 },
      { ageH: 5, step: 4, div: 'Power', pri: 'High', eng: E, ackMin: 22 }, { ageH: 6, step: 5, div: 'Power', pri: 'Low', eng: E, commitH: 9 },
      { ageH: 30, step: 5, div: 'Electronic Security', pri: 'Low', eng: engD('Electronic Security'), commitH: 20 }, { ageH: 3, step: 5, div: 'Power', pri: 'High', eng: E, commitH: 3.5 },
      { ageH: 20, step: 6, div: 'Power', cat: 'Battery issue (SF/Exide)', eng: E, attH: 6, spare: 'Requested' }, { ageH: 26, step: 6, div: 'Electronic Security', cat: 'Hard disk failure', eng: engD('Electronic Security'), attH: 10, spare: 'Approved' },
      { ageH: 40, step: 7, div: 'Power', eng: E, attH: 2.5, spare: 'Issued' }, { ageH: 55, step: 7, div: 'Solar', cat: 'Inverter fault / shutdown', eng: engD('Solar'), attH: 8, trc: true },
      { ageH: 70, step: 8, div: 'Electronic Security', eng: E, attH: 12, repH: 20, extra: { openSub: 'Waiting for customer' } }, { ageH: 12, step: 8, div: 'Power', eng: E, attH: 2, repH: 3 },
      { ageH: 30, step: 9, div: 'Power', eng: E, attH: 3, repH: 4, chargeableForce: true }, { ageH: 50, step: 9, div: 'Electronic Security', eng: engD('Electronic Security'), attH: 15, repH: 6, repeatLive: true },
      { ageH: 24 * 9, step: 7, div: 'Power', cat: 'UPS not working', eng: E, attH: 3, standby: 9, serviceCentre: true }, { ageH: 24 * 4, step: 7, div: 'Power', cat: 'Battery issue (SF/Exide)', eng: engD('Power'), attH: 5, vendor: true },
      { ageH: 8, step: 7, div: 'Solar', cat: 'Generation below expected level', eng: engD('Solar'), attH: 6, extra: { sparesNotRequired: true } }, { ageH: 1, step: 2, div: 'Electronic Security', ackMin: 12 },
      { ageH: 18, step: 5, div: 'Solar', pri: 'Low', eng: engD('Solar'), commitH: 26 },
      { ageH: 60, step: 7, div: 'Electronic Security', cat: 'Hard disk failure', eng: engD('Electronic Security'), attH: 9, supplier: true },
    ];
    const liveCalls = live.map((sp) => {
      if (sp.repeatLive) { const prev = made.filter((m) => m.division === sp.div).slice(-1)[0]; if (prev) { sp.asset = dbx.get('assets', prev.assetId); sp.cat = prev.category; } }
      const c = mk(sp);
      const patch = {};
      if (sp.chargeableForce && !c.chargeable) Object.assign(patch, { serviceType: 'On-call', coverage: 'Expired', chargeable: true, charges: 1800 });
      if (sp.trc) { const tr = new Date(new Date(c.attendedAt).getTime() + HR); Object.assign(patch, { openSub: 'Observation Required (TRC)', trcAt: tr.toISOString(), observation: { from: tr.toISOString(), hours: 48, revisitAt: new Date(tr.getTime() + 48 * HR).toISOString() } }); }
      if (sp.standby) Object.assign(patch, { openSub: 'Product shifted to Service Centre', standby: { item: 'Standby inverter 1.5KVA', issuedAt: new Date(NOW - sp.standby * 24 * HR + 5 * HR).toISOString() }, serviceCentre: { grnRef: 'GRN-S-' + U.rand(100, 199), stage: 2, inwardAt: new Date(NOW - sp.standby * 24 * HR + 6 * HR).toISOString() } });
      if (sp.vendor) Object.assign(patch, { openSub: 'Battery issue – SF/Exide coordination', pauses: [{ from: new Date(NOW - 3 * 24 * HR).toISOString(), reason: 'Battery issue – SF/Exide coordination' }], vendorComplaint: { kind: 'Battery vendor', brand: 'Exide', ref: 'EXD-CMP-' + U.rand(40000, 49999), status: 'Under review', raisedAt: new Date(NOW - 3 * 24 * HR).toISOString() } });
      if (sp.supplier) Object.assign(patch, { openSub: SUB_SUPPLIER, pauses: [{ from: new Date(NOW - 2 * 24 * HR).toISOString(), reason: SUB_SUPPLIER }], vendorComplaint: { kind: 'Supplier warranty', brand: c.division === 'Solar' ? 'Growatt (inverter)' : 'Hikvision', ref: 'OEM-RMA-' + U.rand(1000, 9999), status: 'Raised', raisedAt: new Date(NOW - 2 * 24 * HR).toISOString() } });
      if (Object.keys(patch).length) { const m = Object.assign({}, c, patch); patch.status = deriveStatus(m); dbx.update('complaints', c.id, patch, S); }
      if (sp.spare) dbx.insert('spareRequests', { complaintId: c.id, division: c.division, item: U.pick(SPARES[c.division]), qty: 1, reason: c.diagnosis, status: sp.spare, requestedBy: c.engineerId, requestedAt: c.diagnosedAt, approvedBy: sp.spare !== 'Requested' ? 'EMP-service_coordinator' : null, approvedAt: sp.spare !== 'Requested' ? c.diagnosedAt : null, issuedAt: sp.spare === 'Issued' ? c.diagnosedAt : null, createdAt: c.diagnosedAt }, { prefix: 'SPR', silent: true });
      return dbx.get('complaints', c.id);
    });
    // spares on historical calls (consumption & returns)
    made.filter((c, i) => i % 3 === 0).forEach((c, i) => dbx.insert('spareRequests', { complaintId: c.id, division: c.division, item: U.pick(SPARES[c.division]), qty: U.rand(1, 2), reason: c.diagnosis, status: i % 6 === 5 ? 'Returned' : 'Used', usedQty: i % 6 === 5 ? 0 : 1, returnedQty: i % 6 === 5 ? 1 : 0, requestedBy: c.engineerId, requestedAt: c.diagnosedAt, approvedBy: 'EMP-service_coordinator', approvedAt: c.diagnosedAt, issuedAt: c.diagnosedAt, createdAt: c.diagnosedAt }, { prefix: 'SPR', silent: true }));
    // PM corrective-action calls
    dbx.find('pmVisits', (v) => v.defects).forEach((v) => {
      const a = dbx.get('assets', (v.assetIds || [])[0]); if (!a) return;
      const c = createComplaint({ division: v.division, customerId: v.customerId, siteId: v.siteId, assetId: a.id, callType: 'Service', category: 'Preventive maintenance finding', priority: 'Low', source: 'PM Visit', description: 'Corrective action from PM ' + v.id + ': ' + v.findings, pmVisitId: v.id, createdAt: new Date(v.completedDate + 'T16:00:00').toISOString() }, S);
      const done = life(c, 9, { closed: hrsSince(c.createdAt) > 72, eng: v.engineerId });
      dbx.update('pmVisits', v.id, { correctiveComplaintId: done.id }, S);
    });

    // ---- feedback (positive / neutral / negative)
    const W = [5, 5, 5, 5, 4, 4, 4, 4, 4, 3, 3, 2, 1];
    dbx.find('complaints', (c) => c.closedAt).forEach((c, i) => {
      if (i % 4 === 3) return;
      const rating = hrsSince(c.closedAt) < 120 && i % 10 === 0 ? 2 : U.pick(W);
      const f = dbx.insert('feedback', { complaintId: c.id, customerId: c.customerId, division: c.division, engineerId: c.engineerId, rating, type: rating >= 4 ? 'Positive' : rating === 3 ? 'Neutral' : 'Negative', comment: rating >= 4 ? U.pick(['Quick response, thank you', 'Engineer was courteous', 'Resolved in one visit']) : rating === 3 ? 'Okay, took time' : U.pick(['Engineer came late', 'Same issue again within weeks', 'Charges not explained']), channel: U.pick(['SMS link', 'WhatsApp', 'Call']), createdAt: new Date(new Date(c.closedAt).getTime() + 3 * HR).toISOString(), actionAt: rating <= 2 && hrsSince(c.closedAt) > 240 ? new Date(new Date(c.closedAt).getTime() + 30 * HR).toISOString() : null }, { prefix: 'FBK', silent: true });
      dbx.update('complaints', c.id, { feedbackId: f.id, rating, step: 10 }, S);
    });

    // ---- customer escalations
    [['Repeated CCTV failure — customer called the MD', 'Service', 'High'], ['Engineer did not turn up at committed time', 'Service', 'Critical'], ['Service charges dispute', 'Accounts', 'Medium'], ['Delay in solar inverter replacement', 'Service', 'High'], ['Installation not completed as promised', 'Installation', 'High'], ['Billing error on AMC invoice', 'Accounts', 'Low']].forEach(([reason, dept, sev], i) => {
      const c = made[made.length - 4 - i * 6] || made[i];
      const date = new Date(NOW - [2, 6, 15, 30, 55, 90][i] * 24 * HR);
      dbx.insert('escalations', { customerId: c.customerId, division: c.division, complaintId: c.id, date: date.toISOString(), reason, department: dept, severity: sev, ownerId: c.engineerId || 'EMP-service_coordinator', status: i < 3 ? 'Open' : 'Resolved', resolvedAt: i < 3 ? null : new Date(date.getTime() + 2 * 24 * HR).toISOString(), resolution: i < 3 ? '' : 'Customer called back; root cause shared and resolved', loggedBy: 'EMP-odm', createdAt: date.toISOString() }, { prefix: 'ESC', silent: true });
    });

    // ---- OTS (opportunity through service)
    const powerCalls = made.filter((c) => c.division === 'Power').concat(liveCalls.filter((c) => c.division === 'Power' && c.attendedAt));
    const QTY = [1, 2, 2, 1, 4, 6, 3, 2, 8, 1, 2, 5, 1, 3, 2, 10];
    const OST = ['Won', 'Won', 'Lost', 'Won', 'In Progress', 'Negotiation', 'Won', 'Open', 'Quotation Sent', 'Won', 'Lost', 'Open', 'Won', 'In Progress', 'Open', 'Lost'];
    const execs = master.staff('sales_exec').map((s) => s.id);
    QTY.forEach((q, i) => {
      const c = powerCalls[(i * 3) % powerCalls.length]; if (!c) return;
      const type = otsType(q, i % 4 === 0 ? 'UPS' : 'Battery'); const st = OST[i];
      const at = c.attendedAt || c.createdAt;
      const value = q * 15500 + (i % 4 === 0 ? 24500 : 0);
      dbx.insert('ots', { division: 'Power', source: 'Service', product: q + ' × Battery', notes: 'From complaint ' + c.id, complaintId: c.id, customerId: c.customerId, customerName: custName(c.customerId), contact: c.contact, location: (master.customer(c.customerId) || {}).area, productType: i % 4 === 0 ? 'UPS' : 'Battery', brand: U.pick(['SF', 'Exide', 'Exide', 'Others']), qty: q, capacity: U.pick(['150Ah', '100Ah', '26Ah', '3KVA']), otsType: type, department: type === 'Service OTS' ? 'Service' : 'Sales', value, urgency: U.pick(['Hot', 'Warm', 'Cold']), expectedClose: U.iso(U.addDays(at, U.rand(5, 25))), createdBy: c.engineerId || E, assignedTo: type === 'Service OTS' ? (c.engineerId || E) : (i === 7 ? null : U.pick(execs)), status: st, revenue: st === 'Won' ? Math.round(value * U.rand(90, 100) / 100) : 0, closedBy: st === 'Won' ? (type === 'Service OTS' ? (c.engineerId || E) : U.pick(execs)) : null, closedAt: ['Won', 'Lost'].includes(st) ? iso(new Date(at).getTime() + U.rand(2, 15) * 24 * HR) : null, lostReason: st === 'Lost' ? U.pick(['Price too high', 'Bought from local dealer', 'Customer postponed']) : '', incentiveEligible: 'Yes', createdAt: at }, { prefix: 'OTS', silent: true });
    });

    // ---- AMC opportunities: automation (60/30/0 & 90/30) then enrich + history
    runAmcAutomation(true);
    dbx.all('amcOpportunities').forEach((o, i) => {
      const m = i % 4;
      const p = { createdAt: new Date(NOW - U.rand(2, 25) * 24 * HR).toISOString(), renewalScore: 0 };
      if (m >= 1) p.followups = [{ at: new Date(NOW - U.rand(1, 10) * 24 * HR).toISOString(), mode: U.pick(['Call', 'Visit']), note: 'Discussed renewal; customer reviewing', next: U.iso(U.addDays(CRM.TODAY, U.rand(-2, 5))), by: 'EMP-pm_coordinator' }];
      if (m >= 2) { const amt = amcQuoteAmount({ assetIds: o.assetIds, amcType: 'Comprehensive', batteries: 2 }); p.quote = { no: 'AQ-' + o.id.slice(4), template: o.division + ' – ' + (o.division === 'Power' ? 'UPS/Inverter' : o.division === 'Solar' ? 'O&M' : 'CCTV') + ' AMC', amcType: 'Comprehensive', capacity: 0, batteries: 2, amount: amt, discountPct: m === 3 ? 12 : 0, status: m === 3 ? 'Opened' : 'Sent', sentAt: new Date(NOW - U.rand(2, 8) * 24 * HR).toISOString(), discountApproval: m === 3 ? 'Pending' : null }; }
      p.status = ['Open', 'Under Follow-up', 'Quotation Sent', 'Negotiation'][m];
      dbx.update('amcOpportunities', o.id, p, S);
    });
    dbx.find('amcContracts', (c) => c.status !== 'Renewed' && U.daysBetween(c.start, CRM.TODAY) <= 185 && U.daysBetween(c.start, CRM.TODAY) >= 0).forEach((c) => {
      const closed = U.addDays(c.start, -U.rand(2, 9));
      const o = createOpp({ type: c.renewedFrom ? 'AMC Renewal' : 'Warranty Conversion', customerId: c.customerId, siteId: c.siteId, division: c.division, assetIds: c.assetIds, contractId: c.renewedFrom || null, estValue: c.value, status: 'Won', closedAt: closed.toISOString(), closedBy: U.pick(['EMP-pm_coordinator', 'EMP-pm_coordinator', 'EMP-service_coordinator', 'EMP-sales_manager']), createdBy: U.pick(['EMP-pm_coordinator', 'EMP-service_engineer', 'EMP-pm_coordinator']), quote: { no: 'AQ-H' + U.rand(100, 999), amcType: c.type, amount: c.value, status: 'Accepted', sentAt: U.addDays(closed, -6).toISOString() }, trigger: c.renewedFrom ? '60 days before expiry' : '90 days before warranty expiry', incentiveApplicable: 'Yes', createdAt: U.addDays(closed, -30).toISOString() }, S);
      dbx.update('amcContracts', c.id, { oppId: o.id }, S);
    });
    for (let i = 0; i < 5; i++) {
      const c = custs[(i * 5 + 2) % custs.length]; const closed = U.addDays(CRM.TODAY, -U.rand(10, 170));
      createOpp({ type: i % 2 ? 'AMC Renewal' : 'Warranty Conversion', customerId: c.id, division: i % 3 ? 'Power' : 'Electronic Security', assetIds: [], estValue: U.rand(8, 60) * 1000, status: 'Lost', lostReason: U.pick(['Price too high', 'Customer moved to competitor', 'Equipment to be replaced', 'No budget this year']), closedAt: closed.toISOString(), createdBy: 'EMP-pm_coordinator', createdAt: U.addDays(closed, -25).toISOString() }, S);
    }

    // ---- Power orders from Sales (if present): asset, warranty, PM plan and installation call
    const approved = (o) => (o.approval ? o.approval === 'Approved' : !/cancel|lost|reject/i.test(o.status || ''));
    dbx.all('orders').filter((o) => o.division === 'Power' && approved(o) && !dbx.one('assets', (a) => a.orderId === o.id) && !dbx.one('complaints', (c) => c.orderId === o.id && c.callType === 'Installation')).slice(0, 12).forEach((o, k) => {
      const r = safe(() => powerOrderToService(o, true), null); if (!r) return;
      if (hrsSince(r.call.createdAt) > 30) {
        const instAt = new Date(new Date(r.call.createdAt).getTime() + U.rand(4, 30) * HR).toISOString();
        const scr = r.call.scrapApplicable && U.rand(0, 3);
        life(r.call, 9, { closed: true, attH: U.rand(4, 30), repH: 2, extra: { installedAt: instAt, scrapCollectedAt: scr ? instAt : null, scrapQty: r.call.scrapQty || (scr ? 2 : 0), instPhotos: 'simulated', instSignature: (master.customer(r.call.customerId) || {}).contact, dcRef: 'DC-' + (o.soNumber || o.id).replace(/\W/g, '').slice(-5), invoiceRef: 'INV-' + (o.soNumber || o.id).replace(/\W/g, '').slice(-5), instPayment: Object.assign({}, r.call.instPayment, k % 4 === 3 ? { mode: 'Credit', status: 'Pending' } : { mode: U.pick(['Cash', 'UPI', 'Bank Transfer']), status: 'Received', amount: o.value, date: util.iso(instAt) }) } });
        applyInstallDate(o.id, util.iso(instAt));
      }
      catchUp(dbx.one('pmPlans', (pl) => pl.orderId === o.id), 1);
    });
    // ---- handed-over projects (if present): assets + warranty PM plan
    dbx.all('projects').filter((p) => /handover|handed|closed|complete/i.test(p.status || p.stage || '') && !dbx.one('assets', (a) => a.projectId === p.id)).slice(0, 10).forEach((p) => safe(() => {
      const devs = (p.devices && p.devices.length ? p.devices : master.products(p.division || 'Electronic Security').slice(0, 3).map((pr) => ({ productId: pr.id, name: pr.name }))).slice(0, 8);
      const list = devs.map((d, k) => createAsset({ customerId: p.customerId, siteId: p.siteId || (master.sites(p.customerId)[0] || {}).id, projectId: p.id, division: p.division || 'Electronic Security', productId: d.productId, name: d.name, category: d.type, serial: d.serial, location: d.location, channel: d.channel || '', tag: d.tag || '', installDate: util.iso(p.handoverAt || p.closedAt || p.updatedAt || CRM.TODAY) }, S));
      Object.values(util.groupBy(list, 'eqType')).forEach((g) => catchUp(pmPlanFromAssets(g, {}, S), 1));
    }, null));

    // ---- violations from the evaluation engine, then historical closure
    evaluatePolicies({ quiet: false });
    dbx.all('violations').forEach((v, i) => {
      const age = U.daysBetween(v.incidentAt, CRM.TODAY);
      const ca = { 'Service': 'Engineer counselled; route plan revised', 'Customer': 'Customer called by ODM; RCA shared', 'AMC': 'Quotation sent / payment followed up', 'Sales': 'Executive reminded of 24h policy' }[v.area] || 'Corrective action completed';
      if (age > 10 || (v.cleared && age > 4)) dbx.update('violations', v.id, { status: i % 17 === 0 ? 'Exception' : 'Closed', correctiveAction: ca, rootCause: U.pick(['Engineer workload', 'Customer not available', 'Spare not in stock', 'Process not followed', 'Traffic / distance']), closureApprovedBy: 'EMP-odm', closedAt: new Date(new Date(v.incidentAt).getTime() + U.rand(1, 5) * 24 * HR).toISOString(), exceptionReason: i % 17 === 0 ? 'Customer-delayed; excluded per reporting rules' : '' }, S);
      else if (age > 2 && i % 3 === 0) dbx.update('violations', v.id, { status: 'Pending Closure Approval', correctiveAction: ca, rootCause: 'Process not followed' }, S);
      else if (age > 1 && i % 3 === 1) dbx.update('violations', v.id, { status: 'Action Planned', correctiveAction: ca }, S);
    });
    runPmAutomation(); runSlaAlerts();
  });

  // ================================================================ UI — shared bits
  const priBadge = (p) => ui.badge(p, p === 'Critical' ? 'violet' : p === 'High' ? 'bad' : 'info');
  const covBadge = (t) => ui.badge(t, t === 'AMC' ? 'ok' : t === 'Warranty' ? 'info' : t === 'Expired' ? 'bad' : '');
  const scope = (list) => (roleIs('service_engineer') ? list.filter((c) => c.engineerId === me()) : list);
  const canCoord = () => roleIs('service_coordinator', 'admin');
  const canEng = (c) => (roleIs('service_engineer') ? c.engineerId === me() : canCoord());
  const toolbarBtn = (label, fn, cls) => ui.btn(label, fn, 'sm ' + (cls || ''));
  function cmpColumns() {
    return [
      { key: 'id', label: 'Complaint', render: (c) => h('span', {}, [mono(c.id), c.safetyCritical ? ' 🔥' : '', c.repeatOf ? h('span', {}, [' ', ui.badge('Repeat', 'warn')]) : null]), csv: (c) => c.id },
      { key: 'createdAt', label: 'Received', render: (c) => fmt.dateTime(c.createdAt), sort: (c) => c.createdAt },
      { key: 'customerId', label: 'Customer / category', render: (c) => h('div', {}, [h('div', {}, custName(c.customerId)), h('div', { class: 'small muted' }, c.category)]), csv: (c) => custName(c.customerId) + ' — ' + c.category, sort: (c) => custName(c.customerId) },
      { key: 'division', label: 'Division', render: (c) => ui.divTag(c.division), csv: (c) => c.division },
      { key: 'priority', label: 'Priority', render: (c) => priBadge(c.priority), csv: (c) => c.priority },
      { key: 'serviceType', label: 'Service type' },
      { key: 'callType', label: 'Call type', render: (c) => callTypeLabel(c.callType), csv: (c) => c.callType },
      { key: 'engineerId', label: 'Engineer', render: (c) => (c.engineerId ? master.staffName(c.engineerId) : ui.badge('Unassigned', 'warn')), csv: (c) => master.staffName(c.engineerId) },
      { key: 'step', label: 'Stage', render: (c) => (isOpen(c) ? STEPS[c.step] : c.status === 'Cancelled' ? 'Cancelled' : c.feedbackId ? 'Closed · feedback ' + c.rating + '/5' : 'Closed'), sort: (c) => c.step },
      { key: 'ack', label: 'Ack SLA', render: (c) => slaBadge(c, 'ack'), csv: (c) => slaState(c, 'ack'), sort: (c) => slaState(c, 'ack') },
      { key: 'attend', label: 'Attendance SLA', render: (c) => slaBadge(c, 'attend'), csv: (c) => slaState(c, 'attend'), sort: (c) => slaState(c, 'attend') },
      { key: 'resolve', label: 'Resolution SLA', render: (c) => slaBadge(c, 'resolve'), csv: (c) => slaState(c, 'resolve'), sort: (c) => slaState(c, 'resolve') },
      { key: 'status', label: 'Status', render: (c) => ui.badge(c.status, c.status === 'Waiting' ? 'warn' : c.status === 'Open' ? 'info' : null) },
    ];
  }
  function metrics(list) {
    const attended = list.filter((c) => c.attendedAt);
    const closed = list.filter((c) => c.closedAt);
    const acked = list.filter((c) => c.ackAt);
    const open = list.filter(isOpen);
    // compliance = met ÷ (completed + still-open calls that have already breached) — open breaches count against the SLA
    const slaPct = (kind) => { const rows = list.filter((c) => c.status !== 'Cancelled' && (doneAt(c, kind) || (isOpen(c) && slaState(c, kind) === 'Breached'))); return pctOf(rows.filter((c) => slaState(c, kind) === 'Met').length, rows.length); };
    return {
      total: list.length, open: open.length, overdue: open.filter(overdue).length, closed: closed.length, attended: attended.length,
      ackSla: slaPct('ack'), attendanceSla: slaPct('attend'), resolutionSla: slaPct('resolve'),
      repeatPct: pctOf(list.filter((c) => c.repeatOf).length, list.length),
      fvr: pctOf(closed.filter((c) => (c.visits || 1) <= 1 && !c.reopenCount).length, closed.length),
      avgAckMin: acked.length ? Math.round(util.sum(acked, (c) => (new Date(c.ackAt) - new Date(c.createdAt)) / 6e4) / acked.length) : 0,
      avgAttendH: attended.length ? Math.round(util.sum(attended, (c) => (new Date(c.attendedAt) - new Date(c.createdAt)) / HR) / attended.length * 10) / 10 : 0,
      avgCloseH: closed.length ? Math.round(util.sum(closed, (c) => (new Date(c.closedAt) - new Date(c.createdAt)) / HR) / closed.length * 10) / 10 : 0,
      attendedOpen: open.filter((c) => c.attendedAt).length,
      revenue: util.sum(closed.filter((c) => c.chargeable && (c.payment || {}).status === 'Received'), (c) => c.charges),
    };
  }
  const svcList = () => db.all('complaints').filter((c) => c.callType !== 'Pre-Sale Support');

  // ================================================================ complaint registration
  function openNewComplaint(pre) {
    pre = pre || {};
    const d0 = pre.division || 'Power';
    const fields = [
      { type: 'section', label: 'Customer (linked to customer master)' },
      { key: 'customerId', label: 'Customer name (lookup)', type: 'select', options: custOpts(), required: true },
      { key: 'siteId', label: 'Site', type: 'select', options: [] },
      { key: 'contact', label: 'Contact number', required: true },
      { key: 'altContact', label: 'Alternate contact' },
      { key: 'address', label: 'Address (auto-fetched, editable)', required: true, full: true },
      { type: 'section', label: 'Complaint details' },
      { key: 'division', label: 'Division', type: 'select', options: DIVS, required: true },
      { key: 'callType', label: 'Call type (by division)', type: 'select', options: callTypeOpts(d0), required: true },
      { key: 'category', label: 'Complaint category', type: 'select', options: CATEGORIES[d0], required: true },
      { key: 'systemType', label: 'System / product type', type: 'select', options: SYSTEM_TYPES[d0] },
      { key: 'assetId', label: 'Equipment ID / serial (asset master)', type: 'select', options: [] },
      { key: 'productDetails', label: 'Product details' },
      { key: 'serial', label: 'Serial number' },
      { key: 'projectId', label: 'Installation project ID (if any)' },
      { key: 'description', label: 'Complaint description', type: 'textarea', required: true },
      { key: 'priority', label: 'Priority', type: 'select', options: PRIORITIES, required: true, hint: 'Fire alarm & safety-critical issues are forced to Critical' },
      { key: 'serviceType', label: 'Service type', type: 'select', options: SERVICE_TYPES, hint: 'Auto-set from warranty / AMC validation' },
      { key: 'commitAt', label: 'Commitment date & time', type: 'datetime-local' },
      { key: 'source', label: 'Complaint source', type: 'select', options: SOURCES, required: true },
      { key: 'reportedBy', label: 'Reported by' },
      { key: 'sparesInitial', label: 'Spares required (initial input)' },
      { key: 'instructions', label: 'Special customer instructions', type: 'textarea' },
    ];
    const form = ui.form(fields, Object.assign({ division: d0, priority: 'Low', source: roleIs('service_engineer') ? 'Service Engineer' : 'CUG Number', callType: 'Service' }, pre));
    const I = form.inputs;
    const ctx = h('div', { class: 'stack', style: 'gap:10px' });
    function refreshCtx() {
      ctx.innerHTML = '';
      const cid = I.customerId.value; const a = db.get('assets', I.assetId.value);
      if (!cid) { ctx.appendChild(txtCallout('Select a customer to auto-fetch address, installed equipment, warranty/AMC status and complaint history.')); return; }
      const cov = a ? coverageOf(a) : { type: customerAmcStatus(cid, I.division.value) === 'Active' ? 'AMC' : 'Expired' };
      if (a) { I.productDetails.value = a.name; I.serial.value = a.serial; if (a.projectId) I.projectId.value = a.projectId; if (a.eqType && SYSTEM_TYPES[a.division].includes(a.eqType)) I.systemType.value = a.eqType; }
      if (I.callType.value === 'Installation') I.serviceType.value = 'Warranty';
      else I.serviceType.value = cov.type === 'AMC' ? 'AMC' : cov.type === 'Warranty' ? 'Warranty' : 'On-call';
      ctx.appendChild(ui.card('Warranty / AMC validation', h('div', { class: 'stack', style: 'gap:6px' }, [
        h('div', { class: 'row' }, [covBadge(cov.type), cov.until ? h('span', { class: 'small muted' }, 'until ' + fmt.date(cov.until)) : null]),
        h('div', { class: 'small' }, cov.type === 'AMC' ? 'AMC active → no service charges.' : cov.type === 'Warranty' ? 'Under warranty → no service charges.' : 'AMC / warranty expired → chargeable (inform customer at acknowledgement).'),
        h('div', { class: 'small muted' }, 'Customer AMC status (' + I.division.value + '): ' + customerAmcStatus(cid, I.division.value)),
      ])));
      const v = { customerId: cid, assetId: a ? a.id : null, division: I.division.value, category: I.category.value };
      const rep = findRepeat(v);
      if (rep) ctx.appendChild(htmlCallout('<b>Repeat complaint</b> — same ' + (a ? 'equipment' : 'category') + ' as <a href="#/complaints/' + esc(rep.id) + '">' + esc(rep.id) + '</a> (' + fmt.date(rep.createdAt) + ') within ' + cfg().repeatWindowDays + ' days.', 'warn'));
      if (isSafety({ category: I.category.value, systemType: I.systemType.value })) { I.priority.value = 'Critical'; ctx.appendChild(htmlCallout('<b>Safety-critical</b> — dedicated priority & escalation policy: Critical priority, ' + esc(slaHours({ division: I.division.value, priority: 'Critical', category: I.category.value }, 'attend')) + 'h attendance SLA.', 'bad')); }
      if (I.callType.value === 'Project Installation') ctx.appendChild(htmlCallout('Division ' + esc(I.division.value) + ' + call type <b>Project Installation</b> opens the Project Installation workflow — a project request is raised and the ' + (I.division.value === 'Solar' ? 'Solar' : 'ES') + ' coordinator is notified.', 'info'));
      const prev = db.find('complaints', (c) => c.customerId === cid).sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
      ctx.appendChild(ui.card('Previous complaint history (' + prev.length + ')', prev.length ? h('div', { class: 'stack', style: 'gap:4px' }, prev.slice(0, 5).map((c) => h('div', { class: 'small' }, [link('#/complaints/' + c.id, c.id), ' · ' + fmt.date(c.createdAt) + ' · ' + c.category + ' · ', ui.badge(c.status)]))) : h('div', { class: 'small muted' }, 'No previous complaints')));
      if (a) { const lp = db.find('pmVisits', (p) => (p.assetIds || []).includes(a.id) && p.completedDate).map((p) => p.completedDate).sort().pop(); ctx.appendChild(txtCallout('Equipment ' + a.id + (a.capacity ? ' · ' + a.capacity : '') + ' · installed ' + fmt.date(a.installDate) + ' · last PM ' + fmt.date(lp), '')); }
    }
    function refreshAssets() { const cid = I.customerId.value; setOptions(I.assetId, db.find('assets', (a) => a.customerId === cid && a.division === I.division.value).map((a) => ({ value: a.id, label: a.id + ' · ' + a.name + ' · ' + a.serial + (a.location ? ' · ' + a.location : '') })), pre.assetId); refreshCtx(); }
    function refreshCustomer() { const cust = master.customer(I.customerId.value); if (!cust) return refreshCtx(); const sites = master.sites(cust.id); setOptions(I.siteId, sites.map((s) => ({ value: s.id, label: s.name + ' · ' + s.address })), (sites[0] || {}).id); I.contact.value = I.contact.value || cust.phone; I.address.value = (sites[0] || {}).address || cust.area; refreshAssets(); }
    function refreshDivision() { const d = I.division.value || 'Power'; setOptions(I.callType, callTypeOpts(d), 'Service'); setOptions(I.category, CATEGORIES[d]); setOptions(I.systemType, SYSTEM_TYPES[d]); refreshAssets(); }
    I.customerId.addEventListener('change', refreshCustomer); I.division.addEventListener('change', refreshDivision);
    I.siteId.addEventListener('change', () => { const s = db.get('sites', I.siteId.value); if (s) I.address.value = s.address; });
    [I.assetId, I.category, I.systemType, I.callType].forEach((x) => x.addEventListener('change', refreshCtx));
    if (pre.customerId) refreshCustomer(); else refreshCtx();
    ui.modal({
      title: 'Register complaint / service request', sub: 'Complaint ID and timestamp are auto-generated · SLA clock starts on save', wide: true,
      body: h('div', { class: 'grid', style: 'grid-template-columns:minmax(0,2fr) minmax(220px,1fr)' }, [form, ctx]),
      actions: [{ label: 'Cancel' }, { label: 'Register complaint', cls: 'primary', onClick: () => {
        if (!form.validate()) return false;
        const v = form.values();
        if (isSafety(v) && v.priority !== 'Critical') { ui.toast('Safety-critical issues cannot be logged as ordinary priority', 'bad'); return false; }
        if (v.commitAt) v.commitAt = new Date(v.commitAt).toISOString();
        if (roleIs('service_engineer')) v.engineerId = me();
        const rec = createComplaint(v);
        ui.toast('Complaint ' + rec.id + ' registered · ' + rec.serviceType + (rec.repeatOf ? ' · repeat of ' + rec.repeatOf : ''), 'ok');
        CRM.go('complaints', rec.id);
      } }],
    });
  }

  // ================================================================ complaint workflow actions
  function act(c, title, fields, values, onSave, opts) {
    ui.formModal(title, fields, values || {}, (v) => { const r = onSave(v); if (r === false) return false; reopenAfter(() => {}); return r; }, opts);
  }
  const A = {
    ack(c) {
      act(c, 'Acknowledge complaint ' + c.id, [
        { key: 'called', label: 'Called the customer', type: 'checkbox', required: true },
        { key: 'verified', label: 'Verified complaint details (contact, address, equipment)', type: 'checkbox', required: true },
        { key: 'chargesInformed', label: 'Informed service charges' + (c.coverage === 'Expired' ? ' (mandatory — coverage expired)' : ' (if applicable)'), type: 'checkbox', required: c.coverage === 'Expired' },
        { key: 'remark', label: 'Remarks', type: 'textarea' },
      ], {}, (v) => { updC(c, { ackAt: now().toISOString(), ackBy: me(), ackChecks: { called: v.called, verified: v.verified }, chargesInformed: v.chargesInformed, step: 2, notes: (c.notes || []).concat(v.remark ? [{ at: now().toISOString(), by: CRM.user().name, text: 'Ack note: ' + v.remark }] : []) }, 'Acknowledged'); ui.toast('Acknowledged in ' + dur(hrsSince(c.createdAt)) + (hrsSince(c.createdAt) > slaHours(c, 'ack') ? ' — SLA breached' : ' — within SLA'), hrsSince(c.createdAt) > slaHours(c, 'ack') ? 'warn' : 'ok'); });
    },
    validate(c) {
      act(c, 'Priority & warranty/AMC validation', [
        { key: 'coverage', label: 'Coverage (auto-checked)', type: 'readonly' },
        { key: 'priority', label: 'Priority', type: 'select', options: c.safetyCritical ? ['Critical'] : PRIORITIES, required: true },
        { key: 'serviceType', label: 'Service type', type: 'select', options: SERVICE_TYPES, required: true },
        { key: 'charges', label: 'Service charges ₹ (mandatory if On-call)', type: 'number' },
        { key: 'complimentaryReason', label: 'Complimentary reason (if complimentary)' },
      ], { coverage: c.coverage + (c.coverageUntil ? ' until ' + fmt.date(c.coverageUntil) : ''), priority: c.priority, serviceType: c.serviceType, charges: c.charges || '' }, (v) => {
        if (v.serviceType === 'On-call' && !(v.charges > 0)) { ui.toast('Chargeable (On-call) service needs the service charge amount', 'bad'); return false; }
        if ((v.serviceType === 'AMC' && c.coverage !== 'AMC') || (v.serviceType === 'Warranty' && !['Warranty', 'AMC'].includes(c.coverage))) { ui.toast('Blocked: coverage is ' + c.coverage + ' — cannot classify as ' + v.serviceType, 'bad'); return false; }
        if (v.serviceType === 'Complimentary' && !v.complimentaryReason) { ui.toast('Give the complimentary reason', 'bad'); return false; }
        updC(c, { priority: v.priority, serviceType: v.serviceType, chargeable: v.serviceType === 'On-call', charges: v.serviceType === 'On-call' ? v.charges : 0, complimentaryReason: v.complimentaryReason, validatedAt: now().toISOString(), step: 3 }, 'Validated: ' + v.priority + ' / ' + v.serviceType);
      });
    },
    assign(c) {
      const sug = suggestEngineers(c);
      const f = ui.form([
        { key: 'engineerId', label: 'Assign engineer (manual override allowed)', type: 'select', options: staffOpts('service_engineer'), required: true },
        { key: 'remoteNote', label: 'Remote diagnosis notes', type: 'textarea' },
        { key: 'remote', label: 'Issue can be resolved remotely (no site visit)', type: 'checkbox' },
      ], { engineerId: (sug[0] || {}).e && sug[0].e.id });
      const list = h('div', { class: 'stack', style: 'gap:6px;margin-bottom:12px' }, [h('div', { class: 'small muted' }, 'Suggested by skillset, product knowledge, location, priority and workload:')].concat(sug.map((s, i) => h('div', { class: 'row', style: 'justify-content:space-between;border:1px solid var(--border);border-radius:8px;padding:6px 10px' }, [
        h('div', {}, [h('b', {}, (i === 0 ? '★ ' : '') + s.e.name), h('div', { class: 'small muted' }, s.why.join(' · '))]),
        h('div', { class: 'row' }, [ui.badge('Score ' + s.score, i === 0 ? 'ok' : ''), ui.btn('Pick', () => { f.inputs.engineerId.value = s.e.id; }, 'sm')]),
      ]))));
      ui.modal({ title: 'Engineer allocation · ' + c.id, body: h('div', {}, [list, f]), actions: [{ label: 'Cancel' }, { label: 'Assign', cls: 'primary', onClick: () => {
        if (!f.validate()) return false; const v = f.values();
        updC(c, { engineerId: v.engineerId, assignedAt: now().toISOString(), remoteNote: v.remoteNote, remote: v.remote, step: 4 }, 'Assigned to ' + master.staffName(v.engineerId));
        CRM.notify({ to: ['service_engineer'], title: 'New call assigned: ' + c.id, body: custName(c.customerId) + ' · ' + c.category + ' · ' + c.priority + ' · for ' + master.staffName(v.engineerId), link: '#/complaints/' + c.id, key: 'asg-' + c.id + '-' + v.engineerId });
        CRM.notify({ to: ['service_coordinator'], title: 'SMS/WhatsApp to customer: Engineer assigned', body: 'Our technician ' + master.staffName(v.engineerId) + ' will call you about request ' + c.id + '. — Team Maruthi', channel: 'SMS / WhatsApp', link: '#/complaints/' + c.id, key: 'asg-sms-' + c.id + '-' + v.engineerId });
        reopenAfter(() => {});
      } }] });
    },
    commit(c) {
      act(c, 'Customer commitment', [
        { key: 'commitAt', label: 'Attendance commitment date & time', type: 'datetime-local', required: true },
        { key: 'visitMode', label: 'Visit mode', type: 'select', options: ['Site visit', 'Remote session'], required: true },
      ], { commitAt: dtLocal(c.commitAt || dueAt(c, 'attend')), visitMode: c.remote ? 'Remote session' : 'Site visit' }, (v) => {
        const late = new Date(v.commitAt) > dueAt(c, 'attend');
        updC(c, { commitAt: new Date(v.commitAt).toISOString(), committedAt: now().toISOString(), remote: v.visitMode === 'Remote session', step: 5 }, 'Commitment ' + fmt.dateTime(new Date(v.commitAt)));
        if (late) ui.toast('Commitment is beyond the ' + slaHours(c, 'attend') + 'h attendance SLA — will breach', 'warn');
      });
    },
    checkin(c) {
      // attendance time is recorded at once; the geo-tag comes from the device GPS (navigator.geolocation) and falls back to a labelled simulated value
      const simulated = (why) => (11 + Math.random() / 10).toFixed(4) + ', ' + (76.9 + Math.random() / 10).toFixed(4) + ' (simulated — ' + why + ')';
      const setGeo = (geo, src) => { const cur = db.get('complaints', c.id); if (cur && cur.attendedAt && (!cur.geo || cur.geoSource === 'pending')) db.update('complaints', c.id, { geo, geoSource: src }, { note: 'Check-in geo-tag: ' + geo }); };
      const hasGps = typeof navigator !== 'undefined' && navigator.geolocation && (typeof window === 'undefined' || window.isSecureContext !== false);
      updC(c, { attendedAt: now().toISOString(), visits: (c.visits || 0) + 1, geo: hasGps ? 'Locating…' : simulated('location unavailable on this device'), geoSource: hasGps ? 'pending' : 'simulated' }, 'Engineer checked in');
      if (hasGps) {
        let settled = false;
        const fail = (why) => { if (settled) return; settled = true; setGeo(simulated(why), 'simulated'); };
        try {
          navigator.geolocation.getCurrentPosition((pos) => { if (settled) return; settled = true; setGeo(pos.coords.latitude.toFixed(5) + ', ' + pos.coords.longitude.toFixed(5) + ' (GPS ±' + Math.round(pos.coords.accuracy || 0) + ' m)', 'gps'); },
            (err) => fail(err && err.code === 1 ? 'location permission denied' : 'location unavailable'), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
        } catch (e) { fail('location unavailable'); }
        setTimeout(() => fail('location timed out'), 9000);
      }
      const s = slaState(Object.assign({}, c, { attendedAt: now().toISOString() }), 'attend');
      ui.toast('Checked in · ' + (hasGps ? 'reading GPS location' : 'geo-tag simulated (no location on this device)') + ' · attendance SLA ' + s, s === 'Met' ? 'ok' : 'warn');
      if (c.commitAt && Date.now() > new Date(c.commitAt).getTime()) note(c, 'Commitment mismatch: attended after committed time ' + fmt.dateTime(c.commitAt));
    },
    diagnose(c, after) {
      const fields = [
        { key: 'diagnosis', label: 'Diagnosis', type: 'textarea', required: true },
        { key: 'faultCode', label: c.division === 'Solar' ? 'Inverter fault code / monitoring evidence' : 'Fault code / observation' },
        c.division === 'Solar' ? { key: 'rootCause', label: 'Underperformance cause', type: 'select', options: ROOT_CAUSES, required: true } : null,
        { key: 'openSub', label: 'Call remains open because…', type: 'select', options: OPEN_SUBS, hint: 'Leave blank if work continues now' },
        { key: 'grnRef', label: 'GRN number (mandatory if product shifted to service centre)' },
        { key: 'obsHours', label: 'Observation window (TRC / Case 2)', type: 'select', options: [{ value: '24', label: '1 day (24 h)' }, { value: '48', label: '2 days (48 h)' }] },
        { key: 'revisitAt', label: 'Scheduled revisit (TRC / Case 2)', type: 'datetime-local' },
        { key: 'vendorRef', label: 'External complaint / RMA no. (battery vendor or OEM supplier claim)' },
        { key: 'vendorBrand', label: 'Vendor / supplier', type: 'select', options: VENDOR_BRANDS[c.division] || VENDOR_BRANDS.Power },
        { key: 'standbyItem', label: 'Standby material supplied (item)' },
        { key: 'sparesNeeded', label: 'Spares required?', type: 'select', options: ['No', 'Yes'], required: true },
        { key: 'spareStock', label: 'Spare part (spare parts master · live stock)', type: 'select', options: spareOpts(c.division), hint: 'Linked to the stores stock master — availability is checked on approval' },
        { key: 'spareItem', label: 'Other spare (not in master)', placeholder: c.sparesInitial || '' },
        { key: 'spareQty', label: 'Spare quantity', type: 'number', default: 1 },
      ].filter(Boolean);
      const obsH = cfg().observationHours || 24;
      act(c, 'Attendance & diagnosis · ' + c.id, fields, { diagnosis: c.diagnosis || '', sparesNeeded: c.sparesInitial ? 'Yes' : 'No', spareItem: c.sparesInitial || '', obsHours: String(obsH), revisitAt: dtLocal(new Date(Date.now() + obsH * HR)), vendorBrand: (VENDOR_BRANDS[c.division] || VENDOR_BRANDS.Power)[0] }, (v) => {
        if (v.openSub === OPEN_SUBS[0]) {
          const grn = v.grnRef || (db.one('grns', (g) => g.complaintId === c.id) || {}).id;
          if (!grn) { ui.toast('Blocked: GRN is mandatory before the service centre stage', 'bad'); CRM.notify({ to: ['service_coordinator', 'stores'], title: 'Alert: product moved without GRN — ' + c.id, body: custName(c.customerId) + ' · create the service GRN before service centre processing', link: '#/complaints/' + c.id, severity: 'bad', key: 'nogrn-' + c.id }); return false; }
          v.grnRef = grn;
        }
        if ((v.openSub === OPEN_SUBS[2] || v.openSub === SUB_SUPPLIER) && !v.vendorRef) { ui.toast('Enter the external vendor complaint / supplier RMA number', 'bad'); return false; }
        if (v.sparesNeeded === 'Yes' && !v.spareStock && !v.spareItem) { ui.toast('Select the spare part (or enter one not in the master)', 'bad'); return false; }
        const t = now().toISOString();
        const patch = { diagnosis: v.diagnosis, faultCode: v.faultCode, rootCause: v.rootCause, openSub: v.openSub || null, diagnosedAt: t, step: v.sparesNeeded === 'Yes' ? 6 : 7, sparesNotRequired: v.sparesNeeded === 'No' };
        if (!c.attendedAt) Object.assign(patch, { attendedAt: t, visits: (c.visits || 0) + 1 });
        if (v.openSub === OPEN_SUBS[1]) { const hrs = Number(v.obsHours) || obsH; patch.trcAt = t; patch.observation = { from: t, hours: hrs, revisitAt: v.revisitAt ? new Date(v.revisitAt).toISOString() : new Date(Date.now() + hrs * HR).toISOString() }; }
        if (v.openSub === OPEN_SUBS[0]) { const g = db.get('grns', v.grnRef) || db.one('grns', (x) => x.complaintId === c.id); patch.serviceCentre = { grnRef: v.grnRef, grnId: g ? g.id : null, stage: 0, inwardAt: t }; }
        if (v.openSub === OPEN_SUBS[2] || v.openSub === SUB_SUPPLIER) patch.vendorComplaint = { kind: v.openSub === SUB_SUPPLIER ? 'Supplier warranty' : 'Battery vendor', brand: v.vendorBrand || 'Others', ref: v.vendorRef, status: 'Raised', raisedAt: t };
        if (v.standbyItem) patch.standby = { item: v.standbyItem, issuedAt: t };
        updC(c, patch, 'Diagnosis recorded');
        if (v.sparesNeeded === 'Yes') { const sp = resolveSpare(v.spareStock, v.spareItem); requestSpare(c, sp.item, v.spareQty || 1, v.diagnosis, sp.stockId); }
        if (/battery/i.test(c.category + v.diagnosis) && c.division === 'Power') ui.toast('Battery replacement? Create an OTS from this call for revenue tracking', 'warn');
        if (after) after();
      });
    },
    sparesDone(c) {
      const pend = spareReqs(c.id).filter((s) => ['Requested', 'Approved', 'Awaiting stock'].includes(s.status));
      if (pend.length) { ui.toast('Blocked: ' + pend.length + ' spare request(s) awaiting approval / stock / issue', 'bad'); return; }
      updC(c, { step: 7 }, 'Spares available — proceed to repair'); CRM.refresh();
    },
    repair(c) {
      const state = Object.assign({}, c.tests || {});
      const cl = ui.checklist(testList(c), state);
      const issued = spareReqs(c.id).filter((s) => s.status === 'Issued');
      const f = ui.form([
        { key: 'actionTaken', label: 'Work performed / action taken', type: 'textarea', required: true },
        { key: 'readings', label: 'Test readings (V / A / kW / image check)' },
        { key: 'problemResolved', label: 'Problem resolved?', type: 'select', options: ['Yes', 'No — follow-up visit needed'], required: true },
      ].concat(issued.map((s) => ({ key: 'sp_' + s.id, label: 'Spare ' + s.item + ' × ' + s.qty + ' — consumption', type: 'select', options: ['Used', 'Returned'], required: true }))), { actionTaken: c.actionTaken || '', problemResolved: 'Yes' });
      const pb = evidenceWidget({ kind: 'photo', label: 'Before-service photo' }); const pa = evidenceWidget({ kind: 'photo', label: 'After-service photo' });
      ui.modal({ title: 'Repair & functional testing · ' + c.id, wide: true, body: h('div', { class: 'grid g2' }, [h('div', { class: 'stack' }, [f, h('div', { class: 'form' }, [pb.node, pa.node])]), ui.card('Functional test checklist (' + c.division + ')', cl)]), actions: [{ label: 'Cancel' }, { label: 'Save & submit tests', cls: 'primary', onClick: () => {
        if (!f.validate()) return false;
        if (!cl.complete()) { ui.toast('Blocked: all functional tests must be completed before proceeding', 'bad'); return false; }
        const v = f.values();
        issued.forEach((s) => { const st = v['sp_' + s.id]; db.update('spareRequests', s.id, { status: st, usedQty: st === 'Used' ? s.qty : 0, returnedQty: st === 'Returned' ? s.qty : 0, closedAt: now().toISOString() }, { note: 'Spare ' + st }); if (st === 'Returned') stockEvent('stock.return.requested', s, { fromEngineer: c.engineerId }); else stockEvent('stock.consumed', s, { engineerId: c.engineerId }); });
        updC(c, { actionTaken: v.actionTaken, readings: v.readings, tests: state, photosBefore: storeEv(pb.get(), 'complaints', c.id, 'photosBefore', 'Before-service photo') || c.photosBefore || '', photosAfter: storeEv(pa.get(), 'complaints', c.id, 'photosAfter', 'After-service photo') || c.photosAfter || '', problemResolved: v.problemResolved === 'Yes', repairedAt: now().toISOString(), step: 8 }, 'Repair & testing completed');
        reopenAfter(() => {});
      } }] });
    },
    report(c) {
      evModal('Service report & customer confirmation', [
        { key: 'serviceReportNo', label: 'Service report no. (auto)', type: 'readonly' },
        { key: 'confirmMode', label: 'Customer confirmation mode', type: 'select', options: ['On-site digital signature', 'OTP confirmation', 'Phone confirmation'], required: true },
        { key: 'satisfied', label: 'Customer confirms the work is completed', type: 'checkbox', required: true },
        { key: 'summary', label: 'Report summary', type: 'textarea' },
      ], { serviceReportNo: 'SR-' + c.id.slice(4) }, [{ key: 'signature', kind: 'signature', label: 'Customer signature', required: true, default: (master.customer(c.customerId) || {}).contact }], (v) => {
        updC(c, { serviceReportNo: v.serviceReportNo, confirmMode: v.confirmMode, signature: storeEv(v.signature, 'complaints', c.id, 'signature', 'Customer signature (service report)'), customerConfirmed: true, reportSummary: v.summary, reportAt: now().toISOString(), step: 9 }, 'Service report submitted');
      });
    },
    approve(c) { updC(c, { closureApprovedBy: me(), closureApprovedAt: now().toISOString() }, 'Closure approved'); ui.toast('Closure approved', 'ok'); CRM.refresh(); },
    followUp(c) {
      const f = createComplaint({ division: c.division, customerId: c.customerId, siteId: c.siteId, assetId: c.assetId, callType: 'Service', category: c.category, priority: c.priority, source: 'Service Engineer', description: 'Follow-up / repeat visit for ' + c.id + ': ' + (c.actionTaken || c.diagnosis || ''), engineerId: c.engineerId, contact: c.contact, address: c.address });
      updC(c, { followUpId: f.id }, 'Follow-up visit created ' + f.id); ui.toast('Follow-up call ' + f.id + ' created', 'ok'); CRM.refresh();
    },
    close(c) {
      const gates = closureGates(c).filter((g) => !g.ok);
      if (gates.length) { ui.toast('Closure blocked: ' + gates.map((g) => g.label).join('; '), 'bad'); return; }
      const t = now().toISOString();
      const patch = { closedAt: t, resolvedAt: c.resolvedAt || t, closedBy: me(), step: 9 };
      if (c.chargeable) patch.payment = Object.assign({ status: 'Pending', invoiceNo: 'SINV-' + c.id.slice(4) }, c.payment || {});
      // complaint.chargeable fires once per amount (a re-close after reopening does not raise a second invoice)
      const emitCharge = c.chargeable && Number(c.charges) > 0 && Number(c.chargeEmitted) !== Number(c.charges);
      if (emitCharge) patch.chargeEmitted = Number(c.charges);
      if (c.callType === 'Installation') patch.installedAt = c.installedAt || t;
      updC(c, patch, 'Call closed');
      const lk = '#/complaints/' + c.id;
      if (emitCharge) { CRM.emit('complaint.chargeable', { complaint: db.get('complaints', c.id), amount: c.charges }); CRM.notify({ to: ['accounts'], title: 'Service charges to collect: ' + fmt.money(c.charges), body: c.id + ' · ' + custName(c.customerId) + ' · invoice ' + patch.payment.invoiceNo, link: '#/svc-billing', key: 'chg-' + c.id + '-' + c.charges }); }
      if (c.callType === 'Installation') {
        const cc = db.get('complaints', c.id);
        const n = applyInstallDate(c.orderId, util.iso(cc.installedAt), { silent: false });
        CRM.emit('installation.completed', { orderId: c.orderId || null, complaintId: c.id, completedAt: cc.installedAt, closedAt: t, payment: cc.instPayment || null, scrapCollected: !!cc.scrapCollectedAt, scrapId: cc.scrapId || null, dcRef: cc.dcRef || null, invoiceRef: cc.invoiceRef || null });
        if (n) ui.toast('Warranty & PM re-based on installation date ' + fmt.date(cc.installedAt) + ' for ' + n + ' asset(s)', 'ok');
      }
      CRM.notify({ to: ['service_coordinator'], title: 'SMS/WhatsApp to customer: Call closed + feedback link', body: 'Your request ' + c.id + ' is resolved. How did we do? Reply 1–5. — Team Maruthi', channel: 'SMS / WhatsApp', link: lk, key: 'cls-sms-' + c.id + '-' + (c.reopenCount || 0) });
      ui.toast('Call ' + c.id + ' closed' + (c.chargeable ? ' · ' + fmt.money(c.charges) + ' sent to Accounts' : ''), 'ok'); CRM.refresh();
    },
    feedback(c) {
      act(c, 'Customer feedback · ' + c.id, [
        { key: 'rating', label: 'Rating (1–5)', type: 'select', options: ['5', '4', '3', '2', '1'], required: true },
        { key: 'channel', label: 'Channel', type: 'select', options: ['Call', 'SMS link', 'WhatsApp', 'Email'], required: true },
        { key: 'comment', label: 'Comments', type: 'textarea' },
      ], { channel: 'Call' }, (v) => { const f = recordFeedback(c, { rating: Number(v.rating), comment: v.comment, channel: v.channel }); ui.toast('Feedback ' + f.type + (f.rating <= cfg().negativeRating ? ' — escalated to department head' : ''), f.rating <= 2 ? 'warn' : 'ok'); });
    },
    reopen(c) {
      act(c, 'Reopen call ' + c.id, [{ key: 'reason', label: 'Reason for reopening', type: 'textarea', required: true }], {}, (v) => {
        updC(c, { closedAt: null, resolvedAt: null, closureApprovedBy: null, customerConfirmed: false, serviceReportNo: null, tests: {}, step: 5, reopenCount: (c.reopenCount || 0) + 1, notes: (c.notes || []).concat([{ at: now().toISOString(), by: CRM.user().name, text: 'Reopened: ' + v.reason }]) }, 'Reopened');
        CRM.notify({ to: ['service_coordinator', 'service_engineer'], title: 'Call reopened: ' + c.id, body: v.reason, link: '#/complaints/' + c.id, severity: 'warn', key: 'reopen-' + c.id + '-' + ((c.reopenCount || 0) + 1) });
      });
    },
    cancel(c) { act(c, 'Cancel call ' + c.id, [{ key: 'reason', label: 'Reason (duplicate / raised in error)', required: true }], {}, (v) => { const patch = { status: 'Cancelled', cancelReason: v.reason, closedAt: null }; if (isPauseSub(c.openSub)) patch.pauses = (c.pauses || []).map((p) => (p.to ? p : Object.assign({}, p, { to: now().toISOString() }))); db.update('complaints', c.id, patch, { note: 'Cancelled: ' + v.reason }); }); },
    waiting(c) {
      act(c, 'Waiting status · ' + c.id, [{ key: 'openSub', label: 'Call is waiting for… (blank = work resumes)', type: 'select', options: OPEN_SUBS.slice(3), hint: 'Waiting for customer / spares / vendor pauses the attendance & resolution SLA clocks' }, { key: 'remark', label: 'Remark' }], { openSub: isPauseSub(c.openSub) ? c.openSub : '' }, (v) => {
        updC(c, { openSub: v.openSub || (isPauseSub(c.openSub) ? null : c.openSub), notes: (c.notes || []).concat([{ at: now().toISOString(), by: CRM.user().name, text: (v.openSub ? 'Waiting: ' + v.openSub : 'Work resumed — SLA clock running') + (v.remark ? ' · ' + v.remark : '') }]) }, v.openSub ? 'SLA paused: ' + v.openSub : 'SLA resumed');
      });
    },
    observation(c) {
      const ob = c.observation || {};
      act(c, 'Observation revisit (Case 2) · ' + c.id, [
        { key: 'outcome', label: 'Revisit outcome', type: 'select', options: ['Resolved — monitoring OK', 'Not resolved — extend observation', 'Not resolved — follow-up / service centre'], required: true },
        { key: 'revisitAt', label: 'Next revisit (if extended)', type: 'datetime-local' },
        { key: 'note', label: 'Observation notes', type: 'textarea', required: true },
      ], { revisitAt: dtLocal(new Date(Date.now() + (ob.hours || 24) * HR)) }, (v) => {
        const t = now().toISOString();
        if (/extend/.test(v.outcome)) { updC(c, { observation: Object.assign({}, ob, { revisitAt: v.revisitAt ? new Date(v.revisitAt).toISOString() : ob.revisitAt, extended: (ob.extended || 0) + 1, lastNote: v.note }), visits: (c.visits || 0) + 1 }, 'Observation extended'); return; }
        updC(c, { observation: Object.assign({}, ob, { outcome: v.outcome, outcomeAt: t, lastNote: v.note }), trcClearedAt: t, openSub: null, visits: (c.visits || 0) + 1, problemResolved: /^Resolved/.test(v.outcome) ? true : c.problemResolved }, 'Observation closed: ' + v.outcome);
      });
    },
    installUpdate(c) {
      const d = installDocs(c); const pay = c.instPayment || {}; const b = c.battery || {};
      evModal('Installation update · ' + c.id, [
        { type: 'section', label: 'Installation' },
        { key: 'installed', label: 'Installation completed at site', type: 'checkbox' },
        { key: 'batteryBrand', label: 'Battery brand' }, { key: 'batteryModel', label: 'Battery model' }, { key: 'batteryQty', label: 'Battery quantity', type: 'number' }, { key: 'batteryCapacity', label: 'Battery capacity (Ah)' },
        { type: 'section', label: 'Payment collection' },
        { key: 'payMode', label: 'Payment mode', type: 'select', options: ['Cash', 'UPI', 'Bank Transfer', 'Credit', 'Partial'], required: true },
        { key: 'payStatus', label: 'Payment status', type: 'select', options: ['Pending', 'Received', 'Partial'], required: true },
        { key: 'payAmount', label: 'Amount collected ₹', type: 'number' }, { key: 'payDate', label: 'Payment date', type: 'date' },
        { type: 'section', label: 'Scrap & documents' },
        c.scrapApplicable ? { key: 'scrapType', label: 'Scrap type', type: 'select', options: ['Battery', 'UPS', 'Inverter', 'Stabilizer', 'Other'], required: true } : null,
        c.scrapApplicable ? { key: 'scrapQty', label: 'Scrap quantity collected', type: 'number', hint: 'Creates the scrap entry linked to this installation' } : null,
        { key: 'dcRef', label: 'Delivery challan (DC) no.', hint: d.dcs.length ? 'Linked DC: ' + d.dcs.map((x) => x.id).join(', ') : 'No DC linked to the SO yet' },
        { key: 'invoiceRef', label: 'Invoice no.', hint: d.invoices.length ? 'Linked invoice: ' + d.invoices.map((x) => x.invoiceNo || x.id).join(', ') : 'No invoice linked to the SO yet' },
      ].filter(Boolean), { installed: !!c.installedAt, batteryBrand: b.brand, batteryModel: b.model, batteryQty: b.qty, batteryCapacity: b.capacity, payMode: pay.mode, payStatus: pay.status || 'Pending', payAmount: pay.amount, payDate: pay.date || util.iso(CRM.TODAY), scrapType: c.scrapType || 'Battery', scrapQty: c.scrapQty || '', dcRef: c.dcRef || ((d.dcs[0] || {}).id || ''), invoiceRef: c.invoiceRef || ((d.invoices[0] || {}).invoiceNo || '') },
      [{ key: 'photos', kind: 'photo', label: 'Installation photo proof' }, { key: 'signature', kind: 'signature', label: 'Customer signature', default: (master.customer(c.customerId) || {}).contact }], (v) => {
        if (v.payStatus !== 'Pending' && !(v.payAmount > 0)) { ui.toast('Enter the amount collected', 'bad'); return false; }
        const t = now().toISOString();
        const patch = { battery: clean({ brand: v.batteryBrand, model: v.batteryModel, qty: v.batteryQty, capacity: v.batteryCapacity }), instPayment: clean({ mode: v.payMode, status: v.payStatus, amount: v.payAmount, date: v.payDate, balance: Math.max(0, (Number(c.billValue) || 0) - (Number(v.payAmount) || 0)), terms: pay.terms }), dcRef: v.dcRef, invoiceRef: v.invoiceRef, instPhotos: storeEv(v.photos, 'complaints', c.id, 'instPhotos', 'Installation photo proof') || c.instPhotos || '', instSignature: storeEv(v.signature, 'complaints', c.id, 'instSignature', 'Customer signature (installation)') || c.instSignature || '' };
        if (v.installed && !c.installedAt) patch.installedAt = t;
        if (c.scrapApplicable) { patch.scrapType = v.scrapType; patch.scrapQty = Number(v.scrapQty) || 0; }
        if (c.scrapApplicable && Number(v.scrapQty) > 0 && !c.scrapId) {
          const sr = requestScrap({ linkType: 'Installation', linkId: c.id, complaintId: c.id, orderId: c.orderId || null, customerId: c.customerId, division: c.division, scrapType: v.scrapType, qty: Number(v.scrapQty), trigger: 'Collected during installation', source: 'From Installation', status: 'Collected', location: (master.customer(c.customerId) || {}).area });
          patch.scrapId = sr ? sr.id : null; patch.scrapCollectedAt = t;
        }
        updC(c, patch, 'Installation update' + (patch.installedAt ? ' — completed' : ''));
        CRM.emit('installation.updated', { orderId: c.orderId || null, complaintId: c.id, status: installStatus(db.get('complaints', c.id)), installedAt: patch.installedAt || c.installedAt || null, payment: patch.instPayment, scrapCollected: !!(patch.scrapCollectedAt || c.scrapCollectedAt), dcRef: v.dcRef, invoiceRef: v.invoiceRef });
      });
    },
    scrap(c, reason) {
      act(c, 'Scrap entry (old material) · ' + c.id, [{ key: 'scrapType', label: 'Scrap type', type: 'select', options: ['Battery', 'UPS', 'Inverter', 'Stabilizer', 'Camera / device', 'Solar module', 'Other'], required: true }, { key: 'qty', label: 'Quantity', type: 'number', required: true }, { key: 'brand', label: 'Brand' }, { key: 'capacity', label: 'Capacity' }], { scrapType: c.division === 'Power' ? 'Battery' : 'Other', qty: 1, brand: (c.vendorComplaint || {}).brand }, (v) => {
        if (!(v.qty > 0)) { ui.toast('Quantity must be at least 1', 'bad'); return false; }
        const g = grnFor(c);
        const sr = requestScrap({ linkType: 'Complaint', linkId: c.id, complaintId: c.id, grnId: g ? g.id : null, customerId: c.customerId, division: c.division, scrapType: v.scrapType, qty: v.qty, brand: v.brand, capacity: v.capacity, trigger: reason || 'Replacement — old material', source: 'From Service', status: 'Collected', location: (master.customer(c.customerId) || {}).area });
        note(db.get('complaints', c.id), 'Scrap entry ' + (sr ? sr.id : '') + ' recorded (' + v.qty + ' × ' + v.scrapType + ')');
      });
    },
    payment(c) {
      act(c, 'Record service charge payment', [
        { key: 'amount', label: 'Amount received ₹', type: 'number', required: true },
        { key: 'mode', label: 'Mode', type: 'select', options: ['Cash', 'UPI', 'Bank Transfer'], required: true },
        { key: 'invoiceNo', label: 'Invoice link / no.', required: true },
      ], { amount: c.charges, invoiceNo: (c.payment || {}).invoiceNo }, (v) => { db.update('complaints', c.id, { payment: { status: 'Received', mode: v.mode, invoiceNo: v.invoiceNo, amount: v.amount, receivedAt: now().toISOString() } }, { note: 'Payment received' }); evaluateSoon(); ui.toast('Payment recorded', 'ok'); });
    },
  };
  // ---- spare parts master = the stores stock master (projects-owned 'stock'; read here, movements requested through events)
  const stockItems = (div) => db.all('stock').filter((s) => !div || !s.division || s.division === div || s.division === 'Common');
  const stockAvail = (s) => (s ? Math.max(0, (Number(s.current) || 0) - (Number(s.reserved) || 0)) : 0);
  const stockOf = (sp) => (sp && sp.stockId ? db.get('stock', sp.stockId) : sp && sp.item ? db.one('stock', (x) => x.name === sp.item) : null);
  function spareOpts(div) {
    const st = stockItems(div).filter((s) => !/cable|conduit|pipe/i.test(s.category || '')).sort((a, b) => (a.name > b.name ? 1 : -1));
    return st.length ? st.map((s) => ({ value: s.id, label: s.name + ' · ' + (s.code || s.id) + ' · available ' + stockAvail(s) + ' ' + (s.unit || '') })) : (SPARES[div] || SPARES.Power).map((x) => ({ value: 'TXT:' + x, label: x + ' (stock master not loaded)' }));
  }
  function resolveSpare(stockSel, text) {
    if (stockSel && !/^TXT:/.test(stockSel)) { const s = db.get('stock', stockSel); if (s) return { stockId: s.id, item: s.name }; }
    return { stockId: null, item: text || String(stockSel || '').replace(/^TXT:/, '') };
  }
  function stockEvent(evt, sp, extra) {
    const st = stockOf(sp);
    CRM.emit(evt, Object.assign({ productId: st ? (st.productId || st.id) : null, stockId: st ? st.id : null, item: sp.item, qty: Number(evt === 'stock.return.requested' ? sp.returnedQty || sp.qty : sp.qty) || 1, toEngineer: (db.get('complaints', sp.complaintId) || {}).engineerId || sp.requestedBy, complaintId: sp.complaintId, spareRequestId: sp.id, division: sp.division }, extra || {}));
  }
  function requestSpare(c, item, qty, reason, stockId) {
    const st = stockId ? db.get('stock', stockId) : db.one('stock', (x) => x.name === item);
    const s = db.insert('spareRequests', { complaintId: c.id, division: c.division, item, stockId: st ? st.id : null, qty: Number(qty) || 1, availableAtRequest: st ? stockAvail(st) : null, reason: reason || '', status: 'Requested', requestedBy: me(), requestedAt: now().toISOString() }, { prefix: 'SPR' });
    CRM.notify({ to: ['service_coordinator'], title: 'Spare approval needed: ' + item, body: c.id + ' · ' + custName(c.customerId) + ' · qty ' + s.qty + (st ? ' · ' + stockAvail(st) + ' in stock' : ' · not in stock master'), link: '#/spares', severity: 'warn', key: 'spr-' + s.id });
    if (c.step < 6 || c.step > 7) updC(db.get('complaints', c.id), { step: 6 }, 'Spare requested');
    return s;
  }
  const SPR = {
    approve(s, ok) {
      const st = stockOf(s);
      const short = ok && st && stockAvail(st) < s.qty;
      db.update('spareRequests', s.id, { status: !ok ? 'Rejected' : short ? 'Awaiting stock' : 'Approved', approvedBy: me(), approvedAt: now().toISOString(), availableAtApproval: st ? stockAvail(st) : null }, { note: !ok ? 'Rejected' : short ? 'Approved — awaiting stock (' + stockAvail(st) + ' available)' : 'Approved' });
      if (short) CRM.notify({ to: ['stores', 'purchase'], title: 'Spare out of stock: ' + s.item, body: s.complaintId + ' · need ' + s.qty + ' · available ' + stockAvail(st) + ' — raise purchase / transfer', link: '#/spares', severity: 'warn', key: 'spr-short-' + s.id });
      else if (ok) CRM.notify({ to: ['stores'], title: 'Issue spare to engineer: ' + s.item, body: s.complaintId + ' · qty ' + s.qty + (st ? ' · ' + stockAvail(st) + ' available' : ''), link: '#/spares', key: 'spr-iss-' + s.id });
      CRM.refresh();
    },
    recheck(s) { const st = stockOf(s); if (st && stockAvail(st) < s.qty) { ui.toast('Still short: ' + stockAvail(st) + ' available', 'warn'); return; } db.update('spareRequests', s.id, { status: 'Approved' }, { note: 'Stock available — ready to issue' }); CRM.refresh(); },
    issue(s) {
      const st = stockOf(s);
      if (st && stockAvail(st) < s.qty) { ui.toast('Blocked: only ' + stockAvail(st) + ' ' + s.item + ' available in stock', 'bad'); return; }
      db.update('spareRequests', s.id, { status: 'Issued', issuedAt: now().toISOString(), issuedBy: me(), stockMove: st ? 'Issue requested to stores' : 'Not in stock master' }, { note: 'Issued to engineer' });
      stockEvent('stock.issue.requested', db.get('spareRequests', s.id));
      CRM.notify({ to: ['service_engineer'], title: 'Spare issued: ' + s.item, body: s.complaintId, link: '#/complaints/' + s.complaintId, key: 'spr-got-' + s.id }); CRM.refresh();
    },
  };
  // ---- scrap entries (projects-owned 'scrap' collection): requested through 'scrap.create.requested';
  // if no listener created it, the entry is recorded here with the same schema so the replacement is never left without scrap
  function requestScrap(v) {
    const payload = Object.assign({ status: 'Pending Collection', collectedBy: me(), storedAt: 'Service Centre' }, clean(v));
    const find = () => db.one('scrap', (x) => x.linkType === payload.linkType && x.linkId === payload.linkId && x.trigger === payload.trigger);
    CRM.emit('scrap.create.requested', payload);
    return find() || db.insert('scrap', Object.assign({ history: [{ ts: now().toISOString(), by: CRM.user().name, text: 'Scrap entry from ' + payload.linkType + ' ' + payload.linkId + ' (service)' }], viol: [] }, payload), { prefix: 'SCR', note: 'Scrap entry from ' + payload.linkType + ' ' + payload.linkId });
  }
  const scrapFor = (c) => db.find('scrap', (x) => x.linkId === c.id || x.complaintId === c.id || (c.orderId && x.linkType === 'Installation' && x.orderId === c.orderId));
  const grnFor = (c) => (c.serviceCentre && (db.get('grns', c.serviceCentre.grnId) || db.get('grns', c.serviceCentre.grnRef))) || db.one('grns', (g) => g.complaintId === c.id);
  function installDocs(c) {
    const ids = [c.orderId, c.soNumber].filter(Boolean);
    const dcs = db.find('dcs', (d) => (ids.length && (ids.includes(d.linkId) || ids.includes(d.orderId) || ids.includes(d.soNumber))) || d.linkId === c.id);
    const invoices = c.orderId ? db.find('invoices', (i) => i.orderId === c.orderId || (c.soNumber && i.soNumber === c.soNumber)) : [];
    return { dcs, invoices, dc: c.dcRef || (dcs[0] || {}).id || '', invoice: c.invoiceRef || (invoices[0] || {}).invoiceNo || '' };
  }
  function grnMetrics() {
    const svcG = db.all('grns').filter((g) => /service/i.test(g.type || '') || g.complaintId);
    const deliveredOpen = svcG.filter((g) => g.status === 'Delivered' && g.complaintId && isOpen(db.get('complaints', g.complaintId) || { status: 'Closed' }));
    const missing = db.all('complaints').filter((c) => isOpen(c) && c.serviceCentre && !grnFor(c));
    return { svcG, deliveredOpen, missing, pendingInward: svcG.filter((g) => g.status === 'Pending Inward') };
  }
  function installStatus(c) { if (c.closedAt) return 'Closed'; if (c.status === 'Cancelled') return 'Cancelled'; if (c.installedAt) return 'Completed'; if (c.attendedAt) return 'In Progress'; if (c.engineerId) return 'Assigned'; return 'Pending'; }
  const isReplacement = (c) => !!(c.vendorComplaint && c.vendorComplaint.kind !== 'Supplier warranty' && VENDOR_STAGES.indexOf(c.vendorComplaint.status) >= 2);

  // ================================================================ complaint detail
  function actionPanel(c) {
    const box = h('div', { class: 'stack', style: 'gap:10px' });
    const btns = h('div', { class: 'row' });
    const add = (label, fn, cls, ok) => { if (ok !== false) btns.appendChild(ui.btn(label, fn, cls || 'primary')); };
    const ro = (txt) => box.appendChild(txtCallout(txt)); // plain text — user-entered values are never parsed as HTML
    const roHtml = (html) => box.appendChild(htmlCallout(html));
    if (c.status === 'Cancelled') { ro('This call was cancelled: ' + (c.cancelReason || '')); return box; }
    if (c.closedAt) {
      box.appendChild(txtCallout('Closed ' + fmt.dateTime(c.closedAt) + ' · resolution ' + dur((new Date(c.closedAt) - new Date(c.createdAt)) / HR) + (c.feedbackId ? ' · feedback ' + c.rating + '/5' : ' · feedback pending'), 'ok'));
      add('Capture feedback', () => A.feedback(c), 'primary', !c.feedbackId && (canCoord() || roleIs('service_engineer')));
      add('Reopen call', () => A.reopen(c), '', canCoord());
      box.appendChild(btns); return box;
    }
    const s = c.step;
    box.appendChild(h('div', {}, [h('div', { class: 'small muted' }, 'Current step ' + (s + 1) + ' of 10'), h('h3', {}, STEPS[s])]));
    if (s === 1) { ro('Coordinator must call the customer, verify details and inform service charges (if applicable) within ' + Math.round(slaHours(c, 'ack') * 60) + ' minutes.'); add('Acknowledge', () => A.ack(c), 'primary', canCoord()); add('Cancel (duplicate)', () => A.cancel(c), '', canCoord()); }
    if (s === 2) { roHtml('Validate priority and warranty / AMC coverage. Coverage auto-checked: <b>' + esc(c.coverage) + '</b>.'); add('Validate', () => A.validate(c), 'primary', canCoord()); }
    if (s === 3) { add('Assign engineer (suggestions)', () => A.assign(c), 'primary', canCoord()); }
    if (s === 4) { add('Record customer commitment', () => A.commit(c), 'primary', canEng(c)); }
    if (s === 5) {
      if (!c.attendedAt) add(c.remote ? 'Start remote session' : 'Check-in at site (geo-tag)', () => { A.checkin(c); CRM.refresh(); }, 'primary', canEng(c));
      add('Record diagnosis', () => A.diagnose(c), c.attendedAt ? 'primary' : '', canEng(c));
    }
    if (s === 6) {
      const pend = spareReqs(c.id).filter((x) => ['Requested', 'Approved', 'Awaiting stock'].includes(x.status));
      roHtml(pend.length ? pend.length + ' spare request(s) pending approval / stock / issue — the call is <b>Waiting</b>.' : 'All spares issued or decided. Proceed to repair.');
      add('Request another spare', () => spareForm(c), '', canEng(c));
      add('Proceed to repair', () => A.sparesDone(c), 'primary', canEng(c));
    }
    if (s === 7) add('Repair & test', () => A.repair(c), 'primary', canEng(c));
    if (s === 8) add('Service report & customer confirmation', () => A.report(c), 'primary', canEng(c));
    if (s === 9) {
      const gates = closureGates(c);
      box.appendChild(h('div', { class: 'checklist' }, gates.map((g) => h('label', { class: g.ok ? 'done' : '' }, [h('span', {}, g.ok ? '✅' : '⛔'), h('span', {}, g.label + (g.hint ? ' — ' + g.hint : ''))]))));
      add('Approve closure', () => A.approve(c), 'ok', needsApproval(c) && !c.closureApprovedBy && canCoord());
      add('Create follow-up visit', () => A.followUp(c), '', c.problemResolved === false && !c.followUpId && (canCoord() || canEng(c)));
      add('Close call', () => A.close(c), 'primary', canCoord() || (canEng(c) && !needsApproval(c)));
    }
    if (s >= 5 && s <= 8 && (canEng(c) || canCoord())) btns.appendChild(ui.btn(isPauseSub(c.openSub) ? '▶ Resume (SLA paused: ' + c.openSub + ')' : '⏸ Waiting status', () => A.waiting(c), 'sm'));
    if (c.observation && !c.observation.outcome && (canEng(c) || canCoord())) btns.appendChild(ui.btn('Record observation revisit', () => A.observation(c), 'sm primary'));
    if (c.callType === 'Installation' && s >= 4 && (canEng(c) || canCoord())) btns.appendChild(ui.btn('Installation update (payment · scrap · photos)', () => A.installUpdate(c), 'sm primary'));
    if (isReplacement(c) && !scrapFor(c).length && (canEng(c) || canCoord())) btns.appendChild(ui.btn('+ Scrap entry (old battery)', () => A.scrap(c, 'Vendor replacement — old battery'), 'sm'));
    if (s >= 5 && (canEng(c) || canCoord())) btns.appendChild(ui.btn('+ OTS', () => openOtsForm(c), 'sm'));
    if (!btns.children.length) ro('No action for your role at this step. ' + (roleIs('service_engineer') ? 'Waiting for the coordinator.' : 'Owner: ' + (s <= 3 ? 'Service Coordinator' : master.staffName(c.engineerId))));
    box.appendChild(btns);
    return box;
  }

  // ---- service centre (Case 1): stages synced with the Service GRN; quotation & customer approval on chargeable jobs
  const scStages = (c) => (c.chargeable ? SC_STAGES.paid : SC_STAGES.free);
  const SC_TO_GRN = { 'Inward (GRN)': 'Inward Created', Processing: 'Under Service', Testing: 'Under Service', Quotation: 'Under Service', 'Customer approval': 'Under Service', Repair: 'Ready for Dispatch', Delivered: 'Delivered', 'Payment received': 'Delivered' };
  const GRN_TO_SC = { 'Inward Created': 'Inward (GRN)', 'Under Service': 'Processing', 'Ready for Dispatch': 'Repair', Delivered: 'Delivered' };
  const canSC = (c) => roleIs('service_centre_tech', 'service_coordinator', 'admin') || canEng(c);
  // pull: a GRN moved by stores advances the complaint's service-centre stage (never backwards)
  function syncScFromGrn(c, g) {
    if (!c || !c.serviceCentre || !g || !isOpen(c)) return false;
    const st = scStages(c); const target = st.indexOf(GRN_TO_SC[g.status]);
    if (target <= c.serviceCentre.stage) return false;
    // chargeable jobs cannot skip quotation / approval
    const qi = st.indexOf('Customer approval'); const capped = qi >= 0 && !(c.serviceCentre.approval || {}).status ? Math.min(target, st.indexOf('Quotation')) : target;
    if (capped <= c.serviceCentre.stage) return false;
    updC(c, { serviceCentre: Object.assign({}, c.serviceCentre, { stage: capped, grnId: g.id, grnStatus: g.status }) }, 'Service centre synced from GRN ' + g.id + ': ' + st[capped]);
    return true;
  }
  CRM.on('grns:updated', (g) => { if (g && g.complaintId) safe(() => syncScFromGrn(db.get('complaints', g.complaintId), g), null); });
  function scAdvance(c) {
    const sc = c.serviceCentre; const st = scStages(c); const nx = st[sc.stage + 1]; const g = grnFor(c);
    const done = (patch, noteText) => {
      const nsc = Object.assign({}, sc, patch, { stage: sc.stage + 1, ['at_' + (sc.stage + 1)]: now().toISOString() });
      const extra = {};
      if (nx === 'Customer approval' && patch.approval && patch.approval.status === 'Approved') { extra.charges = Number((sc.quote || {}).amount) || c.charges; }
      if (nx === 'Payment received') extra.payment = Object.assign({}, c.payment || {}, { status: 'Received', mode: patch.payMode, amount: c.charges, receivedAt: now().toISOString(), invoiceNo: (c.payment || {}).invoiceNo || 'SINV-' + c.id.slice(4) });
      updC(c, Object.assign({ serviceCentre: nsc }, extra), noteText || 'Service centre: ' + nx);
      CRM.emit('service.centre.stage', { complaintId: c.id, grnId: g ? g.id : (sc.grnId || sc.grnRef || null), stage: sc.stage + 1, stageName: nx, grnStatus: SC_TO_GRN[nx] || null });
      if (g && SC_TO_GRN[nx] && SGRN_ORDER.indexOf(g.status) < SGRN_ORDER.indexOf(SC_TO_GRN[nx])) CRM.notify({ to: ['stores'], title: 'Update Service GRN ' + g.id + ' → ' + SC_TO_GRN[nx], body: c.id + ' · service centre stage ' + nx, link: '#/grn', key: 'scgrn-' + g.id + '-' + nx });
    };
    if (nx === 'Quotation') return act(c, 'Service centre quotation · ' + c.id, [{ key: 'no', label: 'Quotation no.', type: 'readonly' }, { key: 'details', label: 'Repair scope / parts', type: 'textarea', required: true }, { key: 'amount', label: 'Quotation amount ₹', type: 'number', required: true }], { no: 'SCQ-' + c.id.slice(4), amount: c.charges || '' }, (v) => { if (!(v.amount > 0)) { ui.toast('Enter the quotation amount', 'bad'); return false; } done({ quote: { no: v.no, details: v.details, amount: v.amount, sentAt: now().toISOString(), by: me() } }, 'Service centre quotation ' + fmt.money(v.amount)); });
    if (nx === 'Customer approval') return act(c, 'Customer approval · ' + (sc.quote || {}).no, [{ key: 'status', label: 'Customer decision', type: 'select', options: ['Approved', 'Rejected — return unrepaired'], required: true }, { key: 'by', label: 'Approved by (customer contact)', required: true }, { key: 'mode', label: 'Approval mode', type: 'select', options: ['Phone', 'Email', 'WhatsApp', 'Signed quotation'], required: true }], { by: (master.customer(c.customerId) || {}).contact }, (v) => {
      const ok = v.status === 'Approved'; const ap = { status: ok ? 'Approved' : 'Rejected', by: v.by, mode: v.mode, at: now().toISOString() };
      if (!ok) { updC(c, { serviceCentre: Object.assign({}, sc, { approval: ap, stage: st.indexOf('Delivered') - 1 }) }, 'Customer rejected quotation — return unrepaired'); return; }
      done({ approval: ap }, 'Customer approved quotation ' + fmt.money((sc.quote || {}).amount));
    });
    if (nx === 'Delivered') return act(c, 'Outward — deliver to customer', [{ key: 'mode', label: 'Outward mode', type: 'select', options: ['Engineer delivery', 'Customer pickup', 'Courier'], required: true }, { key: 'dcRef', label: 'Outward DC / gate pass no.' }, { key: 'receivedBy', label: 'Received by (customer)', required: true }], { receivedBy: (master.customer(c.customerId) || {}).contact }, (v) => { done({ outward: { at: now().toISOString(), by: me(), mode: v.mode, dcRef: v.dcRef, receivedBy: v.receivedBy } }, 'Delivered to customer (' + v.mode + ')'); });
    if (nx === 'Payment received') return act(c, 'Service centre payment', [{ key: 'payMode', label: 'Mode', type: 'select', options: ['Cash', 'UPI', 'Bank Transfer'], required: true }], {}, (v) => { done({ payMode: v.payMode }); });
    done({}); CRM.refresh();
  }
  const SGRN_ORDER = ['Pending Inward', 'Inward Created', 'Under Service', 'Ready for Dispatch', 'Delivered'];
  function scPanel(c) {
    const sc = c.serviceCentre; const st = scStages(c); const g = grnFor(c);
    const want = SC_TO_GRN[st[sc.stage]]; const lag = g && want && SGRN_ORDER.indexOf(g.status) < SGRN_ORDER.indexOf(want);
    return h('div', { class: 'stack' }, [
      ui.stepper(st, sc.stage),
      ui.dl([['GRN', g ? g.id + ' · ' + g.status : (sc.grnRef || '—') + ' (not found in GRN register)'], ['Inward', fmt.dateTime(sc.inwardAt)], sc.quote ? ['Quotation', sc.quote.no + ' · ' + fmt.money(sc.quote.amount) + ' · ' + sc.quote.details] : null, sc.approval ? ['Customer approval', sc.approval.status + ' · ' + sc.approval.by + ' (' + sc.approval.mode + ') · ' + fmt.dateTime(sc.approval.at)] : null, sc.outward ? ['Outward', sc.outward.mode + ' · ' + fmt.dateTime(sc.outward.at) + (sc.outward.dcRef ? ' · ' + sc.outward.dcRef : '') + ' · received by ' + sc.outward.receivedBy] : null].filter(Boolean)),
      !g ? txtCallout('Missing GRN — the service GRN must exist in the GRN register before processing.', 'bad') : lag ? txtCallout('GRN status (' + g.status + ') is behind the service-centre stage — stores have been asked to move it to "' + want + '".', 'warn') : null,
      h('div', { class: 'row' }, [sc.stage < st.length - 1 && canSC(c) && isOpen(c) ? ui.btn('Advance to ' + st[sc.stage + 1], () => scAdvance(c), 'sm primary') : ui.badge(sc.stage >= st.length - 1 ? 'Cycle complete' : 'In service centre', sc.stage >= st.length - 1 ? 'ok' : 'info'), g && canSC(c) && syncNeeded(c, g) ? ui.btn('Sync from GRN', () => { syncScFromGrn(c, g); CRM.refresh(); }, 'sm') : null]),
    ]);
  }
  const syncNeeded = (c, g) => scStages(c).indexOf(GRN_TO_SC[g.status]) > c.serviceCentre.stage;
  function installPanel(c) {
    const d = installDocs(c); const pay = c.instPayment || {}; const b = c.battery || {}; const o = c.orderId ? db.get('orders', c.orderId) : null; const st = installStatus(c);
    return h('div', { class: 'stack' }, [
      ui.stepper(['Pending', 'Assigned', 'In Progress', 'Completed', 'Closed'], ['Pending', 'Assigned', 'In Progress', 'Completed', 'Closed'].indexOf(st) + (st === 'Closed' ? 1 : 0)),
      ui.dl([['Installation status', ui.badge(st, st === 'Closed' || st === 'Completed' ? 'ok' : 'warn')], ['SO status (Sales)', o ? (o.installationStatus || '—') + (o.installationCompletionDate ? ' · ' + fmt.date(o.installationCompletionDate) : '') : '—'], ['Product / qty', (c.productType || c.productDetails || '') + ' × ' + (c.qty || 1)], ['Battery details', b.brand || b.model ? [b.brand, b.model, b.qty ? b.qty + ' nos' : '', b.capacity].filter(Boolean).join(' · ') : '—'], ['Bill value', fmt.money(c.billValue)],
        ['Payment mode / status', (pay.mode || '—') + ' · ' + (pay.status || 'Pending') + (pay.terms ? ' (terms: ' + pay.terms + ')' : '')], ['Collected / balance', fmt.money(pay.amount) + ' / ' + fmt.money(pay.balance != null ? pay.balance : (Number(c.billValue) || 0) - (Number(pay.amount) || 0))],
        ['Scrap', c.scrapApplicable ? (c.scrapQty || 0) + ' × ' + (c.scrapType || 'scrap') + ' · ' + (c.scrapId ? 'entry ' + c.scrapId : c.scrapCollectedAt ? 'collected ' + fmt.date(c.scrapCollectedAt) : 'pending') : 'Not applicable'],
        ['Delivery challan', d.dc || '—'], ['Invoice', d.invoice || '—'], ['Installed at', fmt.dateTime(c.installedAt)], ['Photo proof / signature', (evOk(c, 'complaints', 'instPhotos') ? '✓' : '✗') + ' / ' + (c.instSignature ? (/^ATT:/.test(c.instSignature) ? '✓ signed' : c.instSignature) : '✗')]]),
    ]);
  }
  function obsPanel(c) {
    const ob = c.observation; const end = new Date(new Date(ob.from).getTime() + ob.hours * HR);
    return h('div', { class: 'stack' }, [ui.dl([['Monitoring window', ob.hours + ' h · ' + fmt.dateTime(ob.from) + ' → ' + fmt.dateTime(end)], ['Scheduled revisit', fmt.dateTime(ob.revisitAt) + (ob.extended ? ' (extended ×' + ob.extended + ')' : '')], ['Outcome', ob.outcome ? ob.outcome + ' · ' + fmt.dateTime(ob.outcomeAt) : ui.badge(hrsSince(ob.revisitAt) > 0 ? 'Revisit overdue' : 'Monitoring', hrsSince(ob.revisitAt) > 0 ? 'bad' : 'info')], ['Notes', ob.lastNote]])]);
  }
  // commissioning report & last PM report for the engineer (Solar §5.4)
  function assetReports(a) {
    const p = a.projectId ? db.get('projects', a.projectId) : null;
    const comm = (p && anyField(p, ['commissionedAt', 'commissioningCertAt', 'commissioningReportAt', 'commissioningAt'])) || a.commissionDate;
    const lp = db.find('pmVisits', (v) => (v.assetIds || []).includes(a.id) && v.completedDate).sort((x, y) => (x.completedDate < y.completedDate ? 1 : -1))[0];
    const items = lp ? Object.keys(lp.checklist || {}).length : 0;
    return ui.dl([['Commissioning report', (p ? (p.commissioningReportNo || 'Project ' + p.id) : 'Commissioning record ' + a.id) + ' · ' + fmt.date(comm)], ['Installed / capacity', fmt.date(a.installDate) + (a.capacity ? ' · ' + a.capacity : '')], ['Last PM report', lp ? link('#/pm/' + lp.id, lp.id + ' · ' + fmt.date(lp.completedDate)) : '—'], ['Last PM findings', lp ? (lp.findings || '—') + ' · ' + items + ' checks' + (lp.readings ? ' · ' + lp.readings : '') : '—']]);
  }
  function spareForm(c) {
    act(c, 'Request spare', [{ key: 'stock', label: 'Spare part (spare parts master · live stock)', type: 'select', options: spareOpts(c.division) }, { key: 'item', label: 'Other spare (not in master)' }, { key: 'qty', label: 'Qty', type: 'number', required: true }], { qty: 1 }, (v) => {
      if (!v.stock && !v.item) { ui.toast('Select a spare or enter one', 'bad'); return false; }
      if (!(v.qty > 0)) { ui.toast('Quantity must be at least 1', 'bad'); return false; }
      const sp = resolveSpare(v.stock, v.item); const st = sp.stockId && db.get('stock', sp.stockId);
      requestSpare(c, sp.item, v.qty, c.diagnosis, sp.stockId);
      if (st && stockAvail(st) < v.qty) ui.toast('Only ' + stockAvail(st) + ' in stock — stores / purchase will be alerted on approval', 'warn');
    });
  }

  function renderComplaint(el, id) {
    const c = db.get('complaints', id);
    if (!c) { el.appendChild(ui.empty('Complaint not found')); return; }
    if (roleIs('service_engineer') && c.engineerId !== me()) { el.appendChild(ui.empty('This call is not assigned to you — engineers see only their own calls.', '🔒')); return; }
    const cust = master.customer(c.customerId) || {};
    const asset = c.assetId ? db.get('assets', c.assetId) : null;
    ui.page(el, { title: c.id + ' · ' + cust.name, crumbs: 'Service › Complaints › ' + c.id, sub: c.division + ' · ' + c.callType + ' · ' + c.category, actions: [ui.btn('← Queue', () => CRM.go('complaints')), CRM.canSee('customer360') ? ui.btn('Customer 360', () => CRM.go('customer360', c.customerId)) : null] });
    el.appendChild(h('div', { class: 'row', style: 'margin:-6px 0 12px' }, [ui.divTag(c.division), ui.badge(c.status), priBadge(c.priority), ui.badge(c.serviceType, 'brand'), covBadge(c.coverage), c.safetyCritical ? ui.badge('Safety-critical', 'violet') : null, c.repeatOf ? h('a', { href: '#/complaints/' + c.repeatOf }, ui.badge('Repeat of ' + c.repeatOf, 'warn')) : null, c.reopenCount ? ui.badge('Reopened ×' + c.reopenCount, 'warn') : null, c.openSub ? ui.badge(c.openSub, 'warn') : null, c.chargeable ? ui.badge('Chargeable ' + fmt.money(c.charges), 'warn') : null]));
    el.appendChild(ui.card(null, ui.stepper(STEPS, c.closedAt ? (c.feedbackId ? 10 : 9) : c.step, c.status === 'Waiting')));
    const left = h('div', { class: 'stack span2' });
    const right = h('div', { class: 'stack' });
    left.appendChild(ui.card('Workflow action', actionPanel(c)));
    left.appendChild(ui.card('Complaint details (15 parameters)', ui.dl([
      ['1 · Complaint ID', c.id], ['2 · Customer', cust.name], ['3 · Contact number', c.contact + (c.altContact ? ' / ' + c.altContact : '')], ['4 · Address', c.address],
      ['5 · Description', c.description], ['6 · Product details', c.productDetails], ['7 · Serial number', c.serial], ['8 · Service type', c.serviceType],
      ['9 · Call type', c.callType], ['10 · Priority', c.priority], ['11 · Commitment', c.commitAt ? fmt.dateTime(c.commitAt) : '—'], ['12 · Previous complaints', String(c.prevCount || 0)],
      ['13 · Spares (initial)', c.sparesInitial], ['14 · Special instructions', c.instructions], ['15 · Source', c.source + (c.reportedBy ? ' · ' + c.reportedBy : '')], ['System type', c.systemType],
      ['Coordinator', master.staffName(c.coordinatorId)], ['Engineer', master.staffName(c.engineerId)], ['Diagnosis', c.diagnosis], ['Action taken', c.actionTaken],
      c.division === 'Solar' ? ['Fault code / cause', (c.faultCode || '—') + ' · ' + (c.rootCause || '—')] : null, ['Resolution mode', c.remote ? 'Remote' : 'Site visit (' + (c.visits || 0) + ')'],
      c.orderId ? ['Sales Order', c.soNumber || c.orderId] : null, c.pmVisitId ? ['From PM visit', link('#/pm/' + c.pmVisitId, c.pmVisitId)] : null,
    ])));
    const reqs = spareReqs(c.id);
    if (reqs.length || c.step === 6) left.appendChild(ui.card('Spares (requisition → approval → issue → used / returned)', sparesTable(reqs, true), { flush: true }));
    if (c.serviceCentre) left.appendChild(ui.card('Service centre (Case 1 — product shifted) · GRN ' + (c.serviceCentre.grnId || c.serviceCentre.grnRef || '—'), scPanel(c)));
    if (c.vendorComplaint) {
      const vc = c.vendorComplaint; const i = VENDOR_STAGES.indexOf(vc.status); const sup = vc.kind === 'Supplier warranty';
      left.appendChild(ui.card((sup ? 'Supplier warranty claim (OEM)' : 'Battery vendor complaint (Case 3)') + ' · ' + vc.brand + ' ' + vc.ref, h('div', {}, [ui.stepper(VENDOR_STAGES, i), i < VENDOR_STAGES.length - 1 && (canCoord() || canEng(c)) ? ui.btn('Vendor status → ' + VENDOR_STAGES[i + 1], () => { updC(c, { vendorComplaint: Object.assign({}, vc, { status: VENDOR_STAGES[i + 1], closedAt: VENDOR_STAGES[i + 1] === 'Closed' ? now().toISOString() : null }) }, 'Vendor complaint: ' + VENDOR_STAGES[i + 1]); if (VENDOR_STAGES[i + 1] === 'Replacement approved' && !sup) ui.toast('Replacement approved — record the scrap entry for the old battery', 'warn'); CRM.refresh(); }, 'sm primary') : ui.badge('Closure confirmed', 'ok')])));
    }
    if (c.standby) left.appendChild(ui.card('Standby material', h('div', { class: 'row', style: 'justify-content:space-between' }, [h('div', {}, [h('b', {}, c.standby.item), h('div', { class: 'small muted' }, 'Issued ' + fmt.dateTime(c.standby.issuedAt) + ' · ' + (c.standby.collectedAt ? 'collected ' + fmt.dateTime(c.standby.collectedAt) : Math.round(hrsSince(c.standby.issuedAt) / 24) + ' days at site (policy: 7 days)'))]), !c.standby.collectedAt && (canCoord() || canEng(c)) ? ui.btn('Mark collected', () => { updC(c, { standby: Object.assign({}, c.standby, { collectedAt: now().toISOString() }) }, 'Standby collected'); CRM.refresh(); }, 'sm') : ui.badge(c.standby.collectedAt ? 'Collected' : 'At site', c.standby.collectedAt ? 'ok' : 'warn')])));
    if (c.chargeable) { const p = c.payment || {}; left.appendChild(ui.card('Payment tracking', h('div', { class: 'row', style: 'justify-content:space-between' }, [ui.dl([['Service charges', fmt.money(c.charges)], ['Payment status', ui.badge(p.status || 'Not billed')], ['Mode', p.mode], ['Invoice', p.invoiceNo]]), c.closedAt && p.status !== 'Received' && roleIs('accounts', 'service_coordinator', 'admin') ? ui.btn('Record payment', () => A.payment(c), 'sm primary') : null]))); }
    const ots = db.find('ots', (o) => o.complaintId === c.id);
    if (ots.length) left.appendChild(ui.card('OTS from this call', h('div', { class: 'stack', style: 'gap:4px' }, ots.map((o) => h('div', { class: 'row' }, [link('#/ots/' + o.id, o.id), ui.badge(o.otsType, o.otsType === 'Service OTS' ? 'brand' : 'violet'), o.qty + ' × ' + o.productType + ' · ' + fmt.money(o.value), ui.badge(o.status)])))));
    if (c.callType === 'Installation') left.appendChild(ui.card('Installation record (synced with SO ' + (c.soNumber || c.orderId || '—') + ')', installPanel(c)));
    if (c.observation) left.appendChild(ui.card('Observation (Case 2) — monitoring window & revisit', obsPanel(c)));
    const scr = scrapFor(c);
    if (scr.length) left.appendChild(ui.card('Scrap entries linked to this call', h('div', { class: 'stack', style: 'gap:4px' }, scr.map((x) => h('div', { class: 'row small' }, [mono(x.id), ' ' + (x.qty || 1) + ' × ' + (x.scrapType || '') + ' ', ui.badge(x.status || 'Pending Collection'), x.grnId ? ' · GRN ' + x.grnId : '']))))); 
    if (ui.attachments) { const att = safe(() => nodeOf(ui.attachments('complaints', c.id, { roles: SVC_VIEW })), null); if (att) left.appendChild(ui.card('Attachments (photos, reports, signatures)', att)); }
    // right column
    right.appendChild(ui.card('SLA clocks (' + c.division + ' · ' + c.priority + (bizMode(c) ? ' · business hours' : ' · 24×7') + ')', ui.dl([
      ['Acknowledgement (' + dur(slaHours(c, 'ack')) + ')', slaBadge(c, 'ack')], ['Attendance (' + slaHours(c, 'attend') + 'h)', slaBadge(c, 'attend')], ['Resolution (' + slaHours(c, 'resolve') + 'h)', slaBadge(c, 'resolve')],
      ['Commitment', c.commitAt ? (c.attendedAt ? (new Date(c.attendedAt) <= new Date(c.commitAt) ? ui.badge('Met', 'ok') : ui.badge('Mismatch', 'bad')) : fmt.dateTime(c.commitAt)) : '—'],
      ['Ageing', dur(((c.closedAt ? new Date(c.closedAt) : Date.now()) - new Date(c.createdAt)) / HR)], ['Attended but open', c.attendedAt && !c.closedAt ? dur(hrsSince(c.attendedAt)) : '—'], ['SLA paused', (c.pauses || []).length ? dur(pausedHours(c, 'resolve', c.closedAt || Date.now())) + ' · ' + c.pauses.map((p) => p.reason).filter((x, k, a) => a.indexOf(x) === k).join(', ') + (isPaused(c) ? ' (paused now)' : '') : '—'],
    ])));
    const prev = db.find('complaints', (x) => x.customerId === c.customerId && x.id !== c.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    right.appendChild(ui.card('Customer & equipment', h('div', { class: 'stack', style: 'gap:10px' }, [
      ui.dl([['Customer', CRM.canSee('customer360') ? link('#/customer360/' + c.customerId, cust.name) : cust.name], ['Type', cust.type], ['Equipment', asset ? link('#/assets/' + asset.id, asset.id + ' · ' + asset.name) : '—'], ['Install date', asset ? fmt.date(asset.installDate) : '—'], ['Warranty end', asset ? fmt.date(asset.warrantyEnd) : '—'], ['Capacity', (asset && asset.capacity) || c.capacity || '—'], ['AMC status (' + c.division + ')', customerAmcStatus(c.customerId, c.division)], ['Last PM', fmt.date(c.lastPmDate)], ['Project', c.projectId || '—']]),
      h('div', {}, [h('div', { class: 'small muted' }, 'Previous complaints (' + prev.length + ')')].concat(prev.slice(0, 5).map((x) => h('div', { class: 'small' }, [link('#/complaints/' + x.id, x.id), ' · ' + fmt.date(x.createdAt) + ' · ' + x.category])))),
    ])));
    if (asset) right.appendChild(ui.card('Commissioning & last PM report', assetReports(asset)));
    right.appendChild(ui.card('Timeline', ui.timeline(timelineOf(c))));
    right.appendChild(ui.card('Audit trail', ui.auditTrail('complaints', c.id)));
    el.appendChild(h('div', { class: 'grid g3 mt' }, [left, right]));
  }

  function sparesTable(rows, compact) {
    return ui.table({ rows, search: !compact, pageSize: compact ? 8 : 15, columns: [
      { key: 'id', label: 'Request', render: (s) => mono(s.id) }, compact ? null : { key: 'complaintId', label: 'Complaint', render: (s) => link('#/complaints/' + s.complaintId, s.complaintId) },
      { key: 'item', label: 'Spare item', render: (s) => h('div', {}, [s.item, h('div', { class: 'small muted' }, s.stockId ? 'Stock ' + ((db.get('stock', s.stockId) || {}).code || s.stockId) : 'Not in stock master')]), csv: (s) => s.item }, { key: 'qty', label: 'Qty', cls: 'right' },
      { key: 'avail', label: 'In stock', cls: 'right', render: (s) => { const st = stockOf(s); if (!st) return '—'; const a = stockAvail(st); return ui.badge(a, ['Requested', 'Approved', 'Awaiting stock'].includes(s.status) && a < s.qty ? 'bad' : 'ok'); }, csv: (s) => stockAvail(stockOf(s)) },
      { key: 'requestedBy', label: 'Requested by', render: (s) => master.staffName(s.requestedBy) },
      { key: 'requestedAt', label: 'Requested', render: (s) => fmt.dateTime(s.requestedAt) }, { key: 'status', label: 'Status', render: (s) => ui.badge(s.status, s.status === 'Requested' || s.status === 'Awaiting stock' ? 'warn' : s.status === 'Issued' ? 'info' : null) },
    ].filter(Boolean), actions: (s) => [
      s.status === 'Requested' && canCoord() ? ui.btn('Approve', () => SPR.approve(s, true), 'sm ok') : null, s.status === 'Requested' && canCoord() ? ui.btn('Reject', () => SPR.approve(s, false), 'sm') : null,
      s.status === 'Awaiting stock' && roleIs('service_coordinator', 'stores', 'admin') ? ui.btn('Re-check stock', () => SPR.recheck(s), 'sm') : null,
      s.status === 'Approved' && roleIs('service_coordinator', 'stores', 'admin') ? ui.btn('Issue to engineer', () => SPR.issue(s), 'sm primary') : null,
    ].filter(Boolean) });
  }

  // ================================================================ PAGES — Service section (60–69)
  const SVC_VIEW = ['service_coordinator', 'service_engineer', 'pm_coordinator', 'service_centre_tech', 'admin', 'gm', 'odm'];
  const BOARD = [
    { id: 'new', label: 'Ack pending', color: 'var(--bad)', test: (c) => c.step === 1 }, { id: 'val', label: 'Validate / assign', color: 'var(--warn)', test: (c) => c.step === 2 || c.step === 3 },
    { id: 'com', label: 'Committed · to attend', color: 'var(--chart-5)', test: (c) => (c.step === 4 || c.step === 5) && !c.attendedAt }, { id: 'att', label: 'Attended · in work', color: 'var(--chart-1)', test: (c) => c.attendedAt && c.step >= 5 && c.step <= 7 },
    { id: 'cls', label: 'Report & closure', color: 'var(--chart-4)', test: (c) => c.step >= 8 },
  ];
  CRM.registerPage({
    id: 'complaints', title: 'Complaints', icon: '🛠', section: 'Service', order: 61, roles: SVC_VIEW,
    badge: () => scope(db.all('complaints')).filter((c) => isOpen(c) && overdue(c)).length,
    render(el, params) {
      if (params[0]) return renderComplaint(el, params[0]);
      const all = scope(svcList());
      const open = all.filter(isOpen);
      ui.page(el, { title: roleIs('service_engineer') ? 'My Calls' : 'Complaint / Service Request Queue', sub: 'Common 10-step service workflow for Power, Electronic Security and Solar with separate acknowledgement, attendance and resolution SLAs', actions: [
        roleIs('service_coordinator', 'service_engineer', 'admin') ? ui.btn('+ Register complaint', () => openNewComplaint(), 'primary') : null,
        ui.btn('Export CSV', () => exportCSV('complaints', cmpColumns(), all)),
      ] });
      el.appendChild(ui.kpis([
        { label: 'Open calls', value: open.length, meta: open.filter((c) => c.status === 'Waiting').length + ' waiting', color: 'var(--chart-1)' },
        { label: 'Ack pending', value: open.filter((c) => c.step === 1).length, meta: open.filter((c) => c.step === 1 && slaState(c, 'ack') === 'Breached').length + ' beyond ack SLA', color: 'var(--bad)' },
        { label: 'Unassigned', value: open.filter((c) => !c.engineerId).length, color: 'var(--warn)' },
        { label: 'SLA breached (open)', value: open.filter(overdue).length, tone: 'down', meta: 'attendance or resolution', color: 'var(--bad)' },
        { label: 'Attended but open', value: open.filter((c) => c.attendedAt).length, meta: open.filter((c) => c.attendedAt && hrsSince(c.attendedAt) > 36).length + ' > 36h', color: 'var(--chart-4)' },
        { label: 'Closed today', value: all.filter((c) => c.closedAt && util.iso(c.closedAt) === util.iso(CRM.TODAY)).length, color: 'var(--ok)' },
      ]));
      const filters = [{ key: 'division', label: 'divisions', options: DIVS }, { key: 'priority', label: 'priorities', options: PRIORITIES }, { key: 'status', label: 'statuses', options: ['Open', 'In Progress', 'Waiting', 'Closed', 'Cancelled'] }, { key: 'serviceType', label: 'service types', options: SERVICE_TYPES }];
      el.appendChild(ui.tabs([{ id: 'q', label: 'Live queue', count: open.length }, { id: 'b', label: 'Board' }, { id: 'a', label: 'All calls', count: all.length }], (t, body) => {
        if (t === 'q') body.appendChild(ui.card(null, ui.table({ rows: open.sort((a, b) => dueAt(a, 'resolve') - dueAt(b, 'resolve')), columns: cmpColumns(), filters, onRow: (c) => CRM.go('complaints', c.id) }), { flush: true }));
        if (t === 'b') body.appendChild(ui.kanban({ columns: BOARD, items: open, colOf: (c) => (BOARD.find((b) => b.test(c)) || BOARD[0]).id, onClick: (c) => CRM.go('complaints', c.id), card: (c) => [h('div', { class: 't' }, [c.id + ' ', priBadge(c.priority)]), h('div', {}, custName(c.customerId)), h('div', { class: 'small muted' }, c.category), h('div', { class: 'row', style: 'margin-top:4px' }, [ui.divTag(c.division), slaBadge(c, c.attendedAt ? 'resolve' : c.ackAt ? 'attend' : 'ack')]), h('div', { class: 'small muted' }, c.engineerId ? '👷 ' + master.staffName(c.engineerId) : 'Unassigned')] }));
        if (t === 'a') body.appendChild(ui.card(null, ui.table({ rows: all.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)), columns: cmpColumns(), filters: filters.concat([{ key: 'callType', label: 'call types', options: ES_CALLS }]), onRow: (c) => CRM.go('complaints', c.id) }), { flush: true }));
      }));
    },
  });

  // ---------------------------------------------------------------- Service & PM dashboard (Ops + Mgmt; ES §10.3, Solar §9.3)
  CRM.registerPage({
    id: 'svc-dashboard', title: 'Service Dashboard', icon: '📟', section: 'Service', order: 60, roles: ['service_coordinator', 'pm_coordinator', 'admin', 'gm', 'odm'],
    render(el) {
      let div = '', days = 30;
      ui.page(el, { title: 'Service & PM Dashboard', sub: 'Operations and management view — complaints received, attended and closed; SLA compliance; ageing; repeats; workload; PM and AMC' });
      const bar = h('div', { class: 'row', style: 'margin-bottom:12px' });
      const body = h('div');
      const sel = h('select', { onChange: (e) => { div = e.target.value; draw(); } }, [h('option', { value: '' }, 'All divisions')].concat(DIVS.map((d) => h('option', { value: d }, d))));
      const per = h('select', { onChange: (e) => { days = Number(e.target.value); draw(); } }, [[30, 'Last 30 days'], [90, 'Last 90 days'], [180, 'Last 180 days']].map(([v, l]) => h('option', { value: v }, l)));
      bar.appendChild(sel); bar.appendChild(per); bar.appendChild(pdfBtn('Service & PM Dashboard', () => body)); el.appendChild(bar); el.appendChild(body);
      function draw() {
        body.innerHTML = '';
        const base = svcList().filter((c) => !div || c.division === div);
        const list = base.filter((c) => util.daysBetween(c.createdAt, CRM.TODAY) <= days);
        const m = metrics(list); const open = base.filter(isOpen);
        body.appendChild(ui.kpis([
          { label: 'Received', value: m.total, meta: m.attended + ' attended · ' + m.closed + ' closed', onClick: () => CRM.go('complaints') },
          { label: 'Open / overdue', value: open.length + ' / ' + open.filter(overdue).length, color: 'var(--bad)', onClick: () => CRM.go('complaints') },
          { label: 'Ack SLA', value: fmt.pct(m.ackSla), meta: 'avg ' + m.avgAckMin + ' min · open breaches counted', color: 'var(--chart-5)', onClick: () => CRM.go('svc-reports') },
          { label: 'Attendance SLA', value: fmt.pct(m.attendanceSla), meta: 'avg ' + m.avgAttendH + 'h to attend', color: m.attendanceSla >= 95 ? 'var(--ok)' : 'var(--warn)', onClick: () => CRM.go('svc-reports') },
          { label: 'Resolution SLA', value: fmt.pct(m.resolutionSla), meta: 'avg ' + m.avgCloseH + 'h to close', color: m.resolutionSla >= 95 ? 'var(--ok)' : 'var(--warn)', onClick: () => CRM.go('svc-reports') },
          { label: 'Repeat complaints', value: fmt.pct(m.repeatPct), meta: 'within ' + cfg().repeatWindowDays + ' days', color: 'var(--chart-4)', onClick: () => CRM.go('svc-reports') },
          { label: 'First-visit resolution', value: fmt.pct(m.fvr), color: 'var(--ok)' },
          { label: 'Revenue from service', value: fmt.lakh(m.revenue), meta: 'charges collected', color: 'var(--div-power)', onClick: () => CRM.go('svc-billing') },
        ]));
        const ms = months(6);
        const ageing = [['0–4h', 0, 4], ['4–24h', 4, 24], ['24–48h', 24, 48], ['>48h', 48, 1e9]];
        const fb = db.all('feedback').filter((f) => !div || f.division === div);
        const pmv = db.all('pmVisits').filter((v) => (!div || v.division === div) && util.daysBetween(parseD(v.dueDate), CRM.TODAY) <= days && parseD(v.dueDate) <= CRM.TODAY);
        const gm = grnMetrics();
        body.appendChild(h('div', { class: 'grid g2' }, [
          ui.card('Complaints received vs closed (6 months)', ui.barChart(ms.map((mm) => ({ label: mm.label, values: [base.filter((c) => monthKey(c.createdAt) === mm.key).length, base.filter((c) => monthKey(c.closedAt) === mm.key).length] })), [{ name: 'Received', color: 'var(--chart-1)' }, { name: 'Closed', color: 'var(--chart-2)' }])),
          ui.card('Priority-wise ageing of open calls', ui.barChart(ageing.map(([l, a, b]) => ({ label: l, values: PRIORITIES.map((p) => open.filter((c) => c.priority === p && hrsSince(c.createdAt) >= a && hrsSince(c.createdAt) < b).length) })), [{ name: 'Critical', color: 'var(--chart-4)' }, { name: 'High', color: 'var(--bad)' }, { name: 'Low', color: 'var(--chart-5)' }])),
          ui.card('Complaints by equipment type', ui.hbars(Object.entries(util.countBy(list, (c) => c.systemType || 'Other')).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ label: k, value: v })))),
          ui.card('Engineer workload (open calls)', ui.hbars(master.staff('service_engineer').map((e) => ({ label: e.name, value: open.filter((c) => c.engineerId === e.id).length, color: 'var(--chart-1)', text: open.filter((c) => c.engineerId === e.id).length + ' open · ' + open.filter((c) => c.engineerId === e.id && overdue(c)).length + ' overdue' })))),
          ui.card('Complaints by complaint type', ui.hbars(Object.entries(util.countBy(list, 'category')).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ label: k, value: v, color: 'var(--chart-4)' })))),
          ui.card('Complaints by site', ui.hbars(Object.entries(util.countBy(list, (c) => custName(c.customerId) + (c.siteId ? ' · ' + ((db.get('sites', c.siteId) || {}).name || c.siteId) : ''))).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ label: k, value: v })))),
          ui.card('Calls by division', ui.donut(DIVS.map((d) => ({ label: d, value: list.filter((c) => c.division === d).length, color: DIV_COLOR[d] })), { label: 'calls' })),
          ui.card('Customer feedback', ui.donut([['Positive', 'var(--ok)'], ['Neutral', 'var(--warn)'], ['Negative', 'var(--bad)']].map(([t, col]) => ({ label: t, value: fb.filter((f) => f.type === t).length, color: col })), { label: 'responses' })),
          ui.card('PM, AMC, warranty & spares', ui.dl([
            ['PM due (period)', pmv.length], ['PM completed', pmv.filter((v) => v.completedDate).length], ['PM overdue now', db.all('pmVisits').filter((v) => (!div || v.division === div) && pmState(v) === 'Overdue').length],
            ['AMC expiring (60d)', db.all('amcContracts').filter((a) => (!div || a.division === div) && a.status === 'Active' && util.daysBetween(CRM.TODAY, a.end) <= 60).length], ['Renewal follow-ups open', db.all('amcOpportunities').filter((o) => (!div || o.division === div) && !['Won', 'Lost'].includes(o.status)).length],
            ['Warranty claims open (battery vendor / OEM supplier)', db.all('complaints').filter((c) => (!div || c.division === div) && c.vendorComplaint && c.vendorComplaint.status !== 'Closed').length + ' (' + db.all('complaints').filter((c) => (!div || c.division === div) && c.vendorComplaint && c.vendorComplaint.kind === 'Supplier warranty' && c.vendorComplaint.status !== 'Closed').length + ' OEM)'],
            ['Service GRN: delivered pending closure / missing GRN', gm.deliveredOpen.length + ' / ' + gm.missing.length], ['Spares pending', db.all('spareRequests').filter((s) => ['Requested', 'Approved', 'Awaiting stock'].includes(s.status)).length],
            ['Customer escalations open', db.all('escalations').filter((e) => e.status !== 'Resolved' && (!div || e.division === div)).length],
          ])),
          ui.card('Attendance vs resolution SLA by division', ui.barChart(DIVS.map((d) => { const mm = metrics(list.filter((c) => c.division === d)); return { label: d.replace('Electronic Security', 'Security'), values: [mm.ackSla, mm.attendanceSla, mm.resolutionSla] }; }), [{ name: 'Ack %', color: 'var(--chart-6)' }, { name: 'Attendance %', color: 'var(--chart-1)' }, { name: 'Resolution %', color: 'var(--chart-2)' }])),
        ]));
      }
      draw();
    },
  });

  // ---------------------------------------------------------------- Mobile engineer view
  let mobileSel = null, mobileEng = null, mobileTab = 'calls';
  CRM.registerPage({
    id: 'svc-mobile', title: 'Engineer Mobile', icon: '📱', section: 'Service', order: 62, roles: ['service_engineer', 'service_coordinator', 'admin', 'gm'],
    render(el) {
      ui.page(el, { title: 'Service Engineer — Mobile App', sub: 'Mobile-first field view: my calls, check-in with geo-tag, diagnosis, spares, test checklist, customer confirmation, installation update, quick OTS and PM schedule' });
      const engId = roleIs('service_engineer') ? me() : (mobileEng || 'EMP-service_engineer');
      if (!roleIs('service_engineer')) el.appendChild(h('div', { class: 'row', style: 'justify-content:center;margin-bottom:12px' }, [ui.badge('Read-only preview', 'warn'), h('span', { class: 'small muted' }, 'Preview as engineer:'), h('select', { onChange: (e) => { mobileEng = e.target.value; mobileSel = null; CRM.refresh(); } }, master.staff('service_engineer').map((s) => h('option', { value: s.id, selected: s.id === engId ? true : null }, s.name)))]));
      const calls = db.find('complaints', (c) => c.engineerId === engId && isOpen(c)).sort((a, b) => ((a.commitAt || a.createdAt) > (b.commitAt || b.createdAt) ? 1 : -1));
      const pms = db.find('pmVisits', (v) => v.engineerId === engId && !v.completedDate && util.daysBetween(CRM.TODAY, v.dueDate) <= 30).sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1));
      const screen = h('div', { class: 'phone-screen' });
      const head = h('div', { style: 'background:var(--side-bg);color:#fff;padding:14px 16px' }, [h('div', { class: 'small', style: 'opacity:.7' }, '9:41 · Maruthi Service'), h('div', { style: 'font-weight:700;font-size:16px' }, master.staffName(engId)), h('div', { class: 'small', style: 'opacity:.8' }, calls.length + ' open calls · ' + pms.length + ' PMs in 30 days')]);
      const tabsBar = h('div', { class: 'row', style: 'padding:8px 12px;gap:6px;border-bottom:1px solid var(--border)' }, [['calls', 'My calls'], ['pm', 'My PMs']].map(([k, l]) => ui.btn(l, () => { mobileTab = k; mobileSel = null; CRM.refresh(); }, 'sm ' + (mobileTab === k ? 'primary' : ''))));
      const content = h('div', { style: 'padding:12px;display:flex;flex-direction:column;gap:10px' });
      screen.appendChild(head); screen.appendChild(tabsBar); screen.appendChild(content);
      const sel = mobileSel && db.get('complaints', mobileSel);
      if (mobileTab === 'pm') {
        if (!pms.length) content.appendChild(ui.empty('No PM visits due', '🗓'));
        pms.forEach((v) => content.appendChild(h('div', { class: 'card card-body', style: 'padding:10px', onClick: () => openPmVisit(v.id) }, [h('div', { class: 'row', style: 'justify-content:space-between' }, [h('b', {}, v.id), ui.badge(pmState(v))]), h('div', {}, custName(v.customerId)), h('div', { class: 'small muted' }, v.systemType + ' · due ' + fmt.date(v.dueDate) + ' · ' + PM_FLOW[v.stage])])));
      } else if (!sel) {
        if (!calls.length) content.appendChild(ui.empty('No open calls — great job!', '✅'));
        calls.forEach((c) => content.appendChild(h('div', { class: 'card card-body', style: 'padding:10px;cursor:pointer', onClick: () => { mobileSel = c.id; CRM.refresh(); } }, [
          h('div', { class: 'row', style: 'justify-content:space-between' }, [h('b', {}, c.id + (c.safetyCritical ? ' 🔥' : '')), priBadge(c.priority)]),
          h('div', {}, custName(c.customerId)), h('div', { class: 'small muted' }, c.category + ' · ' + (master.customer(c.customerId) || {}).area),
          h('div', { class: 'row', style: 'margin-top:4px' }, [ui.badge(STEPS[c.step], 'brand'), slaBadge(c, c.attendedAt ? 'resolve' : 'attend')]),
          c.commitAt && !c.attendedAt ? h('div', { class: 'small' }, '⏰ Committed ' + fmt.dateTime(c.commitAt)) : null,
        ])));
      } else {
        const c = sel; const cust = master.customer(c.customerId) || {}; const a = c.assetId ? db.get('assets', c.assetId) : null;
        // only the assigned engineer acts from the mobile app — managers/coordinators previewing it are read-only
        const own = roleIs('service_engineer') && c.engineerId === me();
        const big = (label, fn, cls, ok) => (ok === false ? null : h('button', { class: 'btn ' + (cls || 'primary'), style: 'width:100%;justify-content:center;padding:11px', onClick: fn }, label));
        content.appendChild(ui.btn('← My calls', () => { mobileSel = null; CRM.refresh(); }, 'sm ghost'));
        content.appendChild(h('div', { class: 'card card-body', style: 'padding:10px' }, [h('div', { class: 'row', style: 'justify-content:space-between' }, [h('b', {}, c.id), priBadge(c.priority)]), h('div', { style: 'font-weight:600' }, cust.name), h('div', { class: 'small' }, '📍 ' + c.address), h('div', { class: 'small' }, '📞 ' + c.contact), h('div', { class: 'small muted' }, c.description), c.instructions ? txtCallout('Instructions: ' + c.instructions, 'warn') : null]));
        content.appendChild(h('div', { class: 'card card-body', style: 'padding:10px' }, [ui.dl([['Equipment', a ? a.name + ' · ' + a.serial + (a.capacity ? ' · ' + a.capacity : '') : c.productDetails], ['Coverage', covBadge(c.coverage)], ['Installed', a ? fmt.date(a.installDate) : '—'], ['Last PM', fmt.date(c.lastPmDate)], ['Attendance SLA', slaBadge(c, 'attend')], ['Resolution SLA', slaBadge(c, 'resolve')]])]));
        if (a) content.appendChild(h('div', { class: 'card card-body', style: 'padding:10px' }, [h('b', {}, 'Commissioning & last PM report'), assetReports(a)]));
        if (c.callType === 'Installation') content.appendChild(h('div', { class: 'card card-body', style: 'padding:10px' }, [h('b', {}, 'Pre-installation details'), installPanel(c)]));
        if (!own) content.appendChild(txtCallout(roleIs('service_engineer') ? 'Not assigned to you — view only.' : 'Read-only preview — actions are available to the assigned engineer only.', 'warn'));
        content.appendChild(h('div', { class: 'small muted', style: 'text-align:center' }, 'Step ' + (c.step + 1) + '/10 · ' + STEPS[c.step]));
        const s = c.step;
        const acts = [];
        if (s === 4) acts.push(big('Confirm visit time with customer', () => A.commit(c), 'primary', own));
        if (s <= 5 && s >= 4 && !c.attendedAt) acts.push(big('📍 Check-in (geo-tag)', () => { A.checkin(c); CRM.refresh(); }, 'ok', own));
        if (s === 5 && c.attendedAt) acts.push(big('🩺 Record diagnosis', () => A.diagnose(c), 'primary', own));
        if (s === 6 || s === 7) acts.push(big('🔩 Request spare', () => spareForm(c), '', own));
        if (s === 6) acts.push(big('Spares received → repair', () => A.sparesDone(c), 'primary', own));
        if (s === 7) acts.push(big('✅ Test checklist & repair', () => A.repair(c), 'primary', own));
        if (s === 8) acts.push(big('✍ Customer confirmation & report', () => A.report(c), 'primary', own));
        if (c.callType === 'Installation' && s >= 4) acts.push(big('🧾 Installation update (payment · scrap · photo · signature)', () => A.installUpdate(c), '', own));
        if (s >= 5 && s <= 8) acts.push(big(isPauseSub(c.openSub) ? '▶ Resume work (SLA paused)' : '⏸ Waiting for customer / spares / vendor', () => A.waiting(c), '', own));
        if (c.observation && !c.observation.outcome) acts.push(big('🔁 Observation revisit outcome', () => A.observation(c), 'primary', own));
        if (s === 9) acts.push(h('div', { class: 'callout ok' }, 'Submitted — awaiting coordinator closure' + (needsApproval(c) ? ' & approval' : '')));
        if (s >= 5) acts.push(big('💰 Quick OTS (replacement / upgrade)', () => openOtsForm(c), '', own));
        if (s >= 5 && c.status !== 'Closed') acts.push(big('📦 Quick GRN (take product to service centre)', () => quickGrn(c), '', own));
        if (s < 4) acts.push(h('div', { class: 'callout' }, 'Waiting for coordinator (' + STEPS[s] + ')'));
        acts.filter(Boolean).forEach((x) => content.appendChild(x));
        const reqs = spareReqs(c.id);
        if (reqs.length) content.appendChild(h('div', { class: 'card card-body', style: 'padding:10px' }, [h('b', {}, 'Spares'), ...reqs.map((r) => h('div', { class: 'row small', style: 'justify-content:space-between' }, [r.item + ' × ' + r.qty, ui.badge(r.status)]))]));
      }
      el.appendChild(h('div', { class: 'phone' }, screen));
    },
  });

  // ---------------------------------------------------------------- Spares & standby
  CRM.registerPage({
    id: 'spares', title: 'Spares & Standby', icon: '🔩', section: 'Service', order: 64, roles: ['service_coordinator', 'service_engineer', 'stores', 'admin', 'gm', 'odm'],
    badge: () => (canCoord() ? db.all('spareRequests').filter((s) => s.status === 'Requested').length : 0),
    render(el) {
      const all = db.all('spareRequests').filter((s) => !roleIs('service_engineer') || s.requestedBy === me() || (db.get('complaints', s.complaintId) || {}).engineerId === me());
      ui.page(el, { title: 'Spares Management', sub: 'Spare parts master = stores stock master · availability checked on approval and issue · issue / return movements requested to stores (stock.issue.requested / stock.return.requested) · standby material tracking', actions: [ui.btn('Export CSV', () => exportCSV('spare_requests', [{ key: 'id', label: 'ID' }, { key: 'complaintId', label: 'Complaint' }, { key: 'item', label: 'Item' }, { key: 'qty', label: 'Qty' }, { key: 'status', label: 'Status' }, { key: 'requestedBy', label: 'Engineer', csv: (s) => master.staffName(s.requestedBy) }, { key: 'requestedAt', label: 'Requested', csv: (s) => fmt.dateTime(s.requestedAt) }], all))] });
      const st = (k) => all.filter((s) => s.status === k);
      el.appendChild(ui.kpis([{ label: 'Awaiting approval', value: st('Requested').length, color: 'var(--warn)' }, { label: 'Awaiting stock', value: st('Awaiting stock').length, meta: 'stores / purchase alerted', color: 'var(--bad)' }, { label: 'Approved · to issue', value: st('Approved').length, color: 'var(--chart-5)' }, { label: 'With engineers (issued)', value: st('Issued').length, color: 'var(--chart-1)' }, { label: 'Consumed', value: util.sum(all, (s) => s.usedQty || 0), color: 'var(--ok)' }, { label: 'Returned', value: util.sum(all, (s) => s.returnedQty || 0) }, { label: 'Standby at customer sites', value: db.all('complaints').filter((c) => c.standby && !c.standby.collectedAt).length, color: 'var(--bad)' }]));
      el.appendChild(ui.tabs([{ id: 'q', label: 'Approval & issue queue' }, { id: 'a', label: 'All requests' }, { id: 'e', label: 'Engineer stock' }, { id: 's', label: 'Standby material' }], (t, body) => {
        if (t === 'q') body.appendChild(ui.card(null, sparesTable(all.filter((s) => ['Requested', 'Approved', 'Awaiting stock'].includes(s.status))), { flush: true }));
        if (t === 'a') body.appendChild(ui.card(null, sparesTable(all.slice().reverse()), { flush: true }));
        if (t === 'e') body.appendChild(ui.card('Issued / used / returned / balance per engineer', ui.table({ rows: master.staff('service_engineer').map((e) => { const r = all.filter((s) => s.requestedBy === e.id || (db.get('complaints', s.complaintId) || {}).engineerId === e.id); const iss = util.sum(r.filter((s) => ['Issued', 'Used', 'Returned'].includes(s.status)), (s) => s.qty); const used = util.sum(r, (s) => s.usedQty || 0); const ret = util.sum(r, (s) => s.returnedQty || 0); return { id: e.id, name: e.name, iss, used, ret, bal: iss - used - ret, eff: pctOf(used, iss) }; }), columns: [{ key: 'name', label: 'Engineer' }, { key: 'iss', label: 'Issued', cls: 'right' }, { key: 'used', label: 'Used', cls: 'right' }, { key: 'ret', label: 'Returned', cls: 'right' }, { key: 'bal', label: 'Balance with engineer', cls: 'right', render: (r) => ui.badge(r.bal, r.bal ? 'warn' : 'ok') }, { key: 'eff', label: 'Spare usage efficiency', render: (r) => fmt.pct(r.eff) }] }), { flush: true }));
        if (t === 's') body.appendChild(ui.card(null, ui.table({ rows: db.all('complaints').filter((c) => c.standby), onRow: (c) => CRM.go('complaints', c.id), columns: [{ key: 'id', label: 'Complaint', render: (c) => mono(c.id) }, { key: 'customerId', label: 'Customer', render: (c) => custName(c.customerId) }, { key: 'item', label: 'Standby item', render: (c) => c.standby.item }, { key: 'issued', label: 'Issued', render: (c) => fmt.date(c.standby.issuedAt) }, { key: 'days', label: 'Days at site', render: (c) => { const d = Math.round(((c.standby.collectedAt ? new Date(c.standby.collectedAt) : Date.now()) - new Date(c.standby.issuedAt)) / 864e5); return ui.badge(d + 'd', d > 7 && !c.standby.collectedAt ? 'bad' : 'ok'); } }, { key: 'st', label: 'Status', render: (c) => ui.badge(c.standby.collectedAt ? 'Collected' : 'At site', c.standby.collectedAt ? 'ok' : 'warn') }] }), { flush: true }));
      }));
    },
  });

  // ---------------------------------------------------------------- OTS — Opportunity Through Service
  // ---- mobile Quick GRN: the engineer collects the customer's product. GRN records are projects-owned, so the request goes through
  // 'grn.service.requested' (projects inserts the Service GRN synchronously); the photo is attached to the GRN record.
  function scanInput(input) {
    const supported = typeof window !== 'undefined' && 'BarcodeDetector' in window;
    const pc = supported && ui.photoCapture ? ui.photoCapture({ label: '📷 Scan barcode / QR', onChange: (d) => { if (!d) return; const img = new Image(); img.onload = () => { try { new window.BarcodeDetector().detect(img).then((r) => { if (r && r[0]) { input.value = r[0].rawValue; input.dispatchEvent(new Event('input', { bubbles: true })); ui.toast('Scanned: ' + r[0].rawValue, 'ok'); } else ui.toast('No barcode found — type the serial number', 'warn'); }).catch(() => ui.toast('Barcode scan failed — type the serial number', 'warn')); } catch (e) { ui.toast('Barcode scan unavailable — type the serial number', 'warn'); } }; img.src = d; } }) : null;
    return h('div', { class: 'small muted' }, pc ? [pc] : ['Barcode scanning is not supported in this browser — type or paste the serial / barcode (a USB / Bluetooth scanner types into the field).']);
  }
  function quickGrn(c) {
    const a = c.assetId ? db.get('assets', c.assetId) : null; const cust = master.customer(c.customerId) || {};
    const existing = db.one('grns', (g) => g.type === 'Service GRN' && g.complaintId === c.id && g.status !== 'Delivered');
    if (existing) { ui.toast('Service GRN ' + existing.id + ' already exists for ' + c.id, 'warn'); return; }
    const f = ui.form([
      { key: 'productType', label: 'Product type', type: 'select', required: true, options: ['UPS', 'Inverter', 'Battery', 'Stabilizer', 'DVR/NVR', 'Camera', 'Solar inverter', 'Other'] },
      { key: 'brand', label: 'Brand', required: true }, { key: 'model', label: 'Model', required: true },
      { key: 'serial', label: 'Serial number / barcode', required: true }, { key: 'qty', label: 'Quantity', type: 'number', required: true },
      { key: 'condition', label: 'Physical condition', type: 'select', required: true, options: ['Good', 'Damaged'] },
      { key: 'accessories', label: 'Accessories received', required: true }, { key: 'problem', label: 'Problem description', type: 'textarea', required: true },
    ], { productType: /UPS/i.test((a && a.category) || '') ? 'UPS' : /Inverter/i.test((a && a.category) || '') ? 'Inverter' : /Battery/i.test((a && a.category) || '') ? 'Battery' : c.division === 'Electronic Security' ? 'DVR/NVR' : c.division === 'Solar' ? 'Solar inverter' : 'Other', brand: (a && a.make) || '', model: (a && a.model) || c.model || '', serial: (a && a.serial) || c.serial || '', qty: 1, condition: 'Good', accessories: 'No', problem: c.diagnosis || c.description || '' });
    const serialIn = (f.inputs && f.inputs.serial) || null;
    const photo = evidenceWidget({ kind: 'photo', label: 'Photo of the product collected' });
    ui.modal({ title: 'Quick GRN · ' + c.id, sub: cust.name + ' · ' + (cust.phone || ''), body: h('div', { class: 'stack' }, [f, serialIn ? scanInput(serialIn) : null, h('div', { class: 'form' }, [photo.node])].filter(Boolean)), actions: [{ label: 'Cancel' }, { label: 'Create GRN', cls: 'primary', onClick: () => {
      if (!f.validate()) return false; const v = f.values();
      if (!(v.qty > 0)) { ui.toast('Quantity must be at least 1', 'bad'); return false; }
      const ph = photo.get(); if (!ph) { ui.toast('Photo of the collected product is mandatory', 'bad'); return false; }
      const payload = Object.assign({ complaintId: c.id, customerId: c.customerId, division: c.division, contact: c.contact || cust.phone || '', site: c.address || cust.area || '', collectedBy: me(), source: 'Mobile quick GRN' }, v);
      CRM.emit('grn.service.requested', payload);
      const g = db.one('grns', (x) => x.type === 'Service GRN' && x.complaintId === c.id && x.serial === v.serial && x.status !== 'Delivered');
      if (!g) { ui.toast('GRN could not be created — the stores module is unavailable', 'bad'); return false; }
      const ref = storeEv(ph, 'grns', g.id, 'photo', 'Product photo at collection'); if (ref) db.update('grns', g.id, { photo: ref }, { silent: true });
      updC(db.get('complaints', c.id), { quickGrnId: g.id }, 'Quick GRN ' + g.id + ' created on mobile');
      ui.toast(g.id + ' created — product in transit to the service centre', 'ok'); reopenAfter(() => {});
    } }] });
  }
  function openOtsForm(c) {
    const cust = master.customer(c.customerId) || {};
    const th = Number(cfg().otsBatteryThreshold) || 2;
    const hint = h('div', { class: 'callout' }, 'Auto-classification (batteries): qty ≤ ' + th + ' → Service OTS · qty > ' + th + ' → Sales OTS (Sales Coordinator assigns a Sales Executive). Other products → ' + (cfg().otsNonBattery || 'Sales OTS') + '.');
    const describe = (I) => { const t = otsType(I.qty.value, I.productType.value); hint.textContent = 'Auto-classification: ' + t + ' → ' + (t === 'Service OTS' ? 'Service department; popup + email to Service Coordinator' : 'Sales department; popup + email to Sales Coordinator, assignment task created') + (roleIs('service_coordinator') && t === 'Sales OTS' ? ' — coordinators may only create Service OTS' : ''); };
    const f = ui.form([
      { key: 'productType', label: 'Product type', type: 'select', options: OTS_PRODUCTS[c.division] || OTS_PRODUCTS.Power, required: true, onChange: (v, I) => describe(I) },
      { key: 'brand', label: 'Brand', type: 'select', options: (VENDOR_BRANDS[c.division] || VENDOR_BRANDS.Power).concat(['Maruthi']), required: true },
      { key: 'qty', label: 'Quantity', type: 'number', required: true, onChange: (v, I) => { describe(I); if (!I.value.value) I.value.value = (Number(v) || 0) * 15500; } },
      { key: 'capacity', label: 'Capacity / specification', type: 'select', options: ['26Ah', '100Ah', '150Ah', '200Ah', '1.5KVA', '3KVA', '10KVA', '4MP', '8MP', '4TB', '5kW', '10kW', 'Other'], required: true },
      { key: 'value', label: 'Estimated value ₹', type: 'number', required: true },
      { key: 'urgency', label: 'Urgency', type: 'select', options: ['Hot', 'Warm', 'Cold'], required: true },
      { key: 'expectedClose', label: 'Expected closure date', type: 'date', required: true },
      { key: 'location', label: 'Location' },
    ], { productType: 'Battery', brand: (VENDOR_BRANDS[c.division] || VENDOR_BRANDS.Power)[0], qty: 2, capacity: '150Ah', value: 31000, urgency: 'Hot', expectedClose: util.iso(util.addDays(CRM.TODAY, 7)), location: cust.area });
    const photo = evidenceWidget({ kind: 'photo', label: 'Photo of battery / equipment condition' });
    ui.modal({ title: 'Create OTS from ' + c.id, sub: custName(c.customerId) + ' · ' + c.contact, body: h('div', { class: 'stack' }, [hint, f, h('div', { class: 'form' }, [photo.node])]), actions: [{ label: 'Cancel' }, { label: 'Create OTS', cls: 'primary', onClick: () => {
      if (!f.validate()) return false; const v = f.values();
      if (!(v.qty > 0)) { ui.toast('Quantity must be at least 1', 'bad'); return false; }
      // Service doc OTS §2: the back-office coordinator may create Service OTS only
      if (roleIs('service_coordinator') && otsType(v.qty, v.productType) === 'Sales OTS') { ui.toast('Blocked: coordinators may create Service OTS only — the engineer logs Sales OTS', 'bad'); return false; }
      const ph = photo.get(); const o = createOts(Object.assign(v, { photo: ph && !isDataUrl(ph) && !Array.isArray(ph) ? ph : '', division: c.division, complaintId: c.id, customerId: c.customerId, contact: c.contact, createdBy: c.engineerId || me() }));
      if (ph) { const ref = storeEv(ph, 'ots', o.id, 'photo', 'OTS equipment photo'); if (ref) db.update('ots', o.id, { photo: ref }, { silent: true }); }
      ui.toast(o.id + ' created as ' + o.otsType, 'ok'); reopenAfter(() => {});
    } }] });
  }
  const otsCanEdit = (o) => (o.otsType === 'Service OTS' ? roleIs('service_engineer', 'service_coordinator', 'admin') && (!roleIs('service_engineer') || o.assignedTo === me() || o.createdBy === me()) : roleIs('sales_coordinator', 'sales_manager', 'admin') || (roleIs('sales_exec') && o.assignedTo === me()));
  function openOts(id) {
    const o = db.get('ots', id); if (!o) return;
    const i = OTS_STATUS.indexOf(o.status);
    const can = otsCanEdit(o);
    const next = OTS_STATUS.slice(i + 1, 4);
    const discNeeds = Number(o.discountPct) > cfg().discountLimit && o.discountApproval !== 'Approved';
    const acts = [];
    if (o.otsType === 'Sales OTS' && roleIs('sales_coordinator', 'sales_manager', 'admin') && !['Won', 'Lost'].includes(o.status)) acts.push({ label: o.assignedTo ? 'Reassign' : 'Assign Sales Executive', cls: 'primary', onClick: () => { ui.formModal('Assign Sales OTS', [{ key: 'assignedTo', label: 'Sales Executive', type: 'select', options: staffOpts('sales_exec'), required: true }], { assignedTo: o.assignedTo }, (v) => { db.update('ots', o.id, { assignedTo: v.assignedTo, status: o.status === 'Open' ? 'In Progress' : o.status }, { note: 'Assigned to ' + master.staffName(v.assignedTo) }); CRM.notify({ to: ['sales_exec'], title: 'Sales OTS assigned: ' + o.id, body: o.qty + ' batteries · ' + custName(o.customerId), link: '#/ots/' + o.id, key: 'ots-asg-' + o.id + v.assignedTo }); reopenAfter(() => openOts(o.id)); }); return false; } });
    if (can && !['Won', 'Lost'].includes(o.status)) {
      // Service OTS: quotation value → coordinator approval → "Quotation Sent" (Sales OTS quotations live in the Sales CRM)
      const svcQuote = o.otsType === 'Service OTS';
      if (svcQuote && OTS_STATUS.indexOf(o.status) < 2) acts.push({ label: o.quoteValue ? 'Revise quotation' : 'Prepare quotation', onClick: () => { ui.formModal('Quotation for ' + o.id, [{ key: 'quoteValue', label: 'Quotation value ₹ (incl. GST)', type: 'number', required: true }, { key: 'quoteNote', label: 'Items / terms', type: 'textarea' }], { quoteValue: o.quoteValue || Math.round(o.value * (1 - (o.discountPct || 0) / 100)), quoteNote: o.quoteNote || ((o.qty || 1) + ' × ' + (o.productType || 'Battery') + ' ' + (o.brand || '') + ' ' + (o.capacity || '')) }, (v) => {
        if (!(v.quoteValue > 0)) { ui.toast('Quotation value must be greater than zero', 'bad'); return false; }
        const self = roleIs('service_coordinator', 'admin');
        db.update('ots', o.id, { quoteValue: v.quoteValue, quoteNote: v.quoteNote, quoteNo: o.quoteNo || 'OQ-' + o.id.slice(4), quoteRev: (o.quoteRev || 0) + (o.quoteValue ? 1 : 0), quoteApproval: self ? 'Approved' : 'Pending', quoteApprovedBy: self ? me() : null, quoteApprovedAt: self ? now().toISOString() : null }, { note: 'Quotation ' + fmt.money(v.quoteValue) + (self ? ' (approved)' : ' submitted for approval') });
        if (!self) CRM.notify({ to: ['service_coordinator'], title: 'OTS quotation awaiting approval: ' + o.id, body: fmt.money(v.quoteValue) + ' · ' + custName(o.customerId), link: '#/ots/' + o.id, severity: 'warn', key: 'ots-q-' + o.id + '-' + ((o.quoteRev || 0) + 1) });
        reopenAfter(() => openOts(o.id));
      }); return false; } });
      if (svcQuote && o.quoteApproval === 'Pending' && roleIs('service_coordinator', 'admin')) acts.push({ label: 'Approve quotation', cls: 'ok', onClick: () => { db.update('ots', o.id, { quoteApproval: 'Approved', quoteApprovedBy: me(), quoteApprovedAt: now().toISOString() }, { note: 'Quotation approved' }); reopenAfter(() => openOts(o.id)); return false; } });
      next.forEach((s) => acts.push({ label: '→ ' + s, onClick: () => {
        if (svcQuote && OTS_STATUS.indexOf(s) >= 2 && o.quoteApproval !== 'Approved') { ui.toast('Blocked: prepare the quotation and get it approved by the Service Coordinator first', 'bad'); return false; }
        const p = { status: s }; if (s === 'Quotation Sent') { p.quoteNo = o.quoteNo || 'OQ-' + o.id.slice(4); p.quoteSentAt = now().toISOString(); }
        db.update('ots', o.id, p, { note: 'Status ' + s }); reopenAfter(() => openOts(o.id)); return false; } }));
      acts.push({ label: 'Discount', onClick: () => { ui.formModal('Discount request', [{ key: 'discountPct', label: 'Discount %', type: 'number', required: true }], { discountPct: o.discountPct || 0 }, (v) => { const need = v.discountPct > cfg().discountLimit; db.update('ots', o.id, { discountPct: v.discountPct, discountApproval: need ? 'Pending' : 'Within limit' }, { note: 'Discount ' + v.discountPct + '%' }); if (need) CRM.notify({ to: ['gm', 'sales_manager'], title: 'Discount approval: ' + o.id + ' (' + v.discountPct + '%)', body: 'Beyond the ' + cfg().discountLimit + '% limit', link: '#/ots/' + o.id, severity: 'warn', key: 'ots-disc-' + o.id + v.discountPct }); reopenAfter(() => openOts(o.id)); }); return false; } });
      acts.push({ label: 'Mark Won', cls: 'ok', onClick: () => { if (discNeeds) { ui.toast('Blocked: discount beyond ' + cfg().discountLimit + '% awaits approval', 'bad'); return false; } ui.formModal('Mark OTS Won', [{ key: 'revenue', label: 'Revenue value ₹', type: 'number', required: true }, { key: 'invoiceId', label: 'Sales invoice (from Accounts)', type: 'select', options: [{ value: '', label: 'Not invoiced yet — Accounts will be asked to bill' }].concat(db.find('invoices', (x) => x.customerId === o.customerId).sort((a, b) => (a.invoiceDate < b.invoiceDate ? 1 : -1)).slice(0, 30).map((x) => ({ value: x.id, label: (x.invoiceNo || x.id) + ' · ' + fmt.date(x.invoiceDate) + ' · ' + fmt.money(x.value) }))) }, { key: 'scrap', label: 'Old material (scrap entry is mandatory for replacements)', type: 'select', options: ['Collected — create scrap entry', 'Not a replacement (new / additional)', 'Customer retained old material'], required: true }, { key: 'scrapQty', label: 'Old units collected', type: 'number' }], { revenue: o.quoteValue || Math.round(o.value * (1 - (o.discountPct || 0) / 100)), scrap: 'Collected — create scrap entry', scrapQty: o.qty, invoiceId: o.invoiceId || '' }, (v) => {
        let scrapId = null;
        if (/^Collected/.test(v.scrap)) { if (!(v.scrapQty > 0)) { ui.toast('Enter the number of old units collected', 'bad'); return false; } const cmp = o.complaintId && db.get('complaints', o.complaintId); const g = cmp ? grnFor(cmp) : null; const sr = requestScrap({ linkType: 'OTS', linkId: o.id, otsId: o.id, complaintId: o.complaintId || null, grnId: g ? g.id : null, customerId: o.customerId, division: o.division || 'Power', scrapType: o.productType === 'Battery' ? 'Battery' : o.productType, brand: o.brand, capacity: o.capacity, qty: v.scrapQty, trigger: 'OTS replacement — old ' + (o.productType || 'battery'), source: 'From OTS', status: 'Collected', location: o.location }); scrapId = sr ? sr.id : null; }
        const inv = v.invoiceId ? db.get('invoices', v.invoiceId) : null; db.update('ots', o.id, { status: 'Won', revenue: v.revenue, invoiceId: inv ? inv.id : null, invoiceNo: inv ? inv.invoiceNo || inv.id : '', closedBy: me(), closedAt: now().toISOString(), scrapDecision: v.scrap, scrapId }, { note: 'Won' + (scrapId ? ' · scrap ' + scrapId : '') }); CRM.notify({ to: ['accounts'], title: 'Trigger billing: OTS ' + o.id + ' won', body: fmt.money(v.revenue) + ' · ' + custName(o.customerId), link: '#/svc-billing', severity: 'ok', key: 'ots-won-' + o.id }); reopenAfter(() => openOts(o.id)); }); return false; } });
      acts.push({ label: 'Mark Lost', cls: 'danger', onClick: () => { ui.formModal('Mark OTS Lost (OTS cannot be deleted)', [{ key: 'lostReason', label: 'Lost reason', type: 'select', options: ['Price too high', 'Bought from local dealer', 'Customer postponed', 'Not required after repair', 'Other'], required: true }], {}, (v) => { db.update('ots', o.id, { status: 'Lost', lostReason: v.lostReason, closedBy: me(), closedAt: now().toISOString() }, { note: 'Lost: ' + v.lostReason }); reopenAfter(() => openOts(o.id)); }); return false; } });
    }
    if (o.discountApproval === 'Pending' && roleIs('gm', 'sales_manager', 'admin')) acts.push({ label: 'Approve discount', cls: 'ok', onClick: () => { db.update('ots', o.id, { discountApproval: 'Approved', discountApprovedBy: me() }, { note: 'Discount approved' }); reopenAfter(() => openOts(o.id)); return false; } });
    ui.drawer({ title: o.id + ' · ' + o.otsType, sub: custName(o.customerId), actions: acts, body: h('div', { class: 'stack' }, [
      ui.stepper(OTS_STATUS.slice(0, 5), o.status === 'Lost' ? 4 : o.status === 'Won' ? 5 : i, o.status === 'Lost'),
      o.status === 'Lost' ? txtCallout('Lost — ' + o.lostReason, 'bad') : null,
      discNeeds ? txtCallout('Discount ' + o.discountPct + '% exceeds the ' + cfg().discountLimit + '% limit — approval required', 'warn') : null,
      ui.dl([['OTS ID', o.id], ['Linked complaint', o.complaintId ? link('#/complaints/' + o.complaintId, o.complaintId) : '—'], ['Customer', custName(o.customerId)], ['Contact', o.contact], ['Location', o.location], ['Product type', o.productType], ['Battery brand', o.brand], ['Battery quantity', o.qty], ['Capacity', o.capacity], ['OTS type (auto)', o.otsType], ['Department', o.department], ['Estimated value', fmt.money(o.value)], ['Quotation', o.quoteValue ? (o.quoteNo || '') + ' · ' + fmt.money(o.quoteValue) + ' · ' + (o.quoteApproval || '—') : '—'], ['Invoice', o.invoiceId ? (CRM.canSee('invoices') ? link('#/invoices', o.invoiceNo || o.invoiceId) : (o.invoiceNo || o.invoiceId)) : (o.invoiceNo || '—')], ['Urgency', ui.badge(o.urgency, o.urgency === 'Hot' ? 'bad' : o.urgency === 'Warm' ? 'warn' : 'info')], ['Expected closure', fmt.date(o.expectedClose)], ['Created by', master.staffName(o.createdBy)], ['Assigned to', o.assignedTo ? master.staffName(o.assignedTo) : ui.badge('Awaiting assignment', 'warn')], ['Closed by', master.staffName(o.closedBy)], ['Revenue', fmt.money(o.revenue)], ['Incentive eligible', o.incentiveEligible], ['Incentive (auto)', fmt.money(otsIncentive(o))], ['Discount', (o.discountPct || 0) + '% ' + (o.discountApproval || '')], ['Quotation', o.quoteNo || '—'], ['Sales order', o.orderId || '—'], ['Converted to enquiry', o.converted ? (o.enquiryId || 'Yes') + ' · ' + fmt.date(o.convertedAt) : '—'], ['Scrap (old material)', o.scrapId ? o.scrapId : (o.scrapDecision || '—')], ['Condition photo', o.photo ? '✓' : '—']]),
      ui.card('Audit trail', ui.auditTrail('ots', o.id)),
    ]) });
  }
  CRM.registerPage({
    id: 'ots', title: 'OTS (Opportunity via Service)', icon: '💡', section: 'Service', order: 63, roles: ['service_coordinator', 'service_engineer', 'sales_coordinator', 'sales_manager', 'sales_exec', 'accounts', 'admin', 'gm', 'odm'],
    badge: () => (roleIs('sales_coordinator') ? db.all('ots').filter((o) => o.otsType === 'Sales OTS' && !o.assignedTo).length : 0),
    render(el, params) {
      let all = db.all('ots');
      if (roleIs('service_engineer')) all = all.filter((o) => o.createdBy === me() || o.assignedTo === me());
      if (roleIs('sales_exec')) all = all.filter((o) => o.assignedTo === me());
      const won = all.filter((o) => o.status === 'Won'); const closed = all.filter((o) => ['Won', 'Lost'].includes(o.status));
      const cols = [{ key: 'id', label: 'OTS', render: (o) => mono(o.id) }, { key: 'createdAt', label: 'Created', render: (o) => fmt.date(o.createdAt), sort: (o) => o.createdAt }, { key: 'complaintId', label: 'Complaint' }, { key: 'customerId', label: 'Customer', render: (o) => custName(o.customerId), csv: (o) => custName(o.customerId) }, { key: 'otsType', label: 'Type', render: (o) => ui.badge(o.otsType, o.otsType === 'Service OTS' ? 'brand' : 'violet') }, { key: 'qty', label: 'Qty', cls: 'right' }, { key: 'value', label: 'Value', cls: 'right', render: (o) => fmt.money(o.value) }, { key: 'urgency', label: 'Urgency' }, { key: 'assignedTo', label: 'Assigned', render: (o) => (o.assignedTo ? master.staffName(o.assignedTo) : ui.badge('Unassigned', 'warn')), csv: (o) => master.staffName(o.assignedTo) }, { key: 'status', label: 'Status', render: (o) => ui.badge(o.status) }, { key: 'inc', label: 'Incentive', cls: 'right', render: (o) => fmt.money(otsIncentive(o)), csv: (o) => otsIncentive(o) }];
      ui.page(el, { title: 'OTS — Opportunity Through Service', sub: 'Revenue opportunities from service visits · auto-classified Service (≤2 batteries) vs Sales (>2) · cannot be deleted, only marked lost', actions: [ui.btn('Export CSV', () => exportCSV('ots', cols, all))] });
      el.appendChild(ui.kpis([{ label: 'Total OTS generated', value: all.length }, { label: 'Service vs Sales', value: all.filter((o) => o.otsType === 'Service OTS').length + ' / ' + all.filter((o) => o.otsType === 'Sales OTS').length }, { label: 'Conversion rate', value: fmt.pct(pctOf(won.length, closed.length)), color: 'var(--ok)' }, { label: 'Revenue from OTS', value: fmt.lakh(util.sum(won, (o) => o.revenue)), color: 'var(--div-power)' }, { label: 'Open pipeline', value: fmt.lakh(util.sum(all.filter((o) => !['Won', 'Lost'].includes(o.status)), (o) => o.value)) }, { label: 'OTS capture rate', value: fmt.pct(pctOf(new Set(db.all('ots').map((o) => o.complaintId)).size, db.all('complaints').filter((c) => c.division === 'Power' && /Battery|backup/i.test(c.category)).length)), meta: 'battery calls with OTS' }]));
      el.appendChild(ui.tabs([{ id: 'k', label: 'Pipeline' }, { id: 'l', label: 'All OTS' }, { id: 'd', label: 'Dashboard & incentives' }], (t, body) => {
        if (t === 'k') body.appendChild(ui.kanban({ columns: OTS_STATUS.map((s, i) => ({ id: s, label: s, color: ['var(--chart-5)', 'var(--chart-1)', 'var(--chart-4)', 'var(--warn)', 'var(--ok)', 'var(--bad)'][i] })), items: all, colOf: (o) => o.status, onClick: (o) => openOts(o.id), sum: (its) => fmt.lakh(util.sum(its, (o) => o.value)), card: (o) => [h('div', { class: 't' }, o.id + ' · ' + o.qty + ' × ' + o.productType), h('div', {}, custName(o.customerId)), h('div', { class: 'row' }, [ui.badge(o.otsType, o.otsType === 'Service OTS' ? 'brand' : 'violet'), h('span', { class: 'small' }, fmt.money(o.value))])] }));
        if (t === 'l') body.appendChild(ui.card(null, ui.table({ rows: all.slice().reverse(), columns: cols, onRow: (o) => openOts(o.id), filters: [{ key: 'otsType', label: 'types', options: ['Service OTS', 'Sales OTS'] }, { key: 'status', label: 'statuses', options: OTS_STATUS }] }), { flush: true }));
        if (t === 'd') {
          const byEng = util.groupBy(all, 'createdBy'); const bySales = util.groupBy(all.filter((o) => o.otsType === 'Sales OTS' && o.assignedTo), 'assignedTo');
          body.appendChild(h('div', { class: 'grid g2' }, [
            ui.card('Engineer-wise OTS (created · won value)', ui.hbars(Object.keys(byEng).map((k) => ({ label: master.staffName(k), value: byEng[k].length, text: byEng[k].length + ' · ' + fmt.lakh(util.sum(byEng[k].filter((o) => o.status === 'Won'), (o) => o.revenue)) })))),
            ui.card('Sales executive-wise performance', Object.keys(bySales).length ? ui.hbars(Object.keys(bySales).map((k) => ({ label: master.staffName(k), value: bySales[k].filter((o) => o.status === 'Won').length, target: bySales[k].length }))) : ui.empty('No Sales OTS assigned')),
            ui.card('Service vs Sales OTS', ui.donut([{ label: 'Service OTS', value: all.filter((o) => o.otsType === 'Service OTS').length, color: 'var(--chart-1)' }, { label: 'Sales OTS', value: all.filter((o) => o.otsType === 'Sales OTS').length, color: 'var(--chart-4)' }])),
            ui.card('Lost opportunity analysis', ui.hbars(Object.entries(util.countBy(all.filter((o) => o.status === 'Lost'), 'lostReason')).map(([k, v]) => ({ label: k, value: v, color: 'var(--bad)' })))),
          ]));
          const ic = cfg().otsIncentive;
          body.appendChild(h('div', { class: 'mt' }, ui.card('Incentive tracking (Service ' + ic.servicePct + '% · Sales ' + ic.salesPct + '% · shared split ' + ic.sharedSplit + '/' + (100 - ic.sharedSplit) + ')', ui.table({ rows: won, columns: [{ key: 'id', label: 'OTS', render: (o) => mono(o.id) }, { key: 'createdBy', label: 'Created by', render: (o) => master.staffName(o.createdBy) }, { key: 'closedBy', label: 'Closed by', render: (o) => master.staffName(o.closedBy) }, { key: 'revenue', label: 'Revenue', cls: 'right', render: (o) => fmt.money(o.revenue) }, { key: 'incentiveEligible', label: 'Eligible' }, { key: 'inc', label: 'Incentive', cls: 'right', render: (o) => fmt.money(otsIncentive(o)) }, { key: 'split', label: 'Split (creator / closer)', render: (o) => (o.createdBy !== o.closedBy && o.closedBy ? 'Shared · ' + master.staffName(o.createdBy) + ' ' + fmt.money(otsIncentive(o) * ic.sharedSplit / 100) + ' / ' + master.staffName(o.closedBy) + ' ' + fmt.money(otsIncentive(o) * (100 - ic.sharedSplit) / 100) : 'Single · ' + master.staffName(o.createdBy)) }] }), { flush: true })));
        }
      }));
      routeDrawer(params[0], openOts);
    },
  });

  // ---------------------------------------------------------------- Billing — chargeable service, AMC billing, OTS billing
  CRM.registerPage({
    id: 'svc-billing', title: 'Service & AMC Billing', icon: '🧾', section: 'Service', order: 65, roles: ['accounts', 'service_coordinator', 'pm_coordinator', 'admin', 'gm', 'odm'],
    badge: () => (roleIs('accounts') ? db.all('complaints').filter((c) => c.chargeable && c.closedAt && (c.payment || {}).status !== 'Received').length : 0),
    render(el) {
      const chg = db.all('complaints').filter((c) => c.chargeable && c.closedAt);
      const pend = chg.filter((c) => (c.payment || {}).status !== 'Received');
      const amcs = db.all('amcContracts').filter((a) => a.status !== 'Renewed');
      const canBill = roleIs('accounts', 'pm_coordinator', 'admin');
      ui.page(el, { title: 'Service Charges & AMC Billing', sub: 'Chargeable service collection (Pending / Received · Cash / UPI / Bank Transfer · invoice link), AMC invoices and OTS billing readiness' });
      el.appendChild(ui.kpis([{ label: 'Service charges pending', value: fmt.money(util.sum(pend, (c) => c.charges)), meta: pend.length + ' calls', color: 'var(--bad)' }, { label: 'Collected (30 days)', value: fmt.money(util.sum(chg.filter((c) => (c.payment || {}).receivedAt && util.daysBetween(c.payment.receivedAt, CRM.TODAY) <= 30), (c) => c.charges)), color: 'var(--ok)' }, { label: 'AMC to be billed', value: amcs.filter((a) => (a.billing || {}).status === 'To be billed' && a.status === 'Active').length, color: 'var(--warn)' }, { label: 'AMC payment pending', value: fmt.money(util.sum(amcs.filter((a) => (a.billing || {}).status === 'Billed'), (a) => a.billing.amount)), color: 'var(--bad)' }, { label: 'OTS won · billing', value: db.all('ots').filter((o) => o.status === 'Won' && !o.billed).length }]));
      el.appendChild(ui.tabs([{ id: 's', label: 'Service charges', count: pend.length }, { id: 'a', label: 'AMC billing' }, { id: 'o', label: 'OTS billing' }], (t, body) => {
        if (t === 's') body.appendChild(ui.card(null, ui.table({ rows: chg.slice().sort((a, b) => ((a.payment || {}).status === 'Received') - ((b.payment || {}).status === 'Received')), onRow: (c) => CRM.go('complaints', c.id), filters: [{ key: 'division', label: 'divisions', options: DIVS }], columns: [{ key: 'id', label: 'Complaint', render: (c) => mono(c.id) }, { key: 'customerId', label: 'Customer', render: (c) => custName(c.customerId) }, { key: 'division', label: 'Division', render: (c) => ui.divTag(c.division) }, { key: 'closedAt', label: 'Resolved', render: (c) => fmt.date(c.closedAt) }, { key: 'charges', label: 'Charges', cls: 'right', render: (c) => fmt.money(c.charges) }, { key: 'inv', label: 'Invoice', render: (c) => (c.payment || {}).invoiceNo }, { key: 'pay', label: 'Payment', render: (c) => ui.badge((c.payment || {}).status || 'Pending') }, { key: 'mode', label: 'Mode', render: (c) => (c.payment || {}).mode }, { key: 'age', label: 'Pending for', render: (c) => ((c.payment || {}).status === 'Received' ? '—' : ui.badge(dur(hrsSince(c.closedAt)), hrsSince(c.closedAt) > 24 ? 'bad' : 'warn')) }], actions: (c) => ((c.payment || {}).status !== 'Received' && roleIs('accounts', 'service_coordinator', 'admin') ? [ui.btn('Record payment', () => A.payment(c), 'sm primary')] : []) }), { flush: true }));
        if (t === 'a') body.appendChild(ui.card(null, ui.table({ rows: amcs, onRow: (a) => openContract(a.id), filters: [{ key: 'division', label: 'divisions', options: DIVS }, { key: 'status', label: 'statuses', options: ['Active', 'Expired'] }], columns: [{ key: 'id', label: 'AMC', render: (a) => mono(a.id) }, { key: 'customerId', label: 'Customer', render: (a) => custName(a.customerId) }, { key: 'type', label: 'Type' }, { key: 'start', label: 'Period', render: (a) => fmt.date(a.start) + ' → ' + fmt.date(a.end) }, { key: 'value', label: 'Value', cls: 'right', render: (a) => fmt.money(a.value) }, { key: 'bill', label: 'Billing', render: (a) => ui.badge((a.billing || {}).status || 'To be billed', (a.billing || {}).status === 'Paid' ? 'ok' : (a.billing || {}).status === 'Billed' ? 'warn' : 'info') }, { key: 'inv', label: 'Invoice', render: (a) => (a.billing || {}).invoiceNo }, { key: 'due', label: 'Payment due', render: (a) => ((a.billing || {}).billedAt ? fmt.date(util.addDays(a.billing.billedAt, cfg().creditDays)) : '—') }], actions: (a) => [canBill && (a.billing || {}).status === 'To be billed' ? ui.btn('Raise invoice', () => amcBill(a), 'sm primary') : null, roleIs('accounts', 'admin') && (a.billing || {}).status === 'Billed' ? ui.btn('Payment received', () => amcPaid(a), 'sm ok') : null].filter(Boolean) }), { flush: true }));
        if (t === 'o') body.appendChild(ui.card(null, ui.table({ rows: db.all('ots').filter((o) => o.status === 'Won'), onRow: (o) => openOts(o.id), columns: [{ key: 'id', label: 'OTS', render: (o) => mono(o.id) }, { key: 'customerId', label: 'Customer', render: (o) => custName(o.customerId) }, { key: 'otsType', label: 'Type' }, { key: 'revenue', label: 'Revenue', cls: 'right', render: (o) => fmt.money(o.revenue) }, { key: 'invoiceNo', label: 'Invoice ref' }, { key: 'billed', label: 'Billing', render: (o) => ui.badge(o.billed ? 'Billed' : 'Ready for billing', o.billed ? 'ok' : 'warn') }], actions: (o) => (!o.billed && roleIs('accounts', 'admin') ? [ui.btn('Mark billed', () => { db.update('ots', o.id, { billed: true, billedAt: now().toISOString() }, { note: 'Billed' }); CRM.refresh(); }, 'sm')] : []) }), { flush: true }));
      }));
    },
  });
  function amcBill(a) { ui.formModal('Raise AMC invoice · ' + a.id, [{ key: 'invoiceNo', label: 'Invoice no.', required: true }, { key: 'amount', label: 'Amount ₹', type: 'number', required: true }], { invoiceNo: 'INV-AMC-' + a.id.slice(4), amount: a.value }, (v) => { db.update('amcContracts', a.id, { billing: { status: 'Billed', invoiceNo: v.invoiceNo, amount: v.amount, billedAt: util.iso(CRM.TODAY), paymentStatus: 'Pending' } }, { note: 'AMC invoiced' }); CRM.notify({ to: ['accounts'], title: 'AMC invoice raised ' + v.invoiceNo, body: custName(a.customerId) + ' · ' + fmt.money(v.amount) + ' · payment due in ' + cfg().creditDays + ' days', link: '#/svc-billing', key: 'amcinv-' + a.id + v.invoiceNo }); ui.toast('Invoice raised', 'ok'); CRM.refresh(); }); }
  function amcPaid(a) { ui.formModal('AMC payment received', [{ key: 'mode', label: 'Mode', type: 'select', options: ['Bank Transfer', 'UPI', 'Cheque', 'Cash'], required: true }], {}, (v) => { db.update('amcContracts', a.id, { billing: Object.assign({}, a.billing, { status: 'Paid', paymentStatus: 'Received', paidAt: util.iso(CRM.TODAY), mode: v.mode }) }, { note: 'AMC payment received' }); evaluateSoon(); ui.toast('Payment recorded', 'ok'); CRM.refresh(); }); }

  // ---------------------------------------------------------------- Engineer master & performance (score-based)
  const or100 = (n, d) => (d ? pctOf(n, d) : 100); // no data → neutral (no penalty)
  function engScore(engId, days) {
    const inPeriod = (c) => util.daysBetween(c.createdAt, CRM.TODAY) <= days;
    const mine = db.all('complaints').filter((c) => c.engineerId === engId && inPeriod(c) && c.status !== 'Cancelled');
    const list = mine.filter((c) => c.callType !== 'Installation');
    const m = metrics(list);
    const fb = db.all('feedback').filter((f) => f.engineerId === engId && util.daysBetween(f.createdAt, CRM.TODAY) <= days);
    const csat = fb.length ? util.sum(fb, (f) => f.rating) / fb.length : 0;
    const sp = db.all('spareRequests').filter((s) => list.some((c) => c.id === s.complaintId));
    const iss = util.sum(sp.filter((s) => ['Issued', 'Used', 'Returned'].includes(s.status)), (s) => s.qty);
    const spEff = iss ? pctOf(util.sum(sp, (s) => s.usedQty || 0), iss) : 100;
    const viol = db.all('violations').filter((v) => v.ownerId === engId && util.daysBetween(v.incidentAt, CRM.TODAY) <= days).length;
    const rev = m.revenue + util.sum(db.all('ots').filter((o) => o.status === 'Won' && o.createdBy === engId && util.daysBetween(o.closedAt, CRM.TODAY) <= days), (o) => o.revenue);
    const onTime = list.filter((c) => c.commitAt && c.attendedAt);
    const onTimePct = pctOf(onTime.filter((c) => new Date(c.attendedAt) <= new Date(c.commitAt)).length, onTime.length);
    const closeRate = pctOf(m.closed, m.total);
    // GRN compliance (service-centre calls with a registered GRN) and scrap accountability (replacements / installations with a scrap entry)
    const scCalls = mine.filter((c) => c.serviceCentre);
    const grnPct = or100(scCalls.filter((c) => grnFor(c)).length, scCalls.length);
    const grnsColl = db.all('grns').filter((g) => g.collectedBy === engId && g.createdAt && util.daysBetween(g.createdAt, CRM.TODAY) <= days);
    const scrapDue = mine.filter((c) => isReplacement(c) || (c.callType === 'Installation' && c.scrapApplicable && c.installedAt));
    const scrapPct = or100(scrapDue.filter((c) => scrapFor(c).length || c.scrapId || c.scrapCollectedAt).length, scrapDue.length);
    // PM completion & on-time
    const pmv = db.all('pmVisits').filter((v) => v.engineerId === engId && parseD(v.dueDate) <= CRM.TODAY && util.daysBetween(parseD(v.dueDate), CRM.TODAY) <= Math.max(days, 30));
    const pmDone = or100(pmv.filter((v) => v.completedDate).length, pmv.length); const pmOnTimePct = or100(pmv.filter(pmOnTime).length, pmv.length);
    // installation performance (completed, on-time vs INS-DLY threshold, payment efficiency, scrap accuracy)
    const inst = mine.filter((c) => c.callType === 'Installation');
    const instDone = inst.filter((c) => c.installedAt);
    const insThr = thr(rule('INS-DLY') || {}, 24);
    const instOnTime = or100(instDone.filter((c) => (new Date(c.installedAt) - new Date(c.createdAt)) / HR <= insThr).length, instDone.length);
    const instPay = or100(instDone.filter((c) => (c.instPayment || {}).status === 'Received' || (c.instPayment || {}).mode === 'Credit').length, instDone.length);
    const instScrap = or100(instDone.filter((c) => !c.scrapApplicable || c.scrapId || c.scrapCollectedAt).length, instDone.filter((c) => c.scrapApplicable).length ? instDone.length : 0);
    const instScore = Math.round((instOnTime + instPay + instScrap) / 3);
    const pen = (cfg().penalty || {}).engineer != null ? Number(cfg().penalty.engineer) : 1.5;
    const score = Math.max(0, Math.round(0.2 * m.attendanceSla + 0.12 * m.fvr + 0.12 * closeRate + 0.16 * (csat ? csat / 5 * 100 : 80) + 0.08 * (100 - m.repeatPct) + 0.07 * spEff + 0.05 * onTimePct + 0.06 * pmOnTimePct + 0.05 * instScore + 0.05 * grnPct + 0.04 * scrapPct - viol * pen));
    return { m, csat: Math.round(csat * 10) / 10, spEff, viol, rev, score, onTimePct, closeRate, daily: Math.round(m.attended / Math.max(1, Math.min(days, 26)) * 10) / 10, grnPct, grnsCollected: grnsColl.length, scrapPct, pmDue: pmv.length, pmDone, pmOnTimePct, instCount: inst.length, instDone: instDone.length, instOnTime, instPay, instScrap, instScore };
  }
  // coordinator score: ack ≤ SLA %, allocation efficiency, data accuracy, communication — minus violations owned by coordinators
  function coordScore(days) {
    const co = svcList().filter((c) => util.daysBetween(c.createdAt, CRM.TODAY) <= Math.max(days, 1));
    const acked = co.filter((c) => c.ackAt); const asg = co.filter((c) => c.assignedAt && c.ackAt);
    const ack = pctOf(acked.filter((c) => slaState(c, 'ack') === 'Met').length, acked.length);
    const alloc = pctOf(asg.filter((c) => (new Date(c.assignedAt) - new Date(c.ackAt)) / HR <= 1).length, asg.length);
    const data = pctOf(co.filter((c) => c.assetId && c.serial).length, co.length);
    const comm = pctOf(co.filter((c) => c.feedbackId).length, co.filter((c) => c.closedAt).length);
    const viol = db.all('violations').filter((v) => (v.ownerId === 'EMP-service_coordinator' || v.ownerRole === 'service_coordinator' || ['SVC-ACK'].includes(v.ruleId)) && util.daysBetween(v.incidentAt, CRM.TODAY) <= Math.max(days, 1)).length;
    const pen = Number((cfg().penalty || {}).coordinator) || 2;
    return { ack, alloc, data, comm, viol, score: Math.max(0, Math.round(0.35 * ack + 0.25 * alloc + 0.2 * data + 0.2 * comm - viol * pen)) };
  }
  // sales score per executive and department performance scores (violation penalties — Policy doc §15)
  function salesScores(days) {
    const pen = Number((cfg().penalty || {}).sales) || 3;
    return master.staff('sales_exec').map((e) => { const v = db.all('violations').filter((x) => x.ownerId === e.id && util.daysBetween(x.incidentAt, CRM.TODAY) <= days); return { name: e.name, viol: v.length, open: v.filter(vOpen).length, score: Math.max(0, 100 - v.length * pen - v.filter(vOpen).length) }; });
  }
  function deptScores(days) {
    const pen = Number((cfg().penalty || {}).department) || 2;
    return Object.keys(LADDER).map((d) => {
      const all = db.all('violations').filter((v) => v.area === d && util.daysBetween(v.incidentAt, CRM.TODAY) <= days); const open = all.filter(vOpen);
      const closed = all.filter((v) => v.closedAt); const onTime = pctOf(closed.filter((v) => v.dueDate && util.iso(v.closedAt) <= v.dueDate).length, closed.length);
      return { d, total: all.length, open: open.length, critical: open.filter((v) => v.severity === 'Critical').length, l3: open.filter((v) => (v.escalationLevel || 1) >= 3).length, onTime, score: Math.max(0, Math.round(100 - all.length * pen * 0.5 - open.length * pen - open.filter((v) => v.severity === 'Critical').length * 5)) };
    });
  }
  CRM.registerPage({
    id: 'engineers', title: 'Engineer Performance', icon: '🏅', section: 'Service', order: 66, roles: ['service_coordinator', 'pm_coordinator', 'admin', 'gm', 'odm'],
    render(el) {
      let days = 30;
      ui.page(el, { title: 'Engineer Master & Performance', sub: 'Score-based KPIs — process (on-time response, SLA adherence, daily calls, first-time fix, repeat rate, GRN compliance, PM on-time) and result (closure, revenue, CSAT, spare usage, scrap accountability, installation performance); violations reduce the score' });
      const body = h('div');
      el.appendChild(h('div', { class: 'row', style: 'margin-bottom:12px' }, [h('select', { onChange: (e) => { days = Number(e.target.value); draw(); } }, [[1, 'Daily (today)'], [30, 'Monthly (30 days)'], [90, 'Quarter (90 days)']].map(([v, l]) => h('option', { value: v, selected: v === 30 ? true : null }, l)))]));
      el.appendChild(body);
      function draw() {
        body.innerHTML = '';
        const rows = master.staff('service_engineer').map((e) => Object.assign({ id: e.id, name: e.name, division: e.division }, engScore(e.id, days === 1 ? 1 : days)));
        const cols = [{ key: 'name', label: 'Engineer' }, { key: 'score', label: 'Score', render: (r) => ui.badge(r.score, r.score >= 80 ? 'ok' : r.score >= 60 ? 'warn' : 'bad'), sort: (r) => r.score }, { key: 'onTime', label: 'On-time response', render: (r) => fmt.pct(r.onTimePct) }, { key: 'sla', label: 'SLA adherence', render: (r) => fmt.pct(r.m.attendanceSla) }, { key: 'daily', label: 'Daily calls attended', cls: 'right' }, { key: 'fvr', label: 'First-time fix', render: (r) => fmt.pct(r.m.fvr) }, { key: 'rep', label: 'Repeat rate', render: (r) => fmt.pct(r.m.repeatPct) }, { key: 'close', label: 'Closure rate', render: (r) => fmt.pct(r.closeRate) }, { key: 'rev', label: 'Revenue', cls: 'right', render: (r) => fmt.money(r.rev) }, { key: 'csat', label: 'CSAT', render: (r) => (r.csat ? r.csat + '/5' : '—') }, { key: 'sp', label: 'Spare efficiency', render: (r) => fmt.pct(r.spEff) }, { key: 'grn', label: 'GRN compliance', render: (r) => fmt.pct(r.grnPct) + (r.grnsCollected ? ' · ' + r.grnsCollected + ' GRN' : ''), csv: (r) => r.grnPct }, { key: 'scr', label: 'Scrap accountability', render: (r) => fmt.pct(r.scrapPct), csv: (r) => r.scrapPct }, { key: 'pm', label: 'PM done / on-time', render: (r) => (r.pmDue ? fmt.pct(r.pmDone) + ' / ' + fmt.pct(r.pmOnTimePct) : '—'), csv: (r) => r.pmDone + '/' + r.pmOnTimePct }, { key: 'inst', label: 'Installations (done · on-time · payment · scrap)', render: (r) => (r.instCount ? r.instDone + '/' + r.instCount + ' · ' + fmt.pct(r.instOnTime) + ' · ' + fmt.pct(r.instPay) + ' · ' + fmt.pct(r.instScrap) : '—'), csv: (r) => r.instDone + '/' + r.instCount }, { key: 'viol', label: 'Violations', render: (r) => ui.badge(r.viol, r.viol ? 'bad' : 'ok') }];
        body.appendChild(ui.card('Engineer KPI scorecard', ui.table({ rows, columns: cols, search: false, toolbar: [ui.btn('Export CSV', () => exportCSV('engineer_performance', cols, rows), 'sm')] }), { flush: true }));
        const cs = coordScore(days);
        body.appendChild(h('div', { class: 'grid g2 mt' }, [
          ui.card('Coordinator KPIs — ' + master.staffName('EMP-service_coordinator'), ui.dl([['Coordinator score', ui.badge(cs.score, cs.score >= 80 ? 'ok' : cs.score >= 60 ? 'warn' : 'bad')], ['Acknowledgement within SLA', fmt.pct(cs.ack)], ['Allocation efficiency (assigned ≤ 1h of ack)', fmt.pct(cs.alloc)], ['Data accuracy (equipment & serial linked)', fmt.pct(cs.data)], ['Customer communication score (feedback captured)', fmt.pct(cs.comm)], ['Violations (penalty −' + ((cfg().penalty || {}).coordinator || 2) + ' each)', cs.viol]])),
          ui.card('Score ranking', ui.hbars(rows.slice().sort((a, b) => b.score - a.score).map((r) => ({ label: r.name, value: r.score, target: 100 })))),
        ]));
        body.appendChild(h('div', { class: 'mt' }, ui.card('Engineer master', ui.table({ rows: master.staff('service_engineer').map((e) => Object.assign({ id: e.id, name: e.name, phone: e.phone, division: e.division }, engProfile(e.id))), search: false, columns: [{ key: 'name', label: 'Engineer name' }, { key: 'id', label: 'Employee ID', render: (r) => mono(r.id) }, { key: 'phone', label: 'Contact' }, { key: 'areas', label: 'Area / location', render: (r) => (r.areas || []).join(', ') }, { key: 'skills', label: 'Skillset', render: (r) => h('span', {}, r.skills.map((s) => ui.badge(s, 'brand'))) }, { key: 'experience', label: 'Experience' }, { key: 'availability', label: 'Availability', render: (r) => ui.badge(r.availability, r.availability === 'Available' ? 'ok' : 'warn') }, { key: 'load', label: 'Open calls', render: (r) => openLoad(r.id) }], actions: (r) => (isCoord() ? [ui.btn('Edit', () => editEngineer(r.id), 'sm')] : []) }), { flush: true })));
      }
      draw();
    },
  });
  function editEngineer(id) {
    const p = engProfile(id);
    ui.formModal('Engineer profile · ' + master.staffName(id), [{ key: 'skills', label: 'Skillset (comma separated: UPS, Inverter, Battery, Solar, Security)', required: true }, { key: 'experience', label: 'Experience level', type: 'select', options: ['Junior', 'Mid', 'Senior'], required: true }, { key: 'areas', label: 'Areas (comma separated)' }, { key: 'availability', label: 'Availability status', type: 'select', options: ['Available', 'Busy', 'On Leave'], required: true }], { skills: p.skills.join(', '), experience: p.experience, areas: (p.areas || []).join(', '), availability: p.availability }, (v) => {
      const engineers = Object.assign({}, cfg().engineers); engineers[id] = Object.assign({}, p, { skills: v.skills.split(',').map((s) => s.trim()).filter(Boolean), experience: v.experience, areas: v.areas.split(',').map((s) => s.trim()).filter(Boolean), availability: v.availability });
      saveCfg({ engineers }, 'Engineer profile ' + id); ui.toast('Engineer master updated', 'ok'); CRM.refresh();
    });
  }

  // ================================================================ PAGES — AMC & PM section (70–79)
  const AMC_ROLES = ['pm_coordinator', 'service_coordinator', 'accounts', 'sales_manager', 'admin', 'gm', 'odm'];
  const canPm = () => roleIs('pm_coordinator', 'admin');

  // ---------------------------------------------------------------- Equipment / asset master
  function openAsset(id) {
    const a = db.get('assets', id); if (!a) return;
    const cov = coverageOf(a);
    const calls = db.find('complaints', (c) => c.assetId === a.id).sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
    const pms = db.find('pmVisits', (v) => (v.assetIds || []).includes(a.id)).sort((x, y) => (x.dueDate < y.dueDate ? 1 : -1));
    const canEdit = roleIs('service_coordinator', 'pm_coordinator', 'admin');
    ui.drawer({ title: a.id + ' · ' + a.name, sub: custName(a.customerId) + ' · ' + a.division, actions: [
      roleIs('service_coordinator', 'service_engineer', 'admin') ? { label: 'Log complaint', cls: 'primary', onClick: () => { openNewComplaint({ customerId: a.customerId, division: a.division, assetId: a.id }); } } : null,
      canEdit ? { label: 'Replacement / upgrade', onClick: () => { ui.formModal('Replacement / upgrade history', [{ key: 'text', label: 'What changed', required: true }, { key: 'serial', label: 'New serial (if replaced)' }, { key: 'status', label: 'Equipment status', type: 'select', options: ['Active', 'Under Repair', 'Replaced', 'Decommissioned'], required: true }], { status: a.status }, (v) => { db.update('assets', a.id, { history: (a.history || []).concat([{ at: util.iso(CRM.TODAY), text: v.text + (v.serial ? ' (new serial ' + v.serial + ')' : '') }]), serial: v.serial || a.serial, status: v.status }, { note: 'Asset history: ' + v.text }); reopenAfter(() => openAsset(a.id)); }); return false; } } : null,
      canEdit ? { label: 'Transfer ownership', onClick: () => { transferAsset(a); return false; } } : null,
    ].filter(Boolean), body: h('div', { class: 'stack' }, [
      h('div', { class: 'row' }, [ui.divTag(a.division), ui.badge(a.status), covBadge(cov.type), cov.until ? h('span', { class: 'small muted' }, 'until ' + fmt.date(cov.until)) : null, a.installPending ? ui.badge('Installation pending — warranty provisional', 'warn') : null]),
      ui.dl([['Equipment ID', a.id], ['Customer ID / site', a.customerId + ' / ' + (a.siteId || '—')], ['Project / job ID', a.projectId || (a.orderId ? 'SO ' + (a.soNumber || a.orderId) : '—')], ['Equipment category', a.category + ' (' + a.eqType + ')'], ['Make / model', a.make + ' / ' + a.model], ['Serial number', a.serial], ['Location', a.location], ['Camera ID / channel', [a.tag, a.channel].filter(Boolean).join(' · ')], ['Capacity', a.capacity], ['Quantity', a.qty], ['Installation date', fmt.date(a.installDate)], ['Commissioning date', fmt.date(a.commissionDate)], ['Warranty', fmt.date(a.warrantyStart) + ' → ' + fmt.date(a.warrantyEnd)], ['AMC', cov.amc ? cov.amc.id + ' · ' + fmt.date(cov.amc.start) + ' → ' + fmt.date(cov.amc.end) : (a.amcEnd ? 'Ended ' + fmt.date(a.amcEnd) : '—')]]),
      ui.card('Service history (' + calls.length + ')', calls.length ? ui.timeline(calls.slice(0, 8).map((c) => ({ when: fmt.dateTime(c.createdAt), title: c.id + ' · ' + c.category, body: c.status + (c.actionTaken ? ' · ' + c.actionTaken : '') }))) : ui.empty('No complaints')),
      ui.card('PM history (' + pms.length + ')', pms.length ? h('div', { class: 'stack', style: 'gap:4px' }, pms.slice(0, 8).map((v) => h('div', { class: 'row small' }, [link('#/pm/' + v.id, v.id), ' due ' + fmt.date(v.dueDate) + ' ', ui.badge(pmState(v)), v.completedDate ? ' done ' + fmt.date(v.completedDate) : '']))) : ui.empty('No PM visits')),
      ui.card('Replacement & upgrade history', ui.timeline((a.history || []).slice().reverse().map((x) => ({ when: fmt.date(x.at), title: x.text })))),
      (a.ownershipHistory || []).length ? ui.card('Ownership history (complaint history preserved)', ui.timeline(a.ownershipHistory.slice().reverse().map((x) => ({ when: fmt.date(x.at), title: custName(x.from) + ' → ' + custName(x.to), body: x.reason + ' · ' + master.staffName(x.by) })))) : null,
      ui.card('Commissioning & last PM report', assetReports(a)),
    ]) });
  }
  // ownership change: the asset moves to the new customer; complaints, PM visits and history stay linked to the asset (Solar §5.4)
  function transferAsset(a) {
    ui.formModal('Transfer ownership · ' + a.id, [{ key: 'to', label: 'New owner (customer)', type: 'select', options: custOpts().filter((o) => o.value !== a.customerId), required: true }, { key: 'at', label: 'Transfer date', type: 'date', required: true }, { key: 'reason', label: 'Reason (property sale, relocation…)', required: true }, { key: 'keepWarranty', label: 'Warranty transfers with the equipment', type: 'checkbox' }], { at: util.iso(CRM.TODAY), keepWarranty: true }, (v) => {
      const hist = (a.ownershipHistory || []).concat([{ from: a.customerId, to: v.to, at: v.at, reason: v.reason, by: me() }]);
      const patch = { customerId: v.to, siteId: (master.sites(v.to)[0] || {}).id || null, ownershipHistory: hist, history: (a.history || []).concat([{ at: v.at, text: 'Ownership transferred from ' + custName(a.customerId) + ' to ' + custName(v.to) + ' — ' + v.reason }]) };
      if (!v.keepWarranty) patch.warrantyEnd = util.iso(util.addDays(parseD(v.at), -1));
      db.update('assets', a.id, patch, { note: 'Ownership transferred to ' + custName(v.to) });
      const amc = activeAmcFor(a); if (amc) ui.toast('Note: AMC ' + amc.id + ' stays with ' + custName(amc.customerId) + ' — create a new AMC for the new owner', 'warn');
      ui.toast(a.id + ' transferred · ' + db.find('complaints', (c) => c.assetId === a.id).length + ' past complaints remain linked to the equipment', 'ok');
      reopenAfter(() => openAsset(a.id));
    });
  }
  CRM.registerPage({
    id: 'assets', title: 'Equipment Register', icon: '🗄', section: 'AMC & PM', order: 70, roles: ['service_coordinator', 'service_engineer', 'pm_coordinator', 'es_coordinator', 'solar_coordinator', 'admin', 'gm', 'odm'],
    render(el, params) {
      const rows = db.all('assets').map((a) => { const cov = coverageOf(a); return Object.assign({}, a, { cov: cov.type, covUntil: cov.until, custName: custName(a.customerId) }); });
      const cols = [{ key: 'id', label: 'Equipment ID', render: (a) => mono(a.id) }, { key: 'custName', label: 'Customer' }, { key: 'division', label: 'Division', render: (a) => ui.divTag(a.division), csv: (a) => a.division }, { key: 'eqType', label: 'Type' }, { key: 'name', label: 'Make / model', render: (a) => a.make + ' · ' + a.model }, { key: 'serial', label: 'Serial', render: (a) => mono(a.serial), csv: (a) => a.serial }, { key: 'location', label: 'Location / channel', render: (a) => [a.location, a.channel].filter(Boolean).join(' · ') }, { key: 'capacity', label: 'Capacity' }, { key: 'installDate', label: 'Installed', render: (a) => fmt.date(a.installDate) }, { key: 'warrantyEnd', label: 'Warranty end', render: (a) => fmt.date(a.warrantyEnd) }, { key: 'cov', label: 'Coverage', render: (a) => covBadge(a.cov) }, { key: 'status', label: 'Status', render: (a) => ui.badge(a.status) }];
      ui.page(el, { title: 'Customer, Site & Equipment Register', sub: 'Installed base with serial numbers, warranty, AMC, service & PM history — created automatically from project handover and Power sales orders', actions: [roleIs('service_coordinator', 'pm_coordinator', 'admin') ? ui.btn('+ Add equipment', () => addAssetForm(), 'primary') : null, ui.btn('Export CSV', () => exportCSV('equipment_register', cols, rows))] });
      el.appendChild(ui.kpis([{ label: 'Installed equipment', value: rows.length }, { label: 'Under warranty', value: rows.filter((a) => a.cov === 'Warranty').length, color: 'var(--chart-5)' }, { label: 'Under AMC', value: rows.filter((a) => a.cov === 'AMC').length, color: 'var(--ok)' }, { label: 'Not covered', value: rows.filter((a) => a.cov === 'Expired').length, color: 'var(--bad)' }, { label: 'Warranty ending ≤ 90d', value: rows.filter((a) => a.cov === 'Warranty' && util.daysBetween(CRM.TODAY, a.warrantyEnd) <= 90).length, color: 'var(--warn)' }]));
      el.appendChild(ui.card(null, ui.table({ rows, columns: cols, onRow: (a) => openAsset(a.id), filters: [{ key: 'division', label: 'divisions', options: DIVS }, { key: 'eqType', label: 'types', options: EQ_TYPES }, { key: 'cov', label: 'coverage', options: ['Warranty', 'AMC', 'Expired'] }, { key: 'status', label: 'statuses', options: ['Active', 'Under Repair', 'Replaced', 'Decommissioned'] }] }), { flush: true }));
      routeDrawer(params[0], openAsset);
    },
  });
  function addAssetForm() {
    ui.formModal('Add installed equipment', [{ key: 'customerId', label: 'Customer', type: 'select', options: custOpts(), required: true }, { key: 'productId', label: 'Product', type: 'select', options: master.products().map((p) => ({ value: p.id, label: p.division + ' · ' + p.name })), required: true }, { key: 'serial', label: 'Serial number', required: true }, { key: 'location', label: 'Location' }, { key: 'channel', label: 'Camera ID / recording channel' }, { key: 'capacity', label: 'Capacity (kW / kVA / Ah)' }, { key: 'installDate', label: 'Installation date', type: 'date', required: true }, { key: 'projectId', label: 'Project / job ID' }], { installDate: util.iso(CRM.TODAY) }, (v) => {
      if (db.one('assets', (a) => a.serial === v.serial)) { ui.toast('Duplicate prevented: serial already registered', 'bad'); return false; }
      const a = createAsset(Object.assign(v, { siteId: (master.sites(v.customerId)[0] || {}).id }));
      ui.toast(a.id + ' registered · warranty until ' + fmt.date(a.warrantyEnd), 'ok'); CRM.refresh();
    });
  }

  // ---------------------------------------------------------------- AMC opportunities & contracts
  function installedBase(ids) { const as = (ids || []).map((id) => db.get('assets', id)).filter(Boolean); const n = (t) => util.sum(as.filter((a) => a.eqType === t), (a) => a.qty || 1); return 'UPS ' + n('UPS') + ' · Inverter ' + n('Inverter') + ' · Battery ' + n('Battery') + (as.some((a) => !['UPS', 'Inverter', 'Battery'].includes(a.eqType)) ? ' · Other ' + as.filter((a) => !['UPS', 'Inverter', 'Battery'].includes(a.eqType)).length : ''); }
  function openOpp(id) {
    const o = db.get('amcOpportunities', id); if (!o) return;
    const cust = master.customer(o.customerId) || {};
    const q = o.quote;
    const can = roleIs('pm_coordinator', 'service_coordinator', 'admin') || (roleIs('sales_manager') && o.estValue > 100000);
    const re = () => reopenAfter(() => openOpp(o.id));
    const acts = [];
    if (can && !['Won', 'Lost'].includes(o.status)) {
      acts.push({ label: 'Log follow-up', onClick: () => { ui.formModal('Follow-up (call / visit)', [{ key: 'mode', label: 'Mode', type: 'select', options: ['Call', 'Visit', 'Email', 'WhatsApp'], required: true }, { key: 'note', label: 'Outcome', type: 'textarea', required: true }, { key: 'next', label: 'Next follow-up date (reminder)', type: 'date', required: true }], { next: util.iso(util.addDays(CRM.TODAY, 3)) }, (v) => { db.update('amcOpportunities', o.id, { followups: (o.followups || []).concat([Object.assign({ at: now().toISOString(), by: me() }, v)]), status: o.status === 'Open' ? 'Under Follow-up' : o.status, nextFollowUp: v.next }, { note: 'Follow-up ' + v.mode }); closeTasks(o.id, v.mode + ': ' + v.note); oppTask(db.get('amcOpportunities', o.id), v.next); re(); }); return false; } });
      acts.push({ label: q ? 'Revise quotation' : 'Create AMC quotation', cls: 'primary', onClick: () => { quoteForm(o); return false; } });
      if (q && q.status === 'Draft') acts.push({ label: 'Send via email', onClick: () => { db.update('amcOpportunities', o.id, { quote: Object.assign({}, q, { status: 'Sent', sentAt: now().toISOString() }), status: 'Quotation Sent' }, { note: 'AMC quotation emailed' }); CRM.notify({ to: ['pm_coordinator'], title: 'Email sent: AMC quotation ' + q.no, body: 'To ' + cust.email + ' · ' + fmt.money(q.amount), channel: 'Email', link: '#/amc/' + o.id, key: 'aq-sent-' + q.no + q.amount }); evaluateSoon(); re(); return false; } });
      if (q && q.status === 'Sent') acts.push({ label: 'Mark opened', onClick: () => { db.update('amcOpportunities', o.id, { quote: Object.assign({}, q, { status: 'Opened', openedAt: now().toISOString() }) }, { note: 'Quotation opened' }); re(); return false; } });
      if (q && ['Sent', 'Opened'].includes(q.status)) acts.push({ label: '→ Negotiation', onClick: () => { db.update('amcOpportunities', o.id, { status: 'Negotiation' }, { note: 'Negotiation' }); re(); return false; } });
      acts.push({ label: 'Won → activate AMC', cls: 'ok', onClick: () => {
        if (!q || !['Sent', 'Opened', 'Accepted'].includes(q.status)) { ui.toast('Blocked: send the AMC quotation before closing as Won', 'bad'); return false; }
        if (q.discountApproval === 'Pending') { ui.toast('Blocked: discount beyond ' + cfg().discountLimit + '% awaits approval', 'bad'); return false; }
        db.update('amcOpportunities', o.id, { status: 'Won', closedAt: now().toISOString(), closedBy: me(), incentiveApplicable: 'Yes', quote: Object.assign({}, q, { status: 'Accepted' }) }, { note: 'Won' });
        const c = activateAmc(db.get('amcOpportunities', o.id)); ui.toast('AMC ' + c.id + ' activated · 3 PM visits scheduled', 'ok'); re(); return false;
      } });
      acts.push({ label: 'Lost', cls: 'danger', onClick: () => { ui.formModal('Lost — capture reason', [{ key: 'lostReason', label: 'Reason', type: 'select', options: ['Price too high', 'Customer moved to competitor', 'Equipment to be replaced', 'No budget this year', 'Not interested', 'Other'], required: true }], {}, (v) => { db.update('amcOpportunities', o.id, { status: 'Lost', lostReason: v.lostReason, closedAt: now().toISOString(), closedBy: me(), quote: q ? Object.assign({}, q, { status: 'Rejected' }) : null }, { note: 'Lost: ' + v.lostReason }); re(); }); return false; } });
    }
    if (q && q.discountApproval === 'Pending' && roleIs('gm', 'odm', 'admin')) acts.push({ label: 'Approve discount', cls: 'ok', onClick: () => { db.update('amcOpportunities', o.id, { quote: Object.assign({}, q, { discountApproval: 'Approved', discountApprovedBy: me() }) }, { note: 'Discount approved' }); re(); return false; } });
    if (can && !['Won', 'Lost'].includes(o.status)) acts.push({ label: 'Assign', onClick: () => { ui.formModal('Assign opportunity', [{ key: 'assignedTo', label: 'Coordinator / Sales / Service', type: 'select', options: staffOpts('pm_coordinator').concat(staffOpts('service_coordinator'), staffOpts('sales_manager'), staffOpts('sales_exec'), staffOpts('service_engineer')), required: true }], { assignedTo: o.assignedTo }, (v) => { db.update('amcOpportunities', o.id, v, { note: 'Assigned' }); re(); }); return false; } });
    const step = o.status === 'Lost' ? 4 : o.status === 'Won' ? 5 : OPP_STATUS.indexOf(o.status);
    const contract = db.one('amcContracts', (c) => c.oppId === o.id);
    ui.drawer({ title: o.id + ' · ' + o.type, sub: cust.name + ' · ' + o.division, actions: acts, body: h('div', { class: 'stack' }, [
      ui.stepper(OPP_STATUS.slice(0, 5), step, o.status === 'Lost'),
      o.status === 'Lost' ? txtCallout('Lost — ' + o.lostReason, 'bad') : null, contract ? htmlCallout('AMC contract <a href="#/amc/' + esc(contract.id) + '">' + esc(contract.id) + '</a> activated ' + fmt.date(contract.start) + ' → ' + fmt.date(contract.end), 'ok') : null,
      ui.dl([['Opportunity ID', o.id], ['Follow-up task', ((t) => (t ? t.id + ' · due ' + fmt.date(t.dueDate) + ' · ' + master.staffName(t.assignedTo) : 'None open'))(db.one('serviceTasks', (t) => t.refId === o.id && t.status === 'Open'))], ['Customer', cust.name], ['Contact', cust.contact + ' · ' + cust.phone], ['Location', cust.area], ['Opportunity type', ui.badge(o.type, o.type === 'AMC Renewal' ? 'brand' : 'violet')], ['Trigger', o.trigger || 'Manual'], ['Product details', o.productDetails], ['Installed base', installedBase(o.assetIds)], ['Estimated AMC value', fmt.money(o.estValue)], ['Expected closure', fmt.date(o.expectedClose)], ['Assigned to', master.staffName(o.assignedTo)], ['Created by', master.staffName(o.createdBy)], ['Closed by', master.staffName(o.closedBy)], ['Renewal probability', ui.badge(oppScore(o) + '%', oppScore(o) >= 60 ? 'ok' : oppScore(o) >= 40 ? 'warn' : 'bad')], ['Incentive applicable', o.incentiveApplicable || (o.status === 'Won' ? 'Yes' : '—')], ['Next follow-up', fmt.date(o.nextFollowUp)]]),
      q ? ui.card('AMC quotation ' + q.no, ui.dl([['Template', q.template], ['AMC type', q.amcType], ['Capacity (kVA/kW)', q.capacity], ['Batteries', q.batteries], ['Amount', fmt.money(q.amount)], ['Discount', (q.discountPct || 0) + '% ' + (q.discountApproval ? '· ' + q.discountApproval : '')], ['Status', ui.badge(q.status)], ['Sent', fmt.dateTime(q.sentAt)]])) : txtCallout('No quotation yet — TAT: submit at least 30 days before expiry.', 'warn'),
      ui.card('Follow-ups', (o.followups || []).length ? ui.timeline(o.followups.slice().reverse().map((f) => ({ when: fmt.dateTime(f.at) + ' · ' + f.mode + ' · ' + master.staffName(f.by), title: f.note, body: 'Next: ' + fmt.date(f.next) }))) : ui.empty('No follow-ups yet')),
      ui.card('Audit trail', ui.auditTrail('amcOpportunities', o.id)),
    ]) });
  }
  function quoteForm(o) {
    const P = cfg().amcPricing;
    const base = { amcType: (o.quote || {}).amcType || 'Comprehensive', capacity: (o.quote || {}).capacity || 0, batteries: (o.quote || {}).batteries || util.sum((o.assetIds || []).map((id) => db.get('assets', id)).filter((a) => a && a.eqType === 'Battery'), (a) => a.qty), discountPct: (o.quote || {}).discountPct || 0 };
    base.amount = amcQuoteAmount(Object.assign({ assetIds: o.assetIds }, base));
    const recalc = (v, I) => { I.amount.value = Math.round(amcQuoteAmount({ assetIds: o.assetIds, amcType: I.amcType.value, capacity: I.capacity.value, batteries: I.batteries.value }) * (1 - (Number(I.discountPct.value) || 0) / 100)); };
    ui.formModal('AMC quotation · ' + o.id, [
      { key: 'template', label: 'Predefined template', type: 'select', options: ['Power – UPS/Inverter AMC', 'Power – Battery bank AMC', 'Electronic Security – CCTV AMC', 'Electronic Security – Fire alarm AMC', 'Solar – O&M AMC'], required: true },
      { key: 'amcType', label: 'AMC type', type: 'select', options: ['Comprehensive', 'Non-Comprehensive'], required: true, onChange: recalc },
      { key: 'capacity', label: 'Capacity (kVA / kW)', type: 'number', onChange: recalc },
      { key: 'batteries', label: 'Number of batteries', type: 'number', onChange: recalc },
      { key: 'discountPct', label: 'Discount % (approval above ' + cfg().discountLimit + '%)', type: 'number', onChange: recalc },
      { key: 'amount', label: 'Quotation amount ₹ (auto-calculated)', type: 'number', required: true, hint: 'Product-wise: ' + P.Comprehensive.pct + '% / ' + P['Non-Comprehensive'].pct + '% of equipment value + ₹/kVA + ₹/battery' },
    ], Object.assign({ template: o.division === 'Solar' ? 'Solar – O&M AMC' : o.division === 'Power' ? 'Power – UPS/Inverter AMC' : 'Electronic Security – CCTV AMC' }, base), (v) => {
      const needs = v.discountPct > cfg().discountLimit;
      db.update('amcOpportunities', o.id, { quote: Object.assign({ no: 'AQ-' + o.id.slice(4), status: 'Draft' }, v, { discountApproval: needs ? 'Pending' : null }) }, { note: 'AMC quotation ' + fmt.money(v.amount) });
      if (needs) CRM.notify({ to: ['gm', 'odm'], title: 'Discount approval: AMC ' + o.id + ' (' + v.discountPct + '%)', body: custName(o.customerId) + ' · ' + fmt.money(v.amount), link: '#/amc/' + o.id, severity: 'warn', key: 'aq-disc-' + o.id + v.discountPct });
      reopenAfter(() => openOpp(o.id));
    });
  }
  function openContract(id) {
    const c = db.get('amcContracts', id); if (!c) return;
    const vs = db.find('pmVisits', (v) => v.amcId === c.id).sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1));
    const b = c.billing || {};
    const opp = db.one('amcOpportunities', (o) => o.contractId === c.id && !['Won', 'Lost'].includes(o.status));
    ui.drawer({ title: c.id + ' · ' + custName(c.customerId), sub: c.division + ' · ' + c.type, actions: [
      roleIs('accounts', 'pm_coordinator', 'admin') && b.status === 'To be billed' ? { label: 'Raise invoice', cls: 'primary', onClick: () => { amcBill(c); return false; } } : null,
      canPm() && !opp && c.status !== 'Renewed' ? { label: 'Create renewal opportunity', onClick: () => { const o = createOpp({ type: 'AMC Renewal', customerId: c.customerId, siteId: c.siteId, division: c.division, assetIds: c.assetIds, contractId: c.id, estValue: Math.round(c.value * 1.05), expectedClose: util.iso(util.addDays(c.end, -5)), trigger: 'Manual' }); reopenAfter(() => openOpp(o.id)); return false; } } : null,
    ].filter(Boolean), body: h('div', { class: 'stack' }, [
      h('div', { class: 'row' }, [ui.divTag(c.division), ui.badge(c.status), ui.badge(util.daysBetween(CRM.TODAY, c.end) >= 0 ? util.daysBetween(CRM.TODAY, c.end) + ' days to expiry' : 'Expired ' + Math.abs(util.daysBetween(CRM.TODAY, c.end)) + 'd ago', util.daysBetween(CRM.TODAY, c.end) <= 30 ? 'bad' : util.daysBetween(CRM.TODAY, c.end) <= 60 ? 'warn' : 'ok')]),
      opp ? htmlCallout('Renewal opportunity <a href="#/amc/' + esc(opp.id) + '">' + esc(opp.id) + '</a> · ' + esc(opp.status), 'info') : null,
      ui.dl([['AMC status', c.status], ['AMC type', c.type], ['AMC duration', fmt.date(c.start) + ' → ' + fmt.date(c.end)], ['Contract value', fmt.money(c.value)], ['PM frequency', 'Auto: every ' + (c.pmFrequencyMonths || 4) + ' months'], ['Total PM visits', 'Auto: ' + (c.pmVisitsPerYear || 3) + ' per year'], ['Customer reminders sent', db.find('notifications', (n) => n.key && n.key.indexOf('cust-amcRenewal-' + c.id + '-') === 0).map((n) => n.channel.replace(' (simulated)', '') + ' ' + fmt.date(n.createdAt)).join(' · ') || '—'], ['Next PM due', fmt.date(c.nextPmDue)], ['Last PM completed', fmt.date(c.lastPmDate)], ['Installed base', installedBase(c.assetIds)], ['Renewed from / to', (c.renewedFrom || '—') + ' / ' + (c.renewedTo || '—')], ['Billing', (b.status || 'To be billed') + (b.invoiceNo ? ' · ' + b.invoiceNo : '')], ['Payment', b.paidAt ? 'Received ' + fmt.date(b.paidAt) : b.billedAt ? 'Pending since ' + fmt.date(b.billedAt) : '—']]),
      ui.card('PM schedule (' + (c.pmVisitsPerYear || 3) + ' visits · every ' + (c.pmFrequencyMonths || 4) + ' months)', vs.length ? h('div', { class: 'stack', style: 'gap:6px' }, vs.map((v) => h('div', { class: 'row', style: 'justify-content:space-between' }, [h('span', {}, [link('#/pm/' + v.id, v.id), ' · due ' + fmt.date(v.dueDate)]), ui.badge(pmState(v))]))) : ui.empty('No PM visits')),
      ui.card('Audit trail', ui.auditTrail('amcContracts', c.id)),
    ]) });
  }
  CRM.registerPage({
    id: 'amc', title: 'AMC Management', icon: '📑', section: 'AMC & PM', order: 71, roles: AMC_ROLES.concat(['service_engineer']),
    badge: () => (roleIs('pm_coordinator') ? db.all('amcOpportunities').filter((o) => !['Won', 'Lost'].includes(o.status) && !o.quote).length : 0),
    render(el, params) {
      const opps = db.all('amcOpportunities').filter((o) => !roleIs('service_engineer') || o.createdBy === me());
      const cons = db.all('amcContracts').filter((c) => c.status !== 'Renewed');
      const oppCols = [{ key: 'id', label: 'Opportunity', render: (o) => mono(o.id) }, { key: 'type', label: 'Type', render: (o) => ui.badge(o.type, o.type === 'AMC Renewal' ? 'brand' : 'violet'), csv: (o) => o.type }, { key: 'customerId', label: 'Customer', render: (o) => custName(o.customerId), csv: (o) => custName(o.customerId) }, { key: 'division', label: 'Division', render: (o) => ui.divTag(o.division), csv: (o) => o.division }, { key: 'estValue', label: 'Est. value', cls: 'right', render: (o) => fmt.money(o.estValue) }, { key: 'expectedClose', label: 'Expected closure', render: (o) => fmt.date(o.expectedClose) }, { key: 'quote', label: 'Quotation', render: (o) => (o.quote ? ui.badge(o.quote.status) : ui.badge('Not submitted', 'warn')), csv: (o) => (o.quote ? o.quote.status : 'Not submitted') }, { key: 'assignedTo', label: 'Assigned', render: (o) => master.staffName(o.assignedTo) }, { key: 'score', label: 'Probability', render: (o) => oppScore(o) + '%', sort: (o) => oppScore(o) }, { key: 'status', label: 'Status', render: (o) => ui.badge(o.status) }];
      const conCols = [{ key: 'id', label: 'AMC', render: (c) => mono(c.id) }, { key: 'customerId', label: 'Customer', render: (c) => custName(c.customerId), csv: (c) => custName(c.customerId) }, { key: 'division', label: 'Division', render: (c) => ui.divTag(c.division), csv: (c) => c.division }, { key: 'type', label: 'AMC type' }, { key: 'start', label: 'Start', render: (c) => fmt.date(c.start) }, { key: 'end', label: 'End', render: (c) => fmt.date(c.end) }, { key: 'value', label: 'Contract value', cls: 'right', render: (c) => fmt.money(c.value) }, { key: 'nextPmDue', label: 'Next PM due', render: (c) => fmt.date(c.nextPmDue) }, { key: 'lastPmDate', label: 'Last PM', render: (c) => fmt.date(c.lastPmDate) }, { key: 'status', label: 'Status', render: (c) => ui.badge(c.status) }];
      ui.page(el, { title: 'AMC — Renewals & Warranty Conversion', sub: 'AMC → AMC renewal customers and Warranty → AMC conversions · alerts at 60/30/0 days before AMC expiry and 90/30 days before warranty expiry', actions: [
        canPm() ? ui.btn('Run renewal automation', () => { const n = runAmcAutomation(false); evaluatePolicies(); ui.toast(n + ' new opportunit' + (n === 1 ? 'y' : 'ies') + ' auto-created', 'ok'); CRM.refresh(); }) : null,
        roleIs('pm_coordinator', 'service_coordinator', 'service_engineer', 'admin') ? ui.btn('+ New opportunity', () => ui.formModal('New AMC opportunity', [{ key: 'type', label: 'Opportunity type', type: 'select', options: ['AMC Renewal', 'Warranty Conversion'], required: true }, { key: 'customerId', label: 'Customer', type: 'select', options: custOpts(), required: true }, { key: 'division', label: 'Division', type: 'select', options: DIVS, required: true }, { key: 'estValue', label: 'Estimated AMC value ₹', type: 'number', required: true }, { key: 'expectedClose', label: 'Expected closure', type: 'date', required: true }, { key: 'productDetails', label: 'Product details' }], { type: 'Warranty Conversion' }, (v) => { v.assetIds = db.find('assets', (a) => a.customerId === v.customerId && a.division === v.division).map((a) => a.id); const o = createOpp(Object.assign(v, { trigger: 'Manual' + (roleIs('service_engineer') ? ' (identified during service)' : '') })); CRM.notify({ to: ['pm_coordinator'], title: 'New AMC opportunity ' + o.id, body: custName(o.customerId) + ' · ' + o.type, link: '#/amc/' + o.id, key: 'amo-new-' + o.id }); reopenAfter(() => openOpp(o.id)); }), 'primary') : null,
      ] });
      const open = opps.filter((o) => !['Won', 'Lost'].includes(o.status));
      el.appendChild(ui.kpis([{ label: 'Active AMC contracts', value: cons.filter((c) => c.status === 'Active').length, meta: fmt.lakh(util.sum(cons.filter((c) => c.status === 'Active'), (c) => c.value)) + ' contract value', color: 'var(--ok)' }, { label: 'Expiring ≤ 60 days', value: cons.filter((c) => c.status === 'Active' && util.daysBetween(CRM.TODAY, c.end) <= 60).length, color: 'var(--warn)' }, { label: 'Expired (not renewed)', value: cons.filter((c) => c.status === 'Expired').length, color: 'var(--bad)' }, { label: 'Open opportunities', value: open.length, meta: fmt.lakh(util.sum(open, (o) => o.estValue)) + ' potential' }, { label: 'Quotation not submitted', value: open.filter((o) => !o.quote).length, color: 'var(--bad)' }, { label: 'Follow-ups due', value: open.filter((o) => o.nextFollowUp && o.nextFollowUp <= util.iso(CRM.TODAY)).length, color: 'var(--chart-4)' }]));
      el.appendChild(ui.tabs([{ id: 'k', label: 'Opportunity pipeline' }, { id: 'o', label: 'Opportunities', count: opps.length }, { id: 'c', label: 'AMC contracts', count: cons.length }, { id: 'r', label: 'Renewal & warranty alerts' }], (t, body) => {
        if (t === 'k') body.appendChild(ui.kanban({ columns: OPP_STATUS.map((s, i) => ({ id: s, label: s, color: ['var(--chart-5)', 'var(--chart-1)', 'var(--chart-4)', 'var(--warn)', 'var(--ok)', 'var(--bad)'][i] })), items: opps.filter((o) => !['Won', 'Lost'].includes(o.status) || util.daysBetween(o.closedAt, CRM.TODAY) <= 60), colOf: (o) => o.status, onClick: (o) => openOpp(o.id), sum: (its) => fmt.lakh(util.sum(its, (o) => o.estValue)), card: (o) => [h('div', { class: 't' }, custName(o.customerId)), h('div', { class: 'row' }, [ui.badge(o.type === 'AMC Renewal' ? 'Renewal' : 'Warranty → AMC', o.type === 'AMC Renewal' ? 'brand' : 'violet'), h('span', { class: 'small' }, fmt.money(o.estValue))]), h('div', { class: 'small muted' }, o.id + ' · close ' + fmt.date(o.expectedClose))] }));
        if (t === 'o') body.appendChild(ui.card(null, ui.table({ rows: opps.slice().reverse(), columns: oppCols, onRow: (o) => openOpp(o.id), filters: [{ key: 'type', label: 'types', options: ['AMC Renewal', 'Warranty Conversion'] }, { key: 'status', label: 'statuses', options: OPP_STATUS }, { key: 'division', label: 'divisions', options: DIVS }], toolbar: [ui.btn('Export CSV', () => exportCSV('amc_opportunities', oppCols, opps), 'sm')] }), { flush: true }));
        if (t === 'c') body.appendChild(ui.card(null, ui.table({ rows: cons, columns: conCols, onRow: (c) => openContract(c.id), filters: [{ key: 'status', label: 'statuses', options: ['Active', 'Expired'] }, { key: 'division', label: 'divisions', options: DIVS }, { key: 'type', label: 'types', options: ['Comprehensive', 'Non-Comprehensive'] }], toolbar: [ui.btn('Export CSV', () => exportCSV('amc_contracts', conCols, cons), 'sm')] }), { flush: true }));
        if (t === 'r') {
          const exp = cons.filter((c) => util.daysBetween(CRM.TODAY, c.end) <= 60 && util.daysBetween(CRM.TODAY, c.end) >= -45).sort((a, b) => (a.end > b.end ? 1 : -1));
          const wty = db.all('assets').filter((a) => coverageOf(a).type === 'Warranty' && util.daysBetween(CRM.TODAY, a.warrantyEnd) <= 90);
          const stg = (d) => (d <= 0 ? ui.badge('On expiry', 'bad') : d <= 30 ? ui.badge('30-day alert', 'warn') : ui.badge('60-day alert', 'info'));
          body.appendChild(h('div', { class: 'grid g2' }, [
            ui.card('AMC renewal alerts (60 / 30 / 0 days)', ui.table({ rows: exp, search: false, onRow: (c) => openContract(c.id), columns: [{ key: 'id', label: 'AMC', render: (c) => mono(c.id) }, { key: 'customerId', label: 'Customer', render: (c) => custName(c.customerId) }, { key: 'end', label: 'Expiry', render: (c) => fmt.date(c.end) }, { key: 'stage', label: 'Alert', render: (c) => stg(util.daysBetween(CRM.TODAY, c.end)) }, { key: 'opp', label: 'Opportunity', render: (c) => { const o = db.one('amcOpportunities', (x) => x.contractId === c.id); return o ? ui.badge(o.status) : ui.badge('None', 'bad'); } }] }), { flush: true }),
            ui.card('Warranty → AMC conversion (90 / 30 days)', ui.table({ rows: wty, search: false, onRow: (a) => openAsset(a.id), columns: [{ key: 'id', label: 'Equipment', render: (a) => mono(a.id) }, { key: 'customerId', label: 'Customer', render: (a) => custName(a.customerId) }, { key: 'name', label: 'Product' }, { key: 'warrantyEnd', label: 'Warranty end', render: (a) => fmt.date(a.warrantyEnd) }, { key: 'st', label: 'Alert', render: (a) => ui.badge(util.daysBetween(CRM.TODAY, a.warrantyEnd) <= 30 ? '30-day' : '90-day', util.daysBetween(CRM.TODAY, a.warrantyEnd) <= 30 ? 'warn' : 'info') }] }), { flush: true }),
          ]));
        }
      }));
      if (params[0]) routeDrawer(params[0], (x) => (x.startsWith('AMO') ? openOpp(x) : openContract(x)));
    },
  });

  // ---------------------------------------------------------------- AMC dashboards (Potential · Conversion · Team · Revenue)
  CRM.registerPage({
    id: 'amc-dash', title: 'AMC Dashboards', icon: '📈', section: 'AMC & PM', order: 72, roles: ['pm_coordinator', 'service_coordinator', 'accounts', 'sales_manager', 'admin', 'gm', 'odm'],
    render(el) {
      const ms = months(6); let mk = ms[ms.length - 1].key;
      ui.page(el, { title: 'AMC Dashboards', sub: 'Monthly AMC potential, conversion, team performance and revenue' });
      const sel = h('select', { onChange: (e) => { mk = e.target.value; draw(); } }, ms.slice().reverse().concat([{ key: util.iso(addMonths(CRM.TODAY, 1)).slice(0, 7), label: 'Next month' }]).map((m) => h('option', { value: m.key }, m.label + ' ' + m.key.slice(0, 4))));
      el.appendChild(h('div', { class: 'row', style: 'margin-bottom:12px' }, [h('span', { class: 'small muted' }, 'Month:'), sel]));
      const body = h('div'); el.appendChild(body);
      function draw() {
        body.innerHTML = '';
        const ren = db.all('amcContracts').filter((c) => c.status !== 'Renewed' && monthKey(c.end) === mk);
        const wty = util.groupBy(db.all('assets').filter((a) => !activeAmcFor(a) && monthKey(a.warrantyEnd) === mk), 'customerId');
        const wtyVal = util.sum(Object.values(wty), (l) => amcQuoteAmount({ assetIds: l.map((a) => a.id), amcType: 'Comprehensive' }));
        const opps = db.all('amcOpportunities');
        const won = opps.filter((o) => o.status === 'Won'); const lost = opps.filter((o) => o.status === 'Lost');
        const monthWon = won.filter((o) => monthKey(o.closedAt) === mk);
        const target = cfg().amcTargetMonthly; const achieved = util.sum(monthWon, (o) => (db.one('amcContracts', (c) => c.oppId === o.id) || {}).value || o.estValue);
        body.appendChild(h('h3', { style: 'margin:4px 0 8px' }, '8.1 Monthly AMC potential'));
        body.appendChild(ui.kpis([{ label: 'AMC renewal customers (AMC → AMC)', value: ren.length, meta: fmt.lakh(util.sum(ren, (c) => c.value)), color: 'var(--chart-1)' }, { label: 'Warranty conversion customers', value: Object.keys(wty).length, meta: fmt.lakh(wtyVal), color: 'var(--chart-4)' }, { label: 'Total potential value', value: fmt.lakh(util.sum(ren, (c) => c.value) + wtyVal), color: 'var(--ok)' }]));
        body.appendChild(h('h3', { style: 'margin:4px 0 8px' }, '8.2 Conversion'));
        const ren2 = opps.filter((o) => o.type === 'AMC Renewal' && ['Won', 'Lost'].includes(o.status)); const wc = opps.filter((o) => o.type === 'Warranty Conversion' && ['Won', 'Lost'].includes(o.status));
        body.appendChild(ui.kpis([{ label: 'Total opportunities', value: opps.length }, { label: 'Won', value: won.length, color: 'var(--ok)' }, { label: 'Lost', value: lost.length, color: 'var(--bad)' }, { label: 'Under follow-up', value: opps.filter((o) => !['Won', 'Lost'].includes(o.status)).length, color: 'var(--warn)' }, { label: 'Conversion rate', value: fmt.pct(pctOf(won.length, won.length + lost.length)) }, { label: 'Renewal rate / warranty conversion', value: fmt.pct(pctOf(ren2.filter((o) => o.status === 'Won').length, ren2.length)) + ' / ' + fmt.pct(pctOf(wc.filter((o) => o.status === 'Won').length, wc.length)) }]));
        const byCo = util.groupBy(won.concat(lost), (o) => o.closedBy || o.assignedTo);
        const eng = opps.filter((o) => (db.get('staff', o.createdBy) || {}).role === 'service_engineer');
        const salesC = won.filter((o) => /sales/.test((db.get('staff', o.closedBy) || {}).role || ''));
        body.appendChild(h('div', { class: 'grid g2' }, [
          ui.card('8.3 Team performance — coordinator-wise conversion', ui.hbars(Object.keys(byCo).map((k) => ({ label: master.staffName(k), value: byCo[k].filter((o) => o.status === 'Won').length, target: byCo[k].length })))),
          ui.card('Engineer & sales contribution', ui.dl([['Opportunities identified by engineers', eng.length], ['…of which won', eng.filter((o) => o.status === 'Won').length], ['High-value AMCs closed by Sales', salesC.length], ['Sales-closed value', fmt.lakh(util.sum(salesC, (o) => o.estValue))]])),
          ui.card('8.4 Revenue — target vs achieved (' + mk + ')', ui.hbars([{ label: 'AMC revenue', value: achieved, target }], { money: true })),
          ui.card('Month-wise AMC revenue trend', ui.lineChart(ms.map((m) => m.label), [{ name: 'Achieved', color: 'var(--chart-2)', values: ms.map((m) => util.sum(won.filter((o) => monthKey(o.closedAt) === m.key), (o) => o.estValue)) }, { name: 'Target', color: 'var(--chart-3)', dashed: true, values: ms.map(() => target) }], { money: true, area: true })),
          ui.card('Lost opportunity analysis', ui.hbars(Object.entries(util.countBy(lost, 'lostReason')).map(([k, v]) => ({ label: k, value: v, color: 'var(--bad)' })))),
          ui.card('Pipeline by stage', ui.barChart(OPP_STATUS.map((s) => ({ label: s, values: [opps.filter((o) => o.status === s).length] })), [{ name: 'Opportunities', color: 'var(--chart-4)' }])),
        ]));
      }
      draw();
    },
  });

  // ---------------------------------------------------------------- Preventive Maintenance
  function openPmVisit(id) {
    const v = db.get('pmVisits', id); if (!v) return;
    const plan = db.get('pmPlans', v.planId) || {};
    const items = checklistFor(v.systemType);
    const own = roleIs('service_engineer') ? v.engineerId === me() : roleIs('pm_coordinator', 'service_coordinator', 'admin');
    const re = () => reopenAfter(() => openPmVisit(v.id));
    const up = (patch, n) => { db.update('pmVisits', v.id, patch, { note: n }); evaluateSoon(); };
    const state = Object.assign({}, v.checklist || {});
    const cl = ui.checklist(items, state, null, v.stage !== 4 || !own);
    const acts = [];
    const s = v.stage;
    if (own && s === 0) acts.push({ label: 'Plan visit', cls: 'primary', onClick: () => { ui.formModal('Plan PM visit', [{ key: 'scheduledDate', label: 'Visit date', type: 'date', required: true }], { scheduledDate: v.dueDate }, (x) => { up({ scheduledDate: x.scheduledDate, stage: 1 }, 'Visit planned ' + fmt.date(parseD(x.scheduledDate))); re(); }); return false; } });
    if (own && s === 1) acts.push({ label: 'Customer confirmed', cls: 'primary', onClick: () => { up({ customerConfirmedAt: now().toISOString(), stage: 2 }, 'Customer confirmed visit'); CRM.notify({ to: ['pm_coordinator'], title: 'Customer reminder SMS sent: PM visit ' + fmt.date(v.scheduledDate), body: custName(v.customerId), channel: 'SMS', link: '#/pm/' + v.id, key: 'pm-sms-' + v.id }); re(); return false; } });
    if (roleIs('pm_coordinator', 'service_coordinator', 'admin') && s === 2) acts.push({ label: 'Assign engineer', cls: 'primary', onClick: () => { ui.formModal('Assign PM engineer', [{ key: 'engineerId', label: 'Engineer', type: 'select', options: staffOpts('service_engineer'), required: true }], { engineerId: v.engineerId }, (x) => { up({ engineerId: x.engineerId, stage: 3 }, 'Engineer assigned'); CRM.notify({ to: ['service_engineer'], title: 'PM visit assigned: ' + v.id, body: custName(v.customerId) + ' · ' + v.systemType + ' · ' + fmt.date(v.scheduledDate), link: '#/pm/' + v.id, key: 'pm-asg-' + v.id + x.engineerId }); re(); }); return false; } });
    if (own && s === 3) acts.push({ label: 'Visit completed', cls: 'primary', onClick: () => { evModal('Visit completed — evidence', [{ key: 'visitAt', label: 'Visit date & time', type: 'datetime-local', required: true }], { visitAt: dtLocal(now()) }, [{ key: 'photosBefore', kind: 'photo', label: 'Before-service photos', required: true }, { key: 'photosAfter', kind: 'photo', label: 'After-service photos', required: true }, { key: 'signature', kind: 'signature', label: 'Customer signature', required: true, default: (master.customer(v.customerId) || {}).contact }], (x) => { up({ visitAt: new Date(x.visitAt).toISOString(), photosBefore: storeEv(x.photosBefore, 'pmVisits', v.id, 'photosBefore', 'PM before-service photos'), photosAfter: storeEv(x.photosAfter, 'pmVisits', v.id, 'photosAfter', 'PM after-service photos'), signature: storeEv(x.signature, 'pmVisits', v.id, 'signature', 'PM customer signature'), customerAck: true, stage: 4 }, 'Visit completed'); re(); }); return false; } });
    if (own && s === 4) acts.push({ label: 'Submit checklist', cls: 'primary', onClick: () => {
      if (!cl.complete()) { ui.toast('Blocked: PM cannot be completed — ' + items.filter((i) => !state[i]).length + ' checklist item(s) incomplete', 'bad'); return false; }
      if (!evOk(v, 'pmVisits', 'photosBefore') || !evOk(v, 'pmVisits', 'photosAfter') || !evOk(v, 'pmVisits', 'signature')) { ui.toast('Blocked: photos and customer signature are mandatory (stored attachments)', 'bad'); return false; }
      up({ checklist: state, checklistVersion: cfg().checklistVersion[v.systemType] || 'v1.0', completedDate: util.iso(v.visitAt || CRM.TODAY), stage: 5 }, 'Checklist submitted'); re(); return false;
    } });
    if (own && s === 5) acts.push({ label: 'Record findings', cls: 'primary', onClick: () => { ui.formModal('Findings & corrective actions', [{ key: 'findings', label: 'Findings', type: 'textarea', required: true }, { key: 'readings', label: 'Measurements / readings' }, { key: 'defects', label: 'Defects requiring corrective action (creates a separate service call)', type: 'checkbox' }], {}, (x) => {
      const patch = { findings: x.findings, readings: x.readings, defects: x.defects, stage: 7 };
      if (x.defects) { const a = db.get('assets', (v.assetIds || [])[0]) || {}; const c = createComplaint({ division: v.division, customerId: v.customerId, siteId: v.siteId, assetId: a.id, callType: 'Service', category: 'Preventive maintenance finding', priority: 'Low', source: 'PM Visit', description: 'Corrective action from PM ' + v.id + ': ' + x.findings, pmVisitId: v.id }); patch.correctiveComplaintId = c.id; ui.toast('Corrective-action complaint ' + c.id + ' auto-created', 'ok'); }
      up(patch, 'Findings recorded'); re();
    }); return false; } });
    if (roleIs('pm_coordinator', 'admin') && s === 7) acts.push({ label: 'Approve report & schedule next PM', cls: 'ok', onClick: () => { up({ reportApproved: true, reportApprovedBy: me(), stage: 9 }, 'PM report approved'); const nv = scheduleNextPm(db.get('pmVisits', v.id)); ui.toast('Report approved · ' + (nv ? 'next PM ' + nv.id + ' due ' + fmt.date(nv.dueDate) : 'next PM already scheduled'), 'ok'); re(); return false; } });
    if (roleIs('pm_coordinator', 'admin') && s < 4 && v.dueDate) acts.push({ label: 'Reschedule', onClick: () => { ui.formModal('Reschedule PM (original due date preserved)', [{ key: 'scheduledDate', label: 'New visit date', type: 'date', required: true }, { key: 'reason', label: 'Reason', required: true }], {}, (x) => { up({ scheduledDate: x.scheduledDate, rescheduleReason: x.reason, stage: Math.max(1, v.stage) }, 'Rescheduled: ' + x.reason); re(); }); return false; } });
    ui.drawer({ title: v.id + ' · PM ' + v.systemType, sub: custName(v.customerId) + ' · ' + v.division, actions: acts, body: h('div', { class: 'stack' }, [
      ui.stepper(PM_FLOW, v.reportApproved ? 10 : s + 1), h('div', { class: 'row' }, [ui.badge(pmState(v), pmState(v) === 'Overdue' ? 'bad' : null), v.completedDate ? ui.badge(pmOnTime(v) ? 'On time' : 'Late', pmOnTime(v) ? 'ok' : 'warn') : null]),
      ui.dl([['PM ID', v.id], ['Linked AMC / plan', (v.amcId ? v.amcId : 'Warranty') + ' / ' + v.planId], ['Customer', custName(v.customerId)], ['Contact', (master.customer(v.customerId) || {}).contact + ' · ' + (master.customer(v.customerId) || {}).phone], ['Location', ((db.get('sites', v.siteId) || {}).address) || (master.customer(v.customerId) || {}).area], ['PM due date', fmt.date(v.dueDate)], ['PM scheduled date', fmt.date(v.scheduledDate)], ['PM completed date', fmt.date(v.completedDate)], ['Assigned engineer', master.staffName(v.engineerId)], ['Visit date & time', fmt.dateTime(v.visitAt)], ['Equipment', installedBase(v.assetIds) + ' (' + (plan.deviceCount || (v.assetIds || []).length) + ' devices)'], ['Checklist version', v.checklistVersion || cfg().checklistVersion[v.systemType]], ['Photos before / after', (v.photosBefore ? '✓' : '✗') + ' / ' + (v.photosAfter ? '✓' : '✗')], ['Customer signature', typeof v.signature === 'string' && v.signature.length < 60 ? v.signature : v.signature ? '✓ captured' : '—'], ['Capacity', plan.capacity || '—'], ['Findings', v.findings], ['Corrective service call', v.correctiveComplaintId ? link('#/complaints/' + v.correctiveComplaintId, v.correctiveComplaintId) : '—'], ['Report', v.reportApproved ? 'Approved by ' + master.staffName(v.reportApprovedBy) : 'Pending']]),
      ui.card('Service checklist — ' + v.systemType + ' (' + (cfg().checklistVersion[v.systemType] || 'v1.0') + ')', cl),
      ui.card('Audit trail', ui.auditTrail('pmVisits', v.id)),
    ]) });
  }
  const pmScope = (list) => (roleIs('service_engineer') ? list.filter((v) => v.engineerId === me()) : list);
  const pmCols = () => [{ key: 'id', label: 'PM ID', render: (v) => mono(v.id) }, { key: 'customerId', label: 'Customer', render: (v) => custName(v.customerId), csv: (v) => custName(v.customerId) }, { key: 'loc', label: 'Location', render: (v) => (master.customer(v.customerId) || {}).area }, { key: 'addr', label: 'Address', render: (v) => (db.get('sites', v.siteId) || {}).address || '—' }, { key: 'division', label: 'Division', render: (v) => ui.divTag(v.division), csv: (v) => v.division }, { key: 'systemType', label: 'Product / system' }, { key: 'prod', label: 'Product details', render: (v) => installedBase(v.assetIds) }, { key: 'dueDate', label: 'Due date', render: (v) => fmt.date(v.dueDate), sort: (v) => v.dueDate }, { key: 'scheduledDate', label: 'Scheduled', render: (v) => fmt.date(v.scheduledDate) }, { key: 'engineerId', label: 'Engineer', render: (v) => master.staffName(v.engineerId) }, { key: 'stage', label: 'Last step done', render: (v) => PM_FLOW[v.reportApproved ? 9 : v.stage] }, { key: 'state', label: 'Status', render: (v) => ui.badge(pmState(v), pmState(v) === 'Overdue' ? 'bad' : pmState(v) === 'Due' ? 'warn' : null), csv: (v) => pmState(v) }];
  CRM.registerPage({
    id: 'pm', title: 'Preventive Maintenance', icon: '🗓', section: 'AMC & PM', order: 73, roles: ['pm_coordinator', 'service_coordinator', 'service_engineer', 'admin', 'gm', 'odm'],
    badge: () => pmScope(db.all('pmVisits')).filter((v) => pmState(v) === 'Overdue').length,
    render(el, params) {
      const all = pmScope(db.all('pmVisits')).map((v) => Object.assign({ state: pmState(v) }, v));
      const ms = months(6); let mk = util.iso(CRM.TODAY).slice(0, 7);
      ui.page(el, { title: 'Preventive Maintenance', sub: 'PM Due → Visit Planned → Customer Confirmation → Engineer Assigned → Visit Completed → Checklist Submitted → Findings → Corrective Action → Report Approved → Next PM Scheduled', actions: [canPm() ? ui.btn('Send due reminders / escalate overdue', () => { runPmAutomation(); evaluatePolicies(); ui.toast('PM reminders and overdue escalations sent', 'ok'); CRM.refresh(); }) : null] });
      el.appendChild(ui.kpis([{ label: 'Due this month', value: all.filter((v) => monthKey(v.dueDate) === mk).length }, { label: 'Scheduled', value: all.filter((v) => v.state === 'Scheduled').length, color: 'var(--chart-5)' }, { label: 'Overdue', value: all.filter((v) => v.state === 'Overdue').length, color: 'var(--bad)' }, { label: 'Completed (30 days)', value: all.filter((v) => v.completedDate && util.daysBetween(parseD(v.completedDate), CRM.TODAY) <= 30).length, color: 'var(--ok)' }, { label: 'Reports awaiting approval', value: all.filter((v) => v.stage === 7 && !v.reportApproved).length, color: 'var(--chart-4)' }, { label: 'PM compliance %', value: fmt.pct(pctOf(all.filter(pmOnTime).length, all.filter((v) => parseD(v.dueDate) <= CRM.TODAY).length)) }]));
      el.appendChild(ui.tabs([{ id: 'd', label: 'Monthly PM due list' }, { id: 'a', label: 'All visits', count: all.length }, { id: 'p', label: 'PM plans' }, { id: 'c', label: 'Checklist configuration' }], (t, body) => {
        if (t === 'd') {
          const sel = h('select', { onChange: (e) => { mk = e.target.value; draw(); } }, ms.slice().reverse().concat([{ key: util.iso(addMonths(CRM.TODAY, 1)).slice(0, 7), label: 'Next' }]).map((m) => h('option', { value: m.key, selected: m.key === mk ? true : null }, m.label + ' ' + m.key.slice(0, 4))));
          const out = h('div');
          const rowsOf = () => all.filter((v) => monthKey(v.dueDate) === mk || (v.state === 'Overdue' && mk === util.iso(CRM.TODAY).slice(0, 7))).sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1));
          function draw() { out.innerHTML = ''; out.appendChild(ui.card(null, ui.table({ rows: rowsOf(), columns: pmCols(), onRow: (v) => openPmVisit(v.id), filters: [{ key: 'division', label: 'divisions', options: DIVS }, { key: 'state', label: 'statuses', options: ['Due', 'Scheduled', 'Completed', 'Overdue'] }] }), { flush: true })); }
          body.appendChild(h('div', { class: 'row', style: 'margin-bottom:10px' }, [h('span', { class: 'small muted' }, 'PM Due Report for'), sel, ui.btn('Export to Excel (CSV)', () => exportCSV('monthly_pm_due_' + mk, pmCols(), rowsOf()), 'sm')]));
          body.appendChild(out); draw();
        }
        if (t === 'a') body.appendChild(ui.card(null, ui.table({ rows: all.slice().sort((a, b) => (a.dueDate < b.dueDate ? 1 : -1)), columns: pmCols(), onRow: (v) => openPmVisit(v.id), filters: [{ key: 'division', label: 'divisions', options: DIVS }, { key: 'state', label: 'statuses', options: ['Due', 'Scheduled', 'Completed', 'Overdue'] }, { key: 'systemType', label: 'equipment', options: EQ_TYPES }] }), { flush: true }));
        if (t === 'p') body.appendChild(ui.card(null, ui.table({ rows: db.all('pmPlans'), columns: [{ key: 'id', label: 'PM plan', render: (p) => mono(p.id) }, { key: 'customerId', label: 'Customer / site', render: (p) => custName(p.customerId) + ' · ' + (p.siteId || '') }, { key: 'projectId', label: 'Project', render: (p) => p.projectId || (p.orderId ? 'SO' : '—') }, { key: 'systemType', label: 'Equipment / system' }, { key: 'deviceCount', label: 'Devices', cls: 'right' }, { key: 'coverage', label: 'Coverage', render: (p) => covBadge(p.coverage) }, { key: 'frequencyMonths', label: 'Frequency', render: (p) => 'Every ' + p.frequencyMonths + ' months' }, { key: 'lastPmDate', label: 'Last PM', render: (p) => fmt.date(p.lastPmDate) }, { key: 'nextDue', label: 'Next due', render: (p) => fmt.date(p.nextDue) }, { key: 'engineerId', label: 'Coordinator / engineer', render: (p) => master.staffName(p.coordinatorId) + ' / ' + master.staffName(p.engineerId) }, { key: 'checklistVersion', label: 'Checklist ver.' }], filters: [{ key: 'division', label: 'divisions', options: DIVS }, { key: 'coverage', label: 'coverage', options: ['AMC', 'Warranty'] }] }), { flush: true }));
        if (t === 'c') body.appendChild(checklistConfig());
      }));
      routeDrawer(params[0], openPmVisit);
    },
  });
  function checklistConfig() {
    let type = 'CCTV';
    const wrap = h('div');
    const canEdit = roleIs('pm_coordinator', 'admin');
    function draw() {
      wrap.innerHTML = '';
      const items = checklistFor(type);
      wrap.appendChild(h('div', { class: 'row', style: 'margin-bottom:10px' }, [h('span', { class: 'small muted' }, 'Equipment type:'), h('select', { onChange: (e) => { type = e.target.value; draw(); } }, EQ_TYPES.map((t) => h('option', { value: t, selected: t === type ? true : null }, t))), ui.badge('Version ' + (cfg().checklistVersion[type] || 'v1.0'), 'brand'), canEdit ? ui.btn('+ Add item', () => ui.formModal('Add checklist item', [{ key: 'item', label: 'Checklist item', required: true }], {}, (v) => { save(items.concat([v.item])); }), 'sm primary') : null]));
      wrap.appendChild(ui.card(type + ' PM checklist (' + items.length + ' items)', h('div', { class: 'stack', style: 'gap:4px' }, items.map((it, i) => h('div', { class: 'row', style: 'justify-content:space-between;border-bottom:1px solid var(--border);padding:4px 0' }, [h('span', {}, (i + 1) + '. ' + it), canEdit ? ui.btn('Remove', () => save(items.filter((x) => x !== it)), 'sm ghost') : null])))));
    }
    function save(items) {
      const c = cfg(); const checklists = Object.assign({}, c.checklists, { [type]: items });
      const ver = (c.checklistVersion[type] || 'v1.0').replace(/v(\d+)\.(\d+)/, (m, a, b) => 'v' + a + '.' + (Number(b) + 1));
      saveCfg({ checklists, checklistVersion: Object.assign({}, c.checklistVersion, { [type]: ver }) }, 'Checklist ' + type + ' → ' + ver); ui.toast(type + ' checklist saved as ' + ver, 'ok'); draw();
    }
    draw();
    return wrap;
  }
  // breakdown calls per 10 assets per 90 days: before vs after the first completed PM, and PM-covered vs not-covered assets (last 180 days)
  function breakdownEffect() {
    const bd = svcList().filter(isBreakdown);
    const firstPm = {};
    db.all('pmVisits').filter((v) => v.completedDate).forEach((v) => (v.assetIds || []).forEach((id) => { if (!firstPm[id] || v.completedDate < firstPm[id]) firstPm[id] = v.completedDate; }));
    let before = 0; let after = 0; let bDays = 0; let aDays = 0;
    Object.keys(firstPm).forEach((id) => {
      const f = parseD(firstPm[id]); const aft = Math.min(180, Math.max(0, util.daysBetween(f, CRM.TODAY))); if (aft < 15) return;
      bDays += 180; aDays += aft;
      bd.filter((c) => c.assetId === id).forEach((c) => { const d = util.daysBetween(f, new Date(c.createdAt)); if (d < 0 && d >= -180) before++; else if (d >= 0 && d <= 180) after++; });
    });
    const rate = (n, days) => (days ? Math.round(n / days * 90 * 10 * 10) / 10 : 0);
    const r6 = bd.filter((c) => util.daysBetween(c.createdAt, CRM.TODAY) <= 180);
    const pmSet = new Set(Object.keys(firstPm)); const assets = db.all('assets').filter((a) => a.status === 'Active');
    const covered = assets.filter((a) => pmSet.has(a.id)); const uncovered = assets.filter((a) => !pmSet.has(a.id));
    const per10 = (list) => (list.length ? Math.round(r6.filter((c) => list.some((a) => a.id === c.assetId)).length / list.length * 10 * 10) / 10 : 0);
    const rb = rate(before, bDays); const ra = rate(after, aDays);
    return h('div', { class: 'stack' }, [ui.dl([['Breakdowns / 10 assets / 90d — before first PM', rb], ['…after PM', ra], ['Reduction', rb ? ui.badge(fmt.pct(Math.round((rb - ra) / rb * 1000) / 10), ra <= rb ? 'ok' : 'bad') : '—'], ['PM-covered assets — breakdowns / 10 assets (180d)', per10(covered) + ' (' + covered.length + ' assets)'], ['Not under PM — breakdowns / 10 assets (180d)', per10(uncovered) + ' (' + uncovered.length + ' assets)']])]);
  }
  CRM.registerPage({
    id: 'pm-dash', title: 'PM Dashboard', icon: '📊', section: 'AMC & PM', order: 74, roles: ['pm_coordinator', 'service_coordinator', 'admin', 'gm', 'odm'],
    render(el) {
      const ms = months(6); let mk = util.iso(CRM.TODAY).slice(0, 7);
      ui.page(el, { title: 'Monthly PM Dashboard', sub: 'Total due, scheduled, completed, pending and overdue; engineer PM performance; planned vs completed' });
      const body = h('div');
      el.appendChild(h('div', { class: 'row', style: 'margin-bottom:12px' }, [h('span', { class: 'small muted' }, 'Month:'), h('select', { onChange: (e) => { mk = e.target.value; draw(); } }, ms.slice().reverse().map((m) => h('option', { value: m.key }, m.label + ' ' + m.key.slice(0, 4))))]));
      el.appendChild(body);
      function draw() {
        body.innerHTML = '';
        const all = db.all('pmVisits');
        const due = all.filter((v) => monthKey(v.dueDate) === mk);
        body.appendChild(ui.kpis([{ label: 'Total PM due', value: due.length }, { label: 'Scheduled', value: due.filter((v) => pmState(v) === 'Scheduled').length, color: 'var(--chart-5)' }, { label: 'Completed', value: due.filter((v) => v.completedDate).length, color: 'var(--ok)' }, { label: 'Pending', value: due.filter((v) => !v.completedDate && pmState(v) !== 'Overdue').length, color: 'var(--warn)' }, { label: 'Overdue', value: due.filter((v) => pmState(v) === 'Overdue').length, color: 'var(--bad)' }, { label: 'On-time PM %', value: fmt.pct(pctOf(due.filter(pmOnTime).length, due.filter((v) => parseD(v.dueDate) <= CRM.TODAY).length)) }]));
        const engs = master.staff('service_engineer');
        const past = all.filter((v) => parseD(v.dueDate) <= CRM.TODAY && util.daysBetween(parseD(v.dueDate), CRM.TODAY) <= 180);
        body.appendChild(h('div', { class: 'grid g2' }, [
          ui.card('Planned vs completed (6 months)', ui.barChart(ms.map((m) => ({ label: m.label, values: [all.filter((v) => monthKey(v.dueDate) === m.key).length, all.filter((v) => monthKey(v.dueDate) === m.key && v.completedDate).length, all.filter((v) => monthKey(v.dueDate) === m.key && pmOnTime(v)).length] })), [{ name: 'Planned (due)', color: 'var(--chart-1)' }, { name: 'Completed', color: 'var(--chart-2)' }, { name: 'On time', color: 'var(--chart-6)' }])),
          ui.card('PM by division (month)', ui.donut(DIVS.map((d) => ({ label: d, value: due.filter((v) => v.division === d).length, color: DIV_COLOR[d] })), { label: 'due' })),
          ui.card('Reduction in breakdown complaints (PM effect, PM §15)', breakdownEffect()),
          h('div', { class: 'span2' }, ui.card('Engineer performance (last 6 months)', ui.table({ rows: engs.map((e) => { const l = past.filter((v) => v.engineerId === e.id); return { name: e.name, total: l.length, done: l.filter((v) => v.completedDate).length, ontime: pctOf(l.filter(pmOnTime).length, l.length), missed: pctOf(l.filter((v) => pmState(v) === 'Overdue').length, l.length) }; }), search: false, columns: [{ key: 'name', label: 'Engineer' }, { key: 'total', label: 'PM due', cls: 'right' }, { key: 'done', label: 'PM completed', cls: 'right' }, { key: 'ontime', label: 'On-time PM %', render: (r) => fmt.pct(r.ontime) }, { key: 'missed', label: 'Missed PM %', render: (r) => ui.badge(fmt.pct(r.missed), r.missed > 10 ? 'bad' : 'ok') }] }), { flush: true })),
        ]));
      }
      draw();
    },
  });

  // ================================================================ PAGES — Governance section (80–85)
  const GOV_ROLES = ['odm', 'gm', 'admin', 'service_coordinator', 'pm_coordinator', 'sales_manager', 'es_coordinator', 'solar_coordinator', 'accounts'];
  const V_STATUS = ['Open', 'Action Planned', 'Pending Closure Approval', 'Closed'];
  const canGov = () => roleIs('odm', 'gm', 'admin');
  const canActOn = (v) => canGov() || roleIs('service_coordinator', 'pm_coordinator', 'sales_manager', 'es_coordinator', 'solar_coordinator') || v.ownerId === me();
  const vOpen = (v) => !['Closed', 'Exception'].includes(v.status);
  const lvlBadge = (l) => ui.badge('L' + (l || 1), l >= 4 ? 'violet' : l >= 3 ? 'bad' : l >= 2 ? 'warn' : 'info');
  const LVLS = LEVEL_NAMES.map((x, i) => i + 1);
  const vioCols = () => [
    { key: 'id', label: 'Violation', render: (v) => mono(v.id) }, { key: 'incidentAt', label: 'Incident date', render: (v) => fmt.dateTime(v.incidentAt), sort: (v) => v.incidentAt },
    { key: 'policyRef', label: 'Policy ref' }, { key: 'title', label: 'Violation type' }, { key: 'area', label: 'Department' }, { key: 'division', label: 'Division', render: (v) => (v.division ? ui.divTag(v.division) : '—'), csv: (v) => v.division },
    { key: 'customerId', label: 'Customer', render: (v) => (v.customerId ? custName(v.customerId) : '—'), csv: (v) => custName(v.customerId) }, { key: 'ownerId', label: 'Owner', render: (v) => (v.ownerId ? master.staffName(v.ownerId) : ((CRM.role(v.ownerRole) || {}).name || '—')), csv: (v) => master.staffName(v.ownerId) },
    { key: 'severity', label: 'Severity', render: (v) => ui.badge(v.severity, sevTone(v.severity)) }, { key: 'escalationLevel', label: 'Escalation', render: (v) => lvlBadge(v.escalationLevel), csv: (v) => 'L' + v.escalationLevel },
    { key: 'kind', label: 'Kind', render: (v) => ui.badge(v.kind, v.kind === 'Warning' ? 'warn' : '') }, { key: 'status', label: 'Status', render: (v) => ui.badge(v.status, v.status === 'Pending Closure Approval' ? 'violet' : v.status === 'Exception' ? '' : null) },
  ];
  function openViolation(id) {
    const v = db.get('violations', id); if (!v) return;
    const r = rule(v.ruleId) || { name: v.title };
    const re = () => reopenAfter(() => openViolation(v.id));
    const up = (p, n) => db.update('violations', v.id, p, { note: n });
    const acts = [];
    if (vOpen(v) && canActOn(v)) {
      acts.push({ label: 'Record corrective action', cls: v.status === 'Open' ? 'primary' : '', onClick: () => { ui.formModal('Corrective action', [{ key: 'rootCause', label: 'Root cause', type: 'select', options: ['Engineer workload', 'Customer not available', 'Spare not in stock', 'Process not followed', 'Traffic / distance', 'Vendor delay', 'System / data error', 'Other'], required: true }, { key: 'correctiveAction', label: 'Corrective action', type: 'textarea', required: true }, { key: 'dueDate', label: 'Due date', type: 'date', required: true }], { rootCause: v.rootCause, correctiveAction: v.correctiveAction, dueDate: v.dueDate }, (x) => { up(Object.assign(x, { status: 'Action Planned' }), 'Corrective action recorded'); re(); }); return false; } });
      if (v.status === 'Action Planned') acts.push({ label: 'Submit for closure', cls: 'primary', onClick: () => { ui.formModal('Closure evidence', [{ key: 'closureEvidence', label: 'Evidence of closure', type: 'textarea', required: true }], {}, (x) => { up(Object.assign(x, { status: 'Pending Closure Approval', submittedBy: me() }), 'Submitted for closure approval'); CRM.notify({ to: ['odm'], title: 'Closure approval requested: ' + v.id, body: v.title + ' · ' + x.closureEvidence, link: '#/violations/' + v.id, key: 'vio-cls-' + v.id + (v.escalationLog || []).length }); re(); }); return false; } });
    }
    if (canGov() && v.status === 'Pending Closure Approval') {
      acts.push({ label: 'Approve closure', cls: 'ok', onClick: () => { up({ status: 'Closed', closureApprovedBy: me(), closedAt: now().toISOString() }, 'Closure approved'); re(); return false; } });
      acts.push({ label: 'Reject closure', cls: 'danger', onClick: () => { up({ status: 'Action Planned' }, 'Closure rejected'); re(); return false; } });
    }
    if (canGov() && vOpen(v)) {
      if (v.kind === 'Warning') acts.push({ label: 'Confirm as violation', onClick: () => { up({ kind: 'Confirmed' }, 'Confirmed as policy violation'); re(); return false; } });
      acts.push({ label: 'Record exception', onClick: () => { ui.formModal('Authorized exception', [{ key: 'exceptionReason', label: 'Exception reason & supporting evidence', type: 'textarea', required: true }], {}, (x) => { up(Object.assign(x, { status: 'Exception', closureApprovedBy: me(), closedAt: now().toISOString() }), 'Exception recorded'); re(); }); return false; } });
      if ((v.escalationLevel || 1) < MAX_LVL) acts.push({ label: 'Escalate to L' + ((v.escalationLevel || 1) + 1), cls: 'danger', onClick: () => { const l = (v.escalationLevel || 1) + 1; const to = ladderRoles(v.area, l); up({ escalationLevel: l, escalationLog: (v.escalationLog || []).concat([{ at: now().toISOString(), level: l, to, manual: true }]) }, 'Escalated to L' + l); CRM.notify({ to, title: 'Escalated to ' + LEVEL_NAMES[l - 1] + ': ' + v.title, body: v.id + ' · ' + v.evidence, link: '#/violations/' + v.id, severity: 'bad', key: 'vio-man-' + v.id + '-L' + l }); re(); return false; } });
    }
    const st = v.status === 'Exception' ? 3 : V_STATUS.indexOf(v.status);
    ui.drawer({ title: v.id + ' · ' + v.title, sub: v.area + ' · ' + (v.division || 'All divisions'), actions: acts, body: h('div', { class: 'stack' }, [
      ui.stepper(V_STATUS, st === 3 ? 4 : st),
      h('div', { class: 'row' }, [ui.badge(v.severity, sevTone(v.severity)), lvlBadge(v.escalationLevel), ui.badge(v.kind, v.kind === 'Warning' ? 'warn' : ''), v.cleared ? ui.badge('Condition cleared ' + fmt.dateTime(v.clearedAt), 'ok') : ui.badge('Condition still open', 'bad'), repeatViolations(v) > 1 ? ui.badge('Repeat ×' + repeatViolations(v) + ' (same rule & owner)', 'violet') : null]),
      ui.dl([['Policy reference', v.policyRef + ' — ' + (r.cond || r.name || '')], ['Incident date', fmt.dateTime(v.incidentAt)], ['Detected', fmt.dateTime(v.detectedAt)], ['Responsible owner', v.ownerId ? master.staffName(v.ownerId) : ((CRM.role(v.ownerRole) || {}).name || '—')], ['Customer', v.customerId ? custName(v.customerId) : '—'], ['Record', v.link ? link(v.link, v.recId) : (v.recId || '—') + (v.col ? ' (' + v.col + ')' : '')], ['Evidence', v.evidence], ['Severity', v.severity], ['Root cause', v.rootCause], ['Corrective action', v.correctiveAction], ['Due date', fmt.date(v.dueDate)], ['Escalation', LEVEL_NAMES[(v.escalationLevel || 1) - 1]], ['Closure evidence', v.closureEvidence], ['Closure approval', v.closureApprovedBy ? master.staffName(v.closureApprovedBy) + ' · ' + fmt.dateTime(v.closedAt) : 'Pending'], v.exceptionReason ? ['Exception', v.exceptionReason] : null]),
      ui.card('Escalation log', ui.timeline((v.escalationLog || []).map((e) => ({ when: fmt.dateTime(e.at), title: LEVEL_NAMES[e.level - 1] + (e.manual ? ' (manual)' : ''), body: 'Notified: ' + (e.to || []).map((x) => (CRM.role(x) || {}).name || x).join(', '), color: e.level >= 3 ? 'var(--bad)' : 'var(--warn)' })))),
      ui.card('Audit trail', ui.auditTrail('violations', v.id)),
    ]) });
  }
  CRM.registerPage({
    id: 'violations', title: 'Policy Violations', icon: '🚨', section: 'Governance', order: 80, roles: GOV_ROLES,
    badge: () => (roleIs('odm') ? db.all('violations').filter((v) => v.status === 'Pending Closure Approval').length : 0),
    render(el, params) {
      const all = db.all('violations').slice().sort((a, b) => (a.incidentAt < b.incidentAt ? 1 : -1));
      const open = all.filter(vOpen);
      ui.page(el, { title: 'Policy Violation & Escalation Desk', sub: 'Auto-detected from Sales, Installation, Service, AMC, Projects and Feedback against the configurable rules table · every violation records policy ref, date, owner, evidence, severity, corrective action, due date, escalation and closure approval', actions: [
        canGov() || roleIs('service_coordinator') ? ui.btn('Run policy scan', () => { const n = evaluatePolicies(); ui.toast('Scan complete · ' + n + ' new violation' + (n === 1 ? '' : 's'), n ? 'warn' : 'ok'); CRM.refresh(); }, 'primary') : null,
        canGov() ? ui.btn('+ Log violation / warning', () => ui.formModal('Log policy violation', [{ key: 'type', label: 'Violation type', required: true }, { key: 'policyRef', label: 'Policy reference', required: true }, { key: 'division', label: 'Division', type: 'select', options: DIVS }, { key: 'owner', label: 'Responsible owner', type: 'select', options: db.all('staff').filter((s) => s.active).map((s) => ({ value: s.id, label: s.name + ' · ' + ((CRM.role(s.role) || {}).name || s.role) })), required: true }, { key: 'severity', label: 'Severity', type: 'select', options: ['Low', 'Medium', 'High', 'Critical'], required: true }, { key: 'details', label: 'Evidence', type: 'textarea', required: true }, { key: 'warning', label: 'Log as warning (not yet confirmed)', type: 'checkbox' }], {}, (x) => { CRM.emit('violation.raise', Object.assign(x, { recordId: 'MAN-' + util.uid() })); ui.toast('Violation logged', 'ok'); CRM.refresh(); })) : null,
        ui.btn('Export CSV', () => exportCSV('policy_violations', vioCols(), all)),
      ] });
      el.appendChild(ui.kpis([{ label: 'Violations today', value: all.filter((v) => util.iso(v.incidentAt) === util.iso(CRM.TODAY)).length }, { label: 'Open violations', value: open.length, color: 'var(--bad)' }, { label: 'Critical (open)', value: open.filter((v) => v.severity === 'Critical').length, color: 'var(--chart-4)' }, { label: 'Awaiting closure approval', value: all.filter((v) => v.status === 'Pending Closure Approval').length, color: 'var(--warn)' }, { label: 'Escalated L3+', value: open.filter((v) => v.escalationLevel >= 3).length, color: 'var(--bad)' }, { label: 'Overdue corrective actions', value: open.filter((v) => v.dueDate && v.dueDate < util.iso(CRM.TODAY)).length }]));
      const ruleNames = [...new Set(all.map((v) => v.title))];
      el.appendChild(ui.tabs([{ id: 'o', label: 'Open', count: open.length }, { id: 'a', label: 'All', count: all.length }, { id: 'p', label: 'Awaiting approval' }], (t, body) => {
        const rows = t === 'o' ? open : t === 'p' ? all.filter((v) => v.status === 'Pending Closure Approval') : all;
        body.appendChild(ui.card(null, ui.table({ rows, columns: vioCols(), onRow: (v) => openViolation(v.id), filters: [{ key: 'area', label: 'departments', options: Object.keys(LADDER) }, { key: 'title', label: 'violation types', options: ruleNames }, { key: 'severity', label: 'severities', options: ['Low', 'Medium', 'High', 'Critical'] }, { key: 'status', label: 'statuses', options: V_STATUS.concat(['Exception']) }, { key: 'division', label: 'divisions', options: DIVS }] }), { flush: true }));
      }));
      routeDrawer(params[0], openViolation);
    },
  });

  // ---------------------------------------------------------------- Escalation dashboards (Management · SLA · Customer risk)
  function customerRisk() {
    return master.customers().map((c) => {
      const esc = db.find('escalations', (e) => e.customerId === c.id);
      const neg = db.find('feedback', (f) => f.customerId === c.id && f.rating <= cfg().negativeRating);
      const rep = db.find('complaints', (x) => x.customerId === c.id && x.repeatOf);
      const vio = db.find('violations', (v) => v.customerId === c.id && vOpen(v));
      return { id: c.id, name: c.name, type: c.type, esc: esc.length, escOpen: esc.filter((e) => e.status !== 'Resolved').length, neg: neg.length, rep: rep.length, vio: vio.length, score: esc.filter((e) => e.status !== 'Resolved').length * 4 + esc.length * 2 + neg.length * 3 + rep.length * 2 + vio.length };
    }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
  }
  CRM.registerPage({
    id: 'escalation-dash', title: 'Escalation Dashboards', icon: '🧯', section: 'Governance', order: 81, roles: ['odm', 'gm', 'admin', 'service_coordinator', 'pm_coordinator', 'sales_manager'],
    render(el) {
      ui.page(el, { title: 'Escalation Dashboards', sub: 'Management · SLA · Customer risk' });
      el.appendChild(h('div', { class: 'row', style: 'margin-bottom:10px' }, [pdfBtn('Escalation Dashboards', () => el.querySelector('.tabs + div') || el)]));
      el.appendChild(ui.tabs([{ id: 'm', label: 'Management dashboard' }, { id: 's', label: 'SLA dashboard' }, { id: 'c', label: 'Customer risk dashboard' }, { id: 't', label: 'Trends (employee · customer)' }], (t, body) => {
        const all = db.all('violations'); const open = all.filter(vOpen);
        if (t === 't') {
          const ms = months(6);
          const trendRows = (keyOf, nameOf) => Object.entries(util.groupBy(all.filter((v) => keyOf(v) && util.daysBetween(v.incidentAt, CRM.TODAY) <= 186), keyOf)).map(([k, l]) => {
            const r = { name: nameOf(k), total: l.length }; ms.forEach((m) => { r[m.key] = l.filter((v) => monthKey(v.incidentAt) === m.key).length; });
            const last3 = util.sum(ms.slice(3), (m) => r[m.key]); const prev3 = util.sum(ms.slice(0, 3), (m) => r[m.key]); r.trend = last3 > prev3 ? 'Rising' : last3 < prev3 ? 'Improving' : 'Flat'; return r;
          }).sort((a, b) => b.total - a.total);
          const cols = (label) => [{ key: 'name', label }].concat(ms.map((m) => ({ key: m.key, label: m.label, cls: 'right' })), [{ key: 'total', label: 'Total', cls: 'right' }, { key: 'trend', label: 'Trend (3m vs prior 3m)', render: (r) => ui.badge(r.trend, r.trend === 'Rising' ? 'bad' : r.trend === 'Improving' ? 'ok' : '') }]);
          const emp = trendRows((v) => v.ownerId, (k) => master.staffName(k)); const cus = trendRows((v) => v.customerId, (k) => custName(k));
          body.appendChild(ui.card('Violations by department over time', ui.lineChart(ms.map((m) => m.label), Object.keys(LADDER).map((d, i) => ({ name: d, color: 'var(--chart-' + ((i % 6) + 1) + ')', values: ms.map((m) => all.filter((v) => v.area === d && monthKey(v.incidentAt) === m.key).length) })))));
          body.appendChild(h('div', { class: 'grid g2 mt' }, [
            ui.card('Employee-wise violation trend', ui.table({ rows: emp, columns: cols('Employee'), pageSize: 10, toolbar: [ui.btn('Export CSV', () => exportCSV('employee_violation_trend', cols('Employee'), emp), 'sm')] }), { flush: true }),
            ui.card('Customer-wise violation trend', ui.table({ rows: cus, columns: cols('Customer'), pageSize: 10, toolbar: [ui.btn('Export CSV', () => exportCSV('customer_violation_trend', cols('Customer'), cus), 'sm')] }), { flush: true }),
          ]));
          return;
        }
        if (t === 'm') {
          body.appendChild(ui.kpis([{ label: 'Total violations today', value: all.filter((v) => util.iso(v.incidentAt) === util.iso(CRM.TODAY)).length }, { label: 'Open violations', value: open.length, color: 'var(--bad)' }, { label: 'Critical violations', value: open.filter((v) => v.severity === 'Critical').length, color: 'var(--chart-4)' }, { label: 'Closed (30d)', value: all.filter((v) => v.closedAt && util.daysBetween(v.closedAt, CRM.TODAY) <= 30).length, color: 'var(--ok)' }]));
          const wk = []; for (let i = 7; i >= 0; i--) { const s = util.addDays(CRM.TODAY, -i * 7 - 6); const e = util.addDays(CRM.TODAY, -i * 7 + 1); wk.push({ label: fmt.date(s).slice(0, 6), values: ['Low', 'Medium', 'High', 'Critical'].map((sv) => all.filter((v) => v.severity === sv && new Date(v.incidentAt) >= s && new Date(v.incidentAt) < e).length) }); }
          const byOwner = util.groupBy(all.filter((v) => v.ownerId), 'ownerId');
          const engOwners = Object.keys(byOwner).filter((k) => (db.get('staff', k) || {}).role === 'service_engineer');
          const rep = Object.values(util.groupBy(all.filter((v) => v.ownerId), (v) => v.ruleId + '|' + v.ownerId)).filter((l) => l.length > 1).sort((a, b) => b.length - a.length);
          body.appendChild(h('div', { class: 'grid g2' }, [
            ui.card('Department-wise violations (open / total)', ui.hbars(Object.keys(LADDER).map((d) => ({ label: d, value: open.filter((v) => v.area === d).length, target: all.filter((v) => v.area === d).length })))),
            ui.card('Engineer-wise violations', ui.hbars(engOwners.map((k) => ({ label: master.staffName(k), value: byOwner[k].length, color: 'var(--bad)', text: byOwner[k].length + ' (' + byOwner[k].filter(vOpen).length + ' open)' })))),
            ui.card('Weekly trend by severity', ui.barChart(wk, [{ name: 'Low', color: 'var(--chart-6)' }, { name: 'Medium', color: 'var(--chart-3)' }, { name: 'High', color: 'var(--chart-5)' }, { name: 'Critical', color: 'var(--chart-4)' }])),
            ui.card('Root cause analysis', ui.donut(Object.entries(util.countBy(all.filter((v) => v.rootCause), 'rootCause')).map(([k, n], i) => ({ label: k, value: n, color: 'var(--chart-' + ((i % 6) + 1) + ')' })), { label: 'analysed' })),
            ui.card('Violations by rule', ui.hbars(Object.entries(util.countBy(all, 'title')).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ label: k, value: n })))),
            ui.card('Repeat violation analysis (same rule & owner)', rep.length ? ui.table({ rows: rep.slice(0, 10).map((l) => ({ owner: master.staffName(l[0].ownerId), rule: l[0].title, n: l.length, open: l.filter(vOpen).length })), search: false, columns: [{ key: 'owner', label: 'Owner' }, { key: 'rule', label: 'Rule' }, { key: 'n', label: 'Count', cls: 'right' }, { key: 'open', label: 'Open', cls: 'right' }] }) : ui.empty('No repeats'), { flush: true }),
            ui.card('Escalation level distribution (open)', ui.barChart(LVLS.map((l) => ({ label: 'L' + l, values: [open.filter((v) => (v.escalationLevel || 1) === l).length] })), [{ name: 'Open violations', color: 'var(--chart-5)' }])),
            ui.card('KPI linkage — violation penalties in scores (30 days)', (() => { const cs = coordScore(30); const ss = salesScores(30); const pen = cfg().penalty || {}; return ui.dl([['Engineer score', '−' + (pen.engineer || 1.5) + ' per violation (Engineer Performance)'], ['Coordinator score', ui.badge(cs.score, cs.score >= 80 ? 'ok' : 'warn')], ['…coordinator violations', cs.viol + ' × −' + (pen.coordinator || 2)], ['Sales team score (avg of executives)', ss.length ? Math.round(util.sum(ss, 'score') / ss.length) : '—'], ['…sales violations', util.sum(ss, 'viol') + ' × −' + (pen.sales || 3)]]); })()),
            h('div', { class: 'span2' }, ui.card('Department performance score (30 days)', ui.table({ rows: deptScores(30), search: false, columns: [{ key: 'd', label: 'Department' }, { key: 'total', label: 'Violations', cls: 'right' }, { key: 'open', label: 'Open', cls: 'right' }, { key: 'critical', label: 'Critical open', cls: 'right' }, { key: 'l3', label: 'Escalated L3+', cls: 'right' }, { key: 'onTime', label: 'Closed on time', render: (r) => fmt.pct(r.onTime) }, { key: 'score', label: 'Score', render: (r) => ui.badge(r.score, r.score >= 80 ? 'ok' : r.score >= 60 ? 'warn' : 'bad'), sort: (r) => r.score }] }), { flush: true })),
            ui.card('Sales executive score (30 days)', ui.table({ rows: salesScores(30), search: false, columns: [{ key: 'name', label: 'Executive' }, { key: 'viol', label: 'Violations', cls: 'right' }, { key: 'open', label: 'Open', cls: 'right' }, { key: 'score', label: 'Score', render: (r) => ui.badge(r.score, r.score >= 80 ? 'ok' : 'warn') }] }), { flush: true }),
          ]));
        }
        if (t === 's') {
          const list = svcList().filter((c) => util.daysBetween(c.createdAt, CRM.TODAY) <= 90);
          const m = metrics(list); const ms = months(6);
          body.appendChild(ui.kpis([{ label: 'SLA compliance (attendance)', value: fmt.pct(m.attendanceSla), meta: 'target > 95%', color: m.attendanceSla >= 95 ? 'var(--ok)' : 'var(--warn)' }, { label: 'SLA compliance (resolution)', value: fmt.pct(m.resolutionSla), color: m.resolutionSla >= 95 ? 'var(--ok)' : 'var(--warn)' }, { label: 'Ack within SLA', value: fmt.pct(m.ackSla) }, { label: 'Average response time', value: m.avgAckMin + ' min', meta: m.avgAttendH + 'h to attend' }, { label: 'Average closure time', value: m.avgCloseH + 'h' }]));
          body.appendChild(h('div', { class: 'grid g2' }, [
            ui.card('SLA by division (90 days)', ui.table({ rows: DIVS.map((d) => Object.assign({ d }, metrics(list.filter((c) => c.division === d)))), search: false, columns: [{ key: 'd', label: 'Division', render: (r) => ui.divTag(r.d) }, { key: 'total', label: 'Calls', cls: 'right' }, { key: 'ackSla', label: 'Ack %', render: (r) => fmt.pct(r.ackSla) }, { key: 'attendanceSla', label: 'Attendance %', render: (r) => fmt.pct(r.attendanceSla) }, { key: 'resolutionSla', label: 'Resolution %', render: (r) => fmt.pct(r.resolutionSla) }, { key: 'avgAttendH', label: 'Avg attend (h)', cls: 'right' }, { key: 'avgCloseH', label: 'Avg close (h)', cls: 'right' }] }), { flush: true }),
            ui.card('Monthly SLA trend', ui.lineChart(ms.map((x) => x.label), [{ name: 'Attendance SLA %', color: 'var(--chart-1)', values: ms.map((x) => metrics(svcList().filter((c) => monthKey(c.createdAt) === x.key)).attendanceSla) }, { name: 'Resolution SLA %', color: 'var(--chart-2)', values: ms.map((x) => metrics(svcList().filter((c) => monthKey(c.createdAt) === x.key)).resolutionSla) }])),
            ui.card('SLA by priority (90 days)', ui.barChart(PRIORITIES.map((p) => { const mm = metrics(list.filter((c) => c.priority === p)); return { label: p, values: [mm.attendanceSla, mm.resolutionSla] }; }), [{ name: 'Attendance %', color: 'var(--chart-1)' }, { name: 'Resolution %', color: 'var(--chart-2)' }])),
            ui.card('Open-call ageing (attended but open)', ui.hbars([['0–24h', 0, 24], ['24–36h', 24, 36], ['36–48h (L1)', 36, 48], ['> 48h (L2)', 48, 1e9]].map(([l, a, b]) => ({ label: l, value: svcList().filter((c) => isOpen(c) && c.attendedAt && hrsSince(c.attendedAt) >= a && hrsSince(c.attendedAt) < b).length, color: a >= 36 ? 'var(--bad)' : 'var(--chart-1)' })))),
          ]));
        }
        if (t === 'c') {
          const risk = customerRisk();
          body.appendChild(ui.kpis([{ label: 'Escalated customers', value: new Set(db.all('escalations').map((e) => e.customerId)).size, meta: db.all('escalations').filter((e) => e.status !== 'Resolved').length + ' open escalations', color: 'var(--bad)' }, { label: 'Negative feedback customers', value: new Set(db.all('feedback').filter((f) => f.rating <= cfg().negativeRating).map((f) => f.customerId)).size, color: 'var(--chart-4)' }, { label: 'Customers with repeat complaints', value: new Set(db.all('complaints').filter((c) => c.repeatOf).map((c) => c.customerId)).size, color: 'var(--warn)' }]));
          body.appendChild(ui.card('Customer risk register', ui.table({ rows: risk, onRow: (r) => CRM.canSee('customer360') && CRM.go('customer360', r.id), columns: [{ key: 'name', label: 'Customer' }, { key: 'type', label: 'Type' }, { key: 'esc', label: 'Escalations', render: (r) => r.esc + (r.escOpen ? ' (' + r.escOpen + ' open)' : '') }, { key: 'neg', label: 'Negative feedback', cls: 'right' }, { key: 'rep', label: 'Repeat complaints', cls: 'right' }, { key: 'vio', label: 'Open violations', cls: 'right' }, { key: 'score', label: 'Risk score', render: (r) => ui.badge(r.score, r.score >= 10 ? 'bad' : r.score >= 5 ? 'warn' : 'info'), sort: (r) => r.score }] }), { flush: true }));
        }
      }));
    },
  });

  // ---------------------------------------------------------------- Policy rules & escalation matrix (configurable)
  const thrText = (r) => (SLA_RULES.includes(r.id) ? 'SLA matrix' : r.threshold == null || r.threshold === '' ? 'default' : r.threshold >= 48 ? Math.round(r.threshold / 24 * 10) / 10 + ' days' : r.threshold < 1 ? Math.round(r.threshold * 60) + ' min' : r.threshold + ' h');
  function editRule(r) {
    const lv = (r.levels || []).concat([null, null, null, null, null]);
    ui.formModal('Edit rule ' + r.id, [
      SLA_RULES.includes(r.id) ? { key: 'thr', label: 'Threshold', type: 'readonly' } : { key: 'threshold', label: 'Threshold (hours)', type: 'number', step: 'any', hint: 'Blank = documented default' },
      { key: 'severity', label: 'Severity', type: 'select', options: ['Low', 'Medium', 'High', 'Critical'], required: true },
      { key: 'startLevel', label: 'Raised at level', type: 'select', options: LVLS.map((l) => ({ value: String(l), label: LEVEL_NAMES[l - 1] })), required: true },
      { key: 'l2', label: 'L2 Team Leader / Coordinator after (+h)', type: 'number', required: true }, { key: 'l3', label: 'L3 Department Head after (+h)', type: 'number', required: true },
      { key: 'l4', label: 'L4 Operations Manager after (+h)', type: 'number', required: true }, { key: 'l5', label: 'L5 Management after (+h)', type: 'number', required: true },
      { key: 'enabled', label: 'Rule enabled', type: 'checkbox' },
    ], { thr: 'From the SLA matrix (Service Configuration)', threshold: r.threshold, severity: r.severity, startLevel: String(r.startLevel || 1), l2: lv[1], l3: lv[2], l4: lv[3], l5: lv[4] != null ? lv[4] : 48, enabled: r.enabled }, (v) => {
      if (!(v.l2 <= v.l3 && v.l3 <= v.l4 && v.l4 <= v.l5)) { ui.toast('Escalation offsets must increase L2 ≤ L3 ≤ L4 ≤ L5', 'bad'); return false; }
      const nr = cfg().rules.map((x) => (x.id === r.id ? Object.assign({}, x, { threshold: SLA_RULES.includes(r.id) ? null : (v.threshold == null ? null : v.threshold), severity: v.severity, startLevel: Number(v.startLevel) || 1, levels: [0, v.l2, v.l3, v.l4, v.l5], enabled: v.enabled }) : x));
      saveCfg({ rules: nr }, 'Rule ' + r.id + ' updated'); ui.toast('Rule updated', 'ok'); CRM.refresh();
    });
  }
  function ladderView(canEdit) {
    const roleName = (x) => (CRM.role(x) || {}).name || x;
    return ui.table({ rows: Object.keys(LADDER).map((d) => ({ d, l: ladderOf(d) })), search: false, columns: [{ key: 'd', label: 'Department' }].concat(LVLS.map((n) => ({ key: 'l' + n, label: 'L' + n, render: (r) => (r.l[n - 1] || []).map(roleName).join(' / ') }))), actions: (r) => (canEdit ? [ui.btn('Edit', () => {
      const opts = CRM.roles.map((x) => x.id).join(', ');
      ui.formModal('Escalation ladder · ' + r.d, LVLS.map((n) => ({ key: 'l' + n, label: LEVEL_NAMES[n - 1] + ' — role ids (comma separated)', required: true, full: true, hint: n === 1 ? 'Role ids: ' + opts : '' })), Object.assign({}, ...LVLS.map((n) => ({ ['l' + n]: (r.l[n - 1] || []).join(', ') }))), (v) => {
        const ids = new Set(CRM.roles.map((x) => x.id)); const lv = LVLS.map((n) => v['l' + n].split(',').map((x) => x.trim()).filter(Boolean));
        const bad = [].concat(...lv).filter((x) => !ids.has(x)); if (bad.length) { ui.toast('Unknown role id: ' + bad.join(', '), 'bad'); return false; }
        saveCfg({ ladder: Object.assign({}, cfg().ladder || util.clone(DEFAULT_LADDER), { [r.d]: lv }) }, 'Escalation ladder ' + r.d); ui.toast('Ladder updated', 'ok'); CRM.refresh();
      });
    }, 'sm')] : []) });
  }
  CRM.registerPage({
    id: 'policy-rules', title: 'Policy Rules & Matrix', icon: '⚖', section: 'Governance', order: 82, roles: ['odm', 'gm', 'admin', 'service_coordinator'],
    render(el) {
      const rules = cfg().rules;
      const canEdit = roleIs('odm', 'admin');
      ui.page(el, { title: 'Policy Violation Master', sub: 'Configurable SLA timings, five-level escalation matrix (roles & offsets), auto alerts and violation severity — the evaluation engine reads these rules and re-checks every minute' });
      el.appendChild(ui.card('Violation rules (' + rules.length + ')', ui.table({ rows: rules, pageSize: 30, columns: [{ key: 'id', label: 'Rule', render: (r) => mono(r.id) }, { key: 'area', label: 'Department' }, { key: 'policyRef', label: 'Policy ref' }, { key: 'name', label: 'Violation', render: (r) => h('div', {}, [h('b', {}, r.name), h('div', { class: 'small muted' }, r.cond)]) }, { key: 'threshold', label: 'Threshold', render: thrText, csv: thrText }, { key: 'severity', label: 'Severity', render: (r) => ui.badge(r.severity, sevTone(r.severity)) }, { key: 'levels', label: 'Escalation (L1 → L5)', render: (r) => (r.startLevel > 1 ? 'Raised at L' + r.startLevel + ' · ' : '') + (r.levels || []).map((x, i) => (i ? 'L' + (i + 1) + ' +' + x + 'h' : 'L1 breach')).join(' · ') }, { key: 'enabled', label: 'Enabled', render: (r) => ui.badge(r.enabled ? 'Yes' : 'No') }, { key: 'n', label: 'Open', cls: 'right', render: (r) => db.all('violations').filter((v) => v.ruleId === r.id && vOpen(v)).length }], filters: [{ key: 'area', label: 'departments', options: Object.keys(LADDER) }], actions: (r) => (canEdit ? [ui.btn('Edit', () => editRule(r), 'sm')] : []) }), { flush: true }));
      el.appendChild(h('div', { class: 'grid g2 mt' }, [
        ui.card('Auto escalation matrix (default offsets)', ui.table({ rows: [['SLA breach', LEVEL_NAMES[0]], ['+6 hrs', LEVEL_NAMES[1]], ['+12 hrs', LEVEL_NAMES[2]], ['+24 hrs', LEVEL_NAMES[3]], ['+48 hrs', LEVEL_NAMES[4]]].map(([a, b]) => ({ a, b })), search: false, columns: [{ key: 'a', label: 'Delay duration' }, { key: 'b', label: 'Escalation' }] }), { flush: true }),
        ui.card('Violation severity levels', ui.dl([['Low', 'Quotation delay'], ['Medium', 'Open calls > 36 hrs'], ['High', 'High-priority complaint delay · open call 36–48 h (L2)'], ['Critical', 'Customer escalation / negative feedback']])),
        h('div', { class: 'span2' }, ui.card('Escalation ladder by department (configurable roles per level)', ladderView(canEdit), { flush: true })),
      ]));
    },
  });

  // ---------------------------------------------------------------- Customer escalations & feedback
  CRM.registerPage({
    id: 'escalations', title: 'Escalations & Feedback', icon: '📣', section: 'Governance', order: 83, roles: ['odm', 'gm', 'admin', 'service_coordinator', 'pm_coordinator', 'sales_manager'],
    render(el) {
      const esc = db.all('escalations').slice().reverse(); const fb = db.all('feedback').slice().reverse();
      ui.page(el, { title: 'Customer Escalations & Feedback', sub: 'Escalation date, reason, severity and responsible department · positive / neutral / negative feedback with negative-feedback alert (≤ ' + cfg().negativeRating + '/5)', actions: [
        ui.btn('+ Log customer escalation', () => ui.formModal('Customer escalation', [{ key: 'customerId', label: 'Customer', type: 'select', options: custOpts(), required: true }, { key: 'division', label: 'Division', type: 'select', options: DIVS, required: true }, { key: 'reason', label: 'Escalation reason', type: 'textarea', required: true }, { key: 'severity', label: 'Severity', type: 'select', options: ['Low', 'Medium', 'High', 'Critical'], required: true }, { key: 'department', label: 'Responsible department', type: 'select', options: ['Service', 'Sales', 'Installation', 'Projects', 'Accounts', 'AMC'], required: true }, { key: 'complaintId', label: 'Linked complaint (optional)' }, { key: 'ownerId', label: 'Responsible person', type: 'select', options: db.all('staff').filter((s) => s.active).map((s) => ({ value: s.id, label: s.name })) }], { severity: 'High', department: 'Service' }, (v) => { raiseCustomerEscalation(v); ui.toast('Escalation logged and escalated', 'warn'); CRM.refresh(); }), 'primary'),
        ui.btn('+ Capture feedback', () => ui.formModal('Customer feedback', [{ key: 'customerId', label: 'Customer', type: 'select', options: custOpts(), required: true }, { key: 'division', label: 'Division', type: 'select', options: DIVS, required: true }, { key: 'rating', label: 'Rating', type: 'select', options: ['5', '4', '3', '2', '1'], required: true }, { key: 'comment', label: 'Comment', type: 'textarea' }], {}, (v) => { recordFeedback(null, Object.assign(v, { rating: Number(v.rating) })); CRM.refresh(); })),
      ] });
      el.appendChild(ui.kpis([{ label: 'Open escalations', value: esc.filter((e) => e.status !== 'Resolved').length, color: 'var(--bad)' }, { label: 'Feedback captured', value: fb.length }, { label: 'Positive', value: fb.filter((f) => f.type === 'Positive').length, color: 'var(--ok)' }, { label: 'Neutral', value: fb.filter((f) => f.type === 'Neutral').length, color: 'var(--warn)' }, { label: 'Negative', value: fb.filter((f) => f.type === 'Negative').length, meta: fb.filter((f) => f.type === 'Negative' && !f.actionAt).length + ' without action', color: 'var(--bad)' }, { label: 'Average rating', value: fb.length ? (Math.round(util.sum(fb, (f) => f.rating) / fb.length * 10) / 10) + '/5' : '—' }]));
      el.appendChild(ui.tabs([{ id: 'e', label: 'Escalation report' }, { id: 'f', label: 'Feedback' }, { id: 't', label: 'Feedback trend' }], (t, body) => {
        if (t === 'e') body.appendChild(ui.card(null, ui.table({ rows: esc, columns: [{ key: 'id', label: 'ID', render: (e) => mono(e.id) }, { key: 'date', label: 'Escalation date', render: (e) => fmt.dateTime(e.date) }, { key: 'customerId', label: 'Customer', render: (e) => custName(e.customerId) }, { key: 'reason', label: 'Reason' }, { key: 'severity', label: 'Severity', render: (e) => ui.badge(e.severity, sevTone(e.severity)) }, { key: 'department', label: 'Responsible dept.' }, { key: 'complaintId', label: 'Complaint', render: (e) => (e.complaintId ? link('#/complaints/' + e.complaintId, e.complaintId) : '—') }, { key: 'status', label: 'Status', render: (e) => ui.badge(e.status) }], filters: [{ key: 'department', label: 'departments', options: ['Service', 'Sales', 'Installation', 'Projects', 'Accounts', 'AMC'] }, { key: 'status', label: 'statuses', options: ['Open', 'Resolved'] }], actions: (e) => (e.status !== 'Resolved' && roleIs('odm', 'gm', 'admin', 'service_coordinator') ? [ui.btn('Resolve', () => ui.formModal('Resolve escalation', [{ key: 'resolution', label: 'Resolution & closure evidence', type: 'textarea', required: true }], {}, (v) => { db.update('escalations', e.id, { status: 'Resolved', resolution: v.resolution, resolvedAt: now().toISOString() }, { note: 'Resolved' }); evaluatePolicies(); CRM.refresh(); }), 'sm')] : []) }), { flush: true }));
        if (t === 'f') body.appendChild(ui.card(null, ui.table({ rows: fb, columns: [{ key: 'id', label: 'ID', render: (f) => mono(f.id) }, { key: 'createdAt', label: 'Date', render: (f) => fmt.date(f.createdAt) }, { key: 'customerId', label: 'Customer', render: (f) => custName(f.customerId) }, { key: 'complaintId', label: 'Complaint', render: (f) => (f.complaintId ? link('#/complaints/' + f.complaintId, f.complaintId) : '—') }, { key: 'engineerId', label: 'Engineer', render: (f) => master.staffName(f.engineerId) }, { key: 'rating', label: 'Rating', render: (f) => '★'.repeat(f.rating) + '☆'.repeat(5 - f.rating) }, { key: 'type', label: 'Type', render: (f) => ui.badge(f.type, f.type === 'Positive' ? 'ok' : f.type === 'Neutral' ? 'warn' : 'bad') }, { key: 'comment', label: 'Comment' }, { key: 'channel', label: 'Channel' }], filters: [{ key: 'type', label: 'types', options: ['Positive', 'Neutral', 'Negative'] }, { key: 'division', label: 'divisions', options: DIVS }], actions: (f) => (f.type === 'Negative' && !f.actionAt && roleIs('odm', 'gm', 'admin', 'service_coordinator') ? [ui.btn('Action taken', () => { db.update('feedback', f.id, { actionAt: now().toISOString(), actionBy: me() }, { note: 'Negative feedback actioned' }); evaluatePolicies(); CRM.refresh(); }, 'sm')] : []) }), { flush: true }));
        if (t === 't') { const ms = months(6); body.appendChild(ui.card('Feedback trend', ui.barChart(ms.map((m) => ({ label: m.label, values: ['Positive', 'Neutral', 'Negative'].map((ty) => fb.filter((f) => f.type === ty && monthKey(f.createdAt) === m.key).length) })), [{ name: 'Positive', color: 'var(--ok)' }, { name: 'Neutral', color: 'var(--warn)' }, { name: 'Negative', color: 'var(--bad)' }]))); }
      }));
    },
  });

  // ---------------------------------------------------------------- ODM cross-functional pending tasks
  function pendingTasks() {
    const T = []; const add = (area, item, ref, customerId, owner, since, sev, lk) => T.push({ area, item, ref, customer: customerId ? custName(customerId) : '—', owner: owner ? master.staffName(owner) : '—', since, age: since ? Math.round(hrsSince(since)) : 0, sev, link: lk });
    db.all('complaints').filter(isOpen).forEach((c) => {
      const lk = '#/complaints/' + c.id;
      if (c.step === 1 && slaState(c, 'ack') === 'Breached') add('Service', 'Acknowledgement overdue', c.id, c.customerId, c.coordinatorId, c.createdAt, 'Medium', lk);
      else if (c.step <= 3 && !c.engineerId) add('Service', 'Engineer not assigned', c.id, c.customerId, c.coordinatorId, c.ackAt || c.createdAt, 'Medium', lk);
      if (!c.attendedAt && slaState(c, 'attend') === 'Breached') add('Service', 'Attendance SLA breached (' + c.priority + ')', c.id, c.customerId, c.engineerId, dueAt(c, 'attend'), c.priority === 'Low' ? 'Medium' : 'High', lk);
      if (c.attendedAt && hrsSince(c.attendedAt) > 36) add('Service', 'Attended but open > 36h' + (c.openSub ? ' · ' + c.openSub : ''), c.id, c.customerId, c.engineerId, c.attendedAt, hrsSince(c.attendedAt) > 48 ? 'High' : 'Medium', lk);
      if (c.step === 9 && needsApproval(c) && !c.closureApprovedBy) add('Service', 'Closure approval pending', c.id, c.customerId, c.coordinatorId, c.reportAt, 'Low', lk);
      if (c.observation && !c.observation.outcome && hrsSince(c.observation.revisitAt) > 0) add('Service', 'Observation revisit overdue', c.id, c.customerId, c.engineerId, c.observation.revisitAt, 'Medium', lk);
      if (c.callType === 'Installation' && !c.installedAt) add('Installation', 'Installation pending (' + installStatus(c) + ')', c.id, c.customerId, c.engineerId || c.coordinatorId, c.createdAt, hrsSince(c.createdAt) > 24 ? 'Medium' : 'Low', lk);
      if (c.callType === 'Installation' && c.installedAt && (c.instPayment || {}).status !== 'Received' && (c.instPayment || {}).mode !== 'Credit') add('Installation', 'Installation payment pending', c.id, c.customerId, c.engineerId, c.installedAt, 'Medium', lk);
    });
    const gm = grnMetrics();
    gm.deliveredOpen.forEach((g) => add('Service', 'GRN delivered — complaint not closed', g.id, g.customerId, 'EMP-service_coordinator', g.updatedAt || g.createdAt, 'Medium', '#/complaints/' + g.complaintId));
    gm.missing.forEach((c) => add('Service', 'Missing GRN for service-centre job', c.id, c.customerId, c.engineerId, (c.serviceCentre || {}).inwardAt, 'High', '#/complaints/' + c.id));
    db.all('spareRequests').filter((s) => ['Requested', 'Approved', 'Awaiting stock'].includes(s.status)).forEach((s) => add('Spares', 'Spare ' + s.status.toLowerCase() + ' — ' + s.item, s.id, (db.get('complaints', s.complaintId) || {}).customerId, s.status === 'Requested' ? 'EMP-service_coordinator' : 'EMP-stores', s.requestedAt, 'Low', '#/spares'));
    db.all('pmVisits').filter((v) => pmState(v) === 'Overdue').forEach((v) => add('PM', 'PM overdue (' + v.systemType + ')', v.id, v.customerId, v.engineerId, v.dueDate, 'Medium', '#/pm/' + v.id));
    db.all('pmVisits').filter((v) => v.stage === 7 && !v.reportApproved).forEach((v) => add('PM', 'PM report awaiting approval', v.id, v.customerId, 'EMP-pm_coordinator', v.completedDate, 'Low', '#/pm/' + v.id));
    db.all('amcOpportunities').filter((o) => !['Won', 'Lost'].includes(o.status) && !o.quote && o.contractId).forEach((o) => { const c = db.get('amcContracts', o.contractId); if (c && util.daysBetween(CRM.TODAY, c.end) <= 30) add('AMC', 'Renewal due — quotation not submitted', o.id, o.customerId, o.assignedTo, util.addDays(c.end, -30), 'Medium', '#/amc/' + o.id); });
    db.all('amcContracts').filter((c) => (c.billing || {}).status === 'Billed').forEach((c) => add('AMC', 'AMC invoice payment pending', c.id, c.customerId, 'EMP-accounts', c.billing.billedAt, util.daysBetween(c.billing.billedAt, CRM.TODAY) > cfg().creditDays ? 'Medium' : 'Low', '#/amc/' + c.id));
    db.all('complaints').filter((c) => c.chargeable && c.closedAt && (c.payment || {}).status !== 'Received').forEach((c) => add('Accounts', 'Service charges not collected ' + fmt.money(c.charges), c.id, c.customerId, 'EMP-accounts', c.closedAt, 'Medium', '#/complaints/' + c.id));
    db.all('escalations').filter((e) => e.status !== 'Resolved').forEach((e) => add('Customer', 'Customer escalation — ' + e.reason, e.id, e.customerId, e.ownerId, e.date, 'Critical', '#/escalations'));
    db.all('violations').filter((v) => v.status === 'Pending Closure Approval').forEach((v) => add('Governance', 'Violation closure approval — ' + v.title, v.id, v.customerId, 'EMP-odm', v.updatedAt, 'Low', '#/violations/' + v.id));
    db.all('violations').filter((v) => vOpen(v) && ['Sales', 'Installation', 'Projects'].includes(v.area)).forEach((v) => add(v.area, v.title, v.recId || v.id, v.customerId, v.ownerId, v.incidentAt, v.severity, '#/violations/' + v.id));
    return T.sort((a, b) => b.age - a.age);
  }
  const taskCols = [{ key: 'area', label: 'Area', render: (t) => ui.badge(t.area, 'brand'), csv: (t) => t.area }, { key: 'item', label: 'Pending task' }, { key: 'ref', label: 'Ref', render: (t) => link(t.link, t.ref), csv: (t) => t.ref }, { key: 'customer', label: 'Customer' }, { key: 'owner', label: 'Owner' }, { key: 'since', label: 'Since', render: (t) => fmt.dateTime(t.since) }, { key: 'age', label: 'Ageing', render: (t) => dur(t.age), sort: (t) => t.age, csv: (t) => t.age + 'h' }, { key: 'sev', label: 'Severity', render: (t) => ui.badge(t.sev, sevTone(t.sev)) }];
  CRM.registerPage({
    id: 'pending-tasks', title: 'Pending Tasks (ODM)', icon: '📌', section: 'Governance', order: 84, roles: ['odm', 'gm', 'admin'],
    render(el) {
      const T = pendingTasks();
      ui.page(el, { title: 'Cross-functional Pending Tasks', sub: 'Everything waiting on someone across Service, Spares, PM, AMC, Accounts, Customer, Sales, Installation and Projects', actions: [ui.btn('Export CSV', () => exportCSV('pending_tasks', taskCols, T))] });
      el.appendChild(ui.kpis(['Service', 'PM', 'AMC', 'Accounts', 'Customer', 'Sales', 'Installation', 'Projects'].map((a) => ({ label: a, value: T.filter((t) => t.area === a).length, color: T.filter((t) => t.area === a && ['High', 'Critical'].includes(t.sev)).length ? 'var(--bad)' : 'var(--chart-1)' }))));
      el.appendChild(ui.card(null, ui.table({ rows: T, columns: taskCols, onRow: (t) => { if (t.link) location.hash = t.link; }, filters: [{ key: 'area', label: 'areas', options: [...new Set(T.map((t) => t.area))] }, { key: 'sev', label: 'severities', options: ['Low', 'Medium', 'High', 'Critical'] }], pageSize: 20 }), { flush: true }));
    },
  });

  // ================================================================ Reports (filters + CSV export + drill-down)
  function reportView(body, o) {
    const st = { from: util.iso(util.addDays(CRM.TODAY, -(o.days != null ? o.days : 90))), to: util.iso(util.addDays(CRM.TODAY, o.ahead || 0)), division: '', owner: '', customer: '', ctype: '', cat: '' };
    const out = h('div');
    const inp = (type, key) => h('input', { type, value: st[key], onChange: (e) => { st[key] = e.target.value; draw(); } });
    const sel = (key, label, opts) => h('select', { onChange: (e) => { st[key] = e.target.value; draw(); } }, [h('option', { value: '' }, 'All ' + label)].concat(opts.map((x) => h('option', { value: typeof x === 'object' ? x.value : x }, typeof x === 'object' ? x.label : x))));
    const filtered = () => {
      let rows = o.rows();
      if (o.dateOf) rows = rows.filter((r) => { const d = util.iso(o.dateOf(r)); return !d || (d >= st.from && d <= st.to); });
      if (st.division) rows = rows.filter((r) => (o.divOf ? o.divOf(r) : r.division) === st.division);
      if (st.owner && o.ownerOf) rows = rows.filter((r) => o.ownerOf(r) === st.owner);
      if (st.customer) rows = rows.filter((r) => (o.custOf ? o.custOf(r) : r.customerId) === st.customer);
      if (st.ctype && o.typeOf) rows = rows.filter((r) => (o.typeOf(r) === 'Breakdown' ? 'Service' : o.typeOf(r)) === st.ctype);
      if (st.cat && o.catOf) rows = rows.filter((r) => o.catOf(r) === st.cat);
      return o.aggregate ? o.aggregate(rows) : rows;
    };
    const bar = h('div', { class: 'filters card', style: 'margin-bottom:12px' }, [
      o.dateOf ? h('span', { class: 'small muted' }, 'From') : null, o.dateOf ? inp('date', 'from') : null, o.dateOf ? h('span', { class: 'small muted' }, 'to') : null, o.dateOf ? inp('date', 'to') : null,
      o.noDivision ? null : sel('division', 'divisions', DIVS), o.ownerOf ? sel('owner', 'owners', db.all('staff').filter((s) => ['service_engineer', 'service_coordinator', 'pm_coordinator', 'sales_exec', 'accounts', 'tech_engineer'].includes(s.role)).map((s) => ({ value: s.id, label: s.name }))) : null,
      o.noCustomer ? null : sel('customer', 'customers', custOpts()), o.typeOf ? sel('ctype', 'call / installation types', ES_CALLS.map((v) => ({ value: v, label: callTypeLabel(v) }))) : null, o.catOf ? sel('cat', 'complaint types', [...new Set([].concat(...Object.values(CATEGORIES)))]) : null, h('span', { style: 'flex:1' }), ui.btn('Export CSV', () => exportCSV(o.name, o.columns, filtered()), 'sm primary'), pdfBtn(o.name.replace(/_/g, ' '), () => out),
    ]);
    function draw() { out.innerHTML = ''; const rows = filtered(); if (o.summary) out.appendChild(o.summary(rows)); out.appendChild(ui.card(null, ui.table({ rows, columns: o.columns, onRow: o.onRow, filters: o.filters, pageSize: 12 }), { flush: true })); }
    body.appendChild(bar); body.appendChild(out); draw();
  }
  const sum2 = (pairs) => ui.kpis(pairs.map(([label, value, color]) => ({ label, value, color })));
  function mgmtReport(body) {
    let div = 'Electronic Security', per = 'DRM';
    const out = h('div');
    body.appendChild(h('div', { class: 'filters card', style: 'margin-bottom:12px' }, [h('select', { onChange: (e) => { div = e.target.value; draw(); } }, ['Electronic Security', 'Solar', 'Power'].map((d) => h('option', { value: d }, d))), h('select', { onChange: (e) => { per = e.target.value; draw(); } }, [['DRM', 'Daily (DRM)'], ['WRM', 'Weekly (WRM)'], ['MRM', 'Monthly (MRM)']].map(([v, l]) => h('option', { value: v }, l))), h('span', { style: 'flex:1' }), ui.btn('Export CSV', () => draw(true), 'sm primary')]));
    body.appendChild(out);
    function draw(csv) {
      out.innerHTML = '';
      const start = per === 'DRM' ? CRM.TODAY : per === 'WRM' ? util.addDays(CRM.TODAY, -6) : new Date(CRM.TODAY.getFullYear(), CRM.TODAY.getMonth(), 1);
      const inP = (d) => d && new Date(d) >= start;
      const cs = svcList().filter((c) => c.division === div);
      const m = metrics(cs.filter((c) => inP(c.createdAt)));
      const open = cs.filter(isOpen);
      const pmv = db.all('pmVisits').filter((v) => v.division === div);
      const vio = db.all('violations').filter((v) => v.division === div && inP(v.incidentAt));
      const prj = db.all('projects').filter((p) => p.division === div);
      const rows = [
        ['Complaints received', m.total], ['Complaints attended', cs.filter((c) => inP(c.attendedAt)).length], ['Complaints closed', cs.filter((c) => inP(c.closedAt)).length], ['Open calls (now)', open.length], ['Overdue calls (now)', open.filter(overdue).length],
        ['Acknowledgement SLA %', m.ackSla], ['Attendance SLA %', m.attendanceSla], ['Resolution SLA %', m.resolutionSla], ['Repeat complaint %', m.repeatPct], ['First-visit resolution %', m.fvr],
        ['PM due in period', pmv.filter((v) => inP(v.dueDate) && parseD(v.dueDate) <= CRM.TODAY).length], ['PM completed in period', pmv.filter((v) => inP(v.completedDate)).length], ['PM overdue (now)', pmv.filter((v) => pmState(v) === 'Overdue').length],
        ['Material issues (spares pending)', db.all('spareRequests').filter((s) => s.division === div && ['Requested', 'Approved', 'Awaiting stock'].includes(s.status)).length], ['Escalations raised', db.all('escalations').filter((e) => e.division === div && inP(e.date)).length], ['Policy violations raised', vio.length], ['Violations closed', db.all('violations').filter((v) => v.division === div && inP(v.closedAt)).length],
        ['Projects in progress', prj.filter((p) => !/closed|handover|handed|complete/i.test(p.status || p.stage || '')).length], ['Projects handed over (period)', prj.filter((p) => inP(p.handoverAt || (/handover|handed|closed/i.test(p.status || '') ? p.updatedAt : null))).length],
        ['AMC renewed / converted', db.all('amcOpportunities').filter((o) => o.division === div && o.status === 'Won' && inP(o.closedAt)).length],
      ];
      if (csv === true) { exportCSV(div + '_' + per, [{ key: 0, label: 'Metric', csv: (r) => r[0] }, { key: 1, label: 'Value', csv: (r) => r[1] }], rows); return; }
      out.appendChild(htmlCallout('<b>' + esc(div) + ' ' + esc(per) + '</b> · period from ' + fmt.date(start) + ' to ' + fmt.date(CRM.TODAY) + ' · ' + { DRM: 'daily progress, pending work, material issues, service calls and escalations', WRM: 'weekly progress, SLA compliance, delays and recovery plans', MRM: 'monthly objectives, project completion, service performance, PM and quality' }[per]));
      out.appendChild(h('div', { class: 'grid g2 mt' }, [
        ui.card('Summary', ui.dl(rows.map(([k, v]) => [k, /%/.test(k) ? fmt.pct(v) : String(v)]))),
        ui.card('Pending work & recovery plans', ui.table({ rows: open.slice().sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1)), search: false, pageSize: 8, onRow: (c) => CRM.go('complaints', c.id), columns: [{ key: 'id', label: 'Call', render: (c) => mono(c.id) }, { key: 'c', label: 'Customer', render: (c) => custName(c.customerId) }, { key: 'step', label: 'Stage', render: (c) => STEPS[c.step] }, { key: 'age', label: 'Ageing', render: (c) => dur(hrsSince(c.createdAt)) }, { key: 'rec', label: 'Recovery plan', render: (c) => { const v = db.one('violations', (x) => x.recId === c.id && x.correctiveAction); return v ? v.correctiveAction : c.commitAt ? 'Committed ' + fmt.dateTime(c.commitAt) : '—'; } }] }), { flush: true }),
        ui.card('Escalations & violations in period', vio.length ? ui.table({ rows: vio, search: false, pageSize: 8, onRow: (v) => openViolation(v.id), columns: [{ key: 'title', label: 'Violation' }, { key: 'owner', label: 'Owner', render: (v) => master.staffName(v.ownerId) }, { key: 'severity', label: 'Severity', render: (v) => ui.badge(v.severity, sevTone(v.severity)) }, { key: 'status', label: 'Status', render: (v) => ui.badge(v.status) }] }) : ui.empty('No violations in period'), { flush: true }),
      ]));
    }
    draw();
  }
  CRM.registerPage({
    id: 'svc-reports', title: 'Service Reports', icon: '📄', section: 'Service', order: 67, roles: ['service_coordinator', 'pm_coordinator', 'accounts', 'admin', 'gm', 'odm'],
    render(el) {
      ui.page(el, { title: 'Service, AMC, PM & Governance Reports', sub: 'Date, division, owner and customer filters · CSV export (Excel) · click a row to drill down to the record' });
      const C = cmpColumns();
      const cmpRow = (c) => CRM.go('complaints', c.id);
      const tabs = [
        { id: 'sla', label: 'Service SLA' }, { id: 'daily', label: 'Daily service' }, { id: 'resp', label: 'Response by priority' }, { id: 'res', label: 'Resolution product-wise' }, { id: 'commit', label: 'Commitment mismatch' }, { id: 'single', label: 'Single-visit closed' },
        { id: 'repeat', label: 'Repeat complaints' }, { id: 'eng', label: 'Engineer productivity' }, { id: 'rev', label: 'Revenue' }, { id: 'spare', label: 'Spare consumption' }, { id: 'pm', label: 'PM compliance' }, { id: 'wamc', label: 'Warranty / AMC' },
        { id: 'amcdue', label: 'AMC due / renewal' }, { id: 'vio', label: 'Policy violations' }, { id: 'eqr', label: 'Equipment register' }, { id: 'mgmt', label: 'DRM / WRM / MRM' }, { id: 'otsr', label: 'OTS' }, { id: 'grnr', label: 'Engineer-wise GRN' }, { id: 'brk', label: 'Breakdown reduction' },
      ];
      el.appendChild(ui.tabs(tabs, (t, body) => {
        const base = { rows: () => svcList(), dateOf: (c) => c.createdAt, ownerOf: (c) => c.engineerId, onRow: cmpRow, typeOf: (c) => c.callType, catOf: (c) => c.category };
        if (t === 'sla') reportView(body, Object.assign({}, base, { name: 'service_sla', columns: C.concat([{ key: 'ackMin', label: 'Ack (min)', render: (c) => (c.ackAt ? Math.round((new Date(c.ackAt) - new Date(c.createdAt)) / 6e4) : '—') }, { key: 'attH', label: 'Attend (h)', render: (c) => (c.attendedAt ? dur((new Date(c.attendedAt) - new Date(c.createdAt)) / HR) : '—') }, { key: 'resH', label: 'Resolve (h)', render: (c) => (c.resolvedAt ? dur((new Date(c.resolvedAt) - new Date(c.createdAt)) / HR) : '—') }]), summary: (rows) => { const m = metrics(rows); return sum2([['Calls', m.total], ['Ack SLA', fmt.pct(m.ackSla)], ['Attendance SLA', fmt.pct(m.attendanceSla)], ['Resolution SLA', fmt.pct(m.resolutionSla)], ['Open overdue', m.overdue, 'var(--bad)']]); } }));
        if (t === 'daily') reportView(body, Object.assign({}, base, { name: 'daily_service', days: 0, columns: C, summary: (rows) => sum2([['Received', rows.length], ['Attended', rows.filter((c) => c.attendedAt).length], ['Closed', rows.filter((c) => c.closedAt).length], ['Open', rows.filter(isOpen).length]]) }));
        if (t === 'resp') reportView(body, Object.assign({}, base, { name: 'response_time_by_priority', onRow: null, aggregate: (rows) => PRIORITIES.flatMap((p) => DIVS.map((d) => { const l = rows.filter((c) => c.priority === p && c.division === d); const m = metrics(l); return { p, d, n: l.length, ack: m.avgAckMin, att: m.avgAttendH, sla: m.attendanceSla }; })).filter((r) => r.n), columns: [{ key: 'p', label: 'Priority' }, { key: 'd', label: 'Division' }, { key: 'n', label: 'Calls', cls: 'right' }, { key: 'ack', label: 'Avg ack (min)', cls: 'right' }, { key: 'att', label: 'Avg response / attend (h)', cls: 'right' }, { key: 'sla', label: 'Within SLA', render: (r) => fmt.pct(r.sla) }] }));
        if (t === 'res') reportView(body, Object.assign({}, base, { name: 'resolution_time_product_wise', onRow: null, aggregate: (rows) => Object.entries(util.groupBy(rows.filter((c) => c.closedAt), (c) => c.systemType || 'Other')).map(([k, l]) => { const m = metrics(l); return { k, n: l.length, avg: m.avgCloseH, sla: m.resolutionSla, fvr: m.fvr }; }), columns: [{ key: 'k', label: 'Product / system' }, { key: 'n', label: 'Closed calls', cls: 'right' }, { key: 'avg', label: 'Avg resolution (h)', cls: 'right' }, { key: 'sla', label: 'Within SLA', render: (r) => fmt.pct(r.sla) }, { key: 'fvr', label: 'First-visit fix', render: (r) => fmt.pct(r.fvr) }] }));
        if (t === 'commit') reportView(body, Object.assign({}, base, { name: 'commitment_mismatch', rows: () => svcList().filter((c) => c.commitAt && c.attendedAt && new Date(c.attendedAt) > new Date(c.commitAt)), columns: C.slice(0, 7).concat([{ key: 'commitAt', label: 'Committed', render: (c) => fmt.dateTime(c.commitAt) }, { key: 'attendedAt', label: 'Attended', render: (c) => fmt.dateTime(c.attendedAt) }, { key: 'gap', label: 'Late by', render: (c) => dur((new Date(c.attendedAt) - new Date(c.commitAt)) / HR) }]) }));
        if (t === 'single') reportView(body, Object.assign({}, base, { name: 'single_visit_closed', rows: () => svcList().filter((c) => c.closedAt && (c.visits || 1) <= 1 && !c.reopenCount), columns: C }));
        if (t === 'repeat') reportView(body, Object.assign({}, base, { name: 'repeat_complaints', rows: () => svcList().filter((c) => c.repeatOf), columns: [{ key: 'id', label: 'Complaint', render: (c) => mono(c.id) }, { key: 'createdAt', label: 'Date', render: (c) => fmt.date(c.createdAt) }, { key: 'customerId', label: 'Customer', render: (c) => custName(c.customerId) }, { key: 'assetId', label: 'Affected equipment', render: (c) => (c.assetId ? c.assetId + ' · ' + c.productDetails : c.productDetails) }, { key: 'category', label: 'Failure' }, { key: 'repeatOf', label: 'Previous complaint', render: (c) => link('#/complaints/' + c.repeatOf, c.repeatOf) }, { key: 'gap', label: 'Days since previous', render: (c) => util.daysBetween((db.get('complaints', c.repeatOf) || {}).createdAt, c.createdAt) }, { key: 'actionTaken', label: 'Corrective action' }, { key: 'status', label: 'Status', render: (c) => ui.badge(c.status) }], summary: (rows) => sum2([['Repeat complaints', rows.length, 'var(--warn)'], ['Repeat %', fmt.pct(pctOf(rows.length, svcList().length))], ['Equipment affected', new Set(rows.map((c) => c.assetId)).size]]) }));
        if (t === 'eng') reportView(body, Object.assign({}, base, { name: 'engineer_productivity', onRow: null, aggregate: (rows) => master.staff('service_engineer').map((e) => { const l = rows.filter((c) => c.engineerId === e.id); const m = metrics(l); return { n: e.name, a: l.length, att: m.attended, cl: m.closed, avg: m.avgCloseH, sla: m.attendanceSla, rev: m.revenue }; }), columns: [{ key: 'n', label: 'Engineer' }, { key: 'a', label: 'Assigned', cls: 'right' }, { key: 'att', label: 'Attended', cls: 'right' }, { key: 'cl', label: 'Closed', cls: 'right' }, { key: 'avg', label: 'Avg close (h)', cls: 'right' }, { key: 'sla', label: 'SLA adherence', render: (r) => fmt.pct(r.sla) }, { key: 'rev', label: 'Revenue', cls: 'right', render: (r) => fmt.money(r.rev) }] }));
        if (t === 'rev') reportView(body, { name: 'service_revenue', noCustomer: true, noDivision: true, rows: () => months(6), columns: [{ key: 'label', label: 'Month', render: (m) => m.label + ' ' + m.key.slice(0, 4) }, { key: 's', label: 'Service charges collected', cls: 'right', render: (m) => fmt.money(util.sum(db.all('complaints').filter((c) => monthKey((c.payment || {}).receivedAt) === m.key), (c) => c.charges)) }, { key: 'o', label: 'OTS revenue', cls: 'right', render: (m) => fmt.money(util.sum(db.all('ots').filter((o) => o.status === 'Won' && monthKey(o.closedAt) === m.key), (o) => o.revenue)) }, { key: 'a', label: 'AMC contracts booked', cls: 'right', render: (m) => fmt.money(util.sum(db.all('amcContracts').filter((c) => c.oppId && monthKey(c.start) === m.key), (c) => c.value)) }] });
        if (t === 'spare') reportView(body, { name: 'spare_consumption', rows: () => db.all('spareRequests'), dateOf: (s) => s.requestedAt, ownerOf: (s) => s.requestedBy, onRow: (s) => CRM.go('complaints', s.complaintId), custOf: (s) => (db.get('complaints', s.complaintId) || {}).customerId, columns: [{ key: 'id', label: 'Request', render: (s) => mono(s.id) }, { key: 'complaintId', label: 'Complaint' }, { key: 'division', label: 'Division' }, { key: 'item', label: 'Spare' }, { key: 'qty', label: 'Qty', cls: 'right' }, { key: 'usedQty', label: 'Used', cls: 'right' }, { key: 'returnedQty', label: 'Returned', cls: 'right' }, { key: 'requestedBy', label: 'Engineer', render: (s) => master.staffName(s.requestedBy) }, { key: 'status', label: 'Status', render: (s) => ui.badge(s.status) }] });
        if (t === 'pm') reportView(body, { name: 'pm_compliance', rows: () => db.all('pmVisits').filter((v) => parseD(v.dueDate) <= util.addDays(CRM.TODAY, 30)), dateOf: (v) => v.dueDate, ahead: 30, ownerOf: (v) => v.engineerId, onRow: (v) => openPmVisit(v.id), columns: pmCols().concat([{ key: 'completedDate', label: 'Completed', render: (v) => fmt.date(v.completedDate) }, { key: 'ot', label: 'On time', render: (v) => (v.completedDate ? ui.badge(pmOnTime(v) ? 'Yes' : 'No') : '—') }, { key: 'findings', label: 'Findings' }]), summary: (rows) => { const due = rows.filter((v) => parseD(v.dueDate) <= CRM.TODAY); return sum2([['PM due', due.length], ['Completed', due.filter((v) => v.completedDate).length, 'var(--ok)'], ['Overdue', due.filter((v) => pmState(v) === 'Overdue').length, 'var(--bad)'], ['PM compliance', fmt.pct(pctOf(due.filter(pmOnTime).length, due.length))], ['With findings', rows.filter((v) => v.defects).length]]); } });
        if (t === 'wamc') reportView(body, { name: 'warranty_amc', rows: () => db.all('assets').map((a) => Object.assign({ cov: coverageOf(a) }, a)), dateOf: null, onRow: (a) => openAsset(a.id), columns: [{ key: 'id', label: 'Equipment', render: (a) => mono(a.id) }, { key: 'customerId', label: 'Customer', render: (a) => custName(a.customerId) }, { key: 'division', label: 'Division' }, { key: 'name', label: 'Product' }, { key: 'serial', label: 'Serial' }, { key: 'cov', label: 'Coverage', render: (a) => covBadge(a.cov.type), csv: (a) => a.cov.type }, { key: 'until', label: 'Expiry', render: (a) => fmt.date(a.cov.until), sort: (a) => a.cov.until }, { key: 'ren', label: 'Renewal / conversion', render: (a) => { const o = db.one('amcOpportunities', (x) => (x.assetIds || []).includes(a.id) && !['Lost'].includes(x.status)); return o ? o.id + ' · ' + o.status : '—'; } }, { key: 'claims', label: 'Warranty claims', cls: 'right', render: (a) => db.find('complaints', (c) => c.assetId === a.id && c.serviceType === 'Warranty').length }] });
        if (t === 'amcdue') reportView(body, { name: 'amc_due_renewal', rows: () => db.all('amcContracts').filter((c) => c.status !== 'Renewed'), dateOf: (c) => c.end, days: 45, ahead: 90, onRow: (c) => openContract(c.id), columns: [{ key: 'id', label: 'AMC', render: (c) => mono(c.id) }, { key: 'customerId', label: 'Customer', render: (c) => custName(c.customerId) }, { key: 'division', label: 'Division' }, { key: 'type', label: 'Type' }, { key: 'end', label: 'Expiry', render: (c) => fmt.date(c.end) }, { key: 'value', label: 'Value', cls: 'right', render: (c) => fmt.money(c.value) }, { key: 'opp', label: 'Renewal opportunity', render: (c) => { const o = db.one('amcOpportunities', (x) => x.contractId === c.id); return o ? o.id + ' · ' + o.status + (o.quote ? ' · quote ' + o.quote.status : ' · no quote') : 'None'; } }, { key: 'status', label: 'Status', render: (c) => ui.badge(c.status) }] });
        if (t === 'vio') reportView(body, { name: 'policy_violations', rows: () => db.all('violations').map((v) => Object.assign({ rec: repeatViolations(v) }, v)), dateOf: (v) => v.incidentAt, ownerOf: (v) => v.ownerId, onRow: (v) => openViolation(v.id), filters: [{ key: 'title', label: 'violation types (quotation delay, site visit delay, …)', options: [...new Set(db.all('violations').map((v) => v.title))] }, { key: 'area', label: 'departments', options: Object.keys(LADDER) }, { key: 'status', label: 'statuses', options: V_STATUS.concat(['Exception']) }], columns: vioCols().concat([{ key: 'rec', label: 'Recurrence', cls: 'right' }, { key: 'correctiveAction', label: 'Corrective action' }, { key: 'closureApprovedBy', label: 'Closure approval', render: (v) => master.staffName(v.closureApprovedBy) }]) });
        if (t === 'eqr') reportView(body, { name: 'equipment_register', rows: () => db.all('assets'), dateOf: (a) => a.installDate, days: 3650, onRow: (a) => openAsset(a.id), columns: [{ key: 'id', label: 'Equipment ID', render: (a) => mono(a.id) }, { key: 'customerId', label: 'Customer', render: (a) => custName(a.customerId) }, { key: 'siteId', label: 'Site' }, { key: 'projectId', label: 'Project / SO', render: (a) => a.projectId || a.soNumber || a.orderId || '—' }, { key: 'category', label: 'Category' }, { key: 'make', label: 'Make' }, { key: 'model', label: 'Model' }, { key: 'serial', label: 'Serial' }, { key: 'channel', label: 'Camera ID / channel' }, { key: 'installDate', label: 'Installed', render: (a) => fmt.date(a.installDate) }, { key: 'warrantyEnd', label: 'Warranty end', render: (a) => fmt.date(a.warrantyEnd) }, { key: 'status', label: 'Asset status' }] });
        if (t === 'mgmt') mgmtReport(body);
        if (t === 'grnr') grnReport(body);
        if (t === 'brk') body.appendChild(ui.card('Reduction in breakdown complaints (PM effect)', breakdownEffect()));
        if (t === 'otsr') reportView(body, { name: 'ots_report', rows: () => db.all('ots'), dateOf: (o) => o.createdAt, ownerOf: (o) => o.createdBy, divOf: (o) => o.division || 'Power', onRow: (o) => openOts(o.id), filters: [{ key: 'status', label: 'statuses', options: OTS_STATUS }, { key: 'otsType', label: 'types', options: ['Service OTS', 'Sales OTS'] }], columns: [{ key: 'id', label: 'OTS', render: (o) => mono(o.id) }, { key: 'createdAt', label: 'Date', render: (o) => fmt.date(o.createdAt) }, { key: 'customerId', label: 'Customer', render: (o) => custName(o.customerId) }, { key: 'otsType', label: 'Type' }, { key: 'createdBy', label: 'Engineer', render: (o) => master.staffName(o.createdBy) }, { key: 'assignedTo', label: 'Assigned', render: (o) => master.staffName(o.assignedTo) }, { key: 'value', label: 'Value', cls: 'right', render: (o) => fmt.money(o.value) }, { key: 'status', label: 'Status', render: (o) => ui.badge(o.status) }, { key: 'lostReason', label: 'Lost reason' }], summary: (rows) => sum2([['OTS', rows.length], ['Won', rows.filter((o) => o.status === 'Won').length, 'var(--ok)'], ['Lost', rows.filter((o) => o.status === 'Lost').length, 'var(--bad)'], ['Conversion', fmt.pct(pctOf(rows.filter((o) => o.status === 'Won').length, rows.filter((o) => ['Won', 'Lost'].includes(o.status)).length))]]) });
      }));
    },
  });

  // ---------------------------------------------------------------- Service configuration (SLA matrix, masters, settings)
  // SLA matrix + calendar + complaint-type SLA + reminders + scores — shared by the Service Configuration page and core "Settings & Rules"
  function slaConfigView(canEdit) {
    const c = cfg(); const wrap = h('div', { class: 'stack' });
    wrap.appendChild(h('div', { class: 'grid g3' }, DIVS.map((d) => ui.card(d + ' · ' + ((c.slaCalendar || {})[d] === 'business' ? 'business hours' : '24×7'), ui.table({ rows: PRIORITIES.map((p) => Object.assign({ p }, c.sla[d][p])), search: false, columns: [{ key: 'p', label: 'Priority', render: (r) => priBadge(r.p) }, { key: 'ack', label: 'Ack', render: (r) => Math.round(r.ack * 60) + ' min' }, { key: 'attend', label: 'Attend', render: (r) => r.attend + ' h' }, { key: 'resolve', label: 'Resolve', render: (r) => r.resolve + ' h' }], actions: (r) => (canEdit ? [ui.btn('Edit', () => ui.formModal('SLA · ' + d + ' · ' + r.p, [{ key: 'ack', label: 'Acknowledgement (hours)', type: 'number', step: 'any', required: true }, { key: 'attend', label: 'Attendance (hours)', type: 'number', step: 'any', required: true }, { key: 'resolve', label: 'Resolution (hours)', type: 'number', step: 'any', required: true }], r, (v) => { if (!(v.ack > 0 && v.attend > 0 && v.resolve > 0)) { ui.toast('SLA hours must be greater than 0', 'bad'); return false; } const sla = util.clone(cfg().sla); sla[d][r.p] = { ack: v.ack, attend: v.attend, resolve: v.resolve }; saveCfg({ sla }, 'SLA ' + d + ' ' + r.p); ui.toast('SLA updated', 'ok'); CRM.refresh(); }), 'sm')] : []) }), { flush: true }))));
    const wh = workHours();
    const calF = ui.form(DIVS.map((d) => ({ key: d, label: d + ' SLA calendar', type: 'select', options: [{ value: '24x7', label: '24×7 (clock hours)' }, { value: 'business', label: 'Business hours & holidays' }], required: true })), Object.assign({}, c.slaCalendar || {}));
    wrap.appendChild(ui.card('SLA calendar & pauses', h('div', { class: 'stack' }, [txtCallout('Business hours: ' + (wh.days || []).map((x) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x]).join(', ') + ' · ' + wh.start + '–' + wh.end + ' · ' + (cfgGet('holidays', []) || []).length + ' holidays (edit work hours & holidays under Settings & Rules). Attendance and resolution clocks pause while a call waits for the customer, spares or a vendor / supplier.'), calF, canEdit ? ui.btn('Save calendar', () => { if (!calF.validate()) return; saveCfg({ slaCalendar: calF.values() }, 'SLA calendar'); ui.toast('SLA calendar saved', 'ok'); CRM.refresh(); }, 'primary sm') : null])));
    const bt = (c.slaByType || {}).Solar || {};
    const typeRows = CATEGORIES.Solar.map((k) => ({ k, attend: (bt[k] || {}).attend, resolve: (bt[k] || {}).resolve }));
    wrap.appendChild(ui.card('Solar SLA by complaint type (overrides priority SLA when stricter)', ui.table({ rows: typeRows, search: false, pageSize: 20, columns: [{ key: 'k', label: 'Complaint type' }, { key: 'attend', label: 'Attend (h)', render: (r) => (r.attend ? r.attend + ' h' : 'priority SLA') }, { key: 'resolve', label: 'Resolve (h)', render: (r) => (r.resolve ? r.resolve + ' h' : 'priority SLA') }], actions: (r) => (canEdit ? [ui.btn('Edit', () => ui.formModal('Solar SLA · ' + r.k, [{ key: 'attend', label: 'Attendance (hours, blank = priority SLA)', type: 'number', step: 'any' }, { key: 'resolve', label: 'Resolution (hours, blank = priority SLA)', type: 'number', step: 'any' }], r, (v) => { const sb = util.clone(cfg().slaByType || {}); sb.Solar = sb.Solar || {}; if (!v.attend && !v.resolve) delete sb.Solar[r.k]; else sb.Solar[r.k] = clean({ attend: v.attend, resolve: v.resolve }); saveCfg({ slaByType: sb }, 'Solar SLA ' + r.k); ui.toast('Saved', 'ok'); CRM.refresh(); }), 'sm')] : []) }), { flush: true }));
    const chans = c.customerChannels || {}; const rd = c.reminderDays || {}; const pen = c.penalty || {};
    const rf = ui.form([
      { type: 'section', label: 'Customer reminders (Email / WhatsApp delivery is simulated — integration hook: customer.message event)' },
      { key: 'amcDays', label: 'AMC renewal reminder days before expiry', required: true, hint: 'comma separated, e.g. 60, 30' }, { key: 'wtyDays', label: 'Warranty expiry reminder days', required: true },
      { key: 'amcEmail', label: 'AMC renewal → Email', type: 'checkbox' }, { key: 'amcWa', label: 'AMC renewal → WhatsApp', type: 'checkbox' }, { key: 'amcSms', label: 'AMC renewal → SMS', type: 'checkbox' },
      { key: 'wtyEmail', label: 'Warranty expiry → Email', type: 'checkbox' }, { key: 'wtyWa', label: 'Warranty expiry → WhatsApp', type: 'checkbox' }, { key: 'wtySms', label: 'Warranty expiry → SMS', type: 'checkbox' },
      { type: 'section', label: 'AMC, PM, OTS & observation' },
      { key: 'visits', label: 'AMC PM visits per year (all divisions)', type: 'number', required: true }, { key: 'obs', label: 'Default observation window (h)', type: 'number', required: true },
      { key: 'otsTh', label: 'OTS battery threshold (≤ → Service OTS)', type: 'number', required: true }, { key: 'otsNb', label: 'Non-battery OTS goes to', type: 'select', options: ['Sales OTS', 'Service OTS'], required: true },
      { type: 'section', label: 'Score penalties per violation' },
      { key: 'pE', label: 'Engineer', type: 'number', step: 'any', required: true }, { key: 'pC', label: 'Coordinator', type: 'number', step: 'any', required: true }, { key: 'pS', label: 'Sales executive', type: 'number', step: 'any', required: true }, { key: 'pD', label: 'Department', type: 'number', step: 'any', required: true },
    ], { amcDays: (rd.amc || [60, 30]).join(', '), wtyDays: (rd.warranty || [90, 30]).join(', '), amcEmail: (chans.amcRenewal || []).includes('Email'), amcWa: (chans.amcRenewal || []).includes('WhatsApp'), amcSms: (chans.amcRenewal || []).includes('SMS'), wtyEmail: (chans.warrantyExpiry || []).includes('Email'), wtyWa: (chans.warrantyExpiry || []).includes('WhatsApp'), wtySms: (chans.warrantyExpiry || []).includes('SMS'), visits: amcVisits(), obs: c.observationHours || 24, otsTh: c.otsBatteryThreshold || 2, otsNb: c.otsNonBattery || 'Sales OTS', pE: pen.engineer != null ? pen.engineer : 1.5, pC: pen.coordinator || 2, pS: pen.sales || 3, pD: pen.department || 2 });
    wrap.appendChild(ui.card('Reminders, AMC/PM, OTS and score rules', h('div', { class: 'stack' }, [rf, canEdit ? ui.btn('Save rules', () => {
      if (!rf.validate()) return; const v = rf.values();
      const days = (x) => String(x).split(',').map((n) => Number(n.trim())).filter((n) => n > 0);
      if (!days(v.amcDays).length || !days(v.wtyDays).length) { ui.toast('Enter reminder days, e.g. 60, 30', 'bad'); return; }
      const ch = (e, w, sm) => [e ? 'Email' : null, w ? 'WhatsApp' : null, sm ? 'SMS' : null].filter(Boolean);
      saveCfg({ reminderDays: { amc: days(v.amcDays), warranty: days(v.wtyDays) }, customerChannels: { amcRenewal: ch(v.amcEmail, v.amcWa, v.amcSms), warrantyExpiry: ch(v.wtyEmail, v.wtyWa, v.wtySms) }, amcPmVisitsPerYear: Math.max(1, Math.min(12, v.visits)), observationHours: v.obs, otsBatteryThreshold: v.otsTh, otsNonBattery: v.otsNb, penalty: { engineer: v.pE, coordinator: v.pC, sales: v.pS, department: v.pD } }, 'Service rules');
      ui.toast('Rules saved', 'ok'); CRM.refresh();
    }, 'primary sm') : null])));
    return wrap;
  }
  CRM.registerPage({
    id: 'svc-config', title: 'Service Configuration', icon: '⚙', section: 'Service', order: 69, roles: ['admin', 'gm', 'service_coordinator', 'odm'],
    render(el) {
      const c = cfg(); const canEdit = roleIs('admin');
      ui.page(el, { title: 'Service Configuration', sub: 'Division-specific SLA matrix (single source of truth), business-hours calendar, Solar complaint-type SLA, escalation ladder, call-type and category masters, PM frequencies, AMC pricing, OTS & reminder rules' + (canEdit ? '' : ' · read-only for your role') });
      el.appendChild(ui.tabs([{ id: 'sla', label: 'SLA, calendar & rules' }, { id: 'lad', label: 'Escalation ladder' }, { id: 'm', label: 'Masters' }, { id: 'g', label: 'General settings' }], (t, body) => {
        if (t === 'sla') body.appendChild(slaConfigView(canEdit));
        if (t === 'lad') body.appendChild(ui.card('Five-level escalation ladder (roles per level)', ladderView(roleIs('admin', 'odm')), { flush: true }));
        if (t === 'm') body.appendChild(h('div', { class: 'grid g3' }, DIVS.map((d) => ui.card(d, h('div', { class: 'stack', style: 'gap:8px' }, [h('div', {}, [h('b', {}, 'Call types: '), CALL_TYPES[d].map(callTypeLabel).join(' · ')]), h('div', {}, [h('b', {}, 'System types: '), SYSTEM_TYPES[d].join(' · ')]), h('div', {}, [h('b', {}, 'Complaint categories:'), h('ul', { style: 'margin:4px 0;padding-left:18px' }, CATEGORIES[d].map((x) => h('li', { class: 'small' }, x + (SAFETY_CATS.includes(x) ? ' 🔥' : ''))))])]))).concat([ui.card('Common masters', ui.dl([['Service types', SERVICE_TYPES.join(' · ')], ['Priorities', 'Critical (safety) · High · Low'], ['Complaint sources', SOURCES.join(' · ')], ['Open-call sub-categories', OPEN_SUBS.join(' · ')], ['SLA pauses on', PAUSE_SUBS.join(' · ')], ['Main call status', 'Open · In Progress · Waiting · Closed'], ['Call-type reconciliation', '§2.2 Breakdown = §9 Service (shown as “Service / Breakdown”); Inspection added']]))])));
        if (t === 'g') {
          const f = ui.form([{ key: 'repeatWindowDays', label: 'Repeat complaint window (days)', type: 'number', required: true }, { key: 'negativeRating', label: 'Negative feedback threshold (≤ rating)', type: 'number', required: true }, { key: 'creditDays', label: 'Default customer credit days', type: 'number', required: true }, { key: 'pmGraceDays', label: 'PM due window (days)', type: 'number', required: true }, { key: 'discountLimit', label: 'Discount limit without approval (%)', type: 'number', required: true }, { key: 'amcTargetMonthly', label: 'Monthly AMC revenue target ₹', type: 'number', required: true }, { key: 'pmPower', label: 'Warranty PM frequency — Power (months)', type: 'number', required: true }, { key: 'pmES', label: 'Warranty PM frequency — Electronic Security (months)', type: 'number', required: true }, { key: 'pmSolar', label: 'Warranty PM frequency — Solar (months)', type: 'number', required: true }, { key: 'servicePct', label: 'Service OTS incentive %', type: 'number', step: 'any', required: true }, { key: 'salesPct', label: 'Sales OTS incentive %', type: 'number', step: 'any', required: true }, { key: 'sharedSplit', label: 'Shared OTS split — creator share %', type: 'number', required: true }, { key: 'compPct', label: 'AMC pricing — Comprehensive % of equipment value', type: 'number', required: true }, { key: 'nonPct', label: 'AMC pricing — Non-Comprehensive %', type: 'number', required: true }], { repeatWindowDays: c.repeatWindowDays, negativeRating: c.negativeRating, creditDays: c.creditDays, pmGraceDays: c.pmGraceDays, discountLimit: c.discountLimit, amcTargetMonthly: c.amcTargetMonthly, pmPower: c.pmFrequency.Power, pmES: c.pmFrequency['Electronic Security'], pmSolar: c.pmFrequency.Solar, servicePct: c.otsIncentive.servicePct, salesPct: c.otsIncentive.salesPct, sharedSplit: c.otsIncentive.sharedSplit, compPct: c.amcPricing.Comprehensive.pct, nonPct: c.amcPricing['Non-Comprehensive'].pct });
          const eqF = ui.form(EQ_TYPES.map((t2) => ({ key: t2, label: t2 + ' PM frequency (months, blank = division)', type: 'number' })), Object.assign({}, c.pmFrequencyEq || {}));
          body.appendChild(ui.card('General service settings', h('div', { class: 'stack' }, [f, h('h3', {}, 'PM frequency by equipment type (warranty PM plans)'), eqF, canEdit ? h('div', {}, ui.btn('Save settings', () => { if (!f.validate()) return; const v = f.values(); const ev = eqF.values(); const eqm = {}; Object.keys(ev).forEach((k) => { if (ev[k] > 0) eqm[k] = ev[k]; }); const pr = util.clone(c.amcPricing); pr.Comprehensive.pct = v.compPct; pr['Non-Comprehensive'].pct = v.nonPct; saveCfg({ repeatWindowDays: v.repeatWindowDays, negativeRating: v.negativeRating, creditDays: v.creditDays, pmGraceDays: v.pmGraceDays, discountLimit: v.discountLimit, amcTargetMonthly: v.amcTargetMonthly, pmFrequency: { Power: v.pmPower, 'Electronic Security': v.pmES, Solar: v.pmSolar }, pmFrequencyEq: eqm, otsIncentive: Object.assign({}, c.otsIncentive, { servicePct: v.servicePct, salesPct: v.salesPct, sharedSplit: Math.max(0, Math.min(100, v.sharedSplit)) }), amcPricing: pr }, 'General settings'); ui.toast('Settings saved', 'ok'); }, 'primary')) : null])));
        }
      }));
    },
  });
  if (CRM.registerConfigSection) {
    safe(() => CRM.registerConfigSection({ id: 'service-sla', title: 'Service SLA matrix, calendar & reminders', roles: ['admin', 'odm', 'gm'], render(container) { container.appendChild(slaConfigView(roleIs('admin', 'odm'))); } }), null);
    safe(() => CRM.registerConfigSection({ id: 'service-escalation', title: 'Escalation ladder (5 levels)', roles: ['admin', 'odm', 'gm'], render(container) { container.appendChild(ladderView(roleIs('admin', 'odm'))); } }), null);
  }

  // ---------------------------------------------------------------- Engineer-wise GRN report (GRN §11)
  function grnReport(body) {
    reportView(body, { name: 'engineer_wise_grn', noDivision: true, rows: () => grnMetrics().svcG, dateOf: (g) => g.createdAt, ownerOf: (g) => g.collectedBy, aggregate: (rows) => {
      const open = grnMetrics().deliveredOpen.map((g) => g.id);
      return Object.entries(util.groupBy(rows, (g) => g.collectedBy || '—')).map(([k, l]) => ({ n: master.staffName(k), t: l.length, pi: l.filter((g) => g.status === 'Pending Inward').length, us: l.filter((g) => ['Inward Created', 'Under Service'].includes(g.status)).length, rd: l.filter((g) => g.status === 'Ready for Dispatch').length, dl: l.filter((g) => g.status === 'Delivered').length, dpc: l.filter((g) => open.includes(g.id)).length, lk: pctOf(l.filter((g) => g.complaintId && db.get('complaints', g.complaintId)).length, l.length) }));
    }, columns: [{ key: 'n', label: 'Engineer (collected by)' }, { key: 't', label: 'GRNs', cls: 'right' }, { key: 'pi', label: 'Pending inward', cls: 'right' }, { key: 'us', label: 'Inward / under service', cls: 'right' }, { key: 'rd', label: 'Ready for dispatch', cls: 'right' }, { key: 'dl', label: 'Delivered', cls: 'right' }, { key: 'dpc', label: 'Delivered — call open', cls: 'right' }, { key: 'lk', label: 'Linked to complaint', render: (r) => fmt.pct(r.lk), csv: (r) => r.lk }] });
  }

  // ---------------------------------------------------------------- Service Centre workbench (Case 1 · Service Centre Technician)
  if (CRM.registerRole && !(CRM.roles || []).some((r) => r.id === 'service_centre_tech')) safe(() => CRM.registerRole({ id: 'service_centre_tech', name: 'Service Centre Technician', group: 'Service', user: 'Service Centre Technician', color: '#5C6066' }), null);
  CRM.registerPage({
    id: 'svc-centre', title: 'Service Centre', icon: '🔧', section: 'Service', order: 64.5, roles: ['service_centre_tech', 'service_coordinator', 'service_engineer', 'stores', 'admin', 'gm', 'odm'],
    badge: () => (roleIs('service_centre_tech') ? db.all('complaints').filter((c) => isOpen(c) && c.serviceCentre).length : 0),
    render(el) {
      let jobs = db.all('complaints').filter((c) => c.serviceCentre && c.status !== 'Cancelled');
      if (roleIs('service_engineer')) jobs = jobs.filter((c) => c.engineerId === me());
      jobs.forEach((c) => { const g = grnFor(c); if (g && isOpen(c) && syncNeeded(c, g)) safe(() => syncScFromGrn(c, g), null); });
      const open = jobs.filter(isOpen); const gm = grnMetrics();
      const stName = (c) => scStages(c)[c.serviceCentre.stage];
      ui.page(el, { title: 'Service Centre Workbench', sub: 'Case 1 — product shifted to the service centre: inward (GRN) → processing → testing → quotation & customer approval (chargeable) → repair → outward delivery → payment · stages synced with the Service GRN' });
      el.appendChild(ui.kpis([
        { label: 'Jobs in service centre', value: open.length, color: 'var(--chart-1)' },
        { label: 'Awaiting quotation / approval', value: open.filter((c) => ['Quotation', 'Customer approval'].includes(scStages(c)[c.serviceCentre.stage + 1])).length, color: 'var(--warn)' },
        { label: 'Repair done · to deliver', value: open.filter((c) => stName(c) === 'Repair').length, color: 'var(--chart-5)' },
        { label: 'Delivered pending closure', value: gm.deliveredOpen.length + open.filter((c) => stName(c) === 'Delivered' || stName(c) === 'Payment received').length, color: 'var(--bad)' },
        { label: 'Missing GRN', value: gm.missing.length, color: 'var(--bad)' },
        { label: 'Service GRN pending inward', value: gm.pendingInward.length, color: 'var(--chart-4)', onClick: () => CRM.canSee('grn') && CRM.go('grn') },
      ]));
      const cols = [{ key: 'id', label: 'Complaint', render: (c) => mono(c.id) }, { key: 'customerId', label: 'Customer', render: (c) => custName(c.customerId), csv: (c) => custName(c.customerId) }, { key: 'productDetails', label: 'Product', render: (c) => (c.productDetails || '') + (c.serial ? ' · ' + c.serial : '') }, { key: 'grn', label: 'GRN', render: (c) => { const g = grnFor(c); return g ? h('span', {}, [mono(g.id), ' ', ui.badge(g.status, g.status === 'Delivered' ? 'ok' : 'info')]) : ui.badge('Missing', 'bad'); }, csv: (c) => (grnFor(c) || {}).id || 'Missing' }, { key: 'stage', label: 'Stage', render: (c) => ui.badge(stName(c), 'brand'), csv: stName }, { key: 'quote', label: 'Quotation / approval', render: (c) => { const sc = c.serviceCentre; return c.chargeable ? (sc.quote ? fmt.money(sc.quote.amount) + ' · ' + ((sc.approval || {}).status || 'awaiting customer') : 'Not quoted') : 'Warranty / AMC (free)'; } }, { key: 'age', label: 'In centre', render: (c) => dur(hrsSince(c.serviceCentre.inwardAt)), sort: (c) => c.serviceCentre.inwardAt }, { key: 'engineerId', label: 'Engineer', render: (c) => master.staffName(c.engineerId) }, { key: 'status', label: 'Call', render: (c) => ui.badge(c.status) }];
      el.appendChild(ui.tabs([{ id: 'q', label: 'Workbench', count: open.length }, { id: 'a', label: 'All jobs', count: jobs.length }, { id: 'g', label: 'Engineer-wise GRN' }], (t, body) => {
        if (t === 'q' || t === 'a') body.appendChild(ui.card(null, ui.table({ rows: (t === 'q' ? open : jobs).slice().sort((a, b) => (a.serviceCentre.inwardAt > b.serviceCentre.inwardAt ? 1 : -1)), columns: cols, onRow: (c) => CRM.go('complaints', c.id), actions: (c) => (isOpen(c) && canSC(c) && c.serviceCentre.stage < scStages(c).length - 1 ? [ui.btn('→ ' + scStages(c)[c.serviceCentre.stage + 1], () => scAdvance(c), 'sm primary')] : []), toolbar: [ui.btn('Export CSV', () => exportCSV('service_centre_jobs', cols, t === 'q' ? open : jobs), 'sm')] }), { flush: true }));
        if (t === 'g') grnReport(body);
      }));
    },
  });
  CRM.registerHome('service_centre_tech', (el) => {
    const open = db.all('complaints').filter((c) => isOpen(c) && c.serviceCentre); const gm = grnMetrics();
    el.appendChild(ui.hero(CRM.role(), [open.length + ' jobs in the service centre', gm.pendingInward.length + ' GRNs pending inward', gm.missing.length + ' missing GRN']));
    el.appendChild(h('div', { class: 'grid g2' }, [
      ui.card('Jobs to work on', taskList(open.map((c) => ({ title: c.id + ' · ' + custName(c.customerId), sub: (c.productDetails || '') + ' · next: ' + (scStages(c)[c.serviceCentre.stage + 1] || 'close'), badge: ui.badge(scStages(c)[c.serviceCentre.stage], 'brand'), link: '#/complaints/' + c.id })), 'No jobs in the service centre')),
      qa([['Service centre workbench', () => CRM.go('svc-centre'), 'primary'], CRM.canSee('grn') ? ['GRN register', () => CRM.go('grn')] : null]),
    ]));
  });

  // ---------------------------------------------------------------- Installations (Install doc §3–§9): dashboard, record and 5 reports
  const instList = () => db.all('complaints').filter((c) => c.callType === 'Installation' && c.status !== 'Cancelled');
  CRM.registerPage({
    id: 'installations', title: 'Installations', icon: '🧰', section: 'Service', order: 68, roles: ['service_coordinator', 'service_engineer', 'accounts', 'sales_coordinator', 'sales_manager', 'admin', 'gm', 'odm'],
    badge: () => (roleIs('service_coordinator') ? instList().filter((c) => !c.engineerId && isOpen(c)).length : 0),
    render(el) {
      let all = instList(); if (roleIs('service_engineer')) all = all.filter((c) => c.engineerId === me());
      const done = all.filter((c) => c.installedAt); const pend = all.filter((c) => !c.installedAt);
      const payPend = done.filter((c) => (c.instPayment || {}).status !== 'Received');
      const thrH = thr(rule('INS-DLY') || {}, 24);
      ui.page(el, { title: 'Installation Dashboard', sub: 'Auto-created from the Sales Order · one installation record per SO (status, payment, battery, scrap, DC & invoice) synced to Sales through installation.updated / installation.completed', actions: [pdfBtn('Installation Dashboard', () => el)] });
      el.appendChild(ui.kpis([
        { label: 'Total installations', value: all.length }, { label: 'Pending', value: pend.length, meta: pend.filter((c) => !c.engineerId).length + ' unassigned', color: 'var(--warn)' },
        { label: 'Completed', value: done.length, meta: fmt.pct(pctOf(done.filter((c) => (new Date(c.installedAt) - new Date(c.createdAt)) / HR <= thrH).length, done.length)) + ' within ' + thrH + 'h', color: 'var(--ok)' },
        { label: 'Payment pending', value: payPend.length, meta: fmt.money(util.sum(payPend, (c) => (c.instPayment || {}).balance != null ? c.instPayment.balance : c.billValue)), color: 'var(--bad)' },
        { label: 'Scrap collected', value: util.sum(all.filter((c) => c.scrapCollectedAt || c.scrapId), (c) => Number(c.scrapQty) || 1), meta: all.filter((c) => c.scrapApplicable && c.installedAt && !c.scrapCollectedAt && !c.scrapId).length + ' pending', color: 'var(--chart-4)' },
      ]));
      const cols = [{ key: 'id', label: 'Installation', render: (c) => mono(c.id) }, { key: 'soNumber', label: 'SO', render: (c) => c.soNumber || c.orderId || '—' }, { key: 'createdAt', label: 'Created', render: (c) => fmt.date(c.createdAt), sort: (c) => c.createdAt }, { key: 'customerId', label: 'Customer', render: (c) => custName(c.customerId), csv: (c) => custName(c.customerId) }, { key: 'productDetails', label: 'Product' }, { key: 'billValue', label: 'Bill value', cls: 'right', render: (c) => fmt.money(c.billValue) }, { key: 'engineerId', label: 'Engineer', render: (c) => (c.engineerId ? master.staffName(c.engineerId) : ui.badge('Unassigned', 'warn')), csv: (c) => master.staffName(c.engineerId) }, { key: 'ist', label: 'Status', render: (c) => ui.badge(installStatus(c), installStatus(c) === 'Pending' ? 'warn' : ['Completed', 'Closed'].includes(installStatus(c)) ? 'ok' : 'info'), csv: installStatus }, { key: 'pay', label: 'Payment', render: (c) => ((c.instPayment || {}).mode || '—') + ' · ' + ((c.instPayment || {}).status || 'Pending') }, { key: 'scr', label: 'Scrap', render: (c) => (c.scrapApplicable ? (c.scrapQty || 0) + ' × ' + (c.scrapType || '') + (c.scrapId || c.scrapCollectedAt ? ' ✓' : ' · pending') : '—') }, { key: 'docs', label: 'DC / invoice', render: (c) => { const d = installDocs(c); return (d.dc || '—') + ' / ' + (d.invoice || '—'); } }];
      const engRows = (rows) => master.staff('service_engineer').map((e) => { const l = rows.filter((c) => c.engineerId === e.id); const d = l.filter((c) => c.installedAt); return { n: e.name, a: l.length, d: d.length, ot: pctOf(d.filter((c) => (new Date(c.installedAt) - new Date(c.createdAt)) / HR <= thrH).length, d.length), pay: pctOf(d.filter((c) => (c.instPayment || {}).status === 'Received').length, d.length), scr: pctOf(d.filter((c) => !c.scrapApplicable || c.scrapId || c.scrapCollectedAt).length, d.length) }; }).filter((r) => r.a);
      const iBase = { rows: () => all, dateOf: (c) => c.createdAt, ownerOf: (c) => c.engineerId, onRow: (c) => CRM.go('complaints', c.id) };
      el.appendChild(ui.tabs([{ id: 'l', label: 'All installations', count: all.length }, { id: 'r1', label: 'Daily installation report' }, { id: 'r2', label: 'Pending installation report' }, { id: 'r3', label: 'Payment collection report' }, { id: 'r4', label: 'Scrap from installation' }, { id: 'r5', label: 'Engineer-wise installation' }], (t, body) => {
        if (t === 'l') body.appendChild(ui.card(null, ui.table({ rows: all.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)), columns: cols, onRow: (c) => CRM.go('complaints', c.id), filters: [{ key: 'division', label: 'divisions', options: DIVS }] }), { flush: true }));
        if (t === 'r1') reportView(body, Object.assign({}, iBase, { name: 'daily_installation', days: 0, dateOf: (c) => c.installedAt || c.createdAt, columns: cols, summary: (rows) => sum2([['Installations', rows.length], ['Completed', rows.filter((c) => c.installedAt).length, 'var(--ok)'], ['Pending', rows.filter((c) => !c.installedAt).length, 'var(--warn)']]) }));
        if (t === 'r2') reportView(body, Object.assign({}, iBase, { name: 'pending_installation', days: 120, rows: () => all.filter((c) => !c.installedAt), columns: cols.concat([{ key: 'age', label: 'Pending for', render: (c) => ui.badge(dur(hrsSince(c.createdAt)), hrsSince(c.createdAt) > thrH ? 'bad' : 'warn'), sort: (c) => c.createdAt }]) }));
        if (t === 'r3') reportView(body, Object.assign({}, iBase, { name: 'installation_payment_collection', days: 180, rows: () => all.filter((c) => c.installedAt), dateOf: (c) => c.installedAt, columns: [cols[0], cols[1], cols[3], cols[5], { key: 'mode', label: 'Mode', render: (c) => (c.instPayment || {}).mode || '—' }, { key: 'st', label: 'Status', render: (c) => ui.badge((c.instPayment || {}).status || 'Pending', (c.instPayment || {}).status === 'Received' ? 'ok' : 'warn') }, { key: 'amt', label: 'Collected', cls: 'right', render: (c) => fmt.money((c.instPayment || {}).amount) }, { key: 'bal', label: 'Balance', cls: 'right', render: (c) => fmt.money((c.instPayment || {}).balance != null ? c.instPayment.balance : (Number(c.billValue) || 0) - (Number((c.instPayment || {}).amount) || 0)) }, { key: 'dt', label: 'Payment date', render: (c) => fmt.date((c.instPayment || {}).date) }], summary: (rows) => sum2([['Billed', fmt.money(util.sum(rows, 'billValue'))], ['Collected', fmt.money(util.sum(rows, (c) => (c.instPayment || {}).amount)), 'var(--ok)'], ['Collection efficiency', fmt.pct(pctOf(rows.filter((c) => (c.instPayment || {}).status === 'Received').length, rows.length))]]) }));
        if (t === 'r4') reportView(body, Object.assign({}, iBase, { name: 'scrap_from_installation', days: 180, rows: () => all.filter((c) => c.scrapApplicable), columns: [cols[0], cols[1], cols[3], { key: 'type', label: 'Scrap type', render: (c) => c.scrapType || '—' }, { key: 'qty', label: 'Qty', cls: 'right', render: (c) => c.scrapQty || 0 }, { key: 'ent', label: 'Scrap entry', render: (c) => c.scrapId || ((scrapFor(c)[0] || {}).id) || ui.badge('Not created', 'bad'), csv: (c) => c.scrapId || '' }, { key: 'col', label: 'Collected', render: (c) => fmt.date(c.scrapCollectedAt) }], summary: (rows) => sum2([['Scrap-applicable installations', rows.length], ['Scrap collected (qty)', util.sum(rows.filter((c) => c.scrapCollectedAt || c.scrapId), (c) => Number(c.scrapQty) || 0), 'var(--ok)'], ['Pending', rows.filter((c) => !c.scrapCollectedAt && !c.scrapId).length, 'var(--bad)']]) }));
        if (t === 'r5') reportView(body, Object.assign({}, iBase, { name: 'engineer_wise_installation', onRow: null, aggregate: engRows, columns: [{ key: 'n', label: 'Engineer' }, { key: 'a', label: 'Assigned', cls: 'right' }, { key: 'd', label: 'Completed', cls: 'right' }, { key: 'ot', label: 'On-time %', render: (r) => fmt.pct(r.ot) }, { key: 'pay', label: 'Payment efficiency', render: (r) => fmt.pct(r.pay) }, { key: 'scr', label: 'Scrap accuracy', render: (r) => fmt.pct(r.scr) }] }));
      }));
    },
  });

  // ================================================================ Role homes
  const qa = (items) => ui.card('Quick actions', h('div', { class: 'row' }, items.filter(Boolean).map(([l, fn, cls]) => ui.btn(l, fn, cls || ''))));
  function taskList(rows, empty) {
    if (!rows.length) return ui.empty(empty || 'Nothing pending', '✅');
    return h('div', { class: 'stack', style: 'gap:6px' }, rows.slice(0, 10).map((r) => h('a', { href: r.link, class: 'row', style: 'justify-content:space-between;border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text)' }, [h('div', {}, [h('b', {}, r.title), h('div', { class: 'small muted' }, r.sub)]), r.badge])));
  }
  CRM.registerHome('service_coordinator', (el) => {
    const all = svcList(); const open = all.filter(isOpen); const m = metrics(all.filter((c) => util.daysBetween(c.createdAt, CRM.TODAY) <= 30));
    const risk = open.filter((c) => ['At risk'].includes(slaState(c, c.attendedAt ? 'resolve' : 'attend')));
    el.appendChild(ui.hero(CRM.role(), [open.length + ' open calls', open.filter((c) => c.step === 1).length + ' awaiting acknowledgement', open.filter(overdue).length + ' SLA breached']));
    el.appendChild(ui.kpis([
      { label: 'Ack pending', value: open.filter((c) => c.step === 1).length, meta: open.filter((c) => c.step === 1 && slaState(c, 'ack') === 'Breached').length + ' beyond ack SLA', color: 'var(--bad)', onClick: () => CRM.go('complaints') },
      { label: 'Unassigned', value: open.filter((c) => !c.engineerId).length, color: 'var(--warn)', onClick: () => CRM.go('complaints') },
      { label: 'SLA at risk / breached', value: risk.length + ' / ' + open.filter(overdue).length, color: 'var(--bad)' },
      { label: 'Attended but open > 36h', value: open.filter((c) => c.attendedAt && hrsSince(c.attendedAt) > 36).length, color: 'var(--chart-4)' },
      { label: 'Spares to approve', value: db.all('spareRequests').filter((s) => s.status === 'Requested').length, onClick: () => CRM.go('spares') },
      { label: 'Attendance SLA (30d)', value: fmt.pct(m.attendanceSla), meta: 'Resolution ' + fmt.pct(m.resolutionSla), color: m.attendanceSla >= 95 ? 'var(--ok)' : 'var(--warn)' },
      { label: 'Repeat complaints (30d)', value: fmt.pct(m.repeatPct), color: 'var(--chart-4)' },
    ]));
    const tasks = [];
    open.filter((c) => c.step === 1).forEach((c) => tasks.push({ title: 'Acknowledge ' + c.id + ' · ' + custName(c.customerId), sub: c.category + ' · ' + c.priority + ' · registered ' + dur(hrsSince(c.createdAt)) + ' ago', badge: slaBadge(c, 'ack'), link: '#/complaints/' + c.id }));
    open.filter((c) => c.step === 2 || c.step === 3).forEach((c) => tasks.push({ title: (c.step === 2 ? 'Validate ' : 'Assign engineer · ') + c.id, sub: custName(c.customerId) + ' · ' + c.category, badge: slaBadge(c, 'attend'), link: '#/complaints/' + c.id }));
    open.filter((c) => c.step === 9).forEach((c) => tasks.push({ title: 'Close ' + c.id + (needsApproval(c) && !c.closureApprovedBy ? ' (approval needed)' : ''), sub: custName(c.customerId) + ' · report ' + (c.serviceReportNo || ''), badge: ui.badge('Closure', 'violet'), link: '#/complaints/' + c.id }));
    risk.forEach((c) => tasks.push({ title: 'SLA at risk ' + c.id, sub: master.staffName(c.engineerId) + ' · ' + custName(c.customerId), badge: ui.badge('At risk', 'warn'), link: '#/complaints/' + c.id }));
    const commits = open.filter((c) => c.commitAt && util.iso(c.commitAt) === util.iso(CRM.TODAY) && !c.attendedAt);
    el.appendChild(h('div', { class: 'grid g3' }, [
      h('div', { class: 'span2' }, ui.card('Action now (' + tasks.length + ')', taskList(tasks, 'Queue is clear'))),
      ui.card("Today's customer commitments", commits.length ? h('div', { class: 'stack', style: 'gap:6px' }, commits.map((c) => h('div', { class: 'small' }, [link('#/complaints/' + c.id, c.id), ' · ' + fmtTime(c.commitAt) + ' · ' + master.staffName(c.engineerId) + ' · ' + custName(c.customerId)]))) : ui.empty('No commitments today', '⏰')),
      ui.card('Engineer workload', ui.hbars(master.staff('service_engineer').map((e) => ({ label: e.name, value: openLoad(e.id), color: 'var(--chart-1)', text: openLoad(e.id) + ' open · ' + engProfile(e.id).availability })))),
      ui.card('Open calls by division', ui.donut(DIVS.map((d) => ({ label: d, value: open.filter((c) => c.division === d).length, color: DIV_COLOR[d] })), { label: 'open' })),
      qa([['+ Register complaint', () => openNewComplaint(), 'primary'], ['Live queue', () => CRM.go('complaints')], ['Spares approvals', () => CRM.go('spares')], ['Engineer mobile view', () => CRM.go('svc-mobile')], ['Run SLA check', () => { runSlaAlerts(); const n = evaluatePolicies(); ui.toast('SLA check done · ' + n + ' new violations', 'ok'); CRM.refresh(); }]]),
    ]));
  });

  CRM.registerHome('service_engineer', (el) => {
    const mine = db.all('complaints').filter((c) => c.engineerId === me());
    const open = mine.filter(isOpen); const sc = engScore(me(), 30);
    const pms = db.all('pmVisits').filter((v) => v.engineerId === me() && !v.completedDate && util.daysBetween(CRM.TODAY, v.dueDate) <= 14).sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1));
    el.appendChild(ui.hero(CRM.role(), [open.length + ' open calls', open.filter((c) => !c.attendedAt).length + ' to attend', pms.length + ' PM visits in 14 days']));
    el.appendChild(ui.kpis([
      { label: 'My open calls', value: open.length, onClick: () => CRM.go('complaints') }, { label: 'To attend', value: open.filter((c) => !c.attendedAt && c.engineerId).length, meta: open.filter((c) => !c.attendedAt && slaState(c, 'attend') === 'Breached').length + ' beyond SLA', color: 'var(--bad)' },
      { label: 'Reports pending', value: open.filter((c) => c.step === 8).length, color: 'var(--warn)' }, { label: 'Closed (30 days)', value: sc.m.closed, color: 'var(--ok)' },
      { label: 'First-visit resolution', value: fmt.pct(sc.m.fvr) }, { label: 'Attendance SLA', value: fmt.pct(sc.m.attendanceSla) }, { label: 'My score', value: sc.score, meta: 'CSAT ' + (sc.csat || '—') + '/5', color: sc.score >= 80 ? 'var(--ok)' : 'var(--warn)' },
    ]));
    el.appendChild(h('div', { class: 'grid g3' }, [
      h('div', { class: 'span2' }, ui.card('My calls — today’s list', taskList(open.sort((a, b) => dueAt(a, a.attendedAt ? 'resolve' : 'attend') - dueAt(b, b.attendedAt ? 'resolve' : 'attend')).map((c) => ({ title: c.id + ' · ' + custName(c.customerId) + (c.safetyCritical ? ' 🔥' : ''), sub: STEPS[c.step] + ' · ' + c.category + (c.commitAt ? ' · committed ' + fmt.dateTime(c.commitAt) : ''), badge: slaBadge(c, c.attendedAt ? 'resolve' : 'attend'), link: '#/complaints/' + c.id })), 'No open calls'))),
      ui.card('My PM visits (14 days)', taskList(pms.map((v) => ({ title: v.id + ' · ' + custName(v.customerId), sub: v.systemType + ' · due ' + fmt.date(v.dueDate), badge: ui.badge(pmState(v)), link: '#/pm/' + v.id })), 'No PM visits due')),
      qa([['📱 Open mobile app', () => CRM.go('svc-mobile'), 'primary'], ['+ Register complaint', () => openNewComplaint()], ['My OTS', () => CRM.go('ots')], ['My PM schedule', () => CRM.go('pm')], ['My installations', () => CRM.go('installations')]]),
      ui.card('My OTS contribution', ui.dl([['OTS created (all time)', db.all('ots').filter((o) => o.createdBy === me()).length], ['Won', db.all('ots').filter((o) => o.createdBy === me() && o.status === 'Won').length], ['Revenue', fmt.money(util.sum(db.all('ots').filter((o) => o.createdBy === me() && o.status === 'Won'), (o) => o.revenue))], ['Incentive earned', fmt.money(util.sum(db.all('ots').filter((o) => o.createdBy === me()), otsIncentive))]])),
      ui.card('Violations against me (30d)', ui.dl([['Count', sc.viol], ['Score impact', '−' + Math.round(sc.viol * (Number((cfg().penalty || {}).engineer) || 1.5))], ['GRN compliance', fmt.pct(sc.grnPct)], ['Scrap accountability', fmt.pct(sc.scrapPct)], ['PM on-time', sc.pmDue ? fmt.pct(sc.pmOnTimePct) : '—'], ['Installations done', sc.instDone + ' / ' + sc.instCount]])),
    ]));
  });

  CRM.registerHome('pm_coordinator', (el) => {
    const mk = util.iso(CRM.TODAY).slice(0, 7);
    const vs = db.all('pmVisits'); const due = vs.filter((v) => monthKey(v.dueDate) === mk);
    const od = vs.filter((v) => pmState(v) === 'Overdue');
    const cons = db.all('amcContracts').filter((c) => c.status === 'Active');
    const opps = db.all('amcOpportunities').filter((o) => !['Won', 'Lost'].includes(o.status));
    const wonM = db.all('amcOpportunities').filter((o) => o.status === 'Won' && monthKey(o.closedAt) === mk);
    const past = vs.filter((v) => parseD(v.dueDate) <= CRM.TODAY && util.daysBetween(parseD(v.dueDate), CRM.TODAY) <= 180);
    el.appendChild(ui.hero(CRM.role(), [due.length + ' PMs due this month', od.length + ' overdue', cons.filter((c) => util.daysBetween(CRM.TODAY, c.end) <= 60).length + ' AMCs expiring in 60 days']));
    el.appendChild(ui.kpis([
      { label: 'PM due this month', value: due.length, meta: due.filter((v) => v.completedDate).length + ' completed', onClick: () => CRM.go('pm') }, { label: 'PM overdue', value: od.length, color: 'var(--bad)', onClick: () => CRM.go('pm') },
      { label: 'PM compliance (6m)', value: fmt.pct(pctOf(past.filter(pmOnTime).length, past.length)), color: 'var(--ok)' }, { label: 'Reports to approve', value: vs.filter((v) => v.stage === 7 && !v.reportApproved).length, color: 'var(--chart-4)' },
      { label: 'AMC expiring ≤ 60d', value: cons.filter((c) => util.daysBetween(CRM.TODAY, c.end) <= 60).length, color: 'var(--warn)', onClick: () => CRM.go('amc') }, { label: 'Renewal / conversion opps', value: opps.filter((o) => o.type === 'AMC Renewal').length + ' / ' + opps.filter((o) => o.type === 'Warranty Conversion').length },
      { label: 'AMC revenue (month)', value: fmt.lakh(util.sum(wonM, (o) => o.estValue)), meta: 'target ' + fmt.lakh(cfg().amcTargetMonthly), color: 'var(--div-power)' },
    ]));
    const tasks = [];
    od.forEach((v) => tasks.push({ title: 'Overdue PM ' + v.id + ' · ' + custName(v.customerId), sub: v.systemType + ' · due ' + fmt.date(v.dueDate) + ' · ' + master.staffName(v.engineerId), badge: ui.badge(Math.abs(util.daysBetween(CRM.TODAY, v.dueDate)) + 'd overdue', 'bad'), link: '#/pm/' + v.id }));
    vs.filter((v) => !v.completedDate && !v.scheduledDate && util.daysBetween(CRM.TODAY, v.dueDate) >= 0 && util.daysBetween(CRM.TODAY, v.dueDate) <= 10).forEach((v) => tasks.push({ title: 'Plan PM ' + v.id + ' · ' + custName(v.customerId), sub: 'Due ' + fmt.date(v.dueDate) + ' — fix date & assign engineer', badge: ui.badge('Due', 'warn'), link: '#/pm/' + v.id }));
    vs.filter((v) => v.stage === 7 && !v.reportApproved).forEach((v) => tasks.push({ title: 'Approve PM report ' + v.id, sub: custName(v.customerId) + ' · ' + (v.findings || ''), badge: ui.badge('Approval', 'violet'), link: '#/pm/' + v.id }));
    opps.filter((o) => !o.quote).forEach((o) => tasks.push({ title: 'Send AMC quotation · ' + custName(o.customerId), sub: o.type + ' · ' + o.trigger + ' · ' + fmt.money(o.estValue), badge: ui.badge('No quote', 'bad'), link: '#/amc/' + o.id }));
    db.find('serviceTasks', (t) => t.status === 'Open' && t.dueDate <= util.iso(CRM.TODAY)).forEach((t) => tasks.push({ title: t.title, sub: t.id + ' · due ' + fmt.date(t.dueDate) + ' · ' + master.staffName(t.assignedTo), badge: ui.badge(t.dueDate < util.iso(CRM.TODAY) ? 'Overdue' : 'Due today', t.dueDate < util.iso(CRM.TODAY) ? 'bad' : 'info'), link: t.link }));
    const ms = months(6);
    el.appendChild(h('div', { class: 'grid g3' }, [
      h('div', { class: 'span2' }, ui.card('Today’s tasks (' + tasks.length + ')', taskList(tasks))),
      qa([['Monthly PM due list', () => CRM.go('pm'), 'primary'], ['AMC pipeline', () => CRM.go('amc')], ['AMC dashboards', () => CRM.go('amc-dash')], ['PM dashboard', () => CRM.go('pm-dash')], ['Run renewal automation', () => { const n = runAmcAutomation(false); ui.toast(n + ' opportunities created', 'ok'); CRM.refresh(); }]]),
      h('div', { class: 'span2' }, ui.card('PM planned vs completed', ui.barChart(ms.map((m) => ({ label: m.label, values: [vs.filter((v) => monthKey(v.dueDate) === m.key).length, vs.filter((v) => monthKey(v.dueDate) === m.key && v.completedDate).length] })), [{ name: 'Due', color: 'var(--chart-1)' }, { name: 'Completed', color: 'var(--chart-2)' }]))),
      ui.card('Opportunity mix', ui.donut([{ label: 'AMC Renewal', value: opps.filter((o) => o.type === 'AMC Renewal').length, color: 'var(--chart-1)' }, { label: 'Warranty Conversion', value: opps.filter((o) => o.type === 'Warranty Conversion').length, color: 'var(--chart-4)' }], { label: 'open' })),
    ]));
  });

  CRM.registerHome('odm', (el) => {
    const all = db.all('violations'); const open = all.filter(vOpen); const T = pendingTasks();
    const m = metrics(svcList().filter((c) => util.daysBetween(c.createdAt, CRM.TODAY) <= 30));
    el.appendChild(ui.hero(CRM.role(), [open.length + ' open violations', open.filter((v) => v.severity === 'Critical').length + ' critical', all.filter((v) => v.status === 'Pending Closure Approval').length + ' awaiting your approval']));
    el.appendChild(ui.kpis([
      { label: 'Violations today', value: all.filter((v) => util.iso(v.incidentAt) === util.iso(CRM.TODAY)).length, onClick: () => CRM.go('violations') },
      { label: 'Open violations', value: open.length, color: 'var(--bad)', onClick: () => CRM.go('violations') }, { label: 'Critical', value: open.filter((v) => v.severity === 'Critical').length, color: 'var(--chart-4)' },
      { label: 'Awaiting closure approval', value: all.filter((v) => v.status === 'Pending Closure Approval').length, color: 'var(--warn)' }, { label: 'Escalated L3+', value: open.filter((v) => v.escalationLevel >= 3).length, color: 'var(--bad)' },
      { label: 'Attendance SLA (30d)', value: fmt.pct(m.attendanceSla), meta: 'resolution ' + fmt.pct(m.resolutionSla) }, { label: 'Cross-functional pending', value: T.length, onClick: () => CRM.go('pending-tasks') },
    ]));
    const appr = all.filter((v) => v.status === 'Pending Closure Approval');
    el.appendChild(h('div', { class: 'grid g3' }, [
      h('div', { class: 'span2' }, ui.card('Cross-functional pending tasks (oldest first)', ui.table({ rows: T.slice(0, 12), columns: taskCols, search: false, onRow: (t) => { if (t.link) location.hash = t.link; } }), { flush: true, actions: [ui.btn('View all', () => CRM.go('pending-tasks'), 'sm')] })),
      ui.card('Closure approvals (' + appr.length + ')', taskList(appr.map((v) => ({ title: v.id + ' · ' + v.title, sub: master.staffName(v.ownerId) + ' · ' + (v.correctiveAction || ''), badge: ui.badge(v.severity, sevTone(v.severity)), link: '#/violations/' + v.id })), 'No approvals pending')),
      ui.card('Department-wise open violations', ui.hbars(Object.keys(LADDER).map((d) => ({ label: d, value: open.filter((v) => v.area === d).length, color: 'var(--bad)' })))),
      ui.card('Escalation ladder (open)', ui.barChart(LVLS.map((l) => ({ label: 'L' + l, values: [open.filter((v) => (v.escalationLevel || 1) === l).length] })), [{ name: 'Open', color: 'var(--chart-5)' }])),
      ui.card('Customer risk — top 5', taskList(customerRisk().slice(0, 5).map((r) => ({ title: r.name, sub: r.esc + ' escalations · ' + r.neg + ' negative feedback · ' + r.rep + ' repeat complaints', badge: ui.badge('Risk ' + r.score, r.score >= 10 ? 'bad' : 'warn'), link: '#/customer360/' + r.id })), 'No customers at risk')),
      qa([['Run policy scan', () => { const n = evaluatePolicies(); ui.toast(n + ' new violations', n ? 'warn' : 'ok'); CRM.refresh(); }, 'primary'], ['Violations desk', () => CRM.go('violations')], ['Escalation dashboards', () => CRM.go('escalation-dash')], ['Policy rules', () => CRM.go('policy-rules')], ['Reports', () => CRM.go('svc-reports')]]),
    ]));
  });

  // ================================================================ Customer 360, search and summary API
  CRM.registerCustomerSection((cust) => {
    const assets = db.find('assets', (a) => a.customerId === cust.id);
    const calls = db.find('complaints', (c) => c.customerId === cust.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const amcs = db.find('amcContracts', (a) => a.customerId === cust.id);
    const pms = db.find('pmVisits', (v) => v.customerId === cust.id).sort((a, b) => (a.dueDate < b.dueDate ? 1 : -1));
    if (!assets.length && !calls.length && !amcs.length) return null;
    return {
      title: 'Service, AMC & PM', summary: assets.length + ' assets · ' + calls.filter(isOpen).length + ' open calls · AMC ' + amcStatusLine(cust.id), flush: true,
      body: () => ui.tabs([{ id: 'a', label: 'Installed equipment (' + assets.length + ')' }, { id: 'c', label: 'Complaints (' + calls.length + ')' }, { id: 'm', label: 'AMC (' + amcs.length + ')' }, { id: 'p', label: 'PM history (' + pms.length + ')' }], (t, b) => {
        if (t === 'a') b.appendChild(ui.table({ rows: assets, search: false, pageSize: 8, onRow: (a) => (CRM.canSee('assets') ? CRM.go('assets', a.id) : null), columns: [{ key: 'id', label: 'Equipment', render: (a) => mono(a.id) }, { key: 'name', label: 'Product' }, { key: 'serial', label: 'Serial' }, { key: 'location', label: 'Location' }, { key: 'installDate', label: 'Installed', render: (a) => fmt.date(a.installDate) }, { key: 'cov', label: 'Coverage', render: (a) => covBadge(coverageOf(a).type) }] }));
        if (t === 'c') b.appendChild(ui.table({ rows: calls, search: false, pageSize: 8, onRow: (c) => (CRM.canSee('complaints') ? CRM.go('complaints', c.id) : null), columns: [{ key: 'id', label: 'Complaint', render: (c) => mono(c.id) }, { key: 'createdAt', label: 'Date', render: (c) => fmt.date(c.createdAt) }, { key: 'division', label: 'Division', render: (c) => ui.divTag(c.division) }, { key: 'category', label: 'Category' }, { key: 'priority', label: 'Priority', render: (c) => priBadge(c.priority) }, { key: 'status', label: 'Status', render: (c) => ui.badge(c.status) }, { key: 'rating', label: 'Feedback', render: (c) => (c.rating ? c.rating + '/5' : '—') }] }));
        if (t === 'm') b.appendChild(ui.table({ rows: amcs, search: false, onRow: (c) => (CRM.canSee('amc') ? CRM.go('amc', c.id) : null), columns: [{ key: 'id', label: 'AMC', render: (c) => mono(c.id) }, { key: 'type', label: 'Type' }, { key: 'start', label: 'Period', render: (c) => fmt.date(c.start) + ' → ' + fmt.date(c.end) }, { key: 'value', label: 'Value', render: (c) => fmt.money(c.value) }, { key: 'nextPmDue', label: 'Next PM', render: (c) => fmt.date(c.nextPmDue) }, { key: 'status', label: 'Status', render: (c) => ui.badge(c.status) }] }));
        if (t === 'p') b.appendChild(ui.table({ rows: pms, search: false, pageSize: 8, onRow: (v) => (CRM.canSee('pm') ? CRM.go('pm', v.id) : null), columns: [{ key: 'id', label: 'PM', render: (v) => mono(v.id) }, { key: 'systemType', label: 'System' }, { key: 'dueDate', label: 'Due', render: (v) => fmt.date(v.dueDate) }, { key: 'completedDate', label: 'Completed', render: (v) => fmt.date(v.completedDate) }, { key: 'st', label: 'Status', render: (v) => ui.badge(pmState(v)) }, { key: 'findings', label: 'Findings' }] }));
      }),
    };
  });

  CRM.registerSearch((q) => {
    const out = [];
    const cn = (id) => custName(id).toLowerCase();
    if (CRM.canSee('complaints')) scope(db.all('complaints')).filter((c) => (c.id + ' ' + cn(c.customerId) + ' ' + c.category + ' ' + (c.serial || '')).toLowerCase().includes(q)).slice(0, 5).forEach((c) => out.push({ label: c.id + ' · ' + custName(c.customerId), sub: 'Complaint · ' + c.category + ' · ' + c.status, link: '#/complaints/' + c.id }));
    if (CRM.canSee('assets')) db.all('assets').filter((a) => (a.id + ' ' + a.serial + ' ' + cn(a.customerId)).toLowerCase().includes(q)).slice(0, 3).forEach((a) => out.push({ label: a.id + ' · ' + a.name, sub: 'Equipment · serial ' + a.serial + ' · ' + custName(a.customerId), link: '#/assets/' + a.id }));
    if (CRM.canSee('amc')) db.all('amcContracts').concat(db.all('amcOpportunities')).filter((a) => (a.id + ' ' + cn(a.customerId)).toLowerCase().includes(q)).slice(0, 3).forEach((a) => out.push({ label: a.id + ' · ' + custName(a.customerId), sub: (a.type || 'AMC') + ' · ' + a.status, link: '#/amc/' + a.id }));
    if (CRM.canSee('ots')) db.all('ots').filter((o) => (o.id + ' ' + cn(o.customerId)).toLowerCase().includes(q)).slice(0, 2).forEach((o) => out.push({ label: o.id + ' · ' + custName(o.customerId), sub: o.otsType + ' · ' + o.status, link: '#/ots/' + o.id }));
    if (CRM.canSee('violations')) db.all('violations').filter((v) => (v.id + ' ' + v.title).toLowerCase().includes(q)).slice(0, 2).forEach((v) => out.push({ label: v.id + ' · ' + v.title, sub: 'Violation · ' + v.status, link: '#/violations/' + v.id }));
    return out;
  });

  CRM.service = {
    summary() {
      const all = svcList(); const recentL = all.filter((c) => util.daysBetween(c.createdAt, CRM.TODAY) <= 90);
      const m = metrics(recentL); const open = all.filter(isOpen); const vs = db.all('pmVisits');
      const byDivision = {}; const divisionDetail = {};
      DIVS.forEach((d) => { const l = open.filter((c) => c.division === d); const md = metrics(recentL.filter((c) => c.division === d)); byDivision[d] = l.length; divisionDetail[d] = { openCalls: l.length, overdueCalls: l.filter(overdue).length, attendanceSla: md.attendanceSla, resolutionSla: md.resolutionSla, repeatPct: md.repeatPct }; });
      return {
        openCalls: open.length, overdueCalls: open.filter(overdue).length, attendanceSla: m.attendanceSla, resolutionSla: m.resolutionSla, ackSla: m.ackSla, repeatPct: m.repeatPct,
        pmDue: vs.filter((v) => !v.completedDate && util.daysBetween(CRM.TODAY, v.dueDate) >= 0 && util.daysBetween(CRM.TODAY, v.dueDate) <= 30).length, pmOverdue: vs.filter((v) => pmState(v) === 'Overdue').length,
        amcExpiring: db.all('amcContracts').filter((a) => a.status === 'Active' && util.daysBetween(CRM.TODAY, a.end) <= 60).length,
        openViolations: db.all('violations').filter(vOpen).length, criticalViolations: db.all('violations').filter((v) => vOpen(v) && v.severity === 'Critical').length,
        serviceRevenue: m.revenue, byDivision, divisionDetail,
      };
    },
    evaluate: () => evaluatePolicies(), runAutomation: () => runAutomation(), coverageOf, slaState,
  };

  // ---------------------------------------------------------------- boot: run alerts, renewal triggers and the policy engine on load,
  // then re-check SLA / escalation / observation every minute (core CRM.registerTick when present, else setInterval)
  let booted = false;
  let popupReady = false; let lastPop = 0; let popQueue = 0;
  function tick() { if (!booted) return; safe(() => { runSlaAlerts(); evaluatePolicies(); }, null); }
  CRM.on('ready', () => { safe(() => { cfg(); runAutomation(); }, null); safe(() => db.find('amcOpportunities', (o) => !['Won', 'Lost'].includes(o.status) && !db.one('serviceTasks', (t) => t.refId === o.id && t.status === 'Open')).forEach((o) => oppTask(o, o.nextFollowUp || util.iso(util.addDays(parseD(o.createdAt || CRM.TODAY), FOLLOW_UP_DAYS)), { silent: true })), null); booted = true; setTimeout(() => { popupReady = true; }, 1500); });
  if (CRM.registerTick) safe(() => CRM.registerTick(tick, 60e3), null); else setInterval(tick, 60e3);
  // popup for new critical notifications addressed to the current user's role (bell badge alone is easy to miss)
  CRM.on('notifications:created', (n) => {
    if (!popupReady || !n || n.severity !== 'bad' || CRM.notifyPopup) return;
    const mine = (n.to || []).some((r) => CRM.is(r)) || ((n.to || []).includes('mgmt') && CRM.is('admin', 'gm', 'odm'));
    if (!mine || (n.toUser && n.toUser !== me())) return;
    const t = Date.now(); if (t - lastPop < 4000) { popQueue++; return; }
    lastPop = t; ui.toast('🔔 ' + n.title + (popQueue ? ' (+' + popQueue + ' more)' : ''), 'bad'); popQueue = 0;
  });
})();
