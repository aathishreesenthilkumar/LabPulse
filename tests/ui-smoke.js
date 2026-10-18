/**
 * UI smoke test: renders the real HTML/JS in jsdom with google.script.run wired straight to
 * the server code (via the harness), then walks every tab for every role, the phone check-in
 * flow and the lab monitor. Fails on any script error or any "Could not load" panel.
 * Usage: node tests/ui-smoke.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');
const { INSIDE, world, scan } = require('./fixtures');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 25));
async function settle() { for (let i = 0; i < 12; i++) await wait(10); }

function page(file, boot, env, email, opts) {
  opts = opts || {};
  const html = read(file)
    .replace(/<script src="[^"]+"><\/script>/g, '')
    .replace(/<\?!= include_\('Styles'\); \?>/, read('Styles.html'))
    .replace(/<\?!= include_\('Client'\); \?>/, read('Client.html'))
    .replace(/<\?!= bootJson \?>/, JSON.stringify(boot).replace(/</g, '\\u003c'));
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message + (e.detail ? ' ' + (e.detail.stack || e.detail) : '')));
  vc.on('error', (e) => errors.push(String(e)));
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://script.google.com/macros/s/TEST/exec',
    virtualConsole: vc,
    beforeParse(win) {
      win.google = {
        script: {
          get run() {
            const h = { ok: null, fail: null };
            const runner = {
              withSuccessHandler(f) { h.ok = f; return runner; },
              withFailureHandler(f) { h.fail = f; return runner; },
              api(action, payload) {
                calls.push(action);
                setTimeout(() => {
                  const r = env.as(email)(action, JSON.parse(JSON.stringify(payload || {})));
                  if (h.ok) h.ok(r);
                }, 0);
              }
            };
            return runner;
          }
        }
      };
      Object.defineProperty(win.navigator, 'geolocation', {
        value: {
          watchPosition(ok) {
            setTimeout(() => ok({ coords: { latitude: INSIDE.lat, longitude: INSIDE.lng, accuracy: 8 }, timestamp: Date.now() }), 0);
            return 1;
          },
          clearWatch() {},
          getCurrentPosition(ok) { ok({ coords: { latitude: INSIDE.lat, longitude: INSIDE.lng, accuracy: 6 } }); }
        }
      });
      win.URL.createObjectURL = () => 'blob:test';
      win.URL.revokeObjectURL = () => {};
      win.open = () => null;
      win.scrollTo = () => {}; // not implemented by jsdom
      if (opts.qr) {
        win.QRCode = function () { this.makeCode = (t) => opts.qr.push(t); this.clear = () => {}; };
        win.QRCode.CorrectLevel = { M: 0 };
      }
    }
  });
  return { dom, win: dom.window, doc: dom.window.document, errors, calls };
}

function bootFor(env, email, extra) {
  const init = env.as(email)('bootstrap');
  assert.ok(init.ok, JSON.stringify(init));
  return Object.assign({ view: 'app', webAppUrl: 'https://script.google.com/macros/s/TEST/exec', init: init.data }, extra || {});
}

function click(p, selector) {
  const el = p.doc.querySelector(selector);
  assert.ok(el, 'missing element ' + selector);
  el.dispatchEvent(new p.win.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function assertClean(p, where) {
  const failures = Array.from(p.doc.querySelectorAll('#app .bg-red-50')).map((e) => e.textContent.trim());
  assert.deepStrictEqual(p.errors, [], where + ': script errors');
  assert.deepStrictEqual(failures, [], where + ': error panels');
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, name, e]);
  }
}

(async () => {
  await test('every tab renders for every role without errors', async () => {
    const env = world();
    scan(env, 's1@karunya.edu.in');
    env.as('s1@karunya.edu.in')('checkIn', { labId: 'AIIOT', lat: INSIDE.lat, lng: INSIDE.lng, accuracy: 80, reason: { type: 'COURSE', sessionId: 'C-23CS2048' } });
    const expectTabs = {
      's1@karunya.edu.in': ['home', 'history'],
      'faculty@karunya.edu': ['sessions', 'reviews', 'reports'],
      'staff@karunya.edu': ['live', 'reviews', 'inventory', 'courses', 'reports'],
      'admin@karunya.edu': ['live', 'sessions', 'reviews', 'inventory', 'courses', 'reports', 'settings', 'people', 'audit']
    };
    for (const [email, tabs] of Object.entries(expectTabs)) {
      const p = page('Index.html', bootFor(env, email), env, email);
      await settle();
      const shown = Array.from(p.doc.querySelectorAll('[data-act="tab"][role="tab"]')).map((b) => b.dataset.tab);
      assert.deepStrictEqual(shown, tabs, email + ' tabs');
      for (const t of tabs) {
        click(p, '[role="tab"][data-tab="' + t + '"]');
        await settle();
        assertClean(p, email + ' › ' + t);
      }
      assert.match(p.doc.getElementById('occ-pill').textContent, /0 inside\s*· 1 pending/, 'Amber check-in is shown as pending, not counted');
    }
  });

  await test('student dashboard shows status, free chips, map and request flow', async () => {
    const env = world();
    scan(env, 's1@karunya.edu.in');
    env.as('s1@karunya.edu.in')('checkIn', { labId: 'AIIOT', lat: INSIDE.lat, lng: INSIDE.lng, accuracy: 8, reason: { type: 'COURSE', sessionId: 'C-23CS2048' } });
    const p = page('Index.html', bootFor(env, 's1@karunya.edu.in'), env, 's1@karunya.edu.in');
    await settle();
    const text = p.doc.body.textContent;
    assert.match(text, /Checked in · 0m/);
    assert.match(text, /4 ESP32|5 ESP32/);
    assert.match(text, /not physical sensors/);
    click(p, '[data-act="request-asset"]');
    await settle();
    const form = p.doc.getElementById('modal-form');
    assert.ok(form, 'request modal opens');
    form.querySelector('[name=assetId]').value = 'RPI-02';
    form.dispatchEvent(new p.win.Event('submit', { cancelable: true }));
    await settle();
    assert.ok(!p.doc.getElementById('modal-form'), 'modal closes after a successful request');
    assert.match(p.doc.body.textContent, /Requested/);
    click(p, '[data-act="checkout"]');
    await settle();
    assert.match(p.doc.body.textContent, /Not checked in/);
    assertClean(p, 'student home');
  });

  await test('phone check-in flow: scan → location → reason → Checked in', async () => {
    const env = world();
    const { claim } = scan(env, 's2@karunya.edu.in');
    const p = page('Index.html', bootFor(env, 's2@karunya.edu.in', { view: 'checkin', claim }), env, 's2@karunya.edu.in');
    await settle();
    assert.match(p.doc.body.textContent, /Checking in to\s*AI & IoT Lab/);
    assert.match(p.doc.getElementById('loc-status').textContent, /Location ready/);
    assert.ok(p.doc.getElementById('ci-submit').disabled, 'submit waits for a reason');
    click(p, '[data-act="ci-type"][data-type="RESEARCH"]');
    const purpose = p.doc.querySelector('[data-bind="purpose"]');
    purpose.value = 'Calibrating LiDAR';
    purpose.dispatchEvent(new p.win.Event('input', { bubbles: true }));
    const eq = p.doc.querySelector('[data-bind="equipment"]');
    eq.value = 'LiDAR unit';
    eq.dispatchEvent(new p.win.Event('input', { bubbles: true }));
    assert.ok(!p.doc.getElementById('ci-submit').disabled, 'submit enabled');
    click(p, '#ci-submit');
    await settle();
    assert.match(p.doc.body.textContent, /Checked in/);
    assert.match(p.doc.body.textContent, /Research: Calibrating LiDAR/);
    click(p, '[data-act="ci-done"]');
    await settle();
    assert.match(p.doc.body.textContent, /Checked in · /);
    assertClean(p, 'check-in');
  });

  await test('check-in with a course that is not in the timetable', async () => {
    const env = world();
    const { claim } = scan(env, 's3@karunya.edu.in');
    const p = page('Index.html', bootFor(env, 's3@karunya.edu.in', { view: 'checkin', claim }), env, 's3@karunya.edu.in');
    await settle();
    click(p, '[data-act="ci-type"][data-type="COURSE"]');
    click(p, '[data-act="ci-manual"]');
    const set = (bind, v) => {
      const el = p.doc.querySelector('[data-bind="' + bind + '"]');
      el.value = v;
      el.dispatchEvent(new p.win.Event('input', { bubbles: true }));
    };
    set('m_code', '23CS3001');
    set('m_name', 'Deep Learning Lab');
    assert.ok(p.doc.getElementById('ci-submit').disabled, 'duration still missing');
    set('m_hours', '2');
    assert.ok(!p.doc.getElementById('ci-submit').disabled);
    click(p, '#ci-submit');
    await settle();
    assert.match(p.doc.body.textContent, /Checked in — pending review/);
    assert.match(p.doc.body.textContent, /not in the timetable/);
    assertClean(p, 'unlisted check-in');
  });

  await test('research check-in picks equipment from the catalog chips', async () => {
    const env = world();
    const { claim } = scan(env, 's2@karunya.edu.in');
    const p = page('Index.html', bootFor(env, 's2@karunya.edu.in', { view: 'checkin', claim }), env, 's2@karunya.edu.in');
    await settle();
    click(p, '[data-act="ci-type"][data-type="RESEARCH"]');
    const purpose = p.doc.querySelector('[data-bind="purpose"]');
    purpose.value = 'Point cloud mapping';
    purpose.dispatchEvent(new p.win.Event('input', { bubbles: true }));
    assert.ok(p.doc.getElementById('ci-submit').disabled, 'needs equipment');
    click(p, '[data-act="ci-equip"][data-type="LiDAR"]');
    assert.ok(!p.doc.getElementById('ci-submit').disabled);
    click(p, '#ci-submit');
    await settle();
    assert.match(p.doc.body.textContent, /Checked in/);
    const stored = JSON.parse(env.rows('Visits')[1][7]);
    assert.strictEqual(stored.equipment, 'LiDAR');
    assertClean(p, 'equipment chips');
  });

  await test('staff can export Excel from the Reports tab', async () => {
    const env = world();
    const p = page('Index.html', bootFor(env, 'staff@karunya.edu'), env, 'staff@karunya.edu');
    await settle();
    click(p, '[role="tab"][data-tab="reports"]');
    await settle();
    click(p, '[data-act="report-kind"][data-kind="export"]');
    await settle();
    click(p, '[data-act="export-xlsx"]');
    await settle();
    assert.match(p.doc.getElementById('report-out').textContent, /\.xlsx/);
    assertClean(p, 'excel');
  });

  await test('reused QR shows a clear rejection screen', async () => {
    const env = world();
    const first = scan(env, 's1@karunya.edu.in');
    env.session.active = 's2@karunya.edu.in';
    const claim = JSON.parse(JSON.stringify(env.ctx.Attendance.claim(env.ctx.Auth.context(), first.token)));
    const p = page('Index.html', bootFor(env, 's2@karunya.edu.in', { view: 'checkin', claim }), env, 's2@karunya.edu.in');
    await settle();
    assert.match(p.doc.body.textContent, /Not checked in/);
    assert.match(p.doc.body.textContent, /already used/);
    assert.deepStrictEqual(p.errors, []);
  });

  await test('first sign-in shows registration, then the dashboard', async () => {
    const env = world();
    const email = 'newbie@karunya.edu.in';
    const p = page('Index.html', bootFor(env, email), env, email);
    await settle();
    assert.match(p.doc.body.textContent, /Welcome to LabPulse/);
    const f = p.doc.getElementById('reg-form');
    f.querySelector('[name=name]').value = 'New Student';
    f.querySelector('[name=reg_no]').value = 'URK24CS1500';
    f.querySelector('[name=mobile]').value = '9876543210';
    f.dispatchEvent(new p.win.Event('submit', { cancelable: true }));
    await settle();
    assert.match(p.doc.body.textContent, /Not checked in/);
    assertClean(p, 'registration');
  });

  await test('staff handshake: issue and return through the modals', async () => {
    const env = world();
    scan(env, 's1@karunya.edu.in');
    env.as('s1@karunya.edu.in')('checkIn', { labId: 'AIIOT', lat: INSIDE.lat, lng: INSIDE.lng, accuracy: 8, reason: { type: 'COURSE', sessionId: 'C-23CS2048' } });
    env.as('s1@karunya.edu.in')('requestAsset', { assetId: 'GPU-02', hours: 2 });
    const p = page('Index.html', bootFor(env, 'staff@karunya.edu'), env, 'staff@karunya.edu');
    await settle();
    click(p, '[data-act="issue"]');
    p.doc.getElementById('modal-form').dispatchEvent(new p.win.Event('submit', { cancelable: true }));
    await settle();
    assert.ok(!p.doc.getElementById('modal-form'), 'issue modal closed: ' + (p.doc.getElementById('modal-error') || {}).textContent);
    assert.match(p.doc.getElementById('sec-handshake').textContent, /On loan/);
    click(p, '[data-act="return"]');
    p.doc.getElementById('modal-form').dispatchEvent(new p.win.Event('submit', { cancelable: true }));
    await settle();
    assert.match(p.doc.getElementById('sec-handshake').textContent, /No items out/);
    assertClean(p, 'handshake');
  });

  await test('admin can run reports and change a role from the UI', async () => {
    const env = world();
    const p = page('Index.html', bootFor(env, 'admin@karunya.edu'), env, 'admin@karunya.edu');
    await settle();
    click(p, '[role="tab"][data-tab="reports"]');
    await settle();
    click(p, '[data-act="report-run"]');
    await settle();
    assert.match(p.doc.getElementById('report-out').textContent, /Daily Operational Digest/);
    click(p, '[data-act="report-kind"][data-kind="monthly"]');
    await settle();
    click(p, '[data-act="report-run"]');
    await settle();
    assert.match(p.doc.getElementById('report-out').textContent, /Course-wise student-hours/);
    click(p, '[role="tab"][data-tab="people"]');
    await settle();
    const sel = p.doc.querySelector('[data-user-role="s1@karunya.edu.in"]');
    sel.value = 'STAFF';
    sel.dispatchEvent(new p.win.Event('change', { bubbles: true }));
    await settle();
    assert.strictEqual(env.as('admin@karunya.edu')('users').data.find((u) => u.email === 's1@karunya.edu.in').role, 'STAFF');
    assertClean(p, 'admin');
  });

  await test('lab monitor shows a QR link, occupancy and swaps the code after a scan', async () => {
    const env = world();
    const qr = [];
    const boot = bootFor(env, 'staff@karunya.edu', { view: 'monitor', lab: env.run('Settings.publicLab(Settings.labs()[0])') });
    const p = page('Monitor.html', JSON.parse(JSON.stringify(boot)), env, 'staff@karunya.edu', { qr });
    await settle();
    assert.strictEqual(p.doc.getElementById('conn').textContent, 'Online');
    assert.strictEqual(qr.length, 1);
    assert.match(qr[0], /^https:\/\/script\.google\.com\/macros\/s\/TEST\/exec\?t=AIIOT\./);
    const token = decodeURIComponent(qr[0].split('?t=')[1]);
    env.session.active = 's1@karunya.edu.in';
    env.ctx.Attendance.claim(env.ctx.Auth.context(), token);
    await wait(1700); // one monitor poll
    await settle();
    assert.strictEqual(qr.length, 2, 'new QR after consumption');
    assert.notStrictEqual(qr[1], qr[0]);
    assert.deepStrictEqual(p.errors, []);
    p.win.close();
  });

  let failed = 0;
  results.forEach(([ok, name, err]) => {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
    if (!ok) {
      failed++;
      console.log('        ' + (err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n        ') : err));
    }
  });
  console.log('\n' + (results.length - failed) + '/' + results.length + ' UI checks passed');
  process.exit(failed ? 1 : 0);
})();
