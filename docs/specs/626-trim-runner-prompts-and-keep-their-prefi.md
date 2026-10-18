# C-254: Trim runner prompts and keep their prefixes cache-stable

Issue: #626

## What to do
Every runner launch sends a large fixed prompt before any work: the card worker prompt (`packages/shared/src/board/worker-prompt.ts`), planner and intake instructions, design, skill and orchestrator prompts, plus system-prompt appends.

- Audit each prompt for duplicated rules, rules the model already follows, and long examples.
- Order every prompt so the static part comes first and per-run data (card body, ids, dates, attachments) comes last, so Anthropic prompt caching reuses the prefix across runs.
- Add a token-budget test per prompt that fails when a prompt grows past its budget.

## Acceptance criteria
- [ ] A spec test computes the size of each launch prompt (bytes ÷ 4 estimate is fine) and asserts a budget per prompt kind.
- [ ] The card worker prompt and the planner/intake instructions are each at least 25% smaller than on `develop` at the start of this card, with every behavioural rule kept: existing prompt tests still pass.
- [ ] In every prompt builder, per-run values appear only after the static instructions; a test asserts the static prefix is byte-identical across two different cards.
- [ ] The PR description lists each prompt's size before and after.

## Out of scope
- Changing what any prompt asks the agent to do.
- The intake output contract's JSON shape.

## Open questions
None.
