'use strict';
// Claude Workflow front end. Task state comes from the ledger over SSE; run commentary arrives
// as separate events and is also fetchable, so a reload recovers a run already in flight.

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

let STATE = { tasks: [], env: {} };
let selected = null;
let images = [];   // every attachment travels with the task
const LOGS = new Map();          // id -> events[]
const RUNSTATUS = new Map();     // id -> {status, error}

const STAGES = ['Classify', 'Model', 'Work', 'Review', 'Verdict', 'Result'];

// The five stages a model can be pinned to, in the order they run, with the label the
// person sees. 'Verdict' is not here: it is bookkeeping, not a model call.
const PIN_STAGES = [['classify', 'Classify'], ['model', 'Pick model'], ['work', 'Do the work'],
                    ['review', 'Review'], ['result', 'Write result']];
const PIN_MODELS = ['auto', 'opus', 'sonnet', 'haiku', 'fable'];
const modelOptions = (chosen) => PIN_MODELS.map(m =>
  `<option value="${m}"${m === (chosen || 'auto') ? ' selected' : ''}>${m === 'auto' ? 'Auto' : m}</option>`).join('');
const stageIndex = (t) => ({
  open: 0, classified: t.model ? 2 : 1, assigned: 2, built: 3, reviewing: 3,
  passed: 4, failed: 4, escalated: 4, delivered: 5,
}[t.state] ?? 0);
const TONE = { open:'neutral', classified:'neutral', assigned:'go', built:'go', reviewing:'go',
  passed:'ok', failed:'bad', escalated:'warn', delivered:'ok' };

async function api(path, opts) {
  const r = await fetch(path, opts);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || `request failed (${r.status})`);
  return b;
}
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, 2400);
}
async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const was = btn.textContent; btn.textContent = 'Copied'; btn.classList.add('done');
    setTimeout(() => { btn.textContent = was; btn.classList.remove('done'); }, 1700);
    toast('Copied — paste it into the ticket');
  } catch { toast('Could not copy — select the text and copy manually'); }
}

// ── live ────────────────────────────────────────────────────────
function connect() {
  const es = new EventSource('/api/events');
  es.onopen  = () => { $('#live').classList.add('on'); $('#live').title = 'live'; };
  es.onerror = () => { $('#live').classList.remove('on'); $('#live').title = 'reconnecting…'; };
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    // Defaults first: one malformed frame must not throw inside render() and take the
    // rest of the page's event handling down with it.
    if (m.type === 'state') { STATE = { tasks: [], env: {}, ...m }; render(); announceFinished(); return; }
    if (m.type === 'usage') { if (STATE.env) STATE.env.usage = m.usage; paintUsage(); return; }
    if (m.type === 'event') {
      if (!LOGS.has(m.id)) LOGS.set(m.id, []);
      LOGS.get(m.id).push(m.ev);
      if (m.ev.level === 'error') RUNSTATUS.set(m.id, { status: 'error', error: m.ev.text });
      if (m.id === selected) appendEvent(m.ev);
    }
  };
}

// ── render ──────────────────────────────────────────────────────
function keyLine(k, creds) {
  if (!k) return '';
  if (!k.stored && creds) return ['Using ANTHROPIC_API_KEY from the environment.', 'good'];
  if (!k.stored)          return ['No key yet. Paste one above to start running tasks.', 'warn'];
  if (k.encrypted)        return ['A key is saved, encrypted with this machine’s keychain.', 'good'];
  return [`A key is saved in plain text at ${k.file}. Encryption was not available.`, 'warn'];
}

// Numbers only, as asked: calls, input, output, cache reads, dollars. No labels, no
// commentary, no opinion about whether that is a lot.
const compact = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
                     : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n);
function paintUsage() {
  const el = $('#usage'); if (!el) return;
  const u = STATE.env?.usage;
  if (!u || !u.calls) { el.textContent = ''; return; }
  el.textContent = [compact(u.calls), compact(u.input), compact(u.output),
                    compact(u.cacheRead), '$' + Number(u.costUsd || 0).toFixed(2)].join('  ');
}

