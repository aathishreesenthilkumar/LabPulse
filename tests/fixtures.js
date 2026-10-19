/** Shared test world: one lab, demo data and one registered user per role. */
"use strict";
const assert = require("assert");
const { createEnv } = require("./harness");

const LAB = { lat: 10.9364, lng: 76.7442 };
const INSIDE = { lat: LAB.lat + 0.00004, lng: LAB.lng, accuracy: 8 }; // ~4 m from centre
const EDGE = { lat: LAB.lat + 0.0002, lng: LAB.lng, accuracy: 25 }; // ~22 m, within GPS uncertainty
const FAR = { lat: LAB.lat + 0.0045, lng: LAB.lng, accuracy: 10 }; // ~500 m
const HOSTEL = { lat: LAB.lat + 0.018, lng: LAB.lng, accuracy: 10 }; // ~2 km


/** A fresh world: one lab, demo catalog and sessions, and one registered user per role. */
function world() {
  const env = createEnv();
  env.setIst('2026-10-19', '10:30'); // Monday, inside hours and inside the 23CS2048 slot
  env.session.active = 'owner@karunya.edu';
  env.run(`
    Db.insert('Config', { lab_id: 'AIIOT', name: 'Intel Unnati IoT Lab', lat: ${LAB.lat}, lng: ${LAB.lng}, radius_m: 20,
      open_time: '08:00', close_time: '20:00', open_days: 'MON,TUE,WED,THU,FRI,SAT', accuracy_limit_m: 30,
      amber_margin_m: 30, speed_flag_kmh: 25, speed_block_kmh: 200, qr_rotate_sec: 8, grace_min: 15,
      incharge_email: 'incharge@karunya.edu', map_cols: 8, map_rows: 5, active: true, updated_at: U.now() });
    Settings.syncFromSheet();
  `);
  env.run('seedDemoData()');
  env.run(`
    [['admin@karunya.edu','SUPER_ADMIN'],['staff@karunya.edu','STAFF'],['faculty@karunya.edu','FACULTY'],
     ['coord@karunya.edu','COORDINATOR'],['hod@karunya.edu','HOD']].forEach(function (x) {
      Db.insert('Users', { user_id: U.id('U'), email: x[0], name: '', reg_no: '', mobile: '', role: x[1], active: true, created_at: U.now(), updated_at: U.now() });
    });
    Db.update('CoursesEvents', Db.byId('CoursesEvents', 'C-23CS2048'), { coordinator_email: 'faculty@karunya.edu' });
    Db.update('CoursesEvents', Db.byId('CoursesEvents', 'C-DEMO'), { coordinator_email: 'faculty@karunya.edu' });
    Db.insertMany('Enrollments', [
      { session_id: 'C-23CS2048', user_email: 's1@karunya.edu.in' },
      { session_id: 'C-23CS2048', user_email: 's2@karunya.edu.in' },
      { session_id: 'C-23CS2048', user_email: 's3@karunya.edu.in' }
    ]);
    // One active project per student, for extra-hours (research) check-ins.
    ['s1', 's2', 's3'].forEach(function (s, i) {
      Db.insert('Projects', { project_id: 'P-' + s.toUpperCase(), lab_id: 'AIIOT', title: ['Smart Irrigation with ESP32', 'Drone Crop Survey', 'Edge AI Camera'][i],
        description: 'Demo project', owner_email: s + '@karunya.edu.in', members: '', start_date: '2026-10-01', end_date: '2026-12-15',
        status: 'ACTIVE', outcome: '', outcome_link: '', created_at: U.now(), updated_at: U.now() });
    });
  `);
  const reg = (email, name, regNo, mobile) => {
    const r = env.as(email)('register', { name, reg_no: regNo, mobile });
    assert.ok(r.ok, email + ' register: ' + JSON.stringify(r));
  };
  reg('admin@karunya.edu', 'Admin One', 'EMP001', '9876500001');
  reg('staff@karunya.edu', 'Staff One', 'EMP002', '9876500002');
  reg('faculty@karunya.edu', 'Dr Faculty', 'EMP003', '9876500003');
  reg('coord@karunya.edu', 'Lab Coordinator', 'EMP004', '9876500004');
  reg('hod@karunya.edu', 'HOD CSE', 'EMP005', '9876500005');
  reg('s1@karunya.edu.in', 'Student One', 'URK24CS1001', '9876500011');
  reg('s2@karunya.edu.in', 'Student Two', 'URK24CS1002', '9876500012');
  reg('s3@karunya.edu.in', 'Student Three', 'URK24CS1003', '9876500013');
  return env;
}

/** Monitor shows a QR; the student scans it (doGet → claim). */
function scan(env, email) {
  const tick = env.as('staff@karunya.edu')('monitorTick', { labId: 'AIIOT' });
  assert.ok(tick.ok && tick.data.open, 'monitor tick: ' + JSON.stringify(tick));
  env.session.active = email;
  env.ctx.Db.reset();
  const claim = JSON.parse(JSON.stringify(env.ctx.Attendance.claim(env.ctx.Auth.context(), tick.data.token)));
  return { token: tick.data.token, claim };
}

function checkIn(env, email, loc, reason, extra) {
  return env.as(email)('checkIn', Object.assign({
    labId: 'AIIOT', lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy,
    reason: reason || { type: 'COURSE', sessionId: 'C-23CS2048' }
  }, extra || {}));
}

function auditActions(env) {
  return env.rows('AuditLog').slice(1).map((r) => r[4]);
}

module.exports = { LAB, INSIDE, EDGE, FAR, HOSTEL, world, scan, checkIn, auditActions };
