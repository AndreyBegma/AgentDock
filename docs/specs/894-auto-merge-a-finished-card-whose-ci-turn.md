# C-360: Auto-merge a Finished card whose CI turns green after it finished

Issue: #894

## What happens
A card whose round finishes while its PR's CI is still pending (or `none`) moves to Finished, and when CI later turns green the Board never auto-merges it. The card sits in Finished with a green, `CLEAN` PR until someone merges by hand. Seen on 2026-10-23: C-346 (PR #889) and C-351 (PR #892), both merged manually by the orchestrator. Cards that finish with CI already green auto-merge correctly (#864, #869, #871, #878, …).

## Expected
Auto-merge (ADR-0035, ADR-0080) is driven by the PR's CI state, not by the moment the round finished: when the checks poller sees a Finished card's PR go green and `mergeStateStatus` is `CLEAN`, it applies the same auto-merge decision it applies at finish time (merge policy, protected paths, `needsPerson`, attribution checks — unchanged).

## Where to look
`apps/api/src/board/board-shipping.ts`, the checks poller that updates `ciState`, and the finish path in `board-rounds.service.ts`.

## Acceptance criteria
- [ ] A card that enters Finished with CI pending is auto-merged once its CI turns green, under the same conditions as a card that finishes green.
- [ ] A card that enters Finished with CI pending and then goes red gets the existing `ci_fix` round, as today.
- [ ] Cards whose auto-merge is off, or that need a person (protected paths, `.woodpecker/**`), are still not merged.
- [ ] A merge is attempted at most once per head SHA; a PR that becomes `BEHIND`/`DIRTY` is not merged.
- [ ] e2e spec (next to `board-ships.e2e.spec.ts`) covers: finished-pending → green → merged; finished-pending → red → ci_fix; auto-merge off → not merged.
- [ ] `bun run check` passes.

## Out of scope
- Changing the merge policy or its conditions.
