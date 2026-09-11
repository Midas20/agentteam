#!/usr/bin/env node
// server.mjs - local console for the relay ledger.
//
// The UI never writes a task file itself. Every mutation shells out to bin/relay.mjs,
// so the cap, the model guard, the mode guard and the state machine apply identically
// whether a command came from a terminal or from the browser. A refusal from the CLI
// surfaces in the UI as the error it is.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, watch } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE   = dirname(fileURLToPath(import.meta.url));
const ROOT   = join(HERE, '..');            // relay/
const CLI    = join(ROOT, 'bin', 'relay.mjs');
const TASKS  = join(ROOT, 'tasks');
const ROUTES = join(ROOT, 'routes.json');
const PUBLIC = join(HERE, 'public');
const UPLOAD = join(HERE, '.uploads');
const PORT   = Number(process.env.RELAY_UI_PORT || 7391);

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
               '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
               '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg' };

// ---- ledger access ---------------------------------------------------------
const relay = (args) => new Promise((res, rej) => {
  execFile(process.execPath, [CLI, ...args], { cwd: ROOT, windowsHide: true }, (err, stdout, stderr) => {
    if (err) return rej(new Error((stderr || stdout || err.message).trim().replace(/^relay:\s*/, '')));
    res(stdout.trim());
  });
});

function tasks() {
  if (!existsSync(TASKS)) return [];
  return readdirSync(TASKS).filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(TASKS, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.created.localeCompare(a.created));
}
const routes = () => existsSync(ROUTES) ? JSON.parse(readFileSync(ROUTES, 'utf8')) : {};

// ---- live updates ----------------------------------------------------------
const clients = new Set();
let timer = null;
function broadcast() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const frame = `data: ${JSON.stringify({ tasks: tasks(), routes: routes() })}\n\n`;
    for (const res of clients) { try { res.write(frame); } catch { clients.delete(res); } }
  }, 120);                                  // debounce: a save is a write + a rename
}
mkdirSync(TASKS, { recursive: true });
watch(TASKS, { persistent: false }, broadcast);
if (existsSync(ROUTES)) watch(ROUTES, { persistent: false }, broadcast);

// ---- http ------------------------------------------------------------------
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > 12e6) { reject(new Error('payload too large (12 MB max)')); req.destroy(); } chunks.push(c); });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
  req.on('error', reject);
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ tasks: tasks(), routes: routes() })}\n\n`);
      const ka = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch {} }, 25000);
      clients.add(res);
      req.on('close', () => { clients.delete(res); clearInterval(ka); });
      return;
    }

    if (p === '/api/state') return json(res, 200, { tasks: tasks(), routes: routes() });

    if (p === '/api/envelope') {
      const id = url.searchParams.get('id'), to = url.searchParams.get('to');
      if (!id || !to) return json(res, 400, { error: 'id and to required' });
      return json(res, 200, { text: await relay(['envelope', id, '--to', to]) });
    }

    // Create + classify in one step. If classify fails the task still exists in
    // 'open' and the UI says so, rather than silently losing the requirement.
    if (p === '/api/tasks' && req.method === 'POST') {
      const b = await readBody(req);
      const title = (b.title || '').trim() || (b.spec || '').trim().split('\n')[0].slice(0, 60) || 'Untitled';
      const spec  = (b.spec || '').trim();
      if (!spec && !b.image) return json(res, 400, { error: 'a requirement or an image is required' });

      mkdirSync(UPLOAD, { recursive: true });
      const specFile = join(UPLOAD, `spec-${Date.now()}.md`);
      writeFileSync(specFile, spec || '(requirement is in the attachment)');

      const args = ['new', '--title', title, '--spec-file', specFile, '--cap', String(b.cap || 3)];
      if (b.image?.data) {
        const safe = (b.image.name || 'requirement.png').replace(/[^\w.\-]/g, '_');
        const imgFile = join(UPLOAD, `${Date.now()}-${safe}`);
        writeFileSync(imgFile, Buffer.from(String(b.image.data).split(',').pop(), 'base64'));
        args.push('--attach', imgFile);
      }
      const id = (await relay(args)).split('\n')[0].trim();
      let warning = null;
      try {
        await relay(['classify', id, '--kind', b.kind, '--mode', b.mode, '--why', (b.why || '').trim() || 'set from the relay console']);
      } catch (e) { warning = e.message; }
      broadcast();
      return json(res, 200, { id, warning });
    }

    // Escape hatch: run any relay command from the UI. The CLI does the validating.
    if (p === '/api/run' && req.method === 'POST') {
      const { args } = await readBody(req);
      if (!Array.isArray(args) || !args.length) return json(res, 400, { error: 'args array required' });
      const out = await relay(args.map(String));
      broadcast();
      return json(res, 200, { out });
    }

    // static
    let file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    if (file.includes('..')) return json(res, 400, { error: 'bad path' });
    const full = join(PUBLIC, file);
    if (!existsSync(full)) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
    return res.end(readFileSync(full));

  } catch (e) {
    return json(res, 400, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`relay console  →  http://localhost:${PORT}`);
  console.log(`ledger         →  ${TASKS}`);
});
