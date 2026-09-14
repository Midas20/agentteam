// agents.mjs - who is in the pipeline, and what each of them is told.
//
// The pipeline used to be fixed: one classifier, one worker, exactly two reviewers on two
// axes chosen by whoever wrote prompts.mjs, one writer. Those are good defaults and they
// stay the defaults - but they are somebody else's judgement about your work, and the
// reviewers in particular decide whether an answer ships. That call belongs to the person
// whose name is on the submission.
//
// So the roster is data now, not source code:
//
//   * every agent's instructions can be rewritten, and reset back,
//   * the reviewers can be two, three or four, each on its own named axis.
//
// What is NOT configurable, deliberately:
//
//   * fewer than two reviewers. The whole design rests on two verdicts reached without
//     sight of each other. One reviewer is not a gate, it is a second opinion, and the
//     ledger would have nothing to resolve.
//   * the order of the stages, which the ledger's transition table enforces and which no
//     amount of prompt text can change.
//
// Stored at <DATA>/agents.json. Only the differences from the defaults are written, so an
// app that never touches this file behaves exactly as it always did, and an upgrade that
// improves a default prompt still reaches everyone who has not overridden that one.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLASSIFY, WORKER, REVIEWER, RESULT } from './prompts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR  = process.env.RELAY_DATA_DIR || HERE;
export const FILE = join(DIR, 'agents.json');

// A role's instructions are a system prompt, and a system prompt that runs away with
// itself is paid for on every call of every stage of every run.
export const LIMIT = 40000;

/** Reviewer slots, in the order they are offered. Two are on by default. */
export const SLOTS = ['a', 'b', 'c', 'd'];
export const DEFAULT_SLOTS = ['a', 'b'];

/**
 * Every agent the pipeline can call, with its default text and a one-line description of
 * what it is for. `axis` is a reviewer's beat - the single word for what it is looking
 * for, and the thing that makes two reviews two reviews rather than one review twice.
 */
const DEFAULTS = [
  { id: 'classify', group: 'Intake', label: 'Classifier',
    blurb: 'Reads the requirement and decides what kind of work it is and what you need at the end.',
    text: () => CLASSIFY },

  { id: 'worker.answer', group: 'Workers', label: 'Answer worker',
    blurb: 'Evaluation tasks: selections plus a written explanation.', text: () => WORKER.answer },
  { id: 'worker.repo', group: 'Workers', label: 'Repository worker',
    blurb: 'Finds a repository matching a brief, and proves it is the hardest one available.',
    text: () => WORKER.repo },
  { id: 'worker.project', group: 'Workers', label: 'Project worker',
    blurb: 'Builds something new to a specification, in a real workspace on disk.',
    text: () => WORKER.project },
  { id: 'worker.prompt', group: 'Workers', label: 'Prompt worker',
    blurb: 'Authors prompts intended to make a model fail, each with a checkable failure.',
    text: () => WORKER.prompt },

  { id: 'reviewer.a', group: 'Reviewers', label: 'Reviewer A', axis: 'Compliance',
    blurb: 'Was everything that was asked for actually delivered, in the shape it was asked for?',
    text: () => REVIEWER.a },
  { id: 'reviewer.b', group: 'Reviewers', label: 'Reviewer B', axis: 'Correctness',
    blurb: 'Set aside whether the boxes were ticked - is it actually right?', text: () => REVIEWER.b },
  { id: 'reviewer.c', group: 'Reviewers', label: 'Reviewer C', axis: 'Evidence',
    blurb: 'Could a stranger re-derive this from the notes alone, without taking anything on trust?',
    text: () => REVIEWER.c },
  { id: 'reviewer.d', group: 'Reviewers', label: 'Reviewer D', axis: 'Risk',
    blurb: 'Reads the requirement adversarially and attacks whatever would cost most if it were wrong.',
    text: () => REVIEWER.d },

  { id: 'result.paste', group: 'Result', label: 'Result writer - paste',
    blurb: 'Writes the exact text you paste into the form. Plain text, form order, nothing else.',
    text: () => RESULT.paste },
  { id: 'result.guide', group: 'Result', label: 'Result writer - guide',
    blurb: 'Writes the steps you carry out yourself, each one with a checkpoint.',
    text: () => RESULT.guide },
  { id: 'result.escalated', group: 'Result', label: 'Result writer - failure',
    blurb: 'Explains why a ticket could not be completed, in the reviewers own words.',
    text: () => RESULT.escalated },
];

const byId = new Map(DEFAULTS.map(d => [d.id, d]));
export const ids = () => DEFAULTS.map(d => d.id);
export const exists = (id) => byId.has(id);

function load() {
  try {
    const v = JSON.parse(readFileSync(FILE, 'utf8'));
    return { slots: Array.isArray(v.slots) ? v.slots : null,
             roles: v.roles && typeof v.roles === 'object' ? v.roles : {} };
  } catch { return { slots: null, roles: {} }; }
}

function store(v) {
  // Nothing left to remember means no file, so a reset really is a reset rather than an
  // empty object quietly shadowing a future improvement to the defaults.
  if (!v.slots && !Object.keys(v.roles).length) { try { rmSync(FILE, { force: true }); } catch { } return; }
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(v, null, 2), 'utf8');
}

/** The reviewers that will actually run. Always at least two, always in slot order. */
export function activeSlots() {
  const { slots } = load();
  if (!slots) return [...DEFAULT_SLOTS];
  const clean = SLOTS.filter(s => slots.includes(s));
  return clean.length >= 2 ? clean : [...DEFAULT_SLOTS];
}

