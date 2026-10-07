'use strict';
// Student side: join a broadcast session by URL, get a unique question, practise in an isolated database,
// submit for automatic evaluation, and (when allowed) see score + concept-focused feedback.
const express = require('express');
const db = require('../db');
const config = require('../config');
const { auth } = require('../auth');
const S = require('../services/sessions');
const { sandbox, resetSandbox } = require('../services/sqlRunner');
const { runAgainstTests, approvedTests } = require('../services/evaluator');

const router = express.Router();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(e.status || 400).json({ error: e.message, code: e.code }));
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const MAX_SQL = 20000;

// ---------------------------------------------------------------- public info (no login) - used by the /s/<token> page
router.get('/public/session/:token', (req, res) => {
  const s = db.get('SELECT * FROM sessions WHERE token = ?', [req.params.token]);
  if (!s) return res.status(404).json({ error: 'No such session. Check the URL shown in the lab room.' });
  res.json({ title: s.title, mode: s.mode, status: s.status, lockdown: s.mode === 'assessment', strict: s.mode === 'assessment' && config.lockdownStrict, duration_min: s.duration_min });
});

router.use('/play/:token', auth('student'), (req, res, next) => {
  const s = db.get('SELECT * FROM sessions WHERE token = ?', [req.params.token]);
  if (!s) return res.status(404).json({ error: 'No such session' });
  // Safe-browser requirement applies to assessments only. Class sessions never need it.
  if (s.mode === 'assessment' && config.lockdownStrict && req.headers['x-lockdown-client'] !== config.lockdownSecret)
    return res.status(403).json({ error: 'This assessment must be opened in the DBMS Lab Lockdown Browser.', code: 'LOCKDOWN_REQUIRED' });
  req.sess = s;
  next();
});

// ---------------------------------------------------------------- helpers
function participant(s, uid) {
  return db.get('SELECT * FROM participants WHERE session_id = ? AND user_id = ?', [s.id, uid]);
}

// Give the student one unique, approved, not-yet-assigned question for every (topic, slot) of the session.
function assign(s, uid) {
  const pairs = db.all('SELECT DISTINCT topic_id, slot FROM questions WHERE session_id = ? ORDER BY topic_id, slot', [s.id]);
  const waiting = [];
  for (const p of pairs) {
    if (db.get('SELECT id FROM questions WHERE session_id = ? AND topic_id = ? AND slot = ? AND assigned_to = ?', [s.id, p.topic_id, p.slot, uid])) continue;
    const pool = db.all("SELECT id FROM questions WHERE session_id = ? AND topic_id = ? AND slot = ? AND status = 'approved' AND assigned_to IS NULL", [s.id, p.topic_id, p.slot]);
    if (!pool.length) {
      if (db.get("SELECT id FROM questions WHERE session_id = ? AND topic_id = ? AND slot = ? AND status IN ('approved','pending')", [s.id, p.topic_id, p.slot]))
        waiting.push(db.get('SELECT name FROM topics WHERE id = ?', [p.topic_id]).name);
      continue;
    }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    db.run('UPDATE questions SET assigned_to = ?, assigned_at = ? WHERE id = ? AND assigned_to IS NULL', [uid, db.now(), pick.id]);
  }
  return waiting;
}

const resultsVisible = (s, part) => s.show_results === 'immediate' || s.status === 'ended' || (part && part.status === 'submitted');

// Student-safe view of per-test results: hidden tests never reveal data.
function maskResults(results) {
  return results.map((r) => (r.kind === 'hidden'
    ? { kind: 'hidden', status: r.status, reason: r.reason }
    : { kind: 'visible', status: r.status, reason: r.reason, error: r.error, expected: r.expected, actual: r.actual }));
}

function questionView(s, part, q, showScores) {
  const subs = db.all('SELECT * FROM submissions WHERE session_id = ? AND user_id = ? AND question_id = ? ORDER BY id', [s.id, part.user_id, q.id]);
  const best = subs.reduce((b, x) => (!b || x.final_score > b.final_score ? x : b), null);
  const draft = db.get('SELECT sql_text FROM drafts WHERE session_id = ? AND user_id = ? AND question_id = ?', [s.id, part.user_id, q.id]);
  return {
    id: q.id, topic: q.topic_name, slot: q.slot, difficulty: q.difficulty, concepts: db.json(q.concepts, []), text: q.text, qtype: q.qtype,
    attempts: subs.length, max_attempts: s.max_attempts, answered: subs.length > 0, draft: draft ? draft.sql_text : '',
    last_sql: subs.length ? subs[subs.length - 1].sql_text : '', best_score: showScores && best ? best.final_score : null,
  };
}

