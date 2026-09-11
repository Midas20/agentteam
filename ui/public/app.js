'use strict';
// Relay Console. Reads the ledger over SSE, mutates it only through bin/relay.mjs,
// so every guard the CLI enforces shows up here as a real error instead of a wrong screen.

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

let STATE = { tasks: [], routes: {} };
let selected = null;
let image = null;

const STAGES = ['Intake', 'Model', 'Work', 'Review', 'Verdict', 'Result'];
const stageIndex = (t) => ({
  open: 0, classified: t.model ? 2 : 1, assigned: 2, built: 3, reviewing: 3,
  passed: 4, failed: 4, escalated: 4, delivered: 5,
}[t.state] ?? 0);

const STATE_TONE = { open:'neutral', classified:'neutral', assigned:'go', built:'go',
  reviewing:'go', passed:'ok', failed:'bad', escalated:'warn', delivered:'ok' };

// ── api ────────────────────────────────────────────────────────
async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `request failed (${r.status})`);
  return body;
}
const run = (args) => api('/api/run', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }),
});

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2200);
}

async function copy(text, btn, label) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const was = btn.textContent;
      btn.textContent = 'Copied'; btn.classList.add('done');
      setTimeout(() => { btn.textContent = was; btn.classList.remove('done'); }, 1600);
    }
    toast(label || 'Copied to clipboard');
  } catch { toast('Could not copy — select the text and copy manually'); }
}

// ── live ───────────────────────────────────────────────────────
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { $('#live').classList.add('on'); $('#live').title = 'live'; };
  es.onerror = () => { $('#live').classList.remove('on'); $('#live').title = 'reconnecting…'; };
  es.onmessage = (e) => { STATE = JSON.parse(e.data); render(); };
}

// ── render ─────────────────────────────────────────────────────
function render() {
  const unpinned = Object.entries(STATE.routes)
    .filter(([, v]) => !v || String(v).startsWith('PLACEHOLDER')).map(([k]) => k);
  const rh = $('#routehealth');
  const total = Object.keys(STATE.routes).length;
  rh.textContent = unpinned.length ? `${total - unpinned.length}/${total} sessions pinned` : `${total}/${total} sessions pinned`;
  rh.className = 'pill ' + (unpinned.length ? 'warn' : 'ok');
  rh.title = unpinned.length ? 'unpinned: ' + unpinned.join(', ') : 'all roles have a live session';

  const open = STATE.tasks.filter(t => t.state !== 'delivered').length;
  $('#count').textContent = STATE.tasks.length ? `${open} in flight · ${STATE.tasks.length} total` : '';

  renderList();
  if (selected && !STATE.tasks.some(t => t.id === selected)) selected = null;
  renderDetail();
}

function renderList() {
  const box = $('#tasklist');
  if (!STATE.tasks.length) { box.innerHTML = '<p class="empty">No tasks yet.</p>'; return; }
  box.innerHTML = STATE.tasks.map(t => {
    const rv = ['a', 'b'].map(s => t.reviews[s] ? (t.reviews[s].result === 'pass' ? '✓' : '✗') : '·').join('');
    return `<button class="trow ${t.id === selected ? 'sel' : ''}" data-id="${t.id}">
      <span class="t">${esc(t.title)}</span>
      <span class="pill ${STATE_TONE[t.state] || 'neutral'}">${t.state}</span>
      <span class="m"><span>${esc(t.kind || '—')}</span><span>${esc(t.model?.work || '—')}</span>
        <span>${t.attempt}/${t.cap}</span><span>rv ${rv}</span></span>
    </button>`;
  }).join('');
  $$('.trow', box).forEach(b => b.onclick = () => { selected = b.dataset.id; render(); });
}

