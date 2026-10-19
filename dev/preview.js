/**
 * Local preview of LabPulse: serves the real UI and runs the real server code (src/*.js)
 * against in-memory Google services, so the app can be tried without deploying.
 *
 *   npm run preview      then open http://localhost:8787
 *
 * The QR on the monitor links to this laptop's Wi-Fi address, so a phone on the same
 * Wi-Fi can scan it. GPS stays simulated: phones only allow real GPS on https pages,
 * which the deployed Apps Script app has.
 *
 * Differences from the deployed app: identity comes from a role picker instead of Google
 * sign-in, GPS can be simulated, PDFs are rendered as HTML pages, and emails go to an outbox.
 */
'use strict';
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { world, LAB } = require('../tests/fixtures');

const PORT = Number(process.env.PORT) || 8787;
const BASE = 'http://localhost:' + PORT;

/** First non-internal IPv4 address (the Wi-Fi/LAN address phones can reach), or null. */
function lanAddress() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal && !/^169\.254\./.test(n.address)) return n.address;
    }
  }
  return null;
}
const LAN = lanAddress();
// Links that leave this laptop (the QR, files) use the LAN address when there is one.
const PUBLIC = LAN ? 'http://' + LAN + ':' + PORT : BASE;
const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

/* ---------- world: demo data, adjusted so the lab is open whenever you try it ---------- */

const env = world();
const sync = () => { env.clock.ms = Date.now(); env.ctx.Db.reset(); };
sync();
env.session.active = '';
env.run(`
  Db.update('Config', Db.byId('Config', 'AIIOT'), { open_time: '00:00', close_time: '23:59', open_days: 'SUN,MON,TUE,WED,THU,FRI,SAT' });
  Settings.syncFromSheet();
  Db.update('CoursesEvents', Db.byId('CoursesEvents', 'C-DEMO'), { start_time: '00:00', end_time: '23:59' });
  Db.update('CoursesEvents', Db.byId('CoursesEvents', 'EV-HACK'), { start_date: U.dateKey(U.now()), end_date: U.addDays(U.dateKey(U.now()), 2) });
  Db.update('CoursesEvents', Db.byId('CoursesEvents', 'C-23CS2048'), { days: 'SUN,MON,TUE,WED,THU,FRI,SAT', start_time: '00:00', end_time: '23:59' });
`);

// Files ("PDFs", CSVs) are kept in memory and served at /files/<id>.
const files = {};
env.ctx.__saveFile = (blob, shareWith) => {
  const id = 'F' + Object.keys(files).length;
  files[id] = { name: blob.name || 'file', type: blob.type || 'text/html', body: blob.html || blob.data || '' };
  return { id, name: files[id].name, url: PUBLIC + '/files/' + id };
};
env.ctx.Utilities.newBlob = (data, type, name) => ({
  data, type, name,
  getAs: () => ({ html: data, type: 'text/html', name, setName(n) { this.name = n; return this; } })
});
env.run(`
  Reports.saveFile = function (blob, share) { return __saveFile(blob, share); };
  Reports.toXlsx = function (columns, rows, filename, share) {
    var esc = function (v) { return String(v === null || v === undefined ? '' : v).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
    var html = '<html><head><meta charset="utf-8"><title>' + filename + '</title></head><body style="font-family:Arial;padding:16px">' +
      '<p style="color:#64748b">Preview of <b>' + filename + '</b>. The deployed app exports a real .xlsx through Google Sheets.</p>' +
      '<table border="1" cellpadding="4" style="border-collapse:collapse;font-size:12px"><tr>' + columns.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr>' +
      rows.map(function (r) { return '<tr>' + columns.map(function (c) { return '<td>' + esc(r[c]) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table></body></html>';
    return Reports.saveFile({ html: html, type: 'text/html', name: filename }, share);
  };
  Reports.toPdf = function (report, share) {
    var html = '<html><head><meta charset="utf-8"><title>' + report.filename + '</title></head><body style="padding:24px">' +
      Reports.toHtml(report) + '<p style="color:#94a3b8;font-size:12px">Preview: in the deployed app this is a PDF filled from the Google Docs template.</p></body></html>';
    return Reports.saveFile({ html: html, type: 'text/html', name: report.filename + '.pdf' }, share);
  };
`);
const noop = () => chain;
const chain = new Proxy({}, { get: () => noop });
env.ctx.DriveApp = {
  getFileById: (id) => ({ getBlob: () => ({ name: (files[id] || {}).name }) })
};
env.ctx.ScriptApp.getProjectTriggers = () => [];
env.ctx.ScriptApp.newTrigger = () => chain;
env.ctx.ScriptApp.deleteTrigger = () => {};

