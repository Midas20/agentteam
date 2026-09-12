// cli.mjs - the same five pipeline stages, run through the Claude Code CLI.
//
// WHY THIS EXISTS: the API path in claude.mjs needs a credential of its own — an API key
// or an `ant auth login` profile. This path needs neither. It drives the `claude` binary
// that is already installed and already signed in on this machine, so the app runs as
// whoever is logged in to Claude Code and nothing is stored here at all.
//
// This is the documented way to drive the agent loop from outside Python/TypeScript:
// run the CLI as a subprocess with `-p` and a JSON output format. It is not a private
// interface and it does not read anyone's credential files; the CLI authenticates
// itself, exactly as it does when you run it in a terminal.
//
// Two consequences worth knowing:
//   * Usage counts against the signed-in plan, not against API credit.
//   * `--system-prompt` REPLACES Claude Code's own system prompt. That matters for more
//     than tone: its default prompt is tens of thousands of tokens, and every call here
//     would otherwise pay to cache it. The roles in prompts.mjs are the whole brief.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod/v4';
import { CLASSIFY, MODEL_PICK, WORKER, REVIEWER, RESULT } from './prompts.mjs';
import { record, taskContext } from './usage.mjs';
import { remember, forget } from './orphans.mjs';

// Live child processes, by the ticket that owns them. A stage can run for a quarter of an
// hour and cost real money, so stopping one has to actually kill the process — setting a
// flag and waiting for the turn to end is not cancelling, it is just hiding.
const live = new Map();   // taskId -> Set<ChildProcess>
const LOOSE = Symbol('no ticket');   // bucket for children started outside a ticket
export function killTask(id) {
  const set = live.get(id);
  if (!set) return 0;
  let n = 0;
  for (const child of set) { try { child.kill(); n++; } catch { /* already gone */ } }
  live.delete(id);
  return n;
}

/**
 * Kill everything still running. A child does not die with its parent on Windows, and
 * closing the app used to leave `claude` processes behind — still working, still spending
 * the plan's quota, with no window left to show for it. Observed: twelve orphans after a
 * test session, several still burning CPU minutes later.
 */
export function killAllTasks() {
  let n = 0;
  for (const id of [...live.keys()]) n += killTask(id);
  return n;
}
process.on('exit', killAllTasks);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { killAllTasks(); process.exit(0); });
}

// ── finding the binary ───────────────────────────────────────────────────────
const EXE = process.platform === 'win32' ? 'claude.exe' : 'claude';

/** Newest first, by numeric version segments rather than string order (so 2.1.9 < 2.1.10). */
const byVersion = (a, b) => {
  const nums = (s) => (s.match(/(\d+)\.(\d+)\.(\d+)/) || [0, 0, 0, 0]).slice(1).map(Number);
  const [x, y] = [nums(a), nums(b)];
  return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]);
};

function candidates() {
  const out = [];
  if (process.env.CLAUDE_CLI_PATH) out.push(process.env.CLAUDE_CLI_PATH);

  // The VS Code extension ships its own copy. Most people who have Claude Code in the
  // editor have never put it on PATH, so this is the case that matters most.
  for (const root of [join(homedir(), '.vscode', 'extensions'),
                      join(homedir(), '.vscode-server', 'extensions'),
                      join(homedir(), '.vscode-insiders', 'extensions')]) {
    if (!existsSync(root)) continue;
    try {
      readdirSync(root)
        .filter(d => d.startsWith('anthropic.claude-code-'))
        .sort(byVersion)
        .forEach(d => out.push(join(root, d, 'resources', 'native-binary', EXE)));
    } catch { /* unreadable extensions directory */ }
  }

  out.push(join(homedir(), '.claude', 'local', EXE));
  out.push(join(homedir(), '.local', 'bin', EXE));
  return out;
}

let _found;   // undefined = not looked yet, null = looked and absent
export function locate() {
  if (_found !== undefined) return _found;
  for (const p of candidates()) if (existsSync(p)) return (_found = p);
  // Finally PATH itself. Resolved lazily because spawning to probe is slower than a stat.
  return (_found = onPath() ? EXE : null);
}
function onPath() {
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  return dirs.some(d => d && existsSync(join(d, EXE)));
}
export const resetLocate = () => { _found = undefined; };