function renderDetail() {
  const main = $('#detail');
  const t = STATE.tasks.find(x => x.id === selected);
  if (!t) {
    main.innerHTML = `<div class="placeholder"><p>Select a task, or create one to begin.</p>
      <p class="muted small">This console reads and writes the same ledger as <code>bin/relay.mjs</code>.
      It does not run the sessions — it shows you what each one is owed and hands you the text to send.</p></div>`;
    return;
  }

  const node = $('#tpl-detail').content.cloneNode(true);
  $('.ttl', node).textContent = t.title;
  const sp = $('.state', node);
  sp.textContent = t.state; sp.className = 'pill ' + (STATE_TONE[t.state] || 'neutral');

  $('.facts', node).innerHTML = [
    ['id', t.id], ['kind', t.kind || '—'], ['output', t.output_mode || '—'],
    ['work model', t.model?.work || 'not pinned'], ['review model', t.model?.review || 'not pinned'],
    ['attempt', `${t.attempt}/${t.cap}`],
    ['attachments', t.attachments.length || '0'],
  ].map(([k, v]) => `<span>${k} <b>${esc(v)}</b></span>`).join('');

  // stages
  const idx = stageIndex(t), broken = t.state === 'failed' || t.state === 'escalated';
  $('.stagestrip', node).innerHTML = STAGES.map((s, i) =>
    `<li class="${i < idx ? 'done' : i === idx ? (broken ? 'bad' : 'now') : ''}">${s}</li>`).join('');
  $('.slots', node).innerHTML = ['a', 'b'].map(s => {
    const r = t.reviews[s];
    const cls = !r ? '' : r.result === 'pass' ? 'ok' : 'bad';
    return `<span class="slot ${cls}">review ${s}: ${r ? r.result : 'outstanding'}</span>`;
  }).join('');

  renderNext(node, t);
  renderResult(node, t);

  if (t.reviews.a || t.reviews.b) {
    $('.reviews', node).hidden = false;
    $('.revbody', node).innerHTML = ['a', 'b'].filter(s => t.reviews[s]).map(s => {
      const r = t.reviews[s];
      return `<div class="rev ${r.result === 'pass' ? 'ok' : 'bad'}">
        <h4>review ${s} — ${r.result} · ${esc(r.by)}</h4><p>${esc(r.notes)}</p></div>`;
    }).join('');
  }

  $('.histbody', node).innerHTML = t.history.length
    ? t.history.map(h => `<div><span class="w">${h.from} → ${h.to}</span><span>${esc(h.actor)} · ${esc(h.note || '')}</span></div>`).join('')
    : '<div>(nothing yet)</div>';

  main.innerHTML = '';
  main.appendChild(node);
}

function renderNext(node, t) {
  const n = nextAction(t);
  $('.nlabel', node).textContent = n.label;
  $('.nhint', node).textContent = n.hint;
  const errBox = $('.acterr', node);

  if (n.to) {
    const wrap = $('.sendto', node);
    wrap.hidden = false;
    const hops = t.state === 'built' ? ['reviewer-a', 'reviewer-b'] : [n.to];
    const names = hops.map(h => {
      const key = h === 'worker'
        ? ({ answer:'worker-answer', repo:'worker-repo', project:'worker-project', prompt:'worker-prompt' })[t.kind] : h;
      const s = STATE.routes[key];
      return s && !String(s).startsWith('PLACEHOLDER') ? s : `${key} (not pinned)`;
    });
    $('.sess', wrap).textContent = names.join('  +  ');
    const pre = $('.envelope', wrap);
    pre.textContent = 'loading…';
    Promise.all(hops.map(h => api(`/api/envelope?id=${t.id}&to=${h}`).then(r => r.text)))
      .then(texts => { pre.textContent = texts.join('\n\n' + '─'.repeat(60) + '\n\n'); })
      .catch(e => { pre.textContent = `could not build the envelope: ${e.message}`; });
    $('.env', wrap).onclick = () => copy(pre.textContent, $('.env', wrap), 'Envelope copied — paste it into that session');
  }

  // Buttons that map 1:1 onto a CLI command. The CLI decides whether it is allowed.
  const acts = [];
  if (t.state === 'failed' && t.attempt < t.cap) acts.push(['Assign retry', ['assign', t.id]]);
  if (t.state === 'failed' && t.attempt >= t.cap) acts.push(['Escalate', ['escalate', t.id]]);
  if (t.state === 'classified' && t.model) acts.push(['Assign', ['assign', t.id]]);
  const box = $('.acts', node);
  box.innerHTML = acts.map((a, i) => `<button data-i="${i}">${esc(a[0])}</button>`).join('');
  $$('button', box).forEach(b => b.onclick = async () => {
    b.disabled = true; errBox.hidden = true;
    try { const { out } = await run(acts[b.dataset.i][1]); toast(out.split('\n')[0]); }
    catch (e) { errBox.textContent = e.message; errBox.hidden = false; }
    finally { b.disabled = false; }
  });
}

