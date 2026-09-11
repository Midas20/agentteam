// auth.mjs - who the app is signed in as.
//
// Two supported ways in:
//
//   1. Sign in with Claude — `ant auth login` opens a browser, exchanges for a token and
//      writes a profile to the Anthropic config directory. A bare `new Anthropic()` then
//      picks it up with no key anywhere in the app. This is the path most people want.
//   2. An API key pasted into Settings, stored encrypted (see settings.mjs).
//
// THE TRAP THIS FILE EXISTS TO AVOID: a profile is only consulted when no API key is set,
// and an *empty* ANTHROPIC_API_KEY still wins its precedence slot and authenticates as an
// empty key. So the key is deleted from the environment, never blanked.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';

export function configDir() {
  if (process.env.ANTHROPIC_CONFIG_DIR) return process.env.ANTHROPIC_CONFIG_DIR;
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Anthropic');
  return join(homedir(), '.config', 'anthropic');
}

/** Profiles with a stored credential, newest first. */
export function profiles() {
  const dir = join(configDir(), 'credentials');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter(f => f.endsWith('.json'))
      .map(f => ({ name: f.replace(/\.json$/, ''), at: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
  } catch { return []; }
}

// No `shell: true` anywhere in this file. `ant` is a single Go binary, so execFile
// resolves it on PATH by itself, and the shell would concatenate these args unescaped —
// with a user-supplied profile name among them.
const run = (cmd, args, timeout = 15000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true },
    (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() }));
});

// Defence in depth: even without a shell, keep the profile to what a profile can be.
const safeProfile = (p) => {
  const v = String(p || '').trim();
  if (!v) return null;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(v)) throw new Error('Profile names may use letters, digits, dot, dash and underscore only.');
  return v;
};

/** Is the `ant` CLI on PATH? Cached — it does not appear mid-session. */
let _ant;
export async function antAvailable() {
  if (_ant !== undefined) return _ant;
  const r = await run('ant', ['--version'], 8000);
  return (_ant = r.ok);
}

/**
 * Which credential the SDK will actually use, and why. Deliberately does not shell out
 * on the hot path — file presence is enough to describe the situation, and `ant auth
 * status` is offered separately for the authoritative answer.
 */
export async function authStatus() {
  const list = profiles();
  const active = process.env.ANTHROPIC_PROFILE || (list[0]?.name ?? null);
  const source =
    process.env.ANTHROPIC_API_KEY   ? 'api-key' :
    process.env.ANTHROPIC_AUTH_TOKEN ? 'auth-token' :
    list.length                      ? 'profile' : 'none';
  return {
    source,
    signedIn: source !== 'none',
    profiles: list.map(p => p.name),
    activeProfile: source === 'profile' ? active : null,
    configDir: configDir(),
    antInstalled: await antAvailable(),
  };
}

/**
 * Start `ant auth login`. It opens a browser; this resolves when the CLI exits, which is
 * after the browser round trip completes. `--profile` is passed through so a user with
 * several workspaces can keep them apart.
 */
export async function signIn({ profile } = {}) {
  if (!await antAvailable()) {
    throw new Error('The `ant` CLI is not installed. Install it first — see Settings for the link.');
  }
  // An API key in the environment silently outranks whatever we are about to mint.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const args = ['auth', 'login', ...(safeProfile(profile) ? ['--profile', safeProfile(profile)] : [])];
  return new Promise((resolve, reject) => {
    execFile('ant', args, { env, timeout: 300000, windowsHide: true },
      (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`.trim();
        if (err) return reject(new Error(out || err.message));
        resolve(out);
      });
  });
}

export async function signOut({ all } = {}) {
  if (!await antAvailable()) throw new Error('The `ant` CLI is not installed.');
  const r = await run('ant', ['auth', 'logout', ...(all ? ['--all'] : [])], 20000);
  if (!r.ok) throw new Error(r.out || 'logout failed');
  return r.out;
}

/** The CLI's own answer to "which credential wins". Slower, but authoritative. */
export async function antStatus() {
  if (!await antAvailable()) return null;
  return (await run('ant', ['auth', 'status'], 20000)).out;
}

export const INSTALL_HINT = {
  win32: 'Download ant.exe from github.com/anthropics/anthropic-cli/releases and put it on your PATH.',
  darwin: 'brew install anthropics/tap/ant',
  linux: 'Download the release for your architecture from github.com/anthropics/anthropic-cli/releases',
}[process.platform] || 'See github.com/anthropics/anthropic-cli/releases';

// Where to get the CLI. Rendered as a real link in Settings, opened in the user's own
// browser rather than inside the app window.
export const RELEASES = 'https://github.com/anthropics/anthropic-cli/releases';
