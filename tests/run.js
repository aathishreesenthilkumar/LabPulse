/**
 * Acceptance tests (SRS §10.1) and supporting checks, run against the real server code
 * with in-memory Google services.  Usage: node tests/run.js
 */
'use strict';
const assert = require('assert');
const { INSIDE, EDGE, FAR, HOSTEL, world, scan, checkIn, auditActions } = require("./fixtures");

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, name, e]);
  }
}


/* ------------------------------------------------------------------ */

test('AT-01 outside Gmail account is rejected and logged', () => {
  const env = world();
  const r = env.as('someone@gmail.com')('bootstrap');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'DOMAIN');
  assert.ok(auditActions(env).includes('SECURITY_DOMAIN_REJECT'));
});

test('FR-02 registration validates fields and unique roll number', () => {
  const env = world();
  const bad = env.as('new@karunya.edu.in')('register', { name: 'X', reg_no: '!', mobile: '123' });
  assert.strictEqual(bad.code, 'INVALID');
  const dup = env.as('new@karunya.edu.in')('register', { name: 'New Person', reg_no: 'URK24CS1001', mobile: '9876500099' });
  assert.strictEqual(dup.code, 'INVALID');
  const unreg = env.as('new@karunya.edu.in')('status');
  assert.strictEqual(unreg.code, 'NOT_REGISTERED');
  const ok = env.as('new@karunya.edu.in')('register', { name: 'New Person', reg_no: 'URK24CS1999', mobile: '+91 98765 00099' });
  assert.ok(ok.ok);
  assert.strictEqual(ok.data.mobile, '••••••0099', 'only a masked number leaves the server');
  assert.strictEqual(ok.data.role, 'STUDENT');
});

test('AT-02 valid QR inside radius gives a Green check-in and occupancy rises', () => {
  const env = world();
  const { claim } = scan(env, 's1@karunya.edu.in');
  assert.ok(claim.ok, JSON.stringify(claim));
  const r = checkIn(env, 's1@karunya.edu.in', INSIDE);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.data.outcome, 'GREEN');
  const occ = env.as('faculty@karunya.edu')('occupancy', { labId: 'AIIOT' });
  assert.strictEqual(occ.data.occupancy, 1);
});

test('AT-03 expired, malformed and reused QR codes are all rejected', () => {
  const env = world();
  const first = scan(env, 's1@karunya.edu.in');
  assert.ok(first.claim.ok);
  env.session.active = 's2@karunya.edu.in';
  const reused = env.ctx.Attendance.claim(env.ctx.Auth.context(), first.token);
  assert.strictEqual(reused.code, 'QR_REUSED');

  const malformed = env.ctx.Attendance.claim(env.ctx.Auth.context(), 'AIIOT.123.zzz.nope');
  assert.strictEqual(malformed.code, 'QR_INVALID');
  const forged = first.token.slice(0, -3) + 'AAA';
  assert.strictEqual(env.ctx.Attendance.claim(env.ctx.Auth.context(), forged).code, 'QR_INVALID');

  const tick = env.as('staff@karunya.edu')('monitorTick', { labId: 'AIIOT' });
  env.advance(8 * 4);
  env.session.active = 's2@karunya.edu.in';
  assert.strictEqual(env.ctx.Attendance.claim(env.ctx.Auth.context(), tick.data.token).code, 'QR_EXPIRED');

  const actions = auditActions(env);
  assert.ok(actions.includes('SECURITY_QR_REUSED'));
  assert.ok(actions.includes('SECURITY_QR_INVALID'));
  assert.ok(actions.includes('SECURITY_QR_EXPIRED'));
});

test('FR-17 monitor shows a fresh QR as soon as one is consumed', () => {
  const env = world();
  const staff = env.as('staff@karunya.edu');
  const a = staff('monitorTick', { labId: 'AIIOT' }).data.token;
  assert.strictEqual(staff('monitorTick', { labId: 'AIIOT' }).data.token, a, 'same QR until used');
  env.session.active = 's1@karunya.edu.in';
  env.ctx.Attendance.claim(env.ctx.Auth.context(), a);
  const b = staff('monitorTick', { labId: 'AIIOT' }).data.token;
  assert.notStrictEqual(a, b);
});

test('check-in without scanning is refused', () => {
  const env = world();
  const r = checkIn(env, 's1@karunya.edu.in', INSIDE);
  assert.strictEqual(r.code, 'NO_TICKET');
});

test('AT-04 retries and double taps create exactly one visit', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  const r1 = checkIn(env, 's1@karunya.edu.in', INSIDE, null, { requestId: 'abc-1' });
  const r2 = checkIn(env, 's1@karunya.edu.in', INSIDE, null, { requestId: 'abc-1' });
  assert.deepStrictEqual(r1, r2);
  scan(env, 's1@karunya.edu.in');
  const r3 = checkIn(env, 's1@karunya.edu.in', INSIDE, null, { requestId: 'abc-2' });
  assert.strictEqual(r3.data.outcome, 'EXISTING');
  assert.strictEqual(env.rows('Visits').length - 1, 1);
  assert.strictEqual(env.rows('ActiveVisits').length - 1, 1);
});

