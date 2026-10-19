/* Projects & Supply Chain module — Electronic Security large projects & small installation jobs, Solar projects,
 * site survey, version-controlled BOQ, procurement (stock → reservation → PR → PO → GRN → inspection → allocation),
 * stock master, delivery challans, material issue/returns, scrap, net-metering, subsidy and the secure credential vault.
 * Sources: Electronic_security.pdf §1-5 & 9-14, Solar.pdf §2-4 & 8-12, Service_requirement.pdf (Project installation,
 * Inventory / Purchase / GRN / DC / Scrap).
 * Collections owned: projects, surveys, boqs, purchaseRequests, purchaseOrders, grns, stock, dcs, scrap, netMetering,
 * subsidies (+ credVault for the restricted credential-vault references).
 */
(function () {
  'use strict';
  const { db, ui, h, util, fmt, master } = CRM;

  // ------------------------------------------------------------------ constants
  const T0 = CRM.TODAY;
  const MG = ['gm', 'admin', 'odm'];
  const ESD = 'Electronic Security', SOL = 'Solar';
  const KIND = { es_large: 'Large Project', es_small: 'Small Installation', es_pending: 'Awaiting classification', solar: 'Solar Project' };
  const KIND_TONE = { es_large: 'brand', es_small: 'info', es_pending: 'warn', solar: 'ok' };
  const ES_TYPES = ['CCTV', 'Access Control', 'Biometric', 'PA System', 'Fire Alarm', 'Video Door Phone', 'Mixed'];
  const SOLAR_TYPES = ['Residential', 'Commercial', 'Industrial', 'Other'];
  const PRIORITIES = ['High', 'Medium', 'Low'];
  const INSTALL_MODES = ['Own team', 'Vendor', 'Mixed'];
  const SUPPLIERS = ['Prama Hikvision (Coimbatore)', 'CP Plus Distributors Chennai', 'D-Link Networks India', 'Polycab Wires Ltd', 'Waaree Energies Ltd', 'Sungrow India Pvt Ltd', 'Kovai Steel Structures', 'Exide Industries Ltd'];
  const WAREHOUSES = ['Main Warehouse', 'Service Centre', 'Engineer Stock', 'Project Site'];
  const NM_STATUS = ['Not Started', 'Documents Pending', 'Ready for Submission', 'Submitted', 'Under Review', 'Additional Information Required', 'Approved', 'Rejected', 'Meter Installation Pending', 'Completed'];
  const NM_DOCS = ['Consumer number / service connection proof', 'Latest electricity bill', 'Customer ID & address proof', 'Property ownership / NOC', 'Single-line diagram', 'Inverter & module datasheets / test certificates', 'Signed net-metering application form', 'Installer (vendor) registration details', 'Commissioning / work-completion report'];
  const SUB_STATUS = ['Eligibility Check', 'Documents Pending', 'Registered', 'Application Submitted', 'Under Verification', 'Additional Documents Requested', 'Approved', 'Rejected', 'Resubmitted', 'Disbursed'];
  const SUB_DOCS = ['Customer consent form', 'Aadhaar / ID proof', 'Bank account details (cancelled cheque)', 'Latest electricity bill', 'Rooftop photograph with geo-tag', 'Net-meter installation certificate', 'Commissioning certificate', 'DCR module certificate'];
  const SCHEMES = ['PM Surya Ghar: Muft Bijli Yojana (2024)', 'TANGEDCO Rooftop Scheme (2025)', 'Not applicable'];
  const SCRAP_TRIGGERS = ['Battery replaced under warranty', 'Old battery taken during new sale', 'Damaged inverter replaced', 'Non-repairable items', 'Damaged material from installation'];
  const SCRAP_STATUS = ['Pending Collection', 'Collected', 'In Stock', 'Sent to Vendor', 'Disposed'];
  const SGRN_STATUS = ['Pending Inward', 'Inward Created', 'Under Service', 'Ready for Dispatch', 'Delivered'];

  // ------------------------------------------------------------------ small helpers
  const nowIso = () => new Date().toISOString();
  const isoD = (d) => util.iso(d);
  const isPast = (d) => d && new Date(d) < T0;
  const user = () => CRM.user();
  const can = (...roles) => CRM.is(roles.flat()) || CRM.is('admin');
  const sName = (id) => master.staffName(id);
  const cust = (id) => master.customer(id) || { name: id || '—', area: '' };
  const mono = (t) => h('span', { class: 'mono' }, t || '—');
  const plink = (id) => '#/projects/' + id;
  const pLink = (id) => h('a', { href: plink(id), class: 'mono' }, id);
  const yes = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  const clone = util.clone;
  const sumBy = (arr, k) => util.sum(arr || [], k == null ? undefined : typeof k === 'function' ? k : (x) => x[k]);
  const daysLate = (due, doneAt) => (due ? util.daysBetween(due, doneAt ? new Date(doneAt) : T0) : 0);
  const hrs = (a, b) => (a && b ? util.hoursBetween(a, b) : null);
  const CREDENTIAL_RX = /(pass(word)?|pwd|passcode|recovery\s*code|secret|wifi\s*key)\s*[:=]/i;

  function csv(name, cols, rows) {
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const text = [cols.map((c) => esc(c.label)).join(',')].concat(rows.map((r) => cols.map((c) => esc(c.csv ? c.csv(r) : r[c.key])).join(','))).join('\n');
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: name + '.csv' });
    document.body.appendChild(a); a.click(); a.remove();
    ui.toast('Exported ' + rows.length + ' rows', 'ok');
  }
  const exportBtn = (name, cols, rowsFn) => ui.btn('⇩ Export', () => csv(name, cols, rowsFn()), 'sm');

  // ------------------------------------------------------------------ stage library
  // Each workflow is an ordered list of [stageKey, label]. Stage state lives in project.stages[key]:
  // { status, done:[checklist indices], fields:{}, startedAt, submittedAt, doneAt, due, approvedBy, reworkCount }.
  const WF = {
    es_large: [['so', 'SO receipt'], ['survey', 'Site survey'], ['boq', 'BOQ'], ['procurement', 'Procurement'], ['delivery', 'Material delivery'], ['planning', 'Installation planning'], ['cable', 'Cable laying'], ['nvr', 'DVR / NVR'], ['cameras', 'Camera installation'], ['testing', 'Config / Testing / Commissioning'], ['handover', 'Handover / Closure']],
    es_small: [['so', 'SO received & job created'], ['scope', 'Scope & site verified'], ['survey', 'Site visit (if required)'], ['boq', 'BOQ / material list'], ['procurement', 'Stock & purchase'], ['delivery', 'Material issued & scheduled'], ['install', 'Cable & device installation'], ['testing', 'DVR/NVR config & testing'], ['handover', 'Demo & handover'], ['activate', 'Asset / warranty / PM activation']],
    solar: [['so', 'SO receipt'], ['survey', 'Site visit & feasibility'], ['boq', 'BOQ'], ['procurement', 'Purchase & material planning'], ['delivery', 'Dispatch & site verification'], ['planning', 'Installation planning'], ['civil', 'Civil work'], ['mechanical', 'Mechanical installation'], ['electrical', 'Electrical installation'], ['commissioning', 'Testing & commissioning'], ['compliance', 'Net metering & subsidy'], ['handover', 'Customer handover']],
    es_pending: [['so', 'SO receipt / classification']],
  };
  const DUR = { so: 1, scope: 1, survey: 5, boq: 3, procurement: 9, delivery: 3, planning: 2, cable: 6, nvr: 2, cameras: 5, install: 3, testing: 3, handover: 4, activate: 2, civil: 5, mechanical: 4, electrical: 4, commissioning: 3, compliance: 10 };
  const DUR_SMALL = { so: 1, scope: 1, survey: 2, boq: 2, procurement: 4, delivery: 2, install: 3, testing: 1, handover: 1, activate: 2 };
  const OPT = (arr) => arr;
  const F = (key, label, type, extra) => Object.assign({ key, label, type: type || 'text', required: true }, extra || {});

  const LIB = {
    so: {
      owner: 'Sales Team / ES Coordinator', roles: ['es_coordinator'], setup: true,
      checklist: ['Sales Order number linked to Sales CRM', 'Customer ID, installation site address and site contact verified', 'Project type and system architecture confirmed', 'Camera count and other device quantities (DVR/NVR, switches, biometric, access controllers) confirmed', 'Project scope documents attached (Sales Order, quotation, drawings, specifications)', 'Project coordinator assigned', 'Technical engineer assigned', 'Installation mode decided (Own team / Vendor / Mixed)', 'Planned completion date committed', 'Milestones and tasks created; project accepted by coordinator'],
      gate: (p) => (!p.coordinator || !p.engineer || !p.installMode || !p.committedDate ? 'Complete the project setup (coordinator, technical engineer, installation mode, committed date) first.' : null),
    },
    scope: {
      owner: 'ES Coordinator', roles: ['es_coordinator', 'tech_engineer'],
      checklist: ['Customer and site details verified', 'Number and type of cameras/devices confirmed', 'Installation team and owner assigned', 'Site-visit requirement decided as per policy / technical complexity'],
      fields: [F('siteVisit', 'Site visit required?', 'select', { options: ['Yes', 'No — straightforward job (policy permits)'] }), F('policyNote', 'Policy basis / remarks', 'text', { required: false })],
    },
    survey: { owner: 'Technical Engineer (accountable: Coordinator / Technical Head)', roles: ['tech_engineer', 'tech_head', 'es_coordinator', 'solar_coordinator'], special: 'survey', gate: (p) => { const s = latestSurvey(p.id); return s && s.status === 'Approved' ? null : 'The site survey must be submitted complete and approved by the reviewer (status now: ' + (s ? s.status : 'not scheduled') + ').'; } },
    boq: { owner: 'Technical Engineer (approver: Technical Head)', roles: ['tech_engineer', 'tech_head', 'es_coordinator', 'solar_coordinator'], special: 'boq', gate: (p) => (!approvedBoq(p.id) ? 'An approved BOQ is required (prepare → submit → Technical Head approval).' : p.boqRevisionRequired ? 'Scope changed — the revised BOQ must be approved.' : null) },
    procurement: { owner: 'Purchase Coordinator', roles: ['purchase', 'stores', 'es_coordinator', 'solar_coordinator'], special: 'procurement', gate: (p) => (!approvedBoq(p.id) ? 'Purchase requires an approved BOQ.' : shortages(p).length ? shortages(p).length + ' BOQ item(s) are still short — reserve, purchase, receive (GRN), inspect and allocate first.' : null) },
    delivery: {
      owner: 'Stores / Logistics / Project Coordinator', roles: ['stores', 'es_coordinator', 'solar_coordinator', 'install_lead'], special: 'delivery', gate: (p) => (deliveryComplete(p) ? null : 'All BOQ material must be dispatched on DC and confirmed at site (actual quantities, no open discrepancy).'),
      checklist: ['Materials traceable to the project and approved BOQ', 'Dispatch done against DC as per stock-movement policy', 'Receiving person confirmed actual quantities', 'Discrepancies (short / damaged / rejected) recorded as exception', 'Unused-material return / reconciliation arranged', 'Material readiness confirmed only after receipt checks'],
    },
    planning: {
      owner: 'ES Coordinator', roles: ['es_coordinator', 'install_lead'],
      checklist: ['Stage-wise schedule prepared with task dependencies', 'Internal team / vendor allocated', 'Material readiness confirmed after receipt checks', 'Site readiness and customer availability confirmed', 'Required tools and safety arrangements in place'],
      fields: [F('team', 'Installation team / vendor'), F('teamLeader', 'Team leader & technicians'), F('plannedStart', 'Planned start', 'date'), F('plannedFinish', 'Planned finish', 'date'), F('siteReadiness', 'Site readiness & customer availability', 'select', { options: ['Ready — customer available', 'Partially ready', 'Not ready'] }), F('cablePlan', 'Cable-laying plan'), F('nvrPlan', 'DVR/NVR installation plan'), F('cameraPlan', 'Camera installation plan'), F('testPlan', 'Configuration & testing plan'), F('toolsSafety', 'Required tools & safety arrangements'), F('progressNote', 'Daily progress / pending work', 'textarea', { required: false })],
      gate: (p) => (!deliveryComplete(p) ? 'Material readiness is not confirmed — site receipt of all BOQ material must be verified before installation planning is completed.' : (st(p, 'planning').fields.siteReadiness === 'Not ready' ? 'Site is not ready — installation cannot be scheduled.' : null)),
    },
    cable: {
      owner: 'Installation Team Leader / Assigned Vendor', roles: ['install_lead', 'tech_engineer', 'es_coordinator'], approval: ['install_lead', 'tech_head'], task: true,
      checklist: ['Conduit / trunking completed', 'Cable termination completed', 'Labelling and identification check done', 'Cable endpoint mapping recorded (camera/device ↔ recording/network endpoint)', 'Cable testing completed', 'Before/after photographs uploaded', 'Actual cable consumption recorded for stock reconciliation'],
      fields: [F('cableType', 'Cable type', 'select', { options: ['Cat6', 'Fibre', 'Coaxial', 'Cat6 + Fibre'] }), F('route', 'Cable route / floor / zone'), F('plannedLength', 'Planned cable length (m)', 'number'), F('actualLength', 'Actual cable length used (m)', 'number'), F('endpointMap', 'Cable ID / camera endpoint mapping'), F('conduit', 'Conduit/trunking status', 'select', { options: ['Completed', 'Partial', 'Pending'] }), F('termination', 'Termination status', 'select', { options: ['Completed', 'Partial', 'Pending'] }), F('testResult', 'Cable testing result', 'select', { options: ['Pass', 'Fail'] }), F('pendingRoutes', 'Pending routes & obstructions', 'text', { required: false }), F('photos', 'Before/after photographs (ref)'), F('completedBy', 'Completed by'), F('inspectedBy', 'Inspected by', 'text', { required: false })],
      gate: (p) => {
        const f = st(p, 'cable').fields;
        if (f.testResult === 'Fail') return 'Cable test failed — corrective work must be completed and re-tested.';
        if (f.conduit !== 'Completed' || f.termination !== 'Completed') return 'Conduit/trunking and termination must be Completed.';
        if (cableVariance(p) > 10 && !st(p, 'cable').varianceApproved) return 'Cable consumption is ' + cableVariance(p) + '% above plan (permitted 10%). Additional-material approval from the Technical Head is required.';
        return null;
      },
    },
    nvr: {
      owner: 'Assigned Technical Engineer', roles: ['tech_engineer', 'tech_head'],
      checklist: ['Correct DVR/NVR model and capacity verified', 'Device serial number recorded', 'Hard disks installed and health checked', 'Recording capacity and retention settings configured', 'Network settings recorded', 'Time zone, date and time configured', 'Camera channels mapped', 'Recording schedule configured', 'Motion/event recording settings configured where required', 'Remote access configured through an approved secure method, where included', 'User roles and access permissions configured', 'UPS/power protection verified where applicable', 'Device health and recording test completed', 'Configuration backup and handover records stored securely'],
      fields: [F('nvrModel', 'DVR/NVR model & channels'), F('hdd', 'Hard disks installed (count × TB)'), F('retention', 'Recording retention (days)', 'number'), F('network', 'Network settings (IP / subnet / gateway — no passwords)'), F('remote', 'Remote access method', 'select', { options: ['Not in scope', 'Vendor P2P cloud (approved)', 'VPN (approved)'] })],
      gate: (p) => {
        const nv = (p.devices || []).filter((d) => d.type === 'NVR');
        if (!nv.length || nv.some((d) => !d.serial)) return 'Record the DVR/NVR serial number in the device schedule.';
        if (!db.one('credVault', (v) => v.projectId === p.id)) return 'Device credentials must be lodged in the secure credential vault (not in notes) before DVR/NVR sign-off.';
        return null;
      },
    },
    cameras: {
      owner: 'Installation Team', roles: ['install_lead', 'tech_engineer', 'es_coordinator'], special: 'devices', task: true,
      checklist: ['Camera make, model and serial number recorded where applicable', 'Installation location and camera ID recorded', 'Camera mounting completed', 'Field of view checked', 'Image quality and focus verified', 'Night vision / IR checked where applicable', 'Day/night image quality checked as appropriate', 'Camera connection and power verified', 'Network connectivity verified for IP systems', 'Video feed mapped to the correct DVR/NVR channel', 'Camera view confirmed with customer where required', 'Final installation photographs uploaded', 'Defects and corrective actions recorded'],
      gate: (p) => devicesGate(p),
    },
    install: {
      owner: 'Installation Team / Technical Engineer', roles: ['install_lead', 'tech_engineer', 'es_coordinator'], special: 'devices', task: true,
      checklist: ['Cable laying completed, labelled and tested', 'Cable endpoint mapping recorded', 'Cameras / devices mounted at approved locations', 'Camera connection and power verified', 'Video feed mapped to DVR/NVR channel', 'Installation photographs uploaded', 'Material used recorded against issue'],
      fields: [F('plannedLength', 'Planned cable length (m)', 'number'), F('actualLength', 'Actual cable used (m)', 'number'), F('installStatus', 'Cable / device installation status', 'select', { options: ['Physical work complete', 'In progress'] })],
      gate: (p) => (st(p, 'install').fields.installStatus !== 'Physical work complete' ? 'Installation status must be "Physical work complete".' : devicesGate(p)),
    },
    testing: {
      owner: 'Technical Engineer (approval: Technical Head)', roles: ['tech_engineer', 'es_coordinator'], approval: ['tech_head'], task: true,
      checklist: ['All installed cameras/devices are accounted for', 'Live video / device operation verified', 'Recording and playback tested', 'Recording retention settings verified against the approved scope', 'Date/time synchronization checked', 'Network connectivity verified', 'Remote viewing tested if included in the scope', 'Motion/event alerts tested if included', 'Access permissions verified', 'UPS/power backup checked where applicable', 'Cable labels and camera/channel mapping verified', 'Customer user training completed', 'Test results and commissioning report uploaded', 'Defects and punch-list items closed or formally accepted'],
      fields: [F('testResult', 'Overall test result', 'select', { options: ['Pass', 'Fail'] }), F('testedOn', 'Tested on', 'date'), F('report', 'Commissioning report (document ref)'), F('punchOpen', 'Open punch-list items', 'number'), F('remarks', 'Test remarks', 'textarea', { required: false })],
      gate: (p) => { const f = st(p, 'testing').fields; return f.testResult !== 'Pass' ? 'Test result is not "Pass" — a rework task must be closed and the test repeated.' : Number(f.punchOpen) > 0 ? 'Close or formally accept all punch-list items before commissioning sign-off.' : null; },
    },
    handover: {
      owner: 'ES Coordinator (final closure: designated owner)', roles: ['es_coordinator', 'doc_coordinator'], approval: ['es_coordinator'], closes: true,
      checklist: ['Final approved BOQ and any approved changes', 'Installed equipment schedule and serial numbers', 'Final camera/device location schedule', 'DVR/NVR channel mapping', 'Commissioning and testing report', 'Warranty documentation', 'Customer user training and acknowledgement', 'Approved access and configuration handover procedure', 'Drawings / cable route records where applicable', 'Customer acceptance / signed handover', 'Outstanding items and approved closure plan', 'Service and PM activation status'],
      fields: [F('acceptedBy', 'Customer acceptance — signed by'), F('acceptedOn', 'Acceptance date', 'date'), F('evidence', 'Signed handover evidence (document ref)'), F('trainingOn', 'Customer training date', 'date'), F('outstanding', 'Outstanding items & closure plan', 'text', { required: false })],
      gate: (p) => handoverGate(p),
    },
    activate: {
      owner: 'ES Coordinator', roles: ['es_coordinator'], approval: ['es_coordinator'], closes: true,
      checklist: ['Material used and returned reconciled', 'Equipment and serial numbers recorded', 'Warranty start date recorded', 'Service history and PM eligibility activated', 'Closure approved by coordinator (not by engineer completion alone)'],
      gate: (p) => (!DONE(st(p, 'handover')) ? 'Customer demonstration & handover must be completed first.' : openRework(p).length ? 'Open rework tasks must be closed or formally accepted.' : null),
    },
    civil: {
      owner: 'Task owner (team / vendor)', roles: ['install_lead', 'solar_coordinator', 'tech_engineer'], approval: ['tech_head', 'install_lead'], task: true,
      checklist: ['Foundation and structural support work', 'Roof preparation and waterproofing precautions', 'Cable routing provisions and equipment foundations', 'Site cleanliness and safety inspection', 'Completion photos and inspection sign-off'],
      fields: [F('actualDate', 'Actual completion date', 'date'), F('responsible', 'Responsible person / vendor'), F('photos', 'Completion photographs (ref)')],
    },
    mechanical: {
      owner: 'Task owner (team / vendor)', roles: ['install_lead', 'solar_coordinator', 'tech_engineer'], approval: ['tech_head', 'install_lead'], task: true,
      checklist: ['Mounting structure installation', 'Module placement and fastening', 'Alignment and mechanical stability checks', 'Fastener and structure inspection', 'Completion photographs and quality approval'],
      fields: [F('actualDate', 'Actual completion date', 'date'), F('responsible', 'Responsible person / vendor'), F('defects', 'Pending defects', 'text', { required: false }), F('photos', 'Completion photographs (ref)')],
      gate: (p) => (!DONE(st(p, 'civil')) ? 'Civil work must be approved before mechanical installation (dependency).' : null),
    },
    electrical: {
      owner: 'Task owner (team / vendor)', roles: ['install_lead', 'solar_coordinator', 'tech_engineer'], approval: ['tech_head'], task: true,
      checklist: ['Module string wiring and DC cabling', 'Inverter mounting and connections', 'AC connections and protection devices', 'Earthing and applicable surge/lightning protection', 'Testing, electrical safety checks and labelling'],
      fields: [F('actualDate', 'Actual completion date', 'date'), F('testRecords', 'Test records (document ref)'), F('photos', 'Photographs (ref)')],
      gate: (p) => (!DONE(st(p, 'mechanical')) ? 'Mechanical installation must be approved before electrical work (dependency).' : null),
    },
    commissioning: {
      owner: 'Technical Team (approval: Technical Head)', roles: ['tech_engineer', 'solar_coordinator'], approval: ['tech_head'], special: 'devices',
      checklist: ['Project and equipment identification recorded', 'System capacity and approved configuration verified', 'Installed module, inverter and other equipment details recorded', 'Serial numbers recorded where required', 'Test results and commissioning checklist completed', 'Earthing and electrical test records uploaded', 'Inverter configuration and monitoring setup done', 'Grid connection status and utility prerequisites checked', 'Faults, punch-list items and corrective actions closed or accepted', 'Commissioning date and authorized sign-off recorded', 'Commissioning report and supporting documents uploaded'],
      fields: [F('testResult', 'Test result', 'select', { options: ['Pass', 'Fail'] }), F('commissionedOn', 'Commissioning date', 'date'), F('report', 'Commissioning report (document ref)'), F('punchOpen', 'Open punch-list items', 'number'), F('gridStatus', 'Grid synchronization status', 'select', { options: ['Not synchronized', 'Synchronized (export pending net meter)', 'Synchronized with net meter'] })],
      gate: (p) => { const f = st(p, 'commissioning').fields; if (f.testResult !== 'Pass') return 'Tests have not passed — rework must be closed first.'; if (Number(f.punchOpen) > 0) return 'Mandatory punch-list items must be closed or accepted as exceptions.'; return devicesGate(p); },
    },
    compliance: { owner: 'Documentation Coordinator', roles: ['doc_coordinator', 'solar_coordinator'], special: 'compliance', gate: (p) => complianceGate(p) },
  };
  // Solar variants of shared stages (different checklists / owners per Solar.pdf).
  const LIB_SOLAR = {
    so: { owner: 'Sales / Solar Coordinator', roles: ['solar_coordinator'], checklist: ['Sales Order linked and project value verified', 'Customer, site address, contact person and mobile verified', 'Solar system capacity (kW/kWp) and configuration confirmed', 'Project type confirmed (Residential / Commercial / Industrial / Other)', 'Sales Order, approved quotation, scope and attachments uploaded', 'Project owner (Solar Coordinator) assigned', 'Technical owner assigned', 'Installation mode decided (Own team / Vendor / Mixed)', 'Planned completion date approved', 'Project checklist created and project accepted'] },
    delivery: { checklist: ['Delivery challan (DC) generated or linked', 'Dispatch date, vehicle/courier details and receiving person recorded', 'Item-wise quantity dispatched recorded', 'Site receipt confirmed with date, quantity and evidence', 'Short supply, damage, incorrect or rejected items recorded', 'Return of unused materials to stores tracked', 'Additional material requests approved', 'BOQ, purchased, received, dispatched, site-used and return quantities reconciled'], roles: ['stores', 'solar_coordinator', 'install_lead'] },
    planning: {
      owner: 'Solar Coordinator', roles: ['solar_coordinator', 'install_lead'],
      checklist: ['Project task plan with task owners and dependencies created', 'Team leader / vendor assigned and briefed', 'Material readiness confirmed', 'Site readiness confirmed', 'Required tools, equipment and safety arrangements confirmed', 'Customer availability and access confirmed'],
      fields: [F('team', 'Team leader & assigned technicians'), F('vendorContact', 'Vendor name & contact', 'text', { required: false }), F('plannedStart', 'Planned start', 'date'), F('plannedFinish', 'Planned completion', 'date'), F('civilDate', 'Civil work date', 'date'), F('mechDate', 'Mechanical work date', 'date'), F('elecDate', 'Electrical work date', 'date'), F('siteReadiness', 'Site readiness status', 'select', { options: ['Ready — customer available', 'Partially ready', 'Not ready'] }), F('toolsSafety', 'Tools, equipment & safety arrangements'), F('dependencies', 'Dependencies and constraints', 'text', { required: false }), F('delayPlan', 'Delay reason & recovery plan', 'text', { required: false })],
    },
    handover: {
      owner: 'Solar Coordinator (support: Technical, Accounts, Service)', roles: ['solar_coordinator', 'doc_coordinator'], approval: ['solar_coordinator'],
      checklist: ['Installation and commissioning — approved status and records', 'System documentation uploaded', 'Equipment information — make, model and serial numbers recorded', 'Warranty start/end dates and conditions recorded', 'Customer demonstration — date and trainer/engineer recorded', 'Operating instructions handed over', 'Monitoring access / setup status recorded', 'Net-metering actual status recorded separately', 'Subsidy actual status recorded separately', 'Outstanding defects closed or formally accepted with owner and due date', 'Customer acceptance — signed / digital acknowledgement', 'Service activation — equipment and customer linked to service'],
      docs: ['Approved quotation / Sales Order reference', 'Final approved BOQ and as-built changes', 'Installation and commissioning report', 'Equipment list and serial numbers', 'Warranty documentation', 'Customer operating and maintenance instructions', 'Test records and relevant certificates', 'Net-metering documents and current status', 'Subsidy documents and current status, where applicable', 'Customer handover / acceptance document', 'Open items, if any, and the agreed closure plan'],
      fields: [F('acceptedBy', 'Customer acceptance — signed by'), F('acceptedOn', 'Acceptance date', 'date'), F('evidence', 'Signed acceptance (document ref)'), F('demoOn', 'Customer demonstration date', 'date'), F('trainer', 'Trainer / engineer'), F('monitoring', 'Monitoring access status', 'select', { options: ['Customer app configured', 'Not applicable', 'Pending'] }), F('warrantyStart', 'Warranty start date', 'date'), F('closureType', 'Closure type', 'select', { options: ['Operational closure', 'Administrative (full) closure'] }), F('outstanding', 'Open items & agreed closure plan', 'text', { required: false })],
    },
  };
  const LIB_SMALL = {
    survey: { optional: true },
    delivery: { checklist: ['Material issued against the approved material list (DC / issue reference)', 'Installation date scheduled with customer', 'Team leader / technicians confirmed', 'Receiving person confirmed quantities at site'] },
    testing: { approval: ['tech_head', 'es_coordinator'], fields: [F('nvrConfig', 'DVR/NVR configuration status', 'select', { options: ['Configured', 'Pending'] })].concat(LIB.testing.fields) },
    handover: {
      approval: null, closes: false,
      checklist: ['Customer demonstration completed', 'Customer user training and acknowledgement recorded', 'Equipment list and DVR/NVR channel mapping handed over', 'Warranty documentation handed over', 'Customer acceptance signed'],
      fields: [F('demoOn', 'Demonstration date', 'date'), F('acceptedBy', 'Customer acceptance — signed by'), F('acceptedOn', 'Acceptance date', 'date'), F('evidence', 'Signed acceptance (document ref)')],
    },
  };
  function stageDef(p, key) {
    const base = LIB[key] || {};
    const ov = p.kind === 'solar' ? LIB_SOLAR[key] : p.kind === 'es_small' ? LIB_SMALL[key] : null;
    const d = Object.assign({ key, label: key }, base, ov || {});
    d.label = ((WF[p.kind] || []).find((x) => x[0] === key) || [key, d.label])[1];
    if (p.kind === 'solar' && d.special === 'devices' && key !== 'commissioning') d.special = null;
    return d;
  }
  const DONE = (s) => !!s && (s.status === 'Completed' || s.status === 'Skipped');
  function st(p, key) { p.stages = p.stages || {}; return p.stages[key] || (p.stages[key] = { status: 'Not Started', done: [], fields: {} }); }
  const workflow = (p) => WF[p.kind] || [];
  function curIndex(p) { const wf = workflow(p); const i = wf.findIndex(([k]) => !DONE((p.stages || {})[k])); return i < 0 ? wf.length : i; }
  const curKey = (p) => (workflow(p)[curIndex(p)] || [null])[0];
  const curLabel = (p) => (p.status === 'Closed' ? 'Closed' : (workflow(p)[curIndex(p)] || [null, 'Completed'])[1]);
  const progressPct = (p) => util.pct(curIndex(p), Math.max(1, workflow(p).length));
  const isActive = (p) => !['Closed', 'Cancelled'].includes(p.status);
  const stageOverdue = (p, key) => { const s = (p.stages || {})[key]; return !!s && !DONE(s) && isPast(s.due); };
  const projOverdue = (p) => isActive(p) && (stageOverdue(p, curKey(p)) || isPast(p.revisedDate || p.committedDate));
  const openRework = (p) => (p.tasks || []).filter((t) => t.kind === 'Rework' && !['Completed', 'Approved', 'Accepted'].includes(t.status));

  // ------------------------------------------------------------------ survey definitions
  const FEAS = ['Feasible', 'Feasible with Conditions', 'Revisit Required', 'Not Feasible'];
  const SURVEY_ES = ['Customer, site address and contact details verified', 'Required security system and coverage objectives confirmed', 'Camera locations and viewing coverage identified', 'Camera type, resolution and lens requirements assessed', 'Indoor/outdoor conditions and environmental protection assessed', 'DVR/NVR location and recording arrangement identified', 'Recording retention requirement documented', 'Network topology, bandwidth and IP requirements assessed', 'PoE switches, power supplies and network equipment identified', 'Cable routes, lengths, conduits and cable-laying requirements recorded', 'Power availability, earthing and surge protection assessed', 'Rack, monitor, UPS and other accessories identified', 'Remote viewing and authorized user access requirements confirmed', 'Civil work, drilling, conduit and ceiling access requirements recorded', 'Site photographs, layout and technical observations uploaded', 'Customer-side dependencies and execution risks recorded'];
  const SURVEY_SOLAR = ['Customer and site details verified', 'Roof / installation area measurements recorded', 'Roof condition and structural suitability assessed', 'Shading and solar exposure assessed', 'Proposed module placement and layout recorded', 'Existing electrical supply and connection details checked', 'Inverter location and cable routing assessed', 'Earthing, lightning protection and safety requirements assessed', 'Civil and structural work requirements identified', 'Material and equipment requirements identified', 'Site photographs and measurements uploaded', 'Feasibility issues, risks and customer dependencies recorded'];
  function surveyFields(p) {
    const eng = master.staff('tech_engineer').concat(master.staff('tech_head')).map((s) => ({ value: s.id, label: s.name }));
    const common = [F('plannedDate', 'Planned visit date', 'date'), F('actualDate', 'Actual visit date', 'date'), F('engineer', 'Assigned technical person', 'select', { options: eng })];
    const tail = [F('feasibility', 'Feasibility / visit outcome', 'select', { options: FEAS }), F('observations', 'Technical observations & restrictions', 'textarea'), F('nextAction', 'Recommended next action'), F('nextOwner', 'Next action owner', 'select', { options: eng.concat(master.staff(p.division === SOL ? 'solar_coordinator' : 'es_coordinator').map((s) => ({ value: s.id, label: s.name }))) }), F('nextDue', 'Next action / follow-up date', 'date'), F('delayReason', 'Reason for delayed / missed visit or incomplete survey', 'text', { required: false })];
    if (p.division === SOL) return common.concat([F('contact', 'Customer/site contact & location'), F('roofType', 'Roof type', 'select', { options: ['RCC flat roof', 'Metal sheet roof', 'Tiled roof', 'Ground mount'] }), F('measurements', 'Roof measurements & usable area'), F('structural', 'Structural details'), F('capacity', 'Proposed system capacity (kWp)', 'number'), F('config', 'Proposed configuration', 'select', { options: ['On-grid', 'Hybrid', 'Other'] }), F('photos', 'Photos and site layout (ref)'), F('addlReqs', 'Additional civil / mechanical / electrical requirements'), F('dependencies', 'Customer-side dependencies')], tail);
    return common.concat([F('systemType', 'System type', 'select', { options: ES_TYPES }), F('equipment', 'Proposed equipment'), F('deviceCount', 'Camera / device count', 'number'), F('locations', 'Proposed locations'), F('cableRoute', 'Cable route'), F('cableLength', 'Estimated cable length (m)', 'number'), F('nvrLocation', 'DVR/NVR and rack location'), F('powerNetwork', 'Power and network requirements'), F('recording', 'Recording and storage requirements'), F('civil', 'Required civil work and accessories'), F('dependencies', 'Existing infrastructure & customer-side dependencies'), F('photos', 'Site photographs, drawings (ref)')], tail);
  }
  const surveyChecklist = (p) => (p.division === SOL ? SURVEY_SOLAR : SURVEY_ES);
  const surveysOf = (pid) => db.find('surveys', (s) => s.projectId === pid).sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
  const latestSurvey = (pid) => { const l = surveysOf(pid); return l[l.length - 1] || null; };

  // ------------------------------------------------------------------ stock master helpers
  const stockItem = (id) => db.get('stock', id);
  const stockName = (id) => (stockItem(id) || {}).name || id;
  const stockBy = (name) => db.one('stock', (s) => s.name === name);
  function reservedTotal(sid, exceptPid) { return sumBy(db.find('projects', (p) => p.id !== exceptPid && isActive(p)), (p) => (p.alloc || {})[sid] || 0); }
  function available(sid, exceptPid, extra) { const s = stockItem(sid); return s ? Math.max(0, s.current - reservedTotal(sid, exceptPid) - (extra || 0)) : 0; }
  function moveStock(sid, delta, type, ref, o) {
    const s = clone(stockItem(sid)); if (!s) return;
    s.current = Math.max(0, s.current + delta);
    s.movements = (s.movements || []).concat({ ts: o && o.at ? new Date(o.at).toISOString() : nowIso(), type, qty: delta, ref }).slice(-25);
    if (delta < 0) { s.lastIssueAt = (o && o.at ? new Date(o.at) : new Date()).toISOString(); s.issued90 = (s.issued90 || 0) + Math.abs(delta); }
    s.lastMovedAt = (o && o.at ? new Date(o.at) : new Date()).toISOString();
    db.update('stock', sid, s, { silent: o && o.silent, note: type + ' ' + (delta > 0 ? '+' : '') + delta + ' (' + ref + ')' });
  }

  // ------------------------------------------------------------------ device schedule generation
  const LOCS = ['Main gate', 'Reception', 'Lobby', 'Parking', 'Corridor F1', 'Corridor F2', 'Store room', 'Production floor', 'Loading bay', 'Perimeter North', 'Perimeter South', 'Staircase', 'Cash counter', 'Server room', 'Lift lobby', 'Terrace', 'Canteen', 'Office bay'];
  const prodId = (name) => (master.products().find((x) => x.name === name) || {}).id || null;
  function genDevices(p, from) {
    const out = (from || []).slice(); let n = out.length;
    const add = (type, name, qty, locFn, chFn) => { for (let i = 0; i < qty; i++) { n++; out.push({ id: 'D' + n, type, name, productId: prodId(name), location: locFn(i), tag: type === 'Camera' ? 'CAM-' + String(out.filter((d) => d.type === 'Camera').length + 1).padStart(2, '0') : type.toUpperCase().replace(/\s+/g, '') + '-' + (i + 1), serial: '', channel: chFn ? chFn(i) : '', test: 'Pending', installed: false }); } };
    if (p.division === SOL) {
      const kw = p.capacityKw || 5;
      add('Inverter', 'Solar Inverter 5kW Grid-tie', Math.max(1, Math.ceil(kw / 5)), () => 'Inverter wall — ground floor');
      add('Module array', 'Mono PERC Panel 540W', 1, () => 'Rooftop array (' + Math.ceil(kw * 1000 / 540) + ' × 540W)');
      add('ACDB/DCDB', 'ACDB/DCDB Set', 1, () => 'Near inverter');
      if (p.config === 'Hybrid') add('Battery', 'Lithium Battery 5kWh', Math.max(1, Math.round(kw / 2.5)), () => 'Battery rack');
      return out;
    }
    if (p.systemType === 'CCTV' || p.cameraCount) {
      const cams = p.cameraCount || 0;
      const existing = out.filter((d) => d.type === 'Camera').length;
      const ptz = from ? 0 : (cams > 24 ? Math.floor(cams / 24) : 0);
      const need = cams - existing;
      if (need > 0) {
        const dome = Math.round((need - ptz) * 0.55);
        const chOf = (i) => { const k = existing + i; return 'NVR-' + (Math.floor(k / 32) + 1) + ' / CH' + String((k % 32) + 1).padStart(2, '0'); };
        add('Camera', 'IP Dome Camera 4MP', dome, (i) => LOCS[(existing + i) % LOCS.length] + (existing + i >= LOCS.length ? ' ' + Math.ceil((existing + i + 1) / LOCS.length) : ''), chOf);
        add('Camera', 'IP Bullet Camera 4MP', need - ptz - dome, (i) => LOCS[(existing + dome + i + 3) % LOCS.length] + ' outdoor', (i) => chOf(dome + i));
        add('Camera', 'PTZ Camera 2MP 25x', ptz, () => 'Perimeter PTZ', (i) => chOf(need - ptz + i));
      } else if (need < 0) {
        let drop = -need;
        for (let i = out.length - 1; i >= 0 && drop > 0; i--) if (out[i].type === 'Camera' && !out[i].installed) { out.splice(i, 1); drop--; }
      }
      if (!from) {
        const nvrs = Math.max(1, Math.ceil(cams / 32));
        add('NVR', cams > 16 ? 'NVR 32 Channel' : 'NVR 16 Channel', nvrs, () => 'Server / rack room');
        add('PoE Switch', 'PoE Switch 16 Port', Math.max(1, Math.ceil(cams / 16)), () => 'Network rack');
        add('HDD', 'Surveillance HDD 4TB', nvrs * (cams > 16 ? 4 : 2), () => 'Inside NVR');
      }
      return out;
    }
    const map = { 'Access Control': 'Access Controller 2-Door', Biometric: 'Biometric Attendance Terminal', 'Video Door Phone': 'Video Door Phone 7"', 'PA System': 'PA Amplifier 240W', 'Fire Alarm': 'Fire Alarm Panel 4 Zone' };
    const name = map[p.systemType] || 'Access Controller 2-Door';
    add(p.systemType || 'Device', name, Math.max(1, p.deviceQty || 1), (i) => LOCS[i % LOCS.length]);
    if (p.systemType === 'Fire Alarm') add('Detector', 'Smoke Detector', 12, (i) => LOCS[i % LOCS.length]);
    return out;
  }
  function devicesGate(p) {
    const ds = p.devices || [];
    if (!ds.length) return 'Device schedule is empty.';
    const pend = ds.filter((d) => !d.installed);
    if (pend.length) return pend.length + ' device(s) are not yet marked installed in the device schedule.';
    const noSer = ds.filter((d) => !d.serial && ['Camera', 'NVR', 'Inverter', 'Battery', 'Module array'].includes(d.type));
    if (noSer.length) return noSer.length + ' device(s) are missing serial numbers.';
    const noCh = ds.filter((d) => d.type === 'Camera' && !d.channel);
    if (noCh.length) return noCh.length + ' camera(s) are not mapped to a DVR/NVR channel.';
    return null;
  }
  const cameraCountOf = (p) => (p.devices || []).filter((d) => d.type === 'Camera').length;

  // ------------------------------------------------------------------ BOQ
  const boqsOf = (pid) => db.find('boqs', (b) => b.projectId === pid).sort((a, b) => a.version - b.version);
  const latestBoq = (pid) => { const l = boqsOf(pid); return l[l.length - 1] || null; };
  const approvedBoq = (pid) => { const l = boqsOf(pid).filter((b) => b.status === 'Approved'); return l[l.length - 1] || null; };
  const boqValue = (b) => sumBy(b ? b.items : [], (i) => i.qty * i.rate);
  const BOQ_CAT_ES = ['Cameras', 'Recording', 'Network', 'Cabling', 'Power', 'Mounting', 'Infrastructure', 'Display', 'Other security equipment'];
  const BOQ_CAT_SOL = ['Modules', 'Inverter', 'Mounting structure', 'DC cabling', 'AC cabling & protection', 'Earthing & lightning protection', 'Monitoring', 'Battery', 'Civil & accessories'];
  function boqDraftItems(p, at) {
    const items = [];
    const need = util.addDays(at || new Date(), p.kind === 'es_small' ? 4 : 12);
    const add = (name, qty, cat, remarks) => { const s = stockBy(name); if (!s || qty <= 0) return; const ex = items.find((i) => i.stockId === s.id); if (ex) { ex.qty += qty; return; } items.push({ stockId: s.id, code: s.code, desc: s.name, make: s.brand + ' ' + s.model, category: cat, qty, unit: s.unit, rate: s.purchaseCost, requiredAt: isoD(need), remarks: remarks || '' }); };
    if (p.division === SOL) {
      const kw = p.capacityKw || 5;
      add('Mono PERC Panel 540W', Math.ceil(kw * 1000 / 540), 'Modules', 'DCR modules if subsidy applicable');
      add('Solar Inverter 5kW Grid-tie', Math.max(1, Math.ceil(kw / 5)), 'Inverter');
      add('GI Mounting Structure (per kWp)', Math.ceil(kw), 'Mounting structure', 'Hot-dip galvanised, wind-load certified');
      add('Solar DC Cable 4 sq.mm (m)', Math.round(kw * 25), 'DC cabling');
      add('AC Cable 6 sq.mm (m)', 30, 'AC cabling & protection');
      add('ACDB/DCDB Set', 1, 'AC cabling & protection');
      add('Earthing Kit', 3, 'Earthing & lightning protection');
      add('Lightning Arrester', 1, 'Earthing & lightning protection');
      add('Monitoring Wi-Fi Dongle', 1, 'Monitoring');
      if (p.config === 'Hybrid') add('Lithium Battery 5kWh', Math.max(1, Math.round(kw / 2.5)), 'Battery');
      return items;
    }
    const catOf = { Camera: 'Cameras', NVR: 'Recording', HDD: 'Recording', 'PoE Switch': 'Network' };
    (p.devices || []).forEach((d) => add(d.name, 1, catOf[d.type] || 'Other security equipment'));
    const cams = p.cameraCount || (p.devices || []).length;
    add('Cat6 UTP Cable (m)', cams * 40, 'Cabling', 'Outdoor-rated for perimeter runs');
    add('PVC Conduit 25mm (m)', cams * 25, 'Infrastructure');
    add('RJ45 Connectors (pkt of 100)', Math.max(1, Math.ceil(cams * 2 / 100)), 'Infrastructure');
    add('Junction Box', cams, 'Mounting');
    if (p.kind === 'es_large') { add('6U Network Rack', 1, 'Mounting'); add('Online UPS 1KVA (rack)', 1, 'Power'); }
    if (p.systemType === 'CCTV' || p.cameraCount) add('24" LED Monitor', 1, 'Display');
    return items;
  }
  // Net requirement per stock item = approved BOQ + approved additional-material requests.
  function needs(p) {
    const b = approvedBoq(p.id);
    const req = {};
    (b ? b.items : []).forEach((i) => { req[i.stockId] = (req[i.stockId] || 0) + i.qty; });
    (p.addl || []).filter((a) => a.status === 'Approved').forEach((a) => { req[a.stockId] = (req[a.stockId] || 0) + a.qty; });
    const transit = inTransit(p);
    return Object.keys(req).map((sid) => {
      const alloc = (p.alloc || {})[sid] || 0, site = (p.siteOk || {})[sid] || 0, tr = transit[sid] || 0;
      const need = req[sid];
      return { stockId: sid, need, alloc, transit: tr, site, issued: (p.issued || {})[sid] || 0, returned: (p.returned || {})[sid] || 0, used: (p.used || {})[sid] || 0, short: Math.max(0, need - alloc - tr - site), avail: available(sid, p.id) };
    });
  }
  function inTransit(p) { const m = {}; db.find('dcs', (d) => d.projectId === p.id && ['Picking', 'Dispatched'].includes(d.status)).forEach((d) => d.items.forEach((i) => { m[i.stockId] = (m[i.stockId] || 0) + i.qty; })); return m; }
  const shortages = (p) => needs(p).filter((x) => x.short > 0);
  const materialReady = (p) => !!approvedBoq(p.id) && !shortages(p).length;
  const deliveryComplete = (p) => !!approvedBoq(p.id) && needs(p).every((x) => x.site >= x.need) && !db.one('dcs', (d) => d.projectId === p.id && d.status === 'Discrepancy');
  function cableVariance(p) {
    const f = st(p, p.kind === 'es_small' ? 'install' : 'cable').fields;
    const pl = Number(f.plannedLength) || 0, ac = Number(f.actualLength) || 0;
    return pl ? Math.round(((ac - pl) / pl) * 1000) / 10 : 0;
  }
  function handoverGate(p) {
    const k = p.kind === 'solar' ? 'commissioning' : 'testing';
    if (!DONE(st(p, k))) return 'Testing & commissioning must be approved before handover.';
    const s = st(p, 'handover'); const d = stageDef(p, 'handover');
    if (d.docs && (s.docsDone || []).length < d.docs.length) return 'Handover document pack is incomplete (' + (s.docsDone || []).length + ' of ' + d.docs.length + ' documents).';
    if (!yes(s.fields.evidence) || !yes(s.fields.acceptedBy)) return 'Customer handover must have recorded evidence (signed acceptance).';
    const rw = openRework(p).filter((t) => !t.accepted);
    if (rw.length) return rw.length + ' outstanding defect / rework task(s) must be closed or formally accepted.';
    return null;
  }
  function complianceGate(p) {
    const nm = db.one('netMetering', (n) => n.projectId === p.id);
    if (!nm || NM_STATUS.indexOf(nm.status) < 3) return 'Net-metering application has not been submitted to the utility yet (status: ' + (nm ? nm.status : 'none') + ').';
    if (nm.status === 'Rejected') return 'Net-metering application was rejected — resubmission is required.';
    const sb = db.one('subsidies', (s) => s.projectId === p.id);
    if (sb && sb.eligibility === 'Pending') return 'Subsidy eligibility has not been verified against the applicable scheme.';
    if (sb && sb.eligibility === 'Eligible' && SUB_STATUS.indexOf(sb.status) < 3) return 'Subsidy application has not been submitted on the portal yet.';
    return null;
  }

  // ------------------------------------------------------------------ project creation (order.won and manual)
  function classifyES(o) {
    const cams = Number(o.cameraCount) || 0;
    if ((o.systemType === 'CCTV' || !o.systemType) && cams > 0) return cams > 16 ? 'es_large' : 'es_small';
    return 'es_pending';
  }
  function createProject(o, ctx) {
    ctx = ctx || {};
    const at = ctx.at ? new Date(ctx.at) : new Date();
    const c = cust(o.customerId);
    const prodRec = o.productId ? master.product(o.productId) : null;
    const division = o.division;
    const p = {
      division, orderId: o.id || null, soNumber: o.soNumber || ('SO-' + util.rand(24000, 26999)), customerId: o.customerId, siteId: (master.sites(o.customerId)[0] || {}).id || null,
      value: Number(o.value) || 0, priority: o.priority || (Number(o.value) > 1000000 ? 'High' : 'Medium'), status: 'Active', createdAt: at.toISOString(), orderDate: isoD(at),
      coordinator: division === SOL ? 'EMP-solar_coordinator' : 'EMP-es_coordinator', engineer: ctx.engineer || null, installLead: ctx.installLead || null, vendorId: ctx.vendorId || null, installMode: ctx.installMode || null,
      stages: {}, tasks: [], history: [], alloc: {}, issued: {}, siteOk: {}, returned: {}, used: {}, addl: [], scopeChanges: [], kindHistory: [], dateRevisions: [], viol: [],
    };
    if (division === SOL) {
      p.kind = 'solar';
      const kwMatch = prodRec && /([\d.]+)\s*kW/i.exec(prodRec.name);
      p.capacityKw = Number(o.capacityKw) || (kwMatch ? Number(kwMatch[1]) * (Number(o.quantity) || 1) : 5);
      p.config = prodRec && prodRec.category === 'Hybrid' ? 'Hybrid' : (o.config || 'On-grid');
      p.projectType = c.segment === 'Residential' ? 'Residential' : c.segment === 'Industrial' ? 'Industrial' : 'Commercial';
    } else {
      p.systemType = o.systemType || (prodRec ? prodRec.category : 'CCTV');
      if (!ES_TYPES.includes(p.systemType)) p.systemType = 'CCTV';
      p.cameraCount = Number(o.cameraCount) || (p.systemType === 'CCTV' ? Math.max(4, Number(o.quantity) || 8) : 0);
      p.deviceQty = p.systemType === 'CCTV' ? 0 : Math.max(1, Number(o.quantity) || 1);
      p.kind = p.systemType === 'CCTV' ? classifyES(p) : 'es_pending';
      p.architecture = p.cameraCount > 32 ? 'Multi-site / Networked' : p.cameraCount > 16 ? 'Networked' : 'Standalone';
    }
    const prefix = p.kind === 'solar' ? 'PRJ-SOL' : p.kind === 'es_small' ? 'JOB-ES' : 'PRJ-ES';
    p.id = CRM.nextId(prefix);
    p.devices = p.kind === 'es_pending' && !p.deviceQty ? [] : genDevices(p);
    planDues(p, at);
    p.history.push({ ts: at.toISOString(), by: ctx.by || 'System', text: 'Project auto-created from Sales Order ' + p.soNumber + ' — classified as ' + KIND[p.kind] + (p.kind === 'es_pending' ? ' (non-CCTV: authorized user to select workflow)' : p.division === ESD ? ' (' + p.cameraCount + ' cameras; rule: >16 = Large)' : ' (' + p.capacityKw + ' kWp ' + p.config + ')') });
    const rec = db.insert('projects', p, { silent: !!ctx.silent, note: 'Created from SO ' + p.soNumber });
    if (division === SOL) {
      db.insert('netMetering', { projectId: p.id, customerId: p.customerId, consumerNo: '', status: 'Not Started', owner: 'EMP-doc_coordinator', docs: [], plannedSubmit: null, log: [{ ts: at.toISOString(), by: 'System', text: 'Net-metering workstream opened' }] }, { prefix: 'NM', silent: !!ctx.silent });
      db.insert('subsidies', { projectId: p.id, customerId: p.customerId, scheme: p.projectType === 'Residential' && p.capacityKw <= 10 ? SCHEMES[0] : SCHEMES[2], eligibility: 'Pending', status: 'Eligibility Check', docs: [], owner: 'EMP-doc_coordinator', comms: [], log: [{ ts: at.toISOString(), by: 'System', text: 'Subsidy tracker opened — eligibility to be verified (not assumed)' }] }, { prefix: 'SUB', silent: !!ctx.silent });
    }
    if (!ctx.silent) {
      const to = division === SOL ? 'solar_coordinator' : 'es_coordinator';
      CRM.notify({ to, title: 'New ' + KIND[p.kind] + ' created: ' + p.id, body: c.name + ' · SO ' + p.soNumber + ' · ' + (division === SOL ? p.capacityKw + ' kWp' : p.cameraCount ? p.cameraCount + ' cameras' : p.systemType) + '. Please accept and assign.', link: plink(p.id), severity: 'info', key: 'new-' + p.id });
      if (p.kind === 'es_pending') CRM.notify({ to: ['es_coordinator', 'tech_head'], title: 'Select installation workflow for ' + p.id, body: p.systemType + ' order without camera count — classify as Large project or Small installation by approved complexity.', link: plink(p.id), severity: 'warn', key: 'cls-' + p.id });
    }
    return rec;
  }
  function planDues(p, at) {
    let t = new Date(at);
    const dur = p.kind === 'es_small' ? DUR_SMALL : DUR;
    const scale = p.kind === 'es_large' ? (p.cameraCount > 48 ? 1.4 : 1.15) : p.kind === 'solar' && p.capacityKw > 20 ? 1.4 : 1;
    workflow(p).forEach(([k]) => { t = util.addDays(t, Math.max(1, Math.round((dur[k] || 3) * scale))); const s = st(p, k); s.due = isoD(t); });
    if (!p.committedDate) p.committedDate = isoD(util.addDays(t, 2));
  }
  function getP(id) { const p = db.get('projects', id); return p ? clone(p) : null; }
  function commit(p, note, o) { return db.update('projects', p.id, p, { note, silent: o && o.silent }); }
  function hist(p, text, o) { p.history = (p.history || []).concat({ ts: o && o.at ? new Date(o.at).toISOString() : nowIso(), by: (o && o.by) || user().name, text }); }

  // ------------------------------------------------------------------ policy violations (emitted to the ODM desk via service module)
  function raise(col, rec, type, o) {
    o = o || {};
    if (!rec) return false;
    rec.viol = rec.viol || [];
    if (rec.viol.some((v) => v.type === type)) return false;
    const p = col === 'projects' ? rec : rec.projectId ? db.get('projects', rec.projectId) : null;
    const division = o.division || (p ? p.division : rec.division || ESD);
    const v = { type, ts: o.at ? new Date(o.at).toISOString() : nowIso(), severity: o.severity || 'Medium', owner: o.owner || (p ? p.coordinator : null), policyRef: o.policyRef || (division === SOL ? 'Solar CRM §9.4' : 'ES CRM §10.4'), details: o.details || '', division, emitted: false };
    rec.viol.push(v);
    if (booted && !seeding) { emitViolation(col, rec, v); v.emitted = true; }
    db.update(col, rec.id, { viol: clone(rec.viol) }, { silent: true });
    return true;
  }
  function emitViolation(col, r, v) {
    const p = col === 'projects' ? r : r.projectId ? db.get('projects', r.projectId) : null;
    const link = p ? plink(p.id) : '#/' + ({ purchaseRequests: 'purchase-requests', purchaseOrders: 'purchase-orders', dcs: 'dc', scrap: 'scrap', netMetering: 'net-metering', subsidies: 'subsidy' })[col];
    const division = v.division || (p ? p.division : ESD);
    CRM.emit('violation.raise', { division, type: v.type, policyRef: v.policyRef, owner: v.owner, severity: v.severity, recordId: r.id, link, details: v.details });
    CRM.notify({ to: ['odm', division === SOL ? 'solar_coordinator' : division === ESD ? 'es_coordinator' : 'service_coordinator'], title: 'Policy violation: ' + v.type, body: r.id + ' — ' + v.details, link, severity: 'bad', key: 'viol-' + r.id + '-' + v.type });
  }
  // violations recorded during seeding are emitted once every module has registered its listeners (on ready)
  function flushViolations() {
    ['projects', 'purchaseRequests', 'purchaseOrders', 'dcs', 'scrap', 'netMetering', 'subsidies'].forEach((col) => db.all(col).forEach((r) => {
      if (!(r.viol || []).some((v) => !v.emitted)) return;
      const viol = clone(r.viol);
      viol.filter((v) => !v.emitted).forEach((v) => { emitViolation(col, r, v); v.emitted = true; });
      db.update(col, r.id, { viol }, { silent: true });
    }));
  }
  const allViolations = () => ['projects', 'purchaseRequests', 'purchaseOrders', 'dcs', 'scrap', 'netMetering', 'subsidies'].flatMap((col) => db.all(col).flatMap((r) => (r.viol || []).map((v) => Object.assign({ col, recId: r.id, projectId: col === 'projects' ? r.id : r.projectId, division: col === 'projects' ? r.division : r.projectId ? (db.get('projects', r.projectId) || {}).division : r.division }, v))));

  // ------------------------------------------------------------------ tasks (installation, rework, follow-up)
  function addTask(p, t, o) {
    const task = Object.assign({ id: 'TSK-' + util.uid().slice(0, 6).toUpperCase(), status: 'Planned', createdAt: o && o.at ? new Date(o.at).toISOString() : nowIso() }, t);
    p.tasks = (p.tasks || []).concat(task);
    if (!(o && o.silent)) {
      const s = db.get('staff', task.assignee);
      CRM.notify({ to: s ? s.role : 'install_lead', title: (task.kind === 'Rework' ? 'Rework task: ' : 'Task assigned: ') + task.title, body: p.id + ' · due ' + fmt.date(task.due), link: s && s.role === 'vendor' ? '#/vendor-tasks' : plink(p.id), severity: task.kind === 'Rework' ? 'warn' : 'info', key: 'task-' + task.id });
    }
    return task;
  }
  function createInstallTasks(p, o) {
    const at = o && o.at ? new Date(o.at) : new Date();
    const vendor = p.installMode !== 'Own team' ? p.vendorId : null;
    const lead = p.installLead || 'EMP-install_lead';
    const plan = p.kind === 'solar'
      ? [['civil', 'Civil work — structure foundation & roof preparation', vendor || lead], ['mechanical', 'Mechanical — mounting structure & module installation', vendor || lead], ['electrical', 'Electrical — DC/AC wiring, inverter, earthing & protection', lead], ['commissioning', 'Testing & commissioning records', p.engineer]]
      : p.kind === 'es_small' ? [['install', 'Cable laying & device installation', vendor || lead], ['testing', 'DVR/NVR configuration & testing', p.engineer]]
        : [['cable', 'Cable laying — conduits, routes, termination & labelling', vendor || lead], ['nvr', 'DVR/NVR installation & configuration', p.engineer], ['cameras', 'Camera installation & channel mapping', lead], ['testing', 'Configuration, testing & commissioning', p.engineer]];
    plan.forEach(([k, title, who]) => { if (!(p.tasks || []).some((t) => t.stageKey === k && t.kind === 'Installation')) addTask(p, { kind: 'Installation', stageKey: k, title, assignee: who || lead, due: st(p, k).due || isoD(util.addDays(at, 5)) }, Object.assign({}, o, { at })); });
  }

  // ------------------------------------------------------------------ stage engine
  const allowEdit = (p, d) => can(d.roles || []) && isActive(p) && p.status !== 'On Hold';
  function predecessorsDone(p, key) { const wf = workflow(p); const i = wf.findIndex((x) => x[0] === key); return wf.slice(0, i).every(([k]) => DONE(st(p, k))); }
  function validateStage(p, key) {
    const d = stageDef(p, key), s = st(p, key);
    if (p.status === 'On Hold') return 'Project is on hold (' + (p.holdReason || 'no reason') + ').';
    if (!predecessorsDone(p, key)) return 'Predecessor stages are not complete — a project must not move forward merely because a status is changed.';
    if (d.checklist && (s.done || []).length < d.checklist.length) return 'Checklist incomplete: ' + (s.done || []).length + ' of ' + d.checklist.length + ' items checked.';
    const miss = (d.fields || []).filter((f) => f.required && !yes(s.fields[f.key])).map((f) => f.label);
    if (miss.length) return 'Mandatory fields missing: ' + miss.slice(0, 4).join(', ') + (miss.length > 4 ? '…' : '');
    return d.gate ? d.gate(p) : null;
  }
  function startStage(p, key, o) {
    const s = st(p, key);
    if (s.status === 'Not Started' || s.status === 'Planned') { s.status = 'In Progress'; s.startedAt = o && o.at ? new Date(o.at).toISOString() : nowIso(); }
  }
  // returns { ok, msg }
  function submitStage(p, key, o) {
    o = o || {};
    const d = stageDef(p, key), s = st(p, key);
    if (['testing', 'commissioning', 'cable'].includes(key) && s.fields.testResult === 'Fail') return failTest(p, key, o);
    const err = validateStage(p, key);
    if (err) return { ok: false, msg: err };
    startStage(p, key, o);
    if (d.approval && d.approval.length) {
      s.status = 'Submitted for Inspection'; s.submittedAt = o.at ? new Date(o.at).toISOString() : nowIso();
      hist(p, d.label + ' submitted for inspection / approval', o);
      (p.tasks || []).forEach((t) => { if (t.stageKey === key && t.kind === 'Installation' && !['Completed'].includes(t.status)) t.status = 'Submitted for Inspection'; });
      if (!o.silent) CRM.notify({ to: d.approval, title: 'Approval required: ' + d.label + ' — ' + p.id, body: cust(p.customerId).name + ' · submitted by ' + user().name, link: plink(p.id), severity: 'warn', key: 'appr-' + p.id + '-' + key + '-' + (s.reworkCount || 0) });
      return { ok: true, msg: 'Submitted for inspection — approval by ' + d.approval.map((r) => CRM.role(r).name).join(' / ') };
    }
    completeStage(p, key, o);
    return { ok: true, msg: d.label + ' completed' };
  }
  function approveStage(p, key, o) {
    o = o || {};
    const d = stageDef(p, key), s = st(p, key);
    if (s.status !== 'Submitted for Inspection') return { ok: false, msg: 'Stage is not awaiting approval.' };
    const err = validateStage(p, key);
    if (err) return { ok: false, msg: err };
    s.approvedBy = o.by || user().name; s.approvedAt = o.at ? new Date(o.at).toISOString() : nowIso();
    completeStage(p, key, o);
    return { ok: true, msg: d.label + ' approved' };
  }
  function rejectStage(p, key, reason, o) {
    o = o || {};
    const d = stageDef(p, key), s = st(p, key);
    s.status = 'Rework Required'; s.reworkCount = (s.reworkCount || 0) + 1;
    (p.tasks || []).forEach((t) => { if (t.stageKey === key && t.kind === 'Installation' && t.status !== 'Completed') t.status = 'Rework Required'; });
    const owner = ['cable', 'cameras', 'install', 'civil', 'mechanical', 'electrical'].includes(key) ? (p.installMode === 'Vendor' && p.vendorId ? p.vendorId : p.installLead || 'EMP-install_lead') : p.engineer || 'EMP-tech_engineer';
    addTask(p, { kind: 'Rework', stageKey: key, title: 'Rework — ' + d.label + ': ' + reason, assignee: owner, due: isoD(util.addDays(o.at || new Date(), 3)), status: 'Planned' }, o);
    hist(p, d.label + ' inspection failed — rework required: ' + reason, o);
    return { ok: true, msg: 'Rework task created with owner ' + sName(owner) + ' and due date' };
  }
  function failTest(p, key, o) {
    const d = stageDef(p, key), s = st(p, key);
    startStage(p, key, o);
    s.status = 'Rework Required'; s.reworkCount = (s.reworkCount || 0) + 1; s.fields.testResult = '';
    const owner = key === 'cable' ? (p.installLead || 'EMP-install_lead') : (p.engineer || 'EMP-tech_engineer');
    addTask(p, { kind: 'Rework', stageKey: key, title: (key === 'cable' ? 'Corrective work — failed cable test / damaged cable' : 'Rework — failed ' + d.label.toLowerCase()), assignee: owner, due: isoD(util.addDays(o && o.at ? o.at : new Date(), 3)) }, o);
    hist(p, d.label + ': test FAILED — rework task created for ' + sName(owner), o);
    return { ok: true, msg: 'Test failed — rework task created (owner ' + sName(owner) + ', due in 3 days)', tone: 'warn' };
  }
  function completeStage(p, key, o) {
    o = o || {};
    const d = stageDef(p, key), s = st(p, key);
    if (!s.startedAt) s.startedAt = o.at ? new Date(o.at).toISOString() : nowIso();
    s.status = 'Completed'; s.doneAt = o.at ? new Date(o.at).toISOString() : nowIso();
    (p.tasks || []).forEach((t) => { if (t.stageKey === key && t.kind === 'Installation') { t.status = 'Completed'; t.doneAt = t.doneAt || s.doneAt; } });
    hist(p, d.label + ' completed' + (s.approvedBy ? ' — approved by ' + s.approvedBy : ''), o);
    const coordRole = p.division === SOL ? 'solar_coordinator' : 'es_coordinator';
    if (key === 'so') { p.acceptedAt = p.acceptedAt || s.doneAt; }
    if (key === 'scope' && /^No/.test(s.fields.siteVisit || '')) { const sv = st(p, 'survey'); sv.status = 'Skipped'; sv.doneAt = s.doneAt; sv.skipReason = 'Site visit not required — ' + (s.fields.policyNote || 'straightforward job, policy permits'); hist(p, 'Site visit skipped as permitted by policy', o); }
    if (key === 'planning' || (key === 'delivery' && p.kind === 'es_small')) createInstallTasks(p, o);
    if (key === 'install') { const pl = Number(s.fields.plannedLength) || 0; if (pl && cableVariance(p) > 10) raise('projects', p, 'Cable or material consumption beyond approved limit', { severity: 'Medium', at: o.at, details: 'Cable used ' + s.fields.actualLength + ' m vs planned ' + pl + ' m (+' + cableVariance(p) + '%)' }); }
    if ((key === 'testing' || key === 'commissioning') && !o.silent) CRM.notify({ to: [coordRole, 'doc_coordinator'], title: 'Commissioning completed — initiate handover: ' + p.id, body: cust(p.customerId).name + ' · handover document checklist is now open', link: plink(p.id), severity: 'ok', key: 'comm-' + p.id });
    if (d.closes) closeProject(p, o);
  }
  function equipmentList(p) {
    return (p.devices || []).map((d) => ({ productId: d.productId, name: d.name, serial: d.serial, location: d.location, channel: d.channel, tag: d.tag, type: d.type }));
  }
  function closeProject(p, o) {
    o = o || {};
    const at = o.at ? new Date(o.at) : new Date();
    p.status = 'Closed'; p.closedAt = at.toISOString();
    const hs = st(p, 'handover');
    p.handoverAt = hs.fields.acceptedOn || isoD(at);
    // release unused reservations back to free stock
    p.alloc = {};
    hist(p, 'Project closed — equipment, warranty, service history and PM eligibility activated (project.handover emitted)', o);
    if (!o.silent) {
      setTimeout(() => {
        const rec = db.get('projects', p.id);
        CRM.emit('project.handover', { project: rec, equipment: equipmentList(rec) });
      });
      CRM.notify({ to: ['service_coordinator', 'pm_coordinator'], title: 'Project handed over: ' + p.id, body: cust(p.customerId).name + ' · ' + (p.devices || []).length + ' equipment records to activate under warranty / PM', link: plink(p.id), severity: 'ok', key: 'ho-' + p.id });
    }
  }

  // ------------------------------------------------------------------ procurement chain
  function reserve(p, o) {
    let n = 0;
    needs(p).forEach((x) => { const take = Math.min(x.short, available(x.stockId, p.id)); if (take > 0) { p.alloc[x.stockId] = (p.alloc[x.stockId] || 0) + take; n += take; } });
    if (n) hist(p, 'Material reserved from stock against approved BOQ (' + n + ' units)', o);
    return n;
  }
  function createPR(data, o) {
    o = o || {};
    const at = o.at ? new Date(o.at) : new Date();
    const pr = db.insert('purchaseRequests', Object.assign({ status: 'Pending Approval', createdAt: at.toISOString(), requestedBy: o.by || user().name, viol: [] }, data), { prefix: 'PR', silent: o.silent, note: 'Purchase requisition created' });
    if (!o.silent) CRM.notify({ to: ['gm'], title: 'PR awaiting approval: ' + pr.id, body: (data.projectId ? data.projectId + ' · ' : '') + pr.items.length + ' item(s) · ' + data.purpose, link: '#/purchase-requests', severity: 'warn', key: 'pr-' + pr.id });
    return pr;
  }
  function prFromShortage(p, o) {
    const b = approvedBoq(p.id);
    const sh = shortages(p).map((x) => ({ stockId: x.stockId, qty: x.short - Math.min(x.short, x.avail) })).filter((x) => x.qty > 0);
    const open = db.find('purchaseRequests', (r) => r.projectId === p.id && !['Rejected', 'Closed'].includes(r.status));
    const pending = {}; open.forEach((r) => { if (r.status === 'PO Raised') db.find('purchaseOrders', (po) => po.prId === r.id && !['Received', 'Cancelled'].includes(po.status)).forEach((po) => po.items.forEach((i) => { pending[i.stockId] = (pending[i.stockId] || 0) + i.qty - (i.received || 0); })); else r.items.forEach((i) => { pending[i.stockId] = (pending[i.stockId] || 0) + i.qty; }); });
    const items = sh.map((x) => ({ stockId: x.stockId, qty: x.qty - (pending[x.stockId] || 0) })).filter((x) => x.qty > 0);
    if (!items.length) return null;
    return createPR({ projectId: p.id, boqId: b ? b.id : null, boqVersion: b ? b.version : null, division: p.division, purpose: 'Project', trigger: 'Project requirement', items, requiredDate: b ? b.items[0].requiredAt : isoD(util.addDays(new Date(), 7)), status: 'Draft', autoDraft: true }, o);
  }
  function createPO(pr, supplier, promised, terms, o) {
    o = o || {};
    const at = o.at ? new Date(o.at) : new Date();
    const items = pr.items.map((i) => { const s = stockItem(i.stockId); return { stockId: i.stockId, qty: i.qty, rate: Math.round(s.purchaseCost * (o.rateFactor || 1)), received: 0 }; });
    const boq = pr.boqId ? db.get('boqs', pr.boqId) : null;
    const budget = sumBy(items, (i) => i.qty * ((boq && (boq.items.find((b) => b.stockId === i.stockId) || {}).rate) || stockItem(i.stockId).purchaseCost));
    const po = db.insert('purchaseOrders', { prId: pr.id, projectId: pr.projectId || null, division: pr.division, supplier, items, poDate: isoD(at), promisedDate: promised, paymentTerms: terms || '30 days credit', status: 'Issued', createdAt: at.toISOString(), budget, value: sumBy(items, (i) => i.qty * i.rate), exception: o.exception || null, viol: [] }, { prefix: 'PO', silent: o.silent, note: 'PO issued to ' + supplier });
    db.update('purchaseRequests', pr.id, { status: 'PO Raised', poId: po.id }, { silent: o.silent });
    return po;
  }
  function receiveGRN(po, lines, extra, o) {
    o = o || {};
    const at = o.at ? new Date(o.at) : new Date();
    const g = db.insert('grns', Object.assign({ type: 'Purchase GRN', poId: po.id, projectId: po.projectId, supplier: po.supplier, items: lines, warehouse: 'Main Warehouse', receivedDate: isoD(at), status: 'Pending Inspection', createdAt: at.toISOString(), receivedBy: o.by || user().name }, extra || {}), { prefix: 'GRN', silent: o.silent, note: 'GRN against ' + po.id });
    const items = po.items.map((i) => { const l = lines.find((x) => x.stockId === i.stockId); return Object.assign({}, i, { received: (i.received || 0) + (l ? l.received : 0) }); });
    const full = items.every((i) => i.received >= i.qty);
    db.update('purchaseOrders', po.id, { items, status: full ? 'Received' : 'Partially Received', receivedAt: at.toISOString(), grnIds: (po.grnIds || []).concat(g.id), delayReason: po.delayReason || (new Date(po.promisedDate) < at ? 'Supplier dispatch delay' : '') }, { silent: o.silent });
    return g;
  }
  function inspectGRN(g, passed, o) {
    o = o || {};
    const at = o.at ? new Date(o.at) : new Date();
    const lines = g.items.map((l) => passed ? l : Object.assign({}, l, { accepted: 0, rejected: l.received }));
    db.update('grns', g.id, { items: lines, status: passed ? 'Accepted' : 'Rejected', inspectedAt: at.toISOString(), inspectedBy: o.by || user().name, inspection: passed ? 'Passed' : 'Failed' }, { silent: o.silent, note: 'QC inspection ' + (passed ? 'passed' : 'failed') });
    if (!passed) return null;
    lines.forEach((l) => { if (l.accepted > 0) moveStock(l.stockId, l.accepted, 'GRN inward', g.id, o); });
    // project allocation of accepted material
    if (g.projectId) {
      const p = getP(g.projectId);
      if (p && isActive(p)) {
        let n = 0;
        needs(p).forEach((x) => { const l = lines.find((y) => y.stockId === x.stockId); if (!l) return; const take = Math.min(x.short, l.accepted); if (take > 0) { p.alloc[x.stockId] = (p.alloc[x.stockId] || 0) + take; n += take; } });
        if (n) hist(p, 'GRN ' + g.id + ' inspected — ' + n + ' units allocated to project', o);
        commit(p, 'Project allocation from ' + g.id, o);
        if (!o.silent) {
          CRM.notify({ to: p.division === SOL ? 'solar_coordinator' : 'es_coordinator', title: 'Material received: ' + p.id, body: g.id + ' accepted & allocated', link: plink(p.id), severity: 'info', key: 'mr-' + g.id });
          if (materialReady(p)) CRM.notify({ to: [p.division === SOL ? 'solar_coordinator' : 'es_coordinator'], title: 'All required materials available: ' + p.id, body: 'Material ready for dispatch to site', link: plink(p.id), severity: 'ok', key: 'ready-' + p.id });
        }
      }
    }
    return lines;
  }
  function createDC(p, o, extra) {
    o = o || {};
    const at = o.at ? new Date(o.at) : new Date();
    const items = Object.keys(p.alloc || {}).filter((sid) => p.alloc[sid] > 0).map((sid) => ({ stockId: sid, qty: p.alloc[sid] }));
    if (!items.length) return null;
    const site = master.sites(p.customerId).find((s) => s.id === p.siteId) || master.sites(p.customerId)[0] || {};
    const dc = db.insert('dcs', Object.assign({ linkType: 'Project', linkId: p.id, projectId: p.id, customerId: p.customerId, siteAddress: site.address || cust(p.customerId).area, purpose: p.kind === 'solar' ? 'Project material dispatch' : 'Installation material dispatch', items, store: 'Main Warehouse', dispatchedBy: o.by || user().name, vehicle: 'TN 37 ' + util.pick(['BK', 'CX', 'DM']) + ' ' + util.rand(1000, 9999), dispatchDate: isoD(at), status: 'Dispatched', createdAt: at.toISOString(), viol: [] }, extra || {}), { prefix: 'DC', silent: o.silent, note: 'DC generated for ' + p.id });
    items.forEach((i) => { moveStock(i.stockId, -i.qty, 'DC dispatch', dc.id, o); p.issued[i.stockId] = (p.issued[i.stockId] || 0) + i.qty; p.alloc[i.stockId] = 0; });
    hist(p, 'Material dispatched on ' + dc.id + ' (' + items.length + ' line items)', o);
    return dc;
  }
  function confirmDC(dc, receipt, receiver, o) {
    o = o || {};
    const at = o.at ? new Date(o.at) : new Date();
    const items = dc.items.map((i) => { const r = receipt[i.stockId] || {}; const short = Number(r.short) || 0, damaged = Number(r.damaged) || 0; return Object.assign({}, i, { accepted: i.qty - short - damaged, short, damaged }); });
    const disc = items.some((i) => i.short || i.damaged);
    db.update('dcs', dc.id, { items, status: disc ? 'Discrepancy' : 'Delivered', receiver, receivedAt: at.toISOString(), evidence: o.evidence || 'Signed DC copy + site photos', exception: disc ? { ts: at.toISOString(), text: items.filter((i) => i.short || i.damaged).map((i) => stockName(i.stockId) + ': short ' + i.short + ', damaged ' + i.damaged).join('; '), resolved: false } : null }, { silent: o.silent, note: disc ? 'Site receipt with discrepancy' : 'Site receipt confirmed' });
    if (dc.projectId) {
      const p = getP(dc.projectId);
      items.forEach((i) => { p.siteOk[i.stockId] = (p.siteOk[i.stockId] || 0) + i.accepted; });
      hist(p, 'Site receipt of ' + dc.id + ' confirmed by ' + receiver + (disc ? ' — DISCREPANCY exception recorded' : ''), o);
      commit(p, 'Site receipt ' + dc.id, o);
      if (!o.silent) CRM.notify({ to: p.division === SOL ? 'solar_coordinator' : 'es_coordinator', title: (disc ? 'Delivery discrepancy: ' : 'Material received at site: ') + p.id, body: dc.id + (disc ? ' — short/damaged items need replacement' : ' — readiness status updated'), link: plink(p.id), severity: disc ? 'warn' : 'ok', key: 'dcr-' + dc.id });
    }
  }

  // ------------------------------------------------------------------ shared view helpers
  const PHASES = [['Order & survey', ['so', 'scope', 'survey']], ['BOQ & procurement', ['boq', 'procurement']], ['Delivery & planning', ['delivery', 'planning']], ['Installation', ['cable', 'nvr', 'cameras', 'install', 'civil', 'mechanical', 'electrical']], ['Testing & commissioning', ['testing', 'commissioning']], ['Compliance & handover', ['compliance', 'handover', 'activate']]];
  const phaseOf = (p) => (p.status === 'Closed' ? 'Closed' : (PHASES.find((x) => x[1].includes(curKey(p))) || ['Order & survey'])[0]);
  const kindBadge = (p) => ui.badge(KIND[p.kind], KIND_TONE[p.kind]);
  function statusBadge(p) {
    if (p.status === 'Active') return projOverdue(p) ? ui.badge('Overdue', 'bad') : ui.badge('On track', 'ok');
    return ui.badge(p.status, p.status === 'Closed' ? 'ok' : p.status === 'On Hold' ? 'warn' : 'bad');
  }
  const scopeText = (p) => (p.division === SOL ? p.capacityKw + ' kWp ' + (p.config || '') : p.cameraCount ? p.cameraCount + ' cameras' : (p.systemType || '') + (p.deviceQty ? ' × ' + p.deviceQty : ''));
  const coordRoleOf = (p) => (p.division === SOL ? 'solar_coordinator' : 'es_coordinator');
  function myProjects() {
    const u = user(), all = db.all('projects');
    if (CRM.is('tech_engineer')) return all.filter((p) => p.engineer === u.id || (p.tasks || []).some((t) => t.assignee === u.id));
    if (CRM.is('install_lead')) return all.filter((p) => p.installLead === u.id || (p.tasks || []).some((t) => t.assignee === u.id));
    if (CRM.is('es_coordinator')) return all.filter((p) => p.division === ESD);
    if (CRM.is('solar_coordinator', 'doc_coordinator')) return all.filter((p) => p.division === SOL);
    if (CRM.is('vendor')) return [];
    return all;
  }
  const viewRow = (p) => Object.assign({}, p, { kindLabel: KIND[p.kind], customerName: cust(p.customerId).name, stageLabel: curLabel(p), phase: phaseOf(p) });
  function projectColumns(opts) {
    opts = opts || {};
    return [
      { key: 'id', label: 'Project / Job ID', render: (p) => pLink(p.id) },
      { key: 'soNumber', label: 'SO', render: (p) => mono(p.soNumber) },
      { key: 'customerName', label: 'Customer' },
      { key: 'division', label: 'Division', render: (p) => ui.divTag(p.division) },
      { key: 'kindLabel', label: 'Category', render: (p) => kindBadge(p) },
      { key: 'scope', label: 'Scope', render: (p) => scopeText(p) },
      { key: 'stageLabel', label: 'Current stage', sort: (p) => curIndex(p), render: (p) => h('div', { style: 'min-width:150px' }, [h('div', { class: 'small' }, curLabel(p)), ui.progress(progressPct(p))]) },
      { key: 'committedDate', label: 'Committed', render: (p) => h('div', {}, [fmt.date(p.committedDate), p.revisedDate ? h('div', { class: 'small muted' }, 'Revised ' + fmt.date(p.revisedDate)) : null]) },
      opts.value && !CRM.is('vendor') ? { key: 'value', label: 'Value', cls: 'right', render: (p) => fmt.lakh(p.value) } : null,
      { key: 'status', label: 'Status', render: (p) => statusBadge(p) },
    ].filter(Boolean);
  }
  function projectTable(rows, opts) {
    return ui.table(Object.assign({ rows: () => (typeof rows === 'function' ? rows() : rows).map(viewRow), onRow: (p) => CRM.go('projects', p.id), columns: projectColumns({ value: true }), pageSize: 12 }, opts || {}));
  }

  // ------------------------------------------------------------------ Projects register page
  function renderProjects(el, params) {
    if (params[0]) return renderProject(el, params[0], params[1]);
    const rows = myProjects();
    const act = rows.filter(isActive);
    const canNew = can('es_coordinator', 'solar_coordinator');
    ui.page(el, { title: 'Projects & Installation Jobs', sub: 'ES large projects (>16 cameras), small installation jobs (≤16) and Solar projects — auto-created from won Sales Orders', actions: [canNew ? ui.btn('+ Manual project from SO', newProjectForm, 'primary') : null] });
    el.appendChild(ui.kpis([
      { label: 'Active', value: act.length, meta: rows.length + ' total' },
      { label: 'Large projects', value: act.filter((p) => p.kind === 'es_large').length, color: 'var(--div-security)' },
      { label: 'Small jobs', value: act.filter((p) => p.kind === 'es_small').length, color: 'var(--chart-5)' },
      { label: 'Solar projects', value: act.filter((p) => p.kind === 'solar').length, color: 'var(--div-solar)' },
      { label: 'Overdue', value: act.filter(projOverdue).length, color: 'var(--bad)', tone: 'down', meta: 'stage or committed date' },
      { label: 'On hold', value: rows.filter((p) => p.status === 'On Hold').length, color: 'var(--warn)' },
      { label: 'Awaiting classification', value: rows.filter((p) => p.kind === 'es_pending' && isActive(p)).length, color: 'var(--chart-4)' },
    ]));
    el.appendChild(ui.tabs([{ id: 'reg', label: 'Register', count: rows.length }, { id: 'board', label: 'Stage board' }, { id: 'hold', label: 'Hold / classification' }], (id, body) => {
      if (id === 'reg') body.appendChild(ui.card(null, projectTable(rows, { filters: [{ key: 'kindLabel', label: 'categories', options: Object.values(KIND) }, { key: 'status', label: 'statuses', options: ['Active', 'On Hold', 'Closed', 'Cancelled'] }, { key: 'division', label: 'divisions', options: [ESD, SOL] }, { key: 'phase', label: 'phases', options: PHASES.map((x) => x[0]).concat('Closed') }], toolbar: [exportBtn('projects', projectColumns().map((c) => ({ label: c.label, csv: (p) => (c.key === 'stageLabel' ? curLabel(p) : c.key === 'scope' ? scopeText(p) : c.key === 'kindLabel' ? KIND[p.kind] : c.key === 'customerName' ? cust(p.customerId).name : p[c.key]) })), () => rows)] }), { flush: true }));
      if (id === 'board') body.appendChild(ui.kanban({ columns: PHASES.map((x, i) => ({ id: x[0], label: x[0], color: 'var(--chart-' + ((i % 6) + 1) + ')' })).concat({ id: 'Closed', label: 'Closed', color: 'var(--ok)' }), items: rows.filter((p) => p.status !== 'Cancelled'), colOf: phaseOf, onClick: (p) => CRM.go('projects', p.id), card: (p) => [h('div', { class: 't' }, p.id), h('div', {}, cust(p.customerId).name), h('div', { class: 'row small', style: 'margin-top:4px' }, [kindBadge(p), statusBadge(p)]), h('div', { class: 'small muted', style: 'margin-top:4px' }, curLabel(p) + ' · ' + scopeText(p))] }));
      if (id === 'hold') {
        const hold = rows.filter((p) => p.status === 'On Hold' || (p.kind === 'es_pending' && isActive(p)));
        body.appendChild(ui.card('Projects on hold and reasons / awaiting workflow selection', ui.table({ rows: hold.map(viewRow), onRow: (p) => CRM.go('projects', p.id), columns: [{ key: 'id', label: 'ID', render: (p) => pLink(p.id) }, { key: 'customerName', label: 'Customer' }, { key: 'kindLabel', label: 'Category', render: (p) => kindBadge(p) }, { key: 'holdReason', label: 'Reason', render: (p) => p.holdReason || (p.kind === 'es_pending' ? 'Non-CCTV order — authorized user must select workflow by approved complexity' : '—') }, { key: 'holdAt', label: 'Since', render: (p) => fmt.date(p.holdAt || p.createdAt) }], empty: 'Nothing on hold' }), { flush: true }));
      }
    }));
  }
  function newProjectForm() {
    const sol = CRM.is('solar_coordinator');
    ui.formModal('Create project from Sales Order', [
      { key: 'division', label: 'Division', type: 'select', required: true, options: sol ? [SOL] : CRM.is('es_coordinator') ? [ESD] : [ESD, SOL], default: sol ? SOL : ESD },
      { key: 'soNumber', label: 'Sales Order number', required: true, placeholder: 'SO-25xxx' },
      { key: 'customerId', label: 'Customer', type: 'select', required: true, options: master.customers().map((c) => ({ value: c.id, label: c.name + ' (' + c.id + ')' })) },
      { key: 'value', label: 'Project value (₹)', type: 'number', required: true },
      { key: 'systemType', label: 'ES system type', type: 'select', options: ES_TYPES, hint: 'Electronic Security only' },
      { key: 'cameraCount', label: 'Camera count', type: 'number', hint: '>16 → Large project; ≤16 (incl. exactly 16) → Small installation' },
      { key: 'quantity', label: 'Device quantity (non-CCTV)', type: 'number' },
      { key: 'capacityKw', label: 'Solar capacity (kWp)', type: 'number', hint: 'Solar only' },
      { key: 'config', label: 'Solar configuration', type: 'select', options: ['On-grid', 'Hybrid'] },
    ], {}, (v) => {
      if (db.one('projects', (p) => p.soNumber === v.soNumber)) { ui.toast('Duplicate prevented — a project already exists for ' + v.soNumber, 'bad'); return false; }
      const p = createProject(Object.assign({}, v, { cameraCount: v.systemType === 'CCTV' ? v.cameraCount : 0 }), { by: user().name });
      ui.toast(p.id + ' created as ' + KIND[p.kind], 'ok');
      CRM.go('projects', p.id);
    });
  }

  // ------------------------------------------------------------------ project detail workspace
  function renderProject(el, id, selKey) {
    const p = db.get('projects', id);
    if (!p) { el.appendChild(ui.empty('Project not found')); return; }
    const c = cust(p.customerId), wf = workflow(p), ci = curIndex(p);
    const key = selKey && wf.some((x) => x[0] === selKey) ? selKey : (wf[ci] || wf[wf.length - 1] || [null])[0];
    const isCoord = can(coordRoleOf(p));
    ui.page(el, {
      title: p.id + ' · ' + c.name, crumbs: 'Projects › ' + KIND[p.kind] + ' › SO ' + p.soNumber,
      sub: p.division + ' · ' + scopeText(p) + ' · committed ' + fmt.date(p.committedDate) + (p.revisedDate ? ' (revised ' + fmt.date(p.revisedDate) + ')' : ''),
      actions: [ui.btn('← Register', () => CRM.go('projects')),
        isCoord && isActive(p) ? ui.btn('Project setup', () => setupForm(p)) : null,
        can(coordRoleOf(p), 'tech_head') && isActive(p) && p.kind !== 'es_pending' ? ui.btn('Scope change', () => scopeChangeForm(p)) : null,
        isCoord && p.status === 'Active' ? ui.btn('Put on hold', () => holdForm(p)) : null,
        isCoord && p.status === 'On Hold' && !/Technical review/.test(p.holdReason || '') ? ui.btn('Resume', () => { const q = getP(p.id); q.status = 'Active'; hist(q, 'Resumed from hold'); commit(q, 'Resumed'); CRM.refresh(); }, 'primary') : null,
        can(coordRoleOf(p), 'gm') && isActive(p) ? ui.btn('Cancel', () => cancelForm(p), 'danger') : null],
    });
    // status strip — Solar keeps physical installation, commissioning, grid/net-meter, subsidy and handover separate
    const strip = [ui.divTag(p.division), kindBadge(p), statusBadge(p), ui.badge('Priority: ' + p.priority, p.priority === 'High' ? 'bad' : 'info')];
    if (p.kind === 'solar') {
      const nm = db.one('netMetering', (n) => n.projectId === p.id), sb = db.one('subsidies', (s) => s.projectId === p.id);
      strip.push(ui.badge('Physical installation: ' + (DONE(st(p, 'electrical')) ? 'Completed' : 'Pending'), DONE(st(p, 'electrical')) ? 'ok' : ''), ui.badge('Commissioning: ' + (DONE(st(p, 'commissioning')) ? 'Completed' : 'Pending'), DONE(st(p, 'commissioning')) ? 'ok' : ''), ui.badge('Grid / net-meter: ' + (nm ? nm.status : '—'), nm && nm.status === 'Completed' ? 'ok' : 'info'), ui.badge('Subsidy: ' + (sb ? (sb.eligibility === 'Not Eligible' ? 'Not eligible' : sb.status) : '—'), 'violet'), ui.badge('Handover: ' + (DONE(st(p, 'handover')) ? 'Completed' : 'Pending'), DONE(st(p, 'handover')) ? 'ok' : ''));
    }
    el.appendChild(h('div', { class: 'row', style: 'margin:-6px 0 12px' }, strip));
    if (p.status === 'On Hold') el.appendChild(h('div', { style: 'margin-bottom:12px' }, [ui.callout('<b>On hold:</b> ' + util.esc(p.holdReason || '') + ' (since ' + fmt.date(p.holdAt) + ')', 'warn'), /Technical review/.test(p.holdReason || '') && can('tech_head') ? h('div', { class: 'row mt' }, [ui.btn('Technical review: approve revisit / revised scope', () => techReview(p, true), 'primary'), ui.btn('Technical review: cancel project', () => techReview(p, false), 'danger')]) : null]));
    if (p.kind === 'es_pending') { el.appendChild(classifyCard(p)); }
    if (p.boqRevisionRequired) el.appendChild(h('div', { style: 'margin-bottom:12px' }, ui.callout('<b>Scope changed</b> — a revised BOQ and reclassification check are required. Purchase orders and the committed date may be affected.', 'warn')));
    // stepper (click to inspect any stage)
    const stepper = ui.stepper(wf.map((x) => x[1]), ci, p.status === 'On Hold' || (wf[ci] && st(p, wf[ci][0]).status === 'Rework Required'));
    Array.from(stepper.children).forEach((n, i) => { n.style.cursor = 'pointer'; n.title = 'Open ' + wf[i][1]; if (wf[i][0] === key) n.style.textDecoration = 'underline'; n.addEventListener('click', () => CRM.go('projects', p.id, wf[i][0])); });
    if (wf.length) el.appendChild(ui.card(null, stepper));
    const grid = h('div', { class: 'grid g3 mt' });
    grid.appendChild(h('div', { class: 'span2' }, key && p.kind !== 'es_pending' ? stagePanel(p, key) : ui.card('Stage', ui.empty('Select a workflow to begin'))));
    grid.appendChild(h('div', { class: 'stack' }, [infoCard(p), alertsCard(p)]));
    el.appendChild(grid);
    el.appendChild(h('div', { class: 'mt' }, ui.tabs([{ id: 'ov', label: 'Plan vs actual' }, { id: 'mat', label: 'Materials' }, { id: 'dev', label: p.division === SOL ? 'Equipment' : 'Camera / device schedule', count: (p.devices || []).length }, { id: 'tasks', label: 'Tasks', count: (p.tasks || []).length }, { id: 'hist', label: 'History' }, { id: 'audit', label: 'Audit trail' }], (t, body) => {
      if (t === 'ov') body.appendChild(ui.card('Stage plan versus actual (Gantt)', h('div', { class: 'stack' }, [gantt(p), stageTable(p)])));
      if (t === 'mat') body.appendChild(materialsTab(p));
      if (t === 'dev') body.appendChild(deviceSchedule(p, false));
      if (t === 'tasks') body.appendChild(tasksCard(p));
      if (t === 'hist') body.appendChild(ui.card('Project history (original job history retained across reclassification)', ui.timeline((p.history || []).slice().reverse().map((x) => ({ when: fmt.dateTime(x.ts) + ' · ' + x.by, title: x.text })))));
      if (t === 'audit') body.appendChild(ui.card('Audit trail', ui.auditTrail('projects', p.id)));
    })));
  }
  function infoCard(p) {
    const site = master.sites(p.customerId).find((s) => s.id === p.siteId) || {};
    const pairs = [['Project ID', p.id], ['Sales Order', p.soNumber], ['Customer', h('a', { href: '#/customer360/' + p.customerId }, cust(p.customerId).name)], ['Site', (site.name || '') + ' — ' + (site.address || '')], ['Site contact', (site.contact || '') + ' ' + (site.phone || '')]];
    if (p.division === SOL) pairs.push(['Capacity / config', p.capacityKw + ' kWp · ' + p.config], ['Project type', p.projectType]);
    else pairs.push(['Project type', p.systemType], ['Camera count', p.cameraCount || '—'], ['Other devices', util.countBy((p.devices || []).filter((d) => d.type !== 'Camera'), 'type') && Object.entries(util.countBy((p.devices || []).filter((d) => d.type !== 'Camera'), 'type')).map(([k, v]) => k + ' ×' + v).join(', ')], ['Architecture', p.architecture]);
    if (!CRM.is('vendor')) pairs.push(['Project value', fmt.money(p.value)]);
    pairs.push(['Coordinator', sName(p.coordinator)], ['Technical engineer', p.engineer ? sName(p.engineer) : ui.badge('Unassigned', 'warn')], ['Team leader', sName(p.installLead)], ['Installation mode', p.installMode || '—'], ['Vendor', p.vendorId ? sName(p.vendorId) : '—'], ['Order received', fmt.date(p.createdAt)], ['Accepted', p.acceptedAt ? fmt.date(p.acceptedAt) : ui.badge('Not accepted', 'warn')], ['Original committed', fmt.date(p.committedDate)], ['Approved revised', p.revisedDate ? fmt.date(p.revisedDate) : '—'], ['SO → today', Math.max(0, util.daysBetween(p.createdAt, p.closedAt || T0)) + ' days']);
    return ui.card('Project details', ui.dl(pairs));
  }
  function alertsCard(p) {
    const out = [];
    if (isActive(p) && !p.acceptedAt && util.daysBetween(p.createdAt, T0) > 1) out.push(ui.callout('Not accepted / assigned beyond the handover SLA (1 day).', 'bad'));
    const k = curKey(p);
    if (k && stageOverdue(p, k)) out.push(ui.callout('<b>' + util.esc(curLabel(p)) + '</b> overdue by ' + daysLate(st(p, k).due) + ' day(s).' + (st(p, k).delayReason ? ' Reason: ' + util.esc(st(p, k).delayReason) : ' <b>No delay reason recorded.</b>'), 'bad'));
    const sh = approvedBoq(p.id) ? shortages(p) : [];
    if (sh.length && isActive(p)) out.push(ui.callout('Material shortage on ' + sh.length + ' item(s): ' + sh.slice(0, 3).map((x) => util.esc(stockName(x.stockId)) + ' (' + x.short + ')').join(', '), 'warn'));
    if (openRework(p).length) out.push(ui.callout(openRework(p).length + ' open rework / corrective task(s) — outstanding defects remain visible until closed or accepted.', 'warn'));
    (p.viol || []).forEach((v) => out.push(ui.callout('Policy violation: <b>' + util.esc(v.type) + '</b> — ' + util.esc(v.details), 'bad')));
    if (!out.length) out.push(ui.callout('No open alerts for this project.', 'ok'));
    return ui.card('Alerts & controls', h('div', { class: 'stack', style: 'gap:8px' }, out));
  }
  function gantt(p) {
    const wf = workflow(p); if (!wf.length) return ui.empty('No workflow');
    const start = new Date(p.createdAt);
    const ends = wf.map(([k]) => st(p, k)).flatMap((s) => [s.due, s.doneAt].filter(Boolean).map((d) => new Date(d)));
    const end = new Date(Math.max(T0, util.addDays(start, 5), ...ends));
    const span = Math.max(1, end - start);
    const pos = (d) => Math.max(0, Math.min(100, ((new Date(d) - start) / span) * 100));
    let prevDue = start;
    const rows = wf.map(([k, label]) => {
      const s = st(p, k); const pStart = prevDue; prevDue = s.due ? new Date(s.due) : prevDue;
      const aStart = s.startedAt, aEnd = s.doneAt || (s.startedAt ? T0 : null);
      const late = s.due && (s.doneAt ? new Date(s.doneAt) > util.addDays(new Date(s.due), 1) : isPast(s.due));
      return h('div', { style: 'display:grid;grid-template-columns:170px 1fr;gap:8px;align-items:center;font-size:12px' }, [
        h('div', { style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, label),
        h('div', { style: 'position:relative;height:18px;background:var(--surface-3);border-radius:4px' }, [
          s.due ? h('div', { title: 'Planned ' + fmt.date(pStart) + ' → ' + fmt.date(s.due), style: 'position:absolute;top:2px;height:6px;border-radius:3px;background:var(--border-strong);left:' + pos(pStart) + '%;width:' + Math.max(1, pos(s.due) - pos(pStart)) + '%' }) : null,
          aStart ? h('div', { title: 'Actual ' + fmt.date(aStart) + ' → ' + (s.doneAt ? fmt.date(s.doneAt) : 'in progress'), style: 'position:absolute;top:9px;height:7px;border-radius:3px;background:' + (late ? 'var(--bad)' : DONE(s) ? 'var(--ok)' : 'var(--chart-1)') + ';left:' + pos(aStart) + '%;width:' + Math.max(1, pos(aEnd) - pos(aStart)) + '%' }) : null,
          h('div', { style: 'position:absolute;top:0;bottom:0;width:2px;background:var(--warn);left:' + pos(T0) + '%', title: 'Today' }),
        ]),
      ]);
    });
    return h('div', { class: 'stack', style: 'gap:6px' }, rows.concat(h('div', { class: 'legend' }, [h('span', {}, [h('i', { style: 'background:var(--border-strong)' }), 'Planned']), h('span', {}, [h('i', { style: 'background:var(--ok)' }), 'Actual (on time)']), h('span', {}, [h('i', { style: 'background:var(--bad)' }), 'Actual (late)']), h('span', {}, [h('i', { style: 'background:var(--warn)' }), 'Today'])])));
  }
  function stageTable(p) {
    return ui.table({ search: false, pageSize: 20, rows: workflow(p).map(([k, label], i) => Object.assign({ k, label, i }, st(p, k))), columns: [{ key: 'label', label: 'Stage', render: (r) => h('a', { href: plink(p.id) + '/' + r.k }, (r.i + 1) + '. ' + r.label) }, { key: 'owner', label: 'Owner', render: (r) => stageDef(p, r.k).owner }, { key: 'status', label: 'Status', render: (r) => ui.badge(r.status) }, { key: 'due', label: 'Due', render: (r) => fmt.date(r.due) }, { key: 'startedAt', label: 'Started', render: (r) => fmt.date(r.startedAt) }, { key: 'doneAt', label: 'Completed', render: (r) => fmt.date(r.doneAt) }, { key: 'late', label: 'Δ days', render: (r) => { const d = r.due ? daysLate(r.due, r.doneAt) : 0; return r.due && (r.doneAt || isPast(r.due)) ? ui.badge((d > 0 ? '+' : '') + d, d > 0 ? 'bad' : 'ok') : '—'; } }, { key: 'reworkCount', label: 'Rework', render: (r) => r.reworkCount || 0 }, { key: 'approvedBy', label: 'Approved by' }] });
  }

  // ------------------------------------------------------------------ stage panel (checklists, mandatory fields, gates, approvals)
  function stagePanel(p, key) {
    const d = stageDef(p, key), s = st(p, key);
    const editable = allowEdit(p, d) && !DONE(s) && s.status !== 'Submitted for Inspection';
    const body = h('div', { class: 'stack', style: 'gap:12px' });
    body.appendChild(ui.dl([['Responsible', d.owner], ['Status', ui.badge(s.status)], ['Planned due', h('span', {}, [fmt.date(s.due), stageOverdue(p, key) ? ' ' : '', stageOverdue(p, key) ? ui.badge('Overdue ' + daysLate(s.due) + 'd', 'bad') : ''])], ['Started / completed', fmt.date(s.startedAt) + ' → ' + fmt.date(s.doneAt)], d.approval ? ['Approval by', d.approval.map((r) => CRM.role(r).name).join(' / ')] : null, s.approvedBy ? ['Approved by', s.approvedBy + ' · ' + fmt.dateTime(s.approvedAt)] : null, s.skipReason ? ['Skipped', s.skipReason] : null, s.exception ? ['Authorized exception', s.exception] : null]));
    if (!DONE(s)) {
      const err = predecessorsDone(p, key) ? null : 'Waiting for predecessor stages.';
      const g = err || validateStage(p, key);
      if (g) body.appendChild(ui.callout('<b>Gate:</b> ' + util.esc(g), 'warn'));
      else body.appendChild(ui.callout('All checks, mandatory fields and gates are satisfied for this stage.', 'ok'));
    }
    if (key === 'install') body.appendChild(ui.callout('Control: the job cannot be closed just because the engineer marks the physical work complete — testing, customer handover and coordinator-approved activation remain mandatory.', 'info'));
    if (stageOverdue(p, key)) body.appendChild(delayReasonBox(p, key));
    if (d.special === 'survey') body.appendChild(surveyPanel(p));
    if (d.special === 'boq') body.appendChild(boqPanel(p));
    if (d.special === 'procurement') body.appendChild(procurementPanel(p));
    if (d.special === 'delivery') body.appendChild(deliveryPanel(p));
    if (d.special === 'devices') body.appendChild(deviceSchedule(p, true));
    if (d.special === 'compliance') body.appendChild(compliancePanel(p));
    if (key === 'so') body.appendChild(ui.callout('Original committed date is frozen at ' + fmt.date(p.committedDate) + '; approved revisions are tracked separately. Use <b>Project setup</b> to assign the coordinator, technical engineer, team and installation mode.', 'info'));
    if ((key === 'cable' || key === 'install') && yes(s.fields.actualLength)) body.appendChild(ui.callout('Cable variance: <b>' + cableVariance(p) + '%</b> vs plan (permitted ±10%).' + (s.varianceApproved ? ' Additional consumption approved by ' + util.esc(s.varianceApproved) + '.' : ''), cableVariance(p) > 10 && !s.varianceApproved ? 'bad' : 'ok'));
    if (d.checklist) {
      const obj = {}; (s.done || []).forEach((i) => { obj[d.checklist[i]] = true; });
      body.appendChild(h('div', {}, [h('h3', { style: 'margin-bottom:6px' }, 'Checklist'), ui.checklist(d.checklist, obj, (o) => { const q = getP(p.id); st(q, key).done = d.checklist.map((it, i) => (o[it] ? i : -1)).filter((i) => i >= 0); startStage(q, key); commit(q, d.label + ' checklist updated'); }, !editable)]));
    }
    if (d.docs) {
      const obj = {}; (s.docsDone || []).forEach((i) => { obj[d.docs[i]] = true; });
      body.appendChild(h('div', {}, [h('h3', { style: 'margin-bottom:6px' }, 'Handover document pack'), ui.checklist(d.docs, obj, (o) => { const q = getP(p.id); st(q, key).docsDone = d.docs.map((it, i) => (o[it] ? i : -1)).filter((i) => i >= 0); commit(q, 'Handover document pack updated'); }, !editable)]));
    }
    let form = null;
    if (d.fields) { form = ui.form(d.fields, s.fields); if (!editable) Object.values(form.inputs).forEach((i) => { i.disabled = true; }); body.appendChild(h('div', {}, [h('h3', { style: 'margin-bottom:8px' }, 'Mandatory fields'), form])); }
    const saveFields = (q) => { if (!form) return true; const v = form.values(); const bad = Object.keys(v).find((k) => CREDENTIAL_RX.test(String(v[k] || ''))); if (bad) { ui.toast('Blocked: device passwords / secrets must not be stored in notes. Use the secure credential vault.', 'bad'); return false; } Object.assign(st(q, key).fields, v); return true; };
    const acts = [];
    if (editable) {
      if (form) acts.push(ui.btn('Save', () => { const q = getP(p.id); if (!saveFields(q)) return; startStage(q, key); if ((key === 'cable' || key === 'install') && cableVariance(q) > 10 && !st(q, key).varianceApproved) { raise('projects', q, 'Cable or material consumption beyond approved limit', { severity: 'Medium', details: 'Actual ' + st(q, key).fields.actualLength + ' m vs planned ' + st(q, key).fields.plannedLength + ' m (+' + cableVariance(q) + '%)' }); CRM.notify({ to: 'tech_head', title: 'Additional cable approval needed: ' + p.id, body: '+' + cableVariance(q) + '% over plan', link: plink(p.id) + '/' + key, severity: 'warn', key: 'cv-' + p.id + '-' + st(q, key).fields.actualLength }); } commit(q, d.label + ' fields saved'); ui.toast('Saved', 'ok'); CRM.refresh(); }));
      if (s.status === 'Not Started' || s.status === 'Planned') acts.push(ui.btn('Start stage', () => tryStart(p, key)));
      acts.push(ui.btn(d.approval ? 'Submit for inspection / approval' : 'Mark stage complete', () => { const q = getP(p.id); if (!saveFields(q)) return; if (['cable', 'install', 'civil'].includes(key) && !deliveryComplete(q) && !st(q, key).exception) { ui.toast('Blocked: installation cannot start before material readiness is confirmed', 'bad'); return; } const r = submitStage(q, key); if (!r.ok) { ui.toast(r.msg, 'bad'); commit(q, d.label + ' saved'); CRM.refresh(); return; } commit(q, r.msg); ui.toast(r.msg, r.tone || 'ok'); CRM.refresh(); }, 'primary'));
    }
    if (s.status === 'Submitted for Inspection' && can(d.approval || []) && isActive(p)) {
      acts.push(ui.btn('Approve', () => { const q = getP(p.id); const r = approveStage(q, key); if (!r.ok) { ui.toast(r.msg, 'bad'); return; } commit(q, r.msg); ui.toast(r.msg, 'ok'); CRM.refresh(); }, 'ok'));
      acts.push(ui.btn('Reject → rework', () => ui.formModal('Inspection failed — create rework task', [{ key: 'reason', label: 'Defect / reason', required: true, type: 'textarea' }], {}, (v) => { const q = getP(p.id); const r = rejectStage(q, key, v.reason); commit(q, 'Inspection failed: ' + v.reason); ui.toast(r.msg, 'warn'); CRM.refresh(); }), 'danger'));
    }
    if ((key === 'cable' || key === 'install') && can('tech_head') && cableVariance(p) > 10 && !s.varianceApproved) acts.push(ui.btn('Approve additional cable', () => ui.formModal('Additional material approval', [{ key: 'reason', label: 'Reason / cost impact', required: true }], {}, (v) => { const q = getP(p.id); st(q, key).varianceApproved = user().name + ' — ' + v.reason; hist(q, 'Additional cable consumption approved: ' + v.reason); commit(q, 'Cable variance approved'); CRM.refresh(); })));
    if (d.closes && !DONE(s) && CRM.is('gm', 'admin') && isActive(p) && validateStage(p, key)) acts.push(ui.btn('Administrative closure (authorized exception)', () => ui.formModal('Close with authorized exception', [{ key: 'reason', label: 'Exception reason & approved closure plan', required: true, type: 'textarea' }], {}, (v) => { const q = getP(p.id); const qs = st(q, key); qs.exception = 'Closed by ' + user().name + ' — ' + v.reason; raise('projects', q, 'Project closed without mandatory handover documents', { severity: 'High', details: validateStage(q, key) + ' — exception: ' + v.reason }); qs.status = 'Completed'; qs.doneAt = nowIso(); qs.approvedBy = user().name + ' (exception)'; closeProject(q); commit(q, 'Closed under authorized exception'); ui.toast('Closed under authorized exception — violation recorded', 'warn'); CRM.refresh(); }), 'danger'));
    return ui.card((workflow(p).findIndex((x) => x[0] === key) + 1) + '. ' + d.label, body, { actions: acts.length ? acts : [ui.badge(DONE(s) ? 'Read-only (completed)' : 'View only')] });
  }
  function tryStart(p, key) {
    const q = getP(p.id);
    if (!predecessorsDone(q, key)) { ui.toast('Predecessor stages are not complete', 'bad'); return; }
    if (['cable', 'install', 'civil'].includes(key) && !deliveryComplete(q)) {
      ui.modal({ title: 'Installation readiness not approved', body: ui.callout('Material site receipt is not fully verified for this project. Installation must not start before the required readiness approval.<br>An authorized user (Technical Head / GM) may record an exception — this is logged as a policy violation.', 'bad'), actions: [{ label: 'Close' }, can('tech_head', 'gm') ? { label: 'Start with authorized exception', cls: 'danger', onClick: () => { const r = getP(p.id); st(r, key).exception = 'Started before readiness — authorized by ' + user().name; startStage(r, key); raise('projects', r, 'Installation started before required readiness approval', { severity: 'High', details: 'Stage ' + stageDef(r, key).label + ' started with material receipt pending' }); hist(r, 'Installation started under authorized exception'); commit(r, 'Started with exception'); CRM.refresh(); } } : null].filter(Boolean) });
      return;
    }
    startStage(q, key); hist(q, stageDef(q, key).label + ' started'); commit(q, 'Stage started'); CRM.refresh();
  }
  function delayReasonBox(p, key) {
    const s = st(p, key);
    const inp = h('input', { type: 'text', value: s.delayReason || '', placeholder: 'Delay reason, next action and responsible person', style: 'flex:1;min-width:220px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:7px' });
    return h('div', { class: 'row' }, [h('b', { class: 'small' }, 'Delay reason:'), inp, ui.btn('Record', () => { if (!inp.value.trim()) return; const q = getP(p.id); st(q, key).delayReason = inp.value.trim(); hist(q, 'Delay reason recorded for ' + stageDef(q, key).label + ': ' + inp.value.trim()); commit(q, 'Delay reason recorded'); ui.toast('Delay reason recorded', 'ok'); }, 'sm')]);
  }
  function classifyCard(p) {
    const body = h('div', { class: 'stack', style: 'gap:10px' }, [ui.callout('This ' + util.esc(p.systemType) + ' order has no camera count. Camera count alone must not classify a non-CCTV project — an authorized user selects the installation workflow based on approved project complexity.', 'warn')]);
    if (can('es_coordinator', 'tech_head')) body.appendChild(h('div', { class: 'row' }, [ui.btn('Use Large project workflow', () => classify(p, 'es_large'), 'primary'), ui.btn('Use Small installation workflow', () => classify(p, 'es_small'))]));
    return h('div', { style: 'margin-bottom:12px' }, ui.card('Workflow selection required', body));
  }
  function classify(p, kind) {
    ui.formModal('Select workflow — ' + KIND[kind], [{ key: 'reason', label: 'Approved project complexity / justification', required: true, type: 'textarea' }, { key: 'qty', label: 'Device quantity', type: 'number', default: p.deviceQty || 1 }], {}, (v) => {
      const q = getP(p.id);
      q.kindHistory = (q.kindHistory || []).concat({ ts: nowIso(), from: q.kind, to: kind, by: user().name, reason: v.reason });
      q.kind = kind; q.deviceQty = v.qty || q.deviceQty; q.devices = genDevices(q); q.stages = { so: q.stages.so || { status: 'Not Started', done: [], fields: {} } }; planDues(q, new Date());
      hist(q, 'Workflow selected: ' + KIND[kind] + ' — ' + v.reason); commit(q, 'Classified as ' + KIND[kind]); ui.toast('Workflow set to ' + KIND[kind], 'ok'); CRM.refresh();
    });
  }
  function staffOpts(roles) { return [].concat(roles).flatMap((r) => master.staff(r)).map((s) => ({ value: s.id, label: s.name + (s.division ? ' (' + s.division + ')' : '') })); }
  function setupForm(p) {
    const fields = [
      { key: 'coordinator', label: 'Project coordinator', type: 'select', required: true, options: staffOpts(coordRoleOf(p)) },
      { key: 'engineer', label: 'Technical engineer / owner', type: 'select', required: true, options: staffOpts('tech_engineer') },
      { key: 'installLead', label: 'Installation team leader', type: 'select', options: staffOpts('install_lead') },
      { key: 'installMode', label: 'Installation mode', type: 'select', required: true, options: INSTALL_MODES },
      { key: 'vendorId', label: 'Vendor (if Vendor / Mixed)', type: 'select', options: staffOpts('vendor') },
      { key: 'priority', label: 'Priority', type: 'select', required: true, options: PRIORITIES },
      { key: 'committedDate', label: 'Committed completion date (original — frozen once set)', type: p.committedDate ? 'readonly' : 'date', required: true },
      { key: 'revisedDate', label: 'Approved revised date', type: 'date' },
      { key: 'revisionReason', label: 'Revision reason (mandatory when revising)' },
    ];
    if (p.division === SOL) fields.push({ key: 'projectType', label: 'Project type', type: 'select', options: SOLAR_TYPES }, { key: 'config', label: 'System configuration', type: 'select', options: ['On-grid', 'Hybrid', 'Other'] });
    else fields.push({ key: 'architecture', label: 'System architecture', type: 'select', options: ['Standalone', 'Networked', 'Multi-site / Networked'] });
    ui.formModal('Project setup — ' + p.id, fields, Object.assign({}, p, { revisionReason: '' }), (v) => {
      if (v.installMode !== 'Own team' && !v.vendorId) { ui.toast('Select the vendor for Vendor / Mixed installation mode', 'bad'); return false; }
      const q = getP(p.id);
      if (v.revisedDate && v.revisedDate !== (q.revisedDate || '')) { if (!v.revisionReason) { ui.toast('Revision reason is mandatory for a revised date', 'bad'); return false; } q.dateRevisions = (q.dateRevisions || []).concat({ ts: nowIso(), from: q.revisedDate || q.committedDate, to: v.revisedDate, reason: v.revisionReason, by: user().name }); hist(q, 'Completion date revised to ' + fmt.date(v.revisedDate) + ' — ' + v.revisionReason + ' (original ' + fmt.date(q.committedDate) + ' preserved)'); }
      const engChanged = v.engineer && v.engineer !== q.engineer;
      ['coordinator', 'engineer', 'installLead', 'installMode', 'vendorId', 'priority', 'revisedDate', 'architecture', 'projectType', 'config'].forEach((k) => { if (v[k] !== undefined && v[k] !== '') q[k] = v[k]; });
      if (!q.committedDate && v.committedDate) q.committedDate = v.committedDate;
      hist(q, 'Project setup updated'); commit(q, 'Project setup updated');
      if (engChanged) CRM.notify({ to: 'tech_engineer', title: 'Assigned as technical engineer: ' + q.id, body: cust(q.customerId).name + ' — schedule the site visit', link: plink(q.id), severity: 'info', key: 'eng-' + q.id + '-' + v.engineer });
      ui.toast('Project setup saved', 'ok'); CRM.refresh();
    });
  }
  function holdForm(p) { ui.formModal('Put project on hold', [{ key: 'reason', label: 'Hold reason', required: true, type: 'select', options: ['Customer site not ready', 'Customer-delayed approvals', 'Payment / commercial hold', 'Material shortage', 'Scope under revision', 'Other'] }, { key: 'note', label: 'Details' }], {}, (v) => { const q = getP(p.id); q.status = 'On Hold'; q.holdReason = v.reason + (v.note ? ' — ' + v.note : ''); q.holdAt = nowIso(); hist(q, 'Put on hold: ' + q.holdReason); commit(q, 'On hold'); CRM.refresh(); }); }
  function cancelForm(p) { ui.formModal('Cancel project', [{ key: 'reason', label: 'Cancellation reason', required: true, type: 'textarea' }], {}, (v) => { const q = getP(p.id); q.status = 'Cancelled'; q.cancelReason = v.reason; q.alloc = {}; hist(q, 'Cancelled: ' + v.reason + ' (reservations released)'); commit(q, 'Cancelled'); CRM.refresh(); }); }
  function techReview(p, proceed) {
    ui.formModal(proceed ? 'Technical review — approve revisit' : 'Technical review — cancel', [{ key: 'reason', label: 'Review decision & remarks', required: true, type: 'textarea' }].concat(proceed ? [{ key: 'date', label: 'Revisit date', type: 'date', required: true }] : []), {}, (v) => {
      const q = getP(p.id);
      if (proceed) { q.status = 'Active'; q.holdReason = ''; db.insert('surveys', { projectId: q.id, division: q.division, status: 'Scheduled', fields: { plannedDate: v.date, engineer: q.engineer }, done: [], revisitOf: (latestSurvey(q.id) || {}).id }, { prefix: 'SRV', note: 'Revisit scheduled after technical review' }); st(q, 'survey').status = 'In Progress'; hist(q, 'Technical review: revisit approved — ' + v.reason); }
      else { q.status = 'Cancelled'; q.cancelReason = 'Technical review: ' + v.reason; q.alloc = {}; hist(q, 'Technical review: cancelled — ' + v.reason); }
      commit(q, 'Technical review decision'); CRM.refresh();
    });
  }
  function scopeChangeForm(p) {
    const fields = p.division === SOL
      ? [{ key: 'capacityKw', label: 'Revised capacity (kWp)', type: 'number', required: true }, { key: 'config', label: 'Configuration', type: 'select', options: ['On-grid', 'Hybrid'] }]
      : [{ key: 'cameraCount', label: 'Revised approved camera count', type: 'number', required: p.systemType === 'CCTV', hint: 'Re-evaluates category: >16 Large, ≤16 Small' }, { key: 'systemType', label: 'System type', type: 'select', options: ES_TYPES }];
    ui.formModal('Approved scope change — ' + p.id, fields.concat([{ key: 'value', label: 'Revised project value (₹)', type: 'number' }, { key: 'reason', label: 'Scope change reason', required: true }, { key: 'approvedBy', label: 'Approved by', required: true }]), p, (v) => {
      const q = getP(p.id);
      const before = p.division === SOL ? q.capacityKw + ' kWp' : q.cameraCount + ' cameras';
      if (p.division === SOL) { q.capacityKw = v.capacityKw; q.config = v.config || q.config; q.devices = genDevices(Object.assign({}, q, { devices: [] })).map((d, i) => Object.assign(d, (q.devices || [])[i] && (q.devices || [])[i].name === d.name ? { serial: q.devices[i].serial, installed: q.devices[i].installed } : {})); }
      else { q.cameraCount = Number(v.cameraCount) || 0; q.systemType = v.systemType || q.systemType; q.devices = genDevices(q, q.devices); }
      if (v.value) q.value = v.value;
      const after = p.division === SOL ? q.capacityKw + ' kWp' : q.cameraCount + ' cameras';
      q.scopeChanges = (q.scopeChanges || []).concat({ ts: nowIso(), from: before, to: after, reason: v.reason, approvedBy: v.approvedBy, by: user().name });
      hist(q, 'Scope change: ' + before + ' → ' + after + ' (' + v.reason + ', approved by ' + v.approvedBy + ')');
      if (latestBoq(q.id)) { q.boqRevisionRequired = true; const b = st(q, 'boq'); if (DONE(b)) { b.prevDoneAt = b.doneAt; b.status = 'In Progress'; b.doneAt = null; } hist(q, 'Revised BOQ required — BOQ stage reopened'); }
      commit(q, 'Scope change recorded');
      CRM.notify({ to: ['tech_head', 'purchase'], title: 'Scope change on ' + q.id + ' — revised BOQ required', body: before + ' → ' + after, link: plink(q.id), severity: 'warn', key: 'sc-' + q.id + '-' + q.scopeChanges.length });
      if (q.division === ESD && q.systemType === 'CCTV') {
        const nk = q.cameraCount > 16 ? 'es_large' : 'es_small';
        if (nk !== q.kind) setTimeout(() => ui.modal({ title: 'Reclassification check', body: ui.callout('Approved camera count is now <b>' + q.cameraCount + '</b>. Routing rule: ' + (nk === 'es_large' ? 'more than 16 cameras → <b>Large project</b> (full lifecycle).' : '16 or fewer → <b>Small installation</b>.') + '<br>The original job history and audit trail are retained.', 'warn'), actions: [{ label: 'Keep current workflow' }, { label: 'Reclassify to ' + KIND[nk], cls: 'primary', onClick: () => reclassify(q.id, nk, v.reason) }] }), 50);
      }
      ui.toast('Scope change recorded', 'ok'); CRM.refresh();
    });
  }
  function reclassify(id, nk, reason) {
    const q = getP(id);
    const from = q.kind;
    q.kindHistory = (q.kindHistory || []).concat({ ts: nowIso(), from, to: nk, by: user().name, reason });
    q.kind = nk;
    let t = new Date();
    workflow(q).forEach(([k]) => { const s = st(q, k); if (!s.due || (!DONE(s) && new Date(s.due) < t)) { t = util.addDays(t, (nk === 'es_small' ? DUR_SMALL : DUR)[k] || 3); s.due = isoD(t); } else t = new Date(s.due); });
    hist(q, 'Reclassified from ' + KIND[from] + ' to ' + KIND[nk] + ' — original job history retained (' + reason + ')');
    commit(q, 'Reclassified ' + KIND[from] + ' → ' + KIND[nk]);
    CRM.notify({ to: ['es_coordinator', 'tech_head'], title: q.id + ' reclassified to ' + KIND[nk], body: reason, link: plink(q.id), severity: 'info', key: 'rc-' + q.id + '-' + q.kindHistory.length });
    ui.toast('Reclassified to ' + KIND[nk], 'ok'); CRM.refresh();
  }

  // ------------------------------------------------------------------ site survey
  const surveyReviewer = (p) => can(coordRoleOf(p), 'tech_head');
  function surveyPanel(p) {
    const list = surveysOf(p.id);
    const wrap = h('div', { class: 'stack', style: 'gap:10px' });
    if (st(p, 'survey').status === 'Skipped') wrap.appendChild(ui.callout('Site visit skipped — ' + util.esc(st(p, 'survey').skipReason), 'info'));
    const latest = list[list.length - 1];
    const acts = [];
    if (isActive(p) && p.status !== 'On Hold' && DONE(st(p, 'so')) && !latest && st(p, 'survey').status !== 'Skipped' && can(coordRoleOf(p), 'tech_head')) acts.push(ui.btn('Schedule site visit', () => scheduleSurvey(p), 'primary'));
    if (!DONE(st(p, 'so'))) wrap.appendChild(ui.callout('Complete SO receipt / project acceptance before scheduling the survey.', 'info'));
    wrap.appendChild(ui.table({ search: false, rows: list, onRow: (s) => surveyDrawer(s.id), empty: 'No site visit scheduled yet', columns: [{ key: 'id', label: 'Survey', render: (s) => mono(s.id) }, { key: 'planned', label: 'Planned', render: (s) => fmt.date(s.fields.plannedDate) }, { key: 'actual', label: 'Actual', render: (s) => fmt.date(s.fields.actualDate) }, { key: 'eng', label: 'Engineer', render: (s) => sName(s.fields.engineer) }, { key: 'feas', label: 'Outcome', render: (s) => ui.badge(s.fields.feasibility || '—') }, { key: 'status', label: 'Status', render: (s) => ui.badge(s.status) }] }));
    if (acts.length) wrap.appendChild(h('div', { class: 'row' }, acts));
    return wrap;
  }
  function scheduleSurvey(p) {
    ui.formModal('Schedule & assign site visit', [{ key: 'plannedDate', label: 'Planned visit date', type: 'date', required: true, default: isoD(util.addDays(T0, 2)) }, { key: 'engineer', label: 'Assigned engineer', type: 'select', required: true, options: staffOpts('tech_engineer'), default: p.engineer }], {}, (v) => {
      const s = db.insert('surveys', { projectId: p.id, division: p.division, status: 'Scheduled', fields: v, done: [] }, { prefix: 'SRV', note: 'Site visit scheduled' });
      const q = getP(p.id); startStage(q, 'survey'); st(q, 'survey').surveyId = s.id; hist(q, 'Site visit ' + s.id + ' scheduled for ' + fmt.date(v.plannedDate) + ' — ' + sName(v.engineer)); commit(q, 'Survey scheduled');
      CRM.notify({ to: 'tech_engineer', title: 'Site visit scheduled: ' + p.id, body: cust(p.customerId).name + ' on ' + fmt.date(v.plannedDate), link: '#/surveys/' + s.id, severity: 'info', key: 'sv-' + s.id });
      ui.toast('Site visit scheduled', 'ok'); CRM.refresh();
    });
  }
  function surveyDrawer(id) {
    const s = db.get('surveys', id); if (!s) return;
    const p = db.get('projects', s.projectId);
    const items = surveyChecklist(p);
    const editable = ['Scheduled', 'Draft', 'Returned for correction'].includes(s.status) && can('tech_engineer', 'tech_head') && p.status !== 'Cancelled';
    const obj = {}; (s.done || []).forEach((i) => { obj[items[i]] = true; });
    const cl = ui.checklist(items, obj, null, !editable);
    const form = ui.form(surveyFields(p), s.fields);
    if (!editable) Object.values(form.inputs).forEach((i) => { i.disabled = true; });
    const body = h('div', { class: 'stack', style: 'gap:12px' }, [
      ui.dl([['Project', pLink(p.id)], ['Customer', cust(p.customerId).name], ['Status', ui.badge(s.status)], ['Sales Order', p.soNumber], s.returnReason ? ['Returned for correction', s.returnReason] : null, s.reviewedBy ? ['Reviewed by', s.reviewedBy + ' · ' + fmt.dateTime(s.reviewedAt)] : null]),
      s.status === 'Returned for correction' ? ui.callout('Incomplete survey returned for correction: ' + util.esc(s.returnReason || ''), 'warn') : null,
      h('h3', {}, 'Site survey checklist'), cl, h('h3', {}, 'Mandatory survey fields'), form,
    ]);
    const persist = (status) => {
      const v = form.values();
      if (Object.values(v).some((x) => CREDENTIAL_RX.test(String(x || '')))) { ui.toast('Credentials must not be stored in survey notes', 'bad'); return null; }
      const done = items.map((it, i) => (obj[it] ? i : -1)).filter((i) => i >= 0);
      return db.update('surveys', s.id, { fields: Object.assign({}, s.fields, v), done, status: status || (s.status === 'Scheduled' ? 'Draft' : s.status) }, { note: status ? 'Survey ' + status : 'Survey draft saved' });
    };
    const actions = [];
    if (editable) {
      actions.push({ label: 'Save draft', onClick: () => { if (persist()) ui.toast('Draft saved', 'ok'); CRM.refresh(); } });
      actions.push({ label: 'Submit survey', cls: 'primary', onClick: () => {
        if (!form.validate()) return false;
        if (!cl.complete()) { ui.toast('Survey checklist is incomplete — all items must be checked before submission', 'bad'); return false; }
        const v = form.values();
        if (v.actualDate > v.plannedDate && !yes(v.delayReason)) { ui.toast('Visit was later than planned — record the delay reason', 'bad'); return false; }
        const out = v.feasibility;
        const rec = persist(out === 'Revisit Required' ? 'Revisit Required' : out === 'Not Feasible' ? 'Not Feasible' : 'Submitted');
        if (!rec) return false;
        db.update('surveys', s.id, { submittedAt: nowIso() }, { silent: true });
        const q = getP(p.id);
        if (out === 'Revisit Required') {
          addTask(q, { kind: 'Follow-up', stageKey: 'survey', title: 'Site revisit — ' + (v.nextAction || 'complete pending survey items'), assignee: v.engineer, due: v.nextDue });
          db.insert('surveys', { projectId: p.id, division: p.division, status: 'Scheduled', fields: { plannedDate: v.nextDue, engineer: v.engineer }, done: [], revisitOf: s.id }, { prefix: 'SRV', note: 'Revisit scheduled' });
          hist(q, 'Survey ' + s.id + ': revisit required — follow-up task and revisit created');
        } else if (out === 'Not Feasible') {
          q.status = 'On Hold'; q.holdReason = 'Technical review — site not feasible (' + s.id + ')'; q.holdAt = nowIso();
          hist(q, 'Survey ' + s.id + ': NOT FEASIBLE — project held for technical review (not advanced to procurement)');
          CRM.notify({ to: ['tech_head', coordRoleOf(p)], title: 'Technical review required: ' + p.id, body: 'Site assessed Not Feasible — ' + (v.observations || ''), link: plink(p.id), severity: 'bad', key: 'nf-' + s.id });
        } else {
          hist(q, 'Survey ' + s.id + ' submitted (' + out + ') — awaiting review');
          CRM.notify({ to: [coordRoleOf(p), 'tech_head'], title: 'Survey submitted: ' + p.id, body: out + ' — review and prompt the BOQ workflow', link: '#/surveys/' + s.id, severity: 'info', key: 'ss-' + s.id });
        }
        commit(q, 'Survey submitted');
        ui.toast('Survey submitted: ' + out, out === 'Not Feasible' ? 'warn' : 'ok'); CRM.refresh();
      } });
    }
    if (s.status === 'Submitted' && surveyReviewer(p)) {
      actions.push({ label: 'Return for correction', onClick: () => { ui.formModal('Return survey for correction', [{ key: 'reason', label: 'What is incomplete?', required: true }], {}, (v) => { db.update('surveys', s.id, { status: 'Returned for correction', returnReason: v.reason }, { note: 'Returned for correction' }); CRM.notify({ to: 'tech_engineer', title: 'Survey returned: ' + s.id, body: v.reason, link: '#/surveys/' + s.id, severity: 'warn', key: 'sr-' + s.id + '-' + util.uid() }); CRM.refresh(); }); } });
      actions.push({ label: 'Approve survey', cls: 'ok', onClick: () => {
        db.update('surveys', s.id, { status: 'Approved', reviewedBy: user().name, reviewedAt: nowIso() }, { note: 'Survey approved' });
        const q = getP(p.id); const ss = st(q, 'survey'); ss.approvedBy = user().name; ss.approvedAt = nowIso(); ss.surveyId = s.id; completeStage(q, 'survey'); commit(q, 'Survey approved — BOQ enabled');
        CRM.notify({ to: ['tech_engineer', coordRoleOf(p)], title: 'Site visit completed — prepare BOQ: ' + p.id, body: 'Survey ' + s.id + ' approved; BOQ preparation is now enabled', link: plink(p.id) + '/boq', severity: 'ok', key: 'sa-' + s.id });
        ui.toast('Survey approved — BOQ preparation enabled', 'ok'); CRM.refresh();
      } });
    }
    ui.drawer({ title: 'Site survey ' + s.id, sub: p.id + ' · ' + KIND[p.kind], body, actions: actions.length ? actions : [{ label: 'Close' }] });
  }

  // ------------------------------------------------------------------ BOQ (structured, version-controlled)
  function availabilityText(it, p) { const a = available(it.stockId, p ? p.id : null) + ((p && (p.alloc || {})[it.stockId]) || 0) + ((p && (p.siteOk || {})[it.stockId]) || 0); return a >= it.qty ? 'Stock' : a > 0 ? 'Partially Available' : 'To Purchase'; }
  function boqPanel(p) {
    const list = boqsOf(p.id);
    const wrap = h('div', { class: 'stack', style: 'gap:10px' });
    const surveyOk = DONE(st(p, 'survey'));
    if (!surveyOk) wrap.appendChild(ui.callout('BOQ preparation is enabled only after the site survey is complete and approved.', 'warn'));
    wrap.appendChild(ui.table({ search: false, rows: list.slice().reverse(), onRow: (b) => boqDrawer(b.id), empty: 'No BOQ prepared yet', columns: [{ key: 'id', label: 'BOQ', render: (b) => mono(b.id) }, { key: 'version', label: 'Version', render: (b) => 'v' + b.version }, { key: 'status', label: 'Status', render: (b) => ui.badge(b.status, b.status === 'Superseded' ? '' : null) }, { key: 'items', label: 'Items', render: (b) => b.items.length }, { key: 'val', label: 'Est. value', cls: 'right', render: (b) => fmt.lakh(boqValue(b)) }, { key: 'preparedBy', label: 'Prepared by' }, { key: 'submittedAt', label: 'Submitted', render: (b) => fmt.date(b.submittedAt) }, { key: 'approvedBy', label: 'Approved by' }, { key: 'revisionReason', label: 'Revision reason' }] }));
    const latest = list[list.length - 1];
    const acts = [];
    const preparer = can('tech_engineer', 'tech_head', coordRoleOf(p));
    if (surveyOk && preparer && isActive(p) && !latest) acts.push(ui.btn('Prepare BOQ (draft from survey)', () => { const b = db.insert('boqs', { projectId: p.id, division: p.division, version: 1, status: 'Draft', items: boqDraftItems(p), preparedBy: user().name, surveyId: st(p, 'survey').surveyId || (latestSurvey(p.id) || {}).id || null }, { prefix: 'BOQ', note: 'BOQ v1 drafted' }); const q = getP(p.id); startStage(q, 'boq'); commit(q, 'BOQ drafted'); boqEditor(b.id); }, 'primary'));
    if (latest && preparer && isActive(p) && ['Approved', 'Rejected'].includes(latest.status)) acts.push(ui.btn('Revise BOQ (new version)', () => reviseBoq(p, latest)));
    if (acts.length) wrap.appendChild(h('div', { class: 'row' }, acts));
    return wrap;
  }
  function reviseBoq(p, latest) {
    const pos = db.find('purchaseOrders', (po) => po.projectId === p.id && po.status !== 'Cancelled');
    ui.formModal('Revise BOQ — v' + (latest.version + 1), [{ key: 'reason', label: 'Revision reason (mandatory)', required: true }, { key: 'note', label: 'Impact on committed installation date', type: 'select', options: ['No impact', 'May delay committed date', 'Delays committed date'] }], {}, (v) => {
      const b = db.insert('boqs', { projectId: p.id, division: p.division, version: latest.version + 1, status: 'Draft', items: clone(latest.items), preparedBy: user().name, revisionReason: v.reason, dateImpact: v.note, prevId: latest.id, affectedPOs: pos.map((x) => x.id), surveyId: latest.surveyId }, { prefix: 'BOQ', note: 'BOQ v' + (latest.version + 1) + ' drafted: ' + v.reason });
      if (pos.length) CRM.notify({ to: 'purchase', title: 'BOQ revision after purchase initiation: ' + p.id, body: 'Affected POs: ' + pos.map((x) => x.id).join(', '), link: plink(p.id) + '/boq', severity: 'warn', key: 'bra-' + b.id });
      boqEditor(b.id);
    });
  }
  function boqDiff(b) {
    const prev = b.prevId ? db.get('boqs', b.prevId) : null; if (!prev) return null;
    const ids = Array.from(new Set(prev.items.map((i) => i.stockId).concat(b.items.map((i) => i.stockId))));
    const rows = ids.map((sid) => { const a = prev.items.find((i) => i.stockId === sid), c = b.items.find((i) => i.stockId === sid); const dq = (c ? c.qty : 0) - (a ? a.qty : 0); return { sid, dq, dv: dq * ((c || a).rate) }; }).filter((r) => r.dq);
    return rows;
  }
  function boqDrawer(id) {
    const b = db.get('boqs', id); const p = db.get('projects', b.projectId);
    const diff = boqDiff(b);
    const body = h('div', { class: 'stack', style: 'gap:12px' }, [
      ui.dl([['Project', pLink(p.id)], ['Version', 'v' + b.version], ['Status', ui.badge(b.status)], ['Traceable survey', b.surveyId || '—'], ['Prepared by / date', (b.preparedBy || '—') + ' · ' + fmt.date(b.createdAt)], ['Submitted', fmt.dateTime(b.submittedAt)], ['Technical approval', b.approvedBy ? b.approvedBy + ' · ' + fmt.dateTime(b.approvedAt) : '—'], ['Revision reason', b.revisionReason || '—'], ['Estimated value', fmt.money(boqValue(b))], ['Affected POs', (b.affectedPOs || []).join(', ') || '—']]),
      b.rejectReason ? ui.callout('Rejected: ' + util.esc(b.rejectReason), 'bad') : null,
      diff && diff.length ? ui.card('Changes vs previous version (quantity / value difference)', ui.table({ search: false, rows: diff, columns: [{ key: 'sid', label: 'Item', render: (r) => stockName(r.sid) }, { key: 'dq', label: 'Δ Qty', cls: 'right', render: (r) => (r.dq > 0 ? '+' : '') + r.dq }, { key: 'dv', label: 'Δ Value', cls: 'right', render: (r) => fmt.money(r.dv) }] }), { flush: true }) : null,
      boqItemsTable(b, p),
    ]);
    const acts = [];
    const preparer = can('tech_engineer', 'tech_head', coordRoleOf(p));
    if (b.status === 'Draft' && preparer) { acts.push({ label: 'Edit items', onClick: () => boqEditor(b.id) }); acts.push({ label: 'Submit for approval', cls: 'primary', onClick: () => submitBoq(b, p) }); }
    if (b.status === 'Submitted' && can('tech_head')) {
      acts.push({ label: 'Reject', onClick: () => { ui.formModal('Reject BOQ', [{ key: 'reason', label: 'Reason', required: true }], {}, (v) => { db.update('boqs', b.id, { status: 'Rejected', rejectReason: v.reason }, { note: 'BOQ rejected: ' + v.reason }); CRM.notify({ to: 'tech_engineer', title: 'BOQ rejected: ' + b.id, body: v.reason, link: plink(p.id) + '/boq', severity: 'warn', key: 'brj-' + b.id }); CRM.refresh(); }); } });
      acts.push({ label: 'Approve BOQ', cls: 'ok', onClick: () => approveBoq(b, p) });
    }
    ui.drawer({ title: 'BOQ ' + b.id + ' (v' + b.version + ')', sub: p.id + ' · ' + cust(p.customerId).name, body, actions: acts.length ? acts : [{ label: 'Close' }] });
  }
  function boqItemsTable(b, p) {
    return ui.table({ search: false, pageSize: 40, rows: b.items, columns: [{ key: 'category', label: 'Category' }, { key: 'code', label: 'Item code', render: (i) => mono(i.code) }, { key: 'desc', label: 'Description' }, { key: 'make', label: 'Make / model' }, { key: 'qty', label: 'Qty', cls: 'right', render: (i) => i.qty + ' ' + i.unit }, { key: 'rate', label: 'Est. rate', cls: 'right', render: (i) => fmt.money(i.rate) }, { key: 'val', label: 'Value', cls: 'right', render: (i) => fmt.money(i.qty * i.rate), footer: (rows) => fmt.money(sumBy(rows, (i) => i.qty * i.rate)) }, { key: 'requiredAt', label: 'Req. at site', render: (i) => fmt.date(i.requiredAt) }, { key: 'av', label: 'Availability', render: (i) => ui.badge(availabilityText(i, p), availabilityText(i, p) === 'Stock' ? 'ok' : availabilityText(i, p) === 'To Purchase' ? 'bad' : 'warn') }, { key: 'remarks', label: 'Technical remarks' }] });
  }
  function boqEditor(id) {
    const b = db.get('boqs', id); const p = db.get('projects', b.projectId);
    const cats = p.division === SOL ? BOQ_CAT_SOL : BOQ_CAT_ES;
    const stockOpts = db.find('stock', (s) => s.division === p.division || s.division === 'Common');
    const tbody = h('tbody');
    const addRow = (it) => {
      it = it || { stockId: stockOpts[0].id, qty: 1, category: cats[0], requiredAt: isoD(util.addDays(T0, 10)), remarks: '' };
      const sel = h('select', {}, stockOpts.map((s) => h('option', { value: s.id, selected: s.id === it.stockId ? true : null }, s.code + ' · ' + s.name)));
      const cat = h('select', {}, cats.map((c) => h('option', { value: c, selected: c === it.category ? true : null }, c)));
      const qty = h('input', { type: 'number', min: 1, value: it.qty, style: 'width:80px' });
      const req = h('input', { type: 'date', value: it.requiredAt });
      const rem = h('input', { type: 'text', value: it.remarks || '', placeholder: 'Technical remarks' });
      const tr = h('tr', {}, [h('td', {}, cat), h('td', {}, sel), h('td', {}, qty), h('td', {}, req), h('td', {}, rem), h('td', {}, ui.btn('✕', () => tr.remove(), 'sm ghost'))]);
      tr.read = () => { const s = stockItem(sel.value); return { stockId: s.id, code: s.code, desc: s.name, make: s.brand + ' ' + s.model, category: cat.value, qty: Number(qty.value) || 0, unit: s.unit, rate: s.purchaseCost, requiredAt: req.value, remarks: rem.value }; };
      tbody.appendChild(tr);
    };
    b.items.forEach(addRow);
    const tbl = h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' }, [h('thead', {}, h('tr', {}, ['Category', 'Item (product master)', 'Qty', 'Required at site', 'Remarks', ''].map((x) => h('th', {}, x)))), tbody]));
    ui.modal({ title: 'Edit BOQ ' + b.id + ' (v' + b.version + ')', wide: true, body: h('div', { class: 'stack', style: 'gap:10px' }, [ui.callout('Structured material list linked to the product/stock master — not an uploaded PDF. Rates default from the stock master purchase cost.', 'info'), tbl, ui.btn('+ Add item', () => addRow())]), actions: [{ label: 'Cancel' }, { label: 'Save BOQ', cls: 'primary', onClick: () => { const items = Array.from(tbody.children).map((tr) => tr.read()).filter((i) => i.qty > 0); if (!items.length) { ui.toast('BOQ must have at least one item', 'bad'); return false; } if (items.some((i) => CREDENTIAL_RX.test(i.remarks))) { ui.toast('Credentials must not be stored in remarks', 'bad'); return false; } db.update('boqs', b.id, { items }, { note: 'BOQ items edited (' + items.length + ')' }); ui.toast('BOQ saved', 'ok'); CRM.refresh(); } }] });
  }
  function submitBoq(b, p) {
    if (b.version > 1 && !yes(b.revisionReason)) { ui.toast('Revision reason is mandatory', 'bad'); return false; }
    db.update('boqs', b.id, { status: 'Submitted', submittedAt: nowIso() }, { note: 'BOQ submitted for approval' });
    const q = getP(p.id); startStage(q, 'boq'); st(q, 'boq').submittedAt = nowIso(); hist(q, 'BOQ ' + b.id + ' v' + b.version + ' submitted — approval task created for Technical Head'); commit(q, 'BOQ submitted');
    CRM.notify({ to: 'tech_head', title: 'BOQ approval task: ' + b.id + ' (v' + b.version + ')', body: p.id + ' · ' + cust(p.customerId).name + ' · ' + fmt.lakh(boqValue(b)), link: plink(p.id) + '/boq', severity: 'warn', key: 'bs-' + b.id });
    ui.toast('Submitted — approval task created', 'ok'); CRM.refresh();
  }
  function approveBoq(b, p, o) {
    o = o || {};
    const at = o.at ? new Date(o.at).toISOString() : nowIso();
    db.find('boqs', (x) => x.projectId === p.id && x.status === 'Approved').forEach((x) => db.update('boqs', x.id, { status: 'Superseded' }, { silent: o.silent, note: 'Superseded by ' + b.id }));
    db.update('boqs', b.id, { status: 'Approved', approvedBy: o.by || user().name, approvedAt: at }, { silent: o.silent, note: 'BOQ approved (technical)' });
    const q = getP(p.id);
    q.boqRevisionRequired = false;
    const s = st(q, 'boq'); s.approvedBy = o.by || user().name; s.approvedAt = at; s.submittedAt = s.submittedAt || b.submittedAt;
    if (!DONE(s)) completeStage(q, 'boq', o); else hist(q, 'Revised BOQ v' + b.version + ' approved', o);
    commit(q, 'BOQ approved', o);
    if (!o.silent) {
      CRM.notify({ to: 'purchase', title: 'BOQ approved — procurement readiness: ' + p.id, body: 'v' + b.version + ' · ' + b.items.length + ' items · shortages will be compared against stock', link: plink(p.id) + '/procurement', severity: 'info', key: 'ba-' + b.id });
      ui.toast('BOQ approved — Purchase Coordinator notified', 'ok'); CRM.refresh();
    }
  }

  // ------------------------------------------------------------------ procurement pipeline per BOQ item
  function itemPipeline(p) {
    const prs = db.find('purchaseRequests', (r) => r.projectId === p.id && r.status !== 'Rejected');
    const pos = db.find('purchaseOrders', (r) => r.projectId === p.id && r.status !== 'Cancelled');
    const grns = db.find('grns', (g) => g.projectId === p.id);
    return needs(p).map((x) => {
      const inPr = sumBy(prs, (r) => sumBy(r.items.filter((i) => i.stockId === x.stockId), 'qty'));
      const prApproved = prs.some((r) => ['Approved', 'PO Raised'].includes(r.status) && r.items.some((i) => i.stockId === x.stockId));
      const poLines = pos.flatMap((po) => po.items.filter((i) => i.stockId === x.stockId).map((i) => Object.assign({ po }, i)));
      const ordered = sumBy(poLines, 'qty'), received = sumBy(poLines, 'received');
      const confirmed = poLines.some((l) => l.po.status !== 'Issued');
      const inspected = grns.some((g) => g.status === 'Accepted' && g.items.some((i) => i.stockId === x.stockId));
      const state = x.short === 0 ? (x.site >= x.need ? 'Site verified' : x.transit ? 'Dispatched' : 'Allocated') : inspected ? 'Inspected' : received ? 'Goods received' : confirmed ? 'Supplier confirmed' : ordered ? 'PO issued' : prApproved ? 'PR approved' : inPr ? 'PR pending approval' : x.alloc ? 'Partly reserved' : 'Stock check';
      return Object.assign({}, x, { inPr, ordered, received, state });
    });
  }
  function procurementPanel(p) {
    const wrap = h('div', { class: 'stack', style: 'gap:10px' });
    if (!approvedBoq(p.id)) { wrap.appendChild(ui.callout('Purchase initiation requires an approved BOQ (unless an authorized exception is recorded on the Purchase Requests page).', 'warn')); return wrap; }
    wrap.appendChild(ui.callout('Flow per BOQ item: Stock check → Reservation → Purchase requisition → Approval → Purchase Order → Supplier confirmation → Goods receipt → Inspection → Project allocation. Ordered ≠ received ≠ site-verified.', 'info'));
    const rows = itemPipeline(p);
    wrap.appendChild(ui.table({ search: false, pageSize: 30, rows, columns: [{ key: 'stockId', label: 'Item', render: (r) => h('div', {}, [h('div', {}, stockName(r.stockId)), h('div', { class: 'small muted' }, (stockItem(r.stockId) || {}).itemType)]) }, { key: 'need', label: 'Required', cls: 'right' }, { key: 'avail', label: 'Free stock', cls: 'right' }, { key: 'alloc', label: 'Reserved', cls: 'right' }, { key: 'inPr', label: 'In PR', cls: 'right' }, { key: 'ordered', label: 'Ordered', cls: 'right' }, { key: 'received', label: 'Received', cls: 'right' }, { key: 'site', label: 'Site-verified', cls: 'right' }, { key: 'short', label: 'Shortage', cls: 'right', render: (r) => (r.short ? ui.badge(r.short, 'bad') : ui.badge('0', 'ok')) }, { key: 'state', label: 'State', render: (r) => ui.badge(r.state, /verified|Allocated|Dispatched/.test(r.state) ? 'ok' : /Stock check|pending/.test(r.state) ? 'warn' : 'info') }] }));
    const acts = [];
    if (isActive(p) && can('stores', 'purchase', coordRoleOf(p))) acts.push(ui.btn('Reserve available stock', () => { const q = getP(p.id); const n = reserve(q); commit(q, 'Stock reserved'); ui.toast(n ? n + ' units reserved' : 'No free stock to reserve', n ? 'ok' : 'warn'); if (n && materialReady(q)) CRM.notify({ to: coordRoleOf(q), title: 'All required materials available: ' + q.id, body: 'Ready for dispatch', link: plink(q.id), severity: 'ok', key: 'ready-' + q.id }); CRM.refresh(); }));
    if (isActive(p) && can('purchase', coordRoleOf(p))) acts.push(ui.btn('Generate PR draft for shortage', () => { const q = getP(p.id); const pr = prFromShortage(q); if (!pr) { ui.toast('No uncovered shortage (check reserve / open PRs)', 'warn'); return; } hist(q, 'PR draft ' + pr.id + ' generated for shortage'); commit(q, 'PR draft generated'); ui.toast('Draft ' + pr.id + ' generated — submit it for approval', 'ok'); CRM.go('purchase-requests'); }, 'primary'));
    if (acts.length) wrap.appendChild(h('div', { class: 'row' }, acts));
    return wrap;
  }

  // ------------------------------------------------------------------ material delivery (DC + site receipt)
  function deliveryPanel(p) {
    const wrap = h('div', { class: 'stack', style: 'gap:10px' });
    const dcs = db.find('dcs', (d) => d.projectId === p.id);
    wrap.appendChild(dcTable(dcs, true));
    const acts = [];
    const allocQty = sumBy(Object.values(p.alloc || {}));
    if (isActive(p) && can('stores') && allocQty > 0) acts.push(ui.btn('Pick & generate DC (' + allocQty + ' units)', () => { const q = getP(p.id); const dc = createDC(q, { by: user().name }); commit(q, 'DC ' + dc.id + ' dispatched'); CRM.notify({ to: [coordRoleOf(q), 'install_lead'], title: 'Material dispatched: ' + dc.id, body: q.id + ' — confirm site receipt with actual quantities', link: plink(q.id) + '/delivery', severity: 'info', key: 'dcd-' + dc.id }); ui.toast(dc.id + ' generated and dispatched', 'ok'); CRM.refresh(); }, 'primary'));
    if (!allocQty && !deliveryComplete(p)) wrap.appendChild(ui.callout('Nothing reserved for dispatch. Complete procurement / reservation first (no stock dispatch without DC).', 'info'));
    if (acts.length) wrap.appendChild(h('div', { class: 'row' }, acts));
    return wrap;
  }
  function dcTable(rows, compact) {
    return ui.table({ search: !compact, rows, pageSize: compact ? 10 : 15, onRow: (d) => dcDrawer(d.id), empty: 'No delivery challans', columns: [{ key: 'id', label: 'DC No.', render: (d) => mono(d.id) }, { key: 'linkId', label: 'Linked to', render: (d) => d.projectId ? pLink(d.projectId) : (d.linkType + ' ' + (d.linkId || '')) }, compact ? null : { key: 'customerId', label: 'Customer', render: (d) => cust(d.customerId).name }, { key: 'purpose', label: 'Purpose' }, { key: 'items', label: 'Lines / qty', render: (d) => d.items.length + ' / ' + sumBy(d.items, 'qty') }, { key: 'dispatchDate', label: 'Dispatched', render: (d) => fmt.date(d.dispatchDate) }, { key: 'dispatchedBy', label: 'By' }, { key: 'receiver', label: 'Received by', render: (d) => d.receiver ? d.receiver + ' · ' + fmt.date(d.receivedAt) : '—' }, { key: 'status', label: 'Status', render: (d) => ui.badge(d.status, d.status === 'Dispatched' && util.daysBetween(d.dispatchDate, T0) > 2 ? 'bad' : null) }].filter(Boolean) });
  }
  function dcDrawer(id) {
    const d = db.get('dcs', id);
    const body = h('div', { class: 'stack', style: 'gap:12px' }, [
      ui.dl([['DC number', d.id], ['Linked', d.projectId ? pLink(d.projectId) : d.linkType + ' ' + (d.linkId || '—')], ['Customer', cust(d.customerId).name], ['Site address', d.siteAddress], ['Dispatching store', d.store], ['Dispatched by', d.dispatchedBy], ['Vehicle', d.vehicle || '—'], ['Dispatch date', fmt.date(d.dispatchDate)], ['Receiver', d.receiver || '—'], ['Receipt', fmt.dateTime(d.receivedAt)], ['Evidence', d.evidence || '—'], ['Status', ui.badge(d.status)]]),
      d.exception ? ui.callout('<b>Discrepancy exception:</b> ' + util.esc(d.exception.text) + (d.exception.resolved ? '<br>Resolved: ' + util.esc(d.exception.resolution) : ''), d.exception.resolved ? 'ok' : 'bad') : null,
      ui.table({ search: false, rows: d.items, columns: [{ key: 'stockId', label: 'Item', render: (i) => stockName(i.stockId) }, { key: 'qty', label: 'Dispatched', cls: 'right' }, { key: 'accepted', label: 'Accepted', cls: 'right' }, { key: 'short', label: 'Short', cls: 'right' }, { key: 'damaged', label: 'Damaged', cls: 'right' }] }),
    ]);
    const acts = [];
    if (d.status === 'Dispatched' && can('stores', 'install_lead', 'es_coordinator', 'solar_coordinator', 'tech_engineer')) acts.push({ label: 'Confirm site receipt', cls: 'primary', onClick: () => receiptForm(d) });
    if (d.status === 'Discrepancy' && can('es_coordinator', 'solar_coordinator', 'stores')) acts.push({ label: 'Resolve discrepancy', onClick: () => ui.formModal('Resolve delivery exception', [{ key: 'res', label: 'Resolution (replacement DC / credit note / accepted)', required: true }], {}, (v) => { db.update('dcs', d.id, { status: 'Delivered', exception: Object.assign({}, d.exception, { resolved: true, resolution: v.res + ' — ' + user().name }) }, { note: 'Discrepancy resolved' }); ui.toast('Exception closed — shortfall re-enters the shortage list', 'ok'); CRM.refresh(); }) });
    ui.drawer({ title: 'Delivery Challan ' + d.id, sub: d.purpose, body, actions: acts.length ? acts : [{ label: 'Close' }] });
  }
  function receiptForm(d) {
    const fields = [{ key: 'receiver', label: 'Receiving person', required: true }, { key: 'evidence', label: 'Evidence (signed DC / photos ref)', required: true }].concat(d.items.flatMap((i) => [{ type: 'section', label: stockName(i.stockId) + ' — dispatched ' + i.qty }, { key: 's_' + i.stockId, label: 'Short qty', type: 'number', default: 0 }, { key: 'd_' + i.stockId, label: 'Damaged / rejected qty', type: 'number', default: 0 }]));
    ui.formModal('Site receipt confirmation — ' + d.id, fields, {}, (v) => {
      const receipt = {}; d.items.forEach((i) => { receipt[i.stockId] = { short: v['s_' + i.stockId] || 0, damaged: v['d_' + i.stockId] || 0 }; if (receipt[i.stockId].short + receipt[i.stockId].damaged > i.qty) receipt.bad = true; });
      if (receipt.bad) { ui.toast('Short + damaged cannot exceed dispatched quantity', 'bad'); return false; }
      delete receipt.bad;
      confirmDC(d, receipt, v.receiver, { evidence: v.evidence });
      ui.toast('Site receipt recorded', 'ok'); CRM.refresh();
    });
  }

  // ------------------------------------------------------------------ camera / device schedule + secure credential vault
  function deviceSchedule(p, inStage) {
    const editable = isActive(p) && can('install_lead', 'tech_engineer', 'tech_head', coordRoleOf(p));
    const rows = (p.devices || []);
    const inputs = {};
    const cell = (d, k, w) => { if (!editable) return d[k] || '—'; const i = h('input', { type: 'text', value: d[k] || '', style: 'width:' + (w || 110) + 'px;padding:4px 6px;border:1px solid var(--border);border-radius:5px' }); (inputs[d.id] = inputs[d.id] || {})[k] = i; return i; };
    const sel = (d) => { if (!editable) return ui.badge(d.test); const s = h('select', {}, ['Pending', 'Pass', 'Fail'].map((x) => h('option', { selected: x === d.test ? true : null }, x))); (inputs[d.id] = inputs[d.id] || {}).test = s; return s; };
    const chk = (d) => { if (!editable) return d.installed ? '✓' : '—'; const c = h('input', { type: 'checkbox', checked: d.installed ? true : null }); (inputs[d.id] = inputs[d.id] || {}).installed = c; return c; };
    const tbl = ui.table({ search: !inStage, pageSize: 100, rows, columns: [{ key: 'tag', label: 'Device / camera ID', render: (d) => cell(d, 'tag', 90) }, { key: 'type', label: 'Type' }, { key: 'name', label: 'Make / model' }, { key: 'location', label: 'Location', render: (d) => cell(d, 'location', 140) }, { key: 'serial', label: 'Serial number', render: (d) => cell(d, 'serial', 120) }, { key: 'channel', label: 'Recording channel', render: (d) => (d.type === 'Camera' ? cell(d, 'channel', 100) : '—') }, { key: 'test', label: 'Test status', render: sel }, { key: 'installed', label: 'Installed', render: chk }] });
    const acts = [];
    if (editable) {
      acts.push(ui.btn('Save schedule', () => {
        const q = getP(p.id);
        q.devices = q.devices.map((d) => { const i = inputs[d.id]; if (!i) return d; return Object.assign({}, d, { tag: i.tag.value, location: i.location.value, serial: i.serial.value.trim(), channel: i.channel ? i.channel.value : d.channel, test: i.test.value, installed: i.installed.checked }); });
        if (q.devices.some((d) => CREDENTIAL_RX.test(d.location + d.serial))) { ui.toast('Credentials must not be entered in the device schedule', 'bad'); return; }
        const failed = q.devices.filter((d) => d.test === 'Fail' && !(q.tasks || []).some((t) => t.deviceId === d.id && t.status !== 'Completed'));
        failed.forEach((d) => addTask(q, { kind: 'Rework', stageKey: curKey(q), deviceId: d.id, title: 'Corrective action — ' + d.tag + ' failed test (' + d.location + ')', assignee: q.engineer || 'EMP-tech_engineer', due: isoD(util.addDays(T0, 2)) }));
        hist(q, 'Device schedule updated (' + q.devices.filter((d) => d.installed).length + '/' + q.devices.length + ' installed)' + (failed.length ? ' — ' + failed.length + ' rework task(s) for failed devices' : ''));
        commit(q, 'Device schedule updated'); ui.toast('Device schedule saved', 'ok'); CRM.refresh();
      }, 'primary'));
      acts.push(ui.btn('Capture serials (scan)', () => { Object.values(inputs).forEach((i) => { if (!i.serial.value) i.serial.value = (p.division === SOL ? 'SG' : 'HK') + util.rand(10, 99) + 'A' + util.rand(100000, 999999); }); ui.toast('Serials captured — review and save', 'info'); }, 'sm'));
      if (p.kind !== 'solar' && (p.systemType === 'CCTV' || p.cameraCount)) acts.push(ui.btn('+ Add camera', () => addCamera(p), 'sm'));
    }
    if (p.division === ESD && can('tech_engineer', 'tech_head') && isActive(p)) acts.push(ui.btn('🔒 Lodge credentials in vault', () => vaultLodge(p), 'sm'));
    const vaultCount = db.find('credVault', (v) => v.projectId === p.id).length;
    return ui.card(p.division === SOL ? 'Installed equipment — module, inverter & serials' : 'Camera / device schedule — location, ID, serial, channel, test & installation status', h('div', { class: 'stack', style: 'gap:8px' }, [
      p.division === ESD ? ui.callout('Device passwords, recovery codes and network secrets are <b>never</b> stored in notes or the schedule. ' + vaultCount + ' credential reference(s) held in the restricted secure vault (Technical Head / Admin only, access audited).', 'info') : null,
      h('div', { class: 'small muted' }, rows.filter((d) => d.installed).length + ' of ' + rows.length + ' installed · ' + rows.filter((d) => d.test === 'Pass').length + ' tested OK · ' + rows.filter((d) => d.test === 'Fail').length + ' failed'),
      tbl,
    ]), { flush: false, actions: acts });
  }
  function addCamera(p) {
    ui.formModal('Add camera (approved scope change)', [{ key: 'n', label: 'Number of cameras to add', type: 'number', required: true, default: 1 }, { key: 'reason', label: 'Approved scope-change reason', required: true }, { key: 'approvedBy', label: 'Approved by', required: true }], {}, (v) => {
      const q = getP(p.id); const before = q.cameraCount;
      q.cameraCount = before + Number(v.n); q.devices = genDevices(q, q.devices);
      q.scopeChanges = (q.scopeChanges || []).concat({ ts: nowIso(), from: before + ' cameras', to: q.cameraCount + ' cameras', reason: v.reason, approvedBy: v.approvedBy, by: user().name });
      if (approvedBoq(q.id)) { q.boqRevisionRequired = true; }
      hist(q, 'Cameras added: ' + before + ' → ' + q.cameraCount + ' (' + v.reason + ')'); commit(q, 'Cameras added');
      if (q.kind === 'es_small' && q.cameraCount > 16) setTimeout(() => ui.modal({ title: 'Reclassification required', body: ui.callout('This job now has <b>' + q.cameraCount + ' cameras</b> (> 16) because of an approved scope change. It must be reclassified to the <b>Large project</b> workflow; the original job history is retained.', 'warn'), actions: [{ label: 'Later' }, { label: 'Reclassify to Large project', cls: 'primary', onClick: () => reclassify(q.id, 'es_large', v.reason) }] }), 50);
      else CRM.refresh();
    });
  }
  function vaultLodge(p) {
    const nv = (p.devices || []).filter((d) => ['NVR', 'Camera', 'PoE Switch'].includes(d.type) || p.systemType !== 'CCTV');
    ui.formModal('Secure credential vault — lodge credential', [{ key: 'deviceId', label: 'Device', type: 'select', required: true, options: nv.map((d) => ({ value: d.id, label: d.tag + ' · ' + d.name })) }, { key: 'account', label: 'Account label (e.g. admin, viewer, recovery)', required: true }, { key: 'secret', label: 'Credential (sent to vault — never stored in CRM)', type: 'password', required: true }], {}, (v) => {
      const d = p.devices.find((x) => x.id === v.deviceId);
      const rec = db.insert('credVault', { projectId: p.id, deviceId: d.id, deviceTag: d.tag, account: v.account, secretRef: 'vault://mpcs-es/' + p.id + '/' + d.tag + '/' + v.account + '#' + util.uid(), storedBy: user().name, access: [] }, { prefix: 'VLT', note: 'Credential reference lodged (secret held in secure vault placeholder)' });
      v.secret = null;
      ui.toast('Credential lodged — reference ' + rec.id + ' (secret not stored in CRM)', 'ok'); CRM.refresh();
    }, { saveLabel: 'Lodge securely' });
  }
  function vaultReveal(v) {
    ui.formModal('Access credential ' + v.id, [{ key: 'reason', label: 'Access reason (logged)', required: true }], {}, (f) => {
      db.update('credVault', v.id, { access: (v.access || []).concat({ ts: nowIso(), by: user().name, role: CRM.role().name, reason: f.reason }) }, { note: 'Credential accessed: ' + f.reason });
      setTimeout(() => ui.modal({ title: 'Secure vault — ' + v.deviceTag + ' / ' + v.account, body: h('div', { class: 'stack', style: 'gap:10px' }, [ui.callout('Retrieved through the approved secure credential mechanism (placeholder). The secret is displayed in the vault client only and is never persisted in the CRM.', 'info'), ui.dl([['Vault reference', h('span', { class: 'mono' }, v.secretRef)], ['Credential', h('span', { class: 'mono' }, '•••••••••• (vault client)')], ['Access logged', user().name + ' · ' + fmt.dateTime(new Date())]])]) }), 30);
      CRM.refresh();
    });
  }

  // ------------------------------------------------------------------ Solar compliance summary panel
  function compliancePanel(p) {
    const nm = db.one('netMetering', (n) => n.projectId === p.id), sb = db.one('subsidies', (s) => s.projectId === p.id);
    return h('div', { class: 'grid g2' }, [
      ui.card('Net-metering workstream', nm ? ui.dl([['Application', h('a', { href: '#/net-metering/' + nm.id, class: 'mono' }, nm.id)], ['Status', ui.badge(nm.status)], ['Owner', sName(nm.owner)], ['Planned / actual submission', fmt.date(nm.plannedSubmit) + ' / ' + fmt.date(nm.actualSubmit)], ['Reference no.', nm.refNo || '—'], ['Next follow-up', fmt.date(nm.nextFollowUp)], ['Documents', (nm.docs || []).length + ' / ' + NM_DOCS.length]]) : ui.empty('No application')),
      ui.card('Subsidy tracker', sb ? ui.dl([['Record', h('a', { href: '#/subsidy/' + sb.id, class: 'mono' }, sb.id)], ['Scheme', sb.scheme], ['Eligibility', ui.badge(sb.eligibility)], ['Status', ui.badge(sb.status)], ['Application ID', sb.appId || '—'], ['Disbursement', sb.disbursement || '—']]) : ui.empty('No subsidy record')),
    ]);
  }

  // ------------------------------------------------------------------ materials tab (reconciliation, additional requests, returns)
  function materialsTab(p) {
    const rows = needs(p);
    const value = (sid, q) => q * ((stockItem(sid) || {}).purchaseCost || 0);
    const issuedVal = sumBy(rows, (r) => value(r.stockId, r.issued));
    const poVal = sumBy(db.find('purchaseOrders', (po) => po.projectId === p.id && po.status !== 'Cancelled'), 'value');
    const wrap = h('div', { class: 'stack' });
    if (!CRM.is('vendor')) wrap.appendChild(ui.kpis([{ label: 'Approved BOQ value', value: fmt.lakh(boqValue(approvedBoq(p.id))) }, { label: 'Purchased (PO value)', value: fmt.lakh(poVal) }, { label: 'Issued to project', value: fmt.lakh(issuedVal) }, { label: 'Shortage lines', value: rows.filter((r) => r.short).length, color: 'var(--bad)' }]));
    wrap.appendChild(ui.card('BOQ → reserved → dispatched → site-verified → used → returned reconciliation', ui.table({ search: false, pageSize: 40, rows, empty: 'No approved BOQ yet', columns: [{ key: 'stockId', label: 'Item', render: (r) => stockName(r.stockId) }, { key: 'need', label: 'Approved', cls: 'right' }, { key: 'alloc', label: 'Reserved', cls: 'right' }, { key: 'issued', label: 'Dispatched', cls: 'right' }, { key: 'transit', label: 'In transit', cls: 'right' }, { key: 'site', label: 'Site-verified', cls: 'right' }, { key: 'used', label: 'Used', cls: 'right' }, { key: 'returned', label: 'Returned', cls: 'right' }, { key: 'short', label: 'Shortage', cls: 'right', render: (r) => (r.short ? ui.badge(r.short, 'bad') : '0') }] }), { flush: true, actions: [isActive(p) && can('install_lead', 'tech_engineer', coordRoleOf(p)) ? ui.btn('Additional material request', () => addlForm(p), 'sm') : null, can('stores', coordRoleOf(p), 'install_lead') ? ui.btn('Return unused material', () => returnForm(p), 'sm') : null, CRM.is('gm', 'admin') && isActive(p) ? ui.btn('Allocate beyond BOQ (authorized)', () => overAllocForm(p), 'sm danger') : null].filter(Boolean) }));
    wrap.appendChild(ui.card('Additional material requests', ui.table({ search: false, rows: p.addl || [], empty: 'None', columns: [{ key: 'stockId', label: 'Item', render: (a) => stockName(a.stockId) }, { key: 'qty', label: 'Qty', cls: 'right' }, { key: 'reason', label: 'Reason' }, { key: 'cost', label: 'Cost impact', cls: 'right', render: (a) => fmt.money(a.cost) }, { key: 'by', label: 'Requested by' }, { key: 'status', label: 'Status', render: (a) => ui.badge(a.status) }, { key: 'approver', label: 'Approver' }], actions: (a) => (a.status === 'Pending' && can('tech_head', 'gm') ? [ui.btn('Approve', () => { const q = getP(p.id); const x = q.addl.find((y) => y.id === a.id); x.status = 'Approved'; x.approver = user().name; hist(q, 'Additional material approved: ' + stockName(a.stockId) + ' × ' + a.qty); commit(q, 'Additional material approved'); CRM.refresh(); }, 'sm ok'), ui.btn('Reject', () => { const q = getP(p.id); const x = q.addl.find((y) => y.id === a.id); x.status = 'Rejected'; x.approver = user().name; commit(q, 'Additional material rejected'); CRM.refresh(); }, 'sm')] : []) }), { flush: true }));
    return wrap;
  }
  function addlForm(p) {
    ui.formModal('Additional material request', [{ key: 'stockId', label: 'Item', type: 'select', required: true, options: db.find('stock', (s) => s.division === p.division || s.division === 'Common').map((s) => ({ value: s.id, label: s.name })) }, { key: 'qty', label: 'Quantity', type: 'number', required: true }, { key: 'reason', label: 'Reason', required: true }, { key: 'approver', label: 'Approver', type: 'select', required: true, options: ['Technical Head', 'GM / CEO'] }], {}, (v) => {
      const q = getP(p.id); q.addl = (q.addl || []).concat({ id: 'AMR-' + util.uid().slice(0, 5).toUpperCase(), stockId: v.stockId, qty: v.qty, reason: v.reason, cost: v.qty * stockItem(v.stockId).purchaseCost, by: user().name, status: 'Pending', approverRole: v.approver, ts: nowIso() });
      hist(q, 'Additional material requested: ' + stockName(v.stockId) + ' × ' + v.qty); commit(q, 'Additional material requested');
      CRM.notify({ to: v.approver === 'GM / CEO' ? 'gm' : 'tech_head', title: 'Additional material approval: ' + p.id, body: stockName(v.stockId) + ' × ' + v.qty + ' — ' + v.reason, link: plink(p.id), severity: 'warn', key: 'amr-' + p.id + '-' + q.addl.length });
      ui.toast('Request submitted for approval', 'ok'); CRM.refresh();
    });
  }
  function returnForm(p) {
    const opts = needs(p).filter((r) => r.site - r.used - r.returned > 0 || r.site > 0);
    ui.formModal('Return unused material to stores', [{ key: 'stockId', label: 'Item', type: 'select', required: true, options: opts.map((r) => ({ value: r.stockId, label: stockName(r.stockId) + ' (at site ' + (r.site - r.returned) + ')' })) }, { key: 'qty', label: 'Return quantity', type: 'number', required: true }, { key: 'condition', label: 'Condition', type: 'select', required: true, options: ['Good — back to stock', 'Damaged — to scrap'] }], {}, (v) => {
      const r = opts.find((x) => x.stockId === v.stockId);
      if (!r || v.qty > r.site - r.returned) { ui.toast('Return exceeds quantity at site', 'bad'); return false; }
      const q = getP(p.id); q.returned[v.stockId] = (q.returned[v.stockId] || 0) + v.qty;
      if (/^Good/.test(v.condition)) moveStock(v.stockId, v.qty, 'Project return', p.id);
      else db.insert('scrap', { linkType: 'Project', linkId: p.id, projectId: p.id, customerId: p.customerId, location: cust(p.customerId).area, scrapType: stockItem(v.stockId).category, itemName: stockName(v.stockId), brand: stockItem(v.stockId).brand, qty: v.qty, capacity: '', source: 'From Installation', trigger: 'Damaged material from installation', collectedBy: user().name, storedAt: 'Warehouse', status: 'Collected', history: [{ ts: nowIso(), by: user().name, text: 'Returned damaged from site' }], viol: [] }, { prefix: 'SCR', note: 'Scrap from project return' });
      hist(q, 'Returned ' + v.qty + ' × ' + stockName(v.stockId) + ' (' + v.condition + ')'); commit(q, 'Material returned');
      ui.toast('Return recorded', 'ok'); CRM.refresh();
    });
  }
  function overAllocForm(p) {
    ui.formModal('Allocate material beyond approved quantity', [{ key: 'stockId', label: 'Item', type: 'select', required: true, options: needs(p).map((r) => ({ value: r.stockId, label: stockName(r.stockId) })) }, { key: 'qty', label: 'Extra quantity', type: 'number', required: true }, { key: 'reason', label: 'Authorization reason', required: true }], {}, (v) => {
      if (available(v.stockId, p.id) < v.qty) { ui.toast('Not enough free stock', 'bad'); return false; }
      const q = getP(p.id); q.alloc[v.stockId] = (q.alloc[v.stockId] || 0) + v.qty;
      raise('projects', q, 'Material allocated beyond approved quantity', { severity: 'Medium', details: stockName(v.stockId) + ' +' + v.qty + ' over approved BOQ — ' + v.reason });
      hist(q, 'Authorized over-allocation: ' + stockName(v.stockId) + ' +' + v.qty); commit(q, 'Over-allocation (authorized)'); CRM.refresh();
    });
  }

  // ------------------------------------------------------------------ project tasks
  function taskActions(p, t) {
    const u = user(); const out = [];
    const mine = t.assignee === u.id || CRM.is('admin');
    if (mine && ['Planned', 'Not Started'].includes(t.status)) out.push(ui.btn('Start', () => updTask(p.id, t.id, { status: 'In Progress', startedAt: nowIso() }, 'Task started'), 'sm'));
    if (mine && ['In Progress', 'Rework Required'].includes(t.status)) out.push(ui.btn(t.kind === 'Installation' ? 'Submit completion evidence' : 'Mark done', () => ui.formModal('Completion evidence — ' + t.title, [{ key: 'evidence', label: 'Evidence (photos / checklist / test ref)', required: true }, { key: 'note', label: 'Remarks' }], {}, (v) => updTask(p.id, t.id, { status: t.kind === 'Installation' ? 'Submitted for Inspection' : 'Completed', evidence: v.evidence, note: v.note, doneAt: t.kind === 'Installation' ? null : nowIso() }, t.kind === 'Installation' ? 'Completion evidence submitted — inspection required' : 'Task completed', t.kind === 'Installation')), 'sm primary'));
    if (t.status === 'Submitted for Inspection' && t.kind === 'Installation' && can('install_lead', 'tech_head')) {
      out.push(ui.btn('Inspect OK', () => updTask(p.id, t.id, { status: 'Approved', inspectedBy: u.name }, 'Task inspected & approved'), 'sm ok'));
      out.push(ui.btn('Rework', () => updTask(p.id, t.id, { status: 'Rework Required', reworkCount: (t.reworkCount || 0) + 1 }, 'Task sent back for rework'), 'sm'));
    }
    if (t.kind === 'Rework' && !['Completed', 'Accepted'].includes(t.status) && can('tech_head')) out.push(ui.btn('Formally accept', () => ui.formModal('Formally accept outstanding defect', [{ key: 'reason', label: 'Acceptance reason, owner & due date', required: true }], {}, (v) => updTask(p.id, t.id, { status: 'Accepted', accepted: true, note: v.reason }, 'Defect formally accepted')), 'sm'));
    return out;
  }
  function updTask(pid, tid, patch, note, notifyInspect) {
    const q = getP(pid);
    q.tasks = q.tasks.map((t) => (t.id === tid ? Object.assign({}, t, patch) : t));
    const t = q.tasks.find((x) => x.id === tid);
    if (t.kind === 'Rework' && ['Completed', 'Accepted'].includes(t.status)) { const s = st(q, t.stageKey); if (s.status === 'Rework Required' && !openRework(q).some((x) => x.stageKey === t.stageKey)) s.status = 'In Progress'; }
    hist(q, note + ': ' + t.title);
    commit(q, note);
    if (notifyInspect) CRM.notify({ to: ['install_lead', 'tech_head'], title: 'Inspection required: ' + t.title, body: q.id + ' · evidence: ' + patch.evidence, link: plink(q.id), severity: 'warn', key: 'ti-' + tid + '-' + (t.reworkCount || 0) });
    ui.toast(note, 'ok'); CRM.refresh();
  }
  function tasksCard(p) {
    return ui.card('Tasks — installation, rework and follow-ups', ui.table({ search: false, rows: p.tasks || [], empty: 'No tasks yet — installation tasks are created automatically at planning', columns: [{ key: 'id', label: 'Task', render: (t) => mono(t.id) }, { key: 'kind', label: 'Type', render: (t) => ui.badge(t.kind, t.kind === 'Rework' ? 'warn' : 'info') }, { key: 'title', label: 'Title' }, { key: 'assignee', label: 'Owner', render: (t) => sName(t.assignee) }, { key: 'due', label: 'Due', render: (t) => h('span', {}, [fmt.date(t.due), isPast(t.due) && !['Completed', 'Approved', 'Accepted'].includes(t.status) ? ui.badge('Overdue', 'bad') : '']) }, { key: 'status', label: 'Status', render: (t) => ui.badge(t.status) }, { key: 'evidence', label: 'Evidence' }], actions: (t) => taskActions(p, t) }), { flush: true });
  }

  // ------------------------------------------------------------------ KPI engine (ES §12 / Solar §11) — computed from timestamps
  const INSTALL_KEYS = ['cable', 'nvr', 'cameras', 'install', 'civil', 'mechanical', 'electrical', 'testing', 'commissioning'];
  const INSPECT_KEYS = ['cable', 'testing', 'civil', 'mechanical', 'electrical', 'commissioning'];
  function kpiData(projects) {
    const ps = projects || db.all('projects');
    const pids = new Set(ps.map((p) => p.id));
    const sv = db.find('surveys', (s) => pids.has(s.projectId) && s.fields.plannedDate && new Date(s.fields.plannedDate) <= T0);
    const svOn = sv.filter((s) => s.fields.actualDate && s.fields.actualDate <= s.fields.plannedDate && s.status !== 'Scheduled');
    const boqT = db.find('boqs', (b) => pids.has(b.projectId) && b.version === 1 && b.submittedAt).map((b) => { const s = db.get('surveys', b.surveyId) || latestSurvey(b.projectId); return s && s.submittedAt ? { b, d: util.hoursBetween(s.submittedAt, b.submittedAt) / 24 } : null; }).filter(Boolean);
    const prT = db.find('purchaseRequests', (r) => pids.has(r.projectId) && r.boqId && !r.exception).map((r) => { const b = db.get('boqs', r.boqId); return b && b.approvedAt ? { r, d: util.hoursBetween(b.approvedAt, r.createdAt) / 24 } : null; }).filter((x) => x && x.d >= 0);
    const sched = ps.filter((p) => p.status !== 'Cancelled' && workflow(p).some(([k]) => k === 'planning' || k === 'delivery') && (curIndex(p) >= workflow(p).findIndex(([k]) => k === 'delivery') || isPast(st(p, 'delivery').due)));
    const ready = sched.filter((p) => DONE(st(p, 'delivery')) || materialReady(p));
    const ms = ps.flatMap((p) => workflow(p).filter(([k]) => INSTALL_KEYS.includes(k)).map(([k, l]) => ({ p, k, l, s: st(p, k) }))).filter((m) => m.s.due && (DONE(m.s) || isPast(m.s.due)) && m.s.status !== 'Skipped');
    const msOn = ms.filter((m) => DONE(m.s) && m.s.doneAt && isoD(m.s.doneAt) <= m.s.due);
    const insp = ps.flatMap((p) => workflow(p).filter(([k]) => INSPECT_KEYS.includes(k)).map(([k, l]) => ({ p, k, l, s: st(p, k) }))).filter((m) => DONE(m.s) || (m.s.reworkCount || 0) > 0);
    const inspOk = insp.filter((m) => !(m.s.reworkCount > 0));
    const hoDue = ps.filter((p) => p.status === 'Closed' || (isActive(p) && p.kind !== 'es_pending' && isPast(p.committedDate)));
    const hoOn = hoDue.filter((p) => p.status === 'Closed' && (p.handoverAt || isoD(p.closedAt)) <= p.committedDate);
    const cab = ps.filter((p) => p.kind === 'es_large' || p.kind === 'es_small').map((p) => { const f = st(p, p.kind === 'es_small' ? 'install' : 'cable').fields; return { p, pl: Number(f.plannedLength) || 0, ac: Number(f.actualLength) || 0 }; }).filter((x) => x.pl && x.ac);
    const nm = db.find('netMetering', (n) => pids.has(n.projectId) && n.plannedSubmit && new Date(n.plannedSubmit) <= T0);
    const nmOn = nm.filter((n) => n.actualSubmit && n.actualSubmit <= n.plannedSubmit);
    const avg = (a) => (a.length ? Math.round((sumBy(a, 'd') / a.length) * 10) / 10 : 0);
    return {
      survey: { label: 'Site survey on-time %', value: util.pct(svOn.length, sv.length), fmt: 'pct', n: svOn.length + ' / ' + sv.length, formula: 'Surveys completed by due date ÷ surveys due × 100', rows: sv.map((s) => ({ id: s.projectId, a: s.id, b: fmt.date(s.fields.plannedDate), c: fmt.date(s.fields.actualDate), ok: svOn.includes(s) })) },
      boq: { label: 'BOQ turnaround time', value: avg(boqT), fmt: 'days', n: boqT.length + ' BOQs', formula: 'BOQ submission timestamp − survey completion timestamp', rows: boqT.map((x) => ({ id: x.b.projectId, a: x.b.id, b: fmt.dateTime(x.b.submittedAt), c: x.d.toFixed(1) + ' d', ok: x.d <= 3 })) },
      purchase: { label: 'Purchase initiation time', value: avg(prT), fmt: 'days', n: prT.length + ' PRs', formula: 'Purchase requisition creation − BOQ approval', rows: prT.map((x) => ({ id: x.r.projectId, a: x.r.id, b: fmt.dateTime(x.r.createdAt), c: x.d.toFixed(1) + ' d', ok: x.d <= 2 })) },
      readiness: { label: 'Material readiness %', value: util.pct(ready.length, sched.length), fmt: 'pct', n: ready.length + ' / ' + sched.length, formula: 'Projects ready with required materials ÷ projects scheduled to start × 100', rows: sched.map((p) => ({ id: p.id, a: curLabel(p), b: shortages(p).length + ' short lines', c: DONE(st(p, 'delivery')) ? 'Site-verified' : materialReady(p) ? 'Allocated' : 'Short', ok: ready.includes(p) })) },
      install: { label: 'Installation on-time %', value: util.pct(msOn.length, ms.length), fmt: 'pct', n: msOn.length + ' / ' + ms.length, formula: 'Installation milestones completed on time ÷ milestones due × 100', rows: ms.map((m) => ({ id: m.p.id, a: m.l, b: fmt.date(m.s.due), c: fmt.date(m.s.doneAt), ok: msOn.includes(m) })) },
      inspection: { label: 'First-time inspection pass %', value: util.pct(inspOk.length, insp.length), fmt: 'pct', n: inspOk.length + ' / ' + insp.length, formula: 'Inspections passed without rework ÷ inspections performed × 100', rows: insp.map((m) => ({ id: m.p.id, a: m.l, b: 'Rework ×' + (m.s.reworkCount || 0), c: m.s.status, ok: inspOk.includes(m) })) },
      handover: { label: 'Project handover on-time %', value: util.pct(hoOn.length, hoDue.length), fmt: 'pct', n: hoOn.length + ' / ' + hoDue.length, formula: 'Projects handed over by committed date ÷ projects due for handover × 100', rows: hoDue.map((p) => ({ id: p.id, a: fmt.date(p.committedDate), b: p.status, c: fmt.date(p.handoverAt), ok: hoOn.includes(p) })) },
      variance: { label: 'Material variance %', value: cab.length ? Math.round(sumBy(cab, (x) => Math.abs(x.ac - x.pl)) / sumBy(cab, 'pl') * 1000) / 10 : 0, fmt: 'pct', n: cab.length + ' cable records', formula: 'Actual material consumption variance ÷ approved material quantity × 100', rows: cab.map((x) => ({ id: x.p.id, a: x.pl + ' m planned', b: x.ac + ' m actual', c: Math.round((x.ac - x.pl) / x.pl * 1000) / 10 + '%', ok: Math.abs(x.ac - x.pl) / x.pl <= 0.1 })) },
      netmeter: { label: 'Net-metering submission on-time %', value: util.pct(nmOn.length, nm.length), fmt: 'pct', n: nmOn.length + ' / ' + nm.length, formula: 'Applications submitted by due date ÷ applications due × 100', rows: nm.map((n) => ({ id: n.projectId, a: n.id, b: fmt.date(n.plannedSubmit), c: fmt.date(n.actualSubmit), ok: nmOn.includes(n) })) },
    };
  }
  function kpiTiles(k, keys) {
    return ui.kpis(keys.map((key) => { const x = k[key]; const good = x.fmt === 'days' ? x.value <= 3 : key === 'variance' ? x.value <= 10 : x.value >= 80; return { label: x.label, value: x.fmt === 'days' ? x.value + ' d' : fmt.pct(x.value), meta: x.n, tone: good ? 'up' : 'down', color: good ? 'var(--ok)' : 'var(--warn)', onClick: () => kpiDrill(x) }; }));
  }
  function kpiDrill(x) {
    ui.drawer({ title: x.label, sub: x.formula, body: h('div', { class: 'stack' }, [ui.callout('Traceable to underlying CRM transactions. Actual performance shown separately from targets (targets configured from approved FY 2026–27 objectives).', 'info'), ui.table({ rows: x.rows, columns: [{ key: 'id', label: 'Project', render: (r) => pLink(r.id) }, { key: 'a', label: 'Record' }, { key: 'b', label: 'Due / basis' }, { key: 'c', label: 'Actual' }, { key: 'ok', label: 'Result', render: (r) => ui.badge(r.ok ? 'On time' : 'Missed', r.ok ? 'ok' : 'bad') }] })]) });
  }

  // ------------------------------------------------------------------ dashboards
  const monthsBack = (n) => Array.from({ length: n }, (_, i) => { const d = new Date(T0.getFullYear(), T0.getMonth() - (n - 1 - i), 1); return { y: d.getFullYear(), m: d.getMonth(), label: d.toLocaleString('en-IN', { month: 'short' }) }; });
  const inMonth = (d, mo) => { if (!d) return false; const x = new Date(d); return x.getFullYear() === mo.y && x.getMonth() === mo.m; };
  function plannedVsActual(ps) {
    const ms = monthsBack(6);
    return ui.lineChart(ms.map((m) => m.label), [{ name: 'Planned completions (committed)', color: 'var(--chart-4)', values: ms.map((m) => ps.filter((p) => inMonth(p.committedDate, m)).length), dashed: true }, { name: 'Actual completions', color: 'var(--chart-2)', values: ms.map((m) => ps.filter((p) => p.status === 'Closed' && inMonth(p.closedAt, m)).length) }]);
  }
  function stageBars(ps, kind) {
    const wf = WF[kind];
    return ui.barChart(wf.map(([k, l]) => ({ label: l.split(' ')[0] + (l.split(' ')[1] ? ' ' + l.split(' ')[1] : ''), values: [ps.filter((p) => p.kind === kind && isActive(p) && curKey(p) === k).length] })), [{ name: 'Projects', color: kind === 'solar' ? 'var(--div-solar)' : kind === 'es_small' ? 'var(--chart-6)' : 'var(--div-security)' }], { height: 200 });
  }
  function vendorPerf(ps) {
    const map = {};
    ps.forEach((p) => (p.tasks || []).forEach((t) => { const s = db.get('staff', t.assignee); if (!s || !['vendor', 'install_lead'].includes(s.role)) return; const m = map[t.assignee] = map[t.assignee] || { id: t.assignee, name: s.name, role: s.role, total: 0, done: 0, late: 0, rework: 0, open: 0 }; if (t.kind === 'Rework') { m.rework++; return; } m.total++; if (['Completed', 'Approved'].includes(t.status)) { m.done++; if (t.doneAt && isoD(t.doneAt) > t.due) m.late++; } else { m.open++; if (isPast(t.due)) m.late++; } }));
    return Object.values(map);
  }
  function vendorTable(ps) { return ui.table({ search: false, rows: vendorPerf(ps), empty: 'No vendor / team tasks yet', columns: [{ key: 'name', label: 'Vendor / team' }, { key: 'role', label: 'Type', render: (r) => (r.role === 'vendor' ? ui.badge('Vendor', 'violet') : ui.badge('Own team', 'info')) }, { key: 'total', label: 'Tasks', cls: 'right' }, { key: 'done', label: 'Completed', cls: 'right' }, { key: 'open', label: 'Open', cls: 'right' }, { key: 'late', label: 'Delayed', cls: 'right', render: (r) => (r.late ? ui.badge(r.late, 'bad') : 0) }, { key: 'rework', label: 'Rework', cls: 'right', render: (r) => (r.rework ? ui.badge(r.rework, 'warn') : 0) }, { key: 'ot', label: 'On-time %', cls: 'right', render: (r) => fmt.pct(util.pct(r.done + r.open - r.late, r.done + r.open)) }] }); }
  function countRow(items) { return h('div', { class: 'grid g4' }, items.map(([l, v, tone, link]) => h('a', { class: 'card card-body', href: link || null, style: 'display:block' }, [h('div', { class: 'small muted' }, l), h('div', { style: 'font-size:22px;font-weight:700;color:' + (tone ? 'var(--' + tone + ')' : 'var(--text)') }, String(v))]))); }
  function renderESDash(el) {
    const ps = db.find('projects', (p) => p.division === ESD);
    const act = ps.filter(isActive);
    const atKey = (k) => act.filter((p) => curKey(p) === k);
    const k = kpiData(ps);
    const prs = db.find('purchaseRequests', (r) => r.division === ESD && ['Draft', 'Pending Approval', 'Approved'].includes(r.status));
    const pos = db.find('purchaseOrders', (r) => r.division === ESD && !['Received', 'Cancelled'].includes(r.status));
    ui.page(el, { title: 'Project Installation Dashboard', sub: 'Electronic Security · large projects and small installation jobs (ES CRM §10.2)', actions: [ui.btn('Projects register', () => CRM.go('projects'))] });
    el.appendChild(ui.kpis([
      { label: 'Large projects active', value: act.filter((p) => p.kind === 'es_large').length, color: 'var(--div-security)', onClick: () => CRM.go('projects') },
      { label: 'Small jobs active', value: act.filter((p) => p.kind === 'es_small').length, color: 'var(--chart-6)' },
      { label: 'Overdue activities', value: act.filter(projOverdue).length, color: 'var(--bad)', tone: 'down', meta: 'survey · BOQ · procurement · installation · handover' },
      { label: 'Delayed by material shortage', value: act.filter((p) => approvedBoq(p.id) && shortages(p).length).length, color: 'var(--warn)' },
      { label: 'Open policy violations', value: allViolations().filter((v) => v.division === ESD).length, color: 'var(--chart-4)', onClick: () => CRM.go('proj-compliance') },
    ]));
    el.appendChild(countRow([
      ['Awaiting site survey', atKey('survey').length, 'info', '#/surveys'], ['BOQs awaiting preparation / approval', atKey('boq').length + ' (' + db.find('boqs', (b) => b.division === ESD && b.status === 'Submitted').length + ' to approve)', 'warn', '#/boqs'],
      ['PRs / POs pending', prs.length + ' / ' + pos.length, null, '#/purchase-requests'], ['Supplier deliveries overdue', pos.filter((po) => isPast(po.promisedDate)).length, 'bad', '#/purchase-orders'],
      ['Projects with material shortages', act.filter((p) => approvedBoq(p.id) && shortages(p).length).length, 'warn', '#/project-material'], ['Cable laying pending', atKey('cable').length, null], ['DVR/NVR installation pending', atKey('nvr').length, null], ['Cameras/devices awaiting installation', sumBy(act.filter((p) => curIndex(p) >= 5), (p) => (p.devices || []).filter((d) => !d.installed).length), null, '#/device-schedule'],
      ['Configuration & testing pending', atKey('testing').length, null], ['Awaiting inspection', act.filter((p) => Object.values(p.stages || {}).some((s) => s.status === 'Submitted for Inspection')).length, 'warn', '#/quality'], ['Customer handover pending', atKey('handover').length + atKey('activate').length, 'info', '#/handover'], ['On hold', ps.filter((p) => p.status === 'On Hold').length, 'warn'],
    ]));
    el.appendChild(h('div', { class: 'grid g2 mt' }, [ui.card('Large projects by stage', stageBars(ps, 'es_large')), ui.card('Small installation jobs by stage', stageBars(ps, 'es_small')), ui.card('Planned versus actual completion', plannedVsActual(ps)), ui.card('KPIs (ES CRM §12)', kpiTiles(k, ['survey', 'install', 'inspection', 'handover']))]));
    el.appendChild(h('div', { class: 'grid g2 mt' }, [ui.card('Vendor-wise completion, delays and rework', vendorTable(ps), { flush: true }), ui.card('Projects on hold and reasons', ui.table({ search: false, rows: ps.filter((p) => p.status === 'On Hold'), onRow: (p) => CRM.go('projects', p.id), empty: 'No projects on hold', columns: [{ key: 'id', label: 'Project', render: (p) => pLink(p.id) }, { key: 'c', label: 'Customer', render: (p) => cust(p.customerId).name }, { key: 'holdReason', label: 'Reason' }, { key: 'holdAt', label: 'Since', render: (p) => fmt.date(p.holdAt) }] }), { flush: true })]));
  }
  function renderSolarDash(el) {
    const f = { month: '', cap: '', type: '', owner: '' };
    ui.page(el, { title: 'Solar Project Execution Dashboard', sub: 'Solar CRM §9.1–9.2 · live from project, procurement and compliance records' });
    const bar = h('div', { class: 'filters card', style: 'margin-bottom:16px' });
    const mk = (key, label, opts) => { const s = h('select', { onChange: (e) => { f[key] = e.target.value; draw(); } }, [h('option', { value: '' }, 'All ' + label)].concat(opts.map((o) => h('option', { value: o.value || o }, o.label || o)))); bar.appendChild(s); };
    mk('month', 'months (order)', monthsBack(6).map((m) => ({ value: m.y + '-' + m.m, label: m.label + ' ' + m.y })));
    mk('cap', 'capacities', ['≤ 5 kWp', '5–20 kWp', '> 20 kWp']);
    mk('type', 'project types', SOLAR_TYPES);
    mk('owner', 'technical owners', master.staff('tech_engineer').map((s) => ({ value: s.id, label: s.name })));
    el.appendChild(bar);
    const body = h('div'); el.appendChild(body);
    function draw() {
      body.innerHTML = '';
      const ps = db.find('projects', (p) => p.kind === 'solar').filter((p) => (!f.month || (new Date(p.createdAt).getFullYear() + '-' + new Date(p.createdAt).getMonth()) === f.month) && (!f.cap || (f.cap[0] === '≤' ? p.capacityKw <= 5 : f.cap[0] === '>' ? p.capacityKw > 20 : p.capacityKw > 5 && p.capacityKw <= 20)) && (!f.type || p.projectType === f.type) && (!f.owner || p.engineer === f.owner));
      const act = ps.filter(isActive); const at = (k) => act.filter((p) => curKey(p) === k);
      const k = kpiData(ps);
      const soldOrders = db.find('orders', (o) => o.division === SOL && !db.one('projects', (p) => p.orderId === o.id || p.soNumber === o.soNumber) && !/cancel|lost/i.test(o.status || ''));
      const nmAwait = act.filter((p) => { const n = db.one('netMetering', (x) => x.projectId === p.id); return n && NM_STATUS.indexOf(n.status) < 3; });
      const sbAwait = act.filter((p) => { const s = db.one('subsidies', (x) => x.projectId === p.id); return s && s.eligibility !== 'Not Eligible' && SUB_STATUS.indexOf(s.status) < 3; });
      body.appendChild(ui.kpis([
        { label: 'Projects in progress', value: act.length, color: 'var(--div-solar)' },
        { label: 'Projects overdue', value: act.filter(projOverdue).length, color: 'var(--bad)', tone: 'down', meta: 'milestone & total delays' },
        { label: 'Material readiness %', value: fmt.pct(k.readiness.value), meta: k.readiness.n, onClick: () => kpiDrill(k.readiness) },
        { label: 'On-time handover %', value: fmt.pct(k.handover.value), meta: k.handover.n, onClick: () => kpiDrill(k.handover) },
        { label: 'Net-metering submission on-time %', value: fmt.pct(k.netmeter.value), meta: k.netmeter.n, onClick: () => kpiDrill(k.netmeter) },
      ]));
      body.appendChild(countRow([
        ['Sales Orders awaiting handover', soldOrders.length, soldOrders.length ? 'warn' : null], ['Site visits pending', at('survey').length, 'info', '#/surveys'], ['BOQs pending preparation / approval', at('boq').length, 'warn', '#/boqs'], ['Purchase requisitions pending', db.find('purchaseRequests', (r) => r.division === SOL && ['Draft', 'Pending Approval'].includes(r.status)).length, null, '#/purchase-requests'],
        ['Supplier deliveries overdue', db.find('purchaseOrders', (r) => r.division === SOL && !['Received', 'Cancelled'].includes(r.status) && isPast(r.promisedDate)).length, 'bad', '#/purchase-orders'], ['Civil / mechanical / electrical pending', at('civil').length + ' / ' + at('mechanical').length + ' / ' + at('electrical').length, null], ['Awaiting inspection / commissioning', act.filter((p) => Object.values(p.stages || {}).some((s) => s.status === 'Submitted for Inspection')).length + ' / ' + at('commissioning').length, 'warn', '#/quality'], ['Awaiting net-metering documentation', nmAwait.length, 'info', '#/net-metering'],
        ['Awaiting subsidy documentation', sbAwait.length, 'info', '#/subsidy'], ['Awaiting customer handover', at('handover').length, null, '#/handover'], ['Repeated schedule changes (≥2)', ps.filter((p) => (p.dateRevisions || []).length >= 2).length, 'warn'], ['On hold', ps.filter((p) => p.status === 'On Hold').length, 'warn'],
      ]));
      body.appendChild(h('div', { class: 'grid g2 mt' }, [ui.card('Projects by stage', stageBars(ps, 'solar')), ui.card('Planned versus actual project completion', plannedVsActual(ps)),
        ui.card('Material shortages by project', ui.table({ search: false, rows: act.filter((p) => approvedBoq(p.id) && shortages(p).length), onRow: (p) => CRM.go('projects', p.id, 'procurement'), empty: 'No shortages', columns: [{ key: 'id', label: 'Project', render: (p) => pLink(p.id) }, { key: 'c', label: 'Customer', render: (p) => cust(p.customerId).name }, { key: 's', label: 'Short items', render: (p) => shortages(p).map((x) => stockName(x.stockId) + ' (' + x.short + ')').join(', ') }] }), { flush: true }),
        ui.card('Vendor-wise delays and rework', vendorTable(ps), { flush: true }),
        ui.card('Projects on hold and reasons', ui.table({ search: false, rows: ps.filter((p) => p.status === 'On Hold'), empty: 'None', columns: [{ key: 'id', label: 'Project', render: (p) => pLink(p.id) }, { key: 'holdReason', label: 'Reason' }] }), { flush: true }),
        ui.card('Repeated schedule changes', ui.table({ search: false, rows: ps.filter((p) => (p.dateRevisions || []).length >= 1), empty: 'None', columns: [{ key: 'id', label: 'Project', render: (p) => pLink(p.id) }, { key: 'n', label: 'Revisions', render: (p) => ui.badge((p.dateRevisions || []).length, (p.dateRevisions || []).length >= 2 ? 'bad' : 'warn') }, { key: 'committedDate', label: 'Original', render: (p) => fmt.date(p.committedDate) }, { key: 'revisedDate', label: 'Current revised', render: (p) => fmt.date(p.revisedDate) }] }), { flush: true })]));
    }
    draw();
  }

  // ------------------------------------------------------------------ surveys / BOQ pages
  function renderSurveys(el, params) {
    const pset = new Set(myProjects().map((p) => p.id));
    const rows = db.find('surveys', (s) => pset.has(s.projectId) || CRM.is('tech_head', 'gm', 'admin', 'odm'));
    ui.page(el, { title: 'Site Visits & Technical Surveys', sub: 'Scheduled → submitted → reviewed. BOQ preparation is enabled only after a complete, approved survey.' });
    const view = rows.map((s) => Object.assign({}, s, { customer: cust((db.get('projects', s.projectId) || {}).customerId).name, engName: sName(s.fields.engineer), late: s.status === 'Scheduled' && isPast(s.fields.plannedDate) ? 'Overdue' : '' }));
    el.appendChild(ui.kpis([{ label: 'Scheduled', value: rows.filter((s) => s.status === 'Scheduled').length }, { label: 'Visit overdue', value: view.filter((s) => s.late).length, color: 'var(--bad)' }, { label: 'Awaiting review', value: rows.filter((s) => s.status === 'Submitted').length, color: 'var(--warn)' }, { label: 'Returned for correction', value: rows.filter((s) => s.status === 'Returned for correction').length }, { label: 'Not feasible (technical review)', value: rows.filter((s) => s.status === 'Not Feasible').length, color: 'var(--bad)' }]));
    el.appendChild(ui.card(null, ui.table({ rows: view, onRow: (s) => surveyDrawer(s.id), filters: [{ key: 'status', label: 'statuses', options: ['Scheduled', 'Draft', 'Submitted', 'Returned for correction', 'Approved', 'Revisit Required', 'Not Feasible'] }, { key: 'division', label: 'divisions', options: [ESD, SOL] }], columns: [{ key: 'id', label: 'Survey', render: (s) => mono(s.id) }, { key: 'projectId', label: 'Project', render: (s) => pLink(s.projectId) }, { key: 'customer', label: 'Customer' }, { key: 'division', label: 'Division', render: (s) => ui.divTag(s.division) }, { key: 'engName', label: 'Engineer' }, { key: 'planned', label: 'Planned', render: (s) => h('span', {}, [fmt.date(s.fields.plannedDate), s.late ? ' ' : '', s.late ? ui.badge('Overdue', 'bad') : '']) }, { key: 'actual', label: 'Actual', render: (s) => fmt.date(s.fields.actualDate) }, { key: 'feas', label: 'Outcome', render: (s) => ui.badge(s.fields.feasibility || '—') }, { key: 'status', label: 'Status', render: (s) => ui.badge(s.status) }] }), { flush: true }));
    if (params[0]) setTimeout(() => surveyDrawer(params[0]));
  }
  function renderBoqs(el) {
    const pset = new Set(myProjects().map((p) => p.id));
    const rows = db.find('boqs', (b) => pset.has(b.projectId) || CRM.is('tech_head', 'purchase', 'gm', 'admin', 'odm'));
    ui.page(el, { title: 'BOQ & Approvals', sub: 'Structured, version-controlled material lists — revisions never overwrite previous versions' });
    el.appendChild(ui.kpis([{ label: 'Awaiting technical approval', value: rows.filter((b) => b.status === 'Submitted').length, color: 'var(--warn)' }, { label: 'Drafts in preparation', value: rows.filter((b) => b.status === 'Draft').length }, { label: 'Approved (current)', value: rows.filter((b) => b.status === 'Approved').length, color: 'var(--ok)' }, { label: 'Revisions (v2+)', value: rows.filter((b) => b.version > 1).length }, { label: 'Rejected', value: rows.filter((b) => b.status === 'Rejected').length, color: 'var(--bad)' }]));
    const view = rows.map((b) => Object.assign({}, b, { customer: cust((db.get('projects', b.projectId) || {}).customerId).name, value: boqValue(b) }));
    el.appendChild(ui.card(null, ui.table({ rows: view, onRow: (b) => boqDrawer(b.id), filters: [{ key: 'status', label: 'statuses', options: ['Draft', 'Submitted', 'Approved', 'Rejected', 'Superseded'] }, { key: 'division', label: 'divisions', options: [ESD, SOL] }], columns: [{ key: 'id', label: 'BOQ', render: (b) => mono(b.id) }, { key: 'version', label: 'Ver.', render: (b) => 'v' + b.version }, { key: 'projectId', label: 'Project', render: (b) => pLink(b.projectId) }, { key: 'customer', label: 'Customer' }, { key: 'items', label: 'Items', render: (b) => b.items.length }, { key: 'value', label: 'Est. value', cls: 'right', render: (b) => fmt.lakh(b.value) }, { key: 'preparedBy', label: 'Prepared by' }, { key: 'submittedAt', label: 'Submitted', render: (b) => fmt.date(b.submittedAt) }, { key: 'approvedBy', label: 'Approver' }, { key: 'status', label: 'Status', render: (b) => ui.badge(b.status) }] }), { flush: true }));
  }

  // ------------------------------------------------------------------ device register & secure credential vault
  function renderDevices(el) {
    const ps = myProjects().filter((p) => p.division === ESD || CRM.is('tech_head', 'gm', 'admin', 'odm'));
    const rows = ps.flatMap((p) => (p.devices || []).map((d) => Object.assign({ projectId: p.id, customer: cust(p.customerId).name, pstatus: p.status }, d)));
    const vaultOk = CRM.is('tech_head', 'admin');
    ui.page(el, { title: 'Camera / Device Schedule', sub: 'Every device with location, ID, serial number, recording channel, test and installation status' });
    el.appendChild(ui.kpis([{ label: 'Devices scheduled', value: rows.length }, { label: 'Installed', value: rows.filter((d) => d.installed).length, color: 'var(--ok)' }, { label: 'Awaiting installation', value: rows.filter((d) => !d.installed && d.pstatus !== 'Cancelled').length, color: 'var(--warn)' }, { label: 'Failed tests', value: rows.filter((d) => d.test === 'Fail').length, color: 'var(--bad)' }, { label: 'Missing serials (installed)', value: rows.filter((d) => d.installed && !d.serial).length }]));
    el.appendChild(ui.tabs([{ id: 'reg', label: 'Device register' }, { id: 'vault', label: '🔒 Secure credential vault' }], (t, body) => {
      if (t === 'reg') body.appendChild(ui.card(null, ui.table({ rows, onRow: (d) => CRM.go('projects', d.projectId), filters: [{ key: 'type', label: 'types', options: Object.keys(util.countBy(rows, 'type')) }, { key: 'test', label: 'test statuses', options: ['Pending', 'Pass', 'Fail'] }], columns: [{ key: 'projectId', label: 'Project', render: (d) => pLink(d.projectId) }, { key: 'customer', label: 'Customer' }, { key: 'tag', label: 'Device ID' }, { key: 'type', label: 'Type' }, { key: 'name', label: 'Make / model' }, { key: 'location', label: 'Location' }, { key: 'serial', label: 'Serial', render: (d) => mono(d.serial) }, { key: 'channel', label: 'Channel' }, { key: 'test', label: 'Test', render: (d) => ui.badge(d.test === 'Pass' ? 'Passed' : d.test === 'Fail' ? 'Failed' : 'Pending') }, { key: 'installed', label: 'Installed', render: (d) => (d.installed ? ui.badge('Yes', 'ok') : ui.badge('No', 'warn')) }] }), { flush: true }));
      if (t === 'vault') {
        if (!vaultOk) { body.appendChild(ui.callout('<b>Restricted.</b> Device credentials and sensitive security configuration have stricter access than ordinary project records — only the Technical Head and CRM Administrator can open the vault. Every access is audited.', 'bad')); return; }
        const vs = db.all('credVault');
        body.appendChild(ui.callout('Placeholder for the approved secure credential mechanism: the CRM stores only vault references and an access audit — never passwords, recovery codes or network secrets.', 'info'));
        body.appendChild(h('div', { class: 'mt' }, ui.card('Credential references', ui.table({ rows: vs, columns: [{ key: 'id', label: 'Vault ID', render: (v) => mono(v.id) }, { key: 'projectId', label: 'Project', render: (v) => pLink(v.projectId) }, { key: 'deviceTag', label: 'Device' }, { key: 'account', label: 'Account' }, { key: 'secretRef', label: 'Vault reference', render: (v) => mono(v.secretRef.replace(/#.*/, '#…')) }, { key: 'storedBy', label: 'Lodged by' }, { key: 'createdAt', label: 'Lodged', render: (v) => fmt.date(v.createdAt) }, { key: 'access', label: 'Accesses', render: (v) => (v.access || []).length }], actions: (v) => [ui.btn('Access', () => vaultReveal(v), 'sm')] }), { flush: true })));
        const log = vs.flatMap((v) => (v.access || []).map((a) => Object.assign({ vid: v.id, dev: v.deviceTag, pid: v.projectId }, a))).sort((a, b) => (a.ts < b.ts ? 1 : -1));
        body.appendChild(h('div', { class: 'mt' }, ui.card('Vault access audit', ui.table({ rows: log, empty: 'No access yet', columns: [{ key: 'ts', label: 'When', render: (a) => fmt.dateTime(a.ts) }, { key: 'by', label: 'User' }, { key: 'role', label: 'Role' }, { key: 'vid', label: 'Vault ID' }, { key: 'pid', label: 'Project' }, { key: 'dev', label: 'Device' }, { key: 'reason', label: 'Reason' }] }), { flush: true })));
      }
    }));
  }

  // ------------------------------------------------------------------ installation tasks & cross-project Gantt
  function allTasks(ps) { return ps.flatMap((p) => (p.tasks || []).map((t) => Object.assign({ projectId: p.id, customer: cust(p.customerId).name, division: p.division, assigneeName: sName(t.assignee), overdue: isPast(t.due) && !['Completed', 'Approved', 'Accepted'].includes(t.status) ? 'Overdue' : '' }, t))); }
  function renderTasks(el) {
    const ps = myProjects();
    const tasks = allTasks(ps);
    ui.page(el, { title: 'Installation Tasks & Schedule', sub: 'Team / vendor tasks, planned versus actual Gantt, dependencies and workload' });
    el.appendChild(ui.kpis([{ label: 'Open tasks', value: tasks.filter((t) => !['Completed', 'Approved', 'Accepted'].includes(t.status)).length }, { label: 'Overdue', value: tasks.filter((t) => t.overdue).length, color: 'var(--bad)' }, { label: 'Awaiting inspection', value: tasks.filter((t) => t.status === 'Submitted for Inspection').length, color: 'var(--warn)' }, { label: 'Open rework', value: tasks.filter((t) => t.kind === 'Rework' && !['Completed', 'Accepted'].includes(t.status)).length, color: 'var(--chart-4)' }]));
    el.appendChild(ui.tabs([{ id: 't', label: 'Task list' }, { id: 'g', label: 'Gantt (planned vs actual)' }, { id: 'w', label: 'Team workload' }], (id, body) => {
      if (id === 't') body.appendChild(ui.card(null, ui.table({ rows: tasks, onRow: (t) => CRM.go('projects', t.projectId), filters: [{ key: 'status', label: 'statuses', options: ['Planned', 'In Progress', 'Submitted for Inspection', 'Rework Required', 'Approved', 'Completed', 'Accepted'] }, { key: 'kind', label: 'types', options: ['Installation', 'Rework', 'Follow-up'] }, { key: 'assigneeName', label: 'owners', options: Object.keys(util.countBy(tasks, 'assigneeName')) }, { key: 'overdue', label: 'overdue', options: ['Overdue'] }], columns: [{ key: 'projectId', label: 'Project', render: (t) => pLink(t.projectId) }, { key: 'customer', label: 'Customer' }, { key: 'kind', label: 'Type', render: (t) => ui.badge(t.kind, t.kind === 'Rework' ? 'warn' : 'info') }, { key: 'title', label: 'Task' }, { key: 'assigneeName', label: 'Owner' }, { key: 'due', label: 'Due', render: (t) => h('span', {}, [fmt.date(t.due), t.overdue ? ' ' : '', t.overdue ? ui.badge('Overdue', 'bad') : '']) }, { key: 'status', label: 'Status', render: (t) => ui.badge(t.status) }], actions: (t) => taskActions(db.get('projects', t.projectId), t) }), { flush: true }));
      if (id === 'g') {
        const act = ps.filter((p) => isActive(p) && p.kind !== 'es_pending').sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1)).slice(-25);
        const start = new Date(Math.min(...act.map((p) => new Date(p.createdAt))));
        const end = new Date(Math.max(T0.getTime() + 20 * 864e5, ...act.map((p) => new Date(p.revisedDate || p.committedDate))));
        const pos = (d) => ((new Date(d) - start) / (end - start)) * 100;
        body.appendChild(ui.card('Active projects — committed plan vs actual progress', h('div', { class: 'stack', style: 'gap:6px' }, act.map((p) => h('div', { style: 'display:grid;grid-template-columns:200px 1fr;gap:8px;align-items:center;font-size:12px' }, [h('a', { href: plink(p.id) }, p.id + ' · ' + cust(p.customerId).name.slice(0, 16)), h('div', { style: 'position:relative;height:20px;background:var(--surface-3);border-radius:4px' }, [h('div', { title: 'Planned ' + fmt.date(p.createdAt) + ' → ' + fmt.date(p.committedDate), style: 'position:absolute;top:2px;height:7px;border-radius:3px;background:var(--border-strong);left:' + pos(p.createdAt) + '%;width:' + Math.max(1, pos(p.committedDate) - pos(p.createdAt)) + '%' }), p.revisedDate ? h('div', { title: 'Revised to ' + fmt.date(p.revisedDate), style: 'position:absolute;top:2px;height:7px;width:3px;background:var(--warn);left:' + pos(p.revisedDate) + '%' }) : null, h('div', { title: curLabel(p) + ' · ' + progressPct(p) + '%', style: 'position:absolute;top:11px;height:7px;border-radius:3px;background:' + (projOverdue(p) ? 'var(--bad)' : 'var(--ok)') + ';left:' + pos(p.createdAt) + '%;width:' + Math.max(1, (pos(T0) - pos(p.createdAt)) * Math.min(1, progressPct(p) / 100 + 0.05)) + '%' }), h('div', { style: 'position:absolute;top:0;bottom:0;width:2px;background:var(--warn);left:' + pos(T0) + '%' })])])).concat(h('div', { class: 'legend' }, [h('span', {}, [h('i', { style: 'background:var(--border-strong)' }), 'Planned (SO → committed date)']), h('span', {}, [h('i', { style: 'background:var(--ok)' }), 'Actual progress']), h('span', {}, [h('i', { style: 'background:var(--bad)' }), 'Delayed']), h('span', {}, [h('i', { style: 'background:var(--warn)' }), 'Today / revised date'])])))));
      }
      if (id === 'w') {
        const open = tasks.filter((t) => !['Completed', 'Approved', 'Accepted'].includes(t.status));
        const by = util.groupBy(open, 'assigneeName');
        body.appendChild(h('div', { class: 'grid g2' }, [ui.card('Open tasks per owner', ui.hbars(Object.keys(by).map((k) => ({ label: k, value: by[k].length, text: by[k].length + ' open · ' + by[k].filter((t) => t.overdue).length + ' overdue' })))), ui.card('Vendor & team performance', vendorTable(ps), { flush: true })]));
      }
    }));
  }

  // ------------------------------------------------------------------ installation quality, handover, compliance
  function renderQuality(el) {
    const ps = myProjects();
    const pending = ps.flatMap((p) => workflow(p).filter(([k]) => st(p, k).status === 'Submitted for Inspection').map(([k, l]) => ({ p, k, l, s: st(p, k) })));
    const rework = allTasks(ps).filter((t) => t.kind === 'Rework');
    const k = kpiData(ps);
    ui.page(el, { title: 'Inspection, Testing & Rework', sub: 'A failed test creates a rework task with owner and due date; technical completion needs all mandatory checks approved' });
    el.appendChild(kpiTiles(k, ['inspection', 'install', 'variance']));
    el.appendChild(ui.card('Awaiting inspection / approval', ui.table({ rows: pending, empty: 'Nothing awaiting inspection', onRow: (r) => CRM.go('projects', r.p.id, r.k), columns: [{ key: 'p', label: 'Project', render: (r) => pLink(r.p.id) }, { key: 'c', label: 'Customer', render: (r) => cust(r.p.customerId).name }, { key: 'l', label: 'Stage' }, { key: 'sub', label: 'Submitted', render: (r) => fmt.dateTime(r.s.submittedAt) }, { key: 'ap', label: 'Approver', render: (r) => (stageDef(r.p, r.k).approval || []).map((x) => CRM.role(x).name).join(' / ') }, { key: 'rw', label: 'Previous rework', render: (r) => r.s.reworkCount || 0 }] }), { flush: true }));
    el.appendChild(h('div', { class: 'mt' }, ui.card('Rework & corrective tasks (failed tests, defects)', ui.table({ rows: rework, onRow: (t) => CRM.go('projects', t.projectId), filters: [{ key: 'status', label: 'statuses', options: ['Planned', 'In Progress', 'Completed', 'Accepted'] }], columns: [{ key: 'projectId', label: 'Project', render: (t) => pLink(t.projectId) }, { key: 'title', label: 'Rework' }, { key: 'assigneeName', label: 'Owner' }, { key: 'due', label: 'Due', render: (t) => h('span', {}, [fmt.date(t.due), t.overdue ? ' ' : '', t.overdue ? ui.badge('Overdue', 'bad') : '']) }, { key: 'status', label: 'Status', render: (t) => ui.badge(t.status) }], actions: (t) => taskActions(db.get('projects', t.projectId), t) }), { flush: true })));
  }
  function handoverMissing(p) {
    const d = stageDef(p, 'handover'), s = st(p, 'handover');
    const miss = (d.checklist || []).filter((x, i) => !(s.done || []).includes(i)).concat((d.docs || []).filter((x, i) => !(s.docsDone || []).includes(i)));
    if (!yes(s.fields.evidence)) miss.push('Signed acceptance evidence');
    return miss;
  }
  function renderHandover(el) {
    const ps = myProjects();
    const pend = ps.filter((p) => isActive(p) && ['handover', 'activate'].includes(curKey(p)));
    const closed = ps.filter((p) => p.status === 'Closed').sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));
    const k = kpiData(ps);
    ui.page(el, { title: 'Customer Handover & Closure', sub: 'Formal handover with mandatory records, recorded evidence and designated-owner closure approval' });
    el.appendChild(kpiTiles(k, ['handover']));
    el.appendChild(ui.card('Handover pending — missing items', ui.table({ rows: pend.map(viewRow), onRow: (p) => CRM.go('projects', p.id, curKey(p)), empty: 'No handovers pending', columns: [{ key: 'id', label: 'Project', render: (p) => pLink(p.id) }, { key: 'customerName', label: 'Customer' }, { key: 'kindLabel', label: 'Category', render: (p) => kindBadge(p) }, { key: 'committedDate', label: 'Committed', render: (p) => fmt.date(p.committedDate) }, { key: 'm', label: 'Missing documents / items', render: (p) => { const m = handoverMissing(p); return m.length ? h('span', { title: m.join('\n') }, ui.badge(m.length + ' missing', 'warn')) : ui.badge('Complete', 'ok'); } }, { key: 'stageLabel', label: 'Stage' }, { key: 'st', label: 'Stage status', render: (p) => ui.badge(st(p, curKey(p)).status) }] }), { flush: true }));
    el.appendChild(h('div', { class: 'mt' }, ui.card('Recently handed over / closed', ui.table({ rows: closed.map(viewRow), onRow: (p) => CRM.go('projects', p.id), columns: [{ key: 'id', label: 'Project', render: (p) => pLink(p.id) }, { key: 'customerName', label: 'Customer' }, { key: 'handoverAt', label: 'Handover', render: (p) => fmt.date(p.handoverAt) }, { key: 'committedDate', label: 'Committed', render: (p) => fmt.date(p.committedDate) }, { key: 'ot', label: 'On time', render: (p) => ui.badge((p.handoverAt || '') <= p.committedDate ? 'On time' : 'Late') }, { key: 'acc', label: 'Accepted by', render: (p) => st(p, 'handover').fields.acceptedBy || '—' }, { key: 'ex', label: 'Exception', render: (p) => (st(p, p.kind === 'es_small' ? 'activate' : 'handover').exception ? ui.badge('Admin closure', 'bad') : '—') }] }), { flush: true })));
  }
  function liveWarnings() {
    const out = [];
    db.all('projects').filter(isActive).forEach((p) => {
      const k = curKey(p); if (k && stageOverdue(p, k) && !st(p, k).delayReason) out.push({ p, type: 'Milestone overdue without recorded reason / action plan', details: curLabel(p) + ' overdue ' + daysLate(st(p, k).due) + 'd', sev: daysLate(st(p, k).due) > 7 ? 'Confirmed' : 'Warning' });
      if (approvedBoq(p.id) && shortages(p).length && curIndex(p) > workflow(p).findIndex((x) => x[0] === 'procurement')) out.push({ p, type: 'Installation stage reached with material shortage', details: shortages(p).length + ' short line(s)', sev: 'Warning' });
      if (latestBoq(p.id) && latestBoq(p.id).status === 'Draft' && latestBoq(p.id).version > 1 && db.one('purchaseOrders', (po) => po.projectId === p.id)) out.push({ p, type: 'BOQ change pending approval after purchase initiation', details: latestBoq(p.id).id, sev: 'Warning' });
    });
    return out;
  }
  function renderCompliance(el) {
    const vs = allViolations().filter((v) => !CRM.is('es_coordinator') || v.division === ESD).filter((v) => !CRM.is('solar_coordinator') || v.division === SOL);
    const warn = liveWarnings().filter((w) => !CRM.is('es_coordinator') || w.p.division === ESD).filter((w) => !CRM.is('solar_coordinator') || w.p.division === SOL);
    const byOwner = util.countBy(vs, (v) => sName(v.owner));
    ui.page(el, { title: 'Project Policy Compliance', sub: 'ES §10.4 / Solar §9.4 checks — confirmed violations are raised to the ODM desk; warnings are shown separately' });
    el.appendChild(ui.kpis([{ label: 'Violations raised', value: vs.length, color: 'var(--bad)' }, { label: 'High severity', value: vs.filter((v) => v.severity === 'High').length, color: 'var(--bad)' }, { label: 'Live warnings', value: warn.length, color: 'var(--warn)' }, { label: 'Repeat owners (≥2)', value: Object.values(byOwner).filter((n) => n >= 2).length, color: 'var(--chart-4)' }]));
    el.appendChild(h('div', { class: 'grid g3' }, [h('div', { class: 'span2' }, ui.card('Violations (policy reference, owner, severity)', ui.table({ rows: vs.sort((a, b) => (a.ts < b.ts ? 1 : -1)), filters: [{ key: 'type', label: 'types', options: Object.keys(util.countBy(vs, 'type')) }, { key: 'severity', label: 'severities', options: ['High', 'Medium', 'Low'] }, { key: 'division', label: 'divisions', options: [ESD, SOL] }], columns: [{ key: 'ts', label: 'Incident', render: (v) => fmt.date(v.ts) }, { key: 'type', label: 'Violation' }, { key: 'recId', label: 'Record', render: (v) => (v.projectId ? pLink(v.projectId) : mono(v.recId)) }, { key: 'owner', label: 'Responsible', render: (v) => sName(v.owner) }, { key: 'severity', label: 'Severity', render: (v) => ui.badge(v.severity) }, { key: 'policyRef', label: 'Policy ref' }, { key: 'details', label: 'Evidence / details' }] }), { flush: true })), ui.card('Repeat violations by owner / team / vendor', ui.hbars(Object.keys(byOwner).map((k) => ({ label: k, value: byOwner[k], color: byOwner[k] >= 2 ? 'var(--bad)' : 'var(--warn)' }))))]));
    el.appendChild(h('div', { class: 'mt' }, ui.card('Warnings (not yet confirmed violations)', ui.table({ rows: warn, empty: 'No warnings', columns: [{ key: 'p', label: 'Project', render: (w) => pLink(w.p.id) }, { key: 'type', label: 'Check' }, { key: 'details', label: 'Details' }, { key: 'sev', label: 'Level', render: (w) => ui.badge(w.sev, w.sev === 'Confirmed' ? 'bad' : 'warn') }] }), { flush: true })));
  }
  function renderKpis(el) {
    const div = CRM.is('solar_coordinator') ? SOL : CRM.is('es_coordinator') ? ESD : '';
    ui.page(el, { title: 'Project KPIs', sub: 'Calculated from actual system timestamps (ES CRM §12, Solar CRM §11). Click a KPI to drill down to the underlying records.' });
    const bodyEl = h('div');
    const sel = h('select', { onChange: (e) => draw(e.target.value) }, ['', ESD, SOL].map((d) => h('option', { value: d, selected: d === div ? true : null }, d || 'All divisions')));
    el.appendChild(h('div', { class: 'filters card', style: 'margin-bottom:16px' }, [h('b', { class: 'small' }, 'Division'), sel]));
    el.appendChild(bodyEl);
    function draw(d) {
      bodyEl.innerHTML = '';
      const k = kpiData(db.find('projects', (p) => !d || p.division === d));
      const keys = ['survey', 'boq', 'purchase', 'readiness', 'install', 'inspection', 'handover', 'variance'].concat(d !== ESD ? ['netmeter'] : []);
      bodyEl.appendChild(kpiTiles(k, keys));
      bodyEl.appendChild(ui.card('KPI definitions', ui.table({ search: false, rows: keys.map((x) => k[x]), columns: [{ key: 'label', label: 'KPI' }, { key: 'formula', label: 'Calculation' }, { key: 'value', label: 'Actual', render: (x) => (x.fmt === 'days' ? x.value + ' days' : fmt.pct(x.value)) }, { key: 'n', label: 'Basis' }], onRow: (x) => kpiDrill(x) }), { flush: true }));
      bodyEl.appendChild(h('div', { class: 'mt' }, ui.callout('Reporting rules: cancelled and on-hold work is excluded from on-time handover; original committed dates are preserved when revised dates are approved; numerical targets are configured separately from actual values.', 'info')));
    }
    draw(div);
  }

  // ------------------------------------------------------------------ reports (with date / owner / category / customer filters and export)
  function renderReports(el) {
    ui.page(el, { title: 'Project & Material Reports', sub: 'Project Lifecycle · Installation Job · BOQ & Material · Purchase & Vendor · Installation Quality · Customer Handover · Installation Progress · DRM/WRM/MRM' });
    const f = { from: '', to: '', division: CRM.is('solar_coordinator', 'doc_coordinator') ? SOL : CRM.is('es_coordinator') ? ESD : '', kind: '', owner: '' };
    const bar = h('div', { class: 'filters card', style: 'margin-bottom:16px' });
    const inp = (key, type, label) => { const i = h('input', { type, title: label, onChange: (e) => { f[key] = e.target.value; redraw(); } }); bar.appendChild(h('span', { class: 'small muted' }, label)); bar.appendChild(i); };
    const sel = (key, label, opts) => bar.appendChild(h('select', { onChange: (e) => { f[key] = e.target.value; redraw(); } }, [h('option', { value: '' }, 'All ' + label)].concat(opts.map((o) => h('option', { value: o.value || o, selected: (o.value || o) === f[key] ? true : null }, o.label || o)))));
    inp('from', 'date', 'Order from'); inp('to', 'date', 'to');
    sel('division', 'divisions', [ESD, SOL]); sel('kind', 'categories', ['es_large', 'es_small', 'solar'].map((k) => ({ value: k, label: KIND[k] })));
    sel('owner', 'owners / teams', staffOpts(['tech_engineer', 'install_lead', 'vendor']));
    el.appendChild(bar);
    const host = h('div'); el.appendChild(host);
    let tab = 'life';
    const filtered = () => db.all('projects').filter((p) => (!f.from || isoD(p.createdAt) >= f.from) && (!f.to || isoD(p.createdAt) <= f.to) && (!f.division || p.division === f.division) && (!f.kind || p.kind === f.kind) && (!f.owner || p.engineer === f.owner || p.installLead === f.owner || p.vendorId === f.owner));
    const stageDate = (p, k) => { const s = (p.stages || {})[k]; return s && DONE(s) ? fmt.date(s.doneAt) : s && s.status !== 'Not Started' ? s.status : '—'; };
    const R = {
      life: { label: 'Project Lifecycle', rows: (ps) => ps, cols: [{ key: 'id', label: 'Project', render: (p) => pLink(p.id), csv: (p) => p.id }, { key: 'c', label: 'Customer', render: (p) => cust(p.customerId).name, csv: (p) => cust(p.customerId).name }, { key: 'k', label: 'Category', render: (p) => KIND[p.kind], csv: (p) => KIND[p.kind] }, { key: 'so', label: 'SO received', render: (p) => fmt.date(p.createdAt), csv: (p) => isoD(p.createdAt) }, { key: 'survey', label: 'Survey', render: (p) => stageDate(p, 'survey'), csv: (p) => stageDate(p, 'survey') }, { key: 'boq', label: 'BOQ approved', render: (p) => stageDate(p, 'boq'), csv: (p) => stageDate(p, 'boq') }, { key: 'proc', label: 'Procurement', render: (p) => stageDate(p, 'procurement'), csv: (p) => stageDate(p, 'procurement') }, { key: 'del', label: 'Delivery', render: (p) => stageDate(p, 'delivery'), csv: (p) => stageDate(p, 'delivery') }, { key: 'test', label: 'Commissioning', render: (p) => stageDate(p, p.kind === 'solar' ? 'commissioning' : 'testing'), csv: (p) => stageDate(p, p.kind === 'solar' ? 'commissioning' : 'testing') }, { key: 'ho', label: 'Handover', render: (p) => stageDate(p, 'handover'), csv: (p) => stageDate(p, 'handover') }, { key: 'age', label: 'SO → now/closure (d)', cls: 'right', render: (p) => util.daysBetween(p.createdAt, p.closedAt || T0), csv: (p) => util.daysBetween(p.createdAt, p.closedAt || T0) }, { key: 'status', label: 'Status', render: (p) => statusBadge(p), csv: (p) => p.status }] },
      job: { label: 'Installation Job Report', rows: (ps) => ps.filter((p) => p.kind === 'es_small'), cols: [{ key: 'id', label: 'Job ID', render: (p) => pLink(p.id), csv: (p) => p.id }, { key: 'c', label: 'Customer', render: (p) => cust(p.customerId).name, csv: (p) => cust(p.customerId).name }, { key: 'dev', label: 'Devices', cls: 'right', render: (p) => (p.devices || []).length, csv: (p) => (p.devices || []).length }, { key: 'cam', label: 'Cameras', cls: 'right', render: (p) => p.cameraCount, csv: (p) => p.cameraCount }, { key: 'stage', label: 'Stage', render: (p) => curLabel(p), csv: (p) => curLabel(p) }, { key: 'pend', label: 'Pending tasks', cls: 'right', render: (p) => (p.tasks || []).filter((t) => !['Completed', 'Approved', 'Accepted'].includes(t.status)).length, csv: (p) => (p.tasks || []).filter((t) => !['Completed', 'Approved', 'Accepted'].includes(t.status)).length }, { key: 'cl', label: 'Closure', render: (p) => (p.status === 'Closed' ? fmt.date(p.closedAt) : p.status), csv: (p) => (p.status === 'Closed' ? isoD(p.closedAt) : p.status) }] },
      boq: { label: 'BOQ & Material', rows: (ps) => ps.flatMap((p) => needs(p).map((n) => Object.assign({ p }, n, { ordered: sumBy(db.find('purchaseOrders', (po) => po.projectId === p.id).flatMap((po) => po.items.filter((i) => i.stockId === n.stockId)), 'qty'), received: sumBy(db.find('purchaseOrders', (po) => po.projectId === p.id).flatMap((po) => po.items.filter((i) => i.stockId === n.stockId)), 'received') }))), cols: [{ key: 'p', label: 'Project', render: (r) => pLink(r.p.id), csv: (r) => r.p.id }, { key: 'i', label: 'Item', render: (r) => stockName(r.stockId), csv: (r) => stockName(r.stockId) }, { key: 'need', label: 'BOQ', cls: 'right' }, { key: 'ordered', label: 'Purchased', cls: 'right' }, { key: 'received', label: 'Received', cls: 'right' }, { key: 'issued', label: 'Issued', cls: 'right' }, { key: 'used', label: 'Consumed', cls: 'right' }, { key: 'returned', label: 'Returned', cls: 'right' }, { key: 'bal', label: 'Balance at site', cls: 'right', render: (r) => r.site - r.used - r.returned, csv: (r) => r.site - r.used - r.returned }, { key: 'short', label: 'Shortage', cls: 'right' }] },
      pur: { label: 'Purchase & Vendor', rows: (ps) => { const ids = new Set(ps.map((p) => p.id)); return db.find('purchaseOrders', (po) => !po.projectId || ids.has(po.projectId)); }, cols: [{ key: 'id', label: 'PO', render: (po) => mono(po.id), csv: (po) => po.id }, { key: 'supplier', label: 'Supplier' }, { key: 'projectId', label: 'Project' }, { key: 'poDate', label: 'PO date', render: (po) => fmt.date(po.poDate), csv: (po) => po.poDate }, { key: 'promisedDate', label: 'Promised', render: (po) => fmt.date(po.promisedDate), csv: (po) => po.promisedDate }, { key: 'receivedAt', label: 'Received', render: (po) => fmt.date(po.receivedAt), csv: (po) => isoD(po.receivedAt) }, { key: 'delay', label: 'Delay (d)', cls: 'right', render: (po) => poDelay(po), csv: (po) => poDelay(po) }, { key: 'var', label: 'Cost variance', cls: 'right', render: (po) => fmt.money(po.value - po.budget), csv: (po) => po.value - po.budget }, { key: 'delayReason', label: 'Delay reason' }, { key: 'status', label: 'Status' }] },
      qual: { label: 'Installation Quality', rows: (ps) => ps.flatMap((p) => workflow(p).filter(([k]) => INSPECT_KEYS.includes(k) && (DONE(st(p, k)) || st(p, k).reworkCount || st(p, k).status === 'Submitted for Inspection')).map(([k, l]) => ({ p, l, s: st(p, k), defects: (p.tasks || []).filter((t) => t.kind === 'Rework' && t.stageKey === k).length }))), cols: [{ key: 'p', label: 'Project', render: (r) => pLink(r.p.id), csv: (r) => r.p.id }, { key: 'l', label: 'Inspection' }, { key: 'res', label: 'Result', render: (r) => ui.badge(DONE(r.s) ? (r.s.reworkCount ? 'Passed after rework' : 'Passed first time') : r.s.status), csv: (r) => (DONE(r.s) ? (r.s.reworkCount ? 'Passed after rework' : 'Passed first time') : r.s.status) }, { key: 'rw', label: 'Failed tests / rework', cls: 'right', render: (r) => r.s.reworkCount || 0, csv: (r) => r.s.reworkCount || 0 }, { key: 'defects', label: 'Defect tasks', cls: 'right' }, { key: 'by', label: 'Approved by', render: (r) => r.s.approvedBy || '—', csv: (r) => r.s.approvedBy }] },
      ho: { label: 'Customer Handover', rows: (ps) => ps.filter((p) => p.status === 'Closed' || ['handover', 'activate'].includes(curKey(p))), cols: [{ key: 'id', label: 'Project', render: (p) => pLink(p.id), csv: (p) => p.id }, { key: 'c', label: 'Customer', render: (p) => cust(p.customerId).name, csv: (p) => cust(p.customerId).name }, { key: 'st', label: 'Handover status', render: (p) => ui.badge(p.status === 'Closed' ? 'Handed over' : st(p, 'handover').status), csv: (p) => (p.status === 'Closed' ? 'Handed over' : st(p, 'handover').status) }, { key: 'acc', label: 'Acceptance', render: (p) => st(p, 'handover').fields.acceptedBy || '—', csv: (p) => st(p, 'handover').fields.acceptedBy }, { key: 'miss', label: 'Missing documents', render: (p) => handoverMissing(p).length ? handoverMissing(p).slice(0, 3).join('; ') + (handoverMissing(p).length > 3 ? '…' : '') : 'None', csv: (p) => handoverMissing(p).join('; ') }] },
      prog: { label: 'Installation Progress (Solar)', rows: (ps) => ps.filter((p) => p.kind === 'solar'), cols: [{ key: 'id', label: 'Project', render: (p) => pLink(p.id), csv: (p) => p.id }, { key: 'kw', label: 'kWp', cls: 'right', render: (p) => p.capacityKw, csv: (p) => p.capacityKw }].concat(['civil', 'mechanical', 'electrical', 'commissioning'].map((k) => ({ key: k, label: LIB[k] ? k[0].toUpperCase() + k.slice(1) : k, render: (p) => ui.badge(st(p, k).status), csv: (p) => st(p, k).status }))) },
      mr: { label: 'DRM / WRM / MRM', rows: (ps) => [['Today (DRM)', 1], ['This week (WRM)', 7], ['This month (MRM)', 30]].map(([l, d]) => { const since = util.addDays(T0, -d + 1); const done = ps.flatMap((p) => workflow(p).filter(([k]) => DONE(st(p, k)) && st(p, k).doneAt && new Date(st(p, k).doneAt) >= since)); return { l, stages: done.length, closed: ps.filter((p) => p.closedAt && new Date(p.closedAt) >= since).length, dcs: db.find('dcs', (x) => new Date(x.dispatchDate) >= since).length, disc: db.find('dcs', (x) => x.status === 'Discrepancy').length, overdue: ps.filter(projOverdue).length, viol: allViolations().filter((v) => new Date(v.ts) >= since).length }; }), cols: [{ key: 'l', label: 'Period' }, { key: 'stages', label: 'Milestones completed', cls: 'right' }, { key: 'closed', label: 'Projects completed', cls: 'right' }, { key: 'dcs', label: 'Material dispatches', cls: 'right' }, { key: 'disc', label: 'Open material issues', cls: 'right' }, { key: 'overdue', label: 'Pending / overdue projects', cls: 'right' }, { key: 'viol', label: 'Escalations / violations', cls: 'right' }] },
    };
    const tabsEl = ui.tabs(Object.keys(R).map((k) => ({ id: k, label: R[k].label })), (id) => { tab = id; redraw(); });
    host.appendChild(tabsEl);
    const out = h('div'); host.appendChild(out);
    function redraw() {
      out.innerHTML = '';
      const r = R[tab]; const rows = r.rows(filtered());
      out.appendChild(ui.card(r.label + ' report', ui.table({ rows, pageSize: 20, columns: r.cols, toolbar: [exportBtn(r.label.replace(/\W+/g, '-'), r.cols, () => rows)] }), { flush: true }));
    }
  }
  const poDelay = (po) => { const end = po.receivedAt ? new Date(po.receivedAt) : (['Received', 'Cancelled'].includes(po.status) ? null : T0); return end ? Math.max(0, util.daysBetween(po.promisedDate, end)) : 0; };

  // ------------------------------------------------------------------ vendor: assigned tasks only (no costs, no other customers / vendors)
  function vendorTasks() { const u = user(); return db.all('projects').flatMap((p) => (p.tasks || []).filter((t) => t.assignee === u.id).map((t) => ({ t, p }))); }
  function vendorTaskCard(x) {
    const { t, p } = x; const site = master.sites(p.customerId).find((s) => s.id === p.siteId) || {};
    return h('div', { class: 'card card-body', style: 'display:flex;flex-direction:column;gap:6px' }, [
      h('div', { class: 'row', style: 'justify-content:space-between' }, [h('b', {}, t.title), ui.badge(t.status)]),
      h('div', { class: 'small muted' }, p.id + ' · ' + cust(p.customerId).name + ' · ' + (site.address || '')),
      h('div', { class: 'small' }, 'Site access: ' + (site.access || '—') + ' · Contact via coordinator ' + sName(p.coordinator)),
      h('div', { class: 'row small' }, [ui.badge(t.kind, t.kind === 'Rework' ? 'warn' : 'info'), 'Due ' + fmt.date(t.due), isPast(t.due) && !['Completed', 'Approved'].includes(t.status) ? ui.badge('Overdue', 'bad') : null, t.evidence ? h('span', { class: 'muted' }, 'Evidence: ' + t.evidence) : null]),
      h('div', { class: 'row' }, taskActions(p, t)),
    ]);
  }
  function renderVendorTasks(el) {
    const list = vendorTasks();
    ui.page(el, { title: 'My Assigned Tasks', sub: 'Restricted vendor view — assigned installation tasks and completion evidence only' });
    el.appendChild(ui.callout('As an external vendor you see only tasks assigned to <b>' + util.esc(user().name) + '</b>. Project costs, other customers and other vendors\' information are not visible.', 'info'));
    el.appendChild(h('div', { class: 'tabs-host mt' }, ui.tabs([{ id: 'open', label: 'Open', count: list.filter((x) => !['Completed', 'Approved', 'Accepted'].includes(x.t.status)).length }, { id: 'done', label: 'Completed', count: list.filter((x) => ['Completed', 'Approved', 'Accepted'].includes(x.t.status)).length }], (id, body) => {
      const rows = list.filter((x) => (id === 'open') === !['Completed', 'Approved', 'Accepted'].includes(x.t.status)).sort((a, b) => (a.t.due > b.t.due ? 1 : -1));
      body.appendChild(rows.length ? h('div', { class: 'grid g2' }, rows.map(vendorTaskCard)) : ui.empty('No tasks'));
    })));
  }

  // ------------------------------------------------------------------ supply chain helpers
  const stockStatus = (s) => (s.current <= 0 ? 'Out of stock' : s.current <= s.minLevel ? 'Below minimum' : s.current <= s.reorderLevel ? 'Reorder' : 'In stock');
  const stockTone = (s) => ({ 'Out of stock': 'bad', 'Below minimum': 'bad', Reorder: 'warn', 'In stock': 'ok' })[stockStatus(s)];
  const nonMoving = (s) => !s.lastMovedAt || util.daysBetween(s.lastMovedAt, T0) > 90;
  const itemsText = (items) => items.map((i) => stockName(i.stockId) + ' × ' + i.qty).join(', ');
  const pendingGRN = () => db.find('purchaseOrders', (po) => ['Issued', 'Supplier Confirmed', 'Partially Received'].includes(po.status) && isPast(po.promisedDate));

  // ------------------------------------------------------------------ supply chain dashboards (Inventory / Purchase / DC / Project material)
  function renderSCDash(el) {
    ui.page(el, { title: 'Supply Chain Dashboards', sub: 'Inventory, purchase, delivery challan and project-material control (inventory model: regular stock vs order-based items)' });
    const stock = db.all('stock');
    el.appendChild(ui.callout('Official stock balances are mastered in Tally Prime — the CRM mirrors the balance (last sync ' + fmt.dateTime(util.addHours(new Date(), -2)) + ') and adds project reservations, DC traceability and site verification without keeping a conflicting duplicate balance.', 'info'));
    el.appendChild(h('div', { class: 'mt' }, ui.tabs([{ id: 'inv', label: 'Inventory' }, { id: 'pur', label: 'Purchase' }, { id: 'dc', label: 'DC' }, { id: 'pm', label: 'Project material' }, { id: 'gs', label: 'GRN & Scrap' }], (id, body) => {
      if (id === 'inv') {
        const low = stock.filter((s) => s.itemType === 'Regular' && s.current <= s.reorderLevel);
        body.appendChild(ui.kpis([{ label: 'Current stock value', value: fmt.lakh(sumBy(stock, (s) => s.current * s.purchaseCost)) }, { label: 'Low stock items', value: low.length, color: 'var(--bad)', onClick: () => CRM.go('stock') }, { label: 'Reserved stock (units)', value: fmt.num(sumBy(stock, (s) => reservedTotal(s.id))), color: 'var(--chart-4)' }, { label: 'Non-moving items (>90d)', value: stock.filter(nonMoving).length, color: 'var(--warn)' }, { label: 'Order-based items', value: stock.filter((s) => s.itemType === 'Order-Based').length }]));
        body.appendChild(h('div', { class: 'grid g2' }, [ui.card('Low stock items', ui.table({ search: false, rows: low, columns: [{ key: 'name', label: 'Item' }, { key: 'current', label: 'Current', cls: 'right' }, { key: 'reorderLevel', label: 'Reorder', cls: 'right' }, { key: 's', label: 'Status', render: (s) => ui.badge(stockStatus(s), stockTone(s)) }] }), { flush: true }), ui.card('Fast-moving items (issued, last 90 days)', ui.hbars(stock.slice().sort((a, b) => (b.issued90 || 0) - (a.issued90 || 0)).slice(0, 8).map((s) => ({ label: s.name, value: s.issued90 || 0, text: fmt.num(s.issued90 || 0) + ' ' + s.unit })))), ui.card('Reserved stock by item', ui.hbars(stock.map((s) => ({ s, r: reservedTotal(s.id) })).filter((x) => x.r).sort((a, b) => b.r - a.r).slice(0, 8).map((x) => ({ label: x.s.name, value: x.r, target: x.s.current, text: x.r + ' of ' + x.s.current + ' ' + x.s.unit })))), ui.card('Non-moving items', ui.table({ search: false, rows: stock.filter(nonMoving), empty: 'None', columns: [{ key: 'name', label: 'Item' }, { key: 'current', label: 'Qty', cls: 'right' }, { key: 'lastMovedAt', label: 'Last movement', render: (s) => fmt.date(s.lastMovedAt) }] }), { flush: true })]));
      }
      if (id === 'pur') {
        const prs = db.find('purchaseRequests', (r) => ['Draft', 'Pending Approval'].includes(r.status));
        const pos = db.find('purchaseOrders', (r) => !['Received', 'Cancelled'].includes(r.status));
        const late = pos.filter((po) => isPast(po.promisedDate));
        body.appendChild(ui.kpis([{ label: 'Pending purchase requests', value: prs.length, color: 'var(--warn)', onClick: () => CRM.go('purchase-requests') }, { label: 'Pending POs', value: pos.length, onClick: () => CRM.go('purchase-orders') }, { label: 'Vendor delay (POs overdue)', value: late.length, color: 'var(--bad)' }, { label: 'Pending GRN', value: pendingGRN().length + db.find('grns', (g) => g.status === 'Pending Inspection').length, meta: 'overdue receipts + awaiting inspection', color: 'var(--chart-4)' }]));
        body.appendChild(h('div', { class: 'grid g2' }, [ui.card('Supplier deliveries overdue', ui.table({ search: false, rows: late, empty: 'None', columns: [{ key: 'id', label: 'PO', render: (p) => mono(p.id) }, { key: 'supplier', label: 'Supplier' }, { key: 'projectId', label: 'Project' }, { key: 'promisedDate', label: 'Promised', render: (p) => fmt.date(p.promisedDate) }, { key: 'd', label: 'Late by', render: (p) => ui.badge(poDelay(p) + 'd', 'bad') }] }), { flush: true }), ui.card('Purchase value by month', ui.barChart(monthsBack(6).map((m) => ({ label: m.label, values: [sumBy(db.find('purchaseOrders', (po) => inMonth(po.poDate, m)), 'value')] })), [{ name: 'PO value', color: 'var(--chart-3)' }], { money: true }))]));
      }
      if (id === 'dc') {
        const dcs = db.all('dcs');
        const today = dcs.filter((d) => d.dispatchDate === isoD(T0));
        const pend = dcs.filter((d) => d.status === 'Dispatched');
        const byArea = util.countBy(dcs, (d) => cust(d.customerId).area || '—');
        body.appendChild(ui.kpis([{ label: 'Material dispatched today', value: today.length }, { label: 'Pending delivery confirmation', value: pend.length, color: 'var(--warn)' }, { label: 'Dispatched, not acknowledged > 2d', value: pend.filter((d) => util.daysBetween(d.dispatchDate, T0) > 2).length, color: 'var(--bad)' }, { label: 'Open discrepancies', value: dcs.filter((d) => d.status === 'Discrepancy').length, color: 'var(--chart-4)' }]));
        body.appendChild(h('div', { class: 'grid g2' }, [ui.card('Site-wise dispatch', ui.hbars(Object.keys(byArea).map((k) => ({ label: k, value: byArea[k] })))), ui.card('Pending delivery confirmation', dcTable(pend, true), { flush: true })]));
      }
      if (id === 'pm') body.appendChild(projectMaterialBody());
      if (id === 'gs') {
        const g = db.all('grns'); const sc = db.all('scrap');
        body.appendChild(ui.kpis([{ label: 'Total GRNs', value: g.length }, { label: 'Pending inward (service)', value: g.filter((x) => x.status === 'Pending Inward').length, color: 'var(--warn)' }, { label: 'Under service', value: g.filter((x) => x.status === 'Under Service').length }, { label: 'Ready for dispatch', value: g.filter((x) => x.status === 'Ready for Dispatch').length }, { label: 'Scrap in stock', value: sumBy(sc.filter((s) => ['Collected', 'In Stock'].includes(s.status)), 'qty') }, { label: 'Scrap disposed / vendor return', value: sumBy(sc.filter((s) => ['Disposed', 'Sent to Vendor'].includes(s.status)), 'qty') }]));
        const byType = util.groupBy(sc, 'scrapType');
        body.appendChild(ui.card('Scrap by type', ui.donut(Object.keys(byType).map((k, i) => ({ label: k, value: sumBy(byType[k], 'qty'), color: 'var(--chart-' + ((i % 6) + 1) + ')' })), { label: 'units' })));
      }
    })));
  }

  // ------------------------------------------------------------------ stock master
  function renderStock(el) {
    const rows = db.all('stock').map((s) => Object.assign({}, s, { reserved: reservedTotal(s.id), available: available(s.id), statusText: stockStatus(s) }));
    ui.page(el, { title: 'Stock Master', sub: 'Regular stock items (≈90%) vs order-based purchase items (procured only after SO / project approval)', actions: [can('purchase') ? ui.btn('Raise PR for low stock', lowStockPR, 'primary') : null] });
    el.appendChild(ui.kpis([{ label: 'Stock items', value: rows.length }, { label: 'Stock value', value: fmt.lakh(sumBy(rows, (s) => s.current * s.purchaseCost)) }, { label: 'Low / reorder', value: rows.filter((s) => s.itemType === 'Regular' && s.current <= s.reorderLevel).length, color: 'var(--bad)' }, { label: 'Reserved for projects', value: fmt.num(sumBy(rows, 'reserved')), color: 'var(--chart-4)' }, { label: 'Pending manual adjustments', value: rows.filter((s) => s.pendingAdj).length, color: 'var(--warn)' }]));
    const cols = [{ key: 'code', label: 'Code', render: (s) => mono(s.code) }, { key: 'name', label: 'Product' }, { key: 'division', label: 'Division', render: (s) => (s.division === 'Common' ? 'Common' : ui.divTag(s.division)) }, { key: 'category', label: 'Category' }, { key: 'brand', label: 'Brand / model', render: (s) => s.brand + ' ' + s.model }, { key: 'itemType', label: 'Inventory model', render: (s) => ui.badge(s.itemType, s.itemType === 'Regular' ? 'info' : 'violet') }, { key: 'opening', label: 'Opening', cls: 'right' }, { key: 'current', label: 'Current', cls: 'right' }, { key: 'reserved', label: 'Reserved', cls: 'right' }, { key: 'available', label: 'Available', cls: 'right' }, { key: 'reorderLevel', label: 'Reorder / min', cls: 'right', render: (s) => s.reorderLevel + ' / ' + s.minLevel }, { key: 'purchaseCost', label: 'Cost', cls: 'right', render: (s) => fmt.money(s.purchaseCost) }, { key: 'sellingPrice', label: 'Price', cls: 'right', render: (s) => fmt.money(s.sellingPrice) }, { key: 'statusText', label: 'Status', render: (s) => ui.badge(s.statusText, stockTone(s)) }];
    el.appendChild(ui.card(null, ui.table({ rows, onRow: (s) => stockDrawer(s.id), filters: [{ key: 'itemType', label: 'inventory models', options: ['Regular', 'Order-Based'] }, { key: 'division', label: 'divisions', options: [ESD, SOL, 'Power', 'Common'] }, { key: 'statusText', label: 'statuses', options: ['In stock', 'Reorder', 'Below minimum', 'Out of stock'] }], columns: cols, pageSize: 20, toolbar: [exportBtn('stock-summary', cols, () => rows)] }), { flush: true }));
  }
  function stockDrawer(id) {
    const s = stockItem(id);
    const reservedBy = db.all('projects').filter((p) => isActive(p) && (p.alloc || {})[id] > 0);
    const body = h('div', { class: 'stack', style: 'gap:12px' }, [
      ui.dl([['Product code', s.code], ['Product', s.name], ['Division', s.division], ['Category', s.category], ['Brand / model', s.brand + ' ' + s.model], ['Serial tracked', s.serialized ? 'Yes' : 'No'], ['Inventory model', s.itemType], ['Unit', s.unit], ['Opening stock', s.opening], ['Current stock', s.current], ['Reserved', reservedTotal(id)], ['Available', available(id)], ['Reorder level', s.reorderLevel], ['Minimum level', s.minLevel], ['Purchase cost', fmt.money(s.purchaseCost)], ['Selling price', fmt.money(s.sellingPrice)], ['Preferred vendor', s.vendor], ['Last movement', fmt.dateTime(s.lastMovedAt)]]),
      ui.card('Location split', ui.dl(WAREHOUSES.map((w) => [w, (s.locations || {})[w] || 0]))),
      s.pendingAdj ? ui.callout('Pending manual adjustment: ' + (s.pendingAdj.qty > 0 ? '+' : '') + s.pendingAdj.qty + ' — ' + util.esc(s.pendingAdj.reason) + ' (requested by ' + util.esc(s.pendingAdj.by) + ')', 'warn') : null,
      ui.card('Reserved for projects', ui.table({ search: false, rows: reservedBy, empty: 'No reservations', columns: [{ key: 'id', label: 'Project', render: (p) => pLink(p.id) }, { key: 'q', label: 'Qty', cls: 'right', render: (p) => p.alloc[id] }] }), { flush: true }),
      ui.card('Item-wise movement', ui.table({ search: false, rows: (s.movements || []).slice().reverse(), empty: 'No movements', columns: [{ key: 'ts', label: 'When', render: (m) => fmt.dateTime(m.ts) }, { key: 'type', label: 'Movement' }, { key: 'qty', label: 'Qty', cls: 'right', render: (m) => (m.qty > 0 ? '+' : '') + m.qty }, { key: 'ref', label: 'Reference' }] }), { flush: true }),
    ]);
    const acts = [];
    if (can('stores') && !s.pendingAdj) acts.push({ label: 'Request manual adjustment', onClick: () => { ui.formModal('Manual stock adjustment (approval required)', [{ key: 'qty', label: 'Adjustment qty (+/−)', type: 'number', required: true }, { key: 'reason', label: 'Reason (physical count / Tally reconciliation)', required: true }], {}, (v) => { db.update('stock', id, { pendingAdj: { qty: v.qty, reason: v.reason, by: user().name, ts: nowIso() } }, { note: 'Manual adjustment requested' }); CRM.notify({ to: 'gm', title: 'Stock adjustment approval: ' + s.name, body: v.qty + ' — ' + v.reason, link: '#/stock', severity: 'warn', key: 'adj-' + id + '-' + util.uid() }); CRM.refresh(); }); } });
    if (s.pendingAdj && CRM.is('gm', 'admin', 'odm')) acts.push({ label: 'Approve adjustment', cls: 'ok', onClick: () => { moveStock(id, s.pendingAdj.qty, 'Manual adjustment (approved by ' + user().name + ')', s.pendingAdj.reason); db.update('stock', id, { pendingAdj: null }, { note: 'Adjustment approved' }); CRM.refresh(); } });
    ui.drawer({ title: s.name, sub: s.code + ' · ' + s.itemType, body, actions: acts.length ? acts : [{ label: 'Close' }] });
  }
  function lowStockPR() {
    const low = db.find('stock', (s) => s.itemType === 'Regular' && s.current <= s.reorderLevel);
    if (!low.length) { ui.toast('No items at or below reorder level', 'info'); return; }
    ui.formModal('Purchase request — low stock replenishment', [{ key: 'purpose', label: 'Purpose', type: 'select', required: true, options: ['Sales', 'Service', 'Project'] }, { key: 'requiredDate', label: 'Required date', type: 'date', required: true, default: isoD(util.addDays(T0, 7)) }], {}, (v) => {
      const byDiv = util.groupBy(low, 'division');
      Object.keys(byDiv).forEach((d) => createPR({ division: d, purpose: v.purpose, trigger: 'Low stock', items: byDiv[d].map((s) => ({ stockId: s.id, qty: Math.max(1, s.reorderLevel * 2 - s.current) })), requiredDate: v.requiredDate }));
      ui.toast(Object.keys(byDiv).length + ' PR(s) raised for approval', 'ok'); CRM.go('purchase-requests');
    });
  }

  // ------------------------------------------------------------------ purchase requests
  function renderPRs(el) {
    const rows = db.all('purchaseRequests').slice().reverse();
    ui.page(el, { title: 'Purchase Requests', sub: 'Triggers: low stock · project requirement · special order. Flow: PR → approval → vendor selection → PO → GRN', actions: [can('purchase', 'es_coordinator', 'solar_coordinator', 'stores', 'tech_head') ? ui.btn('+ New PR', newPRForm, 'primary') : null] });
    el.appendChild(ui.kpis([{ label: 'Drafts (auto-generated)', value: rows.filter((r) => r.status === 'Draft').length }, { label: 'Pending approval', value: rows.filter((r) => r.status === 'Pending Approval').length, color: 'var(--warn)' }, { label: 'Approved — PO pending', value: rows.filter((r) => r.status === 'Approved').length, color: 'var(--chart-5)' }, { label: 'PO raised', value: rows.filter((r) => r.status === 'PO Raised').length, color: 'var(--ok)' }, { label: 'Raised under exception', value: rows.filter((r) => r.exception).length, color: 'var(--bad)' }]));
    el.appendChild(ui.card(null, ui.table({ rows, filters: [{ key: 'status', label: 'statuses', options: ['Draft', 'Pending Approval', 'Approved', 'Rejected', 'PO Raised'] }, { key: 'purpose', label: 'purposes', options: ['Sales', 'Service', 'Project'] }, { key: 'division', label: 'divisions', options: ['Power', ESD, SOL] }], columns: [{ key: 'id', label: 'PR No.', render: (r) => mono(r.id) }, { key: 'createdAt', label: 'Date', render: (r) => fmt.date(r.createdAt) }, { key: 'requestedBy', label: 'Requested by' }, { key: 'division', label: 'Division', render: (r) => ui.divTag(r.division) }, { key: 'purpose', label: 'Purpose' }, { key: 'trigger', label: 'Trigger' }, { key: 'projectId', label: 'Project / BOQ', render: (r) => (r.projectId ? h('span', {}, [pLink(r.projectId), r.boqVersion ? ' v' + r.boqVersion : '']) : '—') }, { key: 'items', label: 'Material details', render: (r) => itemsText(r.items) }, { key: 'requiredDate', label: 'Required', render: (r) => fmt.date(r.requiredDate) }, { key: 'status', label: 'Status', render: (r) => h('span', {}, [ui.badge(r.status), r.exception ? ' ' : '', r.exception ? ui.badge('Exception', 'bad') : '']) }, { key: 'approver', label: 'Approver / date', render: (r) => (r.approver ? r.approver + ' · ' + fmt.date(r.approvedAt) : '—') }], actions: prActions }), { flush: true }));
  }
  function prActions(r) {
    const out = [];
    if (r.status === 'Draft' && can('purchase', 'es_coordinator', 'solar_coordinator')) out.push(ui.btn('Submit', () => { db.update('purchaseRequests', r.id, { status: 'Pending Approval', submittedAt: nowIso() }, { note: 'Submitted for approval' }); CRM.notify({ to: 'gm', title: 'PR awaiting approval: ' + r.id, body: itemsText(r.items), link: '#/purchase-requests', severity: 'warn', key: 'prs-' + r.id }); CRM.refresh(); }, 'sm primary'));
    if (r.status === 'Pending Approval' && CRM.is('gm', 'admin')) {
      out.push(ui.btn('Approve', () => { db.update('purchaseRequests', r.id, { status: 'Approved', approver: user().name, approvedAt: nowIso() }, { note: 'PR approved' }); CRM.notify({ to: 'purchase', title: 'PR approved: ' + r.id, body: 'Select approved vendor and raise PO', link: '#/purchase-requests', severity: 'ok', key: 'pra-' + r.id }); CRM.refresh(); }, 'sm ok'));
      out.push(ui.btn('Reject', () => ui.formModal('Reject PR', [{ key: 'reason', label: 'Reason', required: true }], {}, (v) => { db.update('purchaseRequests', r.id, { status: 'Rejected', rejectReason: v.reason, approver: user().name, approvedAt: nowIso() }, { note: 'PR rejected' }); CRM.refresh(); }), 'sm'));
    }
    if (r.status === 'Approved' && can('purchase')) out.push(ui.btn('Raise PO', () => poForm(r), 'sm primary'));
    if (['Draft', 'Pending Approval'].includes(r.status) && can('purchase')) out.push(ui.btn('Emergency PO', () => ui.modal({ title: 'Raise PO without approval?', body: ui.callout('Procurement without the required approval is a policy violation (ES §10.4 / Solar §9.4). It will be recorded against you and escalated to the ODM desk.', 'bad'), actions: [{ label: 'Cancel' }, { label: 'Proceed — record violation', cls: 'danger', onClick: () => setTimeout(() => poForm(r, true), 50) }] }), 'sm danger'));
    return out;
  }
  function newPRForm() {
    const projs = db.all('projects').filter((p) => isActive(p) && p.kind !== 'es_pending');
    const stockOpts = db.all('stock').map((s) => ({ value: s.id, label: s.code + ' · ' + s.name }));
    ui.formModal('New purchase request', [
      { key: 'purpose', label: 'Purpose', type: 'select', required: true, options: ['Sales', 'Service', 'Project'] },
      { key: 'trigger', label: 'Trigger condition', type: 'select', required: true, options: ['Low stock', 'Project requirement', 'Special order requirement'] },
      { key: 'division', label: 'Division', type: 'select', required: true, options: ['Power', ESD, SOL] },
      { key: 'projectId', label: 'Project (if purpose = Project)', type: 'select', options: projs.map((p) => ({ value: p.id, label: p.id + ' · ' + cust(p.customerId).name })) },
      { key: 's1', label: 'Material 1', type: 'select', required: true, options: stockOpts }, { key: 'q1', label: 'Quantity 1', type: 'number', required: true },
      { key: 's2', label: 'Material 2', type: 'select', options: stockOpts }, { key: 'q2', label: 'Quantity 2', type: 'number' },
      { key: 'requiredDate', label: 'Required date', type: 'date', required: true },
      { key: 'exception', label: 'Authorized exception (only if project BOQ not approved)', hint: 'Technical Head / GM only — recorded as an exception' },
    ], {}, (v) => {
      const items = [[v.s1, v.q1], [v.s2, v.q2]].filter(([s, q]) => s && q > 0).map(([stockId, qty]) => ({ stockId, qty }));
      if (v.purpose === 'Project' && !v.projectId) { ui.toast('Select the project', 'bad'); return false; }
      const p = v.projectId ? db.get('projects', v.projectId) : null;
      const b = p ? approvedBoq(p.id) : null;
      if (p && !b) {
        if (!v.exception || !CRM.is('tech_head', 'gm', 'admin')) { ui.toast('Blocked: purchase initiation must use an approved BOQ unless an authorized exception is recorded by the Technical Head / GM', 'bad'); return false; }
      }
      const pr = createPR({ division: p ? p.division : v.division, purpose: v.purpose, trigger: v.trigger, projectId: v.projectId || null, boqId: b ? b.id : null, boqVersion: b ? b.version : null, items, requiredDate: v.requiredDate, exception: p && !b ? v.exception : null });
      if (p && !b) raise('purchaseRequests', db.get('purchaseRequests', pr.id), 'Procurement initiated without approved BOQ (authorized exception)', { severity: 'Low', owner: user().id, division: p.division, details: pr.id + ' — ' + v.exception });
      ui.toast(pr.id + ' raised for approval', 'ok'); CRM.refresh();
    });
  }
  function poForm(pr, exception) {
    const first = stockItem(pr.items[0].stockId) || {};
    ui.formModal('Purchase Order from ' + pr.id + (exception ? ' (EXCEPTION)' : ''), [
      { key: 'supplier', label: 'Vendor (approved vendor list only)', type: 'select', required: true, options: SUPPLIERS, default: first.vendor },
      { key: 'promised', label: 'Promised delivery date', type: 'date', required: true, default: isoD(util.addDays(T0, 7)) },
      { key: 'terms', label: 'Payment terms', type: 'select', required: true, options: ['Advance', '15 days credit', '30 days credit', '45 days credit'] },
      { key: 'reason', label: exception ? 'Reason for proceeding without approval' : 'Remarks', required: !!exception },
    ], {}, (v) => {
      const po = createPO(pr, v.supplier, v.promised, v.terms, { exception: exception ? v.reason : null });
      if (exception) raise('purchaseOrders', db.get('purchaseOrders', po.id), 'Procurement without the required approval', { severity: 'High', owner: user().id, division: pr.division, details: po.id + ' raised on unapproved ' + pr.id + ' — ' + v.reason });
      ui.toast(po.id + ' issued to ' + v.supplier, exception ? 'warn' : 'ok'); CRM.go('purchase-orders');
    });
  }

  // ------------------------------------------------------------------ purchase orders & supplier delivery tracking
  function renderPOs(el) {
    const rows = db.all('purchaseOrders').slice().reverse().map((po) => Object.assign({}, po, { delivery: ['Received', 'Cancelled'].includes(po.status) ? (po.receivedAt && isoD(po.receivedAt) > po.promisedDate ? 'Delivered late' : po.status === 'Cancelled' ? 'Cancelled' : 'Delivered on time') : isPast(po.promisedDate) ? 'Overdue' : util.daysBetween(T0, po.promisedDate) <= 2 ? 'Due soon' : 'On track' }));
    ui.page(el, { title: 'Purchase Orders & Supplier Delivery', sub: 'PO number, vendor, material, quantity, rate, delivery date and payment terms — with supplier confirmation and delay tracking' });
    el.appendChild(ui.kpis([{ label: 'Open POs', value: rows.filter((r) => !['Received', 'Cancelled'].includes(r.status)).length }, { label: 'Awaiting supplier confirmation', value: rows.filter((r) => r.status === 'Issued').length, color: 'var(--warn)' }, { label: 'Deliveries overdue', value: rows.filter((r) => r.delivery === 'Overdue').length, color: 'var(--bad)' }, { label: 'Due in 2 days', value: rows.filter((r) => r.delivery === 'Due soon').length, color: 'var(--chart-5)' }, { label: 'Open PO value', value: fmt.lakh(sumBy(rows.filter((r) => !['Received', 'Cancelled'].includes(r.status)), 'value')) }]));
    el.appendChild(ui.card(null, ui.table({ rows, filters: [{ key: 'status', label: 'statuses', options: ['Issued', 'Supplier Confirmed', 'Partially Received', 'Received', 'Cancelled'] }, { key: 'delivery', label: 'delivery', options: ['Overdue', 'Due soon', 'On track', 'Delivered on time', 'Delivered late'] }, { key: 'supplier', label: 'suppliers', options: SUPPLIERS }], columns: [{ key: 'id', label: 'PO No.', render: (r) => mono(r.id) }, { key: 'poDate', label: 'PO date', render: (r) => fmt.date(r.poDate) }, { key: 'supplier', label: 'Vendor' }, { key: 'projectId', label: 'Project', render: (r) => (r.projectId ? pLink(r.projectId) : '—') }, { key: 'items', label: 'Material / qty', render: (r) => r.items.map((i) => stockName(i.stockId) + ' ' + (i.received || 0) + '/' + i.qty).join(', ') }, { key: 'value', label: 'Value', cls: 'right', render: (r) => fmt.money(r.value) }, { key: 'promisedDate', label: 'Promised', render: (r) => fmt.date(r.promisedDate) }, { key: 'paymentTerms', label: 'Terms' }, { key: 'delivery', label: 'Delivery', render: (r) => ui.badge(r.delivery, r.delivery === 'Overdue' || r.delivery === 'Delivered late' ? 'bad' : r.delivery === 'Due soon' ? 'warn' : 'ok') }, { key: 'status', label: 'Status', render: (r) => h('span', {}, [ui.badge(r.status), r.exception ? ' ' : '', r.exception ? ui.badge('No approval', 'bad') : '']) }], actions: poActions }), { flush: true }));
  }
  function poActions(po) {
    const out = [];
    if (po.status === 'Issued' && can('purchase')) out.push(ui.btn('Supplier confirmed', () => ui.formModal('Supplier confirmation — ' + po.id, [{ key: 'promised', label: 'Confirmed delivery date', type: 'date', required: true, default: po.promisedDate }, { key: 'ref', label: 'Supplier order reference', required: true }], {}, (v) => { db.update('purchaseOrders', po.id, { status: 'Supplier Confirmed', confirmedAt: nowIso(), supplierRef: v.ref, promisedDate: v.promised, originalPromised: po.originalPromised || po.promisedDate }, { note: 'Supplier confirmed' }); CRM.refresh(); }), 'sm'));
    if (['Issued', 'Supplier Confirmed', 'Partially Received'].includes(po.status) && can('stores')) out.push(ui.btn('Record GRN', () => grnForm(po), 'sm primary'));
    if (['Issued', 'Supplier Confirmed', 'Partially Received'].includes(po.status) && can('purchase') && isPast(po.promisedDate)) out.push(ui.btn('Delay reason', () => ui.formModal('Supplier delay — ' + po.id, [{ key: 'reason', label: 'Delay reason', required: true }, { key: 'date', label: 'New expected date', type: 'date', required: true }], {}, (v) => { db.update('purchaseOrders', po.id, { delayReason: v.reason, expectedDate: v.date }, { note: 'Delay recorded: ' + v.reason }); CRM.refresh(); }), 'sm'));
    return out;
  }

  // ------------------------------------------------------------------ GRN (purchase & service)
  function grnForm(po) {
    const pend = po.items.filter((i) => (i.received || 0) < i.qty);
    const fields = [{ key: 'warehouse', label: 'Warehouse location', type: 'select', required: true, options: WAREHOUSES.slice(0, 2) }, { key: 'invoice', label: 'Supplier invoice / DC ref', required: true }].concat(pend.flatMap((i) => [{ type: 'section', label: stockName(i.stockId) + ' — ordered ' + i.qty + ', pending ' + (i.qty - (i.received || 0)) }, { key: 'r_' + i.stockId, label: 'Qty received', type: 'number', default: i.qty - (i.received || 0) }, { key: 'a_' + i.stockId, label: 'Qty accepted', type: 'number', default: i.qty - (i.received || 0) }, { key: 'j_' + i.stockId, label: 'Qty rejected', type: 'number', default: 0 }, { key: 'd_' + i.stockId, label: 'Of which damaged', type: 'number', default: 0 }]));
    ui.formModal('GRN against ' + po.id + ' · ' + po.supplier, fields, {}, (v) => {
      const lines = [];
      for (const i of pend) {
        const r = v['r_' + i.stockId] || 0, a = v['a_' + i.stockId] || 0, j = v['j_' + i.stockId] || 0, d = v['d_' + i.stockId] || 0;
        if (!r) continue;
        if (r > i.qty - (i.received || 0)) { ui.toast('GRN must match PO quantity — ' + stockName(i.stockId) + ' exceeds pending', 'bad'); return false; }
        if (a + j !== r) { ui.toast('Accepted + rejected must equal received for ' + stockName(i.stockId), 'bad'); return false; }
        if (d > j) { ui.toast('Rejection entry is mandatory for damaged material (' + stockName(i.stockId) + ')', 'bad'); return false; }
        lines.push({ stockId: i.stockId, received: r, accepted: a, rejected: j, damaged: d, pending: i.qty - (i.received || 0) - r });
      }
      if (!lines.length) { ui.toast('Enter received quantities', 'bad'); return false; }
      const g = receiveGRN(po, lines, { warehouse: v.warehouse, invoice: v.invoice });
      CRM.notify({ to: 'stores', title: 'GRN awaiting QC inspection: ' + g.id, body: po.supplier, link: '#/grn', severity: 'info', key: 'gi-' + g.id });
      ui.toast(g.id + ' created — QC inspection pending', 'ok'); CRM.refresh();
    });
  }
  function renderGRN(el) {
    const all = db.all('grns').slice().reverse();
    ui.page(el, { title: 'Goods Receipt Notes', sub: 'GRN mandatory for every inward: Purchase GRN (vendor material) and Service GRN (customer product inward for repair)', actions: [can('service_engineer', 'service_coordinator', 'stores') ? ui.btn('+ Service GRN', serviceGrnForm, 'primary') : null] });
    const pur = all.filter((g) => g.type === 'Purchase GRN'), svc = all.filter((g) => g.type === 'Service GRN');
    el.appendChild(ui.kpis([{ label: 'Total GRNs', value: all.length }, { label: 'Awaiting QC inspection', value: pur.filter((g) => g.status === 'Pending Inspection').length, color: 'var(--warn)' }, { label: 'Pending GRN (overdue POs)', value: pendingGRN().length, color: 'var(--bad)' }, { label: 'Service: pending inward', value: svc.filter((g) => g.status === 'Pending Inward').length, color: 'var(--chart-4)' }, { label: 'Under service', value: svc.filter((g) => g.status === 'Under Service').length }, { label: 'Ready for dispatch', value: svc.filter((g) => g.status === 'Ready for Dispatch').length, color: 'var(--ok)' }]));
    el.appendChild(ui.tabs([{ id: 'p', label: 'Purchase GRN', count: pur.length }, { id: 's', label: 'Service GRN', count: svc.length }], (id, body) => {
      if (id === 'p') body.appendChild(ui.card(null, ui.table({ rows: pur, filters: [{ key: 'status', label: 'statuses', options: ['Pending Inspection', 'Accepted', 'Rejected'] }], columns: [{ key: 'id', label: 'GRN No.', render: (g) => mono(g.id) }, { key: 'poId', label: 'PO', render: (g) => mono(g.poId) }, { key: 'supplier', label: 'Vendor' }, { key: 'projectId', label: 'Project', render: (g) => (g.projectId ? pLink(g.projectId) : '—') }, { key: 'items', label: 'Received / accepted / rejected', render: (g) => g.items.map((i) => stockName(i.stockId) + ' ' + i.received + '/' + i.accepted + '/' + i.rejected).join(', ') }, { key: 'warehouse', label: 'Warehouse' }, { key: 'receivedDate', label: 'Received', render: (g) => fmt.date(g.receivedDate) }, { key: 'status', label: 'QC / status', render: (g) => ui.badge(g.status) }], actions: (g) => (g.status === 'Pending Inspection' && can('stores', 'tech_head') ? [ui.btn('QC pass', () => { inspectGRN(g, true); ui.toast('Stock updated and allocated to project', 'ok'); CRM.refresh(); }, 'sm ok'), ui.btn('QC fail', () => { inspectGRN(g, false); ui.toast('GRN rejected — return to supplier', 'warn'); CRM.refresh(); }, 'sm')] : []) }), { flush: true }));
      if (id === 's') body.appendChild(ui.card(null, ui.table({ rows: svc, filters: [{ key: 'status', label: 'statuses', options: SGRN_STATUS }], columns: [{ key: 'id', label: 'GRN No.', render: (g) => mono(g.id) }, { key: 'createdAt', label: 'Date / time', render: (g) => fmt.dateTime(g.createdAt) }, { key: 'complaintId', label: 'Complaint' }, { key: 'customerId', label: 'Customer', render: (g) => cust(g.customerId).name }, { key: 'productType', label: 'Product', render: (g) => g.productType + ' · ' + g.brand + ' ' + g.model }, { key: 'serial', label: 'Serial', render: (g) => mono(g.serial) }, { key: 'condition', label: 'Condition', render: (g) => ui.badge(g.condition, g.condition === 'Damaged' ? 'bad' : 'ok') }, { key: 'collectedBy', label: 'Collected by', render: (g) => sName(g.collectedBy) }, { key: 'receivedBy', label: 'Received by' }, { key: 'status', label: 'Status', render: (g) => ui.badge(g.status) }], actions: (g) => { const i = SGRN_STATUS.indexOf(g.status); return i < SGRN_STATUS.length - 1 && can('stores', 'service_coordinator', 'service_engineer') ? [ui.btn('→ ' + SGRN_STATUS[i + 1], () => { const patch = { status: SGRN_STATUS[i + 1], ['at_' + i]: nowIso() }; if (i === 0) patch.receivedBy = user().name; db.update('grns', g.id, patch, { note: 'Service GRN → ' + SGRN_STATUS[i + 1] }); CRM.refresh(); }, 'sm')] : []; } }), { flush: true }));
    }));
  }
  function serviceGrnForm() {
    const comps = db.all('complaints').slice(-60).map((c) => ({ value: c.id, label: c.id + ' · ' + cust(c.customerId).name }));
    ui.formModal('Service GRN — product inward from customer', [
      comps.length ? { key: 'complaintId', label: 'Linked complaint ID', type: 'select', required: true, options: comps } : { key: 'complaintId', label: 'Linked complaint ID', required: true },
      { key: 'customerId', label: 'Customer', type: 'select', required: true, options: master.customers().map((c) => ({ value: c.id, label: c.name })) },
      { key: 'contact', label: 'Contact number', required: true }, { key: 'site', label: 'Site location', required: true },
      { key: 'productType', label: 'Product type', type: 'select', required: true, options: ['UPS', 'Inverter', 'Battery', 'Stabilizer', 'DVR/NVR', 'Solar inverter'] },
      { key: 'brand', label: 'Brand', required: true }, { key: 'model', label: 'Model', required: true }, { key: 'serial', label: 'Serial number', required: true }, { key: 'qty', label: 'Quantity', type: 'number', required: true, default: 1 },
      { key: 'problem', label: 'Problem description', type: 'textarea', required: true }, { key: 'condition', label: 'Physical condition', type: 'select', required: true, options: ['Good', 'Damaged'] },
      { key: 'accessories', label: 'Accessories received (Yes/No + details)', required: true }, { key: 'collectedBy', label: 'Collected by (engineer)', type: 'select', required: true, options: staffOpts('service_engineer'), default: CRM.is('service_engineer') ? user().id : '' },
    ], {}, (v) => {
      const c = v.complaintId && db.get('complaints', v.complaintId);
      const g = db.insert('grns', Object.assign(v, { type: 'Service GRN', customerId: v.customerId || (c && c.customerId), status: 'Pending Inward' }), { prefix: 'GRN', note: 'Service GRN created (field collection)' });
      ui.toast(g.id + ' created — product in transit to service centre', 'ok'); CRM.refresh();
    });
  }

  // ------------------------------------------------------------------ delivery challans
  function renderDC(el) {
    const rows = db.all('dcs').slice().reverse();
    ui.page(el, { title: 'Delivery Challans', sub: 'No stock dispatch without DC · flow: approved requirement → picking → DC → dispatch → site/customer delivery confirmation', actions: [can('stores') ? ui.btn('+ DC (sales / service / customer delivery)', dcForm, 'primary') : null] });
    el.appendChild(ui.kpis([{ label: 'Dispatched today', value: rows.filter((d) => d.dispatchDate === isoD(T0)).length }, { label: 'Pending delivery confirmation', value: rows.filter((d) => d.status === 'Dispatched').length, color: 'var(--warn)' }, { label: 'Not acknowledged > 2 days', value: rows.filter((d) => d.status === 'Dispatched' && util.daysBetween(d.dispatchDate, T0) > 2).length, color: 'var(--bad)' }, { label: 'Discrepancy exceptions', value: rows.filter((d) => d.status === 'Discrepancy').length, color: 'var(--chart-4)' }]));
    el.appendChild(ui.card(null, dcTable(rows, false), { flush: true }));
  }
  function dcForm() {
    const stockOpts = db.all('stock').map((s) => ({ value: s.id, label: s.name + ' (avail ' + available(s.id) + ')' }));
    ui.formModal('Generate delivery challan', [
      { key: 'linkType', label: 'DC for', type: 'select', required: true, options: ['Sales Order', 'Complaint', 'Customer delivery'] }, { key: 'linkId', label: 'Linked Sales Order / Complaint no.', required: true },
      { key: 'customerId', label: 'Customer', type: 'select', required: true, options: master.customers().map((c) => ({ value: c.id, label: c.name })) },
      { key: 's1', label: 'Material', type: 'select', required: true, options: stockOpts }, { key: 'q1', label: 'Quantity', type: 'number', required: true },
      { key: 'dispatchedBy', label: 'Dispatched by', required: true, default: user().name }, { key: 'vehicle', label: 'Vehicle details (optional)' },
    ], {}, (v) => {
      if (available(v.s1) < v.q1) { ui.toast('Insufficient free stock (reserved quantities are protected)', 'bad'); return false; }
      const dc = db.insert('dcs', { linkType: v.linkType, linkId: v.linkId, customerId: v.customerId, siteAddress: (master.sites(v.customerId)[0] || {}).address, purpose: v.linkType === 'Complaint' ? 'Service material dispatch' : 'Customer delivery', items: [{ stockId: v.s1, qty: v.q1 }], store: 'Main Warehouse', dispatchedBy: v.dispatchedBy, vehicle: v.vehicle, dispatchDate: isoD(T0), status: 'Dispatched', viol: [] }, { prefix: 'DC', note: 'DC generated' });
      moveStock(v.s1, -v.q1, 'DC dispatch', dc.id);
      ui.toast(dc.id + ' dispatched', 'ok'); CRM.refresh();
    });
  }

  // ------------------------------------------------------------------ material issue, engineer stock & returns
  function renderIssue(el) {
    ui.page(el, { title: 'Material Issue & Returns', sub: 'Project issues (DC), engineer stock (issued / used / returned / balance) and unused-material returns', actions: [can('stores') ? ui.btn('Issue to engineer', engIssueForm, 'primary') : null] });
    const eng = db.all('stock').flatMap((s) => Object.keys(s.eng || {}).map((id) => Object.assign({ stockId: s.id, item: s.name, engineer: id, engName: sName(id) }, s.eng[id]))).map((r) => Object.assign(r, { balance: r.issued - r.used - r.returned }));
    const returns = db.all('projects').flatMap((p) => Object.keys(p.returned || {}).filter((k) => p.returned[k] > 0).map((k) => ({ projectId: p.id, item: stockName(k), qty: p.returned[k] })));
    el.appendChild(ui.tabs([{ id: 'p', label: 'Issues to projects' }, { id: 'e', label: 'Engineer stock', count: eng.length }, { id: 'r', label: 'Project returns', count: returns.length }], (id, body) => {
      if (id === 'p') body.appendChild(ui.card(null, dcTable(db.find('dcs', (d) => d.projectId).reverse(), false), { flush: true }));
      if (id === 'e') body.appendChild(ui.card(null, ui.table({ rows: eng, empty: 'No engineer stock issued', filters: [{ key: 'engName', label: 'engineers', options: Object.keys(util.countBy(eng, 'engName')) }], columns: [{ key: 'engName', label: 'Engineer' }, { key: 'item', label: 'Item' }, { key: 'issued', label: 'Issued', cls: 'right' }, { key: 'used', label: 'Used', cls: 'right' }, { key: 'returned', label: 'Returned', cls: 'right' }, { key: 'balance', label: 'Balance', cls: 'right', render: (r) => ui.badge(r.balance, r.balance > 0 ? 'warn' : 'ok') }], actions: (r) => (r.balance > 0 && can('stores', 'service_engineer', 'tech_engineer') ? [ui.btn('Record used', () => engMove(r, 'used'), 'sm'), ui.btn('Return', () => engMove(r, 'returned'), 'sm')] : []) }), { flush: true }));
      if (id === 'r') body.appendChild(ui.card(null, ui.table({ rows: returns, empty: 'No returns yet', columns: [{ key: 'projectId', label: 'Project', render: (r) => pLink(r.projectId) }, { key: 'item', label: 'Item' }, { key: 'qty', label: 'Returned', cls: 'right' }] }), { flush: true }));
    }));
  }
  function engIssueForm() {
    ui.formModal('Issue material to engineer stock', [{ key: 'engineer', label: 'Engineer', type: 'select', required: true, options: staffOpts(['service_engineer', 'tech_engineer']) }, { key: 'stockId', label: 'Item', type: 'select', required: true, options: db.all('stock').map((s) => ({ value: s.id, label: s.name + ' (avail ' + available(s.id) + ')' })) }, { key: 'qty', label: 'Quantity', type: 'number', required: true }, { key: 'ref', label: 'Issue reference (complaint / job)', required: true }], {}, (v) => {
      if (available(v.stockId) < v.qty) { ui.toast('Insufficient free stock', 'bad'); return false; }
      moveStock(v.stockId, -v.qty, 'Issue to engineer ' + sName(v.engineer), v.ref);
      const s = clone(stockItem(v.stockId)); s.eng = s.eng || {}; const e = s.eng[v.engineer] = s.eng[v.engineer] || { issued: 0, used: 0, returned: 0 }; e.issued += v.qty;
      s.locations = Object.assign({}, s.locations, { 'Engineer Stock': ((s.locations || {})['Engineer Stock'] || 0) + v.qty });
      db.update('stock', s.id, { eng: s.eng, locations: s.locations }, { note: 'Engineer stock issued' });
      ui.toast('Issued', 'ok'); CRM.refresh();
    });
  }
  function engMove(r, kind) {
    ui.formModal((kind === 'used' ? 'Record usage' : 'Return to stores') + ' — ' + r.item, [{ key: 'qty', label: 'Quantity', type: 'number', required: true, default: r.balance }], {}, (v) => {
      if (v.qty > r.balance) { ui.toast('Exceeds balance', 'bad'); return false; }
      const s = clone(stockItem(r.stockId)); s.eng[r.engineer][kind] += v.qty;
      s.locations = Object.assign({}, s.locations, { 'Engineer Stock': Math.max(0, ((s.locations || {})['Engineer Stock'] || 0) - v.qty) });
      db.update('stock', s.id, { eng: s.eng, locations: s.locations }, { note: 'Engineer stock ' + kind });
      if (kind === 'returned') moveStock(r.stockId, v.qty, 'Engineer return', r.engName);
      CRM.refresh();
    });
  }

  // ------------------------------------------------------------------ scrap management (no deletion; disposal needs approval)
  function renderScrap(el) {
    const rows = db.all('scrap').slice().reverse().map((s) => Object.assign({}, s, { late: s.status === 'Pending Collection' && util.hoursBetween(s.createdAt, new Date()) > 24 ? 'Collection > 24h' : '' }));
    ui.page(el, { title: 'Scrap Management', sub: 'Scrap batteries, inverters, UPS and replaced / damaged material — full movement audit, no deletion, disposal only after approval', actions: [can('service_engineer', 'service_coordinator', 'stores', 'install_lead') ? ui.btn('+ Scrap entry', scrapForm, 'primary') : null] });
    el.appendChild(ui.kpis([{ label: 'Total scrap collected', value: sumBy(rows.filter((s) => s.status !== 'Pending Collection'), 'qty') }, { label: 'Pending collection', value: rows.filter((s) => s.status === 'Pending Collection').length, meta: rows.filter((s) => s.late).length + ' beyond 24h', color: 'var(--bad)' }, { label: 'Scrap in stock', value: sumBy(rows.filter((s) => ['Collected', 'In Stock'].includes(s.status)), 'qty'), color: 'var(--warn)' }, { label: 'Sent to vendor', value: sumBy(rows.filter((s) => s.status === 'Sent to Vendor'), 'qty'), color: 'var(--chart-5)' }, { label: 'Disposed', value: sumBy(rows.filter((s) => s.status === 'Disposed'), 'qty'), color: 'var(--ok)' }, { label: 'Disposal approvals pending', value: rows.filter((s) => s.disposalReq && !s.disposalReq.approvedBy).length, color: 'var(--chart-4)' }]));
    const byType = util.groupBy(rows, 'scrapType');
    el.appendChild(h('div', { class: 'grid g3' }, [h('div', { class: 'span2' }, ui.card(null, ui.table({ rows, filters: [{ key: 'status', label: 'statuses', options: SCRAP_STATUS }, { key: 'scrapType', label: 'types', options: Object.keys(byType) }, { key: 'source', label: 'sources', options: ['From Service', 'From Installation', 'From Replacement'] }], onRow: (s) => scrapDrawer(s.id), columns: [{ key: 'id', label: 'Scrap ID', render: (s) => mono(s.id) }, { key: 'link', label: 'Linked', render: (s) => s.linkType + ' ' + (s.linkId || '') }, { key: 'customerId', label: 'Customer', render: (s) => cust(s.customerId).name }, { key: 'scrapType', label: 'Type' }, { key: 'brand', label: 'Brand' }, { key: 'qty', label: 'Qty', cls: 'right' }, { key: 'source', label: 'Source' }, { key: 'storedAt', label: 'Stored at' }, { key: 'status', label: 'Status', render: (s) => h('span', {}, [ui.badge(s.status), s.late ? ' ' : '', s.late ? ui.badge(s.late, 'bad') : '']) }] }), { flush: true })), ui.card('Scrap by type', ui.donut(Object.keys(byType).map((k, i) => ({ label: k, value: sumBy(byType[k], 'qty'), color: 'var(--chart-' + ((i % 6) + 1) + ')' })), { label: 'units' }))]));
  }
  function scrapForm() {
    ui.formModal('Scrap entry', [
      { key: 'trigger', label: 'Trigger case', type: 'select', required: true, options: SCRAP_TRIGGERS }, { key: 'linkType', label: 'Linked to', type: 'select', required: true, options: ['Complaint', 'OTS', 'Sale', 'Project'] }, { key: 'linkId', label: 'Linked record no.', required: true },
      { key: 'customerId', label: 'Customer', type: 'select', required: true, options: master.customers().map((c) => ({ value: c.id, label: c.name })) }, { key: 'location', label: 'Location', required: true },
      { key: 'scrapType', label: 'Scrap type', type: 'select', required: true, options: ['Battery', 'Inverter', 'UPS', 'Cable', 'Camera', 'Other'] }, { key: 'brand', label: 'Brand', type: 'select', required: true, options: ['SF', 'Exide', 'Maruthi', 'Others'] }, { key: 'qty', label: 'Quantity', type: 'number', required: true, default: 1 }, { key: 'capacity', label: 'Capacity (e.g. 150Ah / 1.5KVA)' },
      { key: 'source', label: 'Source', type: 'select', required: true, options: ['From Service', 'From Installation', 'From Replacement'] }, { key: 'collectedBy', label: 'Collected by (engineer)', type: 'select', required: true, options: staffOpts(['service_engineer', 'tech_engineer', 'install_lead']) }, { key: 'storedAt', label: 'Storage location', type: 'select', required: true, options: ['Service Centre', 'Warehouse'] },
    ], {}, (v) => {
      const s = db.insert('scrap', Object.assign(v, { status: 'Pending Collection', history: [{ ts: nowIso(), by: user().name, text: 'Scrap identified at site & entered' }], viol: [] }), { prefix: 'SCR', note: 'Scrap entry' });
      ui.toast(s.id + ' recorded — physical collection pending (24h policy)', 'ok'); CRM.refresh();
    });
  }
  function scrapDrawer(id) {
    const s = db.get('scrap', id);
    const step = (status, text, extra) => { db.update('scrap', id, Object.assign({ status, history: (s.history || []).concat({ ts: nowIso(), by: user().name, text }) }, extra || {}), { note: 'Scrap → ' + status }); CRM.refresh(); };
    const acts = [];
    if (s.status === 'Pending Collection' && can('service_engineer', 'stores', 'install_lead')) acts.push({ label: 'Physically collected', cls: 'primary', onClick: () => step('Collected', 'Scrap brought to ' + s.storedAt, { collectedAt: nowIso() }) });
    if (s.status === 'Collected' && can('stores')) acts.push({ label: 'Store & tag', cls: 'primary', onClick: () => step('In Stock', 'Stored and tagged SCRAP-TAG-' + util.rand(1000, 9999)) });
    if (s.status === 'In Stock' && !s.disposalReq && can('stores')) acts.push({ label: 'Request disposal / vendor return', onClick: () => ui.formModal('Disposal request', [{ key: 'mode', label: 'Mode', type: 'select', required: true, options: ['Vendor return (Exide / SF)', 'Internal disposal'] }, { key: 'note', label: 'Remarks' }], {}, (v) => { db.update('scrap', id, { disposalReq: { mode: v.mode, note: v.note, by: user().name, ts: nowIso() }, history: (s.history || []).concat({ ts: nowIso(), by: user().name, text: 'Disposal requested: ' + v.mode }) }, { note: 'Disposal requested' }); CRM.notify({ to: ['odm', 'gm'], title: 'Scrap disposal approval: ' + id, body: s.qty + ' × ' + s.scrapType + ' — ' + v.mode, link: '#/scrap', severity: 'warn', key: 'sd-' + id }); CRM.refresh(); }) });
    if (s.disposalReq && !s.disposalReq.approvedBy && CRM.is('gm', 'odm', 'admin')) acts.push({ label: 'Approve disposal', cls: 'ok', onClick: () => step(/^Vendor/.test(s.disposalReq.mode) ? 'Sent to Vendor' : 'Disposed', 'Disposal approved by ' + user().name + ' — ' + s.disposalReq.mode, { disposalReq: Object.assign({}, s.disposalReq, { approvedBy: user().name, approvedAt: nowIso() }) }) });
    ui.drawer({ title: 'Scrap ' + s.id, sub: s.trigger, body: h('div', { class: 'stack' }, [ui.dl([['Linked', s.linkType + ' ' + (s.linkId || '')], ['Customer', cust(s.customerId).name], ['Location', s.location], ['Scrap type', s.scrapType], ['Brand', s.brand], ['Quantity', s.qty], ['Capacity', s.capacity], ['Source', s.source], ['Collected by', sName(s.collectedBy)], ['Stored location', s.storedAt], ['Status', ui.badge(s.status)], ['Disposal', s.disposalReq ? s.disposalReq.mode + (s.disposalReq.approvedBy ? ' — approved by ' + s.disposalReq.approvedBy : ' — awaiting approval') : '—']]), ui.callout('Scrap records cannot be deleted; every movement is audited.', 'info'), ui.timeline((s.history || []).slice().reverse().map((x) => ({ when: fmt.dateTime(x.ts) + ' · ' + x.by, title: x.text }))), ui.auditTrail('scrap', s.id)]), actions: acts.length ? acts : [{ label: 'Close' }] });
  }

  // ------------------------------------------------------------------ vendor & supplier performance
  function supplierPerf() {
    return SUPPLIERS.map((name) => {
      const pos = db.find('purchaseOrders', (po) => po.supplier === name && po.status !== 'Cancelled');
      const due = pos.filter((po) => po.status === 'Received' || isPast(po.promisedDate));
      const onTime = due.filter((po) => po.status === 'Received' && po.receivedAt && isoD(po.receivedAt) <= po.promisedDate);
      const grns = db.find('grns', (g) => g.supplier === name);
      const rec = sumBy(grns.flatMap((g) => g.items), 'received'), rej = sumBy(grns.flatMap((g) => g.items), 'rejected');
      return { name, pos: pos.length, value: sumBy(pos, 'value'), onTime: util.pct(onTime.length, due.length), due: due.length, avgDelay: due.length ? Math.round(sumBy(due, poDelay) / due.length * 10) / 10 : 0, rejected: util.pct(rej, rec), variance: sumBy(pos, (po) => po.value - po.budget), open: pos.filter((po) => !['Received'].includes(po.status)).length };
    }).filter((s) => s.pos);
  }
  function renderVendorPerf(el) {
    const sp = supplierPerf();
    ui.page(el, { title: 'Vendor & Supplier Performance', sub: 'Supplier delivery commitments, delays, rejected material and cost variance; installation vendor completion, delays and rework' });
    el.appendChild(h('div', { class: 'grid g2' }, [ui.card('Supplier on-time delivery %', ui.hbars(sp.map((s) => ({ label: s.name, value: s.onTime, target: 100, text: fmt.pct(s.onTime) + ' (' + s.due + ' due)' })))), ui.card('Installation vendors & teams', vendorTable(db.all('projects')), { flush: true })]));
    el.appendChild(h('div', { class: 'mt' }, ui.card('Supplier scorecard', ui.table({ rows: sp, columns: [{ key: 'name', label: 'Supplier' }, { key: 'pos', label: 'POs', cls: 'right' }, { key: 'value', label: 'PO value', cls: 'right', render: (s) => fmt.lakh(s.value) }, { key: 'onTime', label: 'On-time %', cls: 'right', render: (s) => ui.badge(fmt.pct(s.onTime), s.onTime >= 80 ? 'ok' : s.onTime >= 60 ? 'warn' : 'bad') }, { key: 'avgDelay', label: 'Avg delay (d)', cls: 'right' }, { key: 'rejected', label: 'Rejected %', cls: 'right', render: (s) => fmt.pct(s.rejected) }, { key: 'variance', label: 'Cost variance', cls: 'right', render: (s) => fmt.money(s.variance) }, { key: 'open', label: 'Open POs', cls: 'right' }] }), { flush: true })));
  }

  // ------------------------------------------------------------------ project material dashboard
  function projectMaterialBody() {
    const ps = db.all('projects').filter((p) => isActive(p) && approvedBoq(p.id));
    const rows = ps.map((p) => { const n = needs(p); const val = (f) => sumBy(n, (x) => f(x) * ((stockItem(x.stockId) || {}).purchaseCost || 0)); return { p, id: p.id, customer: cust(p.customerId).name, division: p.division, allocated: val((x) => x.alloc + x.transit + x.site), consumed: val((x) => x.used || (DONE(st(p, p.kind === 'solar' ? 'electrical' : p.kind === 'es_small' ? 'install' : 'cameras')) ? x.site : 0)), balance: val((x) => x.site - x.used - x.returned), short: n.filter((x) => x.short).length }; });
    return h('div', { class: 'stack' }, [ui.kpis([{ label: 'Material allocated', value: fmt.lakh(sumBy(rows, 'allocated')) }, { label: 'Material consumed', value: fmt.lakh(sumBy(rows, 'consumed')) }, { label: 'Balance at site', value: fmt.lakh(sumBy(rows, 'balance')) }, { label: 'Projects with shortage alerts', value: rows.filter((r) => r.short).length, color: 'var(--bad)' }]), ui.card('Project-wise material (BOQ-based reservation, site allocation, stage consumption)', ui.table({ rows, onRow: (r) => CRM.go('projects', r.id), filters: [{ key: 'division', label: 'divisions', options: [ESD, SOL] }], columns: [{ key: 'id', label: 'Project', render: (r) => pLink(r.id) }, { key: 'customer', label: 'Customer' }, { key: 'stage', label: 'Stage', render: (r) => curLabel(r.p) }, { key: 'allocated', label: 'Allocated', cls: 'right', render: (r) => fmt.lakh(r.allocated) }, { key: 'consumed', label: 'Consumed', cls: 'right', render: (r) => fmt.lakh(r.consumed) }, { key: 'balance', label: 'Balance', cls: 'right', render: (r) => fmt.lakh(r.balance) }, { key: 'short', label: 'Shortage alerts', render: (r) => (r.short ? ui.badge(r.short + ' items', 'bad') : ui.badge('None', 'ok')) }] }), { flush: true })]);
  }
  function renderProjectMaterial(el) { ui.page(el, { title: 'Project Material', sub: 'BOQ-based reservation, site-wise allocation, stage-wise consumption and shortage alerts' }); el.appendChild(projectMaterialBody()); }

  // ------------------------------------------------------------------ net metering (separate workstream, configurable utility stages)
  const NM_NEXT = { 'Not Started': ['Documents Pending'], 'Documents Pending': ['Ready for Submission'], 'Ready for Submission': ['Submitted'], Submitted: ['Under Review'], 'Under Review': ['Additional Information Required', 'Approved', 'Rejected'], 'Additional Information Required': ['Under Review'], Rejected: ['Ready for Submission'], Approved: ['Meter Installation Pending'], 'Meter Installation Pending': ['Completed'], Completed: [] };
  const docOwner = () => CRM.is('doc_coordinator', 'admin');
  const maskNo = (n) => (!n ? '—' : CRM.is('doc_coordinator', 'solar_coordinator', 'admin') ? n : n.replace(/.(?=.{3})/g, '•'));
  function renderNM(el, params) {
    const rows = db.all('netMetering').map((n) => Object.assign({}, n, { customer: cust(n.customerId).name, follow: n.nextFollowUp && isPast(n.nextFollowUp) && n.status !== 'Completed' ? 'Overdue' : '' }));
    ui.page(el, { title: 'Net-Metering Applications', sub: 'Separate workstream linked to each Solar project — a submitted application is never counted as approved' });
    const by = util.countBy(rows, 'status');
    el.appendChild(ui.kpis([{ label: 'Applications', value: rows.length }, { label: 'Documents pending', value: (by['Not Started'] || 0) + (by['Documents Pending'] || 0), color: 'var(--warn)' }, { label: 'Submitted / under review', value: (by.Submitted || 0) + (by['Under Review'] || 0) + (by['Additional Information Required'] || 0), color: 'var(--chart-5)' }, { label: 'Approved (incl. meter pending)', value: (by.Approved || 0) + (by['Meter Installation Pending'] || 0), color: 'var(--ok)' }, { label: 'Rejected', value: by.Rejected || 0, color: 'var(--bad)' }, { label: 'Follow-ups overdue', value: rows.filter((r) => r.follow).length, color: 'var(--bad)' }]));
    el.appendChild(h('div', { class: 'grid g3' }, [h('div', { class: 'span2' }, ui.card(null, ui.table({ rows, onRow: (n) => nmDrawer(n.id), filters: [{ key: 'status', label: 'statuses', options: NM_STATUS }, { key: 'follow', label: 'follow-up', options: ['Overdue'] }], columns: [{ key: 'id', label: 'Application', render: (n) => mono(n.id) }, { key: 'projectId', label: 'Project', render: (n) => pLink(n.projectId) }, { key: 'customer', label: 'Customer' }, { key: 'consumerNo', label: 'Consumer no.', render: (n) => mono(maskNo(n.consumerNo)) }, { key: 'refNo', label: 'Reference no.' }, { key: 'plannedSubmit', label: 'Planned / actual submission', render: (n) => fmt.date(n.plannedSubmit) + ' / ' + fmt.date(n.actualSubmit) }, { key: 'nextFollowUp', label: 'Next follow-up', render: (n) => h('span', {}, [fmt.date(n.nextFollowUp), n.follow ? ' ' : '', n.follow ? ui.badge('Overdue', 'bad') : '']) }, { key: 'status', label: 'Status', render: (n) => ui.badge(n.status) }] }), { flush: true })), ui.card('Pipeline', ui.hbars(NM_STATUS.map((s) => ({ label: s, value: by[s] || 0 }))))]));
    if (params[0]) setTimeout(() => nmDrawer(params[0]));
  }
  function nmDrawer(id) {
    const n = db.get('netMetering', id); const p = db.get('projects', n.projectId);
    const edit = can('doc_coordinator', 'solar_coordinator') && n.status !== 'Completed';
    const obj = {}; (n.docs || []).forEach((i) => { obj[NM_DOCS[i]] = true; });
    const cl = ui.checklist(NM_DOCS, obj, null, !edit);
    const fields = [{ key: 'consumerNo', label: 'Consumer no. / service connection (controlled access)', type: CRM.is('doc_coordinator', 'solar_coordinator', 'admin') ? 'text' : 'readonly' }, { key: 'owner', label: 'Application preparation owner', type: 'select', options: staffOpts(['doc_coordinator', 'solar_coordinator']) }, { key: 'plannedSubmit', label: 'Planned submission date', type: 'date' }, { key: 'actualSubmit', label: 'Actual submission date', type: 'date' }, { key: 'refNo', label: 'Application / reference number' }, { key: 'ack', label: 'Submission acknowledgement (ref)' }, { key: 'inspection', label: 'Inspection / additional-document request' }, { key: 'pendingAction', label: 'Pending action & responsible person' }, { key: 'nextFollowUp', label: 'Next follow-up date', type: 'date' }, { key: 'outcome', label: 'Approval / rejection / resubmission details' }, { key: 'meterDate', label: 'Meter installation date', type: 'date' }, { key: 'meterRef', label: 'Meter reference' }];
    const form = ui.form(fields, Object.assign({}, n, { consumerNo: CRM.is('doc_coordinator', 'solar_coordinator', 'admin') ? n.consumerNo : maskNo(n.consumerNo) }));
    if (!edit) Object.values(form.inputs).forEach((i) => { i.disabled = true; });
    const save = (status) => {
      const v = form.values(); if (!CRM.is('doc_coordinator', 'solar_coordinator', 'admin')) delete v.consumerNo;
      const docs = NM_DOCS.map((d, i) => (obj[d] ? i : -1)).filter((i) => i >= 0);
      const changed = Object.keys(v).filter((k) => String(v[k] || '') !== String(n[k] || ''));
      const log = (n.log || []).slice();
      if (changed.length) log.push({ ts: nowIso(), by: user().name, text: (NM_STATUS.indexOf(n.status) >= 3 ? 'Submitted application info changed: ' : 'Updated: ') + changed.join(', ') });
      if (status) log.push({ ts: nowIso(), by: user().name, text: 'Status → ' + status });
      db.update('netMetering', id, Object.assign(v, { docs, log }, status ? { status } : {}), { note: status ? 'Net-metering → ' + status : 'Net-metering updated' });
    };
    const acts = [];
    if (edit) {
      acts.push({ label: 'Save', onClick: () => { save(); ui.toast('Saved', 'ok'); CRM.refresh(); } });
      (NM_NEXT[n.status] || []).forEach((ns) => acts.push({ label: '→ ' + ns, cls: ns === 'Rejected' ? 'danger' : 'primary', onClick: () => {
        const v = form.values(); const docsOk = cl.complete();
        if (ns === 'Ready for Submission' && !docsOk) { ui.toast('All required application documents must be in place first', 'bad'); return false; }
        if (ns === 'Submitted') { if (!yes(v.refNo) || !yes(v.actualSubmit) || !yes(v.ack)) { ui.toast('Reference number, actual submission date and acknowledgement are mandatory', 'bad'); return false; } if (!DONE(st(p, 'electrical'))) { ui.toast('Submission depends on installation completion (electrical work approved) as per utility requirements', 'bad'); return false; } }
        if (['Approved', 'Rejected'].includes(ns) && !yes(v.outcome)) { ui.toast('Record approval / rejection details', 'bad'); return false; }
        if (ns === 'Completed' && (!yes(v.meterDate) || !yes(v.meterRef))) { ui.toast('Meter installation date and reference are mandatory', 'bad'); return false; }
        save(ns);
        if (ns === 'Completed') CRM.notify({ to: 'solar_coordinator', title: 'Net meter installed: ' + p.id, body: cust(p.customerId).name, link: plink(p.id), severity: 'ok', key: 'nmc-' + id });
        ui.toast('Status → ' + ns, 'ok'); CRM.refresh();
      } }));
    }
    ui.drawer({ title: 'Net metering ' + n.id, sub: p.id + ' · ' + cust(p.customerId).name + ' · ' + p.capacityKw + ' kWp', body: h('div', { class: 'stack' }, [ui.dl([['Status', ui.badge(n.status)], ['Project', pLink(p.id)], ['Installation', curLabel(p)], ['Grid sync', st(p, 'commissioning').fields.gridStatus || '—']]), ui.callout('Stages are configurable for the relevant utility and scheme. Documentation may be prepared in parallel with installation; submission respects commissioning prerequisites.', 'info'), h('h3', {}, 'Application / document checklist'), cl, h('h3', {}, 'Application details'), form, h('h3', {}, 'History'), ui.timeline((n.log || []).slice().reverse().map((x) => ({ when: fmt.dateTime(x.ts) + ' · ' + x.by, title: x.text })))]), actions: acts.length ? acts : [{ label: 'Close' }] });
  }

  // ------------------------------------------------------------------ subsidy tracker (sensitive documents: doc_coordinator only)
  const SUB_NEXT = { 'Eligibility Check': ['Documents Pending'], 'Documents Pending': ['Registered'], Registered: ['Application Submitted'], 'Application Submitted': ['Under Verification'], 'Under Verification': ['Additional Documents Requested', 'Approved', 'Rejected'], 'Additional Documents Requested': ['Under Verification'], Rejected: ['Resubmitted'], Resubmitted: ['Under Verification'], Approved: ['Disbursed'], Disbursed: [] };
  function renderSubsidy(el, params) {
    const rows = db.all('subsidies').map((s) => Object.assign({}, s, { customer: cust(s.customerId).name, follow: s.nextFollowUp && isPast(s.nextFollowUp) && !['Disbursed'].includes(s.status) && s.eligibility !== 'Not Eligible' ? 'Overdue' : '' }));
    ui.page(el, { title: 'Subsidy Registration & Applications', sub: 'Eligibility verified against the applicable scheme (never assumed). Company installation completion is tracked separately from subsidy approval and payment.' });
    if (!docOwner()) el.appendChild(h('div', { style: 'margin-bottom:12px' }, ui.callout('Sensitive customer documents (ID, bank, consent) are restricted to the Documentation Coordinator. You can view status only.', 'warn')));
    el.appendChild(ui.kpis([{ label: 'Eligibility pending', value: rows.filter((s) => s.eligibility === 'Pending').length, color: 'var(--warn)' }, { label: 'Eligible', value: rows.filter((s) => s.eligibility === 'Eligible').length, color: 'var(--ok)' }, { label: 'Not eligible', value: rows.filter((s) => s.eligibility === 'Not Eligible').length }, { label: 'Applications submitted', value: rows.filter((s) => SUB_STATUS.indexOf(s.status) >= 3).length, color: 'var(--chart-5)' }, { label: 'Missing documents', value: rows.filter((s) => s.eligibility === 'Eligible' && (s.docs || []).length < SUB_DOCS.length).length, color: 'var(--bad)' }, { label: 'Disbursed', value: rows.filter((s) => s.status === 'Disbursed').length, color: 'var(--ok)' }]));
    el.appendChild(ui.card(null, ui.table({ rows, onRow: (s) => subDrawer(s.id), filters: [{ key: 'eligibility', label: 'eligibility', options: ['Pending', 'Eligible', 'Not Eligible'] }, { key: 'status', label: 'statuses', options: SUB_STATUS }], columns: [{ key: 'id', label: 'Record', render: (s) => mono(s.id) }, { key: 'projectId', label: 'Project', render: (s) => pLink(s.projectId) }, { key: 'customer', label: 'Customer' }, { key: 'scheme', label: 'Scheme & version' }, { key: 'eligibility', label: 'Eligibility', render: (s) => ui.badge(s.eligibility === 'Eligible' ? 'Verified eligible' : s.eligibility) }, { key: 'docs', label: 'Documents', render: (s) => (docOwner() ? (s.docs || []).length + ' / ' + SUB_DOCS.length : '🔒') }, { key: 'appId', label: 'Application ID' }, { key: 'nextFollowUp', label: 'Next follow-up', render: (s) => h('span', {}, [fmt.date(s.nextFollowUp), s.follow ? ' ' : '', s.follow ? ui.badge('Overdue', 'bad') : '']) }, { key: 'status', label: 'Status', render: (s) => ui.badge(s.status) }, { key: 'disbursement', label: 'Disbursement' }] }), { flush: true }));
    if (params[0]) setTimeout(() => subDrawer(params[0]));
  }
  function subDrawer(id) {
    const s = db.get('subsidies', id); const p = db.get('projects', s.projectId);
    const edit = docOwner() && s.status !== 'Disbursed';
    const obj = {}; (s.docs || []).forEach((i) => { obj[SUB_DOCS[i]] = true; });
    const cl = docOwner() ? ui.checklist(SUB_DOCS, obj, null, !edit) : ui.callout('🔒 Restricted — sensitive customer documents are visible only to the Documentation Coordinator (access is role-based).', 'warn');
    const fields = [{ key: 'scheme', label: 'Scheme name & version', type: 'select', options: SCHEMES }, { key: 'eligibility', label: 'Eligibility verification', type: 'select', options: ['Pending', 'Eligible', 'Not Eligible'] }, { key: 'evidence', label: 'Eligibility evidence' }, { key: 'consent', label: 'Customer consent', type: 'select', options: ['Yes', 'No'] }, { key: 'appId', label: 'Registration / application ID' }, { key: 'portalDate', label: 'Portal submission date', type: 'date' }, { key: 'pending', label: 'Pending requirements' }, { key: 'vendorReg', label: 'Vendor / installer registration details' }, { key: 'inspection', label: 'Inspection / verification status', type: 'select', options: ['Not required yet', 'Scheduled', 'Completed', 'Failed'] }, { key: 'addlReqDate', label: 'Additional document request date', type: 'date' }, { key: 'responseDate', label: 'Response date', type: 'date' }, { key: 'outcome', label: 'Approval / rejection / resubmission' }, { key: 'disbursement', label: 'Disbursement status', type: 'select', options: ['Not tracked', 'Pending', 'Partially disbursed', 'Disbursed to customer'] }, { key: 'nextFollowUp', label: 'Next follow-up date', type: 'date' }];
    const form = ui.form(fields, s);
    if (!edit) Object.values(form.inputs).forEach((i) => { i.disabled = true; });
    const save = (status) => {
      const v = form.values(); const docs = docOwner() ? SUB_DOCS.map((d, i) => (obj[d] ? i : -1)).filter((i) => i >= 0) : s.docs;
      const changed = Object.keys(v).filter((k) => String(v[k] || '') !== String(s[k] || ''));
      const log = (s.log || []).slice(); if (changed.length) log.push({ ts: nowIso(), by: user().name, text: (SUB_STATUS.indexOf(s.status) >= 3 ? 'Submitted application info changed: ' : 'Updated: ') + changed.join(', ') }); if (status) log.push({ ts: nowIso(), by: user().name, text: 'Status → ' + status });
      db.update('subsidies', id, Object.assign(v, { docs, log }, status ? { status } : {}), { note: status ? 'Subsidy → ' + status : 'Subsidy updated' });
    };
    const acts = [];
    if (edit) {
      acts.push({ label: 'Save', onClick: () => { save(); CRM.refresh(); } });
      acts.push({ label: 'Log customer communication', onClick: () => ui.formModal('Customer communication', [{ key: 'channel', label: 'Channel', type: 'select', required: true, options: ['Phone', 'WhatsApp', 'Email', 'Visit'] }, { key: 'note', label: 'Summary', required: true }, { key: 'next', label: 'Next follow-up', type: 'date' }], {}, (v) => { db.update('subsidies', id, { comms: (s.comms || []).concat({ ts: nowIso(), by: user().name, channel: v.channel, note: v.note }), nextFollowUp: v.next || s.nextFollowUp }, { note: 'Communication logged' }); CRM.refresh(); }) });
      if (s.eligibility !== 'Not Eligible') (SUB_NEXT[s.status] || []).forEach((ns) => acts.push({ label: '→ ' + ns, cls: ns === 'Rejected' ? 'danger' : 'primary', onClick: () => {
        const v = form.values();
        if (ns === 'Documents Pending' && v.eligibility !== 'Eligible') { ui.toast('Eligibility must be verified against the scheme first', 'bad'); return false; }
        if (ns === 'Registered' && (!cl.complete || !cl.complete() || v.consent !== 'Yes')) { ui.toast('All required customer documents and consent are needed', 'bad'); return false; }
        if (ns === 'Application Submitted' && (!yes(v.appId) || !yes(v.portalDate))) { ui.toast('Application ID and portal submission date are mandatory', 'bad'); return false; }
        if (ns === 'Disbursed' && v.disbursement !== 'Disbursed to customer') { ui.toast('Set disbursement status first', 'bad'); return false; }
        save(ns); ui.toast('Status → ' + ns, 'ok'); CRM.refresh();
      } }));
    }
    ui.drawer({ title: 'Subsidy ' + s.id, sub: p.id + ' · ' + cust(p.customerId).name + ' · ' + p.projectType + ' ' + p.capacityKw + ' kWp', body: h('div', { class: 'stack' }, [ui.dl([['Status', ui.badge(s.status)], ['Eligibility', ui.badge(s.eligibility)], ['Installation (company)', p.status === 'Closed' ? 'Handed over' : curLabel(p)], ['Subsidy approval / payment', s.status + ' / ' + (s.disbursement || '—')]]), h('h3', {}, 'Required customer documents'), cl, h('h3', {}, 'Application'), form, h('h3', {}, 'Customer communication history'), ui.timeline((s.comms || []).slice().reverse().map((c) => ({ when: fmt.dateTime(c.ts) + ' · ' + c.by + ' · ' + c.channel, title: c.note }))), h('h3', {}, 'Change log'), ui.timeline((s.log || []).slice().reverse().map((x) => ({ when: fmt.dateTime(x.ts) + ' · ' + x.by, title: x.text })))]), actions: acts.length ? acts : [{ label: 'Close' }] });
  }
  function followups() {
    const nm = db.all('netMetering').filter((n) => n.nextFollowUp && n.status !== 'Completed').map((n) => ({ kind: 'Net metering', id: n.id, projectId: n.projectId, date: n.nextFollowUp, status: n.status, action: n.pendingAction || 'Follow up with utility', link: '#/net-metering/' + n.id }));
    const sb = db.all('subsidies').filter((s) => s.nextFollowUp && s.status !== 'Disbursed' && s.eligibility !== 'Not Eligible').map((s) => ({ kind: 'Subsidy', id: s.id, projectId: s.projectId, date: s.nextFollowUp, status: s.status, action: s.pending || 'Follow up on portal / customer documents', link: '#/subsidy/' + s.id }));
    return nm.concat(sb).sort((a, b) => (a.date > b.date ? 1 : -1));
  }
  function renderFollowups(el) {
    const rows = followups().map((r) => Object.assign(r, { when: isPast(r.date) ? 'Overdue' : r.date === isoD(T0) ? 'Today' : util.daysBetween(T0, r.date) <= 7 ? 'This week' : 'Later' }));
    ui.page(el, { title: 'Compliance Follow-ups', sub: 'Net-metering and subsidy follow-ups — missing documents and overdue follow-ups are visible to the owner and manager' });
    el.appendChild(ui.kpis(['Overdue', 'Today', 'This week', 'Later'].map((w) => ({ label: w, value: rows.filter((r) => r.when === w).length, color: w === 'Overdue' ? 'var(--bad)' : w === 'Today' ? 'var(--warn)' : null }))));
    el.appendChild(ui.card(null, ui.table({ rows, onRow: (r) => { location.hash = r.link; }, filters: [{ key: 'when', label: 'due', options: ['Overdue', 'Today', 'This week', 'Later'] }, { key: 'kind', label: 'workstreams', options: ['Net metering', 'Subsidy'] }], columns: [{ key: 'date', label: 'Follow-up', render: (r) => h('span', {}, [fmt.date(r.date), ' ', ui.badge(r.when, r.when === 'Overdue' ? 'bad' : r.when === 'Today' ? 'warn' : 'info')]) }, { key: 'kind', label: 'Workstream' }, { key: 'id', label: 'Record', render: (r) => mono(r.id) }, { key: 'projectId', label: 'Project', render: (r) => pLink(r.projectId) }, { key: 'c', label: 'Customer', render: (r) => cust((db.get('projects', r.projectId) || {}).customerId).name }, { key: 'status', label: 'Status', render: (r) => ui.badge(r.status) }, { key: 'action', label: 'Pending action' }] }), { flush: true }));
  }

  // ------------------------------------------------------------------ role homes
  function actionList(items, empty) {
    if (!items.length) return ui.empty(empty || 'Nothing pending — all caught up', '✓');
    return h('div', { class: 'stack', style: 'gap:0' }, items.slice(0, 12).map((it) => h('a', { href: it.link || null, style: 'display:flex;justify-content:space-between;gap:10px;padding:10px 4px;border-bottom:1px solid var(--border);color:var(--text)' }, [h('div', {}, [h('div', { style: 'font-weight:600' }, it.title), h('div', { class: 'small muted' }, it.sub || '')]), it.badge ? ui.badge(it.badge, it.tone == null ? null : it.tone) : null])));
  }
  const quick = (items) => ui.card('Quick actions', h('div', { class: 'row' }, items.map(([l, id, cls]) => ui.btn(l, () => (typeof id === 'function' ? id() : CRM.go(id)), cls))));
  function coordHome(el, division) {
    const coordRole = division === SOL ? 'solar_coordinator' : 'es_coordinator';
    const ps = db.find('projects', (p) => p.division === division); const act = ps.filter(isActive);
    const todo = [];
    act.filter((p) => !p.acceptedAt).forEach((p) => todo.push({ title: 'Accept & assign ' + p.id, sub: cust(p.customerId).name + ' · SO ' + p.soNumber, link: plink(p.id) + '/so', badge: util.daysBetween(p.createdAt, T0) > 1 ? 'SLA breached' : 'New', tone: util.daysBetween(p.createdAt, T0) > 1 ? 'bad' : 'info' }));
    act.filter((p) => p.kind === 'es_pending').forEach((p) => todo.push({ title: 'Select workflow for ' + p.id, sub: p.systemType + ' order without camera count', link: plink(p.id), badge: 'Classify', tone: 'warn' }));
    db.find('surveys', (s) => s.division === division && s.status === 'Submitted').forEach((s) => todo.push({ title: 'Review survey ' + s.id, sub: s.projectId + ' · ' + (s.fields.feasibility || ''), link: '#/surveys/' + s.id, badge: 'Review', tone: 'warn' }));
    db.find('dcs', (d) => d.status === 'Discrepancy' && (db.get('projects', d.projectId) || {}).division === division).forEach((d) => todo.push({ title: 'Delivery discrepancy ' + d.id, sub: d.projectId + ' — ' + ((d.exception || {}).text || ''), link: plink(d.projectId) + '/delivery', badge: 'Exception', tone: 'bad' }));
    act.filter((p) => ['handover', 'activate'].includes(curKey(p))).forEach((p) => todo.push({ title: 'Handover ' + p.id, sub: cust(p.customerId).name + ' · ' + handoverMissing(p).length + ' items missing', link: plink(p.id) + '/' + curKey(p), badge: st(p, curKey(p)).status === 'Submitted for Inspection' ? 'Approve closure' : 'Pending', tone: 'info' }));
    act.filter((p) => stageOverdue(p, curKey(p))).sort((a, b) => daysLate(st(b, curKey(b)).due) - daysLate(st(a, curKey(a)).due)).forEach((p) => todo.push({ title: p.id + ' · ' + curLabel(p) + ' overdue', sub: cust(p.customerId).name + (st(p, curKey(p)).delayReason ? ' · ' + st(p, curKey(p)).delayReason : ' · no delay reason recorded'), link: plink(p.id), badge: daysLate(st(p, curKey(p)).due) + 'd late', tone: 'bad' }));
    const k = kpiData(ps);
    el.appendChild(ui.hero(CRM.role(), [act.length + ' active ' + (division === SOL ? 'solar projects' : 'projects & jobs'), act.filter(projOverdue).length + ' overdue', act.filter((p) => ['handover', 'activate'].includes(curKey(p))).length + ' handovers pending']));
    const kp = division === SOL
      ? [{ label: 'Projects in progress', value: act.length, color: 'var(--div-solar)' }, { label: 'Overdue', value: act.filter(projOverdue).length, color: 'var(--bad)' }, { label: 'Material readiness %', value: fmt.pct(k.readiness.value), onClick: () => kpiDrill(k.readiness) }, { label: 'On-time handover %', value: fmt.pct(k.handover.value), onClick: () => kpiDrill(k.handover) }, { label: 'Awaiting net-metering docs', value: act.filter((p) => { const n = db.one('netMetering', (x) => x.projectId === p.id); return n && NM_STATUS.indexOf(n.status) < 3; }).length, color: 'var(--chart-5)' }]
      : [{ label: 'Large projects', value: act.filter((p) => p.kind === 'es_large').length, color: 'var(--div-security)' }, { label: 'Small jobs', value: act.filter((p) => p.kind === 'es_small').length, color: 'var(--chart-6)' }, { label: 'Overdue', value: act.filter(projOverdue).length, color: 'var(--bad)' }, { label: 'Material short', value: act.filter((p) => approvedBoq(p.id) && shortages(p).length).length, color: 'var(--warn)' }, { label: 'Survey on-time %', value: fmt.pct(k.survey.value), onClick: () => kpiDrill(k.survey) }, { label: 'Handover on-time %', value: fmt.pct(k.handover.value), onClick: () => kpiDrill(k.handover) }];
    el.appendChild(ui.kpis(kp));
    el.appendChild(h('div', { class: 'grid g3' }, [h('div', { class: 'span2' }, ui.card('My action list today', actionList(todo))), h('div', { class: 'stack' }, [quick(division === SOL ? [['Solar dashboard', 'solar-dash', 'primary'], ['Projects', 'projects'], ['Net metering', 'net-metering'], ['Handover', 'handover'], ['KPIs', 'proj-kpi']] : [['Installation dashboard', 'proj-dash', 'primary'], ['Projects', 'projects'], ['Device schedule', 'device-schedule'], ['Handover', 'handover'], ['Reports', 'proj-reports']]), ui.card('Projects by phase', ui.donut(PHASES.map((x, i) => ({ label: x[0], value: act.filter((p) => phaseOf(p) === x[0]).length, color: 'var(--chart-' + ((i % 6) + 1) + ')' })), { label: 'active' }))])]));
    el.appendChild(h('div', { class: 'grid g2 mt' }, division === SOL ? [ui.card('Projects by stage', stageBars(ps, 'solar')), ui.card('Planned vs actual completion', plannedVsActual(ps))] : [ui.card('Large projects by stage', stageBars(ps, 'es_large')), ui.card('Small jobs by stage', stageBars(ps, 'es_small'))]));
  }
  function docHome(el) {
    const nm = db.all('netMetering'), sb = db.all('subsidies'), fu = followups();
    el.appendChild(ui.hero(CRM.role(), [fu.filter((r) => isPast(r.date)).length + ' follow-ups overdue', fu.filter((r) => r.date === isoD(T0)).length + ' due today', 'Owner of sensitive subsidy documents']));
    el.appendChild(ui.kpis([{ label: 'NM documents pending', value: nm.filter((n) => NM_STATUS.indexOf(n.status) < 3).length, color: 'var(--warn)', onClick: () => CRM.go('net-metering') }, { label: 'NM under utility review', value: nm.filter((n) => ['Submitted', 'Under Review', 'Additional Information Required'].includes(n.status)).length, color: 'var(--chart-5)' }, { label: 'Meter installation pending', value: nm.filter((n) => n.status === 'Meter Installation Pending').length }, { label: 'Subsidy eligibility to verify', value: sb.filter((s) => s.eligibility === 'Pending').length, color: 'var(--chart-4)', onClick: () => CRM.go('subsidy') }, { label: 'Subsidy document gaps', value: sb.filter((s) => s.eligibility === 'Eligible' && (s.docs || []).length < SUB_DOCS.length).length, color: 'var(--bad)' }, { label: 'NM submission on-time %', value: fmt.pct(kpiData().netmeter.value) }]));
    const todo = fu.filter((r) => new Date(r.date) <= util.addDays(T0, 2)).map((r) => ({ title: r.kind + ' follow-up · ' + r.projectId, sub: r.action + ' · ' + r.status, link: r.link, badge: isPast(r.date) ? 'Overdue ' + daysLate(r.date) + 'd' : fmt.rel(r.date), tone: isPast(r.date) ? 'bad' : 'warn' }));
    db.all('projects').filter((p) => p.kind === 'solar' && isActive(p) && DONE(st(p, 'commissioning')) && !DONE(st(p, 'handover'))).forEach((p) => todo.push({ title: 'Handover document pack · ' + p.id, sub: handoverMissing(p).length + ' items missing', link: plink(p.id) + '/handover', badge: 'Docs', tone: 'info' }));
    el.appendChild(h('div', { class: 'grid g3' }, [h('div', { class: 'span2' }, ui.card('Follow-ups & document tasks', actionList(todo))), h('div', { class: 'stack' }, [quick([['Net metering', 'net-metering', 'primary'], ['Subsidy', 'subsidy'], ['Follow-ups', 'compliance-followups'], ['Handover', 'handover']]), ui.card('Subsidy status', ui.donut(['Eligibility Check', 'Documents Pending', 'Registered', 'Application Submitted', 'Under Verification', 'Approved', 'Disbursed'].map((s, i) => ({ label: s, value: sb.filter((x) => x.status === s && x.eligibility !== 'Not Eligible').length, color: 'var(--chart-' + ((i % 6) + 1) + ')' })), { label: 'eligible' }))])]));
    el.appendChild(h('div', { class: 'mt' }, ui.card('Net-metering pipeline', ui.barChart(NM_STATUS.map((s) => ({ label: s.replace('Additional Information Required', 'Addl. info').replace('Meter Installation Pending', 'Meter pending').replace('Ready for Submission', 'Ready'), values: [nm.filter((n) => n.status === s).length] })), [{ name: 'Applications', color: 'var(--div-solar)' }]))));
  }
  function engineerHome(el) {
    const u = user();
    const ps = db.all('projects').filter((p) => isActive(p) && (p.engineer === u.id || (p.tasks || []).some((t) => t.assignee === u.id)));
    const items = [];
    db.find('surveys', (s) => s.fields.engineer === u.id && ['Scheduled', 'Draft', 'Returned for correction'].includes(s.status)).forEach((s) => items.push({ icon: '📍', title: 'Site visit · ' + s.projectId, sub: cust((db.get('projects', s.projectId) || {}).customerId).name + ' · ' + s.status, due: s.fields.plannedDate, act: () => surveyDrawer(s.id), label: 'Open survey' }));
    ps.forEach((p) => { const k = curKey(p); const d = k && stageDef(p, k); if (d && p.engineer === u.id && (d.roles || []).includes('tech_engineer') && !['survey'].includes(k)) items.push({ icon: '🛠', title: d.label + ' · ' + p.id, sub: cust(p.customerId).name + ' · ' + st(p, k).status, due: st(p, k).due, act: () => CRM.go('projects', p.id, k), label: 'Update' }); });
    ps.forEach((p) => (p.tasks || []).filter((t) => t.assignee === u.id && !['Completed', 'Approved', 'Accepted', 'Submitted for Inspection'].includes(t.status)).forEach((t) => items.push({ icon: t.kind === 'Rework' ? '↺' : '☑', title: t.title, sub: p.id + ' · ' + t.status, due: t.due, act: () => CRM.go('projects', p.id), label: 'Open' })));
    items.sort((a, b) => ((a.due || '9') > (b.due || '9') ? 1 : -1));
    el.appendChild(ui.hero(CRM.role(), [items.length + ' field tasks', items.filter((i) => isPast(i.due)).length + ' overdue', ps.length + ' assigned projects']));
    const phone = h('div', { class: 'phone' }, h('div', { class: 'phone-screen' }, [
      h('div', { style: 'padding:14px 16px;background:var(--power-black);color:#fff;border-bottom:4px solid var(--maruthi-red)' }, [h('div', { style: 'font-weight:700' }, 'Field tasks · ' + fmt.date(T0)), h('div', { class: 'small', style: 'opacity:.85' }, u.name + ' · mobile view')]),
      h('div', { style: 'padding:10px;display:flex;flex-direction:column;gap:8px' }, items.length ? items.slice(0, 10).map((it) => h('div', { class: 'card', style: 'padding:12px;display:flex;gap:10px;align-items:center' }, [h('div', { style: 'font-size:22px' }, it.icon), h('div', { style: 'flex:1;min-width:0' }, [h('div', { style: 'font-weight:600;font-size:13px' }, it.title), h('div', { class: 'small muted' }, it.sub), h('div', { class: 'small', style: 'color:' + (isPast(it.due) ? 'var(--bad)' : 'var(--text-3)') }, 'Due ' + fmt.date(it.due) + (isPast(it.due) ? ' · overdue' : ''))]), ui.btn(it.label, it.act, 'sm primary')])) : [ui.empty('No field tasks today')]),
    ]));
    el.appendChild(h('div', { class: 'grid g2' }, [phone, h('div', { class: 'stack' }, [ui.kpis([{ label: 'Surveys due', value: items.filter((i) => i.icon === '📍').length }, { label: 'Open rework', value: items.filter((i) => i.icon === '↺').length, color: 'var(--warn)' }, { label: 'Overdue', value: items.filter((i) => isPast(i.due)).length, color: 'var(--bad)' }]), ui.card('My assigned projects', projectTable(ps, { search: false, pageSize: 8, columns: projectColumns().filter((c) => !['soNumber', 'division'].includes(c.key)) }), { flush: true }), quick([['Surveys', 'surveys', 'primary'], ['Device schedule', 'device-schedule'], ['Tasks', 'install-tasks'], ['Material issue', 'material-issue']])])]));
  }
  function techHeadHome(el) {
    const ps = db.all('projects');
    const q = [];
    db.find('boqs', (b) => b.status === 'Submitted').forEach((b) => q.push({ title: 'Approve BOQ ' + b.id + ' (v' + b.version + ')', sub: b.projectId + ' · ' + fmt.lakh(boqValue(b)), link: plink(b.projectId) + '/boq', badge: 'BOQ', tone: 'warn' }));
    ps.filter(isActive).forEach((p) => workflow(p).forEach(([k, l]) => { if (st(p, k).status === 'Submitted for Inspection' && (stageDef(p, k).approval || []).includes('tech_head')) q.push({ title: 'Inspect / approve: ' + l, sub: p.id + ' · ' + cust(p.customerId).name, link: plink(p.id) + '/' + k, badge: 'Inspection', tone: 'warn' }); }));
    db.find('surveys', (s) => s.status === 'Submitted').forEach((s) => q.push({ title: 'Survey review ' + s.id, sub: s.projectId, link: '#/surveys/' + s.id, badge: 'Survey', tone: 'info' }));
    ps.filter((p) => p.status === 'On Hold' && /Technical review/.test(p.holdReason || '')).forEach((p) => q.push({ title: 'Technical review — not feasible: ' + p.id, sub: p.holdReason, link: plink(p.id), badge: 'Review', tone: 'bad' }));
    ps.filter(isActive).forEach((p) => (p.addl || []).filter((a) => a.status === 'Pending').forEach((a) => q.push({ title: 'Additional material: ' + stockName(a.stockId) + ' × ' + a.qty, sub: p.id + ' · ' + a.reason, link: plink(p.id), badge: 'Material', tone: 'info' })));
    ps.filter((p) => isActive(p) && ['cable', 'install'].includes(curKey(p)) && cableVariance(p) > 10 && !st(p, curKey(p)).varianceApproved).forEach((p) => q.push({ title: 'Cable variance +' + cableVariance(p) + '% — ' + p.id, sub: 'Additional consumption approval', link: plink(p.id) + '/' + curKey(p), badge: 'Variance', tone: 'bad' }));
    ps.filter((p) => p.kind === 'es_pending' && isActive(p)).forEach((p) => q.push({ title: 'Classify workflow ' + p.id, sub: p.systemType, link: plink(p.id), badge: 'Classify', tone: 'warn' }));
    const k = kpiData(ps);
    el.appendChild(ui.hero(CRM.role(), [q.length + ' approvals waiting', db.find('credVault', () => true).length + ' vault credentials', 'Technical approvals · inspection · commissioning']));
    el.appendChild(kpiTiles(k, ['inspection', 'boq', 'install', 'variance']));
    el.appendChild(h('div', { class: 'grid g3' }, [h('div', { class: 'span2' }, ui.card('Approval & inspection queue', actionList(q, 'No approvals pending'))), h('div', { class: 'stack' }, [quick([['Quality & rework', 'quality', 'primary'], ['BOQs', 'boqs'], ['Device vault', 'device-schedule'], ['KPIs', 'proj-kpi']]), ui.card('Open rework by stage', ui.hbars(Object.entries(util.countBy(allTasks(ps).filter((t) => t.kind === 'Rework' && !['Completed', 'Accepted'].includes(t.status)), (t) => t.stageKey)).map(([s, n]) => ({ label: s, value: n, color: 'var(--warn)' }))))])]));
  }
  function purchaseHome(el) {
    const prs = db.all('purchaseRequests'), pos = db.all('purchaseOrders');
    const open = pos.filter((p) => !['Received', 'Cancelled'].includes(p.status));
    const todo = [];
    prs.filter((r) => r.status === 'Approved').forEach((r) => todo.push({ title: 'Raise PO for ' + r.id, sub: itemsText(r.items), link: '#/purchase-requests', badge: 'PO pending', tone: 'warn' }));
    prs.filter((r) => r.status === 'Draft').forEach((r) => todo.push({ title: 'Submit PR draft ' + r.id, sub: (r.projectId || '') + ' · ' + itemsText(r.items), link: '#/purchase-requests', badge: 'Draft', tone: 'info' }));
    open.filter((p) => isPast(p.promisedDate)).forEach((p) => todo.push({ title: 'Chase ' + p.supplier + ' — ' + p.id, sub: 'Promised ' + fmt.date(p.promisedDate) + (p.delayReason ? ' · ' + p.delayReason : ''), link: '#/purchase-orders', badge: poDelay(p) + 'd late', tone: 'bad' }));
    open.filter((p) => !isPast(p.promisedDate) && util.daysBetween(T0, p.promisedDate) <= 2).forEach((p) => todo.push({ title: 'Delivery due ' + fmt.rel(p.promisedDate) + ' — ' + p.id, sub: p.supplier, link: '#/purchase-orders', badge: 'Reminder', tone: 'warn' }));
    open.filter((p) => p.status === 'Issued').forEach((p) => todo.push({ title: 'Get supplier confirmation — ' + p.id, sub: p.supplier, link: '#/purchase-orders', badge: 'Unconfirmed', tone: 'info' }));
    const short = db.all('projects').filter((p) => isActive(p) && approvedBoq(p.id) && shortages(p).length);
    el.appendChild(ui.hero(CRM.role(), [prs.filter((r) => ['Draft', 'Pending Approval'].includes(r.status)).length + ' PRs pending', open.length + ' open POs', short.length + ' projects short']));
    el.appendChild(ui.kpis([{ label: 'PRs pending approval', value: prs.filter((r) => r.status === 'Pending Approval').length, color: 'var(--warn)' }, { label: 'Approved — PO pending', value: prs.filter((r) => r.status === 'Approved').length, color: 'var(--chart-5)' }, { label: 'Supplier deliveries overdue', value: open.filter((p) => isPast(p.promisedDate)).length, color: 'var(--bad)' }, { label: 'Open PO value', value: fmt.lakh(sumBy(open, 'value')) }, { label: 'Purchase initiation time', value: kpiData().purchase.value + ' d', meta: 'PR creation − BOQ approval' }]));
    el.appendChild(h('div', { class: 'grid g3' }, [h('div', { class: 'span2' }, ui.card('Purchase follow-ups today', actionList(todo))), h('div', { class: 'stack' }, [quick([['Purchase requests', 'purchase-requests', 'primary'], ['Purchase orders', 'purchase-orders'], ['Vendor performance', 'vendor-perf'], ['Supply dashboards', 'sc-dash']]), ui.card('Shortages by project', actionList(short.map((p) => ({ title: p.id, sub: shortages(p).map((x) => stockName(x.stockId) + ' (' + x.short + ')').join(', '), link: plink(p.id) + '/procurement', badge: shortages(p).length + ' items', tone: 'bad' })), 'No shortages'))])]));
    el.appendChild(h('div', { class: 'mt' }, ui.card('Supplier on-time delivery', ui.hbars(supplierPerf().map((s) => ({ label: s.name, value: s.onTime, target: 100, text: fmt.pct(s.onTime) }))))));
  }
  function storesHome(el) {
    const grn = db.find('grns', (g) => g.status === 'Pending Inspection');
    const toDispatch = db.all('projects').filter((p) => isActive(p) && sumBy(Object.values(p.alloc || {})) > 0 && curIndex(p) >= workflow(p).findIndex((x) => x[0] === 'procurement'));
    const dcs = db.find('dcs', (d) => d.status === 'Dispatched');
    const low = db.find('stock', (s) => s.itemType === 'Regular' && s.current <= s.reorderLevel);
    const scr = db.find('scrap', (s) => s.status === 'Pending Collection');
    const todo = [];
    grn.forEach((g) => todo.push({ title: 'QC inspection — ' + g.id, sub: g.supplier + ' · ' + (g.projectId || 'stock'), link: '#/grn', badge: 'GRN', tone: 'warn' }));
    toDispatch.forEach((p) => todo.push({ title: 'Pick & dispatch — ' + p.id, sub: sumBy(Object.values(p.alloc)) + ' units reserved · ' + cust(p.customerId).name, link: plink(p.id) + '/delivery', badge: 'DC', tone: 'info' }));
    dcs.filter((d) => util.daysBetween(d.dispatchDate, T0) > 2).forEach((d) => todo.push({ title: 'Site acknowledgement pending — ' + d.id, sub: (d.projectId || d.linkId) + ' · dispatched ' + fmt.date(d.dispatchDate), link: '#/dc', badge: util.daysBetween(d.dispatchDate, T0) + 'd', tone: 'bad' }));
    db.find('grns', (g) => g.status === 'Pending Inward').forEach((g) => todo.push({ title: 'Service inward — ' + g.id, sub: g.productType + ' ' + g.brand + ' · ' + cust(g.customerId).name, link: '#/grn', badge: 'Inward', tone: 'violet' }));
    el.appendChild(ui.hero(CRM.role(), [grn.length + ' GRNs to inspect', toDispatch.length + ' dispatches ready', low.length + ' low-stock items']));
    el.appendChild(ui.kpis([{ label: 'GRN awaiting QC', value: grn.length, color: 'var(--warn)' }, { label: 'Ready to dispatch', value: toDispatch.length, color: 'var(--chart-5)' }, { label: 'DC pending confirmation', value: dcs.length, color: 'var(--bad)' }, { label: 'Low stock', value: low.length, color: 'var(--bad)', onClick: () => CRM.go('stock') }, { label: 'Scrap pending collection', value: scr.length, color: 'var(--chart-4)', onClick: () => CRM.go('scrap') }]));
    el.appendChild(h('div', { class: 'grid g3' }, [h('div', { class: 'span2' }, ui.card('Stores work queue', actionList(todo))), h('div', { class: 'stack' }, [quick([['GRN', 'grn', 'primary'], ['Delivery challans', 'dc'], ['Stock master', 'stock'], ['Material issue', 'material-issue'], ['Scrap', 'scrap']]), ui.card('Low stock', ui.hbars(low.slice(0, 8).map((s) => ({ label: s.name, value: s.current, target: s.reorderLevel, text: s.current + ' / reorder ' + s.reorderLevel }))))])]));
  }
  function installLeadHome(el) {
    const u = user();
    const ps = db.all('projects').filter((p) => isActive(p) && (p.installLead === u.id || (p.tasks || []).some((t) => t.assignee === u.id)));
    const tasks = allTasks(db.all('projects').filter(isActive));
    const mine = tasks.filter((t) => t.assignee === u.id && !['Completed', 'Approved', 'Accepted'].includes(t.status));
    const inspect = tasks.filter((t) => t.status === 'Submitted for Inspection');
    const stagesToInspect = db.all('projects').filter(isActive).flatMap((p) => workflow(p).filter(([k]) => st(p, k).status === 'Submitted for Inspection' && (stageDef(p, k).approval || []).includes('install_lead')).map(([k, l]) => ({ p, k, l })));
    el.appendChild(ui.hero(CRM.role(), [mine.length + ' tasks assigned', inspect.length + stagesToInspect.length + ' to inspect', ps.length + ' sites']));
    el.appendChild(ui.kpis([{ label: 'My open tasks', value: mine.length }, { label: 'Due today / overdue', value: mine.filter((t) => t.due <= isoD(T0)).length, color: 'var(--bad)' }, { label: 'Vendor submissions to inspect', value: inspect.length, color: 'var(--warn)' }, { label: 'Stage inspections', value: stagesToInspect.length, color: 'var(--chart-4)' }, { label: 'Open rework', value: tasks.filter((t) => t.kind === 'Rework' && !['Completed', 'Accepted'].includes(t.status)).length }]));
    const todo = mine.sort((a, b) => (a.due > b.due ? 1 : -1)).map((t) => ({ title: t.title, sub: t.projectId + ' · ' + t.customer + ' · ' + t.status, link: plink(t.projectId), badge: isPast(t.due) ? 'Overdue' : fmt.rel(t.due), tone: isPast(t.due) ? 'bad' : 'info' }))
      .concat(inspect.map((t) => ({ title: 'Inspect: ' + t.title, sub: t.projectId + ' · by ' + t.assigneeName + ' · ' + (t.evidence || ''), link: '#/install-tasks', badge: 'Inspection', tone: 'warn' })), stagesToInspect.map((x) => ({ title: 'Approve stage: ' + x.l, sub: x.p.id, link: plink(x.p.id) + '/' + x.k, badge: 'Stage', tone: 'warn' })));
    el.appendChild(h('div', { class: 'grid g3' }, [h('div', { class: 'span2' }, ui.card('Today\'s installation work', actionList(todo))), h('div', { class: 'stack' }, [quick([['Installation tasks', 'install-tasks', 'primary'], ['Device schedule', 'device-schedule'], ['Quality', 'quality']]), ui.card('Team workload (open tasks)', ui.hbars(Object.entries(util.countBy(tasks.filter((t) => !['Completed', 'Approved', 'Accepted'].includes(t.status)), 'assigneeName')).map(([k, v]) => ({ label: k, value: v }))))])]));
  }
  function vendorHome(el) {
    const list = vendorTasks();
    const open = list.filter((x) => !['Completed', 'Approved', 'Accepted'].includes(x.t.status));
    el.appendChild(ui.hero(CRM.role(), [open.length + ' open tasks', 'Assigned work only']));
    el.appendChild(ui.kpis([{ label: 'Open tasks', value: open.length }, { label: 'Due today', value: open.filter((x) => x.t.due === isoD(T0)).length, color: 'var(--warn)' }, { label: 'Overdue', value: open.filter((x) => isPast(x.t.due)).length, color: 'var(--bad)' }, { label: 'Awaiting inspection', value: list.filter((x) => x.t.status === 'Submitted for Inspection').length, color: 'var(--chart-5)' }, { label: 'Rework requested', value: open.filter((x) => x.t.kind === 'Rework' || x.t.status === 'Rework Required').length, color: 'var(--chart-4)' }, { label: 'Completed', value: list.length - open.length, color: 'var(--ok)' }]));
    el.appendChild(ui.callout('Restricted vendor view: only tasks assigned to ' + util.esc(user().name) + ' — no project costs, unrelated customers or other vendors.', 'info'));
    el.appendChild(h('div', { class: 'grid g2 mt' }, open.length ? open.sort((a, b) => (a.t.due > b.t.due ? 1 : -1)).slice(0, 8).map(vendorTaskCard) : [ui.empty('No open tasks')]));
  }

  // ------------------------------------------------------------------ automations & scans (alerts with de-dupe keys, policy checks)
  function runScans() {
    const now = new Date();
    db.all('projects').filter((x) => isActive(x) && x.kind !== 'es_pending').forEach((p0) => {
      const p = p0; const k = curKey(p); const cr = coordRoleOf(p);
      if (!p.acceptedAt && util.daysBetween(p.createdAt, T0) > 1) CRM.notify({ to: ['gm', 'odm', cr], title: 'Project not accepted / assigned beyond SLA: ' + p.id, body: cust(p.customerId).name + ' · handed over ' + fmt.date(p.createdAt), link: plink(p.id), severity: 'bad', key: 'unacc-' + p.id });
      if (k && stageOverdue(p, k)) {
        const late = daysLate(st(p, k).due);
        const owner = (stageDef(p, k).roles || [cr])[0];
        CRM.notify({ to: [owner, cr], title: 'Task overdue: ' + curLabel(p) + ' — ' + p.id, body: late + ' day(s) late · escalated to owner and coordinator', link: plink(p.id), severity: 'warn', key: 'ovd-' + p.id + '-' + k });
        if (late > 7 && !st(p, k).delayReason) raise('projects', db.get('projects', p.id), 'Project milestone overdue without recorded reason / action plan', { severity: late > 20 ? 'High' : 'Medium', details: curLabel(p) + ' overdue ' + late + ' days (due ' + fmt.date(st(p, k).due) + ')' });
      }
      const instKey = p.kind === 'solar' ? 'electrical' : p.kind === 'es_small' ? 'install' : 'cameras';
      const commKey = p.kind === 'solar' ? 'commissioning' : 'testing';
      const inst = (p.stages || {})[instKey];
      if (inst && DONE(inst) && !DONE(st(p, commKey)) && util.hoursBetween(inst.doneAt, now) > 48) raise('projects', db.get('projects', p.id), 'Commissioning certificate delay (> 48 hrs after installation)', { severity: 'Medium', policyRef: 'Installation policy 5.4', details: 'Installation completed ' + fmt.date(inst.doneAt) + '; commissioning not yet approved' });
      if (DONE(st(p, commKey)) && ['handover', 'activate'].includes(k) && util.daysBetween(st(p, commKey).doneAt, T0) > 3) CRM.notify({ to: cr, title: 'Handover incomplete: ' + p.id, body: handoverMissing(p).length + ' missing item(s) — ' + handoverMissing(p).slice(0, 3).join(', '), link: plink(p.id) + '/handover', severity: 'warn', key: 'hoi-' + p.id });
      (p.tasks || []).filter((t) => isPast(t.due) && !['Completed', 'Approved', 'Accepted'].includes(t.status)).forEach((t) => { const s = db.get('staff', t.assignee); CRM.notify({ to: [s ? s.role : 'install_lead', cr], title: 'Task overdue: ' + t.title, body: p.id + ' · due ' + fmt.date(t.due), link: s && s.role === 'vendor' ? '#/vendor-tasks' : plink(p.id), severity: 'warn', key: 'tovd-' + t.id }); });
      (p.tasks || []).filter((t) => t.due === isoD(util.addDays(T0, 1)) && !['Completed', 'Approved'].includes(t.status)).forEach((t) => { const s = db.get('staff', t.assignee); CRM.notify({ to: s ? s.role : 'install_lead', title: 'Installation task due tomorrow: ' + t.title, body: p.id, link: s && s.role === 'vendor' ? '#/vendor-tasks' : plink(p.id), severity: 'info', key: 'tdue-' + t.id }); });
    });
    db.find('surveys', (s) => s.status === 'Scheduled' && s.fields.plannedDate && new Date(s.fields.plannedDate) <= util.addDays(T0, 1)).forEach((s) => CRM.notify({ to: 'tech_engineer', title: (isPast(s.fields.plannedDate) ? 'Site visit overdue: ' : 'Site visit due: ') + s.projectId, body: sName(s.fields.engineer) + ' · ' + fmt.date(s.fields.plannedDate), link: '#/surveys/' + s.id, severity: isPast(s.fields.plannedDate) ? 'warn' : 'info', key: 'svd-' + s.id }));
    db.find('boqs', (b) => b.status === 'Submitted' && util.daysBetween(b.submittedAt, T0) > 2).forEach((b) => CRM.notify({ to: ['tech_head', 'odm'], title: 'BOQ approval overdue: ' + b.id, body: b.projectId + ' · submitted ' + fmt.date(b.submittedAt), link: plink(b.projectId) + '/boq', severity: 'warn', key: 'bao-' + b.id }));
    db.find('purchaseOrders', (po) => !['Received', 'Cancelled'].includes(po.status)).forEach((po) => {
      if (isPast(po.promisedDate)) CRM.notify({ to: ['purchase'].concat(po.projectId ? [coordRoleOf(db.get('projects', po.projectId) || {})] : []), title: 'Supplier delivery commitment missed: ' + po.id, body: po.supplier + ' · promised ' + fmt.date(po.promisedDate), link: '#/purchase-orders', severity: 'bad', key: 'pom-' + po.id });
      else if (util.daysBetween(T0, po.promisedDate) <= 2) CRM.notify({ to: 'purchase', title: 'Supplier delivery approaching: ' + po.id, body: po.supplier + ' · ' + fmt.date(po.promisedDate), link: '#/purchase-orders', severity: 'info', key: 'poa-' + po.id });
    });
    db.find('grns', (g) => g.status === 'Pending Inspection').forEach((g) => CRM.notify({ to: 'stores', title: 'Pending GRN inspection: ' + g.id, body: g.supplier, link: '#/grn', severity: 'info', key: 'gpi-' + g.id }));
    db.find('dcs', (d) => d.status === 'Dispatched').forEach((d) => {
      const age = util.daysBetween(d.dispatchDate, T0);
      if (age > 2) CRM.notify({ to: ['stores'].concat(d.projectId ? [coordRoleOf(db.get('projects', d.projectId) || {})] : []), title: 'Material dispatched but not acknowledged: ' + d.id, body: (d.projectId || d.linkId) + ' · ' + age + ' days', link: '#/dc', severity: 'warn', key: 'dcna-' + d.id });
      if (age > 4 && d.projectId) raise('dcs', db.get('dcs', d.id), 'Site material receipt not confirmed / discrepancy unresolved', { severity: 'Medium', owner: 'EMP-stores', details: d.id + ' dispatched ' + fmt.date(d.dispatchDate) + ' without site receipt confirmation' });
    });
    db.find('stock', (s) => s.itemType === 'Regular' && s.current <= s.reorderLevel).forEach((s) => CRM.notify({ to: ['stores', 'purchase'], title: (s.current <= s.minLevel ? 'Low stock (below minimum): ' : 'Reorder alert: ') + s.name, body: 'Current ' + s.current + ' · reorder level ' + s.reorderLevel, link: '#/stock', severity: s.current <= s.minLevel ? 'bad' : 'warn', key: 'low-' + s.id + '-' + s.current }));
    db.find('scrap', (s) => s.status === 'Pending Collection' && util.hoursBetween(s.createdAt, now) > 24).forEach((s) => raise('scrap', db.get('scrap', s.id), 'Scrap collection delay (> 24 hrs)', { severity: 'Low', owner: s.collectedBy, division: 'Power', policyRef: 'Installation policy 5.3', details: s.id + ' · ' + s.qty + ' × ' + s.scrapType + ' identified ' + fmt.date(s.createdAt) }));
    followups().forEach((f) => {
      if (new Date(f.date) <= T0) CRM.notify({ to: 'doc_coordinator', title: f.kind + ' follow-up due: ' + f.projectId, body: f.action, link: f.link, severity: isPast(f.date) ? 'warn' : 'info', key: 'fu-' + f.id + '-' + f.date });
      if (util.daysBetween(f.date, T0) > 2) raise(f.kind === 'Subsidy' ? 'subsidies' : 'netMetering', db.get(f.kind === 'Subsidy' ? 'subsidies' : 'netMetering', f.id), 'Net-metering or subsidy follow-up missed', { severity: 'Medium', owner: 'EMP-doc_coordinator', division: SOL, details: f.id + ' follow-up due ' + fmt.date(f.date) });
    });
  }

  // ------------------------------------------------------------------ cross-module: order.won → project, search, Customer 360, GM summary
  let booted = false, seeding = false;
  CRM.on('order.won', (payload) => {
    const o = payload && payload.order;
    if (!o || ![ESD, SOL].includes(o.division)) return;
    const dup = db.one('projects', (p) => (o.id && p.orderId === o.id) || (o.soNumber && p.soNumber === o.soNumber));
    if (dup) { if (booted) CRM.notify({ to: coordRoleOf(dup), title: 'Duplicate project prevented for SO ' + (o.soNumber || o.id), body: 'Existing ' + dup.id, link: plink(dup.id), severity: 'warn', key: 'dup-' + dup.id + '-' + (o.id || '') }); return; }
    createProject(o, booted ? { by: 'Sales handover' } : { silent: true, at: orderDate(o) || new Date() });
  });
  CRM.on('ready', () => { booted = true; try { lateSeed(); flushViolations(); runScans(); } catch (e) { console.error('[projects] scans', e); } });

  CRM.registerSearch((q) => {
    if (CRM.is('vendor')) return vendorTasks().filter((x) => (x.t.title + x.p.id).toLowerCase().includes(q)).slice(0, 5).map((x) => ({ label: x.t.title, sub: 'My task · ' + x.p.id, link: '#/vendor-tasks' }));
    const out = [];
    const canP = CRM.canSee('projects');
    if (canP) db.all('projects').filter((p) => (p.id + ' ' + p.soNumber + ' ' + cust(p.customerId).name).toLowerCase().includes(q)).slice(0, 6).forEach((p) => out.push({ label: p.id + ' · ' + cust(p.customerId).name, sub: KIND[p.kind] + ' · ' + curLabel(p) + ' · SO ' + p.soNumber, link: plink(p.id) }));
    [['purchaseRequests', 'purchase-requests', 'Purchase request'], ['purchaseOrders', 'purchase-orders', 'Purchase order'], ['grns', 'grn', 'GRN'], ['dcs', 'dc', 'Delivery challan'], ['scrap', 'scrap', 'Scrap'], ['surveys', 'surveys', 'Site survey'], ['netMetering', 'net-metering', 'Net metering'], ['subsidies', 'subsidy', 'Subsidy']].forEach(([col, page, label]) => {
      if (!CRM.canSee(page)) return;
      db.all(col).filter((r) => (r.id + ' ' + (r.supplier || '') + ' ' + (r.projectId || '') + ' ' + (r.serial || '')).toLowerCase().includes(q)).slice(0, 3).forEach((r) => out.push({ label: r.id, sub: label + (r.projectId ? ' · ' + r.projectId : '') + (r.status ? ' · ' + r.status : ''), link: '#/' + page + (['surveys', 'net-metering', 'subsidy'].includes(page) ? '/' + r.id : '') }));
    });
    if (CRM.canSee('stock')) db.all('stock').filter((s) => (s.code + ' ' + s.name).toLowerCase().includes(q)).slice(0, 3).forEach((s) => out.push({ label: s.name, sub: 'Stock · ' + s.code + ' · ' + s.current + ' ' + s.unit, link: '#/stock' }));
    return out;
  });
  CRM.registerCustomerSection((c) => {
    const ps = db.find('projects', (p) => p.customerId === c.id);
    if (!ps.length) return null;
    return { title: 'Installation projects', summary: ps.length + ' project(s) · ' + ps.filter(isActive).length + ' active', flush: true, body: () => ui.table({ search: false, rows: ps.map(viewRow), onRow: (p) => CRM.go('projects', p.id), columns: projectColumns({ value: true }).filter((c2) => c2.key !== 'customerName') }) };
  });
  CRM.projects = {
    summary() {
      const act = db.all('projects').filter(isActive);
      return {
        active: act.length, large: act.filter((p) => p.kind === 'es_large').length, small: act.filter((p) => p.kind === 'es_small').length, solar: act.filter((p) => p.kind === 'solar').length,
        overdue: act.filter(projOverdue).length, materialShort: act.filter((p) => approvedBoq(p.id) && shortages(p).length).length, handoverPending: act.filter((p) => ['handover', 'activate'].includes(curKey(p))).length,
        byStage: PHASES.map((x) => ({ label: x[0], value: act.filter((p) => phaseOf(p) === x[0]).length })),
      };
    },
    kpis: () => kpiData(),
  };

  // ------------------------------------------------------------------ page registry
  const P = (id, title, icon, section, order, roles, render, badge) => CRM.registerPage({ id, title, icon, section, order, roles, render, badge });
  const PJ = ['es_coordinator', 'solar_coordinator', 'tech_engineer', 'tech_head', 'install_lead'];
  P('proj-dash', 'Installation Dashboard', '▦', 'Projects', 30, ['es_coordinator', 'tech_head', 'install_lead', 'tech_engineer'].concat(MG), renderESDash);
  P('projects', 'Projects & Jobs', '🏗', 'Projects', 31, PJ.concat(['doc_coordinator', 'purchase', 'stores'], MG), renderProjects, () => myProjects().filter(projOverdue).length);
  P('solar-dash', 'Solar Execution', '☀', 'Projects', 32, ['solar_coordinator', 'doc_coordinator', 'tech_head'].concat(MG), renderSolarDash);
  P('surveys', 'Site Surveys', '📍', 'Projects', 33, ['es_coordinator', 'solar_coordinator', 'tech_engineer', 'tech_head'].concat(MG), renderSurveys, () => (CRM.is('tech_engineer') ? db.find('surveys', (s) => s.fields.engineer === user().id && s.status === 'Scheduled').length : db.find('surveys', (s) => s.status === 'Submitted').length));
  P('boqs', 'BOQ & Approvals', '📋', 'Projects', 34, ['es_coordinator', 'solar_coordinator', 'tech_engineer', 'tech_head', 'purchase'].concat(MG), renderBoqs, () => (CRM.is('tech_head') ? db.find('boqs', (b) => b.status === 'Submitted').length : 0));
  P('install-tasks', 'Installation Tasks', '🛠', 'Projects', 35, PJ.concat(MG), renderTasks);
  P('device-schedule', 'Device Schedule & Vault', '📷', 'Projects', 36, ['es_coordinator', 'tech_engineer', 'tech_head', 'install_lead'].concat(MG), renderDevices);
  P('quality', 'Inspection & Rework', '✔', 'Projects', 37, PJ.concat(MG), renderQuality);
  P('handover', 'Handover & Closure', '🤝', 'Projects', 38, ['es_coordinator', 'solar_coordinator', 'doc_coordinator', 'tech_head'].concat(MG), renderHandover);
  P('proj-compliance', 'Project Compliance', '⚑', 'Projects', 39, ['es_coordinator', 'solar_coordinator', 'tech_head'].concat(MG), renderCompliance);
  P('proj-kpi', 'Project KPIs', '◔', 'Projects', 40, ['es_coordinator', 'solar_coordinator', 'tech_head'].concat(MG), renderKpis);
  P('proj-reports', 'Project Reports', '🗎', 'Projects', 41, ['es_coordinator', 'solar_coordinator', 'doc_coordinator', 'tech_head', 'purchase'].concat(MG), renderReports);
  P('vendor-tasks', 'My Assigned Tasks', '☑', 'Projects', 42, ['vendor'], renderVendorTasks, () => vendorTasks().filter((x) => !['Completed', 'Approved', 'Accepted'].includes(x.t.status)).length);
  P('sc-dash', 'Supply Dashboards', '▤', 'Supply Chain', 45, ['purchase', 'stores', 'es_coordinator', 'solar_coordinator'].concat(MG), renderSCDash);
  P('stock', 'Stock Master', '📦', 'Supply Chain', 46, ['purchase', 'stores', 'es_coordinator', 'solar_coordinator', 'tech_engineer', 'tech_head'].concat(MG), renderStock);
  P('purchase-requests', 'Purchase Requests', '📝', 'Supply Chain', 47, ['purchase', 'stores', 'es_coordinator', 'solar_coordinator', 'tech_head'].concat(MG), renderPRs, () => (CRM.is('gm') ? db.find('purchaseRequests', (r) => r.status === 'Pending Approval').length : CRM.is('purchase') ? db.find('purchaseRequests', (r) => ['Draft', 'Approved'].includes(r.status)).length : 0));
  P('purchase-orders', 'Purchase Orders', '🧾', 'Supply Chain', 48, ['purchase', 'stores'].concat(MG), renderPOs, () => db.find('purchaseOrders', (po) => !['Received', 'Cancelled'].includes(po.status) && isPast(po.promisedDate)).length);
  P('grn', 'GRN (Inward)', '📥', 'Supply Chain', 49, ['stores', 'purchase', 'service_coordinator', 'service_engineer'].concat(MG), renderGRN, () => (CRM.is('stores') ? db.find('grns', (g) => ['Pending Inspection', 'Pending Inward'].includes(g.status)).length : 0));
  P('dc', 'Delivery Challans', '🚚', 'Supply Chain', 50, ['stores', 'purchase', 'es_coordinator', 'solar_coordinator', 'install_lead', 'accounts'].concat(MG), renderDC);
  P('material-issue', 'Material Issue & Returns', '⇄', 'Supply Chain', 51, ['stores', 'es_coordinator', 'solar_coordinator', 'tech_engineer', 'service_engineer'].concat(MG), renderIssue);
  P('scrap', 'Scrap', '♻', 'Supply Chain', 52, ['stores', 'service_coordinator', 'service_engineer', 'install_lead'].concat(MG), renderScrap);
  P('vendor-perf', 'Vendor Performance', '★', 'Supply Chain', 53, ['purchase', 'es_coordinator', 'solar_coordinator', 'tech_head'].concat(MG), renderVendorPerf);
  P('project-material', 'Project Material', '🧱', 'Supply Chain', 54, ['purchase', 'stores', 'es_coordinator', 'solar_coordinator', 'tech_engineer'].concat(MG), renderProjectMaterial);
  P('net-metering', 'Net Metering', '⚡', 'Solar Compliance', 55, ['doc_coordinator', 'solar_coordinator'].concat(MG), renderNM);
  P('subsidy', 'Subsidy Tracker', '₹', 'Solar Compliance', 56, ['doc_coordinator', 'solar_coordinator'].concat(MG), renderSubsidy);
  P('compliance-followups', 'Compliance Follow-ups', '⏰', 'Solar Compliance', 57, ['doc_coordinator', 'solar_coordinator'].concat(MG), renderFollowups, () => (CRM.is('doc_coordinator') ? followups().filter((f) => new Date(f.date) <= T0).length : 0));

  CRM.registerHome('es_coordinator', (el) => coordHome(el, ESD));
  CRM.registerHome('solar_coordinator', (el) => coordHome(el, SOL));
  CRM.registerHome('doc_coordinator', docHome);
  CRM.registerHome('tech_engineer', engineerHome);
  CRM.registerHome('tech_head', techHeadHome);
  CRM.registerHome('purchase', purchaseHome);
  CRM.registerHome('stores', storesHome);
  CRM.registerHome('install_lead', installLeadHome);
  CRM.registerHome('vendor', vendorHome);

  // ------------------------------------------------------------------ seed data
  const [S0, S1, S2, S3, S4, S5, S6, S7] = SUPPLIERS;
  const STOCK_SEED = [
    // name, division, category, brand, unit, model, qty, cost, reorder, min, vendor
    ['IP Dome Camera 4MP', ESD, 'CCTV', 'Hikvision', 'Nos', 'Regular', 230, 3000, 40, 20, S0], ['IP Bullet Camera 4MP', ESD, 'CCTV', 'Hikvision', 'Nos', 'Regular', 170, 3300, 40, 20, S0], ['PTZ Camera 2MP 25x', ESD, 'CCTV', 'Hikvision', 'Nos', 'Order-Based', 0, 27000, 0, 0, S0],
    ['NVR 16 Channel', ESD, 'CCTV', 'Hikvision', 'Nos', 'Regular', 18, 10400, 6, 3, S0], ['NVR 32 Channel', ESD, 'CCTV', 'Hikvision', 'Nos', 'Regular', 7, 18700, 3, 1, S0], ['PoE Switch 16 Port', ESD, 'Network', 'D-Link', 'Nos', 'Regular', 16, 8500, 6, 3, S2], ['Surveillance HDD 4TB', ESD, 'Recording', 'Seagate', 'Nos', 'Regular', 34, 6600, 12, 6, S0],
    ['Biometric Attendance Terminal', ESD, 'Biometric', 'eSSL', 'Nos', 'Regular', 14, 7000, 5, 2, S1], ['Access Controller 2-Door', ESD, 'Access Control', 'ZKTeco', 'Nos', 'Regular', 9, 11900, 4, 2, S1], ['Video Door Phone 7"', ESD, 'Video Door Phone', 'CP Plus', 'Nos', 'Regular', 10, 9000, 4, 2, S1], ['PA Amplifier 240W', ESD, 'PA System', 'Ahuja', 'Nos', 'Regular', 4, 15100, 2, 1, S1], ['Fire Alarm Panel 4 Zone', ESD, 'Fire Alarm', 'Ravel', 'Nos', 'Regular', 5, 13300, 2, 1, S1], ['Smoke Detector', ESD, 'Fire Alarm', 'Ravel', 'Nos', 'Regular', 120, 790, 40, 20, S1],
    ['Cat6 UTP Cable (m)', ESD, 'Cabling', 'Polycab', 'm', 'Regular', 14000, 22, 2500, 1200, S3], ['PVC Conduit 25mm (m)', ESD, 'Infrastructure', 'Precision', 'm', 'Regular', 9000, 18, 1500, 800, S3], ['RJ45 Connectors (pkt of 100)', ESD, 'Infrastructure', 'D-Link', 'pkt', 'Regular', 40, 650, 10, 5, S2], ['Junction Box', ESD, 'Mounting', 'Hikvision', 'Nos', 'Regular', 420, 160, 100, 50, S0],
    ['6U Network Rack', ESD, 'Mounting', 'Netrack', 'Nos', 'Regular', 9, 4200, 3, 1, S2], ['Online UPS 1KVA (rack)', ESD, 'Power', 'Maruthi', 'Nos', 'Regular', 8, 13500, 2, 1, S7], ['24" LED Monitor', ESD, 'Display', 'LG', 'Nos', 'Regular', 12, 7600, 4, 2, S2], ['ANPR Special Camera', ESD, 'CCTV', 'Hikvision', 'Nos', 'Order-Based', 0, 52000, 0, 0, S0],
    ['Mono PERC Panel 540W', SOL, 'Modules', 'Waaree', 'Nos', 'Regular', 300, 10400, 80, 40, S4], ['Solar Inverter 5kW Grid-tie', SOL, 'Inverter', 'Sungrow', 'Nos', 'Regular', 12, 44600, 4, 2, S5], ['GI Mounting Structure (per kWp)', SOL, 'Mounting structure', 'Kovai Steel', 'kWp', 'Order-Based', 0, 5200, 0, 0, S6],
    ['Solar DC Cable 4 sq.mm (m)', SOL, 'DC cabling', 'Polycab', 'm', 'Regular', 4200, 48, 1000, 500, S3], ['AC Cable 6 sq.mm (m)', SOL, 'AC cabling & protection', 'Polycab', 'm', 'Regular', 1600, 85, 400, 200, S3], ['ACDB/DCDB Set', SOL, 'AC cabling & protection', 'Havells', 'Set', 'Regular', 14, 7800, 5, 2, S3], ['Earthing Kit', SOL, 'Earthing & lightning protection', 'JMV', 'Set', 'Regular', 45, 2100, 15, 8, S3], ['Lightning Arrester', SOL, 'Earthing & lightning protection', 'JMV', 'Nos', 'Regular', 12, 3400, 5, 2, S3], ['Monitoring Wi-Fi Dongle', SOL, 'Monitoring', 'Sungrow', 'Nos', 'Regular', 18, 2600, 6, 3, S5], ['Lithium Battery 5kWh', SOL, 'Battery', 'Exide', 'Nos', 'Order-Based', 0, 98000, 0, 0, S7],
    ['Maruthi Inverter 900VA', 'Power', 'Inverter', 'Maruthi', 'Nos', 'Regular', 35, 5600, 12, 6, S7], ['Maruthi Inverter 1.5KVA', 'Power', 'Inverter', 'Maruthi', 'Nos', 'Regular', 22, 8300, 10, 5, S7], ['Maruthi Inverter 3KVA', 'Power', 'Inverter', 'Maruthi', 'Nos', 'Regular', 6, 17600, 8, 4, S7], ['Maruthi Online UPS 1KVA', 'Power', 'Online UPS', 'Maruthi', 'Nos', 'Regular', 14, 13300, 6, 3, S7], ['Maruthi Online UPS 3KVA', 'Power', 'Online UPS', 'Maruthi', 'Nos', 'Regular', 7, 30200, 4, 2, S7], ['Maruthi Online UPS 10KVA', 'Power', 'Online UPS', 'Maruthi', 'Nos', 'Regular', 2, 97000, 2, 1, S7], ['Maruthi Online UPS 60KVA', 'Power', 'Online UPS', 'Maruthi', 'Nos', 'Order-Based', 0, 497000, 0, 0, S7],
    ['Maruthi Servo Stabilizer 10KVA', 'Power', 'Servo Stabilizer', 'Maruthi', 'Nos', 'Regular', 5, 27400, 3, 1, S7], ['Exide 150Ah Tubular', 'Power', 'Battery', 'Exide', 'Nos', 'Regular', 48, 11200, 20, 10, S7], ['SF Sonic 100Ah', 'Power', 'Battery', 'SF Sonic', 'Nos', 'Regular', 9, 7300, 15, 8, S7], ['Exide SMF 26Ah', 'Power', 'Battery', 'Exide', 'Nos', 'Regular', 70, 3450, 30, 15, S7], ['Battery Trolley', 'Power', 'Accessories', 'Maruthi', 'Nos', 'Regular', 25, 900, 10, 5, S7], ['MS Stand', 'Power', 'Accessories', 'Maruthi', 'Nos', 'Regular', 4, 650, 10, 5, S7],
  ];
  const SERIALIZED = ['CCTV', 'Inverter', 'Online UPS', 'Battery', 'Modules'];
  function seedStock() {
    const pfx = { [ESD]: 'ES', [SOL]: 'SL', Power: 'PW' }; const n = { ES: 0, SL: 0, PW: 0 };
    STOCK_SEED.forEach(([name, division, category, brand, unit, itemType, qty, cost, reorder, min, vendor]) => {
      const pr = master.products().find((x) => x.name === name);
      const code = pfx[division] + '-' + String(++n[pfx[division]]).padStart(3, '0');
      const nonMove = ['Access Controller 2-Door', 'PA Amplifier 240W', 'Maruthi Online UPS 10KVA', 'ANPR Special Camera'].includes(name);
      db.insert('stock', { code, name, productId: pr ? pr.id : null, division, category, brand, model: name.replace(brand, '').replace(/^Maruthi\s*/, '').trim().slice(0, 24), unit, itemType, serialized: SERIALIZED.includes(category), opening: qty + util.rand(0, Math.ceil(qty * 0.2)), current: qty, reorderLevel: reorder, minLevel: min, purchaseCost: cost, sellingPrice: pr ? pr.price : Math.round(cost * 1.38), vendor, locations: { 'Main Warehouse': qty, 'Service Centre': division === 'Power' ? util.rand(0, 3) : 0, 'Engineer Stock': 0, 'Project Site': 0 }, lastMovedAt: util.addDays(T0, nonMove ? -util.rand(100, 160) : -util.rand(1, 40)).toISOString(), issued90: nonMove ? 0 : util.rand(2, 40) * (unit === 'm' ? 50 : 1), movements: [{ ts: util.addDays(T0, -180).toISOString(), type: 'Opening balance (Tally sync)', qty, ref: 'TALLY-OB' }], eng: {} }, { silent: true, prefix: 'STK' });
    });
  }
  const SAMPLE = { team: 'Senthil A + 3 technicians', teamLeader: 'Senthil A · Ravi, Kumar, Mohan', cablePlan: 'Floor-wise PVC trunking; perimeter runs in GI conduit', nvrPlan: 'Rack in server room on UPS-backed supply', cameraPlan: 'Perimeter cameras first, then indoor zones', testPlan: 'Channel-wise live view, playback and remote test', toolsSafety: 'Ladders, harness, PPE, drilling kit, cable tester', route: 'Ground floor + first floor + perimeter', endpointMap: 'CAB-01..NN ↔ CAM-01..NN ↔ NVR-1 CH01..', photos: 'DMS/IMG-2026-', completedBy: 'Installation team (Senthil A)', inspectedBy: 'Balaji T', nvrModel: 'Hikvision DS-7732NI · 32 ch', hdd: '4 × 4TB', network: '192.168.10.0/24 · GW .1 · static IPs reserved', report: 'COMM-RPT-', responsible: 'Assigned team / vendor', testRecords: 'IR, earth-resistance & polarity test sheet', acceptedBy: 'Customer site in-charge', evidence: 'HO-ACK-', trainer: 'Suresh B', vendorContact: 'Green Rays Contractors · 97xxxxxx12', dependencies: 'None open', delayPlan: '', outstanding: '', defects: '', remarks: 'All channels tested OK', policyNote: 'Straightforward residential job — policy permits', progressNote: 'On plan', siteVisit: 'Yes' };
  function sampleFor(fd, p, at) {
    if (fd.type === 'date') return isoD(at);
    if (fd.type === 'number') return ({ plannedLength: cableBase(p), actualLength: Math.round(cableBase(p) * (0.93 + Math.random() * 0.12)), retention: 30, punchOpen: 0 })[fd.key] || 1;
    if (fd.type === 'select') return fd.key === 'testResult' ? 'Pass' : fd.key === 'gridStatus' ? 'Synchronized with net meter' : fd.key === 'closureType' ? 'Administrative (full) closure' : fd.key === 'remote' ? 'Vendor P2P cloud (approved)' : fd.options[0].value || fd.options[0];
    const v = SAMPLE[fd.key];
    if (v === undefined) return 'Recorded';
    return /-$/.test(v) ? v + util.rand(1000, 9999) : v || (fd.required ? 'Recorded' : '');
  }
  const cableBase = (p) => (p.cameraCount || (p.devices || []).length || 4) * 40;
  function fillFields(p, k, at, ratio) {
    const d = stageDef(p, k), f = st(p, k).fields;
    (d.fields || []).forEach((fd, i) => { if (!yes(f[fd.key]) && (ratio == null || i / (d.fields.length) < ratio)) f[fd.key] = sampleFor(fd, p, at); });
    if (f.acceptedBy === SAMPLE.acceptedBy) f.acceptedBy = cust(p.customerId).contact || SAMPLE.acceptedBy;
  }
  const APPROVER = { tech_head: 'Balaji T', install_lead: 'Senthil A', es_coordinator: 'Vignesh M', solar_coordinator: 'Prakash V' };
  function seedComplete(p, k, start, end) {
    const d = stageDef(p, k), s = st(p, k);
    s.startedAt = start.toISOString();
    if (d.checklist) s.done = d.checklist.map((x, i) => i);
    if (d.docs) s.docsDone = d.docs.map((x, i) => i);
    fillFields(p, k, end);
    if (d.approval) { s.submittedAt = util.addHours(end, -20).toISOString(); s.approvedBy = APPROVER[d.approval[0]]; s.approvedAt = end.toISOString(); }
    completeStage(p, k, { at: end, silent: true, by: d.approval ? APPROVER[d.approval[0]] : sName(p.engineer) });
  }
  function seedPartial(p, k, start, ratio) {
    const d = stageDef(p, k), s = st(p, k);
    s.status = 'In Progress'; s.startedAt = start.toISOString();
    if (d.checklist) s.done = d.checklist.map((x, i) => i).filter((i) => i / d.checklist.length < ratio);
    if (d.docs) s.docsDone = d.docs.map((x, i) => i).filter((i) => i / d.docs.length < ratio * 0.8);
    fillFields(p, k, start, ratio);
  }
  function seedRework(p, k, at, open) {
    const s = st(p, k); s.reworkCount = (s.reworkCount || 0) + 1;
    const owner = ['cable', 'civil', 'mechanical', 'electrical', 'install'].includes(k) ? (p.vendorId && p.installMode === 'Vendor' ? p.vendorId : p.installLead) : p.engineer;
    addTask(p, { kind: 'Rework', stageKey: k, title: 'Rework — ' + stageDef(p, k).label + ': ' + util.pick(['failed continuity test on 2 runs', 'camera focus / FOV not as approved', 'labelling incomplete', 'earthing resistance above limit', 'loose fasteners on 3 module rows', 'recording schedule not as scope']), assignee: owner, due: isoD(util.addDays(at, 3)), status: open ? 'In Progress' : 'Completed', doneAt: open ? null : util.addDays(at, 2).toISOString() }, { at, silent: true });
  }
  const sync = (p) => { commit(p, 'seed', { silent: true }); return getP(p.id); };
  function seedProcure(p, start, end, partialMode) {
    const o = (at, by) => ({ at, silent: true, by });
    p = getP(p.id); reserve(p, o(start, 'Murugan S')); p = sync(p);
    if (!shortages(p).length) return p;
    const prAt = util.addHours(start, util.rand(4, 30));
    const pr = prFromShortage(p, o(prAt, 'Gopi K'));
    if (!pr) return p;
    if (partialMode === 'draft') return getP(p.id);
    db.update('purchaseRequests', pr.id, { status: 'Pending Approval', submittedAt: util.addHours(prAt, 1).toISOString() }, { silent: true });
    if (partialMode === 'pr') return getP(p.id);
    db.update('purchaseRequests', pr.id, { status: 'Approved', approver: 'S. Maruthi', approvedAt: util.addHours(prAt, 8).toISOString() }, { silent: true });
    const poAt = util.addDays(prAt, 1);
    const sup = (stockItem(pr.items[0].stockId) || {}).vendor || S0;
    const promised = util.addDays(poAt, util.rand(3, 7));
    const po = createPO(db.get('purchaseRequests', pr.id), SUPPLIERS.includes(sup) ? sup : S0, isoD(promised), util.pick(['30 days credit', '45 days credit', 'Advance']), { at: poAt, silent: true, rateFactor: 0.96 + Math.random() * 0.1 });
    if (partialMode === 'po') { if (Math.random() < 0.6) db.update('purchaseOrders', po.id, { status: 'Supplier Confirmed', confirmedAt: util.addDays(poAt, 1).toISOString(), supplierRef: 'SO/' + util.rand(10000, 99999) }, { silent: true }); if (isPast(promised) && Math.random() < 0.5) db.update('purchaseOrders', po.id, { delayReason: util.pick(['Supplier stock-out at depot', 'Transport strike', 'Factory dispatch delayed']) }, { silent: true }); return getP(p.id); }
    db.update('purchaseOrders', po.id, { status: 'Supplier Confirmed', confirmedAt: util.addDays(poAt, 1).toISOString(), supplierRef: 'SO/' + util.rand(10000, 99999) }, { silent: true });
    let recvAt = util.addDays(promised, util.rand(-1, 3));
    if (end && recvAt > util.addHours(end, -14)) recvAt = util.addHours(end, -14);
    if (recvAt < util.addHours(poAt, 12)) recvAt = util.addHours(poAt, 12);
    const rej = Math.random() < 0.18 ? 1 : 0;
    const lines = db.get('purchaseOrders', po.id).items.map((i, ix) => ({ stockId: i.stockId, received: i.qty, accepted: i.qty - (ix === 0 ? rej : 0), rejected: ix === 0 ? rej : 0, damaged: ix === 0 ? rej : 0, pending: 0 }));
    const g = receiveGRN(db.get('purchaseOrders', po.id), lines, { warehouse: 'Main Warehouse', invoice: 'INV/' + util.rand(1000, 9999) }, o(recvAt, 'Murugan S'));
    if (partialMode === 'grn') return getP(p.id);
    inspectGRN(db.get('grns', g.id), true, o(util.addHours(recvAt, 5), 'Murugan S'));
    p = getP(p.id);
    reserve(p, o(util.addHours(recvAt, 6), 'Murugan S')); p = sync(p);
    // any residual (e.g. rejected on GRN) is covered by a replacement receipt
    shortages(p).forEach((x) => { moveStock(x.stockId, x.short, 'GRN inward (replacement)', g.id, o(util.addHours(recvAt, 30))); p.alloc[x.stockId] = (p.alloc[x.stockId] || 0) + x.short; });
    return sync(p);
  }
  function seedDelivery(p, start, end, partialMode) {
    const dc = createDC(p, { at: util.addHours(start, 6), silent: true, by: 'Murugan S' });
    p = sync(p);
    if (!dc || partialMode === 'dispatched') return p;
    const disc = partialMode === 'discrepancy';
    const receipt = {}; if (disc) receipt[dc.items[0].stockId] = { short: 0, damaged: Math.min(2, dc.items[0].qty) };
    confirmDC(db.get('dcs', dc.id), receipt, cust(p.customerId).contact || 'Site in-charge', { at: util.addHours(start, 30), silent: true, evidence: 'Signed DC + 4 photos' });
    return getP(p.id);
  }
  function seedFinish(p, k, start, end) {
    const id = p.id;
    if (k === 'scope') { st(p, k).fields.siteVisit = p.cameraCount <= 8 && Math.random() < 0.5 ? 'No — straightforward job (policy permits)' : 'Yes'; }
    if (k === 'survey') {
      const planned = util.addDays(start, 1); const late = Math.random() < 0.25;
      const actual = late ? util.addDays(planned, util.rand(1, 3)) : planned;
      const f = {}; surveyFields(p).forEach((fd) => { f[fd.key] = sampleFor(fd, p, actual); });
      Object.assign(f, { plannedDate: isoD(planned), actualDate: isoD(actual), engineer: p.engineer, feasibility: Math.random() < 0.75 ? 'Feasible' : 'Feasible with Conditions', nextOwner: p.engineer, nextAction: 'Prepare BOQ', deviceCount: p.cameraCount || (p.devices || []).length, capacity: p.capacityKw, config: p.config, systemType: p.systemType, cableLength: cableBase(p), delayReason: late ? util.pick(['Customer rescheduled visit', 'Site access not available', 'Engineer on breakdown call']) : '', observations: p.division === SOL ? 'Shadow-free south-facing roof; parapet 0.9 m' : 'Perimeter lighting adequate; IR range sufficient', locations: 'As per marked layout', equipment: p.division === SOL ? '' : 'IP dome/bullet, NVR, PoE switches' });
      const s = db.insert('surveys', { projectId: id, division: p.division, status: 'Approved', fields: f, done: surveyChecklist(p).map((x, i) => i), createdAt: start.toISOString(), submittedAt: util.addHours(end, -18).toISOString(), reviewedBy: p.division === SOL ? 'Prakash V' : 'Balaji T', reviewedAt: end.toISOString() }, { prefix: 'SRV', silent: true });
      st(p, k).surveyId = s.id; st(p, k).approvedBy = s.reviewedBy; st(p, k).approvedAt = end.toISOString();
      completeStage(p, k, { at: end, silent: true, by: s.reviewedBy }); return p;
    }
    if (k === 'boq') {
      const subAt = util.addHours(start, util.rand(10, Math.max(12, util.hoursBetween(start, end) - 8)));
      const items = boqDraftItems(p, start);
      const revise = Math.random() < 0.22;
      const v1 = db.insert('boqs', { projectId: id, division: p.division, version: 1, status: revise ? 'Superseded' : 'Approved', items, preparedBy: sName(p.engineer), createdAt: start.toISOString(), submittedAt: subAt.toISOString(), approvedBy: 'Balaji T', approvedAt: (revise ? util.addHours(subAt, 6) : end).toISOString(), surveyId: st(p, 'survey').surveyId || null }, { prefix: 'BOQ', silent: true });
      if (revise) { const it2 = clone(items); it2[0].qty += 1; db.insert('boqs', { projectId: id, division: p.division, version: 2, status: 'Approved', items: it2, preparedBy: sName(p.engineer), createdAt: util.addHours(subAt, 8).toISOString(), submittedAt: util.addHours(subAt, 10).toISOString(), approvedBy: 'Balaji T', approvedAt: end.toISOString(), revisionReason: util.pick(['Customer added one more location', 'Make substitution approved (equivalent spec)', 'Revised after site re-measurement']), prevId: v1.id, surveyId: v1.surveyId }, { prefix: 'BOQ', silent: true }); }
      const s = st(p, k); s.submittedAt = subAt.toISOString(); s.approvedBy = 'Balaji T'; s.approvedAt = end.toISOString();
      completeStage(p, k, { at: end, silent: true, by: 'Balaji T' }); return p;
    }
    if (k === 'procurement') { p = sync(p); p = seedProcure(p, start, end); seedComplete(p, k, start, end); return p; }
    if (k === 'delivery') { p = sync(p); p = seedDelivery(p, start, end); seedComplete(p, k, start, end); return p; }
    if (['cable', 'testing', 'civil', 'mechanical', 'electrical'].includes(k) && Math.random() < 0.22) seedRework(p, k, util.addDays(start, 1), false);
    if (k === 'cable' && Math.random() < 0.18) { fillFields(p, k, end); st(p, k).fields.actualLength = Math.round(cableBase(p) * 1.14); st(p, k).varianceApproved = 'Balaji T — additional perimeter routes approved'; }
    if (k === 'nvr') { p.devices.filter((d) => d.type === 'NVR').forEach((d) => { d.serial = 'HKN' + util.rand(100000, 999999); d.installed = true; d.test = 'Pass'; }); db.insert('credVault', { projectId: id, deviceId: (p.devices.find((d) => d.type === 'NVR') || {}).id, deviceTag: 'NVR-1', account: 'admin', secretRef: 'vault://mpcs-es/' + id + '/NVR-1/admin#' + util.uid(), storedBy: sName(p.engineer), createdAt: end.toISOString(), access: Math.random() < 0.4 ? [{ ts: util.addDays(end, 3).toISOString(), by: 'Balaji T', role: 'Technical Head', reason: 'Remote-view issue diagnosis' }] : [] }, { prefix: 'VLT', silent: true }); }
    if (['cameras', 'install', 'commissioning'].includes(k)) p.devices.forEach((d) => { d.installed = true; d.test = 'Pass'; if (!d.serial) d.serial = (p.division === SOL ? 'SG' : 'HK') + util.rand(10, 99) + 'A' + util.rand(100000, 999999); });
    if (k === 'compliance') { const nm = db.one('netMetering', (n) => n.projectId === id); if (nm && NM_STATUS.indexOf(nm.status) < 3) db.update('netMetering', nm.id, { status: 'Submitted' }, { silent: true }); }
    seedComplete(p, k, start, end);
    if (p.status === 'Closed') { p.used = clone(p.siteOk); const cab = stockBy('Cat6 UTP Cable (m)'); if (cab && (p.siteOk || {})[cab.id] > 40 && Math.random() < 0.5) { const r = util.rand(10, 30); p.returned[cab.id] = r; p.used[cab.id] -= r; moveStock(cab.id, r, 'Project return', id, { at: end, silent: true }); } }
    return p;
  }
  function seedCurrent(p, k, start) {
    const id = p.id; const r = Math.random();
    if (k === 'so') { if (util.daysBetween(start, T0) <= 1) { st(p, k).status = 'Not Started'; if (r < 0.5) p.engineer = null; } else seedPartial(p, k, start, 0.6); return p; }
    if (k === 'survey') {
      seedPartial(p, k, start, 0);
      const planned = util.addDays(start, util.rand(1, 3));
      const base = { projectId: id, division: p.division, createdAt: start.toISOString() };
      const filled = () => { const f = {}; surveyFields(p).forEach((fd) => { f[fd.key] = sampleFor(fd, p, planned); }); return Object.assign(f, { plannedDate: isoD(planned), actualDate: isoD(planned), engineer: p.engineer, nextOwner: p.engineer, deviceCount: p.cameraCount, capacity: p.capacityKw, delayReason: '' }); };
      if (r < 0.35) db.insert('surveys', Object.assign(base, { status: 'Scheduled', fields: { plannedDate: isoD(planned), engineer: p.engineer }, done: [] }), { prefix: 'SRV', silent: true });
      else if (r < 0.6) db.insert('surveys', Object.assign(base, { status: 'Submitted', fields: Object.assign(filled(), { feasibility: 'Feasible' }), done: surveyChecklist(p).map((x, i) => i), submittedAt: util.addDays(planned, 1).toISOString() }), { prefix: 'SRV', silent: true });
      else if (r < 0.74) { db.insert('surveys', Object.assign(base, { status: 'Not Feasible', fields: Object.assign(filled(), { feasibility: 'Not Feasible', observations: p.division === SOL ? 'Asbestos roof — structural load not acceptable' : 'No power / network path to perimeter without civil trenching' }), done: surveyChecklist(p).map((x, i) => i), submittedAt: util.addDays(planned, 1).toISOString() }), { prefix: 'SRV', silent: true }); p.status = 'On Hold'; p.holdReason = 'Technical review — site not feasible'; p.holdAt = util.addDays(planned, 1).toISOString(); }
      else if (r < 0.86) { db.insert('surveys', Object.assign({}, base, { status: 'Revisit Required', fields: Object.assign(filled(), { feasibility: 'Revisit Required', nextAction: 'Revisit with customer electrician for power path', nextDue: isoD(util.addDays(planned, 4)) }), done: surveyChecklist(p).map((x, i) => i), submittedAt: util.addDays(planned, 1).toISOString() }), { prefix: 'SRV', silent: true }); db.insert('surveys', Object.assign({}, base, { status: 'Scheduled', fields: { plannedDate: isoD(util.addDays(planned, 4)), engineer: p.engineer }, done: [], createdAt: util.addDays(planned, 1).toISOString() }), { prefix: 'SRV', silent: true }); addTask(p, { kind: 'Follow-up', stageKey: 'survey', title: 'Site revisit — complete pending survey items', assignee: p.engineer, due: isoD(util.addDays(planned, 4)) }, { at: planned, silent: true }); }
      else db.insert('surveys', Object.assign(base, { status: 'Returned for correction', returnReason: 'Cable route and recording requirement missing', fields: Object.assign(filled(), { cableRoute: '', recording: '' }), done: surveyChecklist(p).map((x, i) => i).slice(0, -3) }), { prefix: 'SRV', silent: true });
      return p;
    }
    if (k === 'boq') { seedPartial(p, k, start, 0); const sub = r < 0.6; db.insert('boqs', { projectId: id, division: p.division, version: 1, status: sub ? 'Submitted' : 'Draft', items: boqDraftItems(p, start), preparedBy: sName(p.engineer), createdAt: start.toISOString(), submittedAt: sub ? util.addDays(start, 1).toISOString() : null, surveyId: st(p, 'survey').surveyId || null }, { prefix: 'BOQ', silent: true }); if (sub) st(p, k).submittedAt = util.addDays(start, 1).toISOString(); return p; }
    if (k === 'procurement') { seedPartial(p, k, start, 0); p = sync(p); return seedProcure(p, start, null, r < 0.25 ? 'draft' : r < 0.45 ? 'pr' : r < 0.85 ? 'po' : 'grn'); }
    if (k === 'delivery') { seedPartial(p, k, start, 0.3); p = sync(p); return seedDelivery(p, start, null, r < 0.55 ? 'dispatched' : r < 0.75 ? 'discrepancy' : 'dispatched'); }
    const insp = ['cable', 'civil', 'mechanical', 'electrical', 'testing', 'commissioning', 'handover', 'activate'].includes(k) && stageDef(p, k).approval;
    if (['cameras', 'install', 'commissioning', 'testing'].includes(k)) { const frac = ['testing', 'commissioning'].includes(k) ? 1 : 0.3 + Math.random() * 0.5; p.devices.forEach((d, i) => { if (i / p.devices.length < frac) { d.installed = true; d.serial = d.serial || (p.division === SOL ? 'SG' : 'HK') + util.rand(10, 99) + 'A' + util.rand(100000, 999999); d.test = Math.random() < 0.9 ? 'Pass' : 'Pending'; } }); }
    if (insp && r < 0.35) { seedPartial(p, k, start, 1); fillFields(p, k, start); const s = st(p, k); s.status = 'Submitted for Inspection'; s.submittedAt = util.addDays(start, 1).toISOString(); (p.tasks || []).forEach((t) => { if (t.stageKey === k && t.kind === 'Installation') { t.status = 'Submitted for Inspection'; t.evidence = 'Checklist + ' + util.rand(4, 12) + ' photos'; } }); if (['testing', 'commissioning', 'cable'].includes(k)) p.devices.forEach((d) => { d.test = d.installed ? 'Pass' : d.test; }); return p; }
    if (['cable', 'civil', 'mechanical', 'electrical', 'testing', 'commissioning', 'install'].includes(k) && r < 0.6) { seedPartial(p, k, start, 0.7); st(p, k).status = 'Rework Required'; seedRework(p, k, util.addDays(start, 1), true); (p.tasks || []).forEach((t) => { if (t.stageKey === k && t.kind === 'Installation') t.status = 'Rework Required'; }); return p; }
    seedPartial(p, k, start, 0.3 + Math.random() * 0.5);
    (p.tasks || []).forEach((t) => { if (t.stageKey === k && t.kind === 'Installation') { t.status = 'In Progress'; t.startedAt = start.toISOString(); } });
    if (k === 'cable' && r > 0.85) { st(p, k).fields.plannedLength = cableBase(p); st(p, k).fields.actualLength = Math.round(cableBase(p) * 1.19); raise('projects', p, 'Cable or material consumption beyond approved limit', { at: start, severity: 'Medium', details: 'Actual ' + st(p, k).fields.actualLength + ' m vs planned ' + cableBase(p) + ' m (+19%) without approval' }); }
    return p;
  }
  function simulate(id, spec) {
    let p = getP(id);
    const ES_ENG = ['EMP-tech_engineer', (master.staff('tech_engineer', ESD).find((s) => s.division === ESD) || {}).id || 'EMP-tech_engineer'];
    const SO_ENG = ['EMP-tech_engineer', (master.staff('tech_engineer', SOL).find((s) => s.division === SOL) || {}).id || 'EMP-tech_engineer'];
    const venES = ['EMP-vendor', (master.staff('vendor').find((s) => s.division === ESD) || {}).id || 'EMP-vendor'];
    const venSO = ['EMP-vendor', (master.staff('vendor').find((s) => s.division === SOL) || {}).id || 'EMP-vendor'];
    const sol = p.division === SOL;
    p.engineer = util.pick(sol ? SO_ENG : ES_ENG);
    p.installLead = sol ? util.pick(['EMP-install_lead', (master.staff('install_lead', SOL).find((s) => s.division === SOL) || {}).id || 'EMP-install_lead']) : 'EMP-install_lead';
    p.installMode = util.pick(['Own team', 'Vendor', 'Mixed', 'Vendor', 'Mixed']);
    p.vendorId = p.installMode === 'Own team' ? null : util.pick(sol ? venSO : venES);
    const d0 = new Date(p.createdAt);
    if (p.kind === 'es_pending') {
      if (spec && spec.classifyAs || util.daysBetween(d0, T0) > 4) {
        const to = (spec && spec.classifyAs) || 'es_small';
        p.kindHistory = [{ ts: util.addHours(d0, 20).toISOString(), from: 'es_pending', to, by: 'Vignesh M', reason: to === 'es_large' ? 'Multi-zone fire alarm with networked panels — approved as complex project' : 'Standalone devices, single site — simple installation' }];
        p.kind = to; p.stages = {}; p.devices = genDevices(p); planDues(p, d0); p.history.push({ ts: util.addHours(d0, 20).toISOString(), by: 'Vignesh M', text: 'Workflow selected: ' + KIND[to] });
      } else { p.engineer = null; p.installMode = null; p.vendorId = null; return sync(p); }
    }
    const slow = util.pick([0.75, 0.9, 1, 1, 1.05, 1.15, 1.35, 1.7, 2.1]);
    const scale = p.kind === 'es_large' ? (p.cameraCount > 48 ? 1.4 : 1.15) : p.kind === 'solar' && p.capacityKw > 20 ? 1.4 : 1;
    let t = new Date(d0);
    const wf = workflow(p);
    for (let i = 0; i < wf.length; i++) {
      const k = wf[i][0];
      if (DONE(st(p, k))) continue;
      const dur = Math.max(1, Math.round(((p.kind === 'es_small' ? DUR_SMALL : DUR)[k] || 3) * scale * slow * (0.75 + Math.random() * 0.5)));
      const end = util.addDays(t, dur);
      if (end >= T0 || (spec && spec.stopAt === k)) { p = seedCurrent(p, k, t); if (stageOverdue(p, k) && Math.random() < 0.4) st(p, k).delayReason = util.pick(['Customer site not ready — revised date agreed', 'Awaiting customer power shutdown window', 'Vendor team diverted to priority site — recovery Saturday', 'Material discrepancy replacement awaited']); break; }
      p = seedFinish(p, k, t, end);
      t = end;
    }
    if (Math.random() < 0.18 && isActive(p)) { const n = util.rand(1, 2); let dt = new Date(p.committedDate); for (let i = 0; i < n; i++) { const nd = util.addDays(dt, util.rand(7, 15)); p.dateRevisions = (p.dateRevisions || []).concat({ ts: util.addDays(d0, 10 + i * 8).toISOString(), from: isoD(dt), to: isoD(nd), reason: util.pick(['Customer requested shift', 'Material delay (supplier)', 'Scope addition approved']), by: sName(p.coordinator) }); dt = nd; } p.revisedDate = isoD(dt); }
    return sync(p);
  }
  function seedCompliance(p) {
    const nm = db.one('netMetering', (n) => n.projectId === p.id), sb = db.one('subsidies', (s) => s.projectId === p.id);
    if (!nm) return;
    const wf = workflow(p); const idx = p.status === 'Closed' ? wf.length : curIndex(p); const ix = (k) => wf.findIndex((x) => x[0] === k);
    const elec = st(p, 'electrical'), comm = st(p, 'commissioning');
    const n = { consumerNo: '04' + util.rand(1000000, 9999999) + util.rand(10, 99), plannedSubmit: isoD(util.addDays(st(p, 'electrical').due, 3)), log: (nm.log || []).slice() };
    let status = 'Not Started';
    if (idx >= ix('procurement')) { status = 'Documents Pending'; n.docs = NM_DOCS.map((x, i) => i).slice(0, util.rand(2, 5)); }
    if (idx >= ix('civil')) { status = 'Ready for Submission'; n.docs = NM_DOCS.map((x, i) => i).slice(0, NM_DOCS.length - (Math.random() < 0.4 ? 1 : 0)); if (n.docs.length < NM_DOCS.length) status = 'Documents Pending'; }
    if (DONE(elec)) { status = 'Submitted'; n.docs = NM_DOCS.map((x, i) => i); const late = Math.random() < 0.3; n.actualSubmit = isoD(util.addDays(elec.doneAt, late ? util.rand(4, 9) : util.rand(0, 2))); n.refNo = 'TNPDCL/NM/' + util.rand(10000, 99999); n.ack = 'ACK-' + util.rand(100000, 999999); }
    if (DONE(comm)) status = util.pick(['Under Review', 'Additional Information Required', 'Approved', 'Meter Installation Pending', 'Under Review']);
    if (DONE(st(p, 'compliance')) && NM_STATUS.indexOf(status) < 4) status = 'Under Review';
    if (p.status === 'Closed') { status = Math.random() < 0.75 ? 'Completed' : 'Meter Installation Pending'; }
    if (['Approved', 'Meter Installation Pending', 'Completed'].includes(status)) n.outcome = 'Approved by AE/O&M after inspection';
    if (status === 'Completed') { n.meterDate = isoD(util.addDays(comm.doneAt || p.closedAt, util.rand(5, 15))); n.meterRef = 'NM-MTR-' + util.rand(100000, 999999); }
    if (status === 'Additional Information Required') { n.inspection = 'Utility requested revised SLD and inverter certificate'; n.pendingAction = 'Kavya R to upload revised SLD'; }
    if (status !== 'Completed' && status !== 'Not Started') n.nextFollowUp = isoD(util.addDays(T0, util.rand(-6, 6)));
    n.log.push({ ts: (DONE(elec) ? new Date(elec.doneAt) : new Date(p.createdAt)).toISOString(), by: 'Kavya R', text: 'Status → ' + status });
    db.update('netMetering', nm.id, Object.assign(n, { status }), { silent: true });
    if (!sb) return;
    const s = { comms: [], log: (sb.log || []).slice() };
    if (sb.scheme === SCHEMES[2]) Object.assign(s, { eligibility: 'Not Eligible', evidence: p.projectType + ' project — not eligible under residential scheme', status: 'Eligibility Check' });
    else if (idx >= ix('boq')) {
      Object.assign(s, { eligibility: 'Eligible', evidence: 'Residential rooftop ≤ 10 kW, DISCOM consumer verified', consent: 'Yes', status: 'Documents Pending', docs: SUB_DOCS.map((x, i) => i).slice(0, util.rand(2, 5)), vendorReg: 'Maruthi empanelled vendor ID TN-VND-0193' });
      if (idx >= ix('planning')) { s.status = 'Registered'; s.docs = SUB_DOCS.map((x, i) => i).slice(0, SUB_DOCS.length - 2); }
      if (DONE(comm)) { s.status = 'Application Submitted'; s.docs = SUB_DOCS.map((x, i) => i); s.appId = 'PMSG-TN-' + util.rand(100000, 999999); s.portalDate = isoD(util.addDays(comm.doneAt, util.rand(1, 4))); }
      if (p.status === 'Closed') { s.status = util.pick(['Under Verification', 'Approved', 'Disbursed', 'Additional Documents Requested']); s.inspection = 'Completed'; if (s.status === 'Disbursed') s.disbursement = 'Disbursed to customer'; else s.disbursement = 'Pending'; if (s.status === 'Additional Documents Requested') { s.addlReqDate = isoD(util.addDays(T0, -5)); s.pending = 'Geo-tagged photo re-upload'; } }
      if (s.status !== 'Disbursed') s.nextFollowUp = isoD(util.addDays(T0, util.rand(-5, 8)));
      s.comms.push({ ts: util.addDays(p.createdAt, 3).toISOString(), by: 'Kavya R', channel: 'Phone', note: 'Explained scheme eligibility and document list to customer' });
    } else s.nextFollowUp = isoD(util.addDays(T0, util.rand(0, 5)));
    s.log.push({ ts: new Date().toISOString(), by: 'Kavya R', text: 'Status → ' + (s.status || sb.status) });
    db.update('subsidies', sb.id, s, { silent: true });
  }
  function seedExtras() {
    const o = (at, by) => ({ at, silent: true, by });
    // replenishment PRs / POs for regular stock (Power, ES)
    const st1 = stockBy('SF Sonic 100Ah'), st2 = stockBy('Maruthi Inverter 3KVA'), st3 = stockBy('MS Stand'), st4 = stockBy('Exide 150Ah Tubular'), st5 = stockBy('Surveillance HDD 4TB');
    const prA = createPR({ division: 'Power', purpose: 'Sales', trigger: 'Low stock', items: [{ stockId: st1.id, qty: 25 }, { stockId: st3.id, qty: 20 }], requiredDate: isoD(util.addDays(T0, 6)) }, o(util.addDays(T0, -1), 'Gopi K'));
    const prB = createPR({ division: 'Power', purpose: 'Service', trigger: 'Low stock', items: [{ stockId: st2.id, qty: 10 }], requiredDate: isoD(util.addDays(T0, 10)) }, o(util.addDays(T0, -9), 'Gopi K'));
    db.update('purchaseRequests', prB.id, { status: 'Approved', approver: 'S. Maruthi', approvedAt: util.addDays(T0, -8).toISOString() }, { silent: true });
    const poB = createPO(db.get('purchaseRequests', prB.id), S7, isoD(util.addDays(T0, -2)), '30 days credit', o(util.addDays(T0, -7)));
    db.update('purchaseOrders', poB.id, { status: 'Supplier Confirmed', confirmedAt: util.addDays(T0, -6).toISOString(), delayReason: 'Factory dispatch delayed — revised to next week' }, { silent: true });
    [[st4, 40, -60, -52, -51], [st5, 20, -40, -33, -35], [stockBy('IP Dome Camera 4MP'), 100, -90, -84, -80]].forEach(([s, q, a, prom, rec]) => {
      const pr = createPR({ division: s.division, purpose: 'Sales', trigger: 'Low stock', items: [{ stockId: s.id, qty: q }], requiredDate: isoD(util.addDays(T0, prom)) }, o(util.addDays(T0, a), 'Gopi K'));
      db.update('purchaseRequests', pr.id, { status: 'Approved', approver: 'S. Maruthi', approvedAt: util.addDays(T0, a + 1).toISOString() }, { silent: true });
      const po = createPO(db.get('purchaseRequests', pr.id), s.vendor, isoD(util.addDays(T0, prom)), '45 days credit', o(util.addDays(T0, a + 1)));
      const g = receiveGRN(db.get('purchaseOrders', po.id), [{ stockId: s.id, received: q, accepted: q, rejected: 0, damaged: 0, pending: 0 }], { warehouse: 'Main Warehouse', invoice: 'INV/' + util.rand(1000, 9999) }, o(util.addDays(T0, rec), 'Murugan S'));
      inspectGRN(db.get('grns', g.id), true, o(util.addDays(T0, rec), 'Murugan S'));
    });
    // emergency PO raised without approval → policy violation
    const prC = createPR({ division: ESD, purpose: 'Service', trigger: 'Special order requirement', items: [{ stockId: stockBy('PoE Switch 16 Port').id, qty: 4 }], requiredDate: isoD(util.addDays(T0, -3)) }, o(util.addDays(T0, -6), 'Gopi K'));
    const poC = createPO(db.get('purchaseRequests', prC.id), S2, isoD(util.addDays(T0, 1)), 'Advance', Object.assign(o(util.addDays(T0, -5)), { exception: 'Customer breakdown — switch needed urgently' }));
    raise('purchaseOrders', db.get('purchaseOrders', poC.id), 'Procurement without the required approval', { severity: 'High', owner: 'EMP-purchase', division: ESD, at: util.addDays(T0, -5), details: poC.id + ' raised on unapproved ' + prC.id + ' — customer breakdown' });
    void prA;
    // manual adjustment pending approval, engineer stock
    db.update('stock', st3.id, { pendingAdj: { qty: -2, reason: 'Physical count mismatch vs Tally (2 stands damaged)', by: 'Murugan S', ts: util.addDays(T0, -1).toISOString() } }, { silent: true });
    const engs = master.staff('service_engineer');
    [[st4, 4, 2, 1], [stockBy('Exide SMF 26Ah'), 6, 3, 0], [stockBy('Cat6 UTP Cable (m)'), 100, 60, 20], [stockBy('Maruthi Inverter 900VA'), 2, 1, 0]].forEach(([s, iq, uq, rq], i) => {
      const e = engs[i % engs.length]; if (!e) return;
      moveStock(s.id, -iq, 'Issue to engineer ' + e.name, 'ENG-ISS-' + (100 + i), o(util.addDays(T0, -util.rand(3, 20))));
      const rec = clone(stockItem(s.id)); rec.eng = rec.eng || {}; rec.eng[e.id] = { issued: iq, used: uq, returned: rq };
      if (rq) rec.current += rq;
      rec.locations = Object.assign({}, rec.locations, { 'Engineer Stock': iq - uq - rq });
      db.update('stock', s.id, { eng: rec.eng, locations: rec.locations, current: rec.current }, { silent: true });
    });
  }
  // Records linked to service complaints are created once the service module's data exists.
  function lateSeed() {
    if (db.one('grns', (g) => g.type === 'Service GRN') || db.one('scrap', (s) => s.seeded)) return;
    const comps = db.all('complaints');
    const custs = master.customers();
    const engs = master.staff('service_engineer');
    const SGRN = [['UPS', 'Maruthi', 'Online UPS 3KVA'], ['Inverter', 'Maruthi', 'Inverter 1.5KVA'], ['Battery', 'Exide', '150Ah Tubular'], ['Stabilizer', 'Maruthi', 'Servo 10KVA'], ['UPS', 'Maruthi', 'Online UPS 10KVA'], ['Inverter', 'Maruthi', 'Inverter 900VA'], ['DVR/NVR', 'Hikvision', 'NVR 16 Channel'], ['Solar inverter', 'Sungrow', 'SG5.0RS']];
    SGRN.forEach(([type, brand, model], i) => {
      const c = comps[i * 3 % Math.max(1, comps.length)];
      const at = util.addDays(T0, -util.rand(0, 25));
      const status = SGRN_STATUS[i % SGRN_STATUS.length];
      db.insert('grns', { type: 'Service GRN', complaintId: c ? c.id : 'CMP-' + (2100 + i), customerId: c ? c.customerId : custs[i + 3].id, contact: (cust(c ? c.customerId : custs[i + 3].id)).phone, site: cust(c ? c.customerId : custs[i + 3].id).area, productType: type, brand, model, serial: brand.slice(0, 2).toUpperCase() + util.rand(100000, 999999), qty: 1, problem: util.pick(['No output on battery mode', 'Overload trip frequently', 'Not charging', 'Display dead', 'HDD not detected']), condition: i % 4 === 3 ? 'Damaged' : 'Good', accessories: i % 2 ? 'Yes — power cable, manual' : 'No', collectedBy: (engs[i % Math.max(1, engs.length)] || {}).id, receivedBy: status === 'Pending Inward' ? '' : 'Murugan S', status, createdAt: at.toISOString() }, { prefix: 'GRN', silent: true });
    });
    const SC = [['Battery replaced under warranty', 'Battery', 'Exide', 2, '150Ah', 'From Replacement'], ['Old battery taken during new sale', 'Battery', 'SF', 1, '100Ah', 'From Replacement'], ['Damaged inverter replaced', 'Inverter', 'Maruthi', 1, '1.5KVA', 'From Service'], ['Non-repairable items', 'UPS', 'Maruthi', 1, '1KVA', 'From Service'], ['Battery replaced under warranty', 'Battery', 'Exide', 4, '26Ah SMF', 'From Service'], ['Old battery taken during new sale', 'Battery', 'Exide', 2, '150Ah', 'From Replacement'], ['Damaged material from installation', 'Cable', 'Others', 30, 'Cat6 offcuts (m)', 'From Installation'], ['Damaged inverter replaced', 'Inverter', 'Maruthi', 1, '3KVA', 'From Service'], ['Non-repairable items', 'Camera', 'Others', 3, '2MP analog', 'From Installation'], ['Battery replaced under warranty', 'Battery', 'SF', 2, '100Ah', 'From Replacement'], ['Old battery taken during new sale', 'Battery', 'Exide', 1, '150Ah', 'From Replacement'], ['Battery replaced under warranty', 'Battery', 'Exide', 1, '150Ah', 'From Service']];
    SC.forEach(([trigger, scrapType, brand, qty, capacity, source], i) => {
      const c = comps[(i * 5 + 1) % Math.max(1, comps.length)];
      const status = i < 2 ? 'Pending Collection' : SCRAP_STATUS[1 + (i % 4)];
      const at = i < 2 ? util.addDays(new Date(), -util.rand(2, 4)) : util.addDays(T0, -util.rand(5, 120));
      const linkType = source === 'From Installation' ? 'Project' : trigger.includes('sale') ? 'Sale' : c ? 'Complaint' : 'OTS';
      const pid = linkType === 'Project' ? (db.all('projects').find((p) => p.status === 'Closed') || {}).id : null;
      db.insert('scrap', { seeded: true, trigger, linkType, linkId: pid || (linkType === 'Complaint' && c ? c.id : linkType === 'Sale' ? 'SO-25' + util.rand(100, 999) : 'OTS-' + util.rand(100, 999)), projectId: pid, customerId: c ? c.customerId : custs[(i * 3) % custs.length].id, location: AREAS_OF(i), scrapType, brand, qty, capacity, source, collectedBy: (engs[i % Math.max(1, engs.length)] || {}).id, storedAt: i % 3 ? 'Service Centre' : 'Warehouse', status, disposalReq: ['Sent to Vendor', 'Disposed'].includes(status) ? { mode: status === 'Sent to Vendor' ? 'Vendor return (Exide / SF)' : 'Internal disposal', by: 'Murugan S', approvedBy: 'Lakshmi N', approvedAt: util.addDays(at, 10).toISOString() } : (status === 'In Stock' && i % 2 ? { mode: 'Vendor return (Exide / SF)', by: 'Murugan S', ts: util.addDays(T0, -2).toISOString() } : null), history: [{ ts: at.toISOString(), by: 'Field engineer', text: 'Scrap identified & entered' }].concat(status !== 'Pending Collection' ? [{ ts: util.addDays(at, 1).toISOString(), by: 'Murugan S', text: 'Collected & stored' }] : []), createdAt: at.toISOString(), viol: [] }, { prefix: 'SCR', silent: true });
    });
  }
  const orderDate = (o) => o.soIssuedDate || o.wonDate || o.date || o.orderDate || o.createdAt || null;
  const AREAS_OF = (i) => master.areas[i % master.areas.length];
  CRM.registerSeed(() => {
    seeding = true;
    try {
      seedStock();
      const custs = master.customers();
      const bySeg = (segs) => custs.filter((c) => segs.includes(c.segment));
      // 1) projects for won ES / Solar Sales Orders not yet converted
      db.all('orders').filter((o) => [ESD, SOL].includes(o.division) && orderDate(o)).sort((a, b) => (orderDate(a) > orderDate(b) ? 1 : -1)).slice(-14).forEach((o) => { if (!db.one('projects', (p) => p.orderId === o.id || p.soNumber === o.soNumber)) createProject(o, { silent: true, at: orderDate(o) }); });
      const existing = db.all('projects').map((p) => p.id);
      // 2) synthetic Sales Orders to give every dashboard a realistic spread
      const specs = [];
      const LC = [20, 24, 32, 40, 48, 64, 18, 28, 36, 22, 56, 30, 26]; const SC2 = [4, 6, 8, 16, 12, 10, 16, 8, 5, 14, 9, 7]; const KW = [3, 5, 5, 10, 3, 5, 50, 10, 20, 5, 3, 6];
      for (let i = 0; i < 9; i++) specs.push({ division: ESD, systemType: 'CCTV', cameraCount: LC[i % LC.length], segs: ['Industrial', 'Healthcare', 'Institutional', 'Commercial', 'Retail', 'Government'] });
      for (let i = 0; i < 10; i++) specs.push({ division: ESD, systemType: 'CCTV', cameraCount: SC2[i % SC2.length], segs: ['Residential', 'Retail', 'Healthcare', 'Commercial'] });
      for (let i = 0; i < 9; i++) specs.push({ division: SOL, capacityKw: KW[i % KW.length], config: i % 4 === 1 ? 'Hybrid' : 'On-grid', segs: KW[i % KW.length] > 10 ? ['Industrial', 'Institutional', 'Commercial'] : ['Residential', 'Residential', 'Healthcare', 'Commercial'] });
      specs.push({ division: ESD, systemType: 'Fire Alarm', quantity: 1, classifyAs: 'es_large', segs: ['Industrial', 'Healthcare'] });
      specs.push({ division: ESD, systemType: 'Biometric', quantity: 4, classifyAs: 'es_small', segs: ['Industrial', 'Institutional'] });
      specs.push({ division: ESD, systemType: 'Access Control', quantity: 6, recent: true, segs: ['Commercial', 'Institutional'] });
      // age each order relative to its lifecycle length so that ~40% are complete and the rest spread across stages
      const LIFE = { large: 55, small: 20, solar: 70 };
      const ages = specs.map((sp, i) => { if (sp.recent) return 1; const life = sp.division === SOL ? LIFE.solar : sp.cameraCount > 16 || sp.classifyAs === 'es_large' ? LIFE.large : LIFE.small; const f = ((i * 7) % specs.length) / specs.length; return Math.max(2, Math.min(175, Math.round(life * (0.08 + f * 1.75)))); });
      const created = specs.map((sp, i) => {
        const pool = bySeg(sp.segs); const c = pool.length ? pool[i % pool.length] : util.pick(custs);
        const prodName = sp.division === SOL ? (sp.config === 'Hybrid' ? 'Hybrid Solar ' + (sp.capacityKw > 3 ? 5 : 3) + 'kW + Battery' : 'On-grid Rooftop ' + sp.capacityKw + 'kW') : sp.systemType === 'CCTV' ? 'IP Dome Camera 4MP' : null;
        const value = sp.division === SOL ? sp.capacityKw * util.rand(54000, 62000) : sp.cameraCount ? sp.cameraCount * util.rand(8200, 9800) + (sp.cameraCount > 16 ? 150000 : 18000) : util.rand(90000, 420000);
        const o = { id: null, soNumber: 'SO-25' + String(400 + i * 7 + util.rand(0, 5)).padStart(3, '0'), customerId: c.id, division: sp.division, productId: prodId(prodName), quantity: sp.quantity || 1, value, cameraCount: sp.cameraCount || 0, systemType: sp.systemType, capacityKw: sp.capacityKw, config: sp.config };
        const p = createProject(o, { silent: true, at: util.addDays(T0, -ages[i]) });
        return [p.id, sp];
      });
      existing.forEach((id) => simulate(id, {}));
      created.forEach(([id, sp]) => simulate(id, sp));
      // a cancelled and a customer-held project for realism
      const act = db.all('projects').filter((p) => isActive(p) && p.kind === 'es_small' && curIndex(p) < 4);
      if (act[0]) { const p = getP(act[0].id); p.status = 'Cancelled'; p.cancelReason = 'Customer withdrew order — budget freeze'; p.alloc = {}; p.history.push({ ts: util.addDays(T0, -6).toISOString(), by: 'Vignesh M', text: 'Cancelled: customer withdrew order' }); sync(p); }
      const held = db.all('projects').find((p) => p.status === 'Active' && p.kind === 'es_large' && curIndex(p) >= 5 && curIndex(p) <= 7);
      if (held) { const p = getP(held.id); p.status = 'On Hold'; p.holdReason = 'Customer site not ready — false ceiling work pending'; p.holdAt = util.addDays(T0, -9).toISOString(); sync(p); }
      const early = db.all('projects').find((p) => p.status === 'Active' && p.kind === 'es_large' && curKey(p) === 'cable');
      if (early) { const p = getP(early.id); st(p, 'cable').exception = 'Started before readiness — authorized by Balaji T (customer shutdown window)'; raise('projects', p, 'Installation started before required readiness approval', { severity: 'High', details: 'Cable laying started while site receipt verification was pending' }); sync(p); }
      const adm = db.all('projects').find((p) => p.status === 'Closed' && p.kind === 'es_large');
      if (adm) { const p = getP(adm.id); st(p, 'handover').exception = 'Closed by S. Maruthi — customer signature pending travel; closure plan agreed'; st(p, 'handover').fields.evidence = ''; st(p, 'handover').done = st(p, 'handover').done.slice(0, -2); raise('projects', p, 'Project closed without mandatory handover documents', { severity: 'High', at: p.closedAt, details: 'Signed acceptance missing at closure — administrative exception' }); sync(p); }
      db.all('projects').filter((p) => p.kind === 'solar').forEach(seedCompliance);
      seedExtras();
      db.all('projects').filter((p) => util.daysBetween(p.createdAt, T0) <= 2).forEach((p) => CRM.notify({ to: coordRoleOf(p), title: 'New ' + KIND[p.kind] + ' created: ' + p.id, body: cust(p.customerId).name + ' · SO ' + p.soNumber + ' — accept and assign', link: plink(p.id), severity: 'info', key: 'new-' + p.id }));
    } finally { seeding = false; }
  });
})();
