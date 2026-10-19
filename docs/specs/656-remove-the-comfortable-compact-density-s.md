# C-261: Remove the Comfortable / Compact density switch from the Board

Issue: #656

## What to do
The Comfortable / Compact density switch on the board toolbar is not worth keeping. Remove it; the Board always shows full (comfortable) cards.

Where it lives:
- The `Density` type, the `DENSITIES` list and the `SegmentedControl aria-label="Density"` in the toolbar's `actions` (`apps/web/src/components/board/board-toolbar.tsx`).
- The `density` state and its `onDensityChange` / `compact={density === 'compact'}` wiring (`apps/web/src/app/(app)/projects/[projectId]/board/page.tsx`).

Pass full cards to `BoardView`. Drop the `compact` prop from `BoardView` and from `CardFace` where nothing else uses it any more. `PlanPanel` passes its own `compact` to a different component; leave that untouched.

The toolbar's layout must still look right without its actions slot, in the approved mockup's style.

## Acceptance criteria
- [ ] The board toolbar no longer shows a Comfortable / Compact switch.
- [ ] Board cards always render full: the note is not clamped to one line, and the issue and PR links are shown when present.
- [ ] No dead code is left: the `Density` type, the `DENSITIES` list, the density state and any `compact` prop no longer used by any caller are removed.
- [ ] The board toolbar's filters stay aligned and wrap cleanly without the actions slot, on desktop and on a narrow screen.
- [ ] `bun run check`, `bun run build` and the web tests pass.

## Out of scope
- The board filters themselves.
- Card content or layout beyond removing the compact variant.
- The plan panel's own `compact` mode.

## Open questions
None.
