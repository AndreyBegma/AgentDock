# ADR-0086: A card PR is read only once GitHub shows the head the round pushed

Status: accepted · Date: 2026-10-23 ·
Issue: [#895](https://github.com/AndreyBegma/Nautelle/issues/895) ·
Spec: [`docs/specs/895-push-a-card-round-s-local-merge-commit-a.md`](../specs/895-push-a-card-round-s-local-merge-commit-a.md)

## Context

On 2026-10-23 C-346's `ci_fix` round merged `origin/develop` into its branch to resolve a conflict on PR #889. The runner pushed the merge commit `881c209e` at 17:18:20Z, 15 seconds after it was made: the main checkout's reflog for `refs/remotes/origin/feat/886-…` records "update by push". GitHub's PR, however, still showed the old head `d97806dc` until about 17:32. At 17:31 the orchestrator pushed the branch by hand; the push changed nothing, and its own transcript says the branch was already at `881c209e` and the PR had not caught up.

At about 17:21 Nautelle read `card.checks` for the PR. The answer was the old head `d97806dc`, whose checks were green, and the card moved to Finished. Issue #895 read this as "collect does not push a merge commit". The runner does push it: `card.collect` and the mid-round push both count `origin/<base>..HEAD`, and a merge commit counts.

The defect is on the API side. `BoardShipping` took the PR GitHub reported as the head the card's latest round left, although that round had pushed another head (`round.headSha`, #837). It could finish, fix or merge a card on checks and mergeability that belonged to the commit the round replaced. With auto-merge on, it would also refuse the round as `round_pushed_nothing` (#542), because the PR's head was the round's `startHeadSha`.

## Decision

1. **A PR behind the round's push is not read.** When `card.checks` answers an open or draft PR whose head is the latest round's `startHeadSha`, while that round recorded a different `headSha`, the API stores nothing and decides nothing. There is no `ci_fix` round, no move to Finished, no auto-merge and no `needsPerson`. The card stays In progress with no active round, so the PR poll (`CARD_CI_POLL_MS`) reads it again.
2. **The wait is bounded.** It lasts `CARD_PR_HEAD_LAG_MS` (30 minutes) after the round ended. A PR still at the old head after that is taken as it is: the branch was moved back, and the existing rules apply (#542 `round_pushed_nothing` with auto-merge on).
3. **A PR at any other head is read as before.** A third head is someone else's push, and checks for it are read normally.

## Consequences

- A card no longer ships on its previous head's CI while GitHub lags behind a push. A lag costs up to one poll interval after GitHub catches up.
- A PR whose head never reaches the pushed commit waits 30 minutes before the old head is judged. Nothing marks the card during that wait; the API log names the PR and both heads.
- Merged and closed PRs are still read at once: neither depends on which head GitHub shows.
- Fleet PRs (`source: fleet`) are watched by the cs-orchestrator, outside this repository.
