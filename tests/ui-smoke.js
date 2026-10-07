process.env.DATA_DIR = require('fs').mkdtempSync('/tmp/uidata-');
process.env.HIDDEN_TESTCASES = '2';
const { JSDOM, VirtualConsole } = require('jsdom');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let base, errors = [];
async function api(method, url, body, token) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(url + ' ' + JSON.stringify(j)); return j;
}
async function page(path, storage) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(path + ' JSDOMERR ' + (e.detail && e.detail.stack || e.message).slice(0, 400)));
  vc.on('error', (...a) => errors.push(path + ' console.error ' + a.join(' ').slice(0, 300)));
  const dom = await JSDOM.fromURL(base + path, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(u, base).href, o);
      w.FormData = FormData;
      for (const [k, v] of Object.entries(storage || {})) w.localStorage.setItem(k, v);
      w.document.createRange = () => ({ setStart() {}, setEnd() {}, getBoundingClientRect: () => ({ right: 0, left: 0, top: 0, bottom: 0 }), getClientRects: () => [], commonAncestorContainer: w.document.body });
      w.HTMLElement.prototype.scrollIntoView = () => {};
      const strict = path.startsWith('/s/'); w.confirm = () => { if (strict) errors.push('NATIVE confirm() on student page - would break full screen'); return true; }; w.prompt = () => { if (strict) errors.push('NATIVE prompt() on student page'); return ''; }; w.alert = () => { if (strict) errors.push('NATIVE alert() on student page'); };
      w.Element.prototype.getClientRects = () => [];
    },
  });
  await sleep(1200);
  return dom;
}
const text = (d) => d.window.document.body.textContent.replace(/\s+/g, ' ');
async function waitFor(d, re, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(text(d))) return true; await sleep(250); } return false; }
function click(d, pred) { const els = [...d.window.document.querySelectorAll('button,a,tr,summary')]; const el = els.find(pred); if (!el) return false; el.dispatchEvent(new d.window.MouseEvent('click', { bubbles: true })); return true; }
const has = (d, label) => click(d, (e) => e.textContent.trim().startsWith(label));
const ok = (c, m) => { console.log((c ? '  ok - ' : '  FAIL - ') + m); if (!c) errors.push('check failed: ' + m); };

