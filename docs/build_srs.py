"""Builds docs/LabPulse_SRS_v1.4.pdf.  Usage: python docs/build_srs.py"""
import os
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table,
                                TableStyle, ListFlowable, ListItem)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'LabPulse_SRS_v1.4.pdf')

ss = getSampleStyleSheet()
BODY = ParagraphStyle('body', parent=ss['Normal'], fontName='Times-Roman', fontSize=11, leading=15, spaceAfter=6)
SMALL = ParagraphStyle('small', parent=BODY, fontSize=9.5, leading=12.5, spaceAfter=0)
SMALLB = ParagraphStyle('smallb', parent=SMALL, fontName='Times-Bold')
H1 = ParagraphStyle('h1', parent=BODY, fontName='Times-Bold', fontSize=16, leading=20, spaceBefore=14, spaceAfter=8)
H2 = ParagraphStyle('h2', parent=BODY, fontName='Times-Bold', fontSize=12.5, leading=16, spaceBefore=10, spaceAfter=5)
CENTER = ParagraphStyle('center', parent=BODY, alignment=TA_CENTER)
QUOTE = ParagraphStyle('quote', parent=BODY, fontName='Times-BoldItalic', alignment=TA_CENTER)

story = []


def p(text, style=BODY):
    story.append(Paragraph(text, style))


def h1(text):
    story.append(Paragraph(text, H1))


def h2(text):
    story.append(Paragraph(text, H2))


def bullets(items, numbered=False):
    story.append(ListFlowable([ListItem(Paragraph(i, BODY), leftIndent=14) for i in items],
                              bulletType='1' if numbered else 'bullet', start=1 if numbered else None,
                              bulletFontName='Times-Roman', bulletFontSize=10, leftIndent=18))


def table(header, rows, widths, highlight_col=None):
    data = [[Paragraph(h, SMALLB) for h in header]]
    for r in rows:
        data.append([Paragraph(str(c), SMALL) for c in r])
    t = Table(data, colWidths=[w * mm for w in widths], repeatRows=1)
    style = [
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#d9d9d9')),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#555555')),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 5),
        ('RIGHTPADDING', (0, 0), (-1, -1), 5),
    ]
    t.setStyle(TableStyle(style))
    story.append(t)
    story.append(Spacer(1, 8))


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont('Times-Roman', 9)
    canvas.drawCentredString(A4[0] / 2, 12 * mm, 'LabPulse – Software Requirements Specification v1.4 | Page %d' % doc.page)
    canvas.restoreState()


DONE = 'Built and tested'
ADDED = 'Added value (beyond proposal)'
VERIFY = 'Built; verify on deployment'

# ---------------------------------------------------------------- cover
story.append(Spacer(1, 45 * mm))
story.append(Paragraph('LabPulse', ParagraphStyle('t', parent=CENTER, fontName='Times-Bold', fontSize=30, leading=36)))
story.append(Paragraph('Software Requirements Specification', ParagraphStyle('st', parent=CENTER, fontSize=17, leading=22)))
story.append(Spacer(1, 10 * mm))
for line in [
    'Real-Time Lab Monitoring, Geofenced Attendance and Asset Booking System',
    '<b>Karunya Institute of Technology and Sciences</b>',
    'Division of Computer Science and Engineering',
    'Course: 23CS2048 – Web Technology (3 IA Project)',
    'Reference: Circular KITS/CSE/CIR/2026/163, the client’s GeoFence Proposal and the supervisor’s briefing',
    'Version 1.4 | 19 October 2026',
    '<b>Submitted by (III B.Tech CSE)</b>',
    'RS Aathishree — URK24CS1249',
    'Harivaishnavi B — URK24CS1238',
    'Christy Vincelet A — URK24CS1199',
    '<b>Team name:</b> LabPulse',
    '<b>Supervisor:</b> Dr. I. Titus, Assistant Professor',
]:
    story.append(Paragraph(line, CENTER))
story.append(PageBreak())

# ---------------------------------------------------------------- revision note
h1('What changed in version 1.4')
p('After version 1.3 the supervisor briefed the teams (two voice messages). Version 1.4 adds everything in that '
  'briefing. The first deployment is the <b>Intel Unnati IoT Lab</b>; nothing is tied to one room, so the same app '
  'serves every lab in the department.')
table(['Supervisor asked for', 'What LabPulse now does', 'Requirement'], [
    ['See from home how many students are in the lab, which systems they use and what projects they work on', 'Check-in records the system (lab PC, GPU node, 3D printer, drone or own laptop) and, for extra hours, the project. HOD, Coordinator and staff see a live “who’s in the lab” list: name, register number, system, project, time in', 'FR-38'],
    ['Assets such as 3D printers, drones and computers with graphics cards, used by timeline, with a queue to reserve a spot', 'Catalog includes them. Students reserve a time slot; if it is taken they join a waitlist and are emailed when it frees up. Staff start the session only when the student is checked in. No-shows release the slot', 'FR-40, FR-48'],
    ['Record the project, its timeline and its outcome', 'Projects with title, members, start and end date, a work log built from each visit (system, hours, “what I did today”), and a submitted outcome with a link', 'FR-39'],
    ['Given a register number: how many days and how long in the lab', 'Lookup by register number: days in lab, total hours, visits by day, systems, projects', 'FR-41'],
    ['Given a system: how many people used it and for what', 'Lookup by system: number of people, uses, hours, and each use with person, purpose and project', 'FR-42'],
    ['Regular lab (e.g. Web Technology at 11 am): faculty find who is missing', 'Roster shows Present · Pending · Missing; faculty are emailed the missing list after the session; CSV download', 'FR-43'],
    ['Google Sheets storage with periodic backups and multiple sheets so one sheet is not overloaded', 'Nightly per-day summaries, monthly archiving of old rows to a yearly archive spreadsheet, nightly backup copies with retention', 'FR-44, FR-45'],
    ['Encrypt crucial data such as phone numbers, and validate input', 'Phone numbers stored encrypted with tamper detection, shown only to roles that need them; stricter validation of register numbers, names and all input on the server', 'FR-46, FR-47'],
    ['Roles: student (sees own hours), coordinator (add/remove facilities and students), HOD (sees everything), super admin (manages roles)', 'Six roles: Student, Faculty, Lab staff, Coordinator, HOD (read-only), Super Admin', 'FR-37'],
], [52, 92, 26])

