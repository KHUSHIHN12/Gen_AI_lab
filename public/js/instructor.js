/* Instructor web portal */
const DIFF_ORDER = ['easy', 'medium', 'hard'];
const ERR_LABEL = {
  syntax_error: 'Syntax errors', unknown_identifier: 'Unknown table/column', ambiguous_column: 'Ambiguous column', timeout: 'Timeouts', forbidden: 'Forbidden statements',
  runtime_error: 'Runtime errors', empty_submission: 'Empty submissions', wrong_columns: 'Wrong columns', too_many_rows: 'Too many rows', too_few_rows: 'Too few rows',
  wrong_values: 'Wrong values', wrong_order: 'Wrong ordering', overfit: 'Passes samples only (hard-coding?)',
};
const VIO_LABEL = {
  tab_switch: 'Tab switch / minimise', window_blur: 'Window lost focus', fullscreen_exit: 'Left full screen', external_paste: 'Outside paste blocked', devtools: 'Dev tools suspected',
  blocked_shortcut: 'Blocked shortcut', context_menu: 'Right-click blocked', drop_attempt: 'Drag & drop blocked', multiple_displays: 'Second display detected', navigation_attempt: 'Navigation attempt',
};

const route = () => (location.hash.replace(/^#\/?/, '') || 'sessions').split('/');
const go = (p) => { location.hash = '#/' + p; };

/* ===================================================================== Syllabus */
function SyllabusView() {
  const [list, reloadList] = useLoad(() => Api.get('/api/syllabi'), []);
  const [sel, setSel] = useState(null);
  const [form, setForm] = useState({ title: '', text: '', file: null });
  const [busy, setBusy] = useState(false);

  const open = (id) => Api.get('/api/syllabi/' + id).then(setSel).catch(fail);
  const upload = async (e) => {
    e.preventDefault(); setBusy(true);
    try {
      const fd = new FormData();
      fd.append('title', form.title || (form.file ? form.file.name : 'DBMS Syllabus'));
      if (form.file) fd.append('file', form.file); else fd.append('text', form.text);
      const r = await Api.call('POST', '/api/syllabi', fd, true);
      toast(`Syllabus processed: ${r.topics.length} topics detected`, 'ok');
      setForm({ title: '', text: '', file: null }); reloadList(); setSel({ id: r.id, title: r.title, topics: r.topics });
    } catch (e2) { fail(e2); } finally { setBusy(false); }
  };
  const sample = async () => { const t = await fetch('/samples/syllabus_dbms.txt').then((r) => r.text()); setForm({ ...form, title: 'Sample DBMS syllabus', text: t, file: null }); };

  return html`<div>
    <div className="grid g2">
      <form className="card" onSubmit=${upload}>
        <h2>Upload syllabus</h2>
        <p className="muted small">The syllabus is the single source for all AI-generated questions and test cases. Upload .txt .md .csv .pdf .docx, or paste text.
          Best format (one topic per line): <code>Topic | SQL concepts | easy/medium/hard | learning objective</code>. Free text with headings and bullets also works.</p>
        <div className="field"><label>Title</label><input style=${{ width: '100%' }} value=${form.title} onInput=${(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. DBMS Lab - Semester 5" /></div>
        <div className="field"><label>File</label><input type="file" accept=".txt,.md,.csv,.pdf,.docx" onChange=${(e) => setForm({ ...form, file: e.target.files[0] || null })} /></div>
        <div className="field"><label>…or paste the syllabus text</label><textarea rows="7" value=${form.text} onInput=${(e) => setForm({ ...form, text: e.target.value })}></textarea></div>
        <div className="row"><button className="btn primary" disabled=${busy || (!form.file && !form.text.trim())}>${busy ? 'Processing…' : 'Process syllabus'}</button><button type="button" className="btn" onClick=${sample}>Load sample syllabus</button></div>
      </form>
      <div className="card"><h2>Your syllabi</h2>
        ${!list ? html`<${Spinner}/>` : list.length === 0 ? html`<p className="muted">Nothing uploaded yet.</p>` : html`<table><thead><tr><th>Title</th><th>Topics</th><th>Uploaded</th><th></th></tr></thead><tbody>
          ${list.map((s) => html`<tr key=${s.id} className="click" onClick=${() => open(s.id)}><td>${s.title}</td><td>${s.topics}</td><td className="small">${when(s.created_at)}</td>
            <td><button className="btn sm" onClick=${(e) => { e.stopPropagation(); if (confirm('Delete this syllabus?')) Api.del('/api/syllabi/' + s.id).then(() => { reloadList(); if (sel && sel.id === s.id) setSel(null); }).catch(fail); }}>Delete</button></td></tr>`)}</tbody></table>`}
      </div>
    </div>
    ${sel && html`<${TopicEditor} key=${sel.id} syl=${sel} onSaved=${(t) => { setSel({ ...sel, topics: t }); reloadList(); }} />`}
  </div>`;
}

function TopicEditor({ syl, onSaved }) {
  const [rows, setRows] = useState(syl.topics.map((t) => ({ ...t, concepts: t.concepts.join(', ') })));
  const upd = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async () => {
    try { const r = await Api.put(`/api/syllabi/${syl.id}/topics`, { topics: rows }); onSaved(r.topics); setRows(r.topics.map((t) => ({ ...t, concepts: t.concepts.join(', ') }))); toast('Topics saved', 'ok'); } catch (e) { fail(e); }
  };
  return html`<div className="card"><div className="row between"><h2>Topics - ${syl.title}</h2>
    <div className="row"><button className="btn" onClick=${() => setRows([...rows, { name: '', concepts: '', difficulty: 'medium', objectives: '' }])}>+ Add topic</button><button className="btn primary" onClick=${save}>Save topics</button></div></div>
    <p className="muted small">Check what the Syllabus Processing Module detected. Concepts decide which SQL skills are tested (SELECT, GROUP BY, JOIN, EXISTS, RANK, UPDATE, VIEW, CREATE TABLE…).</p>
    <div className="scroll" style=${{ maxHeight: 520 }}><table><thead><tr><th>Topic</th><th>SQL concepts (comma separated)</th><th>Difficulty</th><th>Learning objective</th><th></th></tr></thead><tbody>
    ${rows.map((r, i) => html`<tr key=${i}>
      <td><input style=${{ width: 190 }} value=${r.name} onInput=${(e) => upd(i, 'name', e.target.value)} /></td>
      <td><input style=${{ width: 230 }} value=${r.concepts} onInput=${(e) => upd(i, 'concepts', e.target.value)} /></td>
      <td><select value=${r.difficulty} onChange=${(e) => upd(i, 'difficulty', e.target.value)}>${DIFF_ORDER.map((d) => html`<option key=${d}>${d}</option>`)}</select></td>
      <td><input style=${{ width: 280 }} value=${r.objectives} onInput=${(e) => upd(i, 'objectives', e.target.value)} /></td>
      <td><button className="btn sm" onClick=${() => setRows(rows.filter((_, j) => j !== i))}>✕</button></td></tr>`)}
    </tbody></table></div></div>`;
}

/* ===================================================================== Sessions */
function SessionsView() {
  const [list, reload] = useLoad(() => Api.get('/api/sessions'), []);
  const [creating, setCreating] = useState(false);
  usePoll(reload, 5000, []);
  return html`<div>
    <div className="row between" style=${{ marginBottom: 12 }}><h1>Sessions</h1><button className="btn primary" onClick=${() => setCreating(!creating)}>${creating ? 'Close' : '+ New session'}</button></div>
    ${creating && html`<${NewSession} onCreated=${(id) => go('session/' + id)} />`}
    <div className="card">${!list ? html`<${Spinner}/>` : list.length === 0 ? html`<p className="muted">No sessions yet. Upload a syllabus, then create your first lab class or assessment.</p>` : html`<table><thead><tr><th>Title</th><th>Type</th><th>Status</th><th>Topics</th><th>Questions (approved/pending)</th><th>Students</th><th>Created</th></tr></thead><tbody>
      ${list.map((s) => html`<tr key=${s.id} className="click" onClick=${() => go('session/' + s.id)}><td><b>${s.title}</b><div className="small mono muted">/s/${s.token}</div></td>
        <td><${Badge} kind=${s.mode}>${s.mode === 'assessment' ? '🔒 Assessment' : 'Normal class'}<//></td><td><${Badge} kind=${s.status}>${s.status}<//></td><td>${s.topics}</td>
        <td>${s.questions.approved} / ${s.questions.pending}</td><td>${s.participants}</td><td className="small">${when(s.created_at)}</td></tr>`)}</tbody></table>`}</div></div>`;
}

function NewSession({ onCreated }) {
  const [syls] = useLoad(() => Api.get('/api/syllabi'), []);
  const [f, setF] = useState({ title: '', syllabus_id: '', mode: 'class', duration_min: 0, max_attempts: 0, show_results: 'immediate', pause_after: 3, submit_after: 6, slots_per_topic: 1 });
  const [topics, setTopics] = useState([]);
  const [chosen, setChosen] = useState({});
  useEffect(() => {
    if (!syls || !syls.length) return;
    if (!f.syllabus_id) setF((x) => ({ ...x, syllabus_id: syls[0].id }));
  }, [syls]);
  useEffect(() => {
    if (!f.syllabus_id) return;
    Api.get('/api/syllabi/' + f.syllabus_id).then((s) => { setTopics(s.topics); setChosen(Object.fromEntries(s.topics.map((t) => [t.id, true]))); }).catch(fail);
  }, [f.syllabus_id]);
  const setMode = (mode) => setF({ ...f, mode, max_attempts: mode === 'assessment' ? 1 : 0, show_results: mode === 'assessment' ? 'after_finish' : 'immediate', duration_min: mode === 'assessment' ? 60 : 0 });
  const create = async (e) => {
    e.preventDefault();
    try { const r = await Api.post('/api/sessions', { ...f, topic_ids: topics.filter((t) => chosen[t.id]).map((t) => t.id) }); onCreated(r.id); } catch (e2) { fail(e2); }
  };
  const num = (k) => (e) => setF({ ...f, [k]: +e.target.value });
  if (syls && syls.length === 0) return html`<div className="note">Upload a syllabus first (Syllabus tab) - the session's questions are generated from it.</div>`;
  return html`<form className="card" onSubmit=${create}>
    <h2>New session</h2>
    <div className="grid g2">
      <div><div className="field"><label>Session title</label><input style=${{ width: '100%' }} value=${f.title} onInput=${(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Lab 4 - Joins & Subqueries" /></div>
        <div className="field"><label>Syllabus</label><select style=${{ width: '100%' }} value=${f.syllabus_id} onChange=${(e) => setF({ ...f, syllabus_id: +e.target.value })}>${(syls || []).map((s) => html`<option key=${s.id} value=${s.id}>${s.title}</option>`)}</select></div>
        <label>Session type</label>
        <div className="grid g2">
          <div className=${'choice' + (f.mode === 'class' ? ' on' : '')} onClick=${() => setMode('class')}><b>📘 Normal class</b><div className="small muted">Normal browser, no lockdown. Same topics, test cases and automatic evaluation. Unlimited attempts, instant feedback.</div></div>
          <div className=${'choice' + (f.mode === 'assessment' ? ' on assessment' : '')} onClick=${() => setMode('assessment')}><b>🔒 Assessment</b><div className="small muted">Safe browser enforced: full screen, no tab switching, no outside paste, violations logged.</div></div>
        </div></div>
      <div>
        <label>Topics included</label>
        <div className="scroll" style=${{ maxHeight: 190, padding: 8 }}>${topics.map((t) => html`<label key=${t.id} style=${{ display: 'flex', gap: 8, color: 'inherit', fontSize: '.9rem', margin: '2px 0' }}>
          <input type="checkbox" checked=${!!chosen[t.id]} onChange=${(e) => setChosen({ ...chosen, [t.id]: e.target.checked })} /> ${t.name} <${Badge} kind=${t.difficulty}>${t.difficulty}<//></label>`)}</div>
        <div className="grid g3">
          <div><label>Questions per topic</label><select value=${f.slots_per_topic} onChange=${num('slots_per_topic')}><option value="1">1</option><option value="2">2</option><option value="3">3</option></select></div>
          <div><label>Time limit (min, 0 = none)</label><input type="number" min="0" value=${f.duration_min} onInput=${num('duration_min')} style=${{ width: '100%' }} /></div>
          <div><label>Attempts / question (0 = ∞)</label><input type="number" min="0" value=${f.max_attempts} onInput=${num('max_attempts')} style=${{ width: '100%' }} /></div>
        </div>
        <label>Show score & feedback</label><select value=${f.show_results} onChange=${(e) => setF({ ...f, show_results: e.target.value })}><option value="immediate">right after each submission</option><option value="after_finish">after the student submits the test</option></select>
        ${f.mode === 'assessment' && html`<div className="grid g2"><div><label>Auto-pause after N violations (0 = off)</label><input type="number" min="0" value=${f.pause_after} onInput=${num('pause_after')} style=${{ width: '100%' }} /></div>
          <div><label>Auto-submit after N violations (0 = off)</label><input type="number" min="0" value=${f.submit_after} onInput=${num('submit_after')} style=${{ width: '100%' }} /></div></div>`}
      </div></div>
    <button className="btn primary" style=${{ marginTop: 12 }}>Create session</button>
  </form>`;
}

/* ===================================================================== Session detail */
function SessionDetail({ id }) {
  const [s, reload, err] = useLoad(() => Api.get('/api/sessions/' + id), [id]);
  const [tab, setTab] = useState('questions');
  const [proj, setProj] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  usePoll(reload, s && (s.generation.running || s.status === 'live') ? 2500 : 8000, [id, s && s.status, s && s.generation.running]);
  if (err) return html`<div className="note bad">${err.message}</div>`;
  if (!s) return html`<${Spinner}/>`;
  const act = (p, msg, body) => () => { if (msg && !confirm(msg)) return; Api.post(`/api/sessions/${id}/${p}`, body).then(() => { reload(); toast('Done', 'ok'); }).catch(fail); };
  const approvedTotal = s.slots.reduce((a, x) => a + x.approved, 0);
  const minAvail = s.slots.length ? Math.min(...s.slots.map((x) => x.available)) : 0;

  return html`<div>
    <div className="row" style=${{ marginBottom: 8 }}><a href="#/sessions">← Sessions</a></div>
    <div className="card">
      <div className="row between"><div><h1>${s.title}</h1><div className="row"><${Badge} kind=${s.mode}>${s.mode === 'assessment' ? '🔒 Assessment (safe browser)' : 'Normal class (no lockdown)'}<//><${Badge} kind=${s.status}>${s.status.toUpperCase()}<//>
        ${s.duration_min > 0 && html`<span className="small muted">${s.duration_min} min</span>`}<span className="small muted">attempts: ${s.max_attempts || '∞'} · results: ${s.show_results === 'immediate' ? 'instant' : 'after test'}</span></div></div>
        <div className="row">
          ${s.status === 'draft' && html`<button className="btn primary" onClick=${() => setGenOpen(true)}>⚙ Generate question bank</button>`}
          ${s.status === 'live' && html`<button className="btn" onClick=${() => setGenOpen(true)}>+ More variants</button>`}
          ${s.status === 'draft' && html`<button className="btn ok" onClick=${act('broadcast', 'Broadcast now? Anyone with the session URL can join immediately.')}>📡 Broadcast session</button>`}
          ${s.status === 'live' && html`<button className="btn bad" onClick=${act('end', 'End the session? All unsubmitted tests are submitted automatically.')}>■ End session</button>`}
          ${s.status !== 'live' && html`<button className="btn" onClick=${() => { if (confirm('Delete this session and all its data?')) Api.del('/api/sessions/' + id).then(() => go('sessions')).catch(fail); }}>Delete</button>`}
        </div></div>
      <div className="grid g2" style=${{ marginTop: 12 }}>
        <div><div className="small muted">Session URL - generated for this session; works for everyone once you broadcast it (${s.status === 'draft' ? 'not live yet' : s.status})</div>
          <div className="urlbox">${s.join_urls[0]}</div>
          <div className="row" style=${{ marginTop: 6 }}><button className="btn sm" onClick=${() => copyText(s.join_urls[0])}>Copy URL</button><button className="btn sm primary" onClick=${() => setProj(true)}>📺 Show for the lab room</button></div>
          ${s.join_urls.length > 1 && html`<div className="small muted" style=${{ marginTop: 6 }}>Other addresses: ${s.join_urls.slice(1).map((u) => html`<div key=${u} className="mono">${u}</div>`)}</div>`}
          ${s.lockdown && html`<div className=${'note small' + (s.lockdown_strict ? ' ok' : '')} style=${{ marginTop: 8 }}>${s.lockdown_strict ? 'Strict mode: students must open this URL in the DBMS Lab Lockdown Browser.' : 'Browser lockdown is active for this assessment. For OS-level lockdown run students through the Electron lockdown browser (see README) or set LOCKDOWN_STRICT=true.'}</div>`}</div>
        <div className="row" style=${{ justifyContent: 'flex-end' }}>
          <img className="qr" src=${s.qr} alt="QR code of the session URL" />
          <div className="grid g2" style=${{ textAlign: 'center' }}>
            <div className="stat"><b>${s.participants}</b><span>joined</span></div><div className="stat"><b>${approvedTotal}</b><span>approved questions</span></div>
            <div className="stat"><b>${s.questions.pending}</b><span>awaiting review</span></div><div className="stat"><b>${minAvail}</b><span>spare / topic</span></div></div></div>
      </div>
      ${s.generation.running && html`<div className="note info" style=${{ marginTop: 10 }}>⚙ AI is generating & validating questions… ${s.generation.done}/${s.generation.total}<div className="bar"><i style=${{ width: (s.generation.done / Math.max(1, s.generation.total)) * 100 + '%' }}></i></div></div>`}
      ${!s.generation.running && s.generation.errors && s.generation.errors.length > 0 && html`<div className="note bad small" style=${{ marginTop: 10 }}>Generation notes: ${s.generation.errors.slice(0, 3).join(' · ')}</div>`}
      ${s.status === 'live' && minAvail < 3 && s.slots.length > 0 && html`<div className="note small" style=${{ marginTop: 10 }}>Only ${minAvail} unassigned approved variant(s) left for some topic. Generate more variants so every student gets a unique question.</div>`}
    </div>
    <div className="tabs">${[['questions', 'Questions & test cases'], ['monitor', 'Live monitor'], ['submissions', 'Submissions & review'], ['analytics', 'Analytics & metrics'], ['violations', 'Violation log']].map(([k, l]) => html`<button key=${k} className=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div>
    ${tab === 'questions' && html`<${QuestionsTab} sid=${id} session=${s} reloadSession=${reload} />`}
    ${tab === 'monitor' && html`<${MonitorTab} sid=${id} session=${s} />`}
    ${tab === 'submissions' && html`<${SubmissionsTab} sid=${id} />`}
    ${tab === 'analytics' && html`<${AnalyticsTab} sid=${id} />`}
    ${tab === 'violations' && html`<${ViolationsTab} sid=${id} />`}
    ${genOpen && html`<${GenModal} session=${s} onClose=${() => setGenOpen(false)} onStart=${(per) => { Api.post(`/api/sessions/${id}/generate`, { per_topic: per }).then(() => { setGenOpen(false); reload(); }).catch(fail); }} />`}
    ${proj && html`<${Modal} title=${s.title} onClose=${() => setProj(false)}><div style=${{ textAlign: 'center' }}>
      <p className="muted">Join the ${s.mode === 'assessment' ? 'assessment' : 'lab class'} - open this address on your lab computer${s.status !== 'live' ? ' (opens when the instructor broadcasts)' : ''}</p>
      <div className="urlbox big-url">${s.join_urls[0]}</div><p style=${{ fontSize: '1.4rem' }}>Session code: <b className="mono">${s.token}</b></p><img className="big-qr" style=${{ imageRendering: 'pixelated' }} src=${s.qr} /></div><//>`}
  </div>`;
}

function GenModal({ session, onClose, onStart }) {
  const [per, setPer] = useState(30);
  const slots = session.slots.length;
  return html`<${Modal} title="Generate question bank" small=${true} onClose=${onClose}>
    <p className="muted">The AI creates equivalent variants (same concept & difficulty, different wording, schema and data) for each topic, validates them (answerable, right difficulty) and prepares visible + hidden test cases. Everything stays <b>pending</b> until you approve it.</p>
    <div className="field"><label>Variants per topic question (at least the number of students you expect, so nobody shares a question)</label><input type="number" min="1" max="80" value=${per} onInput=${(e) => setPer(+e.target.value)} /></div>
    <p className="small muted">${slots} question slot(s) × ${per} = ${slots * per} questions. Students register themselves when they open the session URL.</p>
    <button className="btn primary" onClick=${() => onStart(per)}>Start generation</button><//>`;
}

/* ---------------------------------------------------------------- questions & test cases */
function QuestionsTab({ sid, session, reloadSession }) {
  const [rows, reload] = useLoad(() => Api.get(`/api/sessions/${sid}/questions`), [sid]);
  const [flt, setFlt] = useState({ topic: '', status: '' });
  const [open, setOpen] = useState(null);
  usePoll(reload, 4000, [sid]);
  if (!rows) return html`<${Spinner}/>`;
  const topics = [...new Set(rows.map((r) => r.topic))];
  const shown = rows.filter((r) => (!flt.topic || r.topic === flt.topic) && (!flt.status || r.status === flt.status));
  const bulk = (action) => {
    const ids = shown.filter((r) => (action === 'approve' ? r.status === 'pending' : action === 'delete' ? r.status === 'rejected' && !r.assigned_to : true)).map((r) => r.id);
    if (!ids.length) return toast('Nothing to do for this filter');
    Api.post(`/api/sessions/${sid}/questions/bulk`, { action, ids }).then((r) => { toast(`${r.done} question(s) ${action}d${r.errors.length ? ' - ' + r.errors[0] : ''}`, r.errors.length ? 'bad' : 'ok'); reload(); reloadSession(); }).catch(fail);
  };
  return html`<div>
    <div className="card"><h3>Question slots</h3><div className="scroll" style=${{ maxHeight: 220 }}><table><thead><tr><th>Topic</th><th>Concept template</th><th>Total</th><th>Approved</th><th>Pending</th><th>Assigned</th><th>Spare</th></tr></thead><tbody>
      ${session.slots.map((x, i) => html`<tr key=${i}><td>${x.topic}${session.slots_per_topic > 1 ? ` (Q${x.slot + 1})` : ''}</td><td className="mono small">${x.template}</td><td>${x.total}</td><td>${x.approved}</td><td>${x.pending}</td><td>${x.assigned}</td><td>${x.available}</td></tr>`)}</tbody></table></div></div>
    <div className="card">
      <div className="row between"><div className="row"><select value=${flt.topic} onChange=${(e) => setFlt({ ...flt, topic: e.target.value })}><option value="">All topics</option>${topics.map((t) => html`<option key=${t}>${t}</option>`)}</select>
        <select value=${flt.status} onChange=${(e) => setFlt({ ...flt, status: e.target.value })}><option value="">Any status</option><option>pending</option><option>approved</option><option>rejected</option></select><span className="muted small">${shown.length} shown</span></div>
        <div className="row"><button className="btn ok" onClick=${() => bulk('approve')}>✔ Approve all pending${flt.topic ? ' (filtered)' : ''}</button><button className="btn" onClick=${() => bulk('delete')}>Delete rejected</button></div></div>
      <p className="muted small" style=${{ margin: '6px 0' }}>Review each variant: open it to read the question, check the reference solution and every visible/hidden test case, edit, rate its equivalence, then approve. Only approved questions and approved test cases are used for students and grading.</p>
      <div className="scroll"><table><thead><tr><th>#</th><th>Topic</th><th>Theme</th><th>Level</th><th>Status</th><th>Tests</th><th>Rating</th><th>Assigned to</th><th>Question</th></tr></thead><tbody>
      ${shown.map((r) => html`<tr key=${r.id} className="click" onClick=${() => setOpen(r.id)}><td>${r.id}${r.version > 1 ? html`<span className="small muted"> v${r.version}</span>` : ''}</td><td>${r.topic}</td><td>${r.theme}${r.source === 'ai-llm' ? ' 🤖' : ''}</td>
        <td><${Badge} kind=${r.difficulty}>${r.difficulty}<//></td><td><${Badge} kind=${r.status}>${r.status}<//></td><td>${r.tests_approved}/${r.tests}</td><td>${r.rating ? '★'.repeat(r.rating) : '—'}</td><td>${r.assigned_name || '—'}</td>
        <td className="small">${r.text.length > 110 ? r.text.slice(0, 110) + '…' : r.text}</td></tr>`)}</tbody></table></div></div>
    ${open && html`<${QuestionModal} qid=${open} onClose=${() => { setOpen(null); reload(); reloadSession(); }} />`}</div>`;
}

function QuestionModal({ qid, onClose }) {
  const [q, reload, err] = useLoad(() => Api.get('/api/questions/' + qid), [qid]);
  const [edit, setEdit] = useState(null);
  const [custom, setCustom] = useState('');
  useEffect(() => { if (q && !edit) setEdit({ text: q.text, solution_sql: q.solution_sql, check_sql: q.check_sql || '', ordered: !!q.ordered }); }, [q]);
  if (err) return html`<${Modal} title="Question" onClose=${onClose}><div className="note bad">${err.message}</div><//>`;
  if (!q || !edit) return html`<${Modal} title="Question" onClose=${onClose}><${Spinner}/><//>`;
  const locked = !!q.assigned_to;
  const act = (p, body, msg) => Api.post(`/api/questions/${qid}/${p}`, body).then(() => { if (msg) toast(msg, 'ok'); setEdit(null); reload(); }).catch(fail);
  const save = () => Api.put('/api/questions/' + qid, { ...edit, check_sql: edit.check_sql || null }).then(() => { toast('Saved - new version created, test case answers recomputed, status reset to pending', 'ok'); setEdit(null); reload(); }).catch(fail);
  const rate = (n) => Api.put('/api/questions/' + qid, { rating: n }).then(() => { setEdit(null); reload(); }).catch(fail);
  const tc = (t, body) => Api.patch('/api/testcases/' + t.id, body).then(reload).catch(fail);
  return html`<${Modal} title=${`Question #${q.id} · ${q.topic} · v${q.version}`} onClose=${onClose}>
    <div className="row"><${Badge} kind=${q.status}>${q.status}<//><${Badge} kind=${q.difficulty}>${q.difficulty}<//><span className="small muted">theme: ${q.theme} · source: ${q.source} · template: ${q.template_key}</span>${locked && html`<${Badge} kind="submitted">assigned<//>`}</div>
    <div className="note small" style=${{ margin: '8px 0' }}>Validation: ${q.validation.answerable ? '✔ answerable on all datasets' : '✖'} · complexity ${q.validation.complexity} (estimated <b>${q.validation.estimated_difficulty}</b>, declared <b>${q.validation.declared_difficulty}</b>${q.validation.difficulty_consistent ? ' ✔' : ' ⚠ differ'})
      ${q.validation.mutation ? ` · test-case mutation score ${q.validation.mutation.rate}% (${q.validation.mutation.killed}/${q.validation.mutation.valid})` : ''}</div>
    <div className="field"><label>Question text shown to the student</label><textarea rows="3" value=${edit.text} disabled=${locked} onInput=${(e) => setEdit({ ...edit, text: e.target.value })}></textarea></div>
    <div className="grid g2"><div className="field"><label>Reference solution (hidden from students)</label><textarea rows="4" className="mono" value=${edit.solution_sql} disabled=${locked} onInput=${(e) => setEdit({ ...edit, solution_sql: e.target.value })}></textarea></div>
      <div><div className="field"><label>Check query (DML / DDL / view questions)</label><textarea rows="2" className="mono" value=${edit.check_sql} disabled=${locked} onInput=${(e) => setEdit({ ...edit, check_sql: e.target.value })}></textarea></div>
        <label style=${{ display: 'flex', gap: 8, color: 'inherit' }}><input type="checkbox" checked=${edit.ordered} disabled=${locked} onChange=${(e) => setEdit({ ...edit, ordered: e.target.checked })} /> Row order matters</label></div></div>
    <div className="row" style=${{ margin: '6px 0 12px' }}>
      <button className="btn primary" onClick=${save} disabled=${locked}>Save edits</button>
      <button className="btn ok" onClick=${() => act('approve', {}, 'Approved with all its test cases')}>✔ Approve</button>
      <button className="btn bad" onClick=${() => act('reject', {}, 'Rejected')}>✖ Reject</button>
      <button className="btn" onClick=${() => act('reset', {}, 'Back to pending')}>Back to pending</button>
      <button className="btn" disabled=${locked} onClick=${() => confirm('Replace with a freshly generated variant?') && act('regenerate', {}, 'Regenerated')}>↻ Regenerate</button>
      <span className="grow"></span><span className="small muted">Equivalence rating (same learning objective & difficulty?)</span>
      ${[1, 2, 3, 4, 5].map((n) => html`<button key=${n} className=${'btn sm' + (q.rating >= n ? ' warn' : '')} onClick=${() => rate(n)}>★</button>`)}</div>
    <h3>Schema</h3><pre>${q.schema_sql}</pre>
    <div className="row between"><h3>Test cases (${q.test_cases.length})</h3><div className="row"><button className="btn sm" onClick=${() => act('testcases', { kind: 'hidden' }, 'AI test case added (pending)')}>+ AI hidden test</button>
      <button className="btn sm" onClick=${() => act('testcases', { kind: 'visible' }, 'AI test case added (pending)')}>+ AI visible test</button></div></div>
    ${q.test_cases.map((t, i) => html`<details key=${t.id} style=${{ border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px', marginBottom: 6 }}>
      <summary><b>#${i + 1}</b> <select value=${t.kind} onClick=${(e) => e.stopPropagation()} onChange=${(e) => tc(t, { kind: e.target.value })}><option>visible</option><option>hidden</option></select>
        <${Badge} kind=${t.status}>${t.status}<//> <span className="small muted">expected ${t.expected.total} row(s)</span>
        <button className="btn sm" onClick=${(e) => { e.preventDefault(); tc(t, { status: 'approved' }); }}>approve</button><button className="btn sm" onClick=${(e) => { e.preventDefault(); tc(t, { status: 'rejected' }); }}>reject</button>
        <button className="btn sm" onClick=${(e) => { e.preventDefault(); if (confirm('Delete test case?')) Api.del('/api/testcases/' + t.id).then(reload).catch(fail); }}>delete</button></summary>
      <div className="grid g2"><div><div className="small muted">Test data</div><pre style=${{ maxHeight: 180 }}>${t.data_sql}</pre></div><div><div className="small muted">Expected result</div><${ResultTable} data=${t.expected} /></div></div></details>`)}
    <details><summary>Add your own test dataset (INSERT statements for this schema)</summary><textarea rows="5" className="mono" value=${custom} onInput=${(e) => setCustom(e.target.value)} placeholder="INSERT INTO ... ;"></textarea>
      <button className="btn sm" disabled=${!custom.trim()} onClick=${() => Api.post(`/api/questions/${qid}/testcases`, { kind: 'hidden', data_sql: custom }).then(() => { setCustom(''); toast('Custom test case added (pending)', 'ok'); reload(); }).catch(fail)}>Add as hidden test</button></details>
    <h3 style=${{ marginTop: 12 }}>Version history</h3><div className="small">${q.versions.map((v) => html`<div key=${v.version + v.changed_at}>v${v.version} · ${when(v.changed_at)} · ${v.changed_by}</div>`)}</div>
  <//>`;
}

/* ---------------------------------------------------------------- live monitor */
function MonitorTab({ sid, session }) {
  const [m, reload] = useLoad(() => Api.get(`/api/sessions/${sid}/monitor`), [sid]);
  usePoll(reload, 3000, [sid]);
  if (!m) return html`<${Spinner}/>`;
  const act = (uid, a) => Api.post(`/api/sessions/${sid}/participants/${uid}/${a}`, {}).then(reload).catch(fail);
  return html`<div className="grid g2" style=${{ gridTemplateColumns: '2fr 1fr' }}>
    <div className="card"><h3>Students in this session (${m.participants.length})</h3>
      ${m.participants.length === 0 ? html`<p className="muted">Nobody has joined yet.</p>` : html`<div className="scroll"><table><thead><tr><th>Student</th><th>State</th><th>Progress</th>${session.mode === 'assessment' ? html`<th>Violations</th>` : null}<th>Last seen</th><th></th></tr></thead><tbody>
      ${m.participants.map((p) => html`<tr key=${p.user_id} style=${p.violations > 0 ? { background: '#fff6f6' } : null}><td><b>${p.name}</b><div className="small muted">${p.username}</div></td>
        <td><${Badge} kind=${p.status}>${p.status}<//> ${p.status !== 'submitted' && html`<${Badge} kind=${p.online ? 'online' : 'offline'}>${p.online ? 'online' : 'offline'}<//>`}</td>
        <td>${p.answered}/${p.questions}</td>${session.mode === 'assessment' ? html`<td>${p.violations > 0 ? html`<${Badge} kind="flag">⚑ ${p.violations}<//>` : '0'} ${p.notices > 0 && html`<span className="small muted">+${p.notices} notices</span>`}</td>` : null}
        <td className="small">${ago(p.last_seen)}</td>
        <td className="row">${p.status === 'paused' && html`<button className="btn sm ok" onClick=${() => act(p.user_id, 'resume')}>Resume</button>`}
          ${p.status === 'active' && session.mode === 'assessment' && html`<button className="btn sm" onClick=${() => act(p.user_id, 'pause')}>Pause</button>`}
          ${p.status !== 'submitted' && html`<button className="btn sm" onClick=${() => confirm('Submit ' + p.name + "'s test now?") && act(p.user_id, 'submit')}>Submit</button>`}</td></tr>`)}</tbody></table></div>`}</div>
    <div className="card"><h3>Latest violations</h3>${session.mode !== 'assessment' ? html`<p className="muted small">Normal class - lockdown is off, nothing is monitored.</p>` : m.recent_violations.length === 0 ? html`<p className="muted">None so far 🎉</p>` : html`<div className="scroll" style=${{ maxHeight: 420 }}>
      ${m.recent_violations.map((v) => html`<div key=${v.id} style=${{ padding: '4px 0', borderBottom: '1px solid var(--line)' }}><b>${v.name}</b> <${Badge} kind=${v.severity}>${v.severity}<//><div className="small">${VIO_LABEL[v.type] || v.type} <span className="muted">· ${clock(v.ts)}</span></div></div>`)}</div>`}</div></div>`;
}

/* ---------------------------------------------------------------- submissions & dual evaluation */
function SubmissionsTab({ sid }) {
  const [rows, reload] = useLoad(() => Api.get(`/api/sessions/${sid}/submissions`), [sid]);
  const [only, setOnly] = useState(false);
  const [open, setOpen] = useState(null);
  usePoll(reload, 6000, [sid]);
  if (!rows) return html`<${Spinner}/>`;
  const shown = rows.filter((r) => !only || (r.flagged && r.teacher_score === null));
  return html`<div className="card"><div className="row between"><h3>Submissions (${rows.length})</h3>
    <label style=${{ display: 'flex', gap: 6, color: 'inherit' }}><input type="checkbox" checked=${only} onChange=${(e) => setOnly(e.target.checked)} /> only flagged for my review (${rows.filter((r) => r.flagged && r.teacher_score === null).length})</label></div>
    <p className="muted small">AI evaluates first. Borderline, timed-out, possibly hard-coded or violation-affected answers are flagged for you. Open one to read the SQL and override the score.</p>
    <div className="scroll"><table><thead><tr><th>Student</th><th>Topic</th><th>Try</th><th>AI score</th><th>Final</th><th>Result</th><th>Flag</th><th>Time</th></tr></thead><tbody>
    ${shown.map((r) => html`<tr key=${r.id} className="click" onClick=${() => setOpen(r.id)}><td>${r.name}</td><td>${r.topic}</td><td>${r.attempt_no}${r.auto ? ' (auto)' : ''}</td><td>${r.ai_score}%</td>
      <td><b>${r.final_score}%</b> ${r.teacher_score !== null && html`<${Badge} kind="submitted">teacher<//>`}</td><td className="small">${r.passed}/${r.total} · ${ERR_LABEL[r.error_category] || r.error_category}</td>
      <td>${r.flagged && r.teacher_score === null ? html`<${Badge} kind="flag" >⚑ review<//>` : ''}</td><td className="small">${clock(r.created_at)}</td></tr>`)}</tbody></table></div>
    ${open && html`<${ReviewModal} id=${open} onClose=${() => { setOpen(null); reload(); }} />`}</div>`;
}

function ReviewModal({ id, onClose }) {
  const [s] = useLoad(() => Api.get('/api/submissions/' + id), [id]);
  const [score, setScore] = useState('');
  const [comment, setComment] = useState('');
  useEffect(() => { if (s) { setScore(s.teacher_score ?? ''); setComment(s.teacher_comment || ''); } }, [s]);
  if (!s) return html`<${Modal} title="Submission" onClose=${onClose}><${Spinner}/><//>`;
  const save = (v) => Api.put(`/api/submissions/${id}/review`, { teacher_score: v, comment }).then(() => { toast('Review saved', 'ok'); onClose(); }).catch(fail);
  return html`<${Modal} title=${`${s.student.name} - submission #${s.id}`} onClose=${onClose}>
    ${s.flagged ? html`<div className="note bad small">⚑ Flagged: ${s.flag_reason}</div>` : null}
    <p><b>Question:</b> ${s.question.text}</p>
    <div className="grid g2"><div><h3>Student SQL</h3><pre>${s.sql_text || '(empty)'}</pre></div><div><h3>Reference solution</h3><pre>${s.question.solution_sql}</pre></div></div>
    <div className="row"><b>AI score: ${s.ai_score}%</b><span className="muted">${s.passed}/${s.total} tests · ${s.eval_ms} ms · ${ERR_LABEL[s.error_category] || s.error_category}</span></div>
    <div className="note small" style=${{ margin: '8px 0' }}>${s.feedback.summary}${s.feedback.ai ? ' 🤖 ' + s.feedback.ai : ''}</div>
    ${s.results.map((r, i) => html`<div key=${i} style=${{ marginBottom: 6 }}><b>${r.kind} test ${i + 1}</b> <${Badge} kind=${r.status}>${r.status}<//> ${r.error ? html`<span className="small mono">${r.error}</span>` : ''}
      ${r.status !== 'pass' && r.expected && html`<div className="grid g2"><div><div className="small muted">expected</div><${ResultTable} data=${r.expected} max=${6} /></div><div><div className="small muted">actual</div>${r.actual ? html`<${ResultTable} data=${r.actual} max=${6} />` : null}</div></div>`}</div>`)}
    <h3>Teacher override</h3>
    <div className="row"><input type="number" min="0" max="100" placeholder="score %" value=${score} onInput=${(e) => setScore(e.target.value)} style=${{ width: 110 }} />
      <input className="grow" placeholder="comment for the student (optional)" value=${comment} onInput=${(e) => setComment(e.target.value)} />
      <button className="btn primary" disabled=${score === ''} onClick=${() => save(+score)}>Save override</button>
      <button className="btn" onClick=${() => save(s.ai_score)}>Confirm AI score</button>
      ${s.teacher_score !== null && html`<button className="btn" onClick=${() => save(null)}>Clear override</button>`}</div><//>`;
}

/* ---------------------------------------------------------------- analytics & metrics */
function Bars({ items, max }) {
  const m = max || Math.max(1, ...items.map((i) => i.value));
  return html`<div>${items.map((i) => html`<div key=${i.label} style=${{ margin: '5px 0' }}><div className="row between small"><span>${i.label}</span><b>${i.text ?? i.value}</b></div><div className="bar"><i style=${{ width: (i.value / m) * 100 + '%' }}></i></div></div>`)}</div>`;
}

function MetricsPanel({ m }) {
  const g = m.grading_accuracy, t = m.test_case_effectiveness, f = m.question_fairness, e = m.evaluation_time;
  return html`<div>
    <h2>Performance evaluation metrics</h2>
    <div className="grid g2">
      <div className="card"><h3>1 · SQL grading accuracy</h3><div className="row"><div className="stat"><b>${pct(g.agreement_pct)}</b><span>AI vs teacher agreement</span></div><div className="stat"><b>${g.mean_abs_difference ?? '—'}</b><span>mean abs. difference (pts)</span></div><div className="stat"><b>${g.reviewed}</b><span>reviewed</span></div></div><p className="small muted">${g.note}</p></div>
      <div className="card"><h3>2 · Test-case effectiveness</h3><div className="row"><div className="stat"><b>${pct(t.mutation_kill_pct)}</b><span>injected mistakes caught</span></div><div className="stat"><b>${pct(t.detection_pct)}</b><span>teacher-confirmed wrong answers detected</span></div></div><p className="small muted">${t.note}</p></div>
      <div className="card"><h3>3 · Question equivalence / fairness</h3><div className="row"><div className="stat"><b>${f.mean_rating ?? '—'}${f.mean_rating ? '/5' : ''}</b><span>teacher rating (${f.rated} rated)</span></div></div>
        <div className="scroll" style=${{ maxHeight: 200, marginTop: 6 }}><table><thead><tr><th>Group</th><th>Variants</th><th>Rating</th><th>Complexity spread</th><th>Score σ</th></tr></thead><tbody>${f.groups.map((x) => html`<tr key=${x.group}><td>${x.group}</td><td>${x.variants}</td><td>${x.teacher_rating ?? '—'}</td><td>${x.complexity_spread}</td><td>${x.score_std ?? '—'}</td></tr>`)}</tbody></table></div></div>
      <div className="card"><h3>4 · Evaluation time reduction</h3><div className="row"><div className="stat"><b>${pct(e.reduction_pct)}</b><span>time saved</span></div><div className="stat"><b>${e.manual_minutes_estimate}</b><span>manual min (est.)</span></div><div className="stat"><b>${e.automatic_minutes}</b><span>automatic min</span></div><div className="stat"><b>${e.avg_eval_ms ?? '—'}</b><span>ms / submission</span></div></div><p className="small muted">${e.note}</p></div>
    </div></div>`;
}

function AnalyticsTab({ sid }) {
  const [a, reload] = useLoad(() => Api.get(`/api/sessions/${sid}/analytics`), [sid]);
  const [busy, setBusy] = useState(false);
  usePoll(reload, 8000, [sid]);
  if (!a) return html`<${Spinner}/>`;
  const t = a.totals;
  const runEff = async () => { setBusy(true); try { const r = await Api.post(`/api/sessions/${sid}/effectiveness`, {}); toast(`Mutation check finished for ${r.length} questions`, 'ok'); reload(); } catch (e) { fail(e); } finally { setBusy(false); } };
  return html`<div>
    <div className="grid g4"><div className="card stat"><b>${t.participants}</b><span>students</span></div><div className="card stat"><b>${t.average_score ?? '—'}%</b><span>average score</span></div>
      <div className="card stat"><b>${t.flagged_pending}</b><span>flagged to review</span></div><div className="card stat"><b>${t.violations}</b><span>lockdown events</span></div></div>
    <div className="grid g3">
      <div className="card"><h3>Score distribution</h3><${Bars} items=${a.score_distribution.map((d) => ({ label: d.label + '%', value: d.count }))} /></div>
      <div className="card"><h3>Average score by topic</h3><${Bars} max=${100} items=${a.topic_scores.map((d) => ({ label: d.topic, value: d.average || 0, text: (d.average ?? 0) + '%' }))} />${a.topic_scores.length === 0 && html`<p className="muted small">No submissions yet.</p>`}</div>
      <div className="card"><h3>Common errors</h3>${a.common_errors.length ? html`<${Bars} items=${a.common_errors.map((d) => ({ label: ERR_LABEL[d.category] || d.category, value: d.count }))} />` : html`<p className="muted small">No errors yet.</p>`}
        ${a.violation_types.length > 0 && html`<h3 style=${{ marginTop: 12 }}>Lockdown events</h3><${Bars} items=${a.violation_types.map((d) => ({ label: VIO_LABEL[d.type] || d.type, value: d.n }))} />`}</div></div>
    <div className="card"><div className="row between"><h3>Students</h3><div className="row"><button className="btn" disabled=${busy} onClick=${runEff}>${busy ? 'Testing…' : '🧪 Run test-case effectiveness check'}</button>
      <a className="btn" href=${`/api/sessions/${sid}/export.csv?token=${Api.token}`}>⬇ Export scores (CSV)</a></div></div>
      <div className="scroll"><table><thead><tr><th>Student</th><th>State</th><th>Answered</th><th>Score</th><th>Violations</th><th>To review</th></tr></thead><tbody>
      ${a.students.map((s) => html`<tr key=${s.user_id}><td>${s.name}</td><td><${Badge} kind=${s.status}>${s.status}<//></td><td>${s.answered}/${s.questions}</td><td><b>${s.score}%</b></td><td>${s.violations}</td><td>${s.flagged}</td></tr>`)}</tbody></table></div></div>
    <${MetricsPanel} m=${a.metrics} /></div>`;
}

function ViolationsTab({ sid }) {
  const [rows, reload] = useLoad(() => Api.get(`/api/sessions/${sid}/violations`), [sid]);
  const [who, setWho] = useState('');
  usePoll(reload, 5000, [sid]);
  if (!rows) return html`<${Spinner}/>`;
  const names = [...new Set(rows.map((r) => r.name))];
  const shown = rows.filter((r) => !who || r.name === who);
  return html`<div className="card"><div className="row between"><h3>Lockdown browser violation log</h3><select value=${who} onChange=${(e) => setWho(e.target.value)}><option value="">All students</option>${names.map((n) => html`<option key=${n}>${n}</option>`)}</select></div>
    ${shown.length === 0 ? html`<p className="muted">No violations recorded.</p>` : html`<div className="scroll"><table><thead><tr><th>Timestamp</th><th>Student</th><th>Event</th><th>Severity</th><th>Detail</th></tr></thead><tbody>
    ${shown.map((r) => html`<tr key=${r.id}><td className="small mono">${new Date(r.ts).toLocaleString()}</td><td>${r.name}</td><td>${VIO_LABEL[r.type] || r.type}</td><td><${Badge} kind=${r.severity}>${r.severity}<//></td><td className="small">${r.detail}</td></tr>`)}</tbody></table></div>`}</div>`;
}

/* ===================================================================== Overall metrics */
function MetricsView() {
  const [d] = useLoad(() => Api.get('/api/analytics/overview'), []);
  return d ? html`<${MetricsPanel} m=${d.metrics} />` : html`<${Spinner}/>`;
}

/* ===================================================================== App shell */
function App() {
  const [user] = useState(Api.token && Api.user && Api.user.role === 'instructor' ? Api.user : null);
  const [r, setR] = useState(route());
  const [ov, reloadOv] = useLoad(() => Api.get('/api/overview'), []);
  usePoll(reloadOv, 5000, []);
  useEffect(() => { const f = () => setR(route()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  useEffect(() => { if (!user) location.href = '/'; }, []);
  if (!user) return null;
  const page = r[0];
  const nav = [['sessions', 'Sessions'], ['syllabus', 'Syllabus'], ['metrics', 'Metrics']];
  return html`<div>
    <div className="topbar"><span className="brand">🗄️ Virtual DBMS Lab</span>
      <nav>${nav.map(([k, l]) => html`<a key=${k} href=${'#/' + k} className=${page === k || (k === 'sessions' && page === 'session') ? 'active' : ''}>${l}</a>`)}</nav>
      ${ov && html`<span className="who">👥 ${ov.students} student${ov.students === 1 ? '' : 's'} registered</span>`}
      ${ov && html`<span className="who">AI: ${ov.ai.model}</span>`}
      <span className="who">${user.name}</span><a href="#" className="out" onClick=${(e) => { e.preventDefault(); Api.clear(); location.href = '/'; }}>Log out</a></div>
    <div className="wrap">
      ${ov && ov.live.length > 0 && page !== 'session' && html`<div className="note ok" style=${{ marginBottom: 12 }}>Live now: ${ov.live.map((l) => html`<a key=${l.id} href=${'#/session/' + l.id} style=${{ marginRight: 12 }}>${l.title} (${l.mode})</a>`)}</div>`}
      ${page === 'sessions' && html`<${SessionsView}/>`}${page === 'session' && html`<${SessionDetail} key=${r[1]} id=${r[1]} />`}
      ${page === 'syllabus' && html`<${SyllabusView}/>`}${page === 'metrics' && html`<${MetricsView}/>`}
    </div><${Toaster}/></div>`;
}
ReactDOM.createRoot(document.getElementById('root')).render(html`<${App}/>`);
