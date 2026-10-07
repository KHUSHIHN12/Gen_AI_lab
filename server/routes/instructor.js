'use strict';
// Instructor web-portal API: syllabus, sessions (class / assessment), question & test-case review, live monitoring,
// submission review (dual evaluation), analytics and exports.
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const db = require('../db');
const config = require('../config');
const { auth } = require('../auth');
const { parseSyllabus, extractText, normDifficulty } = require('../services/syllabusProcessor');
const bank = require('../services/bank');
const S = require('../services/sessions');
const analytics = require('../services/analytics');
const { approvedTests } = require('../services/evaluator');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
router.use(auth('instructor'));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(e.status || 400).json({ error: e.message }));
const fail = (status, message) => Object.assign(new Error(message), { status });
const num = (v, d, lo, hi) => Math.max(lo, Math.min(hi, isNaN(+v) || v === '' || v === null || v === undefined ? d : +v));
const getSession = (id) => db.get('SELECT * FROM sessions WHERE id = ?', [id]) || (() => { throw fail(404, 'Session not found'); })();
const getQuestion = (id) => db.get('SELECT * FROM questions WHERE id = ?', [id]) || (() => { throw fail(404, 'Question not found'); })();

// ============================================================ overview
router.get('/overview', (req, res) => {
  res.json({
    sessions: db.get('SELECT COUNT(*) n FROM sessions').n,
    live: db.all("SELECT id, title, mode, token FROM sessions WHERE status = 'live'"),
    students: db.get("SELECT COUNT(*) n FROM users WHERE role = 'student'").n,
    syllabi: db.get('SELECT COUNT(*) n FROM syllabi').n,
    ai: { provider: config.ai.provider, model: config.ai.provider === 'openai' ? config.ai.model : 'built-in template engine' },
    lockdown_strict: config.lockdownStrict,
  });
});

// ============================================================ syllabus
const topicRows = (sid) => db.all('SELECT * FROM topics WHERE syllabus_id = ? ORDER BY position, id', [sid]).map((t) => ({ ...t, concepts: db.json(t.concepts, []) }));

router.get('/syllabi', (req, res) => {
  res.json(db.all('SELECT s.id, s.title, s.created_at, (SELECT COUNT(*) FROM topics t WHERE t.syllabus_id = s.id) topics FROM syllabi s ORDER BY s.id DESC'));
});

router.post('/syllabi', upload.single('file'), wrap(async (req, res) => {
  let text = String(req.body.text || '');
  if (req.file) text = await extractText(req.file);
  if (!text.trim()) throw fail(400, 'Upload a syllabus file (.txt .md .csv .pdf .docx) or paste the syllabus text');
  const topics = parseSyllabus(text);
  if (!topics.length) throw fail(400, 'No topics could be detected. Use one topic per line or the format  Topic | concepts | difficulty | objective');
  const title = String(req.body.title || (req.file && req.file.originalname) || 'DBMS Syllabus').trim().slice(0, 120);
  const id = db.run('INSERT INTO syllabi(instructor_id, title, raw_text, created_at) VALUES(?,?,?,?)', [req.user.id, title, text.slice(0, 200000), db.now()]).lastId;
  topics.forEach((t, i) => db.run('INSERT INTO topics(syllabus_id, name, concepts, objectives, difficulty, position) VALUES(?,?,?,?,?,?)', [id, t.name, JSON.stringify(t.concepts), t.objectives, t.difficulty, i]));
  res.json({ id, title, topics: topicRows(id) });
}));

router.get('/syllabi/:id', (req, res) => {
  const s = db.get('SELECT id, title, created_at FROM syllabi WHERE id = ?', [req.params.id]);
  if (!s) return res.status(404).json({ error: 'Syllabus not found' });
  res.json({ ...s, topics: topicRows(s.id) });
});

