/* Match Alpha — safe CSV generation (Fase H).
 *
 * Formula-injection guard: any STRING cell starting with = + - @ (or tab / CR) is prefixed with a
 * single quote so spreadsheet apps treat it as text. Finite numbers are written as numbers (a number
 * cannot be a formula, and "-1" must stay numeric). Cells with quotes, separators or newlines are
 * quoted (RFC 4180, "" escaping). Works in the browser (window.MA_CSV) and in Node (module.exports)
 * so tests/csv.test.js can exercise the exact same code.
 */
(function (root) {
  'use strict';

  function csvCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    let s = String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    if (/[",;\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function toCsv(columns, rows) {
    const header = columns.map((c) => csvCell(c.label)).join(',');
    const lines = rows.map((row) => columns.map((c) => csvCell(typeof c.value === 'function' ? c.value(row) : row[c.key])).join(','));
    // BOM so Excel opens UTF-8 (accents) correctly.
    return `﻿${[header, ...lines].join('\r\n')}\r\n`;
  }

  const api = { csvCell, toCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MA_CSV = api;
}(typeof window !== 'undefined' ? window : globalThis));
