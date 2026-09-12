// usage.mjs - what has been spent, as numbers.
//
// Every model call, on either route, adds to a running total kept in the data directory
// so it survives a restart. The header shows it and says nothing about it.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

// Attributing a model call to the ticket that caused it, without threading a task id
// through five stages and two provider modules. The engine runs each task inside this
// store; every call underneath it — including concurrent ones, which is the whole point —
// sees its own id.
export const taskContext = new AsyncLocalStorage();

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.RELAY_DATA_DIR || join(HERE, '..');
const FILE = join(DATA, 'usage.json');

const ZERO = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, since: null };

const read = () => {
  try { return { ...ZERO, ...JSON.parse(readFileSync(FILE, 'utf8')) }; } catch { return { ...ZERO }; }
};

// Per-ticket totals live only in memory: they describe one run, and a restart ends it.
const perTask = new Map();

let state = read();
if (!state.since) state.since = new Date().toISOString();

// Writes are debounced: several stages can finish within the same second, and the total
// is a convenience, not a ledger — losing the last write to a crash costs nothing.
let pending = null;
const flush = () => {
  pending = null;
  try { mkdirSync(DATA, { recursive: true }); writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8'); } catch { /* not fatal */ }
};

const listeners = new Set();
export const onUsage = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** Add one call's usage. Accepts the shape both the API and the CLI report. */
export function record(usage = {}, costUsd = 0, modelUsage = null) {
  state.calls += 1;
  state.input     += Number(usage.input_tokens || 0);
  state.output    += Number(usage.output_tokens || 0);
  state.cacheRead += Number(usage.cache_read_input_tokens || 0);
  state.cacheWrite+= Number(usage.cache_creation_input_tokens || 0);

  // The CLI reports a dollar figure directly. The API path does not, so when several
  // models were used the per-model breakdown is summed instead.
  let cost = Number(costUsd || 0);
  if (!cost && modelUsage) for (const m of Object.values(modelUsage)) cost += Number(m.costUSD || 0);
  state.costUsd += cost;

  // Per ticket, so the detail panel can say what this one cost rather than only what
  // everything has cost since the counter was last reset.
  const id = taskContext.getStore();
  if (id) {
    const p = perTask.get(id) || { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
    p.calls += 1;
    p.input      += Number(usage.input_tokens || 0);
    p.output     += Number(usage.output_tokens || 0);
    p.cacheRead  += Number(usage.cache_read_input_tokens || 0);
    p.cacheWrite += Number(usage.cache_creation_input_tokens || 0);
    p.costUsd    += cost;
    perTask.set(id, p);
  }

  if (!pending) pending = setTimeout(flush, 1500);
  for (const fn of listeners) { try { fn(snapshot()); } catch { /* a listener must not break accounting */ } }
}

export const snapshot = () => ({ ...state });
export const forTask = (id) => perTask.get(id) || null;
export const allTasks = () => Object.fromEntries(perTask);

export function reset() {
  state = { ...ZERO, since: new Date().toISOString() };
  flush();
  for (const fn of listeners) { try { fn(snapshot()); } catch {} }
  return snapshot();
}
