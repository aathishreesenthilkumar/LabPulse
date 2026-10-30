/**
 * Tests for the supervisor's v2 requirements (voice messages): roles, live view with systems
 * and projects, reservations with a queue, lookups, archiving, encryption.
 * Usage: node tests/v2.js
 */
'use strict';
const assert = require('assert');
const { LAB, INSIDE, EDGE, HOSTEL, world, scan, checkIn, auditActions } = require('./fixtures');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, name, e]);
  }
}

/* ---------------- Part 1: roles ---------------- */

test('HOD sees everything but cannot change anything', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  const hod = env.as('hod@karunya.edu');
  ['staffSummary', 'activity', 'inside', 'inventory', 'sessions', 'reportDaily', 'facultySessions'].forEach((a) => {
    const r = hod(a, { labId: 'AIIOT' });
    assert.ok(r.ok, a + ': ' + JSON.stringify(r));
  });
  assert.ok(hod('roster', { sessionId: 'C-23CS2048' }).ok, 'HOD can view any roster');
  [
    ['inventorySave', { lab_id: 'AIIOT', name: 'X', category: 'IOT', type: 'ESP32' }],
    ['inventoryRemove', { assetId: 'ESP-01', reason: 'x' }],
    ['issueAsset', { requestId: 'R' }],
    ['manualEntry', {}],
    ['manageStudent', { email: 'new@karunya.edu.in' }],
    ['markAttendance', { sessionId: 'C-23CS2048', email: 's2@karunya.edu.in', mark: 'PRESENT', reason: 'seen' }],
    ['saveUser', { email: 's1@karunya.edu.in', role: 'STAFF' }],
    ['monitorTick', { labId: 'AIIOT' }]
  ].forEach(([a, p]) => assert.strictEqual(hod(a, p).code, 'FORBIDDEN', a));
});

test('Coordinator adds and removes facilities and students, but cannot touch other roles', () => {
  const env = world();
  const c = env.as('coord@karunya.edu');
  const added = c('inventorySave', { lab_id: 'AIIOT', name: 'Prusa MK4 3D Printer', category: 'IOT', type: '3D Printer' });
  assert.ok(added.ok, JSON.stringify(added));
  assert.ok(c('inventoryRemove', { assetId: added.data.asset_id, reason: 'Moved to another lab' }).ok);
  assert.ok(env.as('staff@karunya.edu')('inventorySave', { lab_id: 'AIIOT', name: 'Spare ESP32', category: 'IOT', type: 'ESP32' }).ok, 'proposal A: lab staff manage the inventory too');

  const s = c('manageStudent', { email: 'urk24cs1500@karunya.edu.in', name: 'New Student', reg_no: 'urk24cs1500' });
  assert.ok(s.ok, JSON.stringify(s));
  assert.strictEqual(s.data.role, 'STUDENT');
  assert.ok(c('students').data.some((u) => u.email === 'urk24cs1500@karunya.edu.in'));
  assert.ok(c('manageStudent', { email: 's1@karunya.edu.in', active: false, reason: 'Graduated' }).ok);
  assert.strictEqual(env.as('s1@karunya.edu.in')('status').code, 'INACTIVE', 'a removed student cannot use the app');
  assert.ok(c('manageStudent', { email: 's1@karunya.edu.in', active: true }).ok);
  assert.ok(env.as('s1@karunya.edu.in')('status').ok);

  assert.strictEqual(c('manageStudent', { email: 'faculty@karunya.edu', active: false }).code, 'FORBIDDEN');
  assert.strictEqual(c('saveUser', { email: 's2@karunya.edu.in', role: 'COORDINATOR' }).code, 'FORBIDDEN');
  const actions = auditActions(env);
  assert.ok(actions.includes('STUDENT_ADD') && actions.includes('STUDENT_REMOVE') && actions.includes('INVENTORY_ADD'));
});

test('Coordinator runs lab operations and reviews; Super Admin assigns the new roles', () => {
  const env = world();
  assert.ok(env.as('coord@karunya.edu')('monitorTick', { labId: 'AIIOT' }).ok);
  scan(env, 's1@karunya.edu.in');
  const r = checkIn(env, 's1@karunya.edu.in', { lat: INSIDE.lat, lng: INSIDE.lng, accuracy: 90 }, { type: 'RESEARCH', purpose: 'Edge AI tests', equipment: 'None', projectId: 'P-S1' });
  assert.strictEqual(r.data.outcome, 'AMBER');
  const q = env.as('coord@karunya.edu')('reviewQueue', { labId: 'AIIOT' }).data;
  assert.strictEqual(q.length, 1);
  assert.ok(env.as('coord@karunya.edu')('reviewVisit', { visitId: q[0].visit_id, decision: 'CONFIRM' }).ok);
  const admin = env.as('admin@karunya.edu');
  assert.ok(admin('saveUser', { email: 'hod2@karunya.edu', role: 'HOD' }).ok);
  assert.ok(admin('saveUser', { email: 'coord2@karunya.edu', role: 'COORDINATOR' }).ok);
});

/* ---------------- Parts 2 and 3: who is on which system, projects ---------------- */

test('Live view from home shows each person, their system and their project', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  const r = checkIn(env, 's1@karunya.edu.in', INSIDE, { type: 'RESEARCH', purpose: 'Train the soil model', equipment: 'None', projectId: 'P-S1', systemId: 'PC-01' });
  assert.strictEqual(r.data.outcome, 'GREEN', JSON.stringify(r));
  scan(env, 's2@karunya.edu.in');
  checkIn(env, 's2@karunya.edu.in', INSIDE, { type: 'COURSE', sessionId: 'C-23CS2048', systemId: 'OWN' });
  const inside = env.as('hod@karunya.edu')('inside', { labId: 'AIIOT' }).data;
  const s1 = inside.find((x) => x.email === 's1@karunya.edu.in');
  assert.strictEqual(s1.system, 'Lab PC 1 (RTX 3060) (PC-01)');
  assert.strictEqual(s1.project, 'Smart Irrigation with ESP32');
  assert.strictEqual(s1.reg_no, 'URK24CS1001');
  assert.strictEqual(inside.find((x) => x.email === 's2@karunya.edu.in').system, 'Own laptop');
  const map = env.as('s3@karunya.edu.in')('labMap', { labId: 'AIIOT' }).data;
  assert.strictEqual(map.cells.find((c) => c.asset_id === 'PC-01').status, 'IN_USE');
  // Every view agrees: the public catalog shows it in use, and nobody else can request it.
  assert.strictEqual(env.as('s3@karunya.edu.in')('assetsPublic', { labId: 'AIIOT' }).data.find((a) => a.asset_id === 'PC-01').status, 'IN_USE');
  scan(env, 's3@karunya.edu.in');
  checkIn(env, 's3@karunya.edu.in', INSIDE);
  assert.match(env.as('s3@karunya.edu.in')('requestAsset', { assetId: 'PC-01' }).message, /in use by someone/);
  assert.ok(!env.as('s3@karunya.edu.in')('freeNow', { labId: 'AIIOT' }).data.some((x) => x.type === 'Lab PC (GPU)' && x.count === 2), 'PC-01 is not free');
  const opts = env.as('s3@karunya.edu.in')('checkinOptions', { labId: 'AIIOT' }).data;
  assert.strictEqual(opts.systems.find((x) => x.asset_id === 'PC-01').in_use, true);
  assert.ok(opts.systems.some((x) => x.asset_id === '3DP-01') && opts.systems.some((x) => x.asset_id === 'DRN-01'));
  assert.deepStrictEqual(opts.projects.map((p) => p.project_id), ['P-S3']);
});

