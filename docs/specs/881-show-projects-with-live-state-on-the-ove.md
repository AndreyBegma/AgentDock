# C-343: Show projects with live state on the Overview

Issue: #881

## What to do
Replace Recent projects (`apps/web/src/components/overview/projects-panel.tsx`, from `ProjectCard` in `dashboard.tsx`) with compact rows fitting the right column: square hue badge and name, orchestrator `StatusPill`, live slot count, how many items need the person (shared with Needs you), and cost today. Order by recent activity (`byRecentActivity`); a row opens the project's Board (`boardHref`). Keep "All projects" to `/projects`. A project that is not answering says so in its row.

## Acceptance criteria
- [ ] Each row shows name, orchestrator status, live slots, waiting count and cost today, and opens the Board.
- [ ] The waiting count equals that project's items in Needs you.
- [ ] Rows are ordered by most recent activity; "All projects" leads to `/projects`.
- [ ] At 1440px the projects are visible without scrolling with the data in the screenshot.
- [ ] Matches the mockup at 375px and 1440px; `bun run check` passes.

## Out of scope
- The `/projects` page.
- Project settings or actions beyond opening the Board.

## Open questions
- How many projects before "All projects". Default: 8.
- Whether per-project cost needs a new usage query. Default: use the usage summary grouped by project if available, otherwise name the gap in the PR and show the rest.