function render() {
  paintUsage();

  const signedIn = !!STATE.env?.credentials;
  $('#envwarn').hidden  = signedIn;
  $('#execwarn').hidden = !STATE.env?.exec;

  // Signing in is the first thing anyone has to do and nothing works before it, so the
  // one button that leads there says so. Calling it "Settings" hid the only door.
  const v = $('#ver');
  if (v) v.textContent = STATE.env?.version ? `v${STATE.env.version}` : '';

  const way = $('#opensettings');
  way.textContent = signedIn ? 'Settings' : 'Sign in to Claude';
  way.classList.toggle('ghost', signedIn);
  way.classList.toggle('cta', !signedIn);
  const open = STATE.tasks.filter(t => t.state !== 'delivered').length;
  $('#count').textContent = STATE.tasks.length ? `${open} running · ${STATE.tasks.length} total` : '';
  renderList();
  if (selected && !STATE.tasks.some(t => t.id === selected)) selected = null;
  renderDetail();

  if ($('#settings').open) paintAuth();
  // Nothing can run without credentials, so say so at startup rather than on first failure.
  if (!STATE.env?.credentials && !render._asked) { render._asked = true; $('#opensettings').click(); }
}

// A ticket takes ten to fifteen minutes. Without a clock the app looks hung, so anything
// not finished shows how long it has been going and keeps ticking between state changes.
const DONE_STATES = ['delivered'];
const isLive = (t) => !DONE_STATES.includes(t.state);
const secsSince = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
const dur = (s) => s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
                                              : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
const elapsedOf = (t) => dur(isLive(t) ? secsSince(t.created) : Math.max(0, Math.round(
  (new Date(t.updated).getTime() - new Date(t.created).getTime()) / 1000)));
const money = (u) => u && u.costUsd ? '$' + u.costUsd.toFixed(2) : '';

function renderList() {
  const box = $('#tasklist');
  if (!STATE.tasks.length) { box.innerHTML = '<p class="empty">Nothing yet.</p>'; return; }
  box.innerHTML = STATE.tasks.map(t => {
    const rv = ['a','b'].map(s => t.reviews[s] ? (t.reviews[s].result === 'pass' ? '✓' : '✗') : '·').join('');
    return `<button class="trow ${t.id === selected ? 'sel' : ''} ${isLive(t) ? 'live' : ''}" data-id="${t.id}">
      <span class="t">${isLive(t) ? '<i class="spin"></i>' : ''}${esc(t.title)}</span>
      <span class="pill ${TONE[t.state] || 'neutral'}">${t.state}</span>
      <span class="m"><span>${esc(t.kind || '…')}</span><span>${esc(t.model?.work || '…')}</span>
        <span>${t.attempt}/${t.cap}</span><span>rv ${rv}</span>
        <span class="clock" data-created="${t.created}" data-live="${isLive(t) ? 1 : 0}"
              data-updated="${t.updated}">${elapsedOf(t)}</span>
        <span>${money(t.usage)}</span></span>
    </button>`;
  }).join('');
  $$('.trow', box).forEach(b => b.onclick = () => { selected = b.dataset.id; render(); loadLog(b.dataset.id); });
}

// One timer for the whole page rather than a re-render per second: re-rendering steals
// text selection and scroll position, and a run lasts long enough for that to matter.
setInterval(() => {
  for (const el of $$('.clock')) {
    if (el.dataset.live !== '1') continue;
    el.textContent = dur(secsSince(el.dataset.created));
  }
}, 1000);