// Background jobs, as the triggers would run them.
setInterval(() => {
  sync();
  env.session.active = '';
  try { env.ctx.jobAutoClose(); env.ctx.jobReconcile(); env.ctx.jobOverdue(); } catch (e) { console.error('job', e.message); }
}, 60000);

/* ---------- people and simulated GPS ---------- */

const PEOPLE = [
  ['s1@karunya.edu.in', 'Student One', 'Student'],
  ['s2@karunya.edu.in', 'Student Two', 'Student'],
  ['s3@karunya.edu.in', 'Student Three', 'Student'],
  ['faculty@karunya.edu', 'Dr Faculty', 'Faculty (coordinates the demo courses)'],
  ['staff@karunya.edu', 'Staff One', 'Lab staff (equipment handover, monitor)'],
  ['coord@karunya.edu', 'Lab Coordinator', 'Coordinator (facilities, students, all staff work)'],
  ['hod@karunya.edu', 'HOD CSE', 'HOD (read-only view of everything)'],
  ['admin@karunya.edu', 'Admin One', 'Super Admin'],
  ['newcomer@karunya.edu.in', 'New user', 'First sign-in (registration)'],
  ['someone@gmail.com', 'Outsider', 'Outside account (rejected)']
];
const GPS = {
  inside: { label: 'Inside the lab (±8 m) → Green', lat: LAB.lat + 0.00004, lng: LAB.lng, accuracy: 8 },
  weak: { label: 'Inside, weak GPS (±80 m) → Amber', lat: LAB.lat + 0.00004, lng: LAB.lng, accuracy: 80 },
  edge: { label: 'Just outside (~22 m) → Amber', lat: LAB.lat + 0.0002, lng: LAB.lng, accuracy: 25 },
  far: { label: 'Hostel, 2 km away → Red', lat: LAB.lat + 0.018, lng: LAB.lng, accuracy: 10 },
  real: { label: 'Use this device’s real GPS (will be far from the lab)' }
};

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1));
  });
  return out;
}

/* ---------- pages ---------- */

function shim(as, gps) {
  const g = GPS[gps] && GPS[gps].lat ? GPS[gps] : null;
  return `<script>
  window.google = { script: { get run() {
    var h = {};
    var r = {
      withSuccessHandler: function (f) { h.ok = f; return r; },
      withFailureHandler: function (f) { h.fail = f; return r; },
      api: function (action, payload) {
        fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ as: ${JSON.stringify(as)}, action: action, payload: payload }) })
          .then(function (x) { return x.json(); })
          .then(function (d) { h.ok && h.ok(d); }, function (e) { h.fail && h.fail(e); });
      }
    };
    return r;
  } } };
  ${g ? `(function () {
    var fix = function () { return { coords: { latitude: ${g.lat}, longitude: ${g.lng}, accuracy: ${g.accuracy} }, timestamp: Date.now() }; };
    var geo = {
      watchPosition: function (ok) { setTimeout(function () { ok(fix()); }, 600); return 1; },
      clearWatch: function () {},
      getCurrentPosition: function (ok) { setTimeout(function () { ok(fix()); }, 300); }
    };
    try { Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true }); } catch (e) {}
  })();` : ''}
  </script>
  <div style="position:fixed;right:8px;bottom:8px;z-index:9999;font:12px system-ui;background:#0f172a;color:#e2e8f0;padding:6px 10px;border-radius:8px;opacity:.85">
    Preview · ${as} · <a href="/" style="color:#5eead4">switch user</a></div>`;
}

function renderApp(file, boot, as, gps) {
  return read(file)
    .replace(/<\?!= include_\('Styles'\); \?>/, read('Styles.html'))
    .replace(/<\?!= include_\('Client'\); \?>/, read('Client.html'))
    .replace(/<\?!= bootJson \?>/, JSON.stringify(boot).replace(/</g, '\\u003c'))
    .replace(/(<body[^>]*>)/, '$1' + shim(as, gps));
}

function doGet(as, params) {
  sync();
  env.session.active = as;
  const out = env.ctx.doGet({ parameter: params });
  const boot = out.boot;
  boot.webAppUrl = PUBLIC + '/app';
  return { file: out.file + '.html', boot };
}

