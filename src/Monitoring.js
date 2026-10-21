/**
 * Live monitoring for staff and faculty (FR-26 – FR-28) and the lab monitor wall display.
 */
var Monitoring = {
  ACTIVITY_ACTIONS: [
    'CHECK_IN', 'CHECK_OUT', 'AUTO_CLOSE', 'STAFF_CHECK_OUT', 'MANUAL_ENTRY', 'MANUAL_ENTRY_OVERRIDE_HOURS',
    'REVIEW_CONFIRM', 'REVIEW_DECLINE', 'REQUEST', 'ISSUE', 'RETURN', 'LOAN_OVERDUE',
    'SECURITY_CHECKIN_RED', 'SECURITY_QR_REUSED', 'SECURITY_QR_EXPIRED', 'SECURITY_QR_INVALID'
  ],

  /** FR-26: recent check-ins, check-outs, issues and returns for one lab. */
  activity: function (labId) {
    var users = Attendance.userIndex();
    return Db.tail('AuditLog', 300)
      .filter(function (e) {
        return e.lab_id === labId && Monitoring.ACTIVITY_ACTIONS.indexOf(e.action) !== -1;
      })
      .slice(-APP.ACTIVITY_LIMIT)
      .reverse()
      .map(function (e) {
        var u = users[e.actor];
        return {
          at: e.timestamp, action: e.action, outcome: e.outcome, target: e.target,
          who: u && u.name ? u.name : e.actor === 'system' ? 'LabPulse' : e.actor,
          note: e.action.indexOf('SECURITY_') === 0 || e.action === 'CHECK_IN' ? e.reason : ''
        };
      });
  },

  /** Top strip of the staff dashboard. */
  summary: function (labId) {
    var now = U.now();
    var loans = Db.find('Loans', function (l) {
      return l.lab_id === labId && l.status !== STATUS.LOAN.RETURNED;
    });
    return {
      occupancy: Attendance.occupancy(labId),
      pending_inside: Attendance.pending(labId),
      items_out: loans.length,
      overdue: loans.filter(function (l) { return l.due_at && l.due_at < now; }).length,
      pending_requests: Db.find('Requests', function (r) {
        return r.lab_id === labId && r.status === STATUS.REQUEST.PENDING;
      }).length,
      pending_reviews: Db.find('Visits', function (v) {
        return v.lab_id === labId && v.review_status === STATUS.REVIEW.PENDING && v.status !== STATUS.VISIT.VOIDED;
      }).length
    };
  },

  systemLabel: function (id, assets) {
    if (!id) return 'Not specified';
    if (id === OWN_DEVICE) return 'Own laptop';
    var a = assets[id];
    return a ? a.name + ' (' + a.asset_id + ')' : id;
  },

  /**
   * Who is inside right now: name, register number, the system they are working at and the
   * project they are working on. This is the "from home" view for HOD, Coordinator and staff.
   */
  inside: function (labId) {
    var users = Attendance.userIndex();
    var now = U.now();
    var assets = {};
    Db.all('Assets').forEach(function (a) { assets[a.asset_id] = a; });
    var projects = {};
    Db.all('Projects').forEach(function (p) { projects[p.project_id] = p; });
    return Db.find('ActiveVisits', function (a) {
      return a.lab_id === labId;
    }).map(function (a) {
      var v = Db.byId('Visits', a.visit_id) || {};
      var u = users[a.email] || {};
      return {
        visit_id: a.visit_id, name: u.name || a.email, reg_no: u.reg_no || '', email: a.email,
        entry_type: a.entry_type, check_in_at: a.check_in_at, expected_end_at: a.expected_end_at,
        duration_ms: now - a.check_in_at, confidence: v.confidence, review_status: v.review_status,
        system_id: a.system_id, system: Monitoring.systemLabel(a.system_id, assets),
        project_id: a.project_id, project: a.project_id && projects[a.project_id] ? projects[a.project_id].title : '',
        purpose: v.purpose || ''
      };
    }).sort(function (a, b) { return b.check_in_at - a.check_in_at; });
  },

  /**
   * FR-28 Live Lab Map: a grid floor plan built from stored records. Each placed asset
   * shows its status; the page labels it "based on app records, not physical sensors".
   */
  labMap: function (labId) {
    var lab = Settings.lab(labId);
    var cells = Assets.publicList(labId).filter(function (a) {
      return a.map_x !== null && a.map_y !== null;
    });
    return {
      cols: lab.map_cols, rows: lab.map_rows, cells: cells,
      occupancy: Attendance.occupancy(labId),
      note: 'Based on app records, not physical sensors.'
    };
  },

  /** Wall display tick: cache-only reads (§4.4 quota note). */
  monitorTick: function (labId) {
    var lab = Settings.lab(labId);
    var now = U.now();
    var occupancy = Attendance.occupancy(lab.lab_id);
    var pending = Attendance.pending(lab.lab_id);
    if (!Settings.isOpen(lab, now)) {
      return { open: false, labName: lab.name, occupancy: occupancy, pending: pending, hours: lab.open_time + '–' + lab.close_time, days: lab.open_days };
    }
    var cur = Token.current(lab, now.getTime());
    return {
      open: true, labName: lab.name, token: cur.token, msLeft: cur.msLeft,
      rotateSec: lab.qr_rotate_sec, occupancy: occupancy, pending: pending, serverTime: now.getTime()
    };
  },

  /* ---------- faculty (FR-27) ---------- */

  seesAllSessions: function (ctx) {
    return ctx.role === ROLES.ADMIN || ctx.role === ROLES.COORDINATOR || ctx.role === ROLES.HOD;
  },

  /** Sessions this faculty member coordinates that run today. Admin, Coordinator and HOD see every session. */
  facultySessions: function (ctx, labId) {
    var d = U.now();
    var today = U.dateKey(d);
    return Db.find('CoursesEvents', function (s) {
      if (!U.truthy(s.active)) return false;
      if (labId && s.lab_id !== labId) return false;
      if (!Monitoring.seesAllSessions(ctx) && s.coordinator_email !== ctx.email) return false;
      if (s.start_date && today < s.start_date) return false;
      if (s.end_date && today > s.end_date) return false;
      if (s.type === ENTRY_TYPES.COURSE && U.str(s.days).toUpperCase().split(',').indexOf(U.dayCode(d)) === -1) return false;
      return true;
    }).map(function (s) {
      return {
        id: s.id, type: s.type, code: s.code, name: s.name, lab_id: s.lab_id,
        start_time: s.start_time, end_time: s.end_time, running: Attendance.isSessionAvailable(s, s.lab_id, d)
      };
    }).sort(function (a, b) { return a.start_time < b.start_time ? -1 : 1; });
  },

  sessionFor: function (ctx, sessionId) {
    var s = Db.byId('CoursesEvents', U.str(sessionId));
    if (!s) fail_('NOT_FOUND', 'Session not found.');
    if (!Monitoring.seesAllSessions(ctx) && s.coordinator_email !== ctx.email) {
      Audit.log(ctx, 'SECURITY_FORBIDDEN', s.id, 'DENIED', 'Not the session coordinator', s.lab_id);
      fail_('FORBIDDEN', 'You do not coordinate this session.');
    }
    return s;
  },

  /** Present · Pending review · Not yet arrived for one session on one date. */
  roster: function (ctx, p) {
    var s = Monitoring.sessionFor(ctx, p && p.sessionId);
    var date = U.isDateKey(p.date) ? p.date : U.dateKey(U.now());
    var from = U.istDate(date, 0);
    var to = U.istDate(U.addDays(date, 1), 0);
    var users = Attendance.userIndex();
    var enrolled = Db.find('Enrollments', function (e) {
      return e.session_id === s.id;
    }).map(function (e) { return U.str(e.user_email).toLowerCase(); });

    var visits = {};
    Db.find('Visits', function (v) {
      return v.course_or_event_id === s.id && v.check_in_at >= from && v.check_in_at < to && v.status !== STATUS.VISIT.VOIDED;
    }).forEach(function (v) {
      visits[v.email] = v; // latest visit wins
    });
    var marks = {};
    Db.find('AttendanceMarks', function (m) {
      return m.session_id === s.id && m.session_date === date;
    }).forEach(function (m) {
      marks[m.user_email] = m; // latest mark wins
    });

    var emails = enrolled.slice();
    Object.keys(visits).forEach(function (e) { if (emails.indexOf(e) === -1) emails.push(e); });
    Object.keys(marks).forEach(function (e) { if (emails.indexOf(e) === -1) emails.push(e); });

    var out = { present: [], pending: [], absent: [], notArrived: [] };
    emails.forEach(function (email) {
      var u = users[email] || {};
      var v = visits[email];
      var m = marks[email];
      var row = {
        email: email, name: u.name || email, reg_no: u.reg_no || '', enrolled: enrolled.indexOf(email) !== -1,
        visit_id: v ? v.visit_id : '', check_in_at: v ? v.check_in_at : null, check_out_at: v ? v.check_out_at : null,
        confidence: v ? v.confidence : '', inside: !!(v && v.status === STATUS.VISIT.ACTIVE),
        mark: m ? m.mark : '', mark_reason: m ? m.reason : ''
      };
      if (m && m.mark === STATUS.MARK.ABSENT) out.absent.push(row);
      else if (m && m.mark === STATUS.MARK.PRESENT) out.present.push(row);
      else if (v && v.review_status === STATUS.REVIEW.PENDING) out.pending.push(row);
      else if (v) out.present.push(row);
      else out.notArrived.push(row);
    });
    return {
      session: { id: s.id, type: s.type, code: s.code, name: s.name, lab_id: s.lab_id, start_time: s.start_time, end_time: s.end_time },
      date: date, roster: out,
      // Once the session has ended, "not yet arrived" means missing.
      ended: U.now() >= U.istDate(date, isNaN(U.parseHHMM(s.end_time)) ? 24 * 60 : U.parseHHMM(s.end_time)),
      missing: out.notArrived.concat(out.absent).filter(function (x) { return x.enrolled; })
    };
  },

  /**
   * After each timetabled course ends, email its faculty the enrolled students who were missing.
   * Runs from the 10-minute job; each session/day is emailed once (remembered in the cache).
   */
  missingEmails: function () {
    if (!Settings.global().missing_list_email) return 0;
    var now = U.now();
    var today = U.dateKey(now);
    var m = U.minutesOfDay(now);
    var sent = 0;
    Db.all('CoursesEvents').forEach(function (s) {
      if (!U.truthy(s.active) || s.type !== ENTRY_TYPES.COURSE) return;
      if (U.str(s.days).toUpperCase().split(',').indexOf(U.dayCode(now)) === -1) return;
      if ((s.start_date && today < s.start_date) || (s.end_date && today > s.end_date)) return;
      var end = U.parseHHMM(s.end_time);
      if (isNaN(end) || m < end || m > end + 120) return;
      var key = 'missing:' + s.id + ':' + today;
      if (Cache.get(key)) return;
      Cache.put(key, '1', 21600);
      var r = Monitoring.roster({ role: ROLES.ADMIN, email: 'system' }, { sessionId: s.id, date: today });
      if (!r.missing.length || !U.isEmail(s.coordinator_email)) return;
      var lines = r.missing.map(function (x) { return '  • ' + x.reg_no + '  ' + x.name + (x.mark === 'ABSENT' ? '  (marked absent: ' + x.mark_reason + ')' : ''); });
      try {
        GmailApp.sendEmail(s.coordinator_email, '[LabPulse] Missing from ' + s.code + ' ' + s.name + ' — ' + today,
          r.missing.length + ' enrolled student(s) did not check in to ' + s.code + ' ' + s.name + ' (' + s.start_time + '–' + s.end_time + ') today:\n\n' +
          lines.join('\n') + '\n\nOpen LabPulse → My sessions to mark anyone present with a reason.\n\n— LabPulse');
        Audit.log(null, 'MISSING_LIST', s.id, 'SENT', r.missing.length + ' missing', s.lab_id);
        sent++;
      } catch (e) {
        console.error('Missing-list email failed for ' + s.id + ': ' + e.message);
      }
    });
    return sent;
  },

  /** Manual present/absent with a reason; audit-logged. Does not change occupancy. */
  mark: function (ctx, p) {
    var s = Monitoring.sessionFor(ctx, p && p.sessionId);
    var mark = U.str(p.mark).toUpperCase();
    if (!STATUS.MARK[mark]) fail_('INVALID', 'Mark must be PRESENT or ABSENT.');
    var reason = U.str(p.reason, 300);
    if (reason.length < 3) fail_('INVALID', 'A reason is required for a manual mark.');
    var email = U.str(p.email).toLowerCase();
    if (!U.isEmail(email)) fail_('INVALID', 'Invalid student email.');
    var date = U.isDateKey(p.date) ? p.date : U.dateKey(U.now());
    return U.plain(withLock_(function () {
      var row = Db.insert('AttendanceMarks', {
        mark_id: U.id('M'), session_id: s.id, session_date: date, user_email: email, mark: mark,
        reason: reason, marked_by: ctx.email, marked_at: U.now()
      });
      Audit.log(ctx, 'MANUAL_MARK', email, mark, s.id + ' ' + date + ': ' + reason, s.lab_id);
      return row;
    }));
  }
};