test('Extra-hours check-in needs one of your own projects; systems must be real', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  const base = { type: 'RESEARCH', purpose: 'Testing sensors', equipment: 'None' };
  assert.strictEqual(checkIn(env, 's1@karunya.edu.in', INSIDE, base).code, 'INCOMPLETE');
  assert.match(checkIn(env, 's1@karunya.edu.in', INSIDE, Object.assign({ projectId: 'P-S2' }, base)).message, /not a member/);
  assert.strictEqual(checkIn(env, 's1@karunya.edu.in', INSIDE, Object.assign({ projectId: 'P-S1', systemId: 'ESP-01' }, base)).code, 'INCOMPLETE', 'an ESP32 is not a workstation');
  assert.strictEqual(checkIn(env, 's1@karunya.edu.in', INSIDE, Object.assign({ projectId: 'P-S1', systemId: '3DP-01' }, base)).data.outcome, 'GREEN');
});

test('Projects: create with a timeline, log work at check-out, submit the outcome', () => {
  const env = world();
  const s = env.as('s3@karunya.edu.in');
  assert.strictEqual(s('projectSave', { lab_id: 'AIIOT', title: 'Gas leak alarm', start_date: '2026-10-19', end_date: '2026-10-01' }).code, 'INVALID');
  assert.strictEqual(s('projectSave', { lab_id: 'AIIOT', title: 'Gas leak alarm', end_date: '2026-11-30', members: 'friend@gmail.com' }).code, 'INVALID');
  const p = s('projectSave', { lab_id: 'AIIOT', title: 'Gas leak alarm', end_date: '2026-11-30', members: 's1@karunya.edu.in' });
  assert.ok(p.ok, JSON.stringify(p));
  const pid = p.data.project_id;
  assert.ok(env.as('s1@karunya.edu.in')('myProjects').data.some((x) => x.project_id === pid), 'members see the project');

  scan(env, 's3@karunya.edu.in');
  checkIn(env, 's3@karunya.edu.in', INSIDE, { type: 'RESEARCH', purpose: 'Wiring the MQ-2 sensor', equipment: 'Gas', projectId: pid, systemId: 'PC-03' });
  env.advance(2 * 3600);
  assert.ok(s('checkOut', { note: 'Sensor wired and calibrated' }).ok);
  const d = s('projectDetail', { projectId: pid }).data;
  assert.strictEqual(d.project.hours, 2);
  assert.strictEqual(d.log[0].note, 'Sensor wired and calibrated');
  assert.strictEqual(d.log[0].system, 'Lab PC 3 (PC-03)');

  assert.strictEqual(env.as('s2@karunya.edu.in')('projectComplete', { project_id: pid, outcome: 'Not mine to close' }).code, 'FORBIDDEN');
  assert.strictEqual(s('projectComplete', { project_id: pid, outcome: 'short' }).code, 'INVALID');
  const done = s('projectComplete', { project_id: pid, outcome: 'Working prototype that alarms at 300 ppm LPG.', outcome_link: 'https://github.com/x/gas-alarm' });
  assert.strictEqual(done.data.status, 'COMPLETED');
  const list = env.as('hod@karunya.edu')('projects', { labId: 'AIIOT' }).data;
  const row = list.find((x) => x.project_id === pid);
  assert.strictEqual(row.hours, 2);
  assert.match(row.outcome, /300 ppm/);
  assert.strictEqual(env.as('s1@karunya.edu.in')('projects', { labId: 'AIIOT' }).code, 'FORBIDDEN', 'students only see their own');
});

/* ---------------- Part 4: reservations with a queue ---------------- */

const at = (hhmm) => '2026-10-19T' + hhmm + ':00+05:30';

/** A lab whose admin allows reserving future slots without being checked in (setting off). */
function advanceBookingWorld() {
  const env = world();
  env.session.active = '';
  env.run("Reports.saveGlobalKey('booking_requires_checkin', false)");
  return env;
}

test('Proposal C: by default a reservation needs an active, verified CHECKED_IN status', () => {
  const env = world();
  const req = { assetId: '3DP-01', start: at('14:00'), end: at('16:00'), purpose: 'Print the sensor enclosure' };
  assert.strictEqual(env.as('s1@karunya.edu.in')('bookAsset', req).code, 'NOT_CHECKED_IN');
  scan(env, 's1@karunya.edu.in');
  const amber = checkIn(env, 's1@karunya.edu.in', { lat: INSIDE.lat, lng: INSIDE.lng, accuracy: 90 });
  assert.strictEqual(amber.data.outcome, 'AMBER');
  assert.strictEqual(env.as('s1@karunya.edu.in')('bookAsset', req).code, 'NOT_CHECKED_IN', 'pending review is not yet CHECKED_IN');
  env.as('faculty@karunya.edu')('reviewVisit', { visitId: amber.data.visit.visit_id, decision: 'CONFIRM' });
  assert.strictEqual(env.as('s1@karunya.edu.in')('bookAsset', req).data.status, 'BOOKED');
  assert.strictEqual(env.as('s1@karunya.edu.in')('bootstrap').data.bookingRequiresCheckin, true);
});

