# LabPulse — What We Have Built So Far

Oct 21, 2026 · @Aathi

LabPulse is built, tested and saved on GitHub; the one big step left is putting it live on Google Apps Script and testing it with real phones in the lab.

## In one minute

LabPulse replaces the lab's paper register with a website that proves who is really in the lab and records what they do there.

Today the lab runs on a paper register: friends sign in for each other, nobody knows how many people are inside, and borrowed equipment goes missing. LabPulse fixes this in four ways:

- **Real attendance.** Students scan a QR code on the lab screen; their phone's location confirms they are actually inside.
- **Live view.** Anyone allowed can see, even from home, who is in the lab, on which computer or machine, and on which project.
- **Equipment tracking.** 3D printers, drones, GPU computers, Raspberry Pis and sensors can be reserved, issued and returned, with a queue when they are busy.
- **Records and reports.** Hours per student, use per machine, daily and monthly reports, Excel and PDF exports.

It runs entirely on free Google tools (Google Apps Script and Google Sheets), so it costs nothing to run. It starts in the Intel Unnati IoT Lab and can be added to every lab in the department.

## What we did, step by step

We went from a plan on paper to a working, tested system in ten steps.

| Step | What we did | Result |
| --- | --- | --- |
| 1 | Read our SRS v1.2 (the plan) | Clear list of what to build |
| 2 | Wrote the app for Google Apps Script | Working attendance, equipment and report features |
| 3 | Wrote automatic tests | The computer checks every feature for us |
| 4 | Built a laptop preview | We can try the app without a Google account |
| 5 | Compared our plan with the client's GeoFence proposal | Found 8 small gaps |
| 6 | Closed those gaps and wrote SRS v1.3 | App and document match the client's needs |
| 7 | Saved everything to GitHub | Code is safe online |
| 8 | Fixed the QR scan error on phones | A phone on the same Wi-Fi can scan the laptop's QR |
| 9 | Added everything from the supervisor's two voice messages | New roles, projects, queue, lookups, encryption and more |
| 10 | Wrote SRS v1.4 and saved the new version to GitHub | 68 automatic checks pass |

The QR error in step 8 happened because the laptop preview's QR held a "localhost" link, which on a phone means the phone itself. It now holds the laptop's Wi-Fi address.

## How it works: one student's visit

A check-in takes about ten seconds and needs only the phone's normal camera.

1. **The QR code.** A screen on the lab wall shows a QR code that changes every 8 seconds. Each code works only once, so a photo of it is useless.
2. **Scan.** The student scans it with their phone camera; LabPulse opens, already signed in with their Karunya Google account.
3. **Location.** The phone shares its location once. LabPulse checks the student is within 20 m of the lab, then throws the location away; only "inside: yes/no" is saved.
4. **Reason.** The student picks why they are here: a regular lab course, an event, or their own research (extra hours).
5. **System and project.** They pick which machine they are working on (lab PC, GPU node, 3D printer, drone or own laptop) and, for extra hours, which project.
6. **Result.** LabPulse answers with one of three colours:
   - **Green**: checked in; the "inside" count goes up.
   - **Amber**: probably fine but the GPS was weak; a teacher or lab staff confirms with one tap.
   - **Red**: rejected (too far away, QR already used, or a fake-GPS app).
7. **In the lab.** The student can reserve equipment, borrow items from staff, and see their own hours.
8. **Check-out.** One tap, with an optional note of what they did today, which goes into their project's work log.
9. **Forgot to check out?** LabPulse closes the visit automatically when the session ends or the lab closes.
10. **Every night.** A report is made and emailed to the lab in-charge, the data is summarised, and the spreadsheet is backed up.

## Who uses it

LabPulse has six roles, and each person sees only the screens their role allows.

| Role | What they can do |
| --- | --- |
| Student | Check in and out by QR; see own hours and days; create projects with a timeline and outcome; reserve equipment slots; borrow items; see history |
| Faculty | See their class roster: present, waiting for review, and missing; confirm weak-GPS check-ins; mark attendance; export; get an email listing missing students after class |
| Lab staff | Run the wall screen; hand over and take back equipment; start and finish reserved sessions; make supervised manual entries |
| Coordinator | Everything lab staff can do, plus add or remove equipment and students, manage courses, look up students and machines, see reports |
| HOD | See everything in every lab (live, projects, lookups, reports) but change nothing |
| Super Admin | Give people roles; set the lab's location, radius and hours; see the security log |

The roles are checked on the server for every action, so hiding a button is never the only protection.

## What the supervisor asked for

Every point from the supervisor's two voice messages is built.

| The supervisor said | What LabPulse does |
| --- | --- |
| See from home who is in the lab, on which system, on which project | A live list: name, register number, machine, project, time in |
| QR scan plus GPS to mark attendance; sign out when leaving | QR on the wall screen, location check, one-tap check-out, auto check-out if forgotten |
| 3D printers, drones, GPU computers used by time slot, with a queue | Students reserve a slot; if taken they join a waitlist and get an email when it frees up; no-shows lose the slot |
| Record the project, its timeline and its outcome | Projects with team, start and end dates, a daily work log, and a submitted outcome |
| Given a register number: days and hours in the lab | Lookup by register number: days, total hours, day-by-day list, machines, projects |
| Given a system: how many people used it and why | Lookup by machine: number of people, hours, and who used it for what |
| Regular class (e.g. Web Technology at 11 am): who is missing | Faculty roster shows "Missing"; faculty get an email with the list after class |
| Data in Google Sheets with backups; don't overload one sheet | Nightly summaries, monthly archive of old records to a yearly sheet, nightly backups |
| Encrypt sensitive data like phone numbers; validate input | Phone numbers stored encrypted; register numbers, names and phones are checked |
| Roles: student, coordinator, HOD, super admin | Six roles, listed in the section above |

