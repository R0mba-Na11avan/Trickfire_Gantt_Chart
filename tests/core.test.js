'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

require('../js/dates.js');
require('../js/model.js');
require('../js/cpm.js');
require('../js/store.js');

const TF = globalThis.TF;
const { dates: D, model: M, cpm: C, store: S } = TF;

// ---------------------------------------------------------------- helpers

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

/** Build a project from compact task specs; ids are the keys. */
function mk(specs, extra) {
  const tasks = specs.map(([id, level, start, end, deps, more]) =>
    Object.assign({
      id, name: 'Task ' + id, level, start, end, progress: 0, owner: '',
      deps: (deps || []).map((d) => (typeof d === 'string' ? { id: d, lag: 0 } : d)),
      milestone: false, urc: false, collapsed: false, notes: '',
    }, more || {}));
  return Object.assign(M.newProject(), { statusDate: '2026-11-13' }, extra || {}, { tasks });
}
const ids = (p) => p.tasks.map((t) => t.id);
const levels = (p) => p.tasks.map((t) => t.level);

// ---------------------------------------------------------------- dates

test('dates: toDay/fromDay round trip and known values', () => {
  assert.equal(D.toDay('1970-01-01'), 0);
  assert.equal(D.toDay('1970-01-02'), 1);
  assert.equal(D.fromDay(0), '1970-01-01');
  for (const iso of ['2026-09-01', '2027-06-30', '2028-02-29', '1999-12-31']) {
    assert.equal(D.fromDay(D.toDay(iso)), iso);
  }
  assert.throws(() => D.toDay('2026-02-30'));
});

test('dates: isValid is strict', () => {
  assert.ok(D.isValid('2026-09-01'));
  assert.ok(D.isValid('2028-02-29'));
  for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-9-1', '26-09-01', '2026-09-31', '', null, undefined, 20260901, '2026-09-01T00:00']) {
    assert.equal(D.isValid(bad), false, String(bad));
  }
});

