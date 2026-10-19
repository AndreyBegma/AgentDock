# C-276: Add a shared phone back/close bar for full-screen layers and sheets

Issue: #675

## What to do
Create one shared phone control for leaving a full-screen layer or sheet: a large (at least 44px touch target) back/close button placed in the thumb zone, with safe-area insets respected, a consistent polished look, and an accessible label. Build it on glass-ui; if glass-ui lacks the primitive, add it to glass-ui rather than hand-writing it in apps/web (ADR-0011). Wire it into `apps/web/src/components/design/full-screen-layer.tsx` as an optional/default slot so full-screen pages can reuse it, and make it usable from sheets such as `apps/web/src/components/board/card-sheet.tsx`. Visible on phone viewports only; desktop layout unchanged.

## Acceptance criteria
- [ ] A shared back/close control exists, with a touch target of at least 44x44px, placed within thumb reach on a phone viewport.
- [ ] It respects safe-area insets (notch / home indicator).
- [ ] It has an accessible name and keyboard focus styling.
- [ ] `FullScreenLayer` can render it and accepts an `onBack`/`onClose` handler.
- [ ] Desktop layout is unchanged.
- [ ] Tests cover rendering and the click handler.

## Out of scope
Applying it to the individual screens (separate cards); swipe gestures.

## Open questions
- Position: bottom bar vs top-left enlarged button. Default: bottom bar in the thumb zone with a large back button.
- Swipe-down-to-close gesture. Default: not included.
