'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, globalShortcut, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const sysinfo = require('./sysinfo');

let win = null;
let tray = null;
let timer = null;
let lastSnap = null;
let paused = false;
let quitting = false;

const HOTKEY = 'CommandOrControl+Shift+Escape';

/* ---------- tiny persisted settings ---------- */
/* backgroundOnClose defaults to false: like the Windows original, closing the
 * window quits the app completely — no tray, no resident processes, zero
 * resources. The tray mode is opt-in from Settings. */
const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');
const settings = { backgroundOnClose: false };
function loadSettings() {
  try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8'))); } catch { /* first run */ }
}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(settings, null, 2)); } catch { /* non fatal */ }
}

function snapshotNow() {
  try {
    lastSnap = sysinfo.sample();
    if (win && !win.isDestroyed()) win.webContents.send('sys:snapshot', lastSnap);
  } catch (e) {
    console.error('sample failed', e);
  }
}

/* ---------- window (frameless: the in-app titlebar is the only one) ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 480,
    frame: false,
    title: 'Task Manager',
    backgroundColor: '#202020',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  const pushMax = () => { if (win && !win.isDestroyed()) win.webContents.send('win:maximized', win.isMaximized()); };
  win.on('maximize', pushMax);
  win.on('unmaximize', pushMax);
  win.on('close', (e) => {
    if (quitting) { stopPolling(); win = null; return; }
    if (settings.backgroundOnClose && tray) { e.preventDefault(); win.hide(); stopPolling(); }
    // default (native behaviour): let the window close — window-all-closed quits
  });
  win.on('closed', () => { win = null; });
}

/* Ctrl+Shift+Esc — mirrors the Windows behaviour of summoning Task Manager */
function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  if (!timer) startPolling(); // window was hidden to tray (or freshly created)
  win.show();
  win.focus();
  if (typeof win.moveTop === 'function') { try { win.moveTop(); } catch { /* unsupported */ } }
  snapshotNow(); // refresh immediately so the restored window is never stale
}

function quitAndExit() {
  quitting = true;
  if (tray) { tray.destroy(); tray = null; }
  app.quit();
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(path.join(__dirname, 'assets', 'icon.png'));
    tray.setToolTip('Task Manager — Ctrl+Shift+Esc');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Task Manager', click: showWindow },
      { type: 'separator' },
      { label: 'Quit Task Manager', click: quitAndExit },
    ]));
    tray.on('click', showWindow);
  } catch (e) {
    console.warn('tray unavailable:', e.message);
  }
}
function destroyTray() { if (tray) { tray.destroy(); tray = null; } }

/* ---------- global hotkey ---------- *
 * The reliable, native way to own Ctrl+Shift+Esc on a GNOME session (X11 or
 * Wayland) is a desktop-level keybinding: GNOME's settings daemon handles the
 * key at the compositor, so it works whether or not the app is running, and it
 * can never be lost. We install it idempotently into gsettings when packaged.
 * Electron's globalShortcut stays as the fallback for other desktops.        */
const KB_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const KB_DIR = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/task-manager/';
const KB_FULL = KB_SCHEMA + '.custom-keybinding:' + KB_DIR;
let hotkeyMethod = 'none'; // 'gnome' | 'electron' | 'none'

function gsettings(args, cb) {
  execFile('gsettings', args, { timeout: 4000 }, (err, stdout) => cb(err, (stdout || '').trim()));
}

const gvStr = (s) => "'" + String(s).replace(/'/g, "\\'") + "'"; // GVariant string literal
function installGnomeHotkey(done) {
  if (!app.isPackaged) return done(false); // dev runs shouldn't own the system key
  // The system binding must outlive this run: AppImages execute from a /tmp
  // extraction dir, so prefer the stable installed binary when it exists.
  let bin = process.execPath;
  const installed = '/opt/Task Manager/task-manager-replica';
  if (bin.startsWith('/tmp/') && fs.existsSync(installed)) bin = installed;
  const exec = '"' + bin + '"'; // kept quoted for g_shell_parse when GNOME runs it
  gsettings(['get', KB_SCHEMA, 'custom-keybindings'], (err, cur) => {
    if (err) return done(false);
    // parse the GVariant array of paths: ['a', 'b'] (or an empty @as [])
    const list = (String(cur).match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1));
    if (!list.includes(KB_DIR)) list.push(KB_DIR);
    const arr = '[' + list.map((p) => "'" + p + "'").join(', ') + ']';
    const steps = [
      (cb) => gsettings(['set', KB_SCHEMA, 'custom-keybindings', arr], cb),
      (cb) => gsettings(['set', KB_FULL, 'name', gvStr('Task Manager')], cb),
      (cb) => gsettings(['set', KB_FULL, 'binding', gvStr('<Control><Shift>Escape')], cb),
      (cb) => gsettings(['set', KB_FULL, 'command', gvStr(exec)], cb),
      (cb) => gsettings(['get', KB_FULL, 'binding'], (e, out) =>
        cb(e || (String(out).replace(/^'|'$/g, '') !== '<Control><Shift>Escape'
          ? new Error('binding verify failed') : null))),
    ];
    let i = 0, fail = null;
    const run = (e) => {
      if (e && !fail) fail = e;
      if (fail || i >= steps.length) return done(!fail);
      steps[i++](run);
    };
    run(null);
  });
}

