'use strict';
// Session lifecycle, Lockdown Monitoring Service (violation policy) and answer submission.
const os = require('os');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { evaluate, flagFor } = require('./evaluator');

const SERIOUS = new Set(['fullscreen_exit', 'tab_switch', 'window_blur', 'external_paste', 'devtools', 'navigation_attempt', 'not_secure_browser', 'drop_attempt', 'multiple_displays']);
const severityOf = (type) => (SERIOUS.has(type) ? 'serious' : 'info');

function newToken() {
  for (;;) {
    const t = crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, '').toLowerCase().slice(0, 7);
    if (t.length >= 6 && !db.get('SELECT id FROM sessions WHERE token = ?', [t])) return t;
  }
}

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}
function joinUrls(session, req) {
  const path = `/s/${session.token}`;
  const urls = [];
  if (config.publicBaseUrl) urls.push(config.publicBaseUrl + path);
  else {
    for (const ip of lanIps()) urls.push(`http://${ip}:${config.port}${path}`);
    // when the instructor opens the dashboard through a real host name, use that too
    const host = req && req.headers.host;
    if (host && !/^(localhost|127\.|\[::1\])/.test(host)) urls.unshift(`${req.protocol}://${host}${path}`);
  }
  urls.push(`http://localhost:${config.port}${path}`);
  return [...new Set(urls)];
}

const policyOf = (s) => ({ pause_after: 0, submit_after: 0, ...db.json(s.policy, {}) });

function violationCount(sessionId, userId) {
  return db.get("SELECT COUNT(*) n FROM violations WHERE session_id = ? AND user_id = ? AND severity = 'serious'", [sessionId, userId]).n;
}

function recordViolation(session, userId, type, detail) {
  const severity = severityOf(type);
  db.run('INSERT INTO violations(session_id, user_id, type, severity, detail, ts) VALUES(?,?,?,?,?,?)', [session.id, userId, type, severity, String(detail || '').slice(0, 300), db.now()]);
  const part = db.get('SELECT * FROM participants WHERE session_id = ? AND user_id = ?', [session.id, userId]);
  const count = violationCount(session.id, userId);
  let action = 'logged';
  if (severity === 'serious' && part && part.status === 'active') {
    const pol = policyOf(session);
    if (pol.submit_after > 0 && count >= pol.submit_after) {
      action = 'submit';
      finalizeParticipant(session, userId, 'auto-submitted: repeated lockdown violations').catch(() => {});
    } else if (pol.pause_after > 0 && count - part.violation_baseline >= pol.pause_after) {
      action = 'pause';
      db.run("UPDATE participants SET status = 'paused' WHERE id = ?", [part.id]);
    } else action = 'warn';
  }
  return { action, count, severity };
}

// Submit everything the student has not answered yet (from saved drafts) and close their test.
async function finalizeParticipant(session, userId, reason) {
  const part = db.get('SELECT * FROM participants WHERE session_id = ? AND user_id = ?', [session.id, userId]);
  if (!part || part.status === 'submitted') return;
  db.run("UPDATE participants SET status = 'submitted', finished_at = ?, finish_reason = ? WHERE id = ?", [db.now(), reason || 'submitted by student', part.id]);
  const questions = db.all('SELECT * FROM questions WHERE session_id = ? AND assigned_to = ?', [session.id, userId]);
  for (const q of questions) {
    const has = db.get('SELECT id FROM submissions WHERE session_id = ? AND user_id = ? AND question_id = ?', [session.id, userId, q.id]);
    if (has) continue;
    const d = db.get('SELECT sql_text FROM drafts WHERE session_id = ? AND user_id = ? AND question_id = ?', [session.id, userId, q.id]);
    if (d && d.sql_text.trim()) {
      try {
        await storeSubmission(session, userId, q, d.sql_text, true);
      } catch {
        /* question without approved tests - nothing to grade */
      }
    }
  }
}

async function storeSubmission(session, userId, question, sqlText, auto = false) {
  const ev = await evaluate({ ...question, concepts: db.json(question.concepts, []) }, sqlText);
  const attempt = db.get('SELECT COUNT(*) n FROM submissions WHERE session_id = ? AND user_id = ? AND question_id = ?', [session.id, userId, question.id]).n + 1;
  const flag = flagFor({ score: ev.score, category: ev.category, results: ev.results, violations: violationCount(session.id, userId) });
  const id = db.run(
    `INSERT INTO submissions(session_id, question_id, user_id, sql_text, passed, total, ai_score, flagged, flag_reason, final_score, error_category, eval_ms,
       attempt_no, results, feedback, auto, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [session.id, question.id, userId, sqlText, ev.passed, ev.total, ev.score, flag.flagged, flag.reason, ev.score, ev.category, ev.eval_ms, attempt, JSON.stringify(ev.results), JSON.stringify(ev.feedback), auto ? 1 : 0, db.now()]
  ).lastId;
  return { id, ...ev, attempt, flagged: flag.flagged };
}

async function endSession(session, reason) {
  if (session.status === 'ended') return;
  db.run("UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?", [db.now(), session.id]);
  const parts = db.all("SELECT user_id FROM participants WHERE session_id = ? AND status != 'submitted'", [session.id]);
  for (const p of parts) await finalizeParticipant(session, p.user_id, reason || 'session ended by instructor');
}

let ticker = null;
function startTicker() {
  if (ticker) return;
  ticker = setInterval(async () => {
    try {
      const due = db.all("SELECT * FROM sessions WHERE status = 'live' AND ends_at IS NOT NULL AND ends_at < ?", [db.now()]);
      for (const s of due) await endSession(s, 'time is up');
    } catch (e) {
      console.error('ticker', e.message);
    }
  }, 5000);
  ticker.unref();
}

module.exports = { newToken, joinUrls, policyOf, violationCount, recordViolation, finalizeParticipant, storeSubmission, endSession, startTicker, severityOf };
