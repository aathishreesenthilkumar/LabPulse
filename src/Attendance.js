/**
 * Check-in, check-out, review and self-healing occupancy (FR-05 – FR-18; SRS §4).
 *
 * Flow: the student scans the monitor QR → doGet calls claim(), which verifies and
 * consumes the token and gives the user a short-lived server-side ticket for that lab →
 * the page collects location and visit reason → checkIn() runs steps 1–11 of §4.2.
 */
var Attendance = {
  /* ---------- occupancy ---------- */

  /**
   * Live counter: verified check-ins only (Green, Manual or confirmed Amber). Check-ins
   * waiting for review are counted separately by pending(). Both are served from cache and
   * always derived from ActiveVisits.
   */
  occupancy: function (labId) {
    var v = Cache.get('occ:' + labId);
    if (v !== null && v !== undefined) return Number(v);
    return Attendance.refreshOccupancy(labId);
  },

  pending: function (labId) {
    var v = Cache.get('occp:' + labId);
    if (v === null || v === undefined) {
      Attendance.refreshOccupancy(labId);
      v = Cache.get('occp:' + labId);
    }
    return Number(v || 0);
  },

  refreshOccupancy: function (labId) {
    var rows = Db.find('ActiveVisits', function (a) {
      return a.lab_id === labId;
    });
    var pending = rows.filter(function (a) { return a.review_status === STATUS.REVIEW.PENDING; }).length;
    Cache.put('occ:' + labId, rows.length - pending, 900);
    Cache.put('occp:' + labId, pending, 900);
    return rows.length - pending;
  },

  /* ---------- step 3–4: claim the scanned QR ---------- */

  claim: function (ctx, token) {
    var nowMs = U.now().getTime();
    var v = Token.verify(token, nowMs);
    var labId = v.parsed ? v.parsed.labId : '';
    if (!v.ok) {
      var expired = v.code === 'QR_EXPIRED';
      Audit.log(ctx, expired ? 'SECURITY_QR_EXPIRED' : 'SECURITY_QR_INVALID', labId, 'REJECTED', '', labId);
      return {
        ok: false,
        code: v.code,
        message: expired
          ? 'This QR code has expired. Scan the code currently shown on the lab monitor.'
          : 'This QR code is not valid. Scan the code shown on the lab monitor.'
      };
    }
    if (ctx.user && !ctx.active) {
      return { ok: false, code: 'INACTIVE', message: 'Your LabPulse account is disabled. Contact the lab in-charge.' };
    }
    var lab = v.lab;
    if (!Settings.isOpen(lab, new Date(nowMs))) {
      return {
        ok: false,
        code: 'LAB_CLOSED',
        message: lab.name + ' is closed now. Opening hours: ' + lab.open_time + '–' + lab.close_time + ' (' + lab.open_days + ').'
      };
    }
    return withLock_(function () {
      if (Token.isUsed(v.parsed.nonce)) {
        Audit.log(ctx, 'SECURITY_QR_REUSED', lab.lab_id, 'REJECTED', 'Token already used', lab.lab_id);
        return {
          ok: false,
          code: 'QR_REUSED',
          message: 'This QR code was already used. Scan the new code on the lab monitor.'
        };
      }
      Token.markUsed(v.parsed.nonce, ctx.email);
      Cache.putJson('ticket:' + ctx.email, { labId: lab.lab_id, at: nowMs }, APP.TICKET_TTL_SEC);
      return { ok: true, labId: lab.lab_id, labName: lab.name, expiresInSec: APP.TICKET_TTL_SEC };
    });
  },

  ticket: function (email) {
    var t = Cache.getJson('ticket:' + email);
    if (!t) return null;
    var left = APP.TICKET_TTL_SEC - Math.floor((U.now().getTime() - t.at) / 1000);
    return left > 0 ? { labId: t.labId, labName: Settings.labName(t.labId), expiresInSec: left } : null;
  },

  /* ---------- visit reasons (FR-09) ---------- */

  isSessionAvailable: function (s, labId, d) {
    if (!U.truthy(s.active) || s.lab_id !== labId) return false;
    var today = U.dateKey(d);
    if (s.start_date && today < s.start_date) return false;
    if (s.end_date && today > s.end_date) return false;
    if (s.type === ENTRY_TYPES.COURSE) {
      var days = U.str(s.days).toUpperCase().split(',');
      if (days.indexOf(U.dayCode(d)) === -1) return false;
    }
    var start = U.parseHHMM(s.start_time);
    var end = U.parseHHMM(s.end_time);
    if (isNaN(start) || isNaN(end)) return s.type === ENTRY_TYPES.EVENT; // all-day event
    var m = U.minutesOfDay(d);
    return m >= start - APP.SESSION_EARLY_MIN && m <= end;
  },

  /** Courses and events a student can pick right now; details fill in from the list. */
  options: function (labId, ctx) {
    var lab = Settings.lab(labId);
    var d = U.now();
    var list = Db.find('CoursesEvents', function (s) {
      return Attendance.isSessionAvailable(s, lab.lab_id, d);
    });
    function view(s) {
      return {
        id: s.id, type: s.type, code: s.code, name: s.name, coordinator: s.coordinator_name,
        start_time: s.start_time, end_time: s.end_time, session_hours: U.num(s.session_hours, null)
      };
    }
    var types = {};
    var inUse = Attendance.systemsInUse(lab.lab_id);
    var systems = [];
    Db.all('Assets').forEach(function (a) {
      if (a.lab_id !== lab.lab_id || a.status === STATUS.ASSET.RETIRED) return;
      types[a.type] = true;
      if (SYSTEM_CATEGORIES.indexOf(a.category) !== -1 && a.status !== STATUS.ASSET.MAINTENANCE) {
        systems.push({ asset_id: a.asset_id, name: a.name, type: a.type, in_use: !!inUse[a.asset_id] });
      }
    });
    return {
      courses: list.filter(function (s) { return s.type === ENTRY_TYPES.COURSE; }).map(view),
      events: list.filter(function (s) { return s.type === ENTRY_TYPES.EVENT; }).map(view),
      equipment: Object.keys(types).sort(), // research visits pick from the lab's own catalog
      systems: systems, // which computer / printer / drone the student will work at
      projects: ctx ? Projects.activeFor(ctx.email, lab.lab_id) : []
    };
  },

  /** asset_id -> true for systems someone is checked in at right now. */
  systemsInUse: function (labId) {
    var used = {};
    Db.all('ActiveVisits').forEach(function (a) {
      if (a.lab_id === labId && a.system_id && a.system_id !== OWN_DEVICE) used[a.system_id] = true;
    });
    return used;
  },

  /**
   * A course or event that is not in the timetable: the student types the fields the
   * proposal lists. Such visits always go to lab staff for review.
   */
  resolveUnlisted: function (type, m, d, closeAt, graceMs) {
    m = m || {};
    var hours = U.num(m.hours, NaN);
    var maxH = type === ENTRY_TYPES.COURSE ? 12 : 24;
    var details;
    if (type === ENTRY_TYPES.COURSE) {
      var code = U.str(m.code, 20).toUpperCase();
      var name = U.str(m.name, 120);
      if (!/^[A-Z0-9][A-Z0-9 -]{1,19}$/.test(code)) fail_('INCOMPLETE', 'Enter the course code (for example 23CS2048).');
      if (name.length < 3) fail_('INCOMPLETE', 'Enter the course name.');
      details = { code: code, name: name, session_hours: hours, unlisted: true };
    } else {
      var ev = U.str(m.event_name, 120);
      var coord = U.str(m.coordinator, 80);
      if (ev.length < 3) fail_('INCOMPLETE', 'Enter the event name.');
      if (coord.length < 3) fail_('INCOMPLETE', 'Enter the event coordinator’s name.');
      details = { event_name: ev, coordinator: coord, expected_duration_h: hours, unlisted: true };
    }
    if (!(hours >= 0.5 && hours <= maxH)) fail_('INCOMPLETE', 'Enter the ' + (type === ENTRY_TYPES.COURSE ? 'session duration' : 'expected duration') + ' in hours (0.5–' + maxH + ').');
    var end = d.getTime() + hours * 3600000 + graceMs;
    return { details: details, expected_end_at: new Date(Math.min(end, Math.max(closeAt.getTime(), d.getTime()))) };
  },

  /**
   * Validates the reason (step 10) and works out when the visit should auto-close
   * if the student forgets to check out (§4.5).
   */
  resolveReason: function (lab, r, d, opts) {
    r = r || {};
    var type = U.str(r.type).toUpperCase();
    var closeAt = Settings.closeAt(lab, d);
    var graceMs = lab.grace_min * 60000;
    var out = { entry_type: type, course_or_event_id: '', purpose: '', details: {}, expected_end_at: closeAt };

    if ((type === ENTRY_TYPES.COURSE || type === ENTRY_TYPES.EVENT) && r.manual && !r.sessionId) {
      var u = Attendance.resolveUnlisted(type, r.manual, d, closeAt, graceMs);
      out.details = u.details;
      out.expected_end_at = u.expected_end_at;
      out.unlisted = true;
    } else if (type === ENTRY_TYPES.COURSE || type === ENTRY_TYPES.EVENT) {
      var s = Db.byId('CoursesEvents', U.str(r.sessionId));
      if (!s || s.type !== type) fail_('INCOMPLETE', 'Choose your ' + (type === ENTRY_TYPES.COURSE ? 'course' : 'event') + ' from the list.');
      if (!(opts && opts.anyTime) && !Attendance.isSessionAvailable(s, lab.lab_id, d)) {
        fail_('INCOMPLETE', s.name + ' is not running in this lab right now.');
      }
      if (s.lab_id !== lab.lab_id) fail_('INCOMPLETE', s.name + ' belongs to a different lab.');
      out.course_or_event_id = s.id;
      var endMin = U.parseHHMM(s.end_time);
      var hours = U.num(s.session_hours, NaN);
      var end;
      if (type === ENTRY_TYPES.COURSE) {
        out.details = { code: s.code, name: s.name, session_hours: isFinite(hours) ? hours : '' };
        end = !isNaN(endMin) ? U.istDate(U.dateKey(d), endMin) : new Date(d.getTime() + (isFinite(hours) ? hours : 2) * 3600000);
      } else {
        out.details = { event_name: s.name, coordinator: s.coordinator_name, expected_duration_h: isFinite(hours) ? hours : '' };
        end = isFinite(hours) ? new Date(d.getTime() + hours * 3600000) : !isNaN(endMin) ? U.istDate(U.dateKey(d), endMin) : closeAt;
      }
      out.expected_end_at = new Date(Math.min(end.getTime() + graceMs, Math.max(closeAt.getTime(), d.getTime())));
    } else if (type === ENTRY_TYPES.RESEARCH) {
      var purpose = U.str(r.purpose, 300);
      var equipment = U.str(r.equipment, 300);
      if (purpose.length < 5) fail_('INCOMPLETE', 'Describe the purpose of your research visit (at least 5 characters).');
      if (!equipment) fail_('INCOMPLETE', 'List the equipment you need, or write "None".');
      out.purpose = purpose;
      out.details = { purpose: purpose, equipment: equipment };
    } else {
      fail_('INCOMPLETE', 'Choose a reason for your visit.');
    }

    // Which system the person will work at: a lab system, their own laptop, or none.
    var sys = U.str(r.systemId);
    if (sys && sys !== OWN_DEVICE) {
      var asset = Db.byId('Assets', sys);
      if (!asset || asset.lab_id !== lab.lab_id || SYSTEM_CATEGORIES.indexOf(asset.category) === -1 || asset.status === STATUS.ASSET.RETIRED) {
        fail_('INCOMPLETE', 'Choose a system from this lab’s list, or “Own laptop”.');
      }
      if (asset.status === STATUS.ASSET.MAINTENANCE) fail_('INCOMPLETE', asset.name + ' is under maintenance. Choose another system.');
    }
    out.system_id = sys;

    // Extra-hours (research) visits must say which project the time goes to.
    var pid = U.str(r.projectId);
    if (pid) {
      var proj = Db.byId('Projects', pid);
      if (!proj || proj.lab_id !== lab.lab_id || proj.status !== Projects.STATUS.ACTIVE) fail_('INCOMPLETE', 'Choose one of your active projects in this lab.');
      if (opts && opts.email && !Projects.isMember(proj, opts.email)) fail_('INCOMPLETE', 'You are not a member of that project.');
    } else if (type === ENTRY_TYPES.RESEARCH && !(opts && opts.anyTime)) {
      fail_('INCOMPLETE', 'Choose the project you are working on, or create one.');
    }
    out.project_id = pid;

    // Outside operating hours (staff override) there is no closing time to fall back on.
    if (out.expected_end_at.getTime() <= d.getTime()) {
      out.expected_end_at = new Date(d.getTime() + APP.MANUAL_VISIT_HOURS * 3600000);
    }
    return out;
  },

  /* ---------- check-in (§4.2 steps 1–11) ---------- */

  checkIn: function (ctx, p) {
    p = p || {};
    var reqKey = p.requestId ? 'req:' + ctx.email + ':' + U.str(p.requestId, 64) : '';
    if (reqKey) {
      var prior = Cache.getJson(reqKey);
      if (prior) return prior; // network retry: same answer, no second visit
    }
    var lab = Settings.lab(p.labId);
    var now = U.now();

    var ticket = Cache.getJson('ticket:' + ctx.email);
    if (!ticket || ticket.labId !== lab.lab_id) {
      fail_('NO_TICKET', 'Scan the QR code on the ' + lab.name + ' monitor first. A scan stays valid for ' + APP.TICKET_TTL_SEC / 60 + ' minutes.');
    }
    if (!Settings.isOpen(lab, now)) {
      Audit.log(ctx, 'CHECK_IN', '', 'REJECTED', 'Outside operating hours', lab.lab_id);
      fail_('LAB_CLOSED', lab.name + ' is closed now (' + lab.open_time + '–' + lab.close_time + '). Lab staff can make a supervised entry.');
    }
    var reason = Attendance.resolveReason(lab, p.reason, now, { email: ctx.email });
    var loc = { lat: p.lat, lng: p.lng, accuracy: p.accuracy, mock: p.mock === true, posAgeMs: p.posAgeMs };

    var result = withLock_(function () {
      if (reqKey) {
        var again = Cache.getJson(reqKey);
        if (again) return again;
      }
      var existing = Db.findOne('ActiveVisits', function (a) {
        return a.email === ctx.email && a.lab_id === lab.lab_id;
      });
      if (existing) {
        return { outcome: 'EXISTING', visit: Attendance.publicVisit(Db.byId('Visits', existing.visit_id)) };
      }

      var prev = Cache.getJson('lastpos:' + ctx.email);
      var prevLab = null;
      if (prev) {
        try { prevLab = Settings.lab(prev.labId); } catch (e) { prevLab = null; }
      }
      var ev = Geo.evaluate(lab, loc, prev, prevLab, now.getTime());
      loc = null; // coordinates are not needed past this point and are never stored (FR-08)
      if (isFinite(ev.distance)) {
        Cache.putJson('lastpos:' + ctx.email, { labId: lab.lab_id, d: Math.round(ev.distance), t: now.getTime() }, APP.LASTPOS_TTL_SEC);
      }
      Cache.remove('ticket:' + ctx.email); // one scan, one attempt

      if (ev.level === STATUS.CONF.RED) {
        Audit.log(ctx, 'SECURITY_CHECKIN_RED', '', 'REJECTED', ev.reasons.join('; '), lab.lab_id);
        return { outcome: STATUS.CONF.RED, reasons: ev.reasons };
      }

      // Physically you can only be in one lab: close any visit left open elsewhere.
      Db.find('ActiveVisits', function (a) {
        return a.email === ctx.email;
      }).forEach(function (a) {
        Attendance.closeVisit(a.visit_id, now, STATUS.CLOSE.AUTO_SWITCH, ctx, 'Checked in to ' + lab.lab_id);
      });

      if (reason.unlisted) {
        // Location is fine, but nobody has vouched for a session that is not in the timetable.
        ev.level = STATUS.CONF.AMBER;
        ev.reasons.push((reason.entry_type === ENTRY_TYPES.COURSE ? 'Course' : 'Event') + ' not in the timetable: needs staff confirmation');
      }
      var amber = ev.level === STATUS.CONF.AMBER;
      var visit = Db.insert('Visits', {
        visit_id: U.id('V'),
        user_id: ctx.user.user_id,
        email: ctx.email,
        lab_id: lab.lab_id,
        entry_type: reason.entry_type,
        course_or_event_id: reason.course_or_event_id,
        purpose: reason.purpose,
        details: reason.details,
        check_in_at: now,
        check_out_at: '',
        expected_end_at: reason.expected_end_at,
        is_valid_geofence: ev.inside,
        confidence: ev.level,
        confidence_reason: ev.reasons.join('; '),
        review_status: amber ? STATUS.REVIEW.PENDING : STATUS.REVIEW.NONE,
        reviewed_by: '',
        reviewed_at: '',
        close_type: '',
        status: STATUS.VISIT.ACTIVE,
        created_by: ctx.email,
        request_id: U.str(p.requestId, 64),
        system_id: reason.system_id,
        project_id: reason.project_id,
        work_note: ''
      });
      Db.insert('ActiveVisits', {
        visit_id: visit.visit_id,
        user_id: visit.user_id,
        email: visit.email,
        lab_id: visit.lab_id,
        check_in_at: visit.check_in_at,
        expected_end_at: visit.expected_end_at,
        entry_type: visit.entry_type,
        course_or_event_id: visit.course_or_event_id,
        review_status: visit.review_status,
        system_id: visit.system_id,
        project_id: visit.project_id
      });
      Audit.log(ctx, 'CHECK_IN', visit.visit_id, ev.level, visit.confidence_reason, lab.lab_id);
      Attendance.refreshOccupancy(lab.lab_id);
      return { outcome: ev.level, reasons: ev.reasons, visit: Attendance.publicVisit(visit) };
    });

    result = U.plain(result);
    if (reqKey) Cache.putJson(reqKey, result, APP.REQUEST_ID_TTL_SEC);
    return result;
  },

  /* ---------- check-out and closing ---------- */

  /** Closes one visit. Caller must hold the lock. */
  closeVisit: function (visitId, at, closeType, ctx, note) {
    var v = Db.byId('Visits', visitId);
    if (v && v.status === STATUS.VISIT.ACTIVE) {
      Db.update('Visits', v, {
        check_out_at: at,
        close_type: closeType,
        status: closeType === STATUS.CLOSE.VOIDED ? STATUS.VISIT.VOIDED : STATUS.VISIT.CLOSED
      });
    }
    var a = Db.findOne('ActiveVisits', function (x) {
      return x.visit_id === visitId;
    });
    if (a) Db.remove('ActiveVisits', a);
    var action = closeType === STATUS.CLOSE.MANUAL ? 'CHECK_OUT' : closeType === STATUS.CLOSE.STAFF ? 'STAFF_CHECK_OUT' : 'AUTO_CLOSE';
    if (closeType !== STATUS.CLOSE.VOIDED) Audit.log(ctx, action, visitId, closeType, note || '', v ? v.lab_id : '');
    if (v) Attendance.refreshOccupancy(v.lab_id);
    return v;
  },

  checkOut: function (ctx, p) {
    p = p || {};
    var reqKey = p.requestId ? 'req:' + ctx.email + ':' + U.str(p.requestId, 64) : '';
    if (reqKey) {
      var prior = Cache.getJson(reqKey);
      if (prior) return prior;
    }
    var result = withLock_(function () {
      var a = Db.findOne('ActiveVisits', function (x) {
        return x.email === ctx.email && (!p.labId || x.lab_id === U.str(p.labId).toUpperCase());
      });
      if (!a) fail_('NOT_CHECKED_IN', 'You are not checked in.');
      var note = U.str(p.note, 500);
      if (note) Db.update('Visits', Db.byId('Visits', a.visit_id), { work_note: note });
      var v = Attendance.closeVisit(a.visit_id, U.now(), STATUS.CLOSE.MANUAL, ctx, '');
      return { outcome: 'CHECKED_OUT', visit: Attendance.publicVisit(v) };
    });
    result = U.plain(result);
    if (reqKey) Cache.putJson(reqKey, result, APP.REQUEST_ID_TTL_SEC);
    return result;
  },

  /* ---------- Amber review (FR-16) ---------- */

  /**
   * Course/event check-ins are reviewed by that session's faculty; self-work and sessions
   * that are not in the timetable are reviewed by lab staff.
   */
  canReview: function (ctx, visit) {
    if (ctx.role === ROLES.ADMIN) return true;
    var labTeam = ctx.role === ROLES.STAFF || ctx.role === ROLES.COORDINATOR;
    if (visit.entry_type === ENTRY_TYPES.RESEARCH || !visit.course_or_event_id) return labTeam;
    var s = Db.byId('CoursesEvents', visit.course_or_event_id);
    if (ctx.role === ROLES.COORDINATOR) return true; // the lab coordinator may review any session
    return !!s && s.coordinator_email === ctx.email && (ctx.role === ROLES.FACULTY || ctx.role === ROLES.STAFF);
  },

  reviewQueue: function (ctx, labId) {
    var users = Attendance.userIndex();
    return Db.find('Visits', function (v) {
      return v.review_status === STATUS.REVIEW.PENDING && v.status !== STATUS.VISIT.VOIDED &&
        (!labId || v.lab_id === labId) && Attendance.canReview(ctx, v);
    }).map(function (v) {
      var pv = Attendance.publicVisit(v);
      var u = users[v.email] || {};
      pv.name = u.name || v.email;
      pv.reg_no = u.reg_no || '';
      pv.email = v.email;
      pv.flag_reason = v.confidence_reason;
      return pv;
    });
  },

  review: function (ctx, p) {
    var decision = U.str(p && p.decision).toUpperCase();
    if (decision !== 'CONFIRM' && decision !== 'DECLINE') fail_('INVALID', 'Decision must be CONFIRM or DECLINE.');
    var note = U.str(p.note, 300);
    return U.plain(withLock_(function () {
      var v = Db.byId('Visits', U.str(p.visitId));
      if (!v) fail_('NOT_FOUND', 'Visit not found.');
      if (!Attendance.canReview(ctx, v)) {
        Audit.log(ctx, 'SECURITY_FORBIDDEN', v.visit_id, 'DENIED', 'Not this visit\'s reviewer', v.lab_id);
        fail_('FORBIDDEN', 'You are not the reviewer for this visit.');
      }
      if (v.review_status !== STATUS.REVIEW.PENDING) fail_('ALREADY', 'This visit has already been reviewed.');
      var now = U.now();
      if (decision === 'CONFIRM') {
        Db.update('Visits', v, { review_status: STATUS.REVIEW.CONFIRMED, reviewed_by: ctx.email, reviewed_at: now });
        var a = Db.findOne('ActiveVisits', function (x) { return x.visit_id === v.visit_id; });
        if (a) Db.update('ActiveVisits', a, { review_status: STATUS.REVIEW.CONFIRMED });
        Attendance.refreshOccupancy(v.lab_id); // now a verified sign-in: the counter goes up
        Audit.log(ctx, 'REVIEW_CONFIRM', v.visit_id, 'CONFIRMED', note, v.lab_id);
      } else {
        Db.update('Visits', v, { review_status: STATUS.REVIEW.DECLINED, reviewed_by: ctx.email, reviewed_at: now });
        if (v.status === STATUS.VISIT.ACTIVE) {
          Attendance.closeVisit(v.visit_id, now, STATUS.CLOSE.VOIDED, ctx, note);
        } else {
          Db.update('Visits', v, { status: STATUS.VISIT.VOIDED, close_type: STATUS.CLOSE.VOIDED });
        }
        Audit.log(ctx, 'REVIEW_DECLINE', v.visit_id, 'VOIDED', note, v.lab_id);
      }
      return Attendance.publicVisit(v);
    }));
  },

  /* ---------- staff actions (§4.6 manual fallback, FR-15 override) ---------- */

  manualEntry: function (ctx, p) {
    p = p || {};
    var why = U.str(p.why, 300);
    if (why.length < 5) fail_('INVALID', 'A reason is required for a manual entry (at least 5 characters).');
    var lab = Settings.lab(p.labId);
    var email = U.str(p.email).toLowerCase();
    var now = U.now();
    var reason = Attendance.resolveReason(lab, p.reason, now, { anyTime: true });
    var override = !Settings.isOpen(lab, now);
    return U.plain(withLock_(function () {
      var target = Db.findOne('Users', function (u) {
        return u.email === email;
      });
      if (!target || !Auth.isRegistered(Auth.publicUser(target)) || !U.truthy(target.active)) {
        fail_('INVALID', 'No active, registered user with that email.');
      }
      var existing = Db.findOne('ActiveVisits', function (a) {
        return a.email === email;
      });
      if (existing) fail_('ALREADY', 'That user is already checked in to ' + existing.lab_id + '.');
      var visit = Db.insert('Visits', {
        visit_id: U.id('V'), user_id: target.user_id, email: email, lab_id: lab.lab_id,
        entry_type: reason.entry_type, course_or_event_id: reason.course_or_event_id,
        purpose: reason.purpose, details: reason.details, check_in_at: now, check_out_at: '',
        expected_end_at: reason.expected_end_at, is_valid_geofence: false,
        confidence: STATUS.CONF.MANUAL, confidence_reason: 'Staff manual entry: ' + why,
        review_status: STATUS.REVIEW.NONE, reviewed_by: '', reviewed_at: '', close_type: '',
        status: STATUS.VISIT.ACTIVE, created_by: ctx.email, request_id: '',
        system_id: reason.system_id, project_id: reason.project_id, work_note: ''
      });
      Db.insert('ActiveVisits', {
        visit_id: visit.visit_id, user_id: visit.user_id, email: email, lab_id: lab.lab_id,
        check_in_at: now, expected_end_at: visit.expected_end_at, entry_type: visit.entry_type,
        course_or_event_id: visit.course_or_event_id, review_status: '',
        system_id: visit.system_id, project_id: visit.project_id
      });
      Audit.log(ctx, override ? 'MANUAL_ENTRY_OVERRIDE_HOURS' : 'MANUAL_ENTRY', visit.visit_id, 'CREATED', email + ': ' + why, lab.lab_id);
      Attendance.refreshOccupancy(lab.lab_id);
      return Attendance.publicVisit(visit);
    }));
  },

  forceCheckOut: function (ctx, p) {
    var why = U.str(p && p.why, 300);
    if (why.length < 3) fail_('INVALID', 'Give a reason for checking this person out.');
    return U.plain(withLock_(function () {
      var a = Db.findOne('ActiveVisits', function (x) {
        return x.visit_id === U.str(p.visitId);
      });
      if (!a) fail_('NOT_FOUND', 'That visit is no longer active.');
      return Attendance.publicVisit(Attendance.closeVisit(a.visit_id, U.now(), STATUS.CLOSE.STAFF, ctx, why));
    }));
  },

  /* ---------- background jobs (§3.4, FR-18) ---------- */

  /** Closes visits past their expected end (duration + grace, or closing time) and labels them. */
  autoCloseSweep: function () {
    return withLock_(function () {
      var now = U.now();
      var closed = 0;
      Db.all('Visits').forEach(function (v) {
        if (v.status !== STATUS.VISIT.ACTIVE) return;
        var end = v.expected_end_at;
        if (!end) {
          var lab = Settings.labs(true).filter(function (l) { return l.lab_id === v.lab_id; })[0];
          end = lab ? Settings.closeAt(lab, v.check_in_at) : now;
        }
        if (end.getTime() > now.getTime()) return;
        var type = v.entry_type === ENTRY_TYPES.RESEARCH ? STATUS.CLOSE.AUTO_CLOSING : STATUS.CLOSE.AUTO_DURATION;
        // Auto-closed visits count only up to the time they were closed (§5.7).
        Db.update('Visits', v, { check_out_at: end, close_type: type, status: STATUS.VISIT.CLOSED });
        Audit.log(null, 'AUTO_CLOSE', v.visit_id, type, 'Forgot to check out', v.lab_id);
        closed++;
      });
      var rec = Attendance.rebuildActive(closed > 0);
      return { closed: closed, occupancy: rec.occupancy };
    });
  },

  reconcile: function () {
    return withLock_(function () {
      return Attendance.rebuildActive(false);
    });
  },

  /** Rebuilds ActiveVisits from Visits and recounts occupancy. Caller must hold the lock. */
  rebuildActive: function (force) {
    var expected = Db.find('Visits', function (v) {
      return v.status === STATUS.VISIT.ACTIVE;
    });
    var actual = Db.all('ActiveVisits');
    var key = function (r) { return r.visit_id + ':' + (r.review_status === STATUS.REVIEW.PENDING ? 'P' : 'V'); };
    var want = expected.map(key).sort().join(',');
    var have = actual.map(key).sort().join(',');
    var drift = want !== have || actual.length !== expected.length;
    if (drift || force) {
      Db.replaceAll('ActiveVisits', expected.map(function (v) {
        return {
          visit_id: v.visit_id, user_id: v.user_id, email: v.email, lab_id: v.lab_id,
          check_in_at: v.check_in_at, expected_end_at: v.expected_end_at,
          entry_type: v.entry_type, course_or_event_id: v.course_or_event_id,
          review_status: v.review_status, system_id: v.system_id, project_id: v.project_id
        };
      }));
      if (drift && !force) Audit.log(null, 'RECONCILE_DRIFT', 'ActiveVisits', 'FIXED', have.split(',').length + ' -> ' + expected.length + ' rows', '');
    }
    var occupancy = {};
    Settings.labs(true).forEach(function (l) {
      occupancy[l.lab_id] = Attendance.refreshOccupancy(l.lab_id);
    });
    return { drift: drift, occupancy: occupancy };
  },

  /* ---------- views ---------- */

  status: function (ctx) {
    var a = Db.findOne('ActiveVisits', function (x) {
      return x.email === ctx.email;
    });
    var visit = a ? Attendance.publicVisit(Db.byId('Visits', a.visit_id)) : null;
    return { checkedIn: !!visit, visit: visit, ticket: Attendance.ticket(ctx.email) };
  },

  history: function (email, limit) {
    return Db.find('Visits', function (v) {
      return v.email === email;
    })
      .sort(function (a, b) { return b.check_in_at - a.check_in_at; })
      .slice(0, limit || 50)
      .map(Attendance.publicVisit);
  },

  publicVisit: function (v) {
    if (!v) return null;
    var details = {};
    try { details = typeof v.details === 'string' ? JSON.parse(v.details || '{}') : v.details || {}; } catch (e) { details = {}; }
    var label = v.entry_type === ENTRY_TYPES.COURSE ? (details.code ? details.code + ' · ' : '') + (details.name || 'Course')
      : v.entry_type === ENTRY_TYPES.EVENT ? details.event_name || 'Event'
      : 'Research: ' + (details.purpose || v.purpose || '');
    var end = v.check_out_at || U.now();
    return {
      visit_id: v.visit_id,
      lab_id: v.lab_id,
      lab_name: Settings.labName(v.lab_id),
      entry_type: v.entry_type,
      course_or_event_id: v.course_or_event_id,
      label: label,
      check_in_at: v.check_in_at,
      check_out_at: v.check_out_at || null,
      expected_end_at: v.expected_end_at || null,
      duration_ms: v.check_in_at ? end - v.check_in_at : 0,
      confidence: v.confidence,
      review_status: v.review_status,
      close_type: v.close_type,
      status: v.status,
      system_id: v.system_id || '',
      project_id: v.project_id || '',
      work_note: v.work_note || ''
    };
  },

  userIndex: function () {
    var idx = {};
    Db.all('Users').forEach(function (u) {
      idx[u.email] = u;
    });
    return idx;
  }
};
