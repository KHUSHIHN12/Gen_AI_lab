'use strict';
// Validates every generated question before it is shown to the instructor: the reference solution must run on every
// dataset ("answerability"), must give a meaningful and non-constant answer, and its complexity must match the declared
// difficulty ("difficulty validation").
const { runDatasets } = require('./sqlRunner');
const { signature } = require('./compare');

const LEVELS = ['easy', 'medium', 'hard'];

// Simple structural complexity score of the reference SQL.
function complexity(sql) {
  const s = ' ' + String(sql).toLowerCase().replace(/'[^']*'/g, "''") + ' ';
  const count = (re) => (s.match(re) || []).length;
  let score = 1;
  score += count(/\bjoin\b/g) * 2;
  score += count(/\bleft join\b/g) * 0.5;
  score += count(/\bgroup by\b/g) * 1.5;
  score += count(/\bhaving\b/g) * 1;
  score += count(/\(\s*select\b/g) * 2;
  score += count(/\bover\s*\(/g) * 4;
  score += count(/\b(union|intersect|except)\b/g) * 2;
  score += count(/\bcase\b/g) * 1.5;
  score += count(/\bexists\b/g) * 1.5;
  score += count(/\b(count|sum|avg|min|max)\s*\(/g) * 0.25;
  score += count(/\b(insert|update|delete|create)\b/g) * 1.5;
  return Math.round(score * 100) / 100;
}
const levelOf = (score) => (score <= 2.5 ? 'easy' : score <= 6 ? 'medium' : 'hard');

async function reference({ schema, setups, solution, check }) {
  return runDatasets({ schema, setups, script: solution, checkSql: check || null, isReference: true });
}

// datasets: [{id, kind, sql}], returns {ok, reason?, expected?: {id: {columns, rows}}, validation}
async function validate({ qtype, schema, datasets, solution, check, declaredDifficulty }) {
  const setups = datasets.map((d) => ({ id: d.id, sql: d.sql }));
  const res = await reference({ schema, setups, solution, check });
  for (const r of res) if (r.error) return { ok: false, reason: `Reference solution failed: ${r.error}` };

  if (qtype === 'query') {
    for (const r of res) {
      if (r.rows.length === 0) return { ok: false, reason: 'Reference answer is empty on a dataset (question not meaningfully answerable)' };
      if (r.rows.length > 150) return { ok: false, reason: 'Reference answer too large' };
    }
    if (res.length > 1 && new Set(res.map(signature)).size < 2) return { ok: false, reason: 'Answer is identical on all datasets (could be hard-coded)' };
  } else {
    const base = await reference({ schema, setups, solution: '', check });
    res.forEach((r, i) => {
      if (!base[i].error && signature(base[i]) === signature(r)) throw Object.assign(new Error('noop'), { reasonText: 'Reference solution changes nothing on a dataset' });
    });
  }
  const score = complexity(solution);
  const est = levelOf(score);
  const expected = {};
  res.forEach((r) => (expected[r.id] = { columns: r.columns, rows: r.rows }));
  return {
    ok: true,
    expected,
    validation: {
      answerable: true,
      datasets: datasets.length,
      complexity: score,
      estimated_difficulty: est,
      declared_difficulty: declaredDifficulty,
      difficulty_consistent: Math.abs(LEVELS.indexOf(est) - LEVELS.indexOf(declaredDifficulty)) <= 1,
      checked_at: new Date().toISOString(),
    },
  };
}

// wrapper converting the 'noop' throw into a normal failure
async function safeValidate(args) {
  try {
    return await validate(args);
  } catch (e) {
    if (e.reasonText) return { ok: false, reason: e.reasonText };
    throw e;
  }
}

module.exports = { validate: safeValidate, complexity, levelOf, reference };
