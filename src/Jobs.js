/**
 * Time-driven background jobs (SRS §3.4). Trigger handlers must be public functions, so
 * each one first checks that it is running as a trigger, from the editor, or for a Super Admin.
 */

function guardJob_() {
  var active = Auth.activeEmail();
  var effective = '';
  try { effective = U.str(Session.getEffectiveUser().getEmail()).toLowerCase(); } catch (e) { effective = ''; }
  if (!active || active === effective) return; // trigger or script editor
  Auth.require(Auth.context(), [], 'job');
}

/** Every 5 minutes: recount occupancy from active visits and fix any drift. */
function jobReconcile() {
  guardJob_();
  return Attendance.reconcile();
}

/** Every 10 minutes: close visits past their duration plus grace, or past closing time. */
function jobAutoClose() {
  guardJob_();
  return Attendance.autoCloseSweep();
}

/** Hourly: mark late loans and email reminders; expire stale requests. */
function jobOverdue() {
  guardJob_();
  return Assets.overdueCheck();
}

/** Hourly: send each lab's daily digest once, 30 minutes after that lab closes. */
function jobDailyDigest() {
  guardJob_();
  return runDailyDigests_(false);
}

/** 1st of each month: last month's institutional report per lab. */
function jobMonthlyAudit() {
  guardJob_();
  var now = U.now();
  var p = U.ist(now);
  var year = p.mo === 1 ? p.y - 1 : p.y;
  var month = p.mo === 1 ? 12 : p.mo - 1;
  var out = [];
  Settings.labs(false).forEach(function (lab) {
    try {
      var report = Reports.monthly(lab.lab_id, year, month);
      var pdf = Reports.toPdf(report, lab.incharge_email);
      Reports.emailReport(report, lab, pdf);
      Audit.log(null, 'MONTHLY_AUDIT', pdf.name, 'OK', '', lab.lab_id);
      out.push(pdf.name);
    } catch (e) {
      Audit.log(null, 'MONTHLY_AUDIT', lab.lab_id, 'FAILED', e.message, lab.lab_id);
    }
  });
  return out;
}

function runDailyDigests_(force) {
  var now = U.now();
  var today = U.dateKey(now);
  var props = Settings.props();
  var out = [];
  Settings.labs(false).forEach(function (lab) {
    var key = 'DIGEST_SENT_' + lab.lab_id;
    if (!force) {
      if (props.getProperty(key) === today) return;
      if (U.minutesOfDay(now) < U.parseHHMM(lab.close_time) + 30) return;
    }
    try {
      var report = Reports.daily(lab.lab_id, today);
      var pdf = Reports.toPdf(report, lab.incharge_email);
      var sent = Reports.emailReport(report, lab, pdf);
      props.setProperty(key, today);
      Audit.log(null, 'DAILY_DIGEST', pdf.name, sent ? 'SENT' : 'SAVED_NO_RECIPIENT', '', lab.lab_id);
      out.push({ lab: lab.lab_id, pdf: pdf, recipients: sent });
    } catch (e) {
      Audit.log(null, 'DAILY_DIGEST', lab.lab_id, 'FAILED', e.message, lab.lab_id);
    }
  });
  if (!force && props.getProperty('BACKUP_DATE') !== today && U.ist(now).h >= 21) {
    backupSpreadsheet_();
  }
  return out;
}

/** Nightly copy of the data spreadsheet (NFR maintainability). */
function backupSpreadsheet_() {
  var g = Settings.global();
  var folder;
  if (g.backup_folder_id) {
    try { folder = DriveApp.getFolderById(g.backup_folder_id); } catch (e) { folder = null; }
  }
  if (!folder) {
    folder = DriveApp.createFolder('LabPulse Backups');
    Reports.saveGlobalKey('backup_folder_id', folder.getId());
  }
  var today = U.dateKey(U.now());
  var copy = DriveApp.getFileById(Db.spreadsheet().getId()).makeCopy('LabPulse backup ' + today, folder);
  Settings.props().setProperty('BACKUP_DATE', today);
  Audit.log(null, 'BACKUP', copy.getName(), 'OK', '', '');
  return { name: copy.getName(), url: copy.getUrl() };
}

/** Run once from the editor (or from Admin › Settings) to install every trigger. */
function installTriggers() {
  guardJob_();
  return installTriggers_(null);
}

function installTriggers_(ctx) {
  var handlers = ['jobReconcile', 'jobAutoClose', 'jobOverdue', 'jobDailyDigest', 'jobMonthlyAudit'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('jobReconcile').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('jobAutoClose').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('jobOverdue').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('jobDailyDigest').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('jobMonthlyAudit').timeBased().onMonthDay(1).atHour(6).inTimezone(APP.TZ).create();
  Audit.log(ctx, 'INSTALL_TRIGGERS', handlers.join(','), 'OK', '', '');
  return handlers;
}
