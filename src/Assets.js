/**
 * Inventory, booking requests and the issue/return handshake (FR-19 – FR-25).
 *
 * Lifecycle: AVAILABLE → (student request) RESERVED → (staff issue) ISSUED → (staff return)
 * AVAILABLE, or MAINTENANCE if returned damaged. A rejected, cancelled or expired request
 * releases the reservation. An asset with an active loan can never be issued again.
 */
var Assets = {
  PUBLIC_STATUS: { AVAILABLE: 'AVAILABLE', RESERVED: 'RESERVED', ISSUED: 'ISSUED', MAINTENANCE: 'UNAVAILABLE' },

  /** FR-20: public availability, no borrower details. */
  publicList: function (labId) {
    var inUse = Attendance.systemsInUse(labId);
    return Db.find('Assets', function (a) {
      return a.lab_id === labId && a.status !== STATUS.ASSET.RETIRED;
    }).map(function (a) {
      // A system someone is checked in at is in use, even though it is not on loan.
      var status = a.status === STATUS.ASSET.AVAILABLE && inUse[a.asset_id] ? 'IN_USE' : Assets.PUBLIC_STATUS[a.status] || a.status;
      return {
        asset_id: a.asset_id, name: a.name, category: a.category, type: a.type,
        status: status, condition: a.condition,
        location: a.location, map_x: U.num(a.map_x, null), map_y: U.num(a.map_y, null)
      };
    });
  },

  /** "Free right now" chips on the student dashboard. */
  freeNow: function (labId) {
    var counts = {};
    var inUse = Attendance.systemsInUse(labId);
    Db.all('Assets').forEach(function (a) {
      if (a.lab_id !== labId || a.status !== STATUS.ASSET.AVAILABLE || inUse[a.asset_id]) return;
      counts[a.type] = (counts[a.type] || 0) + 1;
    });
    return Object.keys(counts).sort().map(function (t) {
      return { type: t, count: counts[t] };
    });
  },

  isCheckedIn: function (email, labId) {
    return !!Db.findOne('ActiveVisits', function (a) {
      return a.email === email && a.lab_id === labId;
    });
  },

  /** CHECKED_IN means a verified visit: Green, Manual or a confirmed Amber. */
  isVerifiedIn: function (email, labId) {
    return !!Db.findOne('ActiveVisits', function (a) {
      return a.email === email && a.lab_id === labId && a.review_status !== STATUS.REVIEW.PENDING;
    });
  },

  /** FR-21: only a student whose visit to the asset's lab is CHECKED_IN (verified) may request it. */
  request: function (ctx, p) {
    p = p || {};
    var g = Settings.global();
    var hours = Math.round(U.num(p.hours, g.default_loan_hours));
    if (!(hours >= 1 && hours <= g.max_loan_hours)) fail_('INVALID', 'Loan length must be 1–' + g.max_loan_hours + ' hours.');
    var note = U.str(p.note, 300);
    return U.plain(withLock_(function () {
      var asset = Db.byId('Assets', U.str(p.assetId));
      if (!asset || asset.status === STATUS.ASSET.RETIRED) fail_('NOT_FOUND', 'That item does not exist.');
      if (!Assets.isCheckedIn(ctx.email, asset.lab_id)) {
        Audit.log(ctx, 'REQUEST', asset.asset_id, 'REJECTED', 'Not checked in', asset.lab_id);
        fail_('NOT_CHECKED_IN', 'You can request equipment only while checked in to ' + Settings.labName(asset.lab_id) + '.');
      }
      if (!Assets.isVerifiedIn(ctx.email, asset.lab_id)) {
        Audit.log(ctx, 'REQUEST', asset.asset_id, 'REJECTED', 'Check-in pending review', asset.lab_id);
        fail_('PENDING_REVIEW', 'Your check-in is waiting for review. You can request equipment once it is confirmed.');
      }
      if (asset.status !== STATUS.ASSET.AVAILABLE) fail_('UNAVAILABLE', asset.name + ' is not available right now.');
      var at = Attendance.systemsInUse(asset.lab_id)[asset.asset_id];
      if (at && at !== ctx.email) fail_('UNAVAILABLE', asset.name + ' is in use by someone working in the lab right now.');
      var now0 = U.now();
      var held = Bookings.heldByOther(asset.asset_id, ctx.email, now0, new Date(now0.getTime() + hours * 3600000));
      if (held) fail_('UNAVAILABLE', asset.name + ' is reserved from ' + U.fmt(held.start_at) + '. Reserve another slot instead.');
      var open = Db.find('Requests', function (r) {
        return r.requester_email === ctx.email && r.status === STATUS.REQUEST.PENDING;
      });
      if (open.length >= g.max_open_requests) fail_('LIMIT', 'You already have ' + open.length + ' pending requests.');
      var now = U.now();
      var req = Db.insert('Requests', {
        request_id: U.id('R'), lab_id: asset.lab_id, asset_id: asset.asset_id,
        requester_id: ctx.user.user_id, requester_email: ctx.email, window_start_at: now,
        window_end_at: new Date(now.getTime() + hours * 3600000), note: note,
        status: STATUS.REQUEST.PENDING, decided_by: '', decided_at: '', decision_note: '', created_at: now
      });
      Db.update('Assets', asset, { status: STATUS.ASSET.RESERVED, updated_at: now });
      Audit.log(ctx, 'REQUEST', req.request_id, 'PENDING', asset.asset_id, asset.lab_id);
      return Assets.publicRequest(req, asset);
    }));
  },

  cancelRequest: function (ctx, p) {
    return U.plain(withLock_(function () {
      var r = Db.byId('Requests', U.str(p && p.requestId));
      if (!r || r.requester_email !== ctx.email) fail_('NOT_FOUND', 'Request not found.');
      if (r.status !== STATUS.REQUEST.PENDING) fail_('ALREADY', 'This request is no longer pending.');
      Assets.closeRequest(r, STATUS.REQUEST.CANCELLED, ctx, 'Cancelled by student');
      return Assets.publicRequest(r);
    }));
  },

  /** Ends a pending request and releases the reservation. Caller holds the lock. */
  closeRequest: function (r, status, ctx, note) {
    var now = U.now();
    Db.update('Requests', r, { status: status, decided_by: ctx ? ctx.email : 'system', decided_at: now, decision_note: note || '' });
    var asset = Db.byId('Assets', r.asset_id);
    if (asset && asset.status === STATUS.ASSET.RESERVED) Db.update('Assets', asset, { status: STATUS.ASSET.AVAILABLE, updated_at: now });
    Audit.log(ctx, 'REQUEST_' + status, r.request_id, status, note || '', r.lab_id);
  },

  /** FR-22: staff confirm the physical handover. */
  issue: function (ctx, p) {
    p = p || {};
    var condition = U.str(p.condition).toUpperCase() || 'GOOD';
    if (STATUS.CONDITIONS.indexOf(condition) === -1) fail_('INVALID', 'Unknown condition.');
    return U.plain(withLock_(function () {
      var r = Db.byId('Requests', U.str(p.requestId));
      if (!r || r.status !== STATUS.REQUEST.PENDING) fail_('NOT_FOUND', 'No pending request with that ID.');
      var asset = Db.byId('Assets', r.asset_id);
      if (!asset || asset.status !== STATUS.ASSET.RESERVED) fail_('INVALID', 'The item is not reserved for this request.');
      var activeLoan = Db.findOne('Loans', function (l) {
        return l.asset_id === asset.asset_id && l.status !== STATUS.LOAN.RETURNED;
      });
      if (activeLoan) fail_('INVALID', asset.name + ' is already on loan (' + activeLoan.loan_id + ').');
      var now = U.now();
      var due = U.toDate(p.dueAt) || r.window_end_at;
      if (!due || due.getTime() <= now.getTime()) fail_('INVALID', 'The due time must be in the future.');
      var loan = Db.insert('Loans', {
        loan_id: U.id('L'), lab_id: r.lab_id, asset_id: asset.asset_id, request_id: r.request_id,
        borrower_id: r.requester_id, borrower_email: r.requester_email, issued_by: ctx.email,
        issued_at: now, due_at: due, issue_condition: condition, returned_at: '', returned_to: '',
        return_condition: '', status: STATUS.LOAN.ISSUED, last_reminder_at: ''
      });
      Db.update('Requests', r, { status: STATUS.REQUEST.FULFILLED, decided_by: ctx.email, decided_at: now });
      Db.update('Assets', asset, { status: STATUS.ASSET.ISSUED, condition: condition, updated_at: now });
      Audit.log(ctx, 'ISSUE', loan.loan_id, 'ISSUED', asset.asset_id + ' to ' + r.requester_email + ', due ' + U.fmt(due), r.lab_id);
      return loan;
    }));
  },

  reject: function (ctx, p) {
    return U.plain(withLock_(function () {
      var r = Db.byId('Requests', U.str(p && p.requestId));
      if (!r || r.status !== STATUS.REQUEST.PENDING) fail_('NOT_FOUND', 'No pending request with that ID.');
      Assets.closeRequest(r, STATUS.REQUEST.REJECTED, ctx, U.str(p.reason, 300));
      return Assets.publicRequest(r);
    }));
  },

  markReturn: function (ctx, p) {
    p = p || {};
    var condition = U.str(p.condition).toUpperCase();
    if (STATUS.CONDITIONS.indexOf(condition) === -1) fail_('INVALID', 'Record the condition: GOOD, FAIR or DAMAGED.');
    return U.plain(withLock_(function () {
      var loan = Db.byId('Loans', U.str(p.loanId));
      if (!loan || loan.status === STATUS.LOAN.RETURNED) fail_('NOT_FOUND', 'No open loan with that ID.');
      var now = U.now();
      Db.update('Loans', loan, { returned_at: now, returned_to: ctx.email, return_condition: condition, status: STATUS.LOAN.RETURNED });
      var asset = Db.byId('Assets', loan.asset_id);
      if (asset) {
        Db.update('Assets', asset, {
          status: condition === 'DAMAGED' ? STATUS.ASSET.MAINTENANCE : STATUS.ASSET.AVAILABLE,
          condition: condition, updated_at: now
        });
      }
      Audit.log(ctx, 'RETURN', loan.loan_id, condition, U.str(p.notes, 300), loan.lab_id);
      return loan;
    }));
  },

  /* ---------- inventory management (FR-24) ---------- */

  inventory: function (labId) {
    return Db.find('Assets', function (a) {
      return a.lab_id === labId && a.status !== STATUS.ASSET.RETIRED;
    }).map(function (a) {
      var o = {};
      SHEETS.Assets.forEach(function (k) { o[k] = a[k]; });
      return o;
    });
  },

  save: function (ctx, p) {
    p = p || {};
    var category = U.str(p.category).toUpperCase();
    if (!ASSET_CATALOG[category]) fail_('INVALID', 'Category must be GPU, IOT or SENSOR.');
    var type = U.str(p.type, 40);
    if (!type) fail_('INVALID', 'Type is required (for example ESP32).');
    var name = U.str(p.name, 80);
    if (!name) fail_('INVALID', 'Name is required.');
    var condition = U.str(p.condition).toUpperCase() || 'GOOD';
    if (STATUS.CONDITIONS.indexOf(condition) === -1) fail_('INVALID', 'Unknown condition.');
    var lab = Settings.lab(p.lab_id);
    var mx = p.map_x === '' || p.map_x == null ? '' : Math.round(U.num(p.map_x, NaN));
    var my = p.map_y === '' || p.map_y == null ? '' : Math.round(U.num(p.map_y, NaN));
    if (mx !== '' && !(mx >= 0 && mx < lab.map_cols)) fail_('INVALID', 'Map column must be 0–' + (lab.map_cols - 1) + '.');
    if (my !== '' && !(my >= 0 && my < lab.map_rows)) fail_('INVALID', 'Map row must be 0–' + (lab.map_rows - 1) + '.');

    return U.plain(withLock_(function () {
      var now = U.now();
      var fields = {
        lab_id: lab.lab_id, name: name, category: category, type: type, condition: condition,
        location: U.str(p.location, 40), map_x: mx, map_y: my, notes: U.str(p.notes, 300), updated_at: now
      };
      var existing = p.asset_id ? Db.byId('Assets', U.str(p.asset_id)) : null;
      if (existing) {
        // Status changes by hand are overrides (FR-04); the lifecycle normally sets status.
        var status = U.str(p.status).toUpperCase() || existing.status;
        if (status !== existing.status) {
          if ([STATUS.ASSET.AVAILABLE, STATUS.ASSET.MAINTENANCE].indexOf(status) === -1) {
            fail_('INVALID', 'Status can only be set by hand to AVAILABLE or MAINTENANCE.');
          }
          if (existing.status === STATUS.ASSET.ISSUED || existing.status === STATUS.ASSET.RESERVED) {
            fail_('INVALID', 'This item is ' + existing.status.toLowerCase() + '. Return it or close the request first.');
          }
          fields.status = status;
          Audit.log(ctx, 'INVENTORY_OVERRIDE', existing.asset_id, status, existing.status + ' -> ' + status + '. ' + U.str(p.reason, 200), lab.lab_id);
        }
        Db.update('Assets', existing, fields);
        Audit.log(ctx, 'INVENTORY_EDIT', existing.asset_id, 'UPDATED', '', lab.lab_id);
        return existing;
      }
      var id = U.str(p.asset_id).toUpperCase();
      if (id && !/^[A-Z0-9_-]{3,24}$/.test(id)) fail_('INVALID', 'Asset ID must be 3–24 letters, digits, - or _.');
      fields.asset_id = id || U.id('A');
      fields.status = STATUS.ASSET.AVAILABLE;
      var created = Db.insert('Assets', fields);
      Audit.log(ctx, 'INVENTORY_ADD', created.asset_id, 'CREATED', name, lab.lab_id);
      return created;
    }));
  },

  /** Soft delete: the row stays so past loans and reports still resolve. */
  remove: function (ctx, p) {
    var reason = U.str(p && p.reason, 200);
    if (reason.length < 3) fail_('INVALID', 'Give a reason for removing the item.');
    return U.plain(withLock_(function () {
      var a = Db.byId('Assets', U.str(p.assetId));
      if (!a || a.status === STATUS.ASSET.RETIRED) fail_('NOT_FOUND', 'Item not found.');
      if (a.status === STATUS.ASSET.ISSUED || a.status === STATUS.ASSET.RESERVED) {
        fail_('INVALID', 'This item is ' + a.status.toLowerCase() + '. Return it or close the request first.');
      }
      Db.update('Assets', a, { status: STATUS.ASSET.RETIRED, updated_at: U.now() });
      Audit.log(ctx, 'INVENTORY_REMOVE', a.asset_id, 'RETIRED', reason, a.lab_id);
      return { asset_id: a.asset_id };
    }));
  },

  /* ---------- views ---------- */

  publicRequest: function (r, asset) {
    asset = asset || Db.byId('Assets', r.asset_id) || {};
    return {
      request_id: r.request_id, asset_id: r.asset_id, asset_name: asset.name || r.asset_id, asset_type: asset.type || '',
      lab_id: r.lab_id, window_start_at: r.window_start_at, window_end_at: r.window_end_at, note: r.note,
      status: r.status, decided_at: r.decided_at, decision_note: r.decision_note, created_at: r.created_at
    };
  },

  publicLoan: function (l) {
    var asset = Db.byId('Assets', l.asset_id) || {};
    var now = U.now();
    return {
      loan_id: l.loan_id, asset_id: l.asset_id, asset_name: asset.name || l.asset_id, asset_type: asset.type || '',
      lab_id: l.lab_id, issued_at: l.issued_at, due_at: l.due_at, returned_at: l.returned_at || null,
      return_condition: l.return_condition, status: l.status,
      overdue: l.status !== STATUS.LOAN.RETURNED && l.due_at && l.due_at < now
    };
  },

  /** FR-25: the student's own borrowing history. */
  mine: function (email) {
    var loans = Db.find('Loans', function (l) { return l.borrower_email === email; })
      .sort(function (a, b) { return b.issued_at - a.issued_at; })
      .map(Assets.publicLoan);
    var requests = Db.find('Requests', function (r) { return r.requester_email === email; })
      .sort(function (a, b) { return b.created_at - a.created_at; })
      .slice(0, 30)
      .map(function (r) { return Assets.publicRequest(r); });
    return { loans: loans, requests: requests };
  },

  /** Staff handshake panel: pending requests and open loans, with borrower identity. */
  handshake: function (labId) {
    var users = Attendance.userIndex();
    function who(email) {
      var u = users[email] || {};
      return { name: u.name || email, reg_no: u.reg_no || '', email: email, mobile: Crypto.reveal(u.mobile) };
    }
    var pending = Db.find('Requests', function (r) {
      return r.lab_id === labId && r.status === STATUS.REQUEST.PENDING;
    }).map(function (r) {
      var o = Assets.publicRequest(r);
      o.requester = who(r.requester_email);
      o.still_checked_in = Assets.isCheckedIn(r.requester_email, labId);
      return o;
    });
    var loans = Db.find('Loans', function (l) {
      return l.lab_id === labId && l.status !== STATUS.LOAN.RETURNED;
    }).map(function (l) {
      var o = Assets.publicLoan(l);
      o.borrower = who(l.borrower_email);
      return o;
    }).sort(function (a, b) { return a.due_at - b.due_at; });
    return { pending: pending, loans: loans };
  },

  /* ---------- background job (FR-23) ---------- */

  /** Marks late loans OVERDUE, emails reminders, and expires stale requests. */
  overdueCheck: function () {
    var g = Settings.global();
    var reminders = [];
    var result = withLock_(function () {
      var now = U.now();
      var marked = 0;
      Db.all('Loans').forEach(function (l) {
        if (l.status === STATUS.LOAN.RETURNED || !l.due_at || l.due_at > now) return;
        if (l.status !== STATUS.LOAN.OVERDUE) {
          Db.update('Loans', l, { status: STATUS.LOAN.OVERDUE });
          Audit.log(null, 'LOAN_OVERDUE', l.loan_id, 'OVERDUE', 'Due ' + U.fmt(l.due_at), l.lab_id);
          marked++;
        }
        var last = l.last_reminder_at;
        if (!last || now - last >= g.reminder_every_hours * 3600000) {
          Db.update('Loans', l, { last_reminder_at: now });
          reminders.push(Assets.publicLoan(l));
          reminders[reminders.length - 1].borrower_email = l.borrower_email;
        }
      });
      var expired = 0;
      Db.all('Requests').forEach(function (r) {
        if (r.status !== STATUS.REQUEST.PENDING) return;
        var stale = now - r.created_at >= g.request_expiry_hours * 3600000;
        if (stale || !Assets.isCheckedIn(r.requester_email, r.lab_id) && now - r.created_at >= 3600000) {
          Assets.closeRequest(r, STATUS.REQUEST.EXPIRED, null, stale ? 'Not collected in time' : 'Requester left the lab');
          expired++;
        }
      });
      return { marked: marked, expired: expired };
    });
    result.reminded = Assets.sendReminders(reminders);
    return result;
  },

  sendReminders: function (loans) {
    var sent = 0;
    loans.forEach(function (l) {
      var lab;
      try { lab = Settings.lab(l.lab_id); } catch (e) { lab = { name: l.lab_id, incharge_email: '' }; }
      var subject = '[LabPulse] Overdue: ' + l.asset_name + ' (' + l.asset_id + ')';
      var body = 'Hello,\n\nThe item "' + l.asset_name + '" (' + l.asset_id + ') borrowed from ' + lab.name +
        ' was due on ' + U.fmt(l.due_at) + ' IST and has not been returned.\n\n' +
        'Please return it to the lab staff as soon as possible.\n\n— LabPulse (automated reminder)';
      try {
        GmailApp.sendEmail(l.borrower_email, subject, body, lab.incharge_email ? { cc: lab.incharge_email } : {});
        sent++;
      } catch (e) {
        console.error('Reminder failed for ' + l.loan_id + ': ' + e.message);
      }
    });
    return sent;
  }
};
