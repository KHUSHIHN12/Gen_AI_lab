/* Student session page  (/s/<token>)
 * login -> (assessment: lockdown gate) -> join -> unique question per topic -> SQL editor -> submit -> result & feedback
 */
const TOKEN = location.pathname.split('/')[2];
const SQL_REASON = {
  columns: 'wrong number of columns', rows_more: 'too many rows', rows_less: 'too few rows', values: 'values differ', order: 'right rows, wrong order', error: 'SQL error', empty: 'no SQL submitted', ok: 'ok',
};

function SqlEditor({ value, onChange, onRun, disabled }) {
  const host = useRef(null);
  const cm = useRef(null);
  const cb = useRef({ onChange, onRun });
  cb.current = { onChange, onRun };
  useEffect(() => {
    cm.current = CodeMirror(host.current, {
      value: value || '', mode: 'text/x-sql', lineNumbers: true, indentWithTabs: false, tabSize: 2, lineWrapping: true,
      extraKeys: { 'Ctrl-Enter': () => cb.current.onRun && cb.current.onRun(), 'Cmd-Enter': () => cb.current.onRun && cb.current.onRun(), Tab: (c) => c.replaceSelection('  ') },
    });
    cm.current.on('change', (c) => cb.current.onChange(c.getValue()));
    Lockdown.setEditor(cm.current);
    return () => { Lockdown.setEditor(null); };
  }, []);
  useEffect(() => { if (cm.current && cm.current.getValue() !== (value || '')) cm.current.setValue(value || ''); }, [value]);
  useEffect(() => { if (cm.current) cm.current.setOption('readOnly', disabled ? 'nocursor' : false); }, [disabled]);
  return html`<div ref=${host}></div>`;
}

function SchemaPanel({ tables }) {
  if (!tables) return html`<${Spinner}/>`;
  return html`<div>${tables.map((t) => html`<details key=${t.name} open=${true} style=${{ marginBottom: 8 }}>
    <summary><b className="mono">${t.name}</b> <span className="muted small">(${t.count} rows)</span></summary>
    <div className="small mono" style=${{ margin: '4px 0' }}>${t.columns.map((c) => html`<span className="tag" key=${c.name}>${c.name} ${c.type}${c.pk ? ' 🔑' : ''}${c.notnull ? ' NN' : ''}</span>`)}</div>
    <${ResultTable} data=${{ columns: t.columns.map((c) => c.name), rows: t.rows, total: t.count }} max=${8} />
  </details>`)}</div>`;
}

function TestList({ data, title, note }) {
  if (!data) return null;
  const list = data.results || [];
  const allOk = list.length > 0 && list.every((r) => r.status === 'pass');
  return html`<div>
    <div className=${'note ' + (allOk ? 'ok' : 'bad')} style=${{ marginBottom: 10 }}><b>${title || 'Test cases'}:</b> ${data.passed} of ${data.total} successful ${allOk ? '— all test cases passed ✅' : '— some test cases failed ❌'}</div>
    ${list.map((r, i) => html`<div key=${i} className=${'testrow ' + (r.status === 'pass' ? 'pass' : 'fail')}>
      <span className=${'tick ' + (r.status === 'pass' ? 'okc' : 'badc')}>${r.status === 'pass' ? '✔' : '✖'}</span>
      <b>${r.kind === 'hidden' ? '🔒 Hidden test' : 'Sample test'} ${i + 1}</b>
      <${Badge} kind=${r.status === 'pass' ? 'pass' : 'fail'}>${r.status === 'pass' ? 'Successful' : 'Failed'}<//>
      ${r.status !== 'pass' && (r.error || r.reason) ? html`<span className="small muted">${r.error ? r.error : SQL_REASON[r.reason] || r.reason}</span>` : null}
      ${r.status !== 'pass' && r.expected ? html`<div className="grid g2 tight" style=${{ width: '100%', marginTop: 6 }}>
        <div><div className="small muted">Expected</div><${ResultTable} data=${r.expected} max=${8} /></div>
        <div><div className="small muted">Your output</div>${r.actual ? html`<${ResultTable} data=${r.actual} max=${8} />` : html`<div className="small muted">(no output)</div>`}</div></div>` : null}
    </div>`)}
    ${note ? html`<p className="small muted">${note}</p>` : null}</div>`;
}

