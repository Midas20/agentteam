#!/usr/bin/env node
// server.mjs - http front end for the self-driving relay.
//
// Creating a task starts the pipeline in the background and returns immediately; the
// browser follows it over SSE. Task state comes from the ledger on disk, run events come
// from memory, so a reload always recovers the state that matters even if it loses the
// live commentary from a run that finished earlier.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, watch, realpathSync, rmSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTask, ledger, runState, onRunEvent, paths, cancelTask } from './engine.mjs';
import { credentialsPresent } from './claude.mjs';
import { execEnabled } from './tools.mjs';
import { resetClient } from './claude.mjs';
import { applyStoredKey, saveKey, keyStatus } from './settings.mjs';
import { authStatus, signIn, signOut, antStatus, INSTALL_HINT, RELEASES } from './auth.mjs';
import { providerStatus, setMode, usable } from './provider.mjs';
import { snapshot as usageSnapshot, reset as usageReset, onUsage, allTasks as usageByTask } from './usage.mjs';
import { sweep } from './orphans.mjs';
import { setModels, addAddendum, read as readInputs, forget as forgetInputs, MODELS, STAGES } from './inputs.mjs';
import { text as standingText, save as saveStanding, status as standingStatus } from './standing.mjs';
import { roster, role as agentRole, setRole, resetRole, resetAll, setSlots, activeSlots,
         reviewMethod, allReviewers, exists as agentExists } from './agents.mjs';

applyStoredKey();   // before the first request, and before any client is built

const HERE   = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const UPLOAD = join(process.env.RELAY_DATA_DIR || HERE, '.uploads');
const TASKS  = paths.TASKS;
const PORT   = Number(process.env.RELAY_APP_PORT || 7392);

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
               '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
               '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml' };

const tasks = () => !existsSync(TASKS) ? [] :
  readdirSync(TASKS).filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(TASKS, f), 'utf8')); } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.created.localeCompare(a.created));

// An OAuth profile is a credential even though nothing is in the environment, so the
// snapshot has to await the auth probe rather than just reading env vars.
const snapshot = async () => {
  const auth = await authStatus();
  const byTask = usageByTask();
  return {
    // Each ticket carries what it has cost so far, so the detail panel can answer
    // "what did THIS one cost" and not only the running total.
    // The UI needs the pins and the added instructions alongside the ledger state; they
    // are inputs to the run, not part of it, so they live outside the ledger file.
    tasks: tasks().map(t => ({ ...t, usage: byTask[t.id] || null, inputs: readInputs(t.id) })),
    env: { credentials: credentialsPresent() || auth.signedIn || providerStatus().active === 'cli', exec: execEnabled(),
           key: keyStatus(), auth, installHint: INSTALL_HINT, releases: RELEASES,
           provider: providerStatus(), usage: usageSnapshot(),
           standing: { ...standingStatus(), text: standingText() },
           // Only the shape of the roster travels on every state frame - who reviews, on
           // what axis. The instructions themselves are thousands of characters each and
           // are fetched from /api/agents when the editor is actually opened.
           agents: { slots: activeSlots(), method: reviewMethod(), reviewers: allReviewers() },
           version: process.env.RELAY_VERSION || null },
  };
};

// ── live ────────────────────────────────────────────────────────────────────
const clients = new Set();
const send = (obj) => {
  const frame = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch { clients.delete(res); } }
};
let timer = null;
const pushState = () => { clearTimeout(timer); timer = setTimeout(async () => send({ type: 'state', ...await snapshot() }), 120); };

mkdirSync(TASKS, { recursive: true });
// realpath first. Handed a Windows 8.3 short path (…\ADMINI~1\…), libuv's watcher hits an
// assertion and aborts the entire process — not an exception, a hard abort that no
// try/catch can see. The native realpath resolves short components to their long form.
// The watcher is a nicety anyway, so losing it must never take the server with it.
try {
  watch(realpathSync.native(TASKS), { persistent: false }, pushState);
} catch (e) {
  console.error(`relay: not watching the ledger directory (${e.message}); the UI will still update after each request.`);
}
onRunEvent((id, ev) => send({ type: 'event', id, ev }));
// The header number moves while a run is in flight, not only when one finishes.
onUsage((u) => send({ type: 'usage', usage: u }));