function renderResult(node, t) {
  const sec = $('.result', node);
  if (t.state === 'delivered') {
    sec.hidden = false;
    sec.classList.toggle('escal', !t.payload || t.history.some(h => h.to === 'escalated'));
    const escalated = t.history.some(h => h.to === 'escalated');
    $('.rlabel', sec).textContent = escalated ? 'Escalated — no result' : `Result — ${t.output_mode}`;
    $('.rhint', sec).textContent = escalated
      ? 'The retry cap was reached. This is the reason, not an answer.'
      : t.output_mode === 'paste'
        ? 'Paste this into the ticket exactly as it is. Nothing here needs editing.'
        : 'Follow these steps in order. Each one ends with a checkpoint.';
    $('.payloadbox', sec).textContent = t.payload || '(the result session recorded no payload)';
    const btn = $('.payload', sec);
    btn.textContent = escalated ? 'Copy reason' : 'Copy result';
    btn.onclick = () => copy(t.payload || '', btn, 'Result copied — paste it into the ticket');
    return;
  }
  if (t.state === 'failed') {
    sec.hidden = false; sec.classList.add('escal');
    $('.rlabel', sec).textContent = `Attempt ${t.attempt} failed`;
    $('.rhint', sec).textContent = t.attempt >= t.cap
      ? 'No attempts left. Escalate to get the reason written up.'
      : 'A redo is owed. The defects below travel with it automatically.';
    $('.payloadbox', sec).textContent = t.review_notes || '(no notes recorded)';
    $('.payload', sec).textContent = 'Copy defects';
    $('.payload', sec).onclick = (e) => copy(t.review_notes || '', e.currentTarget, 'Defects copied');
  }
}

// Mirrors the NEXT: lines bin/relay.mjs prints. The CLI stays authoritative;
// this only decides what to show.
function nextAction(t) {
  switch (t.state) {
    case 'open':       return { to: null, label: 'Not classified', hint: 'This task was created but never classified. Run relay classify from a terminal.' };
    case 'classified': return t.model
      ? { to: 'worker', label: 'Ready to assign', hint: 'Model is pinned. Assign it, then send the envelope to the worker.' }
      : { to: 'model-analyst', label: 'Waiting on the model analyst', hint: 'Paste this into the model-analyst session. Assign refuses until a model is pinned.' };
    case 'assigned':   return { to: 'worker', label: `Waiting on the ${t.kind} worker`, hint: 'Paste this into that worker session.' };
    case 'built':      return { to: 'reviewer-a', label: 'Send to BOTH reviewers', hint: 'Two envelopes below — one per reviewer session. Both slots must be filled before a verdict exists.' };
    case 'reviewing':  return { to: null, label: 'Under review', hint: 'The second reviewer to record resolves the verdict. Nothing to send.' };
    case 'passed':     return { to: 'result', label: 'Passed — send to the result session', hint: 'It writes the payload you paste.' };
    case 'failed':     return { to: null, label: t.attempt >= t.cap ? 'Failed — cap reached' : 'Failed — redo owed', hint: t.attempt >= t.cap ? 'Escalate, then send to the result session for the write-up.' : 'Assign again. The redo envelope carries both reviewers’ defects.' };
    case 'escalated':  return { to: 'result', label: 'Escalated — send to the result session', hint: 'It writes up what was tried and what is still broken.' };
    case 'delivered':  return { to: null, label: 'Delivered', hint: 'Copy the result below.' };
    default:           return { to: null, label: t.state, hint: '' };
  }
}

// ── intake ─────────────────────────────────────────────────────
function setImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const r = new FileReader();
  r.onload = () => {
    image = { name: file.name || 'requirement.png', data: r.result };
    $('#thumb').src = r.result;
    $('#thumbwrap').hidden = false;
    $('.dz').hidden = true;
  };
  r.readAsDataURL(file);
}
function clearImage() {
  image = null; $('#thumbwrap').hidden = true; $('.dz').hidden = false; $('#thumb').removeAttribute('src');
}

function wireIntake() {
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', ev => setImage(ev.dataTransfer.files[0]));
  $('#rmimg').onclick = clearImage;

  // Requirements usually arrive as a screenshot, so paste-into-the-box has to work.
  $('#spec').addEventListener('paste', ev => {
    const item = [...(ev.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (item) { ev.preventDefault(); setImage(item.getAsFile()); toast('Screenshot attached'); }
  });

  $('#newtask').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $('#create'), err = $('#formerr');
    err.hidden = true; btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const { id, warning } = await api('/api/tasks', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: $('#title').value, spec: $('#spec').value, kind: $('#kind').value,
          mode: $('#mode').value, why: $('#why').value, cap: Number($('#cap').value) || 3, image,
        }),
      });
      selected = id;
      if (warning) { err.textContent = `Created, but not classified: ${warning}`; err.hidden = false; }
      else { $('#spec').value = ''; $('#title').value = ''; $('#why').value = ''; clearImage(); toast(`${id} created — send it to the model analyst`); }
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    finally { btn.disabled = false; btn.textContent = 'Create task'; }
  };
}

wireIntake();
connect();
