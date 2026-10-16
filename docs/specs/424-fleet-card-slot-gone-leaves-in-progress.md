# A fleet card whose slot ended without a PR stays in In progress forever

Issue: #424 · Board card: C-72

## What to do

C-8 is the fleet card of issue #324, slot `i324-api-resume`. It has sat in **In progress** since 2026-10-15 although #324 was merged and closed that day. A person cannot move it either: `POST /board/cards/8/move` answers 409 `move_refused` / `fleet_slot` ("A fleet card follows its slot: the one move it takes is Finished → Completed").

Its view: `fleet: { issue: 324, slot: "i324-api-resume", stage: null, slotGone: true }`, no pull request.

Why: `i324-api-resume` was a **resumed** slot (orchestrator Phase 7c under a new slot name); the pull request belonged to the original slot `i324-api`. In `apps/api/src/fleet/board-fleet.service.ts`, `columnOf(slot)` returns `'finished'` only when the slot has a PR, and `null` ("keep the card where it is") when the slot ended — so a slot that ends without its own PR leaves its card in In progress for good, and the move guard then refuses the person too.

Fix both halves:
- **Projection:** a fleet card whose slot ended (`slotGone`) must not stay in In progress. If its issue is closed or a sibling slot's PR for the same issue merged, it goes to Finished; otherwise it goes back to To Do (or a clear "Slot gone" state), not In progress.
- **Escape hatch:** a person may move a `slotGone` fleet card (to Finished or To Do); the `fleet_slot` refusal applies only while the slot is live.

## Acceptance criteria
- [ ] A fleet slot that ends with no PR while its issue is closed puts its card in Finished (e2e on the board-fleet projection).
- [ ] A fleet slot that ends with no PR while its issue is open no longer leaves its card in In progress.
- [ ] A person can move a `slotGone` fleet card; a live slot's card is still refused (`fleet_slot`).
- [ ] After deploy, C-8 can be moved out of In progress (or moves by itself).

## Out of scope
- How the orchestrator names resumed slots.
- The Completed move rules for non-fleet cards.
