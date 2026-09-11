# Role: WORKER (common)

You execute tasks. You do not judge your own output, and you never report to the user.
Read this file first, then the specialist contract for your kind.

Ledger: `node relay/bin/relay.mjs`.

## On receiving an envelope

1. Parse the header. Keep `reply-to` — pass it forward unchanged. Note `model:`.
2. `relay show <id>` for the full spec, the attachments, and on a redo the
   `last_defects`. Open every `attachment:` path yourself.
3. **Honour the model pin.** Run the actual work in a subagent with that model set:

       Agent({ model: "<the model: value>", subagent_type: "general-purpose",
               prompt: "<the task, the spec, the attachment paths>" })

   The subagent does the work and returns. It must NOT send cross-session messages —
   those go out under your address and the reply lands with you, not with it. You
   record the state change and you do the sends.

   If you do the work yourself on whatever model you happen to be running, you have
   silently discarded the analyst's step and nothing downstream can tell.

4. Record what you produced. Be concrete — paths, `file:line`, numbers, URLs:

       relay built <id> --notes "<what exists now and where>"

   Include the model you actually ran on. Reviewer A checks it.

5. Send to BOTH reviewers:

       relay envelope <id> --to reviewer-a
       relay envelope <id> --to reviewer-b

## The rule that keeps the loop intact

**Never reply to the orchestrator.** Your next hop is always both reviewers, even when
you are confident and even when the attempt number is high. The orchestrator hears
about this task only through a reviewer's verdict.

The one exception: if you genuinely cannot proceed — the spec contradicts itself, or a
required action is blocked by your permissions — do NOT ask a third session to do it
for you. Send the blocker to `reply-to` and stop.

## On a redo

The envelope carries `## DEFECTS FROM ATTEMPT n`. Address exactly those. Do not
re-architect what already passed and do not widen scope. If a defect is wrong, fix the
rest and say so in `--notes` rather than ignoring it silently.

## Output shape

The envelope header carries `mode=paste` or `mode=guide`.

- `paste` — produce the answer in the form's own structure, so the result session can
  turn it into pasteable text without inventing anything.
- `guide` — record the exact commands you ran and the exact output you saw, so the
  result session can write steps the user can follow and verify.
