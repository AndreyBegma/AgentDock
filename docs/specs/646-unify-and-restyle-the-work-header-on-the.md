# C-259: Unify and restyle the Work header on the List and Board views

Issue: #646

## What to do
Build one Work header that matches the approved mockup and use it on both views of the Work section.

Today the two views build it differently:
- The List view (`apps/web/src/app/(app)/work/page.tsx`) uses `SegmentedControl size="md"` with `Segment`.
- The Board view (`apps/web/src/app/(app)/projects/[projectId]/board/page.tsx`, the `PageHeader` around line 323) hand-rolls `SegmentedControlItem` with a `Link`/`button` and its own padding. That makes the switch a tall outlined pill, taller than the New work button.

The header has four parts:
- **Title.** Restyle "Work".
- **Stats line.** Restyle the stats line on the Board view. Keep its content: workers running, cards, running, waiting on you.
- **View switch.** Make List / Board one compact switch, the same on both views.
- **Actions row.** Align the row on the right: the live status badge when shown, the view switch, Discuss and New work. They share one height and a consistent style.

Use `PageHeader` (`apps/web/src/components/page-header/page-header.tsx`) and glass-ui components only (ADR-0011). If glass-ui lacks a size or variant the mockup needs, add it to glass-ui.

## Acceptance criteria
- [ ] The Work header on `/work` and on the project Board matches the approved mockup.
- [ ] The List / Board switch looks identical on both views and is no taller than the New work button next to it.
- [ ] Every control in the header action row has the same height. Check with both Discuss and New work visible, and with the live status badge shown.
- [ ] Switching between List and Board keeps the header's position and size: the title, switch and actions do not move.
- [ ] The Board stats line still shows workers running, the card count (with "shown" when filtering), running and waiting on you.
- [ ] On a narrow screen (≤ 640px) the header still wraps cleanly: the switch and the buttons stay usable and nothing overflows.
- [ ] No new non-glass-ui UI components are written in `apps/web`; `bun run check` and `bun run build` pass.

## Out of scope
- The shell top bar (breadcrumbs, search, bell, avatar).
- The board toolbar and its density switch.
- Behaviour changes: navigation between List and Board, the Discuss and New work dialogs.

## Open questions
None.