function renderDetail() {
  const main = $('#detail');
  const t = STATE.tasks.find(x => x.id === selected);
  if (!t) {
    // With no credentials the panel leads with the sign-in rather than with instructions
    // for something that cannot run yet.
    const needsAuth = !STATE.env?.credentials;
    main.innerHTML = `<div class="placeholder"><p>Paste a requirement to start.</p>
      <p class="muted small">Nine steps run without you: classify, pick a model, do the work,
      two independent reviews, retry on failure, then write what you paste.</p>
      ${needsAuth ? `<div class="signin-call">
        <h3>Sign in first</h3>
        <p class="muted small">Nothing can run until this app can reach Claude. Sign in with
        your browser, or paste an API key — either way it is stored on this PC only.</p>
        <button class="cta go">Sign in to Claude</button>
      </div>` : ''}</div>`;
    if (needsAuth) $('.signin-call .go', main).onclick = () => $('#opensettings').click();
    return;
  }
  const node = $('#tpl-detail').content.cloneNode(true);
  $('.ttl', node).textContent = t.title;

  // Deleting is one click plus a confirm rather than a hidden menu: after a day's work the
  // list is mostly finished tickets and there was previously no way to clear any of them.
  const del = $('.del', node);
  // Hidden only while a run is actually in flight, which is exactly what the server
  // refuses to delete. An unfinished ticket that is not running — stopped, failed, or
  // never started — is precisely the kind you most want to be able to clear.
  del.hidden = RUNSTATUS.get(t.id)?.status === 'running';
  del.onclick = async () => {
    if (!confirm(`Delete "${t.title}"? The result and its workspace go with it.`)) return;
    try {
      await api('/api/delete', { method: 'POST', headers: { 'content-type': 'application/json' },
                                 body: JSON.stringify({ id: t.id }) });
      selected = null; LOGS.delete(t.id); RUNSTATUS.delete(t.id);
      STATE = await api('/api/state'); render(); toast('Deleted');
    } catch (e) { toast(e.message); }
  };
  const sp = $('.state', node); sp.textContent = t.state; sp.className = 'pill ' + (TONE[t.state] || 'neutral');

  $('.facts', node).innerHTML = [
    ['kind', t.kind || '…'], ['output', t.output_mode || '…'],
    ['work', t.model?.work || '…'], ['review', t.model?.review || '…'],
    ['attempt', `${t.attempt}/${t.cap}`],
    ['elapsed', elapsedOf(t)],
    ...(t.usage ? [['calls', t.usage.calls], ['cost', '$' + t.usage.costUsd.toFixed(2)]] : []),
  ].map(([k, v], i) => `<span${k === 'elapsed' && isLive(t)
    ? ` class="clock-wrap"` : ''}>${k} <b${k === 'elapsed' && isLive(t)
    ? ` class="clock" data-created="${t.created}" data-live="1"` : ''}>${esc(v)}</b></span>`).join('');

  // Full screen is available whenever there is a result, not only the moment it lands:
  // the sheet gets closed, and the way back to it must not be "run it again".
  const expand = $('.expand', node);
  if (expand) { expand.hidden = !t.payload; expand.onclick = () => openSheet(t); }

  wireTicketControls(node, t);

  const idx = stageIndex(t), broken = t.state === 'failed' || t.state === 'escalated';
  $('.stagestrip', node).innerHTML = STAGES.map((s, i) =>
    `<li class="${i < idx ? 'done' : i === idx ? (broken ? 'bad' : 'now') : ''}">${s}</li>`).join('');
  $('.slots', node).innerHTML = ['a','b'].map(s => {
    const r = t.reviews[s];
    return `<span class="slot ${!r ? '' : r.result === 'pass' ? 'ok' : 'bad'}">review ${s}: ${r ? r.result : 'running'}</span>`;
  }).join('');

  // result
  if (t.state === 'delivered') {
    const sec = $('.result', node); sec.hidden = false;
    const escalated = t.history.some(h => h.to === 'escalated');
    sec.classList.toggle('escal', escalated);
    $('.rlabel', sec).textContent = escalated ? 'Could not complete' : `Result — ${t.output_mode}`;
    const chars = (t.payload || '').length;
    $('.rhint', sec).textContent = (escalated
      ? 'Every attempt failed review. This is why, not an answer.'
      : t.output_mode === 'paste'
        ? 'Paste this into the ticket exactly as it is. Nothing here needs editing.'
        : 'Follow these steps in order. Each ends with a checkpoint.')
      + `  ·  ${chars.toLocaleString()} characters  ·  took ${elapsedOf(t)}`
      + (t.usage ? `  ·  ${t.usage.calls} calls, $${t.usage.costUsd.toFixed(2)}` : '');
    $('.payloadbox', sec).textContent = t.payload || '(no payload)';
    const btn = $('.payload', sec);
    btn.onclick = () => copy(t.payload || '', btn);
  }

  // reviews
  if (t.reviews.a || t.reviews.b) {
    $('.reviews', node).hidden = false;
    $('.revbody', node).innerHTML = ['a','b'].filter(s => t.reviews[s]).map(s => {
      const r = t.reviews[s];
      const axis = s === 'a' ? 'compliance' : 'correctness';
      return `<div class="rev ${r.result === 'pass' ? 'ok' : 'bad'}">
        <h4>review ${s} · ${axis} — ${r.result}</h4><p>${esc(r.notes)}</p></div>`;
    }).join('');
  }

  if (t.build_notes) {
    $('.notes', node).hidden = false;
    $('.notesbody', node).textContent = t.build_notes;
  }

  // run log
  const rs = RUNSTATUS.get(t.id) || { status: t.state === 'delivered' ? 'done' : 'idle' };
  const badge = $('.runstatus', node);
  badge.textContent = rs.status;
  badge.className = 'pill ' + (rs.status === 'running' ? 'running' : rs.status === 'error' ? 'bad' : 'neutral');
  if (rs.error) { const e = $('.runerr', node); e.textContent = rs.error; e.hidden = false; }
  const body = $('.logbody', node);
  for (const ev of LOGS.get(t.id) || []) body.appendChild(evNode(ev));

  const w = $('.retrywrap', node);
  if (rs.status === 'running') {
    // A run costs money and a quarter of an hour, so there has to be a way out of one
    // started by mistake. Stopping keeps every finished stage; Run again picks up there.
    w.hidden = false;
    const retry = $('.retry', w); retry.hidden = true;
    const stop = $('.stop', w); stop.hidden = false;
    stop.onclick = async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await api('/api/cancel', { method:'POST', headers:{'content-type':'application/json'},
                                             body: JSON.stringify({ id: t.id }) });
        RUNSTATUS.set(t.id, { status: 'cancelled', error: 'Stopped by you.' });
        toast(r.killed ? 'Stopped' : 'Stopping — no model call was in flight');
        render();
      } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
    };
  } else if (rs.status === 'error' || rs.status === 'cancelled' || t.state !== 'delivered') {
    w.hidden = false;
    $('.stop', w).hidden = true;
    const retry = $('.retry', w); retry.hidden = false;
    retry.textContent = rs.status === 'cancelled' ? 'Resume' : 'Run again';
    retry.onclick = async (e) => {
      e.currentTarget.disabled = true;
      try { await api('/api/retry', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id: t.id }) });
            RUNSTATUS.set(t.id, { status: 'running' }); toast('Running'); render(); }
      catch (err) { toast(err.message); e.currentTarget.disabled = false; }
    };
  }

  // The panel is rebuilt on every state frame, and during a run those arrive constantly.
  // Without this, scrolling back to read an earlier stage snatches you to the bottom a
  // second later. Follow the tail only if you were already at the tail.
  const prev = $('.logbody');
  const wasFollowing = !prev || (prev.scrollHeight - prev.scrollTop - prev.clientHeight < 60);
  const prevTop = prev ? prev.scrollTop : 0;

  main.innerHTML = ''; main.appendChild(node);
  body.scrollTop = wasFollowing ? body.scrollHeight : prevTop;
}

