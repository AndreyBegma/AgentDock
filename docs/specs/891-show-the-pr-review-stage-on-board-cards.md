# C-351: Show the PR review stage on board cards and in the card sheet

Issue: #891

## What to do
Make the review gate visible on the Board, following the approved stack design and using only glass-ui components (ADR-0011). Use the card DTO's `review` state.
- **Card face** (`apps/web/src/components/board/card-face.tsx`): while a card is in In progress after green CI, show a review chip in the same family as the existing "Fixing CI (1/3)" chip, e.g. "Reviewing · Security (2/3)" or "Fixing review (1/3)", and a needs-person state when the fix limit is exhausted. On Finished cards, show a compact readiness line: CI passed, review passed, fixes done.
- **Card sheet** (`card-sheet.tsx`, `card-tabs.tsx`): a Review section with a step tracker: CI → each review step → Finished. Each step shows its state, blocking and nit counts, and an expandable findings list (title, file:line, body). Each review fix round links to its round.
- Phones: the chip stays one line and truncates the step name; the tracker becomes vertical; findings open in a full-height sheet.
- Uses the shared shipping helpers in `apps/web/src/lib/board/shipping.ts` for the new states, with tests.

## Acceptance criteria
- [ ] A card under review shows the review chip with the current step and its position; a fixing card shows the fix round and limit.
- [ ] A card that exhausted review fixes shows a needs-person state distinct from CI exhaustion.
- [ ] A Finished card with review enabled shows CI, review and fixes as passed.
- [ ] The card sheet's Review section lists every step with state and counts, and expands to findings.
- [ ] Cards in projects with review disabled look exactly as they do today.
- [ ] Layout matches the approved design at desktop and phone widths, with no overflow at 360 px.
- [ ] Tests cover the shipping helpers and the card face for running, fixing, needs-person and passed.

## Out of scope
- Project settings UI.
- Adding a new board column: review stays a sub-state of In progress.

## Open questions
None.
