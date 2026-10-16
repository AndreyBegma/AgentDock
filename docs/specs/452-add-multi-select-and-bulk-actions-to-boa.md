# C-87: Add multi-select and bulk actions to Board cards

Issue: #452

## What to do
Let a person select several Board cards at once and apply one action to all of them: move to Completed, move back to To Do, mark Finished, or delete. The trigger case is a Finished column with ~49 cards, most of them with already-merged PRs, which today have to be accepted one by one.

The parts, in this order:

1. **API**: add `POST /projects/:projectId/board/cards/bulk` (operator, like the per-card endpoints in `apps/api/src/board/board.controller.ts`). It takes a DTO `{ numbers: number[], action: 'complete' | 'todo' | 'finished' | 'delete' }` validated with `class-validator`, with 1–100 numbers. Every card goes through the same service path as the single-card action: `complete` is Accept with neither `merge` nor `closePr`, i.e. move-only per #273 D14 / #329 D8, so the PR is left untouched; `todo` is the person move; `finished` is `board.finish`; `delete` is the existing delete. Every move is checked by `boardMoveRule` (`packages/shared/src/board/moves.ts`). A card the rule refuses (`card_running`, `fleet_slot`, `plan_task_derived`, `card_completed`, …), a card already in the target column, or a card that no longer exists is skipped, not failed, and the rest of the batch still runs. The response lists the outcome of each card (`done` / `skipped` with the refusal code / `error` with the board error). Put the request/response types in `packages/shared/src/board/contracts.ts`. Each card writes its usual audit entry.
2. **Selection state** in the web Board (`apps/web/src/components/board/board-view.tsx`): a set of card numbers that can span columns.
   - A checkbox on each card face (`card-face.tsx`), shown on hover and always while any card is selected.
   - Cmd/Ctrl+click toggles a card. Shift+click selects the range inside a column, from the last clicked card.
   - A "Select all" control in each column header, which respects the active filter (`lib/board/filter.ts`).
   - Esc clears the selection. Cmd/Ctrl+A selects every card of the column under the pointer or focus, only when focus is not in a text input.
   - Plan tasks (`plan-task-face.tsx`) and Inbox suggestions cannot be selected.
   - A selected card that leaves the board drops out of the selection.
   - While anything is selected, a plain click on a card face toggles it instead of opening the sheet.
3. **Floating action bar** at the bottom of the Board while anything is selected. It shows "N selected", a Clear button, and the four actions. Each action button shows how many of the selection it applies to ("Move to Completed · 40 of 42"), computed with `boardMoveRule` on the client; a button that applies to none is disabled. Move to Completed and Delete ask first with `ConfirmDialog`. The Completed confirmation states how many of those cards still have an open PR and that their PRs stay open. After the call, one toast summarises the outcome (done / skipped with reasons), the board refetches, and the selection keeps only the skipped cards. Wire the actions next to `use-card-actions.tsx` and `lib/board/actions.ts`.

UI only from glass-ui (ADR-0011): if a component is missing (e.g. a floating action bar), add it to glass-ui and do not write it here.

## Acceptance criteria
- [ ] Selecting 10 Finished cards and choosing Move to Completed moves all 10 to Completed with one confirmation; none of their PRs is merged or closed.
- [ ] The Completed confirmation names how many selected cards still have an open PR.
- [ ] Cards can be selected by checkbox, Cmd/Ctrl+click, Shift+click (range within a column), the column's "Select all" (filter-aware) and Cmd/Ctrl+A; Esc clears the selection.
- [ ] Cmd/Ctrl+A inside a text input still selects the text, not cards.
- [ ] Cards from different columns can be selected together; each action button shows "N of M" it applies to and is disabled at 0.
- [ ] A selection containing a running card, a fleet card that cannot make the move, or a plan task completes the batch for the rest and reports the skipped cards with a reason; no partial-failure exception reaches the person.
- [ ] Mark Finished and Back to To Do apply the same effects (`finish`, `collect`, `reopen`, …) as the single-card path does.
- [ ] Delete asks once for the whole batch and skips running cards.
- [ ] The bulk endpoint rejects an empty list, more than 100 numbers, an unknown action and extra fields with 400; a viewer gets 403.
- [ ] API e2e spec for the bulk endpoint (mixed outcomes, move-only Accept, audit entries) and web tests for selection (range, select all with a filter, Esc) and the action bar counts.
- [ ] While nothing is selected, the board works as before: a click opens the card sheet and drag-and-drop is unchanged.

## Out of scope
- Bulk Run, bulk merge or close of PRs, bulk editing of card fields (kind, model, profile).
- Dragging a multi-selection as a group.
- Changing the single-card Accept dialog or `boardMoveRule` itself.

## Open questions
- How to delete a running card in bulk. Default: skip it with reason `card_running`; it is never stopped from a bulk action.
- Batch size limit. Default: 100 cards per request.
- Card-face click while a selection exists. Default: it toggles the selection; the sheet opens again once the selection is cleared.
