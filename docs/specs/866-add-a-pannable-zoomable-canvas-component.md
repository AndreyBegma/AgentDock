# C-345: Add a pannable, zoomable canvas component to glass-ui

Issue: #866

## What to do
Add a canvas component to glass-ui (ADR-0011: a missing component is added to glass-ui, not to the app; see `docs/ui/glass-ui.md`).

- **Layout.** It lays out a row of labelled children side by side with a gap. The children are frames of given widths and heights, and each label shows a name and size such as `Phone · 390×844`.
- **Pan.** Drag on empty space, or the trackpad.
- **Zoom.** Ctrl/⌘ + wheel or pinch, zooming around the pointer.
- **Controls.** Zoom in, zoom out, `Fit all` and `100%`.
- **Zoom range.** It keeps the clamps and step logic of `apps/web/src/lib/design/zoom.ts` (spec 335). Move the pure helpers to glass-ui or reuse them; do not duplicate them.
- **Interactions.** Ctrl + wheel over a child still zooms the canvas (spec 396). An edge drag follows the pointer (spec 394).
- **API.** Zoom and pan are controlled values with change callbacks, so the viewer can keep them in the URL. The component exposes the current scale, so callers can map pointer positions into child coordinates (used by pins).

## Acceptance criteria
- [ ] The canvas renders N labelled children side by side at their own widths and heights.
- [ ] Dragging empty space pans the canvas. Ctrl/⌘ + wheel and pinch zoom around the pointer, inside the existing min and max zoom.
- [ ] `Fit all` scales every child to fit the visible area. `100%` shows them at their real size.
- [ ] Zoom and pan work as controlled props with change callbacks.
- [ ] A helper converts a pointer event into the coordinates of a child at the current scale.
- [ ] Unit tests cover fit, clamping and the pointer-to-child conversion.
- [ ] The component is documented in `docs/ui/glass-ui.md`.

## Out of scope
- Wiring the canvas into the design viewer.
- Free placement or dragging of frames: the layout is a fixed row.
- Multiple selection, rulers and guides.

## Open questions
None.
