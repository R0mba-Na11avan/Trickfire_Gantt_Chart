/* TF.cpm - critical path analysis on the dates as entered, dependency violations and auto-scheduling. */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  root.TF = root.TF || {};
  const D = root.TF.dates;
  const M = root.TF.model;

  /**
   * Build the working graph over non-summary tasks.
   * preds[id] = [{ id, lag }] (only existing, non-summary, non-self predecessors).
   * cycle = Set of task ids that sit on a dependency cycle (strongly connected component of size > 1).
   * order = topological order (list order as tie-break) of every non-cycle leaf, using edges between them only.
   */
  function buildGraph(project) {
    const rs = M.rows(project);
    const leaves = rs.filter((r) => !r.isSummary);
    const leafById = new Map(leaves.map((r) => [r.task.id, r]));
    const preds = new Map();
    for (const r of leaves) {
      const list = [];
      const seen = new Set();
      for (const d of r.task.deps) {
        if (d.id === r.task.id || !leafById.has(d.id) || seen.has(d.id)) continue;
        seen.add(d.id);
        list.push({ id: d.id, lag: Math.round(Number(d.lag)) || 0 });
      }
      preds.set(r.task.id, list);
    }

    // Tarjan SCC (recursive; schedules are small) to find exact cycle members.
    const cycle = new Set();
    const idx = new Map(), low = new Map(), onStack = new Set();
    const stack = [];
    let counter = 0;
    function strong(v) {
      idx.set(v, counter); low.set(v, counter); counter++;
      stack.push(v); onStack.add(v);
      for (const e of preds.get(v)) {
        if (!idx.has(e.id)) {
          strong(e.id);
          low.set(v, Math.min(low.get(v), low.get(e.id)));
        } else if (onStack.has(e.id)) {
          low.set(v, Math.min(low.get(v), idx.get(e.id)));
        }
      }
      if (low.get(v) === idx.get(v)) {
        const comp = [];
        let w;
        do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
        if (comp.length > 1) comp.forEach((c) => cycle.add(c));
      }
    }
    for (const r of leaves) if (!idx.has(r.task.id)) strong(r.task.id);

    // Kahn topological order over the acyclic part.
    const dagLeaves = leaves.filter((r) => !cycle.has(r.task.id));
    const succs = new Map(dagLeaves.map((r) => [r.task.id, []]));
    const indeg = new Map();
    for (const r of dagLeaves) {
      let n = 0;
      for (const e of preds.get(r.task.id)) {
        if (cycle.has(e.id)) continue;
        succs.get(e.id).push({ id: r.task.id, lag: e.lag });
        n++;
      }
      indeg.set(r.task.id, n);
    }
    const order = [];
    const queue = dagLeaves.filter((r) => indeg.get(r.task.id) === 0).map((r) => r.task.id);
    for (let q = 0; q < queue.length; q++) {
      const id = queue[q];
      order.push(id);
      for (const s of succs.get(id)) {
        indeg.set(s.id, indeg.get(s.id) - 1);
        if (indeg.get(s.id) === 0) queue.push(s.id);
      }
    }
    return { rs, leaves, leafById, preds, succs, cycle, order };
  }

  function compute(project) {
    const g = buildGraph(project);
    const { rs, leaves, leafById, preds, succs, cycle, order } = g;
    const info = {};
    const cycleIds = leaves.filter((r) => cycle.has(r.task.id)).map((r) => r.task.id);

    const startDay = (id) => D.toDay(leafById.get(id).start);
    const endDay = (id) => D.toDay(leafById.get(id).end);

    let projectEndDay = null;
    for (const r of leaves) {
      const e = D.toDay(r.end);
      if (projectEndDay === null || e > projectEndDay) projectEndDay = e;
    }

    // Violations: end(pred) + lag must be strictly before start(task).
    const violationsOf = (id) => {
      const out = [];
      for (const e of preds.get(id)) {
        const need = endDay(e.id) + e.lag + 1; // earliest legal start
        const days = need - startDay(id);
        if (days > 0) out.push({ predId: e.id, days });
      }
      return out;
    };

    // Backward pass.
    const lateStart = new Map();
    for (let k = order.length - 1; k >= 0; k--) {
      const id = order[k];
      let lf = projectEndDay;
      for (const s of succs.get(id)) lf = Math.min(lf, lateStart.get(s.id) - s.lag - 1);
      const dur = endDay(id) - startDay(id) + 1; // milestones count as 1 day
      lateStart.set(id, lf - (dur - 1));
      const tf = lf - endDay(id);
      info[id] = { totalFloat: tf, critical: tf <= 0, violations: violationsOf(id) };
    }
    for (const id of cycleIds) info[id] = { totalFloat: 0, critical: false, violations: violationsOf(id) };

    // Summaries: min float / any-critical over their leaf descendants.
    for (let i = 0; i < rs.length; i++) {
      if (!rs[i].isSummary) continue;
      const end = M.subtreeEnd(project, i);
      let tf = null, crit = false;
      for (let j = i + 1; j < end; j++) {
        if (rs[j].isSummary) continue;
        const li = info[rs[j].task.id];
        if (tf === null || li.totalFloat < tf) tf = li.totalFloat;
        if (li.critical) crit = true;
      }
      info[rs[i].task.id] = { totalFloat: tf === null ? 0 : tf, critical: crit, violations: [] };
    }

    const criticalIds = leaves.filter((r) => info[r.task.id].critical).map((r) => r.task.id);

    // Driving critical links: both ends critical and no slack on the link itself.
    const criticalEdges = [];
    for (const r of leaves) {
      const id = r.task.id;
      if (!info[id].critical) continue;
      for (const e of preds.get(id)) {
        if (!info[e.id].critical) continue;
        const slack = startDay(id) - e.lag - 1 - endDay(e.id);
        if (slack <= 0) criticalEdges.push({ from: e.id, to: id });
      }
    }

    return {
      info,
      criticalIds,
      criticalEdges,
      projectEnd: projectEndDay === null ? null : D.fromDay(projectEndDay),
      hasCycle: cycleIds.length > 0,
      cycleIds,
    };
  }

  /** Push tasks later so every link is satisfied (duration preserved, never earlier). */
  function autoSchedule(project) {
    const g = buildGraph(project);
    const newStart = new Map(); // id -> start day after scheduling
    const shiftBy = new Map();
    for (const id of g.order) {
      const r = g.leafById.get(id);
      let s = D.toDay(r.start);
      for (const e of g.preds.get(id)) {
        if (g.cycle.has(e.id)) continue;
        const pEnd = newStart.get(e.id) + (D.toDay(g.leafById.get(e.id).end) - D.toDay(g.leafById.get(e.id).start));
        s = Math.max(s, pEnd + e.lag + 1);
      }
      newStart.set(id, s);
      const delta = s - D.toDay(r.start);
      if (delta > 0) shiftBy.set(id, delta);
    }
    if (!shiftBy.size) return project;
    const tasks = project.tasks.map((t) => {
      const d = shiftBy.get(t.id);
      return d ? Object.assign({}, t, { start: D.addDays(t.start, d), end: D.addDays(t.end, d) }) : t;
    });
    return Object.assign({}, project, { tasks });
  }

  function wouldCycle(project, taskId, predId) {
    return M._wouldCycle(project, taskId, predId);
  }

  root.TF.cpm = { compute, autoSchedule, wouldCycle };
})();