/** What the UI shows: is this route usable, and which binary would it use. */
export function cliStatus() {
  const path = locate();
  return { available: Boolean(path), path: path || null };
}

// ── running one turn ─────────────────────────────────────────────────────────
const MODEL_ARG = { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku', fable: 'fable' };

// Named so a stage that wants no tools can say so explicitly. Leaving them merely
// unallowed still ships their schemas in the cached prefix.
const ALL_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
                   'Task', 'TodoWrite', 'NotebookEdit'];

// Somewhere harmless for a stage that has no workspace of its own to stand in.
const SCRATCH = join(process.env.RELAY_DATA_DIR || join(homedir(), '.claude-workflow'), '.scratch');

// The role prompts in prompts.mjs were written for the API path, where each role ends by
// calling a submit_* tool. No such tool exists here, and a worker that goes looking for
// one burns turns and then answers anyway. Each stage says so plainly instead.
const NO_SUBMIT_TOOL = (what) =>
  `\n\nIMPORTANT — this run has no submit_notes / submit_verdict / submit_payload tool. ` +
  `Ignore any instruction to call one. Instead, ${what}`;

/**
 * Turn a provider error into something a person can act on. Observed in real runs: three
 * tickets stopped on a raw "API Error: … safeguards flagged this message …" string, with
 * a Run again button that could only ever fail the same way. Which of these is happening
 * decides what the user should do next, so the message has to say.
 */
function explain(raw) {
  const s = String(raw || 'the CLI reported an error');
  if (/safeguards flagged|\/legal\/aup/i.test(s))
    return `the model declined this request — its safeguards flagged the prompt. ` +
           `Retrying will not change that. Reword the requirement, or lower the model for ` +
           `this ticket, and start a new one. (Original: ${s.slice(0, 200)})`;
  if (/rate.?limit|429|usage limit|quota/i.test(s))
    return `the account hit a rate or usage limit. Wait and press Run again — nothing is ` +
           `lost, the ticket resumes from the last finished stage. (Original: ${s.slice(0, 200)})`;
  if (/401|unauthor|authentication|not logged in|invalid api key/i.test(s))
    return `the model rejected the credential. Open Settings and check the route: either ` +
           `sign in to Claude Code, or paste a valid API key. (Original: ${s.slice(0, 200)})`;
  if (/overloaded|529|503|temporarily unavailable/i.test(s))
    return `the model was overloaded. Press Run again in a minute; the ticket resumes from ` +
           `where it stopped. (Original: ${s.slice(0, 200)})`;
  return s;
}

/**
 * One `claude -p` turn, streamed.
 *
 * stream-json emits one JSON object per line: `assistant` messages as they are produced,
 * `user` messages carrying tool results, and a final `result`. Reading it live is what
 * keeps the activity log moving during a turn that takes minutes; the plain `json` format
 * says nothing until the very end.
 */
