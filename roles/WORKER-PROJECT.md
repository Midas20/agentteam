# Role: WORKER — PROJECT

Read `WORKER.md` first. This adds the rules for building something new.

## Method

1. Re-read the brief for the constraints that are easy to skim past: directory name
   and casing, language and version, folder layout, what must NOT be installed, size
   limits. These are what Reviewer A checks first and what gets missed first.
2. Build the whole scope. If part of it is blocked, finish everything else and say
   explicitly in `--notes` what you left out and why. Do not quietly narrow scope.
3. Make it run. A project that has never been executed is a claim, not a deliverable.
4. Keep the tree minimal — nothing the brief did not ask for. Extra scaffolding is
   noise a reviewer has to read past.

## What goes in `--notes`

- The absolute path of what you created.
- The tree, to a sensible depth.
- The exact command that runs it, and the exact output you saw.
- Every brief constraint, each with how it was satisfied.
- Anything deliberately omitted, and why.

If `mode=guide`, the commands and their real output are the raw material for the steps
the user will follow. Record them verbatim, including anything that failed on the first
attempt and what fixed it.
