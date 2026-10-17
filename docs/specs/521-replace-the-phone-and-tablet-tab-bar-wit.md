# C-231: Replace the phone and tablet tab bar with glass-ui's floating BottomCapsule

Issue: #521

## What to do
Below `lg` (1024 px, `NARROW_QUERY` in `apps/web/src/components/shell/narrow.ts`), the shell renders glass-ui's edge-to-edge `TabBar` with five places and More (`apps/web/src/components/shell/app-shell.tsx`). Replace it with glass-ui's `BottomCapsule` (`@andrewbehma/glass-ui/bottom-capsule`, already in 0.34.0). This gives the floating capsule from the reference mockup: a few tabs, a travelling pill on the active one, More, and a separate round `+` action button beside the capsule. Per ADR-0011, use the glass-ui component as-is and write no custom bar.

1. **Tabs: three plus More.** In `apps/web/src/components/shell/nav.ts`, change `TAB_IDS`/`tabBarSplit` to three places. Inside a project: `board`, `fleet`, `approvals`. Outside one: `overview`, `projects`, `activity`. Everything else goes to More's sheet, which keeps the project switcher and the `ActionList`s it has today. Use `tabSizing="content"` so labels are never truncated.
2. **The `+` action depends on the page.** Add a small page-action registry in `components/shell/`: a context plus a hook such as `usePageActions(actions)` that a page calls to register its actions (label, icon, onSelect, and an optional `operatorOnly` flag), cleared when the page unmounts. The shell reads the registry:
   - One action: `+` runs it.
   - Several actions: `+` opens a bottom sheet listing them as an `ActionList` (glass-ui `Sheet`, wired through `morphFrom`/`open` as `BottomCapsuleAction` documents).
   - None registered, inside a project: `+` is "New work" and opens the Board's New work intake. Reuse the href helper in `apps/web/src/lib/board/href.ts`.
   - None registered, outside a project: no `+`.
   - A viewer (non-operator) never sees operator-only actions. If nothing remains, there is no `+`.
3. **Register actions on the pages that have a primary create action today.** Board → New work (`components/board/`). Fleet → New issue (`fleet/quick-actions.tsx` / `fleet-header.tsx`). Queue → New issue (`queue/new-issue-dialog.tsx`). Schedules → New schedule (`schedules/schedule-dialog.tsx`). Each opens the same dialog or intake the page's own button opens.
4. **Badges.** `BottomCapsuleTab` has no `badge`. Show the waiting-approvals count and the Fleet attention count on their rows in More's sheet (or next to the tab label if glass-ui allows it without custom markup). Record the missing `badge` on `BottomCapsuleTab` as a glass-ui gap in `docs/ui/glass-ui.md`.
5. **Spacing.** Keep the page's end clear of the floating capsule, as the TabBar's spacer did today. Keep the existing sticky bottom bars (for example the narrow composer controls) above it.
6. **Docs.** Update `docs/ui/glass-ui.md` (Navigation section and component table) and `docs/ui/screens.md` (shell row) to describe the capsule, the three tabs and the page-driven `+`.

## Acceptance criteria
- [ ] Below 1024 px the shell shows the floating `BottomCapsule`, not `TabBar`. At 1024 px and above the `NavRail` is unchanged.
- [ ] Inside a project the capsule shows Board · Fleet · Approvals · More. Outside a project it shows Overview · Projects · Activity · More. The active page's tab carries the pill and `aria-current="page"`.
- [ ] More's sheet still holds the project switcher and every page not in the capsule, and a navigation closes it.
- [ ] On the Board, `+` opens New work. On Fleet and Queue, `+` opens New issue. On Schedules, `+` opens New schedule.
- [ ] A page that registers two or more actions opens a sheet listing them when `+` is tapped. This is covered by a unit test of the registry or the shell's selection logic.
- [ ] Inside a project, on a page with no registered action, `+` opens New work on the Board. Outside a project, `+` is not rendered.
- [ ] A viewer sees no operator-only action, and no `+` when none remain.
- [ ] Waiting approvals and slots needing attention remain visible below 1024 px (in More's sheet or on the tab). The missing `BottomCapsuleTab.badge` is recorded as a glass-ui gap in `docs/ui/glass-ui.md`.
- [ ] At 375 px and 768 px no tab label is truncated, the last content of a scrolled page is not hidden under the capsule, and every control is at least 44 × 44 px to a finger.
- [ ] `nav.test.ts` is updated for the three-tab split. `bun run check`, `bun run lint`, `bun run build` and the web tests pass.
- [ ] The PR includes screenshots at 375 px and 768 px, inside and outside a project, plus one with the `+` sheet open.

## Out of scope
- Any change to glass-ui itself (filing the badge gap is enough), or a hand-written bar or FAB in AgentDock.
- The desktop `NavRail`, the top header and the command palette.
- New create actions that pages do not have today.
- A second breakpoint for tablets.

## Open questions
- Where the Approvals and Fleet badges go while `BottomCapsuleTab` has no `badge`. Default: show them on the rows of More's sheet and record the gap in `docs/ui/glass-ui.md`.
- Which tabs make the three. Default: Board · Fleet · Approvals inside a project, Overview · Projects · Activity outside one. Tabs do not change per page.
- What `+` does inside a project when the page registers nothing. Default: New work on the Board.
