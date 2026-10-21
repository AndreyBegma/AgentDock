# C-304: Keep the token-saver badge inside the card header on narrow columns

Issue: #738

## What to do
On the Board, the header row of a card face (ID, Bug chip, cost, `saved ≈ $x` token-saver badge, menu) overflows the card's right edge in narrow columns such as the collapsed Completed column. The `saved ≈ <$0.01` text runs past the card border and gets clipped (see the attached screenshot, cards C-296, C-295, C-303).

Cause: in `apps/web/src/components/board/card-face.tsx` (header row, around lines 175–181) the right-hand group holding the cost, `<SavedBadge>` and the menu is `ms-auto flex shrink-0`. `SavedBadge` (`apps/web/src/components/token-saver/saved-badge.tsx`) is also `whitespace-nowrap`. Nothing in that group can give way, so the row grows wider than the card.

Fix the header so it always fits the card width. Keep the cost and the menu on the header line. Let the saved badge give way when space runs out: it wraps to its own line under the header or truncates with an ellipsis, and the full text and token figure stay in its `title`. Follow the existing pattern in the same row, where the `after` chip is the item that truncates (`min-w-0 shrink` + `truncate`). Use only glass-ui and Tailwind (ADR-0011).

## Acceptance criteria
- [ ] In a narrow Board column (e.g. the Completed column at its default width), no part of the card header — cost, `saved ≈ …` badge, menu — goes past the card's border.
- [ ] The cost and the card menu stay visible on the header line at every column width.
- [ ] When there is room, the header looks the same as today (`$0.30 saved ≈ <$0.01` on one line).
- [ ] When the saved badge is shortened or moved, its hover `title` still shows the full saved figure and tokens.
- [ ] A cheap layout check: a test in `card-face` or `token-saver` asserts the header right group or the badge can shrink or wrap (it is no longer `shrink-0` + `whitespace-nowrap` with nothing that gives way).
- [ ] `bun run check` passes.

## Out of scope
- Changing the saved-figure format or `savedLabel` / `formatSavedUsd` in `lib/token-saver/format.ts`.
- Redesigning other card rows (title, status chips, PR row) or the column widths.
- Token-saver summary tables and other screens.

## Open questions
- On a narrow card, should the saved badge wrap to a second line or truncate with an ellipsis? Default: wrap it to its own line under the header, so the figure stays readable; truncate only if the wrapped line would still overflow.
