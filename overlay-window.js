/**
 * iRaceHUD · overlay-window.js
 *
 * Electron shell that floats overlay.html over the sim as a true in-game
 * overlay: a full-screen, transparent, always-on-top, click-through window —
 * the same architecture RaceLabs-style tools use. Each HUD card is its own
 * widget inside it (drag / resize / hide in edit mode). The shell also
 * spawns agent.js alongside itself, so one command boots the whole stack:
 *
 *   npx electron overlay-window.js           → LIVE (reads iRacing shared memory)
 *   npx electron overlay-window.js --demo    → DEMO (synthetic car)
 *
 * iRacing must run in BORDERLESS WINDOWED mode; exclusive fullscreen paints
 * over every OS window, including this one.
 *
 * Global hotkeys:
 *   Ctrl+Shift+Q      quit overlay + agent
 *   Ctrl+Shift+M      edit mode on/off — drag widgets, resize via the yellow
 *                     corner, hide with ✕, restore from the top toolbar
 *   Ctrl+Shift+ + / - zoom the whole HUD
 */
'use strict';

const { app, BrowserWindow, globalShortcut, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const demoMode = process.argv.includes('--demo');

// Dedicated profile dir — the default (%AppData%\Electron) is shared by every
// unpackaged Electron app and triggers "Unable to move the cache" noise.
app.setPath('userData', path.join(app.getPath('appData'), 'iRaceHUD'));

let win = null;
let agentProc = null;
let editMode = false;
let zoom = 1;

const stateFile = () => path.join(app.getPath('userData'), 'overlay-state.json');

function loadShellState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); }
  catch { return {}; }
}

function saveShellState() {
  try { fs.writeFileSync(stateFile(), JSON.stringify({ zoom })); }
  catch { /* best effort */ }
}

function startAgent() {
  // Spawn under real node, not Electron's runtime — irsdk-node is a native
  // module built against the node ABI.
  const args = [path.join(__dirname, 'agent.js')];
  if (demoMode) args.push('--demo');
  agentProc = spawn('node', args, { stdio: 'inherit' });
  agentProc.on('exit', (code) => {
    // A non-zero exit usually means another agent already owns port 8080 —
    // the overlay just connects to that one instead, so keep running.
    if (code !== 0) console.log('[overlay] agent exited (code ' + code + ') — reusing any agent already on ws://localhost:8080');
    agentProc = null;
  });
  agentProc.on('error', () => {
    console.log('[overlay] could not spawn node — start agent.js manually');
    agentProc = null;
  });
}

function setEditMode(on) {
  editMode = on;
  win.setIgnoreMouseEvents(!editMode, { forward: true });
  win.webContents.executeJavaScript(`window.__setEditMode(${editMode})`).catch(() => {});
  console.log(editMode
    ? '[overlay] EDIT MODE — drag widgets, yellow corner resizes, ✕ hides. Ctrl+Shift+M (or DONE) locks it.'
    : '[overlay] locked — clicks pass through to the sim');
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  zoom = loadShellState().zoom ?? 1;

  win = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    fullscreenable: false,
    skipTaskbar: false,               // keep a taskbar icon as a visible handle
    title: 'iRaceHUD Overlay',
    webPreferences: { backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');          // float above borderless games
  win.setIgnoreMouseEvents(true, { forward: true }); // clicks pass through to the sim
  win.loadFile(path.join(__dirname, 'overlay.html'));
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(zoom));

  // The overlay's DONE button says "lock me" by logging a token — no IPC
  // preload needed for a one-way signal.
  win.webContents.on('console-message', (_e, _level, message) => {
    if (String(message).includes('__IRACEHUD_LOCK__') && editMode) setEditMode(false);
  });
}

app.whenReady().then(() => {
  startAgent();
  createWindow();

  globalShortcut.register('Control+Shift+Q', () => app.quit());
  globalShortcut.register('Control+Shift+M', () => setEditMode(!editMode));
  globalShortcut.register('Control+Shift+Plus', () => {
    zoom = Math.min(1.6, +(zoom + 0.1).toFixed(2));
    win.webContents.setZoomFactor(zoom);
    saveShellState();
  });
  globalShortcut.register('Control+Shift+-', () => {
    zoom = Math.max(0.6, +(zoom - 0.1).toFixed(2));
    win.webContents.setZoomFactor(zoom);
    saveShellState();
  });

  console.log('[overlay] iRaceHUD floating (' + (demoMode ? 'DEMO' : 'LIVE') + ')');
  console.log('[overlay] Ctrl+Shift+Q quits · Ctrl+Shift+M edit layout · Ctrl+Shift+ +/- zooms');
});

app.on('will-quit', () => {
  saveShellState();
  globalShortcut.unregisterAll();
  if (agentProc) agentProc.kill();
});
app.on('window-all-closed', () => app.quit());
