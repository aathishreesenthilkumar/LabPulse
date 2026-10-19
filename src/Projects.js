/**
 * Student projects: what they work on in the lab, its timeline and its outcome.
 *
 * A project belongs to one lab and has an owner and optional members. Extra-hours (research)
 * check-ins name a project, so the department can see what every student is working on,
 * how many hours went into it, and what came out of it.
 */
var Projects = {
  STATUS: { ACTIVE: 'ACTIVE', COMPLETED: 'COMPLETED', DROPPED: 'DROPPED' },

  isMember: function (p, email) {
    return p.owner_email === email || Projects.members(p).indexOf(email) !== -1;
  },

  members: function (p) {
    return U.str(p.members).split(/[\s,;]+/).filter(U.isEmail);
  },

  /** Hours logged per project, from visits that named it (active visits count up to now). */
  hoursIndex: function () {
    var now = U.now();
    var idx = {};
    // Minutes from visits already moved to the archive spreadsheet.
    Db.all('Projects').forEach(function (p) {
      var m = U.num(p.archived_minutes, 0);
      if (m) idx[p.project_id] = m * 60000;
    });
    Db.all('Visits').forEach(function (v) {
      if (!v.project_id || v.status === STATUS.VISIT.VOIDED || !v.check_in_at) return;
      idx[v.project_id] = (idx[v.project_id] || 0) + ((v.check_out_at || now) - v.check_in_at);
    });
    return idx;
  },

  view: function (p, hours, users) {
    var owner = users ? users[p.owner_email] || {} : {};
    return {
      project_id: p.project_id, lab_id: p.lab_id, title: p.title, description: p.description,
      owner_email: p.owner_email, owner_name: owner.name || '', owner_reg_no: owner.reg_no || '',
      members: Projects.members(p), start_date: p.start_date, end_date: p.end_date, status: p.status,
      outcome: p.outcome, outcome_link: p.outcome_link, hours: U.round((hours[p.project_id] || 0) / 3600000, 1),
      overdue: p.status === Projects.STATUS.ACTIVE && !!p.end_date && p.end_date < U.dateKey(U.now()),
      created_at: p.created_at, updated_at: p.updated_at
    };
  },

  mine: function (email) {
    var hours = Projects.hoursIndex();
    return Db.find('Projects', function (p) { return Projects.isMember(p, email); })
      .sort(function (a, b) { return b.created_at - a.created_at; })
      .map(function (p) { return Projects.view(p, hours); });
  },

  /** Active projects the user may log time against in a lab (used by the check-in form). */
  activeFor: function (email, labId) {
    return Db.find('Projects', function (p) {
      return p.lab_id === labId && p.status === Projects.STATUS.ACTIVE && Projects.isMember(p, email);
    }).map(function (p) { return { project_id: p.project_id, title: p.title, end_date: p.end_date }; });
  },

  validate: function (input, lab) {
    var rec = {
      lab_id: lab.lab_id,
      title: U.str(input.title, 120),
      description: U.str(input.description, 1000),
      start_date: U.str(input.start_date) || U.dateKey(U.now()),
      end_date: U.str(input.end_date)
    };
    var errs = [];
    if (rec.title.length < 3) errs.push('Give the project a title (at least 3 characters).');
    if (!U.isDateKey(rec.start_date)) errs.push('Start date must be a date.');
    if (!U.isDateKey(rec.end_date)) errs.push('Give the expected end date (the project timeline).');
    else if (rec.end_date < rec.start_date) errs.push('The end date must be on or after the start date.');
    var members = (Array.isArray(input.members) ? input.members : String(input.members || '').split(/[\s,;]+/))
      .map(function (e) { return U.str(e).toLowerCase(); }).filter(Boolean);
    members.forEach(function (e) {
      if (!U.isEmail(e) || !Auth.isAllowedEmail(e)) errs.push('Team member "' + e + '" is not an institutional email.');
    });
    if (errs.length) fail_('INVALID', errs.join(' '));
    rec.members = members.filter(function (e, i, a) { return a.indexOf(e) === i; }).join(', ');
    return rec;
  },

  /** Create (any signed-in user) or edit (owner, Coordinator or Admin). Caller holds no lock. */
  save: function (ctx, input) {
    input = input || {};
    var lab = Settings.lab(input.lab_id || input.labId);
    var rec = Projects.validate(input, lab);
    return U.plain(withLock_(function () {
      var now = U.now();
      var row = input.project_id ? Db.byId('Projects', U.str(input.project_id)) : null;
      if (row) {
        Projects.requireEditor(ctx, row);
        rec.updated_at = now;
        Db.update('Projects', row, rec);
        Audit.log(ctx, 'PROJECT_EDIT', row.project_id, 'UPDATED', rec.title, lab.lab_id);
      } else {
        rec.project_id = U.id('P');
        rec.owner_email = ctx.email;
        rec.status = Projects.STATUS.ACTIVE;
        rec.outcome = '';
        rec.outcome_link = '';
        rec.created_at = now;
        rec.updated_at = now;
        row = Db.insert('Projects', rec);
        Audit.log(ctx, 'PROJECT_ADD', row.project_id, 'CREATED', rec.title, lab.lab_id);
      }
      return Projects.view(row, Projects.hoursIndex());
    }));
  },

  requireEditor: function (ctx, row) {
    if (row.owner_email === ctx.email || ctx.role === ROLES.COORDINATOR || ctx.role === ROLES.ADMIN) return;
    Audit.log(ctx, 'SECURITY_FORBIDDEN', row.project_id, 'DENIED', 'Not the project owner', row.lab_id);
    fail_('FORBIDDEN', 'Only the project owner can change this project.');
  },

  /** Close a project with its outcome (what was built, results, a link to the code or report). */
  complete: function (ctx, input) {
    input = input || {};
    var outcome = U.str(input.outcome, 2000);
    var link = U.str(input.outcome_link, 300);
    var status = U.str(input.status).toUpperCase() || Projects.STATUS.COMPLETED;
    if (status !== Projects.STATUS.COMPLETED && status !== Projects.STATUS.DROPPED) fail_('INVALID', 'Status must be COMPLETED or DROPPED.');
    if (outcome.length < 10) fail_('INVALID', 'Describe the outcome in at least a sentence (10+ characters).');
    if (link && !/^https?:\/\/\S+$/i.test(link)) fail_('INVALID', 'The outcome link must start with http:// or https://');
    return U.plain(withLock_(function () {
      var row = Db.byId('Projects', U.str(input.project_id));
      if (!row) fail_('NOT_FOUND', 'Project not found.');
      Projects.requireEditor(ctx, row);
      Db.update('Projects', row, { status: status, outcome: outcome, outcome_link: link, updated_at: U.now() });
      Audit.log(ctx, 'PROJECT_' + status, row.project_id, status, outcome.slice(0, 120), row.lab_id);
      return Projects.view(row, Projects.hoursIndex());
    }));
  },

  /** All projects in a lab, for Coordinator, HOD, staff and faculty. */
  list: function (labId, filter) {
    var hours = Projects.hoursIndex();
    var users = Attendance.userIndex();
    var status = U.str(filter && filter.status).toUpperCase();
    return Db.find('Projects', function (p) {
      return p.lab_id === labId && (!status || p.status === status);
    }).sort(function (a, b) { return b.updated_at - a.updated_at; })
      .map(function (p) { return Projects.view(p, hours, users); });
  },

  /** One project with its work log (each visit's date, person, system, hours and note). */
  detail: function (ctx, projectId) {
    var p = Db.byId('Projects', U.str(projectId));
    if (!p) fail_('NOT_FOUND', 'Project not found.');
    var viewer = [ROLES.ADMIN, ROLES.COORDINATOR, ROLES.HOD, ROLES.STAFF, ROLES.FACULTY].indexOf(ctx.role) !== -1;
    if (!viewer && !Projects.isMember(p, ctx.email)) fail_('FORBIDDEN', 'You are not on this project.');
    var users = Attendance.userIndex();
    var assets = {};
    Db.all('Assets').forEach(function (a) { assets[a.asset_id] = a; });
    var now = U.now();
    var log = Db.find('Visits', function (v) {
      return v.project_id === p.project_id && v.status !== STATUS.VISIT.VOIDED;
    }).sort(function (a, b) { return b.check_in_at - a.check_in_at; }).map(function (v) {
      var u = users[v.email] || {};
      return {
        date: U.dateKey(v.check_in_at), name: u.name || v.email, reg_no: u.reg_no || '',
        system: Monitoring.systemLabel(v.system_id, assets), check_in_at: v.check_in_at, check_out_at: v.check_out_at || null,
        hours: U.round(((v.check_out_at || now) - v.check_in_at) / 3600000, 2), note: v.work_note
      };
    });
    return U.plain({ project: Projects.view(p, Projects.hoursIndex(), users), log: log });
  }
};
