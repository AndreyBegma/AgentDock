# Design viewer: dragging the frame edge at 50% zoom moves 2-4x too far

Issue: #394 · Board card: C-45 · Kind: bug

## What to do

Reported: with the design viewer zoom from #335 at 50 %, dragging the mockup frame's edge "changes the width much faster than the pointer moves" (2-4x).

The original analysis on the card does not match the code, so this slot first proves the cause:

- `apps/web/src/components/design/design-viewer.tsx` passes `ResizableFrame` the **scaled** box size (`boxSize(view.width, zoom)`) and converts back with `layoutWidth(box, zoom)` (`apps/web/src/lib/design/zoom.ts`). glass-ui's `ResizableFrame` works in box px, and its factor 2 for a centred frame is what keeps both edges symmetric under the pointer. On paper the dragged edge should already follow the pointer at any zoom.
- So reproduce it first (dev stack, a card with a design, zoom 50 % and 100 %, centred frame and a frame wider than the stage). Measure the pointer travel against the dragged edge's travel in screen px.

The intent, which the fix must meet: **the dragged edge stays under the pointer**, at any zoom, centred or left-aligned. The layout width then changes by `2·dx / zoom` for a centred frame and `dx / zoom` for a left-aligned one.

Likely suspects, if it does reproduce:
- the width round-trip `box → layoutWidth → boxSize` rounding, or feeding back mid-drag (`setDragWidth`) so `startWidth` drifts;
- the centred/left-aligned decision in `ResizableFrame.onPointerDown` (`room >= width`) using a box width the zoom changes;
- `min`/`max` passed in scaled px while the clamp runs on a different scale;
- Fit mode recomputing the zoom while the width changes (the zoom moves under the drag).

If the cause is in glass-ui's `ResizableFrame`, say so in the reply with the exact change: the orchestrator lands it as a glass-ui slot (ADR-0011), and this slot then only bumps or adapts.

## Acceptance criteria

- [ ] The PR (or the reply, if nothing reproduces) states the measured behaviour before the fix: pointer px vs edge px, at 50 % and 100 %, centred and left-aligned.
- [ ] After the fix, at 50 %, 75 %, 100 % and in Fit, the dragged edge stays under the pointer (within 2 px) for a centred and for a left-aligned frame.
- [ ] The committed width equals the layout width the edge shows (no drift after a few drags back and forth).
- [ ] A unit test covers the cause where it is logic (`apps/web/src/lib/design/zoom.ts` or the viewer's drag mapping).
- [ ] `bun run check` and the web tests pass.

## Out of scope

- Zoom presets, Fit and Ctrl+wheel (C-57 has the Ctrl+wheel defect).

## Open questions

- If the defect does not reproduce: the slot reports the measurements and the card is closed as not a bug, with the person told.
