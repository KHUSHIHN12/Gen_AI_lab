'use strict';
/* DBMS Lab Lockdown Browser (Electron).
 * Opens ONE assessment URL in a kiosk window: full screen, always on top, no menu, no dev tools, no navigation away from the lab server,
 * blocked browser shortcuts, clipboard wiped, screen-capture protection. Window-focus loss / full-screen exit / blocked keys /
 * extra monitors are forwarded to the web page, which logs them (with timestamp) on the instructor dashboard.
 * The window can only be closed by the page itself once the test is submitted or the instructor ended the session.
 *
 * Usage:   npm install && npm start -- http://<server-ip>:3000/s/<code>
 *          (without a URL a small launcher asks for it)
 * Env:     LOCKDOWN_SECRET must equal the server's LOCKDOWN_SECRET when the server runs with LOCKDOWN_STRICT=true.
 */
const { app, BrowserWindow, globalShortcut, session, ipcMain, clipboard, screen, Menu } = require('electron');
const path = require('path');

const SECRET = process.env.LOCKDOWN_SECRET || 'dbms-lab-lockdown-secret';
let targetUrl = process.argv.find((a) => /^https?:\/\//i.test(a)) || process.env.LAB_URL || '';
let win = null;
let launcher = null;
let allowExit = false;
let origin = '';

const BLOCK = (i) => {
  const k = (i.key || '').toLowerCase();
  const mod = i.control || i.meta;
  if (['f5', 'f11', 'f12', 'printscreen'].includes(k)) return true;
  if (i.alt && ['f4', 'arrowleft', 'arrowright', 'tab'].includes(k)) return true;
  if (mod && ['r', 'u', 's', 'p', 't', 'n', 'w', 'l', 'o', 'f', 'g', 'h', 'j', 'd', 'e', 'q'].includes(k)) return true;
  if (mod && i.shift && ['i', 'j', 'c', 'n', 't', 'r'].includes(k)) return true;
  return false;
};

function notify(type, detail) {
  if (win && !win.isDestroyed()) win.webContents.send('violation', { type, detail });
}

function openLockdown(url) {
  origin = new URL(url).origin;
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    fullscreen: true, kiosk: true, alwaysOnTop: true, frame: false, show: false, autoHideMenuBar: true, backgroundColor: '#0f172a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false, spellcheck: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true); // no screenshots / screen sharing of the exam window (Windows & macOS)
  win.setMenu(null);

  // identify as the lockdown browser to the lab server (only for requests to the lab server)
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [origin + '/*'] }, (details, cb) => {
    details.requestHeaders['X-Lockdown-Client'] = SECRET;
    cb({ requestHeaders: details.requestHeaders });
  });
  // never load anything outside the lab server
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    cb({ cancel: !(u.startsWith(origin) || u.startsWith('devtools:') || u.startsWith('data:') || u.startsWith('blob:')) });
  });
  win.webContents.on('will-navigate', (e, navUrl) => {
    if (!navUrl.startsWith(origin)) { e.preventDefault(); notify('navigation_attempt', navUrl.slice(0, 80)); }
  });
  win.webContents.setWindowOpenHandler(() => { notify('navigation_attempt', 'new window blocked'); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && BLOCK(input)) {
      e.preventDefault();
      notify('blocked_shortcut', `${input.control ? 'Ctrl+' : ''}${input.meta ? 'Meta+' : ''}${input.alt ? 'Alt+' : ''}${input.shift ? 'Shift+' : ''}${input.key}`);
    }
  });
  win.on('blur', () => {
    if (allowExit) return;
    notify('window_blur', 'lockdown window lost focus');
    clipboard.clear();
    setTimeout(() => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } }, 150);
  });
  win.on('leave-full-screen', () => { if (!allowExit) { notify('fullscreen_exit', 'left full screen'); win.setFullScreen(true); } });
  win.on('minimize', () => { if (!allowExit) { notify('tab_switch', 'window minimised'); win.restore(); } });
  win.on('close', (e) => { if (!allowExit) e.preventDefault(); });
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  win.loadURL(url);

  clipboard.clear();
  const watch = setInterval(() => {
    if (!win || win.isDestroyed()) return clearInterval(watch);
    if (screen.getAllDisplays().length > 1) notify('multiple_displays', 'a second display is connected');
    if (!win.isFocused() && !allowExit) win.focus();
  }, 4000);
  // swallow OS-level shortcuts that Electron can intercept
  ['CommandOrControl+Shift+Esc', 'F11', 'Alt+F4', 'CommandOrControl+W'].forEach((acc) => { try { globalShortcut.register(acc, () => notify('blocked_shortcut', acc)); } catch {} });
}

function openLauncher() {
  launcher = new BrowserWindow({ width: 560, height: 330, resizable: false, title: 'DBMS Lab Lockdown Browser', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
  launcher.setMenu(null);
  launcher.loadFile(path.join(__dirname, 'launcher.html'));
}

ipcMain.on('launch', (e, url) => {
  try { new URL(url); } catch { return; }
  if (launcher && !launcher.isDestroyed()) launcher.close();
  openLockdown(url);
});
ipcMain.on('allow-exit', () => { allowExit = true; if (win && !win.isDestroyed()) { win.setKiosk(false); win.setAlwaysOnTop(false); } });
ipcMain.on('quit', () => { allowExit = true; app.quit(); });

app.whenReady().then(() => {
  if (targetUrl) openLockdown(targetUrl);
  else openLauncher();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (allowExit || !win) app.quit(); });
