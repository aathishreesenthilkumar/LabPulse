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

  /** Who is inside right now (staff view). */
  inside: function (labId) {
    var users = Attendance.userIndex();
    var now = U.now();
    return Db.find('ActiveVisits', function (a) {
      return a.lab_id === labId;
    }).map(function (a) {
      var v = Db.byId('Visits', a.visit_id) || {};
      var u = users[a.email] || {};
      return {
        visit_id: a.visit_id, name: u.name || a.email, reg_no: u.reg_no || '', email: a.email,
        entry_type: a.entry_type, check_in_at: a.check_in_at, expected_end_at: a.expected_end_at,
        duration_ms: now - a.check_in_at, confidence: v.confidence, review_status: v.review_status
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

  /** Sessions this faculty member coordinates that run today. Admin sees every session. */
  facultySessions: function (ctx, labId) {
    var d = U.now();
    var today = U.dateKey(d);
    return Db.find('CoursesEvents', function (s) {
      if (!U.truthy(s.active)) return false;
      if (labId && s.lab_id !== labId) return false;
      if (ctx.role !== ROLES.ADMIN && s.coordinator_email !== ctx.email) return false;
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
    if (ctx.role !== ROLES.ADMIN && s.coordinator_email !== ctx.email) {
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
      date: date, roster: out
    };
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