function turn({ system, prompt, model, cwd, tools = [], addDirs = [], maxTurns, stage, onEvent, timeout = 900000 }) {
  const exe = locate();
  if (!exe) throw new Error('The Claude Code CLI was not found. Install Claude Code, or use an API key instead.');

  const args = [
    '-p',
    '--output-format', 'stream-json', '--verbose',
    '--system-prompt', system,
    // Drops Claude Code's dynamic preamble — the git status, directory listing and editor
    // context this app has no use for. Measured: ~39k cached tokens per call down to
    // ~21k. It is charged on every stage, so it is worth the flag.
    '--exclude-dynamic-system-prompt-sections',
    '--model', MODEL_ARG[model] || 'sonnet',
    '--permission-mode', 'bypassPermissions',   // no human is watching; the tool list is the fence
  ];
  // Both lists, always. An allow-list on its own did NOT hold: a research-only stage was
  // observed calling Edit and Bash. Naming the complement explicitly is what actually
  // stops a stage that only has to write text from editing files on this machine.
  const deny = ALL_TOOLS.filter(t => !tools.includes(t));
  if (tools.length) args.push('--allowed-tools', ...tools);
  if (deny.length)  args.push('--disallowed-tools', ...deny);
  for (const d of addDirs) if (d) args.push('--add-dir', d);
  if (maxTurns) args.push('--max-turns', String(maxTurns));

  // An API key in the environment would make the CLI authenticate as that key instead of
  // as the signed-in user, which is the whole point of this path.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ELECTRON_RUN_AS_NODE;

  // Never inherit the app's own working directory. A stage that is merely writing text
  // still gets a child process with a cwd, and if that cwd is the install or project
  // directory then a stray relative path lands in the user's source tree. Every stage
  // gets an empty scratch directory unless it was given a real workspace.
  const jail = cwd || SCRATCH;
  mkdirSync(jail, { recursive: true });

  // Every child goes in the register, including one started outside a ticket (a bare
  // classify call, a test). Tracking only the ones with an owner is exactly how an orphan
  // survives a quit: nothing holds a handle to it, so nothing can kill it.
  const owner = taskContext.getStore() || LOOSE;

  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: jail, env, windowsHide: true });
    if (!live.has(owner)) live.set(owner, new Set());
    live.get(owner).add(child);
    // In-memory for a normal quit; on disk for a kill that runs no code at all.
    remember(child.pid);
    let buf = '', stderr = '', done = null, text = [];
    const killer = setTimeout(() => { child.kill(); reject(new Error(`${stage}: the CLI did not finish within ${Math.round(timeout / 60000)} minutes`)); }, timeout);

    child.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }

        if (m.type === 'assistant') {
          for (const b of m.message?.content || []) {
            if (b.type === 'text' && b.text.trim()) { text.push(b.text); onEvent?.({ level: 'think', stage, text: b.text.trim().slice(0, 4000) }); }
            if (b.type === 'tool_use') onEvent?.({ level: 'tool', stage, text: `${b.name}${b.input?.query ? `: ${String(b.input.query).slice(0, 120)}` : ''}` });
          }
        }
        if (m.type === 'result') done = m;
      }
    });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(killer); reject(new Error(`could not start the Claude Code CLI: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(killer);
      live.get(owner)?.delete(child);
      forget(child.pid);
      if (!done) return reject(new Error(`${stage}: the CLI exited (${code}) without a result. ${stderr.trim().slice(0, 400)}`));

      // Running out of turns is not the same kind of failure as a broken request. The
      // work up to that point is real, and throwing it away turns a nearly-finished
      // fifteen-minute stage into a total loss — and then the retry pays for it again.
      // Take what there is, say so in the log, and let the reviewers judge it.
      if (done.is_error && done.subtype === 'error_max_turns') {
        record(done.usage, done.total_cost_usd, done.modelUsage);
        const partial = done.result || text.join('\n');
        if (partial.trim()) {
          onEvent?.({ level: 'info', stage, text: 'hit the turn limit — keeping the work produced so far' });
          return resolve({ text: partial, meta: done, truncated: true });
        }
      }
      if (done.is_error) return reject(new Error(`${stage}: ${explain(done.result || done.subtype)}`));
      record(done.usage, done.total_cost_usd, done.modelUsage);
      resolve({ text: done.result ?? text.join('\n'), meta: done });
    });

    child.stdin.end(prompt, 'utf8');
  });
}

// ── structured answers ───────────────────────────────────────────────────────
// There is no schema-enforced output mode on the CLI, so the shape is asked for in words
// and checked in code. A model that answers with prose around the JSON is common and
// harmless; a model that answers with the wrong FIELDS is not, and zod is what catches it.
const fence = /```(?:json)?\s*([\s\S]*?)```/i;

function extractJson(raw) {
  const body = (raw || '').trim();
  const fenced = body.match(fence);
  const candidate = fenced ? fenced[1].trim() : body;
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  // Last resort: the outermost {...} in the text.
  const a = candidate.indexOf('{'), b = candidate.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(candidate.slice(a, b + 1)); } catch { /* no */ } }
  return null;
}

async function structured({ schema, shape, system, prompt, model, stage, onEvent, attachments = [] }) {
  const instruction =
    `\n\n--- OUTPUT FORMAT ---\nReply with one JSON object and nothing else. No prose, no code fence.\n` +
    `Exactly these fields:\n${shape}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const { text } = await turn({
      system, model, stage, onEvent,
      prompt: prompt + instruction + (attempt === 2 ? '\n\nYour previous reply did not parse. Return ONLY the JSON object.' : ''),
      // Reading the attached screenshots is the only tool this stage needs.
      tools: attachments.length ? ['Read'] : [],
      addDirs: attachDirs(attachments),
      maxTurns: attachments.length ? 8 : 2,
    });
    const parsed = extractJson(text);
    const ok = parsed && schema.safeParse(parsed);
    if (ok?.success) return ok.data;
    onEvent?.({ level: 'info', stage, text: `the reply did not match the expected shape${attempt === 1 ? ' — asking again' : ''}` });
  }
  throw new Error(`${stage}: the model never returned a usable decision`);
}

