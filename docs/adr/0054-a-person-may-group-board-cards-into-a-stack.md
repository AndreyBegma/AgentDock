# ADR-0054: A person may group Board cards into a stack by hand

Status: accepted; §1 and §4 amended by [ADR-0089](0089-a-persons-session-may-work-stacks-designs-and-dependencies.md) (stages in one call, stage titles) · Date: 2026-10-17 · Amends [ADR-0044](0044-stacks-staged-cards-under-one-shared-design.md) §3 ·
Card: C-229 · Issue: #588 ·
Spec: [`docs/specs/588-let-users-group-board-cards-into-a-manua.md`](../specs/588-let-users-group-board-cards-into-a-manua.md)

## Context

ADR-0044 made a stack only through an intake: the intake proposes one and
Confirm creates it. A pile of related cards that already exists on the Board
— many Security cards, for example — had no way to be folded into one stack
face, so it kept cluttering the columns.

## Decision

1. **A stack may be made from existing cards.** `POST …/board/stacks`
   (operator) takes a title, an optional body, a `design` flag (off by
   default) and two or more card numbers. It creates the stack with
   `planId = null`, **one stage** holding every named card, and **no**
   `board_card_dependencies` between them: the cards stay independent and run
   as before. `stack.created` is audited as for an intake stack.
2. **The rules of joining a stack hold for every card.** A card must be the
   project's, in no stack already and not in Inbox. One card that breaks a
   rule refuses the whole request with `409 stack_refused`, whose body names
   the refused cards in `cards`; nothing is created.
3. **The shared design is the same as an intake stack's.** With `design` on,
   the stack gets the same design row, and Run of its cards is held until the
   design is approved (ADR-0044 §4, §6).
4. **Later changes use the existing routes.** A card joins or leaves the
   single stage with `POST/DELETE …/board/stacks/:number/cards`; joining
   stage 0 adds no dependency.

## Consequences

- The Board's selection bar gains **Group into stack**, counted with the
  same rule the API runs ("4 of 5"), disabled below two cards that can join.
- Stages, ordering and dependencies chosen by the person inside a manual
  stack are not offered; a card added as a new last stage through the
  existing route does get stage dependencies, as ADR-0044 §2 says.
