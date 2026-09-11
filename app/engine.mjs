// engine.mjs - the pipeline.
//
// Stage order and the retry loop live here; the ledger (bin/relay.mjs) still owns the
// state machine, the attempt cap, the model guard and the two-review gate. The engine
// asks the ledger to move the task and obeys a refusal — it never edits a task file.
//
// The two reviewers run concurrently from the worker's notes alone. Neither is given the
// other's verdict, so their independence is structural rather than a rule anyone follows.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, pickModel, doWork, review, writePayload } from './provider.mjs';
import { modelFor, specWith, read as readInputs } from './inputs.mjs';
import { plainText, countMarkdown } from './plain.mjs';
import { taskContext } from './usage.mjs';
import { killTask } from './cli.mjs';

const HERE      = dirname(fileURLToPath(import.meta.url));
const RELAY_DIR = join(HERE, '..');
// When packaged, this file lives inside app.asar but bin/ is unpacked alongside it.
// A child node process cannot read from the archive, so use the real path on disk.
const DATA      = process.env.RELAY_DATA_DIR || RELAY_DIR;
const TASKS     = join(DATA, 'tasks');
const WORKSPACE = join(DATA, 'workspace');
const TMP       = join(DATA, '.tmp');
const CLI       = join(RELAY_DIR, 'bin', 'relay.mjs').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);

