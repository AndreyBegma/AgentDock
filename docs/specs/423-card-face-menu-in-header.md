# Redesign the board card face and move the quick menu into its header

Issue: #423 · Board card: C-35

## What to do
The quick-menu button ("…") on a Board card stretches the card. glass-ui's `Board` (`glass-ui/src/patterns/board.tsx`, the `RowActions` cluster beside `renderCard`) draws it as a separate flex column next to the card content. That column takes width from the whole card, so the cost and the title move left, the title wraps, and the card grows taller (see the attached screenshot of C-29).

Redesign the whole card face that `CardFace` draws (`apps/web/src/components/board/card-face.tsx`, rendered from `board-view.tsx`) so it reads cleanly and the menu no longer takes a column:

- **Header row:** label, Bug chip, attachments, dependency chip and cost, with the "…" trigger at the end of the same line. The trigger is small, as tall as the text line, and adds no width or height to the card.
- **Title.**
- **Status:** design state, round pill, hooks, auto-run and approve offer.
- **Footer:** PR and Issue links.

The Terminal, Fleet and Suggestion faces fit into the same structure.

Per ADR-0011 the menu placement belongs in glass-ui. Add a way for `Board` to hand the card-menu trigger to the consumer, for example a `menu` node passed into `renderCard`, or an inline placement option, so it can sit in the header row. The move/reorder items and `renderCardMenu` must keep working. Release glass-ui and bump the exact pinned version in `apps/web`.

**The design is approved** (ADR-0022, revision `cmva4w1j300nt01plp65pzgr2`). The approved mockup is committed with this spec as `docs/specs/423-card-face-menu-in-header/design/approved.html`; implement it.

## Acceptance criteria
- [x] A design-stage mockup of the new card exists and was approved before implementation (`docs/specs/423-card-face-menu-in-header/design/approved.html`).
- [ ] The "…" trigger sits in the card's header row; the card has no separate menu column, and the content uses the card's full width.
- [ ] The C-29 card from the screenshot is no taller with the trigger than without it, and its cost stays visible next to the trigger.
- [ ] The card menu still opens from the keyboard (Tab to the trigger, Enter), and still offers the move items and the AgentDock items (Open, Accept, Feedback…, etc.).
- [ ] On a coarse pointer the trigger stays visible; on a fine pointer it follows glass-ui's existing `RowActions` reveal rule.
- [ ] Drag and drop of cards between columns still works.
- [ ] The card shows every existing variant (bug, attachments, dependency, design state, round pill, hooks chip, auto-run failure, approve offer, terminal, fleet, suggestion, PR/Issue) in the new layout, in both normal and compact density.
- [ ] Only glass-ui components and tokens are used: no hex, rgb() or Tailwind palette colours (ADR-0011, docs/ui/glass-ui.md).
- [ ] `card-face.test.tsx` and glass-ui's `board.test.tsx` pass, and are updated for the new structure and the new Board slot.
- [ ] The PR includes before/after screenshots of the board.

## Out of scope
- Changing which data a card shows, or any API or shared types.
- The card sheet (`card-sheet.tsx`) and the plan-task face (`plan-task-face.tsx`), beyond keeping the plan-task face working with the new Board slot.
- Board columns, the toolbar and column widths.
- Adding or removing items in the card menu.

## Open questions
- The glass-ui change lives in a separate repository. Default: land it as a glass-ui PR and release first, then bump AgentDock. If one agent cannot work across both repositories, the glass-ui slot becomes its own card and this one depends on it.

## Sequencing

1. glass-ui: the `Board` hands the card-menu trigger to the consumer (filed in AndreyBegma/glass-ui), released as 0.33.0.
2. AgentDock: bump to 0.33.0 and implement the approved card face. This issue is the AgentDock part; it depends on that glass-ui release.
