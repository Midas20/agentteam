// orphans.mjs - kill the model calls a previous run left behind.
//
// A stage runs as a `claude` child process, and on Windows a child does not die with its
// parent. Quitting normally is handled in cli.mjs, which kills its children on the way
// out. But a process that is terminated outright — Task Manager's End Task, taskkill /F,
// a crash — runs no JavaScript at all, so nothing gets the chance to clean up. Twelve
// `claude` processes were found still running after one such session, still working,
// still spending the plan's quota, with no window left to reveal them.
//
// The only place left to fix that is the NEXT start. This keeps a small register of
// (our pid, child pid, when we started it) and, on startup, kills the children whose
// owner is gone.
//
// IT MUST NEVER KILL BY NAME. `claude.exe` on this machine is also the user's own Claude
// Code session — in a terminal, in VS Code. Killing every process with that name takes
// their session down with it; that is not a theoretical risk, it happened during
// development and ended the session mid-sentence. A process is killable here only when
// the register says we started it and its owner is dead.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';

const DATA = process.env.RELAY_DATA_DIR || join(homedir(), '.claude-workflow');
const FILE = join(DATA, 'running.json');

/** Records are tiny and written often; a bad read must never stop the app starting. */
function load() {
  try { const v = JSON.parse(readFileSync(FILE, 'utf8')); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function save(rows) {
  try { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(rows)); }
  catch { /* a read-only data dir costs us the sweep, not the run */ }
}

/** Is this pid still running? Signal 0 asks without sending anything. */
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // EPERM: exists, but not ours to signal
}

/** Note that we started this child, so a later run can clean it up if we never finish. */
export function remember(pid) {
  if (!pid) return;
  save([...load(), { app: process.pid, child: pid, at: Date.now() }]);
}

/** It exited on its own. Drop it before the register grows into a list of ghosts. */
export function forget(pid) {
  if (!pid) return;
  save(load().filter(r => !(r.app === process.pid && r.child === pid)));
}

/** Every claude.exe running right now, as pid -> start time in epoch ms. */
function runningClaudes() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const ps = `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ForEach-Object { ` +
      `'{0} {1}' -f $_.ProcessId, [int64]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 15000 }, (err, out) => {
        if (err) return resolve(null);
        const map = new Map();
        for (const line of String(out).split(/\r?\n/)) {
          const m = line.trim().match(/^(\d+) (\d+)$/);
          if (m) map.set(Number(m[1]), Number(m[2]));
        }
        resolve(map);
      });
  });
}

/**
 * Kill the leftovers and rewrite the register. Returns how many were killed.
 *
 * Two independent facts have to line up before anything dies: the register says we
 * started that pid and its owner is no longer running, AND the process wearing that pid
 * today is a `claude.exe` that started when we said it did. The second check is what
 * makes pid reuse harmless — a pid handed to something else since then does not match,
 * so it is left alone.
 */
export async function sweep() {
  const rows = load();
  if (!rows.length) return 0;

  // Only rows whose owner is gone. Our own children, and those of another copy of the app
  // that is still running, are none of this sweep's business.
  const dead = rows.filter(r => r.app !== process.pid && !alive(r.app));
  if (!dead.length) return 0;

  const now = await runningClaudes();
  let killed = 0;
  for (const r of dead) {
    const startedAt = now?.get(r.child);
    // No entry: already gone. A start time that does not match ours: a different process
    // is wearing that pid now, and it is not ours to kill.
    if (startedAt === undefined) continue;
    if (Math.abs(startedAt - r.at) > 60000) continue;
    try { process.kill(r.child); killed++; } catch { /* raced us to it */ }
  }
  // Re-read before writing. Deciding took a round trip to the OS, and this process has
  // very likely started model calls of its own in the meantime — writing back the list
  // as it looked before that would erase their rows, and an erased row is an orphan
  // nobody can clean up later. Drop only the rows this sweep actually ruled on.
  const ruled = new Set(dead.map(r => `${r.app}:${r.child}`));
  save(load().filter(r => !ruled.has(`${r.app}:${r.child}`)));
  return killed;
}
