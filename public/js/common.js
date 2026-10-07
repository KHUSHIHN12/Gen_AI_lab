/* Shared helpers: React + htm (no build step), API client, small UI components. */
const html = htm.bind(React.createElement);
const { useState, useEffect, useRef, useCallback, useMemo } = React;

const Api = {
  get token() { try { return localStorage.getItem('dbmslab_token'); } catch { return null; } },
  set(token, user) { try { localStorage.setItem('dbmslab_token', token); localStorage.setItem('dbmslab_user', JSON.stringify(user)); } catch {} },
  clear() { try { localStorage.removeItem('dbmslab_token'); localStorage.removeItem('dbmslab_user'); } catch {} },
  get user() { try { return JSON.parse(localStorage.getItem('dbmslab_user')); } catch { return null; } },
  async call(method, url, body, isForm) {
    const headers = {};
    if (Api.token) headers.Authorization = 'Bearer ' + Api.token;
    if (body && !isForm) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText);
      err.status = res.status; err.code = data && data.code; err.body = data;
      if (res.status === 401 && !/\/auth\/login/.test(url)) { Api.clear(); if (!window.__noRedirect) location.href = '/'; }
      throw err;
    }
    return data;
  },
  get: (u) => Api.call('GET', u), post: (u, b) => Api.call('POST', u, b || {}), put: (u, b) => Api.call('PUT', u, b || {}),
  patch: (u, b) => Api.call('PATCH', u, b || {}), del: (u) => Api.call('DELETE', u),
};

/* ---- toasts */
let toastSet = null;
function toast(msg, kind) { if (toastSet) { toastSet({ msg, kind }); setTimeout(() => toastSet && toastSet(null), 4200); } }
function Toaster() {
  const [t, setT] = useState(null);
  useEffect(() => { toastSet = setT; return () => { toastSet = null; }; }, []);
  return t ? html`<div className=${'toast ' + (t.kind || '')}>${t.msg}</div>` : null;
}
const fail = (e) => toast(e.message || String(e), 'bad');

/* ---- hooks */
function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const reload = useCallback(() => fn().then((d) => { setData(d); setErr(null); return d; }).catch((e) => { setErr(e); }), deps);
  useEffect(() => { reload(); }, [reload]);
  return [data, reload, err];
}
function usePoll(fn, ms, deps) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let stop = false;
    const tick = () => { if (!stop) Promise.resolve(ref.current()).catch(() => {}); };
    const id = setInterval(tick, ms);
    return () => { stop = true; clearInterval(id); };
  }, deps || []);
}

/* ---- components */
const Badge = ({ kind, children }) => html`<span className=${'badge ' + (kind || '')}>${children}</span>`;
const Spinner = ({ text }) => html`<p className="muted">${text || 'Loading…'}</p>`;

function Modal({ title, onClose, small, children }) {
  return html`<div className="overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}>
    <div className=${'modal' + (small ? ' sm' : '')}>
      <div className="row between"><h2>${title}</h2>${onClose && html`<button className="btn sm" onClick=${onClose}>✕</button>`}</div>
      ${children}
    </div></div>`;
}

function ResultTable({ data, max }) {
  if (!data || !data.columns) return null;
  const rows = data.rows.slice(0, max || 50);
  return html`<div className="scroll" style=${{ maxHeight: 260 }}><table className="resgrid">
    <thead><tr>${data.columns.map((c, i) => html`<th key=${i}>${c}</th>`)}</tr></thead>
    <tbody>${rows.map((r, i) => html`<tr key=${i}>${r.map((v, j) => html`<td key=${j}>${v === null ? html`<i className="muted">NULL</i>` : String(v)}</td>`)}</tr>`)}
    ${rows.length === 0 && html`<tr><td colSpan=${Math.max(1, data.columns.length)} className="muted">(no rows)</td></tr>`}</tbody></table>
    ${data.total > rows.length || data.truncated ? html`<div className="small muted" style=${{ padding: 4 }}>showing first ${rows.length} of ${data.total ?? '200+'} rows</div>` : null}</div>`;
}

function copyText(text) {
  const done = () => toast('Copied to clipboard', 'ok');
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => fallback());
  else fallback();
  function fallback() { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch {} t.remove(); }
}
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '—');
const pct = (n) => (n === null || n === undefined ? '—' : n + '%');
const ago = (iso) => { if (!iso) return '—'; const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; };

/* ---- In-page confirm dialog (never use window.confirm in the exam: native dialogs break full screen) */
function ConfirmDialog({ dlg, onClose }) {
  if (!dlg) return null;
  const done = (v) => { onClose(); dlg.res(v); };
  return html`<${Modal} title=${dlg.title} small=${true}>
    <p style=${{ whiteSpace: 'pre-line' }}>${dlg.msg}</p>
    <div className="dialog-actions">
      ${dlg.cancelText !== null && html`<button className="btn" onClick=${() => done(false)}>${dlg.cancelText || 'Cancel'}</button>`}
      <button className=${'btn ' + (dlg.danger ? 'bad' : 'primary')} autoFocus onClick=${() => done(true)}>${dlg.okText || 'OK'}</button>
    </div><//>`;
}
function useConfirm() {
  const [dlg, setDlg] = useState(null);
  const ask = useCallback((title, msg, opts) => new Promise((res) => setDlg({ title, msg, res, ...(opts || {}) })), []);
  const node = html`<${ConfirmDialog} dlg=${dlg} onClose=${() => setDlg(null)} />`;
  return [ask, node];
}

/* ---- login / register box. Students register ONLY from a session page (session = session code). */
function AuthBox({ onDone, roleHint, title, session, canRegister }) {
  const [mode, setMode] = useState(session && canRegister ? 'register' : 'login');
  const [f, setF] = useState({ username: '', password: '', name: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      window.__noRedirect = true;
      const r = await Api.post(mode === 'login' ? '/api/auth/login' : '/api/auth/register', { ...f, session });
      Api.set(r.token, r.user); onDone(r.user);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); window.__noRedirect = false; }
  };
  const reg = mode === 'register';
  return html`<form className="card authbox" onSubmit=${submit}>
    <h2>${title || (reg ? 'Register to join' : 'Log in')}</h2>
    ${roleHint && html`<p className="muted small">${roleHint}</p>`}
    ${reg && html`<div className="field"><label>Full name</label><input value=${f.name} onInput=${set('name')} style=${{ width: '100%' }} required /></div>`}
    <div className="field"><label>${session ? 'Roll number / username' : 'Username'}</label><input value=${f.username} onInput=${set('username')} style=${{ width: '100%' }} autoCapitalize="none" required /></div>
    <div className="field"><label>Password</label><input type="password" value=${f.password} onInput=${set('password')} style=${{ width: '100%' }} required /></div>
    ${err && html`<div className="note bad small" style=${{ marginBottom: 8 }}>${err}</div>`}
    <div className="row between">
      <button className="btn primary" disabled=${busy}>${reg ? 'Register & continue' : 'Log in'}</button>
      ${session && canRegister && html`<a href="#" className="small" onClick=${(e) => { e.preventDefault(); setMode(reg ? 'login' : 'register'); setErr(''); }}>${reg ? 'Already registered? Log in' : 'First time? Register'}</a>`}
    </div></form>`;
}
