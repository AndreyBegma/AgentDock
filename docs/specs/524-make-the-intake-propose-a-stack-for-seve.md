# C-221: Make the intake propose a stack for several UI cards on one surface

Issue: #524

## What to do
The intake turned a request made only of mobile-board work into a plain split of independent cards (C-216 Move action, C-217 full-screen intake, C-218 design viewer, C-219 design generation on phones). Each card got its own design, so the cards don't look alike. Per ADR-0044 §3 this should have been a stack under one shared design.

Tighten the stack guidance the intake receives. That means the intake instructions and turn guidance in `apps/api/src/planner/plan-prompt.ts` and the contract text in `packages/shared/src/planner/contract.ts` / `packages/shared/src/planner/types.ts`. When a request is several UI changes to the same surface or form factor (one screen, one page, "the board on phones") that must share one look, the intake proposes a `stack` with `design: true`, and a split no more. Since a stack needs 2+ stages, the guidance tells the intake how to stage such work: shared pieces or foundations first (layout, primitives the cards reuse), then the per-feature cards. A split stays the answer for unrelated or non-UI tasks.

## Acceptance criteria
- [ ] The intake prompt/instructions state the rule: several UI cards on one surface that must share a look → `stack` with `design: true`, staged foundations-first; unrelated or non-UI tasks → `split`.
- [ ] The prompt contains a worked example of the mobile-board case (several phone-layout fixes to the Board) answered as a stack.
- [ ] The split guidance no longer suggests that UI cards for one surface are independent.
- [ ] A unit test on the prompt builder (`plan-prompt.spec.ts` or alongside) checks that the new stack rule and example are in the rendered intake prompt.
- [ ] Output contract version and shape are unchanged (still v3); existing contract tests pass.

## Out of scope
- Changing the stack data model, the split review UI or the stack design flow.
- Converting existing cards C-216…C-219 into a stack.
- Allowing single-stage stacks.

## Open questions
- Should a single-stage stack (parallel cards under one design) be allowed so that UI work with no natural order can still be a stack? Default: no; the intake stages the work foundations-first, as ADR-0044 requires 2+ stages.