h1('Changes in version 1.3')
p('Version 1.2 was our plan. Version 1.3 aligns that plan line by line with the client’s <b>GeoFence Proposal</b> '
  'and records what has now been built and tested. The proposal is treated as the source of truth; where our plan '
  'differed, the plan has been changed.')
table(['Area', 'Version 1.2', 'Version 1.3 (matches the proposal)'], [
    ['Live occupancy counter', 'Check-ins pending review counted as inside', 'Counter increments only on a <b>verified</b> sign-in; check-ins awaiting review are shown beside it (“12 inside · 2 pending”)'],
    ['Reservation gating', 'Any active visit could request equipment', 'Requires an active, verified CHECKED_IN status'],
    ['Entry reasons', 'Courses and events only from the timetable list', 'Timetable list, plus a “not listed” form with exactly the proposal’s fields (course code, course name, session hours; event name, coordinator, expected duration)'],
    ['Research equipment', 'Free text', 'Chosen from the lab’s own hardware catalog, plus optional free text'],
    ['Mock location', '“Flag” suspected fake GPS', '<b>Reject</b> the check-in when the browser reports a mock location'],
    ['Daily digest', 'Single peak hour', 'Peak occupancy <b>hours</b> (three busiest)'],
    ['Export formats', 'CSV', 'CSV <b>and Excel (.xlsx)</b>, both ERP-ready'],
    ['Backend endpoints', 'doGet', 'doGet <b>and doPost</b>, sharing one role-checked API'],
    ['Status', 'Requirements only; nothing built', 'All P0 and P1 requirements built; 48 automated checks pass. Not yet deployed to Google.'],
], [38, 52, 80])

# ---------------------------------------------------------------- 1 introduction
h1('1. Introduction')
h2('1.1 What we are building')
p('Today a specialised lab runs on a paper register and memory. Someone signs in for a friend, nobody knows how many '
  'people are inside, and a Raspberry Pi borrowed on Monday is forgotten by Friday. LabPulse replaces this with a '
  'Google Apps Script web app that verifies who is physically in the lab, shows live occupancy, manages high-value '
  'hardware, and produces the reports the department needs.')
p('As the proposal requires, it is built 100% on Google Apps Script and Google Workspace at zero server cost. This '
  'document describes the system architecture, the geofencing workflow and the dashboard designs, and maps every '
  'line of the proposal to a requirement (Section 1.3).')

h2('1.2 Approach and added value')
p('The design philosophy is to make correct behaviour the easiest behaviour: if checking in takes about ten seconds '
  'and misuse takes more effort than simply being present, users follow the process. Every requirement in the '
  'proposal is met (priority P0). On top of that we add four ideas. They use only Google Apps Script, Sheets and '
  'Workspace, and none of them changes what the proposal asks for.')
table(['Added idea', 'What it does', 'Why'], [
    ['<b>Presence Confidence</b>', 'Each check-in is graded Green, Amber or Red from QR validity, distance, GPS accuracy, travel speed and the mock-location signal.',
     'GPS drifts indoors. Rejecting an honest student is unfair; accepting everything is unsafe. Amber goes to one-tap faculty or staff review and is only counted once confirmed.'],
    ['<b>Consume-and-Refresh QR</b>', 'When a QR is scanned, the monitor shows a fresh one within about 1.5 seconds.',
     'The proposal requires single-use tokens. Implemented naively, only one student could check in per rotation.'],
    ['<b>Self-Healing Occupancy</b>', 'Forgotten visits close automatically and are labelled; the counter is recounted from records every 5 minutes.',
     'A live counter is only useful if it is accurate.'],
    ['<b>Live Lab Map</b>', 'A floor-plan view of which workstations, GPU nodes and kits are free or in use.',
     'Answers the question students ask most: is anything free right now?'],
], [36, 70, 64])
p('An optional extra, the <b>Lab Passport</b> (a one-page PDF of a student’s verified hours, courses and equipment '
  'handled), is also built.')
p('<b>Limits of the claims.</b> The Lab Map is built from application records, not physical sensors. Presence '
  'Confidence reduces misuse but does not make it impossible, and browsers do not expose a mock-location signal on '
  'every phone. The system states these limits openly.')

h2('1.3 Traceability to the client proposal')
p('Every line of the proposal, the requirement that covers it, and its status. “Built and tested” means automated '
  'tests pass; “verify on deployment” marks features whose logic is tested but which call Google Docs, Drive or '
  'Gmail, which only run once deployed.')
