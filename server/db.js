'use strict';
// Application database (users, syllabi, topics, sessions, question bank, test cases, submissions, logs).
// Uses sql.js (SQLite compiled to WebAssembly) so the project runs with zero native dependencies.
// The database lives in memory and is flushed to data/app.sqlite shortly after every write.
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const config = require('./config');

const DB_FILE = path.join(config.dataDir, 'app.sqlite');
let SQL = null;
let db = null;
let timer = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS syllabi(
  id INTEGER PRIMARY KEY AUTOINCREMENT, instructor_id INTEGER NOT NULL, title TEXT NOT NULL,
  raw_text TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS topics(
  id INTEGER PRIMARY KEY AUTOINCREMENT, syllabus_id INTEGER NOT NULL, name TEXT NOT NULL,
  concepts TEXT NOT NULL DEFAULT '[]', objectives TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL DEFAULT 'medium', position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, instructor_id INTEGER NOT NULL, syllabus_id INTEGER NOT NULL,
  title TEXT NOT NULL, mode TEXT NOT NULL, token TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  duration_min INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 0,
  show_results TEXT NOT NULL DEFAULT 'immediate', policy TEXT NOT NULL DEFAULT '{}',
  topic_ids TEXT NOT NULL DEFAULT '[]', slots_per_topic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, ends_at TEXT);
CREATE TABLE IF NOT EXISTS questions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, topic_id INTEGER NOT NULL,
  slot INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'pending',
  qtype TEXT NOT NULL DEFAULT 'query', text TEXT NOT NULL, schema_sql TEXT NOT NULL, solution_sql TEXT NOT NULL,
  check_sql TEXT, ordered INTEGER NOT NULL DEFAULT 0, template_key TEXT, theme TEXT, difficulty TEXT,
  concepts TEXT NOT NULL DEFAULT '[]', seed INTEGER, source TEXT, assigned_to INTEGER, assigned_at TEXT,
  rating INTEGER, validation TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS question_versions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER NOT NULL, version INTEGER NOT NULL,
  snapshot TEXT NOT NULL, changed_at TEXT NOT NULL, changed_by TEXT);
CREATE TABLE IF NOT EXISTS test_cases(
  id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER NOT NULL, kind TEXT NOT NULL,
  data_sql TEXT NOT NULL, expected TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  weight REAL NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS participants(
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', joined_at TEXT NOT NULL, finished_at TEXT, last_seen TEXT,
  violation_baseline INTEGER NOT NULL DEFAULT 0, finish_reason TEXT, UNIQUE(session_id, user_id));
CREATE TABLE IF NOT EXISTS submissions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, question_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL, sql_text TEXT NOT NULL, passed INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
  ai_score REAL NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, flag_reason TEXT,
  teacher_score REAL, teacher_comment TEXT, reviewed_at TEXT, final_score REAL NOT NULL DEFAULT 0,
  error_category TEXT, eval_ms INTEGER NOT NULL DEFAULT 0, attempt_no INTEGER NOT NULL DEFAULT 1,
  results TEXT, feedback TEXT, auto INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS violations(
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  type TEXT NOT NULL, severity TEXT NOT NULL, detail TEXT, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS drafts(
  session_id INTEGER NOT NULL, user_id INTEGER NOT NULL, question_id INTEGER NOT NULL,
  sql_text TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(session_id, user_id, question_id));
CREATE INDEX IF NOT EXISTS idx_q_session ON questions(session_id, topic_id, slot, status);
CREATE INDEX IF NOT EXISTS idx_tc_q ON test_cases(question_id);
CREATE INDEX IF NOT EXISTS idx_sub_session ON submissions(session_id, user_id, question_id);
CREATE INDEX IF NOT EXISTS idx_vio_session ON violations(session_id, user_id);
`;

async function init() {
  SQL = await initSqlJs();
  db = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();
  db.exec(SCHEMA);
  flush();
}

function flush() {
  clearTimeout(timer);
  if (!db) return;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, DB_FILE);
}
function persist() {
  clearTimeout(timer);
  timer = setTimeout(flush, 300);
}

const clean = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));

function all(sql, params = []) {
  const st = db.prepare(sql);
  try {
    st.bind(clean(params));
    const rows = [];
    while (st.step()) rows.push(st.getAsObject());
    return rows;
  } finally {
    st.free();
  }
}
const get = (sql, params = []) => all(sql, params)[0];
function run(sql, params = []) {
  db.run(sql, clean(params));
  const changes = db.getRowsModified();
  const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  persist();
  return { changes, lastId };
}
const now = () => new Date().toISOString();
const json = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

module.exports = { init, all, get, run, flush, now, json };
process.on('exit', () => {
  try {
    flush();
  } catch {}
});
