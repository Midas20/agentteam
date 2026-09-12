#!/usr/bin/env node
// smoke.mjs - everything that can be checked without spending a token.
//
// Exists because the SDK's zod helpers are built against the v4 schema shape and fail at
// CALL time, not import time, with a bare "Cannot read properties of undefined". A syntax
// check does not catch that; this does. Run it after any dependency change.
//
//   node relay/app/smoke.mjs
import { betaZodTool, betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceTools } from './tools.mjs';
import { ledger, readTask } from './engine.mjs';

const TASKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'tasks');
let failed = 0;
const pass = (m) => console.log(`  ok    ${m}`);
const fail = (m) => { failed++; console.log(`  FAIL  ${m}`); };

async function ok(name, fn) {
  try { const extra = await fn(); pass(extra ? `${name} — ${extra}` : name); }
  catch (e) { fail(`${name} — ${e.message}`); }
}
async function refuses(name, fn) {
  try { await fn(); fail(`${name} — was ALLOWED`); }
  catch (e) { pass(`${name} — ${e.message.slice(0, 66)}`); }
}

// ── schemas ─────────────────────────────────────────────────────
console.log('\nschemas the pipeline builds');
await ok('classify output format', () => {
  const s = betaZodOutputFormat(z.object({
    kind: z.enum(['answer', 'repo', 'project', 'prompt']),
    output_mode: z.enum(['paste', 'guide']), why: z.string(),
  }));
  if (s.type !== 'json_schema') throw new Error(`unexpected type ${s.type}`);
  return Object.keys(s.schema.properties).join(', ');
});
await ok('model output format', () => {
  const s = betaZodOutputFormat(z.object({
    work: z.enum(['opus', 'sonnet', 'haiku', 'fable']),
    review: z.enum(['opus', 'sonnet', 'haiku', 'fable']), why: z.string(),
  }));
  return Object.keys(s.schema.properties).join(', ');
});

console.log('\nsubmit tools each agentic role must call');
for (const [name, schema] of [
  ['submit_notes',   z.object({ notes: z.string() })],
  ['submit_verdict', z.object({ result: z.enum(['pass', 'fail']), notes: z.string() })],
  ['submit_payload', z.object({ payload: z.string() })],
]) await ok(name, () => { betaZodTool({ name, description: 'd', inputSchema: schema, run: async () => 'ok' }); });

// ── workspace tools ─────────────────────────────────────────────
console.log('\nworkspace tools (project kind)');
const ws = mkdtempSync(join(tmpdir(), 'relay-smoke-'));
try {
  let tools = null;
  await ok('build all four', () => { tools = workspaceTools(ws, null); return tools.map(t => t.name).join(', '); });
  if (tools) {
    const call = (n, a) => tools.find(t => t.name === n).run(a);
    await ok('write_file + read_file round trip', async () => {
      await call('write_file', { path: 'src/a.txt', content: 'hello' });
      if (!existsSync(join(ws, 'src', 'a.txt'))) throw new Error('nothing on disk');
      const back = await call('read_file', { path: 'src/a.txt' });
      if (back !== 'hello') throw new Error(`read back ${JSON.stringify(back)}`);
    });
    await ok('list_workspace', async () => (await call('list_workspace', {})).replace(/\s+/g, ' ').slice(0, 40));
    await refuses('path jail blocks ../escape.txt', () => call('write_file', { path: '../escape.txt', content: 'x' }));
    await refuses('path jail blocks an absolute path', () => call('write_file', { path: 'C:/Windows/x.txt', content: 'x' }));
    await ok('run_command honours RELAY_ALLOW_EXEC', async () => {
      const out = await call('run_command', { command: 'echo hi', why: 'smoke' });
      const on = process.env.RELAY_ALLOW_EXEC === '1';
      if (!on && !/disabled/i.test(out)) throw new Error('disabled, but did not say so');
      if (on && !/hi/.test(out)) throw new Error(`enabled, but output was ${JSON.stringify(out.slice(0, 40))}`);
      return on ? 'enabled, ran' : 'disabled, refused';
    });
  }
} finally { rmSync(ws, { recursive: true, force: true }); }

// ── the ledger guards the engine relies on ──────────────────────
console.log('\nledger contract the engine depends on');
const id = (await ledger(['new', '--title', 'smoke', '--spec', 'smoke test', '--cap', '1'])).split('\n')[0];
try {
  await refuses('assign before classify', () => ledger(['assign', id]));
  await ledger(['classify', id, '--kind', 'answer', '--mode', 'paste', '--why', 'smoke']);
  await refuses('assign with no model pinned', () => ledger(['assign', id]));
  await refuses('reviewer weaker than the worker',
    () => ledger(['model', id, '--work', 'opus', '--review', 'haiku', '--why', 'smoke']));

  await ledger(['model', id, '--work', 'sonnet', '--review', 'sonnet', '--why', 'smoke']);
  await ledger(['assign', id]);

  await ok('--notes-file carries 90000 chars past the ~32k arg limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-notes-'));
    const f = join(dir, 'notes.txt');
    const big = 'X'.repeat(90000);
    writeFileSync(f, big, 'utf8');
    try {
      await ledger(['built', id, '--notes-file', f]);
      const got = readTask(id).build_notes.length;
      if (got !== big.length) throw new Error(`came back as ${got} chars`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await ledger(['review', id, '--slot', 'a', '--result', 'fail', '--notes', 'smoke a']);
  await refuses('a slot cannot be recorded twice',
    () => ledger(['review', id, '--slot', 'a', '--result', 'pass', '--notes', 'again']));
  await ok('one review does not resolve the task', () => {
    const s = readTask(id).state;
    if (s !== 'reviewing') throw new Error(`state is ${s}, expected reviewing`);
  });
  await ledger(['review', id, '--slot', 'b', '--result', 'fail', '--notes', 'smoke b']);

  await refuses('assign past the cap', () => ledger(['assign', id]));
  await refuses('deliver a failed task', () => ledger(['deliver', id, '--mode', 'paste', '--payload', 'x']));
  await ledger(['escalate', id]);
  await refuses('deliver with the wrong mode', () => ledger(['deliver', id, '--mode', 'guide', '--payload', 'x']));
  await ok('deliver with the right mode', () => ledger(['deliver', id, '--mode', 'paste', '--payload', 'the reason']));
} finally {
  rmSync(join(TASKS, `${id}.json`), { force: true });
  rmSync(join(TASKS, `${id}.files`), { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
