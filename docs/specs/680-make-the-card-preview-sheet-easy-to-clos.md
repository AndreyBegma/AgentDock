# C-280: Make the card preview sheet easy to close on phones

Issue: #680

## What to do
Adopt the shared phone back/close control in the card preview sheet `apps/web/src/components/board/card-sheet.tsx` (and the card page `apps/web/src/app/(app)/projects/[projectId]/board/cards/[number]/page.tsx` if it shares the header). On phones, closing and stepping back must be easy to reach with the thumb.

## Acceptance criteria
- [ ] On a phone viewport, closing the card preview is one tap on the shared large control.
- [ ] Stepping back from a nested view (e.g. dependencies, steward section) returns to the card, not the board.
- [ ] Look matches the other phone surfaces.
- [ ] `card-sheet.test.tsx` updated; desktop unchanged.

## Out of scope
Changing card content or actions.

## Open questions
None.
