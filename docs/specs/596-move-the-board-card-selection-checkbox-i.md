# C-235: Move the Board card selection checkbox inside the card

Issue: #596

## What to do
The selection checkbox on a Board card straddles the card's left border: `BOX_PLACE` in `apps/web/src/components/board/selection-box.tsx` places it at `-start-[22px] -top-[3px]`, over the card's padding and outside its edge. In the screenshot (card C-233) it looks like a rendering bug, not a control. Move the box fully inside the card's bounds, inside the card's own padding, so it reads as part of the card.

The box must still appear on hover and focus, and on every card while anything is selected. The card face's layout must not shift when it appears (reserve its space, or position it inside the existing `p-3` padding). Check every face that uses `SelectionBox` and `UnselectableMark` (`card-face.tsx`), and `SelectedTint`, which is sized with `-inset-[13px]` to match the old placement. The lock mark that `UnselectableMark` shows on cards that cannot be selected must sit in the same place as the box. Use glass-ui's `Checkbox` only.

## Acceptance criteria
- [ ] The selection checkbox lies entirely within the card's border box on desktop and on phone/tablet widths; no part of it overlaps or crosses the border.
- [ ] It is visible on hover and keyboard focus, and on every card while any card is selected, as before.
- [ ] Showing or hiding the checkbox does not move or resize the card's title, badges or menu.
- [ ] `UnselectableMark` (lock) sits in the same inside position as the checkbox.
- [ ] The selected state (accent border and tint) still frames the whole card correctly.
- [ ] Click, Shift-click range selection and ⌘/Ctrl-click behave as before; the card menu and links still work.
- [ ] Existing board tests pass; a test covers the changed placement where it is testable.

## Out of scope
Changing selection behaviour, the bulk action bar, or card content. No new UI components outside glass-ui.

## Open questions
None.
