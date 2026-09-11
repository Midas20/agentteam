// settings.mjs - the API key, stored per machine.
//
// A packaged app cannot ask the user to set an environment variable, so the key is
// entered in the app and kept in the data directory. When Electron's safeStorage is
// available the main process injects it here and the key is encrypted with the OS
// keychain / DPAPI; without it the key is written in plain text and `encrypted` says so,
// which the UI surfaces rather than hiding.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.RELAY_DATA_DIR || join(HERE, '..');
const FILE = join(DATA, 'settings.json');

// Set by desktop/main.cjs before the server is imported. Shape: {encrypt, decrypt}.
const vault = () => globalThis.__relaySafeStorage || null;

const read = () => {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; }
};
const write = (obj) => {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(FILE, JSON.stringify(obj, null, 2), 'utf8');
};

/** The stored key, decrypted if it was encrypted. Null when nothing is stored. */
export function loadKey() {
  const s = read();
  if (!s.apiKey) return null;
  if (s.encrypted) {
    const v = vault();
    if (!v) return null;              // stored on a run that had the vault; this one does not
    try { return v.decrypt(Buffer.from(s.apiKey, 'base64')); } catch { return null; }
  }
  return s.apiKey;
}

export function saveKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) { write({ ...read(), apiKey: null, encrypted: false }); return { stored: false, encrypted: false }; }
  const v = vault();
  if (v) {
    write({ ...read(), apiKey: v.encrypt(trimmed).toString('base64'), encrypted: true });
    return { stored: true, encrypted: true };
  }
  write({ ...read(), apiKey: trimmed, encrypted: false });
  return { stored: true, encrypted: false };
}

export const keyStatus = () => {
  const s = read();
  return {
    stored: Boolean(s.apiKey),
    encrypted: Boolean(s.encrypted),
    vaultAvailable: Boolean(vault()),
    file: FILE,
  };
};

/**
 * Put the stored key into the environment so the Anthropic client picks it up.
 * An ANTHROPIC_API_KEY already in the environment wins — it is the more deliberate
 * choice, and silently overriding it would be surprising.
 */
export function applyStoredKey() {
  if (process.env.ANTHROPIC_API_KEY) return 'environment';
  const k = loadKey();
  if (!k) return 'none';
  process.env.ANTHROPIC_API_KEY = k;
  return 'settings';
}