// cwd is the DATA directory, not RELAY_DIR. Once packaged, RELAY_DIR points inside
// app.asar, which is a FILE — handing it to a child process as its working directory
// fails with a bare ENOENT that reads like the executable is missing.
export const ledger = (args) => new Promise((res, rej) => {
  mkdirSync(DATA, { recursive: true });
  execFile(process.execPath, [CLI, ...args],
    { cwd: DATA, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, (err, stdout, stderr) =>
    err ? rej(new Error((stderr || stdout || err.message).trim().replace(/^relay:\s*/, '')))
        : res(stdout.trim()));
});
export const readTask = (id) => JSON.parse(readFileSync(join(TASKS, `${id}.json`), 'utf8'));

// A command line is capped (~32k characters on Windows, and execFile throws
// ENAMETOOLONG rather than truncating). Notes routinely exceed that, so they travel
// as a file. Small values still go inline so hand-run commands stay readable.
let tmpSeq = 0;
function spill(text) {
  mkdirSync(TMP, { recursive: true });
  const f = join(TMP, `arg-${Date.now().toString(36)}-${tmpSeq++}.txt`);
  writeFileSync(f, text, 'utf8');
  return f;
}
async function ledgerNotes(args, notes) {
  const f = spill(notes);
  try { return await ledger([...args, '--notes-file', f]); }
  finally { rmSync(f, { force: true }); }
}

const runs = new Map();   // id -> { status, events, error }

export const runState = (id) => runs.get(id) || null;
export const allRuns   = () => Object.fromEntries([...runs].map(([k, v]) => [k, { status: v.status, error: v.error, events: v.events.length }]));

function emitter(id) {
  const rec = { status: 'running', events: [], error: null };
  runs.set(id, rec);
  return (e) => {
    const ev = { at: new Date().toISOString(), level: 'info', stage: '-', ...e };
    rec.events.push(ev);
    if (rec.events.length > 4000) rec.events.splice(0, 1000);   // a long run must not grow without bound
    for (const fn of listeners) fn(id, ev);
  };
}
const listeners = new Set();
export const onRunEvent = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/**
 * Create a task and drive it to a payload. Resolves when the task is delivered or the
 * run stops; never throws into the caller's request — failures land on the run record.
 */
// Tickets the user has asked to stop. Checked between stages, and the child process is
// killed outright, so a fifteen-minute worker turn ends now rather than eventually.
const cancelled = new Set();
export function cancelTask(id) {
  cancelled.add(id);
  const killed = killTask(id);
  const rec = runs.get(id);
  if (rec) { rec.status = "cancelled"; rec.error = "Stopped by you."; }
  return { killed };
}
class Cancelled extends Error {}

export async function runTask(args) {
  cancelled.delete(args.id);           // a fresh run clears a previous stop
  return taskContext.run(args.id, () => runTaskInner(args));
}

async function runTaskInner({ id }) {
  const emit = emitter(id);
  const rec  = runs.get(id);
  const fail = (e) => { rec.status = 'error'; rec.error = e.message; emit({ level: 'error', stage: 'run', text: e.message }); };

  try {
    let t = readTask(id);
    emit({ level: 'stage', stage: 'classify', text: 'Reading the requirement' });

    // ── 1. classify ─────────────────────────────────────────────
    if (t.state === 'open') {
      const c = await classify({ spec: specWith(id, t.spec), attachments: t.attachments,
                                 model: modelFor(id, 'classify') || undefined, onEvent: emit });
      await ledger(['classify', id, '--kind', c.kind, '--mode', c.output_mode, '--why', c.why.slice(0, 2000), '--by', 'app:classify']);
      emit({ level: 'done', stage: 'classify', text: `${c.kind} · ${c.output_mode} — ${c.why}` });
      t = readTask(id);
    }

    // ── 2..5, once per attempt ──────────────────────────────────
    // Entered by STATE, not by step number, so a run interrupted mid-flight resumes
    // where it stopped. The ledger's transitions only permit one way forward from each
    // state, which is exactly what makes resuming safe rather than guesswork.
    let guard = 0;
    while (!['passed', 'escalated', 'delivered'].includes(t.state)) {
      if (++guard > t.cap * 4 + 8) throw new Error(`stuck in ${t.state} — giving up rather than looping`);
      if (cancelled.has(id)) throw new Cancelled("Stopped by you.");
      const before = `${t.state}/${t.attempt}/${Object.keys(t.reviews).length}`;

      // 2 + 3. model, then assign. Also the entry point for a retry after a failure.
      if (t.state === 'classified' || t.state === 'failed') {
        if (t.state === 'failed' && t.attempt >= t.cap) {
          await ledger(['escalate', id, '--by', 'app']);
          emit({ level: 'error', stage: 'verdict', text: `Failed ${t.attempt}/${t.cap} attempts — escalating` });
          t = readTask(id);
          break;
        }
        // A stage pinned to a model is not a hint, it is an instruction. If both the
        // worker and the reviewers are pinned there is nothing left for the analyst to
        // decide, so do not pay for a call that cannot change the outcome.
        const pinWork = modelFor(id, 'work'), pinRev = modelFor(id, 'review');
        let m;
        if (pinWork && pinRev) {
          m = { work: pinWork, review: pinRev, why: 'Chosen by you, not by the analyst.' };
          emit({ level: 'info', stage: 'model', text: `Pinned by you — work ${pinWork} · review ${pinRev}` });
        } else {
          emit({ level: 'stage', stage: 'model', text: 'Choosing the model' });
          m = await pickModel({
            spec: specWith(id, t.spec), attachments: t.attachments, kind: t.kind, output_mode: t.output_mode,
            attempt: t.attempt, cap: t.cap, lastDefects: t.state === 'failed' ? t.review_notes : '',
            model: modelFor(id, 'model') || undefined, onEvent: emit,
          });
          if (pinWork) { m.work = pinWork; m.why += ' Worker pinned by you.'; }
          if (pinRev)  { m.review = pinRev; m.why += ' Reviewers pinned by you.'; }
        }
        await ledger(['model', id, '--work', m.work, '--review', m.review, '--why', m.why.slice(0, 2000), '--by', 'app:analyst'])
          .catch(async (e) => {
            // The ledger refuses a reviewer weaker than the worker. Raise the reviewers
            // rather than lowering the bar, and say so.
            emit({ level: 'info', stage: 'model', text: `${e.message} — raising the reviewers to ${m.work}` });
            await ledger(['model', id, '--work', m.work, '--review', m.work, '--why', `${m.why} (reviewers raised to match the worker)`.slice(0, 2000), '--by', 'app:analyst']);
          });
        t = readTask(id);
        emit({ level: 'done', stage: 'model', text: `work ${t.model.work} · review ${t.model.review} — ${t.model_why}` });
        await ledger(['assign', id, '--by', 'app']);
        t = readTask(id);
      }

      // 4. work
      if (t.state === 'assigned') {
        emit({ level: 'stage', stage: 'work', text: `Attempt ${t.attempt} of ${t.cap} — ${t.kind} worker on ${t.model.work}` });
        const notes = await doWork({
          kind: t.kind, model: t.model.work, spec: specWith(id, t.spec), attachments: t.attachments,
          lastDefects: t.last_defects, attempt: t.attempt - 1, cap: t.cap,
          workspace: join(WORKSPACE, id), onEvent: emit,
        });
        await ledgerNotes(['built', id, '--by', `app:${t.kind}`], notes);
        emit({ level: 'done', stage: 'work', text: `Recorded ${notes.length} characters of notes` });
        t = readTask(id);
      }

      // 5. the reviews still outstanding. On a fresh attempt that is both of them, run
      // concurrently; on a resume it may be only the one that never landed.
      if (t.state === 'built' || t.state === 'reviewing') {
        const missing = ['a', 'b'].filter(s => !t.reviews[s]);
        emit({ level: 'stage', stage: 'review', text:
          missing.length === 2 ? `Two independent reviews on ${t.model.review}`
                               : `Resuming — review ${missing.join('')} never landed` });
        const args = { spec: specWith(id, t.spec), attachments: t.attachments, buildNotes: t.build_notes,
                       kind: t.kind, output_mode: t.output_mode, model: t.model.review, onEvent: emit };
        const done = await Promise.all(missing.map(slot => review({ ...args, slot })));
        // Recorded one at a time: the ledger's lock resolves the verdict on the second.
        for (let i = 0; i < missing.length; i++) {
          await ledgerNotes(['review', id, '--slot', missing[i], '--result', done[i].result,
                             '--by', `app:reviewer-${missing[i]}`], done[i].notes);
        }
        t = readTask(id);
        emit({ level: 'done', stage: 'review', text:
          ['a', 'b'].map(s => `${s.toUpperCase()}: ${t.reviews[s]?.result ?? '—'}`).join(' · ') });
        if (t.state === 'failed' && t.attempt < t.cap)
          emit({ level: 'info', stage: 'verdict', text: `Attempt ${t.attempt} failed — retrying with the defects` });
      }

      if (`${t.state}/${t.attempt}/${Object.keys(t.reviews).length}` === before)
        throw new Error(`cannot make progress from state "${t.state}"`);
    }

    // ── 6. payload ──────────────────────────────────────────────
    t = readTask(id);
    const escalated = t.state === 'escalated';
    emit({ level: 'stage', stage: 'result', text: escalated ? 'Writing up why it failed' : `Writing the ${t.output_mode} result` });
    const payload = await writePayload({
      model: modelFor(id, 'result') || t.model?.review || 'opus', output_mode: t.output_mode, escalated,
      spec: specWith(id, t.spec), attachments: t.attachments, buildNotes: t.build_notes, reviewNotes: t.review_notes,
      history: t.history.filter(h => h.to === 'built' || h.to === 'failed').map(h => `attempt ${h.attempt}: ${h.to} — ${h.note}`).join('\n'),
      onEvent: emit,
    });

    // The payload is pasted into a form, not rendered. Anything the result role left as
    // Markdown would show up as literal asterisks and hashes, so take them out — and say
    // how many, rather than changing what the person receives without telling them.
    const clean = plainText(payload);
    const removed = countMarkdown(payload, clean);
    if (removed) emit({ level: 'info', stage: 'result', text:
      `Removed ${removed} piece(s) of Markdown formatting — the payload is plain text` });

    mkdirSync(TMP, { recursive: true });
    const f = join(TMP, `${id}.payload.md`);
    writeFileSync(f, clean, 'utf8');
    await ledger(['deliver', id, '--mode', t.output_mode, '--file', f, '--by', 'app:result']);
    rmSync(f, { force: true });

    rec.status = escalated ? 'escalated' : 'done';
    emit({ level: 'done', stage: 'result', text: escalated ? 'Reason recorded' : 'Result ready to copy' });
  } catch (e) {
    if (e instanceof Cancelled || cancelled.has(id)) {
      rec.status = "cancelled"; rec.error = "Stopped by you.";
      emit({ level: "info", stage: "run", text: "Stopped. The ticket keeps everything finished so far — press Run again to resume from there." });
    } else fail(e);
  }
}

export const workspaceFor = (id) => join(WORKSPACE, id);
export const paths = { RELAY_DIR, TASKS, CLI, WORKSPACE };
