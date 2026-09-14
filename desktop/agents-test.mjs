// agents-test.mjs - the pipeline roster: who reviews, and what each agent is told.
//   node desktop/agents-test.mjs
//
// Two things here are load-bearing and neither is visible from the screen:
//
//   1. An edited agent must be the one that actually runs. A settings page that saves
//      text nothing reads is worse than no settings page, because it looks like it worked.
//   2. A third reviewer must really gate. Adding one that gets called but whose verdict
//      nobody waits for would turn a stricter pipeline into a more expensive one.
//
// So this drives the real ledger binary for the second half, not a stand-in for it.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, '.agents-test');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.RELAY_DATA_DIR = DATA;

const A = await import(pathToFileURL(join(ROOT, 'app', 'agents.mjs')).href);
const P = await import(pathToFileURL(join(ROOT, 'app', 'prompts.mjs')).href);

let failed = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}\n`);
};

// ── 1. the shipped roster ────────────────────────────────────────
check('two reviewers to begin with', A.activeSlots(), ['a', 'b']);
check('nothing is customised yet', A.roster().agents.filter(a => a.custom).length, 0);
check('no file until something changes', existsSync(A.FILE), false);
check('every agent has a default', A.ids().every(id => A.instructions(id).length > 200), true);
check('reviewer A is the compliance axis', A.role('reviewer.a').axis, 'Compliance');
check('and runs the shipped prompt', A.instructions('reviewer.a') === P.REVIEWER.a, true);
check('the method names both reviewers', A.reviewMethod().map(r => r.slot), ['a', 'b']);

// ── 2. editing an agent ──────────────────────────────────────────
A.setRole('reviewer.b', { instructions: 'You check only whether the dates are right.', axis: 'Dates' });
check('the edited text is what runs', A.instructions('reviewer.b'), 'You check only whether the dates are right.');
check('the axis follows it', A.role('reviewer.b').axis, 'Dates');
check('and the review method reports the new axis', A.reviewMethod()[1].axis, 'Dates');
check('it is marked as customised', A.role('reviewer.b').custom, true);
check('its neighbour is untouched', A.instructions('reviewer.a') === P.REVIEWER.a, true);
check('the default is still available to reset to', A.role('reviewer.b').default.instructions === P.REVIEWER.b, true);

// Re-typing the default is not an override. Otherwise "custom" would come to mean
// "opened once", and an improvement to a shipped prompt would never reach that agent.
A.setRole('reviewer.b', { instructions: P.REVIEWER.b, axis: 'Correctness' });
check('typing the default back clears the override', A.role('reviewer.b').custom, false);

A.setRole('worker.repo', { instructions: 'Find any repo at all.' });
check('workers are editable too', A.instructions('worker.repo'), 'Find any repo at all.');
A.resetRole('worker.repo');
check('and resettable', A.instructions('worker.repo') === P.WORKER.repo, true);

// ── 3. what is refused ───────────────────────────────────────────
const refuses = (fn) => { try { fn(); return false; } catch { return true; } };
check('one reviewer is refused', refuses(() => A.setSlots(['a'])), true);
check('an unknown slot is refused', refuses(() => A.setSlots(['a', 'b', 'z'])), true);
check('an unknown agent is refused', refuses(() => A.setRole('reviewer.z', { label: 'x' })), true);
check('instructions past the cap are refused',
  refuses(() => A.setRole('classify', { instructions: 'x'.repeat(A.LIMIT + 1) })), true);
check('a worker has no axis to set', A.role('worker.repo').axis, null);

// ── 4. three reviewers ───────────────────────────────────────────
check('a third can be switched on', A.setSlots(['a', 'b', 'c']), ['a', 'b', 'c']);
check('order is slot order, not the order given', A.setSlots(['c', 'a', 'b']), ['a', 'b', 'c']);
check('the method grows with it', A.reviewMethod().map(r => r.axis), ['Compliance', 'Correctness', 'Evidence']);
check('reviewer C has its own prompt', A.instructions('reviewer.c') === P.REVIEWER.c, true);
check('and it is a different one from A and B',
  new Set(['a', 'b', 'c'].map(s => A.instructions(`reviewer.${s}`))).size, 3);

// ── 5. the ledger gate, through the real binary ──────────────────
// The point of a third reviewer is that its verdict counts. Everything above is
// configuration; this is the part that decides whether a ticket passes.
const relay = (...args) => execFileSync(process.execPath, [join(ROOT, 'bin', 'relay.mjs'), ...args],
  { cwd: DATA, encoding: 'utf8', env: { ...process.env, RELAY_DATA_DIR: DATA } });

const spec = join(DATA, 'spec.md');
writeFileSync(spec, 'do a thing');
const id = relay('new', '--title', 'three reviewers', '--spec-file', spec, '--cap', '2').split('\n')[0].trim();
relay('classify', id, '--kind', 'answer', '--mode', 'paste', '--why', 'test');
relay('model', id, '--work', 'opus', '--review', 'opus', '--why', 'test');
relay('assign', id, '--slots', 'abc');
const task = () => JSON.parse(readFileSync(join(DATA, 'tasks', `${id}.json`), 'utf8'));
check('the roster is written onto the task', task().review_slots, ['a', 'b', 'c']);

relay('built', id, '--notes', 'here is what I did');
relay('review', id, '--slot', 'a', '--result', 'pass', '--notes', 'clauses all met');
check('one verdict does not resolve it', task().state, 'reviewing');
relay('review', id, '--slot', 'b', '--result', 'pass', '--notes', 'facts check out');
check('two do not either, when three were assigned', task().state, 'reviewing');
relay('review', id, '--slot', 'c', '--result', 'fail', '--notes', 'nothing here is re-derivable');
check('the third reviewer can fail the attempt on its own', task().state, 'failed');
check('and every verdict is in the notes handed to the retry',
  ['[review a', '[review b', '[review c'].every(k => task().review_notes.includes(k)), true);

let refused = '';
try { relay('review', id, '--slot', 'd', '--result', 'pass', '--notes', 'x'); }
catch (e) { refused = String(e.stderr || e.stdout || e.message); }
check('a reviewer that was not assigned is refused', /--slot must be one of: a, b, c/.test(refused), true);

// A roster change mid-ticket must not strand the ticket. The task carries its own.
A.setSlots(['a', 'b']);
check('the running ticket keeps the roster it was assigned', task().review_slots, ['a', 'b', 'c']);
relay('assign', id, '--slots', 'ab');
check('and picks up the new one on the next attempt', task().review_slots, ['a', 'b']);
relay('built', id, '--notes', 'second go');
relay('review', id, '--slot', 'a', '--result', 'pass', '--notes', 'ok');
relay('review', id, '--slot', 'b', '--result', 'pass', '--notes', 'ok');
check('two passes now resolve it', task().state, 'passed');

// ── 6. resetting everything ──────────────────────────────────────
A.setRole('classify', { instructions: 'Guess.' });
A.setSlots(['a', 'b', 'c', 'd']);
A.resetAll();
check('reset puts the reviewers back', A.activeSlots(), ['a', 'b']);
check('reset puts the prompts back', A.instructions('classify') === P.CLASSIFY, true);
check('and leaves no file behind', existsSync(A.FILE), false);

rmSync(DATA, { recursive: true, force: true });
process.stdout.write(failed ? `\n${failed} check(s) FAILED\n` : '\nThe roster is configurable and the extra reviewer really gates\n');
process.exit(failed ? 1 : 0);
