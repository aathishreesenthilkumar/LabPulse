/**
 * Time-slot reservations with a waitlist queue (3D printers, drones, GPU nodes, lab PCs...).
 *
 * A student reserves a future slot at any time. If the slot overlaps a confirmed booking,
 * they join the queue for it. Using the slot still follows the proposal's rule: staff start it
 * only when the student is CHECKED_IN to the lab. Cancellations and no-shows promote the next
 * person in the queue, who is emailed.
 *
 * Lifecycle: BOOKED | WAITLIST  ->  IN_USE  ->  DONE
 *            BOOKED | WAITLIST  ->  CANCELLED | NO_SHOW | EXPIRED
 */
var Bookings = {
  S: { BOOKED: 'BOOKED', WAITLIST: 'WAITLIST', IN_USE: 'IN_USE', DONE: 'DONE', CANCELLED: 'CANCELLED', NO_SHOW: 'NO_SHOW', EXPIRED: 'EXPIRED' },

  /** Confirmed bookings that hold the slot (a waitlisted one does not). */
  holds: function (b) {
    return b.status === Bookings.S.BOOKED || b.status === Bookings.S.IN_USE;
  },

  isOpen: function (b) {
    return b.status === Bookings.S.BOOKED || b.status === Bookings.S.WAITLIST || b.status === Bookings.S.IN_USE;
  },

  overlaps: function (b, start, end) {
    return b.start_at.getTime() < end.getTime() && b.end_at.getTime() > start.getTime();
  },

  /** Position in the queue for a waitlisted booking (1 = next). */
  position: function (b, all) {
    if (b.status !== Bookings.S.WAITLIST) return 0;
    return all.filter(function (x) {
      return x.asset_id === b.asset_id && x.status === Bookings.S.WAITLIST && x.created_at <= b.created_at &&
        Bookings.overlaps(x, b.start_at, b.end_at);
    }).length;
  },

  view: function (b, all, users, assets) {
    var a = assets ? assets[b.asset_id] || {} : Db.byId('Assets', b.asset_id) || {};
    var u = users ? users[b.user_email] || {} : null;
    var o = {
      booking_id: b.booking_id, lab_id: b.lab_id, asset_id: b.asset_id, asset_name: a.name || b.asset_id, asset_type: a.type || '',
      project_id: b.project_id, start_at: b.start_at, end_at: b.end_at, purpose: b.purpose, status: b.status,
      position: Bookings.position(b, all), started_at: b.started_at, finished_at: b.finished_at
    };
    if (u) {
      o.user_email = b.user_email;
      o.user_name = u.name || b.user_email;
      o.reg_no = u.reg_no || '';
    }
    return o;
  },

  validate: function (ctx, p) {
    var g = Settings.global();
    var asset = Db.byId('Assets', U.str(p.assetId));
    if (!asset || asset.status === STATUS.ASSET.RETIRED) fail_('NOT_FOUND', 'That item does not exist.');
    if (asset.status === STATUS.ASSET.MAINTENANCE) fail_('UNAVAILABLE', asset.name + ' is under maintenance.');
    var lab = Settings.lab(asset.lab_id);
    var start = U.toDate(p.start);
    var end = U.toDate(p.end);
    if (!start || !end) fail_('INVALID', 'Choose a start and end time.');
    var now = U.now();
    if (start.getTime() < now.getTime() - 5 * 60000) fail_('INVALID', 'The slot must start in the future.');
    if (end.getTime() <= start.getTime()) fail_('INVALID', 'The end time must be after the start time.');
    if (end - start > g.max_booking_hours * 3600000) fail_('INVALID', 'A booking can be at most ' + g.max_booking_hours + ' hours.');
    if (start - now > g.booking_advance_days * 86400000) fail_('INVALID', 'You can book at most ' + g.booking_advance_days + ' days ahead.');
    var day = U.dateKey(start);
    var w = Settings.openMinutesOn(lab, day);
    if (!w || U.dateKey(end) !== day || U.minutesOfDay(start) < w.open || U.minutesOfDay(end) > w.close) {
      fail_('INVALID', 'The slot must fit inside the lab’s opening hours (' + lab.open_time + '–' + lab.close_time + ', ' + lab.open_days + ').');
    }
    var purpose = U.str(p.purpose, 300);
    if (purpose.length < 5) fail_('INVALID', 'Say what you will use it for (at least 5 characters).');
    var pid = U.str(p.projectId);
    if (pid) {
      var proj = Db.byId('Projects', pid);
      if (!proj || !Projects.isMember(proj, ctx.email)) fail_('INVALID', 'Choose one of your own projects.');
    }
    return { asset: asset, lab: lab, start: start, end: end, purpose: purpose, project_id: pid };
  },

  /** Reserve a slot. Returns the booking with status BOOKED or WAITLIST (and queue position). */
  book: function (ctx, p) {
    p = p || {};
    var v = Bookings.validate(ctx, p);
    var g = Settings.global();
    // Proposal C (reservation gating): requests need an active, verified CHECKED_IN status.
    // A Super Admin may switch this off to allow reserving future slots in advance.
    if (g.booking_requires_checkin && !Assets.isVerifiedIn(ctx.email, v.lab.lab_id)) {
      Audit.log(ctx, 'BOOK', v.asset.asset_id, 'REJECTED', 'Not checked in', v.lab.lab_id);
      fail_('NOT_CHECKED_IN', 'You can reserve equipment only while checked in to ' + v.lab.name + ' (and verified).');
    }
    return U.plain(withLock_(function () {
      var all = Db.all('Bookings');
      var mineOpen = all.filter(function (b) { return b.user_email === ctx.email && Bookings.isOpen(b); });
      if (mineOpen.length >= g.max_open_bookings) fail_('LIMIT', 'You already have ' + mineOpen.length + ' open bookings. Cancel one first.');
      if (mineOpen.some(function (b) { return b.asset_id === v.asset.asset_id && Bookings.overlaps(b, v.start, v.end); })) {
        fail_('ALREADY', 'You already have a booking for ' + v.asset.name + ' at that time.');
      }
      var taken = all.some(function (b) {
        return b.asset_id === v.asset.asset_id && Bookings.holds(b) && Bookings.overlaps(b, v.start, v.end);
      }) || Db.find('Loans', function (l) {
        return l.asset_id === v.asset.asset_id && l.status !== STATUS.LOAN.RETURNED && l.due_at && l.due_at > v.start;
      }).length > 0;
      var now = U.now();
      var row = Db.insert('Bookings', {
        booking_id: U.id('B'), lab_id: v.lab.lab_id, asset_id: v.asset.asset_id, user_id: ctx.user.user_id, user_email: ctx.email,
        project_id: v.project_id, start_at: v.start, end_at: v.end, purpose: v.purpose,
        status: taken ? Bookings.S.WAITLIST : Bookings.S.BOOKED, created_at: now, started_at: '', finished_at: '', handled_by: '', note: ''
      });
      Audit.log(ctx, 'BOOK', row.booking_id, row.status, v.asset.asset_id + ' ' + U.fmt(v.start) + '–' + U.pad(U.ist(v.end).h) + ':' + U.pad(U.ist(v.end).mi), v.lab.lab_id);
      return Bookings.view(row, Db.all('Bookings'));
    }));
  },

  cancel: function (ctx, p) {
    var promoted = [];
    var out = withLock_(function () {
      var b = Db.byId('Bookings', U.str(p && p.bookingId));
      if (!b) fail_('NOT_FOUND', 'Booking not found.');
      var staff = [ROLES.STAFF, ROLES.COORDINATOR, ROLES.ADMIN].indexOf(ctx.role) !== -1;
      if (b.user_email !== ctx.email && !staff) fail_('FORBIDDEN', 'You can cancel only your own bookings.');
      if (b.status !== Bookings.S.BOOKED && b.status !== Bookings.S.WAITLIST) fail_('ALREADY', 'This booking can no longer be cancelled.');
      Db.update('Bookings', b, { status: Bookings.S.CANCELLED, handled_by: ctx.email, note: U.str(p.reason, 200) });
      Audit.log(ctx, 'BOOK_CANCEL', b.booking_id, 'CANCELLED', U.str(p.reason, 200), b.lab_id);
      promoted = Bookings.promote(b.asset_id);
      return Bookings.view(b, Db.all('Bookings'));
    });
    Bookings.notify(promoted);
    return U.plain(out);
  },

  /**
   * Moves waitlisted bookings up when their slot is free again, oldest first.
   * Caller holds the lock. Returns the promoted bookings so they can be emailed.
   */
  promote: function (assetId) {
    var all = Db.all('Bookings');
    var now = U.now();
    var promoted = [];
    all.filter(function (b) { return b.asset_id === assetId && b.status === Bookings.S.WAITLIST && b.end_at > now; })
      .sort(function (a, b) { return a.created_at - b.created_at; })
      .forEach(function (w) {
        var blocked = all.some(function (b) { return b !== w && b.asset_id === assetId && Bookings.holds(b) && Bookings.overlaps(b, w.start_at, w.end_at); });
        if (blocked) return;
        Db.update('Bookings', w, { status: Bookings.S.BOOKED });
        Audit.log(null, 'BOOK_PROMOTED', w.booking_id, 'BOOKED', 'Moved up from the waitlist', w.lab_id);
        promoted.push(Bookings.view(w, all));
        promoted[promoted.length - 1].user_email = w.user_email;
      });
    return promoted;
  },

  notify: function (list) {
    list.forEach(function (b) {
      try {
        GmailApp.sendEmail(b.user_email, '[LabPulse] Your slot is confirmed: ' + b.asset_name,
          'Good news — a slot opened up.\n\n' + b.asset_name + '\n' + U.fmt(new Date(b.start_at)) + ' to ' + U.fmt(new Date(b.end_at)) + ' IST\n\n' +
          'Check in to the lab and lab staff will start your session.\n\n— LabPulse');
      } catch (e) {
        console.error('Promotion email failed for ' + b.booking_id + ': ' + e.message);
      }
    });
  },

  /** Staff start a confirmed booking: the student must be CHECKED_IN (verified) to the lab. */
  start: function (ctx, p) {
    return U.plain(withLock_(function () {
      var b = Db.byId('Bookings', U.str(p && p.bookingId));
      if (!b || b.status !== Bookings.S.BOOKED) fail_('NOT_FOUND', 'No confirmed booking with that ID.');
      var now = U.now();
      if (now < b.start_at - 15 * 60000) fail_('INVALID', 'This slot starts at ' + U.fmt(b.start_at) + '. You can start it 15 minutes early at most.');
      if (now > b.end_at) fail_('INVALID', 'This slot has already ended.');
      if (!Assets.isVerifiedIn(b.user_email, b.lab_id)) {
        fail_('NOT_CHECKED_IN', 'The student must be checked in to the lab (and verified) before the session starts.');
      }
      var asset = Db.byId('Assets', b.asset_id);
      if (!asset || asset.status !== STATUS.ASSET.AVAILABLE) fail_('UNAVAILABLE', (asset ? asset.name : b.asset_id) + ' is not free (' + (asset ? asset.status.toLowerCase() : 'missing') + ').');
      var sitting = Attendance.systemsInUse(b.lab_id)[asset.asset_id];
      if (sitting && sitting !== b.user_email) fail_('UNAVAILABLE', asset.name + ' is being used by someone checked in at it. Ask them to switch systems first.');
      Db.update('Bookings', b, { status: Bookings.S.IN_USE, started_at: now, handled_by: ctx.email });
      Db.update('Assets', asset, { status: STATUS.ASSET.ISSUED, updated_at: now });
      Audit.log(ctx, 'BOOK_START', b.booking_id, 'IN_USE', b.asset_id + ' for ' + b.user_email, b.lab_id);
      return Bookings.view(b, Db.all('Bookings'));
    }));
  },

  /** Staff close a session in use, recording the condition of the item. */
  finish: function (ctx, p) {
    p = p || {};
    var condition = U.str(p.condition).toUpperCase() || 'GOOD';
    if (STATUS.CONDITIONS.indexOf(condition) === -1) fail_('INVALID', 'Record the condition: GOOD, FAIR or DAMAGED.');
    var promoted = [];
    var out = withLock_(function () {
      var b = Db.byId('Bookings', U.str(p.bookingId));
      if (!b || b.status !== Bookings.S.IN_USE) fail_('NOT_FOUND', 'No session in use with that ID.');
      var now = U.now();
      Bookings.close(b, now, condition, ctx, U.str(p.note, 300));
      promoted = Bookings.promote(b.asset_id);
      return Bookings.view(b, Db.all('Bookings'));
    });
    Bookings.notify(promoted);
    return U.plain(out);
  },

  close: function (b, at, condition, ctx, note) {
    Db.update('Bookings', b, { status: Bookings.S.DONE, finished_at: at, note: note || '' });
    var asset = Db.byId('Assets', b.asset_id);
    if (asset && asset.status === STATUS.ASSET.ISSUED) {
      Db.update('Assets', asset, { status: condition === 'DAMAGED' ? STATUS.ASSET.MAINTENANCE : STATUS.ASSET.AVAILABLE, condition: condition, updated_at: at });
    }
    Audit.log(ctx, 'BOOK_DONE', b.booking_id, condition, note || '', b.lab_id);
  },

  /**
   * Background sweep (every 10 minutes): no-shows lose the slot to the queue, sessions left
   * running past their end are closed, and waitlist entries whose slot has passed expire.
   */
  sweep: function () {
    var g = Settings.global();
    var promoted = [];
    var out = withLock_(function () {
      var now = U.now();
      var counts = { no_show: 0, auto_done: 0, expired: 0 };
      var touched = {};
      Db.all('Bookings').forEach(function (b) {
        if (b.status === Bookings.S.BOOKED && now - b.start_at > g.no_show_minutes * 60000) {
          Db.update('Bookings', b, { status: Bookings.S.NO_SHOW });
          Audit.log(null, 'BOOK_NO_SHOW', b.booking_id, 'NO_SHOW', 'Not started within ' + g.no_show_minutes + ' min', b.lab_id);
          touched[b.asset_id] = true;
          counts.no_show++;
        } else if (b.status === Bookings.S.IN_USE && now - b.end_at > 30 * 60000) {
          Bookings.close(b, b.end_at, 'GOOD', null, 'Closed automatically after the slot ended');
          touched[b.asset_id] = true;
          counts.auto_done++;
        } else if (b.status === Bookings.S.WAITLIST && b.end_at <= now) {
          Db.update('Bookings', b, { status: Bookings.S.EXPIRED });
          counts.expired++;
        }
      });
      Object.keys(touched).forEach(function (id) { promoted = promoted.concat(Bookings.promote(id)); });
      return counts;
    });
    Bookings.notify(promoted);
    return out;
  },

  mine: function (email) {
    var all = Db.all('Bookings');
    var now = U.now();
    return all.filter(function (b) { return b.user_email === email && (Bookings.isOpen(b) || b.end_at > now - 7 * 86400000); })
      .sort(function (a, b) { return a.start_at - b.start_at; })
      .map(function (b) { return Bookings.view(b, all); });
  },

  /**
   * One asset's bookings for a day. Students see times only (and "You" for their own);
   * staff, coordinator and HOD also see who booked.
   */
  schedule: function (ctx, p) {
    var asset = Db.byId('Assets', U.str(p && p.assetId));
    if (!asset) fail_('NOT_FOUND', 'Item not found.');
    var day = U.isDateKey(p.date) ? p.date : U.dateKey(U.now());
    var from = U.istDate(day, 0);
    var to = U.istDate(U.addDays(day, 1), 0);
    var all = Db.all('Bookings');
    var full = [ROLES.STAFF, ROLES.COORDINATOR, ROLES.HOD, ROLES.ADMIN].indexOf(ctx.role) !== -1;
    var users = full ? Attendance.userIndex() : null;
    return U.plain(all.filter(function (b) {
      return b.asset_id === asset.asset_id && Bookings.isOpen(b) && Bookings.overlaps(b, from, to);
    }).sort(function (a, b) { return a.start_at - b.start_at; }).map(function (b) {
      var v = Bookings.view(b, all, users);
      v.mine = b.user_email === ctx.email;
      if (!full) delete v.purpose;
      return v;
    }));
  },

  /** Staff view: today's confirmed, in-use and queued bookings for the lab. */
  today: function (labId) {
    var now = U.now();
    var day = U.dateKey(now);
    var from = U.istDate(day, 0);
    var to = U.istDate(U.addDays(day, 1), 0);
    var all = Db.all('Bookings');
    var users = Attendance.userIndex();
    var assets = {};
    Db.all('Assets').forEach(function (a) { assets[a.asset_id] = a; });
    return U.plain(all.filter(function (b) {
      return b.lab_id === labId && Bookings.isOpen(b) && Bookings.overlaps(b, from, to);
    }).sort(function (a, b) { return a.start_at - b.start_at; }).map(function (b) {
      var v = Bookings.view(b, all, users, assets);
      v.checked_in = Assets.isVerifiedIn(b.user_email, labId);
      return v;
    }));
  },

  /** Does someone else hold a confirmed booking for this asset in [start, end)? (walk-in requests) */
  heldByOther: function (assetId, email, start, end) {
    return Db.all('Bookings').filter(function (b) {
      return b.asset_id === assetId && b.user_email !== email && Bookings.holds(b) && Bookings.overlaps(b, start, end);
    })[0] || null;
  }
};
