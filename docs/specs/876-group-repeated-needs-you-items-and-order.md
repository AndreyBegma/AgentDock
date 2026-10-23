# C-340: Group repeated Needs-you items and order them by severity

Issue: #876

## What to do
In the Needs you block (`apps/web/src/components/overview/needs-you.tsx`, logic in `apps/web/src/lib/overview/dashboard.ts` and `apps/web/src/lib/setup/format.ts`), merge items with the same problem across projects into one row ("Terminal sessions don't reach the Board — 8 projects"), expandable to the per-project links. Order rows by severity, then oldest first within a severity: blocked and failed, then prompts, then approvals, then setup needs (terminal setup, missing runtime profile). Apply `NEEDS_YOU_SHOWN` to the merged list, setup needs included, with "Show N more". Update the description under the title to match the new order. Put grouping and ordering in pure, tested helpers.

## Acceptance criteria
- [ ] With the data in the screenshot, the eight terminal-setup rows show as one row reading "8 projects", and the four runtime-profile rows as one row reading "4 projects".
- [ ] Expanding a grouped row lists each project and links to the same place the single row linked to.
- [ ] A blocked or failed slot appears above every setup need.
- [ ] The shown limit counts setup needs; the rest sit behind "Show N more".
- [ ] Per-project counts on the Projects block still count that project's items.
- [ ] Unit tests cover grouping and ordering; `bun run check` passes.

## Out of scope
- Changing which problems count as needs, or any API change.
- Other blocks of the Overview.

## Open questions
None.
