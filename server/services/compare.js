'use strict';
// Behaviour-based result comparison. Two queries are "equal" when they return the same columns count and the same rows
// (as a multiset unless the question asks for an order) - so differently written but equivalent SQL gets full credit.

const nv = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : String(v);
  return String(v);
};
const rowKey = (row) => JSON.stringify(row.map(nv));

function signature(res) {
  if (!res || res.error) return 'ERR';
  return res.columns.length + ':' + res.rows.map(rowKey).sort().join('|');
}

// expected/actual: {columns, rows} (actual may be {error}). Returns {ok, reason}
function compareResults(expected, actual, ordered) {
  if (!actual || actual.error) return { ok: false, reason: 'error', error: actual && actual.error };
  if (expected.columns.length !== actual.columns.length) return { ok: false, reason: 'columns' };
  if (actual.rows.length > expected.rows.length) return { ok: false, reason: 'rows_more' };
  if (actual.rows.length < expected.rows.length) return { ok: false, reason: 'rows_less' };
  const e = expected.rows.map(rowKey);
  const a = actual.rows.map(rowKey);
  if (ordered) {
    if (e.every((k, i) => k === a[i])) return { ok: true };
    const es = [...e].sort();
    const as = [...a].sort();
    return { ok: false, reason: es.every((k, i) => k === as[i]) ? 'order' : 'values' };
  }
  const es = [...e].sort();
  const as = [...a].sort();
  return es.every((k, i) => k === as[i]) ? { ok: true } : { ok: false, reason: 'values' };
}

module.exports = { compareResults, signature, rowKey };
