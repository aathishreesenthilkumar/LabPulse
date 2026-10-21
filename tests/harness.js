/**
 * Loads the Apps Script sources into a Node vm context with in-memory fakes of the Google
 * services they use, so the server logic can be tested without deploying.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { createDocsAndDrive, createTriggers } = require('./fake-google');

const SRC = path.join(__dirname, '..', 'src');

function makeSheet(name) {
  let rows = []; // rows[0] is the header row
  const sheet = {
    getName: () => name,
    getLastRow: () => rows.length,
    getMaxRows: () => Math.max(1000, rows.length),
    setFrozenRows: () => sheet,
    appendRow: (r) => { rows.push(r.slice()); return sheet; },
    deleteRow: (n) => { rows.splice(n - 1, 1); return sheet; },
    deleteRows: (n, count) => { rows.splice(n - 1, count); return sheet; },
    getRange: (r, c, nr = 1, nc = 1) => ({
      getValues: () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const src = rows[r - 1 + i] || [];
          const row = [];
          for (let j = 0; j < nc; j++) {
            const v = src[c - 1 + j];
            row.push(v === undefined ? '' : v instanceof Date ? new Date(v.getTime()) : v);
          }
          out.push(row);
        }
        return out;
      },
      setValues: (vals) => {
        for (let i = 0; i < vals.length; i++) {
          while (rows.length < r + i) rows.push([]);
          const row = rows[r - 1 + i];
          for (let j = 0; j < vals[i].length; j++) row[c - 1 + j] = vals[i][j];
        }
        return { setFontWeight: () => {} };
      },
      clearContent: () => {
        for (let i = 0; i < nr; i++) {
          const row = rows[r - 1 + i];
          if (row) for (let j = 0; j < nc; j++) row[c - 1 + j] = '';
        }
      },
      setNumberFormat() { return this; },
      setFontWeight: () => {}
    }),
    _rows: () => rows
  };
  return sheet;
}

function makeSpreadsheet(id) {
  const sheets = {};
  return {
    getId: () => id || 'SS-TEST',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/SS-TEST',
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n)),
    getSheets: () => Object.values(sheets),
    deleteSheet: (s) => delete sheets[s.getName()],
    setSpreadsheetTimeZone: () => {},
    _sheets: sheets
  };
}

function createEnv() {
  const clock = { ms: Date.UTC(2026, 9, 19, 5, 0, 0) }; // Mon 19 Oct 2026, 10:30 IST
  const cacheStore = new Map();
  const props = new Map();
  const ss = makeSpreadsheet();
  const session = { active: '', effective: 'owner@karunya.edu' };
  const mail = [];
  const created = []; // spreadsheets made with SpreadsheetApp.create
  const drive = { files: [], trashed: [], fetched: [], copies: [] };
  let lockHeld = false;

  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(clock.ms); else super(...a); }
    static now() { return clock.ms; }
  }

  const cache = {
    get: (k) => {
      const e = cacheStore.get(k);
      if (!e) return null;
      if (e.exp <= clock.ms) { cacheStore.delete(k); return null; }
      return e.v;
    },
    put: (k, v, ttl) => cacheStore.set(k, { v: String(v), exp: clock.ms + (ttl || 600) * 1000 }),
    remove: (k) => cacheStore.delete(k)
  };

  const folder = {
    getId: () => 'FOLDER',
    createFile: (blob) => {
      const f = { id: 'F' + drive.files.length, name: blob.name };
      drive.files.push(f);
      return { getId: () => f.id, getName: () => f.name, getUrl: () => 'https://drive/' + f.id, addViewer: () => {} };
    }
  };
  const gdocs = createDocsAndDrive(drive, folder);
  const trig = createTriggers();
  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => ctx.__errors.push(a.join(' ')) },
    __errors: [],
    Date: FakeDate,
    JSON, Math, Object, Array, String, Number, Error, RegExp, isFinite, isNaN, parseInt, parseFloat,
    SpreadsheetApp: {
      openById: (id) => created.find((s) => s.getId() === id) || ss,
      getActiveSpreadsheet: () => ss,
      create: (name) => {
        const extra = makeSpreadsheet('SS-' + name);
        extra.insertSheet('Sheet1');
        created.push(extra);
        return extra;
      },
      flush: () => {}
    },
    CacheService: { getScriptCache: () => cache },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { if (lockHeld) return false; lockHeld = true; return true; },
        waitLock: () => { lockHeld = true; },
        releaseLock: () => { lockHeld = false; }
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, String(v)),
        deleteProperty: (k) => props.delete(k)
      })
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => session.active }),
      getEffectiveUser: () => ({ getEmail: () => session.effective })
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (value, key) => Array.from(crypto.createHmac('sha256', key).update(value).digest()).map((b) => (b > 127 ? b - 256 : b)),
      base64DecodeWebSafe: (s) => Array.from(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')).map((b) => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => (b < 0 ? b + 256 : b))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      newBlob: (data, type, name) => ({ data, type, name, getAs: () => ({ setName() { return this; } }) })
    },
    GmailApp: { sendEmail: (to, subject, body, opts) => mail.push({ to, subject, body, opts }) },
    ScriptApp: Object.assign({ getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }), getOAuthToken: () => 'TOKEN' }, trig.ScriptAppTriggers),
    DocumentApp: gdocs.DocumentApp,
    UrlFetchApp: {
      fetch: (url, opts) => {
        drive.fetched.push({ url, opts });
        return { getResponseCode: () => 200, getBlob: () => ({ name: '', url, setName(n) { this.name = n; return this; } }) };
      }
    },
    DriveApp: {
      getFolderById: () => folder,
      createFolder: () => folder,
      getFileById: (id) => gdocs.fileFor(id)
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } })
    },
    HtmlService: {
      XFrameOptionsMode: { DEFAULT: 'DEFAULT' },
      createTemplateFromFile: (file) => {
        const tpl = {
          evaluate: () => {
            const out = { file, boot: JSON.parse(tpl.bootJson.replace(/\\u003c/g, '<')) };
            out.setTitle = out.addMetaTag = out.setXFrameOptionsMode = () => out;
            return out;
          }
        };
        return tpl;
      },
      createHtmlOutputFromFile: (f) => ({ getContent: () => fs.readFileSync(path.join(SRC, f + '.html'), 'utf8') })
    }
  };
  vm.createContext(ctx);
  fs.readdirSync(SRC)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f }));

  // Create the sheets the way setup() would.
  vm.runInContext('Object.keys(SHEETS).forEach(function(n){ var sh = Db.spreadsheet().getSheetByName(n) || Db.spreadsheet().insertSheet(n); sh.appendRow(SHEETS[n]); });', ctx);

  return {
    ctx,
    clock,
    session,
    mail,
    ss,
    created,
    drive,
    gdocs,
    triggers: trig.triggers,
    run: (code) => vm.runInContext(code, ctx),
    /** Calls the public api() as `email`, the way google.script.run would. */
    as: (email) => (action, payload) => {
      session.active = email;
      ctx.Db.reset();
      return JSON.parse(JSON.stringify(ctx.api(action, payload || {})));
    },
    advance: (sec) => { clock.ms += sec * 1000; },
    setIst: (dateKey, hhmm) => {
      const [h, m] = hhmm.split(':').map(Number);
      const [y, mo, d] = dateKey.split('-').map(Number);
      clock.ms = Date.UTC(y, mo - 1, d, h, m) - 330 * 60000;
    },
    rows: (name) => ss.getSheetByName(name)._rows()
  };
}

module.exports = { createEnv };