trace = [
    ['A', 'Domain lock to @karunya.edu / @karunya.edu.in', 'FR-01', DONE],
    ['A', 'Profile: name, roll no. / employee ID, Karunya email, mobile', 'FR-02', DONE],
    ['A', 'RBAC – Student: scan QR, GPS check-in/out, live counter, visit reason, request bookings, borrowing history', 'FR-03, 05–10, 14, 21, 25', DONE],
    ['A', 'RBAC – Faculty: live roster, verify attendance, export session logs', 'FR-27', DONE],
    ['A', 'RBAC – Lab In-charge / Staff: activity stream, live occupancy, inventory add/edit/remove, issue/return handshake', 'FR-22, 24, 26', DONE],
    ['A', 'RBAC – Super Admin: GPS coordinates, radius, hours, role permissions, audit logs', 'FR-35, 36', DONE],
    ['B', 'Dynamic TOTP-style QR on a lab monitor, rotating every 5–10 s', 'FR-05', DONE],
    ['B', 'GPS geofence with Haversine, 15–20 m', 'FR-07', DONE],
    ['B', 'Categorised entry: course (code, name, hours), event (name, coordinator, duration), research (purpose, hardware)', 'FR-09', DONE],
    ['B', 'Live counter: increment on verified sign-in, decrement on sign-out, on all dashboards', 'FR-14', DONE],
    ['C', 'Catalog: GPU (RTX 4090 / A100), IoT (ESP32, Raspberry Pi, LoRaWAN), sensors (ultrasonic, thermal, LiDAR, gas)', 'FR-19', DONE],
    ['C', 'Public availability catalog for students', 'FR-20', DONE],
    ['C', 'Reservation gated on active CHECKED_IN status', 'FR-21', DONE],
    ['C', 'Staff handshake UI to approve checkout and mark returns', 'FR-22', DONE],
    ['C', 'Overdue tracking and automated reminders', 'FR-23', DONE],
    ['2', 'Single-use token invalidation in CacheService', 'FR-06', DONE],
    ['2', 'LockService during check-ins', 'FR-11', DONE],
    ['2', 'Impossible-travel velocity check: flag and block', 'FR-12', DONE],
    ['2', 'Mock-location detection: reject emulated GPS', 'FR-13', DONE],
    ['2', 'Privacy: store is_valid_geofence and timestamp; discard latitude/longitude', 'FR-08', DONE],
    ['2', 'Append-only audit of manual entries, role changes, inventory overrides', 'FR-04', DONE],
    ['3', 'Daily digest: unique visits, peak hours, hourly distribution, pending/unreturned items', 'FR-29', DONE],
    ['3', 'Monthly audit: course-wise student-hours, GPU utilisation, sensor turnover', 'FR-30', DONE],
    ['3', 'Custom start–end date range export', 'FR-31', DONE],
    ['3', 'PDF from a Google Docs template, saved to Drive', 'FR-32', VERIFY],
    ['3', 'CSV / Excel for ERP import', 'FR-32', VERIFY],
    ['3', 'Daily end-of-day email to the Lab In-charge via GmailApp', 'FR-33', VERIFY],
    ['4', 'Google Apps Script V8, doGet / doPost', '§3.1', DONE],
    ['4', 'HtmlService single-page app (HTML5, Tailwind CSS, JavaScript)', '§3.1, §6', DONE],
    ['4', 'Google Sheets database with structured tabs', '§7', DONE],
    ['4', 'DriveApp, DocumentApp, GmailApp', 'FR-32, 33', VERIFY],
    ['4', 'PropertiesService for geofence limits and constants', 'FR-35', DONE],
    ['–', 'Presence Confidence, Consume-and-Refresh, Self-Healing Occupancy, Lab Map, Lab Passport', 'FR-16, 17, 18, 28, 34', ADDED],
]
table(['Prop. §', 'Proposal requirement', 'Covered by', 'Status'], trace, [14, 96, 30, 30])

# ---------------------------------------------------------------- 2 roles
h1('2. Users and Roles')
p('Access is restricted to institutional Google accounts (@karunya.edu and @karunya.edu.in). Each user records '
  'name, roll number or employee ID, institutional email and mobile number.')
table(['Role', 'What they can do'], [
    ['<b>Student</b>', 'Scan the QR and check in or out with GPS, see the live lab counter and their own hours and days, choose a visit reason, system and project, manage projects (timeline, outcome), reserve equipment slots, request items, see borrowing and visit history'],
    ['<b>Faculty</b>', 'See the live roster for their courses or events (Present · Pending review · Missing), confirm flagged check-ins, mark present or absent with a reason, export session logs, receive the missing list by email'],
    ['<b>Lab Staff</b>', 'Run the lab monitor, watch live activity, hand over and take back equipment, start and finish reserved sessions, make supervised manual entries, review research check-ins'],
    ['<b>Coordinator</b>', 'Everything Lab Staff can do, plus add, edit and remove facilities (inventory), add and remove students, manage courses and events, see live usage, lookups and reports'],
    ['<b>HOD</b>', 'Read-only view of every lab: who is in it, on which system and project, rosters, projects, lookups by register number or system, reports and exports. Cannot change anything'],
    ['<b>Super Admin</b>', 'Manage every role and permission, configure GPS coordinates, geofence radius, operating hours and system settings, inspect audit logs, run maintenance jobs'],
], [32, 138])

# ---------------------------------------------------------------- 3 architecture
h1('3. System Architecture')
h2('3.1 Layers')
p('Everything lives inside Google Workspace, with no external server.')
table(['Layer', 'What it is', 'What it does'], [
    ['<b>Browser</b>', 'Single-page responsive web app (HTML5, Tailwind CSS, JavaScript) served by HtmlService', 'Role dashboards, the lab-monitor QR page, camera link and GPS access'],
    ['<b>Application server</b>', 'Google Apps Script V8: <b>doGet</b> (pages), <b>doPost</b> (JSON API) and google.script.run, all through one role-checked dispatcher', 'All business rules: token checks, geofence, roles, bookings, reports'],
    ['<b>Guard layer</b>', 'CacheService, LockService, PropertiesService', 'Single-use token memory, protection from simultaneous check-ins, settings and secrets'],
    ['<b>Data</b>', 'Google Sheets', 'Every record (Section 7)'],
    ['<b>Output</b>', 'Google Docs, Drive, GmailApp', 'PDF reports, CSV and Excel exports, daily summary email'],
], [32, 70, 68])
h2('3.2 Design principle: server-side trust')
p('The browser is never trusted. The server decides.', QUOTE)
p('The phone only reports what it observed (a QR value, a location and its accuracy). Every decision is made in Apps '
  'Script. Hiding a button is not security; a server-side role check is. In the built system, one route table lists '
  'which roles may call each action, and every request is checked against it.')
h2('3.3 How a request travels')
bullets([
    'The user opens the web app URL and Google sign-in identifies them.',
    'The server checks the email domain and looks up the user’s role.',
    'The screen shows only what that role may use.',
    'Every action goes to the server, which re-checks identity and role, validates input, takes a lock if it writes, '
    'writes, and replies with a clear result. Sensitive actions are also appended to the audit log.',
], numbered=True)
h2('3.4 Background jobs')
table(['Job', 'How often', 'What it does'], [
    ['Occupancy reconciliation', 'Every 5 minutes', 'Recounts verified and pending occupancy from active visits and fixes any drift'],
    ['Auto-close sweep', 'Every 10 minutes', 'Closes visits past their duration plus grace, or past closing time'],
    ['Overdue check', 'Hourly', 'Marks late loans, emails reminders to the borrower and staff, expires stale requests'],
    ['Daily digest', 'Hourly check; sends once, 30 min after each lab closes', 'Builds the report, saves the PDF to Drive, emails the Lab In-charge; nightly spreadsheet backup'],
    ['Monthly audit', '1st of each month', 'Generates last month’s institutional report'],
], [42, 46, 82])
h2('3.5 Ready for every lab')
p('Nothing is hard-coded to one room. Every record carries a lab ID, and each lab has its own coordinates, radius, '
  'hours and monitor QR. Adding a lab is a settings change, not a rewrite.')