// A worker's reasoning arrives in blocks of hundreds of words. Printed in full they bury
// the tool calls and stage changes, which are what you actually scan for; hidden entirely
// you cannot tell a stuck run from a thinking one. So: first line always, rest on click.
const CLAMP = 180;

function evNode(ev) {
  const d = document.createElement('div');
  d.className = `ev ${ev.level}`;
  const time = ev.at ? new Date(ev.at).toLocaleTimeString([], { hour12: false }) : '';
  const text = String(ev.text ?? '');
  const long = text.length > CLAMP;
  const head = long ? text.slice(0, CLAMP).replace(/\s+\S*$/, '') + '…' : text;

  d.innerHTML = `<span class="ts">${esc(time)}</span><span class="s">${esc(ev.stage)}</span>` +
    `<span class="x">${esc(head)}</span>`;
  if (long) {
    d.classList.add('expandable');
    d.title = 'click to expand';
    const full = document.createElement('div');
    full.className = 'full'; full.hidden = true; full.textContent = text;
    d.appendChild(full);
    d.addEventListener('click', () => {
      full.hidden = !full.hidden;
      $('.x', d).textContent = full.hidden ? head : '';
      d.classList.toggle('open', !full.hidden);
    });
  }
  return d;
}
function appendEvent(ev) {
  const body = $('.logbody'); if (!body) return;
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  body.appendChild(evNode(ev));
  if (atBottom) body.scrollTop = body.scrollHeight;
  if (ev.level === 'stage' || ev.level === 'done' || ev.level === 'error') {
    const badge = $('.runstatus');
    if (badge && ev.level === 'error') { badge.textContent = 'error'; badge.className = 'pill bad'; }
  }
}

