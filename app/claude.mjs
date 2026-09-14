// claude.mjs - every call to the model lives here.
//
// Two shapes are used:
//   * messages.parse + zodOutputFormat  — for the two decisions (classify, pick model)
//   * beta.messages.toolRunner          — for the three jobs that need research or files
//
// Each tool-running role ends by calling a single `submit_*` tool. That is how a
// structured result comes back out of an agentic loop without a second round trip.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool, betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
// 'zod/v4' is not optional: the SDK helpers are built against the v4 schema shape, and a
// v3-classic schema fails inside them with "Cannot read properties of undefined". zod 3.25+
// ships both APIs, so the subpath is what selects the right one.
import { z } from 'zod/v4';
import { readFileSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { MODEL_PICK } from './prompts.mjs';
// The role prompts are no longer read from prompts.mjs directly. prompts.mjs holds the
// defaults; agents.mjs is what a stage actually runs with, because any of them can be
// rewritten from Settings and the rewritten one has to be the one that runs.
import { instructions as roleText } from './agents.mjs';
import { record } from './usage.mjs';
import { workspaceTools } from './tools.mjs';

export const MODEL_ID = {
  opus:   'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku:  'claude-haiku-4-5',
  fable:  'claude-fable-5',
};
// Refusal fallbacks are only wired for the two models that can return stop_reason:"refusal",
// and only on the beta endpoints — `fallbacks` does not exist on the non-beta params.
// @anthropic-ai/sdk 0.110 types it as an array of {model}, under this beta flag.
const NEEDS_FALLBACK = new Set(['claude-opus-5', 'claude-fable-5']);
const FALLBACK_BETA  = 'server-side-fallback-2026-06-01';
const FALLBACK_MODEL = 'claude-opus-4-8';

// Built on first use, not at import: the desktop app can store a key after this module
// has already loaded, and a client captured at import would never see it.
let _client = null;
const client = () => (_client ??= new Anthropic());
export const resetClient = () => { _client = null; };

const MEDIA = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
                '.gif':'image/gif', '.webp':'image/webp' };

// Attachments ride along as real image blocks. The requirement is the image; a text
// transcription of it is somebody's reading of the requirement, not the requirement.
function imageBlocks(paths = []) {
  const out = [];
  for (const p of paths) {
    const media_type = MEDIA[extname(p).toLowerCase()];
    if (!media_type) continue;
    try {
      out.push({ type: 'image', source: { type: 'base64', media_type, data: readFileSync(p).toString('base64') } });
      out.push({ type: 'text', text: `(above: attachment "${basename(p)}" — this is the requirement as the user received it)` });
    } catch { /* an unreadable attachment must not take the run down */ }
  }
  return out;
}

// Every call in this file goes through client.beta.messages.*, so the beta-only
// `betas`/`fallbacks` pair is always valid here.
const base = (modelId, effort = 'high') => ({
  model: modelId,
  thinking: { type: 'adaptive' },
  output_config: { effort },
  ...(NEEDS_FALLBACK.has(modelId)
      ? { betas: [FALLBACK_BETA], fallbacks: [{ model: FALLBACK_MODEL }] } : {}),
});

// A refusal comes back as HTTP 200 with stop_reason "refusal", so it has to be checked
// rather than caught.
function assertNotRefused(msg, stage) {
  if (msg?.stop_reason === 'refusal') {
    const d = msg.stop_details || {};
    throw new Error(`${stage}: the model declined this request (${d.category || 'unspecified'})${d.explanation ? ` — ${d.explanation}` : ''}`);
  }
}

// ── the two decisions ────────────────────────────────────────────────────────
const ClassifySchema = z.object({
  kind: z.enum(['answer', 'repo', 'project', 'prompt']),
  output_mode: z.enum(['paste', 'guide']),
  why: z.string().describe('one sentence, recorded in the ledger'),
});

