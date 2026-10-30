/**
 * Email one-time-code sign-in.
 *
 * 1. authStart: the person types their Karunya email; LabPulse emails a 6-digit code.
 * 2. authVerify: they type the code; LabPulse issues a session token (30 days) that the
 *    browser keeps and sends with every call.
 *
 * Codes and tokens are never stored in plain text: only HMAC hashes (key in Script
 * Properties). Codes expire in 10 minutes, allow 5 tries, and can be re-sent once a
 * minute and 5 times an hour. The email is sent by the Google account that owns the
 * script, so no mail password is stored anywhere.
 */
var Login = {
  CODE_TTL_SEC: 600,
  MAX_TRIES: 5,
  RESEND_SEC: 60,
  MAX_PER_HOUR: 5,
  SESSION_DAYS: 30,

  hash: function (value) {
    return U.b64url(U.hmac(value, Settings.secret()));
  },

  normalizeEmail: function (raw) {
    return U.str(raw, 120).trim().toLowerCase();
  },

  mask: function (email) {
    var parts = email.split('@');
    var name = parts[0];
    return (name.length <= 2 ? name[0] + '•' : name.slice(0, 2) + '•••' + name.slice(-1)) + '@' + parts[1];
  },

  newCode: function () {
    // Utilities.getUuid() is a random (v4) UUID; 48 bits of it give an unbiased-enough 6-digit code.
    var n = parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 12), 16);
    return String(n % 1000000).padStart(6, '0');
  },

  /** Step 1: email a code. */
  start: function (p) {
    var email = Login.normalizeEmail(p && p.email);
    if (!U.isEmail(email)) fail_('INVALID', 'Enter your full email address, e.g. urk24cs1249@karunya.edu.in');
    if (!Auth.isAllowedEmail(email)) {
      Audit.log({ email: email, role: '' }, 'SECURITY_DOMAIN_REJECT', email, 'DENIED', 'Sign-in code requested outside allowed domains', '');
      fail_('DOMAIN', 'Only @karunya.edu and @karunya.edu.in accounts can use LabPulse.');
    }
    var user = Auth.findUser(email);
    if (user && !user.active) fail_('INACTIVE', 'Your LabPulse account is disabled. Contact the lab in-charge.');

    var now = U.now().getTime();
    var last = Number(Cache.get('otp:last:' + email) || 0);
    var pending = Cache.getJson('otp:' + email);
    var registered = !!(user && Auth.isRegistered(user));
    if (last && pending && now - last < Login.RESEND_SEC * 1000) {
      // A code went out moments ago and is still unused: send them to it instead of mailing another.
      return {
        sent: false, email: email, masked: Login.mask(email), newUser: !registered,
        expiresInSec: Login.CODE_TTL_SEC, resendInSec: Math.ceil((Login.RESEND_SEC * 1000 - (now - last)) / 1000)
      };
    }
    var sent = Number(Cache.get('otp:count:' + email) || 0);
    if (sent >= Login.MAX_PER_HOUR) fail_('RATE', 'Too many codes requested for this email. Try again in an hour.');
    // Daily email allowance: checked only where the script may read it (MailApp needs its own permission).
    var quotaLeft = null;
    try { if (typeof MailApp !== 'undefined' && MailApp.getRemainingDailyQuota) quotaLeft = MailApp.getRemainingDailyQuota(); } catch (e) { quotaLeft = null; }
    if (quotaLeft !== null && quotaLeft < 1) {
      fail_('MAIL_QUOTA', 'LabPulse has reached today’s email limit. Ask lab staff to let you in, or try again tomorrow.');
    }

    var code = Login.newCode();
    try {
      Login.sendCode(email, code, !!(user && Auth.isRegistered(user)));
    } catch (e) {
      console.error('Sign-in code email failed: ' + (e && e.message));
      fail_('MAIL_FAILED', 'LabPulse could not send the code email right now. Please try again in a minute.');
    }
    // Only a code that was actually emailed is kept.
    Cache.putJson('otp:' + email, { h: Login.hash(email + ':' + code), tries: 0, at: now }, Login.CODE_TTL_SEC);
    Cache.put('otp:last:' + email, now, Login.RESEND_SEC);
    Cache.put('otp:count:' + email, sent + 1, 3600);
    Audit.log({ email: email, role: user ? user.role : '' }, 'OTP_SENT', email, 'OK', '', '');
    return {
      sent: true, email: email, masked: Login.mask(email), newUser: !(user && Auth.isRegistered(user)),
      expiresInSec: Login.CODE_TTL_SEC, resendInSec: Login.RESEND_SEC
    };
  },

  sendCode: function (email, code, returning) {
    var subject = code + ' is your LabPulse code';
    var text = 'Your LabPulse ' + (returning ? 'sign-in' : 'sign-up') + ' code is ' + code + '.\n\n' +
      'It expires in 10 minutes. If you did not ask for it, you can ignore this email; nobody can sign in without the code.\n\n' +
      '— LabPulse · Intel Unnati IoT Lab, Karunya';
    var spaced = code.slice(0, 3) + ' ' + code.slice(3);
    var html =
      '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f7f6f2;padding:32px 16px">' +
      '<div style="max-width:440px;margin:0 auto;background:#ffffff;border:1px solid #e6e3da;border-radius:16px;padding:32px">' +
      '<div style="font-weight:700;font-size:17px;color:#121212;margin-bottom:24px">LabPulse</div>' +
      '<h1 style="font-size:22px;line-height:1.3;color:#121212;margin:0 0 8px">' + (returning ? 'Your sign-in code' : 'Confirm your email') + '</h1>' +
      '<p style="font-size:15px;line-height:1.55;color:#3d3d3a;margin:0 0 24px">Enter this code in LabPulse to ' + (returning ? 'sign in' : 'create your account') + '. It expires in 10 minutes.</p>' +
      '<div style="font-family:SFMono-Regular,Consolas,Menlo,monospace;font-size:34px;letter-spacing:8px;font-weight:700;color:#121212;background:#f2f0ea;border-radius:12px;padding:18px 0;text-align:center">' + spaced + '</div>' +
      '<p style="font-size:13px;line-height:1.55;color:#6f6d66;margin:24px 0 0">If you didn’t ask for this code, you can ignore this email. Nobody can sign in without it. LabPulse will never ask you to share it.</p>' +
      '</div><p style="text-align:center;font-size:12px;color:#8a877e;margin:16px 0 0">Intel Unnati IoT Lab · Karunya</p></div>';
    GmailApp.sendEmail(email, subject, text, { htmlBody: html, name: 'LabPulse' });
  },

  /** Step 2: check the code and open a session. */
  verify: function (p) {
    var email = Login.normalizeEmail(p && p.email);
    var code = U.str(p && p.code, 12).replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) fail_('INVALID', 'Enter the 6-digit code from the email.');
    return withLock_(function () {
      var rec = Cache.getJson('otp:' + email);
      if (!rec) fail_('CODE_EXPIRED', 'This code has expired. Send a new one.');
      if (!U.safeEqual(rec.h, Login.hash(email + ':' + code))) {
        rec.tries = (rec.tries || 0) + 1;
        if (rec.tries >= Login.MAX_TRIES) {
          Cache.remove('otp:' + email);
          Audit.log({ email: email, role: '' }, 'SECURITY_OTP_LOCKED', email, 'DENIED', rec.tries + ' wrong codes', '');
          fail_('CODE_LOCKED', 'Too many wrong codes. Send a new one.');
        }
        Cache.putJson('otp:' + email, rec, Login.CODE_TTL_SEC);
        var left = Login.MAX_TRIES - rec.tries;
        fail_('CODE_WRONG', 'That code isn’t right. ' + left + (left === 1 ? ' try' : ' tries') + ' left.');
      }
      Cache.remove('otp:' + email);
      var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
      var now = U.now();
      Db.insert('Sessions', {
        session_id: U.id('S'), token_hash: Login.hash(token), email: email, created_at: now,
        expires_at: new Date(now.getTime() + Login.SESSION_DAYS * 86400000), revoked_at: ''
      });
      Audit.log({ email: email, role: '' }, 'LOGIN_OTP', email, 'OK', '', '');
      return { token: token, expiresInDays: Login.SESSION_DAYS };
    });
  },

  /** Email for a session token, or '' if it is unknown, expired or revoked. */
  emailFor: function (token) {
    token = U.str(token, 80);
    if (!/^[a-f0-9]{64}$/.test(token)) return '';
    var h = Login.hash(token);
    var cached = Cache.getJson('sess:' + h);
    if (cached) return cached.email || '';
    var row = Db.findBy('Sessions', 'token_hash', h);
    var ok = row && !row.revoked_at && new Date(row.expires_at).getTime() > U.now().getTime();
    Cache.putJson('sess:' + h, { email: ok ? row.email : '' }, 1800);
    return ok ? row.email : '';
  },

  signOut: function (token) {
    token = U.str(token, 80);
    if (!token) return { signedOut: true };
    var h = Login.hash(token);
    withLock_(function () {
      var row = Db.findBy('Sessions', 'token_hash', h);
      if (row && !row.revoked_at) Db.update('Sessions', row, { revoked_at: U.now() });
    });
    Cache.remove('sess:' + h);
    return { signedOut: true };
  }
};