# ---------------------------------------------------------------- 4 workflow
h1('4. Geofencing and Attendance Workflow')
h2('4.1 The student’s view (target: under 10 seconds)')
bullets([
    'Point the phone’s normal camera at the QR on the lab monitor and tap the link. There is no app to install; LabPulse opens, signed in with Google.',
    'Allow location when asked.',
    'Pick one reason: <b>Regular Lab Course</b> (course code, course name, session duration in hours), '
    '<b>Event / Workshop</b> (event name, event coordinator name, expected duration) or <b>Individual Research / Self-Work</b> '
    '(purpose of visit, specific hardware/equipment required). Courses and events running now are offered from the '
    'timetable so their details fill in automatically; if one is missing, the student types those same fields. '
    'Research hardware is chosen from the lab’s own catalog, with free text for anything else.',
    'See a clear result: <b>Checked in</b>, <b>Checked in — pending review</b>, or <b>Not checked in, and here is why</b>.',
], numbered=True)
h2('4.2 What the server does behind the scenes')
table(['Step', 'Check', 'If it fails'], [
    ['1', 'Caller is a signed-in institutional user with an active profile', 'Reject; log event'],
    ['2', 'Lab is open (inside operating hours)', 'Reject with a clear message; staff can make a logged override'],
    ['3', 'QR token has a valid signature and is within its time window', 'Reject as expired or invalid; log event'],
    ['4', 'Token has not been used already (checked and marked under a lock)', 'Reject as reused; log security event'],
    ['5', 'User has no other active visit in this lab', 'Show the existing visit instead of creating another'],
    ['6', 'Distance from the lab centre (Haversine) is inside the configured radius, 15–20 m', 'Reject as outside the lab (Amber if only just outside, within GPS uncertainty)'],
    ['7', 'Reported GPS accuracy is reasonable for the radius', 'Downgrade to Amber'],
    ['8', 'Travel speed since the previous attempt is plausible', 'Flag (Amber) above the walking limit; block (Red) when impossible'],
    ['9', 'Browser mock-location signal, where one exists', '<b>Reject</b> (Red). A missing signal is not treated as proof of honesty'],
    ['10', 'Visit reason details are complete; session is in the timetable', 'Ask the student to complete them; an unlisted session goes to Amber for staff confirmation'],
    ['11', 'Write the visit, the audit event and the occupancy update', 'Reply with the result'],
], [14, 86, 70])
p('Latitude and longitude exist only in server memory while steps 6 to 8 run. What gets stored is the verdict '
  '(<font face="Courier">is_valid_geofence</font>), the confidence level and a timestamp. The travel check keeps '
  'only the previous attempt’s <i>distance from the lab centre</i>, never a position, and uses the triangle '
  'inequality to bound how far the user moved. Our own logging never prints the coordinates.')
h2('4.3 Presence Confidence')
table(['Outcome', 'When', 'What happens'], [
    ['<b>Green</b>', 'Fresh valid QR, inside radius, good GPS accuracy, normal travel history, session in the timetable', 'Checked in and counted immediately'],
    ['<b>Amber</b>', 'Valid QR and near the lab, but accuracy is poor, travel is unusual, or the session is not in the timetable', 'Checked in as <i>pending review</i>; shown as “pending” beside the counter. Faculty (timetabled sessions) or staff (research and unlisted sessions) confirm or decline with one tap. Confirmed visits join the counter; declined ones are voided and logged'],
    ['<b>Red</b>', 'Reused or invalid QR, clearly outside the radius, impossible travel speed, mock location detected', 'Not checked in. The reason is shown and the event is logged'],
], [20, 70, 80])
p('Thresholds (radius, accuracy limit, speed limits) are settings, not code, so admins can tune them after testing in the real lab.')
h2('4.4 Consume-and-Refresh QR')
p('The lab monitor shows a QR containing only the lab ID, a time-window number, a random nonce and an HMAC-SHA256 '
  'signature made with a secret key that stays in Script Properties. <b>No reusable secret is ever inside the QR.</b>')
bullets([
    'The QR rotates every <b>8 seconds</b> (configurable within the required 5–10 seconds).',
    'When a scan succeeds, the server marks the token as used in CacheService and the monitor swaps to a new QR within about 1.5 seconds.',
    'Opening the link consumes the token and gives that user a 5-minute server-side ticket to finish the form, so a slow location fix does not need a rescan.',
    'A screenshot is therefore useless: it is either expired or already consumed by whoever scanned it first.',
])
p('<b>Quota note.</b> The monitor’s refresh reads only the cache and Script Properties, never a Sheet, and slows to '
  'once a minute outside operating hours. <b>Throughput note.</b> About one student every 2–3 seconds per monitor; '
  'a class of 60 needs a couple of minutes. Faster options (a second monitor, a faculty-opened entry window) need '
  'supervisor approval before we change the single-use rule.')
h2('4.5 Check-out and the live counter')
p('Students check out with one tap. The counter shows <b>verified</b> people inside: it goes up on a verified '
  'sign-in (Green, staff manual entry, or a confirmed Amber) and down on sign-out, decline or auto-close. Check-ins '
  'awaiting review appear beside it, so the number on screen is never inflated and nothing is hidden. If a student '
  'forgets to check out, a course or event visit closes at its stated duration plus a grace period and a self-work '
  'visit closes at lab closing time; auto-closed visits are labelled in data and reports. Every 5 minutes both counts '
  'are recalculated from active visit records.')
h2('4.6 When things go wrong')
table(['Situation', 'What the user sees', 'What the system does'], [
    ['Location permission denied', 'A clear explanation and how to enable it', 'Nothing is written. Staff can make a supervised manual entry, which is audit-logged'],
    ['Network drops mid-request', '“Checking… please wait”, then the final result', 'Each request carries a unique ID, so a retry never creates a duplicate visit'],
    ['QR monitor is down', 'The monitor hides the code and shows <i>Offline</i>', 'No attendance is ever created silently. Staff follow the manual fallback'],
    ['Session not in the timetable', 'A form for the session details', 'Check-in recorded as pending; lab staff confirm'],
], [40, 60, 70])

