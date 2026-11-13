/* TF.model - project data model, derived rows (WBS/rollups) and immutable mutation helpers. */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  root.TF = root.TF || {};
  const D = root.TF.dates;

  const DEFAULT_TITLE = 'URC 2027 Integrated Master Schedule';
  const DEFAULT_TEAM = 'TrickFire Robotics';
  const DEFAULT_RANGE_START = '2026-09-01';
  const DEFAULT_RANGE_END = '2027-06-30';

  // ---------------------------------------------------------------- small helpers

  function newId() {
    let s = 't_';
    for (let i = 0; i < 6; i++) s += Math.floor(Math.random() * 36).toString(36);
    return s;
  }

  function clampProgress(p) {
    const n = Math.round(Number(p));
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  function cleanLag(l) {
    const n = Math.round(Number(l));
    return isFinite(n) ? n : 0;
  }

  function cleanDeps(deps) {
    if (!Array.isArray(deps)) return [];
    const seen = new Set();
    const out = [];
    for (const d of deps) {
      if (!d || typeof d.id !== 'string' || seen.has(d.id)) continue;
      seen.add(d.id);
      out.push({ id: d.id, lag: cleanLag(d.lag) });
    }
    return out;
  }

  /** Enforce per-task invariants (dates assumed valid ISO). Returns a new object. */
  function fixTask(t) {
    const n = Object.assign({}, t);
    n.progress = clampProgress(n.progress);
    if (n.milestone) n.end = n.start;
    else if (D.toDay(n.end) < D.toDay(n.start)) n.end = n.start;
    return n;
  }

  function newTask(partial) {
    const p = partial || {};
    const milestone = !!p.milestone;
    const start = D.isValid(p.start) ? p.start : D.today();
    const end = D.isValid(p.end) ? p.end : milestone ? start : D.addDays(start, 6);
    return fixTask({
      id: typeof p.id === 'string' && p.id ? p.id : newId(),
      name: typeof p.name === 'string' ? p.name : 'New task',
      level: Number.isInteger(p.level) && p.level >= 0 ? p.level : 0,
      start,
      end,
      progress: p.progress === undefined ? 0 : p.progress,
      owner: typeof p.owner === 'string' ? p.owner : '',
      deps: cleanDeps(p.deps),
      milestone,
      urc: !!p.urc,
      collapsed: !!p.collapsed,
      notes: typeof p.notes === 'string' ? p.notes : '',
    });
  }

  function newProject() {
    return {
      version: 1,
      title: DEFAULT_TITLE,
      team: DEFAULT_TEAM,
      rangeStart: DEFAULT_RANGE_START,
      rangeEnd: DEFAULT_RANGE_END,
      statusDate: null,
      logo: null,
      tasks: [],
    };
  }

  function withTasks(project, tasks) {
    return Object.assign({}, project, { tasks });
  }

  function findIndex(project, id) {
    return project.tasks.findIndex((t) => t.id === id);
  }

  /** Exclusive end index of the subtree rooted at `index` (the task plus all deeper tasks that follow). */
  function subtreeEnd(project, index) {
    const tasks = project.tasks;
    if (index < 0 || index >= tasks.length) return index;
    const lvl = tasks[index].level;
    let j = index + 1;
    while (j < tasks.length && tasks[j].level > lvl) j++;
    return j;
  }

  // ---------------------------------------------------------------- normalize

  function normalize(input) {
    if (!input || typeof input !== 'object' || !Array.isArray(input.tasks)) {
      throw new Error('Project data must be an object with a "tasks" array.');
    }
    const base = newProject();
    let rangeStart = D.isValid(input.rangeStart) ? input.rangeStart : base.rangeStart;
    let rangeEnd = D.isValid(input.rangeEnd) ? input.rangeEnd : base.rangeEnd;
    if (D.toDay(rangeEnd) < D.toDay(rangeStart)) [rangeStart, rangeEnd] = [rangeEnd, rangeStart];

    // Pass 1: unique ids.
    const used = new Set();
    const raw = input.tasks.filter((t) => t && typeof t === 'object');
    const ids = raw.map((t) => {
      let id = typeof t.id === 'string' && t.id ? t.id : null;
      if (id === null || used.has(id)) {
        do id = newId(); while (used.has(id));
      }
      used.add(id);
      return id;
    });
    // Original ids that are legitimately addressable by deps (first occurrence only keeps its id).
    const idSet = new Set(ids);

    const tasks = [];
    let prevLevel = -1;
    raw.forEach((t, i) => {
      let level = Math.round(Number(t.level));
      if (!isFinite(level) || level < 0) level = 0;
      level = Math.min(level, prevLevel + 1); // first task => 0, never jump more than +1
      prevLevel = level;

      const sOk = D.isValid(t.start), eOk = D.isValid(t.end);
      let start, end;
      if (sOk && eOk) { start = t.start; end = t.end; }
      else if (sOk) { start = end = t.start; }
      else if (eOk) { start = end = t.end; }
      else { start = rangeStart; end = D.addDays(rangeStart, 6); }
      if (D.toDay(end) < D.toDay(start)) [start, end] = [end, start];

      const id = ids[i];
      tasks.push(fixTask({
        id,
        name: typeof t.name === 'string' ? t.name : 'Untitled task',
        level,
        start,
        end,
        progress: t.progress,
        owner: typeof t.owner === 'string' ? t.owner : '',
        deps: cleanDeps(t.deps).filter((d) => d.id !== id && idSet.has(d.id)),
        milestone: !!t.milestone,
        urc: !!t.urc,
        collapsed: !!t.collapsed,
        notes: typeof t.notes === 'string' ? t.notes : '',
      }));
    });

    return {
      version: 1,
      title: typeof input.title === 'string' ? input.title : base.title,
      team: typeof input.team === 'string' ? input.team : base.team,
      rangeStart,
      rangeEnd,
      statusDate: D.isValid(input.statusDate) ? input.statusDate : null,
      logo: typeof input.logo === 'string' && input.logo ? input.logo : null,
      tasks,
    };
  }

  // ---------------------------------------------------------------- rows

  function rows(project) {
    const tasks = project.tasks;
    const n = tasks.length;
    const out = new Array(n);
    const stack = []; // indices of the current ancestor chain
    const counters = [];

    for (let i = 0; i < n; i++) {
      const t = tasks[i];
      while (stack.length && tasks[stack[stack.length - 1]].level >= t.level) stack.pop();
      const parent = stack.length ? stack[stack.length - 1] : -1;
      const depth = stack.length; // WBS depth follows actual nesting even for unrepaired level jumps
      counters[depth] = (counters[depth] || 0) + 1;
      counters.length = depth + 1;
      const isSummary = i + 1 < n && tasks[i + 1].level > t.level;
      out[i] = {
        task: t,
        index: i,
        wbs: counters.join('.'),
        level: t.level,
        isSummary,
        parentId: parent >= 0 ? tasks[parent].id : null,
        childIds: [],
        start: t.start,
        end: t.end,
        duration: t.milestone ? 0 : D.duration(t.start, t.end),
        progress: clampProgress(t.progress),
        visible: parent < 0 ? true : out[parent].visible && !tasks[parent].collapsed,
      };
      if (parent >= 0) out[parent].childIds.push(t.id);
      stack.push(i);
    }

    // Roll up summaries from their leaf descendants.
    for (let i = 0; i < n; i++) {
      if (!out[i].isSummary) continue;
      const end = subtreeEnd(project, i);
      let s = null, e = null, wSum = 0, pSum = 0;
      for (let j = i + 1; j < end; j++) {
        if (out[j].isSummary) continue;
        const r = out[j];
        if (s === null || D.toDay(r.start) < D.toDay(s)) s = r.start;
        if (e === null || D.toDay(r.end) > D.toDay(e)) e = r.end;
        const w = r.task.milestone ? 1 : D.duration(r.start, r.end);
        wSum += w;
        pSum += w * r.progress;
      }
      out[i].start = s;
      out[i].end = e;
      out[i].duration = D.duration(s, e);
      out[i].progress = wSum ? Math.round(pSum / wSum) : 0;
    }
    return out;
  }

  function owners(project) {
    const set = new Set();
    for (const t of project.tasks) {
      const o = (t.owner || '').trim();
      if (o) set.add(o);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  // ---------------------------------------------------------------- dependency helpers

  /**
   * Would adding predId as a predecessor of taskId create a cycle (or a self-link)?
   * Only edges between non-summary tasks count (deps to/from summaries are ignored by CPM).
   * Exposed as TF.model._wouldCycle; TF.cpm.wouldCycle is the public entry point.
   */
  function wouldCycle(project, taskId, predId) {
    if (taskId === predId) return true;
    const tasks = project.tasks;
    const byId = new Map();
    tasks.forEach((t, i) => byId.set(t.id, i));
    if (!byId.has(taskId) || !byId.has(predId)) return false;
    const isSummary = (i) => i + 1 < tasks.length && tasks[i + 1].level > tasks[i].level;
    // A cycle appears iff taskId is already an ancestor (transitive predecessor) of predId.
    const seen = new Set();
    const stack = [predId];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      const ci = byId.get(cur);
      if (isSummary(ci)) continue;
      for (const d of tasks[ci].deps) {
        if (!byId.has(d.id) || isSummary(byId.get(d.id))) continue;
        if (d.id === taskId) return true;
        stack.push(d.id);
      }
    }
    return false;
  }

  function parseDeps(text, project, taskId) {
    const rs = rows(project);
    const byWbs = new Map(rs.map((r) => [r.wbs, r]));
    const deps = [];
    const errors = [];
    const seen = new Set();
    const parts = String(text == null ? '' : text).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      const m = /^(\d+(?:\.\d+)*)\s*(?:([+-])\s*(\d+))?$/.exec(p);
      if (!m) { errors.push('"' + p + '" is not a valid reference (use e.g. 1.2 or 2.1+3)'); continue; }
      const r = byWbs.get(m[1]);
      if (!r) { errors.push('"' + m[1] + '" does not match any task'); continue; }
      if (r.task.id === taskId) { errors.push('A task cannot depend on itself (' + m[1] + ')'); continue; }
      if (r.isSummary) { errors.push(m[1] + ' is a summary task; depend on a task inside it instead'); continue; }
      if (wouldCycle(project, taskId, r.task.id)) { errors.push(m[1] + ' would create a circular dependency'); continue; }
      if (seen.has(r.task.id)) continue;
      seen.add(r.task.id);
      const lag = m[2] ? (m[2] === '-' ? -1 : 1) * parseInt(m[3], 10) : 0;
      deps.push({ id: r.task.id, lag });
    }
    return { deps, errors };
  }

  function formatLag(lag) {
    return lag > 0 ? '+' + lag : lag < 0 ? String(lag) : '';
  }

  function formatDeps(task, project) {
    const rs = rows(project);
    const wbsById = new Map(rs.map((r) => [r.task.id, r.wbs]));
    return (task.deps || [])
      .filter((d) => wbsById.has(d.id))
      .map((d) => wbsById.get(d.id) + formatLag(d.lag))
      .join(', ');
  }

  // ---------------------------------------------------------------- mutations (all pure)

  function updateTask(project, id, patch) {
    const i = findIndex(project, id);
    if (i < 0) return project;
    const old = project.tasks[i];
    const p = Object.assign({}, patch);
    delete p.id;
    if ('start' in p && !D.isValid(p.start)) delete p.start;
    if ('end' in p && !D.isValid(p.end)) delete p.end;
    if ('name' in p) p.name = String(p.name);
    if ('owner' in p) p.owner = String(p.owner);
    if ('notes' in p) p.notes = String(p.notes);
    if ('deps' in p) p.deps = cleanDeps(p.deps);
    if ('level' in p) {
      const lv = Math.round(Number(p.level));
      if (isFinite(lv) && lv >= 0) p.level = lv; else delete p.level;
    }
    for (const k of ['milestone', 'urc', 'collapsed']) if (k in p) p[k] = !!p[k];

    const next = Object.assign({}, old, p);
    // Changing only the start keeps the duration (moves the whole bar).
    if ('start' in p && !('end' in p)) next.end = D.addDays(p.start, D.diff(old.start, old.end));
    const tasks = project.tasks.slice();
    tasks[i] = fixTask(next);
    return withTasks(project, tasks);
  }

  function insertAt(project, index, task) {
    const tasks = project.tasks.slice();
    tasks.splice(index, 0, task);
    return withTasks(project, tasks);
  }

  function defaultDates(project, anchorRow, partial) {
    if (partial && (D.isValid(partial.start) || D.isValid(partial.end))) return {};
    const start = anchorRow ? anchorRow.start : project.statusDate || D.today();
    return { start, end: partial && partial.milestone ? start : D.addDays(start, 6) };
  }

  function addTask(project, afterId, partial) {
    if (afterId == null) {
      const t = newTask(Object.assign(defaultDates(project, null, partial), partial, { level: 0 }));
      return { project: withTasks(project, project.tasks.concat([t])), id: t.id };
    }
    const i = findIndex(project, afterId);
    if (i < 0) return { project, id: null };
    const anchor = rows(project)[i];
    const t = newTask(Object.assign(defaultDates(project, anchor, partial), partial, { level: project.tasks[i].level }));
    return { project: insertAt(project, subtreeEnd(project, i), t), id: t.id };
  }

  function addChild(project, parentId, partial) {
    const i = findIndex(project, parentId);
    if (i < 0) return { project, id: null };
    const parent = project.tasks[i];
    const anchor = rows(project)[i];
    const t = newTask(Object.assign(defaultDates(project, anchor, partial), partial, { level: parent.level + 1 }));
    let next = insertAt(project, subtreeEnd(project, i), t);
    if (parent.collapsed) next = setCollapsed(next, parentId, false); // keep the new child visible
    return { project: next, id: t.id };
  }

  function deleteTask(project, id) {
    const i = findIndex(project, id);
    if (i < 0) return project;
    const end = subtreeEnd(project, i);
    const removed = new Set(project.tasks.slice(i, end).map((t) => t.id));
    const tasks = [];
    project.tasks.forEach((t, j) => {
      if (j >= i && j < end) return;
      const deps = t.deps.filter((d) => !removed.has(d.id));
      tasks.push(deps.length === t.deps.length ? t : Object.assign({}, t, { deps }));
    });
    return withTasks(project, tasks);
  }

  function shiftLevels(project, from, to, delta) {
    const tasks = project.tasks.slice();
    for (let j = from; j < to; j++) tasks[j] = Object.assign({}, tasks[j], { level: tasks[j].level + delta });
    return withTasks(project, tasks);
  }

  function indent(project, id) {
    const i = findIndex(project, id);
    if (i <= 0) return project;
    // Legal only if the result is at most one deeper than the previous task.
    if (project.tasks[i].level > project.tasks[i - 1].level) return project;
    return shiftLevels(project, i, subtreeEnd(project, i), 1);
  }

  function outdent(project, id) {
    const i = findIndex(project, id);
    if (i < 0 || project.tasks[i].level <= 0) return project;
    return shiftLevels(project, i, subtreeEnd(project, i), -1);
  }

  function move(project, id, dir) {
    const i = findIndex(project, id);
    if (i < 0 || (dir !== -1 && dir !== 1)) return project;
    const tasks = project.tasks;
    const lvl = tasks[i].level;
    const end = subtreeEnd(project, i);
    let a, b, c; // swap blocks [a,b) and [b,c)
    if (dir === -1) {
      let p = i - 1;
      while (p >= 0 && tasks[p].level > lvl) p--;
      if (p < 0 || tasks[p].level !== lvl) return project; // no previous sibling
      a = p; b = i; c = end;
    } else {
      if (end >= tasks.length || tasks[end].level !== lvl) return project; // no next sibling
      a = i; b = end; c = subtreeEnd(project, end);
    }
    const next = tasks.slice(0, a).concat(tasks.slice(b, c), tasks.slice(a, b), tasks.slice(c));
    return withTasks(project, next);
  }

  function shiftTask(project, id, deltaDays) {
    const i = findIndex(project, id);
    const delta = Math.round(Number(deltaDays));
    if (i < 0 || !isFinite(delta) || delta === 0) return project;
    const end = subtreeEnd(project, i);
    const tasks = project.tasks.slice();
    for (let j = i; j < end; j++) {
      tasks[j] = Object.assign({}, tasks[j], {
        start: D.addDays(tasks[j].start, delta),
        end: D.addDays(tasks[j].end, delta),
      });
    }
    return withTasks(project, tasks);
  }

  function setCollapsed(project, id, collapsed) {
    const i = findIndex(project, id);
    if (i < 0 || project.tasks[i].collapsed === !!collapsed) return project;
    const tasks = project.tasks.slice();
    tasks[i] = Object.assign({}, tasks[i], { collapsed: !!collapsed });
    return withTasks(project, tasks);
  }

  // ---------------------------------------------------------------- sample template

  /**
   * A believable URC rover IMS template. Dates are placeholders for a team to edit; official URC dates
   * are not asserted (those deliverables are named "(set date)").
   * Design: one tight finish-to-start chain (zero gap) from chassis design through integration, mission
   * dry runs, sign-off and shipping to the competition milestone; every other chain ends with slack.
   */
  function sampleProject() {
    const yr = (md) => (+md.slice(0, 2) >= 9 ? '2026-' : '2027-') + md;
    const SET = 'Placeholder date: confirm against the official URC 2027 schedule.';
    // [key, level, name, owner, start, end, progress, deps, flags ('u' = URC, 'm' = milestone), notes]
    const spec = [
      ['pm', 0, 'Program Management & URC Deliverables', 'Leadership'],
      ['rules', 1, 'URC 2027 rules & mission analysis', 'Systems', '09-01', '09-18', 100, [], 'u'],
      ['pdrdoc', 1, 'PDR package (Gantt, architecture, budget)', 'Leadership', '11-02', '11-27', 55, ['rules'], 'u'],
      ['pdr', 1, 'PDR submission (set date)', 'Leadership', '12-01', '12-01', 0, ['pdrdoc'], 'um', SET],
      ['sarprep', 1, 'SAR video & report', 'Systems', '04-19', '05-07', 0, ['int_sw'], 'u'],
      ['sar', 1, 'SAR submission (set date)', 'Systems', '05-10', '05-10', 0, ['sarprep'], 'um', SET],
      ['ship', 1, 'Pack, ship & travel to competition site', 'Leadership', '05-25', '06-02', 0, ['signoff'], 'u'],
      ['comp', 1, 'URC 2027 competition (set date)', 'Leadership', '06-03', '06-03', 0, ['ship'], 'um', SET],

      ['ch', 0, 'Chassis & Drivetrain', 'Mechanical'],
      ['ch_req', 1, 'Chassis requirements & trade study', 'Mechanical', '09-21', '10-02', 100, ['rules']],
      ['ch_cad', 1, 'Frame & suspension CAD', 'Mechanical', '10-03', '11-06', 100, ['ch_req']],
      ['ch_review', 1, 'Design review & BOM freeze', 'Mechanical', '11-07', '11-20', 40, ['ch_cad']],
      ['ch_fab', 1, 'Frame & suspension fabrication', 'Mechanical', '11-21', '01-15', 0, ['ch_review']],
      ['ch_drive', 1, 'Drivetrain assembly & motor integration', 'Mechanical', '01-16', '02-12', 0, ['ch_fab']],
      ['ch_test', 1, 'Mobility bench & field test', 'Mechanical', '02-13', '02-26', 0, ['ch_drive']],

      ['arm', 0, 'Robotic Arm & End Effector', 'Mechanical'],
      ['arm_cad', 1, 'Arm links, joints & end effector CAD', 'Mechanical', '10-12', '11-27', 60, ['rules']],
      ['arm_fab', 1, 'Arm & end effector fabrication', 'Mechanical', '01-04', '02-05', 0, ['arm_cad']],
      ['arm_ctrl', 1, 'Arm motor control & IK tuning', 'Software', '02-08', '02-24', 0, ['arm_fab']],

      ['sci', 0, 'Science / Life Detection Payload', 'Science'],
      ['sci_sample', 1, 'Sample acquisition & handling', 'Science'],
      ['sci_drill', 2, 'Drill / scoop design', 'Science', '10-12', '11-27', 45, ['rules']],
      ['sci_fab', 2, 'Sample system fabrication & assembly', 'Science', '01-04', '02-05', 0, ['sci_drill']],
      ['sci_inst', 1, 'Life-detection instruments', 'Science'],
      ['sci_sens', 2, 'Sensor suite selection (spectrometer, fluorescence)', 'Science', '10-12', '11-06', 100, ['rules']],
      ['sci_proto', 2, 'Instrument prototype & calibration', 'Science', '11-09', '01-22', 10, ['sci_sens']],
      ['sci_done', 1, 'Science payload bench test', 'Science', '02-08', '02-24', 0, ['sci_fab', 'sci_proto']],

      ['el', 0, 'Electrical & Power', 'Electrical'],
      ['pwr', 1, 'Power system', 'Electrical'],
      ['pwr_pdb', 2, 'Power distribution board design', 'Electrical', '10-12', '11-27', 50, ['rules']],
      ['pwr_fab', 2, 'Battery pack & PCB fabrication', 'Electrical', '01-04', '02-05', 0, ['pwr_pdb']],
      ['mc_design', 1, 'Motor controller board design', 'Electrical', '11-02', '12-18', 25, ['rules']],
      ['mc_fab', 1, 'Controller board fabrication & test', 'Electrical', '01-11', '02-12', 0, ['mc_design']],
      ['el_harness', 1, 'Wiring harness build', 'Electrical', '02-15', '02-24', 0, ['pwr_fab', 'mc_fab']],

      ['sw', 0, 'Software, Autonomy & Navigation', 'Software'],
      ['sw_arch', 1, 'Software architecture & ROS 2 framework', 'Software', '09-21', '10-16', 100, ['rules']],
      ['sw_auto', 1, 'Autonomy & navigation', 'Software'],
      ['sw_sim', 2, 'Simulation environment', 'Software', '10-19', '11-20', 60, ['sw_arch']],
      ['sw_loc', 2, 'Localization & sensor fusion', 'Software', '11-23', '01-29', 0, ['sw_sim']],
      ['sw_plan', 2, 'Path planning & obstacle avoidance', 'Software', '02-01', '03-12', 0, ['sw_loc']],
      ['sw_tele', 1, 'Teleoperation & operator GUI', 'Software', '10-19', '01-29', 25, ['sw_arch']],

      ['com', 0, 'Communications & Base Station', 'Electrical'],
      ['com_base', 1, 'Link budget & base station design', 'Electrical', '10-12', '12-18', 30, ['rules']],
      ['com_fab', 1, 'Base station build & antenna tracker', 'Electrical', '01-04', '02-19', 0, ['com_base']],

      ['int', 0, 'System Integration & Test', 'Systems'],
      ['int_mech', 1, 'Mechanical build-up & subsystem mounting', 'Mechanical', '02-27', '03-12', 0,
        ['ch_test', 'arm_ctrl', 'sci_done']],
      ['int_wire', 1, 'Harness & power-on integration', 'Electrical', '03-13', '03-26', 0,
        ['int_mech', 'el_harness', 'com_fab']],
      ['int_sw', 1, 'Software/hardware integration', 'Software', '03-27', '04-16', 0,
        ['int_wire', 'sw_plan', 'sw_tele']],
      ['int_test', 1, 'Full-system test campaign', 'Systems', '04-17', '05-07', 0, ['int_sw']],
      ['dry', 1, 'URC mission dry runs', 'Systems', null, null, 0, [], 'u'],
      ['dry_sci', 2, 'Science mission dry run', 'Science', '05-08', '05-11', 0, ['int_test'], 'u'],
      ['dry_del', 2, 'Delivery mission dry run', 'Mechanical', '05-12', '05-15', 0, ['dry_sci'], 'u'],
      ['dry_eq', 2, 'Equipment Servicing mission dry run', 'Systems', '05-16', '05-19', 0, ['dry_del'], 'u'],
      ['dry_auto', 2, 'Autonomous Navigation mission dry run', 'Software', '05-20', '05-23', 0, ['dry_eq'], 'u'],
      ['signoff', 1, 'Rover sign-off & pack-out ready (set date)', 'Systems', '05-24', '05-24', 0, ['dry_auto'], 'um', SET],
    ];

    const tasks = spec.map((s) => {
      const [key, level, name, owner, start, end, progress, deps, flags, notes] = s;
      const f = flags || '';
      const s0 = yr(start || '09-01'), e0 = yr(end || start || '09-01');
      return {
        id: 't_' + key,
        name,
        level,
        start: s0,
        end: e0,
        progress: progress || 0,
        owner,
        deps: (deps || []).map((k) => ({ id: 't_' + k, lag: 0 })),
        milestone: f.indexOf('m') >= 0,
        urc: f.indexOf('u') >= 0,
        collapsed: false,
        notes: notes || '',
      };
    });
    // Store the rolled-up values on summaries so the raw data is self-consistent
    // (they are ignored by the app, which always recomputes them).
    const project = Object.assign(newProject(), { statusDate: '2026-11-13', tasks });
    const rs = rows(project);
    project.tasks = tasks.map((t, i) =>
      rs[i].isSummary ? Object.assign({}, t, { start: rs[i].start, end: rs[i].end, progress: rs[i].progress }) : t);
    return project;
  }

  root.TF.model = {
    newId, newTask, newProject, sampleProject, normalize, rows, findIndex, subtreeEnd,
    updateTask, addTask, addChild, deleteTask, indent, outdent, move, shiftTask, setCollapsed,
    parseDeps, formatDeps, owners,
    _wouldCycle: wouldCycle,
  };
})();
