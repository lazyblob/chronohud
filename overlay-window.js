/**
 * iRaceHUD · overlay-window.js
 *
 * Electron shell that floats overlay.html over the sim as a true in-game
 * overlay: transparent, frameless, always-on-top, click-through — the same
 * architecture RaceLabs-style tools use. It also spawns agent.js alongside
 * itself, so one command boots the whole stack:
 *
 *   npx electron overlay-window.js           → LIVE (reads iRacing shared memory)
 *   npx electron overlay-window.js --demo    → DEMO (synthetic car)
 *
 * iRacing must run in BORDERLESS WINDOWED mode; exclusive fullscreen paints
 * over every OS window, including this one.
 *
 * Global hotkeys:
 *   Ctrl+Shift+Q  quit overlay + agent
 *   Ctrl+Shift+M  toggle mouse click-through (grab/release the window)
 */
'use strict';

const { app, BrowserWindow, globalShortcut, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

const demoMode = process.argv.includes('--demo');

let win = null;
let agentProc = null;
let clickThrough = true;

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

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: 404,                       // .hud is 380px + 2×12px padding
    height: Math.min(960, wa.height - 40),
    x: wa.x + wa.width - 424,         // hug the right edge of the screen
    y: wa.y + 20,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    fullscreenable: false,
    skipTaskbar: false,               // keep a taskbar icon as a visible handle
    title: 'iRaceHUD Overlay',
    webPreferences: { backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');       // float above borderless games
  win.setIgnoreMouseEvents(true, { forward: true }); // clicks pass through to the sim
  win.loadFile(path.join(__dirname, 'overlay.html'));
}

app.whenReady().then(() => {
  startAgent();
  createWindow();

  globalShortcut.register('Control+Shift+Q', () => app.quit());
  globalShortcut.register('Control+Shift+M', () => {
    clickThrough = !clickThrough;
    win.setIgnoreMouseEvents(clickThrough, { forward: true });
  });

  console.log('[overlay] iRaceHUD floating (' + (demoMode ? 'DEMO' : 'LIVE') + ') — Ctrl+Shift+Q quits');
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (agentProc) agentProc.kill();
});
app.on('window-all-closed', () => app.quit());