test('FR-11 a held lock makes concurrent writers back off instead of corrupting data', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  const lock = env.ctx.LockService.getScriptLock();
  lock.tryLock(1);
  const r = checkIn(env, 's1@karunya.edu.in', INSIDE);
  lock.releaseLock();
  assert.strictEqual(r.code, 'BUSY');
  assert.strictEqual(env.rows('Visits').length - 1, 0);
});

test('AT-05 repeated check-in and check-out keeps occupancy equal to active visits', () => {
  const env = world();
  const students = ['s1@karunya.edu.in', 's2@karunya.edu.in', 's3@karunya.edu.in'];
  for (let round = 0; round < 3; round++) {
    students.forEach((s) => {
      scan(env, s);
      checkIn(env, s, INSIDE);
    });
    let occ = env.as('staff@karunya.edu')('occupancy', { labId: 'AIIOT' }).data.occupancy;
    assert.strictEqual(occ, 3);
    assert.strictEqual(occ, env.rows('ActiveVisits').length - 1);
    env.as(students[round])('checkOut', {});
    occ = env.as('staff@karunya.edu')('occupancy', { labId: 'AIIOT' }).data.occupancy;
    assert.strictEqual(occ, 2);
    students.forEach((s) => env.as(s)('checkOut', {}));
    assert.strictEqual(env.as('staff@karunya.edu')('occupancy', { labId: 'AIIOT' }).data.occupancy, 0);
    env.advance(60);
  }
  const notIn = env.as('s1@karunya.edu.in')('checkOut', {});
  assert.strictEqual(notIn.code, 'NOT_CHECKED_IN');
});

test('Red: clearly outside the radius is not checked in and is logged', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  const r = checkIn(env, 's1@karunya.edu.in', FAR);
  assert.strictEqual(r.data.outcome, 'RED');
  assert.match(r.data.reasons[0], /Outside the lab/);
  assert.strictEqual(env.rows('Visits').length - 1, 0);
  assert.ok(auditActions(env).includes('SECURITY_CHECKIN_RED'));
  // The scan was spent; a second attempt needs a new scan.
  assert.strictEqual(checkIn(env, 's1@karunya.edu.in', INSIDE).code, 'NO_TICKET');
});

test('Red: mock location flag blocks the check-in', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  const r = checkIn(env, 's1@karunya.edu.in', INSIDE, null, { mock: true });
  assert.strictEqual(r.data.outcome, 'RED');
});

test('FR-12 travel speed: hostel attempt then lab attempt is flagged or blocked', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  assert.strictEqual(checkIn(env, 's1@karunya.edu.in', HOSTEL).data.outcome, 'RED');
  env.advance(20); // 2 km in 20 s ≈ 360 km/h
  scan(env, 's1@karunya.edu.in');
  const blocked = checkIn(env, 's1@karunya.edu.in', INSIDE);
  assert.strictEqual(blocked.data.outcome, 'RED');
  assert.ok(blocked.data.reasons.some((x) => /Impossible travel/.test(x)));

  const env2 = world();
  scan(env2, 's2@karunya.edu.in');
  checkIn(env2, 's2@karunya.edu.in', HOSTEL);
  env2.advance(60); // ≈ 120 km/h: over the flag limit, under the block limit
  scan(env2, 's2@karunya.edu.in');
  const flagged = checkIn(env2, 's2@karunya.edu.in', INSIDE);
  assert.strictEqual(flagged.data.outcome, 'AMBER');

  const env3 = world();
  scan(env3, 's3@karunya.edu.in');
  checkIn(env3, 's3@karunya.edu.in', HOSTEL);
  env3.advance(15 * 60); // a 15-minute walk is fine
  scan(env3, 's3@karunya.edu.in');
  assert.strictEqual(checkIn(env3, 's3@karunya.edu.in', INSIDE).data.outcome, 'GREEN');
});

test('AT-06 booking request while checked out is blocked', () => {
  const env = world();
  const r = env.as('s1@karunya.edu.in')('requestAsset', { assetId: 'RPI-01' });
  assert.strictEqual(r.code, 'NOT_CHECKED_IN');
});

test('AT-07 a student cannot approve a loan; the attempt is logged', () => {
  const env = world();
  const r = env.as('s1@karunya.edu.in')('issueAsset', { requestId: 'R-X' });
  assert.strictEqual(r.code, 'FORBIDDEN');
  assert.ok(auditActions(env).includes('SECURITY_FORBIDDEN'));
});