// Recovers the commentary for a run that started before this page was opened.
async function loadLog(id) {
  if (LOGS.has(id)) return;
  try {
    const r = await api(`/api/run?id=${id}`);
    LOGS.set(id, r.events || []);
    RUNSTATUS.set(id, { status: r.status, error: r.error });
    if (id === selected) renderDetail();
  } catch { LOGS.set(id, []); }
}

// ── intake ──────────────────────────────────────────────────────
function paintThumbs() {
  const box = $('#thumbs');
  box.innerHTML = images.map((im, i) =>
    `<figure class="thumb"><img src="${im.data}" alt="${esc(im.name)}">
       <button type="button" class="rm" data-i="${i}" title="Remove ${esc(im.name)}">×</button></figure>`).join('');
  $$('.rm', box).forEach(b => b.onclick = () => { images.splice(Number(b.dataset.i), 1); paintThumbs(); });
  $('.dz').hidden = images.length > 0;
  $('#drop').classList.toggle('has', images.length > 0);
}

// Exactly the formats the API accepts as image blocks. Anything else is refused here,
// loudly, rather than being attached, uploaded, and then silently skipped on the way to
// the model — which would leave the run reading a requirement with a picture missing.
const OK_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function addImages(files) {
  const rejected = [];
  for (const file of files) {
    if (!file || !file.type.startsWith('image/')) continue;
    if (!OK_TYPES.includes(file.type)) { rejected.push(file.name || file.type); continue; }
    const r = new FileReader();
    r.onload = () => { images.push({ name: file.name || `pasted-${images.length + 1}.png`, data: r.result }); paintThumbs(); };
    r.readAsDataURL(file);
  }
  if (rejected.length) toast(`Not attached — PNG, JPEG, GIF or WebP only: ${rejected.join(', ')}`);
}

function wireIntake() {
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', ev => addImages(ev.dataTransfer.files));

  // A file picker, because drag-and-drop and Ctrl+V are both invisible affordances — and
  // over a remote desktop, dragging a file in from the host machine is not possible at
  // all. Clicking the zone (or focusing it and pressing Enter) opens the ordinary dialog.
  const pick = $('#filepick');
  const openPicker = () => pick.click();
  drop.addEventListener('click', ev => { if (!ev.target.closest('.rm')) openPicker(); });
  drop.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openPicker(); }
  });
  // Reset the value afterwards or choosing the same file twice fires no change event.
  pick.addEventListener('change', () => { addImages(pick.files); pick.value = ''; });

  // A file dropped anywhere *other* than the drop zone would otherwise make the window
  // navigate to that file, replacing the whole app with a picture and losing the form.
  // Outside the zone a drop does nothing at all; inside it, the handler above wins.
  document.addEventListener('dragover', ev => ev.preventDefault());
  document.addEventListener('drop', ev => ev.preventDefault());

  // Screenshots are how most requirements arrive, so Ctrl+V anywhere in the window
  // attaches them — not only when the text box happens to have focus. A clipboard can
  // carry several at once. Text pastes are left completely alone: the handler only acts
  // when the clipboard actually holds an image, so pasting into any field still works.
  document.addEventListener('paste', ev => {
    const dt = ev.clipboardData;
    if (!dt) return;
    // The sign-in dialog is modal and covers the intake form. Attaching there would put a
    // thumbnail somewhere the user cannot see, and would hijack pasting a key into the
    // field they are actually looking at.
    if ($('#settings').open) return;
    const files = [...(dt.files || [])].filter(f => f.type.startsWith('image/'));
    const items = files.length ? files
      : [...(dt.items || [])].filter(i => i.kind === 'file' && i.type.startsWith('image/'))
          .map(i => i.getAsFile()).filter(Boolean);
    if (!items.length) return;              // plain text — let the browser handle it
    ev.preventDefault();
    addImages(items);
    toast(items.length > 1 ? `${items.length} screenshots attached` : 'Screenshot attached');
  });

  // Ctrl+Enter from the requirement box starts the run. The button is at the bottom of a
  // long form and this is the shortcut every text box on the internet has trained people
  // to try first.
  $('#spec').addEventListener('keydown', ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); $('#newtask').requestSubmit(); }
  });

  // Fill the five selects in the new-ticket form once, then read them back on submit.
  for (const [stage] of PIN_STAGES) {
    const sel = $('#pin-' + stage);
    if (sel && !sel.options.length) sel.innerHTML = modelOptions('auto');
  }

  $('#newtask').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $('#create'), err = $('#formerr');
    err.hidden = true; btn.disabled = true; btn.textContent = 'Starting…';
    try {
      const { id } = await api('/api/tasks', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: $('#spec').value, title: $('#title').value,
                               cap: Number($('#cap').value) || 3, images, models: formPins() }),
      });
      selected = id; LOGS.set(id, []); RUNSTATUS.set(id, { status: 'running' });
      $('#spec').value = ''; $('#title').value = ''; images = []; paintThumbs();
      toast('Running — watch the activity log');
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    finally { btn.disabled = false; btn.textContent = 'Run it'; }
  };
}

