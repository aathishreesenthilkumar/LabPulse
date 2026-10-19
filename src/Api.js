/**
 * Web app entry points and the single server API.
 *
 * Every browser action goes through api(action, payload). The route table below is the
 * one place that says which roles may call what; the check runs on the server for every
 * request (FR-03, §3.2). Apps Script exposes only top-level functions without a trailing
 * underscore to google.script.run, so modules are namespaced objects and helpers end in _.
 */

// Literals, not ROLES.*: Apps Script may load this file before Config.js.
var R_ = { STUDENT: 'STUDENT', FACULTY: 'FACULTY', STAFF: 'STAFF', COORDINATOR: 'COORDINATOR', HOD: 'HOD' };
var ANY_ = null; // any registered, active user
var OPS_ = [R_.STAFF, R_.COORDINATOR]; // day-to-day lab operations
var MGR_ = [R_.COORDINATOR]; // managing facilities and students
var VIEW_ = [R_.STAFF, R_.COORDINATOR, R_.HOD]; // oversight; HOD is read-only

/**
 * roles:        who may call it (Super Admin always may)
 * configurable: Super Admin may grant it to more roles (FR-36)
 * open:         may be called before the profile is complete
 */
var ROUTES = {
  bootstrap: { roles: ANY_, open: true, fn: function (ctx) { return Api.bootstrap(ctx); } },
  register: { roles: ANY_, open: true, fn: function (ctx, p) { return Auth.register(ctx, p); } },

  // Everyone
  status: { roles: ANY_, fn: function (ctx) { return Attendance.status(ctx); } },
  occupancy: { roles: ANY_, fn: function (ctx, p) { var id = Settings.lab(p.labId).lab_id; return { labId: id, occupancy: Attendance.occupancy(id), pending: Attendance.pending(id) }; } },
  checkinOptions: { roles: ANY_, fn: function (ctx, p) { return Attendance.options(p.labId, ctx); } },
  checkIn: { roles: ANY_, fn: function (ctx, p) { return Attendance.checkIn(ctx, p); } },
  checkOut: { roles: ANY_, fn: function (ctx, p) { return Attendance.checkOut(ctx, p); } },
  freeNow: { roles: ANY_, fn: function (ctx, p) { return Assets.freeNow(Settings.lab(p.labId).lab_id); } },
  assetsPublic: { roles: ANY_, fn: function (ctx, p) { return Assets.publicList(Settings.lab(p.labId).lab_id); } },
  labMap: { roles: ANY_, fn: function (ctx, p) { return Monitoring.labMap(p.labId); } },
  myItems: { roles: ANY_, fn: function (ctx) { return Assets.mine(ctx.email); } },
  myHistory: { roles: ANY_, fn: function (ctx) { return Attendance.history(ctx.email, 50); } },
  myBookings: { roles: ANY_, fn: function (ctx) { return Bookings.mine(ctx.email); } },
  assetSchedule: { roles: ANY_, fn: function (ctx, p) { return Bookings.schedule(ctx, p); } },
  cancelBooking: { roles: ANY_, fn: function (ctx, p) { return Bookings.cancel(ctx, p); } },
  bookAsset: { roles: [R_.STUDENT], configurable: true, fn: function (ctx, p) { return Bookings.book(ctx, p); } },
  myHours: { roles: ANY_, fn: function (ctx) { return Usage.student(Usage.findUser(ctx.email), { self: true }); } },
  myProjects: { roles: ANY_, fn: function (ctx) { return Projects.mine(ctx.email); } },
  projectSave: { roles: ANY_, fn: function (ctx, p) { return Projects.save(ctx, p); } },
  projectComplete: { roles: ANY_, fn: function (ctx, p) { return Projects.complete(ctx, p); } },
  projectDetail: { roles: ANY_, fn: function (ctx, p) { return Projects.detail(ctx, p.projectId); } },

  // Student
  requestAsset: { roles: [R_.STUDENT], configurable: true, fn: function (ctx, p) { return Assets.request(ctx, p); } },
  cancelRequest: { roles: [R_.STUDENT], configurable: true, fn: function (ctx, p) { return Assets.cancelRequest(ctx, p); } },
  myPassport: { roles: [R_.STUDENT], configurable: true, fn: function (ctx) { return Reports.passport(ctx); } },

  // Faculty (Coordinator and HOD can view every session's roster)
  facultySessions: { roles: [R_.FACULTY, R_.COORDINATOR, R_.HOD], configurable: true, fn: function (ctx, p) { return Monitoring.facultySessions(ctx, p.labId); } },
  roster: { roles: [R_.FACULTY, R_.COORDINATOR, R_.HOD], configurable: true, fn: function (ctx, p) { return Monitoring.roster(ctx, p); } },
  markAttendance: { roles: [R_.FACULTY, R_.COORDINATOR], configurable: true, fn: function (ctx, p) { return Monitoring.mark(ctx, p); } },
  sessionLogPdf: { roles: [R_.FACULTY, R_.COORDINATOR, R_.HOD], configurable: true, fn: function (ctx, p) { return Reports.sessionLogPdf(ctx, p); } },

  // Reviews and exports
  reviewQueue: { roles: [R_.FACULTY, R_.STAFF, R_.COORDINATOR], fn: function (ctx, p) { return Attendance.reviewQueue(ctx, p.labId); } },
  reviewVisit: { roles: [R_.FACULTY, R_.STAFF, R_.COORDINATOR], fn: function (ctx, p) { return Attendance.review(ctx, p); } },
  exportRange: { roles: [R_.FACULTY, R_.STAFF, R_.COORDINATOR, R_.HOD], configurable: true, fn: function (ctx, p) { return Reports.exportRange(ctx, p); } },

  // Oversight: staff, coordinator and HOD (read-only)
  staffSummary: { roles: VIEW_, configurable: true, fn: function (ctx, p) { return Monitoring.summary(Settings.lab(p.labId).lab_id); } },
  activity: { roles: VIEW_, configurable: true, fn: function (ctx, p) { return Monitoring.activity(Settings.lab(p.labId).lab_id); } },
  inside: { roles: VIEW_, configurable: true, fn: function (ctx, p) { return Monitoring.inside(Settings.lab(p.labId).lab_id); } },
  lookupStudent: { roles: VIEW_, configurable: true, fn: function (ctx, p) { return Usage.student(p.q); } },
  lookupAsset: { roles: VIEW_, configurable: true, fn: function (ctx, p) { return Usage.asset(p.assetId); } },
  inventory: { roles: VIEW_, fn: function (ctx, p) { return Assets.inventory(Settings.lab(p.labId).lab_id); } },
  projects: { roles: [R_.STAFF, R_.COORDINATOR, R_.HOD, R_.FACULTY], configurable: true, fn: function (ctx, p) { return Projects.list(Settings.lab(p.labId).lab_id, p); } },
  sessions: { roles: VIEW_, fn: function (ctx, p) { return Api.sessions(p.labId); } },
  reportDaily: { roles: VIEW_, configurable: true, fn: function (ctx, p) { return Api.report(ctx, p, false); } },
  reportPeriod: { roles: VIEW_, configurable: true, fn: function (ctx, p) { return Api.report(ctx, p, false); } },
  reportPdf: { roles: VIEW_, configurable: true, fn: function (ctx, p) { return Api.report(ctx, p, true); } },

  // Lab operations: staff and coordinator
  bookingsToday: { roles: VIEW_, fn: function (ctx, p) { return Bookings.today(Settings.lab(p.labId).lab_id); } },
  startBooking: { roles: OPS_, fn: function (ctx, p) { return Bookings.start(ctx, p); } },
  finishBooking: { roles: OPS_, fn: function (ctx, p) { return Bookings.finish(ctx, p); } },
  handshake: { roles: OPS_, fn: function (ctx, p) { return Assets.handshake(Settings.lab(p.labId).lab_id); } },
  issueAsset: { roles: OPS_, fn: function (ctx, p) { return Assets.issue(ctx, p); } },
  rejectRequest: { roles: OPS_, fn: function (ctx, p) { return Assets.reject(ctx, p); } },
  returnAsset: { roles: OPS_, fn: function (ctx, p) { return Assets.markReturn(ctx, p); } },
  manualEntry: { roles: OPS_, fn: function (ctx, p) { return Attendance.manualEntry(ctx, p); } },
  forceCheckOut: { roles: OPS_, fn: function (ctx, p) { return Attendance.forceCheckOut(ctx, p); } },
  emailDigest: { roles: OPS_, fn: function (ctx, p) { return Api.emailDigest(ctx, p); } },
  monitorTick: { roles: OPS_, fn: function (ctx, p) { return Monitoring.monitorTick(p.labId); } },

  // Lab management: coordinator adds/removes facilities and students
  inventorySave: { roles: MGR_, fn: function (ctx, p) { return Assets.save(ctx, p); } },
  inventoryRemove: { roles: MGR_, fn: function (ctx, p) { return Assets.remove(ctx, p); } },
  sessionSave: { roles: MGR_, fn: function (ctx, p) { return Api.sessionSave(ctx, p); } },
  students: { roles: MGR_, fn: function () { return Auth.listStudents(); } },
  manageStudent: { roles: MGR_, fn: function (ctx, p) { return Auth.manageStudent(ctx, p); } },

  // Super Admin only
  settingsGet: { roles: [], fn: function () { return Api.settingsGet(); } },
  saveLab: { roles: [], fn: function (ctx, p) { return Settings.saveLab(ctx, p); } },
  saveGlobal: { roles: [], fn: function (ctx, p) { return Settings.saveGlobal(ctx, p); } },
  savePermissions: { roles: [], fn: function (ctx, p) { return Settings.savePermissionOverrides(ctx, p.overrides); } },
  users: { roles: [], fn: function () { return Auth.listUsers(true); } },
  saveUser: { roles: [], fn: function (ctx, p) { return Auth.saveUser(ctx, p); } },
  audit: { roles: [], fn: function (ctx, p) { return Audit.query(p); } },
  runJob: { roles: [], fn: function (ctx, p) { return Api.runJob(ctx, p); } },
  installTriggers: { roles: [], fn: function (ctx) { return installTriggers_(ctx); } }
};

