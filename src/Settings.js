/**
 * Per-lab settings and system constants (FR-35).
 *
 * The Config tab is the human-readable copy; PropertiesService holds the copy every
 * request reads (LABS_JSON), so the hot paths never touch a Sheet for settings.
 * Secrets (the QR signing key) live only in Script Properties.
 */
var Settings = {
  LAB_DEFAULTS: {
    radius_m: 20,
    open_time: '08:00',
    close_time: '20:00',
    open_days: 'MON,TUE,WED,THU,FRI,SAT',
    accuracy_limit_m: 30,
    amber_margin_m: 30,
    speed_flag_kmh: 25,
    speed_block_kmh: 200,
    qr_rotate_sec: 8,
    grace_min: 15,
    incharge_email: '',
    map_cols: 8,
    map_rows: 5,
    active: true
  },

  NUMERIC: [
    'lat', 'lng', 'radius_m', 'accuracy_limit_m', 'amber_margin_m', 'speed_flag_kmh',
    'speed_block_kmh', 'qr_rotate_sec', 'grace_min', 'map_cols', 'map_rows'
  ],

  GLOBAL_DEFAULTS: {
    extra_allowed_emails: [], // test accounts outside the institutional domains; empty in production
    monitor_poll_ms: 1500,
    dashboard_poll_ms: 8000,
    default_loan_hours: 4,
    max_loan_hours: 72,
    max_open_requests: 3,
    request_expiry_hours: 4,
    max_booking_hours: 4, // longest single reserved slot
    booking_advance_days: 14, // how far ahead a slot can be reserved
    no_show_minutes: 15, // a confirmed slot not started by then goes to the next in the queue
    max_open_bookings: 3,
    booking_requires_checkin: true, // proposal C: only a CHECKED_IN student may request equipment, including time slots
    presence_enabled: true, // GPS live mode: the open LabPulse page confirms the student is still inside
    presence_ping_sec: 60, // how often the phone sends inside/outside
    presence_not_seen_min: 5, // no ping this long = "Not seen" on Live
    presence_away_close_min: 15, // out or unseen this long = checked out as "Left during session"
    missing_list_email: true, // email faculty the missing students after each course session
    archive_after_months: 3, // closed rows older than this move to the yearly archive spreadsheet
    backup_keep_days: 14, // daily backups kept; older ones keep one copy per month
    reminder_every_hours: 24,
    report_recipients: [], // extra digest recipients besides each lab's in-charge
    reports_folder_id: '',
    template_doc_id: '',
    backup_folder_id: ''
  },

  props: function () {
    return PropertiesService.getScriptProperties();
  },

  normalizeLab: function (o) {
    var lab = {};
    var d = Settings.LAB_DEFAULTS;
    lab.lab_id = U.str(o.lab_id).toUpperCase();
    lab.name = U.str(o.name) || lab.lab_id;
    Settings.NUMERIC.forEach(function (k) {
      lab[k] = U.num(o[k], d[k] === undefined ? NaN : d[k]);
    });
    lab.open_time = U.str(o.open_time) || d.open_time;
    lab.close_time = U.str(o.close_time) || d.close_time;
    lab.open_days = (U.str(o.open_days) || d.open_days).toUpperCase().replace(/\s+/g, '');
    lab.incharge_email = U.str(o.incharge_email).toLowerCase();
    lab.active = o.active === undefined || o.active === '' ? true : U.truthy(o.active);
    return lab;
  },

  /** All labs; inactive ones only when asked for. */
  labs: function (includeInactive) {
    var raw = Settings.props().getProperty('LABS_JSON');
    var labs = raw ? JSON.parse(raw) : Settings.syncFromSheet();
    return includeInactive
      ? labs
      : labs.filter(function (l) {
          return l.active;
        });
  },

  syncFromSheet: function () {
    var labs = Db.all('Config').map(Settings.normalizeLab).filter(function (l) {
      return l.lab_id;
    });
    Settings.props().setProperty('LABS_JSON', JSON.stringify(labs));
    return labs;
  },

  lab: function (labId) {
    var id = U.str(labId).toUpperCase();
    var labs = Settings.labs(false);
    for (var i = 0; i < labs.length; i++) if (labs[i].lab_id === id) return labs[i];
    fail_('NO_LAB', 'Unknown or inactive lab "' + id + '".');
  },

  labName: function (labId) {
    var labs = Settings.labs(true);
    for (var i = 0; i < labs.length; i++) if (labs[i].lab_id === labId) return labs[i].name;
    return labId;
  },

  /** Fields safe to send to any signed-in user (no coordinates or thresholds). */
  publicLab: function (lab) {
    return {
      lab_id: lab.lab_id,
      name: lab.name,
      open_time: lab.open_time,
      close_time: lab.close_time,
      open_days: lab.open_days,
      qr_rotate_sec: lab.qr_rotate_sec,
      map_cols: lab.map_cols,
      map_rows: lab.map_rows
    };
  },

  validateLab: function (lab) {
    var errs = [];
    if (!/^[A-Z0-9_-]{2,20}$/.test(lab.lab_id)) errs.push('Lab ID must be 2–20 letters, digits, - or _.');
    if (!lab.name) errs.push('Lab name is required.');
    if (!(lab.lat >= -90 && lab.lat <= 90)) errs.push('Latitude must be between -90 and 90.');
    if (!(lab.lng >= -180 && lab.lng <= 180)) errs.push('Longitude must be between -180 and 180.');
    if (!(lab.radius_m >= APP.RADIUS_MIN_M && lab.radius_m <= APP.RADIUS_MAX_M)) {
      errs.push('Radius must be between ' + APP.RADIUS_MIN_M + ' and ' + APP.RADIUS_MAX_M + ' m.');
    }
    var open = U.parseHHMM(lab.open_time);
    var close = U.parseHHMM(lab.close_time);
    if (isNaN(open) || isNaN(close) || close <= open) errs.push('Operating hours must be HH:MM with closing after opening.');
    var days = lab.open_days.split(',');
    if (!days.length || days.some(function (x) { return DAY_CODES.indexOf(x) === -1; })) {
      errs.push('Open days must be a comma list such as MON,TUE,WED.');
    }
    if (!(lab.accuracy_limit_m >= 5 && lab.accuracy_limit_m <= 500)) errs.push('Accuracy limit must be 5–500 m.');
    if (!(lab.amber_margin_m >= 0 && lab.amber_margin_m <= 200)) errs.push('Amber margin must be 0–200 m.');
    if (!(lab.speed_flag_kmh >= 5 && lab.speed_flag_kmh < lab.speed_block_kmh && lab.speed_block_kmh <= 2000)) {
      errs.push('Speed limits must satisfy 5 ≤ flag < block ≤ 2000 km/h.');
    }
    if (!(lab.qr_rotate_sec >= APP.QR_ROTATE_MIN_SEC && lab.qr_rotate_sec <= APP.QR_ROTATE_MAX_SEC)) {
      errs.push('QR rotation must be ' + APP.QR_ROTATE_MIN_SEC + '–' + APP.QR_ROTATE_MAX_SEC + ' seconds.');
    }
    if (!(lab.grace_min >= 0 && lab.grace_min <= 180)) errs.push('Grace period must be 0–180 minutes.');
    if (lab.incharge_email && !U.isEmail(lab.incharge_email)) errs.push('Lab in-charge email is not valid.');
    if (!(lab.map_cols >= 2 && lab.map_cols <= 16 && lab.map_rows >= 2 && lab.map_rows <= 12)) {
      errs.push('Map size must be 2–16 columns and 2–12 rows.');
    }
    if (errs.length) fail_('INVALID', errs.join(' '));
  },

  saveLab: function (ctx, input) {
    var lab = Settings.normalizeLab(input || {});
    Settings.validateLab(lab);
    return withLock_(function () {
      var row = Db.byId('Config', lab.lab_id);
      var record = {};
      SHEETS.Config.forEach(function (k) {
        record[k] = lab[k];
      });
      record.updated_at = U.now();
      if (row) Db.update('Config', row, record);
      else Db.insert('Config', record);
      Settings.syncFromSheet();
      Audit.log(ctx, 'SETTINGS_LAB', lab.lab_id, row ? 'UPDATED' : 'CREATED', '', lab.lab_id);
      return lab;
    });
  },

  /** Operating hours check (FR-15), evaluated in IST. */
  isOpen: function (lab, d) {
    d = d || U.now();
    if (lab.open_days.split(',').indexOf(U.dayCode(d)) === -1) return false;
    var m = U.minutesOfDay(d);
    return m >= U.parseHHMM(lab.open_time) && m < U.parseHHMM(lab.close_time);
  },

  closeAt: function (lab, d) {
    return U.istDate(U.dateKey(d || U.now()), U.parseHHMM(lab.close_time));
  },

  openMinutesOn: function (lab, dateKey) {
    var day = DAY_CODES[U.ist(U.istDate(dateKey, 720)).dow];
    if (lab.open_days.split(',').indexOf(day) === -1) return null;
    return { open: U.parseHHMM(lab.open_time), close: U.parseHHMM(lab.close_time) };
  },

  global: function () {
    var raw = Settings.props().getProperty('APP_SETTINGS');
    var saved = raw ? JSON.parse(raw) : {};
    var out = {};
    Object.keys(Settings.GLOBAL_DEFAULTS).forEach(function (k) {
      out[k] = saved[k] === undefined ? Settings.GLOBAL_DEFAULTS[k] : saved[k];
    });
    return out;
  },

  saveGlobal: function (ctx, patch) {
    var cur = Settings.global();
    var next = {};
    Object.keys(cur).forEach(function (k) {
      next[k] = patch && patch[k] !== undefined ? patch[k] : cur[k];
    });
    ['extra_allowed_emails', 'report_recipients'].forEach(function (k) {
      var list = Array.isArray(next[k]) ? next[k] : String(next[k] || '').split(/[\s,;]+/);
      next[k] = list
        .map(function (e) {
          return U.str(e).toLowerCase();
        })
        .filter(U.isEmail);
    });
    var ints = {
      monitor_poll_ms: [1000, 5000],
      dashboard_poll_ms: [5000, 10000],
      default_loan_hours: [1, 168],
      max_loan_hours: [1, 720],
      max_open_requests: [1, 20],
      request_expiry_hours: [1, 72],
      reminder_every_hours: [1, 168],
      max_booking_hours: [1, 12],
      booking_advance_days: [1, 60],
      no_show_minutes: [5, 120],
      max_open_bookings: [1, 20],
      archive_after_months: [1, 24],
      backup_keep_days: [3, 90],
      presence_ping_sec: [15, 300],
      presence_not_seen_min: [2, 60],
      presence_away_close_min: [5, 180]
    };
    Object.keys(ints).forEach(function (k) {
      var n = Math.round(U.num(next[k], NaN));
      if (!(n >= ints[k][0] && n <= ints[k][1])) fail_('INVALID', k + ' must be between ' + ints[k][0] + ' and ' + ints[k][1] + '.');
      next[k] = n;
    });
    next.booking_requires_checkin = next.booking_requires_checkin === true || next.booking_requires_checkin === 'true' || next.booking_requires_checkin === 'on';
    next.missing_list_email = next.missing_list_email === true || next.missing_list_email === 'true' || next.missing_list_email === 'on';
    next.presence_enabled = next.presence_enabled === true || next.presence_enabled === 'true' || next.presence_enabled === 'on';
    if (next.presence_not_seen_min * 60 < next.presence_ping_sec * 2) fail_('INVALID', '"Not seen" must allow at least two missed pings.');
    if (next.presence_away_close_min < next.presence_not_seen_min) fail_('INVALID', 'The check-out limit cannot be shorter than the "Not seen" time.');
    if (next.default_loan_hours > next.max_loan_hours) fail_('INVALID', 'Default loan hours cannot exceed the maximum.');
    ['reports_folder_id', 'template_doc_id', 'backup_folder_id'].forEach(function (k) {
      next[k] = U.str(next[k]);
    });
    Settings.props().setProperty('APP_SETTINGS', JSON.stringify(next));
    Audit.log(ctx, 'SETTINGS_GLOBAL', 'APP_SETTINGS', 'UPDATED', Object.keys(patch || {}).join(','), '');
    return next;
  },

  /** HMAC key for QR tokens. Created on first use; never leaves the server. */
  secret: function () {
    var p = Settings.props();
    var s = p.getProperty('QR_SECRET');
    if (!s) {
      s = Utilities.getUuid() + Utilities.getUuid();
      p.setProperty('QR_SECRET', s);
    }
    return s;
  },

  /** Admin-granted extra roles per action, on top of each route's defaults (FR-36). */
  permissionOverrides: function () {
    var raw = Settings.props().getProperty('ROLE_OVERRIDES');
    return raw ? JSON.parse(raw) : {};
  },

  savePermissionOverrides: function (ctx, map) {
    var clean = {};
    Object.keys(map || {}).forEach(function (action) {
      var route = ROUTES[action];
      if (!route || !route.configurable) fail_('INVALID', 'Permissions for "' + action + '" cannot be changed.');
      var roles = (map[action] || []).filter(function (r) {
        return r !== ROLES.ADMIN && ROLE_LIST.indexOf(r) !== -1;
      });
      if (roles.length) clean[action] = roles;
    });
    Settings.props().setProperty('ROLE_OVERRIDES', JSON.stringify(clean));
    Audit.log(ctx, 'ROLE_PERMISSIONS', 'ROLE_OVERRIDES', 'UPDATED', JSON.stringify(clean), '');
    return clean;
  }
};
