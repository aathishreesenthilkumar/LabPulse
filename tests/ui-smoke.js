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
    .replace(/<\?!= include_\('(\w+)'\); \?>/g, (m, name) => read(name + '.html'))
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
      win.addEventListener('unhandledrejection', (ev) => errors.push('Unhandled: ' + ((ev.reason && ev.reason.stack) || ev.reason)));
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
      's1@karunya.edu.in': ['home', 'equipment', 'projects', 'history'],
      'faculty@karunya.edu': ['sessions', 'reviews', 'labprojects', 'reports'],
      'staff@karunya.edu': ['live', 'reviews', 'inventory', 'courses', 'lookup', 'labprojects', 'reports'],
      'admin@karunya.edu': ['live', 'sessions', 'reviews', 'inventory', 'courses', 'lookup', 'labprojects', 'reports', 'settings', 'people', 'audit'],
      'coord@karunya.edu': ['live', 'sessions', 'reviews', 'inventory', 'courses', 'lookup', 'labprojects', 'reports', 'students'],
      'hod@karunya.edu': ['live', 'sessions', 'inventory', 'courses', 'lookup', 'labprojects', 'reports']
    };
    for (const [email, tabs] of Object.entries(expectTabs)) {
      const p = page('Index.html', bootFor(env, email), env, email);
      await settle();
      const shown = Array.from(p.doc.querySelectorAll('[data-act="tab"][role="tab"]')).map((b) => b.dataset.tab);
      assert.deepStrictEqual(shown, tabs, email + ' tabs');
      // Lab staff can open the QR wall screen from the menu; students, faculty and the HOD cannot.
      const qrLink = p.doc.querySelector('.lp-side [data-monitor-link]');
      assert.strictEqual(!!qrLink, /^(staff|coord|admin)@/.test(email), email + ' QR screen link');
      if (qrLink) assert.match(qrLink.getAttribute('href'), /view=monitor&lab=AIIOT/);
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
    p.doc.querySelector('#modal-form [name=note]').value = 'Tested the soil sensor';
    p.doc.getElementById('modal-form').dispatchEvent(new p.win.Event('submit', { cancelable: true }));
    await settle();
    assert.match(p.doc.body.textContent, /Not checked in/);
    assertClean(p, 'student home');
  });

  await test('phone check-in flow: scan → location → reason → Checked in', async () => {
    const env = world();
    const { claim } = scan(env, 's2@karunya.edu.in');
    const p = page('Index.html', bootFor(env, 's2@karunya.edu.in', { view: 'checkin', claim }), env, 's2@karunya.edu.in');
    await settle();
    assert.match(p.doc.body.textContent, /Checking in to\s*Intel Unnati IoT Lab/);
    assert.match(p.doc.getElementById('loc-status').textContent, /Location ready/);
    assert.ok(p.doc.getElementById('ci-submit').disabled, 'submit waits for a reason');
    click(p, '[data-act="ci-type"][data-type="RESEARCH"]');
    const purpose = p.doc.querySelector('[data-bind="purpose"]');
    purpose.value = 'Calibrating LiDAR';
    purpose.dispatchEvent(new p.win.Event('input', { bubbles: true }));
    const eq = p.doc.querySelector('[data-bind="equipment"]');
    eq.value = 'LiDAR unit';
    eq.dispatchEvent(new p.win.Event('input', { bubbles: true }));
    assert.ok(p.doc.getElementById('ci-submit').disabled, 'needs a project');
    click(p, '[data-act="ci-project"][data-id="NEW"]');
    const setBind = (bind, v) => {
      const el = p.doc.querySelector('[data-bind="' + bind + '"]');
      el.value = v;
      el.dispatchEvent(new p.win.Event('input', { bubbles: true }));
    };
    setBind('np_title', 'LiDAR SLAM rover');
    setBind('np_end', '2026-12-20');
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
    assert.ok(p.doc.getElementById('ci-submit').disabled, 'needs a project');
    click(p, '[data-act="ci-project"][data-id="P-S2"]');
    click(p, '[data-act="ci-system"][data-id="PC-02"]');
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

  await test('student equipment catalog: availability without borrower details, gated actions', async () => {
    const env = world();
    const p = page('Index.html', bootFor(env, 's2@karunya.edu.in'), env, 's2@karunya.edu.in');
    await settle();
    click(p, '[role="tab"][data-tab="equipment"]');
    await settle();
    const text = p.doc.getElementById('sec-catalog').textContent;
    assert.match(text, /3D Printer \(Prusa MK4\)/);
    assert.match(text, /Scan the QR on the lab monitor first/);
    assert.ok(p.doc.querySelector('[data-act="request-asset"][data-id="3DP-01"]').disabled, 'not checked in: cannot request');
    assert.ok(p.doc.querySelector('[data-act="booking-new"][data-id="3DP-01"]').disabled, 'not checked in: cannot reserve');
    click(p, '[data-act="cat-filter"][data-cat="DRONE"]');
    const cards = p.doc.querySelectorAll('#sec-catalog [data-act="request-asset"]');
    assert.strictEqual(cards.length, 2, 'filter shows the two drones');
    assert.ok(!/s1@|Student One/.test(p.doc.getElementById('sec-catalog').textContent), 'no borrower details');
    assert.match(p.doc.getElementById('sec-map').textContent, /not physical sensors/, 'floor map on the Equipment page');
    assertClean(p, 'catalog');
  });

  await test('live dashboard shows the hourly attendance chart with hover values', async () => {
    const env = world();
    scan(env, 's1@karunya.edu.in');
    env.as('s1@karunya.edu.in')('checkIn', { labId: 'AIIOT', lat: INSIDE.lat, lng: INSIDE.lng, accuracy: 8, reason: { type: 'COURSE', sessionId: 'C-23CS2048' } });
    const p = page('Index.html', bootFor(env, 'staff@karunya.edu'), env, 'staff@karunya.edu');
    await settle();
    const svg = p.doc.querySelector('#sec-today svg.lp-chart');
    assert.ok(svg, 'chart rendered');
    assert.ok(svg.querySelectorAll('path.bar').length >= 1, 'a column for the current hour');
    assert.ok([...svg.querySelectorAll('[data-tip]')].some((r) => /10:00–11:00 · 1 present/.test(r.getAttribute('data-tip'))));
    assert.ok(p.doc.querySelector('.lp-side [data-tab="live"][aria-selected="true"]'), 'sidebar marks the current page');
    click(p, '[data-act="nav-toggle"]');
    assert.ok(p.doc.getElementById('shell').classList.contains('nav-open'), 'mobile menu opens');
    click(p, '[data-act="nav-close"]');
    assert.ok(!p.doc.getElementById('shell').classList.contains('nav-open'));
    assertClean(p, 'live chart');
  });

  await test('student reserves a slot; staff see it in today’s reservations', async () => {
    const env = world();
    scan(env, 's1@karunya.edu.in');
    env.as('s1@karunya.edu.in')('checkIn', { labId: 'AIIOT', lat: INSIDE.lat, lng: INSIDE.lng, accuracy: 8, reason: { type: 'COURSE', sessionId: 'C-23CS2048' } });
    const p = page('Index.html', bootFor(env, 's1@karunya.edu.in'), env, 's1@karunya.edu.in');
    await settle();
    click(p, '[data-act="booking-new"]');
    await settle();
    const f = p.doc.getElementById('modal-form');
    assert.ok(f, 'reserve form opens');
    f.querySelector('[name=assetId]').value = '3DP-01';
    f.querySelector('[name=date]').value = '2026-10-19';
    f.querySelector('[name=from]').value = '14:00';
    f.querySelector('[name=to]').value = '16:00';
    f.querySelector('[name=purpose]').value = 'Print the sensor enclosure';
    f.dispatchEvent(new p.win.Event('submit', { cancelable: true }));
    await settle();
    assert.ok(!p.doc.getElementById('modal-form'), 'modal closed: ' + (p.doc.getElementById('modal-error') || {}).textContent);
    assert.match(p.doc.getElementById('sec-mybookings').textContent, /3D Printer \(Prusa MK4\)[\s\S]*Confirmed/);
    assertClean(p, 'reserve');
    const s = page('Index.html', bootFor(env, 'staff@karunya.edu'), env, 'staff@karunya.edu');
    await settle();
    click(s, '[data-act="live-view"][data-view="desk"]');
    await settle();
    assert.match(s.doc.getElementById('sec-bookings').textContent, /Student One[\s\S]*in the lab[\s\S]*Start session/);
    assertClean(s, 'staff bookings');
  });

  await test('HOD looks up a student by register number and a system by ID', async () => {
    const env = world();
    scan(env, 's1@karunya.edu.in');
    env.as('s1@karunya.edu.in')('checkIn', { labId: 'AIIOT', lat: INSIDE.lat, lng: INSIDE.lng, accuracy: 8, reason: { type: 'RESEARCH', purpose: 'Soil model', equipment: 'None', projectId: 'P-S1', systemId: 'PC-01' } });
    const p = page('Index.html', bootFor(env, 'hod@karunya.edu'), env, 'hod@karunya.edu');
    await settle();
    assert.match(p.doc.getElementById('sec-inside').textContent, /PC-01[\s\S]*Smart Irrigation/, 'live view shows system and project');
    click(p, '[role="tab"][data-tab="lookup"]');
    await settle();
    const fs = p.doc.getElementById('lookup-student');
    fs.querySelector('[name=q]').value = 'URK24CS1001';
    fs.dispatchEvent(new p.win.Event('submit', { bubbles: true, cancelable: true }));
    const fa = p.doc.getElementById('lookup-asset');
    fa.querySelector('[name=assetId]').value = 'PC-01';
    fa.dispatchEvent(new p.win.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.match(p.doc.getElementById('lookup-student-out').textContent, /Student One[\s\S]*Days in lab\s*1[\s\S]*Smart Irrigation with ESP32/);
    assert.match(p.doc.getElementById('lookup-asset-out').textContent, /People\s*1[\s\S]*Student One/);
    assertClean(p, 'lookup');
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

  await test('landing page: visitors see Log in / Sign up, members see Open dashboard', async () => {
    const env = world();
    const anon = page('Index.html', { view: 'landing', webAppUrl: 'https://script.google.com/macros/s/TEST/exec' }, env, '');
    await settle();
    const t = anon.doc.body.textContent;
    assert.match(t, /Know who's in the lab\./);
    assert.match(t, /How it works[\s\S]*Six roles[\s\S]*Security and privacy/);
    assert.ok(anon.doc.querySelector('[data-slot="nav-cta"] [data-act="go"][data-page="login"]'), 'Log in in the nav');
    assert.ok(anon.doc.querySelector('[data-slot="hero-cta"] [data-act="go"][data-page="signup"]'), 'Sign up in the hero');
    assert.strictEqual(anon.doc.querySelectorAll('[data-slot="qr"] rect').length > 200, true, 'hero QR drawn');
    click(anon, '[data-slot="nav-cta"] [data-page="login"]');
    assert.match(anon.doc.body.textContent, /Log in to LabPulse[\s\S]*Karunya email[\s\S]*Continue/);
    assert.ok(anon.doc.querySelector('#auth-email [name=email]'), 'email box on the log-in page');
    assert.ok(!anon.doc.querySelector('.lx-auth-side'), 'no dark side panel');
    click(anon, '.lx-switch [data-page="signup"]');
    assert.match(anon.doc.body.textContent, /Create your account\.[\s\S]*Step 1 of 2/);
    assertClean(anon, 'anonymous landing');

    const member = page('Index.html', bootFor(env, 's1@karunya.edu.in', { view: 'landing' }), env, 's1@karunya.edu.in');
    await settle();
    assert.ok(member.doc.querySelector('[data-slot="nav-cta"] [data-page="app"]'), 'Open dashboard for a member');
    click(member, '[data-slot="nav-cta"] [data-page="app"]');
    await settle();
    assert.match(member.doc.body.textContent, /Not checked in/, 'dashboard opens');
    assertClean(member, 'member landing');
  });

  await test('log in: shows the Google account; outsiders are told to switch account', async () => {
    const env = world();
    const p = page('Index.html', bootFor(env, 'faculty@karunya.edu', { view: 'login' }), env, 'faculty@karunya.edu');
    await settle();
    // The signed-in Google email is filled in; Continue goes straight to the dashboard.
    assert.strictEqual(p.doc.querySelector('#auth-email [name=email]').value, 'faculty@karunya.edu');
    p.doc.getElementById('auth-email').dispatchEvent(new p.win.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.ok(p.doc.querySelector('.lp-side'), 'dashboard shell after continuing');
    const out = page('Index.html', { view: 'login', webAppUrl: 'https://x/exec', error: { code: 'DOMAIN', message: 'Only Karunya accounts' } }, env, 'someone@gmail.com');
    await settle();
    assert.match(out.doc.body.textContent, /can’t use LabPulse[\s\S]*@karunya\.edu/);
    assert.ok(out.doc.querySelector('#auth-email [name=email]'), 'outsider can type a different email');
    const reg = page('Index.html', bootFor(env, 's2@karunya.edu.in', { view: 'signup' }), env, 's2@karunya.edu.in');
    await settle();
    assert.match(reg.doc.body.textContent, /already have a LabPulse account/);
    assertClean(p, 'login');
  });

  await test('first sign-in shows registration, then the dashboard', async () => {
    const env = world();
    const email = 'newbie@karunya.edu.in';
    const p = page('Index.html', bootFor(env, email), env, email);
    await settle();
    assert.match(p.doc.body.textContent, /Create your account\.[\s\S]*Step 2 of 2/);
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
    click(p, '[data-act="live-view"][data-view="desk"]');
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
