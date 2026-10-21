# LabPulse

Lab attendance, live monitoring, equipment booking and usage records for the **Intel Unnati IoT Lab**, designed to roll out to every lab in the department. It is built entirely on Google Apps Script, Google Sheets and Google Workspace, so it has no server cost.

It answers the department's questions:
- **Who is in the lab right now**, on which system, working on which project? (viewable from home)
- **How long has a student used the lab?** Search by register number: days, hours, projects.
- **Who has used a particular system**, for how long, and for what?
- **Who is missing** from today's regular lab session?
- **Is the 3D printer, drone or GPU node free?** If not, students reserve a slot or join the queue.

## Roles

| Role | Can do |
|---|---|
| Student | Scan the lab QR to check in or out (GPS-verified), see their own hours, manage projects with timeline and outcome, reserve equipment slots, request items |
| Faculty | Session roster (present, pending review, missing), confirm flagged check-ins, mark attendance, export; emailed the missing list after each session |
| Lab staff | Lab monitor, equipment handover and return, start and finish reserved sessions, manual entries |
| Coordinator | Everything staff can do, plus add and remove facilities and students, courses and events, lookups and reports |
| HOD | Read-only view of every lab: live usage, systems, projects, lookups, reports |
| Super Admin | Roles and permissions, lab location, radius and hours, system settings, audit log |

## What's here

```
src/                  Apps Script project (pushed with clasp; .js files become .gs)
  Config.js           roles, constants, sheet schemas
  Util.js             IST date maths, HMAC, lock and cache helpers
  Db.js               Google Sheets as the database (batched reads, locked writes)
  Settings.js         per-lab settings (Script Properties + Config tab) and system settings
  Auth.js             domain check, registration and validation, roles, audit log
  Crypto.js           encryption of phone numbers stored in Sheets
  Token.js            signed, single-use, rotating QR tokens
  Geo.js              Haversine geofence + Green/Amber/Red presence confidence
  Attendance.js       scan → check-in (system + project), check-out (work note), review, auto-close
  Projects.js         student projects: title, timeline, members, work log, outcome
  Bookings.js         time-slot reservations with a waitlist queue, no-shows
  Assets.js           catalog, walk-in requests, issue/return handshake, overdue reminders
  Monitoring.js       who's in the lab, activity stream, lab map, rosters, missing list
  Usage.js            lookups by register number / by system, nightly rollups, archiving
  Reports.js          daily digest, monthly audit, ranges, CSV/Excel, Docs→PDF, email
  Jobs.js             time-driven triggers, backups with retention
  Api.js              doGet, doPost, the single api() endpoint and the role table
  Setup.js            setup() and seedDemoData()
  Index.html, Client.html, Styles.html   dashboards for every role + phone check-in
  Monitor.html        full-screen lab monitor (QR, countdown, occupancy, online/offline)
docs/
  LabPulse_Progress_Summary.md   easy-read summary: what we built, how it works, roles, glossary, what's left
  LabPulse_SRS_v1.4.pdf   requirements, traced to the client proposal and the supervisor's briefing
  build_srs.py            regenerates the PDF (pip install reportlab; python docs/build_srs.py)
dev/
  preview.js          local preview: npm run preview
tests/
  run.js              SRS acceptance tests AT-01–AT-15 and proposal checks
  v2.js               supervisor-briefing features: roles, systems, projects, queue, lookups, archive, encryption
  ui-smoke.js         renders every role's screens in jsdom wired to the real server code
```

## Try it on your laptop (no Google account needed)

```
npm install
npm run preview
```

Open **http://localhost:8787**. The start page lets you open the lab monitor, choose a simulated location, scan as a student, and open any role's dashboard.

**Scanning with a real phone:** connect the phone to the **same Wi-Fi** as the laptop and point its camera at the monitor's QR. The QR uses the laptop's Wi-Fi address, which the terminal prints, e.g. `http://192.168.1.8:8787`. The phone asks "Who is scanning?", then continues to check-in. If the phone can't load the page, allow Node.js through Windows Firewall for private networks.

In the preview, location is simulated, because phones allow real GPS only on `https` pages. The deployed Apps Script app is `https`, so it uses the phone's real GPS.

## Deploy to Google Apps Script

Use your **Karunya account**. A personal Gmail can't identify other users; see *Identity* below.

1. Turn on the Apps Script API at https://script.google.com/home/usersettings.
2. At https://script.google.com create a project named **LabPulse**, then copy its **Script ID** from Project Settings.
3. In this folder:
   ```
   npx clasp login
   cp .clasp.json.example .clasp.json     # paste the Script ID into it
   npx clasp push                          # answer yes to overwrite the manifest
   ```
4. (Optional) Project Settings → Script Properties → `BOOTSTRAP_ADMINS` = `a@karunya.edu.in, b@karunya.edu.in`.
5. In the editor run **`setup`**, then **`seedDemoData`** (optional), then **`installTriggers`**. Approve the permissions; Google shows "unverified app" for your own scripts, so click *Advanced → Go to LabPulse*.
6. Deploy → New deployment → **Web app**: *Execute as: Me*, *Who has access: Anyone within karunya.edu.in*. Copy the URL.
7. Open the URL and complete your profile. In **Settings**, set the lab location (stand in the lab, then **Use my current location**), hours and in-charge email.
8. On the lab PC, signed in as staff or coordinator, open `<URL>?view=monitor&lab=AIIOT` in full screen.

To update after a code change: `npx clasp push`, then Deploy → Manage deployments → Edit → New version.

### Identity

The web app runs as the deploying account and learns who the visitor is from `Session.getActiveUser()`. Google provides that only for visitors in the **same Google Workspace** as the owner. If `@karunya.edu` and `@karunya.edu.in` are separate Workspaces, users of the other one are refused with a clear message. For a solo test from a personal Gmail, set `"access": "ANYONE"` in `src/appsscript.json`, and add your Gmail to the Script Property `APP_SETTINGS` = `{"extra_allowed_emails":["you@gmail.com"]}` before running `setup`.

## Data, backups and privacy

- **Sheets as the database.** Each kind of record has its own tab, IDs are unique, and writes are locked.
- **Nightly summaries.** `UsageDaily` holds one row per person per day and `AssetUsageDaily` one row per item per day. Lookups stay fast and complete.
- **Monthly archive.** Closed rows older than 3 months (a setting) move to a yearly **LabPulse Archive YYYY** spreadsheet, so the live sheet never grows without limit. Totals and project hours are kept.
- **Backups.** The whole spreadsheet is copied nightly. The last 14 daily copies are kept, plus one per older month (a setting).
- **Encryption.** Phone numbers are stored as `enc:v1:…`, using authenticated encryption built on HMAC-SHA256 with the key in Script Properties. Only the Super Admin, the Coordinator, and staff chasing an unreturned item see the full number; everyone else sees `••••••3210`. Exports never include phone numbers.
- **No GPS coordinates are stored.** Only whether the person was inside the geofence, plus the confidence level.

## Tests

```
npm test     # 37 acceptance + 18 v2 + 13 UI checks
```

The tests run the real `src/*.js` against in-memory fakes of the Google services, with a controllable clock. They do **not** exercise real Google Docs, Drive, Gmail or triggers, or real phone GPS; check those once deployed.

## Known limitations

- The Lab Map and "who is on which system" come from what people enter at check-in, not from physical sensors.
- Browsers rarely expose a mock-location flag. A missing flag is never treated as proof of honesty.
- Anyone with edit access to the Apps Script project can read the encryption key. Keep the project and the spreadsheet private.
- Reports for periods older than the archive cut-off use the summaries, not the raw rows.