# ---------------------------------------------------------------- 5 FRs
h1('5. Functional Requirements')
p('Priority key: <b>P0</b> = required by the circular and the client proposal. <b>P1</b> = our added ideas. '
  '<b>P2</b> = optional. Status reflects the build as of this version.')


def fr(title, rows):
    h2(title)
    table(['ID', 'Requirement', 'Priority', 'Status'], rows, [16, 116, 16, 22])


B = 'Built, tested'
fr('5.1 Access and roles', [
    ['FR-01', 'Only @karunya.edu and @karunya.edu.in Google accounts can enter. Everyone else is rejected on the server.', 'P0', B],
    ['FR-02', 'First sign-in captures name, roll number or employee ID and mobile number; the email comes from the Google account.', 'P0', B],
    ['FR-03', 'Student, Faculty, Lab Staff and Super Admin roles are enforced on the server for every request.', 'P0', B],
    ['FR-04', 'Role changes, manual administrative entries and inventory overrides are written to an append-only audit log.', 'P0', B],
])
fr('5.2 Attendance', [
    ['FR-05', 'A lab-monitor page shows a time-based (TOTP-style) QR that rotates every 5–10 seconds.', 'P0', B],
    ['FR-06', 'Tokens are signed, expire quickly, and are invalidated on first use through CacheService.', 'P0', B],
    ['FR-07', 'Check-in measures distance from the lab with the Haversine formula against a 15–20 m configurable radius.', 'P0', B],
    ['FR-08', 'Raw latitude and longitude are discarded after evaluation. Only is_valid_geofence and a timestamp are stored.', 'P0', B],
    ['FR-09', 'The student must choose one entry reason with its required fields: course (code, name, session hours), event (name, coordinator, expected duration) or research (purpose, hardware from the lab catalog). Timetabled sessions fill in automatically; unlisted ones are typed and go to staff review.', 'P0', B],
    ['FR-10', 'Check-in creates one active visit; a second active visit for the same user and lab is blocked; check-out closes it.', 'P0', B],
    ['FR-11', 'Check-in is wrapped in LockService so simultaneous arrivals cannot corrupt the data.', 'P0', B],
    ['FR-12', 'Travel speed between consecutive attempts is computed; unusual speed is flagged and impossible speed is blocked.', 'P0', B],
    ['FR-13', 'Mock-location flags are read where the browser exposes them, and a check-in reporting a mock location is <b>rejected</b>.', 'P0', B],
    ['FR-14', 'The live occupancy count appears on every dashboard and the monitor, refreshes every 5–10 seconds, counts only verified active visits, and shows pending check-ins separately.', 'P0', B],
    ['FR-15', 'Check-in is accepted only during the lab’s operating hours; staff can override with a logged reason.', 'P0', B],
    ['FR-16', 'Presence Confidence: each check-in is Green, Amber or Red with a stored reason; Amber goes to a review queue.', 'P1', B],
    ['FR-17', 'Consume-and-Refresh: the monitor shows a new QR within about two seconds of a successful scan.', 'P1', B],
    ['FR-18', 'Self-Healing Occupancy: forgotten visits are auto-closed and labelled, and occupancy is reconciled on a timer.', 'P1', B],
])
fr('5.3 Assets and booking', [
    ['FR-19', 'The catalog holds GPU workstations (RTX 4090 / A100), IoT hardware (ESP32, Raspberry Pi, LoRaWAN gateways) and sensors (ultrasonic, thermal, LiDAR, gas). Each item has a unique ID, category, status and condition.', 'P0', B],
    ['FR-20', 'Students see a public availability list (Available / Reserved / Issued) with no borrower details.', 'P0', B],
    ['FR-21', 'A booking request is accepted only from a student whose status is currently CHECKED_IN with a verified visit to that lab.', 'P0', B],
    ['FR-22', 'Staff confirm the physical handover and return. The system records who issued, who borrowed, issue time, due time, return time and condition.', 'P0', B],
    ['FR-23', 'Overdue items are flagged automatically. Borrowers get reminder emails and staff see an overdue list.', 'P0', B],
    ['FR-24', 'Staff can add, edit or remove inventory records, and each action is audit-logged.', 'P0', B],
    ['FR-25', 'Students can see their own borrowing history and visit history.', 'P0', B],
])
fr('5.4 Live monitoring', [
    ['FR-26', 'Staff see a live activity stream (check-ins, check-outs, issues, returns, security events) and current occupancy.', 'P0', B],
    ['FR-27', 'Faculty see the roster for their active course or event (Present · Pending review · Not yet arrived), verify attendance live (including manual present or absent with a reason), and export the session log.', 'P0', B],
    ['FR-28', 'Live Lab Map: a floor plan showing workstation and asset status from stored records, labelled “based on app records, not physical sensors”.', 'P1', B],
])
fr('5.5 Reports and exports', [
    ['FR-29', 'Daily operational digest: unique visits, peak occupancy hours, hourly attendance distribution, pending or unreturned items.', 'P0', B],
    ['FR-30', 'Monthly institutional audit: course-wise student-hours, GPU workstation utilisation, sensor turnover frequency.', 'P0', B],
    ['FR-31', 'Custom report and export for any start–end date range (multi-day workshops, hackathons, assessment weeks).', 'P0', B],
    ['FR-32', 'A Google Docs template is filled and saved as a PDF in Drive. CSV and Excel (.xlsx) exports are ERP-ready: one flat table, fixed column names, ISO dates.', 'P0', 'Built; verify on deployment'],
    ['FR-33', 'A scheduled end-of-day summary email goes to the Lab In-charge through GmailApp.', 'P0', 'Built; verify on deployment'],
    ['FR-34', 'Lab Passport: a one-page PDF of a student’s verified hours, courses and equipment handled.', 'P2', 'Built; verify on deployment'],
])
fr('5.6 Administration', [
    ['FR-35', 'Super Admin sets lab coordinates, radius, operating hours and system constants (stored in PropertiesService), per lab.', 'P0', B],
    ['FR-36', 'Super Admin manages role permissions and views the audit log.', 'P0', B],
])
fr('5.8 Supervisor briefing additions (version 1.4)', [
    ['FR-37', 'Six roles: Student, Faculty, Lab Staff, Coordinator, HOD (read-only) and Super Admin, enforced on the server for every request. Coordinators manage student accounts only; only the Super Admin changes other roles.', 'P0', B],
    ['FR-38', 'Check-in records the system used (lab computer, GPU node, 3D printer, drone, or own laptop) and the project for extra-hours visits. A live view lists everyone inside with register number, system, project and time in; systems in use show on the Lab Map.', 'P0', B],
    ['FR-39', 'Projects have a title, description, members, start and end date (timeline), status and a submitted outcome with an optional link. Check-out asks what was done; each project shows a work log and total hours.', 'P0', B],
    ['FR-40', 'Students reserve equipment for a time slot inside opening hours (length and advance limits are settings). Overlapping requests join a first-come waitlist with a visible position; cancellations and no-shows promote the next person, who is emailed. A session starts only when the student is checked in.', 'P0', B],
    ['FR-41', 'Lookup by register number or email: days in the lab, total hours, visits by day, systems used and projects. Students see their own totals.', 'P0', B],
    ['FR-42', 'Lookup by system or item: number of different users, number of uses, total hours, and each use with person, purpose or project.', 'P0', B],
    ['FR-43', 'For timetabled sessions, the roster marks enrolled students who did not attend as Missing once the session ends; the session faculty is emailed the list once; it can be downloaded as CSV.', 'P0', B],
    ['FR-44', 'Nightly per-person and per-item daily summaries; monthly, closed rows older than a configurable number of months move to a yearly archive spreadsheet without changing totals.', 'P0', B],
    ['FR-45', 'Nightly backup copy of the spreadsheet, keeping the last N daily copies and one per older month.', 'P0', 'Built; verify on deployment'],
    ['FR-46', 'Phone numbers are stored encrypted with integrity protection; only Super Admin, Coordinator and staff following up a loan see the full number; others see a masked form; exports never include it.', 'P0', B],
    ['FR-47', 'Server-side validation of register numbers (e.g. URK24CS1249), names, phone numbers, emails, dates, slot times and text lengths; control characters are stripped.', 'P0', B],
    ['FR-48', 'The catalog includes 3D printers, drones and lab computers with graphics cards, in addition to the proposal’s GPU nodes, IoT boards and sensors.', 'P0', B],
])

