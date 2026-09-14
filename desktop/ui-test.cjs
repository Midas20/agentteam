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
  await wait(500);
  const js = (c) => win.webContents.executeJavaScript(c);
  // Anything that goes to the server has to be waited FOR, not waited OUT. A fixed sleep
  // long enough on this machine is a coin toss on a slower one, and the failure it
  // produces looks exactly like a real bug in the thing being tested.
  const until = async (expr, ms = 6000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms;) {
      try { if (await js(expr)) return true; } catch { /* mid-render */ }
      await wait(80);
    }
    return false;
  };
  // The first real state frame has to have landed before anything else happens. The
  // server awaits an auth probe to build it, and that probe can take seconds on a machine
  // where the CLI is missing - so the frame can otherwise arrive in the middle of a later
  // step, where it re-opens the settings dialog on the sign-in pane and every check after
  // it fails for a reason that has nothing to do with what was being tested.
  for (let i = 0; i < 300 && !(await js(`!!render._asked`)); i++) await wait(100);
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
    spec: 'Rate each answer and explain the rating.',
    kind_why: 'It asks for selections plus a written explanation.',
    review_slots: ['a', 'b'],
    model: { work: 'sonnet', review: 'opus' }, state: 'assigned', attempt: 1, cap: 3,
    created: older, updated: now, reviews: {}, history: [], build_notes: '', payload: '',
    attachments: [], usage: null,
  }, over);

  // The roster as the server publishes it. Reviewer C is switched off but still named:
  // a ticket judged by three has to keep saying three afterwards.
  const REVIEWERS = [
    { slot: 'a', label: 'Reviewer A', axis: 'Compliance', blurb: 'Was it all delivered?' },
    { slot: 'b', label: 'Reviewer B', axis: 'Correctness', blurb: 'Is it actually right?' },
    { slot: 'c', label: 'Reviewer C', axis: 'Evidence', blurb: 'Could a stranger re-derive it?' },
    { slot: 'd', label: 'Reviewer D', axis: 'Risk', blurb: 'What would cost most if wrong?' },
  ];

  const feed = (tasks) => js(`(() => {
    STATE = { tasks: ${JSON.stringify(tasks)}, env: { credentials: true, usage: { calls: 9, input: 100, output: 2000, cacheRead: 500000, cacheWrite: 210000, costUsd: 3.4567 }, provider: { mode:'auto', active:'cli', cli:{available:true,path:'x'} }, auth:{source:'none',signedIn:false,profiles:[],antInstalled:false}, key:{stored:false},
      agents: { slots:['a','b'], method: ${JSON.stringify(REVIEWERS.slice(0,2))}, reviewers: ${JSON.stringify(REVIEWERS)} } } };
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
                     reviews: { a: { result: 'pass', notes: 'every clause met' },
                                b: { result: 'pass', notes: 'both links check out' } },
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

  // The sheet has to make its case before it hands over the answer: what was asked and
  // how it was going to be judged, then how it went, and only then what to submit. It
  // opened on the payload for a while, which is a conclusion with its argument missing.
  check('three numbered sections', await js(`document.querySelectorAll('#finished .fsec').length`), 3);
  check('numbered 1, 2, 3 in order',
    await js(`[...document.querySelectorAll('#finished .fnum')].map(n => n.textContent).join('')`), '123');
  check('the requirement comes before the payload',
    await js(`(() => { const spec = document.querySelector('#fin-spec'), pay = document.querySelector('#fin-payload');
      return !!(spec.compareDocumentPosition(pay) & Node.DOCUMENT_POSITION_FOLLOWING); })()`), true);
  check('the verdicts come between them',
    await js(`(() => { const v = document.querySelector('#fin-verdict'), spec = document.querySelector('#fin-spec'),
        pay = document.querySelector('#fin-payload');
      return !!(spec.compareDocumentPosition(v) & Node.DOCUMENT_POSITION_FOLLOWING)
          && !!(v.compareDocumentPosition(pay) & Node.DOCUMENT_POSITION_FOLLOWING); })()`), true);
  check('the requirement is shown verbatim',
    await js(`document.querySelector('#fin-spec').textContent`), 'Rate each answer and explain the rating.');
  check('and what it was read as',
    await js(`/evaluation to answer/.test(document.querySelector('#fin-target').textContent)`), true);
  check('the review method names every reviewer that judged it',
    await js(`[...document.querySelectorAll('#fin-method li b')].map(b => b.textContent)`),
    ['Reviewer A', 'Reviewer B']);
  check('each with the axis it was working on',
    await js(`[...document.querySelectorAll('#fin-method li')].map(li => li.textContent.includes('·'))`),
    [true, true]);
  check('and says a single fail is enough',
    await js(`/one fail/i.test(document.querySelector('#fin-rule').textContent)`), true);
  check('the verdict says which attempt carried it',
    await js(`/attempt 1 of 3/i.test(document.querySelector('#fin-verdict').textContent)`), true);

  // 9b. The reviewers on the sheet, including one that failed.
  await feed([base({ id: 't-x', state: 'delivered', payload: 'Q1: yes', attempt: 2,
                     reviews: { a: { result: 'pass', notes: 'every clause met' },
                                b: { result: 'fail', notes: 'the second link 404s' } } })]);
  await js(`selected = 't-x'; LOGS.set('t-x', []); render();
            document.querySelector('.expand').click(); true`);
  await wait(300);
  check('each reviewer gets its own block', await js(`document.querySelectorAll('#fin-reviews .frev').length`), 2);
  check('a failure is open by default, a pass is not',
    await js(`[...document.querySelectorAll('#fin-reviews .frev')].map(d => d.open)`), [false, true]);
  check('the failing reviewer notes are readable',
    await js(`document.querySelector('#fin-reviews .frev.bad .frevnotes').textContent`), 'the second link 404s');

  // 9c. A ticket judged by three keeps saying three, even with C now switched off.
  await feed([base({ id: 't-x', state: 'delivered', payload: 'Q1: yes', review_slots: ['a', 'b', 'c'],
                     reviews: { a: { result: 'pass', notes: 'ok' }, b: { result: 'pass', notes: 'ok' },
                                c: { result: 'pass', notes: 'ok' } } })]);
  await js(`selected = 't-x'; LOGS.set('t-x', []); render();
            document.querySelector('.expand').click(); true`);
  await wait(300);
  check('three reviewers are described', await js(`document.querySelectorAll('#fin-method li').length`), 3);
  check('and three verdicts shown', await js(`document.querySelectorAll('#fin-reviews .frev').length`), 3);
  check('the count in the prose matches',
    await js(`/^3 reviewers/.test(document.querySelector('#fin-rule').textContent)`), true);
  check('the ticket panel labels its slots by axis',
    await js(`[...document.querySelectorAll('.slots .slot')].map(s => s.textContent.split(':')[0])`),
    ['Compliance', 'Correctness', 'Evidence']);
  await js(`document.querySelector('#fin-close').click(); true`);
  await wait(200);
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

  // 10. The agent roster in Settings, against the real endpoints. An editor that saves
  //     text nothing reads would look identical from the screen, so the last check reads
  //     the value back out of the server rather than out of the page.
  await js(`document.querySelector('#opensettings').click(); true`);
  await wait(300);
  check('the dialog opens on sign-in',
    await js(`document.querySelector('#settings .pane[data-pane="auth"]').hidden`), false);
  check('and the roster is behind its own tab',
    await js(`document.querySelector('#settings .pane[data-pane="agents"]').hidden`), true);
  await js(`document.querySelector('#settabs [data-pane="agents"]').click(); true`);
  check('the tab shows it',
    await js(`document.querySelector('#settings .pane[data-pane="agents"]').hidden`), false);
  check('and the sign-in pane steps aside',
    await js(`document.querySelector('#settings .pane[data-pane="auth"]').hidden`), true);

  await until(`document.querySelectorAll('#agentlist .arow').length === 12`);
  check('every agent is listed', await js(`document.querySelectorAll('#agentlist .arow').length`), 12);
  check('grouped by what they do',
    await js(`[...document.querySelectorAll('#agentlist .agroup h4')].map(h => h.textContent)`),
    ['Intake', 'Workers', 'Reviewers', 'Result']);
  check('four reviewer slots are offered', await js(`document.querySelectorAll('#slotpick input').length`), 4);
  check('two of them are on',
    await js(`[...document.querySelectorAll('#slotpick input')].filter(c => c.checked).map(c => c.value)`), ['a', 'b']);
  check('the ones that are off say so',
    await js(`document.querySelectorAll('#agentlist .arow.off').length`), 2);

  await js(`[...document.querySelectorAll('#agentlist .arow')].find(b => b.dataset.id === 'reviewer.b').click(); true`);
  if (!await until(`!document.querySelector('#agentedit').hidden`)) {
    say('  DEBUG open toast=' + await js(`document.querySelector('#toast').textContent`));
    say('  DEBUG editing=' + await js(`JSON.stringify(editingAgent && editingAgent.id)`));
    say('  DEBUG probe=' + await js(`fetch('/api/agent?id=reviewer.b').then(r => r.status + ':' + r.headers.get('content-type')).catch(e => 'THREW ' + e.message)`));
    say('  DEBUG paneHidden=' + await js(`document.querySelector('#settings .pane[data-pane="agents"]').hidden`));
  }
  check('clicking one opens its instructions',
    await js(`document.querySelector('#ag-text').value.length > 500`), true);
  check('and its axis', await js(`document.querySelector('#ag-axis').value`), 'Correctness');
  check('the list gets out of the way while editing',
    await js(`document.querySelector('#agentlist').hidden`), true);

  await js(`document.querySelector('#ag-text').value = 'Check only the dates.';
            document.querySelector('#ag-axis').value = 'Dates';
            document.querySelector('#ag-save').click(); true`);
  if (!await until(`document.querySelector('#agentedit').hidden`))
    say('  DEBUG toast=' + await js(`document.querySelector('#toast').textContent`)
      + ' saveDisabled=' + await js(`document.querySelector('#ag-save').disabled`));
  check('saving closes the editor', await js(`document.querySelector('#agentedit').hidden`), true);
  await until(`[...document.querySelectorAll('#agentlist .arow')]
    .find(b => b.dataset.id === 'reviewer.b').textContent.includes('edited')`);
  check('and the row is marked as edited',
    await js(`[...document.querySelectorAll('#agentlist .arow')]
      .find(b => b.dataset.id === 'reviewer.b').textContent.includes('edited')`), true);
  // The one that matters: an editor that saves text nothing reads would look identical
  // from the screen. Read it back out of the server, not out of the page.
  const saved = await js(`fetch('/api/agent?id=reviewer.b').then(r => r.json()).then(r => r.instructions)`);
  check('the server is running the edited text', saved, 'Check only the dates.');

  await js(`[...document.querySelectorAll('#agentlist .arow')].find(b => b.dataset.id === 'reviewer.b').click(); true`);
  await until(`document.querySelector('#ag-text').value.length > 500`);
  check('reopening shows the saved text is resettable',
    await js(`!document.querySelector('#ag-reset').hidden`), true);
  await js(`document.querySelector('#ag-reset').click(); true`);
  await until(`document.querySelector('#ag-text').value.length > 500`);
  check('reset puts the shipped text back',
    await js(`document.querySelector('#ag-text').value.length > 500`), true);
  await js(`document.querySelector('#ag-cancel').click(); true`);

  // A third reviewer, switched on the way a person would switch one on.
  await js(`(() => { const c = [...document.querySelectorAll('#slotpick input')].find(i => i.value === 'c');
    c.checked = true; c.onchange(); return true; })()`);
  await until(`[...document.querySelectorAll('#slotpick input')].filter(c => c.checked).length === 3`);
  check('a third reviewer switches on',
    await js(`fetch('/api/agents').then(r => r.json()).then(r => r.slots)`), ['a', 'b', 'c']);

  // And a single reviewer is refused, with the boxes put back rather than left lying.
  await js(`(() => { for (const i of document.querySelectorAll('#slotpick input')) i.checked = i.value === 'a';
    document.querySelector('#slotpick input').onchange(); return true; })()`);
  await until(`[...document.querySelectorAll('#slotpick input')].filter(c => c.checked).length > 1`);
  check('a single reviewer is refused and the boxes recover',
    await js(`[...document.querySelectorAll('#slotpick input')].filter(c => c.checked).length >= 2`), true);
  await js(`document.querySelector('#settings').close(); true`);

  check('no console errors throughout', errors, []);
  try { rmSync(DATA, { recursive: true, force: true }); } catch {}
  say(failed ? `\n${failed} check(s) FAILED\n` : '\nUI renders every state cleanly\n');
  app.exit(failed ? 1 : 0);
}).catch(e => { say('ERROR: ' + (e && e.stack || e)); app.exit(1); });
