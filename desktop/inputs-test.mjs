// inputs-test.mjs - per-ticket model pins and mid-run instructions.
//   node desktop/inputs-test.mjs
//
// These are inputs to a run, not ledger state, so they have their own store. The rules
// worth holding: an unknown stage or model is refused rather than stored, a refused write
// leaves the previous value alone, addenda are appended in order and marked as arriving
// late, and one ticket never sees another's.
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';
const DATA = 'C:/Users/Administrator/Documents/Claude Workflow/.inputs-test';
rmSync(DATA, { recursive: true, force: true });
process.env.RELAY_DATA_DIR = DATA;
const I = await import(pathToFileURL('C:/Users/Administrator/Documents/Claude Workflow/app/inputs.mjs').href);
let failed = 0;
const check = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

check('no pins to start', I.read('t-1').models, {});
check('pinning a stage', I.setModels('t-1', { work: 'opus' }), { work: 'opus' });
check('reading it back', I.modelFor('t-1', 'work'), 'opus');
check('auto clears a pin', I.setModels('t-1', { work: 'auto' }), {});
check('unknown stage is refused', (() => { try { I.setModels('t-1', { nope: 'opus' }); return 'accepted'; } catch (e) { return 'refused'; } })(), 'refused');
check('unknown model is refused', (() => { try { I.setModels('t-1', { work: 'gpt' }); return 'accepted'; } catch (e) { return 'refused'; } })(), 'refused');
check('a refused write changes nothing', I.read('t-1').models, {});

check('spec is untouched with no addenda', I.specWith('t-2', 'DO THE THING'), 'DO THE THING');
I.addAddendum('t-2', 'also use British spelling');
const s1 = I.specWith('t-2', 'DO THE THING');
check('the original survives', s1.startsWith('DO THE THING'), true);
check('the addendum is appended', s1.includes('also use British spelling'), true);
check('and is marked as arriving later', s1.includes('WHILE THIS TICKET WAS RUNNING'), true);
I.addAddendum('t-2', 'second thought');
const s2 = I.specWith('t-2', 'DO THE THING');
check('both are carried, in order', [s2.indexOf('British') < s2.indexOf('second thought'), (s2.match(/ADDED BY THE REQUESTER/g) || []).length], [true, 2]);
check('empty text is refused', (() => { try { I.addAddendum('t-2', '   '); return 'accepted'; } catch { return 'refused'; } })(), 'refused');
check('tickets do not share addenda', I.specWith('t-1', 'X'), 'X');
I.forget('t-2');
check('forget clears them', I.read('t-2').addenda, []);

rmSync(DATA, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED\n` : '\nper-ticket inputs behave\n');
process.exit(failed ? 1 : 0);
