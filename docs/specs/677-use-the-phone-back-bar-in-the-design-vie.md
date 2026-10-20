# C-277: Use the phone back bar in the design viewer

Issue: #677

## What to do
Adopt the shared phone back/close control in the design viewer pages: `apps/web/src/app/(app)/projects/[projectId]/board/cards/[number]/design/page.tsx`, `.../board/stacks/[number]/design/page.tsx` and `.../planner/[planId]/tasks/[taskKey]/design/page.tsx`. Remove or replace the small existing exit control on phone viewports and make sure "step back" returns to the previous state (e.g. back to the card), not out of the board unexpectedly.

## Acceptance criteria
- [ ] On a phone viewport, exiting the design viewer is one tap on the shared large control.
- [ ] Step back lands on the previous screen/state (the card it was opened from).
- [ ] The look matches the other phone surfaces.
- [ ] Desktop unchanged.
- [ ] Tests updated or added.

## Out of scope
Changing the design content or approval flow.

## Open questions
None.
