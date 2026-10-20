# C-285: Merge History into project Activity and redesign it

Issue: #700

## What to do
Merge `projects/[projectId]/history` into `projects/[projectId]/activity` as a "Runs" tab next to the "Feed" tab. `history` redirects to the Runs tab and `history/[runId]` keeps working, either at a new nested URL with a redirect or at its old URL, opened from the tab. Redesign with the glass-ui primitives and the approved stack mockup: a compact timeline, filters folded into one control on phone, run detail in a sheet on phone and a side panel from tablet up.

## Acceptance criteria
- [ ] Activity has Feed and Runs tabs, and Runs lists what History showed.
- [ ] Old `/history` and `/history/[runId]` links resolve to the same content.
- [ ] The page matches the mockup at 375px, 820px and 1440px, with no horizontal scrolling on phone.
- [ ] `bun run check` passes.

## Out of scope
- The workspace-level `/activity` page (covered by the Workspace card).
- API changes.

## Open questions
None.
