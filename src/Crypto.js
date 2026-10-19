/**
 * Field encryption for sensitive values stored in Sheets (phone numbers).
 *
 * Apps Script has no built-in AES, so this uses a standard construction built only on
 * HMAC-SHA256, which Apps Script does provide:
 *   - keystream:  HMAC(encKey, iv ":" counter) blocks, XORed with the UTF-8 plaintext (CTR mode)
 *   - integrity:  HMAC(macKey, "v1:" iv ":" ciphertext) tag, checked before decrypting
 *                 (encrypt-then-MAC), so a tampered cell is detected, not silently misread
 *   - a fresh random 96-bit IV per value, so equal numbers encrypt differently
 * Stored form: enc:v1:<iv>:<ciphertext>:<tag>  (base64url)
 *
 * The master key lives only in Script Properties (DATA_KEY). Anyone who can open the sheet sees
 * ciphertext only; anyone with edit access to the script itself could read the key.
 */
var Crypto = {
  PREFIX: 'enc:v1:',

  keys: function () {
    var p = Settings.props();
    var master = p.getProperty('DATA_KEY');
    if (!master) {
      master = Utilities.getUuid() + Utilities.getUuid();
      p.setProperty('DATA_KEY', master);
    }
    return {
      enc: U.b64url(U.hmac('labpulse-enc', master)),
      mac: U.b64url(U.hmac('labpulse-mac', master))
    };
  },

  utf8: function (s) {
    var bin = unescape(encodeURIComponent(String(s)));
    var out = [];
    for (var i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i));
    return out;
  },

  fromUtf8: function (bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] & 255);
    return decodeURIComponent(escape(bin));
  },

  signed: function (bytes) {
    return bytes.map(function (b) { b = b & 255; return b > 127 ? b - 256 : b; });
  },

  keystream: function (encKey, iv, length) {
    var out = [];
    for (var counter = 0; out.length < length; counter++) {
      out = out.concat(U.hmac(iv + ':' + counter, encKey));
    }
    return out.slice(0, length);
  },

  isEncrypted: function (v) {
    return String(v || '').indexOf(Crypto.PREFIX) === 0;
  },

  encrypt: function (plain) {
    plain = String(plain == null ? '' : plain);
    if (!plain || Crypto.isEncrypted(plain)) return plain;
    var k = Crypto.keys();
    var hex = Utilities.getUuid().replace(/-/g, '').slice(0, 24);
    var ivBytes = [];
    for (var i = 0; i < 24; i += 2) ivBytes.push(parseInt(hex.substr(i, 2), 16));
    var iv = U.b64url(Crypto.signed(ivBytes));
    var data = Crypto.utf8(plain);
    var ks = Crypto.keystream(k.enc, iv, data.length);
    var ct = U.b64url(Crypto.signed(data.map(function (b, j) { return b ^ (ks[j] & 255); })));
    var tag = U.b64url(U.hmac('v1:' + iv + ':' + ct, k.mac)).slice(0, 22);
    return Crypto.PREFIX + iv + ':' + ct + ':' + tag;
  },

  /** Plain values (from before encryption was switched on) are returned as they are. */
  decrypt: function (value) {
    var s = String(value == null ? '' : value);
    if (!Crypto.isEncrypted(s)) return s;
    var parts = s.slice(Crypto.PREFIX.length).split(':');
    if (parts.length !== 3) fail_('TAMPERED', 'An encrypted field is damaged.');
    var k = Crypto.keys();
    var expect = U.b64url(U.hmac('v1:' + parts[0] + ':' + parts[1], k.mac)).slice(0, 22);
    if (!U.safeEqual(expect, parts[2])) fail_('TAMPERED', 'An encrypted field was changed outside LabPulse.');
    var data = Utilities.base64DecodeWebSafe(Crypto.pad(parts[1]));
    var ks = Crypto.keystream(k.enc, parts[0], data.length);
    return Crypto.fromUtf8(data.map(function (b, j) { return (b ^ ks[j]) & 255; }));
  },

  /** Decrypt for display; a damaged value shows as a warning instead of breaking the page. */
  reveal: function (value) {
    try {
      return Crypto.decrypt(value);
    } catch (e) {
      return '⚠ damaged';
    }
  },

  pad: function (b64) {
    while (b64.length % 4) b64 += '=';
    return b64;
  },

  /** e.g. ••••••3210 — enough to recognise a number without exposing it. */
  mask: function (value) {
    var plain = Crypto.reveal(value);
    if (!plain) return '';
    return plain.length > 4 ? new Array(plain.length - 3).join('•') + plain.slice(-4) : '••••';
  },

  /** One-time migration: encrypt any phone numbers still stored in plain text. */
  migrate: function () {
    return withLock_(function () {
      var n = 0;
      Db.all('Users').forEach(function (u) {
        if (u.mobile && !Crypto.isEncrypted(u.mobile)) {
          Db.update('Users', u, { mobile: Crypto.encrypt(u.mobile) });
          n++;
        }
      });
      if (n) Audit.log(null, 'ENCRYPT_MIGRATION', 'Users.mobile', 'OK', n + ' value(s) encrypted', '');
      return { encrypted: n };
    });
  }
};