var Api = {
  allowedRoles: function (action) {
    var route = ROUTES[action];
    if (!route.roles) return null;
    var extra = route.configurable ? Settings.permissionOverrides()[action] || [] : [];
    return route.roles.concat(extra);
  },

  handle: function (action, payload) {
    try {
      var route = ROUTES.hasOwnProperty(action) ? ROUTES[action] : null;
      if (!route) fail_('NOT_FOUND', 'Unknown action.');
      var ctx = Auth.context();
      if (!route.open) Auth.require(ctx, Api.allowedRoles(action), action);
      var p = payload && typeof payload === 'object' ? payload : {};
      return { ok: true, data: U.plain(route.fn(ctx, p)) };
    } catch (e) {
      if (e instanceof AppError) return { ok: false, code: e.code, message: e.message };
      console.error('api ' + action + ' failed: ' + (e && e.stack ? e.stack : e));
      return { ok: false, code: 'SERVER', message: 'Something went wrong on the server. Please try again.' };
    }
  },

  me: function (ctx) {
    return {
      email: ctx.email,
      name: ctx.user ? ctx.user.name : '',
      reg_no: ctx.user ? ctx.user.reg_no : '',
      role: ctx.role,
      registered: ctx.registered,
      active: ctx.active
    };
  },

  /** Everything the dashboard needs on load, including which actions this role may call. */
  bootstrap: function (ctx) {
    var g = Settings.global();
    var allowed = [];
    if (ctx.registered && ctx.active) {
      Object.keys(ROUTES).forEach(function (a) {
        var roles = Api.allowedRoles(a);
        if (!roles || ctx.role === ROLES.ADMIN || roles.indexOf(ctx.role) !== -1) allowed.push(a);
      });
    }
    return {
      me: Api.me(ctx),
      labs: Settings.labs(false).map(Settings.publicLab),
      allowed: allowed,
      pollMs: g.dashboard_poll_ms,
      monitorPollMs: g.monitor_poll_ms,
      defaultLoanHours: g.default_loan_hours,
      maxBookingHours: g.max_booking_hours,
      maxLoanHours: g.max_loan_hours,
      version: APP.VERSION
    };
  },

  report: function (ctx, p, pdf) {
    var lab = Settings.lab(p.labId);
    var report;
    if (p.kind === 'monthly') {
      var m = /^(\d{4})-(\d{2})$/.exec(U.str(p.month));
      if (!m) fail_('INVALID', 'Choose a month.');
      report = Reports.monthly(lab.lab_id, Number(m[1]), Number(m[2]));
    } else if (p.kind === 'range') {
      if (!U.isDateKey(p.from) || !U.isDateKey(p.to) || p.from > p.to) fail_('INVALID', 'Choose a valid date range.');
      if (U.istDate(p.to, 0) - U.istDate(p.from, 0) > 366 * 86400000) fail_('INVALID', 'Ranges are limited to one year.');
      report = Reports.period(lab.lab_id, p.from, p.to, null, 'range');
    } else {
      report = Reports.daily(lab.lab_id, U.isDateKey(p.date) ? p.date : U.dateKey(U.now()));
    }
    if (!pdf) return report;
    var file = Reports.toPdf(report, ctx.email);
    Audit.log(ctx, 'REPORT_PDF', file.name, 'OK', '', lab.lab_id);
    return file;
  },

  emailDigest: function (ctx, p) {
    var lab = Settings.lab(p.labId);
    var report = Reports.daily(lab.lab_id, U.isDateKey(p.date) ? p.date : U.dateKey(U.now()));
    var pdf = Reports.toPdf(report, ctx.email);
    var sent = Reports.emailReport(report, lab, pdf);
    Audit.log(ctx, 'DIGEST_EMAIL', pdf.name, sent ? 'SENT' : 'NO_RECIPIENT', '', lab.lab_id);
    if (!sent) fail_('INVALID', 'Set the lab in-charge email in Settings first. The PDF was saved: ' + pdf.name);
    return { pdf: pdf, recipients: sent };
  },

  settingsGet: function () {
    var overrides = Settings.permissionOverrides();
    var configurable = Object.keys(ROUTES).filter(function (a) { return ROUTES[a].configurable; }).map(function (a) {
      return { action: a, defaults: ROUTES[a].roles, extra: overrides[a] || [] };
    });
    return { labs: Settings.labs(true), global: Settings.global(), permissions: configurable, limits: {
      radius: [APP.RADIUS_MIN_M, APP.RADIUS_MAX_M], rotate: [APP.QR_ROTATE_MIN_SEC, APP.QR_ROTATE_MAX_SEC]
    } };
  },

  sessions: function (labId) {
    var lab = Settings.lab(labId);
    var enrolled = {};
    Db.all('Enrollments').forEach(function (e) {
      (enrolled[e.session_id] = enrolled[e.session_id] || []).push(e.user_email);
    });
    return Db.find('CoursesEvents', function (s) { return s.lab_id === lab.lab_id; }).map(function (s) {
      var o = {};
      SHEETS.CoursesEvents.forEach(function (k) { o[k] = s[k]; });
      o.active = U.truthy(s.active);
      o.enrolled = enrolled[s.id] || [];
      return o;
    });
  },

  /** Create or edit a course/event and replace its enrolment list. */
  sessionSave: function (ctx, p) {
    p = p || {};
    var lab = Settings.lab(p.lab_id);
    var type = U.str(p.type).toUpperCase();
    if (type !== ENTRY_TYPES.COURSE && type !== ENTRY_TYPES.EVENT) fail_('INVALID', 'Type must be COURSE or EVENT.');
    var rec = {
      lab_id: lab.lab_id, type: type, code: U.str(p.code, 20).toUpperCase(), name: U.str(p.name, 120),
      coordinator_email: U.str(p.coordinator_email).toLowerCase(), coordinator_name: U.str(p.coordinator_name, 80),
      days: U.str(p.days).toUpperCase().replace(/\s+/g, ''), start_time: U.str(p.start_time), end_time: U.str(p.end_time),
      start_date: U.str(p.start_date), end_date: U.str(p.end_date), session_hours: U.str(p.session_hours),
      active: p.active === undefined ? true : !!p.active
    };
    var errs = [];
    if (!rec.name) errs.push('Name is required.');
    if (type === ENTRY_TYPES.COURSE && !rec.code) errs.push('Course code is required.');
    if (!U.isEmail(rec.coordinator_email)) errs.push('Coordinator email is required.');
    if (type === ENTRY_TYPES.COURSE && (!rec.days || rec.days.split(',').some(function (d) { return DAY_CODES.indexOf(d) === -1; }))) {
      errs.push('Days must be a list such as MON,WED.');
    }
    var st = U.parseHHMM(rec.start_time);
    var en = U.parseHHMM(rec.end_time);
    if ((rec.start_time || type === ENTRY_TYPES.COURSE) && (isNaN(st) || isNaN(en) || en <= st)) errs.push('Times must be HH:MM with the end after the start.');
    if (rec.start_date && !U.isDateKey(rec.start_date)) errs.push('Start date must be YYYY-MM-DD.');
    if (rec.end_date && !U.isDateKey(rec.end_date)) errs.push('End date must be YYYY-MM-DD.');
    if (type === ENTRY_TYPES.EVENT && !(rec.start_date && rec.end_date)) errs.push('Events need a start and end date.');
    if (rec.session_hours && !(Number(rec.session_hours) > 0 && Number(rec.session_hours) <= 24)) errs.push('Session hours must be 0–24.');
    if (errs.length) fail_('INVALID', errs.join(' '));
    var emails = (Array.isArray(p.enrolled) ? p.enrolled : String(p.enrolled || '').split(/[\s,;]+/))
      .map(function (e) { return U.str(e).toLowerCase(); })
      .filter(U.isEmail)
      .filter(function (e, i, a) { return a.indexOf(e) === i; });

    return withLock_(function () {
      var row = p.id ? Db.byId('CoursesEvents', U.str(p.id)) : null;
      var id;
      if (row) {
        Db.update('CoursesEvents', row, rec);
        id = row.id;
      } else {
        rec.id = U.id(type === ENTRY_TYPES.COURSE ? 'C' : 'EV');
        Db.insert('CoursesEvents', rec);
        id = rec.id;
      }
      var keep = Db.all('Enrollments').filter(function (e) { return e.session_id !== id; });
      Db.replaceAll('Enrollments', keep.concat(emails.map(function (e) { return { session_id: id, user_email: e }; })));
      Audit.log(ctx, 'SESSION_SAVE', id, row ? 'UPDATED' : 'CREATED', rec.code + ' ' + rec.name + ', ' + emails.length + ' enrolled', lab.lab_id);
      return { id: id };
    });
  },

  runJob: function (ctx, p) {
    var jobs = {
      reconcile: function () { return Attendance.reconcile(); },
      autoClose: function () { return Attendance.autoCloseSweep(); },
      bookings: function () { return Bookings.sweep(); },
      rollup: function () { return Usage.nightly(); },
      encrypt: function () { return Crypto.migrate(); },
      archive: function () { return Usage.archive(); },
      overdue: function () { return Assets.overdueCheck(); },
      digest: function () { return runDailyDigests_(true); },
      backup: function () { return backupSpreadsheet_(); }
    };
    var job = jobs[U.str(p.job)];
    if (!job) fail_('INVALID', 'Unknown job.');
    var out = job();
    Audit.log(ctx, 'RUN_JOB', p.job, 'OK', '', '');
    return out;
  }
};

