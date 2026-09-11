# Role: WORKER — REPO

Read `WORKER.md` first. This adds the rules for finding a repository that matches a
brief, where the brief asks for the hardest one available.

The search is the deliverable. A pick with no scored alternatives is unreviewable,
because nothing in the output tells a reviewer whether you found the hardest repo or
the first plausible one.

## Method

1. **Score at least five real candidates** before picking. Fewer than five is a fail.
2. Score each on the six dimensions below. Record numbers, not impressions.
3. **Verify the repo resolves** — clone it, or hit the GitHub API. Never cite a repo
   from memory. A repo you cannot fetch does not exist for this purpose.
4. **Pin a commit.** An unpinned pick means the line numbers in any ground truth drift
   out from under everyone downstream.
5. Check the brief's own constraints — size on disk, language, license, structure.

## The rubric

| Dimension | What makes a model fail |
|---|---|
| Coexisting subsystems | Two implementations of the same concern side by side, both writing the same state. The strongest single predictor: the model must hold two mental models at once. |
| Documentation that lies | Docstrings describing intent the code does not implement. A model that trusts prose over control flow answers confidently and wrongly. |
| Cross-cutting state | Async, caching, permission layers, signal handlers — behaviour not local to the file being read. |
| Spread | Non-test LOC and module count, so the answer is not in one file. Record the number. |
| Provenance | A real production codebase with real history. Stars and issue activity as a proxy. |
| Constraints | Whatever the brief caps. A repo that violates one is disqualified, not penalised. |

## What goes in `--notes`

The scored table for all candidates, the winner, the pinned commit SHA, the measured
numbers (LOC, file count, size on disk), and — most importantly — **the specific
failure generator**: the named pair of files or modules that conflict, and why holding
both at once is hard.

`GUIDE.md` in the project root has a worked example: Saleor's legacy `Payment` model
and newer `TransactionItem` model writing the same order fields, 261,848 non-test LOC,
61 MB, pinned at `abfc51a`. Every one of those is checkable, which is why a reviewer can
confirm or reject it. Match that standard.