test('Reserving a slot: first comes first, overlaps join the queue, cancel promotes the next', () => {
  const env = advanceBookingWorld(); // Monday 19 Oct, 10:30 IST
  const b1 = env.as('s1@karunya.edu.in')('bookAsset', { assetId: '3DP-01', start: at('14:00'), end: at('16:00'), purpose: 'Print the sensor enclosure', projectId: 'P-S1' });
  assert.strictEqual(b1.data.status, 'BOOKED', JSON.stringify(b1));
  const b2 = env.as('s2@karunya.edu.in')('bookAsset', { assetId: '3DP-01', start: at('15:00'), end: at('17:00'), purpose: 'Print drone arms' });
  assert.deepStrictEqual([b2.data.status, b2.data.position], ['WAITLIST', 1]);
  const b3 = env.as('s3@karunya.edu.in')('bookAsset', { assetId: '3DP-01', start: at('15:30'), end: at('16:30'), purpose: 'Print camera mount' });
  assert.deepStrictEqual([b3.data.status, b3.data.position], ['WAITLIST', 2]);
  assert.strictEqual(env.as('s3@karunya.edu.in')('bookAsset', { assetId: '3DP-02', start: at('15:30'), end: at('16:30'), purpose: 'Other printer' }).data.status, 'BOOKED', 'a different printer is free');

  assert.strictEqual(env.as('s2@karunya.edu.in')('cancelBooking', { bookingId: b1.data.booking_id }).code, 'FORBIDDEN');
  assert.ok(env.as('s1@karunya.edu.in')('cancelBooking', { bookingId: b1.data.booking_id }).ok);
  const mine2 = env.as('s2@karunya.edu.in')('myBookings').data.find((b) => b.booking_id === b2.data.booking_id);
  assert.strictEqual(mine2.status, 'BOOKED', 'next in the queue is promoted');
  assert.ok(env.mail.some((m) => m.to === 's2@karunya.edu.in' && /slot is confirmed/.test(m.subject)));
  const mine3 = env.as('s3@karunya.edu.in')('myBookings').data.find((b) => b.booking_id === b3.data.booking_id);
  assert.deepStrictEqual([mine3.status, mine3.position], ['WAITLIST', 1]);
});

test('Booking rules: length, opening hours, the future, and who may book', () => {
  const env = advanceBookingWorld();
  const s = env.as('s1@karunya.edu.in');
  assert.match(s('bookAsset', { assetId: 'DRN-01', start: at('11:00'), end: at('17:00'), purpose: 'Long flight test' }).message, /at most 4 hours/);
  assert.match(s('bookAsset', { assetId: 'DRN-01', start: at('19:00'), end: at('21:00'), purpose: 'Night flight' }).message, /opening hours/);
  assert.match(s('bookAsset', { assetId: 'DRN-01', start: at('08:00'), end: at('09:00'), purpose: 'Too late now' }).message, /future/);
  assert.match(s('bookAsset', { assetId: 'DRN-01', start: at('12:00'), end: at('13:00'), purpose: 'x' }).message, /what you will use it for/);
  assert.strictEqual(s('bookAsset', { assetId: 'DRN-01', start: at('12:00'), end: at('13:00'), purpose: 'Survey flight', projectId: 'P-S2' }).code, 'INVALID', 'not your project');
  assert.strictEqual(env.as('hod@karunya.edu')('bookAsset', { assetId: 'DRN-01', start: at('12:00'), end: at('13:00'), purpose: 'Survey flight' }).code, 'FORBIDDEN');
  assert.ok(s('bookAsset', { assetId: 'DRN-01', start: at('12:00'), end: at('13:00'), purpose: 'Survey flight' }).ok);
  const pub = env.as('s2@karunya.edu.in')('assetSchedule', { assetId: 'DRN-01', date: '2026-10-19' }).data;
  assert.strictEqual(pub.length, 1);
  assert.ok(!('user_email' in pub[0]) && !('purpose' in pub[0]), 'other students see times only');
  const staffView = env.as('staff@karunya.edu')('assetSchedule', { assetId: 'DRN-01', date: '2026-10-19' }).data;
  assert.strictEqual(staffView[0].user_name, 'Student One');
});

test('Using a booked slot: staff start it only for a checked-in student, finish frees it for the queue', () => {
  const env = advanceBookingWorld();
  const b = env.as('s2@karunya.edu.in')('bookAsset', { assetId: 'GPU-01', start: at('11:00'), end: at('13:00'), purpose: 'Train the crop model' }).data;
  const w = env.as('s3@karunya.edu.in')('bookAsset', { assetId: 'GPU-01', start: at('12:00'), end: at('14:00'), purpose: 'Train the camera model' }).data;
  assert.strictEqual(w.status, 'WAITLIST');
  env.setIst('2026-10-19', '10:50');
  const staff = env.as('staff@karunya.edu');
  assert.strictEqual(staff('startBooking', { bookingId: b.booking_id }).code, 'NOT_CHECKED_IN');
  scan(env, 's2@karunya.edu.in');
  checkIn(env, 's2@karunya.edu.in', INSIDE);
  const today = staff('bookingsToday', { labId: 'AIIOT' }).data;
  assert.strictEqual(today.find((x) => x.booking_id === b.booking_id).checked_in, true);
  assert.strictEqual(staff('startBooking', { bookingId: b.booking_id }).data.status, 'IN_USE');
  assert.strictEqual(staff('inventory', { labId: 'AIIOT' }).data.find((a) => a.asset_id === 'GPU-01').status, 'ISSUED');
  // a walk-in request cannot take a reserved item
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  assert.ok(env.as('s1@karunya.edu.in')('bookAsset', { assetId: 'GPU-02', start: at('11:30'), end: at('12:30'), purpose: 'Benchmark run' }).ok);
  assert.strictEqual(env.as('s2@karunya.edu.in')('requestAsset', { assetId: 'GPU-02', hours: 1 }).code, 'UNAVAILABLE', 'someone else reserved it');
  assert.ok(env.as('s1@karunya.edu.in')('requestAsset', { assetId: 'GPU-02', hours: 1 }).ok, 'the person who reserved it may use it');

  env.setIst('2026-10-19', '12:30');
  assert.strictEqual(staff('finishBooking', { bookingId: b.booking_id, condition: 'GOOD' }).data.status, 'DONE');
  assert.strictEqual(staff('inventory', { labId: 'AIIOT' }).data.find((a) => a.asset_id === 'GPU-01').status, 'AVAILABLE');
  const promoted = env.as('s3@karunya.edu.in')('myBookings').data.find((x) => x.booking_id === w.booking_id);
  assert.strictEqual(promoted.status, 'BOOKED');
});

test('No-shows lose the slot and the queue moves; expired waitlist entries are closed', () => {
  const env = advanceBookingWorld();
  const b = env.as('s1@karunya.edu.in')('bookAsset', { assetId: 'PC-02', start: at('11:00'), end: at('12:00'), purpose: 'CAD work on PC' }).data;
  const w = env.as('s2@karunya.edu.in')('bookAsset', { assetId: 'PC-02', start: at('11:00'), end: at('12:00'), purpose: 'CAD work too' }).data;
  env.setIst('2026-10-19', '11:20');
  env.session.active = '';
  const r = env.run('jobAutoClose()');
  assert.strictEqual(r.bookings.no_show, 1);
  assert.strictEqual(env.as('s1@karunya.edu.in')('myBookings').data.find((x) => x.booking_id === b.booking_id).status, 'NO_SHOW');
  assert.strictEqual(env.as('s2@karunya.edu.in')('myBookings').data.find((x) => x.booking_id === w.booking_id).status, 'BOOKED');
  assert.ok(auditActions(env).includes('BOOK_NO_SHOW'));
});

