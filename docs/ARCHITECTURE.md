# MPCS Unified CRM — Architecture & Module Contract

Single-page, dependency-free HTML/JS app. Open `index.html` directly (works from `file://`) or serve the folder statically.
Data lives in `localStorage` (`mpcs-crm-v1`, with the id counters mirrored in `mpcs-crm-v1-ids`) and is seeded with realistic demo data on first load. Attachments live in IndexedDB (`mpcs-crm-files`). "Reset demo data" in the sidebar clears all of it and regenerates the data.

> **Security note.** The role switcher in the top bar ("Demo role") is a client-side preview. Page access, data scoping and edit rights are enforced in the browser only, so they are a UX model of the required permissions and not a security boundary. A production build needs server-side authorisation, for example row-level security per role and division.

```
index.html
assets/brand/                 master logo files (never redrawn): primary, reversed, compact, mono, symbol (favicon)
assets/fonts/                 Barlow + Noto Sans Tamil (woff2, bundled for offline use) and fonts.css
assets/css/app.css            design system (tokens, light/dark, components, print)
assets/js/core.js             runtime: store, masters, roles, router, UI kit, charts, notifications, audit, config, files, exports, importer
assets/js/modules/sales.js    Sales CRM            (source: Sales.pdf)
assets/js/modules/projects.js Projects & Supply    (source: Electronic_security.pdf, Solar.pdf, Service_requirement.pdf purchase/GRN/DC/scrap)
assets/js/modules/service.js  Service, AMC, PM, ODM (source: Service_requirement.pdf, ES & Solar service/PM sections)
assets/js/modules/executive.js GM/Admin homes, Management Dashboard (`mgmt-dash`), DRM/WRM/MRM reports (`mgmt-reports`), role design guide (`roleguide`)
```
Scripts load in this order: core, sales, projects, service, executive. Modules register everything at load time. `core.boot()` runs on `DOMContentLoaded`, after every module has registered.

## Roles (core.js `ROLES`, 20 roles)
`admin, gm, odm, sales_manager, sales_coordinator, sales_exec, accounts, es_coordinator, solar_coordinator, doc_coordinator, tech_engineer, tech_head, purchase, stores, install_lead, vendor, service_coordinator, service_engineer, service_centre_tech, pm_coordinator`

`service_centre_tech` (Service Centre Technician, primary user `EMP-service_centre_tech`, "Ganesh R", division Power) is new in v2. Service registers its pages. Until then it falls back to the generic home.

The role switcher in the top bar previews each user's experience. Each role gets its own home dashboard (`CRM.registerHome`) and only the pages whose `roles` include it.
Scoping rules: a Sales Executive sees only their own leads; a Vendor sees only tasks assigned to them; Accounts sees invoices and payments.

## Shared masters (core-owned collections)
| Collection | Fields |
|---|---|
| `customers` | id `CUS-1001…`, name, type (`master.customerTypes`: New Customer, Existing Customer, Dealer, Key Customer, Key Account), **category** (Priority / Non-Priority), contact, phone, **altContact**, **altPhone**, email, area, segment, gstin, **ownerId** (sales exec staff id), since, source |
| `sites` | id `SITE-…`, customerId, name, address, area, pincode, contact, phone, access, **utility** `{ discom, consumerNo, sanctionedLoad, tariff, meterType }` (`consumerNo` and `sanctionedLoadKw` are also mirrored flat for older readers). A customer can have many sites. |
| `products` | id `PRD-…`, division, category, name, price, unit, hsn, warrantyMonths, active |
| `staff` | role, division, area, phone, email, **skills[]**, active, primary. The primary user id is `EMP-<roleId>`. |
| `notifications`, `audit`, `attachments` | see the Core API |

Editable list masters, maintained in **Master Data**: `master.areas`, `master.segments`, `master.leadSources`, `master.paymentTerms` (`[{name, days}]`) and the division descriptions. Each array keeps its identity: an edit replaces its contents in place, so references a module already holds stay valid.

