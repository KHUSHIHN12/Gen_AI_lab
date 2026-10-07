'use strict';
// SQL Execution Environment: a small pool of worker threads, each executing queries on isolated in-memory databases.
// A job that exceeds the timeout is killed (worker terminated and respawned) and reported as "timeout".
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const WORKER_FILE = path.join(__dirname, 'sqlWorker.js');
let seq = 0;
const slots = [];
const queue = [];

function spawn(slot) {
  slot.worker = new Worker(WORKER_FILE);
  slot.worker.unref();
  slot.worker.on('message', (m) => {
    const job = slot.job;
    if (!job || job.id !== m.id) return;
    clearTimeout(job.timer);
    slot.job = null;
    if (m.error) job.reject(new Error(m.error));
    else job.resolve(m.result);
    pump();
  });
  slot.worker.on('error', (e) => {
    const job = slot.job;
    slot.job = null;
    if (job) {
      clearTimeout(job.timer);
      job.reject(e);
    }
    spawn(slot);
    pump();
  });
}

function ensure() {
  while (slots.length < Math.max(1, config.sqlWorkers)) {
    const s = { worker: null, job: null };
    spawn(s);
    slots.push(s);
  }
}

function pump() {
  for (const slot of slots) {
    if (slot.job || !queue.length) continue;
    const job = queue.shift();
    slot.job = job;
    job.timer = setTimeout(() => {
      slot.job = null;
      const dead = slot.worker;
      spawn(slot);
      dead.terminate();
      const err = new Error(`Query timed out after ${config.sqlTimeoutMs} ms (possible infinite loop or very heavy query)`);
      err.code = 'TIMEOUT';
      job.reject(err);
      pump();
    }, config.sqlTimeoutMs);
    slot.worker.postMessage({ id: job.id, ...job.payload });
  }
}

function runJob(payload) {
  ensure();
  return new Promise((resolve, reject) => {
    queue.push({ id: ++seq, payload, resolve, reject });
    pump();
  });
}

// ---- High level helpers -------------------------------------------------------------------------------------------

// Run `script` on every dataset. setups = [{id, sql}]. Returns [{id, columns, rows} | {id, error}].
async function runDatasets({ schema, setups, script, checkSql, isReference = false, maxRows = 5000 }) {
  try {
    return await runJob({ op: 'datasets', schema, setups, script, checkSql, isReference, maxRows });
  } catch (e) {
    // A timeout kills the whole batch; report it for every dataset so callers can treat it as a normal error.
    return setups.map((s) => ({ id: s.id, error: e.message, timeout: e.code === 'TIMEOUT' }));
  }
}

// ---- Per-student sandbox databases -------------------------------------------------------------------------------
const cache = new Map();
const sandboxDir = (sid) => path.join(config.dataDir, 'student_dbs', `session_${sid}`);
const sandboxFile = (sid, uid, qid) => path.join(sandboxDir(sid), `user_${uid}_q${qid}.sqlite`);
const keyOf = (sid, uid, qid) => `${sid}:${uid}:${qid}`;

function loadBlob(sid, uid, qid) {
  const k = keyOf(sid, uid, qid);
  if (cache.has(k)) return cache.get(k);
  const f = sandboxFile(sid, uid, qid);
  if (fs.existsSync(f)) {
    const b = fs.readFileSync(f);
    cache.set(k, b);
    return b;
  }
  return null;
}

async function sandbox({ sid, uid, qid, schema, data, script, maxRows }) {
  const blob = loadBlob(sid, uid, qid);
  const r = await runJob({ op: 'sandbox', blob, schema, data, script, maxRows: maxRows || config.maxResultRows });
  const buf = Buffer.from(r.blob);
  cache.set(keyOf(sid, uid, qid), buf);
  fs.mkdirSync(sandboxDir(sid), { recursive: true });
  fs.writeFile(sandboxFile(sid, uid, qid), buf, () => {});
  return { result: r.result, error: r.error, tables: r.tables };
}

function resetSandbox(sid, uid, qid) {
  cache.delete(keyOf(sid, uid, qid));
  try {
    fs.unlinkSync(sandboxFile(sid, uid, qid));
  } catch {}
}

module.exports = { runDatasets, sandbox, resetSandbox };