/* ---------------- Parts 5 and 6: lookups, rollups, archive ---------------- */

/** s1: Mon 19 Oct 10:30–12:30 on PC-01 (project), Tue 20 Oct 09:00–10:00 (course). s2: Mon 13:00–14:00 on PC-01. */
function usageWorld() {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE, { type: 'RESEARCH', purpose: 'Soil model', equipment: 'None', projectId: 'P-S1', systemId: 'PC-01' });
  env.setIst('2026-10-19', '12:30');
  env.as('s1@karunya.edu.in')('checkOut', {});
  env.setIst('2026-10-19', '13:00');
  scan(env, 's2@karunya.edu.in');
  checkIn(env, 's2@karunya.edu.in', INSIDE, { type: 'COURSE', sessionId: 'C-DEMO', systemId: 'PC-01' });
  env.setIst('2026-10-19', '14:00');
  env.as('s2@karunya.edu.in')('checkOut', {});
  env.setIst('2026-10-20', '09:00');
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE, { type: 'COURSE', sessionId: 'C-DEMO' });
  env.setIst('2026-10-20', '10:00');
  env.as('s1@karunya.edu.in')('checkOut', {});
  return env;
}

test('Lookup by register number: days in the lab, total hours, systems and projects', () => {
  const env = usageWorld();
  const r = env.as('hod@karunya.edu')('lookupStudent', { q: 'urk24cs1001' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.data.total_days, r.data.total_hours, r.data.total_visits], [2, 3, 2]);
  assert.strictEqual(r.data.days[0].date, '2026-10-20');
  assert.deepStrictEqual(r.data.days[1].systems, ['Lab PC 1 (RTX 3060) (PC-01)']);
  assert.deepStrictEqual(r.data.days[1].projects, ['Smart Irrigation with ESP32']);
  assert.strictEqual(r.data.projects[0].hours, 2);
  assert.strictEqual(env.as('coord@karunya.edu')('lookupStudent', { q: 's1@karunya.edu.in' }).data.total_hours, 3);
  assert.strictEqual(env.as('s2@karunya.edu.in')('lookupStudent', { q: 'URK24CS1001' }).code, 'FORBIDDEN');
  assert.strictEqual(env.as('hod@karunya.edu')('lookupStudent', { q: 'URK99XX0000' }).code, 'NOT_FOUND');
  const mine = env.as('s1@karunya.edu.in')('myHours').data;
  assert.deepStrictEqual([mine.total_days, mine.total_hours, mine.week_hours], [2, 3, 3]);
});

test('Lookup by system: how many people used it, for how long and for what', () => {
  const env = usageWorld();
  const r = env.as('hod@karunya.edu')('lookupAsset', { assetId: 'PC-01' }).data;
  assert.deepStrictEqual([r.distinct_users, r.total_uses, r.total_hours], [2, 2, 3]);
  assert.deepStrictEqual(r.people, ['Student One', 'Student Two']);
  assert.ok(r.uses.some((u) => u.who === 'Student One' && u.purpose === 'Smart Irrigation with ESP32' && u.hours === 2));
  assert.ok(r.uses.some((u) => u.who === 'Student Two' && /DEMO101/.test(u.purpose)));
});

test('Nightly rollup is repeatable and lookups give the same totals after it', () => {
  const env = usageWorld();
  env.setIst('2026-10-21', '02:00');
  env.session.active = '';
  env.run('Usage.nightly(); Usage.nightly();');
  assert.strictEqual(env.rows('UsageDaily').length - 1, 3, 'one row per person per day, not duplicated');
  assert.strictEqual(env.rows('AssetUsageDaily').length - 1, 1);
  const r = env.as('hod@karunya.edu')('lookupStudent', { q: 'URK24CS1001' }).data;
  assert.deepStrictEqual([r.total_days, r.total_hours], [2, 3]);
  assert.strictEqual(env.as('hod@karunya.edu')('lookupAsset', { assetId: 'PC-01' }).data.total_hours, 3);
});

test('Monthly archive moves old rows out of the live sheet without losing totals', () => {
  const env = world();
  env.setIst('2026-07-06', '10:30'); // a Monday in July
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE, { type: 'RESEARCH', purpose: 'Early prototype', equipment: 'None', projectId: 'P-S1', systemId: 'PC-02' });
  env.setIst('2026-07-06', '12:30');
  env.as('s1@karunya.edu.in')('checkOut', {});
  env.setIst('2026-10-19', '10:30');
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE, { type: 'RESEARCH', purpose: 'Field test', equipment: 'None', projectId: 'P-S1' });
  env.setIst('2026-10-19', '11:30');
  env.as('s1@karunya.edu.in')('checkOut', {});

  env.setIst('2026-11-02', '06:00');
  env.session.active = '';
  const out = env.run('Usage.archive()');
  assert.strictEqual(out.before, '2026-08-01');
  assert.strictEqual(out.moved.Visits, 1);
  assert.ok(env.rows('Visits').slice(1).every((r) => !String(r[8]).includes('Jul')), 'no July visits left in the live sheet');
  const book = env.created.find((s) => /Archive 2026/.test(s.getId()));
  assert.ok(book, 'yearly archive spreadsheet created');
  assert.strictEqual(book.getSheetByName('Visits')._rows().length, 2, 'header + the archived visit');

  const r = env.as('hod@karunya.edu')('lookupStudent', { q: 'URK24CS1001' }).data;
  assert.deepStrictEqual([r.total_days, r.total_hours], [2, 3], 'archived July still counts');
  const p = env.as('s1@karunya.edu.in')('myProjects').data.find((x) => x.project_id === 'P-S1');
  assert.strictEqual(p.hours, 3, 'project hours survive archiving');
  assert.strictEqual(env.as('hod@karunya.edu')('lookupAsset', { assetId: 'PC-02' }).data.total_hours, 2);
});

/* ---------------- Part 7: encryption and validation ---------------- */

