# Moving a card to Completed checks its landing, as Accept does

Issue: [#847](https://github.com/AndreyBegma/Nautelle/issues/847) · Related: [ADR-0024](../adr/0024-board-cards-and-dedicated-card-workers.md) §6, [ADR-0083](../adr/0083-a-persons-session-may-work-the-board-through-mcp.md)

## Summary
`POST board/cards/:number/move` to `completed` moves a Finished card whose pull request is open and unmerged; the same card through `POST …/accept` is refused `not_landed` unless `confirmUnlanded`. Completed means landed; the move path must apply the same check.

## Scope
### In scope
- The person move to `completed` (`board.service.ts` `move` → `BoardWork.move`) runs the landing check `accept` runs (`missingLanding`), refusing `not_landed` unless the request confirms it.
- `MoveBoardCardDto` gains `confirmUnlanded?: boolean`, meaning what it means on accept.
- The web drag to Completed handles `not_landed`: it offers the same confirmation Accept offers, and retries with `confirmUnlanded: true`.
### Out of scope
- Agent moves: `card.move` to completed is refused `completed_needs_person` (ADR-0083) and stays so.
- Fleet cards (ADR-0030) keep their own rule.

## Decisions
- D1 The check and the refusal code are `accept`'s own — `missingLanding`, `not_landed` [Confirmed: board.service.ts accept path]. No new code.
- D2 `confirmUnlanded` on move mirrors `AcceptBoardCardDto.confirmUnlanded` [Confirmed: dto.ts].

## Acceptance criteria
- [ ] Moving a Finished card with an open, unmerged pull request to Completed is refused `not_landed`; the card stays in Finished.
- [ ] The same move with `confirmUnlanded: true` succeeds.
- [ ] A card whose pull request merged moves to Completed without confirmation.
- [ ] A card with no pull request and no landing obligation moves as today.
- [ ] Dragging such a card to Completed in the web Board shows the confirmation; confirming completes it, cancelling leaves it in Finished.
- [ ] e2e (api) for the four API cases; web test for the confirmation.

## Parallel plan
| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i847 | the move check and its UI | apps/api/src/board/board.service.ts, apps/api/src/board/board-work.ts, apps/api/src/board/dto.ts, apps/api/src/board/board.e2e.spec.ts, apps/api/src/board/board-accept.e2e.spec.ts, apps/web/src/components/board/**, apps/web/src/lib/board/** | — | yes | sonnet |

One slot: a repair whose cause is proven (the move path never calls `missingLanding`).
