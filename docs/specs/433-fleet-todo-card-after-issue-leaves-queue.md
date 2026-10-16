# A fleet To Do card stays on the Board after its issue leaves the queue

Issue: #433 · Board card: C-78 · Kind: bug

## What to do
C-55 is the To Do fleet card of issue #390 (`fleet: { issue: 390, slot: null }`, "Waiting for a slot"). #390 lost `cs:ready` and was closed (its work merged through card C-51, PR #422), but C-55 stays in To Do, and `POST /board/cards/55/move` answers 409 `fleet_slot` ("A fleet card follows its live slot").

Why: `BoardFleetService.reconcile` (`apps/api/src/fleet/board-fleet.service.ts`, the "Ready issues no slot has run for" block) creates one `(projectId, issue, null)` card per row of `queueStateRow`, but nothing handles a slotless card whose issue is no longer in the ready set. The move guard (#424) lets a person move only `slotGone` cards, and a slotless card is never `slotGone`.

Fix:
- A slotless fleet card whose issue left the ready set: if the issue is closed, the card goes to Finished; if it is open (unlabelled), the card leaves the Board (or goes to a clear "Not queued" state) — never stays as "Waiting for a slot".
- A person may move or dismiss a slotless fleet card; only a card with a live slot is refused.

## Acceptance criteria
- [ ] A ready issue that is unlabelled or closed no longer leaves its slotless To Do card in To Do (e2e on the projection, both cases).
- [ ] A person can move a slotless fleet card; a live slot's card is still refused (`fleet_slot`).
- [ ] After deploy, C-55 is out of To Do.

## Out of scope
- Cards of slots (handled in #424).