test('Phone numbers are stored encrypted; only admin, coordinator and staff screens reveal them', () => {
  const env = world();
  const header = env.rows('Users')[0];
  const col = header.indexOf('mobile');
  const s1 = env.rows('Users').find((r) => r[1] === 's1@karunya.edu.in');
  assert.match(String(s1[col]), /^enc:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]{22}$/);
  const sheetText = JSON.stringify(env.rows('Users'));
  assert.ok(!sheetText.includes('9876500011'), 'no plain phone number anywhere in the Users sheet');

  assert.strictEqual(env.as('admin@karunya.edu')('users').data.find((u) => u.email === 's1@karunya.edu.in').mobile, '9876500011');
  assert.strictEqual(env.as('coord@karunya.edu')('students').data.find((u) => u.email === 's1@karunya.edu.in').mobile, '9876500011');
  assert.strictEqual(env.as('hod@karunya.edu')('users').code, 'FORBIDDEN');
  const me = env.as('s1@karunya.edu.in')('register', { name: 'Again', reg_no: 'URK24CS1001', mobile: '9876500011' });
  assert.strictEqual(me.code, 'ALREADY');

  // staff see the borrower's number in the handshake panel, to chase a late return
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  const req = env.as('s1@karunya.edu.in')('requestAsset', { assetId: 'ESP-01' }).data;
  env.as('staff@karunya.edu')('issueAsset', { requestId: req.request_id });
  assert.strictEqual(env.as('staff@karunya.edu')('handshake', { labId: 'AIIOT' }).data.loans[0].borrower.mobile, '9876500011');
});

test('Encryption: random IV, Unicode round trip, tamper detection, migration of old rows', () => {
  const env = world();
  const enc = (s) => env.run('Crypto.encrypt(' + JSON.stringify(s) + ')');
  const dec = (s) => env.run('Crypto.decrypt(' + JSON.stringify(s) + ')');
  const a = enc('9876543210');
  const b = enc('9876543210');
  assert.notStrictEqual(a, b, 'same number, different ciphertext');
  assert.strictEqual(dec(a), '9876543210');
  assert.strictEqual(dec(enc('தமிழ் 123 ✓')), 'தமிழ் 123 ✓');
  const parts = a.split(':');
  const flipped = parts.slice(0, 3).concat([(parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1), parts[4]]).join(':');
  assert.throws(() => dec(flipped), /changed outside LabPulse/);
  assert.strictEqual(env.run('Crypto.reveal(' + JSON.stringify(flipped) + ')'), '⚠ damaged');
  assert.strictEqual(dec('9876543210'), '9876543210', 'old plain values still read');

  env.run(`Db.insert('Users', { user_id: 'U-OLD', email: 'old@karunya.edu.in', name: 'Old Row', reg_no: 'URK20CS0001', mobile: '9123456780', role: 'STUDENT', active: true, created_at: U.now(), updated_at: U.now() });`);
  env.session.active = '';
  assert.strictEqual(env.run('Crypto.migrate()').encrypted, 1);
  assert.strictEqual(env.run('Crypto.migrate()').encrypted, 0, 'running it again changes nothing');
  assert.strictEqual(env.as('admin@karunya.edu')('users').data.find((u) => u.email === 'old@karunya.edu.in').mobile, '9123456780');
});

test('Validation: register number format, names, control characters', () => {
  const env = world();
  const r = env.as('new1@karunya.edu.in');
  assert.match(r('register', { name: 'Asha K', reg_no: 'ABC', mobile: '9876500100' }).message, /URK24CS1249/);
  assert.match(r('register', { name: '<script>alert(1)</script>', reg_no: 'URK24CS1100', mobile: '9876500100' }).message, /letters, spaces/);
  assert.match(r('register', { name: 'Asha K', reg_no: 'URK24CS1100', mobile: '12345' }).message, /mobile/);
  assert.ok(r('register', { name: 'Asha K', reg_no: 'urk24cs1100', mobile: '9876500100' }).ok);
  env.as('admin@karunya.edu')('saveUser', { email: 'prof@karunya.edu', role: 'FACULTY' });
  assert.ok(env.as('prof@karunya.edu')('register', { name: 'Dr. Mary Thomas', reg_no: 'EMP-2041', mobile: '9876500101' }).ok, 'staff use employee IDs');
  assert.strictEqual(env.as('coord@karunya.edu')('manageStudent', { email: 'x2@karunya.edu.in', reg_no: 'BAD' }).code, 'INVALID');
  assert.strictEqual(env.run("U.str('ok\\u0000\\u0007 text')"), 'ok text');
});

/* ---------------- Part 8: who is missing from a regular lab session ---------------- */

test('Faculty see who is missing; after the session the faculty is emailed the list once', () => {
  const env = world(); // Mon 10:30, Web Technology Lab 10:00–12:00, s1/s2/s3 enrolled
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  const fac = env.as('faculty@karunya.edu');
  let r = fac('roster', { sessionId: 'C-23CS2048' }).data;
  assert.strictEqual(r.ended, false);
  assert.deepStrictEqual(r.missing.map((x) => x.reg_no).sort(), ['URK24CS1002', 'URK24CS1003']);
  fac('markAttendance', { sessionId: 'C-23CS2048', email: 's3@karunya.edu.in', mark: 'ABSENT', reason: 'On medical leave' });

  env.setIst('2026-10-19', '12:05');
  env.session.active = '';
  const out = env.run('jobAutoClose()');
  assert.strictEqual(out.missing_emails, 1);
  const mail = env.mail.find((m) => /Missing from 23CS2048/.test(m.subject));
  assert.strictEqual(mail.to, 'faculty@karunya.edu');
  assert.match(mail.body, /URK24CS1002  Student Two/);
  assert.match(mail.body, /URK24CS1003  Student Three  \(marked absent: On medical leave\)/);
  assert.ok(!/URK24CS1001/.test(mail.body), 'present students are not listed');
  env.setIst('2026-10-19', '12:15');
  env.session.active = '';
  assert.strictEqual(env.run('jobAutoClose()').missing_emails, 0, 'sent once per session per day');
  r = fac('roster', { sessionId: 'C-23CS2048' }).data;
  assert.strictEqual(r.ended, true);
});

/* ---------------- GPS live mode: is the person still inside, all session ---------------- */

function liveIn(env, email, reason) {
  scan(env, email);
  const r = checkIn(env, email, INSIDE, reason || { type: 'RESEARCH', purpose: 'Thesis experiments', equipment: 'None', projectId: 'P-' + email.slice(0, 2).toUpperCase() });
  assert.ok(r.ok && r.data.visit, 'check-in: ' + JSON.stringify(r));
  return r.data.visit.visit_id;
}
const ping = (env, email, loc) => env.as(email)('presencePing', { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy, posAgeMs: 2000 });
const rowFor = (env, email) => env.as('staff@karunya.edu')('inside', { labId: 'AIIOT' }).data.filter((x) => x.email === email)[0];

