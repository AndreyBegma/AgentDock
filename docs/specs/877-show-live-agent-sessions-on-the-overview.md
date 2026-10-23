# C-341: Show live agent sessions on the Overview

Issue: #877

## What to do
Fill the Live sessions placeholder (`apps/web/src/components/overview/live-sessions.tsx`) with the slots alive now across all projects, built from the fleet data `useDashboard` already loads (`isAlive` in `apps/web/src/lib/overview/dashboard.ts`). Each row: project (square hue badge), slot and its card or issue, status, and how long it has been running (`Time`); a row opens the session or the project's Board. Cap the rows and link to `/sessions`. Empty state: "Nothing is running". A project that is not answering is named, not hidden.

## Acceptance criteria
- [ ] Every slot counted by the Running slots tile appears as a row, up to the cap, with "All sessions" leading to `/sessions`.
- [ ] Each row shows project, slot, card or issue, status and running time, and opens its session or Board.
- [ ] Empty, loading and not-answering states render with glass-ui components.
- [ ] Matches the mockup at 375px and 1440px; `bun run check` passes.

## Out of scope
- Messaging or stopping a session from the Overview.
- New API endpoints, unless the fleet data cannot provide a field — then name the gap in the PR.

## Open questions
- How many rows before "All sessions". Default: 5.
