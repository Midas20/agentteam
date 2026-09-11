// main.cjs - the desktop shell.
//
// Electron's main process owns three things the browser build cannot have: a writable
// data directory that is not the (read-only) install directory, OS-backed encryption for
// the API key, and a real window. The HTTP server and the whole pipeline are unchanged —
// they are imported and run in this process.
// ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain node, and then
// require('electron') hands back a path string instead of the API. Some parent
// processes (other Electron apps, certain terminals) leak it into the environment, so
// fail with a sentence that explains it rather than a bare "cannot read properties of
// undefined" ten lines later.
// Printing a message was the old behaviour, and it is useless to someone who started the
// app by double-clicking it: there is no console to print to, so the app simply vanished.
// Since the fix is entirely mechanical — the same binary, started again without that one
// variable — do it rather than describe it.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    // No arguments: a packaged Electron binary started bare runs its own app. Detached and
    // unref'd, so this process can exit immediately without taking the new one with it.
    require('node:child_process')
      .spawn(process.execPath, [], { env, detached: true, stdio: 'ignore', windowsHide: false })
      .unref();
    process.exit(0);
  } catch (e) {
    console.error('Claude Workflow: this process is running as plain Node because ELECTRON_RUN_AS_NODE is set,\n' +
                  `and restarting it without that variable failed (${e.message}).\n` +
                  'Unset it and start again:  set ELECTRON_RUN_AS_NODE=  &&  "Claude Workflow.exe"');
    process.exit(1);
  }
}
const { app, BrowserWindow, Menu, shell, dialog, safeStorage } = electron;
const path = require('node:path');

// A second copy would fight over the same ledger files. Focus the first instead.
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

// Must be set before the server (and the ledger CLI it spawns) reads it.
const DATA = app.getPath('userData');
process.env.RELAY_DATA_DIR = DATA;
// Shown in the title bar. An old copy left in Program Files looks identical to a new one
// from the outside, and a dead button is exactly how that presents — so the running build
// has to be able to say which build it is.
process.env.RELAY_VERSION = app.getVersion();

// Hand settings.mjs the OS keychain (DPAPI on Windows, Keychain on macOS, libsecret on
// Linux). Without this the key would sit in plain text in the data directory.
//
// This MUST run after app.whenReady(): isEncryptionAvailable() reports false before the
// app is ready, and trusting that answer silently downgrades every stored key to plain
// text. It is called from boot(), not at module load.
function installVault() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  globalThis.__relaySafeStorage = {
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  };
  return true;
}

let win = null;
let port = null;
let splash = null;

// The clock starts at the first line of our code. Electron's own startup happens before
// this, so the numbers here are what WE cost, and the gap between process launch and the
// first mark is what the runtime and (for the portable build) the self-extraction cost.
const T0 = Date.now();
const since = () => String(Date.now() - T0).padStart(6);

/**
 * Say where the boot has got to, on the splash and on stdout.
 *
 * A cold start measured 18 seconds unpacked and 71 seconds for the portable build, most of
 * it before a window exists. Eighteen seconds of nothing is indistinguishable from a
 * crash, so the first thing the app does now is put something on screen that says what it
 * is doing — and the same string goes to stdout, so a slow start can be diagnosed by
 * whoever hits it rather than guessed at.
 */
function mark(text) {
  console.log(`boot ${since()}ms  ${text}`);
  try { splash?.webContents.send('relay:boot', text); } catch { /* splash already gone */ }
}

/** A tiny frameless window, shown before anything slow starts. */
function openSplash() {
  splash = new BrowserWindow({
    width: 420, height: 190, frame: false, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: false, show: false, backgroundColor: '#e8eaed',
    title: 'Claude Workflow',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  splash.once('ready-to-show', () => splash?.show());
  splash.loadFile(path.join(__dirname, 'splash.html')).catch(() => {});
}

function closeSplash() {
  const s = splash;
  splash = null;
  try { s?.destroy(); } catch { /* already closed */ }
}

function menu() {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,',
          click: () => win?.webContents.send('relay:open-settings') },
        { type: 'separator' },
        { label: 'Open data folder', click: () => shell.openPath(DATA) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { label: 'Help', submenu: [
      { label: 'About Claude Workflow', click: () => dialog.showMessageBox(win, {
        type: 'info', title: 'Claude Workflow',
        message: `Claude Workflow ${app.getVersion()}`,
        detail: `A requirement goes in; a reviewed result comes out.\n\n` +
                `Data folder:\n${DATA}\n\nServer: http://127.0.0.1:${port}\n` +
                `Electron ${process.versions.electron} · Node ${process.versions.node}`,
        buttons: ['OK'],
      }) },
    ] },
  ]);
}

