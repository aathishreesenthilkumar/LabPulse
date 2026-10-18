/**
 * Identity, domain restriction, registration and roles (FR-01 – FR-03).
 *
 * The web app runs as the deploying account, so Session.getActiveUser() is the only
 * trusted source of identity. Nothing the browser sends is used to decide who the caller is.
 */
var Auth = {
  activeEmail: function () {
    try {
      return U.str(Session.getActiveUser().getEmail()).toLowerCase();
    } catch (e) {
      return '';
    }
  },

  isAllowedEmail: function (email) {
    var domain = email.split('@')[1] || '';
    if (APP.ALLOWED_DOMAINS.indexOf(domain) !== -1) return true;
    return Settings.global().extra_allowed_emails.indexOf(email) !== -1;
  },

  findUser: function (email) {
    var key = 'user:' + email;
    var cached = Cache.getJson(key);
    if (cached) return cached.none ? null : cached;
    var row = Db.findOne('Users', function (u) {
      return u.email === email;
    });
    var user = row ? Auth.publicUser(row) : null;
    Cache.putJson(key, user || { none: true }, APP.USER_CACHE_SEC);
    return user;
  },

  invalidate: function (email) {
    Cache.remove('user:' + email);
  },

  publicUser: function (row) {
    return {
      user_id: row.user_id,
      email: row.email,
      name: row.name,
      reg_no: row.reg_no,
      mobile: row.mobile,
      role: row.role,
      active: U.truthy(row.active)
    };
  },

  isRegistered: function (user) {
    return !!(user && user.name && user.reg_no && user.mobile);
  },

  /** Step 1 of every request: who is calling, and are they allowed in at all? */
  context: function () {
    var email = Auth.activeEmail();
    if (!email) {
      fail_('NO_IDENTITY', 'We could not read your Google account. Sign in with your Karunya account and reload.');
    }
    if (!Auth.isAllowedEmail(email)) {
      Audit.log({ email: email, role: '' }, 'SECURITY_DOMAIN_REJECT', email, 'DENIED', 'Account outside allowed domains', '');
      fail_('DOMAIN', 'Only @karunya.edu and @karunya.edu.in accounts can use LabPulse.');
    }
    var user = Auth.findUser(email);
    return {
      email: email,
      user: user,
      role: user && user.active ? user.role : null,
      registered: Auth.isRegistered(user),
      active: !!(user && user.active)
    };
  },

  /** Throws unless the caller is registered, active and holds one of `roles`. Admin passes every check. */
  require: function (ctx, roles, action) {
    if (!ctx.registered) fail_('NOT_REGISTERED', 'Please complete your profile first.');
    if (!ctx.active) fail_('INACTIVE', 'Your LabPulse account is disabled. Contact the lab in-charge.');
    if (!roles || ctx.role === ROLES.ADMIN || roles.indexOf(ctx.role) !== -1) return ctx;
    Audit.log(ctx, 'SECURITY_FORBIDDEN', action || '', 'DENIED', 'Role ' + ctx.role + ' not permitted', '');
    fail_('FORBIDDEN', 'You do not have permission to do that.');
  },

  /** FR-02: first sign-in captures name, roll/employee ID and mobile; email comes from Google. */
  register: function (ctx, input) {
    var name = U.str(input && input.name, 80);
    var regNo = U.str(input && input.reg_no, 20).toUpperCase();
    var mobile = U.str(input && input.mobile).replace(/[\s-]/g, '').replace(/^\+91/, '');
    var errs = [];
    if (name.length < 2) errs.push('Enter your full name.');
    if (!/^[A-Z0-9\/-]{3,20}$/.test(regNo)) errs.push('Enter a valid roll number or employee ID.');
    if (!/^[6-9]\d{9}$/.test(mobile)) errs.push('Enter a valid 10-digit Indian mobile number.');
    if (errs.length) fail_('INVALID', errs.join(' '));

    return withLock_(function () {
      var row = Db.findOne('Users', function (u) {
        return u.email === ctx.email;
      });
      var clash = Db.findOne('Users', function (u) {
        return u.reg_no === regNo && u.email !== ctx.email;
      });
      if (clash) fail_('INVALID', 'That roll number / employee ID is already registered to another account.');
      var now = U.now();
      if (row) {
        if (Auth.isRegistered(Auth.publicUser(row))) fail_('ALREADY', 'Your profile is already complete.');
        Db.update('Users', row, { name: name, reg_no: regNo, mobile: mobile, updated_at: now });
      } else {
        row = Db.insert('Users', {
          user_id: U.id('U'),
          email: ctx.email,
          name: name,
          reg_no: regNo,
          mobile: mobile,
          role: ROLES.STUDENT,
          active: true,
          created_at: now,
          updated_at: now
        });
      }
      Auth.invalidate(ctx.email);
      Audit.log({ email: ctx.email, role: row.role }, 'REGISTER', row.user_id, 'OK', '', '');
      return Auth.publicUser(row);
    });
  },

  listUsers: function () {
    return Db.all('Users')
      .map(Auth.publicUser)
      .sort(function (a, b) {
        return a.email < b.email ? -1 : 1;
      });
  },

  /** Admin creates or edits a user. Role changes are audit-logged (FR-04). */
  saveUser: function (ctx, input) {
    var email = U.str(input && input.email).toLowerCase();
    var role = U.str(input && input.role).toUpperCase();
    if (!U.isEmail(email) || !Auth.isAllowedEmail(email)) fail_('INVALID', 'Enter an institutional email address.');
    if (ROLE_LIST.indexOf(role) === -1) fail_('INVALID', 'Unknown role.');
    var active = input.active === undefined ? true : !!input.active;
    if (email === ctx.email && (role !== ROLES.ADMIN || !active)) {
      fail_('INVALID', 'You cannot remove your own Super Admin access. Ask another Super Admin.');
    }
    return withLock_(function () {
      var row = Db.findOne('Users', function (u) {
        return u.email === email;
      });
      var now = U.now();
      if (!row) {
        row = Db.insert('Users', {
          user_id: U.id('U'), email: email, name: '', reg_no: '', mobile: '',
          role: role, active: active, created_at: now, updated_at: now
        });
        Audit.log(ctx, 'ROLE_CHANGE', email, 'CREATED', 'role=' + role, '');
      } else {
        var before = row.role + (U.truthy(row.active) ? '' : ' (inactive)');
        Db.update('Users', row, { role: role, active: active, updated_at: now });
        var after = role + (active ? '' : ' (inactive)');
        if (before !== after) Audit.log(ctx, 'ROLE_CHANGE', email, 'UPDATED', before + ' -> ' + after, '');
      }
      Auth.invalidate(email);
      return Auth.publicUser(row);
    });
  }
};

