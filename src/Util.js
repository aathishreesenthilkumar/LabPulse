/**
 * Small helpers shared by every module: errors, IST date maths, HMAC, locking, caching.
 *
 * Time is always handled in Asia/Kolkata. Because IST has a fixed +05:30 offset, the
 * helpers below do the arithmetic directly instead of relying on the runtime's zone.
 */

function AppError(code, message, extra) {
  this.name = 'AppError';
  this.code = code;
  this.message = message;
  this.extra = extra || null;
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

function fail_(code, message, extra) {
  throw new AppError(code, message, extra);
}

var U = {
  /** Single source of "now" so tests can control the clock. */
  now: function () {
    return new Date();
  },

  id: function (prefix) {
    return prefix + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
  },

  /** Calendar fields of a moment, as seen in IST. */
  ist: function (d) {
    var t = new Date((d || U.now()).getTime() + APP.TZ_OFFSET_MIN * 60000);
    return {
      y: t.getUTCFullYear(),
      mo: t.getUTCMonth() + 1,
      d: t.getUTCDate(),
      h: t.getUTCHours(),
      mi: t.getUTCMinutes(),
      s: t.getUTCSeconds(),
      dow: t.getUTCDay()
    };
  },

  pad: function (n) {
    return (n < 10 ? '0' : '') + n;
  },

  /** 'yyyy-MM-dd' in IST. */
  dateKey: function (d) {
    var p = U.ist(d);
    return p.y + '-' + U.pad(p.mo) + '-' + U.pad(p.d);
  },

  minutesOfDay: function (d) {
    var p = U.ist(d);
    return p.h * 60 + p.mi;
  },

  dayCode: function (d) {
    return DAY_CODES[U.ist(d).dow];
  },

  /** '09:30' -> 570; anything malformed -> NaN. */
  parseHHMM: function (s) {
    var m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s == null ? '' : s).trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  },

  isDateKey: function (s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  },

  /** The instant at `minutes` past IST midnight on dateKey. */
  istDate: function (dateKey, minutes) {
    var parts = String(dateKey).split('-');
    var utcMidnight = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return new Date(utcMidnight - APP.TZ_OFFSET_MIN * 60000 + (minutes || 0) * 60000);
  },

  addDays: function (dateKey, n) {
    return U.dateKey(new Date(U.istDate(dateKey, 12 * 60).getTime() + n * 86400000));
  },

  /** ISO 8601 with the IST offset, e.g. 2026-10-18T14:05:00+05:30 (ERP-ready). */
  iso: function (d) {
    if (!d) return '';
    var p = U.ist(d);
    return p.y + '-' + U.pad(p.mo) + '-' + U.pad(p.d) + 'T' + U.pad(p.h) + ':' + U.pad(p.mi) + ':' + U.pad(p.s) + '+05:30';
  },

  /** Human-readable IST, e.g. 18 Oct 2026, 14:05. */
  fmt: function (d) {
    if (!d) return '';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var p = U.ist(d);
    return p.d + ' ' + months[p.mo - 1] + ' ' + p.y + ', ' + U.pad(p.h) + ':' + U.pad(p.mi);
  },

  toDate: function (v) {
    if (v === null || v === undefined || v === '') return null;
    if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? null : v;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  },

  truthy: function (v) {
    return v === true || /^(true|yes|y|1)$/i.test(String(v == null ? '' : v).trim());
  },

  num: function (v, def) {
    if (v === '' || v === null || v === undefined) return def;
    var n = Number(v);
    return isFinite(n) ? n : def;
  },

  str: function (v, max) {
    var s = String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    return max ? s.slice(0, max) : s;
  },

  isEmail: function (s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
  },

  hmac: function (value, key) {
    return Utilities.computeHmacSha256Signature(value, key);
  },

  b64url: function (bytes) {
    return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
  },

  /** Comparison whose duration does not depend on where the strings differ. */
  safeEqual: function (a, b) {
    a = String(a);
    b = String(b);
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  },

  overlapMs: function (a0, a1, b0, b1) {
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  },

  durationText: function (ms) {
    var mins = Math.max(0, Math.floor(ms / 60000));
    var h = Math.floor(mins / 60);
    return h ? h + 'h ' + (mins % 60) + 'm' : mins + 'm';
  },

  round: function (n, places) {
    var f = Math.pow(10, places || 0);
    return Math.round(n * f) / f;
  },

  /** Deep copy that turns Dates into ISO strings; google.script.run cannot return Dates. */
  plain: function (v) {
    return v === undefined ? null : JSON.parse(JSON.stringify(v));
  }
};

/**
 * Runs fn while holding the script lock (FR-11). The Db read cache is dropped first so
 * every decision inside the lock is based on fresh sheet data.
 */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(APP.LOCK_WAIT_MS)) {
    fail_('BUSY', 'LabPulse is busy right now. Please try again in a moment.');
  }
  try {
    Db.reset();
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

var Cache = {
  c: function () {
    return CacheService.getScriptCache();
  },
  get: function (key) {
    return Cache.c().get(key);
  },
  put: function (key, value, ttlSec) {
    Cache.c().put(key, String(value), Math.min(21600, ttlSec || 600));
  },
  getJson: function (key) {
    var raw = Cache.c().get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  },
  putJson: function (key, value, ttlSec) {
    Cache.put(key, JSON.stringify(value), ttlSec);
  },
  remove: function (key) {
    Cache.c().remove(key);
  }
};
