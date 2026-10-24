# C-342: Show recent activity and a 7-day spend trend on the Overview

Issue: #880

## What to do
Fill two placeholders. Recent activity (`apps/web/src/components/overview/recent-activity.tsx`): the latest events across every project from `/activity` (already called in `use-dashboard.ts`), formatted with `apps/web/src/lib/activity/format.ts`, with "All activity" leading to `/activity`. Spend (`apps/web/src/components/overview/spend-trend.tsx`): API-equivalent cost per day for the last 7 days from the usage API, shown as a sparkline with today's figure, linking to `/usage`; reuse the sparkline in `apps/web/src/app/(app)/usage/usage-figures.tsx` or move it into glass-ui if needed (ADR-0011). Never show a false zero: a failing source shows a dash and a retry, as the stat tiles do.

## Acceptance criteria
- [ ] Recent activity shows at most 8 latest events across projects, each linking where `/activity` links it, plus "All activity".
- [ ] Spend shows 7 daily points ending today, matching `/usage` for the same days, and links to `/usage`.
- [ ] A failing source shows the unavailable state with "Try again", not zeros.
- [ ] Matches the mockup at 375px and 1440px; `bun run check` passes.

## Out of scope
- Filters, per-project breakdowns or charts beyond the sparkline.
- Changing `/activity` or `/usage` pages.

## Open questions
- Whether activity should hide routine events. Default: same filter as `/activity` with no filter set.