// ── settings ────────────────────────────────────────────────────
// Restored after an earlier patch truncated the file: without these the whole script
// died on the last line, so `connect()` never ran and the page never received state.
function paintAuth() {
  const env = STATE.env || {};
  const a = env.auth || { source: 'none', signedIn: false, profiles: [], antInstalled: false };

  // The Claude Code route. When the binary is here this is the only option that needs
  // nothing from the user, so it is stated first and plainly.
  const prov = env.provider || { mode: 'auto', active: 'api', cli: { available: false } };
  const cs = $('#clistate');
  if (cs) {
    cs.textContent = prov.cli.available
      ? (prov.active === 'cli'
          ? `Found, and in use. Runs as whoever is signed in to Claude Code on this PC — no key needed. Usage counts against that plan.`
          : `Found, but switched off below.`)
      : `Not found. Install Claude Code (the VS Code extension is enough) and reopen this window.`;
    cs.className = 'muted small ' + (prov.cli.available ? (prov.active === 'cli' ? 'good' : 'warn') : 'warn');
  }
  $$('input[name="prov"]').forEach(r => {
    r.checked = r.value === prov.mode;
    r.disabled = !prov.cli.available && r.value !== 'api';
  });

  const st = $('#authstate');
  st.textContent =
    a.source === 'api-key'    ? 'Signed in with an API key.' :
    a.source === 'auth-token' ? 'Signed in with ANTHROPIC_AUTH_TOKEN from the environment.' :
    a.source === 'profile'    ? `Signed in with Claude${a.activeProfile ? ` — profile ${a.activeProfile}` : ''}.` :
                                'Not signed in. Nothing can run until you are.';
  st.className = 'authstate ' + (a.signedIn ? 'good' : 'warn');

  // Browser sign-in runs through the `ant` CLI, so without it the button is dead. Saying
  // so is not enough — the message carries a real link that opens in the actual browser,
  // and the app tells you to come back and press Sign in once it is on your PATH.
  const missing = $('#antmissing');
  missing.hidden = !!a.antInstalled;
  missing.innerHTML = a.antInstalled ? '' :
    `Browser sign-in needs the free <b>ant</b> command-line tool, which is not installed on
     this PC yet. <a href="${esc(env.releases || '')}" target="_blank" rel="noreferrer">Download it here</a>,
     put it on your PATH, reopen this window and press Sign in.
     <br>${esc(env.installHint || '')}
     <br>Until then, use the API key below — it works on its own.`;
  $('#signin').disabled  = !a.antInstalled;
  $('#signout').disabled = !a.signedIn;

  const [line, tone] = keyLine(env.key, env.credentials) || ['', ''];
  const ks = $('#keystate'); ks.textContent = line; ks.className = 'muted small ' + tone;
}

