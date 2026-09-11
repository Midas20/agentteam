#!/usr/bin/env node
// relay.mjs - deterministic task ledger for the cross-session relay.
// Routing, the retry cap, the model pin and the two-review gate are enforced HERE,
// not by model judgement. No session has to remember the rules correctly.
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, copyFileSync,
         readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT   = join(dirname(fileURLToPath(import.meta.url)), '..');
// RELAY_DATA_DIR moves the writable state out of the install directory, which is
// read-only once the app is packaged. Unset, everything stays beside the source.
const DATA   = process.env.RELAY_DATA_DIR || ROOT;
const TASKS  = join(DATA, 'tasks');
const ROUTES = join(DATA, 'routes.json');

// Work kinds -> the session role that handles them. Classification decides routing
// once; no later hop re-derives it.
const KINDS = {
  answer:  'worker-answer',    // pick correct answers + write the explanation
  repo:    'worker-repo',      // find the most complex repo matching a brief
  project: 'worker-project',   // create a new project / codebase
  prompt:  'worker-prompt',    // craft prompts that make models fail
};
const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const MODES  = ['paste', 'guide'];
// Used only to stop a reviewer being pinned weaker than the worker.
// 'fable' is deliberately unranked - the guard is skipped rather than guessed.
const STRENGTH = { opus: 3, sonnet: 2, haiku: 1 };

const ROLES = ['orchestrator', 'model-analyst', ...Object.values(KINDS),
               'reviewer-a', 'reviewer-b', 'result'];

// Legal transitions. Anything not listed is rejected.
const LEGAL = {
  open:       ['classified'],
  classified: ['assigned'],
  assigned:   ['built'],
  built:      ['reviewing'],
  reviewing:  ['passed', 'failed'],
  failed:     ['assigned', 'escalated'],
  passed:     ['delivered'],
  escalated:  ['delivered'],
  delivered:  [],
};

// die() THROWS rather than calling process.exit, because process.exit skips `finally`
// and every refusal raised inside withLock would otherwise leak the lock directory,
// blocking the task for 30s. The entry point below turns this back into exit code 1.
class Refusal extends Error {}
const die   = (m) => { throw new Refusal(m); };
const now   = () => new Date().toISOString();
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

function args(argv) {
  const out = { _: [], attach: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { out._.push(argv[i]); continue; }
    const k = argv[i].slice(2);
    const v = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i];
    if (k === 'attach') out.attach.push(v); else out[k] = v;
  }
  return out;
}
const str = (v, flag) => (v && v !== true) ? String(v) : die(`--${flag} required, with a value`);

const routes  = () => existsSync(ROUTES) ? JSON.parse(readFileSync(ROUTES, 'utf8')) : die('routes.json missing');
const path    = (id) => join(TASKS, `${id}.json`);
const filedir = (id) => join(TASKS, `${id}.files`);
const load    = (id) => existsSync(path(id)) ? JSON.parse(readFileSync(path(id), 'utf8'))
                                             : die(`no such task: ${id || '<none given>'}`);

function save(t) {
  mkdirSync(TASKS, { recursive: true });
  const tmp = path(t.id) + '.tmp';
  writeFileSync(tmp, JSON.stringify(t, null, 2));
  renameSync(tmp, path(t.id));   // atomic-ish: no torn reads from a peer session
  return t;
}

// Two reviewers can land a verdict at the same moment. mkdir is atomic on NTFS and
// POSIX, so it is the lock. A lock older than 30s is assumed abandoned.
let held = null;
process.on('exit', () => { if (held) { try { rmSync(held, { recursive: true, force: true }); } catch {} } });

function withLock(id, fn) {
  const lock = path(id) + '.lock';
  for (let i = 0; i < 200; i++) {
    try { mkdirSync(lock); } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 30000) rmSync(lock, { recursive: true, force: true }); } catch {}
      sleep(50); continue;
    }
    held = lock;
    try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); held = null; }
  }
  die(`could not acquire lock for ${id} - remove ${lock} if no session is running`);
}

function move(t, to, actor, note) {
  if (!LEGAL[t.state]?.includes(to)) die(`illegal transition ${t.state} -> ${to} (task ${t.id})`);
  t.history.push({ at: now(), from: t.state, to, actor, note: note || '', attempt: t.attempt });
  t.state = to;
  t.updated = now();
  return t;
}
const log = (t, actor, note) => t.history.push({ at: now(), from: t.state, to: t.state, actor, note, attempt: t.attempt });

