# C-330: Restructure the card detail into a compact header and tabs

Issue: #836

## What to do
Restructure `CardDetailBody` in `apps/web/src/components/board/card-sheet.tsx` into a compact header and tabs, following the approved stack design. The header holds the card number and title, column/run status, PR link with CI state, total cost and the primary actions (Move, Run/Launch, Open as page). Below it, tabs: **Overview** (run state, summary, escalation/CI/protected-path banners, dependencies, steward, handoff), **Rounds** (the existing rounds timeline), **Files** (attachments) and **Edit** (the card form). The same layout serves the desktop side sheet, the standalone card page (`apps/web/src/app/(app)/projects/[projectId]/board/cards/…`) and the phone bottom sheet (`cardSheetSide`, `useNarrow`). Sections that are empty or irrelevant for the card's column are not shown. Use glass-ui primitives only; if glass-ui has no tabs component, add it there (ADR-0011).

## Acceptance criteria
- [ ] The sheet opens on a header showing number, title, status, PR + CI state, cost and the Move / Run / Open as page actions without scrolling.
- [ ] Overview, Rounds, Files and Edit tabs switch content; the active tab is keyboard-accessible and labelled.
- [ ] Card with an active run opens on Overview; the tab choice is not lost when the card refreshes.
- [ ] The same layout renders in the desktop sheet, the standalone card page and the phone bottom sheet, with no horizontal overflow at 375px width.
- [ ] Every section available today is still reachable in some tab; fleet cards keep their current reduced set.
- [ ] Existing `card-sheet.test.tsx` passes (updated for the tabs) and new tests cover tab switching and empty-section hiding.
- [ ] `bun run check` passes.

## Out of scope
- The content of a single round item (separate card).
- Per-round PR/CI data in the API (separate card).
- Any change to card actions' behaviour or to the API.

## Open questions
- Which tab opens by default for a card with no rounds? Default: Overview.
- Does the tab choice persist across cards? Default: no, every card opens on Overview.
