/**
 * Tests for the supervisor's v2 requirements (voice messages): roles, live view with systems
 * and projects, reservations with a queue, lookups, archiving, encryption.
 * Usage: node tests/v2.js
 */
'use strict';
const assert = require('assert');
const { INSIDE, world, scan, checkIn, auditActions } = require('./fixtures');

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
  assert.strictEqual(env.as('staff@karunya.edu')('inventorySave', { lab_id: 'AIIOT', name: 'X', category: 'IOT', type: 'ESP32' }).code, 'FORBIDDEN', 'staff no longer edits the catalog');

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

test('Reserving a slot: first comes first, overlaps join the queue, cancel promotes the next', () => {
  const env = world(); // Monday 19 Oct, 10:30 IST
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
  const env = world();
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
  const env = world();
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
  const env = world();
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