## Module-owned collections
| Module | Collections |
|---|---|
| sales | `enquiries`, `quotations`, `orders`, `invoices`, `payments`, `followups`, `dealers`, `upsells`, `targets`, `callLogs`, `checkins` (+ `salesFiles` only when `CRM.files` is absent, `salesConfig` only when `CRM.config` is absent). Sales also creates core `customers` and `sites` (a new customer captured on a lead, owned by the executive) and promotes a customer from New to Existing when its first SO is approved. |
| projects | `projects` (ES large/small + Solar), `surveys`, `boqs`, `purchaseRequests`, `purchaseOrders`, `grns`, `stock`, `dcs`, `scrap`, `netMetering`, `subsidies`, `credVault` (references and access audit only, never secrets) |
| service | `assets` (installed equipment), `complaints`, `amcContracts`, `pmPlans`, `pmVisits`, `violations`, `escalations`, `feedback`, `spareRequests`, `ots`, `amcOpportunities`, `serviceConfig`. It inserts a `scrap` record only as a fallback, when no `scrap.create.requested` listener created one. |
| executive | none: it reads every collection and stores only `exec.*` config keys |

A module reads other modules' collections but never writes them directly. Cross-module handoffs go through the event bus instead.

## Event bus contract (`CRM.emit` / `CRM.on`)
### Core events
| Event | Payload | When |
|---|---|---|
| `ready` | — | after boot, before the first render |
| `db:change` | `{ col, rec, removed? }` | any non-silent insert, update or remove |
| `<col>:created` / `<col>:updated` / `<col>:removed` | record | per collection, e.g. `complaints:updated` |
| `db:sync` | `{}` | another browser tab saved, and this tab adopted its state |
| `notifications:created` | notification record | every `CRM.notify` that was stored |
| `role:changed` | role object | role switcher used |
| `config:changed` | `{ key, value }` | `CRM.config.set` |
| `masters:changed` | `{ key }` | area, segment, lead source, payment term or division description edited |
| `import:done` | `{ importer, records }` | generic Data Import committed rows |
| `tick` | `{ at }` | after the periodic tick functions ran |

