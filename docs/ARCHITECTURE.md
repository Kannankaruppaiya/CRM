# MPCS Unified CRM — Architecture & Module Contract

Single-page, dependency-free HTML/JS app. Open `index.html` directly (works from `file://`) or serve the folder statically.
Data lives in `localStorage` (`mpcs-crm-v1`) and is seeded with realistic demo data on first load. "Reset demo data" in the sidebar regenerates it.

```
index.html
assets/css/app.css            design system (tokens, light/dark, components)
assets/js/core.js             runtime: store, masters, roles, router, UI kit, charts, notifications, audit
assets/js/modules/sales.js    Sales CRM            (source: Sales.pdf)
assets/js/modules/projects.js Projects & Supply    (source: Electronic_security.pdf, Solar.pdf, Service_requirement.pdf purchase/GRN/DC/scrap)
assets/js/modules/service.js  Service, AMC, PM, ODM (source: Service_requirement.pdf, ES & Solar service/PM sections)
```

## Roles (core.js `ROLES`)
`admin, gm, odm, sales_manager, sales_coordinator, sales_exec, accounts, es_coordinator, solar_coordinator, doc_coordinator, tech_engineer, tech_head, purchase, stores, install_lead, vendor, service_coordinator, service_engineer, pm_coordinator`

The role switcher in the top bar previews each user's experience. Each role gets its own home dashboard (`CRM.registerHome`) and only the pages whose `roles` include it.
Scoping rules: a Sales Executive sees only their own leads; a Vendor sees only tasks assigned to them; Accounts sees invoices and payments.

## Shared masters (core-owned collections)
`customers` (id `CUS-1001…`, name, type, contact, phone, email, area, segment), `sites` (customerId), `products` (division, category, name, price, warrantyMonths), `staff` (role, division, area; primary user id = `EMP-<roleId>`), `notifications`, `audit`.

## Module-owned collections
| Module | Collections |
|---|---|
| sales | `enquiries`, `quotations`, `orders`, `invoices`, `payments`, `followups`, `dealers`, `upsells`, `targets`, `callLogs`, `checkins` |
| projects | `projects` (ES large/small + Solar), `surveys`, `boqs`, `purchaseRequests`, `purchaseOrders`, `grns`, `stock`, `dcs`, `scrap`, `netMetering`, `subsidies` |
| service | `assets` (installed equipment), `complaints`, `amcContracts`, `pmPlans`, `pmVisits`, `violations`, `escalations`, `feedback`, `spareRequests` |

A module reads other modules' collections but never writes them directly. Cross-module handoffs go through the event bus instead.

## Event bus contract (`CRM.emit` / `CRM.on`)
| Event | Emitted by | Payload | Listener does |
|---|---|---|---|
| `order.won` | sales | `{ order, enquiry }`, where order has `id, soNumber, customerId, division, product, productId, quantity, value, cameraCount?, systemType?, capacityKw?` | projects creates a project/job for Electronic Security and Solar. Service (Power division) creates the `assets` record plus warranty and a PM plan, because Power orders have no installation project. |
| `project.handover` | projects | `{ project, equipment:[{productId,name,serial,location,channel}] }` | service creates `assets`, activates warranty/PM and notifies the PM coordinator |
| `invoice.raised` | sales | `{ invoice }` | — (dashboards) |
| `complaint.chargeable` | service | `{ complaint, amount }` | sales/accounts may show service charges to collect |
| `violation.raise` | any | `{ division, type, policyRef, owner, severity, recordId, link, details }` | service (ODM desk) creates the `violations` record |

## Core API cheat-sheet
`CRM.db.all/get/find/one/insert/update/remove`, `CRM.nextId(prefix)`, `CRM.master.*`, `CRM.user()`, `CRM.is(...roles)`, `CRM.notify({to, title, body, link, severity, key})`,
`CRM.ui.page/card/kpis/table/form/formModal/modal/drawer/tabs/kanban/stepper/checklist/timeline/dl/badge/divTag/barChart/lineChart/donut/hbars/progress/callout/auditTrail/hero`,
`CRM.registerPage({id,title,icon,section,roles,order,render,badge})`, `CRM.registerHome(roles, fn)`, `CRM.registerSeed(fn)`, `CRM.registerSearch(fn)`, `CRM.registerCustomerSection(fn)`.
