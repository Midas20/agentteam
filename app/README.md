# relay/app — the self-driving relay

    setx ANTHROPIC_API_KEY sk-ant-...     (once; then open a new terminal)
    node relay/app/server.mjs             →  http://localhost:7392

Paste a requirement. The app classifies it, does the work, has two to four independent
reviewers check it, retries on a failure, and gives you the result to copy. No sessions
to open, no envelopes to paste.

## What runs, in order

| Step | What happens | Model |
|---|---|---|
| 1 · Classify | Decides `kind` (answer / repo / project / prompt) and `output_mode` (paste / guide) | opus, medium effort |
| 2 · Model | Records the models: opus for work and review unless you pin something else | — |
| 3 · Work | Does the job with web search + fetch, and file tools for `project` | opus, xhigh effort |
| 4 · Review ×N | Two to four reviewers run **concurrently** from the worker's notes alone | opus, xhigh effort |
| 5 · Verdict | All pass → on. Any one fails → retry with the defects, up to the cap | — |
| 6 · Result | Writes the `paste` text or the `guide` steps, or the reason it failed | reviewer model, high effort |

The reviewers split by **axis**, not by duplication. Reviewer A checks compliance —
was everything asked for delivered, in the shape it was asked for. Reviewer B checks
correctness — is the answer that's present actually right. Two more can be switched on in
Settings ▸ Agent structure: C checks evidence (could a stranger re-derive it from the
notes), D checks risk (attacks whatever would cost most if wrong). Every agent's
instructions can be rewritten there too. They fail on different things, which is what
makes each extra review worth its cost; the ledger never accepts fewer than two.

Their independence is structural here, not a rule someone follows: both are called with
the worker's notes and nothing else, in parallel, so neither can see the other's verdict.

## It drives the same ledger

Every state change goes through `bin/relay.mjs` as a child process. The app never edits a
task file. That means the attempt cap, the state machine, the review gate and the
reviewer-strength guard all still apply, and `relay list` / `relay show` still work on
tasks the app created. When the ledger refuses, the engine obeys — if you pin a
reviewer weaker than the worker, the ledger rejects it and the engine raises the
*reviewers* rather than lowering the bar, and says so in the log.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required. An `ant auth login` profile also works. |
| `RELAY_APP_PORT` | `7392` | Binds `127.0.0.1` only. |
| `RELAY_ALLOW_EXEC` | unset | `1` lets the `project` worker run shell commands. See below. |
| `RELAY_EXEC_TIMEOUT_MS` | `120000` | Per-command timeout when exec is on. |

### Shell execution is off by default

The `project` worker always has `write_file` / `read_file` / `list_workspace`, jailed to
`relay/app/workspace/<task-id>/`. Path escapes are refused, not clamped.

`run_command` is different: with `RELAY_ALLOW_EXEC=1` the model runs shell commands you
did not write. The working directory is the task workspace, but **a working directory is
not a sandbox** — a command can still reach the rest of the machine. Leave it off unless
you want the worker to install and run what it builds, and turn it off again afterwards.
With it off, the tool still exists and tells the model to record the command it would
have run, so the notes stay complete.

## Cost

Every run is real API spend, and a task that fails review costs roughly double — the
retry re-runs the worker and every reviewer. The attempt cap is your ceiling: at `--cap 3`
with two reviewers the worst case is three workers plus six reviews. Lower the cap in the form before
lowering your standards; a task that fails twice is usually mis-specified rather than
badly built.

## Files

| File | What it is |
|---|---|
| `prompts.mjs` | What each role is told. Edit freely — no code depends on the wording. |
| `claude.mjs` | Every model call. `beta.messages.parse` for the two decisions, `beta.messages.toolRunner` for the three jobs. |
| `tools.mjs` | Workspace file tools and the gated `run_command`. |
| `engine.mjs` | Stage order and the retry loop. Drives the ledger, never edits it. |
| `server.mjs` | HTTP, SSE, background runs. |
| `public/` | The UI. |
| `smoke.mjs` | Everything checkable without spending a token. Run it after any dependency change. |

    node relay/app/smoke.mjs

It builds every schema and tool the pipeline uses and exercises the ledger's guards. That
matters because the SDK's zod helpers fail at **call** time, not import time — `node --check`
sees nothing wrong. **`zod/v4` is not optional**: zod 3.25 ships both APIs, the SDK helpers
are built against v4, and a v3-classic schema dies inside them with a bare
"Cannot read properties of undefined". Import `z` from `'zod/v4'`, never `'zod'`.

Each agentic role ends by calling one `submit_*` tool — `submit_notes`, `submit_verdict`,
`submit_payload`. That is how a structured result comes out of an agentic loop without a
second round trip. A reviewer that never submits is treated as a **fail**, not a pass.

## Known limits

- **Run commentary is in memory.** Task state is on disk and survives a restart; the
  activity log for a run does not. A run whose server restarted shows its ledger state
  and an empty log.
- **A restart abandons an in-flight run.** The task stays wherever the ledger last put it.
  Open it and press **Run again**: the engine re-enters by *state*, so a task stopped at
  `assigned` redoes the work, one stopped at `built` goes straight to review, and one
  stopped at `reviewing` runs only the review slot that never landed. It does not re-run
  or re-charge for a stage the ledger already recorded.
- **`pause_turn` is handled, `max_iterations` is a real ceiling.** A worker is capped at
  60 iterations and a reviewer at 40. A run that hits the ceiling without submitting is
  reported rather than silently truncated.
- **No auth on the server.** Loopback binding is the whole security model. Do not expose
  it — `run_command`, if enabled, runs as you.
- **Uploads are base64 in a JSON body**, capped at 12 MB.
