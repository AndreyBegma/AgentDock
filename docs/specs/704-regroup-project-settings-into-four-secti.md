# C-286: Regroup project settings into four sections with responsive layout

Issue: #704

## What to do
`apps/web/src/app/(app)/projects/[projectId]/settings/page.tsx` has 13 tabs (General, Docs source, Coding rules, Orchestrator, Members, Budget, Planner, Design, Board, Token saver, Steward, AI digest, Sessions). Regroup them into four sections, for example: Project (General, Members, Docs source), Agents (Orchestrator, Coding rules, Planner, Steward, Sessions), Board & design (Board, Design, AI digest), Cost (Budget, Token saver). Use the glass-ui list/detail layout: section list then a page on phone, side by side from tablet up. Keep existing deep links to a tab working by mapping them to the new section/anchor.

## Acceptance criteria
- [ ] Settings shows four sections, and every former tab's settings are reachable and save as before.
- [ ] Old tab deep links open the right section.
- [ ] Layout matches the mockup at 375px, 820px and 1440px.
- [ ] `bun run check` passes.

## Out of scope
- Changing what any setting does, or the API.
- Admin settings (`/admin/settings`).

## Open questions
- Exact grouping of the 13 tabs. Default: the four sections above.