test('FR-19–22 full asset lifecycle: request, issue, return damaged', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  const student = env.as('s1@karunya.edu.in');
  const req = student('requestAsset', { assetId: 'RPI-01', hours: 3 });
  assert.ok(req.ok, JSON.stringify(req));
  const pub = student('assetsPublic', { labId: 'AIIOT' }).data.find((a) => a.asset_id === 'RPI-01');
  assert.strictEqual(pub.status, 'RESERVED');
  assert.ok(!('borrower_email' in pub) && !('requester_email' in pub), 'no borrower details in public list');
  assert.strictEqual(env.as('s2@karunya.edu.in')('requestAsset', { assetId: 'RPI-01' }).code, 'NOT_CHECKED_IN');

  const staff = env.as('staff@karunya.edu');
  const loan = staff('issueAsset', { requestId: req.data.request_id, condition: 'GOOD' });
  assert.ok(loan.ok, JSON.stringify(loan));
  assert.strictEqual(loan.data.issued_by, 'staff@karunya.edu');
  assert.strictEqual(loan.data.borrower_email, 's1@karunya.edu.in');
  assert.ok(loan.data.due_at);
  const map = student('labMap', { labId: 'AIIOT' }).data;
  assert.strictEqual(map.cells.find((c) => c.asset_id === 'RPI-01').status, 'ISSUED');
  assert.match(map.note, /not physical sensors/);

  const ret = staff('returnAsset', { loanId: loan.data.loan_id, condition: 'DAMAGED' });
  assert.ok(ret.ok);
  assert.strictEqual(staff('inventory', { labId: 'AIIOT' }).data.find((a) => a.asset_id === 'RPI-01').status, 'MAINTENANCE');
  const mine = student('myItems').data;
  assert.strictEqual(mine.loans[0].status, 'RETURNED');
  assert.ok(auditActions(env).includes('ISSUE') && auditActions(env).includes('RETURN'));
});

test('AT-08 a loan past its due date is flagged, reminded and appears in the digest', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  const req = env.as('s1@karunya.edu.in')('requestAsset', { assetId: 'ESP-01', hours: 1 });
  const loan = env.as('staff@karunya.edu')('issueAsset', { requestId: req.data.request_id });
  env.advance(2 * 3600);
  env.session.active = '';
  const out = env.run('jobOverdue()');
  assert.strictEqual(out.marked, 1);
  assert.strictEqual(env.mail.length, 1);
  assert.strictEqual(env.mail[0].to, 's1@karunya.edu.in');
  const summary = env.as('staff@karunya.edu')('staffSummary', { labId: 'AIIOT' }).data;
  assert.strictEqual(summary.overdue, 1);
  const digest = env.as('staff@karunya.edu')('reportDaily', { labId: 'AIIOT', date: '2026-10-19' }).data;
  const unreturned = digest.sections.find((s) => s.heading === 'Unreturned items');
  assert.strictEqual(unreturned.rows[0][0], loan.data.loan_id);
  assert.strictEqual(unreturned.rows[0][4], 'OVERDUE');
  // A second hourly run does not resend within the reminder interval.
  env.session.active = '';
  env.run('jobOverdue()');
  assert.strictEqual(env.mail.length, 1);
});

test('AT-09 report totals match known test data', () => {
  const env = world();
  // s1 10:30–12:30, s2 11:00–11:30, s3 Amber and declined (must not count).
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  env.setIst('2026-10-19', '11:00');
  scan(env, 's2@karunya.edu.in');
  checkIn(env, 's2@karunya.edu.in', INSIDE);
  scan(env, 's3@karunya.edu.in');
  const amber = checkIn(env, 's3@karunya.edu.in', EDGE);
  assert.strictEqual(amber.data.outcome, 'AMBER');
  env.as('faculty@karunya.edu')('reviewVisit', { visitId: amber.data.visit.visit_id, decision: 'DECLINE', note: 'Not seen in class' });
  env.setIst('2026-10-19', '11:30');
  env.as('s2@karunya.edu.in')('checkOut', {});
  env.setIst('2026-10-19', '12:30');
  env.as('s1@karunya.edu.in')('checkOut', {});

  const daily = env.as('staff@karunya.edu')('reportDaily', { labId: 'AIIOT', date: '2026-10-19' }).data;
  const kpi = Object.fromEntries(daily.kpis);
  assert.strictEqual(kpi['Unique visitors'], 2);
  assert.strictEqual(kpi['Verified visits'], 2);
  assert.strictEqual(daily.peak.hour, 11);
  assert.strictEqual(daily.peak.count, 2);
  const h10 = daily.hours.find((h) => h.hour === 10);
  assert.strictEqual(h10.people, 1);

  const monthly = env.as('staff@karunya.edu')('reportPeriod', { labId: 'AIIOT', kind: 'monthly', month: '2026-10' }).data;
  const course = monthly.sections[0].rows.find((r) => r[1] === '23CS2048');
  assert.strictEqual(course[3], 2); // students
  assert.strictEqual(course[5], 2.5); // 2 h + 0.5 h
});