export async function classify({ spec, attachments, model = 'opus' }) {
  const res = await client().beta.messages.parse({
    ...base(MODEL_ID[model] || MODEL_ID.opus, 'medium'),
    max_tokens: 16000,
    system: roleText('classify'),
    messages: [{ role: 'user', content: [...imageBlocks(attachments), { type: 'text', text: spec }] }],
    output_config: { effort: 'medium', format: betaZodOutputFormat(ClassifySchema) },
  });
  record(res.usage);
  assertNotRefused(res, 'classify');
  if (!res.parsed_output) throw new Error('classify: the model returned no parseable decision');
  return res.parsed_output;
}

const ModelSchema = z.object({
  work:   z.enum(['opus', 'sonnet', 'haiku', 'fable']),
  review: z.enum(['opus', 'sonnet', 'haiku', 'fable']),
  why:    z.string().describe('one or two sentences a reviewer could argue with'),
});

export async function pickModel({ spec, attachments, kind, output_mode, attempt, cap, lastDefects, model = 'opus' }) {
  const ctx = [
    `kind: ${kind}`, `output mode: ${output_mode}`, `this will be attempt ${attempt + 1} of ${cap}`,
    lastDefects ? `\nThe previous attempt FAILED review. The defects were:\n${lastDefects}` : '',
  ].filter(Boolean).join('\n');
  const res = await client().beta.messages.parse({
    ...base(MODEL_ID[model] || MODEL_ID.opus, 'medium'),
    max_tokens: 16000,
    system: MODEL_PICK,
    messages: [{ role: 'user', content: [...imageBlocks(attachments),
      { type: 'text', text: `${ctx}\n\n--- requirement ---\n${spec}` }] }],
    output_config: { effort: 'medium', format: betaZodOutputFormat(ModelSchema) },
  });
  record(res.usage);
  assertNotRefused(res, 'pick model');
  if (!res.parsed_output) throw new Error('pick model: the model returned no parseable decision');
  return res.parsed_output;
}

// ── the agentic roles ────────────────────────────────────────────────────────
const WEB = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 20 },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 20 },
];

// The SDK's tool runner does NOT auto-resume a `pause_turn`. A long server-tool turn
// stops the loop with no error and a silently truncated answer, so the paused assistant
// turn has to be pushed back by hand. Documented in the SDK's tool-use guide.
async function drive(runner, { stage, onEvent }) {
  let last = null;
  for await (const message of runner) {
    last = message;
    for (const block of message.content || []) {
      if (block.type === 'text' && block.text.trim()) onEvent?.({ level: 'think', stage, text: block.text.trim() });
      if (block.type === 'tool_use')          onEvent?.({ level: 'tool',  stage, text: `${block.name}` });
      if (block.type === 'server_tool_use')   onEvent?.({ level: 'tool',  stage, text: `${block.name}: ${JSON.stringify(block.input).slice(0, 160)}` });
    }
    if (message.usage) record(message.usage);
    if (message.stop_reason === 'pause_turn') {
      onEvent?.({ level: 'info', stage, text: 'server tool paused the turn — resuming' });
      runner.pushMessages({ role: 'assistant', content: message.content });
    }
    assertNotRefused(message, stage);
  }
  return last;
}