const attachDirs = (attachments = []) => [...new Set(attachments.map(p => dirname(p)))];

const imageNote = (attachments = []) => attachments.length
  ? `\n\n--- ATTACHED IMAGES (${attachments.length}) ---\nRead each of these files before you answer. They are part of the requirement:\n`
    + attachments.map(p => `  ${p}`).join('\n')
  : '';

// ── the five stages ──────────────────────────────────────────────────────────
const ClassifySchema = z.object({
  kind: z.enum(['answer', 'repo', 'project', 'prompt']),
  output_mode: z.enum(['paste', 'guide']),
  why: z.string(),
});

export async function classify({ spec, attachments, model = 'opus', onEvent }) {
  return structured({
    schema: ClassifySchema, system: CLASSIFY, model, stage: 'classify', onEvent, attachments,
    shape: `  kind         one of: answer | repo | project | prompt\n` +
           `  output_mode  one of: paste | guide\n` +
           `  why          one or two sentences`,
    prompt: `--- requirement ---\n${spec}${imageNote(attachments)}`,
  });
}

const ModelSchema = z.object({
  work: z.enum(['opus', 'sonnet', 'haiku', 'fable']),
  review: z.enum(['opus', 'sonnet', 'haiku', 'fable']),
  why: z.string(),
});

export async function pickModel({ spec, attachments, kind, output_mode, attempt, cap, lastDefects, model = 'opus', onEvent }) {
  const ctx = [
    `kind: ${kind}`, `output mode: ${output_mode}`, `this will be attempt ${attempt + 1} of ${cap}`,
    lastDefects ? `\nThe previous attempt FAILED review. The defects were:\n${lastDefects}` : '',
  ].filter(Boolean).join('\n');
  return structured({
    schema: ModelSchema, system: MODEL_PICK, model, stage: 'model', onEvent, attachments,
    shape: `  work    one of: opus | sonnet | haiku | fable\n` +
           `  review  one of: opus | sonnet | haiku | fable\n` +
           `  why     one or two sentences a reviewer could argue with`,
    prompt: `${ctx}\n\n--- requirement ---\n${spec}${imageNote(attachments)}`,
  });
}

// Claude Code's own tools, which is the main thing this path gains over the API path:
// real web search, real file editing, and a shell, with no tool plumbing of our own.
const RESEARCH = ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep'];
const BUILD    = [...RESEARCH, 'Write', 'Edit', 'Bash'];

export async function doWork({ kind, model, spec, attachments, lastDefects, attempt, cap, workspace, onEvent }) {
  const parts = [`--- requirement ---\n${spec}${imageNote(attachments)}`];
  if (kind === 'project') parts.push(`Your workspace directory is: ${workspace}\nCreate files there.`);
  if (lastDefects) parts.push(
    `--- DEFECTS FROM ATTEMPT ${attempt} (this is attempt ${attempt + 1} of ${cap}) ---\n` +
    `Two reviewers failed the previous attempt for these reasons. Fix exactly these. Do not\n` +
    `re-architect what already passed, and do not widen scope. If a defect is wrong, fix the\n` +
    `rest and say so in your notes.\n\n${lastDefects}`);
  // Reviewers were repeatedly having to guess which half of the worker's reply was the
  // thing the user pastes and which half was the worker showing its working — and then
  // grading the wrong half. Two labelled sections, always, so the question never arises.
  parts.push(
    `Structure your whole reply as exactly these two sections, with these exact headings:\n\n` +
    `=== DELIVERABLE ===\n` +
    `Only what the user receives. If they asked for text to paste, this is that text and\n` +
    `nothing else — no preamble, no explanation, no "here is". If they asked for a guide,\n` +
    `this is the guide.\n\n` +
    `=== EVIDENCE ===\n` +
    `What you produced, where it is, every source you checked, and anything a reviewer\n` +
    `needs to verify the deliverable. Never put any of this above the second heading.`);

  const { text } = await turn({
    system: WORKER[kind] + NO_SUBMIT_TOOL('end your reply with the notes themselves.'), model, stage: 'work', onEvent,
    prompt: parts.join('\n\n'),
    tools: kind === 'project' ? BUILD : RESEARCH,
    cwd: kind === 'project' ? workspace : undefined,
    addDirs: [...attachDirs(attachments), kind === 'project' ? workspace : null].filter(Boolean),
    maxTurns: 60,
    // Measured worker turns on real tickets run 8-13 minutes, and a research-heavy one
    // goes longer. The old 15-minute ceiling was inside that range, so a nearly finished
    // stage could be killed and the whole attempt paid for again.
    timeout: 45 * 60 * 1000,
  });
  return text?.trim() || '(the worker produced no notes)';
}

