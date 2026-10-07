'use strict';
// Concept-focused feedback. Rule based (always available); optionally polished by the LLM.
// Feedback never reveals hidden test data or the reference solution.
const ai = require('./aiClient');
const config = require('../config');

const CONCEPT_HINT = {
  select_where: 'Revisit SELECT with WHERE: every condition in the question must be combined correctly (AND vs OR) and only the requested columns returned.',
  order_limit: 'Revisit ORDER BY and LIMIT: check the sort direction, add the tie-break column last, and apply LIMIT after sorting.',
  pattern: 'Revisit BETWEEN (inclusive on both ends), IN lists and LIKE patterns (% matches any text).',
  aggregate: 'Revisit aggregate functions (COUNT, SUM, AVG, MAX): they collapse the filtered rows into one row; check the column order and ROUND.',
  group_by_having: 'Revisit GROUP BY and HAVING: WHERE filters rows before grouping, HAVING filters groups after aggregation.',
  join_inner: 'Revisit JOIN ... ON: match the foreign key to the parent key and filter with WHERE; remember inner joins drop unmatched rows.',
  join_left: 'Revisit LEFT JOIN: rows without a match keep NULLs; COUNT(column) ignores NULLs while COUNT(*) does not; use IS NULL to find unmatched rows.',
  subquery: 'Revisit subqueries: a scalar subquery returns one value that you can compare against; make sure it is computed over the right set of rows.',
  exists_correlated: 'Revisit correlated subqueries / EXISTS: the inner query must refer to the outer row (same group or parent), and NOT EXISTS expresses "none".',
  set_ops: 'Revisit set operations: INTERSECT keeps common rows, EXCEPT keeps rows only in the first query, UNION merges and removes duplicates.',
  window: 'Revisit window functions: PARTITION BY restarts the calculation per group, ORDER BY inside OVER defines rank or running order.',
  case_expr: 'Revisit CASE: conditions are tested top to bottom, so order them from the most to the least restrictive; do not forget ELSE.',
  dml: 'Revisit INSERT/UPDATE/DELETE: the WHERE clause decides which rows change, and an UPDATE without it changes everything.',
  view: 'Revisit CREATE VIEW: the view must have exactly the requested name and columns in the requested order.',
  ddl_create: 'Revisit CREATE TABLE: column order, exact data types, PRIMARY KEY and NOT NULL constraints must match the specification.',
};

const GENERIC = {
  syntax_error: 'Your SQL could not be parsed. Check commas between columns, parentheses, quotes and the order of clauses (SELECT, FROM, WHERE, GROUP BY, HAVING, ORDER BY).',
  unknown_identifier: 'A table or column name was not found. Compare your names with the schema panel (spelling and the correct table for each column).',
  ambiguous_column: 'A column name exists in more than one table. Qualify it with a table alias (for example c.name).',
  timeout: 'Your query ran too long. Look for a missing join condition (cartesian product) or a runaway recursive query.',
  forbidden: 'That kind of statement is not allowed in this lab.',
  runtime_error: 'Your SQL raised an error while running. Run it in the editor first and read the message carefully.',
  empty_submission: 'No SQL was submitted. Write your query and submit again.',
  wrong_columns: 'The number of columns returned is different from what the question asks for. Re-read which columns must be returned and in which order.',
  too_many_rows: 'Your query returns more rows than expected on at least one test. A filter or join condition is probably too loose.',
  too_few_rows: 'Your query returns fewer rows than expected on at least one test. A filter is probably too strict, or an inner join is dropping rows that should be kept.',
  wrong_values: 'The rows have the right shape but some values differ. Check the expression, the aggregate function, rounding and which rows are included.',
  wrong_order: 'The right rows are returned but in the wrong order. Check the ORDER BY direction and the tie-break column.',
  overfit: 'Your query works on the sample data but not on every test dataset. Avoid hard-coded values; think about ties, duplicates, empty groups and unmatched rows.',
};

function categorize(question, results, sqlText) {
  if (!sqlText || !sqlText.trim()) return 'empty_submission';
  const failing = results.filter((r) => r.status !== 'pass');
  if (!failing.length) return 'passed';
  const visFail = failing.find((r) => r.kind === 'visible');
  if (!visFail) return 'overfit';
  const f = visFail;
  if (f.status === 'error') {
    const e = (f.error || '').toLowerCase();
    if (/timed out/.test(e)) return 'timeout';
    if (/not allowed/.test(e)) return 'forbidden';
    if (/syntax error|incomplete input|unrecognized token/.test(e)) return 'syntax_error';
    if (/no such (table|column|view)|no such function/.test(e)) return 'unknown_identifier';
    if (/ambiguous/.test(e)) return 'ambiguous_column';
    return 'runtime_error';
  }
  return { columns: 'wrong_columns', rows_more: 'too_many_rows', rows_less: 'too_few_rows', values: 'wrong_values', order: 'wrong_order' }[f.reason] || 'wrong_values';
}

function ruleFeedback(question, category, results, score) {
  const lines = [];
  const passed = results.filter((r) => r.status === 'pass').length;
  if (category === 'passed') {
    lines.push('Correct on every test case, including the hidden ones. Nice work.');
    lines.push(`Concept mastered: ${(question.concepts || []).slice(0, 4).join(', ')}.`);
    return { summary: lines.join(' '), concept: null, category };
  }
  lines.push(`You passed ${passed} of ${results.length} test cases (${Math.round(score)}%).`);
  lines.push(GENERIC[category] || GENERIC.wrong_values);
  const concept = CONCEPT_HINT[question.template_key];
  if (concept && !['syntax_error', 'unknown_identifier', 'ambiguous_column', 'timeout', 'forbidden', 'empty_submission'].includes(category)) lines.push(concept);
  if (question.qtype === 'script' && category !== 'syntax_error' && category !== 'empty_submission') lines.push('After your statement runs, the lab inspects the resulting table/view state, so make sure your statement actually performs the change.');
  return { summary: lines.join(' '), concept: concept || null, category };
}

async function buildFeedback(question, sqlText, results, score) {
  const category = categorize(question, results, sqlText);
  const fb = ruleFeedback(question, category, results, score);
  if (ai.enabled() && config.ai.llmFeedback && category !== 'passed' && category !== 'empty_submission') {
    try {
      const outcome = `${results.filter((r) => r.status === 'pass').length}/${results.length} tests passed; category=${category}`;
      const text = await ai.feedbackText({ question, sqlText, outcome });
      if (text && text.length > 20) fb.ai = text;
    } catch {
      /* keep rule-based feedback */
    }
  }
  return fb;
}

module.exports = { buildFeedback, categorize, CONCEPT_HINT };
