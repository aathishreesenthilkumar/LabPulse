/**
 * "No broken pipes": every server action is called by every kind of user, every button in the
 * UI must have a handler, every server call the UI makes must exist, and the Google-service paths
 * (PDF, email, backups, archive, triggers) run end to end against the fakes.
 * Usage: node tests/routes.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { INSIDE, world, scan, checkIn } = require('./fixtures');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, name, e]);
  }
}

const PERSONAS = {
  's1@karunya.edu.in': 'STUDENT',
  'faculty@karunya.edu': 'FACULTY',
  'staff@karunya.edu': 'STAFF',
  'coord@karunya.edu': 'COORDINATOR',
  'hod@karunya.edu': 'HOD',
  'admin@karunya.edu': 'SUPER_ADMIN',
  'newcomer@karunya.edu.in': null, // signed in, profile not completed
  'someone@gmail.com': 'OUTSIDER'
};

test('every action, called by every kind of user, answers cleanly and obeys the role table', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  const routes = Object.keys(env.ctx.ROUTES);
  assert.ok(routes.length > 60, 'route table loaded (' + routes.length + ')');
  const problems = [];
  routes.forEach((action) => {
    const route = env.ctx.ROUTES[action];
    Object.keys(PERSONAS).forEach((email) => {
      const role = PERSONAS[email];
      [{}, { labId: 'AIIOT' }].forEach((payload) => {
        const r = env.as(email)(action, payload);
        const where = action + ' as ' + email + ' ' + JSON.stringify(payload);
        if (!r || typeof r.ok !== 'boolean') return problems.push(where + ': malformed reply');
        if (r.ok) {
          if (role === 'OUTSIDER') problems.push(where + ': outsider got through');
          return;
        }
        if (r.code === 'SERVER') return problems.push(where + ': SERVER ' + r.message);
        if (!r.message) problems.push(where + ': refusal without a message (' + r.code + ')');
        if (role === 'OUTSIDER' && r.code !== 'DOMAIN') problems.push(where + ': outsider not rejected by domain (' + r.code + ')');
        if (role === null && !route.open && r.code !== 'NOT_REGISTERED') problems.push(where + ': unregistered user not stopped (' + r.code + ')');
        if (role && role !== 'OUTSIDER' && !route.open) {
          const allowed = env.ctx.Api.allowedRoles(action);
          const may = role === 'SUPER_ADMIN' || allowed === null || allowed.indexOf(role) !== -1;
          if (!may && r.code !== 'FORBIDDEN') problems.push(where + ': should be FORBIDDEN, got ' + r.code);
          if (may && r.code === 'FORBIDDEN') problems.push(where + ': allowed role refused');
        }
      });
    });
  });
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(env.ctx.__errors, [], 'no server-side exceptions were logged');
});

test('every button in the UI has a handler, and every server call the UI makes exists', () => {
  const env = world();
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
  const client = src('Client.html');
  const actionsBlock = client.slice(client.indexOf('var ACTIONS = {'));
  const handlers = new Set([...actionsBlock.matchAll(/^\s+'([a-z0-9-]+)':\s/gm)].map((m) => m[1]));
  const used = new Set([...client.matchAll(/data-act="([a-z0-9-]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((a) => !handlers.has(a));
  assert.deepStrictEqual(missing, [], 'buttons without a handler');
  const routes = new Set(Object.keys(env.ctx.ROUTES));
  const calls = new Set([...client.matchAll(/call\('([A-Za-z]+)'/g)].map((m) => m[1]));
  ['monitorTick'].forEach((a) => { if (src('Monitor.html').indexOf(".api('" + a + "'") !== -1) calls.add(a); });
  const unknown = [...calls].filter((a) => !routes.has(a));
  assert.deepStrictEqual(unknown, [], 'UI calls an action the server does not have');
  assert.ok(calls.size > 50, 'UI uses ' + calls.size + ' actions');
});

test('report PDFs are filled from the Docs template and saved to Drive', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  const staff = env.as('staff@karunya.edu');
  [
    ['daily', { kind: 'daily', date: '2026-10-19' }, /Daily Operational Digest/],
    ['monthly', { kind: 'monthly', month: '2026-10' }, /Monthly Institutional Audit/],
    ['range', { kind: 'range', from: '2026-10-01', to: '2026-10-19' }, /Lab Usage Report/]
  ].forEach(([name, p, title]) => {
    const r = staff('reportPdf', Object.assign({ labId: 'AIIOT' }, p));
    assert.ok(r.ok, name + ': ' + JSON.stringify(r));
    assert.match(r.data.name, /\.pdf$/);
  });
  const docs = [...env.gdocs.docs.values()].filter((d) => /^LabPulse_/.test(d.name));
  assert.strictEqual(docs.length, 3, 'one filled copy per report');
  const daily = docs.find((d) => /Daily/.test(d.name));
  const text = daily.blocks.map((b) => (b.kind === 'p' ? b.text : 'TABLE')).join('\n');
  assert.match(text, /Daily Operational Digest/);
  assert.ok(!/\{\{/.test(text), 'no unfilled placeholders');
  assert.ok(daily.blocks.filter((b) => b.kind === 'table').length >= 2, 'KPI table + section tables');
  assert.ok(env.drive.trashed.length >= 3, 'temporary Docs copies are trashed after export');
});

test('EOD email digest, session log, Lab Passport', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  const d = env.as('staff@karunya.edu')('emailDigest', { labId: 'AIIOT', date: '2026-10-19' });
  assert.ok(d.ok, JSON.stringify(d));
  const mail = env.mail.find((m) => /Daily Operational Digest/.test(m.subject));
  assert.strictEqual(mail.to, 'incharge@karunya.edu');
  assert.ok(mail.opts.htmlBody.includes('Unique visitors'));
  assert.strictEqual(mail.opts.attachments.length, 1, 'PDF attached');
  assert.ok(env.as('faculty@karunya.edu')('sessionLogPdf', { sessionId: 'C-23CS2048' }).ok);
  assert.ok(env.as('s1@karunya.edu.in')('myPassport').ok);
});

test('time-driven jobs: digest after closing, monthly audit + archive, backups, triggers', () => {
  const env = world();
  scan(env, 's1@karunya.edu.in');
  checkIn(env, 's1@karunya.edu.in', INSIDE);
  env.setIst('2026-10-19', '20:35');
  env.session.active = '';
  const digests = env.run('jobDailyDigest()');
  assert.strictEqual(digests.length, 1, 'digest sent once the lab has closed');
  assert.strictEqual(env.run('jobDailyDigest()').length, 0, 'not twice the same day');
  env.setIst('2026-10-19', '21:10');
  env.run('jobDailyDigest()');
  assert.strictEqual(env.drive.copies.length, 1, 'nightly spreadsheet backup');
  env.setIst('2026-11-01', '06:00');
  const monthly = env.run('jobMonthlyAudit()');
  assert.ok(monthly.some((x) => typeof x === 'string' && /Monthly/.test(x)), 'monthly report made');
  assert.ok(monthly.some((x) => x && x.before), 'archive ran');
  ['jobReconcile', 'jobAutoClose', 'jobOverdue'].forEach((j) => env.run(j + '()'));
  const admin = env.as('admin@karunya.edu');
  assert.ok(admin('installTriggers').ok);
  assert.ok(admin('installTriggers').ok);
  assert.deepStrictEqual(env.triggers.map((t) => t.fn).sort(), ['jobAutoClose', 'jobDailyDigest', 'jobMonthlyAudit', 'jobOverdue', 'jobReconcile'], 'five triggers, not duplicated');
  ['reconcile', 'autoClose', 'bookings', 'overdue', 'digest', 'rollup', 'archive', 'encrypt', 'backup'].forEach((job) => {
    const r = admin('runJob', { job });
    assert.ok(r.ok, job + ': ' + JSON.stringify(r));
  });
  assert.deepStrictEqual(env.ctx.__errors, []);
});

test('backup retention keeps the newest daily copies and one per older month', () => {
  const env = world();
  env.session.active = '';
  const names = [];
  for (let i = 0; i < 40; i++) names.push('LabPulse backup ' + env.run(`U.addDays('2026-10-19', -${i})`));
  names.forEach((n, i) => env.drive.files.push({ id: 'B' + i, name: n }));
  env.drive.files.forEach((f) => { f.name = f.name; });
  const fileFor = env.gdocs.fileFor;
  env.gdocs.fileFor = (id) => Object.assign(fileFor(id), { getName: () => (env.drive.files.find((f) => f.id === id) || {}).name || id });
  env.ctx.DriveApp.getFileById = env.gdocs.fileFor;
  const folder = env.ctx.DriveApp.createFolder();
  folder.getFiles = () => {
    const list = env.drive.files.slice();
    let i = 0;
    return { hasNext: () => i < list.length, next: () => env.gdocs.fileFor(list[i++].id) };
  };
  const trashed = env.run('pruneBackups_')(folder);
  // 40 days back from 19 Oct: 14 kept in the window, then one each for Oct (older part) and Sep
  assert.strictEqual(trashed, 40 - 14 - 2);
});

let failed = 0;
results.forEach(([ok, name, err]) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  if (!ok) {
    failed++;
    console.log('        ' + (err && err.stack ? err.stack.split('\n').slice(0, 12).join('\n        ') : err));
  }
});
console.log('\n' + (results.length - failed) + '/' + results.length + ' pipeline checks passed');
process.exit(failed ? 1 : 0);
