// login-test.cjs - is there a visible, working way to sign in?
//
//   node_modules/electron/dist/electron.exe desktop/login-test.cjs
//
// This exists because the app once shipped with no usable sign-in at all: the button was
// wired by a function that had been truncated out of the file, so clicking it did
// nothing and the dialog never opened by itself either. Nothing in the test suite
// noticed, because nothing asked the question a person asks first — "how do I log in?"
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { rmSync } = require('node:fs');

const say = (m) => process.stdout.write(m + '\n');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const DATA = path.join(app.getPath('userData'), 'login-test');
  rmSync(DATA, { recursive: true, force: true });        // always a first run
  process.env.RELAY_DATA_DIR = DATA;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  // Start on the API route so this file keeps testing what it was written for: a machine
  // with no credential of any kind. On a machine that has Claude Code installed, the app
  // is signed in from the first frame, which would make every "not signed in" assertion
  // below vacuously true. That route is checked explicitly at the end instead.
  process.env.RELAY_PROVIDER = 'api';

  const server = await import('../app/server.mjs');
  const port = await server.start(7396);
  const win = new BrowserWindow({ width: 1280, height: 860, show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true } });

  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
  await win.loadURL(`http://127.0.0.1:${port}/`);
  await wait(2500);

  const js = (c) => win.webContents.executeJavaScript(c);
  let failed = 0;
  const check = (n, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    say(`  ${ok ? 'ok  ' : 'FAIL'} ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };

  check('no script error', errors, []);

  // 1. On a first run the way in must find the user, not the other way round.
  check('sign-in dialog opens by itself', await js(`document.querySelector('#settings').open`), true);
  check('header button names the action', await js(`document.querySelector('#opensettings').textContent`), 'Sign in to Claude');
  check('and is styled as the call to action', await js(`document.querySelector('#opensettings').classList.contains('cta')`), true);
  check('"not signed in" badge is showing', await js(`!document.querySelector('#envwarn').hidden`), true);

  // 2. Both routes in are present and visible.
  const visible = (sel) => js(`(() => { const e = document.querySelector('${sel}');
    return !!(e && e.offsetParent !== null); })()`);
  check('browser sign-in button is there', await visible('#signin'), true);
  check('profile field is there',          await visible('#profile'), true);
  check('API key field is there',          await visible('#apikey'), true);
  check('Save key button is there',        await visible('#savekey'), true);

  // 3. Without the CLI the browser route cannot work — it must say so and point somewhere.
  const antInstalled = await js(
    `(async () => (await (await fetch('/api/state')).json()).env.auth.antInstalled)()`);
  say(`  (ant CLI installed on this machine: ${antInstalled})`);
  if (!antInstalled) {
    check('sign-in button is disabled without the CLI', await js(`document.querySelector('#signin').disabled`), true);
    check('the reason is shown', await js(`!document.querySelector('#antmissing').hidden`), true);
    check('with a real download link', await js(`!!document.querySelector('#antmissing a[href^="https://"]')`), true);
    check('that opens outside the app', await js(`document.querySelector('#antmissing a').target`), '_blank');
  }

  // 4. The key route must actually change the app's state.
  await js(`document.querySelector('#closesettings').click(); true`);
  await wait(400);
  check('the placeholder also offers a way in', await js(`!!document.querySelector('.signin-call .go')`), true);

  await js(`document.querySelector('#opensettings').click();
            document.querySelector('#apikey').value = 'sk-ant-login-ui-test';
            document.querySelector('#savekey').click(); true`);
  await wait(1600);
  check('saving a key signs the app in', await js(`document.querySelector('#envwarn').hidden`), true);
  check('and the button becomes Settings', await js(`document.querySelector('#opensettings').textContent`), 'Settings');
  check('Sign out is now available', await js(`!document.querySelector('#signout').disabled`), true);

  // 5. And clearing it must put the app back, not leave a half-signed-in state.
  await js(`document.querySelector('#apikey').value = ''; document.querySelector('#savekey').click(); true`);
  await wait(1600);
  check('clearing the key signs it out again', await js(`document.querySelector('#opensettings').textContent`), 'Sign in to Claude');

  // 6. The Claude Code route: the one that needs nothing from the user at all.
  const cliAvailable = await js(
    `(async () => (await (await fetch('/api/state')).json()).env.provider.cli.available)()`);
  say(`  (Claude Code CLI on this machine: ${cliAvailable})`);
  if (cliAvailable) {
    const st = await js(`(async () => {
      const r = await fetch('/api/provider', { method: 'POST', headers: { 'content-type': 'application/json' },
                                               body: JSON.stringify({ mode: 'auto' }) });
      return r.json();
    })()`);
    check('auto mode selects the signed-in CLI', st.active, 'cli');
    await wait(900);
    check('and that alone counts as signed in',
      await js(`(async () => (await (await fetch('/api/state')).json()).env.credentials)()`), true);
    check('the option is offered in Settings', await js(`!!document.querySelector('#cliopt')`), true);
    check('with a radio for each choice',
      await js(`document.querySelectorAll('input[name="prov"]').length`), 3);
  }

  // Best effort: the ledger watcher still holds this directory open, and a failure to
  // tidy up a scratch folder is not a failure of the app.
  try { rmSync(DATA, { recursive: true, force: true }); } catch {}
  if (errors.length) say(`\npage errors: ${JSON.stringify(errors)}`);
  say(failed ? `\n${failed} check(s) FAILED\n` : '\nall login checks passed\n');
  app.exit(failed ? 1 : 0);
}).catch((e) => { say('ERROR: ' + (e && e.stack || e)); app.exit(1); });