function wireSettings() {
  const dlg = $('#settings');
  const open = () => { if (!dlg.open) dlg.showModal(); paintAuth(); };

  $('#opensettings').onclick  = open;
  $('#closesettings').onclick = () => dlg.close();
  window.relay?.onOpenSettings?.(open);   // File ▸ Settings… in the desktop menu

  const busy = async (btn, label, fn) => {
    const was = btn.textContent; btn.disabled = true; btn.textContent = label;
    try { await fn(); } catch (e) { toast(e.message); }
    finally { btn.disabled = false; btn.textContent = was; }
  };

  $$('input[name="prov"]').forEach(r => r.onchange = async () => {
    try {
      await api('/api/provider', { method: 'POST', headers: { 'content-type': 'application/json' },
                                   body: JSON.stringify({ mode: r.value }) });
      STATE = await api('/api/state'); render(); paintAuth();
    } catch (e) { toast(e.message); }
  });

  $('#savekey').onclick = (ev) => busy(ev.currentTarget, 'Saving…', async () => {
    const r = await api('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' },
                                           body: JSON.stringify({ apiKey: $('#apikey').value }) });
    $('#apikey').value = '';
    toast(r.stored ? (r.encrypted ? 'Key saved and encrypted' : 'Key saved — NOT encrypted') : 'Key cleared');
    STATE = await api('/api/state'); render(); paintAuth();
  });

  // The browser round trip can take minutes, so this request is deliberately left to run.
  $('#signin').onclick = (ev) => busy(ev.currentTarget, 'Check your browser…', async () => {
    await api('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
                                   body: JSON.stringify({ profile: $('#profile').value }) });
    toast('Signed in');
    STATE = await api('/api/state'); render(); paintAuth();
  });

  $('#signout').onclick = (ev) => busy(ev.currentTarget, 'Signing out…', async () => {
    await api('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' },
                                    body: JSON.stringify({}) });
    toast('Signed out');
    STATE = await api('/api/state'); render(); paintAuth();
  });
}

wireIntake();
wireSettings();
wireSheet();
connect();


/** What the new-ticket form's five selects say, with 'auto' meaning "leave it to the analyst". */
function formPins() {
  const out = {};
  for (const [stage] of PIN_STAGES) {
    const sel = document.querySelector('#pin-' + stage);
    if (sel && sel.value && sel.value !== 'auto') out[stage] = sel.value;
  }
  return out;
}

/**
 * The per-ticket model controls and the "add an instruction" box.
 *
 * Both are deliberately honest about timing. A stage already in flight was sent its prompt
 * before either of these existed; neither can reach into that request. They apply to the
 * next stage and to every retry, and the UI says so rather than letting a changed dropdown
 * imply the running call changed with it.
 */
function wireTicketControls(node, t) {
  const pins = t.inputs?.models || {};
  const body = $('.pinsbody', node);
  if (body) {
    body.innerHTML = PIN_STAGES.map(([stage, label]) =>
      `<div class="pinrow"><label>${label}</label>` +
      `<select data-stage="${stage}">${modelOptions(pins[stage])}</select></div>`).join('');
    for (const sel of body.querySelectorAll('select')) {
      sel.onchange = async () => {
        try {
          await api('/api/models', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: t.id, models: { [sel.dataset.stage]: sel.value } }) });
          toast(sel.value === 'auto' ? 'Back to the analyst’s choice' : `Pinned to ${sel.value}`);
        } catch (e) { toast(e.message); }
      };
    }
  }

  const box = $('.addendum', node), btn = $('.addbtn', node), note = $('.addnote', node);
  const list = $('.addlist', node);
  const added = t.inputs?.addenda || [];
  if (list) list.innerHTML = added.map((a, i) =>
    `<li><span class="n">${i + 1}</span><span class="tx">${esc(a.text)}</span></li>`).join('');
  if (note) note.textContent = added.length
    ? `${added.length} added · every stage from here on sees ${added.length === 1 ? 'it' : 'them'}`
    : '';

  const send = async () => {
    const text = (box.value || '').trim();
    if (!text) return;
    btn.disabled = true;
    try {
      await api('/api/addendum', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: t.id, text }) });
      box.value = '';
      STATE = await api('/api/state'); render();
      toast('Added — the next stage will see it');
    } catch (e) { toast(e.message); }
    finally { btn.disabled = false; }
  };
  if (btn) btn.onclick = (e) => { e.preventDefault(); send(); };
  if (box) box.onkeydown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
  };
}

// ── finishing: notify, then show what to upload ──────────────────
// A run takes ten to twenty minutes. Nobody watches it, so "it is done" has to arrive
// rather than be discovered: a desktop notification, the taskbar, and a full-screen sheet
// carrying the exact text to upload and the steps for uploading it.
const ANNOUNCED = new Set();