function buildState(s, uid) {
  const part = participant(s, uid);
  const qs = db.all('SELECT q.*, t.name topic_name FROM questions q JOIN topics t ON t.id = q.topic_id WHERE q.session_id = ? AND q.assigned_to = ? ORDER BY t.position, q.slot', [s.id, uid]);
  const show = resultsVisible(s, part);
  return {
    session: {
      title: s.title, mode: s.mode, status: s.status, duration_min: s.duration_min, ends_at: s.ends_at, show_results: s.show_results, max_attempts: s.max_attempts,
      lockdown: s.mode === 'assessment', strict: s.mode === 'assessment' && config.lockdownStrict,
    },
    server_time: db.now(),
    participant: part && { status: part.status, finish_reason: part.finish_reason, violations: S.violationCount(s.id, uid) },
    questions: part ? qs.map((q) => questionView(s, part, q, show)) : [],
    results_visible: show,
  };
}

// ---------------------------------------------------------------- join / state
router.post('/play/:token/join', wrap(async (req, res) => {
  const s = req.sess;
  let part = participant(s, req.user.id);
  if (!part) {
    if (s.status === 'draft') throw fail(409, 'This session has not been broadcast yet. Wait for your instructor.', 'NOT_LIVE');
    if (s.status === 'ended') throw fail(409, 'This session has ended.', 'ENDED');
    db.run('INSERT INTO participants(session_id, user_id, status, joined_at, last_seen) VALUES(?,?,?,?,?)', [s.id, req.user.id, 'active', db.now(), db.now()]);
    part = participant(s, req.user.id);
  }
  const waiting = s.status === 'live' && part.status !== 'submitted' ? assign(s, req.user.id) : [];
  res.json({ ...buildState(s, req.user.id), waiting });
}));

router.get('/play/:token/state', wrap(async (req, res) => {
  const s = db.get('SELECT * FROM sessions WHERE id = ?', [req.sess.id]);
  const part = participant(s, req.user.id);
  if (part) db.run('UPDATE participants SET last_seen = ? WHERE id = ?', [db.now(), part.id]);
  let waiting = [];
  if (part && s.status === 'live' && part.status === 'active') waiting = assign(s, req.user.id);
  res.json({ ...buildState(s, req.user.id), waiting });
}));

function ctx(req, { needActive = true } = {}) {
  const s = db.get('SELECT * FROM sessions WHERE id = ?', [req.sess.id]);
  const part = participant(s, req.user.id);
  if (!part) throw fail(403, 'Join the session first');
  if (needActive) {
    if (s.status !== 'live') throw fail(409, 'The session is not live', 'ENDED');
    if (part.status === 'paused') throw fail(423, 'Your test is paused. Please wait for your instructor.', 'PAUSED');
    if (part.status === 'submitted') throw fail(409, 'You have already submitted this test.', 'SUBMITTED');
  }
  return { s, part };
}
function myQuestion(s, uid, qid) {
  const q = db.get('SELECT * FROM questions WHERE id = ? AND session_id = ? AND assigned_to = ?', [qid, s.id, uid]);
  if (!q) throw fail(404, 'Question not found');
  return q;
}
function sandboxData(q) {
  const t = db.get("SELECT data_sql FROM test_cases WHERE question_id = ? AND kind = 'visible' ORDER BY (status = 'approved') DESC, id LIMIT 1", [q.id]);
  return t ? t.data_sql : '';
}

// ---------------------------------------------------------------- practice in the per-student isolated database
router.get('/play/:token/questions/:qid/schema', wrap(async (req, res) => {
  const { s } = ctx(req, { needActive: false });
  const q = myQuestion(s, req.user.id, +req.params.qid);
  const r = await sandbox({ sid: s.id, uid: req.user.id, qid: q.id, schema: q.schema_sql, data: sandboxData(q), script: '' });
  res.json({ tables: r.tables });
}));

// Run = execute the query in the student's private database AND check it against the sample (visible) test cases.
router.post('/play/:token/run', wrap(async (req, res) => {
  const { s } = ctx(req);
  const q = myQuestion(s, req.user.id, +req.body.question_id);
  const sql = String(req.body.sql || '');
  if (sql.length > MAX_SQL) throw fail(400, 'SQL too long');
  const visible = approvedTests(q.id).filter((t) => t.kind === 'visible');
  const failed = (msg) => ({ passed: 0, total: visible.length, results: visible.map(() => ({ kind: 'visible', status: 'error', reason: 'error', error: msg })) });
  let out;
  try {
    const r = await sandbox({ sid: s.id, uid: req.user.id, qid: q.id, schema: q.schema_sql, data: sandboxData(q), script: sql });
    out = { result: r.result, error: r.error, tables: r.tables };
  } catch (e) {
    out = { error: e.message, result: null };
  }
  if (!sql.trim()) out.tests = failed('Write a query first');
  else if (out.error) out.tests = failed(out.error);
  else {
    const rs = await runAgainstTests(q, sql, visible);
    out.tests = { passed: rs.filter((r) => r.status === 'pass').length, total: rs.length, results: maskResults(rs) };
  }
  res.json(out);
}));