test('GPU utilisation and sensor turnover follow the §5.7 definitions', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  const s = env.as('s1@karunya.edu.in');
  const staff = env.as('staff@karunya.edu');
  const g = s('requestAsset', { assetId: 'GPU-01', hours: 2 });
  const gl = staff('issueAsset', { requestId: g.data.request_id });
  const t = s('requestAsset', { assetId: 'TH-01', hours: 2 });
  const tl = staff('issueAsset', { requestId: t.data.request_id });
  env.advance(2 * 3600);
  staff('returnAsset', { loanId: gl.data.loan_id, condition: 'GOOD' });
  staff('returnAsset', { loanId: tl.data.loan_id, condition: 'GOOD' });
  const day = env.as('staff@karunya.edu')('reportPeriod', { labId: 'AIIOT', kind: 'range', from: '2026-10-19', to: '2026-10-19' }).data;
  const gpu = day.sections[1].rows.find((r) => r[0] === 'GPU-01');
  assert.strictEqual(gpu[2], 2); // 2 h issued
  assert.strictEqual(gpu[3], 12); // 08:00–20:00
  const thermal = day.sections[2].rows.find((r) => r[0] === 'Thermal');
  assert.deepStrictEqual(thermal, ['Thermal', 2, 1, 0.5]);
});

test('AT-11 unauthorised role change and export are denied and logged', () => {
  const env = world();
  const r = env.as('s1@karunya.edu.in')('saveUser', { email: 's1@karunya.edu.in', role: 'SUPER_ADMIN' });
  assert.strictEqual(r.code, 'FORBIDDEN');
  const e = env.as('s1@karunya.edu.in')('exportRange', { labId: 'AIIOT', from: '2026-10-01', to: '2026-10-31' });
  assert.strictEqual(e.code, 'FORBIDDEN');
  const f = env.as('faculty@karunya.edu')('exportRange', { labId: 'AIIOT', from: '2026-10-01', to: '2026-10-31', dataset: 'loans' });
  assert.strictEqual(f.code, 'FORBIDDEN');
  assert.ok(auditActions(env).filter((a) => a === 'SECURITY_FORBIDDEN').length >= 3);
  const ok = env.as('admin@karunya.edu')('saveUser', { email: 's1@karunya.edu.in', role: 'STAFF' });
  assert.ok(ok.ok);
  assert.ok(auditActions(env).includes('ROLE_CHANGE'));
  const self = env.as('admin@karunya.edu')('saveUser', { email: 'admin@karunya.edu', role: 'STAFF' });
  assert.strictEqual(self.code, 'INVALID');
});

test('AT-12 no raw coordinates are stored anywhere after check-in', () => {
  const env = world();
  const odd = { lat: 10.93643217, lng: 76.74421789, accuracy: 9 };
  scan(env, 's1@karunya.edu.in');
  assert.strictEqual(checkIn(env, 's1@karunya.edu.in', odd).data.outcome, 'GREEN');
  scan(env, 's2@karunya.edu.in');
  checkIn(env, 's2@karunya.edu.in', { lat: 10.94, lng: 76.75, accuracy: 9 });
  const all = JSON.stringify(Object.fromEntries(Object.entries(env.ss._sheets).filter(([n]) => n !== 'Config').map(([n, s]) => [n, s._rows()])));
  ['10.93643', '76.74421', '10.94', '76.75'].forEach((frag) => assert.ok(!all.includes(frag), 'found ' + frag));
  const visitCols = env.rows('Visits')[0];
  assert.ok(!visitCols.some((c) => /lat|lng|lon/.test(c)));
});

