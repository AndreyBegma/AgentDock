# C-350: Add a Review tab to project settings for managing review steps

Issue: #890

## What to do
Add a **Review** tab to project settings (`apps/web/src/app/(app)/projects/[projectId]/settings/`, next to `board-tab.tsx`), following the approved stack design and using only glass-ui components (ADR-0011; add any missing primitive to glass-ui):
- A master switch "Review PRs before Finished" and a switch "Publish findings as PR comments" (off by default, with a one-line explanation).
- An ordered list of steps: drag or up/down to reorder, an enable toggle per step, delete for skill steps.
- The Peer review step: a markdown editor for its instructions, save, and "Regenerate" behind a confirm dialog that warns it overwrites edits; a loading state while generation runs.
- "Add step": a picker over the skills the project's runner reports, plus a name.
- Works on desktop and on phones (list collapses to stacked rows, the editor goes full screen on narrow widths).
- Talks to the API over HTTP only.

## Acceptance criteria
- [ ] The Review tab shows the switches and the steps list, and matches the approved design on desktop and at phone width.
- [ ] Enabling review shows the generated Peer review instructions; editing and saving persists them.
- [ ] Regenerate asks for confirmation and replaces the text only after confirming.
- [ ] A skill step can be added from the skills picker, reordered, toggled and deleted; Peer review has no delete action.
- [ ] The publish toggle defaults to off and persists.
- [ ] API errors (unknown skill, generation failure) are shown inline.
- [ ] Component tests cover add, reorder, regenerate-confirm and toggles.

## Out of scope
- Board card UI.
- API changes beyond consuming the endpoints from the foundations card.

## Open questions
None.