test('dates: addDays/diff/duration across month, year boundaries and leap day', () => {
  assert.equal(D.addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(D.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(D.addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(D.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(D.addDays('2028-02-29', 1), '2028-03-01');
  assert.equal(D.addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(D.diff('2026-09-01', '2026-09-08'), 7);
  assert.equal(D.diff('2026-09-08', '2026-09-01'), -7);
  assert.equal(D.diff('2028-02-28', '2028-03-01'), 2);
  assert.equal(D.duration('2026-09-14', '2026-09-14'), 1);
  assert.equal(D.duration('2026-09-14', '2026-10-11'), 28);
});

test('dates: DST transitions do not shift day math', () => {
  // US DST changes: 2027-03-14 and 2026-11-01
  assert.equal(D.addDays('2027-03-13', 1), '2027-03-14');
  assert.equal(D.addDays('2027-03-13', 2), '2027-03-15');
  assert.equal(D.diff('2027-03-01', '2027-04-01'), 31);
  assert.equal(D.addDays('2026-10-31', 2), '2026-11-02');
  assert.equal(D.diff('2026-10-01', '2026-12-01'), 61);
});

test('dates: weekStart returns the Monday on or before', () => {
  assert.equal(D.weekStart('2026-09-14'), '2026-09-14'); // a Monday
  assert.equal(D.weekStart('2026-09-20'), '2026-09-14'); // Sunday
  assert.equal(D.weekStart('2026-09-16'), '2026-09-14');
  assert.equal(D.weekStart('2026-09-01'), '2026-08-31'); // Tuesday -> crosses month
  assert.equal(D.weekStart('2027-01-01'), '2026-12-28'); // crosses year
  assert.equal(D.weekStart('2028-03-01'), '2028-02-28'); // leap year, Wednesday
  assert.equal(D.weekStart('1970-01-01'), '1969-12-29');
});

test('dates: monthStart/monthEnd', () => {
  assert.equal(D.monthStart('2026-09-14'), '2026-09-01');
  assert.equal(D.monthEnd('2026-09-14'), '2026-09-30');
  assert.equal(D.monthEnd('2026-12-05'), '2026-12-31');
  assert.equal(D.monthEnd('2027-02-01'), '2027-02-28');
  assert.equal(D.monthEnd('2028-02-10'), '2028-02-29');
});

test('dates: min/max/clamp', () => {
  assert.equal(D.min('2026-09-01', '2026-10-01'), '2026-09-01');
  assert.equal(D.max('2026-09-01', '2026-10-01'), '2026-10-01');
  assert.equal(D.clamp('2026-08-01', '2026-09-01', '2027-06-30'), '2026-09-01');
  assert.equal(D.clamp('2027-08-01', '2026-09-01', '2027-06-30'), '2027-06-30');
  assert.equal(D.clamp('2026-12-25', '2026-09-01', '2027-06-30'), '2026-12-25');
});

test('dates: formatting and today()', () => {
  assert.equal(D.fmtShort('2026-09-14'), 'Sep 14');
  assert.equal(D.fmtShort('2026-09-04'), 'Sep 4');
  assert.equal(D.fmtLong('2026-09-14'), 'Sep 14, 2026');
  assert.equal(D.fmtMonth('2026-09-14'), 'SEP 2026');
  assert.equal(D.MONTHS_SHORT.length, 12);
  assert.ok(D.isValid(D.today()));
});

// ---------------------------------------------------------------- model basics

test('model: newId, newTask, newProject', () => {
  assert.match(M.newId(), /^t_[0-9a-z]{6}$/);
  assert.notEqual(M.newId(), M.newId());
  const t = M.newTask();
  assert.equal(t.name, 'New task');
  assert.equal(t.level, 0);
  assert.equal(D.duration(t.start, t.end), 7);
  assert.deepEqual([t.progress, t.owner, t.deps, t.milestone, t.urc, t.collapsed, t.notes], [0, '', [], false, false, false, '']);
  const m = M.newTask({ start: '2026-10-01', milestone: true, progress: 150 });
  assert.equal(m.end, '2026-10-01');
  assert.equal(m.progress, 100);
  const p = M.newProject();
  assert.deepEqual(p.tasks, []);
  assert.equal(p.statusDate, null);
  assert.equal(p.rangeStart, '2026-09-01');
  assert.equal(p.rangeEnd, '2027-06-30');
  assert.equal(p.team, 'TrickFire Robotics');
});

// ---------------------------------------------------------------- rows

function outline() {
  // 1 A (summary) -> 1.1 B, 1.2 C (summary) -> 1.2.1 D, 1.2.2 E ; 2 F ; 3 G (summary) -> 3.1 H
  return mk([
    ['A', 0, '2026-09-01', '2026-09-01'],
    ['B', 1, '2026-09-01', '2026-09-10', [], { progress: 100 }],            // 10d, 100
    ['C', 1, '2026-01-01', '2026-01-01'],
    ['D', 2, '2026-09-11', '2026-09-30', [], { progress: 50 }],             // 20d, 50
    ['E', 2, '2026-09-20', '2026-10-09', [], { progress: 0 }],              // 20d, 0
    ['F', 0, '2026-10-01', '2026-10-03', [], { progress: 33 }],
    ['G', 0, '2026-10-05', '2026-10-05'],
    ['H', 1, '2026-10-06', '2026-10-06', [], { milestone: true, progress: 100 }],
  ]);
}

test('rows: WBS numbering, parents, children and summary flags', () => {
  const rs = M.rows(outline());
  assert.deepEqual(rs.map((r) => r.wbs), ['1', '1.1', '1.2', '1.2.1', '1.2.2', '2', '3', '3.1']);
  assert.deepEqual(rs.map((r) => r.isSummary), [true, false, true, false, false, false, true, false]);
  assert.deepEqual(rs.map((r) => r.parentId), [null, 'A', 'A', 'C', 'C', null, null, 'G']);
  assert.deepEqual(rs[0].childIds, ['B', 'C']);
  assert.deepEqual(rs[2].childIds, ['D', 'E']);
  assert.deepEqual(rs[1].childIds, []);
  assert.deepEqual(rs.map((r) => r.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(rs[3].task.id, 'D');
});

test('rows: summary rollups (min start, max end, duration-weighted progress)', () => {
  const rs = M.rows(outline());
  // C: D(20d@50) + E(20d@0) -> 25
  assert.equal(rs[2].start, '2026-09-11');
  assert.equal(rs[2].end, '2026-10-09');
  assert.equal(rs[2].progress, 25);
  assert.equal(rs[2].duration, 29);
  // A: B(10d@100)+D(20d@50)+E(20d@0) = (1000+1000)/50 = 40
  assert.equal(rs[0].start, '2026-09-01');
  assert.equal(rs[0].end, '2026-10-09');
  assert.equal(rs[0].progress, 40);
  // G has only a milestone (weight 1, 100%)
  assert.equal(rs[6].start, '2026-10-06');
  assert.equal(rs[6].progress, 100);
  // leaf rows: milestone duration 0, others inclusive
  assert.equal(rs[7].duration, 0);
  assert.equal(rs[1].duration, 10);
  assert.equal(rs[5].progress, 33);
});

test('rows: milestone weighs 1 day in rollup', () => {
  const p = mk([
    ['S', 0, '2026-09-01', '2026-09-01'],
    ['T', 1, '2026-09-01', '2026-09-03', [], { progress: 0 }],      // 3d @0
    ['M', 1, '2026-09-04', '2026-09-04', [], { milestone: true, progress: 100 }], // 1d @100
  ]);
  assert.equal(M.rows(p)[0].progress, 25);
});

test('rows: visibility under collapse (nested)', () => {
  let p = outline();
  assert.ok(M.rows(p).every((r) => r.visible));
  p = M.setCollapsed(p, 'C', true);
  assert.deepEqual(M.rows(p).map((r) => r.visible), [true, true, true, false, false, true, true, true]);
  p = M.setCollapsed(p, 'A', true);
  assert.deepEqual(M.rows(p).map((r) => r.visible), [true, false, false, false, false, true, true, true]);
  // expanding C while A stays collapsed keeps descendants hidden
  p = M.setCollapsed(p, 'C', false);
  assert.deepEqual(M.rows(p).map((r) => r.visible), [true, false, false, false, false, true, true, true]);
  p = M.setCollapsed(p, 'A', false);
  assert.ok(M.rows(p).every((r) => r.visible));
});

test('rows: empty project and does not mutate', () => {
  assert.deepEqual(M.rows(M.newProject()), []);
  const p = deepFreeze(outline());
  assert.doesNotThrow(() => M.rows(p));
});

test('findIndex / subtreeEnd', () => {
  const p = outline();
  assert.equal(M.findIndex(p, 'D'), 3);
  assert.equal(M.findIndex(p, 'nope'), -1);
  assert.equal(M.subtreeEnd(p, 0), 5);
  assert.equal(M.subtreeEnd(p, 2), 5);
  assert.equal(M.subtreeEnd(p, 1), 2);
  assert.equal(M.subtreeEnd(p, 7), 8);
});

// ---------------------------------------------------------------- mutations

test('updateTask: start only preserves duration; end/milestone/progress invariants', () => {
  const p = deepFreeze(mk([['A', 0, '2026-09-01', '2026-09-10']]));
  let q = M.updateTask(p, 'A', { start: '2026-09-05' });
  assert.deepEqual([q.tasks[0].start, q.tasks[0].end], ['2026-09-05', '2026-09-14']);
  q = M.updateTask(p, 'A', { start: '2026-09-20', end: '2026-09-22' });
  assert.deepEqual([q.tasks[0].start, q.tasks[0].end], ['2026-09-20', '2026-09-22']);
  q = M.updateTask(p, 'A', { end: '2026-08-01' }); // before start => clamp to start
  assert.equal(q.tasks[0].end, '2026-09-01');
  q = M.updateTask(p, 'A', { start: '2026-09-20', end: '2026-09-01' });
  assert.equal(q.tasks[0].end, '2026-09-20');
  q = M.updateTask(p, 'A', { milestone: true });
  assert.equal(q.tasks[0].end, q.tasks[0].start);
  q = M.updateTask(q, 'A', { start: '2026-10-01' });
  assert.deepEqual([q.tasks[0].start, q.tasks[0].end], ['2026-10-01', '2026-10-01']);
  assert.equal(M.updateTask(p, 'A', { progress: 140.6 }).tasks[0].progress, 100);
  assert.equal(M.updateTask(p, 'A', { progress: -4 }).tasks[0].progress, 0);
  assert.equal(M.updateTask(p, 'A', { progress: 33.4 }).tasks[0].progress, 33);
  assert.equal(M.updateTask(p, 'A', { start: 'garbage' }).tasks[0].start, '2026-09-01');
  assert.equal(M.updateTask(p, 'A', { id: 'hijack', name: 'X' }).tasks[0].id, 'A');
  assert.equal(M.updateTask(p, 'A', { name: 'X' }).tasks[0].name, 'X');
  assert.equal(M.updateTask(p, 'zzz', { name: 'X' }), p);
  assert.equal(p.tasks[0].name, 'Task A');
});

test('addTask: after subtree, same level; null appends at level 0; unknown id', () => {
  const p = deepFreeze(outline());
  const r = M.addTask(p, 'A', { name: 'New' });
  assert.deepEqual(ids(r.project).slice(0, 7), ['A', 'B', 'C', 'D', 'E', r.id, 'F']);
  const t = r.project.tasks[5];
  assert.equal(t.level, 0);
  assert.equal(t.name, 'New');
  assert.ok(D.isValid(t.start) && D.isValid(t.end));
  const r2 = M.addTask(p, 'D');
  assert.deepEqual(ids(r2.project).slice(3, 6), ['D', r2.id, 'E']);
  assert.equal(r2.project.tasks[4].level, 2);
  const r3 = M.addTask(p, null);
  assert.equal(r3.project.tasks.at(-1).id, r3.id);
  assert.equal(r3.project.tasks.at(-1).level, 0);
  assert.equal(r3.project.tasks.at(-1).start, '2026-11-13'); // statusDate
  const r4 = M.addTask(p, 'nope');
  assert.equal(r4.project, p);
  assert.equal(r4.id, null);
  assert.equal(p.tasks.length, 8);
  const r5 = M.addTask(M.newProject(), null, { milestone: true, start: '2026-10-10' });
  assert.equal(r5.project.tasks[0].end, '2026-10-10');
  assert.equal(r5.project.tasks[0].milestone, true);
});

test('addChild: last child at level+1, expands collapsed parent, makes a summary', () => {
  const p = deepFreeze(outline());
  const r = M.addChild(p, 'C', { name: 'kid' });
  assert.deepEqual(ids(r.project).slice(2, 7), ['C', 'D', 'E', r.id, 'F']);
  assert.equal(r.project.tasks[5].level, 2);
  const leaf = M.addChild(p, 'F');
  assert.equal(leaf.project.tasks[6].level, 1);
  assert.equal(M.rows(leaf.project)[5].isSummary, true);
  const collapsed = M.setCollapsed(p, 'C', true);
  assert.equal(M.addChild(collapsed, 'C').project.tasks[2].collapsed, false);
  assert.equal(M.addChild(p, 'nope').id, null);
});

test('deleteTask: removes descendants and dangling deps', () => {
  const p = deepFreeze(mk([
    ['A', 0, '2026-09-01', '2026-09-02'],
    ['B', 1, '2026-09-01', '2026-09-02'],
    ['C', 1, '2026-09-03', '2026-09-04', ['B']],
    ['D', 0, '2026-09-10', '2026-09-12', ['C', 'B', { id: 'E', lag: 0 }]],
    ['E', 0, '2026-09-01', '2026-09-02'],
  ]));
  const q = M.deleteTask(p, 'A');
  assert.deepEqual(ids(q), ['D', 'E']);
  assert.deepEqual(q.tasks[0].deps, [{ id: 'E', lag: 0 }]);
  assert.deepEqual(ids(M.deleteTask(p, 'C')), ['A', 'B', 'D', 'E']);
  assert.deepEqual(M.deleteTask(p, 'C').tasks[2].deps, [{ id: 'B', lag: 0 }, { id: 'E', lag: 0 }]);
  assert.equal(M.deleteTask(p, 'zzz'), p);
  assert.equal(p.tasks.length, 5);
});

test('indent / outdent edge cases', () => {
  const p = deepFreeze(outline());
  assert.equal(M.indent(p, 'A'), p, 'first task cannot indent');
  assert.equal(M.indent(p, 'B'), p, 'already a child of the previous task');
  assert.equal(M.indent(p, 'D'), p);
  assert.equal(M.outdent(p, 'A'), p, 'level 0');
  assert.equal(M.outdent(p, 'F'), p);
  assert.equal(M.indent(p, 'zzz'), p);
  // indent F (level 0, previous task level 2) -> level 1; it has no children
  const q = M.indent(p, 'F');
  assert.deepEqual(levels(q), [0, 1, 1, 2, 2, 1, 0, 1]);
  // indent a task with a subtree: G (with H) after F
  const r = M.indent(M.indent(p, 'F'), 'G');
  assert.deepEqual(levels(r), [0, 1, 1, 2, 2, 1, 1, 2]);
  assert.equal(M.indent(r, 'H'), r, 'cannot exceed previous level + 1');
  // outdent C moves its subtree up
  const o = M.outdent(p, 'C');
  assert.deepEqual(levels(o), [0, 1, 0, 1, 1, 0, 0, 1]);
  assert.equal(M.rows(o)[2].isSummary, true);
  assert.deepEqual(M.rows(o).map((x) => x.wbs), ['1', '1.1', '2', '2.1', '2.2', '3', '4', '4.1']);
});

test('move: swaps with previous/next sibling subtrees; no-ops at the ends', () => {
  const p = deepFreeze(outline());
  assert.equal(M.move(p, 'A', -1), p, 'first sibling up');
  assert.equal(M.move(p, 'G', 1), p, 'last sibling down');
  assert.equal(M.move(p, 'B', -1), p, 'first child up');
  assert.equal(M.move(p, 'C', 1), p, 'last child down');
  assert.equal(M.move(p, 'A', 0), p);
  assert.equal(M.move(p, 'zzz', 1), p);
  // A (with subtree) down swaps with F
  assert.deepEqual(ids(M.move(p, 'A', 1)), ['F', 'A', 'B', 'C', 'D', 'E', 'G', 'H']);
  // G up swaps with F
  assert.deepEqual(ids(M.move(p, 'G', -1)), ['A', 'B', 'C', 'D', 'E', 'G', 'H', 'F']);
  // B down swaps with subtree C
  assert.deepEqual(ids(M.move(p, 'B', 1)), ['A', 'C', 'D', 'E', 'B', 'F', 'G', 'H']);
  // C up swaps with B
  assert.deepEqual(ids(M.move(p, 'C', -1)), ['A', 'C', 'D', 'E', 'B', 'F', 'G', 'H']);
  // F up moves above the whole A subtree
  assert.deepEqual(ids(M.move(p, 'F', -1)), ['F', 'A', 'B', 'C', 'D', 'E', 'G', 'H']);
  // levels preserved
  assert.deepEqual(levels(M.move(p, 'B', 1)), [0, 1, 2, 2, 1, 0, 0, 1]);
});

test('shiftTask: leaf, milestone, and summary shifts all descendants', () => {
  const p = deepFreeze(outline());
  const q = M.shiftTask(p, 'B', 3);
  assert.deepEqual([q.tasks[1].start, q.tasks[1].end], ['2026-09-04', '2026-09-13']);
  assert.equal(q.tasks[3], p.tasks[3]);
  const s = M.shiftTask(p, 'C', -2);
  assert.deepEqual([s.tasks[3].start, s.tasks[3].end, s.tasks[4].start, s.tasks[4].end],
    ['2026-09-09', '2026-09-28', '2026-09-18', '2026-10-07']);
  assert.equal(s.tasks[1], p.tasks[1]);
  const rs = M.rows(s);
  assert.equal(rs[2].start, '2026-09-09');
  assert.equal(M.shiftTask(p, 'B', 0), p);
  assert.equal(M.shiftTask(p, 'zzz', 5), p);
  const m = M.shiftTask(p, 'H', 1);
  assert.deepEqual([m.tasks[7].start, m.tasks[7].end], ['2026-10-07', '2026-10-07']);
});

test('setCollapsed: sets flag, returns same project when unchanged', () => {
  const p = deepFreeze(outline());
  const q = M.setCollapsed(p, 'A', true);
  assert.equal(q.tasks[0].collapsed, true);
  assert.equal(p.tasks[0].collapsed, false);
  assert.equal(M.setCollapsed(p, 'A', false), p);
  assert.equal(M.setCollapsed(p, 'zzz', true), p);
});

test('mutation helpers never modify their inputs (frozen deep compare)', () => {
  const p = deepFreeze(mk([
    ['A', 0, '2026-09-01', '2026-09-10'],
    ['B', 1, '2026-09-01', '2026-09-02'],
    ['C', 1, '2026-09-03', '2026-09-04', ['B']],
    ['D', 0, '2026-09-10', '2026-09-12', ['C']],
  ]));
  const snapshot = JSON.stringify(p);
  assert.doesNotThrow(() => {
    M.updateTask(p, 'B', { start: '2026-09-02', name: 'x', deps: [] });
    M.addTask(p, 'A'); M.addTask(p, null); M.addChild(p, 'D');
    M.deleteTask(p, 'B'); M.indent(p, 'D'); M.outdent(p, 'B');
    M.move(p, 'A', 1); M.shiftTask(p, 'A', 4); M.setCollapsed(p, 'A', true);
    C.autoSchedule(p); C.compute(p); M.rows(p); M.parseDeps('1.1', p, 'D'); M.formatDeps(p.tasks[3], p);
    S.toCSV(p); S.toJSON(p);
  });
  assert.equal(JSON.stringify(p), snapshot);
});

// ---------------------------------------------------------------- deps text

function depsProject() {
  // 1 A(summary) -> 1.1 B, 1.2 C ; 2 D ; 3 E (deps D) ; 4 F
  return mk([
    ['A', 0, '2026-09-01', '2026-09-01'],
    ['B', 1, '2026-09-01', '2026-09-05'],
    ['C', 1, '2026-09-06', '2026-09-10', ['B']],
    ['D', 0, '2026-09-11', '2026-09-15', ['C']],
    ['E', 0, '2026-09-16', '2026-09-20', ['D']],
    ['F', 0, '2026-09-21', '2026-09-22'],
  ]);
}

test('parseDeps: wbs refs with lag', () => {
  const p = depsProject();
  const r = M.parseDeps('1.1, 2+3, 3-2', p, 'F');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.deps, [{ id: 'B', lag: 0 }, { id: 'D', lag: 3 }, { id: 'E', lag: -2 }]);
  assert.deepEqual(M.parseDeps('', p, 'F'), { deps: [], errors: [] });
  assert.deepEqual(M.parseDeps('  2 + 3 ; 1.2', p, 'F').deps, [{ id: 'D', lag: 3 }, { id: 'C', lag: 0 }]);
  assert.deepEqual(M.parseDeps('2, 2', p, 'F').deps, [{ id: 'D', lag: 0 }]);
});

test('parseDeps: error cases (self, unknown, summary, cycle, syntax)', () => {
  const p = depsProject();
  let r = M.parseDeps('4', p, 'F'); // self
  assert.equal(r.deps.length, 0); assert.equal(r.errors.length, 1); assert.match(r.errors[0], /itself/);
  r = M.parseDeps('9.9', p, 'F'); // unknown
  assert.equal(r.deps.length, 0); assert.match(r.errors[0], /does not match/);
  r = M.parseDeps('1', p, 'F'); // summary
  assert.equal(r.deps.length, 0); assert.match(r.errors[0], /summary/);
  // B (1.1) depending on E (3) would be B <- E <- D <- C <- B : cycle
  r = M.parseDeps('3', p, 'B');
  assert.equal(r.deps.length, 0); assert.match(r.errors[0], /circular/);
  r = M.parseDeps('abc', p, 'F');
  assert.equal(r.deps.length, 0); assert.match(r.errors[0], /not a valid/);
  // mixed: good refs survive, each bad one reports
  r = M.parseDeps('2, 4, 1, 7, x', p, 'F');
  assert.deepEqual(r.deps, [{ id: 'D', lag: 0 }]);
  assert.equal(r.errors.length, 4);
});

test('formatDeps / parseDeps round trip', () => {
  const p = depsProject();
  const text = '1.1, 2+3, 3-2';
  const parsed = M.parseDeps(text, p, 'F');
  const q = M.updateTask(p, 'F', { deps: parsed.deps });
  const f = M.formatDeps(q.tasks[5], q);
  assert.equal(f, text);
  assert.deepEqual(M.parseDeps(f, q, 'F').deps, parsed.deps);
  assert.equal(M.formatDeps(p.tasks[0], p), '');
  assert.equal(M.formatDeps(p.tasks[2], p), '1.1');
  // unknown dep ids are skipped when formatting
  assert.equal(M.formatDeps({ deps: [{ id: 'gone', lag: 1 }] }, p), '');
});

test('owners: sorted unique non-empty', () => {
  const p = mk([
    ['A', 0, '2026-09-01', '2026-09-02', [], { owner: 'Software' }],
    ['B', 0, '2026-09-01', '2026-09-02', [], { owner: 'Electrical' }],
    ['C', 0, '2026-09-01', '2026-09-02', [], { owner: 'Software' }],
    ['D', 0, '2026-09-01', '2026-09-02', [], { owner: '  ' }],
  ]);
  assert.deepEqual(M.owners(p), ['Electrical', 'Software']);
  assert.deepEqual(M.owners(M.newProject()), []);
});

// ---------------------------------------------------------------- normalize

test('normalize: rejects non-projects', () => {
  assert.throws(() => M.normalize(null));
  assert.throws(() => M.normalize('x'));
  assert.throws(() => M.normalize({}));
  assert.throws(() => M.normalize({ tasks: 'nope' }));
  assert.doesNotThrow(() => M.normalize({ tasks: [] }));
});

test('normalize: repairs levels, dates, progress, ids, milestones and deps', () => {
  const p = M.normalize({
    title: 5, rangeStart: '2027-06-30', rangeEnd: '2026-09-01', statusDate: 'nope',
    tasks: [
      { id: 'a', name: 'First', level: 3, start: '2026-10-10', end: '2026-10-01', progress: 250, deps: [{ id: 'a', lag: 0 }, { id: 'ghost' }] },
      { id: 'a', name: 'Dup', level: 9, start: '2026-10-01', end: '2026-10-02', progress: -5, milestone: true, deps: [{ id: 'a', lag: '2.4' }] },
      { id: 'c', level: -2, start: 'bad', end: 'also bad' },
      { id: 'd', start: '2026-11-03', deps: [{ id: 'c', lag: 1 }, { id: 'c', lag: 5 }, 'junk', null] },
      null,
      { name: 'No id', level: 1, start: '2026-11-04', end: '2026-11-06' },
    ],
  });
  assert.equal(p.title, 'URC 2027 Integrated Master Schedule');
  assert.equal(p.rangeStart, '2026-09-01');
  assert.equal(p.rangeEnd, '2027-06-30');
  assert.equal(p.statusDate, null);
  assert.equal(p.logo, null);
  assert.equal(p.tasks.length, 5);
  const [a, dup, c, d, noId] = p.tasks;
  // levels: first 0, no jump > +1
  assert.deepEqual(p.tasks.map((t) => t.level), [0, 1, 0, 0, 1]);
  // reversed dates swapped, progress clamped
  assert.deepEqual([a.start, a.end, a.progress], ['2026-10-01', '2026-10-10', 100]);
  assert.deepEqual(a.deps, []); // self and unknown dropped
  // duplicate id replaced with a fresh unique id
  assert.notEqual(dup.id, 'a');
  assert.match(dup.id, /^t_/);
  assert.equal(new Set(p.tasks.map((t) => t.id)).size, 5);
  // milestone end forced to start, progress clamped, dep to the original 'a' kept with integer lag
  assert.equal(dup.end, dup.start);
  assert.equal(dup.progress, 0);
  assert.deepEqual(dup.deps, [{ id: 'a', lag: 2 }]);
  // invalid dates fall back to range start; single valid date makes a 1-day task
  assert.equal(c.start, '2026-09-01');
  assert.equal(D.isValid(c.end), true);
  assert.deepEqual([d.start, d.end], ['2026-11-03', '2026-11-03']);
  assert.deepEqual(d.deps, [{ id: 'c', lag: 1 }]); // deduped
  assert.match(noId.id, /^t_/);
  assert.equal(noId.name, 'No id');
  for (const t of p.tasks) {
    assert.deepEqual(Object.keys(t).sort(),
      ['collapsed', 'deps', 'end', 'id', 'level', 'milestone', 'name', 'notes', 'owner', 'progress', 'start', 'urc']);
  }
});

test('normalize is idempotent and does not mutate input', () => {
  const raw = deepFreeze({ tasks: [{ id: 'x', start: '2026-09-02', end: '2026-09-01' }] });
  const a = M.normalize(raw);
  assert.deepEqual(M.normalize(a), a);
});

// ---------------------------------------------------------------- CPM

/*
 * Hand-checked network (all days in September 2026, inclusive):
 *   A 1-5 (5d)             -> B 6-10 (5d)  -> D 11-15 (5d)
 *                          -> C 6-8  (3d)  -> D
 *   E 1-3 (3d), no links
 * projectEnd = 15.
 *   D: lateFinish 15, float 0.   B: lateFinish = 11-1 = 10, float 0.
 *   C: lateFinish = 10, end 8 => float 2.   A: min(B.lateStart 6, C.lateStart 6)-1 = 5, float 0.
 *   E: lateFinish 15, end 3 => float 12.
 */
function hand() {
  return mk([
    ['A', 0, '2026-09-01', '2026-09-05'],
    ['B', 0, '2026-09-06', '2026-09-10', ['A']],
    ['C', 0, '2026-09-06', '2026-09-08', ['A']],
    ['D', 0, '2026-09-11', '2026-09-15', ['B', 'C']],
    ['E', 0, '2026-09-01', '2026-09-03'],
  ]);
}

test('cpm.compute: floats, critical ids/edges, projectEnd on a hand-checked network', () => {
  const r = C.compute(hand());
  assert.deepEqual(Object.fromEntries(Object.entries(r.info).map(([k, v]) => [k, v.totalFloat])),
    { A: 0, B: 0, C: 2, D: 0, E: 12 });
  assert.deepEqual(r.criticalIds, ['A', 'B', 'D']);
  assert.deepEqual(r.criticalEdges, [{ from: 'A', to: 'B' }, { from: 'B', to: 'D' }]);
  assert.equal(r.projectEnd, '2026-09-15');
  assert.equal(r.hasCycle, false);
  assert.deepEqual(r.cycleIds, []);
  for (const v of Object.values(r.info)) assert.deepEqual(v.violations, []);
  assert.equal(r.info.C.critical, false);
  assert.equal(r.info.A.critical, true);
});

test('cpm.compute: summary info rolls up min float / any critical', () => {
  const p = mk([
    ['S1', 0, '2026-09-01', '2026-09-01'],
    ['C', 1, '2026-09-06', '2026-09-08', ['A']],
    ['E', 1, '2026-09-01', '2026-09-03'],
    ['S2', 0, '2026-09-01', '2026-09-01'],
    ['A', 1, '2026-09-01', '2026-09-05'],
    ['B', 1, '2026-09-06', '2026-09-10', ['A']],
    ['D', 0, '2026-09-11', '2026-09-15', ['B', 'C']],
  ]);
  const r = C.compute(p);
  assert.equal(r.info.S1.totalFloat, 2);
  assert.equal(r.info.S1.critical, false);
  assert.equal(r.info.S2.totalFloat, 0);
  assert.equal(r.info.S2.critical, true);
  assert.deepEqual(r.criticalIds, ['A', 'B', 'D']); // summaries are not listed
  assert.deepEqual(r.info.S2.violations, []);
});

test('cpm.compute: lag and negative lag', () => {
  // X 1-2; Y starts exactly end+lag+1 => tight and critical
  let p = mk([['X', 0, '2026-09-01', '2026-09-02'], ['Y', 0, '2026-09-05', '2026-09-06', [{ id: 'X', lag: 2 }]]]);
  let r = C.compute(p);
  assert.deepEqual(r.criticalIds, ['X', 'Y']);
  assert.deepEqual(r.criticalEdges, [{ from: 'X', to: 'Y' }]);
  assert.deepEqual(r.info.Y.violations, []);
  // one day of spare => X gets float 1
  p = mk([['X', 0, '2026-09-01', '2026-09-02'], ['Y', 0, '2026-09-06', '2026-09-07', [{ id: 'X', lag: 2 }]]]);
  r = C.compute(p);
  assert.equal(r.info.X.totalFloat, 1);
  assert.deepEqual(r.criticalIds, ['Y']);
  assert.deepEqual(r.criticalEdges, []);
  // negative lag (overlap allowed): tight at start = end - 1 + 1
  p = mk([['X', 0, '2026-09-01', '2026-09-05'], ['Y', 0, '2026-09-05', '2026-09-06', [{ id: 'X', lag: -1 }]]]);
  r = C.compute(p);
  assert.deepEqual(r.criticalIds, ['X', 'Y']);
  assert.deepEqual(r.info.Y.violations, []);
  // lag 3 where start only honors lag 2 => violation of 1 day
  p = mk([['X', 0, '2026-09-01', '2026-09-02'], ['Y', 0, '2026-09-05', '2026-09-06', [{ id: 'X', lag: 3 }]]]);
  assert.deepEqual(C.compute(p).info.Y.violations, [{ predId: 'X', days: 1 }]);
});

test('cpm.compute: violations report days needed', () => {
  const p = mk([
    ['X', 0, '2026-09-01', '2026-09-10'],
    ['Y', 0, '2026-09-04', '2026-09-06', ['X']], // needs to start 09-11: 7 days later
    ['Z', 0, '2026-09-10', '2026-09-12', ['X']], // start == end, still a violation: 1 day
    ['W', 0, '2026-09-11', '2026-09-12', ['X']], // exactly fine
  ]);
  const r = C.compute(p);
  assert.deepEqual(r.info.Y.violations, [{ predId: 'X', days: 7 }]);
  assert.deepEqual(r.info.Z.violations, [{ predId: 'X', days: 1 }]);
  assert.deepEqual(r.info.W.violations, []);
  assert.deepEqual(r.info.X.violations, []);
});

test('cpm.compute: milestones count as one day', () => {
  const p = mk([
    ['T', 0, '2026-09-01', '2026-09-03'],
    ['M', 0, '2026-09-04', '2026-09-04', ['T'], { milestone: true }],
  ]);
  const r = C.compute(p);
  assert.deepEqual(r.criticalIds, ['T', 'M']);
  assert.equal(r.projectEnd, '2026-09-04');
});

test('cpm.compute: ignores deps to/from summaries', () => {
  const p = mk([
    ['S', 0, '2026-09-01', '2026-09-01'],
    ['K', 1, '2026-09-01', '2026-09-05'],
    ['T', 0, '2026-09-02', '2026-09-03', ['S']], // dep on summary is ignored: no violation
  ]);
  const r = C.compute(p);
  assert.deepEqual(r.info.T.violations, []);
  assert.equal(r.hasCycle, false);
  assert.equal(r.projectEnd, '2026-09-05');
});

test('cpm.compute: cycles do not throw; members are non-critical with float 0', () => {
  const p = mk([
    ['P', 0, '2026-09-01', '2026-09-03', ['Q']],
    ['Q', 0, '2026-09-04', '2026-09-05', ['P']],
    ['R', 0, '2026-09-01', '2026-09-10'],
    ['S', 0, '2026-09-11', '2026-09-12', ['Q']], // downstream of the cycle, not a member
  ]);
  const r = C.compute(p);
  assert.equal(r.hasCycle, true);
  assert.deepEqual(r.cycleIds, ['P', 'Q']);
  assert.deepEqual([r.info.P.totalFloat, r.info.P.critical, r.info.Q.totalFloat, r.info.Q.critical], [0, false, 0, false]);
  assert.equal(r.info.S.critical, true); // ends at projectEnd
  assert.equal(r.projectEnd, '2026-09-12');
  assert.ok(!r.criticalIds.includes('P') && !r.criticalIds.includes('Q'));
  assert.doesNotThrow(() => C.autoSchedule(p));
  assert.equal(C.compute(mk([['A', 0, '2026-09-01', '2026-09-02', ['A']]])).hasCycle, false); // self dep ignored
});

test('cpm.compute: empty project', () => {
  const r = C.compute(M.newProject());
  assert.deepEqual(r, { info: {}, criticalIds: [], criticalEdges: [], projectEnd: null, hasCycle: false, cycleIds: [] });
});

test('cpm.wouldCycle', () => {
  const p = depsProject();
  assert.equal(C.wouldCycle(p, 'B', 'B'), true);
  assert.equal(C.wouldCycle(p, 'B', 'E'), true);   // E <- D <- C <- B
  assert.equal(C.wouldCycle(p, 'B', 'F'), false);
  assert.equal(C.wouldCycle(p, 'F', 'E'), false);
  assert.equal(C.wouldCycle(p, 'E', 'B'), false);
  assert.equal(C.wouldCycle(p, 'nope', 'B'), false);
});

test('cpm.autoSchedule: shifts later only, preserves duration, chains cascade', () => {
  const p = deepFreeze(mk([
    ['X', 0, '2026-09-01', '2026-09-10'],
    ['Y', 0, '2026-09-04', '2026-09-06', ['X']],          // -> 09-11..09-13
    ['Z', 0, '2026-09-07', '2026-09-08', [{ id: 'Y', lag: 2 }]], // Y.end 09-13 + 2 + 1 = 09-16..09-17
    ['W', 0, '2026-12-01', '2026-12-03', ['X']],          // already late: untouched
    ['M', 0, '2026-09-02', '2026-09-02', ['X'], { milestone: true }], // -> 09-11
  ]));
  const q = C.autoSchedule(p);
  assert.deepEqual([q.tasks[1].start, q.tasks[1].end], ['2026-09-11', '2026-09-13']);
  assert.deepEqual([q.tasks[2].start, q.tasks[2].end], ['2026-09-16', '2026-09-17']);
  assert.equal(q.tasks[3], p.tasks[3]);
  assert.deepEqual([q.tasks[4].start, q.tasks[4].end], ['2026-09-11', '2026-09-11']);
  assert.equal(q.tasks[0], p.tasks[0]);
  assert.equal(C.compute(q).info.Y.violations.length, 0);
  assert.ok(Object.values(C.compute(q).info).every((i) => i.violations.length === 0));
  // already consistent => unchanged
  assert.equal(C.autoSchedule(q), q);
  // negative lag is honored
  const n = mk([['X', 0, '2026-09-01', '2026-09-05'], ['Y', 0, '2026-09-01', '2026-09-02', [{ id: 'X', lag: -2 }]]]);
  assert.equal(C.autoSchedule(n).tasks[1].start, '2026-09-04');
});

// ---------------------------------------------------------------- sample project

test('sampleProject: structure, dates and dependencies', () => {
  const p = M.sampleProject();
  assert.equal(p.statusDate, '2026-11-13');
  assert.equal(p.team, 'TrickFire Robotics');
  assert.ok(p.tasks.length >= 45 && p.tasks.length <= 55, 'task count ' + p.tasks.length);
  assert.deepEqual(M.normalize(p), p, 'already normalized');
  assert.equal(new Set(ids(p)).size, p.tasks.length);
  assert.ok(Math.max(...levels(p)) >= 2);
  const rs = M.rows(p);
  // 8 top-level WBS branches in the specified order
  const top = rs.filter((r) => r.level === 0).map((r) => r.task.name);
  assert.equal(top.length, 8);
  assert.match(top[0], /^Program Management/);
  assert.match(top[1], /^Chassis/);
  assert.match(top[2], /^Robotic Arm/);
  assert.match(top[3], /^Science/);
  assert.match(top[4], /^Electrical/);
  assert.match(top[5], /^Software/);
  assert.match(top[6], /^Communications/);
  assert.match(top[7], /^System Integration/);
  for (const r of rs) {
    assert.ok(r.start >= '2026-09-01' && r.end <= '2027-06-30', r.task.name + ' out of range');
    assert.ok(r.task.start >= '2026-09-01' && r.task.end <= '2027-06-30');
    assert.ok(r.task.end >= r.task.start);
    if (r.task.milestone) assert.equal(r.task.end, r.task.start);
    if (!r.isSummary) for (const d of r.task.deps) {
      assert.equal(rs[M.findIndex(p, d.id)].isSummary, false, 'dep onto a summary');
    }
  }
  // owners are subteam names
  const allowed = new Set(['Mechanical', 'Electrical', 'Software', 'Science', 'Systems', 'Leadership']);
  assert.ok(M.owners(p).every((o) => allowed.has(o)), M.owners(p).join());
  // URC deliverables are urc:true; date-uncertain ones say "(set date)"
  const named = (re) => p.tasks.find((t) => re.test(t.name));
  for (const re of [/PDR submission/, /SAR/, /competition/i, /Science mission dry run/, /Delivery mission dry run/,
    /Equipment Servicing mission dry run/, /Autonomous Navigation mission dry run/]) {
    assert.equal(named(re).urc, true, String(re));
  }
  for (const t of p.tasks.filter((x) => x.urc && x.milestone)) assert.match(t.name, /\(set date\)/);
  // status: some complete, some in progress, later ones 0
  const leaves = rs.filter((r) => !r.isSummary);
  assert.ok(leaves.some((r) => r.progress === 100));
  assert.ok(leaves.some((r) => r.progress > 0 && r.progress < 100));
  assert.ok(leaves.some((r) => r.progress === 0));
  for (const r of leaves) {
    if (r.progress === 100) assert.ok(r.end <= p.statusDate, r.task.name + ' complete but ends after status date');
    if (r.start > p.statusDate) assert.equal(r.progress, 0, r.task.name);
  }
});

test('sampleProject: no violations, no cycles, one clear critical path ending at competition', () => {
  const p = M.sampleProject();
  const r = C.compute(p);
  assert.equal(r.hasCycle, false);
  for (const [id, v] of Object.entries(r.info)) assert.deepEqual(v.violations, [], id);
  assert.equal(C.autoSchedule(p), p, 'nothing to reschedule');

  const byId = new Map(p.tasks.map((t) => [t.id, t]));
  const lastId = r.criticalIds.reduce((a, b) => (byId.get(b).end > byId.get(a).end ? b : a));
  const last = byId.get(lastId);
  assert.match(last.name, /competition/i);
  assert.equal(last.milestone, true);
  assert.equal(r.projectEnd, last.end);
  assert.ok(r.criticalIds.length >= 10, 'critical chain length ' + r.criticalIds.length);

  // A single chain: every critical edge links consecutive critical tasks, one in / one out.
  assert.equal(r.criticalEdges.length, r.criticalIds.length - 1);
  const crit = new Set(r.criticalIds);
  const inc = new Map(), out = new Map();
  for (const e of r.criticalEdges) {
    assert.ok(crit.has(e.from) && crit.has(e.to));
    inc.set(e.to, (inc.get(e.to) || 0) + 1);
    out.set(e.from, (out.get(e.from) || 0) + 1);
  }
  const first = r.criticalIds.filter((id) => !inc.has(id));
  const end = r.criticalIds.filter((id) => !out.has(id));
  assert.equal(first.length, 1);
  assert.deepEqual(end, [lastId]);
  assert.ok([...inc.values()].every((n) => n === 1) && [...out.values()].every((n) => n === 1));
  // everything non-critical has positive float
  for (const t of p.tasks) {
    const i = r.info[t.id];
    if (!i.critical) assert.ok(i.totalFloat > 0, t.name);
  }
  // critical path passes through the mission dry runs and the integration steps
  const critNames = r.criticalIds.map((id) => byId.get(id).name).join('|');
  assert.match(critNames, /Science mission dry run/);
  assert.match(critNames, /Autonomous Navigation mission dry run/);
  assert.match(critNames, /Full-system test campaign/);
});

// ---------------------------------------------------------------- store: JSON / CSV / storage / history

test('store: JSON round trip and errors', () => {
  const p = M.sampleProject();
  const text = S.toJSON(p);
  assert.match(text, /\n  "tasks"/); // pretty printed
  assert.deepEqual(S.fromJSON(text), p);
  assert.throws(() => S.fromJSON('{not json'), /not valid JSON/);
  assert.throws(() => S.fromJSON('[1,2]'), /not a schedule/);
  assert.throws(() => S.fromJSON('{"title":"x"}'), /tasks/);
  assert.deepEqual(S.fromJSON('{"tasks":[]}').tasks, []);
});

test('store: load/save tolerate localStorage being unavailable', () => {
  assert.equal(typeof globalThis.localStorage, 'undefined');
  assert.equal(S.load(), null);
  assert.equal(S.save(M.newProject()), false);
  assert.equal(S.KEY, 'tf-gantt-v1');
});

test('store: load/save with a working and a broken localStorage', () => {
  const data = new Map();
  const fake = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
  try {
    assert.equal(S.load(), null);
    const p = M.sampleProject();
    assert.equal(S.save(p), true);
    assert.deepEqual(S.load(), p);
    data.set(S.KEY, '{corrupt');
    assert.equal(S.load(), null);
    data.set(S.KEY, '{"nope":1}');
    assert.equal(S.load(), null);
    fake.setItem = () => { throw new Error('quota'); };
    assert.equal(S.save(p), false);
    fake.getItem = () => { throw new Error('denied'); };
    assert.equal(S.load(), null);
  } finally {
    delete globalThis.localStorage;
  }
  assert.equal(typeof globalThis.localStorage, 'undefined');
});

function strip(project) {
  // comparable view of tasks: deps rendered as wbs text so ids may differ
  const rs = M.rows(project);
  return rs.map((r) => ({
    wbs: r.wbs, name: r.task.name, level: r.task.level, owner: r.task.owner, start: r.start, end: r.end,
    progress: r.progress, milestone: r.task.milestone, urc: r.task.urc, notes: r.task.notes,
    deps: r.isSummary ? '' : M.formatDeps(r.task, project),
  }));
}

test('store: CSV header and shape', () => {
  const csv = S.toCSV(M.sampleProject());
  const first = csv.split('\r\n')[0];
  assert.equal(first, 'WBS,Name,Level,Owner,Start,End,Percent Complete,Milestone,URC,Predecessors,Notes');
  assert.equal(S.toCSV(M.newProject()), first + '\r\n');
});

test('store: CSV round trip of the sample project', () => {
  const p = M.sampleProject();
  const q = S.fromCSV(S.toCSV(p));
  assert.equal(q.tasks.length, p.tasks.length);
  assert.deepEqual(strip(q), strip(p).map((r) => r)); // includes deps by wbs, rollups, flags
  assert.deepEqual(C.compute(q).criticalIds.length, C.compute(p).criticalIds.length);
});

test('store: CSV round trip with quoted commas, quotes and newlines', () => {
  let p = mk([
    ['A', 0, '2026-09-01', '2026-09-30', [], { name: 'Parent, "quoted" task', owner: 'Mech, Elec' }],
    ['B', 1, '2026-09-01', '2026-09-10', [], { name: 'Line one\nLine two', notes: 'He said "go",\r\nthen left,', progress: 40, urc: true }],
    ['C', 1, '2026-09-11', '2026-09-20', [{ id: 'B', lag: 2 }], { name: 'Inner  space', notes: '' }],
    ['D', 0, '2026-09-25', '2026-09-25', [{ id: 'C', lag: -1 }, 'B'], { name: ',', milestone: true }],
  ]);
  const csv = S.toCSV(p);
  assert.ok(csv.includes('"Parent, ""quoted"" task"'));
  const q = S.fromCSV(csv);
  assert.deepEqual(strip(q), strip(p));
  assert.equal(q.tasks[1].name, 'Line one\nLine two');
  assert.equal(q.tasks[1].notes, 'He said "go",\r\nthen left,');
  assert.equal(S.fromCSV(csv.replace(/\r\n(?=\d)/g, '\n')).tasks.length, 4, 'LF line endings also parse');
});

test('store: fromCSV flexible headers, derived levels, lag deps, BOM', () => {
  const csv = '﻿name,wbs,predecessors,START,end,% complete,owner,milestone\n' +
    'Top,1,,2026-09-01,2026-09-10,0,Leadership,no\n' +
    'Child A,1.1,,2026-09-01,2026-09-05,100,Mech,\n' +
    'Child B,1.2,"1.1+2",2026-09-08,2026-09-12,50%,Mech,\n' +
    'Done,2,"1.2, 1.1-3",2026-09-20,,0,,yes\n';
  const q = S.fromCSV(csv);
  assert.deepEqual(q.tasks.map((t) => t.level), [0, 1, 1, 0]);
  assert.deepEqual(q.tasks[2].deps.map((d) => d.lag), [2]);
  assert.deepEqual(q.tasks[3].deps.map((d) => d.lag), [0, -3]);
  assert.equal(q.tasks[2].deps[0].id, q.tasks[1].id);
  assert.equal(q.tasks[2].progress, 50);
  assert.equal(q.tasks[3].milestone, true);
  assert.equal(q.tasks[3].end, '2026-09-20');
  assert.equal(q.rangeStart, '2026-09-01');
  assert.equal(new Set(ids(q)).size, 4);
  // explicit Level column wins over WBS
  const q2 = S.fromCSV('Name,Level\nA,0\nB,1\nC,5\n');
  assert.deepEqual(levels(q2), [0, 1, 2]);
});

test('store: fromCSV error messages', () => {
  assert.throws(() => S.fromCSV(''), /empty/);
  assert.throws(() => S.fromCSV('Foo,Bar\n1,2\n'), /Name/);
  assert.throws(() => S.fromCSV('Name\n'), /no task rows/);
  assert.throws(() => S.fromCSV('Name,Start\nA,2026-02-30\n'), /Row 2.*start/);
  assert.throws(() => S.fromCSV('Name,Start\nA,"2026-01-01\n'), /unterminated/);
  assert.throws(() => S.fromCSV('Name,Percent Complete\nA,lots\n'), /Row 2.*percent/);
  assert.throws(() => S.fromCSV('Name,WBS,Predecessors\nA,1,\nB,2,9\n'), /Row 3.*does not match/);
  assert.throws(() => S.fromCSV('Name,WBS,Predecessors\nA,1,2\nB,2,1\n'), /Row 3.*circular/);
  assert.throws(() => S.fromCSV('Name,WBS,Predecessors\nA,1,1\n'), /Row 2.*itself/);
});

test('store: history undo/redo/limit', () => {
  const a = { n: 'a' }, b = { n: 'b' }, c = { n: 'c' };
  const h = S.createHistory(a, 3);
  assert.equal(h.current(), a);
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
  assert.equal(h.undo(), null);
  assert.equal(h.redo(), null);
  h.push(b); h.push(c);
  assert.equal(h.current(), c);
  assert.equal(h.canUndo(), true);
  assert.equal(h.undo(), b);
  assert.equal(h.current(), b);
  assert.equal(h.canRedo(), true);
  assert.equal(h.undo(), a);
  assert.equal(h.undo(), null);
  assert.equal(h.redo(), b);
  assert.equal(h.redo(), c);
  assert.equal(h.redo(), null);
  // push after undo clears redo
  h.undo();
  const d = { n: 'd' };
  h.push(d);
  assert.equal(h.canRedo(), false);
  assert.equal(h.current(), d);
  assert.equal(h.undo(), b);
  // pushing the identical object adds no step
  const h2 = S.createHistory(a);
  h2.push(a);
  assert.equal(h2.canUndo(), false);
  // limit: only the last 3 undo steps remain
  const h3 = S.createHistory(0, 3);
  for (let i = 1; i <= 10; i++) h3.push(i);
  const seen = [];
  let x;
  while ((x = h3.undo()) !== null) seen.push(x);
  assert.deepEqual(seen, [9, 8, 7]);
  // default limit is 100
  const h4 = S.createHistory(0);
  for (let i = 1; i <= 150; i++) h4.push(i);
  let steps = 0;
  while (h4.undo() !== null) steps++;
  assert.equal(steps, 100);
  // reset
  h4.reset('fresh');
  assert.equal(h4.current(), 'fresh');
  assert.equal(h4.canUndo(), false);
  assert.equal(h4.canRedo(), false);
});
