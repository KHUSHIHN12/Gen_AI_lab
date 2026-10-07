'use strict';
// Question Generation + Test Case Generation modules (orchestration). Generates a bank of equivalent question variants
// for the topics of a session. Everything is stored as "pending" until the instructor reviews and approves it.
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const gen = require('./generator');
const ai = require('./aiClient');
const { validate, reference } = require('./validator');

const jobs = new Map();
const getJob = (sessionId) => jobs.get(sessionId) || { running: false, done: 0, total: 0, errors: [], llm: 0, template: 0 };

function sessionTopics(session) {
  const ids = db.json(session.topic_ids, []);
  const rows = ids.map((id) => db.get('SELECT * FROM topics WHERE id = ?', [id])).filter(Boolean);
  return rows.map((t) => ({ ...t, concepts: db.json(t.concepts, []) }));
}
function topicSlots(session, topic) {
  return gen.templatesForTopic(topic).slice(0, Math.max(1, session.slots_per_topic || 1));
}

async function llmVariant(topic, key, avoidTexts) {
  const tpl = gen.TEMPLATES[key];
  const hidden = config.hiddenTestCases;
  const visible = config.visibleTestCases;
  const p = await ai.proposeQuestion({ topic, conceptHint: tpl.label, difficulty: tpl.difficulty, avoidTexts, hidden, visible });
  const qtype = p.type === 'script' ? 'script' : 'query';
  const datasets = p.datasets.slice(0, visible + hidden).map((sql, i) => ({ id: `d${i}`, kind: i < visible ? 'visible' : 'hidden', sql }));
  const v = await validate({ qtype, schema: p.schema_sql, datasets, solution: p.solution_sql, check: p.check_sql, declaredDifficulty: tpl.difficulty });
  if (!v.ok) throw new Error('LLM variant rejected: ' + v.reason);
  return {
    template_key: key, theme: String(p.theme || 'llm').slice(0, 30), seed: 0, qtype, text: p.question, schema_sql: p.schema_sql,
    solution_sql: p.solution_sql, check_sql: qtype === 'script' ? p.check_sql : null, ordered: p.ordered ? 1 : 0, difficulty: tpl.difficulty,
    concepts: Array.isArray(p.concepts) && p.concepts.length ? p.concepts : [tpl.label], datasets: datasets.map((d) => ({ ...d, expected: v.expected[d.id] })),
    validation: v.validation, source: 'ai-llm',
  };
}

async function makeVariant(topic, key, avoidTexts, stats) {
  if (ai.enabled()) {
    try {
      const v = await llmVariant(topic, key, avoidTexts);
      stats.llm++;
      return v;
    } catch (e) {
      stats.errors.push(`LLM fallback (${topic.name}): ${e.message}`.slice(0, 160));
    }
  }
  for (let k = 0; k < 4; k++) {
    try {
      const v = await gen.buildVariant({ templateKey: key, seed: crypto.randomInt(1, 2 ** 31 - 1) });
      stats.template++;
      return v;
    } catch (e) {
      if (k === 3) throw e;
    }
  }
}

