# LabPulse — Functional Requirements Compliance

Every line of the client's functional requirements, where LabPulse implements it, and the automated test that proves it. Status as of 21 Oct 2026: **all requirements implemented; 77 automated checks pass** (`npm test`).

"Verify on deployment" marks features whose logic is tested against fakes of Google services but which call real Google Docs, Drive, Gmail or phone GPS only once deployed.

## 1A. Authentication & Role Management

| Requirement | Where | Proved by |
|---|---|---|
| Domain lock: only @karunya.edu / @karunya.edu.in | `Auth.context` (`src/Auth.js`), `APP.ALLOWED_DOMAINS` | AT-01; pipeline: every action rejects an outside account |
| Profile: name, roll no. / employee ID, Karunya email, mobile | `Auth.register` (mobile stored encrypted) | FR-02 test; registration UI test; validation test |
| RBAC — Student: scan QR, GPS check-in/out, live counter, visit reason, request bookings, borrowing history | `ROUTES` (`src/Api.js`); student pages Home, Equipment, My projects, My history | AT-02, AT-05, AT-06; UI tests |
| RBAC — Faculty: live roster, verify attendance, export session logs | `Monitoring.roster`, `Attendance.review`, `Reports.exportRange` / `sessionLogPdf` | FR-27, AT-13, missing-list test |
| RBAC — Lab In-charge / Staff: activity stream, live occupancy, inventory add/edit/remove, issue/return handshake | Live page; `inventorySave` / `inventoryRemove` open to staff **and** coordinator | Lifecycle test; coordinator/staff inventory test |
| RBAC — Super Admin: GPS coordinates, radius, hours, role permissions, audit logs | Settings, People, Audit pages; `Settings.saveLab`, `savePermissionOverrides` | FR-35, FR-36, AT-11 |
| Roles enforced on the server for every request | One route table + `Auth.require` | Pipeline: every action × every role checked against the table |

## 1B. Location-Verified Attendance Engine

| Requirement | Where | Proved by |
|---|---|---|
| Dynamic time-based QR on a lab monitor, rotating every 5–10 s | `Token.js`, `Monitor.html` (rotation is a setting, validated 5–10) | FR-17, AT-15; monitor UI test |
| Haversine geofence, 15–20 m | `Geo.haversine` / `Geo.evaluate`; radius validated 15–20 | AT-02, Red-outside test |
| Entry reason — Lab course: code, name, session hours | Timetable list, or a form with exactly those fields if not listed | FR-09, unlisted-course tests |
| Entry reason — Event: name, coordinator, expected duration | Same | Unlisted-event test |
| Entry reason — Research: purpose, specific hardware | Purpose + hardware chips from the lab's own catalog | Catalog-chips tests |
| Live counter: +1 on verified sign-in, −1 on sign-out, on all dashboards | `Attendance.occupancy` (verified only) + pending shown separately; pill in every page's top bar and on the monitor | AT-13, AT-05 |

## 1C. Hardware Asset & Booking Management

| Requirement | Where | Proved by |
|---|---|---|
| Catalog: GPU nodes (RTX 4090 / A100), IoT (ESP32, Raspberry Pi, LoRaWAN), sensors (ultrasonic, thermal, LiDAR, gas) | `ASSET_CATALOG`, seed data; also lab PCs, 3D printers, drones | Lifecycle and turnover tests |
| Public availability catalog for students | Student **Equipment** page: Available / Reserved / Issued / In use, no borrower details | Catalog UI test; public-list test |
| Reservation gating: active CHECKED_IN status to request equipment | Walk-in requests **and** time-slot reservations require a verified check-in (admin may allow advance booking as a setting) | AT-06, Proposal C gating test |
| Staff handshake to approve checkout and mark returns | Live page → Handshake panel; reserved sessions started only for checked-in students | Handshake UI test; booking start test |
| Overdue tracking and automated reminders | `Assets.overdueCheck` (hourly trigger), email reminders | AT-08 |

## 2. Security & Anti-Spoofing

| Requirement | Where | Proved by |
|---|---|---|
| TOTP-style tokens, invalidated on first scan in CacheService | `Token`, `Attendance.claim` | AT-03 (expired, forged, reused) |
| LockService during check-ins | `withLock_` around every write | FR-11, AT-04 |
| Impossible-travel velocity: flag and block | `Geo.evaluate` (flag → Amber, block → Red) | FR-12 test |
| Mock location: reject emulated GPS | Mock flag → Red | Mock-location test |
| Privacy: store only `is_valid_geofence` + timestamp, discard lat/lng | Coordinates never written or logged | AT-12 (searches every sheet) |
| Append-only audit of manual entries, role changes, inventory overrides | `Audit.log`; Audit page with filters | AT-11, AT-15, role tests |

## 3. Analytics & Reporting

| Requirement | Where | Proved by |
|---|---|---|
| Daily digest: unique visits, peak occupancy hours, hourly distribution, pending/unreturned items | `Reports.daily`; hourly chart + table on Reports and Live pages | AT-09, peak-hours test |
| Monthly audit: course-wise student-hours, GPU utilisation, sensor turnover | `Reports.monthly` | AT-09, GPU/sensor test |
| Custom start–end date range | Reports → Date range; CSV/Excel export by range | Export tests |
| PDF from a Google Docs template, saved to Drive | `Reports.toPdf` | Pipeline: template filled, no placeholders left, temp copy trashed (verify on deployment) |
| CSV / Excel for ERP import | `Reports.exportRange` (flat table, fixed columns, ISO dates) | Excel export test (verify on deployment) |
| Daily EOD email to the Lab In-charge via GmailApp | `jobDailyDigest` | Pipeline: sent once after closing, PDF attached (verify on deployment) |

## 4. Platform & Technology

| Requirement | Where | Proved by |
|---|---|---|
| 100% Google Apps Script & Workspace, zero server cost | Everything in `src/` | — |
| V8 runtime, doGet / doPost | `src/appsscript.json`, `doGet`, `doPost` | doGet and doPost tests |
| HtmlService single-page app (HTML5, Tailwind, JS) | `Index.html`, `Client.html`, `Styles.html`, `Monitor.html` | 15 UI tests |
| Google Sheets with programmatic indexing | `Db.js`: batched reads, locked writes, in-memory indexes by ID/email, unique-ID enforcement | All suites |
| DriveApp, DocumentApp, GmailApp | Reports, backups, reminders | Pipeline tests (verify on deployment) |
| PropertiesService for geofence limits and constants | `Settings.js` (`LABS_JSON`, `APP_SETTINGS`, secrets) | FR-35 |

## How "no broken pipes" is checked

`tests/routes.js` calls **every server action as every kind of user** (student, faculty, staff, coordinator, HOD, admin, unregistered, outsider). It fails on any crash, any wrong permission, or any refusal without a message. It also checks:

- every button in the UI has a handler;
- every server call the UI makes exists on the server;
- the PDF, email, backup, archive and trigger paths run end to end against fakes of Google Docs, Drive and triggers.
