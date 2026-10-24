# C-349: Run review steps after green CI and gate Finished on their fixes

Issue: #884

## What to do
Extend the shipping flow in `apps/api/src/board/board-shipping.ts` (and `board-rounds.service.ts`, `board-work.ts`) so that, when the project has `reviewEnabled` and the card's PR has every check green, the card does not move to Finished and is not auto-merged yet. Instead:
1. Run the project's enabled review steps in `position` order against the PR head. Each step is a runner session started by a typed command (ADR-0010). A `peer_review` step runs with its stored instructions; a `skill` step invokes its `skillName`. The session reports findings in the shared findings shape through a structured tool call, the same way `finish_card` reports a finish, not by parsing prose.
2. Store each step's run and findings on the card's current round so the UI can show which step is running, which passed, and the findings.
3. If any step reports `blocking` findings, start a fix round in the card's session (new `CardRoundTrigger` value, e.g. `review_fix`). Its prompt is the blocking findings. After it pushes, CI and then the review steps run again. Review fix rounds are capped at 3 per PR, counted separately from the 3 `ci_fix` rounds; after that the card needs a person, exactly like the existing CI-fix exhaustion.
4. `nit` findings never trigger fixes.
5. Only when CI is green and the latest run of every enabled step has no blocking findings does the card enter Finished, followed by auto-merge as today (ADR-0035, ADR-0080).
6. If `publishReviewComments` is on, post the findings as a GitHub PR review: inline comments where `file`/`line` are set, otherwise a summary comment. Use the existing GitHub App path. A failure to publish is logged and never blocks the gate.
7. Expose the review state in the board card DTO (`board-mapper.ts`): `review: { state: 'idle' | 'running' | 'fixing' | 'passed' | 'needs_person', currentStep?, stepIndex, stepCount, fixRound, fixLimit, steps: [{ id, name, state, blockingCount, nitCount }] }`.

A project with `reviewEnabled = false`, or with no enabled steps, behaves exactly as today.

## Acceptance criteria
- [ ] Review disabled: green CI moves the card to Finished and auto-merges exactly as before; the existing `board-ships.e2e.spec.ts` passes unchanged.
- [ ] Review enabled: green CI starts the first enabled step; the card stays In progress and is not merged while steps run.
- [ ] Steps run in `position` order; disabled steps are skipped.
- [ ] Blocking findings start a `review_fix` round whose prompt contains them; after the fix push, CI and then the steps re-run.
- [ ] After 3 review fix rounds on one PR with blocking findings still present, the card needs a person and no further round starts.
- [ ] Nit-only findings let the card pass to Finished.
- [ ] With `publishReviewComments` on, findings appear as a GitHub PR review; with it off, nothing is posted to GitHub.
- [ ] A publish failure does not block Finished.
- [ ] The card DTO carries the `review` state above; the mapper spec covers it.
- [ ] Review sessions count toward budget and respect the budget hard stop like `ci_fix` rounds.
- [ ] e2e specs cover pass, fix-then-pass, fix-limit exhaustion and review-disabled.

## Out of scope
- Web UI.
- Changing the `ci_fix` limit or behaviour.
- Reviewing cards that have no PR.

## Open questions
- Do review steps re-run when a person's feedback round opens a new PR on a merged card? Default: yes, every new PR goes through the gate.
