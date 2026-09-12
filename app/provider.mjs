// provider.mjs - which route the pipeline takes to a model.
//
//   cli  -> the Claude Code binary already signed in on this machine. No credential here.
//   api  -> the Anthropic SDK with an API key or an `ant auth login` profile.
//
// The engine calls these five functions and never knows which one answered. Selection is
// deliberate rather than per-call: a run that started on one route must finish on it, or
// a retry could be judged by a different reviewer than the one that failed it.
import * as api from './claude.mjs';
import * as cli from './cli.mjs';
import { credentialsPresent } from './claude.mjs';

const STORE = { mode: process.env.RELAY_PROVIDER || 'auto' };

/**
 * 'auto' prefers the signed-in CLI, because it is the route that needs nothing from the
 * user. It falls back to the API only when the binary is absent.
 */
export function resolved() {
  if (STORE.mode === 'cli') return 'cli';
  if (STORE.mode === 'api') return 'api';
  return cli.locate() ? 'cli' : 'api';
}

export const setMode = (m) => { if (['auto', 'cli', 'api'].includes(m)) STORE.mode = m; return STORE.mode; };
export const mode = () => STORE.mode;

/**
 * Can anything run by the route that is actually selected. Availability is not selection:
 * with the mode pinned to 'api', a Claude Code binary sitting on the disk is not a
 * credential, and counting it as one leaves the user with a Run button that fails on the
 * first call.
 */
export const usable = async () => {
  if (resolved() === 'cli') return Boolean(cli.locate());
  if (credentialsPresent()) return true;
  const { authStatus } = await import('./auth.mjs');
  return (await authStatus()).signedIn;
};

export function providerStatus() {
  const c = cli.cliStatus();
  return {
    mode: STORE.mode,
    active: resolved(),
    cli: c,
    label: resolved() === 'cli' ? 'Claude Code login' : 'API key / profile',
  };
}

const pick = () => (resolved() === 'cli' ? cli : api);

export const classify     = (a) => pick().classify(a);
export const pickModel    = (a) => pick().pickModel(a);
export const doWork       = (a) => pick().doWork(a);
export const review       = (a) => pick().review(a);
export const writePayload = (a) => pick().writePayload(a);
