# C-301: S-7 polish: Planner list columns off-screen, Token saver tables on tablet, Fleet title

Issue: #717

Found in the visual pass of stack S-7 on staging (2026-10-20, light and dark, 1440 / 820 / 375 px). No page scrolls horizontally anywhere; these are inside the pages.

## What to fix
1. **Planner list (C-287).** `/projects/:id/planner`: the plans table is 1892 px wide inside a 705–1020 px scroller, so only the **Plan** column is visible even on desktop; every other column sits off to the right. Make the title cell wrap/truncate (no `whitespace-nowrap` on the title + badge), size the other columns to content, and use the responsive rows from tablet down like Schedules and Skills, so all columns fit at 1440 and the rows read well at 820 and 375.
2. **Token saver on tablet.** At 820 px the "Cost per round" (848 px), the second summary (811 px) and "Cost per round by week" (927 px) tables are wider than their 705 px container and scroll sideways, cutting the last columns. Use the responsive rows below desktop (as on phone), or drop/merge the lowest-value columns below desktop, so nothing is cut at 820.
3. **Fleet header.** `/projects/:id/fleet`'s h1 is the project name ("AgentDock") while the breadcrumb and nav say Fleet. Title it "Fleet" (project name in the eyebrow/breadcrumb), matching the approved mockup (`docs/specs/stacks/S-7-…/design/1/navigation-project-home-and-fleet.html`).

## Acceptance criteria
- [ ] Planner list shows all its columns without horizontal scrolling at 1440 px, and readable rows at 820 and 375 px.
- [ ] Token saver tables show every column without sideways scrolling at 820 px.
- [ ] Fleet's h1 is "Fleet".
- [ ] Checked in a browser at 375, 820 and 1440 px (screenshots in the PR), plus web tests for the responsive switch; `bun run check` passes.