test('Live mode: inside pings keep a student In; two outside pings mark them Out; coming back marks them In', () => {
  const env = world();
  liveIn(env, 's2@karunya.edu.in');
  assert.strictEqual(rowFor(env, 's2@karunya.edu.in').presence.state, 'IN', 'starts In at check-in');
  env.advance(60);
  assert.strictEqual(ping(env, 's2@karunya.edu.in', INSIDE).data.state, 'IN');
  env.advance(60);
  assert.strictEqual(ping(env, 's2@karunya.edu.in', HOSTEL).data.state, 'IN', 'one stray outside reading never flips the state');
  env.advance(60);
  assert.strictEqual(ping(env, 's2@karunya.edu.in', HOSTEL).data.state, 'OUT');
  const row = rowFor(env, 's2@karunya.edu.in');
  assert.strictEqual(row.presence.state, 'OUT');
  assert.ok(row.presence.out_since > 0);
  assert.strictEqual(env.as('staff@karunya.edu')('staffSummary', { labId: 'AIIOT' }).data.presence.out, 1);
  env.advance(60);
  assert.strictEqual(ping(env, 's2@karunya.edu.in', INSIDE).data.state, 'IN');
  const acts = auditActions(env);
  assert.ok(acts.includes('PRESENCE_OUT') && acts.includes('PRESENCE_BACK'), acts.join(','));
});

test('Live mode: poor accuracy or the lab edge never marks someone Out', () => {
  const env = world();
  liveIn(env, 's2@karunya.edu.in');
  const fuzzy = { lat: HOSTEL.lat, lng: HOSTEL.lng, accuracy: 300 };
  for (let i = 0; i < 3; i++) { env.advance(60); assert.notStrictEqual(ping(env, 's2@karunya.edu.in', fuzzy).data.state, 'OUT'); }
  for (let i = 0; i < 3; i++) { env.advance(60); assert.strictEqual(ping(env, 's2@karunya.edu.in', EDGE).data.state, 'IN', 'edge of the lab within GPS margin'); }
});

test('Live mode: no ping shows Not seen; out or unseen too long checks out at the last time seen inside', () => {
  const env = world();
  const v = liveIn(env, 's2@karunya.edu.in');
  env.advance(120);
  ping(env, 's2@karunya.edu.in', INSIDE);
  const lastInside = env.clock.ms;
  env.advance(6 * 60);
  assert.strictEqual(rowFor(env, 's2@karunya.edu.in').presence.state, 'NOT_SEEN');
  env.session.active = '';
  assert.strictEqual(env.run('jobAutoClose()').left_during_session, 0, 'not yet past the limit');
  env.advance(10 * 60);
  env.session.active = '';
  assert.strictEqual(env.run('jobAutoClose()').left_during_session, 1);
  const h = env.as('s2@karunya.edu.in')('myHistory').data[0];
  assert.strictEqual(h.visit_id, v);
  assert.strictEqual(h.close_type, 'LEFT_DURING_SESSION');
  assert.strictEqual(new Date(h.check_out_at).getTime(), lastInside, 'hours stop at the last time seen inside');
  assert.ok(auditActions(env).includes('LEFT_DURING_SESSION'));
  assert.strictEqual(ping(env, 's2@karunya.edu.in', INSIDE).data.active, false, 'the page learns it was checked out');
});

test('Live mode: walking out for good checks out from the moment of the last inside reading', () => {
  const env = world();
  liveIn(env, 's2@karunya.edu.in');
  env.advance(60);
  ping(env, 's2@karunya.edu.in', INSIDE);
  const lastInside = env.clock.ms;
  for (let i = 0; i < 16; i++) { env.advance(60); ping(env, 's2@karunya.edu.in', HOSTEL); }
  env.session.active = '';
  assert.strictEqual(env.run('jobAutoClose()').left_during_session, 1);
  const h = env.as('s2@karunya.edu.in')('myHistory').data[0];
  assert.strictEqual(h.close_type, 'LEFT_DURING_SESSION');
  assert.strictEqual(new Date(h.check_out_at).getTime(), lastInside);
});

test('Live mode: manual entries are not watched; turning the setting off stops it; no coordinates stored', () => {
  const env = world();
  const staff = env.as('staff@karunya.edu');
  assert.ok(staff('manualEntry', { email: 's3@karunya.edu.in', labId: 'AIIOT', reason: { type: 'RESEARCH', purpose: 'Supervised work', equipment: 'None' }, why: 'Location blocked' }).ok);
  assert.strictEqual(rowFor(env, 's3@karunya.edu.in').presence.state, 'NOT_WATCHED');
  assert.strictEqual(ping(env, 's3@karunya.edu.in', HOSTEL).data.watched, false);
  liveIn(env, 's2@karunya.edu.in');
  ping(env, 's2@karunya.edu.in', HOSTEL);
  const dump = JSON.stringify(['Visits', 'ActiveVisits', 'AuditLog'].map((t) => env.rows(t)));
  assert.ok(!dump.includes(String(HOSTEL.lat)) && !dump.includes('10.954'), 'no coordinates in any sheet');
  const admin = env.as('admin@karunya.edu');
  assert.ok(admin('saveGlobal', { presence_enabled: false }).ok);
  env.advance(30 * 60);
  env.session.active = '';
  assert.strictEqual(env.run('jobAutoClose()').left_during_session, 0);
  assert.strictEqual(rowFor(env, 's2@karunya.edu.in').presence.state, 'NOT_WATCHED');
  assert.ok(!admin('saveGlobal', { presence_ping_sec: 60, presence_not_seen_min: 1 }).ok, 'Not seen must allow two missed pings');
});

/* ---------------- Email-code sign-in ---------------- */

const anon = (env) => (action, payload) => env.as('')(action, payload);
const lastCode = (env, to) => {
  const m = env.mail.filter((x) => x.to === to).slice(-1)[0];
  return m ? (m.subject.match(/\d{6}/) || [''])[0] : '';
};
function signIn(env, email) {
  assert.ok(anon(env)('authStart', { email }).ok);
  const r = anon(env)('authVerify', { email, code: lastCode(env, email) });
  assert.ok(r.ok, JSON.stringify(r));
  return r.data.token;
}