const textOf = (msg) => (msg?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

export async function doWork({ kind, model, spec, attachments, lastDefects, attempt, cap, workspace, onEvent }) {
  let captured = null;
  const submit = betaZodTool({
    name: 'submit_notes',
    description: 'Record the finished work. Call this exactly once, at the end.',
    inputSchema: z.object({
      notes: z.string().describe('the full evidence: what you produced, where it is, every source you checked'),
    }),
    run: async ({ notes }) => { captured = notes; return 'Recorded. You are done — stop here.'; },
  });

  const tools = [submit, ...WEB, ...(kind === 'project' ? workspaceTools(workspace, onEvent) : [])];
  const parts = [
    ...imageBlocks(attachments),
    { type: 'text', text: `--- requirement ---\n${spec}` },
  ];
  if (kind === 'project') parts.push({ type: 'text', text: `Your workspace directory is: ${workspace}\nAll file paths you pass to the file tools are relative to it.` });
  if (lastDefects) parts.push({ type: 'text', text:
    `--- DEFECTS FROM ATTEMPT ${attempt} (this is attempt ${attempt + 1} of ${cap}) ---\n` +
    `The reviewers failed the previous attempt for these reasons. Fix exactly these. Do not\n` +
    `re-architect what already passed, and do not widen scope. If a defect is wrong, fix the\n` +
    `rest and say so in your notes.\n\n${lastDefects}` });

  const runner = client().beta.messages.toolRunner({
    ...base(MODEL_ID[model], 'xhigh'),
    max_tokens: 32000,
    max_iterations: 60,
    system: roleText(`worker.${kind}`),
    tools,
    messages: [{ role: 'user', content: parts }],
  });
  const final = await drive(runner, { stage: 'work', onEvent });
  return captured || textOf(final) || '(the worker produced no notes)';
}

export async function review({ slot, model, spec, attachments, buildNotes, kind, output_mode, onEvent }) {
  let captured = null;
  const submit = betaZodTool({
    name: 'submit_verdict',
    description: 'Record your verdict. Call this exactly once, at the end.',
    inputSchema: z.object({
      result: z.enum(['pass', 'fail']),
      notes: z.string().describe('specific defects with evidence, or the claims that decided a pass'),
    }),
    run: async (v) => { captured = v; return 'Recorded. You are done — stop here.'; },
  });

  const runner = client().beta.messages.toolRunner({
    ...base(MODEL_ID[model], 'xhigh'),
    max_tokens: 32000,
    max_iterations: 40,
    system: roleText(`reviewer.${slot}`),
    tools: [submit, ...WEB],
    messages: [{ role: 'user', content: [
      ...imageBlocks(attachments),
      { type: 'text', text:
        `--- the requirement (kind: ${kind}, output mode: ${output_mode}) ---\n${spec}\n\n` +
        `--- what the worker says it produced ---\n${buildNotes}\n\n` +
        `Treat those notes as a claim, not as evidence. Check them.` },
    ] }],
  });
  const final = await drive(runner, { stage: `review-${slot}`, onEvent });
  // A reviewer that never submits is not a pass. Fail closed.
  return captured || { result: 'fail', notes:
    `Reviewer ${slot} did not record a verdict before its iteration limit. Treating as a failure.\n\n` +
    `Its last output was:\n${textOf(final).slice(0, 2000) || '(nothing)'}` };
}

export async function writePayload({ model, output_mode, escalated, spec, attachments, buildNotes, reviewNotes, history, onEvent }) {
  let captured = null;
  const submit = betaZodTool({
    name: 'submit_payload',
    description: 'Record the final text for the user. Call this exactly once.',
    inputSchema: z.object({ payload: z.string().describe('exactly what the user receives — nothing else') }),
    run: async ({ payload }) => { captured = payload; return 'Recorded. You are done — stop here.'; },
  });

  const system = roleText(escalated ? 'result.escalated' : `result.${output_mode}`);
  const body = escalated
    ? `--- the requirement ---\n${spec}\n\n--- what was attempted ---\n${history}\n\n--- why the reviewers failed it ---\n${reviewNotes}`
    : `--- the requirement ---\n${spec}\n\n--- the reviewed work ---\n${buildNotes}\n\n--- what the reviewers confirmed ---\n${reviewNotes}`;

  const runner = client().beta.messages.toolRunner({
    ...base(MODEL_ID[model], 'high'),
    max_tokens: 32000,
    max_iterations: 12,
    system,
    tools: [submit],
    messages: [{ role: 'user', content: [...imageBlocks(attachments), { type: 'text', text: body }] }],
  });
  const final = await drive(runner, { stage: 'result', onEvent });
  return captured || textOf(final) || '(the result step produced no payload)';
}

export function credentialsPresent() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}