## How we know it works

All 68 automatic checks pass, and the whole app can be tried on a laptop today.

| Check | Count | What it covers |
| --- | --- | --- |
| Original tests | 37 | The 15 acceptance tests from our SRS (wrong accounts rejected, reused QR rejected, location checks, equipment rules, reports, no stored locations) and more |
| New feature tests | 18 | Roles, systems and projects, the reservation queue, lookups, archiving, encryption, the missing list |
| Screen tests | 13 | Every role's screens, the phone check-in, reservations, lookups and the wall screen |

**The laptop preview.** Running `npm run preview` starts the app on the laptop with demo data. You open it at http://localhost:8787, pick who you are (student, faculty, staff, coordinator, HOD or admin) and use it like the real thing. A phone on the same Wi-Fi can scan the wall-screen QR.

**What the tests cannot prove yet:** real phone GPS, PDF reports, emails, Excel files and backups only run once the app is live on Google Apps Script.

## Where everything is

Everything is saved on GitHub at [github.com/aathishreesenthilkumar/LabPulse](https://github.com/aathishreesenthilkumar/LabPulse).

| Folder or file | What it holds |
| --- | --- |
| `src/` | The app itself: this is what goes onto Google Apps Script |
| `docs/LabPulse_SRS_v1.4.pdf` | The requirements document to submit, matched to the client proposal and the supervisor's messages |
| `tests/` | The 68 automatic checks |
| `dev/preview.js` | The laptop preview |
| `README.md` | Setup and deployment instructions |

To try it on a laptop: install Node.js, open the project folder, run `npm install` once, then `npm run preview`, and open http://localhost:8787.

## Words we use

Each term in this document, in plain English.

| Term | What it means |
| --- | --- |
| Google Apps Script | Google's free tool for running small programs and websites; LabPulse runs on it, so there is no server cost |
| Google Sheets (as the database) | Every record (people, visits, equipment, bookings) is stored as rows in a private Google Sheet |
| Wall screen / lab monitor | A screen in the lab that shows the check-in QR code and how many people are inside |
| Rotating single-use QR | The QR code changes every 8 seconds and each code works only once, so a photo or forwarded screenshot cannot be used |
| Geofence | An invisible circle (15–20 m) around the lab; a check-in counts only if the phone is inside it |
| Green / Amber / Red | The check-in result: Green = accepted, Amber = accepted but needs a teacher's one-tap confirmation, Red = rejected |
| Fake-GPS check | Rejects a check-in when the phone reports a fake location, or when the person seems to move impossibly fast |
| Live count ("inside") | Number of confirmed people in the lab now; check-ins awaiting confirmation are shown separately as "pending" |
| System | The machine a student works at during a visit: lab PC, GPU node, 3D printer, drone, or their own laptop |
| Project | A student's piece of work with a team, start and end dates, a daily work log and a final outcome |
| Reservation and waitlist | Booking a machine for a time slot; if the slot is taken you join a queue and are emailed when it frees up |
| No-show | A reserved slot not used within 15 minutes; it passes to the next person in the queue |
| Handshake | Lab staff confirming in the app that they physically handed over, or got back, an item |
| Lookup | Searching a register number (days and hours in the lab) or a machine (who used it, how long, why) |
| Missing list | Students enrolled in a class session who did not check in; emailed to the faculty after class |
| Daily summary | One small row per person and per machine per day, written every night so lookups stay fast |
| Archive | Every month, records older than 3 months move to a separate yearly spreadsheet so the main one stays fast |
| Backup | A full copy of the spreadsheet every night; the last 14 days plus one per month are kept |
| Encryption | Phone numbers are stored scrambled; only the admin, the coordinator and staff following up a loan can see them |
| Audit log | A record of every sensitive action (role changes, manual entries, rejected scans) that cannot be edited from the app |
| Laptop preview | A copy of LabPulse that runs on a laptop with demo data, for trying and showing the app without Google |
| SRS | Software Requirements Specification: our formal document of what the system must do (now version 1.4) |

## Still to do

The main remaining work is going live on Google and testing in the real lab.

- [ ] Put LabPulse on Google Apps Script using a Karunya Google account (a personal Gmail cannot identify other users)
- [ ] Set the lab's exact location, radius and hours, standing in the Intel Unnati IoT Lab
- [ ] Test check-in with real Android phones and iPhones in the lab
- [ ] Check that PDF reports, emails, Excel exports and backups work on Google
- [ ] Ask the supervisor: are @karunya.edu and @karunya.edu.in in the same Google Workspace?
- [ ] Decide on a unique extra feature to stand out from other teams
- [ ] Rehearse the demo with the team
