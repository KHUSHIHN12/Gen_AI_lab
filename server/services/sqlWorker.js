'use strict';
// Worker thread that executes SQL against throw-away in-memory SQLite databases.
// Running in a worker lets the parent kill runaway queries (infinite recursive CTEs, huge cross joins).
const { parentPort } = require('worker_threads');
const initSqlJs = require('sql.js');

const SQLp = initSqlJs();
const FORBIDDEN = /\b(attach|detach)\b/i;

const cell = (v) => (v instanceof Uint8Array ? "x'" + Buffer.from(v).toString('hex') + "'" : v);

// Runs a multi-statement script; returns the result of the last statement that produces columns.
function runScript(db, script, maxRows) {
  if (FORBIDDEN.test(script)) throw new Error('ATTACH / DETACH statements are not allowed in this laboratory');
  let last = null;
  for (const st of db.iterateStatements(script)) {
    const cols = st.getColumnNames();
    if (cols.length > 0) {
      const rows = [];
      let truncated = false;
      while (st.step()) {
        if (rows.length >= maxRows) {
          truncated = true;
          break;
        }
        rows.push(st.get().map(cell));
      }
      last = { columns: cols, rows, truncated };
    } else {
      st.step();
    }
  }
  return last || { columns: [], rows: [], truncated: false, message: `Statement(s) executed. Rows affected: ${db.getRowsModified()}` };
}

function preview(db) {
  const tables = [];
  const list = db.exec("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name");
  for (const [name] of list.length ? list[0].values : []) {
    const q = '"' + String(name).replace(/"/g, '""') + '"';
    const info = db.exec(`PRAGMA table_info(${q})`);
    const columns = (info.length ? info[0].values : []).map((r) => ({ name: r[1], type: r[2], pk: !!r[5], notnull: !!r[3] }));
    const count = db.exec(`SELECT COUNT(*) FROM ${q}`)[0].values[0][0];
    const sample = db.exec(`SELECT * FROM ${q} LIMIT 8`);
    tables.push({ name, columns, count, rows: sample.length ? sample[0].values.map((r) => r.map(cell)) : [] });
  }
  return tables;
}

const errMsg = (e) => String((e && e.message) || e);

async function handle(SQL, job) {
  const maxRows = job.maxRows || 200;
  if (job.op === 'datasets') {
    // Evaluate one script against several independent datasets (schema + data), optionally followed by a check query.
    const out = [];
    let sharedError = null;
    for (const ds of job.setups) {
      if (sharedError) {
        out.push({ id: ds.id, error: sharedError });
        continue;
      }
      const db = new SQL.Database();
      try {
        db.exec(job.schema);
        db.exec(ds.sql);
        let res;
        try {
          res = runScript(db, job.script, maxRows);
          if (job.checkSql) res = runScript(db, job.checkSql, maxRows);
          out.push({ id: ds.id, columns: res.columns, rows: res.rows, truncated: res.truncated });
        } catch (e) {
          // The same script fails the same way on every dataset, so stop early and reuse the message.
          sharedError = errMsg(e);
          out.push({ id: ds.id, error: errMsg(e) });
        }
      } catch (e) {
        out.push({ id: ds.id, error: errMsg(e), setupError: true });
      } finally {
        db.close();
      }
    }
    return out;
  }

  if (job.op === 'sandbox') {
    // Per-student isolated database instance: restore from blob (or build from schema + sample data), run script, export.
    let db;
    if (job.blob) db = new SQL.Database(new Uint8Array(job.blob));
    else {
      db = new SQL.Database();
      db.exec(job.schema);
      db.exec(job.data);
    }
    try {
      let result = null;
      let error = null;
      if (job.script && job.script.trim()) {
        const t0 = Date.now();
        try {
          result = runScript(db, job.script, maxRows);
          result.ms = Date.now() - t0;
        } catch (e) {
          error = errMsg(e);
        }
      }
      return { result, error, blob: Buffer.from(db.export()), tables: preview(db) };
    } finally {
      db.close();
    }
  }
  throw new Error('Unknown op ' + job.op);
}

parentPort.on('message', async (job) => {
  try {
    const SQL = await SQLp;
    parentPort.postMessage({ id: job.id, result: await handle(SQL, job) });
  } catch (e) {
    parentPort.postMessage({ id: job.id, error: errMsg(e) });
  }
});