router.post('/play/:token/reset', wrap(async (req, res) => {
  const { s } = ctx(req);
  const q = myQuestion(s, req.user.id, +req.body.question_id);
  resetSandbox(s.id, req.user.id, q.id);
  const r = await sandbox({ sid: s.id, uid: req.user.id, qid: q.id, schema: q.schema_sql, data: sandboxData(q), script: '' });
  res.json({ tables: r.tables });
}));

router.put('/play/:token/draft', wrap(async (req, res) => {
  const { s } = ctx(req);
  const q = myQuestion(s, req.user.id, +req.body.question_id);
  db.run('INSERT OR REPLACE INTO drafts(session_id, user_id, question_id, sql_text, updated_at) VALUES(?,?,?,?,?)', [s.id, req.user.id, q.id, String(req.body.sql || '').slice(0, MAX_SQL), db.now()]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- submit -> automatic evaluation
router.post('/play/:token/submit', wrap(async (req, res) => {
  const { s, part } = ctx(req);
  const q = myQuestion(s, req.user.id, +req.body.question_id);
  const sql = String(req.body.sql || '');
  if (sql.length > MAX_SQL) throw fail(400, 'SQL too long');
  const used = db.get('SELECT COUNT(*) n FROM submissions WHERE session_id = ? AND user_id = ? AND question_id = ?', [s.id, req.user.id, q.id]).n;
  if (s.max_attempts > 0 && used >= s.max_attempts) throw fail(409, `You have used all ${s.max_attempts} attempt(s) for this question.`, 'NO_ATTEMPTS');
  db.run('INSERT OR REPLACE INTO drafts(session_id, user_id, question_id, sql_text, updated_at) VALUES(?,?,?,?,?)', [s.id, req.user.id, q.id, sql, db.now()]);
  const sub = await S.storeSubmission(s, req.user.id, q, sql);
  const show = resultsVisible(s, part);
  // Test-case outcome (successful / failed) is always shown; data, score and feedback only when results are released.
  const results = show ? maskResults(sub.results) : sub.results.map((r) => ({ kind: r.kind, status: r.status, reason: r.reason }));
  res.json({
    accepted: true, attempt: sub.attempt, attempts_left: s.max_attempts > 0 ? s.max_attempts - sub.attempt : null, passed: sub.passed, total: sub.total, results,
    ...(show ? { score: sub.score, feedback: sub.feedback } : { message: 'Answer recorded. Your score and feedback will appear after you submit the whole test.' }),
  });
}));

router.post('/play/:token/finish', wrap(async (req, res) => {
  const { s } = ctx(req, { needActive: false });
  await S.finalizeParticipant(s, req.user.id, 'submitted by student');
  res.json(buildState(db.get('SELECT * FROM sessions WHERE id = ?', [s.id]), req.user.id));
}));

// ---------------------------------------------------------------- lockdown monitoring (assessment only)
router.post('/play/:token/violation', wrap(async (req, res) => {
  const { s, part } = ctx(req, { needActive: false });
  if (s.mode !== 'assessment') return res.json({ action: 'ignored' });
  if (part.status === 'submitted' || s.status !== 'live') return res.json({ action: 'ignored' });
  const out = S.recordViolation(s, req.user.id, String(req.body.type || 'unknown').slice(0, 40), req.body.detail);
  res.json(out);
}));

// ---------------------------------------------------------------- results
router.get('/play/:token/results', wrap(async (req, res) => {
  const { s, part } = ctx(req, { needActive: false });
  if (!resultsVisible(s, part)) throw fail(403, 'Results are released after you submit the test.', 'RESULTS_LOCKED');
  const qs = db.all('SELECT q.*, t.name topic_name FROM questions q JOIN topics t ON t.id = q.topic_id WHERE q.session_id = ? AND q.assigned_to = ? ORDER BY t.position, q.slot', [s.id, req.user.id]);
  const items = qs.map((q) => {
    const subs = db.all('SELECT * FROM submissions WHERE session_id = ? AND user_id = ? AND question_id = ? ORDER BY id', [s.id, req.user.id, q.id]);
    const best = subs.reduce((b, x) => (!b || x.final_score > b.final_score ? x : b), null);
    return {
      question_id: q.id, topic: q.topic_name, text: q.text, concepts: db.json(q.concepts, []), attempts: subs.length,
      score: best ? best.final_score : 0, teacher_comment: best ? best.teacher_comment : null, sql: best ? best.sql_text : '',
      results: best ? maskResults(db.json(best.results, [])) : [], feedback: best ? db.json(best.feedback, {}) : { summary: 'Not answered.' },
    };
  });
  const total = items.length ? Math.round((items.reduce((a, i) => a + i.score, 0) / items.length) * 10) / 10 : 0;
  res.json({ total, items });
}));

module.exports = router;
