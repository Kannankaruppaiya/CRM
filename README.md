# MPCS Unified CRM

A multi-role CRM for **Maruthi Power Control Systems**, covering the Power, Electronic Security and Solar divisions. It is built from four requirement documents: Sales, Electronic Security, Solar and Service.

## Run
Open `index.html` in a browser. There is no build step and nothing to install. You can also serve the folder:
`python3 -m http.server 8080`, then open http://localhost:8080.

Use the **role switcher** in the top-right to experience each of the 19 roles. Each role has its own dashboard, navigation and data scope. Demo data is generated on first load and kept in your browser's localStorage. Use **Reset demo data** in the sidebar to start over.

## Modules
- **Sales:** enquiries, pipeline, quotations, orders, invoices and payments, follow-ups, upsell and cross-sell, dealers, targets, a mobile sales view, and daily, weekly and monthly reports.
- **Projects & Supply Chain:** Electronic Security large projects (more than 16 cameras) and small installation jobs, the Solar project lifecycle, net-metering and subsidy, BOQ, PR/PO, GRN, DC, stock and scrap.
- **Service, AMC & PM:** complaints with SLA clocks, the installed equipment register, AMC renewals and warranty-to-AMC conversion, preventive maintenance, and the ODM policy-violation and escalation desk.
- **Executive & Admin:** the GM cockpit, users and the access matrix, master data, the audit log, and the role design guide.

See `docs/ARCHITECTURE.md` for the module contract.