### Module events
| Event | Emitted by | Payload | Listener does |
|---|---|---|---|
| `order.won` | sales | `{ order, enquiry }`, where order has `id, soNumber, customerId, division, product, productId, quantity, value, quotationId?, cameraCount?, systemType?, capacityKw?` | Projects creates a project or job for Electronic Security and Solar. It **refuses** an order (and notifies the coordinator) unless the order has both `id` and `soNumber`. It never invents a camera count: a CCTV order without `cameraCount` waits in "Awaiting classification". Service creates the `assets` record, warranty and PM plan for Power, because Power orders have no installation project. |
| `project.handover` | projects | `{ project, equipment:[{productId, name, type, serial, location, make, brand, model, tag, channel, qty, capacity, capacityKw?, warrantyStart, warrantyEnd, warrantyTerms, installDate}] }`. `project` carries `handoverAt`, `commissionedAt` and `commissioningReportNo`. Emitted once, when the project closes (operational or administrative closure). | service creates one `assets` record per row (make, model, camera tag and recording channel kept separate, capacity, install date, warranty start/end/terms from the row), creates the warranty PM plans and notifies the PM and service coordinators. It ignores a repeat for a project that already has assets. |
| `invoice.raised` | sales | `{ invoice }` | — (dashboards) |
| `complaint.chargeable` | service | `{ complaint, amount }` | sales creates the service invoice and then emits `invoice.raised` |
| `ots.created` | service | `{ ots }` (Sales OTS: more than 2 batteries) | sales queues it on the Sales OTS desk |
| `ots.converted` | sales | `{ otsId, enquiryId, execId }` (also on re-assignment) | service links the OTS to the enquiry and stores `assignedTo` |
| `ots.outcome` | sales | `{ otsId, enquiryId, status: 'Quotation Sent'\|'Negotiation'\|'Won'\|'Lost', revenue, orderId, quoteId, quoteValue, closedBy, by, reason, lostReason, at, reopened }` | service updates the OTS status and its quotation/order links |
| `violation.raise` | any | `{ division, type, policyRef, owner, severity, recordId, link, details }` plus optional `warning` (boolean, a warning rather than a violation), `silent` (no notification), `at` (ISO time of the breach) and `col` (source collection). New projects types: "Configuration / testing completed without evidence", "Unauthorized device / configuration change", "Unapproved substitution of critical equipment", "Material delay against project schedule", "Vendor delay against committed schedule", "Project budget exceeded", "BOQ change implemented without approval" | service (the ODM desk) creates the `violations` record |
| `project.installation.requested` | service | `{ complaint }`: an ES/Solar complaint with call type "Project Installation". Uses `complaint.id, division, customerId, siteId?, systemType?/productType?, cameraCount?, quantity?, capacityKw?, value?, priority?, description?, soNumber?` | projects creates one project per complaint (`project.sourceComplaintId`), with the SO number pending until it is linked in Project setup |
| `project.installation.created` | projects | `{ projectId, complaintId }` | service sets `complaint.projectId` |
| `installation.updated` | service | `{ orderId, complaintId, status ('Pending'\|'Assigned'\|'In Progress'\|'Completed'\|'Closed'), installedAt, payment {mode,status,amount,date,balance,terms}, scrapCollected, dcRef, invoiceRef }`: the Power installation call was updated | sales updates the SO: `installationStatus` (Assigned → Scheduled, In Progress, Completed), `installationCompletionDate` (from `installedAt`), `deliveredDate`, `scrapCollected` and `installationCallId`. A Completed SO never moves back. |
| `installation.completed` | service | `{ orderId, complaintId, completedAt, closedAt, payment, scrapCollected, scrapId, dcRef, invoiceRef }`: the installation call closed. Service has already re-based the warranty and PM plan on `completedAt`. | sales marks the SO installation Completed with that date. The resulting `orders:updated` is a no-op in service, so the two never loop. |
| `stock.issue.requested` | service | `{ productId, stockId, item, qty, toEngineer, complaintId, spareRequestId, division }` | projects moves the qty from the warehouse or service centre into the engineer's stock (`moveStock`) and may raise a service DC (linkType 'Complaint') |
| `stock.return.requested` | service | `{ …same, qty (returned), fromEngineer }` | projects moves it from the engineer back to the service centre |
| `stock.consumed` | service | `{ …same, engineerId }` (spare used at site) | projects consumes it from engineer stock. Service never writes `stock` and checks availability as `current - reserved`. |
| `scrap.create.requested` | service | `{ linkType: 'Installation'\|'Complaint'\|'OTS', linkId, complaintId, orderId?, otsId?, grnId?, customerId, division, scrapType, qty, brand?, capacity?, trigger, source, status, location, collectedBy, storedAt }` | projects inserts the `scrap` record synchronously. If no record exists afterwards, service inserts one itself with the projects schema. |
| `service.centre.stage` | service | `{ complaintId, grnId, stage, stageName, grnStatus }` | projects advances the Service GRN when `grnStatus` is ahead (Pending Inward → Inward Created → Under Service → Ready for Dispatch → Delivered). Service pulls the reverse direction through `grns:updated`. |
| `customer.message` | service | `{ channel, customerId, to, template, stage, text, ref }` | integration hook for WhatsApp/SMS (simulated) |
| `report.dispatch` | executive | `{ report:'DRM'\|'WRM'\|'MRM', period, from, to, division, channel, recipients:[roleIds], summary:[{metric,value}] }` | integration hook for e-mail/WhatsApp report distribution (simulated) |

### Module listeners on core events
| Listener | Event | Does |
|---|---|---|
| sales | `ready`, `db:change` (sales collections), `tick` via `registerTick` | policy scan: reminders, escalations, payment-due alerts, sales violations |
| projects | `ready` | late seed, flushes violations recorded while seeding, runs the stage/SLA scans |
| service | `ready` | automation (SLA, escalation, PM, AMC renewal) |
| service | `orders:updated` | Power SO edited by Sales: copies the installation date and scrap collection to the installation call and re-bases the warranty |
| service | `grns:updated` | Service GRN status → service-centre stage of the linked complaint |
| service | `notifications:created` | its own popup for severity `bad` (skipped when `CRM.notifyPopup` is true) |

Modules may add events. Add every new event to this table.

## Core API cheat-sheet (v1, still supported)
`CRM.db.all/get/find/one/insert/update/remove/export/import/reset`, `CRM.nextId(prefix, width?)`, `CRM.master.*`, `CRM.user()`, `CRM.role(id?)`, `CRM.is(...roles)`, `CRM.notify({to, title, body, link, severity, key})`,
`CRM.ui.page/card/kpis/table/form/formModal/modal/drawer/confirm/toast/tabs/kanban/stepper/checklist/timeline/dl/badge/badgeHtml/divTag/barChart/lineChart/donut/hbars/progress/callout/auditTrail/hero/empty/btn`,
`CRM.registerPage({id,title,icon,section,roles,order,render,badge})`, `CRM.registerHome(roles, fn)`, `CRM.registerSeed(fn)`, `CRM.registerSearch(fn)`, `CRM.registerCustomerSection(fn)`, `CRM.registerRole(r)`, `CRM.go(id, ...params)`, `CRM.refresh()`, `CRM.persist()`, `CRM.TODAY`.

