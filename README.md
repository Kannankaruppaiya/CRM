# MPCS Unified CRM

A multi-role CRM for **Maruthi Power Control Systems**, covering the Power, Electronic Security and Solar divisions. It is built from four requirement documents: Sales, Electronic Security, Solar and Service.

## Run
Open `index.html` in a browser. There is no build step and nothing to install. You can also serve the folder:
`python3 -m http.server 8080`, then open http://localhost:8080.

Demo data is generated on first load and kept in your browser's localStorage. Use **Reset demo data** in the sidebar to start over.

### Role switcher: a demo preview, not access control
Use the **role switcher** in the top-right to see each of the 20 roles. Each role has its own dashboard, navigation and data scope.

The switcher is a **client-side demo preview**. Anyone using the page can pick any role, including Administrator. Page and record restrictions are enforced only in the browser, and **there is no server-side access control**. Before production use, put the app behind a real login and enforce roles on a backend.

## Modules
- **Sales:** enquiries, pipeline, quotations, orders, invoices and payments, follow-ups, upsell and cross-sell, dealers, targets, Sales OTS, a mobile sales view with check-in/out, and daily, weekly and monthly reports.
- **Projects & Supply Chain:** Electronic Security large projects (more than 16 cameras) and small installation jobs, the Solar project lifecycle, site survey, version-controlled BOQ, PR/PO, GRN, DC, stock and scrap, net-metering and subsidy, and the secure credential vault.
- **Service, AMC & PM:** complaints with SLA clocks, the installed equipment register, the Service Centre bench (the **Service Centre Technician** role), AMC renewals and warranty-to-AMC conversion, preventive maintenance, OTS, and the ODM policy-violation and escalation desk.
- **Executive & Management** (GM, ODM, Admin):
  - **GM cockpit.** All figures cover the financial year (Apr–Mar). One rule applies to migrated orders: they count wherever their won date falls. Pipeline value is based on open enquiries.
  - **Management Dashboard:**
    - Projects: total, ongoing, delayed, completed and stage-wise progress.
    - A project risk register (High / Medium / Low), with the reasons for each rating.
    - A policy-violation dashboard: delayed stages, non-compliance by department, engineer delays and vendor/supplier delays.
    - **Department and coordinator scores**, reduced by a penalty for each violation.
  - **DRM / WRM / MRM Reports:** consolidated daily, weekly and monthly reports, filtered by division and as-of date. They cover:
    - sales and revenue, and monthly targets vs achieved
    - project milestones, planned vs actual, and material issues
    - service and PM, SLA compliance and quality (CSAT)
    - violations, escalations and recurring blockers
    - an **action register** of pending items, with owners and recovery plans
  - **Admin console:** record counts for every collection, users and the access matrix, master data, the audit log, and the Role Design Guide (under **Help**). Only management roles get the "preview this role" shortcut.

## Platform features
- **Settings & Rules** (Admin, with some sections for GM): a single page for business rules. It covers GST by division, working hours and holidays (for business-hour SLAs), notification channels per event (in-app / e-mail / WhatsApp), enabled reports, and module rules: sales, project and service SLAs, escalation ladders, and management-report score weights and recipients. Each module registers its own section, and every change is recorded in the audit log.
- **Attachments:** you can attach files, photos (camera capture) and signatures to records, such as surveys, BOQs, inspections, handovers and service reports. Files are stored in the browser (IndexedDB, with a localStorage fallback).
- **Data Import** (Administration): a CSV importer with a downloadable template, row validation and an error report, for the collections each module registers (for example customers and products), plus Sales data migration. A full JSON export/import of all data is available under Master Data.
- **Export:** report tables export to CSV. The Management Dashboard and the DRM/WRM/MRM reports produce a branded, print-ready document that you save as PDF from the browser's print dialog.
- **Notifications & escalation:** an in-app notification bell, per-person and per-role alerts, and periodic SLA and escalation checks.

## Integrations (simulated in this build)
This is a dependency-free, browser-only build, so it does not connect to any external system. Each integration is **simulated** and labelled as such in the UI. The hook for a real connector is always the same: a **setting** in **Settings & Rules** plus an **event** on the `CRM.on(...)` bus that a backend adapter can subscribe to.

| Integration | What happens today | Hook |
|---|---|---|
| WhatsApp Business API | Messages (bilingual English + Tamil, signed "Team Maruthi") are composed and recorded on the notification as "WhatsApp (simulated)". Nothing is sent. | Settings & Rules → Notification channels (per event type, stored as `notify.channels`). The `notifications:created` event carries the channel list. |
| E-mail | Approvals, escalations and DRM/WRM/MRM distribution are recorded as "Email (simulated)". | The same channel matrix, `exec.reportRecipients` and the `report.dispatch` event (report, period, division, recipients, KPI summary). |
| Tally / Zoho (accounting & stock) | Invoices, payments and stock are kept in the CRM and exported to CSV. Stock balances are labelled as mirrored from Tally Prime, and reconciliation adjustments are logged. | The `invoice.raised` and `<collection>:created/updated` events, the CSV exports and Data Import (for loading masters and balances). |
| Telephony / IVR (CUG, landline) | The complaint and lead source (CUG number, landline, phone, WhatsApp…) is recorded by hand, and call logs are entered, not captured. | The `complaints:created` and `enquiries:created` events. A CTI adapter would create the record with its `source` field. |
| Offline mobile app | The mobile sales and engineer views are responsive web pages with check-in/out. They need a browser and keep data locally. GPS uses the browser location, with a labelled simulated fallback. | The mobile views and the `checkins` collection. A native app would sync through the same collections and events. |

## Brand
The UI follows the **Maruthi Brand Book v1.0**:
- **Logo:** the master logo files are in `assets/brand/`. They are never redrawn. The sidebar uses the reversed logo on Power Black, small screens use the compact logo, and the favicon is the power symbol.
- **Colour:** Maruthi Red `#EC000A` and Power Black `#0A0A0A`, with the Deep Red, Graphite, Steel, Alloy, Mist, Paper, Volt Yellow and Signal Green neutrals and accents. Red is used with discipline: buttons, the active state, the Power Slant and alerts.
- **Type:** Barlow, with ExtraBold Italic uppercase for headlines, and Noto Sans Tamil for Tamil. Both are bundled in `assets/fonts/`, so the brand type works offline.
- **Graphic devices:** the 16.7° Power Slant on dashboard banners, and speed bands under the logo.
- **Icons:** outline icons with a 2 px stroke and a red accent stroke.
- **Voice:** real names, short and clear messages, bilingual English + Tamil WhatsApp messages signed "Team Maruthi", and dates written as "25 Oct 2026 · 10:30 AM".

## Code layout
- `index.html`: the shell.
- `assets/js/core.js`: data store, roles, router, event bus, notifications, audit, config, files, export/import and the UI kit.
- `assets/js/modules/sales.js`, `projects.js`, `service.js` and `executive.js`: the four modules.
- `assets/css/app.css`: styles, including the light and dark themes.
- `assets/brand/` and `assets/fonts/`: brand assets.

See `docs/ARCHITECTURE.md` for the module contract and the event table.
