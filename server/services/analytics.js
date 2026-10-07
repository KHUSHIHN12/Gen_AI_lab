'use strict';
// Dashboard & Analytics API: scores, common errors, violations and the four performance-evaluation metrics of the synopsis.
const db = require('../db');
const config = require('../config');
const { mutationTest } = require('./evaluator');

const round = (n, d = 1) => (n === null || n === undefined || isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};

// best final score per (user, question)
function bestScores(rows) {
  const best = new Map();
  for (const r of rows) {
    const k = `${r.user_id}:${r.question_id}`;
    if (!best.has(k) || r.final_score > best.get(k).final_score) best.set(k, r);
  }
  return best;
}

function studentTable(sessionId) {
  const parts = db.all(
    `SELECT p.*, u.name, u.username FROM participants p JOIN users u ON u.id = p.user_id WHERE p.session_id = ? ORDER BY u.name`, [sessionId]);
  const qs = db.all('SELECT id, assigned_to, topic_id FROM questions WHERE session_id = ? AND assigned_to IS NOT NULL', [sessionId]);
  const subs = db.all('SELECT * FROM submissions WHERE session_id = ?', [sessionId]);
  const best = bestScores(subs);
  const vio = db.all("SELECT user_id, COUNT(*) n FROM violations WHERE session_id = ? AND severity = 'serious' GROUP BY user_id", [sessionId]);
  return parts.map((p) => {
    const mine = qs.filter((q) => q.assigned_to === p.user_id);
    const scores = mine.map((q) => (best.has(`${p.user_id}:${q.id}`) ? best.get(`${p.user_id}:${q.id}`).final_score : 0));
    const answered = mine.filter((q) => best.has(`${p.user_id}:${q.id}`)).length;
    return {
      user_id: p.user_id, name: p.name, username: p.username, status: p.status, questions: mine.length, answered,
      score: round(mean(scores) ?? 0), violations: (vio.find((v) => v.user_id === p.user_id) || { n: 0 }).n,
      flagged: subs.filter((s) => s.user_id === p.user_id && s.flagged && s.teacher_score === null).length,
    };
  });
}

function sessionAnalytics(sessionId) {
  const session = db.get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
  const subs = db.all(
    `SELECT s.*, q.topic_id, q.template_key, t.name topic_name FROM submissions s JOIN questions q ON q.id = s.question_id
     JOIN topics t ON t.id = q.topic_id WHERE s.session_id = ?`, [sessionId]);
  const best = [...bestScores(subs).values()];
  const students = studentTable(sessionId);
  const dist = [0, 0, 0, 0, 0];
  students.forEach((s) => dist[Math.min(4, Math.floor(s.score / 20))]++);
  const topics = {};
  best.forEach((b) => {
    topics[b.topic_name] = topics[b.topic_name] || { topic: b.topic_name, scores: [] };
    topics[b.topic_name].scores.push(b.final_score);
  });
  const errors = {};
  subs.filter((s) => s.error_category && s.error_category !== 'passed').forEach((s) => (errors[s.error_category] = (errors[s.error_category] || 0) + 1));
  const vio = db.all('SELECT type, COUNT(*) n FROM violations WHERE session_id = ? GROUP BY type ORDER BY n DESC', [sessionId]);
  return {
    session: { id: session.id, title: session.title, mode: session.mode, status: session.status },
    totals: {
      participants: students.length, submissions: subs.length, average_score: round(mean(students.map((s) => s.score))),
      flagged_pending: subs.filter((s) => s.flagged && s.teacher_score === null).length, reviewed: subs.filter((s) => s.teacher_score !== null).length,
      violations: db.get('SELECT COUNT(*) n FROM violations WHERE session_id = ?', [sessionId]).n,
      perfect: students.filter((s) => s.score === 100).length,
    },
    score_distribution: ['0-19', '20-39', '40-59', '60-79', '80-100'].map((label, i) => ({ label, count: dist[i] })),
    topic_scores: Object.values(topics).map((t) => ({ topic: t.topic, average: round(mean(t.scores)), attempts: t.scores.length })),
    common_errors: Object.entries(errors).sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count })),
    violation_types: vio,
    students,
  };
}

