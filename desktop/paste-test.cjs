// paste-test.cjs - does Ctrl+V actually attach a screenshot?
//
//   node_modules/electron/dist/electron.exe desktop/paste-test.cjs
//
// Everything here is real: a real bitmap is placed on the Windows clipboard by
// PowerShell (the way the Snipping Tool does), and Ctrl+V is delivered through
// Chromium's own input pipeline with sendInputEvent. An earlier version of this file
// dispatched synthetic ClipboardEvents, which tested the handler but not the path the
// user actually takes — and so could not have caught a page-level script error that
// stops the rest of app.js from running.
const { app, BrowserWindow, clipboard } = require('electron');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const say = (m) => process.stdout.write(m + '\n');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  process.env.RELAY_DATA_DIR = path.join(app.getPath('userData'), 'paste-test');
  const server = await import('../app/server.mjs');
  const port = await server.start(7398);

  const win = new BrowserWindow({ width: 1100, height: 800, show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true } });

  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });

  await win.loadURL(`http://127.0.0.1:${port}/`);
  win.focus(); win.moveTop();
  await wait(1800);

  const js = (c) => win.webContents.executeJavaScript(c);
  const count = () => js(`document.querySelectorAll('#thumbs .thumb').length`);

  let failed = 0;
  const check = (n, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    say(`  ${ok ? 'ok  ' : 'FAIL'} ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };

  // A script error anywhere in app.js stops every line after it. The page can look fine
  // and still have no event stream, so this is checked first and explicitly.
  check('page loads with no script error', errors, []);
  check('every entry point defined',
    [await js('typeof wireIntake'), await js('typeof wireSettings'), await js('typeof connect'), await js('typeof paintAuth')],
    ['function', 'function', 'function', 'function']);

  // A real bitmap on the real clipboard, placed in this run so there is no ambiguity.
  execFileSync('powershell.exe',
    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'setclip.ps1'),
     '-Png', path.join(__dirname, '..', 'build', 'icon.png')], { windowsHide: true });
  say(`  (clipboard holds image/png: ${await clipboard.has('image/png')})`);

  const ctrlV = () => {
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'v', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp',   keyCode: 'v', modifiers: ['control'] });
  };

  check('starts with no attachments', await count(), 0);

  // The file picker. Clicking it for real would open a native dialog and hang the run, so
  // the files are handed to the input directly — which still exercises the change handler,
  // addImages, the format filter and the thumbnails. Only the OS dialog is skipped.
  const b64 = readFileSync(path.join(__dirname, '..', 'build', 'icon.png')).toString('base64');
  const choose = (type, n) => js(`(() => {
    const bin = atob(${JSON.stringify(b64)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    for (let i = 0; i < ${n}; i++) dt.items.add(new File([bytes], 'chosen' + i + '.png', { type: '${type}' }));
    const pick = document.querySelector('#filepick');
    pick.files = dt.files;
    pick.dispatchEvent(new Event('change'));
    return true;
  })()`);

  check('there is a file input to upload with', await js(`!!document.querySelector('#filepick')`), true);
  check('it takes more than one file', await js(`document.querySelector('#filepick').multiple`), true);
  check('the drop zone is clickable', await js(`document.querySelector('#drop').getAttribute('role')`), 'button');

  await choose('image/png', 2);
  await wait(900);
  check('choosing two files attaches both', await count(), 2);

  await choose('image/bmp', 1);
  await wait(700);
  check('an unreadable format is refused, not attached', await count(), 2);

  await js(`images.length = 0; paintThumbs(); true`);
  await wait(300);
  check('cleared before the clipboard checks', await count(), 0);

  // sendInputEvent needs a live interactive desktop. Over a locked or disconnected RDP
  // session no keystroke reaches any window, and every check below would report FAIL as
  // though the app were broken. Prove input works at all before trusting the verdict.
  await js(`{ const t = document.querySelector('#title'); t.value = ''; t.focus(); } true`);
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'a' });
  await wait(500);
  if (await js(`document.querySelector('#title').value`) !== 'a') {
    say('\nSKIPPED — keystrokes are not reaching the window, so Ctrl+V cannot be tested.');
    say('This is the desktop session, not the app: lock/disconnect makes sendInputEvent a');
    say('no-op. Re-run it while signed in to the machine.\n');
    app.exit(2);
    return;
  }
  await js(`document.querySelector('#title').value = ''; true`);

  // The sign-in dialog opens by itself when there are no credentials. It is modal and
  // covers the form, so a paste must not disappear behind it.
  await js(`document.querySelector('#opensettings').click(); true`);
  await wait(400);
  check('Settings button opens the dialog', await js(`document.querySelector('#settings').open`), true);
  ctrlV(); await wait(1000);
  check('paste behind the modal attaches nothing', await count(), 0);

  await js(`document.querySelector('#closesettings').click(); true`);
  await wait(400);
  check('Close button closes it', await js(`document.querySelector('#settings').open`), false);

  await js(`document.querySelector('#spec').focus(); true`);
  ctrlV(); await wait(1200);
  check('Ctrl+V with the text box focused', await count(), 1);

  // The reason the handler sits on document rather than on the textarea.
  await js(`document.querySelector('#spec').blur(); document.body.focus(); true`);
  ctrlV(); await wait(1200);
  check('Ctrl+V with focus elsewhere', await count(), 2);

  await js(`document.querySelector('#title').focus(); true`);
  ctrlV(); await wait(1200);
  check('Ctrl+V from another field', await count(), 3);

  // Text pasting must be left completely alone.
  // Braced, not bare. Every executeJavaScript call is evaluated in the same global
  // scope, so a second top-level `const t` throws "already declared" — and it does it
  // as a renderer exception, which arrives here as a bare "Script failed to execute".
  clipboard.writeText('ordinary text');
  await js(`{ const t = document.querySelector('#title'); t.value = ''; t.focus(); } true`);
  ctrlV(); await wait(900);
  check('text paste attaches nothing', await count(), 3);
  check('text paste reaches the field', await js(`document.querySelector('#title').value`), 'ordinary text');

  await js(`document.querySelector('#thumbs .rm').click(); true`);
  await wait(400);
  check('remove button drops one', await count(), 2);

  // Text and images together — the combination, not one or the other.
  await js(`document.querySelector('#spec').value = 'requirement text alongside the screenshots'; true`);
  const sent = await js(`(async () => {
    const r = await fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: document.querySelector('#spec').value, title: 'combined', images }) });
    return { status: r.status, body: await r.json() };
  })()`);
  say(`  (POST /api/tasks with 2 images + text → ${sent.status} ${JSON.stringify(sent.body)})`);

  say(errors.length ? `\npage errors: ${JSON.stringify(errors)}` : '');
  say(failed ? `\n${failed} check(s) FAILED\n` : '\nall paste checks passed\n');
  app.exit(failed ? 1 : 0);
}).catch((e) => { say('ERROR: ' + (e && e.stack || e)); app.exit(1); });