test('AT-13 poor GPS accuracy gives Amber and lands in the right review queue', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  const r = checkIn(env, 's1@karunya.edu.in', { lat: INSIDE.lat, lng: INSIDE.lng, accuracy: 80 });
  assert.strictEqual(r.data.outcome, 'AMBER');
  assert.strictEqual(r.data.visit.review_status, 'PENDING');
  let occ = env.as('staff@karunya.edu')('occupancy', { labId: 'AIIOT' }).data;
  assert.deepStrictEqual([occ.occupancy, occ.pending], [0, 1], 'counter counts verified sign-ins only; pending shown separately');
  const q = env.as('faculty@karunya.edu')('reviewQueue', { labId: 'AIIOT' }).data;
  assert.strictEqual(q.length, 1);
  assert.match(q[0].flag_reason, /Poor GPS accuracy/);
  assert.strictEqual(env.as('staff@karunya.edu')('reviewQueue', { labId: 'AIIOT' }).data.length, 0, 'course visits go to faculty');
  const rv = env.as('staff@karunya.edu')('reviewVisit', { visitId: q[0].visit_id, decision: 'CONFIRM' });
  assert.strictEqual(rv.code, 'FORBIDDEN');
  const ok = env.as('faculty@karunya.edu')('reviewVisit', { visitId: q[0].visit_id, decision: 'CONFIRM' });
  assert.strictEqual(ok.data.review_status, 'CONFIRMED');
  occ = env.as('staff@karunya.edu')('occupancy', { labId: 'AIIOT' }).data;
  assert.deepStrictEqual([occ.occupancy, occ.pending], [1, 0], 'confirming moves the student into the counter');
  assert.strictEqual(env.as('faculty@karunya.edu')('reviewQueue', { labId: 'AIIOT' }).data.length, 0);

  // Research visits are reviewed by staff; a decline voids the visit and frees the seat.
  scan(env, 's2@karunya.edu.in');
  const res = checkIn(env, 's2@karunya.edu.in', EDGE, { type: 'RESEARCH', purpose: 'Training a CNN', equipment: 'GPU', projectId: 'P-S2' });
  assert.strictEqual(res.data.outcome, 'AMBER');
  const sq = env.as('staff@karunya.edu')('reviewQueue', { labId: 'AIIOT' }).data;
  assert.strictEqual(sq.length, 1);
  assert.strictEqual(env.as('staff@karunya.edu')('occupancy', { labId: 'AIIOT' }).data.pending, 1);
  env.as('staff@karunya.edu')('reviewVisit', { visitId: sq[0].visit_id, decision: 'DECLINE', note: 'Not in lab' });
  occ = env.as('staff@karunya.edu')('occupancy', { labId: 'AIIOT' }).data;
  assert.deepStrictEqual([occ.occupancy, occ.pending], [1, 0]);
});

test('AT-14 a forgotten check-out auto-closes and is labelled', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE); // course ends 12:00, grace 15 min
  scan(env, 's2@karunya.edu.in');
  checkIn(env, 's2@karunya.edu.in', INSIDE, { type: 'RESEARCH', purpose: 'Thesis experiments', equipment: 'None', projectId: 'P-S2' });
  env.setIst('2026-10-19', '12:20');
  env.session.active = '';
  assert.strictEqual(env.run('jobAutoClose()').closed, 1);
  const v1 = env.as('s1@karunya.edu.in')('myHistory').data[0];
  assert.strictEqual(v1.close_type, 'AUTO_DURATION');
  assert.strictEqual(v1.check_out_at, '2026-10-19T06:45:00.000Z'); // 12:15 IST: counted only to the close
  env.setIst('2026-10-19', '20:05');
  env.session.active = '';
  env.run('jobAutoClose()');
  const v2 = env.as('s2@karunya.edu.in')('myHistory').data[0];
  assert.strictEqual(v2.close_type, 'AUTO_CLOSING');
  assert.strictEqual(env.as('staff@karunya.edu')('occupancy', { labId: 'AIIOT' }).data.occupancy, 0);
});

test('FR-18 reconciliation repairs a tampered ActiveVisits tab', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  env.run(`Db.replaceAll('ActiveVisits', []); Cache.put('occ:AIIOT', 7, 600);`);
  env.session.active = '';
  const r = env.run('jobReconcile()');
  assert.strictEqual(r.drift, true);
  assert.strictEqual(r.occupancy.AIIOT, 1);
  assert.ok(auditActions(env).includes('RECONCILE_DRIFT'));
});

test('AT-15 check-in outside hours is rejected; a staff override is logged', () => {
  const env = world();
  env.setIst('2026-10-19', '21:00');
  const tick = env.as('staff@karunya.edu')('monitorTick', { labId: 'AIIOT' });
  assert.strictEqual(tick.data.open, false, 'monitor stops issuing QR codes when closed');
  env.setIst('2026-10-19', '19:59');
  env.advance(56);
  const t2 = env.as('staff@karunya.edu')('monitorTick', { labId: 'AIIOT' }).data.token;
  env.advance(5); // still a fresh QR, but the lab closed at 20:00
  env.session.active = 's1@karunya.edu.in';
  assert.strictEqual(env.ctx.Attendance.claim(env.ctx.Auth.context(), t2).code, 'LAB_CLOSED');
  const noWhy = env.as('staff@karunya.edu')('manualEntry', { email: 's1@karunya.edu.in', labId: 'AIIOT', reason: { type: 'RESEARCH', purpose: 'Late experiment', equipment: 'None' } });
  assert.strictEqual(noWhy.code, 'INVALID');
  const m = env.as('staff@karunya.edu')('manualEntry', { email: 's1@karunya.edu.in', labId: 'AIIOT', why: 'Supervised late session', reason: { type: 'RESEARCH', purpose: 'Late experiment', equipment: 'None' } });
  assert.ok(m.ok, JSON.stringify(m));
  assert.strictEqual(m.data.confidence, 'MANUAL');
  assert.ok(auditActions(env).includes('MANUAL_ENTRY_OVERRIDE_HOURS'));
  assert.strictEqual(env.as('s1@karunya.edu.in')('manualEntry', { email: 's2@karunya.edu.in', labId: 'AIIOT', why: 'x' }).code, 'FORBIDDEN');
});

