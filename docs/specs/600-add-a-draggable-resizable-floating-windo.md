# C-237: Add a draggable, resizable floating window and launcher to glass-ui

Issue: #600

## What to do
glass-ui has no floating, draggable or freely resizable window and no launcher. Per ADR-0011, add them to glass-ui (`AndreyBegma/glass-ui`), following the approved design.

- **`FloatingWindow`**
  - Dragged by its title bar; resizable from every edge and corner with pointer capture, as `patterns/side-panel` does.
  - Minimum and maximum size; kept inside the viewport, including when the browser window shrinks.
  - Minimize and maximize controls; Escape minimizes.
  - Position, size and minimized state persist in localStorage under a caller-supplied key.
  - A labelled `dialog` role with keyboard-accessible controls.
  - Below md, it renders as the glass-ui `Sheet`.
- **`Launcher`**: a floating round button with an optional badge.

Add showcase stories, release a new glass-ui version, and pin it exactly in `apps/web/package.json`, which is now on 0.34.0.

## Acceptance criteria
- [ ] The window can be dragged by its title bar and resized from every edge and corner, within its min and max sizes.
- [ ] It never leaves the viewport and re-clamps when the browser window shrinks.
- [ ] With a storage key supplied, position, size and minimized state survive a reload.
- [ ] Below md, the content renders in a `Sheet`.
- [ ] `Launcher` shows a badge and does not cover the phone bottom capsule.
- [ ] Both patterns have showcase stories in light and dark themes.
- [ ] A new glass-ui version is released and pinned in `apps/web`.

## Out of scope
- The assistant chat content and its API calls.
- Changes to existing glass-ui patterns.

## Open questions
None.