/**
 * Choose the reviewers. Two to four, each one a slot that exists.
 *
 * The floor of two is the point of the whole gate, so asking for one is refused here
 * rather than quietly corrected - someone who asks for a single reviewer has a reason,
 * and deserves to be told why they cannot have it instead of watching a setting spring
 * back with no explanation.
 */
export function setSlots(list) {
  const given = Array.isArray(list) ? list : [];
  for (const s of given) if (!SLOTS.includes(s)) throw new Error(`unknown reviewer slot "${s}"`);
  const want = SLOTS.filter(s => given.includes(s));
  if (want.length < 2) throw new Error('at least two reviewers - a single verdict is an opinion, not a review');
  const cur = load();
  cur.slots = want.join('') === DEFAULT_SLOTS.join('') ? null : want;
  store(cur);
  return activeSlots();
}

const defOf = (id) => byId.get(id) || null;

/** The system prompt a stage actually runs with: the override if there is one, else the default. */
export function instructions(id) {
  const d = defOf(id);
  if (!d) throw new Error(`unknown agent "${id}"`);
  const o = load().roles[id];
  const t = o && typeof o.instructions === 'string' ? o.instructions.trim() : '';
  return t || d.text();
}

/** Everything about one agent, its default included, so an editor can offer "reset". */
export function role(id) {
  const d = defOf(id);
  if (!d) throw new Error(`unknown agent "${id}"`);
  const o = load().roles[id] || {};
  const def = { label: d.label, axis: d.axis || null, blurb: d.blurb, instructions: d.text() };
  return {
    id: d.id, group: d.group,
    slot: d.id.startsWith('reviewer.') ? d.id.slice(-1) : null,
    label: (o.label || '').trim() || def.label,
    axis: d.axis ? ((o.axis || '').trim() || def.axis) : null,
    blurb: (o.blurb || '').trim() || def.blurb,
    instructions: (typeof o.instructions === 'string' && o.instructions.trim()) || def.instructions,
    custom: Object.keys(o).length > 0,
    default: def,
  };
}

/**
 * Change an agent. Only the fields given are touched, and a field set back to its default
 * value stops counting as an override - so "custom" means genuinely different rather than
 * merely visited.
 */
export function setRole(id, patch = {}) {
  const d = defOf(id);
  if (!d) throw new Error(`unknown agent "${id}"`);
  const cur = load();
  const o = { ...(cur.roles[id] || {}) };
  const def = { label: d.label, axis: d.axis || '', blurb: d.blurb, instructions: d.text() };
  for (const k of ['label', 'axis', 'blurb', 'instructions']) {
    if (!(k in patch)) continue;
    if (k === 'axis' && !d.axis) continue;                 // only reviewers have an axis
    const v = String(patch[k] ?? '').trim();
    if (k === 'instructions' && v.length > LIMIT)
      throw new Error(`those instructions are too long (${LIMIT.toLocaleString()} characters max)`);
    if (k === 'label' && v.length > 60) throw new Error('that name is too long (60 characters max)');
    if (k === 'axis' && v.length > 40) throw new Error('that axis is too long (40 characters max)');
    if (k === 'blurb' && v.length > 300) throw new Error('that description is too long (300 characters max)');
    if (!v || v === String(def[k]).trim()) delete o[k]; else o[k] = v;
  }
  if (Object.keys(o).length) cur.roles[id] = o; else delete cur.roles[id];
  store(cur);
  return role(id);
}

/** Put one agent back to how it shipped. */
export function resetRole(id) {
  if (!defOf(id)) throw new Error(`unknown agent "${id}"`);
  const cur = load();
  delete cur.roles[id];
  store(cur);
  return role(id);
}

/** Everything back to how it shipped, the reviewer count included. */
export function resetAll() { try { rmSync(FILE, { force: true }); } catch { } return roster(); }

/**
 * The whole roster, for the settings screen. Reviewers carry whether they are switched
 * on; every other agent is always in the pipeline.
 */
export function roster() {
  const on = activeSlots();
  return {
    slots: on, allSlots: [...SLOTS], limit: LIMIT,
    agents: DEFAULTS.map(d => {
      const r = role(d.id);
      return { id: r.id, group: r.group, slot: r.slot, label: r.label, axis: r.axis, blurb: r.blurb,
               custom: r.custom, chars: r.instructions.length,
               active: r.slot ? on.includes(r.slot) : true };
    }),
  };
}

/**
 * How this work is judged, in the terms the reviewers are actually running under.
 *
 * The result screen states the review method before it states the verdicts, and stating a
 * method that is not the one that ran would be worse than stating none at all. So it is
 * read from here - the same source the reviewers themselves are built from - rather than
 * from a sentence written once in the UI and left to drift.
 */
/**
 * Every reviewer slot there is, active or not, with its name and axis.
 *
 * A finished ticket says who judged it. It was judged by the roster it was assigned, which
 * may no longer be the roster in force - so the screen needs the name and axis of a slot
 * that is currently switched off, or a ticket reviewed by three would afterwards be
 * described as having been reviewed by two.
 */
export function allReviewers() {
  return SLOTS.map(s => {
    const r = role(`reviewer.${s}`);
    return { slot: s, label: r.label, axis: r.axis, blurb: r.blurb };
  });
}

export function reviewMethod() {
  return activeSlots().map(s => {
    const r = role(`reviewer.${s}`);
    return { slot: s, label: r.label, axis: r.axis, blurb: r.blurb, custom: r.custom };
  });
}
