// inputs.mjs - the parts of a ticket that are input rather than state.
//
// The ledger file is the task's state, and only bin/relay.mjs writes it. That rule is
// worth keeping, so the two things here do not go in it:
//
//   models   which model to use for each stage, when the person has overridden the
//            analyst's choice. A preference, not something the state machine decides.
//   addenda  extra instructions typed while the ticket is already running.
//
// Attachments already work this way — the ledger records a reference and the bytes live
// beside it — so this follows the precedent rather than inventing a second one.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(process.env.RELAY_DATA_DIR || HERE, '.inputs');

/** Every model a stage may be pinned to, plus the default of letting the analyst choose. */
export const MODELS = ['auto', 'opus', 'sonnet', 'haiku', 'fable'];
/** The stages a model can be chosen for, in the order they run. */
export const STAGES = ['classify', 'model', 'work', 'review', 'result'];

const file = (id) => join(DIR, `${id}.json`);
const EMPTY = { models: {}, addenda: [] };

export function read(id) {
  try {
    const v = JSON.parse(readFileSync(file(id), 'utf8'));
    return { models: v.models || {}, addenda: Array.isArray(v.addenda) ? v.addenda : [] };
  } catch { return { ...EMPTY, models: {}, addenda: [] }; }
}

function write(id, v) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(file(id), JSON.stringify(v), 'utf8');
}

/** Pin stages to models. Anything not named, or named 'auto', is left to the analyst. */
export function setModels(id, models = {}) {
  const cur = read(id);
  for (const [stage, m] of Object.entries(models)) {
    if (!STAGES.includes(stage)) throw new Error(`unknown stage "${stage}"`);
    if (!MODELS.includes(m)) throw new Error(`unknown model "${m}"`);
    if (m === 'auto') delete cur.models[stage];
    else cur.models[stage] = m;
  }
  write(id, cur);
  return cur.models;
}

/** The model pinned for a stage, or null to mean "the analyst decides". */
export const modelFor = (id, stage) => read(id).models[stage] || null;

/**
 * Add an instruction to a ticket that is already running.
 *
 * It cannot change a call that is already in flight — that request was sent, and the only
 * way to stop it is Stop. It joins the requirement from the next stage onward, and on
 * every retry. The caller is told which stage will be the first to see it so the UI can
 * say so plainly instead of implying it took effect immediately.
 */
export function addAddendum(id, text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('an addendum needs some text');
  if (t.length > 20000) throw new Error('that addendum is too long (20,000 characters max)');
  const cur = read(id);
  cur.addenda.push({ at: new Date().toISOString(), text: t });
  write(id, cur);
  return cur.addenda.length;
}

/**
 * The requirement as the next stage should see it: the original, then anything added
 * since, clearly marked so a stage cannot mistake a later instruction for the first one.
 */
export function specWith(id, spec) {
  const { addenda } = read(id);
  if (!addenda.length) return spec;
  return spec + addenda.map((a, i) =>
    `\n\n--- ADDED BY THE REQUESTER WHILE THIS TICKET WAS RUNNING (${i + 1} of ${addenda.length}) ---\n` +
    `This arrived after the work began. It is part of the requirement and overrides anything\n` +
    `earlier that contradicts it.\n\n${a.text}`).join('');
}

export function forget(id) {
  try { rmSync(file(id), { force: true }); } catch { /* nothing to remove */ }
}

export const has = (id) => existsSync(file(id));
