/**
 * Google Sheets as the database (SRS §7).
 *
 * Each tab is read in one batched call and memoised for the rest of the execution.
 * Rows come back as plain objects with a hidden `_row` (sheet row number) used for
 * in-place updates. Writes that depend on reads must run inside withLock_().
 */
var Db = (function () {
  var ss_ = null;
  var tables_ = {};
  var indexes_ = {}; // table -> column -> Map(value -> first row with it), built on first use

  // Tabs whose first column is not a unique ID (or that are append-only logs too large to check).
  var NON_UNIQUE_ = { AuditLog: true, UsageDaily: true, AssetUsageDaily: true, Enrollments: true };

  function dropIndexes(name) {
    delete indexes_[name];
  }

  function spreadsheet() {
    if (ss_) return ss_;
    var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    ss_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
    if (!ss_) fail_('NOT_SETUP', 'LabPulse is not set up yet. Run setup() from the Apps Script editor.');
    return ss_;
  }

  function sheet(name) {
    var sh = spreadsheet().getSheetByName(name);
    if (!sh) fail_('NOT_SETUP', 'Missing sheet "' + name + '". Run setup() from the Apps Script editor.');
    return sh;
  }

  function cols(name) {
    var c = SHEETS[name];
    if (!c) fail_('INTERNAL', 'Unknown table ' + name);
    return c;
  }

  /**
   * A text column that lost its plain-text format (e.g. a hand edit) comes back as a Date.
   * Restore the text it was meant to hold: a time for 1899-12-30 values, otherwise a date key.
   */
  function textFromDate(d) {
    return d.getFullYear() < 1901 ? U.pad(d.getHours()) + ':' + U.pad(d.getMinutes()) : U.dateKey(d);
  }

  function toObj(name, values, rowNum) {
    var c = cols(name);
    var o = {};
    for (var i = 0; i < c.length; i++) {
      var v = values[i];
      if (isDateColumn_(c[i])) o[c[i]] = U.toDate(v);
      else if (Object.prototype.toString.call(v) === '[object Date]') o[c[i]] = textFromDate(v);
      else o[c[i]] = v === null || v === undefined ? '' : String(v);
    }
    Object.defineProperty(o, '_row', { value: rowNum, writable: true, enumerable: false });
    return o;
  }

  function toRow(name, obj) {
    return cols(name).map(function (k) {
      var v = obj[k];
      if (v === null || v === undefined) return '';
      if (isDateColumn_(k)) return U.toDate(v) || '';
      if (v === true) return 'TRUE';
      if (v === false) return 'FALSE';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    });
  }

  function all(name) {
    if (tables_[name]) return tables_[name];
    var sh = sheet(name);
    var last = sh.getLastRow();
    var rows = [];
    if (last >= 2) {
      var values = sh.getRange(2, 1, last - 1, cols(name).length).getValues();
      for (var i = 0; i < values.length; i++) {
        if (values[i].join('') === '') continue; // skip blank rows left by manual edits
        rows.push(toObj(name, values[i], i + 2));
      }
    }
    tables_[name] = rows;
    return rows;
  }

  function find(name, pred) {
    return all(name).filter(pred);
  }

  function findOne(name, pred) {
    var rows = all(name);
    for (var i = 0; i < rows.length; i++) if (pred(rows[i])) return rows[i];
    return null;
  }

  /** Indexed lookup: the first row whose `key` column equals `value`. O(1) after the first call. */
  function findBy(name, key, value) {
    var byTable = indexes_[name] || (indexes_[name] = {});
    var idx = byTable[key];
    if (!idx) {
      idx = byTable[key] = new Map();
      all(name).forEach(function (r) {
        if (!idx.has(r[key])) idx.set(r[key], r);
      });
    }
    return idx.get(value) || null;
  }

  function byId(name, id) {
    return findBy(name, cols(name)[0], id);
  }

  function insert(name, obj) {
    var key = cols(name)[0];
    if (!obj[key]) fail_('INVALID', name + ': ' + key + ' is required');
    if (!NON_UNIQUE_[name] && byId(name, String(obj[key]))) fail_('INVALID', name + ': ' + key + ' "' + obj[key] + '" already exists');
    var row = toRow(name, obj);
    var sh = sheet(name);
    sh.appendRow(row);
    var stored = toObj(name, row, sh.getLastRow());
    if (tables_[name]) tables_[name].push(stored);
    var byTable = indexes_[name] || {};
    Object.keys(byTable).forEach(function (k) {
      if (!byTable[k].has(stored[k])) byTable[k].set(stored[k], stored);
    });
    return stored;
  }

  function insertMany(name, objs) {
    if (!objs.length) return;
    var sh = sheet(name);
    var start = sh.getLastRow() + 1;
    var rows = objs.map(function (o) {
      return toRow(name, o);
    });
    sh.getRange(start, 1, rows.length, cols(name).length).setValues(rows);
    delete tables_[name];
    dropIndexes(name);
  }

  /** Writes patch into the stored row (and the cached object) in one range call. */
  function update(name, rowObj, patch) {
    if (!rowObj || !rowObj._row) fail_('INTERNAL', 'update() needs a row read from ' + name);
    Object.keys(patch).forEach(function (k) {
      if (cols(name).indexOf(k) === -1) fail_('INTERNAL', name + ' has no column ' + k);
      rowObj[k] = patch[k];
    });
    var row = toRow(name, rowObj);
    sheet(name).getRange(rowObj._row, 1, 1, row.length).setValues([row]);
    // Keep the cached copy consistent with what the sheet now holds.
    var normalised = toObj(name, row, rowObj._row);
    Object.keys(normalised).forEach(function (k) {
      rowObj[k] = normalised[k];
    });
    // An indexed column changed value: rebuild that table's indexes on next use.
    var byTable = indexes_[name];
    if (byTable && Object.keys(patch).some(function (k) { return byTable[k]; })) dropIndexes(name);
    return rowObj;
  }

  function remove(name, rowObj) {
    sheet(name).deleteRow(rowObj._row);
    delete tables_[name];
    dropIndexes(name);
  }

  /** Replaces every data row; used to rebuild ActiveVisits during reconciliation. */
  function replaceAll(name, objs) {
    var sh = sheet(name);
    var last = sh.getLastRow();
    if (last >= 2) sh.getRange(2, 1, last - 1, cols(name).length).clearContent();
    if (last > 2 + objs.length) sh.deleteRows(2 + objs.length, last - 1 - objs.length);
    if (objs.length) {
      var rows = objs.map(function (o) {
        return toRow(name, o);
      });
      sh.getRange(2, 1, rows.length, cols(name).length).setValues(rows);
    }
    delete tables_[name];
    dropIndexes(name);
  }

  /** Last n rows without reading the whole tab (activity stream, audit tail). */
  function tail(name, n) {
    var sh = sheet(name);
    var last = sh.getLastRow();
    if (last < 2) return [];
    var count = Math.min(n, last - 1);
    var first = last - count + 1;
    var values = sh.getRange(first, 1, count, cols(name).length).getValues();
    return values.map(function (v, i) {
      return toObj(name, v, first + i);
    });
  }

  function reset() {
    tables_ = {};
    indexes_ = {};
  }

  return {
    spreadsheet: spreadsheet,
    sheet: sheet,
    all: all,
    find: find,
    findOne: findOne,
    byId: byId,
    findBy: findBy,
    insert: insert,
    insertMany: insertMany,
    update: update,
    remove: remove,
    replaceAll: replaceAll,
    tail: tail,
    reset: reset,
    forget: function () {
      ss_ = null;
      tables_ = {};
      indexes_ = {};
    }
  };
})();