// ── http ────────────────────────────────────────────────────────────────────
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
// Base64 inflates by ~4/3, so this ceiling is about attachments, not the requirement
// text. It exists only to stop a runaway request exhausting memory.
const BODY_LIMIT = Number(process.env.RELAY_MAX_UPLOAD_MB || 256) * 1024 * 1024;
const readBody = (req) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > BODY_LIMIT) { reject(new Error(`request too large (over ${Math.round(BODY_LIMIT / 1048576)} MB)`)); req.destroy(); } chunks.push(c); });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
  req.on('error', reject);
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      // await, not spread: snapshot() is async, and spreading the Promise itself yields
      // {} — so the first frame the page ever receives would carry no tasks at all.
      res.write(`data: ${JSON.stringify({ type: 'state', ...(await snapshot()) })}\n\n`);
      const ka = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch {} }, 25000);
      clients.add(res);
      req.on('close', () => { clients.delete(res); clearInterval(ka); });
      return;
    }

    if (p === '/api/state') return json(res, 200, await snapshot());

    // Sign in with Claude. `ant auth login` opens a browser and can sit for minutes
    // while the user completes it, so this request is deliberately long-lived.
    if (p === '/api/auth/login' && req.method === 'POST') {
      const { profile } = await readBody(req);
      const out = await signIn({ profile: (profile || '').trim() || undefined });
      resetClient();
      pushState();
      return json(res, 200, { out, auth: await authStatus() });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      const { all } = await readBody(req);
      const out = await signOut({ all });
      resetClient();
      pushState();
      return json(res, 200, { out, auth: await authStatus() });
    }
    // Which route to Claude to use: 'auto' (prefer the signed-in CLI), 'cli', or 'api'.
    if (p === '/api/provider' && req.method === 'POST') {
      const { mode } = await readBody(req);
      setMode(mode);
      pushState();
      return json(res, 200, providerStatus());
    }
    // Removing a finished ticket. Refused while it is running: deleting the ledger file
    // out from under a live pipeline makes the next stage fail on a missing file rather
    // than stop cleanly, and the run would carry on spending money regardless.
    if (p === '/api/delete' && req.method === 'POST') {
      const { id } = await readBody(req);
      if (!/^t-[A-Za-z0-9_-]+$/.test(String(id || ''))) return json(res, 400, { error: 'bad id' });
      if (runState(id)?.status === 'running') return json(res, 400, { error: 'stop that ticket before deleting it' });
      rmSync(join(TASKS, id + '.json'), { force: true });
      rmSync(join(TASKS, id + '.files'), { recursive: true, force: true });
      rmSync(join(paths.WORKSPACE, id), { recursive: true, force: true });
      forgetInputs(id);
      pushState();
      return json(res, 200, { deleted: id });
    }
    // Pin a stage to a model, or hand it back to the analyst with 'auto'. It takes effect
    // on the next stage to run: a call already in flight was sent with the old choice, and
    // the only thing that stops that is Stop.
    // The instructions that apply to every ticket. Saved as plain text on disk, so it can
    // equally be edited in an editor or kept in version control.
    if (p === '/api/instructions' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        const text = saveStanding(b.text);
        pushState();
        return json(res, 200, { ...standingStatus(), text });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    // ---- the agent roster -------------------------------------------------
    // Who is in the pipeline and what each of them is told. Read separately from the
    // state snapshot because the instructions are long and are only wanted when someone
    // opens the editor.
    if (p === '/api/agents' && req.method === 'GET') return json(res, 200, roster());

    if (p === '/api/agent' && req.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      if (!agentExists(id)) return json(res, 404, { error: `no such agent: ${id}` });
      return json(res, 200, agentRole(id));
    }

    if (p === '/api/agent' && req.method === 'POST') {
      const b = await readBody(req);
      if (!agentExists(b.id)) return json(res, 400, { error: `no such agent: ${b.id}` });
      try {
        const r = setRole(b.id, b);
        pushState();
        return json(res, 200, r);
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/api/agent/reset' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.all) { const r = resetAll(); pushState(); return json(res, 200, { roster: r }); }
      if (!agentExists(b.id)) return json(res, 400, { error: `no such agent: ${b.id}` });
      const r = resetRole(b.id);
      pushState();
      return json(res, 200, r);
    }

    // How many reviewers, and which. A running ticket is unaffected: its roster was
    // written onto the task when it was assigned.
    if (p === '/api/agents/slots' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        const slots = setSlots(b.slots);
        pushState();
        return json(res, 200, { slots, method: reviewMethod() });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/api/models' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.id) return json(res, 400, { error: 'id is required' });
      try {
        const models = setModels(b.id, b.models || {});
        pushState();
        return json(res, 200, { models });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    // Add an instruction to a ticket that is already running.
    if (p === '/api/addendum' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.id) return json(res, 400, { error: 'id is required' });
      try {
        const n = addAddendum(b.id, b.text);
        pushState();
        return json(res, 200, { count: n });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/api/cancel' && req.method === 'POST') {
      const { id } = await readBody(req);
      const r = cancelTask(id);
      pushState();
      return json(res, 200, r);
    }
    if (p === '/api/usage' && req.method === 'POST') { const u = usageReset(); pushState(); return json(res, 200, u); }
    if (p === '/api/usage') return json(res, 200, usageSnapshot());

    if (p === '/api/auth/status') return json(res, 200, { cli: await antStatus(), auth: await authStatus() });

    // The key is entered in the app, not exported into the environment.
    if (p === '/api/settings' && req.method === 'POST') {
      const { apiKey } = await readBody(req);
      const r = saveKey(apiKey);
      // Truly unset, never ''. An empty ANTHROPIC_API_KEY still outranks an OAuth
      // profile and authenticates as an empty key.
      if (r.stored) process.env.ANTHROPIC_API_KEY = String(apiKey).trim();
      else delete process.env.ANTHROPIC_API_KEY;
      resetClient();
      pushState();
      return json(res, 200, { ...r, ...keyStatus() });
    }

    if (p === '/api/run' && url.searchParams.get('id')) {
      const r = runState(url.searchParams.get('id'));
      return json(res, 200, r ? { status: r.status, error: r.error, events: r.events } : { status: 'none', events: [] });
    }

    // Create the task, then start the pipeline without waiting for it.
    if (p === '/api/tasks' && req.method === 'POST') {
      if (!(await usable()))
        return json(res, 400, { error: 'No way to reach Claude yet. Open Settings: either install Claude Code, sign in with your browser, or paste an API key.' });
      const b = await readBody(req);
      const spec = (b.spec || '').trim();
      // `image` is the old single-attachment field; `images` is the list. Both accepted.
      const images = [b.image, ...(Array.isArray(b.images) ? b.images : [])].filter(i => i && i.data);
      if (!spec && !images.length) return json(res, 400, { error: 'a requirement or an image is required' });
      const title = (b.title || '').trim() || spec.split('\n')[0].slice(0, 60) || 'Untitled';

      mkdirSync(UPLOAD, { recursive: true });
      const specFile = join(UPLOAD, `spec-${Date.now()}.md`);
      // The requirement goes to a file, never onto a command line, so its length is
      // bounded by nothing here.
      writeFileSync(specFile, spec || `(the requirement is the ${images.length} attached image(s))`);

      const args = ['new', '--title', title, '--spec-file', specFile, '--cap', String(b.cap || 3)];
      images.forEach((img, i) => {
        const safe = (img.name || `requirement-${i + 1}.png`).replace(/[^\w.\-]/g, '_');
        const f = join(UPLOAD, `${Date.now()}-${i}-${safe}`);
        writeFileSync(f, Buffer.from(String(img.data).split(',').pop(), 'base64'));
        args.push('--attach', f);
      });
      const id = (await ledger(args)).split('\n')[0].trim();
      // Model pins are recorded before the run starts, so the very first stage sees them.
      if (b.models && typeof b.models === 'object') {
        try { setModels(id, b.models); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      runTask({ id });                      // deliberately not awaited
      pushState();
      return json(res, 200, { id });
    }

    if (p === '/api/retry' && req.method === 'POST') {
      const { id } = await readBody(req);
      const r = runState(id);
      if (r?.status === 'running') return json(res, 400, { error: 'that task is already running' });
      const t = tasks().find(x => x.id === id);
      if (!t) return json(res, 404, { error: 'no such task' });
      if (t.state === 'delivered')
        return json(res, 400, { error: 'that task is already delivered — create a new one to run it again' });
      runTask({ id });
      return json(res, 200, { id });
    }

    // static
    const file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    if (file.includes('..')) return json(res, 400, { error: 'bad path' });
    const full = join(PUBLIC, file);
    if (!existsSync(full)) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
    return res.end(readFileSync(full));
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
});

/**
 * Listen, and resolve with the port actually bound. Falls back to an ephemeral port if
 * the preferred one is taken, so a second copy of the app still starts instead of dying.
 */
export function start(preferred = PORT) {
  // A previous run that was terminated outright could not kill its own model calls — no
  // JavaScript runs on the way out of a taskkill. This start is the first chance anyone
  // has had to stop them, so take it, in the background: a leftover child is worth a few
  // seconds of quota, never a few seconds of a slower launch.
  sweep().then(n => { if (n) console.log(`stopped ${n} model call(s) left by a previous run`); })
         .catch(() => { /* best effort; never block a start */ });
  return new Promise((resolve, reject) => {
    const attempt = (port, isRetry) => {
      server.removeAllListeners('error');
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && !isRetry) return attempt(0, true);
        reject(e);
      });
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    };
    attempt(preferred, false);
  });
}

// Run directly (node app/server.mjs) rather than imported by the desktop shell.
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  start().then(async (port) => {
    console.log(`app           →  http://localhost:${port}`);
    console.log(`ledger        →  ${TASKS}`);
    console.log(`workspaces    →  ${paths.WORKSPACE}`);
    // The banner has to name the route that will actually be used. Reading only the API
    // credential printed "NONE — sign in from Settings" on a machine that was signed in
    // through Claude Code and perfectly able to run.
    const a = await authStatus();
    const p = providerStatus();
    console.log(`route         →  ${p.active === 'cli' ? `Claude Code — ${p.cli.path}`
      : a.source === 'none' ? 'NONE — nothing can run; open Settings'
      : `${a.source}${a.activeProfile ? ` (profile ${a.activeProfile})` : ''}`}`);
    console.log(`run_command   →  ${execEnabled() ? 'ENABLED (RELAY_ALLOW_EXEC=1)' : 'disabled'}`);
  }).catch((e) => { console.error('relay: could not start —', e.message); process.exit(1); });
}
