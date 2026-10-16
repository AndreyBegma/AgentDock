# C-216: Add a prominent Move action with a column picker for cards on phones

Issue: #515

## What to do
On a phone, cards cannot be dragged between columns: glass-ui `Board` uses native HTML5 drag, which touch does not start. The only route is a list of "Move to <column>" items buried in the card's menu (`apps/web/src/components/board/board-view.tsx:409-466`).

Make moving a card from a phone easy without drag-and-drop:
- Give the card menu one clear "Move" item.
- Add a visible "Move" button to the card detail sheet (`apps/web/src/components/board/card-sheet.tsx`, the `SheetContent side="right"` around line 1028) and to the full-page card view.
- Both open a glass-ui `Sheet side="bottom"`. It lists the columns the card may move to, marks the current one, and has rows at least 44px tall.

Choosing a column performs the same move the existing menu items perform. That includes the existing confirm `Dialog` when the target is In progress (`board-view.tsx:587-613`). Reuse the existing move logic; do not duplicate it. On desktop the picker may also be used, but drag-and-drop stays as it is.

## Acceptance criteria
- [ ] At 375×812 with touch emulation, a card can be moved to another column from its menu in at most three taps (menu → Move → column), and the Board shows it in the new column.
- [ ] The card detail sheet and the full-page card view show a Move button that opens the same column picker.
- [ ] The picker marks the card's current column and offers only the moves the existing menu allows.
- [ ] Moving to In progress through the picker shows the same confirm dialog as today.
- [ ] Rows in the picker are at least 44px tall.
- [ ] Drag-and-drop on desktop still works.
- [ ] A test covers the picker's list of allowed target columns.
- [ ] `bun run check`, `bun run build` and `bun run test` pass.

## Out of scope
- Touch or long-press drag-and-drop in glass-ui `Board`.
- Bulk moves and bulk selection.
- Card face sizing and Board breakpoints.

## Open questions
None.
