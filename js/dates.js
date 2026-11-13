/* TF.dates - DST-safe ISO date helpers. All arithmetic goes through integer UTC day numbers. */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  root.TF = root.TF || {};

  const MS_PER_DAY = 86400000;
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function pad(n, w) {
    return String(n).padStart(w, '0');
  }

  function daysInMonth(y, m) {
    // m is 1..12; day 0 of the next month is the last day of this one
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  function isValid(iso) {
    if (typeof iso !== 'string') return false;
    const m = ISO_RE.exec(iso);
    if (!m) return false;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1) return false;
    return d <= daysInMonth(y, mo);
  }

  function toDay(iso) {
    if (!isValid(iso)) throw new Error('Invalid date: ' + iso);
    const m = ISO_RE.exec(iso);
    return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / MS_PER_DAY);
  }

  function fromDay(n) {
    const dt = new Date(n * MS_PER_DAY);
    return pad(dt.getUTCFullYear(), 4) + '-' + pad(dt.getUTCMonth() + 1, 2) + '-' + pad(dt.getUTCDate(), 2);
  }

  /** Local calendar date of "now" as ISO (local on purpose: it is the user's today). */
  function today() {
    const n = new Date();
    return pad(n.getFullYear(), 4) + '-' + pad(n.getMonth() + 1, 2) + '-' + pad(n.getDate(), 2);
  }

  function addDays(iso, n) {
    return fromDay(toDay(iso) + n);
  }

  function diff(a, b) {
    return toDay(b) - toDay(a);
  }

  function duration(start, end) {
    return diff(start, end) + 1;
  }

  /** Monday on or before the date. 1970-01-01 was a Thursday, so Monday-based index = (day + 3) mod 7. */
  function weekStart(iso) {
    const n = toDay(iso);
    const dow = (((n + 3) % 7) + 7) % 7; // 0 = Monday
    return fromDay(n - dow);
  }

  function monthStart(iso) {
    return iso.slice(0, 8) + '01';
  }

  function monthEnd(iso) {
    const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
    return pad(y, 4) + '-' + pad(m, 2) + '-' + pad(daysInMonth(y, m), 2);
  }

  // ISO strings of equal format compare correctly as strings, but go through day numbers for safety.
  function min(a, b) {
    return toDay(a) <= toDay(b) ? a : b;
  }
  function max(a, b) {
    return toDay(a) >= toDay(b) ? a : b;
  }
  function clamp(iso, lo, hi) {
    return min(max(iso, lo), hi);
  }

  function parts(iso) {
    toDay(iso); // validates
    return { y: +iso.slice(0, 4), m: +iso.slice(5, 7), d: +iso.slice(8, 10) };
  }

  function fmtShort(iso) {
    const p = parts(iso);
    return MONTHS_SHORT[p.m - 1] + ' ' + p.d;
  }
  function fmtLong(iso) {
    const p = parts(iso);
    return MONTHS_SHORT[p.m - 1] + ' ' + p.d + ', ' + p.y;
  }
  function fmtMonth(iso) {
    const p = parts(iso);
    return MONTHS_SHORT[p.m - 1].toUpperCase() + ' ' + p.y;
  }

  root.TF.dates = {
    toDay, fromDay, isValid, today, addDays, diff, duration, weekStart, monthStart, monthEnd,
    min, max, clamp, fmtShort, fmtLong, fmtMonth, MONTHS_SHORT,
  };
})();