// Replace the topic list (edit names, concepts, difficulty and objectives). Topics that are used by a session are updated in place.
router.put('/syllabi/:id/topics', wrap(async (req, res) => {
  const sid = +req.params.id;
  if (!db.get('SELECT id FROM syllabi WHERE id = ?', [sid])) throw fail(404, 'Syllabus not found');
  const incoming = Array.isArray(req.body.topics) ? req.body.topics : [];
  const keep = new Set();
  incoming.forEach((t, i) => {
    const name = String(t.name || '').trim();
    if (!name) return;
    const concepts = (Array.isArray(t.concepts) ? t.concepts : String(t.concepts || '').split(/[,;]/)).map((c) => String(c).trim().toUpperCase()).filter(Boolean);
    const vals = [name, JSON.stringify(concepts), String(t.objectives || ''), normDifficulty(t.difficulty), i];
    if (t.id && db.get('SELECT id FROM topics WHERE id = ? AND syllabus_id = ?', [t.id, sid])) {
      db.run('UPDATE topics SET name=?, concepts=?, objectives=?, difficulty=?, position=? WHERE id=?', [...vals, t.id]);
      keep.add(+t.id);
    } else keep.add(db.run('INSERT INTO topics(name, concepts, objectives, difficulty, position, syllabus_id) VALUES(?,?,?,?,?,?)', [...vals, sid]).lastId);
  });
  for (const t of db.all('SELECT id FROM topics WHERE syllabus_id = ?', [sid])) {
    if (keep.has(t.id)) continue;
    if (db.get('SELECT 1 x FROM questions WHERE topic_id = ?', [t.id])) continue; // used by a question bank: keep
    db.run('DELETE FROM topics WHERE id = ?', [t.id]);
  }
  res.json({ topics: topicRows(sid) });
}));