test('FR-09 visit reason must be complete', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  assert.strictEqual(checkIn(env, 's1@karunya.edu.in', INSIDE, { type: 'RESEARCH', purpose: 'x' }).code, 'INCOMPLETE');
  assert.strictEqual(checkIn(env, 's1@karunya.edu.in', INSIDE, { type: 'COURSE', sessionId: 'nope' }).code, 'INCOMPLETE');
  assert.strictEqual(checkIn(env, 's1@karunya.edu.in', INSIDE, {}).code, 'INCOMPLETE');
  // The scan is kept so the student can fix the form without rescanning.
  assert.strictEqual(checkIn(env, 's1@karunya.edu.in', INSIDE, { type: 'EVENT', sessionId: 'EV-HACK' }).data.outcome, 'GREEN');
  const opts = env.as('s1@karunya.edu.in')('checkinOptions', { labId: 'AIIOT' }).data;
  assert.ok(opts.courses.some((c) => c.code === '23CS2048'));
  assert.ok(opts.events.some((c) => c.code === 'HACK26'));
});

test('FR-27 faculty roster splits present, pending and not yet arrived; manual marks', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  scan(env, 's2@karunya.edu.in');
  checkIn(env, 's2@karunya.edu.in', { lat: INSIDE.lat, lng: INSIDE.lng, accuracy: 90 });
  const fac = env.as('faculty@karunya.edu');
  let r = fac('roster', { sessionId: 'C-23CS2048' }).data.roster;
  assert.deepStrictEqual([r.present.length, r.pending.length, r.notArrived.length], [1, 1, 1]);
  fac('markAttendance', { sessionId: 'C-23CS2048', email: 's3@karunya.edu.in', mark: 'PRESENT', reason: 'Phone battery dead, seen in class' });
  r = fac('roster', { sessionId: 'C-23CS2048' }).data.roster;
  assert.deepStrictEqual([r.present.length, r.pending.length, r.notArrived.length], [2, 1, 0]);
  assert.ok(auditActions(env).includes('MANUAL_MARK'));
  const csv = fac('exportRange', { labId: 'AIIOT', from: '2026-10-19', to: '2026-10-19', sessionId: 'C-23CS2048' }).data;
  assert.strictEqual(csv.rows, 2);
  const header = csv.csv.split('\r\n')[0];
  assert.ok(!/mobile/.test(header), 'exports never include mobile numbers');
  assert.match(csv.csv, /2026-10-19T10:30:00\+05:30/, 'ISO dates with IST offset');
  // Another faculty member cannot see this roster.
  env.as('admin@karunya.edu')('saveUser', { email: 'other@karunya.edu', role: 'FACULTY' });
  env.as('other@karunya.edu')('register', { name: 'Other Faculty', reg_no: 'EMP009', mobile: '9876500009' });
  assert.strictEqual(env.as('other@karunya.edu')('roster', { sessionId: 'C-23CS2048' }).code, 'FORBIDDEN');
});

test('FR-36 Super Admin can grant a configurable action to another role', () => {
  const env = world();
  assert.strictEqual(env.as('faculty@karunya.edu')('activity', { labId: 'AIIOT' }).code, 'FORBIDDEN');
  const s = env.as('admin@karunya.edu')('savePermissions', { overrides: { activity: ['FACULTY'] } });
  assert.ok(s.ok);
  assert.ok(env.as('faculty@karunya.edu')('activity', { labId: 'AIIOT' }).ok);
  const bad = env.as('admin@karunya.edu')('savePermissions', { overrides: { saveUser: ['STUDENT'] } });
  assert.strictEqual(bad.code, 'INVALID');
});

test('FR-35 lab settings are validated and stored in Script Properties', () => {
  const env = world();
  const admin = env.as('admin@karunya.edu');
  const cur = admin('settingsGet').data.labs[0];
  assert.strictEqual(admin('saveLab', Object.assign({}, cur, { radius_m: 50 })).code, 'INVALID');
  assert.strictEqual(admin('saveLab', Object.assign({}, cur, { qr_rotate_sec: 3 })).code, 'INVALID');
  const ok = admin('saveLab', Object.assign({}, cur, { radius_m: 15, qr_rotate_sec: 6 }));
  assert.ok(ok.ok, JSON.stringify(ok));
  const stored = JSON.parse(env.run("PropertiesService.getScriptProperties().getProperty('LABS_JSON')"));
  assert.strictEqual(stored[0].radius_m, 15);
  assert.strictEqual(stored[0].qr_rotate_sec, 6);
  assert.strictEqual(env.as('staff@karunya.edu')('saveLab', cur).code, 'FORBIDDEN');
  const pub = env.as('s1@karunya.edu.in')('bootstrap').data.labs[0];
  assert.ok(!('lat' in pub), 'students never receive lab coordinates');
});