/**
 * Append-only audit log (FR-04). The application only ever appends; nothing updates or
 * deletes AuditLog rows. Coordinates are never written here.
 */
var Audit = {
  log: function (ctx, action, target, outcome, reason, labId) {
    try {
      Db.insert('AuditLog', {
        event_id: U.id('E'),
        timestamp: U.now(),
        actor: (ctx && ctx.email) || 'system',
        role: ctx ? ctx.role || '' : 'SYSTEM',
        action: action,
        target: target || '',
        outcome: outcome || 'OK',
        reason: U.str(reason, 500),
        lab_id: labId || ''
      });
    } catch (e) {
      // An audit failure must never hide the outcome of the user's action.
      console.error('Audit write failed: ' + e.message);
    }
  },

  query: function (f) {
    f = f || {};
    var actor = U.str(f.actor).toLowerCase();
    var action = U.str(f.action).toUpperCase();
    var from = U.isDateKey(f.from) ? U.istDate(f.from, 0) : null;
    var to = U.isDateKey(f.to) ? U.istDate(U.addDays(f.to, 1), 0) : null;
    var limit = Math.min(500, U.num(f.limit, 200));
    var rows = Db.all('AuditLog').filter(function (r) {
      if (actor && r.actor.toLowerCase().indexOf(actor) === -1) return false;
      if (action && r.action.indexOf(action) === -1) return false;
      if (f.securityOnly && r.action.indexOf('SECURITY_') !== 0) return false;
      if (from && (!r.timestamp || r.timestamp < from)) return false;
      if (to && (!r.timestamp || r.timestamp >= to)) return false;
      return true;
    });
    return rows.slice(-limit).reverse();
  }
};