h2('5.7 How the report numbers are calculated')
table(['Metric', 'Definition'], [
    ['Unique visits', 'Different people with at least one verified visit that day'],
    ['Peak occupancy hours', 'The three hours with the highest number of verified people inside at once'],
    ['Hourly distribution', 'For each hour, the number of different people present at any time in that hour'],
    ['Course-wise student-hours', 'Sum of (check-out minus check-in) for verified visits tagged to that course, clipped to the period; auto-closed visits count only up to the time they were closed; unlisted sessions are reported under the code and name the student entered'],
    ['GPU workstation utilisation', 'Hours reserved or issued, within operating hours, divided by operating hours available in the period'],
    ['Sensor turnover frequency', 'Issue-and-return cycles for a sensor type divided by the number of units of that type'],
], [48, 122])

# ---------------------------------------------------------------- 6 dashboards
h1('6. Dashboard Designs')
p('Every dashboard shows the live counter (“N inside · M pending”) and handles loading, empty, error and permission-denied states.')
for title, items in [
    ('6.1 Student (phone-first)', [
        '<b>Top:</b> status card: <i>Not checked in</i> with a Scan button, or <i>Checked in · 1h 12m</i> with a Check-out button and, if pending, a note that a review is waiting.',
        '<b>Middle:</b> “Free right now” chips (for example <i>2 GPU nodes · 5 ESP32 · 1 LiDAR</i>) and a request button that stays disabled until the check-in is verified, with a note explaining why; the Live Lab Map.',
        '<b>Bottom:</b> borrowed items with due dates, recent visits; full history and Lab Passport on a second tab.']),
    ('6.2 Faculty', [
        '<b>Left:</b> today’s sessions and the active roster, split into <i>Present · Pending review · Not yet arrived</i>, with manual present/absent.',
        '<b>Right:</b> pending reviews with Confirm and Decline buttons and the reason each was flagged.',
        '<b>Footer:</b> export the session log (CSV or PDF).']),
    ('6.3 Lab Staff', [
        '<b>Top strip:</b> inside now (+ pending), items out, overdue count, pending requests, pending reviews.',
        '<b>Left:</b> live activity stream. <b>Centre:</b> Live Lab Map and who is inside. <b>Right:</b> the handshake panel to confirm an issue with a due time or mark a return with its condition.',
        '<b>Tabs:</b> Reviews, Inventory, Courses &amp; events, Reports (daily, monthly, date range, CSV and Excel export).']),
    ('6.4 Super Admin', [
        '<b>Settings:</b> lab location (with a <i>use my current location</i> helper), radius, operating hours, thresholds, monitor link, background jobs.',
        '<b>People:</b> role management. <b>Permissions:</b> grant delegable actions to more roles.',
        '<b>Audit:</b> security events and the audit log, filterable by actor, action and date.']),
]:
    h2(title)
    bullets(items)
h2('6.5 Lab Monitor (wall display)')
p('A clean full-screen page with a large QR, a countdown ring, the verified count with pending beside it, and a '
  'visible <i>Online / Offline</i> indicator. When offline it hides the code rather than show a stale one.')

