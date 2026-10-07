'use strict';
// Assessment & Evaluation Engine: executes the student's SQL on isolated databases built from the approved test cases,
// compares behaviour (not text) with the expected results, scores, categorises errors and prepares feedback.
const db = require('../db');
const { runDatasets } = require('./sqlRunner');
const { compareResults } = require('./compare');
const { buildFeedback } = require('./feedback');

const SHOW = 10; // rows kept per result for display

const cut = (r) => (r && r.rows ? { columns: r.columns, rows: r.rows.slice(0, SHOW), total: r.rows.length } : null);

function approvedTests(questionId) {
  let tests = db.all("SELECT * FROM test_cases WHERE question_id = ? AND status = 'approved' ORDER BY id", [questionId]);
  return tests;
}

// Core: run `sqlText` against the given tests -> per-test results
async function runAgainstTests(question, sqlText, tests) {
  const setups = tests.map((t) => ({ id: t.id, sql: t.data_sql }));
  const runs = await runDatasets({ schema: question.schema_sql, setups, script: sqlText || '', checkSql: question.check_sql || null });
  return tests.map((t) => {
    const run = runs.find((r) => r.id === t.id) || { error: 'not executed' };
    const expected = db.json(t.expected, { columns: [], rows: [] });
    const cmp = compareResults(expected, run, !!question.ordered);
    return {
      test_id: t.id, kind: t.kind, weight: t.weight,
      status: cmp.ok ? 'pass' : run.error ? 'error' : 'fail',
      reason: cmp.ok ? 'ok' : cmp.reason, error: run.error || null,
      expected: cut(expected), actual: run.error ? null : cut(run),
    };
  });
}

async function evaluate(question, sqlText) {
  const t0 = Date.now();
  const tests = approvedTests(question.id);
  if (!tests.length) throw new Error('This question has no approved test cases yet');
  const results = sqlText && sqlText.trim() ? await runAgainstTests(question, sqlText, tests) : tests.map((t) => ({ test_id: t.id, kind: t.kind, weight: t.weight, status: 'fail', reason: 'empty', error: null, expected: null, actual: null }));
  const total = results.length;
  const passed = results.filter((r) => r.status === 'pass').length;
  const wsum = results.reduce((a, r) => a + r.weight, 0);
  const wpass = results.filter((r) => r.status === 'pass').reduce((a, r) => a + r.weight, 0);
  const score = wsum ? Math.round((wpass / wsum) * 1000) / 10 : 0;
  const feedback = await buildFeedback(question, sqlText, results, score);
  return { results, passed, total, score, category: feedback.category, feedback, eval_ms: Date.now() - t0 };
}

// Decide whether a submission needs the instructor's attention (dual evaluation: AI first, teacher reviews flagged cases)
function flagFor({ score, category, results, violations }) {
  const reasons = [];
  if (score > 0 && score < 100 && score >= 30 && score <= 90) reasons.push('borderline score');
  if (category === 'overfit') reasons.push('passes visible tests but fails hidden ones (possible hard-coding)');
  if (category === 'timeout' || category === 'forbidden') reasons.push(category);
  if (violations > 0) reasons.push(`${violations} lockdown violation(s) in this session`);
  if (score === 100 && results.length && violations >= 3) reasons.push('perfect score with repeated violations');
  return { flagged: reasons.length ? 1 : 0, reason: reasons.join('; ') };
}

// ---------------------------------------------------------------- mutation testing (test-case effectiveness)
function mutants(sql) {
  const out = new Map();
  const add = (desc, s) => {
    if (s !== sql && !out.has(s)) out.set(s, desc);
  };
  const first = (re, fn, desc) => {
    const m = re.exec(sql);
    if (m) add(desc, sql.slice(0, m.index) + fn(m) + sql.slice(m.index + m[0].length));
  };
  first(/>=/, () => '>', 'changed >= to >');
  first(/<=/, () => '<', 'changed <= to <');
  first(/(?<![<>=])>(?!=)/, () => '>=', 'changed > to >=');
  first(/(?<![<>=])<(?![=>])/, () => '<=', 'changed < to <=');
  first(/\bDESC\b/, () => 'ASC', 'flipped DESC to ASC');
  first(/\bASC\b/, () => 'DESC', 'flipped ASC to DESC');
  first(/\bAND\b/, () => 'OR', 'replaced AND with OR');
  first(/\bLEFT JOIN\b/, () => 'JOIN', 'LEFT JOIN -> INNER JOIN');
  first(/(?<!LEFT )\bJOIN\b/, () => 'LEFT JOIN', 'INNER JOIN -> LEFT JOIN');
  first(/\bSUM\(/, () => 'AVG(', 'SUM -> AVG');
  first(/\bAVG\(/, () => 'SUM(', 'AVG -> SUM');
  first(/\bMAX\(/, () => 'MIN(', 'MAX -> MIN');
  first(/\bCOUNT\(\*\)/, () => 'SUM(1) + 1', 'COUNT(*) off by one');
  first(/\bUNION\b/, () => 'INTERSECT', 'UNION -> INTERSECT');
  first(/\bINTERSECT\b/, () => 'UNION', 'INTERSECT -> UNION');
  first(/\bEXCEPT\b/, () => 'UNION', 'EXCEPT -> UNION');
  first(/\bRANK\(\)/, () => 'ROW_NUMBER()', 'RANK -> ROW_NUMBER');
  first(/\bNOT EXISTS\b/, () => 'EXISTS', 'NOT EXISTS -> EXISTS');
  first(/\bIS NULL\b/, () => 'IS NOT NULL', 'IS NULL -> IS NOT NULL');
  first(/\bLIMIT (\d+)/, (m) => `LIMIT ${+m[1] + 1}`, 'LIMIT off by one');
  first(/\bNOT NULL\b/, () => '', 'dropped a NOT NULL constraint');
  first(/\bPRIMARY KEY\b/, () => '', 'dropped PRIMARY KEY');
  first(/(\w+) = '/, (m) => `${m[1]} <> '`, 'inverted string comparison');
  first(/\b(\d{3,})\b/, (m) => String(Math.round(+m[1] * 1.1)), 'shifted a numeric threshold');
  first(/\bHAVING\b[\s\S]*$/, () => '', 'removed the HAVING clause');
  if (/^\s*(UPDATE|DELETE)\b/i.test(sql)) first(/\sWHERE\b[\s\S]*$/i, () => '', 'removed the WHERE clause');
  return [...out.entries()].map(([s, d]) => ({ sql: s, desc: d }));
}

async function mutationTest(question) {
  const tests = approvedTests(question.id);
  const list = mutants(question.solution_sql);
  let valid = 0;
  let killed = 0;
  const survivors = [];
  for (const m of list) {
    const res = await runAgainstTests(question, m.sql, tests);
    if (res.some((r) => r.status === 'error')) continue; // syntactically/semantically invalid mutant: not counted
    valid++;
    if (res.some((r) => r.status !== 'pass')) killed++;
    else survivors.push(m.desc);
  }
  return { mutants: list.length, valid, killed, rate: valid ? Math.round((killed / valid) * 1000) / 10 : null, survivors };
}

module.exports = { evaluate, flagFor, approvedTests, runAgainstTests, mutationTest, mutants };