(async () => {
  const server = await start(0); base = 'http://127.0.0.1:' + server.address().port;
  const I = (await api('POST', '/api/auth/login', { username: 'instructor', password: 'instructor123' })).token;
  const iu = JSON.stringify({ id: 1, username: 'instructor', name: 'Course Instructor', role: 'instructor' });
  const syl = await api('POST', '/api/syllabi', { title: 'UI', text: require('fs').readFileSync(__dirname + '/../samples/syllabus_dbms.txt', 'utf8') }, I);
  const { id } = await api('POST', '/api/sessions', { title: 'UI assessment', syllabus_id: syl.id, topic_ids: syl.topics.slice(0, 3).map((t) => t.id), mode: 'assessment' }, I);
  await api('POST', `/api/sessions/${id}/generate`, { per_topic: 3 }, I);
  for (let i = 0; i < 60; i++) { if (!(await api('GET', '/api/sessions/' + id, null, I)).generation.running) break; await sleep(300); }
  const sess = await api('GET', '/api/sessions/' + id, null, I); const token = sess.join_urls[0].split('/s/')[1];

  console.log('[index]'); let d = await page('/');
  ok(/Virtual DBMS Laboratory/.test(text(d)) && /Log in/.test(text(d)), 'login page renders'); d.window.close();

  console.log('[instructor]');
  d = await page('/instructor#/sessions', { dbmslab_token: I, dbmslab_user: iu });
  ok(await waitFor(d, /UI assessment/), 'sessions list shows the session');
  for (const [lbl, re] of [['Syllabus', /Upload syllabus/], ['Metrics', /Performance evaluation metrics/]]) { has(d, lbl); ok(await waitFor(d, re, 5000), lbl + ' view renders'); }
  d.window.location.hash = '#/session/' + id; ok(await waitFor(d, /Question slots/), 'session detail renders (URL + slots)');
  ok(text(d).includes('/s/' + token), 'generated session URL visible'); ok(/Broadcast session/.test(text(d)), 'broadcast button visible');
  ok(/Assessment \(safe browser\)/.test(text(d)), 'assessment mode badge');
  has(d, '✔ Approve all pending'); await sleep(1500);
  ok(await waitFor(d, /approved/), 'bulk approve works from UI');
  click(d, (e) => e.tagName === 'TR' && e.className === 'click'); ok(await waitFor(d, /Reference solution/, 5000), 'question review modal opens');
  ok(/Test cases \(/.test(text(d)) && /hidden/.test(text(d)), 'test cases listed in review modal');
  click(d, (e) => e.textContent === '✕'); await sleep(300);
  has(d, '📡 Broadcast session'); await sleep(1500); ok(await waitFor(d, /LIVE/, 5000), 'session broadcast from UI');
  has(d, 'Live monitor'); ok(await waitFor(d, /Nobody has joined yet/, 4000), 'live monitor tab');
  has(d, 'Analytics & metrics'); ok(await waitFor(d, /SQL grading accuracy/, 5000), 'analytics + metrics tab');
  has(d, 'Violation log'); ok(await waitFor(d, /No violations recorded/, 4000), 'violation log tab');

  console.log('[student]');
  const s = await page('/s/' + token, {});
  s.window.document.documentElement.requestFullscreen = async () => {};
  ok(await waitFor(s, /Register to join/), 'session page shows registration (students register only here)');
  ok(!/Instructor/.test(text(s)), 'no instructor/teacher options on the student page');
  const setVal = (el, v) => { Object.getOwnPropertyDescriptor(s.window.HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new s.window.Event('input', { bubbles: true })); };
  const inputs = [...s.window.document.querySelectorAll('form.authbox input')];
  ok(inputs.length === 3, 'register form: name, roll number, password');
  setVal(inputs[0], 'Asha Rao'); setVal(inputs[1], '1ms21cs001'); setVal(inputs[2], 'pw1234');
  has(s, 'Register & continue');
  ok(await waitFor(s, /Secure assessment rules/), 'registered -> lockdown gate shown for assessment');
  const S = s.window.localStorage.getItem('dbmslab_token');
  has(s, 'I understand'); ok(await waitFor(s, /Questions/, 8000) && await waitFor(s, /Your SQL/, 8000), 'exam screen after joining');
  ok(/ASSESSMENT - secure mode/.test(text(s)), 'secure-mode bar');
  ok(s.window.document.body.classList.contains('lockdown'), 'lockdown active (body class)');
  ok(!!s.window.document.querySelector('.CodeMirror'), 'SQL editor (CodeMirror) mounted');
  const q = (await api('POST', `/api/play/${token}/join`, {}, S)).questions[0];
  const sol = (await api('GET', '/api/questions/' + q.id, null, I)).solution_sql;
  const cm = s.window.document.querySelector('.CodeMirror').CodeMirror; cm.setValue('SELECT 1'); await sleep(200);
  has(s, '▶ Run'); ok(await waitFor(s, /Sample test cases/, 6000) && /Failed/.test(text(s)) && /some test cases failed/.test(text(s)), 'Run with a wrong query shows sample test cases as Failed');
  cm.setValue(sol); await sleep(200);
  has(s, '▶ Run'); ok(await waitFor(s, /all test cases passed/, 6000) && /Successful/.test(text(s)), 'Run with the right query shows sample test cases as Successful');
  ok(/Hidden test cases are checked when you submit/.test(text(s)), 'hint about hidden test cases');
  // submit: in-page confirmation, then in-page result pop-up, never a native dialog, never leaving lockdown
  has(s, 'Submit answer'); ok(await waitFor(s, /Submit this answer\?/, 3000) && !!s.window.document.querySelector('.modal'), 'submit asks for confirmation inside the window (in-page dialog)');
  [...s.window.document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Submit answer').dispatchEvent(new s.window.MouseEvent('click', { bubbles: true }));
  ok(await waitFor(s, /Answer submitted/, 8000), 'result pop-up shown inside the window after submitting');
  ok(/Hidden test 3/.test(text(s)) && /Successful/.test(text(s)), 'pop-up lists hidden/sample test cases as successful');
  [...s.window.document.querySelectorAll('.modal button')].find((b) => b.textContent.includes('OK, continue')).dispatchEvent(new s.window.MouseEvent('click', { bubbles: true }));
  await sleep(500);
  ok(s.window.document.body.classList.contains('lockdown'), 'still in secure mode after submitting an answer');
  let mon = await api('GET', `/api/sessions/${id}/monitor`, null, I);
  ok(mon.participants[0].violations === 0, 'submitting an answer is NOT flagged as a violation');
  // a real tab switch is still caught
  Object.defineProperty(s.window.document, 'hidden', { value: true, configurable: true });
  s.window.document.dispatchEvent(new s.window.Event('visibilitychange')); await sleep(1500);
  Object.defineProperty(s.window.document, 'hidden', { value: false, configurable: true });
  mon = await api('GET', `/api/sessions/${id}/monitor`, null, I);
  ok(mon.participants[0].violations >= 1, 'tab switch reported to instructor (' + mon.participants[0].violations + ')');
  ok(/Violation recorded/.test(text(s)), 'student sees violation warning');
  // final submission is the only way out
  has(s, 'Submit test'); ok(await waitFor(s, /Final submission/, 3000), 'final submission asks inside the window');
  [...s.window.document.querySelectorAll('.modal button')].find((b) => b.textContent.includes('Yes, submit the test')).dispatchEvent(new s.window.MouseEvent('click', { bubbles: true }));
  ok(await waitFor(s, /Test submitted/, 8000), 'final submission completes');
  ok(!s.window.document.body.classList.contains('lockdown'), 'lockdown released only after the final submission');
  const cnt = (await api('GET', '/api/overview', null, I)).students;
  ok(cnt === 1, 'instructor overview shows student count only (' + cnt + ')');
  d.window.location.hash = '#/sessions'; await sleep(600);
  ok(!/Add student/.test(text(d)), 'instructor UI has no student management');
  ok(/1 student registered/.test(text(d)) || (await waitFor(d, /1 student registered/, 9000)), 'dashboard shows how many students registered');
  console.log(errors.length ? '\nERRORS:\n' + errors.join('\n') : '\nUI smoke OK');
  server.close(); process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
