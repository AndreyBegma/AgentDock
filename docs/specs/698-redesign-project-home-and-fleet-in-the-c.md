# C-283: Redesign project home and Fleet in the calm layout

Issue: #698

## What to do
Redesign `apps/web/src/app/(app)/projects/[projectId]/page.tsx` (with `home/`) and `fleet/` using the glass-ui primitives (`PageHeader`, `Section`, `EmptyState`, list/detail) and the approved stack mockup.

- Project home: a short summary (what is running, what waits for the person, recent result) with one primary action "Open Board". Remove duplicated widgets and counters that the Board, Queue or Activity already show.
- Fleet: a list of agents/slots with status, readable on phone (stacked rows), tablet and desktop. Details open in a sheet on phone and a side panel from tablet up.
- Keep `project-runner-banner.tsx` behaviour.

## Acceptance criteria
- [ ] Both pages match the approved mockup at 375px, 820px and 1440px.
- [ ] Project home has exactly one primary action, and it opens the Board.
- [ ] No information the pages showed before is lost: what was removed is reachable on Board, Queue or Activity.
- [ ] No horizontal scrolling at 375px.
- [ ] `bun run check` passes.

## Out of scope
- The Board page.
- API changes.

## Open questions
None.
