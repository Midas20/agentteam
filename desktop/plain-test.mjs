// plain-test.mjs - does the payload cleaner remove formatting without eating content?
//   node desktop/plain-test.mjs
//
// The risk is not that it misses a `**`. The risk is that it mangles something real — an
// asterisk inside a code block, a glob, a multiplication sign — and the person pastes a
// broken command. Every check below that starts "leaves" is guarding against that.
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { plainText } = await import(pathToFileURL(join(ROOT, 'app', 'plain.mjs')).href);

let failed = 0;
const check = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}\n`);
};

check('bold goes', plainText('I rated **A as bad**.'), 'I rated A as bad.');
check('bold-italic goes', plainText('***very***'), 'very');
check('underscore bold goes', plainText('__strong__ point'), 'strong point');
check('single-asterisk italic goes', plainText('that is *not* true'), 'that is not true');
check('a heading loses its hashes', plainText('## Q1: the question'), 'Q1: the question');
check('a blockquote loses its marker', plainText('> quoted line'), 'quoted line');
check('an asterisk bullet becomes a dash', plainText('* first\n* second'), '- first\n- second');
check('a plus bullet becomes a dash', plainText('+ item'), '- item');
check('a dash bullet is left alone', plainText('- item'), '- item');
check('a numbered list is left alone', plainText('1. item'), '1. item');
check('short backticks go', plainText('run `npm test` now'), 'run npm test now');

// The guards.
check('leaves a lone asterisk', plainText('see the note *'), 'see the note *');
check('leaves a glob', plainText('match src/*.js and lib/*.js'), 'match src/*.js and lib/*.js');
check('leaves multiplication', plainText('3 * 4 * 5'), '3 * 4 * 5');
check('leaves a fenced block untouched',
  plainText('text **bold**\n```\nx = a ** b\n* not a bullet\n```\nafter **bold**'),
  'text bold\n```\nx = a ** b\n* not a bullet\n```\nafter bold');
check('leaves an indented block untouched',
  plainText('intro **bold**\n    kwargs = {**opts}\ndone'),
  'intro bold\n    kwargs = {**opts}\ndone');
check('leaves a long backticked snippet alone',
  plainText('`' + 'x'.repeat(70) + '`'), '`' + 'x'.repeat(70) + '`');
check('leaves underscores inside a name', plainText('call read_task_file now'), 'call read_task_file now');
check('leaves an empty payload alone', plainText(''), '');

process.stdout.write(failed ? `\n${failed} check(s) FAILED\n` : '\nformatting goes, content stays\n');
process.exit(failed ? 1 : 0);
