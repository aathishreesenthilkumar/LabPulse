/**
 * Reports and exports (FR-29 – FR-34; metric definitions in SRS §5.7).
 *
 * Every report is first built as a plain object ({title, kpis, sections}) by pure functions,
 * then rendered to a PDF (Google Docs template → Drive), an email or the dashboard.
 */
var Reports = {
  /* ---------- metric helpers (pure) ---------- */

  /** A visit counts once it is not voided and is Green, Manual, or a confirmed Amber. */
  isVerified: function (v) {
    if (v.status === STATUS.VISIT.VOIDED) return false;
    return v.confidence === STATUS.CONF.GREEN || v.confidence === STATUS.CONF.MANUAL || v.review_status === STATUS.REVIEW.CONFIRMED;
  },

  visitEnd: function (v, now) {
    return (v.check_out_at || now).getTime();
  },

  visitsIn: function (visits, labId, fromMs, toMs, now) {
    return visits.filter(function (v) {
      return v.lab_id === labId && v.check_in_at && Reports.isVerified(v) &&
        v.check_in_at.getTime() < toMs && Reports.visitEnd(v, now) > fromMs;
    });
  },

  /** Highest number of people inside at once within [fromMs, toMs). */
  maxConcurrent: function (visits, fromMs, toMs, now) {
    var events = [];
    visits.forEach(function (v) {
      var s = Math.max(v.check_in_at.getTime(), fromMs);
      var e = Math.min(Reports.visitEnd(v, now), toMs);
      if (e > s) {
        events.push([s, 1]);
        events.push([e, -1]);
      }
    });
    events.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; }); // leave before arrive at equal times
    var cur = 0;
    var max = 0;
    events.forEach(function (ev) {
      cur += ev[1];
      if (cur > max) max = cur;
    });
    return max;
  },

  /** Hours of [startMs, endMs) that fall inside the lab's operating hours, within the period. */
  openHoursOverlap: function (lab, startMs, endMs, fromKey, toKey) {
    var total = 0;
    for (var key = fromKey; key <= toKey; key = U.addDays(key, 1)) {
      var w = Settings.openMinutesOn(lab, key);
      if (!w) continue;
      total += U.overlapMs(startMs, endMs, U.istDate(key, w.open).getTime(), U.istDate(key, w.close).getTime());
    }
    return total / 3600000;
  },

  mergeIntervals: function (list) {
    list = list.filter(function (x) { return x[1] > x[0]; }).sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    list.forEach(function (x) {
      var last = out[out.length - 1];
      if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
      else out.push([x[0], x[1]]);
    });
    return out;
  },

  /* ---------- report builders ---------- */

  /** FR-29 daily operational digest. */
  daily: function (labId, dateKey, data) {
    var lab = Settings.lab(labId);
    data = data || Reports.load();
    var now = U.now();
    var from = U.istDate(dateKey, 0).getTime();
    var to = U.istDate(U.addDays(dateKey, 1), 0).getTime();
    var visits = Reports.visitsIn(data.visits, lab.lab_id, from, to, now);

    var people = {};
    visits.forEach(function (v) { people[v.email] = true; });
    var hours = [];
    var peak = { hour: null, count: 0 };
    for (var h = 0; h < 24; h++) {
      var hs = from + h * 3600000;
      var he = hs + 3600000;
      var inHour = visits.filter(function (v) {
        return v.check_in_at.getTime() < he && Reports.visitEnd(v, now) > hs;
      });
      var distinct = {};
      inHour.forEach(function (v) { distinct[v.email] = true; });
      var concurrent = Reports.maxConcurrent(inHour, hs, he, now);
      if (concurrent > peak.count) peak = { hour: h, count: concurrent };
      hours.push({ hour: h, people: Object.keys(distinct).length, peak: concurrent });
    }
    // The three busiest hours, by most people inside at once (ties: earlier hour first).
    var peaks = hours.filter(function (x) { return x.peak > 0; })
      .sort(function (a, b) { return b.peak - a.peak || a.hour - b.hour; })
      .slice(0, 3);
    var lo = U.parseHHMM(lab.open_time) / 60;
    var hi = Math.ceil(U.parseHHMM(lab.close_time) / 60);
    var shownHours = hours.filter(function (x) { return (x.hour >= Math.floor(lo) && x.hour < hi) || x.people > 0; });

    var dayVisits = data.visits.filter(function (v) {
      return v.lab_id === lab.lab_id && v.check_in_at && v.check_in_at.getTime() >= from && v.check_in_at.getTime() < to;
    });
    var count = function (pred) { return dayVisits.filter(pred).length; };
    var openLoans = data.loans.filter(function (l) {
      return l.lab_id === lab.lab_id && l.status !== STATUS.LOAN.RETURNED && l.issued_at && l.issued_at.getTime() < to;
    });
    var pendingReq = data.requests.filter(function (r) {
      return r.lab_id === lab.lab_id && r.status === STATUS.REQUEST.PENDING;
    });
    var assetName = Reports.assetIndex(data.assets);
    var red = data.audit.filter(function (e) {
      return e.lab_id === lab.lab_id && e.action.indexOf('SECURITY_') === 0 && e.timestamp &&
        e.timestamp.getTime() >= from && e.timestamp.getTime() < to;
    }).length;

    return {
      kind: 'daily',
      filename: 'LabPulse_Daily_' + lab.lab_id + '_' + dateKey,
      title: 'Daily Operational Digest',
      subtitle: lab.name + ' · ' + dateKey,
      kpis: [
        ['Unique visitors', Object.keys(people).length],
        ['Verified visits', visits.length],
        ['Peak occupancy hours', peaks.length ? peaks.map(function (x) {
          return U.pad(x.hour) + ':00–' + U.pad(x.hour + 1) + ':00 (' + x.peak + ')';
        }).join(', ') : '—'],
        ['Green / Amber / Manual', count(function (v) { return v.confidence === 'GREEN'; }) + ' / ' +
          count(function (v) { return v.confidence === 'AMBER'; }) + ' / ' + count(function (v) { return v.confidence === 'MANUAL'; })],
        ['Pending reviews', count(function (v) { return v.review_status === STATUS.REVIEW.PENDING && v.status !== STATUS.VISIT.VOIDED; })],
        ['Auto-closed visits', count(function (v) { return /^AUTO_(DURATION|CLOSING)$/.test(v.close_type); })],
        ['Security events', red],
        ['Items out / pending requests', openLoans.length + ' / ' + pendingReq.length]
      ],
      peak: peak,
      peaks: peaks,
      hours: shownHours,
      sections: [
        {
          heading: 'Hourly attendance distribution',
          columns: ['Hour', 'People present', 'Most at once'],
          rows: shownHours.map(function (x) { return [U.pad(x.hour) + ':00–' + U.pad(x.hour + 1) + ':00', x.people, x.peak]; })
        },
        {
          heading: 'Unreturned items',
          columns: ['Loan', 'Item', 'Borrower', 'Due (IST)', 'Status'],
          rows: openLoans.map(function (l) {
            return [l.loan_id, assetName[l.asset_id] || l.asset_id, l.borrower_email, U.fmt(l.due_at), l.due_at && l.due_at.getTime() < now.getTime() ? 'OVERDUE' : 'ON LOAN'];
          })
        },
        {
          heading: 'Pending requests',
          columns: ['Request', 'Item', 'Requested by', 'Since (IST)'],
          rows: pendingReq.map(function (r) { return [r.request_id, assetName[r.asset_id] || r.asset_id, r.requester_email, U.fmt(r.created_at)]; })
        }
      ]
    };
  },

  /** FR-30 monthly institutional audit (also used for FR-31 custom ranges). */
  period: function (labId, fromKey, toKey, data, kind) {
    var lab = Settings.lab(labId);
    data = data || Reports.load();
    var now = U.now();
    var from = U.istDate(fromKey, 0).getTime();
    var to = U.istDate(U.addDays(toKey, 1), 0).getTime();
    var periodEnd = Math.min(to, now.getTime());
    var visits = Reports.visitsIn(data.visits, lab.lab_id, from, to, now);
    var sessions = {};
    data.sessions.forEach(function (s) { sessions[s.id] = s; });

    // Course-wise student-hours: sum of (check-out − check-in), clipped to the period.
    var bySession = {};
    visits.forEach(function (v) {
      if (v.entry_type !== ENTRY_TYPES.COURSE && v.entry_type !== ENTRY_TYPES.EVENT) return;
      var label = Reports.sessionLabel(v, sessions);
      var k = v.course_or_event_id || 'U:' + label.code + '|' + label.name;
      if (!bySession[k]) bySession[k] = { ms: 0, students: {}, visits: 0, type: v.entry_type, code: label.code, name: label.name };
      bySession[k].ms += U.overlapMs(v.check_in_at.getTime(), Reports.visitEnd(v, now), from, to);
      bySession[k].students[v.email] = true;
      bySession[k].visits++;
    });
    var researchMs = 0;
    visits.forEach(function (v) {
      if (v.entry_type === ENTRY_TYPES.RESEARCH) researchMs += U.overlapMs(v.check_in_at.getTime(), Reports.visitEnd(v, now), from, to);
    });
    var sessionRows = Object.keys(bySession).map(function (k) {
      var b = bySession[k];
      return [b.type, b.code, b.name, Object.keys(b.students).length, b.visits, U.round(b.ms / 3600000, 1)];
    }).sort(function (a, b) { return b[5] - a[5]; });

    // GPU utilisation: hours reserved or issued ÷ hours available, within operating hours.
    var gpus = data.assets.filter(function (a) {
      return a.lab_id === lab.lab_id && a.category === 'GPU' && a.status !== STATUS.ASSET.RETIRED;
    });
    var availablePerUnit = Reports.openHoursOverlap(lab, from, to, fromKey, toKey);
    var gpuRows = gpus.map(function (a) {
      var intervals = [];
      data.loans.forEach(function (l) {
        if (l.asset_id === a.asset_id && l.issued_at) intervals.push([l.issued_at.getTime(), (l.returned_at || now).getTime()]);
      });
      data.requests.forEach(function (r) {
        if (r.asset_id !== a.asset_id || !r.created_at) return;
        var end = r.decided_at ? r.decided_at.getTime() : r.status === STATUS.REQUEST.PENDING ? now.getTime() : r.created_at.getTime();
        intervals.push([r.created_at.getTime(), end]);
      });
      var busy = 0;
      Reports.mergeIntervals(intervals).forEach(function (iv) {
        busy += Reports.openHoursOverlap(lab, iv[0], Math.min(iv[1], periodEnd), fromKey, toKey);
      });
      return { asset: a, busy: busy };
    });
    var busyTotal = gpuRows.reduce(function (s, x) { return s + x.busy; }, 0);
    var availTotal = availablePerUnit * gpus.length;
    var gpuUtil = availTotal ? busyTotal / availTotal : 0;

    // Sensor turnover: issue-and-return cycles per sensor type ÷ units of that type.
    var sensorTypes = {};
    data.assets.forEach(function (a) {
      if (a.lab_id === lab.lab_id && a.category === 'SENSOR' && a.status !== STATUS.ASSET.RETIRED) {
        sensorTypes[a.type] = sensorTypes[a.type] || { units: 0, cycles: 0 };
        sensorTypes[a.type].units++;
      }
    });
    var typeOf = {};
    data.assets.forEach(function (a) { typeOf[a.asset_id] = a; });
    data.loans.forEach(function (l) {
      var a = typeOf[l.asset_id];
      if (!a || a.lab_id !== lab.lab_id || a.category !== 'SENSOR' || !l.returned_at) return;
      var t = l.returned_at.getTime();
      if (t >= from && t < to && sensorTypes[a.type]) sensorTypes[a.type].cycles++;
    });

    var people = {};
    visits.forEach(function (v) { people[v.email] = true; });
    var studentHours = sessionRows.reduce(function (s, r) { return s + r[5]; }, 0) + researchMs / 3600000;
    var monthly = kind !== 'range';
    return {
      kind: monthly ? 'monthly' : 'range',
      filename: 'LabPulse_' + (monthly ? 'Monthly_' : 'Range_') + lab.lab_id + '_' + fromKey + (fromKey === toKey ? '' : '_to_' + toKey),
      title: monthly ? 'Monthly Institutional Audit' : 'Lab Usage Report',
      subtitle: lab.name + ' · ' + fromKey + ' to ' + toKey,
      kpis: [
        ['Unique visitors', Object.keys(people).length],
        ['Verified visits', visits.length],
        ['Student-hours (all)', U.round(studentHours, 1)],
        ['Research student-hours', U.round(researchMs / 3600000, 1)],
        ['GPU workstation utilisation', gpus.length ? U.round(gpuUtil * 100, 1) + '% of ' + U.round(availTotal, 1) + ' h' : 'No GPU workstations']
      ],
      gpuUtilisation: gpuUtil,
      sections: [
        {
          heading: 'Course-wise student-hours',
          columns: ['Type', 'Code', 'Name', 'Students', 'Visits', 'Student-hours'],
          rows: sessionRows,
          note: 'Auto-closed visits count only up to the time they were closed.'
        },
        {
          heading: 'GPU workstation utilisation',
          columns: ['Asset', 'Name', 'Reserved or issued (h)', 'Available (h)', 'Utilisation'],
          rows: gpuRows.map(function (x) {
            return [x.asset.asset_id, x.asset.name, U.round(x.busy, 1), U.round(availablePerUnit, 1),
              availablePerUnit ? U.round((x.busy / availablePerUnit) * 100, 1) + '%' : '—'];
          }),
          note: 'Hours reserved or issued, counted within operating hours, divided by operating hours in the period.'
        },
        {
          heading: 'Sensor turnover frequency',
          columns: ['Sensor type', 'Units', 'Issue-and-return cycles', 'Cycles per unit'],
          rows: Object.keys(sensorTypes).sort().map(function (t) {
            var x = sensorTypes[t];
            return [t, x.units, x.cycles, U.round(x.cycles / x.units, 2)];
          })
        }
      ]
    };
  },

  monthly: function (labId, year, month, data) {
    var fromKey = year + '-' + U.pad(month) + '-01';
    var nextMonth = month === 12 ? (year + 1) + '-01-01' : year + '-' + U.pad(month + 1) + '-01';
    return Reports.period(labId, fromKey, U.addDays(nextMonth, -1), data, 'monthly');
  },

  load: function () {
    return {
      visits: Db.all('Visits'),
      loans: Db.all('Loans'),
      requests: Db.all('Requests'),
      assets: Db.all('Assets'),
      sessions: Db.all('CoursesEvents'),
      audit: Db.tail('AuditLog', 5000)
    };
  },

  assetIndex: function (assets) {
    var idx = {};
    assets.forEach(function (a) { idx[a.asset_id] = a.name + ' (' + a.asset_id + ')'; });
    return idx;
  },

  details: function (v) {
    try {
      return typeof v.details === 'string' ? JSON.parse(v.details || '{}') : v.details || {};
    } catch (e) {
      return {};
    }
  },

  /** Code and name of a visit's course/event; sessions not in the timetable use what the student typed. */
  sessionLabel: function (v, sessions) {
    var s = sessions[v.course_or_event_id];
    if (s) return { code: s.code || '', name: s.name || '' };
    var d = Reports.details(v);
    return { code: d.code || '', name: (d.name || d.event_name || '') + (v.course_or_event_id ? '' : ' (not in timetable)') };
  },

  /* ---------- CSV / Excel (FR-31, FR-32) ---------- */

  VISIT_COLUMNS: [
    'visit_id', 'lab_id', 'student_email', 'student_name', 'reg_no', 'entry_type', 'course_or_event_id',
    'course_or_event_code', 'course_or_event_name', 'check_in_at', 'check_out_at', 'duration_minutes',
    'is_valid_geofence', 'confidence', 'review_status', 'close_type', 'status'
  ],
  LOAN_COLUMNS: [
    'loan_id', 'lab_id', 'asset_id', 'asset_name', 'asset_category', 'asset_type', 'borrower_email',
    'borrower_name', 'reg_no', 'issued_by', 'issued_at', 'due_at', 'returned_at', 'return_condition', 'status'
  ],

  csvCell: function (v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (/^[=+@\t\r]/.test(s) || /^-[^0-9]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  },

  toCsv: function (columns, rows) {
    var lines = [columns.join(',')];
    rows.forEach(function (r) {
      lines.push(columns.map(function (c) { return Reports.csvCell(r[c]); }).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  },

  /**
   * One flat table, fixed column names, ISO dates. Field-minimised: no mobile numbers.
   * Faculty may export only visits to sessions they coordinate; loans are staff-only.
   */
  exportRange: function (ctx, p) {
    p = p || {};
    if (!U.isDateKey(p.from) || !U.isDateKey(p.to) || p.from > p.to) fail_('INVALID', 'Choose a valid start and end date.');
    var lab = Settings.lab(p.labId);
    var dataset = U.str(p.dataset).toLowerCase() || 'visits';
    var from = U.istDate(p.from, 0);
    var to = U.istDate(U.addDays(p.to, 1), 0);
    var users = Attendance.userIndex();
    var rows;
    var columns;
    if (dataset === 'loans') {
      if (ctx.role === ROLES.FACULTY) {
        Audit.log(ctx, 'SECURITY_FORBIDDEN', 'export:loans', 'DENIED', 'Faculty cannot export loans', lab.lab_id);
        fail_('FORBIDDEN', 'Loan exports are available to lab staff only.');
      }
      var assets = {};
      Db.all('Assets').forEach(function (a) { assets[a.asset_id] = a; });
      columns = Reports.LOAN_COLUMNS;
      rows = Db.find('Loans', function (l) {
        return l.lab_id === lab.lab_id && l.issued_at && l.issued_at >= from && l.issued_at < to;
      }).map(function (l) {
        var a = assets[l.asset_id] || {};
        var u = users[l.borrower_email] || {};
        return {
          loan_id: l.loan_id, lab_id: l.lab_id, asset_id: l.asset_id, asset_name: a.name, asset_category: a.category,
          asset_type: a.type, borrower_email: l.borrower_email, borrower_name: u.name, reg_no: u.reg_no,
          issued_by: l.issued_by, issued_at: U.iso(l.issued_at), due_at: U.iso(l.due_at), returned_at: U.iso(l.returned_at),
          return_condition: l.return_condition, status: l.status
        };
      });
    } else {
      var sessions = {};
      Db.all('CoursesEvents').forEach(function (s) { sessions[s.id] = s; });
      var onlySession = U.str(p.sessionId);
      columns = Reports.VISIT_COLUMNS;
      rows = Db.find('Visits', function (v) {
        if (v.lab_id !== lab.lab_id || !v.check_in_at || v.check_in_at < from || v.check_in_at >= to) return false;
        if (onlySession && v.course_or_event_id !== onlySession) return false;
        if (ctx.role === ROLES.FACULTY) {
          var s = sessions[v.course_or_event_id];
          return !!s && s.coordinator_email === ctx.email;
        }
        return true;
      }).map(function (v) {
        var label = Reports.sessionLabel(v, sessions);
        var u = users[v.email] || {};
        return {
          visit_id: v.visit_id, lab_id: v.lab_id, student_email: v.email, student_name: u.name, reg_no: u.reg_no,
          entry_type: v.entry_type, course_or_event_id: v.course_or_event_id, course_or_event_code: label.code,
          course_or_event_name: label.name, check_in_at: U.iso(v.check_in_at), check_out_at: U.iso(v.check_out_at),
          duration_minutes: v.check_out_at ? Math.round((v.check_out_at - v.check_in_at) / 60000) : '',
          is_valid_geofence: U.truthy(v.is_valid_geofence) ? 'TRUE' : 'FALSE', confidence: v.confidence,
          review_status: v.review_status, close_type: v.close_type, status: v.status
        };
      });
    }
    var filename = 'labpulse_' + dataset + '_' + lab.lab_id + '_' + p.from + '_' + p.to + '.csv';
    var csv = Reports.toCsv(columns, rows);
    Audit.log(ctx, 'EXPORT', filename, 'OK', rows.length + ' rows', lab.lab_id);
    var out = { filename: filename, csv: csv, rows: rows.length };
    if (U.str(p.format).toLowerCase() === 'xlsx') {
      out.file = Reports.toXlsx(columns, rows, filename.replace(/\.csv$/, '.xlsx'), ctx.email);
    } else if (p.saveToDrive) {
      out.file = Reports.saveFile(Utilities.newBlob(csv, 'text/csv', filename), ctx.email);
    }
    return out;
  },

  /* ---------- PDF via Google Docs template (FR-32) ---------- */

  folder: function () {
    var g = Settings.global();
    if (g.reports_folder_id) {
      try { return DriveApp.getFolderById(g.reports_folder_id); } catch (e) { /* recreate below */ }
    }
    var f = DriveApp.createFolder('LabPulse Reports');
    Reports.saveGlobalKey('reports_folder_id', f.getId());
    return f;
  },

  saveGlobalKey: function (key, value) {
    var props = Settings.props();
    var raw = props.getProperty('APP_SETTINGS');
    var saved = raw ? JSON.parse(raw) : {};
    saved[key] = value;
    props.setProperty('APP_SETTINGS', JSON.stringify(saved));
  },

  templateId: function () {
    var g = Settings.global();
    if (g.template_doc_id) {
      try { DriveApp.getFileById(g.template_doc_id); return g.template_doc_id; } catch (e) { /* recreate below */ }
    }
    var doc = DocumentApp.create('LabPulse Report Template');
    var body = doc.getBody();
    body.clear();
    body.appendParagraph('LabPulse · Karunya Institute of Technology and Sciences').setHeading(DocumentApp.ParagraphHeading.SUBTITLE);
    body.appendParagraph('{{TITLE}}').setHeading(DocumentApp.ParagraphHeading.TITLE);
    body.appendParagraph('{{SUBTITLE}}').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    body.appendParagraph('Generated {{GENERATED_AT}} IST');
    body.appendParagraph('{{KPIS}}');
    body.appendParagraph('{{BODY}}');
    body.appendParagraph('Figures are computed from LabPulse records. Coordinates are never stored; occupancy and the lab map reflect app records, not physical sensors.')
      .editAsText().setItalic(true);
    doc.saveAndClose();
    DriveApp.getFileById(doc.getId()).moveTo(Reports.folder());
    Reports.saveGlobalKey('template_doc_id', doc.getId());
    return doc.getId();
  },

  placeholderIndex: function (body, tag) {
    var found = body.findText('\\{\\{' + tag + '\\}\\}');
    if (!found) return -1;
    var el = found.getElement();
    while (el.getParent() && el.getParent().getType() !== DocumentApp.ElementType.BODY_SECTION) el = el.getParent();
    var idx = body.getChildIndex(el);
    el.removeFromParent();
    return idx;
  },

  insertTable: function (body, idx, columns, rows) {
    if (!rows.length) {
      body.insertParagraph(idx, 'No records for this period.').editAsText().setItalic(true);
      return idx + 1;
    }
    var cells = [columns.map(String)].concat(rows.map(function (r) { return r.map(function (c) { return String(c); }); }));
    var table = body.insertTable(idx, cells);
    var header = table.getRow(0);
    for (var i = 0; i < header.getNumCells(); i++) header.getCell(i).editAsText().setBold(true);
    return idx + 1;
  },

  toPdf: function (report, shareWith) {
    var folder = Reports.folder();
    var copy = DriveApp.getFileById(Reports.templateId()).makeCopy(report.filename, folder);
    var doc = DocumentApp.openById(copy.getId());
    var body = doc.getBody();
    body.replaceText('\\{\\{TITLE\\}\\}', report.title);
    body.replaceText('\\{\\{SUBTITLE\\}\\}', report.subtitle);
    body.replaceText('\\{\\{GENERATED_AT\\}\\}', U.fmt(U.now()));

    var idx = Reports.placeholderIndex(body, 'KPIS');
    if (idx >= 0) Reports.insertTable(body, idx, ['Measure', 'Value'], report.kpis);

    idx = Reports.placeholderIndex(body, 'BODY');
    if (idx >= 0) {
      report.sections.forEach(function (s) {
        body.insertParagraph(idx++, s.heading).setHeading(DocumentApp.ParagraphHeading.HEADING2);
        idx = Reports.insertTable(body, idx, s.columns, s.rows);
        if (s.note) body.insertParagraph(idx++, s.note).editAsText().setItalic(true);
      });
    }
    doc.saveAndClose();
    var pdf = copy.getAs('application/pdf').setName(report.filename + '.pdf');
    copy.setTrashed(true);
    return Reports.saveFile(pdf, shareWith);
  },

  /**
   * Excel export: write the same flat table to a temporary Google Sheet, export it as .xlsx
   * through Drive, save the file in the reports folder and delete the temporary sheet.
   */
  toXlsx: function (columns, rows, filename, shareWith) {
    var tmp = SpreadsheetApp.create(filename);
    try {
      var values = [columns].concat(rows.map(function (r) {
        return columns.map(function (c) { return r[c] === null || r[c] === undefined ? '' : String(r[c]); });
      }));
      tmp.getSheets()[0].getRange(1, 1, values.length, columns.length).setNumberFormat('@').setValues(values);
      SpreadsheetApp.flush();
      var resp = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + tmp.getId() + '/export?format=xlsx', {
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() !== 200) fail_('SERVER', 'Excel export failed (HTTP ' + resp.getResponseCode() + '). The CSV export still works.');
      return Reports.saveFile(resp.getBlob().setName(filename), shareWith);
    } finally {
      DriveApp.getFileById(tmp.getId()).setTrashed(true);
    }
  },

  saveFile: function (blob, shareWith) {
    var file = Reports.folder().createFile(blob);
    if (shareWith) {
      try { file.addViewer(shareWith); } catch (e) { console.warn('Could not share ' + file.getName() + ' with ' + shareWith); }
    }
    return { id: file.getId(), name: file.getName(), url: file.getUrl() };
  },

  toHtml: function (report) {
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function table(columns, rows) {
      if (!rows.length) return '<p style="color:#64748b"><i>No records for this period.</i></p>';
      return '<table style="border-collapse:collapse;font-size:13px">' +
        '<tr>' + columns.map(function (c) { return '<th style="text-align:left;border-bottom:2px solid #cbd5e1;padding:4px 10px">' + esc(c) + '</th>'; }).join('') + '</tr>' +
        rows.map(function (r) {
          return '<tr>' + r.map(function (c) { return '<td style="border-bottom:1px solid #e2e8f0;padding:4px 10px">' + esc(c) + '</td>'; }).join('') + '</tr>';
        }).join('') + '</table>';
    }
    return '<div style="font-family:Arial,sans-serif;color:#0f172a">' +
      '<h2 style="margin:0">' + esc(report.title) + '</h2><p style="color:#475569;margin-top:4px">' + esc(report.subtitle) + '</p>' +
      table(['Measure', 'Value'], report.kpis) +
      report.sections.map(function (s) {
        return '<h3 style="margin-top:20px">' + esc(s.heading) + '</h3>' + table(s.columns, s.rows) +
          (s.note ? '<p style="color:#64748b;font-size:12px"><i>' + esc(s.note) + '</i></p>' : '');
      }).join('') +
      '<p style="color:#94a3b8;font-size:11px;margin-top:24px">Sent by LabPulse. Times are IST.</p></div>';
  },

  /** FR-33: end-of-day summary to the lab in-charge, with the PDF attached. */
  emailReport: function (report, lab, pdf) {
    var to = [lab.incharge_email].concat(Settings.global().report_recipients).filter(function (e, i, a) {
      return e && a.indexOf(e) === i;
    });
    if (!to.length) return 0;
    var opts = { htmlBody: Reports.toHtml(report), name: 'LabPulse' };
    if (pdf) opts.attachments = [DriveApp.getFileById(pdf.id).getBlob()];
    GmailApp.sendEmail(to.join(','), '[LabPulse] ' + report.title + ' — ' + report.subtitle, report.title + ' — ' + report.subtitle + '\n\nThe PDF is attached.', opts);
    return to.length;
  },

  /* ---------- session log and Lab Passport ---------- */

  sessionLogPdf: function (ctx, p) {
    var r = Monitoring.roster(ctx, p);
    var rows = [];
    [['present', 'Present'], ['pending', 'Pending review'], ['absent', 'Absent (marked)'], ['notArrived', 'Not arrived']].forEach(function (g) {
      r.roster[g[0]].forEach(function (x) {
        rows.push([x.reg_no, x.name, g[1], x.check_in_at ? U.fmt(new Date(x.check_in_at)) : '', x.check_out_at ? U.fmt(new Date(x.check_out_at)) : '', x.confidence, x.mark_reason]);
      });
    });
    var report = {
      filename: 'LabPulse_Session_' + r.session.code + '_' + r.date,
      title: 'Session Attendance Log',
      subtitle: r.session.code + ' ' + r.session.name + ' · ' + r.date,
      kpis: [['Present', r.roster.present.length], ['Pending review', r.roster.pending.length], ['Absent', r.roster.absent.length], ['Not arrived', r.roster.notArrived.length]],
      sections: [{ heading: 'Roster', columns: ['Reg. no', 'Name', 'Status', 'Check-in', 'Check-out', 'Confidence', 'Note'], rows: rows }]
    };
    Audit.log(ctx, 'EXPORT', report.filename + '.pdf', 'OK', rows.length + ' rows', r.session.lab_id);
    return Reports.toPdf(report, ctx.email);
  },

  /** FR-34 (P2): one-page PDF of a student's verified hours, courses and equipment handled. */
  passport: function (ctx) {
    var now = U.now();
    var sessions = {};
    Db.all('CoursesEvents').forEach(function (s) { sessions[s.id] = s; });
    var visits = Db.find('Visits', function (v) { return v.email === ctx.email && Reports.isVerified(v) && v.check_out_at; });
    var total = 0;
    var byCourse = {};
    visits.forEach(function (v) {
      var ms = Reports.visitEnd(v, now) - v.check_in_at.getTime();
      total += ms;
      var s = sessions[v.course_or_event_id];
      var key = s ? s.code + ' — ' + s.name : 'Individual research';
      byCourse[key] = (byCourse[key] || 0) + ms;
    });
    var assets = {};
    Db.all('Assets').forEach(function (a) { assets[a.asset_id] = a; });
    var handled = {};
    Db.find('Loans', function (l) { return l.borrower_email === ctx.email && l.status === STATUS.LOAN.RETURNED; }).forEach(function (l) {
      var a = assets[l.asset_id];
      var t = a ? a.type : l.asset_id;
      handled[t] = (handled[t] || 0) + 1;
    });
    var report = {
      filename: 'LabPulse_Passport_' + ctx.user.reg_no + '_' + U.dateKey(now),
      title: 'Lab Passport',
      subtitle: ctx.user.name + ' · ' + ctx.user.reg_no,
      kpis: [['Verified lab hours', U.round(total / 3600000, 1)], ['Verified visits', visits.length], ['Equipment types handled', Object.keys(handled).length]],
      sections: [
        { heading: 'Hours by course or activity', columns: ['Course / activity', 'Hours'], rows: Object.keys(byCourse).sort().map(function (k) { return [k, U.round(byCourse[k] / 3600000, 1)]; }) },
        { heading: 'Equipment handled', columns: ['Type', 'Times borrowed and returned'], rows: Object.keys(handled).sort().map(function (k) { return [k, handled[k]]; }) }
      ]
    };
    var html = '<html><body style="font-family:Arial,sans-serif;padding:24px">' + Reports.toHtml(report) +
      '<p style="font-size:11px;color:#64748b">Issued ' + U.fmt(now) + ' IST. Only completed, verified visits are counted.</p></body></html>';
    var pdf = Utilities.newBlob(html, 'text/html', report.filename + '.html').getAs('application/pdf').setName(report.filename + '.pdf');
    Audit.log(ctx, 'PASSPORT', report.filename, 'OK', '', '');
    return Reports.saveFile(pdf, ctx.email);
  }
};