/** Ask once, quietly. A refusal is fine — the sheet and the toast still happen. */
function askToNotify() {
  try {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  } catch { /* not available in this context */ }
}

function notifyDone(t, ok) {
  const body = ok
    ? `${t.title} — the result is ready to upload.`
    : `${t.title} — could not complete after ${t.attempt} of ${t.cap} attempts.`;
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(ok ? 'Claude Workflow: ready' : 'Claude Workflow: stopped', { body });
      n.onclick = () => { window.focus(); selected = t.id; render(); openSheet(t); };
    }
  } catch { /* a notification is a courtesy, never a requirement */ }
  toast(ok ? 'Done — ready to upload' : 'Could not complete');
}

/** The steps, which differ by what the person is actually being handed. */
function guideFor(t, ok) {
  if (!ok) return [
    'Nothing here is ready to submit. The run used every attempt and stopped.',
    'Read the write-up below: it says what was tried and what the reviewers rejected.',
    'Decide what to change in the requirement, then start a new ticket.',
  ];
  if (t.output_mode === 'guide') return [
    'Copy the text below.',
    'Paste it wherever you keep the instructions — it is written to be followed step by step.',
    'Each step ends with what you should see if it worked. If one does not match, stop there.',
  ];
  return [
    'Press Copy the text. The whole payload goes to your clipboard.',
    'Open the form or ticket this was written for.',
    'Paste it in. It is plain text, already in the form\u2019s question order — paste it as it is.',
    'Do not add a greeting or a sign-off, and do not reformat it. If something needs deleting before it fits, the answer is wrong and worth a new ticket.',
    'Submit.',
  ];
}

function openSheet(t) {
  const sheet = $('#finished');
  if (!sheet || !t) return;
  const ok = !(t.history || []).some(h => h.to === 'escalated');
  const payload = t.payload || '';
  $('#fin-title').textContent = t.title;
  $('#fin-sub').textContent = ok
    ? `${payload.length.toLocaleString()} characters, plain text${t.usage ? ` · $${t.usage.costUsd.toFixed(2)}` : ''}`
    : `Stopped after ${t.attempt} of ${t.cap} attempts${t.usage ? ` · $${t.usage.costUsd.toFixed(2)}` : ''}`;
  $('#fin-guide').innerHTML = guideFor(t, ok).map(s => `<li>${esc(s)}</li>`).join('');
  $('#fin-payload').textContent = payload;
  $('#fin-foot').textContent = ok
    ? 'Reviewed twice before you saw it. Close this to go back to the ticket.'
    : 'Close this to read the activity log and see where it stopped.';
  sheet.classList.toggle('bad', !ok);
  $('#fin-copy').textContent = 'Copy the text';
  sheet.hidden = false;
  $('#fin-copy').focus();
}

// A declaration, not a const: wireSheet() runs above this point in the file and reads
// this identifier while binding handlers. As a const that is a temporal dead zone
// error, which kills the whole wiring pass and leaves the sheet with no way to close.
function closeSheet() { const s = $('#finished'); if (s) s.hidden = true; }

function wireSheet() {
  const copy = $('#fin-copy'), close = $('#fin-close'), sheet = $('#finished');
  if (!copy || !sheet) return;
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText($('#fin-payload').textContent);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy the text'; }, 1600);
    } catch { toast('Could not reach the clipboard — select the text and copy it'); }
  };
  if (close) close.onclick = closeSheet;
  // Clicking the backdrop, but not the panel itself.
  sheet.onclick = (e) => { if (e.target === sheet) closeSheet(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });
  askToNotify();
}

/**
 * Called on every state frame. Announces a ticket the moment it reaches a final state,
 * once and only once — a re-render, a reconnect, or a second SSE frame for the same
 * ticket must not pop the sheet again while the person is reading it.
 */
function announceFinished() {
  for (const t of (STATE.tasks || [])) {
    if (t.state !== 'delivered' || ANNOUNCED.has(t.id)) continue;
    ANNOUNCED.add(t.id);
    // Only for tickets that finished while this page was open. On a reload every
    // delivered ticket is "new" to us, and a sheet for last week's work is noise.
    if (!LOGS.has(t.id)) continue;
    const ok = !(t.history || []).some(h => h.to === 'escalated');
    notifyDone(t, ok);
    selected = t.id;
    openSheet(t);
  }
}
