/**
 * In-memory fakes of DocumentApp, Drive files and ScriptApp triggers — enough of each API for
 * LabPulse's report PDFs, backups and trigger installation to run end to end in tests.
 * They mirror the calls LabPulse makes; they are not complete copies of Google's services.
 */
'use strict';

function createDocsAndDrive(drive, folder) {
  const docs = new Map();
  let nextId = 1;

  function paragraph(text) {
    const p = {
      kind: 'p', text: String(text), heading: null, italic: false,
      setHeading(h) { p.heading = h; return p; },
      editAsText() { return { setItalic(v) { p.italic = !!v; return this; }, setBold() { return this; } }; },
      getType: () => 'PARAGRAPH'
    };
    return p;
  }

  function table(cells) {
    if (!Array.isArray(cells) || !cells.length || !cells.every((r) => Array.isArray(r) && r.length)) {
      throw new Error('insertTable needs a non-empty 2-D array of strings');
    }
    return {
      kind: 'table', cells: cells.map((r) => r.map(String)),
      getRow: (i) => ({ getNumCells: () => cells[i].length, getCell: () => ({ editAsText: () => ({ setBold() { return this; } }) }) }),
      getType: () => 'TABLE'
    };
  }

  function makeDoc(name, blocks) {
    const id = 'DOC-' + nextId++;
    const doc = { id, name, blocks: blocks || [], closed: false };
    const body = {
      getType: () => 'BODY_SECTION',
      clear() { doc.blocks = []; return body; },
      appendParagraph(t) { const p = paragraph(t); doc.blocks.push(p); return p; },
      insertParagraph(i, t) { const p = paragraph(t); doc.blocks.splice(i, 0, p); return p; },
      insertTable(i, cells) { const t = table(cells); doc.blocks.splice(i, 0, t); return t; },
      replaceText(pattern, repl) {
        const re = new RegExp(pattern, 'g');
        doc.blocks.forEach((b) => { if (b.kind === 'p') b.text = b.text.replace(re, () => repl); });
        return body;
      },
      findText(pattern) {
        const re = new RegExp(pattern);
        const p = doc.blocks.find((b) => b.kind === 'p' && re.test(b.text));
        if (!p) return null;
        p.getParent = () => body;
        p.removeFromParent = () => { doc.blocks.splice(doc.blocks.indexOf(p), 1); };
        const textEl = { getParent: () => p, getType: () => 'TEXT' };
        return { getElement: () => textEl };
      },
      getChildIndex(el) {
        const i = doc.blocks.indexOf(el);
        if (i === -1) throw new Error('Element is not a child of the body');
        return i;
      }
    };
    doc.api = { getId: () => id, getBody: () => body, saveAndClose: () => { doc.closed = true; } };
    docs.set(id, doc);
    return doc;
  }

  function render(doc) {
    return doc.blocks.map((b) => (b.kind === 'p' ? b.text : b.cells.map((r) => r.join(' | ')).join('\n'))).join('\n');
  }

  function fileFor(id) {
    const doc = docs.get(id);
    const file = {
      getId: () => id,
      getName: () => (doc ? doc.name : id),
      getUrl: () => 'https://drive/' + id,
      setTrashed: (v) => { if (v) drive.trashed.push(id); return file; },
      moveTo: () => file,
      addViewer: () => file,
      getBlob: () => ({ name: file.getName(), text: doc ? render(doc) : '' }),
      makeCopy: (name) => {
        if (doc) {
          const copy = makeDoc(name, doc.blocks.map((b) => Object.assign({}, b)));
          return fileFor(copy.id);
        }
        drive.copies.push({ from: id, name });
        return fileFor('COPY-' + drive.copies.length);
      },
      getAs: (mime) => {
        if (!doc) throw new Error('getAs on a non-document file');
        if (!doc.closed) throw new Error('Document must be saved and closed before export');
        return { mime, name: doc.name, text: render(doc), setName(n) { this.name = n; return this; } };
      }
    };
    return file;
  }

  folder.getFiles = () => {
    const list = drive.files.slice();
    let i = 0;
    return { hasNext: () => i < list.length, next: () => { const f = list[i++]; return fileFor(f.id); } };
  };
  folder.addFile = () => folder;

  const DocumentApp = {
    ParagraphHeading: { TITLE: 'TITLE', SUBTITLE: 'SUBTITLE', HEADING1: 'HEADING1', HEADING2: 'HEADING2' },
    ElementType: { BODY_SECTION: 'BODY_SECTION', PARAGRAPH: 'PARAGRAPH' },
    create: (name) => makeDoc(name).api,
    openById: (id) => {
      const d = docs.get(id);
      if (!d) throw new Error('No document ' + id);
      d.closed = false;
      return d.api;
    }
  };

  return { DocumentApp, fileFor, docs };
}

function createTriggers() {
  const triggers = [];
  const ScriptAppTriggers = {
    getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.fn, _t: t })),
    deleteTrigger: (t) => { const i = triggers.indexOf(t._t); if (i !== -1) triggers.splice(i, 1); },
    newTrigger: (fn) => {
      const t = { fn, spec: {} };
      const builder = {
        timeBased: () => builder,
        everyMinutes: (n) => { if ([1, 5, 10, 15, 30].indexOf(n) === -1) throw new Error('everyMinutes must be 1, 5, 10, 15 or 30'); t.spec.minutes = n; return builder; },
        everyHours: (n) => { t.spec.hours = n; return builder; },
        everyDays: (n) => { t.spec.days = n; return builder; },
        atHour: (h) => { t.spec.atHour = h; return builder; },
        onMonthDay: (d) => { t.spec.monthDay = d; return builder; },
        inTimezone: (z) => { t.spec.tz = z; return builder; },
        create: () => { triggers.push(t); return t; }
      };
      return builder;
    }
  };
  return { ScriptAppTriggers, triggers };
}

module.exports = { createDocsAndDrive, createTriggers };
