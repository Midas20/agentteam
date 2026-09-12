// orphan-test.mjs - does a model call outlive the app that started it?
//
//   node desktop/orphan-test.mjs
//
// A stage runs as a `claude` child process, and on Windows a child does not die with its
// parent. Twelve of them were found still running after one development session — still
// working, still spending the plan's quota, with no window left to reveal them.
//
// There are two ways the app can go away and they need different fixes, so the test
// covers both:
//
//   a normal quit   — JavaScript still runs, so cli.mjs kills its children on the way out
//   a hard kill     — no JavaScript runs at all, so nothing can clean up until next start
//
// Nothing here counts or kills processes by name. `claude.exe` on this machine is also
// the user's own Claude Code session; a name-based sweep ends that session, which is how
// this was learned. Every process this test touches is one whose pid it watched the app
// write into its own register.
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA = join(ROOT, '.orphan-test');
const REG = join(DATA, 'running.json');
const say = (m) => process.stdout.write(m + '\n');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let failed = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  say(`  ${ok ? 'ok  ' : 'FAIL'} ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

/** The children the app says it started, straight out of its own register. */
const registered = () => {
  try { return JSON.parse(readFileSync(REG, 'utf8')).map(r => r.child); } catch { return []; }
};
/** Is that pid still running? Signal 0 asks without sending anything. */
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const someAlive = (pids) => pids.filter(alive);

/**
 * Start a server on this data directory and wait for it to say which port it bound.
 * Asking for a port is not the same as getting one — the app falls back to an ephemeral
 * port when the preferred one is taken, and assuming otherwise turns a busy port into a
 * bare ECONNREFUSED with nothing to say about it.
 */
async function serve(port) {
  const env = { ...process.env, RELAY_DATA_DIR: DATA, RELAY_APP_PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ANTHROPIC_API_KEY;
  const p = spawn(process.execPath, [join(ROOT, 'app', 'server.mjs')],
                  { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  p.stdout.on('data', c => { log += c; });
  p.stderr.on('data', c => { log += c; });
  let bound = null;
  for (let i = 0; i < 40 && !bound; i++) {
    await wait(500);
    const m = log.match(/http:\/\/localhost:(\d+)/);
    if (m) bound = Number(m[1]);
  }
  if (!bound) throw new Error('the server never reported a port:\n' + log);
  return { p, port: bound, out: () => log };
}

/** Ask for a ticket and wait until the app has a live child to show for it. */
async function startWork(port) {
  await fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'orphan', cap: 1,
      spec: 'Explain the Rust borrow checker in as much detail as you can manage.' }),
  });
  for (let i = 0; i < 45; i++) {
    await wait(2000);
    const live = someAlive(registered());
    if (live.length) return live;
  }
  return [];
}

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

// ── 1. A hard kill, which is the case nothing in the app can handle ─────────────────
say('\n  a hard kill — no JavaScript runs, so nothing in the app can clean up\n');
let one = await serve(7394);
let kids = await startWork(one.port);
check('the app started a model call', kids.length > 0, true);

if (kids.length) {
  // SIGKILL on Windows is TerminateProcess. No exit handler, no signal handler, nothing.
  one.p.kill('SIGKILL');
  await wait(4000);
  check('the app is gone', alive(one.p.pid), false);

  // Measured, not assumed: the child goes too. Not because anything killed it — nothing
  // could — but because its stdout pipe dies with the parent and the CLI stops when it
  // can no longer write. Worth stating as a check, because it is the thing that would
  // change quietly if the CLI ever started tolerating a closed pipe.
  check('the model call goes with it', someAlive(kids), []);

  const two = await serve(one.port);
  await wait(5000);
  check('and the next start clears the register',
        registered().filter(p => kids.includes(p)), []);
  two.p.kill('SIGKILL');
  await wait(1500);
}

// ── 2. A normal quit: cli.mjs must take its children with it, with no sweep involved ──
say('\n  a normal quit — the exit handler in cli.mjs does the work\n');
rmSync(REG, { force: true });
// A file:// URL, not a path. A Windows absolute path in a dynamic import is rejected by
// the ESM loader, and with stdio ignored that failure is invisible — the test reported
// "no model call is running" and looked like the app's fault.
const harness = `
  process.env.RELAY_DATA_DIR = ${JSON.stringify(DATA)};
  const { doWork } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'app', 'cli.mjs')).href)});
  doWork({ kind: 'answer', model: 'sonnet', attempt: 1, cap: 1, attachments: [], workspace: null,
           spec: 'Explain the Rust borrow checker in as much detail as you can manage.' }).catch(() => {});
  setTimeout(() => process.exit(0), 20000);