---

# Core API v2

Everything below is new or changed in v2. All v1 calls keep working. Feature-detect when it is cheap to do so (`if (CRM.files) …`).

## 1. Dates and formatting
| Signature | Result |
|---|---|
| `CRM.fmt.date(v)` | `"25 Oct 2026"`. The day has no leading zero (`"5 Jun 2026"`). The month comes from a fixed array (`Sep`, never `Sept`). Empty or invalid input gives `"—"`. |
| `CRM.fmt.dateTime(v)` | `"25 Oct 2026 · 10:30 AM"` (the separator is ` · `, not `, `) |
| `CRM.fmt.time(v)` | `"10:30 AM"`, `"12:05 AM"` |
| `CRM.fmt.month(v)` | `"Oct 2026"` |
| `CRM.fmt.months` | `['Jan', …, 'Dec']` |
| `CRM.util.parseDate(v)` → `Date \| null` | `'YYYY-MM-DD'` and `'DD/MM/YYYY'` (also `-` or `.`) are **local** calendar dates. `'25 Oct 2026'`, ISO datetimes, Date objects and ms numbers are also accepted. |
| `CRM.util.addMonths(d, n)` → `Date` | clamped to month end: `addMonths('2026-10-31', 4)` → 28 Feb 2027 |
| `CRM.util.iso(d)` | `'YYYY-MM-DD'` in local time. `addDays`, `daysBetween`, `hoursBetween` and `fmt.rel` all parse through `parseDate`. |

```js
const due = CRM.util.addMonths(contract.start, 4);      // never overflows into the next month
cell.textContent = CRM.fmt.dateTime(c.createdAt);        // "25 Oct 2026 · 10:30 AM"
```
Never use `toLocaleDateString('en-IN', …)` or `Date#setMonth` for display or arithmetic.

## 2. Safe callouts
| Signature | Behaviour |
|---|---|
| `ui.callout(text, tone)` | **Escapes**: the string is set as text, so `<b>` shows literally. Pass a DOM `Node` to append it as-is. |
| `ui.calloutHtml(html, tone)` (same as `ui.callout(html, tone, { html: true })`) | For trusted module markup. It is still sanitised: only `b, strong, i, em, u, br, code, small, p, ul, ol, li, span[class], div[class], a[href]` are kept, and only `#…`, `http(s):`, `mailto:` and `tel:` links. Any other tag or attribute is shown as literal text. |
| `ui.sanitize(html, rich?)` → `DocumentFragment` | the same sanitiser, for other places that need inline markup |

Always pass user data through `CRM.util.esc()` before you concatenate it into `calloutHtml`.
```js
ui.callout('Cancelled: ' + c.cancelReason, 'bad');                                  // user text: plain callout
ui.calloutHtml('<b>On hold:</b> ' + util.esc(p.holdReason), 'warn');               // trusted markup + escaped data
```

### Migration notes for module agents (callout call sites that pass markup)
These call sites pass `<b>`, `<br>` or `<a>` markup into `ui.callout` and must switch to `ui.calloutHtml`. Without the switch the tags render as literal text. Line numbers refer to the files at the start of the v2 work (git `HEAD` before this pass).

