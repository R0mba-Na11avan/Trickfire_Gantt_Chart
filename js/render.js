/* TrickFire Gantt - SVG renderer.
 *
 * TF.render builds SVG DOM only (no state, no events):
 *   timeline(project, computed, opts) -> { header, body, geom }   interactive view
 *   page(project, computed, opts)     -> SVGSVGElement            print / export page
 *   pageFit(project, computed, opts)  -> { rowH, fontSize, legible }
 * `computed` = { rows: TF.model.rows(project), cpm: TF.cpm.compute(project) } supplied by the caller.
 */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  root.TF = root.TF || {};

  const NS = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';
  const ROW_H = 30;
  const HEADER_H = 48;

  const D = () => root.TF.dates;

  // ---------------------------------------------------------------- themes
  const THEMES = {
    light: {
      bg: '#ffffff', text: '#1b1b1b', muted: '#555555', border: '#222222',
      grid: '#e2e2e2', gridMonth: '#8f8f8f', stripe: '#f6f6f6', summaryRow: '#e9e9e9',
      outside: '#ebebeb', headBg: '#222222', headText: '#ffffff', headLine: '#6a6a6a',
      weekBg: '#f0f0f0', weekText: '#333333', rowLine: '#d6d6d6',
      green: '#00B400', greenEdge: '#006e00', remain: '#cfcfcf', remainEdge: '#7d7d7d',
      pink: '#E93CAC', pinkEdge: '#8a1366', pinkDeep: '#a31c78',
      summary: '#2b2b2b', milestone: '#2b2b2b', msEdge: '#000000',
      urc: '#000000', urcTagBg: '#222222', urcTagText: '#ffffff',
      status: '#111111', dep: '#6b6b6b', violated: '#d32f2f',
      selected: 'rgba(0,180,0,0.16)', halo: '#ffffff'
    },
    dark: {
      bg: '#222222', text: '#ffffff', muted: '#cccccc', border: '#ffffff',
      grid: '#343434', gridMonth: '#666666', stripe: '#292929', summaryRow: '#303030',
      outside: '#191919', headBg: '#000000', headText: '#ffffff', headLine: '#555555',
      weekBg: '#2d2d2d', weekText: '#cccccc', rowLine: '#383838',
      green: '#00FE00', greenEdge: '#00a800', remain: '#707070', remainEdge: '#a8a8a8',
      pink: '#E93CAC', pinkEdge: '#ffa6dd', pinkDeep: '#8a1d69',
      summary: '#e6e6e6', milestone: '#e6e6e6', msEdge: '#ffffff',
      urc: '#ffffff', urcTagBg: '#00FE00', urcTagText: '#000000',
      status: '#ffffff', dep: '#a0a0a0', violated: '#ff5252',
      selected: 'rgba(0,254,0,0.14)', halo: '#222222'
    }
  };

  const FONT_BODY = 'Roboto, Arial, Helvetica, sans-serif';
  const FONT_HEAD = "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif";
  const FONT_APP = "Overpass, 'Segoe UI', Arial, sans-serif";

  // ---------------------------------------------------------------- helpers
  const rnd = (v) => Math.round(v * 100) / 100;

  function el(name, attrs, parent, text) {
    const e = document.createElementNS(NS, name);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        e.setAttribute(k, typeof v === 'number' ? String(rnd(v)) : v);
      }
    }
    if (text !== undefined && text !== null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  // Text measuring: canvas when a DOM exists (measured with Arial, which is at least as wide as
  // Roboto / Overpass, so truncation is conservative), otherwise a per-character estimate.
  let ctx2d;
  function getCtx() {
    if (ctx2d === undefined) {
      ctx2d = null;
      try {
        if (typeof document !== 'undefined') ctx2d = document.createElement('canvas').getContext('2d') || null;
      } catch (e) { ctx2d = null; }
    }
    return ctx2d;
  }
  const mcache = new Map();
  function tw(str, fs, bold) {
    str = String(str);
    const key = (bold ? 'b' : 'n') + rnd(fs) + '|' + str;
    let w = mcache.get(key);
    if (w === undefined) {
      const c = getCtx();
      if (c) {
        c.font = (bold ? 'bold ' : '') + rnd(fs) + 'px Arial, Helvetica, sans-serif';
        w = c.measureText(str).width;
      } else {
        w = str.length * fs * (bold ? 0.6 : 0.55);
      }
      if (mcache.size > 5000) mcache.clear();
      mcache.set(key, w);
    }
    return w;
  }

  function fitText(str, maxW, fs, bold) {
    str = String(str == null ? '' : str);
    if (maxW <= 0) return '';
    if (tw(str, fs, bold) <= maxW) return str;
    const ell = '…';
    if (tw(ell, fs, bold) > maxW) return '';
    let lo = 0, hi = str.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tw(str.slice(0, mid).replace(/\s+$/, '') + ell, fs, bold) <= maxW) lo = mid; else hi = mid - 1;
    }
    return str.slice(0, lo).replace(/\s+$/, '') + ell;
  }

  function visibleRows(computed) {
    const rows = (computed && computed.rows) || [];
    return rows.filter((r) => r.visible === true);
  }

  function statusIso(project) {
    return project.statusDate || D().today();
  }

  // Day range of the drawn window: Monday on/before rangeStart .. Sunday on/after rangeEnd.
  function windowDays(project) {
    const d = D();
    const origin = d.toDay(d.weekStart(project.rangeStart));
    let end = d.toDay(d.weekStart(project.rangeEnd)) + 6;
    if (end < origin + 6) end = origin + 6;
    return { originDay: origin, endDay: end };
  }

  function slash(iso) {
    if (!iso) return '';
    const p = String(iso).split('-');
    return (+p[1]) + '/' + (+p[2]) + '/' + p[0].slice(2);
  }

  // ---------------------------------------------------------------- calendar header (shared)
  // c: { T, xOf, originDay, endDay, y, monthH, weekH, mfs, wfs, dw }
  function drawHeader(parent, c) {
    const d = D(), T = c.T;
    const xL = c.xOf(c.originDay), xR = c.xOf(c.endDay + 1);
    // month band
    el('rect', { x: xL, y: c.y, width: xR - xL, height: c.monthH, fill: T.headBg }, parent);
    let day = c.originDay;
    while (day <= c.endDay) {
      const iso = d.fromDay(day);
      const cellEnd = Math.min(d.toDay(d.monthEnd(iso)), c.endDay);
      const x0 = c.xOf(day), x1 = c.xOf(cellEnd + 1);
      const full = d.fmtMonth(iso);
      const cands = [full, full.split(' ')[0], full.charAt(0)];
      let label = '';
      for (const s of cands) { if (tw(s, c.mfs, true) + 6 <= x1 - x0) { label = s; break; } }
      if (label) {
        el('text', {
          x: (x0 + x1) / 2, y: c.y + c.monthH / 2 + c.mfs * 0.35, 'text-anchor': 'middle',
          'font-size': c.mfs, 'font-weight': 'bold', fill: T.headText
        }, parent, label);
      }
      el('line', { x1: x0, y1: c.y, x2: x0, y2: c.y + c.monthH, stroke: T.headLine, 'stroke-width': 1 }, parent);
      day = cellEnd + 1;
    }
    // week band: one cell per week, every gridline drawn, label only what fits
    const wy = c.y + c.monthH;
    el('rect', { x: xL, y: wy, width: xR - xL, height: c.weekH, fill: T.weekBg }, parent);
    const weekW = c.dw * 7;
    const useMD = tw('12/30', c.wfs, false) + 4 <= weekW;
    const step = useMD ? 1 : Math.max(1, Math.ceil((tw('30', c.wfs, false) + 3) / weekW));
    let i = 0;
    for (let wd = c.originDay; wd <= c.endDay; wd += 7, i++) {
      const x = c.xOf(wd);
      el('line', { x1: x, y1: wy, x2: x, y2: wy + c.weekH, stroke: T.gridMonth, 'stroke-width': 0.6 }, parent);
      if (i % step === 0) {
        const iso = d.fromDay(wd).split('-');
        const label = useMD ? (+iso[1]) + '/' + (+iso[2]) : String(+iso[2]);
        el('text', {
          x: x + weekW / 2 * (step === 1 ? 1 : 0) + (step === 1 ? 0 : 2), y: wy + c.weekH / 2 + c.wfs * 0.35,
          'text-anchor': step === 1 ? 'middle' : 'start', 'font-size': c.wfs, fill: T.weekText
        }, parent, label);
      }
    }
    el('line', { x1: xL, y1: wy, x2: xR, y2: wy, stroke: T.gridMonth, 'stroke-width': 0.6 }, parent);
    el('line', { x1: xL, y1: wy + c.weekH, x2: xR, y2: wy + c.weekH, stroke: T.border, 'stroke-width': 0.8 }, parent);
  }

  // Weekly + monthly vertical gridlines and out-of-range shading. c: { T, xOf, originDay, endDay, y0, y1, project }
  function drawGrid(parent, c) {
    const d = D(), T = c.T;
    const g = el('g', { class: 'tf-grid', 'shape-rendering': 'crispEdges' }, parent);
    const rs = d.toDay(c.project.rangeStart), re = d.toDay(c.project.rangeEnd);
    const xA = c.xOf(c.originDay), xB = c.xOf(c.endDay + 1);
    if (rs > c.originDay) {
      el('rect', { class: 'tf-outside', x: xA, y: c.y0, width: c.xOf(rs) - xA, height: c.y1 - c.y0, fill: T.outside }, g);
    }
    if (re < c.endDay) {
      el('rect', { class: 'tf-outside', x: c.xOf(re + 1), y: c.y0, width: xB - c.xOf(re + 1), height: c.y1 - c.y0, fill: T.outside }, g);
    }
    for (let wd = c.originDay; wd <= c.endDay; wd += 7) {
      const x = c.xOf(wd);
      el('line', { x1: x, y1: c.y0, x2: x, y2: c.y1, stroke: T.grid, 'stroke-width': 1 }, g);
    }
    for (let day = c.originDay; day <= c.endDay; day++) {
      if (d.fromDay(day).slice(8) === '01') {
        const x = c.xOf(day);
        el('line', { class: 'tf-month-line', x1: x, y1: c.y0, x2: x, y2: c.y1, stroke: T.gridMonth, 'stroke-width': 1 }, g);
      }
    }
  }

  // ---------------------------------------------------------------- bars + dependency links (shared)
  /* c: { T, rows (visible), cpm, project, showDeps, showCritical, selectedId, xOf, dw, left, right,
   *      y0, rowH, barH, fs, stub, labels, interactive, critFill, sw, linkW, linkCritW, uid } */
  function drawScene(parent, c) {
    const d = D(), T = c.T, rows = c.rows;
    const info = (c.cpm && c.cpm.info) || {};
    const critEdges = new Set(((c.cpm && c.cpm.criticalEdges) || []).map((e) => e.from + '>' + e.to));
    const gLinks = el('g', { class: 'tf-deps', 'pointer-events': 'none' }, parent);
    const gBars = el('g', { class: 'tf-bars' }, parent);
    const gCrit = el('g', { class: 'tf-deps-critical', 'pointer-events': 'none' }, parent);

    // dependency links between visible non-summary rows
    const idx = new Map(rows.map((r, i) => [r.task.id, i]));
    const links = [];
    if (c.showDeps) {
      rows.forEach((r) => {
        if (r.isSummary) return;
        (r.task.deps || []).forEach((dep) => {
          const j = idx.get(dep.id);
          if (j === undefined || rows[j].isSummary) return;
          const inf = info[r.task.id];
          const viol = !!(inf && (inf.violations || []).some((v) => v.predId === dep.id));
          const crit = c.showCritical && critEdges.has(dep.id + '>' + r.task.id);
          links.push({ from: dep.id, to: r.task.id, crit, viol });
        });
      });
    }
    const hasOut = new Set(links.map((l) => l.from));

    // per-row geometry
    const geoms = new Map();
    rows.forEach((r, i) => {
      const kind = r.isSummary ? 'summary' : (r.task.milestone ? 'milestone' : 'task');
      const yc = c.y0 + i * c.rowH + c.rowH / 2;
      const s = d.toDay(r.start), e = d.toDay(r.end);
      let x0 = c.xOf(s), x1 = c.xOf(e + 1);
      if (kind === 'milestone') {
        const h = Math.max(2, c.barH * 0.62);
        const xc = c.xOf(s) + c.dw / 2;
        if (xc < c.left || xc > c.right) return;
        geoms.set(r.task.id, { kind, yc, l: xc - h, r: xc + h, xc, h, row: r, i });
        return;
      }
      if (x1 < x0 + 1.5) x1 = x0 + 1.5;
      const cl0 = Math.max(x0, c.left), cl1 = Math.min(x1, c.right);
      if (cl1 <= cl0) return;
      geoms.set(r.task.id, { kind, yc, l: cl0, r: cl1, x0, x1, clipL: x0 < c.left, clipR: x1 > c.right, row: r, i });
    });

    // bars
    rows.forEach((r) => {
      const gm = geoms.get(r.task.id);
      if (!gm) return;
      const t = r.task, id = t.id, p = Math.max(0, Math.min(100, r.progress || 0));
      const inf = info[id];
      const crit = !!(c.showCritical && inf && inf.critical) && gm.kind !== 'summary';
      const complete = p >= 100;
      const cls = 'tf-bar' + (crit ? ' tf-critical' : '') + (t.urc ? ' tf-urc' : '') + (complete ? ' tf-complete' : '');
      const g = el('g', { class: cls, 'data-id': id, 'data-kind': gm.kind }, gBars);
      const yc = gm.yc, bh = c.barH;
      let xr, xl;   // outer right / left edge of the shape (for labels)

      if (gm.kind === 'task') {
        const by = yc - bh / 2;
        const w = gm.r - gm.l;
        const pEnd = Math.min(gm.r, gm.x0 + (gm.x1 - gm.x0) * p / 100);
        const bodyFill = complete ? T.green : (crit ? c.critFill : T.remain);
        const edge = complete ? T.greenEdge : (crit ? T.pinkEdge : T.remainEdge);
        el('rect', { class: 'tf-bar-body', x: gm.l, y: by, width: w, height: bh, fill: bodyFill }, g);
        el('rect', { class: 'tf-bar-progress', x: gm.l, y: by, width: Math.max(0, pEnd - gm.l), height: bh, fill: T.green }, g);
        el('rect', { class: 'tf-bar-outline', x: gm.l, y: by, width: w, height: bh, fill: 'none', stroke: edge, 'stroke-width': crit ? c.sw * 1.5 : c.sw, 'pointer-events': 'none' }, g);
        if (t.urc) {
          el('rect', { class: 'tf-urc-ring', x: gm.l - c.sw * 1.6, y: by - c.sw * 1.6, width: w + c.sw * 3.2, height: bh + c.sw * 3.2, fill: 'none', stroke: T.urc, 'stroke-width': c.sw * 1.4, 'pointer-events': 'none' }, g);
        }
        if (c.interactive) {
          const hw = Math.min(6, Math.max(2, w / 3));
          if (!gm.clipL) el('rect', { class: 'tf-handle', 'data-handle': 'start', x: gm.l, y: by, width: hw, height: bh, fill: '#000', 'fill-opacity': 0, 'pointer-events': 'all', cursor: 'ew-resize' }, g);
          if (!gm.clipR) el('rect', { class: 'tf-handle', 'data-handle': 'end', x: gm.r - hw, y: by, width: hw, height: bh, fill: '#000', 'fill-opacity': 0, 'pointer-events': 'all', cursor: 'ew-resize' }, g);
        }
        xl = gm.l; xr = gm.r;
      } else if (gm.kind === 'summary') {
        const th = Math.max(1.5, bh * 0.36);
        const top = yc - bh * 0.4;
        const cap = Math.max(2, bh * 0.42);
        const pEnd = Math.min(gm.r, gm.x0 + (gm.x1 - gm.x0) * p / 100);
        el('rect', { class: 'tf-bar-body', x: gm.l, y: top, width: gm.r - gm.l, height: th, fill: T.summary }, g);
        if (!gm.clipL) el('path', { class: 'tf-summary-cap', d: `M${rnd(gm.l)},${rnd(top)}h${rnd(cap)}l${rnd(-cap)},${rnd(th + cap)}z`, fill: T.summary }, g);
        if (!gm.clipR) el('path', { class: 'tf-summary-cap', d: `M${rnd(gm.r)},${rnd(top)}h${rnd(-cap)}l${rnd(cap)},${rnd(th + cap)}z`, fill: T.summary }, g);
        if (pEnd > gm.l) {
          const inset = th > 3 ? th * 0.22 : 0;
          el('rect', { class: 'tf-bar-progress', x: gm.l, y: top + inset, width: pEnd - gm.l, height: th - inset * 2, fill: T.green }, g);
        }
        if (t.urc) {
          el('rect', { class: 'tf-urc-ring', x: gm.l - c.sw, y: top - c.sw, width: gm.r - gm.l + c.sw * 2, height: th + c.sw * 2, fill: 'none', stroke: T.urc, 'stroke-width': c.sw * 1.2, 'pointer-events': 'none' }, g);
        }
        xl = gm.l; xr = gm.r;
      } else {
        const h = gm.h, xc = gm.xc;
        const fill = complete ? T.green : (crit ? T.pink : T.milestone);
        const edge = crit ? T.pinkEdge : (complete ? T.greenEdge : T.msEdge);
        if (t.urc) {
          const q = h + c.sw * 1.8;
          el('path', { class: 'tf-urc-ring', d: `M${rnd(xc - q)},${rnd(yc)}L${rnd(xc)},${rnd(yc - q)}L${rnd(xc + q)},${rnd(yc)}L${rnd(xc)},${rnd(yc + q)}Z`, fill: 'none', stroke: T.urc, 'stroke-width': c.sw * 1.4, 'pointer-events': 'none' }, g);
        }
        el('path', { class: 'tf-milestone', d: `M${rnd(xc - h)},${rnd(yc)}L${rnd(xc)},${rnd(yc - h)}L${rnd(xc + h)},${rnd(yc)}L${rnd(xc)},${rnd(yc + h)}Z`, fill, stroke: edge, 'stroke-width': crit ? c.sw * 1.5 : c.sw }, g);
        xl = xc - h; xr = xc + h;
      }

      if (c.labels) drawLabel(g, c, gm, t, p, xl, xr, hasOut.has(id));
    });

    // links: normal first, violated next (inside gLinks), critical in the layer above the bars
    links.sort((a, b) => (a.viol ? 1 : 0) - (b.viol ? 1 : 0));
    links.forEach((lk) => {
      const a = geoms.get(lk.from), b = geoms.get(lk.to);
      if (!a || !b) return;
      const x0 = a.r, y0 = a.yc, x1 = b.l, y1 = b.yc;
      const stub = c.stub;
      let dpath;
      if (x1 - x0 >= stub * 2) {
        dpath = `M${rnd(x0)},${rnd(y0)}H${rnd(x0 + stub)}V${rnd(y1)}H${rnd(x1)}`;
      } else {
        const ym = y1 > y0 ? y0 + c.rowH / 2 : y0 - c.rowH / 2;
        dpath = `M${rnd(x0)},${rnd(y0)}H${rnd(x0 + stub)}V${rnd(ym)}H${rnd(x1 - stub)}V${rnd(y1)}H${rnd(x1)}`;
      }
      const color = lk.viol ? T.violated : (lk.crit ? T.pink : T.dep);
      const w = lk.crit ? c.linkCritW : c.linkW;
      const hs = Math.max(2, Math.min(5, stub * 0.75)) * (lk.crit ? 1.15 : 1);
      const par = lk.crit ? gCrit : gLinks;
      const cls = 'tf-dep' + (lk.crit ? ' tf-dep-critical' : '') + (lk.viol ? ' tf-dep-violated' : '');
      el('path', { class: cls, 'data-from': lk.from, 'data-to': lk.to, d: dpath, fill: 'none', stroke: color, 'stroke-width': w, 'stroke-dasharray': lk.viol ? '4 3' : null, 'stroke-linejoin': 'round' }, par);
      el('path', { class: 'tf-dep-head', d: `M${rnd(x1)},${rnd(y1)}l${rnd(-hs)},${rnd(-hs * 0.62)}v${rnd(hs * 1.24)}z`, fill: color }, par);
    });
  }

  // "40% - Owner" label (and URC tag) beside a bar; flips to the left side when no room on the right.
  function drawLabel(g, c, gm, t, p, xl, xr, hasOut) {
    const T = c.T, fs = c.fs;
    const owner = t.owner ? ' · ' + t.owner : '';
    let text = c.labels === 'tag' ? '' : Math.round(p) + '%' + owner;
    const tagW = t.urc ? tw('URC', fs * 0.78, true) + 6 : 0;
    const tagGap = t.urc ? 4 : 0;
    const gap = hasOut ? c.stub + 4 : 5;
    let avail = c.right - (xr + gap) - 2;
    let fromLeft = false;
    const need = tagW + tagGap + tw(text, fs, false);
    if (need > avail) {
      const availL = (xl - gap) - c.left - 2;
      if (availL > avail) { avail = availL; fromLeft = true; }
    }
    let textMax = avail - tagW - tagGap;
    if (!text || textMax < tw('00%', fs, false)) { text = ''; textMax = 0; }
    else text = fitText(text, textMax, fs, false);
    const total = tagW + tagGap + (text ? tw(text, fs, false) : 0);
    if (!text && !t.urc) return;
    if (total > avail && !text) return;
    let x = fromLeft ? xl - gap - total : xr + gap;
    const yc = gm.yc;
    if (t.urc) {
      const th = fs * 1.15;
      el('rect', { class: 'tf-urc-tag', x, y: yc - th / 2, width: tagW, height: th, fill: T.urcTagBg }, g);
      el('text', { x: x + tagW / 2, y: yc + fs * 0.78 * 0.35, 'text-anchor': 'middle', 'font-size': fs * 0.78, 'font-weight': 'bold', fill: T.urcTagText, 'pointer-events': 'none' }, g, 'URC');
      x += tagW + tagGap;
    }
    if (text) {
      el('text', {
        class: 'tf-bar-label', x, y: yc + fs * 0.35, 'font-size': fs, fill: T.text,
        stroke: T.halo, 'stroke-width': 3, 'stroke-linejoin': 'round', 'paint-order': 'stroke', 'pointer-events': 'none'
      }, g, text);
    }
  }

  function statusLine(parent, c, y0, y1, chip) {
    const d = D(), T = c.T;
    const iso = c.statusIso;
    const day = d.toDay(iso);
    if (day < c.originDay || day > c.endDay) return;
    const x = c.xOf(day) + c.dw / 2;
    const g = el('g', { class: 'tf-status', 'pointer-events': 'none' }, parent);
    el('line', { class: 'tf-status-line', x1: x, y1: y0, x2: x, y2: y1, stroke: T.status, 'stroke-width': c.statusW, 'stroke-dasharray': c.statusDash }, g);
    if (chip) {
      const label = 'STATUS ' + d.fmtShort(iso).toUpperCase();
      const w = tw(label, chip.fs, true) + 8;
      let cx = x - w / 2;
      cx = Math.max(c.left, Math.min(c.right - w, cx));
      el('rect', { x: cx, y: chip.y, width: w, height: chip.h, fill: T.status }, g);
      el('text', { x: cx + w / 2, y: chip.y + chip.h / 2 + chip.fs * 0.35, 'text-anchor': 'middle', 'font-size': chip.fs, 'font-weight': 'bold', fill: T.bg }, g, label);
    }
  }

  // ---------------------------------------------------------------- interactive timeline
  function timeline(project, computed, opts) {
    const d = D();
    const o = Object.assign({ dayWidth: 6, showDeps: true, showCritical: true, selectedId: null, theme: 'dark' }, opts || {});
    const dw = o.dayWidth > 0 ? o.dayWidth : 6;
    const T = THEMES[o.theme] || THEMES.dark;
    const rows = visibleRows(computed);
    const win = windowDays(project);
    const originDay = win.originDay, endDay = win.endDay;
    const width = (endDay - originDay + 1) * dw;
    const height = Math.max(rows.length, 1) * ROW_H;
    const xOf = (day) => (day - originDay) * dw;

    // header
    const header = el('svg', { xmlns: NS, width, height: HEADER_H, viewBox: `0 0 ${rnd(width)} ${HEADER_H}`, class: 'tf-timeline-header', 'font-family': FONT_APP, style: 'display:block' });
    el('rect', { x: 0, y: 0, width, height: HEADER_H, fill: T.bg }, header);
    drawHeader(header, { T, xOf, originDay, endDay, y: 0, monthH: 24, weekH: HEADER_H - 24, mfs: 12, wfs: 10, dw });

    // body
    const body = el('svg', { xmlns: NS, width, height, viewBox: `0 0 ${rnd(width)} ${rnd(height)}`, class: 'tf-timeline-body', 'font-family': FONT_APP, style: 'display:block' });
    el('rect', { x: 0, y: 0, width, height, fill: T.bg }, body);
    rows.forEach((r, i) => {
      if (i % 2 === 1) el('rect', { class: 'tf-row-stripe', x: 0, y: i * ROW_H, width, height: ROW_H, fill: T.stripe }, body);
      if (o.selectedId && r.task.id === o.selectedId) {
        el('rect', { class: 'tf-row-selected', x: 0, y: i * ROW_H, width, height: ROW_H, fill: T.selected }, body);
      }
    });
    drawGrid(body, { T, xOf, originDay, endDay, y0: 0, y1: height, project });
    const sc = {
      T, rows, cpm: computed && computed.cpm, project, showDeps: o.showDeps !== false, showCritical: o.showCritical !== false,
      selectedId: o.selectedId, xOf, dw, left: 0, right: width, y0: 0, rowH: ROW_H, barH: 16, fs: 11, stub: 8,
      labels: true, interactive: true, critFill: T.pink, sw: 1, linkW: 1.2, linkCritW: 2.4,
      statusIso: statusIso(project), originDay, endDay, statusW: 1.5, statusDash: '5 3'
    };
    // row separators
    const sep = el('g', { 'shape-rendering': 'crispEdges' }, body);
    rows.forEach((r, i) => el('line', { x1: 0, y1: (i + 1) * ROW_H, x2: width, y2: (i + 1) * ROW_H, stroke: T.rowLine, 'stroke-width': 1 }, sep));
    statusLine(body, sc, 0, height, { y: 0, h: 14, fs: 9 });
    drawScene(body, sc);

    const geom = {
      dayWidth: dw, rowH: ROW_H, originDay, endDay, width, height,
      xOfDay: xOf,
      dayAtX: (px) => Math.floor(px / dw) + originDay,
      rowAtY: (py) => { const i = Math.floor(py / ROW_H); return (i >= 0 && i < rows.length) ? i : -1; },
      visibleRows: rows
    };
    return { header, body, geom };
  }

  // ---------------------------------------------------------------- page layout
  function normPage(opts) {
    const o = Object.assign({ width: 1056, height: 816, theme: 'light', showDeps: true, showLegend: true, margin: 36 }, opts || {});
    o.width = +o.width || 1056; o.height = +o.height || 816;
    o.margin = o.margin >= 0 ? +o.margin : 36;
    return o;
  }

  // Vertical layout shared by page() and pageFit(): everything that determines rowH / fontSize.
  function layoutV(computed, o) {
    const n = visibleRows(computed).length;
    const m = o.margin;
    const titleH = 50;
    const chipH = 11;
    const legendH = o.showLegend ? 24 : 0;
    const hdrTop = m + titleH + chipH + 3;
    const monthH = 15, weekH = 13, hdrH = monthH + weekH;
    const bodyTop = hdrTop + hdrH;
    const bottom = o.height - m - (o.showLegend ? legendH + 8 : 0);
    const avail = Math.max(1, bottom - bodyTop - 1);
    const rowH = Math.min(21, avail / Math.max(n, 1));
    const fontSize = Math.min(11, rowH * 0.62);
    return { n, m, titleH, chipH, legendH, hdrTop, monthH, weekH, hdrH, bodyTop, bottom, rowH, fontSize, legible: fontSize >= 5.5 };
  }

  function pageFit(project, computed, opts) {
    const L = layoutV(computed, normPage(opts));
    return { rowH: rnd(L.rowH), fontSize: rnd(L.fontSize), legible: L.legible };
  }

  let uidCounter = 0;

  function page(project, computed, opts) {
    const d = D();
    const o = normPage(opts);
    const T = THEMES[o.theme] || THEMES.light;
    const V = layoutV(computed, o);
    const rows = visibleRows(computed);
    const W = o.width, H = o.height, m = o.margin;
    const contentW = W - 2 * m;
    const fs = V.fontSize, rowH = V.rowH;
    const uid = 'tf' + (++uidCounter);

    const svg = el('svg', {
      xmlns: NS, width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'tf-page', 'font-family': FONT_BODY,
      preserveAspectRatio: 'xMidYMid meet'
    });
    svg.setAttribute('xmlns:xlink', XLINK);
    el('rect', { class: 'tf-page-bg', x: 0, y: 0, width: W, height: H, fill: T.bg }, svg);

    // defs: accent gradient + critical hatch (so critical differs by pattern, not hue alone)
    const defs = el('defs', null, svg);
    const grad = el('linearGradient', { id: uid + '-grad', x1: 0, y1: 0, x2: 1, y2: 0 }, defs);
    el('stop', { offset: 0, 'stop-color': '#00FE00' }, grad);
    el('stop', { offset: 1, 'stop-color': '#E93CAC' }, grad);
    const pat = el('pattern', { id: uid + '-hatch', width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    el('rect', { x: 0, y: 0, width: 4, height: 4, fill: T.pink }, pat);
    el('line', { x1: 0, y1: 0, x2: 0, y2: 4, stroke: T.pinkDeep, 'stroke-width': 1.5 }, pat);
    const critFill = `url(#${uid}-hatch)`;

    // ---- title block
    const logo = project.logo && /^data:image\//i.test(project.logo) ? project.logo : null;
    const logoBox = { w: 120, h: 40 };
    const titleMax = contentW - (logo ? logoBox.w + 12 : 0);
    const title = String(project.title || 'Untitled schedule').toUpperCase();
    let tfs = 26;
    while (tfs > 14 && tw(title, tfs * 0.85, true) > titleMax) tfs -= 1;
    el('text', {
      class: 'tf-title', x: m, y: m + 21, 'font-size': tfs, 'font-weight': 600, 'font-family': FONT_HEAD,
      fill: T.text, 'letter-spacing': 0.5
    }, svg, fitText(title, titleMax / 0.85, tfs * 0.85, true));
    const sub = [project.team || 'TrickFire Robotics', 'Status as of ' + d.fmtLong(statusIso(project)),
      d.fmtShort(project.rangeStart) + ' – ' + d.fmtLong(project.rangeEnd)].join('   |   ');
    el('text', { class: 'tf-subtitle', x: m, y: m + 36, 'font-size': 10.5, fill: T.muted }, svg, fitText(sub, titleMax, 10.5, false));
    el('rect', { class: 'tf-accent', x: m, y: m + 42, width: contentW, height: 3, fill: `url(#${uid}-grad)` }, svg);
    if (logo) {
      const im = el('image', { class: 'tf-logo', x: W - m - logoBox.w, y: m, width: logoBox.w, height: logoBox.h, preserveAspectRatio: 'xMaxYMid meet', href: logo }, svg);
      im.setAttributeNS(XLINK, 'xlink:href', logo);
    }

    // ---- columns
    const wbsW = Math.max(tw('WBS', 7.5, true), ...rows.map((r) => tw(r.wbs || '', fs, r.isSummary))) + 7;
    const dateW = Math.max(tw('88/88/88', fs, false), tw('START', 7.5, true)) + 8;
    const pctW = Math.max(tw('100%', fs, false), tw('%', 7.5, true)) + 7;
    const ownerCap = contentW * 0.14;
    let ownerW = Math.max(tw('OWNER', 7.5, true), ...rows.map((r) => tw(r.task.owner || '', fs, false))) + 7;
    ownerW = Math.min(ownerW, ownerCap);
    const indent = fs * 1.15;
    const nameNeed = Math.max(60, ...rows.map((r) => tw(r.task.name || '', fs, r.isSummary) + r.level * indent)) + 9;
    const tableMax = contentW * 0.56;
    const fixed = wbsW + ownerW + dateW * 2 + pctW;
    const nameW = Math.max(60, Math.min(nameNeed, tableMax - fixed));
    const tableW = fixed + nameW;
    const colX = [m, m + wbsW, m + wbsW + nameW, m + wbsW + nameW + ownerW, m + wbsW + nameW + ownerW + dateW, m + wbsW + nameW + ownerW + dateW * 2];
    const tableR = m + tableW;
    const tlX = tableR, tlW = contentW - tableW;

    const win = windowDays(project);
    const originDay = win.originDay, endDay = win.endDay;
    const dw = tlW / (endDay - originDay + 1);
    const xOf = (day) => tlX + (day - originDay) * dw;

    const top = V.bodyTop, bodyH = rows.length ? rows.length * rowH : 40;

    // ---- table header + timeline header
    el('rect', { class: 'tf-table-head', x: m, y: V.hdrTop, width: tableW, height: V.hdrH, fill: T.headBg }, svg);
    const heads = [['WBS', 'start', colX[0] + 3], ['TASK', 'start', colX[1] + 3], ['OWNER', 'start', colX[2] + 3],
      ['START', 'middle', colX[3] + dateW / 2], ['END', 'middle', colX[4] + dateW / 2], ['%', 'end', colX[5] + pctW - 3]];
    heads.forEach((h) => el('text', { x: h[2], y: V.hdrTop + V.hdrH / 2 + 7.5 * 0.35, 'text-anchor': h[1], 'font-size': 7.5, 'font-weight': 'bold', fill: T.headText }, svg, h[0]));
    drawHeader(svg, { T, xOf, originDay, endDay, y: V.hdrTop, monthH: V.monthH, weekH: V.weekH, mfs: 7.5, wfs: 6.5, dw });

    // ---- row backgrounds
    const gRows = el('g', { class: 'tf-rows' }, svg);
    rows.forEach((r, i) => {
      const y = top + i * rowH;
      if (r.isSummary) el('rect', { x: m, y, width: contentW, height: rowH, fill: T.summaryRow }, gRows);
      else if (i % 2 === 1) el('rect', { x: m, y, width: contentW, height: rowH, fill: T.stripe }, gRows);
    });
    const gLines = el('g', { 'shape-rendering': 'crispEdges' }, svg);
    if (rowH >= 6) {
      rows.forEach((r, i) => el('line', { x1: m, y1: top + (i + 1) * rowH, x2: m + contentW, y2: top + (i + 1) * rowH, stroke: T.rowLine, 'stroke-width': 0.5 }, gLines));
    }

    // ---- timeline grid
    drawGrid(svg, { T, xOf, originDay, endDay, y0: top, y1: top + bodyH, project });

    // ---- table text
    const gText = el('g', { class: 'tf-table' }, svg);
    const ty = (i) => top + i * rowH + rowH / 2 + fs * 0.35;
    rows.forEach((r, i) => {
      const t = r.task, y = ty(i), bold = r.isSummary || !!t.urc;
      const col = T.text;
      if (t.urc) {
        el('rect', { class: 'tf-urc-mark', x: m, y: top + i * rowH, width: Math.max(1.5, fs * 0.28), height: rowH, fill: T.urc }, gText);
      }
      el('text', { x: colX[0] + 3, y, 'font-size': fs, fill: T.muted, 'font-weight': r.isSummary ? 'bold' : null }, gText, r.wbs || '');
      const nx = colX[1] + 3 + r.level * indent;
      el('text', { x: nx, y, 'font-size': fs, 'font-weight': bold ? 'bold' : null, fill: col }, gText, fitText(t.name || '', colX[2] - 3 - nx, fs, bold));
      el('text', { x: colX[2] + 3, y, 'font-size': fs, fill: col }, gText, fitText(t.owner || '', ownerW - 5, fs, false));
      el('text', { x: colX[3] + dateW / 2, y, 'text-anchor': 'middle', 'font-size': fs, fill: col }, gText, slash(r.start));
      el('text', { x: colX[4] + dateW / 2, y, 'text-anchor': 'middle', 'font-size': fs, fill: col }, gText, slash(r.end));
      el('text', { x: colX[5] + pctW - 3, y, 'text-anchor': 'end', 'font-size': fs, fill: col }, gText, Math.round(r.progress || 0) + '%');
    });
    if (!rows.length) {
      el('text', { x: m + contentW / 2, y: top + 24, 'text-anchor': 'middle', 'font-size': 11, 'font-style': 'italic', fill: T.muted }, svg, 'No tasks to display');
    }

    // column separators + frame
    const gSep = el('g', { 'shape-rendering': 'crispEdges' }, svg);
    for (let k = 1; k < colX.length; k++) {
      el('line', { x1: colX[k], y1: top, x2: colX[k], y2: top + bodyH, stroke: T.rowLine, 'stroke-width': 0.6 }, gSep);
    }

    // ---- bars + links + status line
    const barH = Math.max(1.6, Math.min(11, rowH * 0.5));
    const sc = {
      T, rows, cpm: computed && computed.cpm, project, showDeps: o.showDeps !== false, showCritical: true,
      xOf, dw, left: tlX, right: tlX + tlW, y0: top, rowH, barH, fs: Math.max(2, Math.min(fs, 9)),
      stub: Math.max(2.5, Math.min(7, rowH * 0.32)), labels: rowH >= 8 ? 'tag' : false, interactive: false, critFill,
      sw: Math.max(0.5, Math.min(1, rowH * 0.06)), linkW: Math.max(0.5, Math.min(1, rowH * 0.06)), linkCritW: Math.max(1.1, Math.min(2.2, rowH * 0.13)),
      statusIso: statusIso(project), originDay, endDay, statusW: 1, statusDash: '4 2'
    };
    // start below the header bands so the dashed line never strikes through a week label
    statusLine(svg, sc, top, top + bodyH, { y: V.hdrTop - V.chipH - 1, h: V.chipH, fs: 6.5 });
    drawScene(svg, sc);

    // frame around table + timeline
    el('rect', { class: 'tf-frame', x: m, y: V.hdrTop, width: contentW, height: V.hdrH + bodyH, fill: 'none', stroke: T.border, 'stroke-width': 0.9 }, svg);
    el('line', { x1: tableR, y1: V.hdrTop, x2: tableR, y2: top + bodyH, stroke: T.border, 'stroke-width': 0.9 }, svg);

    if (o.showLegend) drawLegend(svg, T, m, V.bottom + 8, contentW, V.legendH, critFill);
    return svg;
  }

  function drawLegend(svg, T, x, y, w, h, critFill) {
    const fs = 8.5, sw = 20, sh = 8, pad = 5;
    const items = [
      ['Complete', 'complete'], ['Remaining', 'remain'], ['Critical path', 'crit'], ['Summary', 'summary'],
      ['Milestone', 'milestone'], ['URC2027-specific', 'urc'], ['Status date', 'status']
    ];
    const gap0 = 14;
    const base = items.reduce((s, it) => s + sw + pad + tw(it[0], fs, false), 0);
    const gap = Math.max(6, Math.min(gap0 * 1.6, (w - 60 - base) / (items.length - 1)));
    const g = el('g', { class: 'tf-legend' }, svg);
    el('line', { x1: x, y1: y, x2: x + w, y2: y, stroke: T.rowLine, 'stroke-width': 0.8 }, g);
    let cx = x;
    const cy = y + h / 2 + 2;
    items.forEach((it) => {
      const sx = cx, sy = cy - sh / 2;
      if (it[1] === 'complete') {
        el('rect', { x: sx, y: sy, width: sw, height: sh, fill: T.green, stroke: T.greenEdge, 'stroke-width': 0.8 }, g);
      } else if (it[1] === 'remain') {
        el('rect', { x: sx, y: sy, width: sw, height: sh, fill: T.remain, stroke: T.remainEdge, 'stroke-width': 0.8 }, g);
      } else if (it[1] === 'crit') {
        el('rect', { x: sx, y: sy, width: sw, height: sh, fill: critFill, stroke: T.pinkEdge, 'stroke-width': 1.2 }, g);
      } else if (it[1] === 'summary') {
        el('rect', { x: sx, y: sy, width: sw, height: 3, fill: T.summary }, g);
        el('path', { d: `M${sx},${sy}h4l-4,7zM${sx + sw},${sy}h-4l4,7z`, fill: T.summary }, g);
      } else if (it[1] === 'milestone') {
        const mx = sx + sw / 2;
        el('path', { d: `M${mx - 5},${cy}L${mx},${cy - 5}L${mx + 5},${cy}L${mx},${cy + 5}Z`, fill: T.milestone, stroke: T.msEdge, 'stroke-width': 0.8 }, g);
      } else if (it[1] === 'urc') {
        el('rect', { x: sx, y: sy, width: sw, height: sh, fill: T.remain, stroke: T.remainEdge, 'stroke-width': 0.8 }, g);
        el('rect', { x: sx - 1.6, y: sy - 1.6, width: sw + 3.2, height: sh + 3.2, fill: 'none', stroke: T.urc, 'stroke-width': 1.4 }, g);
      } else {
        el('line', { x1: sx + sw / 2, y1: cy - 6, x2: sx + sw / 2, y2: cy + 6, stroke: T.status, 'stroke-width': 1.2, 'stroke-dasharray': '3 2' }, g);
      }
      el('text', { x: sx + sw + pad, y: cy + fs * 0.35, 'font-size': fs, fill: T.text }, g, it[0]);
      cx += sw + pad + tw(it[0], fs, false) + gap;
    });
  }

  root.TF.render = { ROW_H, HEADER_H, timeline, page, pageFit };
})();
