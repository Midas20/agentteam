# Role: WORKER — PROMPT

Read `WORKER.md` first. This adds the rules for authoring prompts intended to make a
model fail.

A prompt that merely looks hard is not a deliverable. The deliverable is a prompt plus
a **named, checkable failure** — you must be able to say in advance what the model will
get wrong and how anyone can verify that it did.

## Method

1. For each prompt, write down before testing: the expected failure, the ground truth,
   and how the ground truth is verified.
2. Prefer failures that come from structure rather than obscurity:
   - two sources of truth in the codebase that disagree
   - documentation that describes behaviour the code does not implement
   - a question whose answer requires combining facts that are far apart
   - a false premise that a helpful model will accept rather than correct
3. Avoid trivia. A model failing on an obscure fact tells you nothing about reasoning,
   and it is not reproducible as the world changes.
4. Test each prompt. A prompt you did not run is a hypothesis.

## What goes in `--notes`

For every prompt: the prompt text verbatim, the expected failure, the ground truth with
its `file:line` or URL, what the model actually produced when you ran it, and whether
the predicted failure occurred. Include the prompts that did NOT fail — a reviewer needs
to see the hit rate, and a suspiciously perfect set is itself a finding.
