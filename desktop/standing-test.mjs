// standing-test.mjs - the instructions that apply to every ticket.
//   node desktop/standing-test.mjs
//
// The composition order is the whole feature: standing instructions, then the ticket's own
// requirement, then anything added while it ran. Get that wrong and a house-style note
// reads as something this ticket asked for, or a ticket that deliberately sets a rule
// aside gets refused for breaking it.
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, '.standing-test');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.RELAY_DATA_DIR = DATA;

const S = await import(pathToFileURL(join(ROOT, 'app', 'standing.mjs')).href);
const I = await import(pathToFileURL(join(ROOT, 'app', 'inputs.mjs')).href);

let failed = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}\n`);
};

check('none to begin with', S.text(), '');
check('and the spec is passed through untouched', S.withStanding('DO THE THING'), 'DO THE THING');
check('status says so', S.status().present, false);

S.save('Write in British English.');
check('saved', S.text(), 'Write in British English.');
check('status updates', [S.status().present, S.status().chars], [true, 25]);

const composed = S.withStanding('DO THE THING');
check('the instructions come first', composed.indexOf('British') < composed.indexOf('DO THE THING'), true);
check('both are labelled', /--- STANDING INSTRUCTIONS ---[\s\S]*--- REQUIREMENT ---/.test(composed), true);
check('the requirement is told it wins a conflict', /the requirement\s*\n?below explicitly says otherwise|requirement\s*\n?wins/.test(composed), true);

// The real composition, through the path every stage actually uses.
const full = I.specWith('t-1', 'DO THE THING');
check('specWith applies them', full.includes('British'), true);
I.addAddendum('t-1', 'Actually, American English.');
const both = I.specWith('t-1', 'DO THE THING');
check('all three layers, in order',
  [both.indexOf('British') < both.indexOf('DO THE THING'),
   both.indexOf('DO THE THING') < both.indexOf('American')], [true, true]);
check('one ticket\u2019s addendum does not leak to another',
  I.specWith('t-2', 'OTHER').includes('American'), false);
check('but the standing ones reach every ticket', I.specWith('t-2', 'OTHER').includes('British'), true);

// Saving nothing clears them, rather than storing an empty rule block on every prompt.
S.save('   ');
check('blank clears', S.text(), '');
check('and the spec goes back to being itself', I.specWith('t-2', 'OTHER'), 'OTHER');

let refused = 'accepted';
try { S.save('x'.repeat(S.LIMIT + 1)); } catch { refused = 'refused'; }
check('an oversized block is refused', refused, 'refused');
check('and nothing was stored', S.text(), '');

// Editable outside the app: whatever is on disk at the moment a stage runs is what it gets,
// so the file can equally be edited in an editor or kept in version control.
S.save('first');
const { writeFileSync } = await import('node:fs');
writeFileSync(S.FILE, 'edited in an editor', 'utf8');
check('a change made on disk is picked up', S.withStanding('X').includes('edited in an editor'), true);
check('and is what every stage sees', I.specWith('t-9', 'X').includes('edited in an editor'), true);

rmSync(DATA, { recursive: true, force: true });
process.stdout.write(failed ? `\n${failed} check(s) FAILED\n` : '\nstanding instructions reach every ticket\n');
process.exit(failed ? 1 : 0);
