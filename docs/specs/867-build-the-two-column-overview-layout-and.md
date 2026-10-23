# C-339: Build the two-column Overview layout and compact stats strip

Issue: #867

## What to do
Restructure `Dashboard` in `apps/web/src/components/overview/dashboard.tsx` into the approved layout: a compact stats strip (Running slots, Cost today, PRs merged today — the existing `StatTile` links kept, smaller footprint) above a two-column grid on desktop (left: Needs you, Live sessions, Recent activity; right: Projects, Spend) that collapses to one column on phone and tablet. Give each block its own component file under `apps/web/src/components/overview/` (`needs-you.tsx`, `live-sessions.tsx`, `recent-activity.tsx`, `projects-panel.tsx`, `spend-trend.tsx`); move the existing Needs you and Recent projects code into theirs unchanged, and leave the three new ones as placeholders rendering a glass-ui `Section` with a skeleton, so later cards edit only their own file. Keep Getting started and `PageHeader` in `page.tsx` as they are. Use only glass-ui components (ADR-0011).

## Acceptance criteria
- [ ] At 1440px the Overview shows the stats strip and two columns in the mockup's order; at 375px and 820px it is one column with no horizontal scroll.
- [ ] Each block lives in its own file under `components/overview/`, and `dashboard.tsx` only composes them.
- [ ] The stat tiles keep their figures, hints, failure states and links (`OVERVIEW_TILE_HREF`, `mergedTodayHref`).
- [ ] Needs you and Recent projects behave exactly as before this card.
- [ ] `bun run check` passes.

## Out of scope
- Grouping or reordering Needs you, the new blocks' content, and any API change.
- Getting started and other Workspace pages.

## Open questions
None.
