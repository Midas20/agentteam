# relay — cross-session task pipeline

    user → ORCHESTRATOR → MODEL ANALYST → WORKER → REVIEWER A + B → RESULT → user
                  ↑                                       │
                  └──────────── redo, while under cap ─────┘

Nine Claude Code sessions on this machine, wired with `SendMessage`. Routing, the retry
cap, the model pin and the two-review gate live in `bin/relay.mjs` and `tasks/*.json`,
so no session has to remember them correctly.

- **DESIGN.html** — why it is shaped this way, and what breaks if you change it.
- **BUILD.html**  — every file, its contents, and the bootstrap order.

## Quick reference

    node bin/relay.mjs list                 # everything in flight
    node bin/relay.mjs show <id>            # one task, full history
    node bin/relay.mjs routes --<role> <s>  # re-pin after a restart

Session names do not survive a restart; `routes.json` needs re-pinning each time. The
`tasks/` ledger does survive, so an in-flight task resumes by re-pinning and re-sending
the envelope for its current state.