| File:line (HEAD) | Starts with |
|---|---|
| sales.js:841 | `'<b>' + util.esc(dup.name) + '</b> (' + dup.id + ') in the customer master…` |
| sales.js:848 | `'<b>' + open.id + '</b> for ' + util.esc(open.accountName)…` |
| sales.js:950 | `'<b>Lead assignment automation:</b> …` |
| sales.js:984 | `'<b>' + b.type + ' (' + b.ref + ')</b> — ' + util.esc(b.details)…` |
| sales.js:1104 | `'Approve or send back each quotation. Approval auto-sets the <b>Quote Given Date</b>…` |
| sales.js:1197 | `'<b>Sent back by Sales Manager:</b> ' + util.esc(q.approvalRemarks…` |
| sales.js:1274 | `'Awaiting <b>Sales Manager approval</b>…` |
| sales.js:1275 | `'<b>SO rejected:</b> ' + util.esc(o.approvalRemarks…` |
| sales.js:1629 | `'The phone app is used by Sales Executives. Switch role to <b>Sales Executive</b>…` |
| sales.js:1780 | `'<b>' + records.length + '</b> rows read · columns: '…` |
| sales.js:1781 | `'Imported ' + ok.length + ' records. ' + (… '<a href=…')` |
| sales.js:1784 | `'Expected columns: <b>' + imp.header.join(', ') + '</b>…` |
| sales.js:1844 | `'<b>Payment-due alerts:</b> '…` |
| projects.js:796 | `'<b>On hold:</b> ' + util.esc(p.holdReason…` |
| projects.js:798 | `'<b>Scope changed</b> — a revised BOQ…` |
| projects.js:829 | `'<b>' + util.esc(curLabel(p)) + '</b> overdue by '…` |
| projects.js:833 | `'Policy violation: <b>' + util.esc(v.type) + '</b>…` |
| projects.js:873 | `'<b>Gate:</b> ' + util.esc(g)` |
| projects.js:884 | `'Original committed date is frozen at … Use <b>Project setup</b>…` |
| projects.js:885 | `'Cable variance: <b>' + cableVariance(p) + '%</b>…` |
| projects.js:915 | `'Material site receipt is not fully verified…` (contains `<b>`) |
| projects.js:993 | `'Approved camera count is now <b>' + q.cameraCount + '</b>…` |
| projects.js:1236 | `'<b>Discrepancy exception:</b> ' + … '<br>Resolved: '…` |
| projects.js:1281 | `'Device passwords, recovery codes and network secrets are <b>never</b>…` |
| projects.js:1293 | `'This job now has <b>' + q.cameraCount + ' cameras</b>…` |
| projects.js:1543 | `'<b>Restricted.</b> Device credentials…` |
| projects.js:1691 | `'As an external vendor you see only tasks assigned to <b>' + util.esc(user().name)…` |
| service.js:1082 | `'<b>Repeat complaint</b> — … <a href="#/complaints/' + rep.id + '">…` |
| service.js:1083 | `'<b>Safety-critical</b> — dedicated priority & escalation policy…` |
| service.js:1084 | `'Division ' + … + ' + call type <b>Project Installation</b>…` |
| service.js:1777 | `'AMC contract <a href="#/amc/' + contract.id + '">…` (the second callout on that line; the `'Lost — ' + o.lostReason` callout stays a plain callout) |
| service.js:1813 | `'Renewal opportunity <a href="#/amc/' + opp.id + '">…` |
| service.js:2224 | `'<b>' + div + ' ' + per + '</b> · period from '…` |

executive.js has no markup callouts. The XSS sites service.js:1302 (`cancelReason`) and service.js:1520 (`instructions`) pass user text, so they must stay **plain** `ui.callout`, which now escapes them.

## 3. Notifications (per user)
```js
CRM.notify({ to, toUser, title, body, link, severity, key, event, channel }) → record | null (duplicate key)
```
- `to`: role id, array of role ids, or `'mgmt'` (admin, gm, odm).
- `toUser`: staff id (or array of ids). When set, **only those users** see the notification, whatever their role. Without `toUser`, every user of a `to` role sees it.
- `link`: hash link (`'#/enquiries/ENQ-0001'`). If no recipient role can open the page, core drops the link. On click, core checks `canSee` again and shows "cannot open that page" instead of navigating.
- `event`: the channel-config event type (`general, assignment, approval, sla, escalation, payment, renewal, customer`, or one registered with `CRM.registerNotifyEvent`). It decides the in-app/email/WhatsApp channels, which are simulated; the result is stored in `channel` (e.g. `"In-app · Email (simulated)"`).
- A notification for the current user also shows a pop-up toast.
- `CRM.myNotifications()` returns the current user's list, newest first. Read state is kept per user id.
- `CRM.canSee(pageId, roleId?)` → boolean. `'home'` is always true.

```js
CRM.notify({ to: 'sales_exec', toUser: e.execId, title: 'Lead ' + e.id + ' assigned to you', link: '#/enquiries/' + e.id, key: 'assign:' + e.id, event: 'assignment' });
CRM.registerNotifyEvent({ id: 'amc.renewal', label: 'AMC renewal reminders', defaults: { inapp: true, email: true, whatsapp: true } });
```
Module-registered notify events so far: `mgmt.report` (executive: DRM/WRM/MRM report dispatch). Sales registers its reports as `sales-<id>` through `CRM.registerReport` and checks `CRM.config.reportEnabled(id)`; executive registers the DRM/WRM/MRM periods the same way.

