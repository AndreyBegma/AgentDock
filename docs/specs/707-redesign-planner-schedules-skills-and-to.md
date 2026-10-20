# C-287: Redesign Planner, Schedules, Skills and Token saver project pages

Issue: #707

## What to do
Redesign the secondary project pages that now live under More: `planner` (list and `[planId]`), `schedules`, `skills` (with `runs/[runId]`) and `token-saver`, using the glass-ui primitives (`PageHeader` with one primary action, `Section`, `EmptyState`, list/detail) and the approved stack mockup. Remove decorative counters and duplicate controls, and make tables collapse to stacked rows on phone.

## Acceptance criteria
- [ ] Each page has one primary action in its header and an empty state.
- [ ] Each page matches the mockup at 375px, 820px and 1440px, with no horizontal scrolling on phone.
- [ ] Existing functionality and URLs keep working.
- [ ] `bun run check` passes.

## Out of scope
- Planner design viewer pages (`tasks/[taskKey]/design`), already covered by stack S-6.
- API changes.

## Open questions
None.
