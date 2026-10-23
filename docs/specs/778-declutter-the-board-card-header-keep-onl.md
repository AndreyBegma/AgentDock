# C-315: Declutter the Board card header: keep only selection, label, Bug and menu

Issue: #778

## What to do

The header row of a Board card (`apps/web/src/components/board/card-face.tsx`, `data-card-row="header"`) has too much in it. One 16 px line can hold up to ten items: the selection box, the label, the stack chip, Bug, triage hints, the attachment count, the "after C-…" dependency chip, the cost, the token-saver "saved ≈ …" badge and the menu. Make the header short and the same on every card. Approve an HTML mockup first (ADR-0022), then change the component.

Target layout. Validate it in the mockup and adjust there if something reads better:
- **Header:** selection box / unselectable mark, the label (`C-304`), the Bug chip, and the menu trigger at the end. Nothing else.
- **Status row** (`data-card-row="status"`, which already wraps): the stack chip (`S-…`), the triage-hints chip and the "after C-…" dependency chip. Put the dependency chip next to the Ready/Waiting readiness chip.
- **Footer** (PR · Issue, above the hairline): the attachment count (paperclip + number) and the cost (`$0.31`), aligned to the right end of the footer. When there is no PR or Issue but there is a cost or attachments, the footer still renders for them.
- **Token-saver badge:** remove it from the card face entirely. Also remove the narrow-column `data-card-row="saved"` line, which exists only to hold it. Instead, show the card's total saving (`SavedBadge` from `apps/web/src/components/token-saver/saved-badge.tsx`, fed by `card.tokenSaved`) in the card sheet (`apps/web/src/components/board/card-sheet.tsx`) and on the card's own page under `apps/web/src/app/(app)/projects/[projectId]/board/cards/`, near the card's cost.

Keep every item's existing title or aria-label and its existing behaviour (links, tones, truncation). Use glass-ui components only (ADR-0011). Update the doc comment on `CardFace` so it describes the new row contents.

## Acceptance criteria

- [ ] An HTML mockup of the card face (narrow and wide columns, a card with every optional item, and a minimal card) is approved before any code changes.
- [ ] The header row contains only the selection box or unselectable mark, the label, the Bug chip (bug cards) and the menu trigger.
- [ ] The stack, triage-hints and dependency chips render in the status row, with the dependency chip next to the readiness chip.
- [ ] The attachment count and the cost render in the footer, right-aligned. The footer appears when a card has a cost or attachments but no PR or Issue.
- [ ] The token-saver badge no longer appears anywhere on the card face, and the `data-card-row="saved"` row is gone.
- [ ] The card sheet and the card page show the card's token saving when `tokenSaved` is set, and show nothing for it when it is not.
- [ ] On a narrow column (≤ 15rem container) the header no longer overflows or truncates the label. On touch devices the menu keeps its 44 px tap target inside the header (#497).
- [ ] `card-face.test.tsx` is updated for the new row placement (including the existing saved-badge tests), and a test covers the saving in the card sheet.
- [ ] `bun run check` and the web tests pass. The pull request includes before/after screenshots of the Board.

## Out of scope

- Changing what any chip says, its colours or its tooltip text.
- Changing the title, the approve offer or the PR/Issue links, except to make room for the cost and attachment count in the footer.
- The token-saver project page and the usage page.
- New glass-ui components, unless the mockup requires one. If it does, add it to glass-ui (ADR-0011).

## Open questions

- Where exactly should the small meta items go? Default: stack, hints and dependency go to the status row; attachments and cost go to the footer, right-aligned (the person left this to the intake). The approved mockup may adjust it.
- Where on the card sheet and card page should the saving appear? Default: next to the card's cost or in its summary block, using the existing `SavedBadge`.