function landing(c) {
  sync();
  env.session.active = '';
  const occ = env.ctx.Attendance.occupancy('AIIOT');
  const esc = (s) => String(s).replace(/[&<>"]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]));
  const mail = env.mail.slice(-10).reverse();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>LabPulse preview</title><script src="https://cdn.tailwindcss.com/3.4.16"></script></head>
  <body class="bg-slate-100 text-slate-900"><div class="max-w-4xl mx-auto p-6 space-y-5">
  <div><h1 class="text-2xl font-bold">LabPulse — local preview</h1>
  <p class="text-slate-600 text-sm mt-1">The real server code running on this machine with in-memory Google services. Data resets when the preview stops. Currently signed in as <b>${esc(c.as || 'nobody')}</b> · ${occ} inside Intel Unnati IoT Lab.</p></div>

  <section class="bg-white rounded-xl border p-4"><h2 class="font-semibold mb-3">1 · Open the lab monitor (wall display)</h2>
  <a class="inline-block bg-teal-700 text-white rounded-lg px-4 py-2 font-semibold" href="/as?u=staff@karunya.edu&next=/app%3Fview%3Dmonitor%26lab%3DAIIOT" target="_blank">Open monitor as lab staff ↗</a>
  <p class="text-xs text-slate-500 mt-2">Opens in a new tab. Keep it open while you scan from this tab and watch the code change.</p>
  ${LAN ? `<p class="text-sm mt-3 rounded-lg bg-teal-50 text-teal-900 p-3"><b>Scan with your real phone:</b> connect the phone to the same Wi-Fi as this laptop, then point its camera at the monitor’s QR. The phone opens <code>${PUBLIC}</code>, asks who you are, and continues to check-in. Location is simulated (choose it in step 2). If nothing loads on the phone, allow Node.js through Windows Firewall (Private networks).</p>` : '<p class="text-sm mt-3 text-amber-800">No Wi-Fi address found, so phone scanning is unavailable; use the buttons in step 3.</p>'}</section>

  <section class="bg-white rounded-xl border p-4"><h2 class="font-semibold mb-3">2 · Simulated phone location</h2>
  <div class="flex flex-wrap gap-2">${Object.entries(GPS).map(([k, g]) => `<a href="/gps?m=${k}" class="rounded-lg px-3 py-1.5 text-sm border ${c.gps === k || (!c.gps && k === 'inside') ? 'bg-teal-50 border-teal-600 text-teal-800 font-semibold' : 'bg-white'}">${esc(g.label)}</a>`).join('')}</div></section>

  <section class="bg-white rounded-xl border p-4"><h2 class="font-semibold mb-3">3 · Scan the monitor’s QR as a student</h2>
  <div class="flex flex-wrap gap-2">${PEOPLE.slice(0, 3).concat([PEOPLE[6]]).map((p) => `<a class="rounded-lg bg-slate-900 text-white px-3 py-1.5 text-sm" href="/scan?u=${p[0]}">Scan as ${esc(p[1])}</a>`).join('')}</div>
  <p class="text-xs text-slate-500 mt-2">Takes the code currently on the monitor and opens it, exactly as a phone camera would. Use the same code twice (browser back + reload) to see the reuse rejection.</p></section>

  <section class="bg-white rounded-xl border p-4"><h2 class="font-semibold mb-3">4 · Open a dashboard as…</h2>
  <div class="grid sm:grid-cols-2 gap-2">${PEOPLE.map((p) => `<a class="rounded-lg border px-3 py-2 hover:bg-slate-50" href="/as?u=${p[0]}&next=/app"><div class="font-medium">${esc(p[1])}</div><div class="text-xs text-slate-500">${esc(p[2])} · ${esc(p[0])}</div></a>`).join('')}</div></section>

  <section class="bg-white rounded-xl border p-4"><h2 class="font-semibold mb-2">Outbox (emails the app would send)</h2>
  ${mail.length ? '<ul class="text-sm divide-y">' + mail.map((m) => `<li class="py-2"><b>${esc(m.subject)}</b><div class="text-xs text-slate-500">to ${esc(m.to)}</div></li>`).join('') + '</ul>' : '<p class="text-sm text-slate-500">No emails yet.</p>'}
  </section></div></body></html>`;
}

function picker(dev, claim) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]));
  const users = PEOPLE.filter((p) => p[2].indexOf('Student') === 0 || p[0].indexOf('newcomer') === 0 || p[0].indexOf('gmail') !== -1);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>LabPulse preview · who are you?</title><script src="https://cdn.tailwindcss.com/3.4.16"></script></head>
  <body class="bg-slate-100 text-slate-900"><div class="max-w-md mx-auto p-5 space-y-4">
  ${claim.ok ? `<h1 class="text-xl font-bold">Who is scanning?</h1>
  <p class="text-sm text-slate-600">Scan accepted for ${esc(claim.labName)}. In the real app Google sign-in tells LabPulse who you are; in this preview, pick a test user. Your scan is held for 5 minutes.</p>
  ${users.map((p) => `<a class="block rounded-xl bg-white border px-4 py-3" href="/pick?u=${encodeURIComponent(p[0])}&d=${encodeURIComponent(dev)}"><div class="font-semibold">${esc(p[1])}</div><div class="text-xs text-slate-500">${esc(p[0])}</div></a>`).join('')}`
  : `<div class="rounded-xl bg-red-50 text-red-900 p-5"><h1 class="text-lg font-bold">Not checked in</h1><p class="mt-1">${esc(claim.message)}</p></div>`}
  </div></body></html>`;
}

/* ---------- server ---------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  const c = cookies(req);
  const send = (code, body, type, headers) => {
    res.writeHead(code, Object.assign({ 'Content-Type': type || 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
    res.end(body);
  };
  const redirect = (to, setCookie) => send(302, '', 'text/plain', Object.assign({ Location: to }, setCookie ? { 'Set-Cookie': setCookie } : {}));
  try {
    if (url.pathname === '/') return send(200, landing(c));
    if (url.pathname === '/as') return redirect(url.searchParams.get('next') || '/app', 'as=' + encodeURIComponent(url.searchParams.get('u')) + '; Path=/');
    if (url.pathname === '/gps') return redirect('/', 'gps=' + url.searchParams.get('m') + '; Path=/');
    if (url.pathname === '/scan') {
      sync();
      env.session.active = 'staff@karunya.edu';
      const tick = env.ctx.Monitoring.monitorTick('AIIOT');
      if (!tick.open) return send(200, '<p>The lab is closed in settings, so the monitor shows no QR.</p><a href="/">Back</a>');
      return redirect('/app?t=' + encodeURIComponent(tick.token), 'as=' + encodeURIComponent(url.searchParams.get('u')) + '; Path=/');
    }
    if (url.pathname === '/pick') {
      // Hand the scan this device already claimed to the chosen user, then continue to check-in.
      const u = url.searchParams.get('u');
      const dev = url.searchParams.get('d');
      sync();
      const t = env.ctx.Cache.getJson('ticket:' + dev);
      if (t) {
        env.ctx.Cache.remove('ticket:' + dev);
        env.ctx.Cache.putJson('ticket:' + u, t, env.ctx.APP.TICKET_TTL_SEC);
      }
      return redirect('/app?resume=1', 'as=' + encodeURIComponent(u) + '; Path=/');
    }
    if (url.pathname === '/app') {
      if (!c.as && url.searchParams.get('t')) {
        // Claim immediately, like the real app does when Google sign-in already knows the user.
        sync();
        const dev = 'device-' + Math.random().toString(36).slice(2, 10);
        const claim = env.ctx.Attendance.claim({ email: dev, role: null, user: null, active: false }, url.searchParams.get('t'));
        return send(200, picker(dev, claim));
      }
      if (!c.as) return redirect('/');
      const params = Object.fromEntries(url.searchParams.entries());
      const p = doGet(c.as, params);
      if (params.resume && p.boot.init && p.boot.init.me && p.boot.init.me.registered) {
        const t = env.ctx.Attendance.ticket(c.as);
        if (t) { p.boot.view = 'checkin'; p.boot.claim = { ok: true, labId: t.labId, labName: t.labName, expiresInSec: t.expiresInSec }; }
      }
      return send(200, renderApp(p.file, p.boot, c.as, c.gps || 'inside'));
    }
    if (url.pathname === '/api' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        sync();
        const { as, action, payload } = JSON.parse(body || '{}');
        const out = env.as(as || c.as || '')(action, payload);
        if (!out.ok && out.code === 'SERVER') console.error('server error in', action, env.ctx.__errors.slice(-1)[0]);
        send(200, JSON.stringify(out), 'application/json');
      });
      return;
    }
    if (url.pathname.startsWith('/files/')) {
      const f = files[url.pathname.slice(7)];
      if (!f) return send(404, 'Not found', 'text/plain');
      const csv = /csv/.test(f.type);
      return send(200, f.body, csv ? 'text/csv; charset=utf-8' : 'text/html; charset=utf-8', csv ? { 'Content-Disposition': 'attachment; filename="' + f.name + '"' } : {});
    }
    send(404, 'Not found', 'text/plain');
  } catch (e) {
    console.error(e);
    send(500, '<pre>' + String(e.stack || e) + '</pre>');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('LabPulse preview running at ' + BASE);
  console.log(LAN ? 'Phone (same Wi-Fi): ' + PUBLIC + '  (the monitor QR uses this address)' : 'No Wi-Fi address found: phone scanning unavailable.');
  console.log('Users: ' + PEOPLE.map((p) => p[0]).join(', '));
});
