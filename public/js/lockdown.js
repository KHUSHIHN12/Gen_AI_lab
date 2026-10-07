/* Lockdown layer (assessment sessions only).
 * In any browser: full-screen enforcement, tab-switch / window-blur / minimise detection, blocked shortcuts, no outside paste,
 * no context menu, no drag & drop, navigation traps, dev-tools heuristic, server-side violation log with timestamps.
 * In the Electron "DBMS Lab Lockdown Browser" (window.lockdownAPI) the OS-level part is enforced by the app itself
 * (kiosk mode, always-on-top, shortcut blocking) and its events are forwarded to the same violation log.
 */
const Lockdown = (() => {
  const S = { active: false, report: null, editor: null, internalClip: '', last: {}, timers: [], fsLost: false, onFs: null };
  const isElectron = () => !!window.lockdownAPI;

  const fire = (type, detail, minGap = 1500) => {
    if (!S.active) return;
    const now = Date.now();
    if (S.last[type] && now - S.last[type] < minGap) return;
    // tab switch + blur + hidden are usually one physical action: report only the first
    if (['tab_switch', 'window_blur'].includes(type) && now - (S.last.__phys || 0) < 1500) return;
    if (['tab_switch', 'window_blur'].includes(type)) S.last.__phys = now;
    S.last[type] = now;
    S.report(type, detail);
  };

  const BLOCK_KEYS = (e) => {
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (k === 'f12' || k === 'f5' || k === 'f11' || k === 'printscreen') return true;
    if (e.altKey && (k === 'arrowleft' || k === 'arrowright' || k === 'tab' || k === 'f4')) return true;
    if (k === 'meta' || k === 'os') return true;
    if (mod && ['r', 'u', 's', 'p', 't', 'n', 'w', 'l', 'o', 'f', 'g', 'h', 'j', 'd', 'e'].includes(k)) return true;
    if (mod && e.shiftKey && ['i', 'j', 'c', 'n', 't', 'r', 'delete'].includes(k)) return true;
    return false;
  };

  const on = (target, ev, fn, opts) => {
    target.addEventListener(ev, fn, opts);
    S.timers.push(() => target.removeEventListener(ev, fn, opts));
  };

  function start({ report, onFullscreenState }) {
    if (S.active) return;
    S.active = true; S.report = report; S.onFs = onFullscreenState;
    document.body.classList.add('lockdown');

    on(document, 'visibilitychange', () => { if (document.hidden) fire('tab_switch', 'page hidden (tab switch or minimise)'); });
    on(window, 'blur', () => fire('window_blur', 'window lost focus'));
    on(document, 'fullscreenchange', () => {
      if (isElectron()) return;
      const lost = !document.fullscreenElement;
      S.fsLost = lost;
      if (lost) fire('fullscreen_exit', 'left full-screen mode', 800);
      if (S.onFs) S.onFs(lost);
    });
    on(document, 'copy', () => { S.internalClip = (S.editor && S.editor.hasFocus() ? S.editor.getSelection() : '') || ''; }, true);
    on(document, 'cut', () => { S.internalClip = (S.editor && S.editor.hasFocus() ? S.editor.getSelection() : '') || ''; }, true);
    on(document, 'paste', (e) => {
      const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
      // only text that was copied from inside the editor may be pasted
      if (!text || text.replace(/\r/g, '') !== S.internalClip.replace(/\r/g, '')) {
        e.preventDefault(); e.stopPropagation();
        fire('external_paste', `blocked paste of ${text.length} characters from outside`, 600);
      }
    }, true);
    on(document, 'drop', (e) => { e.preventDefault(); fire('drop_attempt', 'drag & drop blocked'); }, true);
    on(document, 'dragover', (e) => e.preventDefault(), true);
    on(document, 'contextmenu', (e) => { e.preventDefault(); fire('context_menu', 'right-click blocked', 3000); });
    on(document, 'keydown', (e) => {
      if (BLOCK_KEYS(e)) {
        e.preventDefault(); e.stopPropagation();
        fire('blocked_shortcut', `${e.ctrlKey ? 'Ctrl+' : ''}${e.metaKey ? 'Meta+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.key}`, 2000);
      }
    }, true);
    on(window, 'beforeunload', (e) => { if (S.active) { e.preventDefault(); e.returnValue = ''; } });
    on(window, 'beforeprint', () => fire('blocked_shortcut', 'print attempt', 3000));
    // back-button trap
    history.pushState({ lock: 1 }, '', location.href);
    on(window, 'popstate', () => { history.pushState({ lock: 1 }, '', location.href); fire('blocked_shortcut', 'browser back button', 2000); });
    // dev-tools heuristic (docked dev tools shrink the viewport)
    const t = setInterval(() => {
      if (isElectron()) return;
      if (window.outerWidth - window.innerWidth > 220 || window.outerHeight - window.innerHeight > 260) fire('devtools', 'dev tools / split view suspected', 20000);
    }, 3000);
    S.timers.push(() => clearInterval(t));
    // events coming from the Electron lockdown browser
    if (isElectron() && window.lockdownAPI.onViolation) window.lockdownAPI.onViolation((v) => fire(v.type, v.detail, 800));
  }

  function stop() {
    S.active = false;
    S.timers.splice(0).forEach((f) => f());
    document.body.classList.remove('lockdown');
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  }

  async function enterFullscreen() {
    if (isElectron()) return true;
    const el = document.documentElement;
    try { await (el.requestFullscreen || el.webkitRequestFullscreen).call(el); return true; } catch { return false; }
  }

  return { start, stop, enterFullscreen, isElectron, setEditor: (cm) => { S.editor = cm; }, isActive: () => S.active };
})();