test('students can see only their own history and items', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  assert.strictEqual(env.as('s2@karunya.edu.in')('myHistory').data.length, 0);
  assert.strictEqual(env.as('s1@karunya.edu.in')('myHistory').data.length, 1);
  assert.strictEqual(env.as('s1@karunya.edu.in')('monitorTick', { labId: 'AIIOT' }).code, 'FORBIDDEN');
  assert.strictEqual(env.as('s1@karunya.edu.in')('inside', { labId: 'AIIOT' }).code, 'FORBIDDEN');
});

test('doGet: QR link claims the scan, monitor needs staff, outsiders see a clear error', () => {
  const env = world();
  const tick = env.as('staff@karunya.edu')('monitorTick', { labId: 'AIIOT' });
  env.session.active = 's1@karunya.edu.in';
  env.ctx.Db.reset();
  let page = env.ctx.doGet({ parameter: { t: tick.data.token } });
  assert.strictEqual(page.file, 'Index');
  assert.strictEqual(page.boot.view, 'checkin');
  assert.strictEqual(page.boot.claim.ok, true);
  assert.strictEqual(page.boot.init.me.role, 'STUDENT');

  page = env.ctx.doGet({ parameter: { view: 'monitor', lab: 'AIIOT' } });
  assert.strictEqual(page.file, 'Index');
  assert.strictEqual(page.boot.error.code, 'FORBIDDEN');

  env.session.active = 'staff@karunya.edu';
  page = env.ctx.doGet({ parameter: { view: 'monitor', lab: 'AIIOT' } });
  assert.strictEqual(page.file, 'Monitor');
  assert.strictEqual(page.boot.lab.lab_id, 'AIIOT');
  assert.ok(!('lat' in page.boot.lab));

  env.session.active = 'x@gmail.com';
  page = env.ctx.doGet({ parameter: {} });
  assert.strictEqual(page.boot.error.code, 'DOMAIN');
  assert.ok(!page.boot.init);
});

test('Proposal: a check-in pending review cannot book equipment until confirmed', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  const r = checkIn(env, 's1@karunya.edu.in', { lat: INSIDE.lat, lng: INSIDE.lng, accuracy: 90 });
  assert.strictEqual(r.data.outcome, 'AMBER');
  assert.strictEqual(env.as('s1@karunya.edu.in')('requestAsset', { assetId: 'ESP-01' }).code, 'PENDING_REVIEW');
  env.as('faculty@karunya.edu')('reviewVisit', { visitId: r.data.visit.visit_id, decision: 'CONFIRM' });
  assert.ok(env.as('s1@karunya.edu.in')('requestAsset', { assetId: 'ESP-01' }).ok);
});

test('Proposal: a course or event not in the timetable can be typed in and goes to staff review', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  const bad = checkIn(env, 's1@karunya.edu.in', INSIDE, { type: 'COURSE', manual: { code: '23CS9', name: 'AI Lab', hours: 0 } });
  assert.strictEqual(bad.code, 'INCOMPLETE');
  const r = checkIn(env, 's1@karunya.edu.in', INSIDE, { type: 'COURSE', manual: { code: '23cs3001', name: 'Deep Learning Lab', hours: 2 } });
  assert.strictEqual(r.data.outcome, 'AMBER');
  assert.ok(r.data.reasons.some((x) => /not in the timetable/.test(x)));
  assert.strictEqual(r.data.visit.label, '23CS3001 · Deep Learning Lab');
  assert.strictEqual(env.as('faculty@karunya.edu')('reviewQueue', { labId: 'AIIOT' }).data.length, 0);
  const q = env.as('staff@karunya.edu')('reviewQueue', { labId: 'AIIOT' }).data;
  assert.strictEqual(q.length, 1);
  env.as('staff@karunya.edu')('reviewVisit', { visitId: q[0].visit_id, decision: 'CONFIRM' });

  scan(env, 's2@karunya.edu.in');
  const ev = checkIn(env, 's2@karunya.edu.in', INSIDE, { type: 'EVENT', manual: { event_name: 'Robotics Workshop', coordinator: 'Dr. Mary', hours: 3 } });
  assert.strictEqual(ev.data.outcome, 'AMBER');
  env.advance(3600);
  env.as('s1@karunya.edu.in')('checkOut', {});
  const monthly = env.as('staff@karunya.edu')('reportPeriod', { labId: 'AIIOT', kind: 'monthly', month: '2026-10' }).data;
  const row = monthly.sections[0].rows.find((x) => x[1] === '23CS3001');
  assert.ok(row, 'unlisted course appears in course-wise hours');
  assert.match(row[2], /not in timetable/);
  assert.strictEqual(row[5], 1);
});

