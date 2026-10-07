'use strict';
// End-to-end smoke test: instructor + students + class / assessment sessions through the real HTTP API.
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmslab-'));
process.env.SEED_DEMO_STUDENTS = 'false';
process.env.HIDDEN_TESTCASES = '2';

const { start } = require('../server');
let base;
let pass = 0;
const ok = (c, m) => {
  if (!c) throw new Error('FAILED: ' + m);
  pass++;
  console.log('  ok -', m);
};
async function api(method, url, body, token, headers = {}) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) { const e = new Error(`${method} ${url} -> ${r.status} ${t.slice(0, 200)}`); e.status = r.status; e.body = j; throw e; }
  return j;
}
const login = async (u, p) => (await api('POST', '/api/auth/login', { username: u, password: p })).token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = await start(0);
  base = `http://127.0.0.1:${server.address().port}`;
  console.log('Server on', base);

  console.log('\n[1] Auth');
  const I = await login('instructor', 'instructor123');
  ok(I, 'instructor login');
  try { await api('POST', '/api/auth/register', { username: 'newkid', name: 'New Kid', password: 'pw1234' }); ok(false, 'registration without session'); } catch (e) { ok(e.status === 400, 'students cannot register without a session link'); }
  try { await api('POST', '/api/students', { username: 'x1234', name: 'X', password: 'pw1234' }, I); ok(false, 'teacher add'); } catch (e) { ok(e.status === 404, 'instructor cannot add students (no such endpoint)'); }
  ok((await api('GET', '/api/students/count', null, I)).count === 0, 'instructor sees only the student count (0 so far)');

  console.log('\n[2] Syllabus');
  const text = fs.readFileSync(path.join(__dirname, '../samples/syllabus_dbms.txt'), 'utf8');
  const syl = await api('POST', '/api/syllabi', { title: 'Sample', text }, I);
  ok(syl.topics.length >= 14, `syllabus parsed into ${syl.topics.length} topics`);
  const free = await api('POST', '/api/syllabi', { title: 'Free', text: fs.readFileSync(path.join(__dirname, '../samples/syllabus_freetext.txt'), 'utf8') }, I);
  ok(free.topics.length === 4 && free.topics[3].concepts.includes('EXISTS'), 'free-text syllabus parsed');

  console.log('\n[3] Assessment session: generate -> review -> broadcast');
  const topicIds = syl.topics.map((t) => t.id);
  const { id: sid } = await api('POST', '/api/sessions', { title: 'Smoke assessment', syllabus_id: syl.id, topic_ids: topicIds, mode: 'assessment', pause_after: 2, submit_after: 6, slots_per_topic: 1 }, I);
  let sess = await api('GET', `/api/sessions/${sid}`, null, I);
  ok(sess.mode === 'assessment' && sess.lockdown && sess.status === 'draft', 'assessment session created (lockdown on)');
  ok(/\/s\/[a-z0-9]{6,}/.test(sess.join_urls[0]) && sess.qr.startsWith('data:image/png'), 'unique join URL + QR generated: ' + sess.join_urls[0]);
  const token = sess.join_urls[0].split('/s/')[1];
  const pub = await api('GET', `/api/public/session/${token}`);
  ok(pub.status === 'draft' && pub.lockdown, 'public session info works without login');
  try { await api('POST', '/api/auth/register', { username: 'early', name: 'Early Bird', password: 'pw1234', session: token }); ok(false, 'register before broadcast'); } catch (e) { ok(e.status === 409, 'registration is closed until the session is broadcast'); }

  await api('POST', `/api/sessions/${sid}/generate`, { per_topic: 4 }, I);
  for (let i = 0; i < 120; i++) {
    sess = await api('GET', `/api/sessions/${sid}`, null, I);
    if (!sess.generation.running) break;
    await sleep(500);
  }
  ok(!sess.generation.running && sess.generation.done === syl.topics.length * 4, `question bank generated (${sess.generation.done} variants, errors: ${sess.generation.errors.length})`);
  const qs = await api('GET', `/api/sessions/${sid}/questions`, null, I);
  ok(new Set(qs.map((q) => q.text)).size === qs.length, 'all question texts unique');
  ok(qs.every((q) => q.status === 'pending'), 'everything starts as pending (needs teacher review)');
  try { await api('POST', `/api/sessions/${sid}/broadcast`, {}, I); ok(false, 'broadcast blocked w/o approval'); } catch (e) { ok(e.status === 400, 'cannot broadcast before approving questions'); }
  const detail = await api('GET', `/api/questions/${qs[0].id}`, null, I);
  ok(detail.test_cases.length === 4 && detail.test_cases.filter((t) => t.kind === 'hidden').length === 2, 'each question has visible + hidden test cases');
  // instructor edits one question (versioning) and adds a hidden test case
  const edited = await api('PUT', `/api/questions/${qs[0].id}`, { text: detail.text + ' (Reviewed.)', rating: 5 }, I);
  ok(edited.version === 2, 'question edit creates a new version');
  const tc = await api('POST', `/api/questions/${qs[0].id}/testcases`, { kind: 'hidden' }, I);
  ok(tc.id, 'extra AI test case generated');
  await api('POST', `/api/sessions/${sid}/questions/bulk`, { action: 'approve' }, I);
  const approved = await api('GET', `/api/sessions/${sid}/questions`, null, I);
  ok(approved.every((q) => q.status === 'approved'), 'instructor approved the bank');
  await api('POST', `/api/sessions/${sid}/broadcast`, {}, I);
  ok((await api('GET', `/api/public/session/${token}`)).status === 'live', 'session broadcast -> live');

  console.log('\n[4] Students take the assessment');
  const reg = async (u, n) => (await api('POST', '/api/auth/register', { username: u, name: n, password: 'pw1234', session: token })).token;
  const S1 = await reg('student01', 'Asha Rao');
  const S2 = await reg('student02', 'Bharath K');
  const S3 = await reg('student03', 'Chitra S');
  try { await api('GET', '/api/students/count', null, S1); ok(false, 'rbac'); } catch (e) { ok(e.status === 403, 'students cannot call instructor API (RBAC)'); }
  try { await api('POST', '/api/auth/register', { username: 'student01', name: 'Dup', password: 'pw1234', session: token }); ok(false, 'dup'); } catch (e) { ok(e.status === 409, 'duplicate roll number rejected'); }
  ok((await login('student01', 'pw1234')), 'registered student can log in again');
  ok((await api('GET', '/api/students/count', null, I)).count === 3, 'instructor count shows 3 registered students');
  const j1 = await api('POST', `/api/play/${token}/join`, {}, S1);
  const j2 = await api('POST', `/api/play/${token}/join`, {}, S2);
  await api('POST', `/api/play/${token}/join`, {}, S3);
  ok(j1.questions.length === syl.topics.length, `student gets one question per topic (${j1.questions.length})`);
  const t1 = new Set(j1.questions.map((q) => q.text));
  ok(j2.questions.every((q) => !t1.has(q.text)), 'two students never get the same question');
  ok(JSON.stringify(j1.questions).indexOf('solution') === -1, 'solution is not leaked to the student');

  // correct answers for student 1 (using the reference solutions through the instructor API)
  const allQ = await api('GET', `/api/sessions/${sid}/questions`, null, I);
  const mine1 = allQ.filter((q) => q.assigned_name === 'Asha Rao');
  ok(mine1.length === j1.questions.length, 'instructor sees assignments');
  const q0 = j1.questions[0];
  const sch = await api('GET', `/api/play/${token}/questions/${q0.id}/schema`, null, S1);
  ok(sch.tables.length >= 2 && sch.tables[0].rows.length > 0, 'per-student isolated DB with sample data');
  const ref0 = (await api('GET', `/api/questions/${q0.id}`, null, I)).solution_sql;
  const run = await api('POST', `/api/play/${token}/run`, { question_id: q0.id, sql: ref0 }, S1);
  ok(run.result && !run.error, 'Run executes in sandbox');
  ok(run.tests && run.tests.total >= 1 && run.tests.passed === run.tests.total && run.tests.results.every((t) => t.status === 'pass'), `Run also checks sample test cases: ${run.tests.passed}/${run.tests.total} successful`);
  const wrongRun = await api('POST', `/api/play/${token}/run`, { question_id: q0.id, sql: 'SELECT 1' }, S1);
  ok(wrongRun.tests.passed === 0 && wrongRun.tests.results.every((t) => t.status !== 'pass'), 'wrong query: sample test cases reported as failed');
  const bad = await api('POST', `/api/play/${token}/run`, { question_id: q0.id, sql: 'SELEC oops' }, S1);
  ok(bad.error, 'syntax error is reported to student');
  const loop = await api('POST', `/api/play/${token}/run`, { question_id: q0.id, sql: 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT COUNT(*) FROM r' }, S1);
  ok(/timed out/.test(loop.error || ''), 'infinite query is killed by timeout');

  let total = 0;
  for (const q of j1.questions) {
    const sol = (await api('GET', `/api/questions/${q.id}`, null, I)).solution_sql;
    const r = await api('POST', `/api/play/${token}/submit`, { question_id: q.id, sql: sol }, S1);
    ok(r.accepted && r.score === undefined && r.total >= 3 && r.passed === r.total && r.results.every((t) => t.status === 'pass' && !t.expected), `assessment shows test cases successful but hides score/data until finish (${q.topic})`);
    total++;
  }
  try { await api('POST', `/api/play/${token}/submit`, { question_id: q0.id, sql: ref0 }, S1); ok(false, 'second attempt blocked'); } catch (e) { ok(e.body.code === 'NO_ATTEMPTS', 'attempt limit enforced (1 attempt)'); }
  try { await api('GET', `/api/play/${token}/results`, null, S1); ok(false, 'locked'); } catch (e) { ok(e.body.code === 'RESULTS_LOCKED', 'results locked until the student finishes'); }
  await api('POST', `/api/play/${token}/finish`, {}, S1);
  const res1 = await api('GET', `/api/play/${token}/results`, null, S1);
  ok(res1.total === 100, `reference solutions score 100% on all ${total} questions (got ${res1.total})`);
  ok(res1.items.every((i) => i.results.filter((r) => r.kind === 'hidden').every((r) => !r.expected && !r.actual)), 'hidden test data never revealed');

  // student 2: wrong answers + semantically-equivalent answer + lockdown violations
  const [a, b] = j2.questions;
  const refA = (await api('GET', `/api/questions/${a.id}`, null, I)).solution_sql;
  await api('POST', `/api/play/${token}/submit`, { question_id: a.id, sql: 'SELECT 1' }, S2);
  const v1 = await api('POST', `/api/play/${token}/violation`, { type: 'tab_switch', detail: 'hidden tab' }, S2);
  ok(v1.action === 'warn' && v1.count === 1, 'violation 1 -> warning');
  const v2 = await api('POST', `/api/play/${token}/violation`, { type: 'fullscreen_exit' }, S2);
  ok(v2.action === 'pause', 'violation 2 -> auto-pause (policy)');
  try { await api('POST', `/api/play/${token}/run`, { question_id: a.id, sql: refA }, S2); ok(false, 'paused blocked'); } catch (e) { ok(e.body.code === 'PAUSED', 'paused student cannot work'); }
  const mon = await api('GET', `/api/sessions/${sid}/monitor`, null, I);
  const m2 = mon.participants.find((p) => p.username === 'student02');
  ok(m2.status === 'paused' && m2.violations === 2, 'instructor monitor shows paused student + violations');
  await api('POST', `/api/sessions/${sid}/participants/${m2.user_id}/resume`, {}, I);
  const info = await api('POST', `/api/play/${token}/violation`, { type: 'blocked_shortcut', detail: 'Ctrl+T' }, S2);
  ok(info.severity === 'info', 'minor events are logged without counting');
  await api('POST', `/api/play/${token}/violation`, { type: 'external_paste' }, S2);
  const v4 = await api('POST', `/api/play/${token}/violation`, { type: 'window_blur' }, S2);
  ok(v4.action === 'pause', 'after resume the pause threshold restarts');
  await api('POST', `/api/sessions/${sid}/participants/${m2.user_id}/resume`, {}, I);
  // a saved draft is auto-graded when the test is force-submitted
  await api('PUT', `/api/play/${token}/draft`, { question_id: b.id, sql: (await api('GET', `/api/questions/${b.id}`, null, I)).solution_sql }, S2);
  await api('POST', `/api/play/${token}/violation`, { type: 'tab_switch' }, S2);
  const v6 = await api('POST', `/api/play/${token}/violation`, { type: 'tab_switch' }, S2);
  ok(v6.action === 'submit', 'repeated violations -> auto-submit (policy)');
  const vs = await api('GET', `/api/sessions/${sid}/violations`, null, I);
  ok(vs.length >= 6 && vs[0].ts, 'violation log has timestamps');
  const st2 = await api('GET', `/api/play/${token}/state`, null, S2);
  ok(st2.participant.status === 'submitted', 'student 2 test closed by policy');

  console.log('\n[5] Instructor: review, analytics, metrics');
  const subs = await api('GET', `/api/sessions/${sid}/submissions`, null, I);
  ok(subs.length >= total + 1, `${subs.length} submissions recorded`);
  ok(subs.some((x) => x.auto === 1 && x.question_id === b.id), 'unsaved draft graded automatically on forced submit');
  const flagged = subs.filter((s) => s.flagged);
  ok(flagged.length >= 1, `${flagged.length} submission(s) flagged for teacher review`);
  const sub = await api('GET', `/api/submissions/${subs.find((s) => s.ai_score < 100).id}`, null, I);
  ok(sub.feedback.summary && sub.results.length, 'AI feedback + per-test results stored');
  await api('PUT', `/api/submissions/${sub.id}/review`, { teacher_score: 50, comment: 'Partial credit' }, I);
  const eff = await api('POST', `/api/sessions/${sid}/effectiveness`, {}, I);
  ok(eff.length > 0 && eff.some((e) => e.valid > 0), `mutation test ran on ${eff.length} questions, kill rate ${Math.round(eff.reduce((a2, e) => a2 + (e.killed || 0), 0) / Math.max(1, eff.reduce((a2, e) => a2 + (e.valid || 0), 0)) * 100)}%`);
  const an = await api('GET', `/api/sessions/${sid}/analytics`, null, I);
  ok(an.totals.participants === 3 && an.metrics.evaluation_time.reduction_pct > 0, 'analytics + evaluation-time metric');
  ok(an.metrics.grading_accuracy.reviewed >= 1 && an.metrics.test_case_effectiveness.mutation_kill_pct !== null, 'grading-accuracy + test-case-effectiveness metrics');
  const csv = await fetch(`${base}/api/sessions/${sid}/export.csv?token=${I}`).then((r) => r.text());
  ok(csv.includes('student01'), 'CSV export');
  await api('POST', `/api/sessions/${sid}/end`, {}, I);
  const st3 = await api('GET', `/api/play/${token}/results`, null, S2).catch((e) => e.body);
  ok(st3.total !== undefined, 'after the session ends, remaining students are auto-submitted and see results');
  ok((await api('GET', `/api/public/session/${token}`)).status === 'ended', 'session ended');

  console.log('\n[6] Normal class session (no lockdown)');
  const { id: cid } = await api('POST', '/api/sessions', { title: 'Class', syllabus_id: free.id, mode: 'class' }, I);
  const cs = await api('GET', `/api/sessions/${cid}`, null, I);
  ok(cs.mode === 'class' && !cs.lockdown && cs.max_attempts === 0 && cs.show_results === 'immediate', 'class mode defaults: no lockdown, unlimited attempts, immediate feedback');
  const ctoken = cs.join_urls[0].split('/s/')[1];
  await api('POST', `/api/sessions/${cid}/generate`, { per_topic: 3 }, I);
  for (let i = 0; i < 120; i++) { if (!(await api('GET', `/api/sessions/${cid}`, null, I)).generation.running) break; await sleep(400); }
  await api('POST', `/api/sessions/${cid}/questions/bulk`, { action: 'approve' }, I);
  await api('POST', `/api/sessions/${cid}/broadcast`, {}, I);
  const cj = await api('POST', `/api/play/${ctoken}/join`, {}, S1);
  ok(cj.questions.length === 4, 'class: topics -> questions');
  const cq = cj.questions[0];
  const wrong = await api('POST', `/api/play/${ctoken}/submit`, { question_id: cq.id, sql: 'SELECT 1' }, S1);
  ok(wrong.score < 100 && wrong.feedback.summary && wrong.results.length, 'class: immediate score + feedback');
  const right = await api('POST', `/api/play/${ctoken}/submit`, { question_id: cq.id, sql: (await api('GET', `/api/questions/${cq.id}`, null, I)).solution_sql }, S1);
  ok(right.score === 100, 'class: unlimited attempts, correct answer scores 100');
  const cv = await api('POST', `/api/play/${ctoken}/violation`, { type: 'tab_switch' }, S1);
  ok(cv.action === 'ignored', 'class: no lockdown / violations ignored');

  console.log(`\nAll ${pass} checks passed.`);
  server.close();
  process.exit(0);
})().catch((e) => {
  console.error('\n' + e.stack);
  process.exit(1);
});