// ----- Performance evaluation metrics (synopsis section 4) ---------------------------------------------------------
function metrics(sessionId) {
  const where = sessionId ? 'WHERE s.session_id = ?' : '';
  const args = sessionId ? [sessionId] : [];
  const subs = db.all(`SELECT s.* FROM submissions s ${where}`, args);

  // 1. SQL grading accuracy: AI vs teacher
  const reviewed = subs.filter((s) => s.teacher_score !== null);
  const diffs = reviewed.map((s) => Math.abs(s.ai_score - s.teacher_score));
  const agree = reviewed.filter((s) => Math.abs(s.ai_score - s.teacher_score) <= 10).length;
  const verdictAgree = reviewed.filter((s) => (s.ai_score >= 100) === (s.teacher_score >= 100)).length;
  const grading = {
    reviewed: reviewed.length,
    agreement_pct: reviewed.length ? round((agree / reviewed.length) * 100) : null,
    verdict_agreement_pct: reviewed.length ? round((verdictAgree / reviewed.length) * 100) : null,
    mean_abs_difference: round(mean(diffs)),
    note: reviewed.length ? 'Share of reviewed submissions where |AI score - teacher score| <= 10 points.' : 'Review (override or confirm) some submissions to measure grading accuracy.',
  };

  // 2. Test-case effectiveness: share of incorrect queries detected by the tests
  const incorrect = reviewed.filter((s) => s.teacher_score < 100);
  const detected = incorrect.filter((s) => s.ai_score < 100).length;
  const qWhere = sessionId ? 'WHERE session_id = ?' : '';
  const mut = db.all(`SELECT id, validation FROM questions ${qWhere ? qWhere + " AND status = 'approved'" : "WHERE status = 'approved'"}`, args);
  const cached = mut.map((q) => db.json(q.validation, {}).mutation).filter(Boolean);
  const kills = cached.reduce((a, m) => a + m.killed, 0);
  const valid = cached.reduce((a, m) => a + m.valid, 0);
  const effectiveness = {
    teacher_marked_incorrect: incorrect.length,
    detected_by_tests: detected,
    detection_pct: incorrect.length ? round((detected / incorrect.length) * 100) : null,
    mutation_questions_tested: cached.length,
    mutation_kill_pct: valid ? round((kills / valid) * 100) : null,
    note: 'Detection % uses teacher-confirmed wrong answers; mutation score injects typical mistakes (>= vs >, JOIN type, ASC/DESC...) into each reference query and counts how many the tests catch (run "Test-case effectiveness check").',
  };

  // 3. Question equivalence / fairness
  const qs = db.all(
    `SELECT q.*, t.name topic_name FROM questions q JOIN topics t ON t.id = q.topic_id ${sessionId ? 'WHERE q.session_id = ?' : ''}`, args);
  const groups = {};
  qs.filter((q) => q.status !== 'rejected').forEach((q) => {
    const k = `${q.topic_name} / slot ${q.slot + 1}`;
    (groups[k] = groups[k] || []).push(q);
  });
  const best = bestScores(subs);
  const fairness = Object.entries(groups).map(([k, list]) => {
    const ratings = list.filter((q) => q.rating).map((q) => q.rating);
    const comp = list.map((q) => db.json(q.validation, {}).complexity).filter((x) => typeof x === 'number');
    const sc = list.map((q) => (q.assigned_to && best.has(`${q.assigned_to}:${q.id}`) ? best.get(`${q.assigned_to}:${q.id}`).final_score : null)).filter((x) => x !== null);
    return {
      group: k, variants: list.length, distinct_texts: new Set(list.map((q) => q.text)).size, teacher_rating: round(mean(ratings)), rated: ratings.length,
      complexity_spread: comp.length ? round(Math.max(...comp) - Math.min(...comp), 2) : 0, score_std: round(std(sc)),
      same_template: new Set(list.map((q) => q.template_key)).size === 1,
    };
  });
  const allRatings = qs.filter((q) => q.rating).map((q) => q.rating);

  // 4. Evaluation time reduction
  const n = subs.length;
  const autoMin = subs.reduce((a, s) => a + s.eval_ms, 0) / 60000;
  const reviewMin = reviewed.length * config.reviewMinutes;
  const manualMin = n * config.manualEvalMinutes;
  const time = {
    submissions: n, manual_minutes_estimate: round(manualMin), automatic_minutes: round(autoMin, 2), teacher_review_minutes: round(reviewMin),
    reduction_pct: manualMin ? round((1 - (autoMin + reviewMin) / manualMin) * 100) : null,
    avg_eval_ms: round(mean(subs.map((s) => s.eval_ms)), 0),
    note: `Manual marking assumed ${config.manualEvalMinutes} min/submission and teacher review ${config.reviewMinutes} min/reviewed submission (configurable).`,
  };

  return {
    grading_accuracy: grading, test_case_effectiveness: effectiveness,
    question_fairness: { mean_rating: round(mean(allRatings)), rated: allRatings.length, groups: fairness },
    evaluation_time: time,
  };
}

async function runMutationChecks(sessionId) {
  const qs = db.all("SELECT * FROM questions WHERE session_id = ? AND status = 'approved'", [sessionId]);
  const out = [];
  for (const q of qs) {
    const m = await mutationTest(q);
    const v = db.json(q.validation, {});
    v.mutation = { mutants: m.mutants, valid: m.valid, killed: m.killed, rate: m.rate, survivors: m.survivors, at: db.now() };
    db.run('UPDATE questions SET validation = ? WHERE id = ?', [JSON.stringify(v), q.id]);
    out.push({ question_id: q.id, ...v.mutation });
  }
  return out;
}

module.exports = { sessionAnalytics, metrics, studentTable, runMutationChecks, bestScores, round };