test('Proposal: research equipment is chosen from the lab catalog', () => {
  const env = world();
  const opts = env.as('s1@karunya.edu.in')('checkinOptions', { labId: 'AIIOT' }).data;
  assert.ok(opts.equipment.includes('RTX 4090') && opts.equipment.includes('LiDAR'));
  scan(env, 's1@karunya.edu.in');
  const r = checkIn(env, 's1@karunya.edu.in', INSIDE, { type: 'RESEARCH', purpose: 'Point cloud mapping', equipment: 'LiDAR, RTX 4090', projectId: 'P-S1' });
  assert.strictEqual(r.data.outcome, 'GREEN');
  const stored = JSON.parse(env.rows('Visits')[1][7]);
  assert.strictEqual(stored.equipment, 'LiDAR, RTX 4090');
});

test('Proposal: daily digest lists the peak occupancy hours', () => {
  const env = world();
  env.setIst('2026-10-19', '09:10');
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE, { type: 'EVENT', sessionId: 'EV-HACK' });
  env.setIst('2026-10-19', '11:05');
  ['s2@karunya.edu.in', 's3@karunya.edu.in'].forEach((s) => { scan(env, s); checkIn(env, s, INSIDE); });
  env.setIst('2026-10-19', '13:30');
  const d = env.as('staff@karunya.edu')('reportDaily', { labId: 'AIIOT', date: '2026-10-19' }).data;
  assert.deepStrictEqual(d.peaks.map((p) => p.hour), [11, 12, 13]);
  assert.match(Object.fromEntries(d.kpis)['Peak occupancy hours'], /^11:00–12:00 \(3\)/);
});

test('Proposal: Excel export goes through a temporary Sheet and is cleaned up', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  const r = env.as('staff@karunya.edu')('exportRange', { labId: 'AIIOT', from: '2026-10-19', to: '2026-10-19', format: 'xlsx' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(r.data.file.name, /\.xlsx$/);
  assert.match(env.drive.fetched[0].url, /export\?format=xlsx$/);
  const tmp = env.created[0];
  assert.deepStrictEqual(env.drive.trashed, [tmp.getId()]);
  const sheetRows = tmp.getSheets()[0]._rows();
  assert.strictEqual(sheetRows[0][0], 'visit_id');
  assert.strictEqual(sheetRows.length, 2);
});

test('Proposal: doPost serves the same API with the same role checks', () => {
  const env = world();
  const post = (email, body) => {
    env.session.active = email;
    env.ctx.Db.reset();
    return JSON.parse(env.ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text);
  };
  assert.strictEqual(post('s1@karunya.edu.in', { action: 'occupancy', payload: { labId: 'AIIOT' } }).ok, true);
  assert.strictEqual(post('s1@karunya.edu.in', { action: 'users' }).code, 'FORBIDDEN');
  assert.strictEqual(post('x@gmail.com', { action: 'occupancy', payload: { labId: 'AIIOT' } }).code, 'DOMAIN');
  assert.strictEqual(post('s1@karunya.edu.in', 'not json').code, 'NOT_FOUND');
});

test('no unexpected server errors were logged', () => {
  // Each world() has its own context; this re-runs a full flow and checks the error sink.
  const env = world();
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  ['status', 'freeNow', 'myItems', 'myHistory', 'labMap', 'occupancy', 'checkinOptions'].forEach((a) => {
    const r = env.as('s1@karunya.edu.in')(a, { labId: 'AIIOT' });
    assert.ok(r.ok, a + ': ' + JSON.stringify(r));
  });
  ['staffSummary', 'activity', 'inside', 'handshake', 'inventory', 'reviewQueue', 'sessions'].forEach((a) => {
    const r = env.as('staff@karunya.edu')(a, { labId: 'AIIOT' });
    assert.ok(r.ok, a + ': ' + JSON.stringify(r));
  });
  ['facultySessions', 'settingsGet', 'users', 'audit', 'bootstrap'].forEach((a) => {
    const r = env.as('admin@karunya.edu')(a, { labId: 'AIIOT' });
    assert.ok(r.ok, a + ': ' + JSON.stringify(r));
  });
  assert.deepStrictEqual(env.ctx.__errors, []);
});

/* ------------------------------------------------------------------ */

let failed = 0;
results.forEach(([ok, name, err]) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  if (!ok) {
    failed++;
    console.log('        ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n        ') : err));
  }
});
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
