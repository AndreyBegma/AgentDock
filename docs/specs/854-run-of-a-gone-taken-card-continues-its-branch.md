# Run of a session-gone taken card continues on its takenBranch

Issue: [#854](https://github.com/AndreyBegma/Nautelle/issues/854) · Follow-up of [#845](845-board-from-a-session.md) D10 · [ADR-0083](../adr/0083-a-persons-session-may-work-the-board-through-mcp.md) §4

## Summary
A card a manual session took (`card.take`) records the session's branch in `BoardCard.takenBranch`. When the session ends without finishing, the card stays In progress, session-gone, and Run is offered again (ADR-0083 §4). Today that Run launches on the card's own branch, so the work the session pushed is not continued. The Run should start from `takenBranch` when it exists on origin.

## Scope
### In scope
- The API's launch of a card round (`board-rounds.service.ts`, `launch-choice.ts`) passes `takenBranch` as the round's start branch when the card is a session-gone taken card.
- The runner's `card.run` executor creates or reuses the card worktree from `origin/<takenBranch>` when that start branch is given and exists on origin; otherwise it launches as today and says so in the round's launch event.
- The card shows which branch the round started from.
### Out of scope
- Taking over a live session's card (Run stays refused while the taker lives).

## Decisions
- D1 The start branch travels in the existing typed `card.run` command (ADR-0010) as an optional field; an older runner ignores it and launches as today [Unknown: whether `card.run` already carries a base/branch field the slot can reuse — the slot reads packages/shared/src/protocol/commands/cards.ts and decides; a new field needs the protocol doc row].
- D2 After the round starts from `takenBranch`, the card's branch becomes `takenBranch` and `takenBranch` is cleared, so a later Run continues the same branch.

## Acceptance criteria
- [ ] Run of a session-gone taken card whose `takenBranch` exists on origin starts the card worktree on that branch (runner test with a git fixture).
- [ ] Without a pushed `takenBranch`, Run behaves as today and the launch event says why.
- [ ] After that Run, the card's branch is `takenBranch` and `takenBranch` is null (api e2e).
- [ ] A runner older than the field launches as today (protocol test).

## Parallel plan
| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i854 | the launch from takenBranch, api and runner | apps/api/src/board/board-rounds.service.ts, apps/api/src/board/launch-choice.ts, apps/api/src/board/board-launch.e2e.spec.ts, apps/api/src/board/board-rounds.e2e.spec.ts, packages/shared/src/protocol/commands/cards.ts, apps/runner/src/cards/**, apps/runner/src/launch/**, apps/runner/src/git/**, docs/architecture/runner-protocol.md | — | yes | opus |

One slot: the protocol field, its API use and the runner's worktree choice must agree; splitting them buys nothing for a change this size.

## Risks
- Medium — a runner that cannot fetch `takenBranch` (credentials) would fail the launch; mitigation: fall back to today's launch and say so.