## 4. Config store and the "Settings & Rules" page (`#/settings`)
```js
CRM.config.get(key, fallback)     // stored → registered default → fallback. Returns a copy.
CRM.config.set(key, value, note?) // persists, audits ('config'), emits config:changed
CRM.config.defaults({ 'sales.sla': {...} })     // register defaults for your keys (never overwrites)
CRM.config.gstRate(division)      // number, from 'gst.<Division>'
CRM.config.channelsFor(eventId)   // { inapp, email, whatsapp }
CRM.config.reportEnabled(reportId), CRM.config.defaultPeriod()
CRM.registerConfigSection({ id, title, roles = ['admin','gm'], order = 50, render(container, { config, refresh }) })
CRM.registerReport({ id, title, group })   // lists the report under Settings › Report configuration (enable/disable)
```
Settings page roles = admin + gm + every role named by a registered section. Each section is shown only to its own `roles`. Built-in core keys:

| Key | Default | Section |
|---|---|---|
| `gst.Power`, `gst.Electronic Security`, `gst.Solar` | 18, 18, 12 | GST rates |
| `workHours` | `{ days: [1,2,3,4,5,6], start: '09:30', end: '18:30' }` (0 = Sunday) | Working hours & holidays |
| `holidays` | `['2026-01-01', '2026-01-15', …]` (YYYY-MM-DD strings) | " |
| `holidayNames` | `{ 'YYYY-MM-DD': 'Pongal', … }` | " |
| `sla.businessHours` | `true`: modules should run SLA clocks in working hours | " |
| `channels.<eventId>` | per-event defaults (see `NOTIFY_EVENTS`) | Notification channels |
| `reports.enabled` | `{}` (missing = enabled) | Report configuration |
| `reports.defaultPeriod` | `'This month'` | " |

Projects keys: `projects.stageDays`, `projects.criticalStages`, `projects.acceptSlaDays`, `projects.prInitDays`, `projects.escalation`, `projects.checklists`, `projects.nmFlows`, `projects.subFlows`, `projects.kpiTargets`, `projects.kpiExclude`, `projects.boqMatrix`, `projects.autoPR`, `projects.budget`, `projects.closure`, `projects.warranty`, `projects.engineerSkills`. Service also reads `channels.amcRenewal` and `channels.warrantyExpiry`. These are customer-facing channel lists (an **array** such as `['Email', 'WhatsApp', 'SMS']`), not the `{inapp,email,whatsapp}` object that core uses for its own event ids, and service edits them in its own section.
Other module keys reported so far: sales `sales.sla`, `sales.escalation`, `sales.paymentEscalation`, `sales.reminders`, `sales.discount`, `sales.otsIncentive` (section `sales-rules`); service sections `service-sla`, `service-escalation`; executive `exec.violationPenalty` (1.5), `exec.coordinatorPenalty` (2), `exec.scoreWindowDays` (90), `exec.riskDays` (7), `exec.reportRecipients` (`['gm','odm']`), and it also reads `channels.report.dispatch` and `service.pmGraceDays`. Prefix your keys with your module name.

## 5. Business hours
```js
CRM.util.addBusinessHours(start, hours) → Date        // skips non-working days, out-of-hours time and holidays
CRM.util.businessHoursBetween(a, b) → number (hours)  // decimal, negative if b < a
CRM.util.pausedMs(intervals, { now?, businessHours? }) → ms
//   intervals: [{from,to}] | [{start,end}] | [[from,to]]; an open interval (no `to`) runs until `now`; overlaps are merged
```
```js
const due = CRM.config.get('sla.businessHours') ? CRM.util.addBusinessHours(c.createdAt, 4) : CRM.util.addHours(c.createdAt, 4);
const paused = CRM.util.pausedMs(c.pauses /* [{from,to}] while Waiting for customer/spares */, { businessHours: true });
```
If no working day is configured, `addBusinessHours` falls back to clock hours.

## 6. Periodic ticks
```js
CRM.registerTick(fn, everyMs = 60000)   // fn({ now, db, util, fmt, master }); minimum 5 s
CRM.runTicks()                          // force all ticks now (tests); also runs when the tab becomes visible
```
The scheduler checks every 5 s while the app is open. After ticks run, the bell and nav badges refresh; the page itself is **not** re-rendered. `CRM.TODAY` moves forward at midnight.