# ---------------------------------------------------------------- 7 data
h1('7. Data Design')
p('Google Sheets is the database: one tab per kind of record, unique IDs, fixed status words, and a lab ID on every row.')
table(['Tab', 'Holds', 'Key fields'], [
    ['Users', 'Everyone with access', 'user_id, email, name, roll/employee ID, mobile, role, active'],
    ['Config', 'Per-lab settings (mirrored in Script Properties)', 'lab_id, coordinates, radius, hours, thresholds; secrets stay in Script Properties'],
    ['CoursesEvents', 'Sessions people can check in to', 'id, type, code, name, coordinator, days, start/end time and date, session hours'],
    ['Enrollments', 'Expected attendees per session', 'session_id, user_email'],
    ['Visits', 'Attendance history', 'visit_id, user_id, lab_id, entry_type, course_or_event_id, purpose, details, check_in_at, check_out_at, is_valid_geofence, confidence, review_status, close_type, status'],
    ['ActiveVisits', 'People inside now, for fast checks', 'visit_id, user_id, lab_id, check_in_at, review_status'],
    ['AttendanceMarks', 'Faculty manual present/absent', 'session_id, date, user_email, mark, reason, marked_by'],
    ['Assets', 'Inventory', 'asset_id, name, category, type, status, condition, location, map position'],
    ['Requests', 'Booking requests', 'request_id, asset_id, requester_id, window, status, decided_by, decided_at'],
    ['Loans', 'Issued items', 'loan_id, asset_id, borrower_id, issued_by, issued_at, due_at, returned_at, return_condition, status'],
    ['AuditLog', 'Append-only history', 'event_id, timestamp, actor, role, action, target, outcome, reason'],
    ['Projects', 'Student projects', 'project_id, title, description, owner, members, start_date, end_date, status, outcome, outcome_link'],
    ['Bookings', 'Time-slot reservations and queue', 'booking_id, asset_id, user, project_id, start_at, end_at, purpose, status (BOOKED, WAITLIST, IN_USE, DONE, CANCELLED, NO_SHOW)'],
    ['UsageDaily', 'Nightly summary per person per day', 'date, lab_id, email, visits, minutes, first in, last out, projects, systems'],
    ['AssetUsageDaily', 'Nightly summary per item per day', 'date, lab_id, asset_id, uses, minutes, users, purposes'],
    ['(Archive YYYY)', 'Separate yearly spreadsheet', 'Same tabs as above for rows moved out of the live spreadsheet'],
], [30, 50, 90])
p('<b>Rules.</b> IDs are unique and required fields are validated before every write. An asset with an active loan '
  'cannot be given to someone else. Occupancy is always calculated from active visits, never typed in, and '
  'ActiveVisits is rebuilt from Visits during reconciliation. Audit rows are only added by the application; because '
  'the sheet owner can still edit by hand, sharing settings are kept private. The script time zone is Asia/Kolkata.')

# ---------------------------------------------------------------- 8 security
h1('8. Security and Privacy')
table(['Attempt', 'Our defence', 'How we test it'], [
    ['Sharing a screenshot of the QR', 'Short expiry, signed token, single-use consumption', 'Scan the same token twice; the second must fail (AT-03)'],
    ['Checking in from the hostel', 'Geofence, accuracy check, travel-speed check', 'Send coordinates outside the radius; expect Red'],
    ['Fake GPS app', 'Mock-location rejection where exposed; travel-speed check', 'Send a mock flag; expect Red'],
    ['Double-tapping or two phones at once', 'LockService, active-visit check, request IDs', 'Fire repeated requests; expect exactly one visit (AT-04)'],
    ['Calling an admin function directly', 'Server-side role check on every endpoint, including doPost', 'Call each endpoint as each role; expect denial (AT-07, AT-11)'],
    ['Borrowing without being in the lab', 'Verified CHECKED_IN gate on the server', 'Request while checked out, and while pending review; expect rejection (AT-06)'],
    ['Equipment never returned', 'Due dates, overdue flag, reminders, audit trail', 'Create a loan with a past due date (AT-08)'],
    ['Reading phone numbers from the sheet', 'Encrypted at rest (enc:v1), masked in most screens, tamper detected', 'Inspect the Users sheet; edit a cell and expect a “damaged” warning'],
    ['Private data in an export', 'Field minimisation (no mobile numbers) and role-restricted exports', 'Check export contents per role'],
], [42, 64, 64])
p('<b>Privacy.</b> Raw coordinates are never stored or logged. Public inventory views never show borrower names or '
  'phone numbers. Exports are limited by role, and retention periods will be agreed with the institution.')
p('<b>Known limitations.</b> GPS can be wrong indoors, browser mock-location detection is patchy, and software alone '
  'cannot stop a determined person who is physically present. LabPulse makes misuse harder, visible and auditable; '
  'it does not claim to make it impossible.')

# ---------------------------------------------------------------- 9 NFR
h1('9. Non-Functional Requirements')
table(['Area', 'What we commit to'], [
    ['<b>Speed</b>', 'Ordinary actions feel quick; our test target is about 3 seconds under the load agreed with the supervisor. This is a target to measure, not a Google guarantee.'],
    ['<b>Reliability</b>', 'Retries never create duplicates. Occupancy and loan states can always be rebuilt from stored records.'],
    ['<b>Ease of use</b>', 'A first-time student can check in without instructions. Status colours are consistent and always paired with a word.'],
    ['<b>Compatibility</b>', 'Current Chrome, Edge, Safari and Firefox on phone and laptop, with location enabled.'],
    ['<b>Scalability</b>', 'Load-test against Apps Script and Sheets quotas. If limits are not enough, document it and ask for approval before changing the platform.'],
    ['<b>Maintainability</b>', 'Modular code, named constants, documented sheet columns, version control, automated tests, a nightly backup copy of the spreadsheet.'],
], [36, 134])

# ---------------------------------------------------------------- 10 testing
h1('10. Testing and Demo Plan')
h2('10.1 Acceptance tests')
p('Each acceptance test is automated. The tests run the real server code against in-memory stand-ins for Sheets, '
  'CacheService, LockService, PropertiesService and Session, with a controllable clock. Results as of 18 October 2026:')
