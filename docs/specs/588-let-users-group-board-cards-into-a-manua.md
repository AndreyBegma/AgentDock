# C-229: Let users group Board cards into a manual stack

Issue: #588

## What to do
Today a stack (ADR-0044) can only be created by confirming an intake proposal, so a pile of related cards (for example many Security cards) clutters the Board list. Let a person group existing cards into a stack themselves.

- API: add an endpoint in `apps/api/src/board/board.controller.ts` backed by a new `BoardStacks.create`-from-cards path in `apps/api/src/board/board-stacks.ts` (`CreateStackInput` already allows `planId: null`). Input: a title, an optional body, a `design` flag (default false) and the card numbers. The stack is made with a single stage and no dependencies between cards, so the cards stay independent and run as before. Add the DTO with `class-validator` decorators and the request/response types in `packages/shared`.
- Reuse the existing rules of `addCard`: a card must belong to this project, must not be in a stack already, and must not be in Inbox (a suggestion joins once accepted). Refuse the whole request with `stackRefused` (409) if any card breaks a rule, and create nothing.
- Web: on the Board (`apps/web/src/components/board/board-view.tsx`, `card-face.tsx`) add multi-select of cards and a "Group" action that asks for a name and, optionally, turns on the shared design. Use glass-ui components only (ADR-0011); if one is missing, add it to glass-ui. The new stack then shows as one stack face (`stack-face.tsx`) with progress, as ADR-0044 §7 describes.
- Shared design is off by default; when the person turns it on, the stack gets the same design row and Run gating as an intake stack (ADR-0044 §4, §6).
- Existing `POST/DELETE board/stacks/:number/cards` keep working for adding or removing a card later; make sure they behave sensibly for a single-stage manual stack.
- Write an audit entry for the creation, as the other stack operations do.

## Acceptance criteria
- [ ] On the Board a person can select two or more cards and group them into a new stack by giving it a title.
- [ ] The grouped cards disappear from the flat list and appear under one stack face with progress; opening it shows the cards.
- [ ] The created stack has one stage and no `board_card_dependencies` between its cards; the cards remain runnable independently.
- [ ] A shared design is not created unless the person turns it on; when turned on, Run is gated until the design is approved.
- [ ] A request that includes an Inbox card, a card already in a stack, or a card from another project is refused with 409 and creates nothing.
- [ ] Cards can still be added to or removed from the manual stack afterwards.
- [ ] API tests (`*.spec.ts` / e2e next to `board-stacks.e2e.spec.ts`) cover creation and each refusal; web test covers the select-and-group flow.
- [ ] `bun run check`, `bun run lint` and `bun run test` pass.

## Out of scope
- Stages, ordering or dependencies chosen by the person inside a manual stack.
- Changing how intake stacks are proposed or confirmed.
- Merging two stacks, moving a card between stacks in one step, or nested stacks.
- Any change to design generation itself.

## Open questions
- How a person adds a single card to an existing stack from its card sheet: Default: not in this card; the existing add/remove-card endpoints stay and a sheet action can follow separately.
- Whether the stack body is asked for at creation: Default: only the title is required, the body is optional.
