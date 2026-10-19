/**
 * Usage lookups, daily rollups and archiving.
 *
 * Lookups answer the supervisor's questions:
 *   - given a register number: how many days and hours a student has spent in the lab, on what
 *   - given a system: how many people have used it, for how long and for what purpose
 *
 * To keep the main spreadsheet small, a nightly job writes one summary row per person per day
 * (UsageDaily) and per asset per day (AssetUsageDaily). A monthly job then moves raw rows older
 * than a few months into a yearly archive spreadsheet. Lookups combine the summaries (for days
 * already rolled up) with live rows (for days after that), so totals stay complete.
 */
var Usage = {
  ROLLUP_KEY: 'ROLLUP_UNTIL',

  rolledUntil: function () {
    return Settings.props().getProperty(Usage.ROLLUP_KEY) || '';
  },

  minutes: function (a, b) {
    return Math.max(0, Math.round((b - a) / 60000));
  },

  /**
   * Every use of an asset in [from, to): a check-in at a system, a booked session, or a loan.
   * Each use: {date, lab_id, asset_id, email, minutes, purpose, kind}.
   */
  assetUses: function (from, to) {
    var now = U.now();
    var projects = {};
    Db.all('Projects').forEach(function (p) { projects[p.project_id] = p.title; });
    var requests = {};
    Db.all('Requests').forEach(function (r) { requests[r.request_id] = r; });
    var inRange = function (d) { return d && d >= from && d < to; };
    var out = [];
    Db.all('Visits').forEach(function (v) {
      if (!v.system_id || v.system_id === OWN_DEVICE || !inRange(v.check_in_at) || !Reports.isVerified(v)) return;
      out.push({
        date: U.dateKey(v.check_in_at), lab_id: v.lab_id, asset_id: v.system_id, email: v.email,
        minutes: Usage.minutes(v.check_in_at, v.check_out_at || now),
        purpose: projects[v.project_id] || v.purpose || Attendance.publicVisit(v).label, kind: 'Worked at it'
      });
    });
    Db.all('Bookings').forEach(function (b) {
      if (!b.started_at || !inRange(b.started_at)) return;
      out.push({
        date: U.dateKey(b.started_at), lab_id: b.lab_id, asset_id: b.asset_id, email: b.user_email,
        minutes: Usage.minutes(b.started_at, b.finished_at || now), purpose: b.purpose, kind: 'Reserved session'
      });
    });
    Db.all('Loans').forEach(function (l) {
      if (!inRange(l.issued_at)) return;
      var r = requests[l.request_id];
      out.push({
        date: U.dateKey(l.issued_at), lab_id: l.lab_id, asset_id: l.asset_id, email: l.borrower_email,
        minutes: Usage.minutes(l.issued_at, l.returned_at || now), purpose: (r && r.note) || 'Borrowed', kind: 'Borrowed'
      });
    });
    return out;
  },

  /** Verified visits in [from, to), grouped per day per person. */
  visitDays: function (from, to, email) {
    var now = U.now();
    var groups = {};
    Db.all('Visits').forEach(function (v) {
      if (!v.check_in_at || v.check_in_at < from || v.check_in_at >= to || !Reports.isVerified(v)) return;
      if (email && v.email !== email) return;
      var key = U.dateKey(v.check_in_at) + '|' + v.lab_id + '|' + v.email;
      var g = groups[key] || (groups[key] = {
        date: U.dateKey(v.check_in_at), lab_id: v.lab_id, email: v.email, visits: 0, minutes: 0,
        first_in_at: v.check_in_at, last_out_at: null, projects: {}, systems: {}
      });
      var end = v.check_out_at || now;
      g.visits++;
      g.minutes += Usage.minutes(v.check_in_at, end);
      if (v.check_in_at < g.first_in_at) g.first_in_at = v.check_in_at;
      if (!g.last_out_at || end > g.last_out_at) g.last_out_at = end;
      if (v.project_id) g.projects[v.project_id] = true;
      if (v.system_id) g.systems[v.system_id] = true;
    });
    return Object.keys(groups).map(function (k) {
      var g = groups[k];
      g.projects = Object.keys(g.projects).join(',');
      g.systems = Object.keys(g.systems).join(',');
      return g;
    });
  },

  /** Rebuild the summary rows for [fromKey, toKey] (idempotent). Caller holds the lock. */
  rollup: function (fromKey, toKey) {
    var from = U.istDate(fromKey, 0);
    var to = U.istDate(U.addDays(toKey, 1), 0);
    var inside = function (r) { return r.date >= fromKey && r.date <= toKey; };

    var people = Usage.visitDays(from, to);
    Db.replaceAll('UsageDaily', Db.all('UsageDaily').filter(function (r) { return !inside(r); }).map(Usage.row('UsageDaily')).concat(people));

    var byAsset = {};
    Usage.assetUses(from, to).forEach(function (u) {
      var key = u.date + '|' + u.asset_id;
      var g = byAsset[key] || (byAsset[key] = { date: u.date, lab_id: u.lab_id, asset_id: u.asset_id, uses: 0, minutes: 0, users: {}, purposes: {} });
      g.uses++;
      g.minutes += u.minutes;
      g.users[u.email] = true;
      if (u.purpose) g.purposes[U.str(u.purpose, 80)] = true;
    });
    var assets = Object.keys(byAsset).map(function (k) {
      var g = byAsset[k];
      g.users = Object.keys(g.users).join(',');
      g.purposes = Object.keys(g.purposes).join(' | ').slice(0, 1000);
      return g;
    });
    Db.replaceAll('AssetUsageDaily', Db.all('AssetUsageDaily').filter(function (r) { return !inside(r); }).map(Usage.row('AssetUsageDaily')).concat(assets));

    if (toKey > Usage.rolledUntil()) Settings.props().setProperty(Usage.ROLLUP_KEY, toKey);
    return { from: fromKey, to: toKey, people_days: people.length, asset_days: assets.length };
  },

  row: function (table) {
    return function (r) {
      var o = {};
      SHEETS[table].forEach(function (k) { o[k] = r[k]; });
      return o;
    };
  },

  /** Nightly: roll up the last few days up to yesterday (re-rolling covers late check-outs). */
  nightly: function () {
    return withLock_(function () {
      var yesterday = U.addDays(U.dateKey(U.now()), -1);
      return Usage.rollup(U.addDays(yesterday, -6), yesterday);
    });
  },

  /* ---------- lookups ---------- */

  findUser: function (q) {
    q = U.str(q);
    if (!q) fail_('INVALID', 'Enter a register number or email.');
    var key = q.toUpperCase();
    var email = q.toLowerCase();
    var u = Db.findOne('Users', function (x) { return x.reg_no === key || x.email === email; });
    if (!u) fail_('NOT_FOUND', 'No one with register number or email "' + q + '".');
    return u;
  },

  /**
   * Days in lab, total hours and what they worked on, for one person. Summaries cover the
   * days already rolled up (including archived ones); live rows cover the rest.
   */
  student: function (q, opts) {
    var u = typeof q === 'object' ? q : Usage.findUser(q);
    var until = Usage.rolledUntil();
    var days = Db.find('UsageDaily', function (r) { return r.email === u.email && (!until || r.date <= until); })
      .map(function (r) {
        return { date: r.date, lab_id: r.lab_id, visits: Number(r.visits), minutes: Number(r.minutes), projects: r.projects, systems: r.systems };
      });
    var liveFrom = until ? U.istDate(U.addDays(until, 1), 0) : new Date(0);
    days = days.concat(Usage.visitDays(liveFrom, new Date(8.64e15), u.email));
    var byDate = {};
    days.forEach(function (d) {
      var g = byDate[d.date] || (byDate[d.date] = { date: d.date, visits: 0, minutes: 0, projects: {}, systems: {} });
      g.visits += d.visits;
      g.minutes += d.minutes;
      String(d.projects || '').split(',').filter(Boolean).forEach(function (p) { g.projects[p] = true; });
      String(d.systems || '').split(',').filter(Boolean).forEach(function (s) { g.systems[s] = true; });
    });
    var projects = {};
    Db.all('Projects').forEach(function (p) { projects[p.project_id] = p; });
    var assets = {};
    Db.all('Assets').forEach(function (a) { assets[a.asset_id] = a; });
    var list = Object.keys(byDate).sort().reverse().map(function (k) {
      var g = byDate[k];
      return {
        date: g.date, visits: g.visits, hours: U.round(g.minutes / 60, 2),
        projects: Object.keys(g.projects).map(function (id) { return projects[id] ? projects[id].title : id; }),
        systems: Object.keys(g.systems).map(function (id) { return Monitoring.systemLabel(id, assets); })
      };
    });
    var totalMin = list.reduce(function (s, d) { return s + d.hours * 60; }, 0);
    var weekStart = U.addDays(U.dateKey(U.now()), -6);
    var out = {
      user: { name: u.name, reg_no: u.reg_no, email: u.email, role: u.role, active: U.truthy(u.active) },
      total_days: list.length,
      total_hours: U.round(totalMin / 60, 1),
      total_visits: list.reduce(function (s, d) { return s + d.visits; }, 0),
      week_hours: U.round(list.filter(function (d) { return d.date >= weekStart; }).reduce(function (s, d) { return s + d.hours; }, 0), 1),
      last_visit: list.length ? list[0].date : null,
      days: list.slice(0, opts && opts.self ? 30 : 180),
      projects: Projects.mine(u.email)
    };
    return U.plain(out);
  },

  /** How many people used a system, for how long, and for what. */
  asset: function (assetId) {
    var a = Db.byId('Assets', U.str(assetId));
    if (!a) fail_('NOT_FOUND', 'Item not found.');
    var until = Usage.rolledUntil();
    var users = Attendance.userIndex();
    var people = {};
    var minutes = 0;
    var count = 0;
    var history = [];
    Db.find('AssetUsageDaily', function (r) { return r.asset_id === a.asset_id && (!until || r.date <= until); }).forEach(function (r) {
      var emails = String(r.users || '').split(',').filter(Boolean);
      emails.forEach(function (e) { people[e] = true; });
      minutes += Number(r.minutes);
      count += Number(r.uses);
      history.push({
        date: r.date, who: emails.map(function (e) { return (users[e] && users[e].name) || e; }).join(', '),
        reg_no: emails.map(function (e) { return (users[e] && users[e].reg_no) || ''; }).join(', '),
        hours: U.round(Number(r.minutes) / 60, 2), purpose: r.purpose || r.purposes, kind: Number(r.uses) + ' use(s), summarised'
      });
    });
    var liveFrom = until ? U.istDate(U.addDays(until, 1), 0) : new Date(0);
    Usage.assetUses(liveFrom, new Date(8.64e15)).filter(function (x) { return x.asset_id === a.asset_id; }).forEach(function (x) {
      people[x.email] = true;
      minutes += x.minutes;
      count++;
      var u = users[x.email] || {};
      history.push({ date: x.date, who: u.name || x.email, reg_no: u.reg_no || '', hours: U.round(x.minutes / 60, 2), purpose: x.purpose, kind: x.kind });
    });
    history.sort(function (p, q) { return p.date < q.date ? 1 : p.date > q.date ? -1 : 0; });
    var byPerson = {};
    Object.keys(people).forEach(function (e) { byPerson[e] = (users[e] && users[e].name) || e; });
    return U.plain({
      asset: { asset_id: a.asset_id, name: a.name, category: a.category, type: a.type, status: a.status, lab_id: a.lab_id },
      distinct_users: Object.keys(people).length,
      total_uses: count,
      total_hours: U.round(minutes / 60, 1),
      people: Object.keys(byPerson).map(function (e) { return byPerson[e]; }).sort(),
      uses: history.slice(0, 300)
    });
  },

  /* ---------- archiving ---------- */

  ARCHIVE_RULES: {
    Visits: function (r, cut) { return r.status !== STATUS.VISIT.ACTIVE && r.check_in_at && r.check_in_at < cut; },
    Loans: function (r, cut) { return r.status === STATUS.LOAN.RETURNED && r.returned_at && r.returned_at < cut; },
    Bookings: function (r, cut) { return !Bookings.isOpen(r) && r.end_at && r.end_at < cut; },
    Requests: function (r, cut) { return r.status !== STATUS.REQUEST.PENDING && r.created_at && r.created_at < cut; },
    AttendanceMarks: function (r, cut) { return r.marked_at && r.marked_at < cut; },
    AuditLog: function (r, cut) { return r.timestamp && r.timestamp < cut; }
  },

  /** Before visits leave the live sheet, add their minutes to each project's running total. */
  carryProjectMinutes: function (visits) {
    var add = {};
    visits.forEach(function (v) {
      if (v.project_id && v.status !== STATUS.VISIT.VOIDED && v.check_in_at && v.check_out_at) {
        add[v.project_id] = (add[v.project_id] || 0) + Usage.minutes(v.check_in_at, v.check_out_at);
      }
    });
    Object.keys(add).forEach(function (id) {
      var p = Db.byId('Projects', id);
      if (p) Db.update('Projects', p, { archived_minutes: U.num(p.archived_minutes, 0) + add[id] });
    });
  },

  /** The yearly archive spreadsheet, created on first use. */
  archiveBook: function (year) {
    var props = Settings.props();
    var key = 'ARCHIVE_' + year + '_ID';
    var id = props.getProperty(key);
    var ss = null;
    if (id) {
      try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
    }
    if (!ss) {
      ss = SpreadsheetApp.create('LabPulse Archive ' + year);
      props.setProperty(key, ss.getId());
    }
    return ss;
  },

  /**
   * Monthly: summarise, then move closed rows older than `archive_after_months` into the
   * yearly archive spreadsheet, so the live spreadsheet stays fast. Nothing is deleted.
   */
  archive: function () {
    var months = Settings.global().archive_after_months;
    var now = U.ist(U.now());
    var y = now.y;
    var m = now.mo - months;
    while (m < 1) { m += 12; y--; }
    var cutKey = y + '-' + U.pad(m) + '-01';
    var cut = U.istDate(cutKey, 0);
    return withLock_(function () {
      // Make sure every day being archived is summarised first.
      var oldest = null;
      Db.all('Visits').forEach(function (v) { if (Usage.ARCHIVE_RULES.Visits(v, cut) && (!oldest || v.check_in_at < oldest)) oldest = v.check_in_at; });
      if (oldest) Usage.rollup(U.dateKey(oldest), U.addDays(cutKey, -1));

      var moved = {};
      var book = null;
      Object.keys(Usage.ARCHIVE_RULES).forEach(function (table) {
        var rule = Usage.ARCHIVE_RULES[table];
        var rows = Db.all(table);
        var old = rows.filter(function (r) { return rule(r, cut); });
        if (!old.length) return;
        book = book || Usage.archiveBook(y);
        var sh = book.getSheetByName(table);
        if (!sh) {
          sh = book.insertSheet(table);
          sh.appendRow(SHEETS[table]);
        }
        var values = old.map(function (r) {
          return SHEETS[table].map(function (k) {
            var v = r[k];
            return v === null || v === undefined ? '' : v;
          });
        });
        sh.getRange(sh.getLastRow() + 1, 1, values.length, SHEETS[table].length).setValues(values);
        if (table === 'Visits') Usage.carryProjectMinutes(old);
        var keep = rows.filter(function (r) { return !rule(r, cut); }).map(Usage.row(table));
        Db.replaceAll(table, keep);
        moved[table] = old.length;
      });
      Audit.log(null, 'ARCHIVE', cutKey, 'OK', JSON.stringify(moved), '');
      return { before: cutKey, moved: moved, archive: book ? book.getUrl() : null };
    });
  }
};
