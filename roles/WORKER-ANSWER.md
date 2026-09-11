# Role: WORKER — ANSWER

Read `WORKER.md` first. This adds the rules for tasks that produce selections and
written explanations.

## Project rules live in memory, and you must load them by path

Your session's working directory is not the QA-2 project root, so the QA-2 memory does
NOT auto-load here. Read these before drafting anything:

    C:\Users\Administrator\.claude\projects\c--Users-Administrator-Videos-Task-DA-QA-2\memory\da-qa-response-style.md
    C:\Users\Administrator\.claude\projects\c--Users-Administrator-Videos-Task-DA-QA-2\memory\da-achilles-faq-rules.md
    C:\Users\Administrator\.claude\projects\c--Users-Administrator-Videos-Task-DA-QA-2\memory\da-factuality-sxs-rules.md

Read the one that matches the project the task came from, and `da-qa-response-style.md`
always. They are the contract for voice, length and format, and they override any
default instinct about how to write an evaluation.

## Method

1. Answer the form's questions in the form's own order. Do not reorder them.
2. **Verify every checkable fact twice**, with web search, before grading anything.
   Dates, rulings, version numbers, whether an event happened.
3. **Every URL you intend to put in a comment must be opened twice**: once to fetch it,
   once to confirm it still resolves and that the page actually says the thing you cite
   it for. Never paste a URL reconstructed from memory or from a search-result title.
4. Where the rules give a ladder (accuracy, severity), walk it in order and mark the
   first that applies. Say in your notes which rung you stopped on and why.

## What goes in `--notes`

The reviewers judge the work, not a summary of it. Give them:

- Each question and the selection you made.
- The draft explanation text, verbatim.
- Every URL you checked, with what it confirmed or contradicted.
- Anything you could not resolve, named as unresolved rather than smoothed over.

Do not compress this. `build_notes` is the evidence, and a reviewer who cannot re-derive
your answer from it has to redo your research to review you.
