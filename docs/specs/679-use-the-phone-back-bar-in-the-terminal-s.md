# C-279: Use the phone back bar in the terminal sheet

Issue: #679

## What to do
Adopt the shared phone back/close control in `apps/web/src/components/terminal/terminal-sheet.tsx` so the terminal can be closed with one thumb-reachable tap on phones, without covering terminal input.

## Acceptance criteria
- [ ] On a phone viewport, the terminal closes with one tap on the shared large control.
- [ ] The control does not overlap the terminal input or the on-screen keyboard area.
- [ ] Desktop unchanged.
- [ ] Tests updated or added.

## Out of scope
Terminal behaviour, key bindings, or session handling.

## Open questions
None.
