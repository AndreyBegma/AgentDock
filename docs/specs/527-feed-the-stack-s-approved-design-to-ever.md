# C-222: Feed the stack's approved design to every card's design turn and run

Issue: #527

## What to do
ADR-0044 §5 says every card of a stack builds on the stack's approved design. The wiring exists: `loadStackReference` (`apps/api/src/design/design-store.ts`) feeds `CardDesignTurnService` (`apps/api/src/planner/card-design-turn.service.ts`), and round 1 commits the stack frames in `apps/api/src/board/board-rounds.service.ts`. But a card's design Generate (`DesignService.generateOf` in `apps/api/src/design/design.service.ts`) is not gated. `BoardStacks.assertRunnable` only gates Run. So a card's design can be drawn while the stack design is still needed and not approved, and that turn gets no stack reference.

Close the gap and prove the delivery for every card of a stack, whatever its stage:
1. Refuse Generate/Revise of a card's own design while its stack's design is needed and not approved: `409` with a stack-design reason, reusing `STACK_GATE_REASON` / `BOARD_ERROR.stackDesignNotApproved` where it fits. Disable the card's Generate design button in the web UI with that reason.
2. Cover with tests that every card of a multi-stage stack gets the approved stack design both in its design-turn prompt and in its round-1 worker prompt (`## Stack`) and committed frames, not only the first card or first stage.

## Acceptance criteria
- [ ] Reproduction: in a stack with a needed, unapproved design, Generate on a card's own design no longer starts a turn. It returns 409 naming the stack design, and the card's Generate button is disabled with that reason.
- [ ] Once the stack design is approved, the card's Generate works, and the card design prompt contains the stack's approved design reference.
- [ ] A test with a stack of 2+ stages and 3+ cards asserts each card's design-turn prompt includes the stack reference.
- [ ] A test asserts each card's round 1 commits the stack frames under `<specDir>/stacks/S-<n>-<slug>/design/<variant>/…` and lists them under `## Stack` in the worker prompt.
- [ ] A stack whose design is switched off (`needed: false`) gates neither card design Generate nor Run.
- [ ] Cards that are not in a stack behave exactly as before.

## Out of scope
- Merging the stack design into card designs (ADR-0044 §5 keeps them separate).
- The UI switch for turning a stack's design on and off.
- Intake prompt changes.

## Open questions
- Should approving the stack design automatically trigger Generate for cards that need their own design? Default: no; the person starts each card's design, now with the reference available.
- Should card designs already drawn before the stack design was approved be flagged as stale? Default: no, not in this card.