/* ---------- entry points ---------- */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var boot = { view: 'app', webAppUrl: ScriptApp.getService().getUrl() };
  var file = 'Index';
  try {
    var ctx = Auth.context();
    boot.init = Api.bootstrap(ctx);
    if (p.view === 'monitor') {
      Auth.require(ctx, Api.allowedRoles('monitorTick'), 'monitor');
      var labs = Settings.labs(false);
      if (!labs.length) fail_('NO_LAB', 'No lab is configured yet.');
      boot.view = 'monitor';
      boot.lab = Settings.publicLab(p.lab ? Settings.lab(p.lab) : labs[0]);
      file = 'Monitor';
    } else if (p.t) {
      boot.view = 'checkin';
      boot.claim = Attendance.claim(ctx, p.t);
    }
  } catch (err) {
    boot.error = err instanceof AppError
      ? { code: err.code, message: err.message }
      : { code: 'SERVER', message: 'LabPulse could not start. Please reload the page.' };
    if (!(err instanceof AppError)) console.error('doGet failed: ' + (err && err.stack ? err.stack : err));
  }
  var tpl = HtmlService.createTemplateFromFile(file);
  tpl.bootJson = JSON.stringify(U.plain(boot)).replace(/</g, '\\u003c');
  return tpl
    .evaluate()
    .setTitle(file === 'Monitor' ? 'LabPulse Monitor' : 'LabPulse')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * JSON endpoint for the same API (proposal: doGet / doPost). Body: {"action": "...", "payload": {...}}.
 * Identity and role checks are identical to api(); the caller must be signed in to the web app.
 */
function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    body = {};
  }
  var out = Api.handle(String(body.action || ''), body.payload);
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** The only function the browser calls. */
function api(action, payload) {
  return Api.handle(String(action || ''), payload);
}

function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}