test('Sign-in code: emailed from LabPulse with the code in the subject; only Karunya emails', () => {
  const env = world();
  const r = anon(env)('authStart', { email: '  URK24CS7777@karunya.edu.in ' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.data.newUser, true);
  assert.match(r.data.masked, /^ur•••7@karunya\.edu\.in$/);
  const m = env.mail.slice(-1)[0];
  assert.strictEqual(m.to, 'urk24cs7777@karunya.edu.in');
  assert.match(m.subject, /^\d{6} is your LabPulse code$/);
  assert.strictEqual(m.opts.name, 'LabPulse');
  assert.match(m.opts.htmlBody, /expires in 10 minutes/);
  assert.strictEqual(anon(env)('authStart', { email: 'someone@gmail.com' }).code, 'DOMAIN');
  assert.strictEqual(anon(env)('authStart', { email: 'not-an-email' }).code, 'INVALID');
  const dump = JSON.stringify(env.rows('AuditLog')) + JSON.stringify(env.rows('Sessions'));
  assert.ok(!dump.includes(lastCode(env, 'urk24cs7777@karunya.edu.in')), 'the code is never written to a sheet');
});

test('Sign-in code: resend waits a minute, at most 5 an hour', () => {
  const env = world();
  const email = 'urk24cs7777@karunya.edu.in';
  assert.ok(anon(env)('authStart', { email }).ok);
  const again = anon(env)('authStart', { email });
  assert.strictEqual(again.data.sent, false, 'within a minute: no second email, back to the code screen');
  assert.strictEqual(env.mail.filter((m) => m.to === email).length, 1);
  for (let i = 0; i < 4; i++) { env.advance(61); assert.ok(anon(env)('authStart', { email }).ok, 'send ' + (i + 2)); }
  env.advance(61);
  const r = anon(env)('authStart', { email });
  assert.strictEqual(r.code, 'RATE');
  assert.match(r.message, /hour/);
  const first = lastCode(env, email);
  assert.ok(anon(env)('authVerify', { email, code: first }).ok, 'the newest code still works');
});

test('Sign-in code: wrong codes count down and lock; codes expire after 10 minutes', () => {
  const env = world();
  const email = 's1@karunya.edu.in';
  anon(env)('authStart', { email });
  const good = lastCode(env, email);
  const bad = good === '000000' ? '111111' : '000000';
  let r = anon(env)('authVerify', { email, code: bad });
  assert.strictEqual(r.code, 'CODE_WRONG');
  assert.match(r.message, /4 tries left/);
  for (let i = 0; i < 3; i++) anon(env)('authVerify', { email, code: bad });
  r = anon(env)('authVerify', { email, code: bad });
  assert.strictEqual(r.code, 'CODE_LOCKED');
  assert.strictEqual(anon(env)('authVerify', { email, code: good }).code, 'CODE_EXPIRED', 'locked code is gone');
  assert.ok(auditActions(env).includes('SECURITY_OTP_LOCKED'));
  env.advance(61);
  anon(env)('authStart', { email });
  const later = lastCode(env, email);
  env.advance(601);
  assert.strictEqual(anon(env)('authVerify', { email, code: later }).code, 'CODE_EXPIRED');
});

test('Sign-in code: the session identifies the person, survives reloads, and sign-out ends it', () => {
  const env = world();
  const token = signIn(env, 's1@karunya.edu.in');
  assert.match(token, /^[a-f0-9]{64}$/);
  const sessions = env.rows('Sessions');
  assert.strictEqual(sessions.length, 2, 'one session row');
  assert.ok(!JSON.stringify(sessions).includes(token), 'only a hash of the token is stored');
  const me = anon(env)('bootstrap', { __s: token });
  assert.ok(me.ok, JSON.stringify(me));
  assert.strictEqual(me.data.me.email, 's1@karunya.edu.in');
  assert.strictEqual(me.data.me.role, 'STUDENT');
  // the token is only proof of identity; it is not passed on to the action
  assert.ok(anon(env)('myHistory', { __s: token }).ok);
  assert.strictEqual(anon(env)('bootstrap', { __s: 'f'.repeat(64) }).code, 'SESSION_EXPIRED');
  assert.strictEqual(anon(env)('bootstrap', {}).code, 'NO_IDENTITY');
  assert.ok(anon(env)('authSignOut', { __s: token }).ok);
  assert.strictEqual(anon(env)('bootstrap', { __s: token }).code, 'SESSION_EXPIRED');
  assert.ok(auditActions(env).includes('LOGIN_OTP'));
});

test('Sign-in code: a brand-new email signs up, registers and checks in by QR scanned before signing in', () => {
  const env = world();
  const email = 'urk24cs7777@karunya.edu.in';
  // Phone scans the QR before signing in: the scan is held as a pass.
  const tick = env.as('staff@karunya.edu')('monitorTick', { labId: 'AIIOT' });
  env.session.active = '';
  env.ctx.Db.reset();
  const page = env.ctx.doGet({ parameter: { t: tick.data.token } });
  assert.strictEqual(page.boot.view, 'checkin');
  assert.ok(!page.boot.init, 'nobody identified yet');
  assert.strictEqual(page.boot.pass.ok, true);
  env.session.active = '';
  env.ctx.Db.reset();
  assert.strictEqual(env.ctx.doGet({ parameter: { t: tick.data.token } }).boot.pass.code, 'QR_REUSED', 'one scan, one pass');

  const token = signIn(env, email);
  const call = (a, p) => anon(env)(a, Object.assign({ __s: token }, p || {}));
  assert.strictEqual(call('bootstrap').data.me.registered, false);
  assert.ok(call('register', { name: 'New Student', reg_no: 'URK24CS7777', mobile: '9876543210' }).ok);
  const claim = call('claimPass', { pass: page.boot.pass.pass });
  assert.strictEqual(claim.data.ok, true, JSON.stringify(claim));
  assert.strictEqual(call('claimPass', { pass: page.boot.pass.pass }).data.ok, false, 'a pass is used once');
  const r = call('checkIn', { labId: 'AIIOT', lat: INSIDE.lat, lng: INSIDE.lng, accuracy: INSIDE.accuracy, reason: { type: 'COURSE', sessionId: 'C-23CS2048' } });
  assert.ok(r.ok && r.data.outcome === 'GREEN', JSON.stringify(r));
  // The wall monitor works with a staff session too.
  const staffToken = signIn(env, 'staff@karunya.edu');
  env.session.active = '';
  env.ctx.Db.reset();
  const mon = env.ctx.doGet({ parameter: { view: 'monitor', lab: 'AIIOT' } });
  assert.strictEqual(mon.file, 'Monitor');
  assert.ok(anon(env)('monitorTick', { labId: 'AIIOT', __s: staffToken }).ok);
  assert.strictEqual(anon(env)('monitorTick', { labId: 'AIIOT', __s: token }).code, 'FORBIDDEN', 'a student session cannot run the monitor');
});

test('3D twin: room, placed desks and every person with seat and live state; HOD can see it, students cannot', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE, { type: 'RESEARCH', purpose: 'Sensor calibration', equipment: 'None', projectId: 'P-S1', systemId: 'PC-02' });
  scan(env, 's2@karunya.edu.in');
  checkIn(env, 's2@karunya.edu.in', INSIDE, { type: 'RESEARCH', purpose: 'Drone mapping', equipment: 'None', projectId: 'P-S2' });
  env.advance(60); env.as('s2@karunya.edu.in')('presencePing', { lat: HOSTEL.lat, lng: HOSTEL.lng, accuracy: 10 });
  env.advance(60); env.as('s2@karunya.edu.in')('presencePing', { lat: HOSTEL.lat, lng: HOSTEL.lng, accuracy: 10 });
  const r = env.as('hod@karunya.edu')('labTwin', { labId: 'AIIOT' });
  assert.ok(r.ok, JSON.stringify(r));
  const d = r.data;
  assert.ok(d.cols > 0 && d.rows > 0);
  assert.ok(d.assets.length > 5 && d.assets.every((a) => Number.isFinite(a.x) && Number.isFinite(a.y)));
  assert.strictEqual(d.assets.filter((a) => a.asset_id === 'PC-02')[0].status, 'IN_USE');
  const s1 = d.people.filter((p) => p.reg_no === 'URK24CS1001')[0];
  const s2 = d.people.filter((p) => p.reg_no === 'URK24CS1002')[0];
  assert.strictEqual(s1.system_id, 'PC-02');
  assert.strictEqual(s1.state, 'IN');
  assert.strictEqual(s2.state, 'OUT');
  assert.ok(s2.state_since > 0);
  assert.ok(!JSON.stringify(d).includes('mobile') && !JSON.stringify(d).includes(String(HOSTEL.lat)), 'no phone numbers or coordinates');
  assert.strictEqual(env.as('s1@karunya.edu.in')('labTwin', { labId: 'AIIOT' }).code, 'FORBIDDEN');
});