at = [
    ['AT-01', 'Sign in with an outside Gmail account', 'Rejected'],
    ['AT-02', 'Valid QR, inside radius', 'Green check-in'],
    ['AT-03', 'Expired, malformed and reused QR', 'All rejected'],
    ['AT-04', 'Two simultaneous check-ins by one user', 'One active visit'],
    ['AT-05', 'Check in and out repeatedly', 'Occupancy always correct'],
    ['AT-06', 'Booking request while checked out or pending review', 'Blocked'],
    ['AT-07', 'Student tries to approve a loan', 'Denied'],
    ['AT-08', 'Loan past its due date', 'Overdue, reminded, in the digest'],
    ['AT-09', 'Reports against known test data', 'Totals match'],
    ['AT-10', 'PDF generation and daily email', 'PDF in Drive, email delivered'],
    ['AT-11', 'Unauthorised role change or export', 'Denied and logged'],
    ['AT-12', 'Inspect all sheets after check-in', 'No raw coordinates anywhere'],
    ['AT-13', 'Poor GPS accuracy', 'Amber, shown as pending, in review queue; counted after confirm'],
    ['AT-14', 'Forget to check out', 'Visit auto-closes and is labelled'],
    ['AT-15', 'Check in outside operating hours', 'Rejected; staff override is logged'],
]
table(['ID', 'Test', 'Expected', 'Result'],
      [r + (['Logic passes; real Docs/Gmail to verify after deployment'] if r[0] == 'AT-10' else ['Pass']) for r in at],
      [16, 64, 52, 38])
p('In total <b>68 automated checks</b> pass: <b>37 server tests</b> (the 15 above plus token forgery, travel speed, '
  'idempotent retries, reconciliation, role overrides, unlisted sessions, Excel export, doPost and export '
  'minimisation), <b>18 tests for the supervisor’s briefing</b> (roles, HOD read-only, systems and projects, the '
  'reservation queue and no-shows, lookups, rollups and archiving, encryption and tamper detection, validation, the '
  'missing list) and <b>13 UI tests</b> (every dashboard for every role, phone check-in flows, reservations, lookups, '
  'the handshake and the lab monitor, rendered against the real server code).')
h2('10.2 Still to verify on the deployed app')
bullets([
    'Real Google Docs to PDF, Drive files, Excel export and Gmail delivery (AT-10).',
    'GPS and Google sign-in inside the Apps Script frame on real Android phones and iPhones.',
    'Identity for both @karunya.edu and @karunya.edu.in under the chosen deployment (Section 13, question 1).',
    'Apps Script quota use with a full class arriving at once.',
])
h2('10.3 Demonstration scenario')
bullets([
    'The monitor shows the QR. A student scans and checks in; the counter goes up on the faculty screen.',
    'Re-scan the same QR on a second phone. It is rejected and logged; the monitor already shows a new code.',
    'A student with poor GPS lands in Amber and appears as “pending” beside the counter; faculty confirm with one tap and the counter goes up.',
    'A student whose course is not in the timetable types its code, name and hours; lab staff confirm it.',
    'The checked-in student requests a Raspberry Pi; staff issue it and the Lab Map updates. A past-due loan shows as overdue.',
    'Generate the daily PDF report and an Excel export.',
], numbered=True)

# ---------------------------------------------------------------- 11 plan
h1('11. Plan to the Deadline')
table(['When', 'Focus', 'Status'], [
    ['14 Oct', 'Submit SRS v1.2. Apps Script project, sheets and sign-in.', 'Done'],
    ['15–16 Oct', 'Roles, settings, QR generation and validation.', 'Done'],
    ['17–18 Oct', 'Geofence, check-in and check-out, occupancy, confidence scoring. Align with the client proposal (v1.3).', 'Done'],
    ['19 Oct', 'Supervisor briefing: Coordinator and HOD roles, systems and projects, reservation queue, lookups, archiving, encryption, missing list (v1.4).', 'Done'],
    ['20 Oct', 'Deploy to Google. Test on real phones in the lab; tune radius and accuracy thresholds.', 'Next'],
    ['21 Oct', 'Verify PDF, Excel, email and triggers on the deployment; load test.', 'Planned'],
    ['22 Oct', 'Demo data, bug fixes. Review-ready.', 'Planned'],
    ['23 Oct', 'Freeze at 5 PM. Final fixes only. Submission.', 'Planned'],
], [24, 116, 30])
p('Because the build is ahead of plan, the remaining days go to deployment and real-device testing, which is where '
  'the remaining risk lies. Rule: P0 first, then P1, then P2.')

# ---------------------------------------------------------------- 12 risks
h1('12. Risks and Limitations')
table(['Risk', 'What could happen', 'What we do'], [
    ['Apps Script quotas and speed', 'A busy class slows check-ins', 'Locks, batched reads and writes, cache-only monitor, a load test, documented limits'],
    ['Indoor GPS drift', 'Honest students rejected', 'Amber review path and tunable thresholds'],
    ['Single-use QR throughput', 'Queue at the door', 'Consume-and-Refresh, measured; fallbacks need approval'],
    ['Location or sign-in behaves differently on some phones (sandboxed frame)', 'Check-in fails for some users', 'Early testing on Android and iPhone; staff-assisted check-in as fallback'],
    ['Two Google Workspace domains', 'One domain cannot be identified', 'Confirm with IT before the demo (question 1)'],
    ['Monitor or network outage', 'Nobody can check in', 'Visible offline state and a manual fallback; never silent attendance'],
], [50, 45, 75])

# ---------------------------------------------------------------- 13 questions
h1('13. Questions for the Supervisor')
bullets([
    'Are @karunya.edu and @karunya.edu.in in the same Google Workspace? The deployed app can identify users only from the deploying account’s Workspace.',
    'What are the exact lab coordinates and radius, and is staff-assisted manual entry the accepted fallback when a student refuses location permission?',
    'Must students always check out? Which attendance corrections need approval beyond the audit log?',
    'What are the booking windows, loan duration, reminder schedule and rules for damaged items?',
    'Who receives reports, how long is data kept, and who can see exports?',
    'How many users and labs, and what peak arrival rate should we design for?',
    'Are the added ideas (Presence Confidence, Lab Map, Lab Passport) part of the assessed scope, or extras?',
    'Is a read-only HOD view the intended scope, and who should hold the Coordinator role for the Intel Unnati IoT Lab?',
    'How long should archived years and backups be kept (defaults: archive after 3 months, keep 14 daily backups plus one per month)?',
], numbered=True)
story.append(Spacer(1, 8))
p('<i>Status statement: all requirements in this document are implemented and pass automated tests on local '
  'stand-ins for Google services. The system has not yet been deployed to Google Apps Script or tested on real '
  'phones; Section 10.2 lists what remains to verify.</i>')

doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=20 * mm,
                        title='LabPulse – Software Requirements Specification v1.4', author='Team LabPulse')
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)