## 7. Attachments
```js
CRM.files.add(fileOrDataUrl, { recordType, recordId, label, name?, viewRoles?, note? }) → Promise<attachment>
CRM.files.list(recordType, recordId, { allVersions? }) → [attachment]   // default: latest version per label
CRM.files.versions(recordType, recordId, label) → [attachment]
CRM.files.has(recordType, recordId, label?) → boolean                 // e.g. closure gates: "photo proof attached"
CRM.files.get(id) → Promise<dataUrl>        // audited ('view'); rejects for roles outside viewRoles (MGMT always allowed)
CRM.files.open(id)                          // preview dialog + download link
CRM.files.remove(id) → Promise
CRM.files.usage() → { bytes, count, limit }
```
- Each file is limited to 1.5 MB, and all attachments together to 25 MB. When a limit is hit, the call rejects with a clear message, and `ui.attachments` shows it as a toast.
- Content goes to IndexedDB, falling back to localStorage with a 2 MB cap. Metadata goes to the `attachments` collection: `{ id ATT-…, recordType, recordId, label, version, name, type, size, storage, viewRoles, uploadedBy, uploadedByName, uploadedRole, createdAt }`.
- Uploading with an existing label (case-insensitive) creates v2, v3 and so on. Older versions stay listed under "History".

```js
card.appendChild(CRM.ui.attachments('projects', p.id, { roles: ['es_coordinator', 'install_lead'], labels: ['Signed handover', 'Test report', 'Site photo'] }));
// opts: { roles: uploadRoles (default: all but vendor), viewRoles, labels: suggestions, title, readOnly, accept, onChange(list) }

const photo = CRM.ui.photoCapture({ label: '📷 Before photo' });          // input accept=image/* capture=environment, auto-compressed JPEG
const sig = CRM.ui.signaturePad({ label: 'Customer signature' });          // canvas + typed-name fallback
// on save:
if (sig.isEmpty()) return ui.toast('Customer signature is required', 'bad'), false;
CRM.files.add(photo.getValue(), { recordType: 'complaints', recordId: c.id, label: 'Before photo' });
CRM.files.add(sig.getValue(), { recordType: 'complaints', recordId: c.id, label: 'Customer signature' });
```
`photoCapture` → element with `getValue()` (data URL or '') and `clear()`. `signaturePad` → element with `getValue()` (PNG data URL or ''), `isEmpty()`, `clear()` and `typedName()`.

## 8. Exports
```js
CRM.exportCsv(filename, rows, columns?)   // columns: ['key', …] | [{ key, label, value(row) }]; UTF-8 BOM; =,+,-,@ prefixed with ' (formula-injection safe); audited
CRM.exportPdf(title, htmlOrNode, { sub? })// branded print document in a hidden iframe → browser print dialog → "Save as PDF"; audited
ui.table({ …, exportName: 'grn-pending.csv' })   // adds a "⇩ CSV" button that exports the filtered, sorted rows (column render → text, or column.exportValue(row))
```
```js
CRM.exportPdf('Gantt — ' + p.id, document.querySelector('#gantt'), { sub: cust.name });
```

## 9. Masters and admin
- **Users & Access** (`#/users`, admin): add and **edit** users (role, division, area, phone, email, skills, active). The primary demo user of a role keeps its role and cannot be deactivated.
- **Master Data** (`#/masters/<tab>`, admin): Products (add/edit/activate), Sites (add/edit, many per customer), Areas, Segments, Lead sources, Payment terms, Divisions (descriptions), and a JSON backup export/import.
- **Customer master** (`#/customer360`): category, Key Account type, alternate contact, owner. GSTIN, phone and email are validated. The duplicate check (name, phone or GSTIN) also runs on edit and excludes the record itself. Sites can be added and edited, and the page has a documents card.
- `CRM.canEditCustomer(customer?, roleId?)`: `CUSTOMER_EDIT_ROLES = admin, gm, sales_manager, sales_coordinator, service_coordinator`. A `sales_exec` may create customers (they become the `ownerId`) and edit only customers they own.
- `CRM.master.nextCustomerId()` returns the next `CUS-1xxx` id.
- Lookup helpers: `CRM.master.paymentTermDays(name)`, `master.paymentTermNames()`, `master.customerCategory(c)` and `master.division(id)` (`{ id, name, color, description }`).
- `CRM.validate.phone(v) / email(v) / gstin(v) / pincode(v)` → boolean; `CRM.validate.messages[kind]`.
- `ui.form` fields accept `format: 'phone'|'email'|'gstin'|'pincode'` and `validate(value, values) → errorText|null`. Errors show under the field with `aria-invalid`.