const cmds = {

  // ---- intake ------------------------------------------------------------
  new(a) {
    const title = str(a.title, 'title');
    const spec  = a['spec-file'] ? readFileSync(a['spec-file'], 'utf8')
                : (a.spec && a.spec !== true) ? a.spec
                : a.attach.length ? '(requirement is in the attachment(s) - read them before classifying)'
                : die('--spec, --spec-file or --attach required');
    // The clock alone is not unique enough now that several tickets can be started at
    // once: two created in the same millisecond would share an id, and the second would
    // silently overwrite the first. Keep the timestamp prefix so ids still sort by age,
    // and settle ties against what is actually on disk.
    let id = `t-${Date.now().toString(36)}`;
    for (let n = 2; existsSync(path(id)); n++) id = `t-${Date.now().toString(36)}-${n}`;
    const attachments = [];
    if (a.attach.length) {
      mkdirSync(filedir(id), { recursive: true });
      // Two screenshots can easily share a basename - Chromium names every pasted image
      // "image.png". Copying both to the same destination silently loses one and lists
      // the survivor twice, so the model would see one picture and never the other.
      const used = new Set();
      for (const src of a.attach) {
        if (!existsSync(src)) die(`attachment not found: ${src}`);
        const name = basename(src);
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext  = dot > 0 ? name.slice(dot) : '';
        let out = name;
        for (let n = 2; used.has(out); n++) out = `${stem}-${n}${ext}`;
        used.add(out);
        const dst = join(filedir(id), out);
        copyFileSync(resolve(src), dst);
        attachments.push(dst);
      }
    }
    save({ id, title, spec, attachments,
           kind: null, kind_why: '', output_mode: null,
           model: null, model_why: '',
           state: 'open', attempt: 0, cap: Number(a.cap || 3),
           created: now(), updated: now(),
           build_notes: '', last_defects: '', reviews: {}, review_notes: '',
           payload: '', history: [] });
    console.log(id);
    if (attachments.length) console.log(attachments.map(p => `attached: ${p}`).join('\n'));
    console.log(`NEXT: relay classify ${id} --kind <k> --mode paste|guide --why "..."`);
  },

  // The orchestrator's judgement call, recorded so every later hop reads it
  // instead of re-deciding it.
  classify(a) {
    const t = load(a._[0]);
    if (!KINDS[a.kind]) die(`--kind must be one of: ${Object.keys(KINDS).join(', ')}`);
    if (!MODES.includes(a.mode)) die(`--mode must be one of: ${MODES.join(', ')}`);
    str(a.why, 'why');
    t.kind = a.kind; t.output_mode = a.mode; t.kind_why = a.why;
    save(move(t, 'classified', a.by || 'orchestrator', `kind=${a.kind} mode=${a.mode}: ${a.why}`));
    console.log(`${t.id} kind=${a.kind} -> ${KINDS[a.kind]} | output=${a.mode}`);
    console.log(`NEXT: relay envelope ${t.id} --to model-analyst`);
  },

  // The model is a property of the task, not of whichever session picks it up.
  // No state change - the task stays in 'classified' until assign.
  model(a) {
    const t = load(a._[0]);
    if (!MODELS.includes(a.work))   die(`--work must be one of: ${MODELS.join(', ')}`);
    if (!MODELS.includes(a.review)) die(`--review must be one of: ${MODELS.join(', ')}`);
    str(a.why, 'why');
    const sw = STRENGTH[a.work], sr = STRENGTH[a.review];
    if (sw && sr && sr < sw)
      die(`reviewers must not be weaker than the worker (work=${a.work}, review=${a.review})`);
    t.model = { work: a.work, review: a.review };
    t.model_why = a.why;
    log(t, a.by || 'model-analyst', `model work=${a.work} review=${a.review}: ${a.why}`);
    save(t);
    console.log(`${t.id} model work=${a.work} review=${a.review}`);
    if (!sw || !sr) console.log(`note: 'fable' is unranked, so the reviewer-strength guard was skipped`);
    console.log(`NEXT: relay envelope ${t.id} --to orchestrator`);
  },

  // ---- the loop ----------------------------------------------------------
  // Hands the task to the worker. Increments the attempt and clears the previous
  // attempt's reviews, so a redo is always judged fresh.
  assign(a) {
    const t = load(a._[0]);
    if (!t.kind)  die(`task ${t.id} is unclassified - relay classify ${t.id} --kind <k> --mode <m> --why "..."`);
    if (!t.model) die(`task ${t.id} has no model pinned - relay envelope ${t.id} --to model-analyst`);
    if (t.attempt >= t.cap) die(`attempt cap ${t.cap} already reached - task is ${t.state}, escalate instead`);
    if (t.state === 'failed') t.last_defects = t.review_notes;
    t.attempt++;
    t.reviews = {}; t.review_notes = '';
    move(t, 'assigned', a.by || 'orchestrator', a.note);
    save(t);
    console.log(`${t.id} assigned to ${KINDS[t.kind]} on ${t.model.work} (attempt ${t.attempt}/${t.cap})`);
    console.log(`NEXT: relay envelope ${t.id} --to worker`);
  },

  built(a) {
    const t = load(a._[0]);
    // --notes-file exists because Windows caps a command line at ~32k characters and
    // thorough build notes exceed that. Same reason deliver takes --file.
    t.build_notes = a['notes-file'] ? readFileSync(a['notes-file'], 'utf8') : str(a.notes, 'notes');
    save(move(t, 'built', a.by || KINDS[t.kind], t.build_notes.slice(0, 300)));
    console.log(`${t.id} built (attempt ${t.attempt}/${t.cap})`);
    console.log(`NEXT: send to BOTH reviewers - relay envelope ${t.id} --to reviewer-a  AND  --to reviewer-b`);
  },

  reviewing(a) {
    const t = load(a._[0]);
    if (t.state === 'reviewing') return console.log(`${t.id} already under review`);
    save(move(t, 'reviewing', a.by || 'reviewer', a.note));
    console.log(`${t.id} under review`);
  },

  // Two independent reviews are required. The second one to land resolves the verdict.
  review(a) {
    const id = a._[0];
    if (!['a', 'b'].includes(a.slot)) die('--slot must be a or b');
    if (!['pass', 'fail'].includes(a.result)) die('--result must be pass or fail');
    const notes = a['notes-file'] ? readFileSync(a['notes-file'], 'utf8') : str(a.notes, 'notes');
    withLock(id, () => {
      const t = load(id);
      if (t.state === 'built') move(t, 'reviewing', a.by || `reviewer-${a.slot}`, 'picked up');
      if (t.state !== 'reviewing') die(`task ${t.id} is ${t.state}, not awaiting review`);
      if (t.reviews[a.slot]) die(`slot ${a.slot} already recorded for attempt ${t.attempt}: ${t.reviews[a.slot].result}`);
      t.reviews[a.slot] = { result: a.result, notes, by: a.by || `reviewer-${a.slot}`, at: now() };

      const other = a.slot === 'a' ? 'b' : 'a';
      if (!t.reviews[other]) {
        save(t);
        return console.log(`${t.id} review ${a.slot} recorded (${a.result}) - slot ${other} outstanding\n`
          + `NEXT: WAIT. Do not route anything. The other reviewer resolves this task.`);
      }

      t.review_notes = `[review a - ${t.reviews.a.result}] ${t.reviews.a.notes}\n`
                     + `[review b - ${t.reviews.b.result}] ${t.reviews.b.notes}`;
      const passed = t.reviews.a.result === 'pass' && t.reviews.b.result === 'pass';
      save(move(t, passed ? 'passed' : 'failed', a.by || `reviewer-${a.slot}`,
                passed ? 'both reviews pass' : 'at least one review failed'));
      console.log(`${t.id} both reviews in (attempt ${t.attempt}/${t.cap})`);
      if (passed)
        console.log(`VERDICT: PASSED\nNEXT: relay envelope ${t.id} --to result`);
      else if (t.attempt >= t.cap)
        console.log(`VERDICT: FAILED (${t.attempt}/${t.cap})\n`
          + `NEXT: ESCALATE - cap reached. Send --to result (the reason) AND --to orchestrator.`);
      else
        console.log(`VERDICT: FAILED (${t.attempt}/${t.cap})\n`
          + `NEXT: REDO - send --to result (the reason) AND --to orchestrator (it may assign attempt ${t.attempt + 1}).`);
    });
  },

  escalate(a) {
    const t = load(a._[0]);
    save(move(t, 'escalated', a.by || 'orchestrator', a.note));
    console.log(`${t.id} escalated\nNEXT: relay envelope ${t.id} --to result`);
  },

  // ---- delivery ----------------------------------------------------------
  // The result session is the only writer of what the user receives.
  deliver(a) {
    const t = load(a._[0]);
    if (!MODES.includes(a.mode)) die(`--mode must be one of: ${MODES.join(', ')}`);
    if (a.mode !== t.output_mode)
      die(`task output_mode is '${t.output_mode}', not '${a.mode}' - the mode is set at classify time, not here`);
    if (t.state === 'failed')
      die(`task ${t.id} failed but is not escalated - a redo is still owed. Report the reason; do not deliver.`);
    if (!['passed', 'escalated'].includes(t.state)) die(`task ${t.id} is ${t.state} - nothing to deliver yet`);
    const p = a.file ? readFileSync(a.file, 'utf8') : str(a.payload, 'payload');
    t.payload = p;
    save(move(t, 'delivered', a.by || 'result', `${t.output_mode}, ${p.length} chars`));
    console.log(`${t.id} delivered (${t.output_mode})\nNEXT: relay payload ${t.id}`);
  },

  payload(a) { console.log(load(a._[0]).payload || '(no payload recorded)'); },

  // ---- wire format -------------------------------------------------------
  // Generated, so reply-to, the model pin and the attachments survive every hop.
  envelope(a) {
    const t = load(a._[0]), r = routes();
    let to = a.to || die(`--to model-analyst|worker|reviewer-a|reviewer-b|orchestrator|result`);
    if (to === 'worker') to = KINDS[t.kind] || die(`task ${t.id} is unclassified`);
    if (!ROLES.includes(to)) die(`unknown hop: ${to}`);
    const hop = r[to];
    if (!hop || String(hop).startsWith('PLACEHOLDER')) die(`routes.json has no live session pinned for ${to}`);

    const body = (a.body && a.body !== true) ? a.body
      : to === 'model-analyst'    ? t.spec
      : to.startsWith('worker')   ? [t.spec, t.last_defects &&
          `\n## DEFECTS FROM ATTEMPT ${t.attempt - 1} - fix these, do not re-architect the rest\n${t.last_defects}`]
          .filter(Boolean).join('\n')
      : to.startsWith('reviewer') ? t.build_notes
      : to === 'result'           ? (t.state === 'passed' ? t.build_notes : t.review_notes)
      : t.review_notes;

    const mline = t.model
      ? `model: ${to.startsWith('reviewer') ? t.model.review : t.model.work}   # run the work in a subagent on this model\n`
      : '';

    console.log(
`[TASK ${t.id} | kind=${t.kind} | mode=${t.output_mode} | attempt ${t.attempt}/${t.cap} | state=${t.state}]
reply-to: ${r.orchestrator}
next-hop: ${hop}
${mline}task-file: ${path(t.id)}${t.attachments.length ? '\n' + t.attachments.map(p => `attachment: ${p}`).join('\n') : ''}
---
${t.title}

${body}`);
  },

  // Pin the live session names once, at bootstrap. Several roles may share a session.
  routes(a) {
    const r = existsSync(ROUTES) ? JSON.parse(readFileSync(ROUTES, 'utf8')) : {};
    for (const k of ROLES) if (a[k]) r[k] = a[k];
    writeFileSync(ROUTES, JSON.stringify(r, null, 2));
    console.log(JSON.stringify(r, null, 2));
    const missing = ROLES.filter(k => !r[k] || String(r[k]).startsWith('PLACEHOLDER'));
    if (missing.length) console.log(`\nstill unpinned: ${missing.join(', ')}`);
  },

  // --for a|b hides the OTHER reviewer's notes, so the two reviews stay independent.
  show(a) {
    const t = load(a._[0]);
    if (a.for === 'a' || a.for === 'b') {
      const other = a.for === 'a' ? 'b' : 'a';
      if (t.reviews[other]) t.reviews[other] = '(hidden - reviews are independent)';
    }
    console.log(JSON.stringify(t, null, 2));
  },

  list() {
    if (!existsSync(TASKS)) return console.log('(no tasks)');
    const rows = readdirSync(TASKS).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(readFileSync(join(TASKS, f), 'utf8')))
      .sort((x, y) => y.created.localeCompare(x.created));
    if (!rows.length) return console.log('(no tasks)');
    for (const t of rows) {
      const rv = ['a', 'b'].map(s => t.reviews[s] ? t.reviews[s].result[0] : '-').join('');
      console.log(`${t.id}  ${t.state.padEnd(10)} ${(t.kind || '?').padEnd(7)} `
        + `${(t.model?.work || '?').padEnd(6)} ${t.attempt}/${t.cap} rv:${rv}  ${t.title}`);
    }
  },
};

const a = args(process.argv.slice(3));
try {
  (cmds[process.argv[2]] || (() => die(`usage: relay <${Object.keys(cmds).join('|')}> [id] [--flags]`)))(a);
} catch (e) {
  if (!(e instanceof Refusal)) throw e;
  console.error(`relay: ${e.message}`);
  process.exit(1);
}