/**
 * Load the local page, with the two things that go wrong on a strange machine handled.
 *
 * The window talks to a server inside this very process, over the loopback address. That
 * sounds unfailable, and it is not:
 *
 *   * Chromium obeys the system proxy. On a managed or server Windows install there is
 *     often a proxy with no bypass for 127.0.0.1, so the browser side dutifully asks a
 *     proxy — which cannot route loopback — for a page that is listening three feet away.
 *     It fails as a bare ERR_FAILED (-2), which reads exactly like "the app is broken".
 *   * The listen callback fires a moment before the socket reliably accepts on some
 *     machines, so the very first navigation can lose a race it will win on the retry.
 *
 * So: force a direct connection for this session, then retry a few times before giving up.
 */
async function load(url) {
  // Direct, for this window only. Set on the session rather than as a global command-line
  // switch so nothing else about the user's network configuration is touched.
  try { await win.webContents.session.setProxy({ mode: 'direct' }); } catch { /* older Electron */ }

  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { return await win.loadURL(url); }
    catch (e) {
      last = e;
      if (attempt < 4) await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
  // Out of retries. Say what was tried, in the terms someone could act on, rather than
  // handing over a Chromium stack trace about browser_init.
  const err = new Error(
    `The window could not reach the app's own server at ${url}.\n\n` +
    `The server is running inside this application and is listening on that address, so ` +
    `this is the browser side of the app being blocked from reaching it — most often a ` +
    `system proxy with no exception for 127.0.0.1, or security software blocking loopback ` +
    `connections for this program.\n\n` +
    `Things that work:\n` +
    `  • Open ${url} in your normal browser — the app runs perfectly well there.\n` +
    `  • Add 127.0.0.1 to your proxy's bypass list.\n` +
    `  • Allow "Claude Workflow.exe" through your security software.\n\n` +
    `Original error: ${last?.message || last}`);
  err.friendly = true;
  throw err;
}

async function boot() {
  openSplash();
  mark('Starting');
  installVault();   // before the server imports settings.mjs, and after the app is ready

  // Windows shows a toast only for an app it can identify. Without an explicit App User
  // Model ID the notification at the end of a run is silently dropped — and that
  // notification is the whole point of a job that takes twenty minutes and that nobody
  // sits and watches.
  // It must be the packaged appId from package.json → build.appId. A different string here
  // identifies an app Windows has no shortcut for, and the toast is dropped just the same.
  if (process.platform === 'win32') app.setAppUserModelId('local.claude-workflow.app');

  // Dynamic import: the server is ESM, this file is CJS.
  mark('Loading the workflow engine');
  const server = await import('../app/server.mjs');
  mark('Starting the local server');
  port = await server.start(Number(process.env.RELAY_APP_PORT || 7392));
  mark(`Listening on ${port}`);

  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    backgroundColor: '#e8eaed',
    title: 'Claude Workflow',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(menu());
  win.once('ready-to-show', () => { closeSplash(); win.show(); });
  mark('Opening the window');
  await load(`http://127.0.0.1:${port}/`);
  mark('Ready');
  closeSplash();   // belt and braces: ready-to-show may already have fired, or may not

  // Anything the page tries to open elsewhere goes to the real browser, not a second
  // Electron window with no chrome.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // And a plain link with no target would navigate the window itself, replacing the app
  // with a web page and no way back. Anything that is not the local server opens outside.
  win.webContents.on('will-navigate', (ev, url) => {
    if (url.startsWith(`http://127.0.0.1:${port}/`)) return;
    ev.preventDefault();
    shell.openExternal(url);
  });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(boot).catch((e) => {
  closeSplash();
  // A diagnosed failure gets its own explanation; anything else still gets the stack,
  // because an undiagnosed crash is worth reporting in full.
  dialog.showErrorBox('Claude Workflow could not start',
    e?.friendly ? String(e.message) : String(e?.stack || e));
  app.quit();
});
// Quitting must take the model calls with it. A stage runs as a child process, and on
// Windows a child outlives its parent by default — so closing the window used to leave
// `claude` running, still spending the plan, with nothing on screen to reveal it.
app.on('before-quit', async () => {
  try {
    const cli = await import('../app/cli.mjs');
    const n = cli.killAllTasks();
    if (n) console.log(`Claude Workflow: stopped ${n} model call(s) that were still running.`);
  } catch { /* nothing was running, or the module never loaded */ }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) boot(); });
