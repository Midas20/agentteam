// standing.mjs - the instructions that apply to every ticket, not just one.
//
// The same few sentences were being pasted into the top of every requirement: house style,
// which spellings to use, how to cite, what never to invent. That is not part of any one
// ticket, so it does not belong in any one ticket's text.
//
// This is the app's equivalent of a CLAUDE.md: one file, edited once, read by every stage
// of every run. It is plain text on disk — `instructions.md` in the data directory — so it
// can be edited in the app, or in an editor, or kept in version control, and the app picks
// up whatever is there at the moment a stage runs.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = process.env.RELAY_DATA_DIR || HERE;
export const FILE = join(DIR, 'instructions.md');

// Long enough for a real house style, short enough that it cannot quietly become the bulk
// of every prompt. These travel with every stage of every run, so their cost is paid many
// times over: about six calls per ticket, and again on each retry.
export const LIMIT = 20000;

/** Whatever is on disk right now. Never throws: a missing or unreadable file means none. */
export function text() {
  try { return readFileSync(FILE, 'utf8'); } catch { return ''; }
}

/** Save, or clear when given nothing. Returns the stored text. */
export function save(s) {
  const v = String(s ?? '').trim();
  if (v.length > LIMIT) throw new Error(`standing instructions are too long (${LIMIT.toLocaleString()} characters max)`);
  if (!v) { try { rmSync(FILE, { force: true }); } catch { /* nothing to remove */ } return ''; }
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, v, 'utf8');
  return v;
}

/** What the UI shows: whether there are any, how long, and where they live. */
export function status() {
  const t = text();
  return { present: Boolean(t.trim()), chars: t.length, path: FILE, limit: LIMIT };
}

/**
 * Put them in front of a requirement.
 *
 * In front, not behind: a stage reads top-down, and these are the rules the requirement is
 * to be carried out under. They are also labelled as standing rather than specific, so a
 * worker cannot mistake a house style note for something this particular ticket asked for
 * — and the requirement is told, in the same breath, that it wins any direct conflict.
 * The alternative is a worker that refuses a ticket for breaking a rule the ticket
 * deliberately set aside.
 */
export function withStanding(spec) {
  const t = text().trim();
  if (!t) return spec;
  return `--- STANDING INSTRUCTIONS ---\n` +
         `These apply to every ticket, not only this one. Follow them unless the requirement\n` +
         `below explicitly says otherwise; where the two genuinely conflict, the requirement\n` +
         `wins and you say so in your notes.\n\n${t}\n\n` +
         `--- REQUIREMENT ---\n${spec}`;
}

export const has = () => existsSync(FILE);
