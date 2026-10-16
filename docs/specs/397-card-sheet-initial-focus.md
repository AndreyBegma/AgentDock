# Card sheet opens with focus on its main action (Accept / Create pull request)

Issue: #397 · Board card: C-58 · Kind: bug

## What to do
Opening a card sheet puts keyboard focus on its primary action: Accept on a Finished card (C-38), Create pull request on C-1. Enter or Space right after opening triggers it. Steps: staging, ?card=38.

## Acceptance criteria
- [ ] Opening a card sheet focuses the sheet title or its close control, never an action button.
- [ ] A web test asserts the initial focus.

## Out of scope
- Other parts of the screen.

Found by the C-46 staging check on 2026-10-16.
