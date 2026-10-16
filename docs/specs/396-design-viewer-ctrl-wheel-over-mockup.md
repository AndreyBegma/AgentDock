# Design viewer: Ctrl+wheel over the mockup does not zoom

Issue: #396 · Board card: C-57 · Kind: bug

## What to do
In the design viewer (#335), Ctrl+wheel zooms only over the empty stage margin. Over the mockup itself (an iframe) nothing happens. Steps: staging, /projects/<id>/board/cards/1/design, Ctrl+wheel over the mockup.

## Acceptance criteria
- [ ] Ctrl+wheel over the mockup changes the zoom the same way as over the margin, and does not scroll or zoom the page.
- [ ] Plain wheel over the mockup still scrolls the mockup.

## Out of scope
- Other parts of the screen.

Found by the C-46 staging check on 2026-10-16.
