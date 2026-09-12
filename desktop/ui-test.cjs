// ui-test.cjs - does the page render real task shapes without throwing?
//
//   node_modules/electron/dist/electron.exe desktop/ui-test.cjs
//
// The renderer is the part with no type checking and no server to catch mistakes. This
// feeds it the states a ticket actually passes through — including the awkward ones, an
// escalated run and a run with no reviews yet — and fails on any console error.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { rmSync } = require('node:fs');
const say = (m) => process.stdout.write(m + '\n');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const DATA = path.join(app.getPath('userData'), 'ui-test');
  rmSync(DATA, { recursive: true, force: true });
  process.env.RELAY_DATA_DIR = DATA;
  const server = await import('../app/server.mjs');
  const port = await server.start(7395);
  const win = new BrowserWindow({ width: 1280, height: 900, show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true } });
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
  await win.loadURL(`http://127.0.0.1:${port}/`);
  await wait(2000);
  const js = (c) => win.webContents.executeJavaScript(c);
  await js(`document.querySelector('#settings').close(); true`);

  let failed = 0;
  const check = (n, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    say(`  ${ok ? 'ok  ' : 'FAIL'} ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };

  const now = new Date().toISOString();
  const older = new Date(Date.now() - 754000).toISOString();
  const base = (over) => Object.assign({
    id: 't-x', title: 'A ticket', kind: 'answer', output_mode: 'paste',
    model: { work: 'sonnet', review: 'opus' }, state: 'assigned', attempt: 1, cap: 3,
    created: older, updated: now, reviews: {}, history: [], build_notes: '', payload: '',
    attachments: [], usage: null,
  }, over);

  const feed = (tasks) => js(`(() => {
    STATE = { tasks: ${JSON.stringify(tasks)}, env: { credentials: true, usage: { calls: 9, input: 100, output: 2000, cacheRead: 500000, cacheWrite: 210000, costUsd: 3.4567 }, provider: { mode:'auto', active:'cli', cli:{available:true,path:'x'} }, auth:{source:'none',signedIn:false,profiles:[],antInstalled:false}, key:{stored:false} } };
    render(); return true; })()`);

  // 1. Mid-run, nothing reviewed yet.
  await feed([base({})]);
  await js(`selected = 't-x'; render(); true`);
  await wait(300);
  check('renders a running ticket', await js(`!!document.querySelector('.stagestrip li.now')`), true);
  check('shows a live clock', await js(`!!document.querySelector('.trow .clock[data-live="1"]')`), true);
  check('elapsed reads in minutes', await js(`document.querySelector('.trow .clock').textContent.includes('m')`), true);

  // 2. Delivered with per-ticket cost.
  await feed([base({ state: 'delivered', payload: 'PASTE ME', reviews: { a: { result:'pass', notes:'ok' }, b: { result:'pass', notes:'ok' } },
                     usage: { calls: 6, input: 10, output: 20, cacheRead: 1, cacheWrite: 2, costUsd: 1.234 } })]);
  await wait(300);
  check('result panel appears', await js(`!document.querySelector('.result').hidden`), true);
  check('payload is shown verbatim', await js(`document.querySelector('.payloadbox').textContent`), 'PASTE ME');
  check('hint carries chars, time and cost',
    await js(`(() => { const s = document.querySelector('.rhint').textContent;
      return s.includes('8 characters') && s.includes('$1.23') && s.includes('took'); })()`), true);
  check('cost shows in the list', await js(`document.querySelector('.trow .m').textContent.includes('$1.23')`), true);

  // 3. Escalated — the failure case must not look like a result.
  await feed([base({ state: 'delivered', payload: 'why it failed', history: [{ to: 'escalated', attempt: 3, note: 'x' }],
                     reviews: { a: { result:'pass', notes:'ok' }, b: { result:'fail', notes:'no' } } })]);
  await wait(300);
  check('escalation is styled as a failure', await js(`document.querySelector('.result').classList.contains('escal')`), true);
  check('and says so', await js(`document.querySelector('.rlabel').textContent`), 'Could not complete');
  check('the failing reviewer is marked', await js(`!!document.querySelector('.rev.bad')`), true);

  // 4. Long reasoning must clamp, then expand.
  const long = 'x'.repeat(900);
  await js(`LOGS.set('t-x', [{ at: new Date().toISOString(), level: 'think', stage: 'work', text: ${JSON.stringify(long)} },
                              { at: new Date().toISOString(), level: 'tool', stage: 'work', text: 'WebSearch' }]); render(); true`);
  await wait(300);
  check('long reasoning is clamped', await js(`document.querySelector('.ev.expandable .x').textContent.length < 200`), true);
  // Doubled backslashes on purpose: this regex travels through a template literal, where
  // a lone \d collapses to a plain "d" and the check would quietly test nothing.
  check('and carries a timestamp',
    await js(`/\\d\\d:\\d\\d:\\d\\d/.test(document.querySelector('.ev .ts').textContent)`), true);

  // The log once shipped with three children in a two-column grid: the text wrapped onto a
  // second row, landed in the 78px timestamp track, and every line broke after two words.
  // Nothing caught it, because every other check only asked whether the text was present.
  // Measure the column, not the content.
  check('the text column gets most of the row',
    await js(`(() => { const ev = document.querySelector('.ev'), x = document.querySelector('.ev .x');
      return x.getBoundingClientRect().width > ev.getBoundingClientRect().width * 0.6; })()`), true);
  check('and the log does not scroll sideways',
    await js(`(() => { const b = document.querySelector('.logbody');
      return b.scrollWidth <= b.clientWidth; })()`), true);

  await js(`document.querySelector('.ev.expandable').click(); true`);
  await wait(200);
  check('clicking reveals the whole thing', await js(`document.querySelector('.ev .full').textContent.length`), 900);

  // 5. The header counter.
  check('usage renders as bare numbers',
    await js(`document.querySelector('#usage').textContent.trim()`), '9  100  2.0k  500k  $3.46');

  // 6. Several tickets at once, which is the normal case now.
  await feed([base({ id: 't-1', title: 'one' }), base({ id: 't-2', title: 'two', state: 'reviewing' }),
              base({ id: 't-3', title: 'three', state: 'delivered', payload: 'p' })]);
  await wait(300);
  check('three tickets listed', await js(`document.querySelectorAll('.trow').length`), 3);
  check('two show as live', await js(`document.querySelectorAll('.trow.live').length`), 2);

  // 7. Scroll position must survive a re-render, or reading an earlier stage during a
  //    run is impossible: the next state frame yanks you back to the bottom.
  await js(`selected = 't-1';
    LOGS.set('t-1', Array.from({ length: 80 }, (_, i) =>
      ({ at: new Date().toISOString(), level: 'tool', stage: 'work', text: 'event ' + i })));
    render(); true`);
  await wait(300);
  await js(`document.querySelector('.logbody').scrollTop = 0; render(); true`);
  await wait(300);
  check('scrolling back is not undone by a re-render',
    await js(`document.querySelector('.logbody').scrollTop`), 0);

  await js(`const b = document.querySelector('.logbody'); b.scrollTop = b.scrollHeight; render(); true`);
  await wait(300);
  check('but following the tail still follows',
    await js(`(() => { const b = document.querySelector('.logbody');
      return b.scrollHeight - b.scrollTop - b.clientHeight < 60; })()`), true);

  // 8. Stop / Run again / Delete must appear for the right states.
  await js(`RUNSTATUS.set('t-1', { status: 'running' }); render(); true`);
  await wait(200);
  check('a running ticket offers Stop',
    await js(`!document.querySelector('.stop').hidden && document.querySelector('.retry').hidden`), true);
  check('and cannot be deleted', await js(`document.querySelector('.del').hidden`), true);

  await js(`RUNSTATUS.set('t-1', { status: 'cancelled', error: 'Stopped by you.' }); render(); true`);
  await wait(200);
  check('a stopped ticket offers Resume', await js(`document.querySelector('.retry').textContent`), 'Resume');
  check('and can now be deleted', await js(`document.querySelector('.del').hidden`), false);

  // 9. Finishing: the sheet that carries what the person uploads.
  await feed([base({ id: 't-x', state: 'delivered', payload: 'Q1: the answer -> yes',
                     usage: { calls: 6, input: 1, output: 2, cacheRead: 1, cacheWrite: 1, costUsd: 0.5 } })]);
  await js(`selected = 't-x'; LOGS.set('t-x', []); render(); true`);
  await wait(300);
  check('the sheet is not open until something finishes',
    await js(`document.querySelector('#finished').hidden`), true);
  check('a finished ticket offers Full screen',
    await js(`!document.querySelector('.expand').hidden`), true);

  await js(`document.querySelector('.expand').click(); true`);
  await wait(300);
  check('Full screen opens the sheet', await js(`!document.querySelector('#finished').hidden`), true);
  check('it carries the payload verbatim',
    await js(`document.querySelector('#fin-payload').textContent`), 'Q1: the answer -> yes');
  check('and numbered steps for uploading it',
    await js(`document.querySelectorAll('#fin-guide li').length >= 3`), true);
  check('Escape closes it',
    await js(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return document.querySelector('#finished').hidden; })()`), true);

  // An escalation must never look like something to submit.
  await feed([base({ id: 't-x', state: 'delivered', payload: 'why it failed',
                     history: [{ to: 'escalated', attempt: 3, note: 'x' }] })]);
  await js(`selected = 't-x'; LOGS.set('t-x', []); render();
            document.querySelector('.expand').click(); true`);
  await wait(300);
  check('an escalation opens as a failure',
    await js(`document.querySelector('#finished').classList.contains('bad')`), true);
  check('and its steps do not say to submit it',
    await js(`/nothing here is ready to submit/i.test(document.querySelector('#fin-guide').textContent)`), true);
  await js(`document.querySelector('#fin-close').click(); true`);
  await wait(200);

  check('no console errors throughout', errors, []);
  try { rmSync(DATA, { recursive: true, force: true }); } catch {}
  say(failed ? `\n${failed} check(s) FAILED\n` : '\nUI renders every state cleanly\n');
  app.exit(failed ? 1 : 0);
}).catch(e => { say('ERROR: ' + (e && e.stack || e)); app.exit(1); });
