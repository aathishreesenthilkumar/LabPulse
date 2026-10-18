/**
 * Consume-and-Refresh QR tokens (FR-05, FR-06, FR-17; SRS §4.4).
 *
 * Token format: LABID.window.nonce.signature
 *   window    = floor(epochSeconds / qr_rotate_sec)
 *   nonce     = 64 random bits, so every token is unique even within one window
 *   signature = HMAC-SHA256(secret, "LABID.window.nonce"), base64url, first 22 chars (132 bits)
 * The secret stays in Script Properties. The QR holds nothing reusable.
 */
var Token = {
  FORMAT: /^([A-Z0-9_-]{2,20})\.(\d{1,12})\.([a-f0-9]{16})\.([A-Za-z0-9_-]{22})$/,

  windowOf: function (ms, rotateSec) {
    return Math.floor(ms / 1000 / rotateSec);
  },

  sign: function (payload) {
    return U.b64url(U.hmac(payload, Settings.secret())).slice(0, 22);
  },

  mint: function (lab, ms) {
    var w = Token.windowOf(ms, lab.qr_rotate_sec);
    var nonce = Utilities.getUuid().replace(/-/g, '').slice(0, 16).toLowerCase();
    var payload = lab.lab_id + '.' + w + '.' + nonce;
    return { token: payload + '.' + Token.sign(payload), window: w, nonce: nonce };
  },

  parse: function (token) {
    var m = Token.FORMAT.exec(U.str(token));
    if (!m) return null;
    return { labId: m[1], window: Number(m[2]), nonce: m[3], sig: m[4], payload: m[1] + '.' + m[2] + '.' + m[3] };
  },

  /** Signature and freshness. Does not consume; see Attendance.claim. */
  verify: function (token, ms) {
    var p = Token.parse(token);
    if (!p) return { ok: false, code: 'QR_INVALID' };
    if (!U.safeEqual(Token.sign(p.payload), p.sig)) return { ok: false, code: 'QR_INVALID', parsed: p };
    var lab;
    try {
      lab = Settings.lab(p.labId);
    } catch (e) {
      return { ok: false, code: 'QR_INVALID', parsed: p };
    }
    var current = Token.windowOf(ms, lab.qr_rotate_sec);
    if (p.window > current) return { ok: false, code: 'QR_INVALID', parsed: p };
    if (p.window < current - APP.TOKEN_GRACE_WINDOWS) return { ok: false, code: 'QR_EXPIRED', parsed: p, lab: lab };
    return { ok: true, parsed: p, lab: lab };
  },

  isUsed: function (nonce) {
    return !!Cache.get('used:' + nonce);
  },

  markUsed: function (nonce, email) {
    // Kept far longer than a token can stay valid, so a consumed nonce is never accepted again.
    Cache.put('used:' + nonce, email, 3600);
  },

  /**
   * The QR the lab monitor should show now. Reads only the cache (quota note, §4.4):
   * a new token is minted when the window rolls over or the shown one was consumed.
   */
  current: function (lab, ms) {
    var key = 'qr:' + lab.lab_id;
    var cur = Cache.getJson(key);
    var w = Token.windowOf(ms, lab.qr_rotate_sec);
    if (!cur || cur.window !== w || Token.isUsed(cur.nonce)) {
      cur = Token.mint(lab, ms);
      Cache.putJson(key, cur, 120);
    }
    var msLeft = (w + 1) * lab.qr_rotate_sec * 1000 - ms;
    return { token: cur.token, window: cur.window, msLeft: msLeft };
  }
};