`;
const quitter = spawn(process.execPath, ['--input-type=module', '--eval', harness],
                      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let qerr = '';
quitter.stderr.on('data', c => { qerr += c; });
let quitKids = [];
for (let i = 0; i < 30; i++) { await wait(1000); quitKids = someAlive(registered()); if (quitKids.length) break; }
check('a model call is running', quitKids.length > 0, true);
if (!quitKids.length && qerr.trim()) say('  harness said: ' + qerr.trim().split('\n')[0]);
if (quitter.exitCode === null) await new Promise(r => quitter.on('close', r));
await wait(3000);
check('quitting took the model call with it', someAlive(quitKids), []);

// ── 3. The sweep's decision, which sections 1 and 2 never reach ──────────────────────
// Section 1 only exercises the sweep if a hard kill leaves something behind, and on this
// machine it does not — a test that passes without testing anything. The sweep is the
// backstop for the day that changes (a CLI that tolerates a closed stdout, a child of a
// child, a machine that schedules differently), so its decision is worth testing on its
// own: run a real model call, tell the register a dead process owns it, and require the
// sweep to find and kill exactly that.
say('\n  the sweep\'s decision, tested directly\n');
rmSync(REG, { force: true });
process.env.RELAY_DATA_DIR = DATA;
const { doWork } = await import(pathToFileURL(join(ROOT, 'app', 'cli.mjs')).href);
const { sweep } = await import(pathToFileURL(join(ROOT, 'app', 'orphans.mjs')).href);

// process.kill(pid, 0) is not usable here. This process spawned these children, so it
// still holds handles to them, and Windows keeps a terminated process addressable for as
// long as any handle is open — the signal-0 probe answers "alive" for a child that has
// already exited. Ask the OS for the process list instead.
const listed = () => {
  try {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ForEach-Object { $_.ProcessId }`;
    return String(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
                               { windowsHide: true })).split(/\r?\n/).map(s => Number(s.trim())).filter(Boolean);
  } catch { return []; }
};

doWork({ kind: 'answer', model: 'sonnet', attempt: 1, cap: 1, attachments: [], workspace: null,
         spec: 'Explain the Rust borrow checker in as much detail as you can manage.' }).catch(() => {});
let target = null;
for (let i = 0; i < 30 && !target; i++) {
  await wait(1000);
  target = registered().find(p => listed().includes(p)) ?? null;
}
check('a real model call is running', Boolean(target), true);
// The app's own record of when it started that child. The sweep matches it against the
// OS's start time, so the test has to hand back the same number the app wrote, not a
// fresh one.
const startedAt = (() => {
  try { return JSON.parse(readFileSync(REG, 'utf8')).find(r => r.child === target)?.at ?? null; }
  catch { return null; }
})();

if (target) {
  // A pid that is certainly dead: run something trivial and wait for it to finish.
  const corpse = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
  const deadPid = corpse.pid;
  await new Promise(r => corpse.on('close', r));

  // First: leave it alone. The owner is this process, which is very much alive.
  const spared = await sweep();
  check('a live owner\'s call is spared', spared, 0);
  check('and is still running', listed().includes(target), true);

  // Then: a pid wearing the wrong start time. This is the pid-reuse guard — the register
  // names a child that died long ago and whose number has been handed to something else.
  writeFileSync(REG, JSON.stringify([{ app: deadPid, child: target, at: Date.now() - 9 * 60 * 1000 }]));
  const mismatched = await sweep();
  check('a pid that does not match the register is spared', mismatched, 0);
  check('and is still running', listed().includes(target), true);

  // Finally the real case: the owner is gone and the start time matches.
  writeFileSync(REG, JSON.stringify([{ app: deadPid, child: target, at: startedAt ?? Date.now() }]));
  const killed = await sweep();
  await wait(2000);
  check('an orphan is killed', killed, 1);
  check('and is gone', listed().includes(target), false);
  check('and its row is dropped', registered().includes(target), false);
}

rmSync(DATA, { recursive: true, force: true });
say(failed ? `\n${failed} check(s) FAILED\n` : '\nno model call outlives the app that started it\n');
process.exit(failed ? 1 : 0);