const VerdictSchema = z.object({ result: z.enum(['pass', 'fail']), notes: z.string() });

export async function review({ slot, model, spec, attachments, buildNotes, kind, output_mode, onEvent }) {
  const stage = `review-${slot}`;
  const prompt =
    `--- the requirement (kind: ${kind}, output mode: ${output_mode}) ---\n${spec}${imageNote(attachments)}\n\n` +
    `--- what the worker says it produced ---\n${buildNotes}\n\n` +
    `The worker's reply is split into "=== DELIVERABLE ===" and "=== EVIDENCE ===".\n` +
    `Grade the DELIVERABLE section against the requirement — that is the only part the\n` +
    `user receives. The EVIDENCE section is the worker's support for you; judge whether it\n` +
    `backs the deliverable up, but do not mark the deliverable down for what is in it.\n\n` +
    `Treat those notes as a claim, not as evidence. Check them.` +
    `\n\n--- OUTPUT FORMAT ---\nReply with one JSON object and nothing else:\n` +
    `  result  one of: pass | fail\n` +
    `  notes   specific defects with evidence, or the claims that decided a pass`;

  let text = '';
  try {
    ({ text } = await turn({
      system: REVIEWER[slot] + NO_SUBMIT_TOOL('reply with the JSON object described below and nothing else.'), model, stage, onEvent, prompt,
      tools: RESEARCH, addDirs: attachDirs(attachments), maxTurns: 40, timeout: 30 * 60 * 1000,
    }));
    const parsed = extractJson(text);
    const ok = parsed && VerdictSchema.safeParse(parsed);
    if (ok?.success) return ok.data;
  } catch (e) {
    text = `the reviewer run failed: ${e.message}`;
  }
  // A reviewer that produces no readable verdict is not a pass. Fail closed — the whole
  // point of two reviews is that silence must never be mistaken for approval.
  return { result: 'fail', notes:
    `Reviewer ${slot} did not record a readable verdict. Treating as a failure.\n\n` +
    `Its last output was:\n${String(text).slice(0, 2000) || '(nothing)'}` };
}

export async function writePayload({ model, output_mode, escalated, spec, attachments, buildNotes, reviewNotes, history, onEvent }) {
  const system = escalated ? RESULT.escalated : RESULT[output_mode];
  const body = escalated
    ? `--- the requirement ---\n${spec}\n\n--- what was attempted ---\n${history}\n\n--- why the reviewers failed it ---\n${reviewNotes}`
    : `--- the requirement ---\n${spec}\n\n--- the reviewed work ---\n${buildNotes}\n\n--- what the reviewers confirmed ---\n${reviewNotes}`;

  const { text } = await turn({
    system: system + NO_SUBMIT_TOOL('reply with the payload text itself and nothing else.')
      + `\n\nThe reviewed work below is split into "=== DELIVERABLE ===" and "=== EVIDENCE ===". ` +
        `The payload comes from the DELIVERABLE section. The EVIDENCE section is working-out ` +
        `and must never appear in what you return.`,
    model, stage: 'result', onEvent,
    prompt: `${body}${imageNote(attachments)}\n\nReply with exactly what the user receives and nothing else — no preamble, no explanation of what you are about to write.`,
    tools: attachments.length ? ['Read'] : [],
    addDirs: attachDirs(attachments),
    maxTurns: 12,
  });
  return text?.trim() || '(the result step produced no payload)';
}