/* ---------------- Virtual boundary: the drawn outline of the room ---------------- */

// A 20 m × 12 m room centred on the lab: corners as [lat, lng].
const M_LAT = 1 / 111195;
const M_LNG = 1 / (111195 * Math.cos(LAB.lat * Math.PI / 180));
const spot = (eastM, northM, acc) => ({ lat: LAB.lat + northM * M_LAT, lng: LAB.lng + eastM * M_LNG, accuracy: acc || 5 });
const ROOM = [[-10, -6], [10, -6], [10, 6], [-10, 6]].map(([e, n]) => { const p = spot(e, n); return [p.lat, p.lng]; });
function drawRoom(env) {
  const admin = env.as('admin@karunya.edu');
  const cur = admin('settingsGet').data.labs.filter((l) => l.lab_id === 'AIIOT')[0];
  const r = admin('saveLab', Object.assign({}, cur, { boundary: JSON.stringify(ROOM) }));
  assert.ok(r.ok, JSON.stringify(r));
  return r.data;
}

test('Virtual boundary: the drawn room outline decides inside/outside, not the 20 m circle', () => {
  const env = world();
  const saved = drawRoom(env);
  assert.strictEqual(saved.boundary.length, 4);
  assert.ok(Math.abs(saved.lat - LAB.lat) < 1e-5 && Math.abs(saved.lng - LAB.lng) < 1e-5, 'centre follows the outline');
  const ev = (p) => env.run(`Geo.evaluate(Settings.lab('AIIOT'), ${JSON.stringify(p)}, null, null, U.now().getTime())`);
  assert.strictEqual(ev(spot(8, 4)).level, 'GREEN', 'inside the room');
  const corridor = ev(spot(0, 15, 5)); // 15 m north: inside the old 20 m circle, but 9 m outside the room
  assert.strictEqual(corridor.level, 'RED', JSON.stringify(corridor));
  assert.match(corridor.reasons[0], /9 m outside the lab boundary/);
  const nearWall = ev(spot(0, 8, 8)); // 2 m outside the wall, GPS ±8 m
  assert.strictEqual(nearWall.level, 'AMBER');
  assert.match(nearWall.reasons[0], /Just outside the lab boundary/);
  assert.strictEqual(ev(HOSTEL).level, 'RED');
  // The real check-in uses it too.
  scan(env, 's1@karunya.edu.in');
  assert.strictEqual(checkIn(env, 's1@karunya.edu.in', spot(0, 15, 5)).data.outcome, 'RED');
  scan(env, 's2@karunya.edu.in');
  assert.strictEqual(checkIn(env, 's2@karunya.edu.in', spot(-6, -3, 6)).data.outcome, 'GREEN');
});

test('Virtual boundary: GPS live mode marks someone in the corridor as Out', () => {
  const env = world();
  drawRoom(env);
  scan(env, 's2@karunya.edu.in');
  checkIn(env, 's2@karunya.edu.in', spot(0, 0), { type: 'RESEARCH', purpose: 'Thesis experiments', equipment: 'None', projectId: 'P-S2' });
  const ping = (p) => env.as('s2@karunya.edu.in')('presencePing', { lat: p.lat, lng: p.lng, accuracy: p.accuracy, posAgeMs: 1000 }).data;
  env.advance(60); assert.strictEqual(ping(spot(5, 2)).state, 'IN');
  env.advance(60); ping(spot(0, 16, 5));
  env.advance(60); assert.strictEqual(ping(spot(0, 16, 5)).state, 'OUT', 'corridor 10 m outside the room');
  const b = env.as('staff@karunya.edu')('labBoundary', { labId: 'AIIOT' }).data;
  assert.strictEqual(b.shape, 'polygon');
  assert.ok(Math.abs(b.area_m2 - 240) < 3, 'area ' + b.area_m2);
  assert.strictEqual(b.presence.out, 1);
  assert.strictEqual(env.as('s1@karunya.edu.in')('labBoundary', { labId: 'AIIOT' }).code, 'FORBIDDEN');
});

test('Virtual boundary: validation, and clearing it goes back to the circle', () => {
  const env = world();
  const admin = env.as('admin@karunya.edu');
  const cur = admin('settingsGet').data.labs[0];
  assert.match(admin('saveLab', Object.assign({}, cur, { boundary: JSON.stringify(ROOM.slice(0, 2)) })).message, /at least 3 corners/);
  const far = ROOM.slice(0, 3).concat([[LAB.lat + 0.05, LAB.lng]]);
  assert.match(admin('saveLab', Object.assign({}, cur, { boundary: JSON.stringify(far) })).message, /within 1 km/);
  drawRoom(env);
  assert.ok(admin('saveLab', Object.assign({}, admin('settingsGet').data.labs[0], { boundary: '' })).ok);
  assert.strictEqual(env.as('staff@karunya.edu')('labBoundary', { labId: 'AIIOT' }).data.shape, 'circle');
  assert.ok(auditActions(env).includes('SETTINGS_LAB'));
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
console.log('\n' + (results.length - failed) + '/' + results.length + ' v2 checks passed');
process.exit(failed ? 1 : 0);
