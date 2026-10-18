# LabPulse

Real-time lab monitoring, geofenced attendance and asset booking, built entirely on Google Apps Script and Google Workspace (SRS v1.2, 23CS2048 Web Technology).

## What's here

```
src/                  Apps Script project (pushed with clasp; .js files become .gs)
  Config.js           constants and sheet schemas (SRS §7)
  Util.js             IST date maths, HMAC, lock and cache helpers
  Db.js               Google Sheets as the database (batched reads, locked writes)
  Settings.js         per-lab settings in PropertiesService + Config tab (FR-35)
  Auth.js             domain check, registration, roles, audit log (FR-01–04)
  Token.js            signed, single-use, rotating QR tokens (FR-05, 06, 17)
  Geo.js              Haversine geofence + Presence Confidence (FR-07, 12, 13, 16)
  Attendance.js       claim → check-in steps 1–11, check-out, review, auto-close, reconcile
  Assets.js           catalog, requests, issue/return handshake, overdue (FR-19–25)
  Monitoring.js       activity stream, staff summary, lab map, faculty roster (FR-26–28)
  Reports.js          daily digest, monthly audit, ranges, CSV, Docs→PDF, email, Lab Passport
  Jobs.js             time-driven triggers (SRS §3.4)
  Api.js              doGet, the single api() endpoint and the role table
  Setup.js            setup() and seedDemoData()
  Index.html, Client.html, Styles.html   role dashboards + phone check-in flow
  Monitor.html        full-screen lab monitor (QR, countdown, occupancy, online/offline)
docs/
  LabPulse_SRS_v1.3.pdf   requirements, aligned line by line with the client's GeoFence proposal
  build_srs.py            regenerates the PDF (pip install reportlab; python docs/build_srs.py)
dev/
  preview.js          local preview: npm run preview, then open http://localhost:8787
tests/
  run.js              SRS acceptance tests AT-01–AT-15 + extra checks, against fake Google services
  ui-smoke.js         renders every role's UI in jsdom wired to the real server code
```

## Deploy

1. **Create the project.** At [script.google.com](https://script.google.com), create a new project, signed in with the institutional account that will own the app. Copy its Script ID from Project Settings.
2. **Push the code.**
   ```
   npm install
   npx clasp login
   cp .clasp.json.example .clasp.json   # paste the Script ID
   npx clasp push
   ```
   (Without clasp: create each file in the editor with the same name and paste it in.)
3. **(Optional) Add other admins.** Project Settings → Script Properties → `BOOTSTRAP_ADMINS` = `a@karunya.edu, b@karunya.edu`. The account that runs `setup()` always becomes a Super Admin if it is institutional.
4. **Run the setup functions.** In the editor, run `setup()`, then `seedDemoData()` (optional), then `installTriggers()`. Approve the permissions each time. `setup()` logs the URL of the data spreadsheet; keep its sharing **private**.
5. **Deploy the web app.** Deploy → New deployment → Web app. Set *Execute as: Me*, *Who has access: Anyone within karunya.edu*.
6. **Configure the lab.** Open the app → Settings. Stand in the middle of the lab and tap **Use my current location**, set the hours and the in-charge email, then save.
7. **Set up the monitor.** On the lab PC, sign in as lab staff and open `<web app URL>?view=monitor&lab=AIIOT` in full screen.

### Identity: confirm before the demo (SRS §13 Q1)

The app runs as the deploying account and identifies users with `Session.getActiveUser()`. Google returns that email only when the visitor is in the **same Google Workspace customer** as the owner.

- If `@karunya.edu` and `@karunya.edu.in` are two domains of one Workspace, both work with *Anyone within …*.
- If they are separate Workspaces, users from the other domain reach the app with an empty identity. LabPulse then refuses them with a clear message and never guesses who they are. Fixing that needs either the owner in the right Workspace or IT to merge the domains.
- For testing with personal Gmail accounts, add them under Settings → *Test accounts allowed outside the institutional domains* and deploy with *Anyone with a Google account*. Empty that list for production; AT-01 depends on it.

## Demo script (SRS §10.2)

1. Show the monitor's QR. A student scans it and checks in; the occupancy pill on the faculty screen goes up within about 8 s.
2. Scan the *same* code on a second phone: **"This QR code was already used."** It appears under Live activity and in Audit as `SECURITY_QR_REUSED`. The monitor already shows a new code.
3. A student with weak GPS (indoors, or `accuracy > 30 m`) lands in **Amber**. Faculty → My sessions → Pending reviews → **Confirm**.
4. The checked-in student taps Request equipment → Raspberry Pi. Staff → Live → Handshake → **Confirm issue**; the Lab Map tile turns blue. To show an overdue loan, issue one with a due time a minute away, then Settings → Run overdue check.
5. Reports → Daily digest → **Save PDF to Drive** (or **Email digest now**).

`seedDemoData()` adds an all-day "DEMO101" session, so course check-ins work at any time of day.

## Tests

```
npm test            # server acceptance tests + UI smoke test
```

The server tests load the real `src/*.js` into Node with in-memory fakes of SpreadsheetApp, CacheService, LockService, PropertiesService, Session and Utilities, plus a controllable clock. They cover AT-01 to AT-15 and also token forgery, travel speed, idempotent retries, reconciliation, role overrides and export minimisation.

They do **not** exercise Google Docs, Drive, Gmail or triggers, and they do not show real phone GPS behaviour. Test those on the deployed app with real Android and iPhone devices, as the SRS risk table says.

## Design notes

- **One API, two doors.** The UI calls `api()` through google.script.run; `doPost` serves the same actions as JSON. Both go through the same role checks.
- **Server decides everything.** The browser sends only what the phone saw (QR, location, accuracy, mock flag). Every call goes through `api()`; the `ROUTES` table in `Api.js` is the single list of who may call what. Super Admin can grant *configurable* actions to more roles (FR-36).
- **Scan → claim → check in.** Opening the QR link calls `doGet`, which verifies the HMAC signature and time window and consumes the nonce under a lock. That gives the user a 5-minute server-side ticket for that lab, which is enough time to allow location and pick a reason, while the QR itself stays valid for only ~16–24 s.
- **No stored coordinates.** Latitude and longitude live only inside `Geo.evaluate`. The travel-speed check needs no stored position: it keeps only the *distance from the lab centre* of the last attempt and uses the triangle inequality for a lower bound on how far the user moved.
- **Verified counter.** As the proposal asks, the live counter counts verified sign-ins only (Green, staff manual entry, or a confirmed Amber); check-ins awaiting review are shown beside it ("12 inside · 2 pending"), and only verified students can request equipment.
- **Occupancy is always derived.** It is a count of `ActiveVisits` rows, cached for dashboards and rebuilt from `Visits` every 5 minutes. Drift is logged as `RECONCILE_DRIFT`.
- **Quotas.** The monitor polls every 1.5 s but reads only Cache and Script Properties. Outside operating hours it slows to one call a minute. Measure real usage before a full class.

## Known limitations

- The Lab Map reflects app records, not physical sensors; the UI says so.
- Browsers rarely expose a mock-location flag. A missing flag is never treated as proof of honesty.
- Throughput is about one check-in per 2–3 s per monitor, because each QR is single-use. Faster options (a second monitor, a faculty-opened entry window) need supervisor approval.
- CSV download from the sandboxed web app frame may be blocked on some browsers; **Save CSV to Drive** is the fallback.