function insertQuestion(session, topic, slot, v) {
  const now = db.now();
  const qid = db.run(
    `INSERT INTO questions(session_id, topic_id, slot, version, status, qtype, text, schema_sql, solution_sql, check_sql, ordered, template_key, theme,
       difficulty, concepts, seed, source, validation, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [session.id, topic.id, slot, 1, 'pending', v.qtype, v.text, v.schema_sql, v.solution_sql, v.check_sql, v.ordered, v.template_key, v.theme, v.difficulty,
      JSON.stringify(v.concepts), v.seed, v.source, JSON.stringify(v.validation), now, now]
  ).lastId;
  for (const d of v.datasets) {
    db.run('INSERT INTO test_cases(question_id, kind, data_sql, expected, status, weight, created_at) VALUES(?,?,?,?,?,?,?)', [qid, d.kind, d.sql, JSON.stringify(d.expected), 'pending', 1, now]);
  }
  snapshot(qid, 'ai-generator');
  return qid;
}

function snapshot(qid, who) {
  const q = db.get('SELECT * FROM questions WHERE id = ?', [qid]);
  db.run('INSERT INTO question_versions(question_id, version, snapshot, changed_at, changed_by) VALUES(?,?,?,?,?)', [
    qid, q.version, JSON.stringify({ text: q.text, solution_sql: q.solution_sql, check_sql: q.check_sql, ordered: q.ordered, status: q.status }), db.now(), who,
  ]);
}

// Start (or continue) bank generation as a background job; progress is polled by the dashboard.
function startGeneration(session, perTopic) {
  const cur = jobs.get(session.id);
  if (cur && cur.running) throw new Error('Generation already running for this session');
  const topics = sessionTopics(session);
  if (!topics.length) throw new Error('This session has no topics');
  const plan = [];
  topics.forEach((t) => topicSlots(session, t).forEach((key, slot) => plan.push({ topic: t, key, slot })));
  const job = { running: true, done: 0, total: plan.length * perTopic, errors: [], llm: 0, template: 0, startedAt: db.now() };
  jobs.set(session.id, job);
  (async () => {
    const existing = db.all('SELECT text FROM questions WHERE session_id = ?', [session.id]).map((r) => r.text);
    for (const p of plan) {
      for (let i = 0; i < perTopic; i++) {
        try {
          let v;
          for (let tries = 0; tries < 4; tries++) {
            v = await makeVariant(p.topic, p.key, existing, job);
            if (!existing.includes(v.text)) break; // every question in the bank is textually unique
          }
          existing.push(v.text);
          insertQuestion(session, p.topic, p.slot, v);
        } catch (e) {
          job.errors.push(`${p.topic.name}: ${e.message}`.slice(0, 200));
        }
        job.done++;
      }
    }
    job.running = false;
    job.finishedAt = db.now();
  })();
  return job;
}

// Recompute expected results of every test case after the reference solution changed.
async function recomputeExpected(q) {
  const tests = db.all('SELECT * FROM test_cases WHERE question_id = ? ORDER BY id', [q.id]);
  if (!tests.length) return;
  const res = await reference({ schema: q.schema_sql, setups: tests.map((t) => ({ id: t.id, sql: t.data_sql })), solution: q.solution_sql, check: q.check_sql });
  for (const r of res) if (r.error) throw new Error('Reference solution fails on a test dataset: ' + r.error);
  for (const r of res) db.run('UPDATE test_cases SET expected = ? WHERE id = ?', [JSON.stringify({ columns: r.columns, rows: r.rows }), r.id]);
}

async function updateQuestion(q, patch, who) {
  const next = {
    text: patch.text !== undefined ? String(patch.text) : q.text,
    solution_sql: patch.solution_sql !== undefined ? String(patch.solution_sql) : q.solution_sql,
    check_sql: patch.check_sql !== undefined ? patch.check_sql || null : q.check_sql,
    ordered: patch.ordered !== undefined ? (patch.ordered ? 1 : 0) : q.ordered,
  };
  const changed = Object.keys(next).some((k) => next[k] !== q[k]);
  if (changed) {
    db.run('UPDATE questions SET text=?, solution_sql=?, check_sql=?, ordered=?, version=version+1, status=?, updated_at=? WHERE id=?', [
      next.text, next.solution_sql, next.check_sql, next.ordered, 'pending', db.now(), q.id,
    ]);
    const nq = db.get('SELECT * FROM questions WHERE id = ?', [q.id]);
    try {
      await recomputeExpected(nq);
    } catch (e) {
      db.run('UPDATE questions SET text=?, solution_sql=?, check_sql=?, ordered=?, version=version-1, status=? WHERE id=?', [q.text, q.solution_sql, q.check_sql, q.ordered, q.status, q.id]);
      await recomputeExpected(q).catch(() => {});
      throw e;
    }
    snapshot(q.id, who);
  }
  if (patch.rating !== undefined) db.run('UPDATE questions SET rating = ? WHERE id = ?', [patch.rating === null ? null : Math.max(1, Math.min(5, +patch.rating)), q.id]);
  return db.get('SELECT * FROM questions WHERE id = ?', [q.id]);
}

async function regenerateQuestion(q) {
  if (q.assigned_to) throw new Error('This question is already assigned to a student');
  const v = await gen.buildVariant({ templateKey: q.template_key, seed: crypto.randomInt(1, 2 ** 31 - 1) });
  db.run('DELETE FROM test_cases WHERE question_id = ?', [q.id]);
  db.run(
    `UPDATE questions SET version=version+1, status='pending', qtype=?, text=?, schema_sql=?, solution_sql=?, check_sql=?, ordered=?, theme=?, difficulty=?,
       concepts=?, seed=?, source=?, validation=?, rating=NULL, updated_at=? WHERE id=?`,
    [v.qtype, v.text, v.schema_sql, v.solution_sql, v.check_sql, v.ordered, v.theme, v.difficulty, JSON.stringify(v.concepts), v.seed, v.source, JSON.stringify(v.validation), db.now(), q.id]
  );
  for (const d of v.datasets) db.run('INSERT INTO test_cases(question_id, kind, data_sql, expected, status, weight, created_at) VALUES(?,?,?,?,?,?,?)', [q.id, d.kind, d.sql, JSON.stringify(d.expected), 'pending', 1, db.now()]);
  snapshot(q.id, 'ai-generator');
  return db.get('SELECT * FROM questions WHERE id = ?', [q.id]);
}

// Add a test case: either generated by the AI engine or supplied by the instructor as INSERT statements.
async function addTestCase(q, { kind = 'hidden', data_sql }) {
  let sql = data_sql;
  let expected;
  if (sql && sql.trim()) {
    const res = await reference({ schema: q.schema_sql, setups: [{ id: 'x', sql }], solution: q.solution_sql, check: q.check_sql });
    if (res[0].error) throw new Error('Your dataset does not work with the schema / reference solution: ' + res[0].error);
    expected = { columns: res[0].columns, rows: res[0].rows };
  } else {
    const d = await gen.extraDataset({ question: { ...q, concepts: db.json(q.concepts, []) }, seed: crypto.randomInt(1, 2 ** 31 - 1), kind });
    sql = d.sql;
    expected = d.expected;
  }
  const id = db.run('INSERT INTO test_cases(question_id, kind, data_sql, expected, status, weight, created_at) VALUES(?,?,?,?,?,?,?)', [q.id, kind === 'visible' ? 'visible' : 'hidden', sql, JSON.stringify(expected), 'pending', 1, db.now()]).lastId;
  return db.get('SELECT * FROM test_cases WHERE id = ?', [id]);
}

module.exports = { startGeneration, getJob, sessionTopics, topicSlots, updateQuestion, regenerateQuestion, addTestCase, recomputeExpected };
