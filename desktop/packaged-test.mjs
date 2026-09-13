// packaged-test.mjs - drives the BUILT application, not a development window.
//
//   node desktop/packaged-test.mjs
//
// Every other test in this repo creates its own BrowserWindow and loads the page into it.
// That skips desktop/main.cjs entirely, so it cannot see anything the shell is
// responsible for, and it cannot see a stale build at all: a broken app.asar sitting in
// Program Files looks identical from the outside to a fixed one. This launches the real
// executable and talks to it over the DevTools protocol, which is the only way to answer
// "does the button in the app I actually ship work?"
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXE  = process.argv[2] || join(HERE, '..', 'dist', 'win-unpacked', 'Claude Workflow.exe');
const PORT = 9333;

const say  = (m) => process.stdout.write(m + '\n');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

if (!existsSync(EXE)) { say(`no such executable: ${EXE}`); process.exit(1); }

// ELECTRON_RUN_AS_NODE turns the binary into plain node and the window never appears.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

say(`launching ${EXE}`);
const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, stdio: 'ignore', windowsHide: false });

let ws = null, id = 0;
const pending = new Map();

/** Evaluate an expression in the page and return its value. */
const evaluate = (expression) => new Promise((resolve, reject) => {
  const n = ++id;
  pending.set(n, { resolve, reject });
  ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate',
                           params: { expression, awaitPromise: true, returnByValue: true } }));
});

async function findPage() {
  // The debugger port is not open the instant the process starts, and the page target
  // appears only once the window has loaded the local server.
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1'));
      if (page) return page;
    } catch { /* not listening yet */ }
    await wait(1000);
  }
  throw new Error('the app never opened a page on the debugging port');
}

let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  say(`  ${ok ? 'ok  ' : 'FAIL'} ${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

try {
  const page = await findPage();
  say(`attached to ${page.url}`);

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('debugger socket failed')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) return p.reject(new Error(m.error.message));
    if (m.result?.exceptionDetails) return p.reject(new Error(m.result.exceptionDetails.text));
    p.resolve(m.result?.result?.value);
  };

  await wait(3000);   // let the first state frame arrive

  // Which build is this, really.
  const version = await evaluate(`document.querySelector('#ver')?.textContent || ''`);
  say(`  (the running build reports ${version || 'no version'})`);
  check('the window shows its version', /^v\d+\.\d+\.\d+$/.test(version), true);

  // The exact thing that was reported broken.
  check('no script error on the page',
    await evaluate(`(window.__errs || []).length`), 0);
  check('wireSettings survived packaging',
    await evaluate(`typeof wireSettings`), 'function');

  await evaluate(`document.querySelector('#settings').close(); true`);
  await wait(300);
  check('dialog starts closed for this check',
    await evaluate(`document.querySelector('#settings').open`), false);

  await evaluate(`document.querySelector('#opensettings').click(); true`);
  await wait(600);
  check('clicking Settings opens the dialog',
    await evaluate(`document.querySelector('#settings').open`), true);
  check('the sign-in controls are really visible',
    await evaluate(`['#signin','#apikey','#savekey']
       .every(s => { const e = document.querySelector(s); return !!(e && e.offsetParent !== null); })`), true);

  await evaluate(`document.querySelector('#closesettings').click(); true`);
  await wait(400);
  check('and Close closes it',
    await evaluate(`document.querySelector('#settings').open`), false);

  // The headline: does the SHIPPED app find the Claude Code login on this machine. A
  // packaged app has a different working directory and environment from a development
  // run, and the binary is located by walking the user's home directory — none of which
  // the dev tests exercise.
  const state = await evaluate(`(async () => {
    const s = await (await fetch('/api/state')).json();
    return { cli: s.env.provider.cli.available, active: s.env.provider.active,
             creds: s.env.credentials, path: s.env.provider.cli.path };
  })()`);
  say(`  (CLI seen by the packaged app: ${state.path || 'none'})`);
  check('it finds the Claude Code binary', state.cli, true);
  check('and routes through it by default', state.active, 'cli');
  check('so it is signed in with no key at all', state.creds, true);
  check('the usage counter is present', await evaluate(`!!document.querySelector('#usage')`), true);

  say(failed ? `\n${failed} check(s) FAILED\n` : '\nthe packaged app is sound\n');
} catch (e) {
  say(`ERROR: ${e.message}`);
  failed = 1;
} finally {
  try { ws?.close(); } catch {}
  child.kill();
  await wait(500);
}
process.exit(failed ? 1 : 0);