function registerHotkey() {
  installGnomeHotkey((ok) => {
    if (ok) {
      hotkeyMethod = 'gnome';
      console.log('hotkey: registered via GNOME keybindings');
      return;
    }
    // fallback for non-GNOME desktops: Electron's own grab
    try {
      const registered = globalShortcut.register(HOTKEY, showWindow);
      hotkeyMethod = registered ? 'electron' : 'none';
      if (!registered) console.warn('Ctrl+Shift+Esc is already grabbed by another application');
    } catch (e) {
      hotkeyMethod = 'none';
      console.warn('global hotkey failed:', e.message);
    }
  });
}

function startPolling() {
  if (timer) clearInterval(timer);
  lastSnap = sysinfo.sample(); // prime deltas
  timer = setInterval(() => {
    // no point sampling while nobody is looking
    if (paused || !win || win.isDestroyed() || !win.isVisible()) return;
    snapshotNow();
  }, 1000);
}
function stopPolling() { if (timer) { clearInterval(timer); timer = null; } }

// ---- IPC ----
ipcMain.handle('sys:initial', () => {
  paused = false;
  if (!lastSnap) lastSnap = sysinfo.sample();
  return { snap: lastSnap, ncpu: lastSnap.ncpu };
});
ipcMain.on('sys:paused', (_e, p) => { paused = !!p; });

ipcMain.handle('proc:kill', (_e, pid, force) => {
  return new Promise((resolve) => {
    sysinfo.endTask(pid, force ? 'SIGKILL' : 'SIGTERM', (err) =>
      resolve(err ? { ok: false, error: err.code === 'ESRCH' ? 'Process already exited' : err.message } : { ok: true }));
  });
});

ipcMain.handle('sys:services', () => new Promise((res) => sysinfo.listServices((e, l) => res(e ? { ok: false, error: e.message } : { ok: true, list: l }))));
ipcMain.handle('svc:action', (_e, unit, action) => new Promise((res) => sysinfo.serviceAction(unit, action, (err) => res(err ? { ok: false, error: err.message } : { ok: true }))));

ipcMain.handle('sys:startup', () => new Promise((res) => sysinfo.listStartup((e, l) => res(e ? { ok: false, error: e.message } : { ok: true, list: l }))));
ipcMain.handle('startup:set', (_e, base, enable) => new Promise((res) => sysinfo.setStartupState(base, enable, (err) => res(err ? { ok: false, error: err.message } : { ok: true }))));

ipcMain.handle('sys:appHistory', () => ({ ok: true, list: sysinfo.appHistory() }));
ipcMain.handle('sys:users', () => ({ ok: true, list: sysinfo.listUsers(lastSnap || sysinfo.sample()) }));

ipcMain.handle('proc:icon', (_e, name) => sysinfo.iconForProcess(name));

// Run new task
ipcMain.handle('run:task', async (_e, cmd) => {
  if (!cmd || typeof cmd !== 'string' || !cmd.trim()) return { ok: false, error: 'No command' };
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec(cmd.trim(), { detached: true, stdio: 'ignore', shell: true, env: process.env })
      .unref?.();
    // exec returns child immediately; consider success if spawn didn't throw synchronously
    setTimeout(() => resolve({ ok: true }), 150);
  });
});

// window buttons (frameless titlebar)
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.on('win:close', () => win && win.close());
ipcMain.handle('win:isMaximized', () => (win ? win.isMaximized() : false));

ipcMain.handle('app:paths', () => ({ home: os.homedir() }));

// background / hotkey settings
ipcMain.handle('settings:get', () => ({ ...settings, hotkey: 'Ctrl+Shift+Esc', hotkeyMethod, platform: process.platform }));
ipcMain.handle('settings:set', (_e, patch) => {
  if (patch && typeof patch.backgroundOnClose === 'boolean') {
    settings.backgroundOnClose = patch.backgroundOnClose;
    if (patch.backgroundOnClose) createTray(); else destroyTray();
  }
  saveSettings();
  return { ...settings };
});

// Windows Task Manager only ever runs once — and a second instance would
// also steal the Ctrl+Shift+Esc registration from the first.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    loadSettings();
    createWindow();
    startPolling();
    if (settings.backgroundOnClose) createTray();
    registerHotkey();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { createWindow(); startPolling(); } });
  });
}

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