function EvalPanel({ res }) {
  if (!res) return null;
  const fb = res.feedback;
  return html`<div>
    ${res.score !== undefined && html`<div className="row" style=${{ marginBottom: 6 }}><div className="score-big" style=${{ color: res.score >= 100 ? 'var(--ok)' : res.score >= 50 ? 'var(--warn)' : 'var(--bad)' }}>${res.score}%</div>
      <div className="muted">${res.attempts_left !== null && res.attempts_left !== undefined ? `${res.attempts_left} attempt(s) left` : 'unlimited attempts'}</div></div>`}
    <${TestList} data=${res} title="Test cases" />
    ${fb ? html`<div className=${'note ' + (res.score >= 100 ? 'ok' : '')} style=${{ margin: '8px 0' }}><b>Feedback.</b> ${fb.summary}${fb.ai ? html`<div style=${{ marginTop: 6 }}>🤖 ${fb.ai}</div>` : null}</div>`
      : html`<div className="note info small" style=${{ marginTop: 8 }}>${res.message || 'Your score and feedback appear after you submit the whole test.'}</div>`}
  </div>`;
}

function ResultsScreen({ onBack, finished }) {
  const [data, , err] = useLoad(() => Api.get(`/api/play/${TOKEN}/results`), []);
  if (err) return html`<div className="wrap"><div className="note">${err.message}</div>${onBack && html`<button className="btn" onClick=${onBack}>Back</button>`}</div>`;
  if (!data) return html`<div className="wrap"><${Spinner}/></div>`;
  return html`<div className="wrap">
    <div className="card row between"><div><h1>${finished ? 'Test submitted' : 'Your results'}</h1><div className="muted">Overall score</div></div><div className="score-big">${data.total}%</div></div>
    ${data.items.map((it) => html`<div className="card" key=${it.question_id}>
      <div className="row between"><h3>${it.topic}</h3><div className="score-big" style=${{ fontSize: '1.5rem' }}>${it.score}%</div></div>
      <p>${it.text}</p>
      <pre>${it.sql || '-- no answer submitted'}</pre>
      <div className="note">${(it.feedback && it.feedback.summary) || ''}${it.feedback && it.feedback.ai ? html`<div>🤖 ${it.feedback.ai}</div>` : null}</div>
      ${it.teacher_comment && html`<div className="note info" style=${{ marginTop: 6 }}><b>Instructor:</b> ${it.teacher_comment}</div>`}
      <div className="row small" style=${{ marginTop: 6 }}>${it.results.map((r, i) => html`<span key=${i}><${Badge} kind=${r.status}>${r.kind === 'hidden' ? 'hidden' : 'sample'} ${i + 1}: ${r.status}<//></span>`)}</div>
    </div>`)}
    ${onBack && html`<button className="btn" onClick=${onBack}>Back to the lab</button>`}
  </div>`;
}

