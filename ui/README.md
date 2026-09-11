# relay/ui — the console

    node relay/ui/server.mjs        →  http://localhost:7391

No dependencies, no build step, no install. Node 14.14+ and a browser.
Set `RELAY_UI_PORT` to move it off 7391. It binds `127.0.0.1` only.

## What it is

A local console over the task ledger in `relay/tasks/`. It gives you the two things
a terminal is bad at: somewhere to paste a ticket requirement, and somewhere to read
and copy the finished result.

**It does not run the sessions.** It cannot open a Claude Code session or send a
`SendMessage` — those are Claude Code capabilities, not browser ones. What it does is
tell you which session is holding each task and hand you the exact envelope to paste
into it. The nine sessions still do the work.

## The loop

1. **Paste the requirement** into the left rail. Screenshots work — paste or drop an
   image and it travels with the task, so every session opens the original rather than
   somebody's transcription of it. Pick a work type and a result shape, then create.
2. **The detail panel names the next session** and shows the envelope for it, with a
   copy button. Paste it into that session. When a task is `built`, it shows both
   reviewer envelopes at once, because both slots must be filled for a verdict to exist.
3. **Watch it move.** The stage strip and the review slots update over SSE as the
   sessions write to the ledger. Nothing to refresh.
4. **Copy the result.** When a task reaches `delivered`, the result section shows the
   payload with a Copy button. For `mode=paste` that text goes straight into the ticket
   with no editing. For `mode=guide` it is the steps to follow.

A failed task shows the defects instead, and an **Assign retry** button while attempts
remain. At the cap the button becomes **Escalate**.

## Why it shells out to the CLI

Every mutation runs `node bin/relay.mjs …` as a child process. The UI never writes a
task file itself. That means the attempt cap, the model guard, the output-mode guard and
the state machine behave identically whether a command came from a terminal or a button,
and there is no second implementation to drift. A CLI refusal surfaces in the browser as
the error it is — press Assign on an unmodelled task and you get
*"task … has no model pinned"*, the same string the terminal prints.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /api/state` | every task plus `routes.json` |
| `GET /api/events` | SSE; pushes on any ledger change (`fs.watch`, debounced) |
| `GET /api/envelope?id=&to=` | the wire text for one hop |
| `POST /api/tasks` | create + classify. Body: `{spec, title, kind, mode, why, cap, image}` |
| `POST /api/run` | `{args:[…]}` — run any relay command; the CLI validates |

`POST /api/run` is deliberately unrestricted: it is the escape hatch for anything the UI
has no button for. It is also why this server binds to loopback only — it runs commands
as you, so do not expose it to a network.

## Known limits

- **Uploads are base64 in a JSON body**, capped at 12 MB, to keep the zero-dependency
  property. They land in `relay/ui/.uploads/` and are copied into the task by the CLI.
  The uploads directory is scratch — safe to delete when no task references it.
- **`fs.watch` can miss an event** on some filesystems. The SSE stream is the fast path;
  reload the page if a task looks stale.
- **No auth.** Loopback binding is the whole security model.
- The console shows what each session is *owed*. It cannot tell you whether a session is
  alive — that is what `ListAgents` and `notify_when_idle` are for.
