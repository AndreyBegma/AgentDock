# C-278: Use the phone back bar in the full-screen New work intake

Issue: #678

## What to do
Adopt the shared phone back/close control in the full-screen New work intake on the Board (find it under `apps/web/src/components/board/`). On phones it must be easy to step back between intake steps (questions, card, split/stack proposal) and to close the whole mode.

## Acceptance criteria
- [ ] On a phone viewport, closing intake is one tap on the shared large control.
- [ ] Stepping back between intake steps is reachable with the thumb.
- [ ] Draft input is not lost silently on close (existing behaviour kept or a confirm shown).
- [ ] Desktop unchanged.
- [ ] Tests updated or added.

## Out of scope
Changing the intake interview logic or the agent contract.

## Open questions
None.
