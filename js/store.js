/* TF.store - persistence (localStorage), JSON/CSV import-export and undo/redo history. */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  root.TF = root.TF || {};
  const D = root.TF.dates;
  const M = root.TF.model;

  const KEY = 'tf-gantt-v1';
  const CSV_HEADER = ['WBS', 'Name', 'Level', 'Owner', 'Start', 'End', 'Percent Complete', 'Milestone', 'URC', 'Predecessors', 'Notes'];

  // ---------------------------------------------------------------- localStorage

  function storage() {
    try {
      return typeof root.localStorage !== 'undefined' && root.localStorage ? root.localStorage : null;
    } catch (e) {
      return null; // access itself can throw (blocked storage)
    }
  }

  function load() {
    try {
      const ls = storage();
      if (!ls) return null;
      const text = ls.getItem(KEY);
      if (!text) return null;
      return M.normalize(JSON.parse(text));
    } catch (e) {
      return null;
    }
  }

  function save(project) {
    try {
      const ls = storage();
      if (!ls) return false;
      ls.setItem(KEY, JSON.stringify(project));
      return true;
    } catch (e) {
      return false; // quota exceeded, blocked, etc.
    }
  }

  // ---------------------------------------------------------------- JSON

  function toJSON(project) {
    return JSON.stringify(project, null, 2);
  }

  function fromJSON(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('That file is not valid JSON (' + e.message + ').');
    }
    try {
      return M.normalize(data);
    } catch (e) {
      throw new Error('That JSON is not a schedule: ' + e.message);
    }
  }

  // ---------------------------------------------------------------- CSV

  function csvField(v) {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(project) {
    const rs = M.rows(project);
    const summaryIds = new Set(rs.filter((r) => r.isSummary).map((r) => r.task.id));
    const wbsById = new Map(rs.map((r) => [r.task.id, r.wbs]));
    const lines = [CSV_HEADER.map(csvField).join(',')];
    for (const r of rs) {
      const t = r.task;
      // Summaries carry no dependencies in CSV, and links into summaries are ignored by scheduling anyway.
      const deps = r.isSummary ? '' : t.deps
        .filter((d) => wbsById.has(d.id) && !summaryIds.has(d.id))
        .map((d) => wbsById.get(d.id) + (d.lag > 0 ? '+' + d.lag : d.lag < 0 ? String(d.lag) : ''))
        .join(', ');
      lines.push([
        r.wbs, t.name, t.level, t.owner, r.start, r.end, r.progress,
        t.milestone ? 'Yes' : 'No', t.urc ? 'Yes' : 'No', deps, t.notes,
      ].map(csvField).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  /** RFC 4180 parser: quoted fields, doubled quotes, embedded commas/newlines, CRLF or LF. */
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += c;
      } else if (c === '"' && field === '') {
        inQ = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\r' || c === '\n') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else field += c;
    }
    if (inQ) throw new Error('The CSV has an unterminated quoted field.');
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
  }

  const HEADER_ALIASES = {
    wbs: 'wbs', name: 'name', task: 'name', 'task name': 'name', level: 'level', owner: 'owner',
    start: 'start', end: 'end', finish: 'end',
    'percent complete': 'progress', percent: 'progress', '% complete': 'progress', progress: 'progress', '%': 'progress',
    milestone: 'milestone', urc: 'urc',
    predecessors: 'deps', predecessor: 'deps', dependencies: 'deps', deps: 'deps',
    notes: 'notes', note: 'notes',
  };

  function truthy(s) {
    return /^(1|true|yes|y|x)$/i.test(String(s || '').trim());
  }

  function fromCSV(text) {
    const table = parseCSV(text);
    if (!table.length) throw new Error('The CSV file is empty.');
    const colOf = {};
    table[0].forEach((h, i) => {
      const key = HEADER_ALIASES[h.trim().toLowerCase().replace(/\s+/g, ' ')];
      if (key && !(key in colOf)) colOf[key] = i;
    });
    if (!('name' in colOf)) throw new Error('The CSV needs a "Name" column in its header row.');
    const cell = (row, key) => {
      if (!(key in colOf) || colOf[key] >= row.length) return '';
      return key === 'notes' ? row[colOf[key]] : row[colOf[key]].trim(); // notes keep their whitespace
    };

    const base = M.newProject();
    const used = new Set();
    const raw = [];
    const depText = new Map();
    const rowNo = new Map();
    for (let r = 1; r < table.length; r++) {
      const row = table[r];
      const n = r + 1; // 1-based row number in the file, header is row 1
      const name = cell(row, 'name');
      if (!name && row.every((c) => !c.trim())) continue;
      const dates = {};
      for (const k of ['start', 'end']) {
        const v = cell(row, k);
        if (v === '') continue;
        if (!D.isValid(v)) throw new Error('Row ' + n + ': "' + v + '" is not a valid ' + k + ' date (use YYYY-MM-DD).');
        dates[k] = v;
      }
      let level = 0;
      const lv = cell(row, 'level');
      const wbs = cell(row, 'wbs');
      if (lv !== '') {
        level = Math.round(Number(lv));
        if (!isFinite(level) || level < 0) throw new Error('Row ' + n + ': "' + lv + '" is not a valid level.');
      } else if (/^\d+(\.\d+)*$/.test(wbs)) {
        level = wbs.split('.').length - 1;
      }
      const pct = cell(row, 'progress').replace('%', '');
      if (pct !== '' && !isFinite(Number(pct))) throw new Error('Row ' + n + ': "' + pct + '" is not a valid percent complete.');
      let id;
      do id = M.newId(); while (used.has(id));
      used.add(id);
      raw.push({
        id, name: name || 'Untitled task', level, owner: cell(row, 'owner'),
        start: dates.start, end: dates.end, progress: pct === '' ? 0 : Number(pct),
        milestone: truthy(cell(row, 'milestone')), urc: truthy(cell(row, 'urc')),
        notes: cell(row, 'notes'), deps: [],
      });
      depText.set(id, cell(row, 'deps'));
      rowNo.set(id, n);
    }
    if (!raw.length) throw new Error('The CSV has no task rows.');

    let project = M.normalize(Object.assign({}, base, { tasks: raw }));
    // Resolve predecessors only now that the full outline (and so every WBS number) is known.
    const rs = M.rows(project);
    for (const r of rs) {
      const txt = depText.get(r.task.id);
      if (!txt || r.isSummary) continue;
      const res = M.parseDeps(txt, project, r.task.id);
      if (res.errors.length) throw new Error('Row ' + rowNo.get(r.task.id) + ': Predecessors - ' + res.errors.join('; ') + '.');
      project = M.updateTask(project, r.task.id, { deps: res.deps });
    }
    return project;
  }

  // ---------------------------------------------------------------- history

  function createHistory(initial, limit) {
    const max = Number.isInteger(limit) && limit >= 1 ? limit : 100;
    let past = [];
    let present = initial;
    let future = [];
    return {
      current: () => present,
      /** Record a new state. Pushing the identical object is ignored (no empty undo step). */
      push(project) {
        if (project === present) return present;
        past.push(present);
        if (past.length > max) past.shift();
        present = project;
        future = [];
        return present;
      },
      undo() {
        if (!past.length) return null;
        future.push(present);
        present = past.pop();
        return present;
      },
      redo() {
        if (!future.length) return null;
        past.push(present);
        present = future.pop();
        return present;
      },
      canUndo: () => past.length > 0,
      canRedo: () => future.length > 0,
      reset(project) {
        past = [];
        future = [];
        present = project;
      },
    };
  }

  root.TF.store = { KEY, load, save, toJSON, fromJSON, toCSV, fromCSV, createHistory };
})();