router.delete('/syllabi/:id', wrap(async (req, res) => {
  if (db.get('SELECT 1 x FROM sessions WHERE syllabus_id = ?', [req.params.id])) throw fail(409, 'This syllabus is used by a session');
  db.run('DELETE FROM topics WHERE syllabus_id = ?', [req.params.id]);
  db.run('DELETE FROM syllabi WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ============================================================ sessions
function sessionSummary(s) {
  const q = db.all('SELECT status, COUNT(*) n FROM questions WHERE session_id = ? GROUP BY status', [s.id]);
  const by = Object.fromEntries(q.map((r) => [r.status, r.n]));
  return {
    id: s.id, title: s.title, mode: s.mode, status: s.status, token: s.token, duration_min: s.duration_min, created_at: s.created_at, started_at: s.started_at, ends_at: s.ends_at,
    topics: db.json(s.topic_ids, []).length, participants: db.get('SELECT COUNT(*) n FROM participants WHERE session_id = ?', [s.id]).n,
    questions: { pending: by.pending || 0, approved: by.approved || 0, rejected: by.rejected || 0 },
  };
}

router.get('/sessions', (req, res) => res.json(db.all('SELECT * FROM sessions ORDER BY id DESC').map(sessionSummary)));

router.post('/sessions', wrap(async (req, res) => {
  const b = req.body;
  const syl = db.get('SELECT * FROM syllabi WHERE id = ?', [b.syllabus_id]);
  if (!syl) throw fail(400, 'Choose a syllabus first');
  const mode = b.mode === 'assessment' ? 'assessment' : 'class';
  const valid = new Set(topicRows(syl.id).map((t) => t.id));
  let ids = (Array.isArray(b.topic_ids) ? b.topic_ids : []).map(Number).filter((id) => valid.has(id));
  if (!ids.length) ids = [...valid];
  if (!ids.length) throw fail(400, 'The syllabus has no topics');
  const title = String(b.title || '').trim() || `${mode === 'assessment' ? 'Assessment' : 'Lab class'} ${new Date().toLocaleDateString()}`;
  const policy = { pause_after: num(b.pause_after, 3, 0, 50), submit_after: num(b.submit_after, 6, 0, 100) };
  const id = db.run(
    `INSERT INTO sessions(instructor_id, syllabus_id, title, mode, token, status, duration_min, max_attempts, show_results, policy, topic_ids, slots_per_topic, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.user.id, syl.id, title.slice(0, 120), mode, S.newToken(), 'draft', num(b.duration_min, 0, 0, 600), num(b.max_attempts, mode === 'assessment' ? 1 : 0, 0, 50),
      b.show_results === 'after_finish' || b.show_results === 'immediate' ? b.show_results : mode === 'assessment' ? 'after_finish' : 'immediate',
      JSON.stringify(policy), JSON.stringify(ids), num(b.slots_per_topic, 1, 1, 3), db.now()]
  ).lastId;
  res.json({ id });
}));

router.get('/sessions/:id', wrap(async (req, res) => {
  const s = getSession(req.params.id);
  const topics = bank.sessionTopics(s);
  const urls = S.joinUrls(s, req);
  const qr = await QRCode.toDataURL(urls[0], { margin: 1, width: 320 });
  const slots = [];
  for (const t of topics)
    bank.topicSlots(s, t).forEach((key, slot) => {
      const c = db.get(
        `SELECT COUNT(*) total, SUM(status='approved') approved, SUM(status='approved' AND assigned_to IS NULL) available, SUM(status='pending') pending, SUM(assigned_to IS NOT NULL) assigned
         FROM questions WHERE session_id = ? AND topic_id = ? AND slot = ?`, [s.id, t.id, slot]);
      slots.push({ topic_id: t.id, topic: t.name, slot, template: key, total: c.total, approved: c.approved || 0, available: c.available || 0, pending: c.pending || 0, assigned: c.assigned || 0 });
    });
  res.json({
    ...sessionSummary(s), policy: S.policyOf(s), max_attempts: s.max_attempts, show_results: s.show_results, slots_per_topic: s.slots_per_topic,
    syllabus_id: s.syllabus_id, topic_list: topics.map((t) => ({ id: t.id, name: t.name, difficulty: t.difficulty, concepts: t.concepts })),
    join_urls: urls, qr, lockdown: s.mode === 'assessment', lockdown_strict: config.lockdownStrict, slots, generation: bank.getJob(s.id),
    enrolled_students: db.get("SELECT COUNT(*) n FROM users WHERE role = 'student'").n,
  });
}));

router.patch('/sessions/:id', wrap(async (req, res) => {
  const s = getSession(req.params.id);
  if (s.status !== 'draft') throw fail(409, 'Only sessions that have not been broadcast can be edited');
  const b = req.body;
  const mode = b.mode === 'assessment' || b.mode === 'class' ? b.mode : s.mode;
  db.run('UPDATE sessions SET title=?, mode=?, duration_min=?, max_attempts=?, show_results=?, policy=? WHERE id=?', [
    String(b.title || s.title).slice(0, 120), mode, num(b.duration_min, s.duration_min, 0, 600), num(b.max_attempts, s.max_attempts, 0, 50),
    b.show_results === 'after_finish' || b.show_results === 'immediate' ? b.show_results : s.show_results,
    JSON.stringify({ pause_after: num(b.pause_after, S.policyOf(s).pause_after, 0, 50), submit_after: num(b.submit_after, S.policyOf(s).submit_after, 0, 100) }), s.id,
  ]);
  res.json({ ok: true });
}));

// Generate the bank of equivalent question variants (background job; poll GET /sessions/:id)
router.post('/sessions/:id/generate', wrap(async (req, res) => {
  const s = getSession(req.params.id);
  if (s.status === 'ended') throw fail(409, 'Session has ended');
  const per = num(req.body.per_topic, 30, 1, 80);
  res.json({ started: true, per_topic: per, job: bank.startGeneration(s, per) });
}));

// Broadcast = make the session URL live for everybody who has it
router.post('/sessions/:id/broadcast', wrap(async (req, res) => {
  const s = getSession(req.params.id);
  if (s.status === 'live') throw fail(409, 'Session is already live');
  if (s.status === 'ended') throw fail(409, 'Session has ended');
  const approved = db.get("SELECT COUNT(*) n FROM questions WHERE session_id = ? AND status = 'approved'", [s.id]).n;
  if (!approved && !req.body.force) throw fail(400, 'Generate and approve at least one question first (every question must be reviewed before it goes live)');
  const started = db.now();
  const ends = s.duration_min > 0 ? new Date(Date.now() + s.duration_min * 60000).toISOString() : null;
  db.run("UPDATE sessions SET status = 'live', started_at = ?, ends_at = ? WHERE id = ?", [started, ends, s.id]);
  res.json({ ok: true, join_urls: S.joinUrls(s, req) });
}));

router.post('/sessions/:id/end', wrap(async (req, res) => {
  await S.endSession(getSession(req.params.id), 'session ended by instructor');
  res.json({ ok: true });
}));

router.delete('/sessions/:id', wrap(async (req, res) => {
  const s = getSession(req.params.id);
  if (s.status === 'live') throw fail(409, 'End the session before deleting it');
  const qids = db.all('SELECT id FROM questions WHERE session_id = ?', [s.id]).map((q) => q.id);
  for (const id of qids) {
    db.run('DELETE FROM test_cases WHERE question_id = ?', [id]);
    db.run('DELETE FROM question_versions WHERE question_id = ?', [id]);
  }
  for (const t of ['questions', 'participants', 'submissions', 'violations', 'drafts']) db.run(`DELETE FROM ${t} WHERE session_id = ?`, [s.id]);
  db.run('DELETE FROM sessions WHERE id = ?', [s.id]);
  res.json({ ok: true });
}));

// ============================================================ question & test case review
router.get('/sessions/:id/questions', (req, res) => {
  const rows = db.all(
    `SELECT q.id, q.topic_id, t.name topic, q.slot, q.status, q.theme, q.difficulty, q.template_key, q.text, q.rating, q.version, q.source, q.assigned_to,
       u.name assigned_name, q.validation,
       (SELECT COUNT(*) FROM test_cases c WHERE c.question_id = q.id) tests, (SELECT COUNT(*) FROM test_cases c WHERE c.question_id = q.id AND c.status = 'approved') tests_approved
     FROM questions q JOIN topics t ON t.id = q.topic_id LEFT JOIN users u ON u.id = q.assigned_to WHERE q.session_id = ? ORDER BY t.position, q.slot, q.id`, [req.params.id]);
  res.json(rows.map((r) => ({ ...r, validation: undefined, estimated_difficulty: db.json(r.validation, {}).estimated_difficulty, mutation: db.json(r.validation, {}).mutation || null })));
});

router.get('/questions/:id', wrap(async (req, res) => {
  const q = getQuestion(req.params.id);
  const cut = (e) => { const x = db.json(e, { columns: [], rows: [] }); return { columns: x.columns, rows: x.rows.slice(0, 15), total: x.rows.length }; };
  res.json({
    ...q, concepts: db.json(q.concepts, []), validation: db.json(q.validation, {}), topic: (db.get('SELECT name FROM topics WHERE id = ?', [q.topic_id]) || {}).name,
    test_cases: db.all('SELECT * FROM test_cases WHERE question_id = ? ORDER BY id', [q.id]).map((t) => ({ ...t, expected: cut(t.expected) })),
    versions: db.all('SELECT version, changed_at, changed_by FROM question_versions WHERE question_id = ? ORDER BY id DESC', [q.id]),
  });
}));

router.put('/questions/:id', wrap(async (req, res) => {
  const q = getQuestion(req.params.id);
  if (q.assigned_to && (req.body.text !== undefined || req.body.solution_sql !== undefined || req.body.check_sql !== undefined)) throw fail(409, 'This question is already assigned to a student and can no longer be edited');
  res.json(await bank.updateQuestion(q, req.body, `instructor:${req.user.username}`));
}));

function setStatus(q, status) {
  if (status === 'approved') {
    const tests = db.all("SELECT * FROM test_cases WHERE question_id = ? AND status != 'rejected'", [q.id]);
    if (tests.length < 2 || !tests.some((t) => t.kind === 'visible') || !tests.some((t) => t.kind === 'hidden')) throw fail(400, `Question ${q.id}: needs at least one visible and one hidden test case`);
    db.run("UPDATE test_cases SET status = 'approved' WHERE question_id = ? AND status = 'pending'", [q.id]);
  }
  db.run('UPDATE questions SET status = ?, updated_at = ? WHERE id = ?', [status, db.now(), q.id]);
}

router.post('/questions/:id/:action', (req, res, next) => {
  if (!['approve', 'reject', 'reset'].includes(req.params.action)) return next();
  wrap(async () => {
    setStatus(getQuestion(req.params.id), { approve: 'approved', reject: 'rejected', reset: 'pending' }[req.params.action]);
    res.json({ ok: true });
  })(req, res);
});

router.post('/sessions/:id/questions/bulk', wrap(async (req, res) => {
  const s = getSession(req.params.id);
  const action = req.body.action;
  const rows = Array.isArray(req.body.ids) && req.body.ids.length
    ? req.body.ids.map((id) => db.get('SELECT * FROM questions WHERE id = ? AND session_id = ?', [id, s.id])).filter(Boolean)
    : db.all("SELECT * FROM questions WHERE session_id = ? AND status = 'pending'", [s.id]);
  let done = 0;
  const errors = [];
  for (const q of rows) {
    try {
      if (action === 'delete') {
        if (q.assigned_to) throw new Error(`Question ${q.id} is assigned`);
        db.run('DELETE FROM test_cases WHERE question_id = ?', [q.id]);
        db.run('DELETE FROM questions WHERE id = ?', [q.id]);
      } else setStatus(q, action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'pending');
      done++;
    } catch (e) {
      errors.push(e.message);
    }
  }
  res.json({ done, errors: errors.slice(0, 5) });
}));

router.post('/questions/:id/regenerate', wrap(async (req, res) => res.json(await bank.regenerateQuestion(getQuestion(req.params.id)))));

router.post('/questions/:id/testcases', wrap(async (req, res) => {
  const q = getQuestion(req.params.id);
  res.json(await bank.addTestCase(q, { kind: req.body.kind, data_sql: req.body.data_sql }));
}));

router.patch('/testcases/:id', wrap(async (req, res) => {
  const t = db.get('SELECT * FROM test_cases WHERE id = ?', [req.params.id]);
  if (!t) throw fail(404, 'Test case not found');
  const status = ['pending', 'approved', 'rejected'].includes(req.body.status) ? req.body.status : t.status;
  const kind = ['visible', 'hidden'].includes(req.body.kind) ? req.body.kind : t.kind;
  db.run('UPDATE test_cases SET status = ?, kind = ?, weight = ? WHERE id = ?', [status, kind, num(req.body.weight, t.weight, 0.1, 10), t.id]);
  res.json({ ok: true });
}));

router.delete('/testcases/:id', wrap(async (req, res) => {
  db.run('DELETE FROM test_cases WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

router.post('/sessions/:id/effectiveness', wrap(async (req, res) => res.json(await analytics.runMutationChecks(getSession(req.params.id).id))));

// ============================================================ live monitoring & violation log
router.get('/sessions/:id/monitor', (req, res) => {
  const s = getSession(req.params.id);
  const t = Date.now();
  const rows = db.all(
    `SELECT p.*, u.name, u.username FROM participants p JOIN users u ON u.id = p.user_id WHERE p.session_id = ? ORDER BY u.name`, [s.id]);
  const subs = db.all('SELECT user_id, question_id FROM submissions WHERE session_id = ? GROUP BY user_id, question_id', [s.id]);
  const assigned = db.all('SELECT assigned_to, COUNT(*) n FROM questions WHERE session_id = ? AND assigned_to IS NOT NULL GROUP BY assigned_to', [s.id]);
  const vio = db.all('SELECT user_id, severity, COUNT(*) n, MAX(ts) last FROM violations WHERE session_id = ? GROUP BY user_id, severity', [s.id]);
  const participants = rows.map((p) => {
    const sv = vio.find((v) => v.user_id === p.user_id && v.severity === 'serious');
    const iv = vio.find((v) => v.user_id === p.user_id && v.severity === 'info');
    return {
      user_id: p.user_id, name: p.name, username: p.username, status: p.status, finish_reason: p.finish_reason,
      online: p.status !== 'submitted' && p.last_seen && t - Date.parse(p.last_seen) < 20000, last_seen: p.last_seen,
      answered: subs.filter((x) => x.user_id === p.user_id).length, questions: (assigned.find((a) => a.assigned_to === p.user_id) || { n: 0 }).n,
      violations: sv ? sv.n : 0, notices: iv ? iv.n : 0, last_violation: sv ? sv.last : null,
    };
  });
  const recent = db.all(
    `SELECT v.id, v.type, v.severity, v.detail, v.ts, u.name, u.username FROM violations v JOIN users u ON u.id = v.user_id WHERE v.session_id = ? ORDER BY v.id DESC LIMIT 40`, [s.id]);
  res.json({ status: s.status, mode: s.mode, ends_at: s.ends_at, server_time: db.now(), participants, recent_violations: recent });
});

router.get('/sessions/:id/violations', (req, res) => {
  res.json(db.all(
    `SELECT v.id, v.type, v.severity, v.detail, v.ts, v.user_id, u.name, u.username FROM violations v JOIN users u ON u.id = v.user_id WHERE v.session_id = ? ORDER BY v.id DESC LIMIT 1000`, [req.params.id]));
});

router.post('/sessions/:id/participants/:uid/:action', wrap(async (req, res) => {
  if (!['pause', 'resume', 'submit'].includes(req.params.action)) throw fail(404, 'Unknown action');
  const s = getSession(req.params.id);
  const uid = +req.params.uid;
  const p = db.get('SELECT * FROM participants WHERE session_id = ? AND user_id = ?', [s.id, uid]);
  if (!p) throw fail(404, 'Participant not found');
  const a = req.params.action;
  if (a === 'pause') db.run("UPDATE participants SET status = 'paused' WHERE id = ? AND status = 'active'", [p.id]);
  else if (a === 'resume') {
    if (p.status === 'submitted') throw fail(409, 'This student has already submitted');
    db.run("UPDATE participants SET status = 'active', violation_baseline = ? WHERE id = ?", [S.violationCount(s.id, uid), p.id]);
  } else await S.finalizeParticipant(s, uid, 'submitted by instructor');
  res.json({ ok: true });
}));

// ============================================================ submissions & dual evaluation
router.get('/sessions/:id/submissions', (req, res) => {
  const rows = db.all(
    `SELECT s.id, s.user_id, u.name, u.username, t.name topic, q.slot, s.question_id, s.attempt_no, s.ai_score, s.teacher_score, s.final_score, s.flagged, s.flag_reason,
       s.error_category, s.auto, s.created_at, s.passed, s.total
     FROM submissions s JOIN users u ON u.id = s.user_id JOIN questions q ON q.id = s.question_id JOIN topics t ON t.id = q.topic_id
     WHERE s.session_id = ? ORDER BY s.id DESC`, [req.params.id]);
  res.json(rows);
});

router.get('/submissions/:id', wrap(async (req, res) => {
  const s = db.get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
  if (!s) throw fail(404, 'Submission not found');
  const q = getQuestion(s.question_id);
  const u = db.get('SELECT name, username FROM users WHERE id = ?', [s.user_id]);
  res.json({ ...s, results: db.json(s.results, []), feedback: db.json(s.feedback, {}), student: u, question: { id: q.id, text: q.text, solution_sql: q.solution_sql, template_key: q.template_key, qtype: q.qtype } });
}));

router.put('/submissions/:id/review', wrap(async (req, res) => {
  const s = db.get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
  if (!s) throw fail(404, 'Submission not found');
  const raw = req.body.teacher_score;
  if (raw === null || raw === '') db.run('UPDATE submissions SET teacher_score = NULL, final_score = ai_score, teacher_comment = ?, reviewed_at = NULL WHERE id = ?', [req.body.comment || null, s.id]);
  else {
    const score = num(raw, NaN, 0, 100);
    if (isNaN(score)) throw fail(400, 'Score must be between 0 and 100');
    db.run('UPDATE submissions SET teacher_score = ?, final_score = ?, teacher_comment = ?, reviewed_at = ? WHERE id = ?', [score, score, String(req.body.comment || '').slice(0, 1000), db.now(), s.id]);
  }
  res.json({ ok: true });
}));

// ============================================================ analytics
router.get('/sessions/:id/analytics', (req, res) => res.json({ ...analytics.sessionAnalytics(getSession(req.params.id).id), metrics: analytics.metrics(+req.params.id) }));
router.get('/analytics/overview', (req, res) => res.json({ metrics: analytics.metrics(null) }));

router.get('/sessions/:id/export.csv', (req, res) => {
  const s = getSession(req.params.id);
  const a = analytics.sessionAnalytics(s.id);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['username', 'name', 'status', 'questions', 'answered', 'score_percent', 'lockdown_violations', 'flagged_unreviewed'].join(',')];
  a.students.forEach((x) => lines.push([x.username, x.name, x.status, x.questions, x.answered, x.score, x.violations, x.flagged].map(esc).join(',')));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="scores_${s.token}.csv"`);
  res.send(lines.join('\n'));
});

module.exports = router;
