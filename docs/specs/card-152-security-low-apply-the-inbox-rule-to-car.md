# C-152: Security [Low]: Apply the Inbox rule to card design, mockups and attachments

> Security audit 2026-10-16 · **WI-50** · severity **Low** · size **S** · findings: L-23 (Z4 D-04)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-23.** Inbox cards are hidden from roles below operator (#244 D8; `apps/api/src/board/board.service.ts:73-74,280`, `board-dependencies.service.ts:56`, `text/text-views.ts:38`), but the card design endpoint (`apps/api/src/design/card-design.controller.ts:56`), the mockup HTML endpoints (`apps/api/src/design/design-mockup.controller.ts:32,41`) and attachment content (`apps/api/src/attachments/attachments.service.ts:234`) do not check the card's column.

**Attacker.** A project viewer.

**Scenario.** The viewer requests the design, mockup or attachment of an Inbox card by id.

**Impact.** The rule is applied inconsistently: content hidden on the board is readable by id.

## Fix
Look up the owning card's column in `cardView`, the mockup endpoints and `content()`, and answer 404 to roles below operator for Inbox cards, with one shared helper.

## Acceptance criteria
- An e2e test: a viewer gets 404 on design, mockup HTML and attachment content of an Inbox card (regression test).
- The same viewer gets 200 after the card is accepted out of the Inbox.

## Touches
- apps/api/src/design/design.service.ts
- apps/api/src/design/design-mockup.controller.ts
- apps/api/src/design/card-design.controller.ts
- apps/api/src/attachments/attachments.service.ts
- apps/api/src/board/inbox-access.ts

## Decision
none needed (#244 D8); see the open question on ADR-0043

## Must not run in parallel with
- WI-54


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
