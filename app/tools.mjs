// tools.mjs - local file tools, for the 'project' kind only.
//
// Every path is resolved and then checked to be inside the task's own workspace
// directory. A path that escapes is refused rather than clamped, so the model is told
// what happened instead of silently writing somewhere else.
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';   // see the note in claude.mjs — the v3 API breaks the SDK helpers
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';

// Shell execution is off unless explicitly enabled, because it runs whatever the model
// decides to run. Jailed to the workspace either way; the jail is not a sandbox.
const EXEC_ENABLED = process.env.RELAY_ALLOW_EXEC === '1';
const EXEC_TIMEOUT = Number(process.env.RELAY_EXEC_TIMEOUT_MS || 120000);
const MAX_READ = 400_000;

function inside(root, p) {
  const base = resolve(root);
  const full = resolve(base, p);
  // Prefix check on the resolved absolute paths. Catches "..", absolute paths, and
  // symlink-free traversal alike; a sibling directory whose name merely starts with
  // the root's name (workspace-old/) is correctly excluded by requiring the separator.
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

function tree(dir, root, depth = 0, acc = []) {
  if (depth > 6 || acc.length > 800) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') { acc.push(`${relative(root, join(dir, e.name))}/  (skipped)`); continue; }
    const full = join(dir, e.name);
    if (e.isDirectory()) { acc.push(`${relative(root, full)}/`); tree(full, root, depth + 1, acc); }
    else acc.push(`${relative(root, full)}  ${statSync(full).size}b`);
  }
  return acc;
}

export function workspaceTools(root, onEvent) {
  mkdirSync(root, { recursive: true });
  const note = (text) => onEvent?.({ level: 'file', stage: 'work', text });
  const guard = (p) => {
    const full = inside(root, p);
    if (!full) throw new Error(`refused: "${p}" resolves outside the workspace. Use a path relative to the workspace root.`);
    return full;
  };

  const tools = [
    betaZodTool({
      name: 'write_file',
      description: 'Create or overwrite a file in the workspace. Parent directories are created automatically.',
      inputSchema: z.object({
        path: z.string().describe('path relative to the workspace root, e.g. "src/index.js"'),
        content: z.string(),
      }),
      run: async ({ path, content }) => {
        const full = guard(path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, 'utf8');
        note(`write ${path} (${content.length}b)`);
        return `Wrote ${path} (${content.length} bytes).`;
      },
    }),

    betaZodTool({
      name: 'read_file',
      description: 'Read a file from the workspace.',
      inputSchema: z.object({ path: z.string() }),
      run: async ({ path }) => {
        const full = guard(path);
        if (!existsSync(full)) return `No such file: ${path}`;
        const body = readFileSync(full, 'utf8');
        note(`read ${path}`);
        return body.length > MAX_READ ? body.slice(0, MAX_READ) + `\n\n[truncated at ${MAX_READ} bytes]` : body;
      },
    }),

    betaZodTool({
      name: 'list_workspace',
      description: 'List everything currently in the workspace, as a tree.',
      inputSchema: z.object({}),
      run: async () => {
        const lines = tree(root, root);
        note(`list (${lines.length} entries)`);
        return lines.length ? lines.join('\n') : '(the workspace is empty)';
      },
    }),
  ];

  tools.push(betaZodTool({
    name: 'run_command',
    description: EXEC_ENABLED
      ? 'Run a shell command with the workspace as the working directory. Use it to install, build, test and run what you have written.'
      : 'Shell execution is DISABLED in this deployment. Calling this returns an explanation, not a result. Build the project with the file tools and report the command you would have run.',
    inputSchema: z.object({
      command: z.string(),
      why: z.string().describe('what you expect this to prove'),
    }),
    run: async ({ command, why }) => {
      if (!EXEC_ENABLED) {
        note(`run_command refused (disabled): ${command}`);
        return `Shell execution is disabled here (set RELAY_ALLOW_EXEC=1 to enable it). ` +
               `Record in your notes that you would have run: ${command}  — to check: ${why}`;
      }
      note(`run: ${command}`);
      return await new Promise((res) => {
        execFile(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', command],
          { cwd: root, timeout: EXEC_TIMEOUT, maxBuffer: 4e6, windowsHide: true },
          (err, stdout, stderr) => {
            const out = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join('\n\n');
            res(err
              ? `Command failed (exit ${err.code ?? 'unknown'}${err.killed ? ', timed out' : ''}).\n\n${out || err.message}`
              : out || '(no output; exit 0)');
          });
      });
    },
  }));

  return tools;
}

export const execEnabled = () => EXEC_ENABLED;
