'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, globalShortcut, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sysinfo = require('./sysinfo');

let win = null;
let tray = null;
let timer = null;
let lastSnap = null;
let paused = false;
let quitting = false;

const HOTKEY = 'CommandOrControl+Shift+Escape';

/* ---------- tiny persisted settings (tray behaviour) ---------- */
const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');
const settings = { backgroundOnClose: true };
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

/* ---------- window ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 480,
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
  win.on('close', (e) => {
    if (quitting) { if (timer) { clearInterval(timer); timer = null; } win = null; return; }
    if (settings.backgroundOnClose) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
  win.on('hide', () => {});
}

/* Ctrl+Shift+Esc — mirrors the Windows behaviour of summoning Task Manager */
function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
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

function registerHotkey() {
  try {
    const ok = globalShortcut.register(HOTKEY, showWindow);
    if (!ok) console.warn('Ctrl+Shift+Esc is already grabbed by another application');
  } catch (e) {
    console.warn('global hotkey failed:', e.message);
  }
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

// window buttons
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.on('win:close', () => win && win.close());
ipcMain.handle('win:isMaximized', () => (win ? win.isMaximized() : false));

ipcMain.handle('app:paths', () => ({ home: os.homedir() }));

// background / hotkey settings
ipcMain.handle('settings:get', () => ({ ...settings, hotkey: 'Ctrl+Shift+Esc', platform: process.platform }));
ipcMain.handle('settings:set', (_e, patch) => {
  if (patch && typeof patch.backgroundOnClose === 'boolean') settings.backgroundOnClose = patch.backgroundOnClose;
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
    createTray();
    registerHotkey();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) { createWindow(); startPolling(); } });
  });
}

// fallback: Ctrl+Shift+Esc while the window already has focus
app.on('browser-window-focus', () => {
  if (!win) return;
  win.webContents.on('before-input-event', function handler(_e, input) {
    if (!win) return win.webContents.removeListener('before-input-event', handler);
    if (input.type === 'keyDown' && input.control && input.shift && input.code === 'Escape') showWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
