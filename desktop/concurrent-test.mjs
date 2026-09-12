// concurrent-test.mjs - can several workflows run at once?
//
//   node desktop/concurrent-test.mjs
//
// The ledger serialises writes to a single task with a mkdir lock. The question this
// answers is the opposite one: that the lock is PER TASK, so three tickets started
// together all make progress instead of queueing behind each other.
import { mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', '.concurrent-test');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.RELAY_DATA_DIR = DATA;

const { ledger } = await import('../app/engine.mjs');

const say = (m) => process.stdout.write(m + '\n');
let failed = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  say(`  ${ok ? 'ok  ' : 'FAIL'} ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

// Three tickets created at the same moment.
const ids = await Promise.all([1, 2, 3].map(n =>
  ledger(['new', '--title', `ticket ${n}`, '--spec', `requirement number ${n}`, '--cap', '2'])
    .then(o => o.split('\n')[0].trim())));
check('three tickets created together', ids.length, 3);
check('each got its own id', new Set(ids).size, 3);

// Drive all three through the same states at the same time, which is where a shared
// lock or a shared temp path would show up as a lost write.
await Promise.all(ids.map(id => ledger(['classify', id, '--kind', 'answer', '--mode', 'paste', '--why', 'test', '--by', 'test'])));
await Promise.all(ids.map(id => ledger(['model', id, '--work', 'sonnet', '--review', 'sonnet', '--why', 'test', '--by', 'test'])));
await Promise.all(ids.map(id => ledger(['assign', id, '--by', 'test'])));
await Promise.all(ids.map(id => ledger(['built', id, '--notes', `notes for ${id}`, '--by', 'test'])));

// Both reviews of all three at once: six concurrent writers, two per file.
await Promise.all(ids.flatMap(id => ['a', 'b'].map(slot =>
  ledger(['review', id, '--slot', slot, '--result', 'pass', '--notes', `${slot} ok`, '--by', 'test']))));

const read = (id) => JSON.parse(readFileSync(join(DATA, 'tasks', `${id}.json`), 'utf8'));
const tasks = ids.map(read);
check('all three reached a verdict', tasks.map(t => t.state), ['passed', 'passed', 'passed']);
check('no review was lost to a race', tasks.map(t => Object.keys(t.reviews).length), [2, 2, 2]);
check('each kept its own notes', tasks.map(t => t.build_notes === `notes for ${t.id}`), [true, true, true]);
check('no stray lock directories', readdirSync(join(DATA, 'tasks')).filter(f => f.endsWith('.lock')).length, 0);

rmSync(DATA, { recursive: true, force: true });
say(failed ? `\n${failed} check(s) FAILED\n` : '\nconcurrent workflows are safe\n');
process.exit(failed ? 1 : 0);
