# C-288: Redesign Workspace Overview, Projects and Work pages

Issue: #711

## What to do
Redesign the main Workspace pages, `/` (Overview, still the landing page), `/projects` and `/work`, with the glass-ui primitives and the approved stack mockup. Overview: a short "needs you" block and recent projects, each with a direct "Open Board" action. Remove widgets that duplicate Usage or Activity. Projects: cards or rows that open the project's Board by default. Work: the cross-project list, made readable on phone (stacked rows) and tablet. Also apply the calm layout to `/activity`, `/sessions` and `/usage` where only header and section primitives need swapping. Restructuring those three is not part of this card.

## Acceptance criteria
- [ ] Sign-in still lands on Overview, and Overview gives one-tap access to each recent project's Board.
- [ ] Opening a project from `/projects` lands on its Board.
- [ ] Overview, Projects and Work match the mockup at 375px, 820px and 1440px, with no horizontal scrolling on phone.
- [ ] `/activity`, `/sessions` and `/usage` use `PageHeader` and `Section`.
- [ ] `bun run check` passes.

## Out of scope
- Admin pages.
- Workflows and the workspace Skills catalog.
- The project Board page.

## Open questions
- Whether opening a project from `/projects` should land on the Board or the project home. Default: Board.