## 10. Data import (`#/dataimport/<importerId>`)
```js
CRM.registerImporter({
  id: 'sales-orders', title: 'Sales orders', collection: 'orders', prefix: 'ORD', roles: ['admin', 'sales_manager'],
  description: 'Historic sales orders',
  columns: [ { key: 'soNumber', label: 'SO Number', required: true, aliases: ['SO No'] },
             { key: 'date', label: 'Order Date', type: 'date' },      // DD/MM/YYYY, YYYY-MM-DD, 25 Oct 2026 → 'YYYY-MM-DD'
             { key: 'value', label: 'Value', type: 'number' },        // strips ₹ and commas
             { key: 'division', label: 'Division', type: 'enum', options: ['Power', 'Electronic Security', 'Solar'] } ],
             // other types: 'text' (default), 'phone', 'email', 'gstin', 'bool'
  map(row, ctx) { return { ...row, approval: 'Approved' }; },  // or { error: 'why' } or { skip: 'why' }; ctx.batch = records accepted so far
  dedupe(rec, ctx) { return CRM.db.one('orders', (o) => o.soNumber === rec.soNumber) ? 'SO already exists' : null; },
  beforeInsert(rec) { /* may set rec.id; return value is passed to onInserted */ },
  onInserted(rec, extra) {}, after(records) {},
  sample: [['MPCS/SO/0001', '25/10/2026', '125000', 'Power']],
});
```
The page offers: choose an importer, download a template, upload or paste CSV, validate and preview (Ready, Error, Duplicate or Skipped per row), import the valid rows, and download an error report CSV. The page roles are admin plus the union of the importer roles. Core registers the `customers` and `products` importers.

### Module-provided APIs (read-only helpers)
- `CRM.projects.stageInfo(projectOrId)` → `{ stageKey, stageLabel, step, totalSteps, pct, status }`. Also `CRM.projects.docStatus(p)`, `.risk(p)`, `.cost(p)`, and `.summary()`, which returns `{ total, completed, atRisk, highRisk, byStatus, … }`.
- `CRM.sales.summary()`, `CRM.service.summary()` (used by executive.js).
- `CRM.notifyPopup === true`: core already shows a toast for every new notification addressed to the current user, so modules should not add their own toast.

## 11. UI kit and accessibility (all automatic)
- Modals and drawers have `role="dialog"`, `aria-modal` and `aria-labelledby`. Focus moves into the dialog, Tab is trapped, Escape closes it, and focus returns to the opener. `opts.onClose` is supported.
- Keyboard access:
  - Clickable table rows, sortable headers (with `aria-sort`), clickable KPIs, notifications and kanban cards respond to Enter and Space.
  - Kanban cards with `onMove` get a **Move ▸** menu (`ui.menu(anchor, items)`).
  - Tabs follow the ARIA tablist pattern and move with the arrow keys.
- Toasts use `aria-live`, and error toasts use `role=alert`.
- Search and filter inputs, and the role switcher, have accessible names. Charts are `role="img"` with an `aria-label` summary; pass `opts.label` to override it.
- `ui.keyActivate(el, fn, label)` makes any element keyboard-operable.
- `ui.table` options: `caption`, `exportName`, `column.sortable:false`, `column.exportValue`. `ui.btn(label, fn, cls, attrs)` accepts extra attributes such as `aria-label`.

## 12. Storage robustness
- Writes are debounced (150 ms) and flushed on `pagehide`. Reset and import set a suspend flag, so a reload never writes the old state back.
- Quota or blocked storage shows a persistent red **"Changes are not being saved"** banner with an export button.
- **Multi-tab:** the `storage` event adopts the other tab's state, and re-renders, or shows a "Refresh view" banner while a dialog or field is in use. Id counters are re-read from `mpcs-crm-v1-ids` before every `nextId`. A reset in one tab reloads the others.
- `db.insert` throws on an explicit duplicate `id`. Generated ids skip any id that already exists.
- `db.import(obj)` validates the file. If storage is full it throws and leaves the current data unchanged.
- `CRM.audit(action, col, id, note)` adds a custom audit entry. Actions in use: `create`, `update`, `delete`, `view`, `denied`, `config`, `import`, `export`.