function Exam({ info, user, initial, onLogout }) {
  const [st, setSt] = useState(initial);
  const [active, setActive] = useState(initial.questions[0] ? initial.questions[0].id : null);
  const [drafts, setDrafts] = useState(() => Object.fromEntries(initial.questions.map((q) => [q.id, q.draft || q.last_sql || ''])));
  const [outs, setOuts] = useState({});
  const [evals, setEvals] = useState({});
  const [schemas, setSchemas] = useState({});
  const [tab, setTab] = useState('output');
  const [busy, setBusy] = useState('');
  const [view, setView] = useState('exam');
  const [alertMsg, setAlertMsg] = useState(null);
  const [fsLost, setFsLost] = useState(false);
  const [offset, setOffset] = useState(Date.parse(initial.server_time) - Date.now());
  const [now, setNow] = useState(Date.now());
  const [popup, setPopup] = useState(null);
  const [ask, dialogNode] = useConfirm();
  const saveT = useRef(null);
  const lock = st.session.lockdown;
  const part = st.participant || { status: 'active', violations: 0 };
  const q = st.questions.find((x) => x.id === active) || st.questions[0];
  const finished = part.status === 'submitted' || st.session.status === 'ended';
  const paused = part.status === 'paused' && !finished;

  // ---- poll state (also acts as heartbeat for the instructor's live monitor)
  const refresh = useCallback(async () => {
    try {
      const s = await Api.get(`/api/play/${TOKEN}/state`);
      setSt(s); setOffset(Date.parse(s.server_time) - Date.now());
      setActive((a) => (a && s.questions.some((x) => x.id === a) ? a : s.questions[0] ? s.questions[0].id : null));
      setDrafts((d) => { const n = { ...d }; s.questions.forEach((x) => { if (n[x.id] === undefined) n[x.id] = x.draft || x.last_sql || ''; }); return n; });
    } catch (e) { if (e.status === 401) location.reload(); }
  }, []);
  usePoll(refresh, 4000, []);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  // ---- lockdown (assessment only)
  const reportViolation = useCallback(async (type, detail) => {
    try {
      const r = await Api.post(`/api/play/${TOKEN}/violation`, { type, detail });
      if (r.severity === 'serious') {
        const label = type.replace(/_/g, ' ');
        setAlertMsg(r.action === 'pause' ? `⛔ ${label} - your test is PAUSED. Wait for your instructor.` : r.action === 'submit' ? `⛔ Too many violations - your test was submitted automatically.` : `⚠ Violation recorded: ${label} (${r.count} so far). Stay in full screen and do not leave this window.`);
        refresh();
      }
    } catch {}
  }, [refresh]);
  useEffect(() => {
    if (!lock || finished) { if (Lockdown.isActive()) Lockdown.stop(); if (lock && finished && window.lockdownAPI) window.lockdownAPI.allowExit(); return; }
    Lockdown.start({ report: reportViolation, onFullscreenState: setFsLost });
    return undefined;
  }, [lock, finished]);
  useEffect(() => () => Lockdown.stop(), []);

  // ---- schema preview of the per-student isolated database
  useEffect(() => {
    if (!q || schemas[q.id] || finished) return;
    Api.get(`/api/play/${TOKEN}/questions/${q.id}/schema`).then((r) => setSchemas((s) => ({ ...s, [q.id]: r.tables }))).catch(() => {});
  }, [q && q.id, finished]);

  const setSql = (v) => {
    if (!q) return;
    setDrafts((d) => ({ ...d, [q.id]: v }));
    clearTimeout(saveT.current);
    const id = q.id;
    saveT.current = setTimeout(() => Api.put(`/api/play/${TOKEN}/draft`, { question_id: id, sql: v }).catch(() => {}), 1500);
  };

  const run = async () => {
    if (!q || busy) return;
    setBusy('run'); setTab('output');
    try {
      const r = await Api.post(`/api/play/${TOKEN}/run`, { question_id: q.id, sql: drafts[q.id] || '' });
      setOuts((o) => ({ ...o, [q.id]: r }));
      if (r.tables) setSchemas((s) => ({ ...s, [q.id]: r.tables }));
    } catch (e) { setOuts((o) => ({ ...o, [q.id]: { error: e.message } })); if (e.code === 'PAUSED') refresh(); }
    finally { setBusy(''); }
  };
  const resetDb = async () => {
    if (!q || !(await ask('Reset database', 'Reset your private database for this question to the original sample data?', { okText: 'Reset' }))) return;
    try { const r = await Api.post(`/api/play/${TOKEN}/reset`, { question_id: q.id }); setSchemas((s) => ({ ...s, [q.id]: r.tables })); toast('Database reset', 'ok'); } catch (e) { fail(e); }
  };
  const submit = async () => {
    if (!q || busy) return;
    const left = q.max_attempts > 0 ? q.max_attempts - q.attempts : null;
    if (!(await ask('Submit this answer?', left === 1 ? 'This is your LAST attempt for this question. Submit it now?' : 'Submit this answer for evaluation? You stay in the secure window.', { okText: 'Submit answer' }))) return;
    setBusy('submit');
    try {
      const r = await Api.post(`/api/play/${TOKEN}/submit`, { question_id: q.id, sql: drafts[q.id] || '' });
      setEvals((e) => ({ ...e, [q.id]: r })); setTab('eval'); setPopup({ topic: q.topic, res: r }); refresh();
    } catch (e) { fail(e); if (e.code === 'PAUSED') refresh(); } finally { setBusy(''); }
  };
  const finish = async () => {
    const unanswered = st.questions.filter((x) => !x.answered).length;
    const msg = (unanswered ? `You have ${unanswered} unanswered question(s) (saved drafts are submitted automatically).\n\n` : '') + (lock ? 'Submit the whole test? You cannot change anything afterwards. The secure window closes only after this final submission.' : 'Finish this lab session?');
    if (!(await ask(lock ? 'Final submission' : 'Finish session', msg, { okText: lock ? 'Yes, submit the test' : 'Finish', danger: lock }))) return;
    try { await Api.post(`/api/play/${TOKEN}/finish`, {}); refresh(); setView('results'); } catch (e) { fail(e); }
  };

  const left = st.session.ends_at ? Math.max(0, Math.round((Date.parse(st.session.ends_at) - (now + offset)) / 1000)) : null;
  const mmss = left === null ? '' : `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;

  if (finished) {
    if (st.results_visible) return html`<${ResultsScreen} finished=${true} onBack=${st.session.mode === 'class' && st.session.status !== 'ended' ? () => location.reload() : null} />`;
    return html`<div className="center"><div className="card" style=${{ maxWidth: 520, textAlign: 'center' }}><h1>✅ Test submitted</h1><p className="muted">${part.finish_reason || ''}</p>
      <p>Your answers have been recorded. Your score and feedback will appear here once the instructor ends the session.</p>
      ${window.lockdownAPI ? html`<button className="btn primary" onClick=${() => window.lockdownAPI.quit()}>Close lockdown browser</button>` : null}</div></div>`;
  }
  if (view === 'results') return html`<${ResultsScreen} onBack=${() => setView('exam')} />`;

  const out = q && outs[q.id];
  const ev = q && evals[q.id];
  const noMore = q && q.max_attempts > 0 && q.attempts >= q.max_attempts;
  const showScore = st.results_visible;

  return html`<div>
    <div className=${'lockbar ' + (lock ? '' : 'class')}>
      <b>${lock ? '🔒 ASSESSMENT - secure mode' : '📘 Lab class'}</b>
      <span>${st.session.title}</span>
      <span className="grow"></span>
      ${lock && html`<span>${window.lockdownAPI ? '🛡 Lockdown browser' : '🛡 Browser lockdown'} · violations: ${part.violations}</span>`}
      ${mmss && html`<span className="timer">⏱ ${mmss}</span>`}
      <span>${user.name}</span>
    </div>
    ${alertMsg && html`<div className="note bad" style=${{ margin: '8px 1rem 0' }}>${alertMsg} <a href="#" onClick=${(e) => { e.preventDefault(); setAlertMsg(null); }}>dismiss</a></div>`}
    ${st.waiting && st.waiting.length > 0 && html`<div className="note" style=${{ margin: '8px 1rem 0' }}>Waiting for your instructor to approve questions for: <b>${st.waiting.join(', ')}</b>. They appear here automatically.</div>`}
    <div className="exam">
      <div>
        <div className="card"><h3>Questions</h3>
          <div className="qlist">${st.questions.map((x, i) => html`<button key=${x.id} className=${x.id === (q && q.id) ? 'on' : ''} onClick=${() => { setActive(x.id); setTab('output'); }}>
            ${showScore && x.best_score !== null ? html`<span className="sc" style=${{ color: x.best_score >= 100 ? 'var(--ok)' : 'var(--warn)' }}>${x.best_score}%</span>` : x.answered ? html`<span className="sc">✓</span>` : null}
            <b>${i + 1}.</b> ${x.topic}</button>`)}</div>
          ${st.questions.length === 0 && html`<p className="muted small">No question assigned yet.</p>`}
        </div>
        <div className="card">
          ${st.session.mode === 'class' && html`<button className="btn" style=${{ width: '100%', marginBottom: 6 }} onClick=${() => setView('results')}>My results so far</button>`}
          <button className="btn primary" style=${{ width: '100%' }} onClick=${finish}>${lock ? 'Submit test' : 'Finish session'}</button>
          ${!lock && html`<button className="btn" style=${{ width: '100%', marginTop: 6 }} onClick=${() => { Api.clear(); location.reload(); }}>Log out</button>`}
        </div>
      </div>
      <div>
        ${q ? html`<div>
          <div className="card">
            <div className="row between"><h2>${q.topic}</h2><div className="row"><${Badge} kind=${q.difficulty}>${q.difficulty}<//>${q.max_attempts > 0 ? html`<span className="small muted">attempt ${Math.min(q.attempts + 1, q.max_attempts)} of ${q.max_attempts}</span>` : html`<span className="small muted">unlimited attempts</span>`}</div></div>
            <p style=${{ fontSize: '1.05rem' }}>${q.text}</p>
            <div>${q.concepts.map((c) => html`<span className="tag" key=${c}>${c}</span>`)}</div>
          </div>
          <div className="grid g2">
            <div className="card">
              <div className="row between"><h3>Your SQL</h3><span className="small muted">Ctrl+Enter = Run</span></div>
              <${SqlEditor} value=${drafts[q.id] || ''} onChange=${setSql} onRun=${run} disabled=${noMore || paused} />
              <div className="row" style=${{ marginTop: 8 }}>
                <button className="btn" onClick=${run} disabled=${!!busy || paused}>▶ Run & test</button>
                <button className="btn primary" onClick=${submit} disabled=${!!busy || noMore || paused}>${busy === 'submit' ? 'Evaluating…' : 'Submit answer'}</button>
                <button className="btn" onClick=${resetDb} disabled=${paused}>↺ Reset my DB</button>
              </div>
              ${noMore && html`<div className="note small" style=${{ marginTop: 8 }}>You have used all attempts for this question.</div>`}
            </div>
            <div className="card"><h3>Your private database</h3><p className="small muted">Isolated copy with sample data - experiment freely, nobody else sees it.</p><${SchemaPanel} tables=${schemas[q.id]} /></div>
          </div>
          <div className="card">
            <div className="tabs"><button className=${tab === 'output' ? 'on' : ''} onClick=${() => setTab('output')}>Output & test cases</button><button className=${tab === 'eval' ? 'on' : ''} onClick=${() => setTab('eval')}>Evaluation</button></div>
            ${tab === 'output' && (out ? html`<div>
              ${out.error ? html`<div className="note bad mono">${out.error}</div>` : out.result && out.result.columns.length ? html`<div><${ResultTable} data=${{ columns: out.result.columns, rows: out.result.rows, total: out.result.rows.length, truncated: out.result.truncated }} max=${100} /><div className="small muted" style=${{ marginBottom: 8 }}>${out.result.rows.length} row(s)${out.result.ms !== undefined ? ` · ${out.result.ms} ms` : ''}</div></div>` : html`<div className="note ok" style=${{ marginBottom: 8 }}>${(out.result && out.result.message) || 'OK'}</div>`}
              <${TestList} data=${out.tests} title="Sample test cases" note="Hidden test cases are checked when you submit your answer." /></div>` : html`<p className="muted">Click “Run & test” to see your output and whether the sample test cases are successful or failed.</p>`)}
            ${tab === 'eval' && (ev ? html`<${EvalPanel} res=${ev} />` : q.answered ? html`<p className="muted">You already submitted an answer${showScore && q.best_score !== null ? ` (best score ${q.best_score}%)` : ''}. Submit again to see a new evaluation.</p>` : html`<p className="muted">Submit your answer to get automatic evaluation.</p>`)}
          </div>
        </div>` : html`<div className="card"><h2>Waiting for questions…</h2><p className="muted">Your instructor is still preparing the question bank. This page updates by itself.</p></div>`}
      </div>
    </div>
    ${dialogNode}
    ${popup && html`<${Modal} title=${'Answer submitted · ' + popup.topic} small=${true} onClose=${() => setPopup(null)}>
      <${EvalPanel} res=${popup.res} />
      <div className="dialog-actions"><button className="btn primary" autoFocus onClick=${() => setPopup(null)}>OK, continue</button></div><//>`}
    ${paused && html`<div className="fullblock"><h1>⏸ Your test is paused</h1><p>The lockdown policy paused your session. Raise your hand - your instructor will resume it.</p><p className="small">${alertMsg || ''}</p></div>`}
    ${lock && fsLost && !paused && !window.lockdownAPI && html`<div className="fullblock"><h1>Full screen is required</h1><p>This assessment must run in full-screen mode. Leaving it is recorded as a violation.</p>
      <button className="btn primary" onClick=${async () => { if (await Lockdown.enterFullscreen()) setFsLost(false); }}>Return to full screen</button></div>`}
  </div>`;
}

function Gate({ info, user, onEnter, onLogout }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const strictBlocked = info.strict && !window.lockdownAPI;
  const go = async () => {
    setBusy(true); setErr('');
    try {
      if (info.lockdown && !(await Lockdown.enterFullscreen())) { setErr('Your browser refused full-screen mode. Allow full screen and try again.'); setBusy(false); return; }
      await onEnter();
    } catch (e) { setErr(e.message); if (info.lockdown) Lockdown.stop(); setBusy(false); }
  };
  return html`<div className="center"><div className="card" style=${{ width: 'min(620px,100%)' }}>
    <div className="row between"><h1>${info.title}</h1><${Badge} kind=${info.mode}>${info.mode === 'assessment' ? 'ASSESSMENT' : 'LAB CLASS'}<//></div>
    <p className="muted">Logged in as <b>${user.name}</b> · <a href="#" onClick=${(e) => { e.preventDefault(); onLogout(); }}>not you?</a></p>
    ${info.lockdown ? html`<div className="note bad"><b>Secure assessment rules</b><ul style=${{ margin: '.4rem 0 0 1.1rem', padding: 0 }}>
      <li>The test runs in full screen. You cannot minimise, switch tabs or leave until you submit or the instructor ends the session.</li>
      <li>Pasting text copied from outside the editor is blocked. Right-click, dev-tools and browser shortcuts are disabled.</li>
      <li>Every attempt is logged with a timestamp and shown to your instructor. Repeated violations pause or submit your test.</li></ul></div>`
      : html`<div className="note ok">This is a normal lab class: no lockdown. You get unique questions, instant evaluation and feedback, and can retry freely.</div>`}
    ${info.duration_min > 0 && html`<p>Time limit: <b>${info.duration_min} minutes</b> (starts when the instructor broadcast the session).</p>`}
    ${strictBlocked ? html`<div className="note bad" style=${{ marginTop: 10 }}><b>Open this link in the DBMS Lab Lockdown Browser.</b> Normal browsers are not accepted for this assessment. Ask your instructor for the lockdown browser launcher.</div>`
      : html`<button className="btn primary" style=${{ marginTop: 12 }} onClick=${go} disabled=${busy}>${info.lockdown ? 'I understand - start the assessment' : 'Join the lab class'}</button>`}
    ${err && html`<div className="note bad" style=${{ marginTop: 10 }}>${err}</div>`}
  </div></div>`;
}

function App() {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const [user, setUser] = useState(() => (Api.token && Api.user && Api.user.role === 'student' ? Api.user : null));
  const [joined, setJoined] = useState(null);
  const loadInfo = useCallback(() => Api.get(`/api/public/session/${TOKEN}`).then(setInfo).catch((e) => setErr(e.message)), []);
  useEffect(() => { loadInfo(); }, []);
  usePoll(() => { if (!joined && info && info.status !== 'live') loadInfo(); }, 3500, [joined, info && info.status]);

  if (err) return html`<div className="center"><div className="card"><h1>Session not found</h1><p>${err}</p><a href="/">Back</a></div></div>`;
  if (!info) return html`<div className="center"><${Spinner}/></div>`;
  const logout = () => { Api.clear(); setUser(null); };
  if (info.status === 'draft') return html`<div className="center"><div className="card" style=${{ textAlign: 'center', maxWidth: 520 }}><h1>${info.title}</h1><p style=${{ fontSize: '1.2rem' }}>⏳ Waiting for the instructor to start the session…</p>
    <p className="muted">Stay on this page - registration and the test open automatically when the session is broadcast.</p></div></div>`;
  if (!user) return html`<div className="center"><div style=${{ width: 'min(440px,100%)' }}><div className="card"><h1>${info.title}</h1><div className="row"><${Badge} kind=${info.mode}>${info.mode === 'assessment' ? 'ASSESSMENT' : 'LAB CLASS'}<//><${Badge} kind=${info.status}>${info.status}<//></div></div>
    <${AuthBox} session=${TOKEN} canRegister=${info.status === 'live'} roleHint=${info.status === 'live' ? 'First time here? Register with your name, roll number and a password. Come back later? Just log in.' : 'Log in to see your results.'} onDone=${(u) => { if (u.role !== 'student') { Api.clear(); toast('Instructors use the dashboard at /instructor', 'bad'); } else setUser(u); }} /><${Toaster}/></div></div>`;

  if (joined) return html`<${Exam} info=${info} user=${user} initial=${joined} onLogout=${logout} /><${Toaster}/>`;

  if (info.status === 'draft') return html`<div className="center"><div className="card" style=${{ textAlign: 'center', maxWidth: 520 }}><h1>${info.title}</h1><p style=${{ fontSize: '1.2rem' }}>⏳ Waiting for the instructor to start the session…</p>
    <p className="muted">Stay on this page - it opens automatically when the session is broadcast.</p></div></div>`;

  const enter = async () => {
    const s = await Api.post(`/api/play/${TOKEN}/join`, {});
    setJoined(s);
  };
  if (info.status === 'ended') {
    return html`<div className="center"><div className="card" style=${{ textAlign: 'center', maxWidth: 520 }}><h1>${info.title}</h1><p>This session has ended.</p>
      <button className="btn primary" onClick=${async () => { try { const s = await Api.post(`/api/play/${TOKEN}/join`, {}); setJoined(s); } catch (e) { toast(e.code === 'ENDED' ? 'You did not take part in this session.' : e.message, 'bad'); } }}>View my results</button><${Toaster}/></div></div>`;
  }
  return html`<${Gate} info=${info} user=${user} onEnter=${enter} onLogout=${logout} /><${Toaster}/>`;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App}/>`);
