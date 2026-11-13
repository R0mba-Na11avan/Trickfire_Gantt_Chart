/* TrickFire Robotics schedule editor: UI controller.
   Consumes TF.dates / TF.model / TF.cpm / TF.store / TF.render / TF.exporter (see CONTRACT).
   Plain browser JS, no modules. */
(function () {
  'use strict';
  const TF = window.TF;
  const D = TF.dates, M = TF.model;
  const ROW_H = TF.render.ROW_H, HEADER_H = TF.render.HEADER_H;

  // ---------------------------------------------------------------- state
  const state = {
    project: null,
    selectedId: null,
    dayWidth: 6,
    showDeps: true,
    showCritical: true
  };
  let history = null;
  let computed = null;          // { rows, cpm } for state.project
  let visibleRows = [];         // computed.rows filtered to visible
  let geom = null;              // geometry of the last timeline render
  let pendingFocus = null;      // { id, col } to focus after the next grid render
  let saveInfo = { ok: true, at: null };

  const $ = (id) => document.getElementById(id);
  const el = {
    app: $('app'), main: $('main'), gridPane: $('grid-pane'), gridBody: $('grid-body'),
    tlHead: $('tl-head'), tlBody: $('tl-body'), splitter: $('splitter'),
    title: $('project-title'), owners: $('owners-list'), toasts: $('toasts'), tip: $('drag-tip')
  };

  // ---------------------------------------------------------------- tiny helpers
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === false || v == null) continue;
        if (k === 'value' || k === 'checked' || k === 'disabled') n[k] = v;
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }
  function icon(id, cls) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', '#' + id);
    s.appendChild(u);
    return s;
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const q = (sel, root) => (root || document).querySelector(sel);
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const later = (fn) => setTimeout(fn, 0);

  function toast(msg, kind) {
    const t = h('div', { class: 'toast' + (kind === 'error' ? ' error' : ''), role: kind === 'error' ? 'alert' : 'status' }, h('span', null, String(msg)));
    const x = h('button', { type: 'button', 'aria-label': 'Dismiss' });
    x.appendChild(icon('i-close'));
    t.appendChild(x);
    const kill = () => t.remove();
    x.addEventListener('click', kill);
    el.toasts.appendChild(t);
    setTimeout(kill, kind === 'error' ? 9000 : 4500);
  }
  function errMsg(e) { return (e && e.message) ? e.message : String(e); }

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem('tf-gantt-ui') || '{}') || {}; } catch (e) { return {}; }
  }
  function savePrefs() {
    try {
      localStorage.setItem('tf-gantt-ui', JSON.stringify({
        dayWidth: state.dayWidth, gridW: parseInt(el.gridPane.style.width, 10) || null,
        showDeps: state.showDeps, showCritical: state.showCritical
      }));
    } catch (e) { /* storage unavailable */ }
  }

  // Structural equality for projects, so no-op operations don't create history entries.
  function sameProject(a, b) {
    if (a === b) return true;
    if (!a || !b || a.tasks.length !== b.tasks.length) return false;
    for (const k of Object.keys(a)) {
      if (k === 'tasks') continue;
      if (a[k] !== b[k]) return false;
    }
    for (const k of Object.keys(b)) if (!(k in a)) return false;
    for (let i = 0; i < a.tasks.length; i++) {
      if (a.tasks[i] !== b.tasks[i] && JSON.stringify(a.tasks[i]) !== JSON.stringify(b.tasks[i])) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- commit / undo / redo
  function persist() {
    let ok = false;
    try { ok = !!TF.store.save(state.project); } catch (e) { ok = false; }
    saveInfo = { ok, at: new Date() };
  }
  function commit(newProject, opts) {
    if (!newProject || sameProject(state.project, newProject)) { renderAll(); return false; }
    history.push(newProject);
    state.project = newProject;
    if (opts && opts.select !== undefined) state.selectedId = opts.select;
    if (state.selectedId && M.findIndex(newProject, state.selectedId) < 0) state.selectedId = null;
    persist();
    renderAll();
    return true;
  }
  function undo() {
    if (!history.canUndo()) return;
    const p = history.undo();
    if (p) afterHistory(p);
  }
  function redo() {
    if (!history.canRedo()) return;
    const p = history.redo();
    if (p) afterHistory(p);
  }
  function afterHistory(p) {
    state.project = p;
    if (state.selectedId && M.findIndex(p, state.selectedId) < 0) state.selectedId = null;
    persist();
    renderAll();
  }

  // ---------------------------------------------------------------- rendering
  function recompute(project) {
    return { rows: M.rows(project), cpm: TF.cpm.compute(project) };
  }

  function renderAll() {
    computed = recompute(state.project);
    visibleRows = computed.rows.filter((r) => r.visible === true);
    renderOwners();
    renderGrid();
    renderTimeline(state.project, computed);
    renderStatus();
    renderToolbar();
    if (document.activeElement !== el.title) el.title.value = state.project.title || '';
    if (q('#dlg-export').open) refreshPreview();
  }

  function renderOwners() {
    el.owners.textContent = '';
    for (const o of M.owners(state.project)) el.owners.appendChild(h('option', { value: o }));
  }

  // ---- grid
  function captureFocus() {
    const a = document.activeElement;
    if (!a || !el.gridBody.contains(a) || !a.dataset || !a.dataset.col) return null;
    const f = { id: a.dataset.id, col: a.dataset.col };
    try { f.s = a.selectionStart; f.e = a.selectionEnd; } catch (e) { /* not a text input */ }
    return f;
  }
  function focusCell(f) {
    if (!f) return;
    const n = q('[data-id="' + f.id + '"][data-col="' + f.col + '"]', el.gridBody);
    if (!n) return;
    n.focus({ preventScroll: true });
    if (f.s != null && n.setSelectionRange && n.type === 'text') {
      try { n.setSelectionRange(f.s, f.e); } catch (e) { /* ignore */ }
    }
  }

  function renderGrid() {
    const focus = pendingFocus || captureFocus();
    pendingFocus = null;
    const top = el.gridBody.scrollTop;
    el.gridBody.textContent = '';
    if (!state.project.tasks.length) {
      el.gridBody.appendChild(emptyState());
      return;
    }
    const frag = document.createDocumentFragment();
    for (const r of visibleRows) frag.appendChild(buildRow(r));
    el.gridBody.appendChild(frag);
    el.gridBody.scrollTop = top;
    if (focus) {
      focusCell(focus);
      if (pendingScroll) { pendingScroll = false; scrollSelectedIntoView(); }
    }
  }
  let pendingScroll = false;

  function emptyState() {
    const add = h('button', { type: 'button', class: 'btn primary' }, 'Add your first task');
    const tpl = h('button', { type: 'button', class: 'btn' }, 'Load URC template');
    add.addEventListener('click', () => addTaskAfter(null));
    tpl.addEventListener('click', () => commit(M.sampleProject(), { select: null }));
    return h('div', { class: 'empty-state' },
      h('h3', null, 'No tasks yet'),
      h('p', null, 'Start a schedule from scratch or load the URC 2027 template and edit it.'),
      add, tpl);
  }

  // Same format the native date inputs use, so summary rows line up visually with task rows.
  function localDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  function field(r, col, type, value, extra) {
    const t = r.task;
    const labels = { name: 'Task name', owner: 'Owner', start: 'Start date', end: 'End date', days: 'Duration in days', pct: 'Percent complete', deps: 'Predecessors' };
    const attrs = Object.assign({
      type, value, 'data-id': t.id, 'data-col': col, 'data-orig': value,
      'aria-label': labels[col] + ', ' + r.wbs, autocomplete: 'off', spellcheck: 'false'
    }, extra || {});
    return h('input', attrs);
  }

  function buildRow(r) {
    const t = r.task, info = computed.cpm.info[t.id] || {};
    const viol = info.violations && info.violations.length;
    const cls = ['grow'];
    if (r.isSummary) cls.push('is-summary');
    if (t.milestone) cls.push('is-milestone');
    if (info.critical) cls.push('is-critical');
    if (viol) cls.push('has-violation');
    if (t.id === state.selectedId) cls.push('selected');
    const row = h('div', { class: cls.join(' '), 'data-id': t.id, role: 'row' });
    const cell = (c, ...kids) => h('div', { class: 'c c-' + c }, ...kids);

    row.appendChild(cell('wbs', r.wbs));

    // name cell
    const nc = cell('name');
    nc.style.paddingLeft = (3 + r.level * 14) + 'px';
    if (r.isSummary) {
      const c = h('button', { type: 'button', class: 'caret', 'data-act': 'collapse', 'data-id': t.id, 'data-col': 'caret',
        'aria-expanded': String(!t.collapsed), 'aria-label': (t.collapsed ? 'Expand ' : 'Collapse ') + t.name });
      c.appendChild(icon('i-chev'));
      nc.appendChild(c);
    } else {
      nc.appendChild(h('span', { class: 'caret-sp' }));
    }
    nc.appendChild(field(r, 'name', 'text', t.name));
    const ms = h('button', { type: 'button', class: 'tog', 'data-act': 'ms', 'data-id': t.id, 'data-col': 'ms',
      'aria-pressed': String(!!t.milestone), 'aria-label': 'Milestone', title: 'Milestone (single date)' });
    ms.appendChild(icon('i-diamond'));
    const urc = h('button', { type: 'button', class: 'tog', 'data-act': 'urc', 'data-id': t.id, 'data-col': 'urc',
      'aria-pressed': String(!!t.urc), 'aria-label': 'URC 2027-specific task', title: 'URC 2027-specific task' });
    urc.appendChild(icon('i-star'));
    if (!r.isSummary) nc.appendChild(ms);
    nc.appendChild(urc);
    row.appendChild(nc);

    // owner
    row.appendChild(cell('owner', field(r, 'owner', 'text', t.owner || '', { list: 'owners-list' })));

    // dates, days, %
    if (r.isSummary) {
      const ro = (txt) => h('span', { class: 'ro' }, txt);
      row.appendChild(cell('start', ro(localDate(r.start))));
      row.appendChild(cell('end', ro(localDate(r.end))));
      row.appendChild(cell('days', ro(String(D.duration(r.start, r.end)))));
      row.appendChild(cell('pct', ro(r.progress + '%')));
    } else if (t.milestone) {
      const start = cell('start', field(r, 'start', 'date', t.start));
      if (viol) start.title = 'Starts ' + info.violations[0].days + ' day(s) before a predecessor finishes';
      row.appendChild(start);
      row.appendChild(cell('end', h('span', { class: 'ro dash', title: 'Milestones have a single date' }, '—')));
      row.appendChild(cell('days', h('span', { class: 'ro dash' }, '—')));
      row.appendChild(cell('pct', field(r, 'pct', 'number', String(r.progress), { min: 0, max: 100, step: 1 })));
    } else {
      const start = cell('start', field(r, 'start', 'date', t.start));
      if (viol) start.title = 'Starts ' + info.violations[0].days + ' day(s) before a predecessor finishes';
      row.appendChild(start);
      row.appendChild(cell('end', field(r, 'end', 'date', t.end)));
      row.appendChild(cell('days', field(r, 'days', 'number', String(D.duration(t.start, t.end)), { min: 1, step: 1 })));
      row.appendChild(cell('pct', field(r, 'pct', 'number', String(r.progress), { min: 0, max: 100, step: 1 })));
    }

    row.appendChild(cell('deps', field(r, 'deps', 'text', M.formatDeps(t, state.project), { placeholder: r.isSummary ? '' : 'e.g. 2.1' })));
    return row;
  }

  // ---- grid editing
  // Apply an edited field. Called asynchronously (after focus has moved) so the re-render
  // cannot swallow a Tab to the next cell.
  function applyField(id, col, raw) {
    const p = state.project;
    const idx = M.findIndex(p, id);
    if (idx < 0) return;
    const t = p.tasks[idx];
    const row = computed.rows[idx];
    let np = p;
    const v = String(raw).trim();
    switch (col) {
      case 'name':
        if (v && v !== t.name) np = M.updateTask(p, id, { name: v });
        break;
      case 'owner':
        if (v !== (t.owner || '')) np = M.updateTask(p, id, { owner: v });
        break;
      case 'start':
        if (D.isValid(v) && v !== t.start) np = M.updateTask(p, id, { start: v });
        break;
      case 'end':
        if (D.isValid(v) && v !== t.end) np = M.updateTask(p, id, { end: D.max(v, t.start) });
        break;
      case 'days': {
        const n = Math.round(Number(v));
        if (isFinite(n) && n >= 1 && n !== D.duration(t.start, t.end)) np = M.updateTask(p, id, { end: D.addDays(t.start, n - 1) });
        break;
      }
      case 'pct': {
        const n = Math.round(Number(v));
        if (v !== '' && isFinite(n)) {
          const c = clamp(n, 0, 100);
          if (c !== row.progress) np = M.updateTask(p, id, { progress: c });
        }
        break;
      }
      case 'deps': {
        const res = M.parseDeps(v, p, id);
        if (res.errors && res.errors.length) toast('Predecessors: ' + res.errors.join('; '), 'error');
        np = M.updateTask(p, id, { deps: res.deps });
        break;
      }
    }
    // commit() re-renders even when nothing changed, which also resets rejected input text.
    commit(np);
  }

  function addTaskAfter(afterId, nameValue) {
    let p = state.project;
    if (afterId && nameValue != null) {
      const t = p.tasks[M.findIndex(p, afterId)];
      const v = String(nameValue).trim();
      if (t && v && v !== t.name) p = M.updateTask(p, afterId, { name: v });
    }
    const res = M.addTask(p, afterId || null);
    pendingFocus = { id: res.id, col: 'name' };
    pendingScroll = true;
    commit(res.project, { select: res.id });
  }

  function onGridChange(e) {
    const inp = e.target;
    if (!inp.dataset || !inp.dataset.col || inp.tagName !== 'INPUT') return;
    if (inp.value === inp.dataset.orig) return;
    const id = inp.dataset.id, col = inp.dataset.col, val = inp.value;
    inp.dataset.orig = val;
    later(() => applyField(id, col, val));
  }

  function onGridKeydown(e) {
    const inp = e.target;
    if (inp.tagName !== 'INPUT' || !inp.dataset.col) return;
    if (e.key === 'Escape') {
      inp.value = inp.dataset.orig;
      e.stopPropagation();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const id = inp.dataset.id, col = inp.dataset.col, val = inp.value;
      if (col === 'name') {
        inp.dataset.orig = val;
        later(() => addTaskAfter(id, val));
      } else if (val !== inp.dataset.orig) {
        inp.dataset.orig = val;
        later(() => applyField(id, col, val));
      }
    }
  }

  function onGridClick(e) {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = b.dataset.id, p = state.project;
    const idx = M.findIndex(p, id);
    if (idx < 0) return;
    const t = p.tasks[idx];
    pendingFocus = { id, col: b.dataset.col };
    if (b.dataset.act === 'collapse') commit(M.setCollapsed(p, id, !t.collapsed));
    else if (b.dataset.act === 'urc') commit(M.updateTask(p, id, { urc: !t.urc }));
    else if (b.dataset.act === 'ms') {
      commit(M.updateTask(p, id, t.milestone ? { milestone: false, end: D.addDays(t.start, 6) } : { milestone: true, end: t.start }));
    }
  }

  function scrollSelectedIntoView() {
    const i = visibleRows.findIndex((r) => r.task.id === state.selectedId);
    if (i < 0) return;
    const gb = el.gridBody, top = i * ROW_H;
    if (top < gb.scrollTop) gb.scrollTop = top;
    else if (top + ROW_H > gb.scrollTop + gb.clientHeight) gb.scrollTop = top + ROW_H - gb.clientHeight;
  }

  // ---- selection (cheap: no grid rebuild)
  function select(id) {
    if (state.selectedId === id) return;
    state.selectedId = id;
    for (const r of qa('.grow.selected', el.gridBody)) r.classList.remove('selected');
    if (id) { const r = q('.grow[data-id="' + id + '"]', el.gridBody); if (r) r.classList.add('selected'); }
    renderTimeline(state.project, computed);
    renderToolbar();
  }

  // ---- timeline
  function renderTimeline(project, comp) {
    const t = TF.render.timeline(project, comp, {
      dayWidth: state.dayWidth, showDeps: state.showDeps, showCritical: state.showCritical, selectedId: state.selectedId
    });
    geom = t.geom;
    t.header.setAttribute('width', geom.width); t.header.setAttribute('height', HEADER_H);
    t.body.setAttribute('width', geom.width); t.body.setAttribute('height', geom.height);
    const sl = el.tlBody.scrollLeft, st = el.tlBody.scrollTop;
    el.tlHead.replaceChildren(t.header);
    el.tlBody.replaceChildren(t.body);
    el.tlBody.scrollLeft = sl;
    el.tlBody.scrollTop = st;
    el.tlHead.scrollLeft = el.tlBody.scrollLeft;
    fitHeaderToScrollbar();
  }

  // The header strip must be as wide as the body's visible area (body has a vertical scrollbar).
  function fitHeaderToScrollbar() {
    const sbw = el.tlBody.offsetWidth - el.tlBody.clientWidth;
    el.tlHead.style.marginRight = '0';
    el.tlHead.style.width = (el.tlBody.clientWidth || el.tlBody.offsetWidth) + 'px';
    el.tlHead.dataset.sbw = sbw;
  }

  function wireScrollSync() {
    // Assigning an equal value fires no event, so these cannot ping-pong.
    el.gridBody.addEventListener('scroll', () => { if (el.tlBody.scrollTop !== el.gridBody.scrollTop) el.tlBody.scrollTop = el.gridBody.scrollTop; });
    el.tlBody.addEventListener('scroll', () => {
      if (el.gridBody.scrollTop !== el.tlBody.scrollTop) el.gridBody.scrollTop = el.tlBody.scrollTop;
      if (el.tlHead.scrollLeft !== el.tlBody.scrollLeft) el.tlHead.scrollLeft = el.tlBody.scrollLeft;
    });
    window.addEventListener('resize', fitHeaderToScrollbar);
  }

  function setZoom(px) {
    if (!geom) { state.dayWidth = px; return; }
    const cw = el.tlBody.clientWidth;
    const centerDay = geom.dayAtX(el.tlBody.scrollLeft + cw / 2);
    state.dayWidth = px;
    renderTimeline(state.project, computed);
    el.tlBody.scrollLeft = Math.max(0, geom.xOfDay(centerDay) - cw / 2);
    renderToolbar();
    savePrefs();
  }
  function jumpToToday() {
    const iso = state.project.statusDate && D.isValid(state.project.statusDate) ? state.project.statusDate : D.today();
    const x = geom.xOfDay(D.toDay(iso));
    el.tlBody.scrollLeft = Math.max(0, x - el.tlBody.clientWidth / 3);
  }

  // ---- status bar & toolbar state
  function renderStatus() {
    const info = computed.cpm.info;
    const leaves = computed.rows.filter((r) => !r.isSummary);
    const viol = leaves.filter((r) => info[r.task.id] && info[r.task.id].violations && info[r.task.id].violations.length).length;
    $('st-tasks').textContent = state.project.tasks.length + ' tasks';
    $('st-finish').textContent = 'Project finish: ' + (computed.cpm.projectEnd ? D.fmtLong(computed.cpm.projectEnd) : '—');
    $('st-crit').textContent = computed.cpm.criticalIds.length + ' critical tasks';
    const v = $('st-viol');
    v.className = 'st-viol';
    if (computed.cpm.hasCycle) {
      v.textContent = 'Dependency cycle in ' + computed.cpm.cycleIds.length + ' tasks';
      v.classList.add('warn-cycle');
      v.title = 'Remove a predecessor to break the cycle';
    } else if (viol) {
      v.textContent = viol + (viol === 1 ? ' dependency violation' : ' dependency violations') + ' - click to auto-schedule';
      v.classList.add('bad');
      v.title = 'Shift tasks later so every predecessor finishes first';
    } else {
      v.textContent = 'No dependency violations';
      v.classList.add('ok');
      v.title = '';
    }
    $('st-save').textContent = saveInfo.ok
      ? (saveInfo.at ? 'Autosaved ' + saveInfo.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Autosave on')
      : 'Not saved (browser storage unavailable) - use File > Save JSON';
  }

  function renderToolbar() {
    const sel = !!state.selectedId;
    for (const id of ['btn-sub', 'btn-indent', 'btn-outdent', 'btn-moveup', 'btn-movedown', 'btn-delete']) $(id).disabled = !sel;
    $('btn-undo').disabled = !history.canUndo();
    $('btn-redo').disabled = !history.canRedo();
    $('btn-deps').setAttribute('aria-pressed', String(state.showDeps));
    $('btn-crit').setAttribute('aria-pressed', String(state.showCritical));
    for (const b of qa('#zoom-seg [data-zoom]')) b.setAttribute('aria-pressed', String(Number(b.dataset.zoom) === state.dayWidth));
  }

  // ---------------------------------------------------------------- task operations
  function addMilestone() {
    const p = state.project;
    const res = M.addTask(p, state.selectedId || null, { milestone: true, name: 'New milestone' });
    const np = M.updateTask(res.project, res.id, { milestone: true });
    pendingFocus = { id: res.id, col: 'name' };
    pendingScroll = true;
    commit(np, { select: res.id });
  }
  function addSubtask() {
    if (!state.selectedId) return;
    const res = M.addChild(state.project, state.selectedId);
    pendingFocus = { id: res.id, col: 'name' };
    pendingScroll = true;
    commit(res.project, { select: res.id });
  }
  function op(fn) {
    if (!state.selectedId) return;
    pendingScroll = true;
    commit(fn(state.project, state.selectedId));
    scrollSelectedIntoView();
  }
  async function deleteSelected() {
    const id = state.selectedId;
    if (!id) return;
    const idx = M.findIndex(state.project, id);
    if (idx < 0) return;
    const n = M.subtreeEnd(state.project, idx) - idx;
    const name = state.project.tasks[idx].name;
    const ok = await confirmBox({
      title: 'Delete task', ok: 'Delete',
      message: n > 1 ? 'Delete "' + name + '" and its ' + (n - 1) + ' subtask(s)? You can undo this.' : 'Delete "' + name + '"? You can undo this.'
    });
    if (ok) commit(M.deleteTask(state.project, id), { select: null });
  }
  async function autoSchedule() {
    const info = computed.cpm.info;
    const n = computed.rows.filter((r) => !r.isSummary && info[r.task.id] && info[r.task.id].violations && info[r.task.id].violations.length).length;
    if (computed.cpm.hasCycle) { toast('Dependencies contain a cycle; fix it before auto-scheduling.', 'error'); return; }
    if (!n) { toast('No dependency violations: nothing to reschedule.'); return; }
    const ok = await confirmBox({
      title: 'Auto-schedule', ok: 'Shift tasks',
      message: n + ' task(s) start before their predecessors finish. Auto-schedule moves them later (never earlier), keeping their durations. You can undo this.'
    });
    if (ok) {
      const np = TF.cpm.autoSchedule(state.project);
      if (!commit(np)) toast('Nothing changed.');
    }
  }
  function setAllCollapsed(flag) {
    let p = state.project;
    for (const r of computed.rows) if (r.isSummary && !!r.task.collapsed !== flag) p = M.setCollapsed(p, r.task.id, flag);
    commit(p);
  }

  // ---------------------------------------------------------------- timeline drag
  let drag = null;

  function onTimelinePointerDown(e) {
    if (e.button !== 0 || !e.target.closest) return;
    if (!e.target.closest('svg')) return; // scrollbar or padding
    const handle = e.target.closest('.tf-handle');
    const bar = e.target.closest('.tf-bar');
    if (!bar && !handle) {
      // empty area: select the row under the pointer
      const y = e.clientY - el.tlBody.getBoundingClientRect().top + el.tlBody.scrollTop;
      const r = visibleRows[geom.rowAtY(y)];
      if (r) select(r.task.id);
      return;
    }
    const barEl = bar || handle.closest('.tf-bar');
    const id = (handle && handle.dataset.id) || (barEl && barEl.dataset.id);
    const row = computed.rows.find((r) => r.task.id === id);
    if (!row) return;
    e.preventDefault();
    const kind = barEl ? barEl.dataset.kind : 'task';
    let mode = 'move';
    if (handle && kind !== 'summary' && kind !== 'milestone') mode = handle.dataset.handle === 'start' ? 'start' : 'end';
    drag = { id, mode, x0: e.clientX, base: state.project, start: row.start, end: row.end, moved: false, delta: 0, np: null };
    select(id);
  }

  function dragProject(d, delta) {
    if (d.mode === 'move') return M.shiftTask(d.base, d.id, delta);
    if (d.mode === 'start') {
      let s = D.addDays(d.start, delta);
      if (D.diff(s, d.end) < 0) s = d.end;
      return M.updateTask(d.base, d.id, { start: s, end: d.end });
    }
    let e = D.addDays(d.end, delta);
    if (D.diff(d.start, e) < 0) e = d.start;
    return M.updateTask(d.base, d.id, { start: d.start, end: e });
  }

  function onDragMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    if (!drag.moved) {
      if (Math.abs(dx) < 3) return;
      drag.moved = true;
      document.body.classList.add('is-dragging');
      if (drag.mode !== 'move') document.body.classList.add('drag-resize');
    }
    const delta = Math.round(dx / geom.dayWidth);
    if (delta !== drag.delta || !drag.np) {
      drag.delta = delta;
      drag.np = dragProject(drag, delta);
      renderTimeline(drag.np, recompute(drag.np));
    }
    // floating date tip
    const i = M.findIndex(drag.np, drag.id);
    const t = drag.np.tasks[i];
    const rr = i >= 0 ? M.rows(drag.np)[i] : null;
    if (rr) {
      el.tip.textContent = (rr.task.milestone ? D.fmtLong(rr.start) : D.fmtShort(rr.start) + ' - ' + D.fmtLong(rr.end)) + (delta ? '  (' + (delta > 0 ? '+' : '') + delta + ' d)' : '');
      el.tip.classList.remove('hidden');
      el.tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 240) + 'px';
      el.tip.style.top = (e.clientY + 18) + 'px';
    }
    void t;
  }

  function endDrag(apply) {
    if (!drag) return;
    const d = drag;
    drag = null;
    document.body.classList.remove('is-dragging', 'drag-resize');
    el.tip.classList.add('hidden');
    if (d.moved && apply && d.delta !== 0 && d.np) commit(d.np);
    else if (d.moved) renderTimeline(state.project, computed);
  }

  // ---------------------------------------------------------------- splitter
  function wireSplitter() {
    const sp = el.splitter;
    let sx = 0, sw = 0, active = false;
    const maxW = () => Math.max(260, el.main.clientWidth - 240);
    const setW = (w) => { el.gridPane.style.width = clamp(w, 240, maxW()) + 'px'; fitHeaderToScrollbar(); };
    sp.addEventListener('pointerdown', (e) => {
      active = true; sx = e.clientX; sw = el.gridPane.getBoundingClientRect().width;
      sp.setPointerCapture(e.pointerId); sp.classList.add('dragging'); document.body.classList.add('is-splitting');
      e.preventDefault();
    });
    sp.addEventListener('pointermove', (e) => { if (active) setW(sw + e.clientX - sx); });
    const stop = () => { if (!active) return; active = false; sp.classList.remove('dragging'); document.body.classList.remove('is-splitting'); savePrefs(); renderTimeline(state.project, computed); };
    sp.addEventListener('pointerup', stop);
    sp.addEventListener('pointercancel', stop);
    sp.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      setW(el.gridPane.getBoundingClientRect().width + (e.key === 'ArrowRight' ? 24 : -24));
      savePrefs();
    });
    window.addEventListener('resize', () => setW(el.gridPane.getBoundingClientRect().width));
  }

  // ---------------------------------------------------------------- dialogs
  function confirmBox(o) {
    const dlg = $('dlg-confirm');
    $('dlg-confirm-h').textContent = o.title || 'Confirm';
    $('dlg-confirm-msg').textContent = o.message || '';
    $('confirm-ok').textContent = o.ok || 'OK';
    dlg.returnValue = '';
    return new Promise((resolve) => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
      dlg.showModal();
      $('confirm-cancel').focus();
    });
  }
  function wireDialogs() {
    for (const dlg of qa('dialog')) {
      for (const b of qa('[data-close]', dlg)) b.addEventListener('click', () => dlg.close());
      // click on backdrop closes (but not for the form dialogs where a stray click would lose input)
    }
    $('dlg-export').addEventListener('click', (e) => { if (e.target === $('dlg-export')) $('dlg-export').close(); });
  }

  // ---- project settings
  let settingsLogo = null;
  function openSettings() {
    const p = state.project;
    $('set-title').value = p.title || '';
    $('set-team').value = p.team || '';
    $('set-start').value = p.rangeStart || '';
    $('set-end').value = p.rangeEnd || '';
    $('set-status').value = p.statusDate || '';
    $('set-error').textContent = '';
    settingsLogo = p.logo || null;
    paintLogo();
    $('dlg-settings').showModal();
    $('set-title').focus();
  }
  function paintLogo() {
    const pv = $('logo-prev');
    pv.style.backgroundImage = settingsLogo ? 'url("' + settingsLogo + '")' : 'none';
    $('btn-logo-remove').disabled = !settingsLogo;
  }
  function wireSettings() {
    $('btn-logo').addEventListener('click', () => $('file-logo').click());
    $('btn-logo-remove').addEventListener('click', () => { settingsLogo = null; paintLogo(); });
    $('set-status-clear').addEventListener('click', () => { $('set-status').value = ''; });
    $('file-logo').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type)) { $('set-error').textContent = 'Please choose an image file.'; return; }
      if (f.size > 1500000) { $('set-error').textContent = 'Image is larger than 1.5 MB; use a smaller logo.'; return; }
      const fr = new FileReader();
      fr.onload = () => { settingsLogo = String(fr.result); $('set-error').textContent = ''; paintLogo(); };
      fr.onerror = () => { $('set-error').textContent = 'Could not read that image.'; };
      fr.readAsDataURL(f);
    });
    $('form-settings').addEventListener('submit', (e) => {
      e.preventDefault();
      const rs = $('set-start').value, re = $('set-end').value, sd = $('set-status').value;
      const err = $('set-error');
      if (!D.isValid(rs) || !D.isValid(re)) { err.textContent = 'Enter a valid chart start and end date.'; return; }
      if (D.diff(rs, re) < 6) { err.textContent = 'The chart must span at least one week.'; return; }
      if (sd && !D.isValid(sd)) { err.textContent = 'Status date is not a valid date.'; return; }
      $('dlg-settings').close();
      commit(Object.assign({}, state.project, {
        title: $('set-title').value.trim() || state.project.title,
        team: $('set-team').value.trim() || 'TrickFire Robotics',
        rangeStart: rs, rangeEnd: re, statusDate: sd || null, logo: settingsLogo
      }));
    });
  }

  // ---- export dialog
  const ex = { orientation: 'landscape', theme: 'light', showDeps: true, showLegend: true };
  function pageOpts() {
    const land = ex.orientation === 'landscape';
    return { width: land ? 1056 : 816, height: land ? 816 : 1056, theme: ex.theme, showDeps: ex.showDeps, showLegend: ex.showLegend, margin: 36 };
  }
  function openExport() {
    $('dlg-export').showModal();
    refreshPreview();
  }
  function refreshPreview() {
    const host = $('ex-page'), o = pageOpts();
    host.textContent = '';
    try {
      const svg = TF.render.page(state.project, computed, o);
      host.appendChild(svg);
      $('ex-warn').classList.toggle('hidden', !!TF.render.pageFit(state.project, computed, o).legible);
    } catch (e) {
      host.appendChild(h('div', { class: 'pv-error' }, 'Could not build the preview: ' + errMsg(e)));
    }
    scalePreview();
  }
  function scalePreview() {
    const frame = $('ex-frame'), host = $('ex-page'), svg = host.firstElementChild;
    if (!svg || svg.tagName.toLowerCase() !== 'svg') return;
    const o = pageOpts();
    const aw = frame.clientWidth - 30, ah = frame.clientHeight - 30;
    if (aw <= 0 || ah <= 0) return;
    const s = Math.min(aw / o.width, ah / o.height);
    svg.style.width = Math.floor(o.width * s) + 'px';
    svg.style.height = Math.floor(o.height * s) + 'px';
  }
  function wireExport() {
    for (const r of qa('input[name="ex-orient"]')) r.addEventListener('change', () => { if (r.checked) { ex.orientation = r.value; refreshPreview(); } });
    for (const r of qa('input[name="ex-theme"]')) r.addEventListener('change', () => { if (r.checked) { ex.theme = r.value; refreshPreview(); } });
    $('ex-deps').addEventListener('change', (e) => { ex.showDeps = e.target.checked; refreshPreview(); });
    $('ex-legend').addEventListener('change', (e) => { ex.showLegend = e.target.checked; refreshPreview(); });
    $('ex-collapse').addEventListener('click', () => setAllCollapsed(true));
    $('ex-expand').addEventListener('click', () => setAllCollapsed(false));
    $('ex-print').addEventListener('click', () => { try { TF.exporter.printPage(state.project, computed, pageOpts()); } catch (e) { toast(errMsg(e), 'error'); } });
    $('ex-svg').addEventListener('click', () => { try { TF.exporter.downloadSvg(state.project, computed, pageOpts()); } catch (e) { toast(errMsg(e), 'error'); } });
    $('ex-png').addEventListener('click', () => {
      try {
        Promise.resolve(TF.exporter.downloadPng(state.project, computed, pageOpts())).catch((e) => toast(errMsg(e), 'error'));
      } catch (e) { toast(errMsg(e), 'error'); }
    });
    if (window.ResizeObserver) new ResizeObserver(scalePreview).observe($('ex-frame'));
    window.addEventListener('resize', scalePreview);
  }

  // ---------------------------------------------------------------- file operations
  function saveJson() {
    try { TF.exporter.download(TF.exporter.fileName(state.project, 'json'), TF.store.toJSON(state.project), 'application/json'); toast('Saved JSON file.'); }
    catch (e) { toast(errMsg(e), 'error'); }
  }
  function exportCsv() {
    try { TF.exporter.download(TF.exporter.fileName(state.project, 'csv'), TF.store.toCSV(state.project), 'text/csv;charset=utf-8'); }
    catch (e) { toast(errMsg(e), 'error'); }
  }
  function hasTasks() { return state.project.tasks.length > 0; }

  async function replaceWith(project, title, message) {
    if (hasTasks()) {
      const ok = await confirmBox({ title, message, ok: 'Replace' });
      if (!ok) return;
    }
    state.selectedId = null;
    commit(project, { select: null });
    el.gridBody.scrollTop = 0;
  }
  function readFile(inputEl, parse, title, label) {
    const f = inputEl.files && inputEl.files[0];
    inputEl.value = '';
    if (!f) return;
    const fr = new FileReader();
    fr.onerror = () => toast('Could not read ' + f.name, 'error');
    fr.onload = () => {
      let p;
      try { p = parse(String(fr.result)); } catch (e) { toast(errMsg(e), 'error'); return; }
      replaceWith(p, title, label + ' "' + f.name + '" replaces the current schedule. You can undo this.');
    };
    fr.readAsText(f);
  }
  function wireFiles() {
    $('file-json').addEventListener('change', (e) => readFile(e.target, (t) => TF.store.fromJSON(t), 'Open JSON', 'Opening'));
    $('file-csv').addEventListener('change', (e) => readFile(e.target, (t) => TF.store.fromCSV(t), 'Import CSV', 'Importing'));
  }
  function fileMenuAction(a) {
    switch (a) {
      case 'new': replaceWith(M.newProject(), 'New blank schedule', 'A new blank schedule replaces the current one. You can undo this.'); break;
      case 'template': replaceWith(M.sampleProject(), 'Load URC template', 'The URC 2027 template replaces the current schedule. You can undo this.'); break;
      case 'open': $('file-json').click(); break;
      case 'save': saveJson(); break;
      case 'import': $('file-csv').click(); break;
      case 'csv': exportCsv(); break;
    }
  }

  // ---------------------------------------------------------------- menus & popovers
  function wireMenus() {
    const pairs = [['btn-file', 'menu-file'], ['btn-help', 'pop-help']];
    const closeAll = (except) => {
      for (const [b, m] of pairs) {
        if (m === except) continue;
        $(m).classList.add('hidden'); $(b).setAttribute('aria-expanded', 'false');
      }
    };
    for (const [b, m] of pairs) {
      $(b).addEventListener('click', (e) => {
        e.stopPropagation();
        const open = $(m).classList.contains('hidden');
        closeAll(open ? m : null);
        $(m).classList.toggle('hidden', !open);
        $(b).setAttribute('aria-expanded', String(open));
        if (open && m === 'menu-file') q('button', $(m)).focus();
      });
    }
    $('menu-file').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-file]');
      if (!b) return;
      closeAll(null);
      $('btn-file').focus();
      fileMenuAction(b.dataset.file);
    });
    $('menu-file').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const items = qa('button', $('menu-file'));
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu-wrap')) closeAll(null);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !q('dialog[open]')) {
        const wasOpen = pairs.find(([, m]) => !$(m).classList.contains('hidden'));
        if (wasOpen) { closeAll(null); $(wasOpen[0]).focus(); }
      }
    });
    wireMenus.close = closeAll;
  }

  // ---------------------------------------------------------------- global keyboard
  function isDirty(t) { return t && t.tagName === 'INPUT' && t.dataset && t.dataset.orig !== undefined && t.value !== t.dataset.orig; }
  function onKeydown(e) {
    if (q('dialog[open]')) return;
    if (e.key === 'Escape' && drag) { endDrag(false); return; }
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const tag = e.target.tagName;
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (mod && !e.altKey) {
      if (k === 's') { e.preventDefault(); saveJson(); return; }
      if (k === 'z' || k === 'y') {
        if (inField && isDirty(e.target)) return; // let the browser undo the text edit
        e.preventDefault();
        if (k === 'y' || e.shiftKey) redo(); else undo();
        return;
      }
    }
    if (e.altKey && e.shiftKey && state.selectedId) {
      const map = { ArrowRight: M.indent, ArrowLeft: M.outdent, ArrowUp: (p, id) => M.move(p, id, -1), ArrowDown: (p, id) => M.move(p, id, 1) };
      if (map[e.key]) { e.preventDefault(); op(map[e.key]); return; }
    }
    if (!inField && !mod && !e.altKey) {
      if (e.key === 'Delete' && state.selectedId) { e.preventDefault(); deleteSelected(); }
      else if (e.key === '?') { e.preventDefault(); $('btn-help').click(); }
    }
  }

  // ---------------------------------------------------------------- init
  function wireToolbar() {
    $('btn-undo').addEventListener('click', undo);
    $('btn-redo').addEventListener('click', redo);
    $('btn-add').addEventListener('click', () => addTaskAfter(state.selectedId));
    $('btn-sub').addEventListener('click', addSubtask);
    $('btn-ms').addEventListener('click', addMilestone);
    $('btn-indent').addEventListener('click', () => op(M.indent));
    $('btn-outdent').addEventListener('click', () => op(M.outdent));
    $('btn-moveup').addEventListener('click', () => op((p, id) => M.move(p, id, -1)));
    $('btn-movedown').addEventListener('click', () => op((p, id) => M.move(p, id, 1)));
    $('btn-delete').addEventListener('click', deleteSelected);
    $('btn-today').addEventListener('click', jumpToToday);
    $('btn-deps').addEventListener('click', () => { state.showDeps = !state.showDeps; renderTimeline(state.project, computed); renderToolbar(); savePrefs(); });
    $('btn-crit').addEventListener('click', () => { state.showCritical = !state.showCritical; renderTimeline(state.project, computed); renderToolbar(); savePrefs(); });
    $('btn-auto').addEventListener('click', autoSchedule);
    $('st-viol').addEventListener('click', () => { if ($('st-viol').classList.contains('bad')) autoSchedule(); });
    for (const b of qa('#zoom-seg [data-zoom]')) b.addEventListener('click', () => setZoom(Number(b.dataset.zoom)));
    $('btn-settings').addEventListener('click', openSettings);
    $('btn-export').addEventListener('click', openExport);

    el.title.addEventListener('change', () => {
      const v = el.title.value.trim();
      if (v && v !== state.project.title) commit(Object.assign({}, state.project, { title: v }));
      else el.title.value = state.project.title;
    });
    el.title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.title.blur();
      else if (e.key === 'Escape') { el.title.value = state.project.title; el.title.blur(); e.stopPropagation(); }
    });
  }

  function wireGrid() {
    el.gridBody.addEventListener('change', onGridChange);
    el.gridBody.addEventListener('keydown', onGridKeydown);
    el.gridBody.addEventListener('click', onGridClick);
    el.gridBody.addEventListener('focusin', (e) => { const r = e.target.closest('.grow'); if (r) select(r.dataset.id); });
    el.gridBody.addEventListener('pointerdown', (e) => { const r = e.target.closest('.grow'); if (r) select(r.dataset.id); });
  }

  function init() {
    document.documentElement.style.setProperty('--row-h', ROW_H + 'px');
    document.documentElement.style.setProperty('--header-h', HEADER_H + 'px');

    const prefs = loadPrefs();
    if ([3, 6, 10, 16].includes(prefs.dayWidth)) state.dayWidth = prefs.dayWidth;
    if (typeof prefs.showDeps === 'boolean') state.showDeps = prefs.showDeps;
    if (typeof prefs.showCritical === 'boolean') state.showCritical = prefs.showCritical;
    el.gridPane.style.width = (prefs.gridW || Math.min(776, Math.round(window.innerWidth * 0.56))) + 'px';

    let project = null;
    try { project = TF.store.load(); } catch (e) { project = null; }
    if (!project) project = M.sampleProject();
    state.project = project;
    history = TF.store.createHistory(project);

    wireToolbar(); wireGrid(); wireScrollSync(); wireSplitter(); wireDialogs();
    wireSettings(); wireExport(); wireFiles(); wireMenus();

    // timeline drag: pointerdown on the (persistent) scroller, move/up on the document
    el.tlBody.addEventListener('pointerdown', onTimelinePointerDown);
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', () => endDrag(true));
    document.addEventListener('pointercancel', () => endDrag(false));
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('error', (e) => toast('Unexpected error: ' + e.message, 'error'));

    renderAll();
    // Open on the status date so the current work is in view.
    if (geom) jumpToToday();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
