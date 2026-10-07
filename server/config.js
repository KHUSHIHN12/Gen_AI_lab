'use strict';
// Central configuration. Every value can be overridden with an environment variable (see .env.example).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
fs.mkdirSync(dataDir, { recursive: true });

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  const f = path.join(dataDir, '.jwt_secret');
  if (fs.existsSync(f)) jwtSecret = fs.readFileSync(f, 'utf8').trim();
  else {
    jwtSecret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, jwtSecret);
  }
}

const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => (v === undefined || v === '' || isNaN(+v) ? d : +v);

module.exports = {
  root,
  dataDir,
  port: int(process.env.PORT, 3000),
  jwtSecret,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  instructor: {
    username: process.env.INSTRUCTOR_USERNAME || 'instructor',
    password: process.env.INSTRUCTOR_PASSWORD || 'instructor123',
    name: process.env.INSTRUCTOR_NAME || 'Course Instructor',
  },
  seedDemoStudents: bool(process.env.SEED_DEMO_STUDENTS, false),
  allowStudentRegistration: bool(process.env.ALLOW_STUDENT_REGISTRATION, true),

  // Lockdown
  lockdownStrict: bool(process.env.LOCKDOWN_STRICT, false), // true => assessments only open in the Electron lockdown browser
  lockdownSecret: process.env.LOCKDOWN_SECRET || 'dbms-lab-lockdown-secret',

  // SQL execution
  sqlTimeoutMs: int(process.env.SQL_TIMEOUT_MS, 5000),
  sqlWorkers: int(process.env.SQL_WORKERS, 2),
  maxResultRows: int(process.env.MAX_RESULT_ROWS, 200),

  // Test cases
  visibleTestCases: int(process.env.VISIBLE_TESTCASES, 2),
  hiddenTestCases: int(process.env.HIDDEN_TESTCASES, 3),

  // AI module: none (offline generator) | openai (any OpenAI-compatible API, incl. Ollama / LM Studio / vLLM)
  ai: {
    provider: (process.env.AI_PROVIDER || 'none').toLowerCase(),
    baseUrl: (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    timeoutMs: int(process.env.AI_TIMEOUT_MS, 60000),
    llmFeedback: bool(process.env.AI_LLM_FEEDBACK, true),
  },

  // Evaluation-time metric assumptions (minutes)
  manualEvalMinutes: int(process.env.MANUAL_EVAL_MINUTES, 4),
  reviewMinutes: int(process.env.REVIEW_MINUTES, 1),
};
