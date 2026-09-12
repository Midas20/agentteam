// cancel-test.mjs - does Stop actually stop?
//   node desktop/cancel-test.mjs
//
// Cancelling has to kill the model call, not merely stop scheduling the next one: a
// worker turn runs for many minutes and costs real money, so "cancelled" that waits for
// the turn to end is not cancelled. This watches the actual child processes.
//
// It starts its own server rather than assuming one is listening, and it identifies the
// model calls by the pids the app writes into its own register — never by counting
// processes named `claude`. That name also belongs to the user's own Claude Code session
// on this machine, so a count of it is both noisy and, if anything ever acted on it,
// dangerous.
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA = join(ROOT, '.cancel-test');
const REG = join(DATA, 'running.json');
const say = (m) => process.stdout.write(m + '\n');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** The pids the app says it started, and which of them the OS still lists. */
const registered = () => {
  try { return JSON.parse(readFileSync(REG, 'utf8')).map(r => r.child); } catch { return []; }
};
const listed = () => {
  try {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ForEach-Object { $_.ProcessId }`;
    return String(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
                               { windowsHide: true })).split(/\r?\n/).map(n => Number(n.trim())).filter(Boolean);
  } catch { return []; }
};
const ours = () => { const now = listed(); return registered().filter(p => now.includes(p)); };

let failed = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  say(`  ${ok ? 'ok  ' : 'FAIL'} ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const env = { ...process.env, RELAY_DATA_DIR: DATA, RELAY_APP_PORT: '7393' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ANTHROPIC_API_KEY;
const server = spawn(process.execPath, [join(ROOT, 'app', 'server.mjs')],
                     { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let log = '';
server.stdout.on('data', c => { log += c; });
server.stderr.on('data', c => { log += c; });

// Asking for a port is not the same as getting one: the app falls back to an ephemeral
// port when the preferred one is taken. Wait for it to say which one it bound, or the
// first fetch fails with a bare ECONNREFUSED that says nothing about why.
let port = null;
for (let i = 0; i < 40 && !port; i++) {
  await wait(500);
  const m = log.match(/http:\/\/localhost:(\d+)/);
  if (m) port = m[1];
}
if (!port) { say('the server never reported a port:\n' + log); process.exit(1); }
const base = `http://127.0.0.1:${port}`;

const r = await fetch(`${base}/api/tasks`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'cancel me', cap: 2,
    spec: 'Research and write a detailed comparison of five different job-queue libraries for Node.js, with citations.' }),
});
const { id } = await r.json();
say(`created ${id}`);

// Wait for two things at once: a model call genuinely in flight, AND at least one stage
// already recorded. Stopping during the very first stage tests only half of this — there
// is nothing finished yet for "it kept what it had" to be about, so that check passes or
// fails on timing rather than on behaviour.
let before = [], state = 'open';
for (let i = 0; i < 90; i++) {
  await wait(2000);
  before = ours();
  const s = await (await fetch(`${base}/api/state`)).json();
  state = s.tasks.find(x => x.id === id)?.state || 'open';
  if (before.length && state !== 'open') break;
}
say(`  (our model calls running before stop: ${before.length}, ticket at "${state}")`);
check('a model call is actually in flight', before.length > 0, true);
check('and a stage has already landed', state !== 'open', true);

const c = await (await fetch(`${base}/api/cancel`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
})).json();
say(`  (cancel killed ${c.killed} process(es))`);
check('stopping killed the live call', c.killed > 0, true);

await wait(4000);
const after = ours();
say(`  (our model calls after stop: ${after.length})`);
check('the process is gone', after.filter(p => before.includes(p)), []);

const run = await (await fetch(`${base}/api/run?id=${id}`)).json();
check('the run reports cancelled', run.status, 'cancelled');

// Everything finished before the stop must survive, so Resume has something to build on.
const s2 = await (await fetch(`${base}/api/state`)).json();
const t2 = s2.tasks.find(x => x.id === id);
say(`  (ticket left in state "${t2.state}", kind=${t2.kind || '-'})`);
check('the ticket still exists', Boolean(t2), true);
check('and kept the stages it finished', Boolean(t2.kind), true);

// A stopped ticket must be resumable and deletable; a running one must not be deletable.
const del = await fetch(`${base}/api/delete`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
});
check('a stopped ticket can be deleted', del.status, 200);

server.kill('SIGKILL');
await wait(1000);
rmSync(DATA, { recursive: true, force: true });
say(failed ? `\n${failed} check(s) FAILED\n` : '\nstopping works\n');
process.exit(failed ? 1 : 0);
