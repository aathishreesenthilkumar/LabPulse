/**
 * Live presence during a visit (GPS live mode).
 *
 * After a QR check-in the student's LabPulse page stays open and sends a location ping
 * every minute. Each ping is turned into inside / outside at once; coordinates are never
 * stored. The running state lives in CacheService (fast, no sheet write per ping); only
 * changes are written: left the lab, came back, and "left during session" check-outs.
 *
 * States shown on Live:
 *   IN        last good reading was inside the lab boundary
 *   OUT       two good readings in a row outside the boundary
 *   NOT_SEEN  no ping for `presence_not_seen_min` (page closed or phone locked)
 * OUT or NOT_SEEN for `presence_away_close_min` ends the visit at the last time the
 * person was confirmed inside, labelled "Left during session".
 */
var Presence = {
  TTL_SEC: 21600, // cache maximum (6 h); a fresh ping renews it

  key: function (visitId) {
    return 'presence:' + visitId;
  },

  enabled: function () {
    return Settings.global().presence_enabled !== false;
  },

  /** Manual (supervised) entries exist for people who cannot share location, so they are never watched. */
  watched: function (v) {
    return !!v && v.confidence !== STATUS.CONF.MANUAL && Presence.enabled();
  },

  /** Starts the record at check-in: the check-in itself proved the person was inside. */
  start: function (visit) {
    var t = new Date(visit.check_in_at).getTime();
    Cache.putJson(Presence.key(visit.visit_id), { state: 'IN', last_seen: t, last_inside: t, out_count: 0, out_since: 0 }, Presence.TTL_SEC);
  },

  read: function (visit) {
    var rec = Cache.getJson(Presence.key(visit.visit_id));
    if (rec) return rec;
    // Cache lost (or a visit from before this feature): count from check-in.
    var t = new Date(visit.check_in_at).getTime();
    return { state: 'IN', last_seen: t, last_inside: t, out_count: 0, out_since: 0 };
  },

  /** The state as Live shows it, including NOT_SEEN, which no ping can report. */
  view: function (visit, nowMs) {
    if (!Presence.watched(visit)) return { state: 'NOT_WATCHED' };
    var g = Settings.global();
    var r = Presence.read(visit);
    var silent = nowMs - r.last_seen >= g.presence_not_seen_min * 60000;
    return {
      state: silent ? 'NOT_SEEN' : r.state,
      last_seen: r.last_seen,
      last_inside: r.last_inside,
      out_since: r.state === 'OUT' ? r.out_since : 0
    };
  },

  /**
   * One ping from the student's phone. Returns the state so the page can show it.
   * @param p {lat, lng, accuracy, posAgeMs, mock}
   */
  ping: function (ctx, p) {
    p = p || {};
    var a = Db.findOne('ActiveVisits', function (x) {
      return x.email === ctx.email;
    });
    if (!a) return { active: false };
    var v = Db.byId('Visits', a.visit_id);
    if (!Presence.watched(v)) return { active: true, watched: false };
    var lab = Settings.lab(a.lab_id);
    var now = U.now().getTime();
    var acc = Number(p.accuracy);
    var ev = Geo.evaluate(lab, { lat: p.lat, lng: p.lng, accuracy: p.accuracy, mock: p.mock === true, posAgeMs: p.posAgeMs }, null, null, now);
    p = null; // coordinates end here and are never stored (FR-08)

    var rec = Presence.read(v);
    rec.last_seen = now;
    var reading;
    if (!isFinite(ev.distance)) reading = 'BAD';
    else if (ev.reasons.some(function (r) { return /Mock location/.test(r); })) reading = 'OUTSIDE';
    else {
      var accOk = isFinite(acc) && acc > 0 && acc <= lab.accuracy_limit_m;
      // Same tolerance as check-in: within the radius plus the GPS uncertainty margin counts as inside.
      var slack = Math.min(isFinite(acc) ? acc : 0, lab.amber_margin_m);
      if (ev.distance <= lab.radius_m + slack) reading = 'INSIDE';
      else reading = accOk ? 'OUTSIDE' : 'WEAK'; // a fuzzy fix never marks someone out
    }

    var change = '';
    if (reading === 'INSIDE') {
      if (rec.state === 'OUT') change = 'BACK';
      rec.state = 'IN';
      rec.last_inside = now;
      rec.out_count = 0;
      rec.out_since = 0;
    } else if (reading === 'OUTSIDE') {
      rec.out_count = (rec.out_count || 0) + 1;
      if (rec.out_count === 1) rec.out_since = now;
      if (rec.out_count >= 2 && rec.state !== 'OUT') {
        rec.state = 'OUT';
        change = 'OUT';
      }
    }
    Cache.putJson(Presence.key(v.visit_id), rec, Presence.TTL_SEC);

    if (change === 'OUT') Audit.log(ctx, 'PRESENCE_OUT', v.visit_id, 'OUT', 'Left the lab area during the visit', v.lab_id);
    if (change === 'BACK') Audit.log(ctx, 'PRESENCE_BACK', v.visit_id, 'IN', 'Back inside the lab', v.lab_id);

    return {
      active: true, watched: true, state: rec.state, reading: reading,
      last_inside: rec.last_inside, out_since: rec.state === 'OUT' ? rec.out_since : 0,
      next_ping_sec: Settings.global().presence_ping_sec
    };
  },

  /**
   * Per-minute job: ends visits whose owner has been out, or unseen, for too long.
   * The visit counts only up to the last time the person was confirmed inside.
   */
  sweep: function () {
    if (!Presence.enabled()) return { left: 0 };
    var g = Settings.global();
    var limit = g.presence_away_close_min * 60000;
    var now = U.now().getTime();
    var left = 0;
    withLock_(function () {
      Db.all('ActiveVisits').forEach(function (a) {
        var v = Db.byId('Visits', a.visit_id);
        if (!Presence.watched(v) || v.status !== STATUS.VISIT.ACTIVE) return;
        var s = Presence.view(v, now);
        var awaySince = s.state === 'OUT' ? s.out_since : s.state === 'NOT_SEEN' ? s.last_seen : 0;
        if (!awaySince || now - awaySince < limit) return;
        var end = new Date(Math.max(new Date(v.check_in_at).getTime(), s.last_inside || 0));
        var why = s.state === 'OUT' ? 'Out of the lab boundary' : 'LabPulse not open (no location)';
        why += ' for ' + U.durationText(now - awaySince) + '; counted until last seen inside at ' + U.fmt(end);
        Attendance.closeVisit(v.visit_id, end, STATUS.CLOSE.LEFT, null, why);
        Audit.log(null, 'LEFT_DURING_SESSION', v.visit_id, s.state, why, v.lab_id);
        Cache.remove(Presence.key(v.visit_id));
        left++;
      });
    });
    return { left: left };
  },

  /** Counts for the Live strip. */
  counts: function (labId) {
    var now = U.now().getTime();
    var out = { in: 0, out: 0, not_seen: 0, not_watched: 0 };
    Db.find('ActiveVisits', function (a) { return a.lab_id === labId; }).forEach(function (a) {
      var s = Presence.view(Db.byId('Visits', a.visit_id), now).state;
      if (s === 'IN') out.in++;
      else if (s === 'OUT') out.out++;
      else if (s === 'NOT_SEEN') out.not_seen++;
      else out.not_watched++;
    });
    return out;
  }
};
