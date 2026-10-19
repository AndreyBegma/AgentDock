# ADR-0063: A card starts from its one unmerged dependency

Status: accepted · Date: 2026-10-19 ·
Issue: [#640](https://github.com/AndreyBegma/AgentDock/issues/640) ·
Builds on [ADR-0034](0034-the-planner-lives-on-the-board-and-makes-cards.md)
(dependencies) and [ADR-0035](0035-a-card-ships-itself.md) (a card's pull
request), within [ADR-0001](0001-control-plane-and-per-machine-runner.md) and
[ADR-0010](0010-typed-command-allowlist-on-the-runner.md)

## Context

A board card's round 1 always created the card's branch from the project's
base. A card often depends on another card (`board_card_dependencies`) whose
pull request is open but not merged yet — it is Finished, waiting for review
or CI. Its dependant then started without the code it was meant to build on:
the worker either rebuilt it or worked around its absence, and both made a
pull request that conflicted with the dependency's.

## Decision

1. **Round 1 picks the branch's start.** Among the card's dependencies, the
   unmerged ones are those with a branch other than the base and a pull
   request that is neither seen merged (`prState merged`, `mergedAt`) nor
   `closed`. A closed pull request is abandoned work, not code on its way: it
   is neither a start nor missing. An unknown state counts as open.
   - **None**: the project's base, as before.
   - **Exactly one**: that dependency's branch.
   - **Two or more**: the project's base. The worker's prompt, the
     `card.run_started` audit record and the card sheet name the
     dependencies whose code the branch does not have. Merging several
     branches into one start is not done: it is a merge the worker would have
     to resolve before its own work, on code nobody has approved yet.
2. **The runner creates the branch.** `card.run` gains an optional
   `startFrom` ref: where the runner creates `branch` (it exists neither
   locally nor on origin), it fetches `origin/<startFrom>` and branches from
   it instead of `origin/<base>`. The control plane names a ref; it never
   reads or writes the repository (ADR-0001), and the command stays typed
   (ADR-0010). The field is sent only to a runner that advertises
   `cardStartFrom`; with an older runner the card starts from the base and
   the one dependency is named as missing.
3. **The pull request targets the project's base**, never the dependency's
   branch: no stacked pull requests. `base` in `card.run` keeps its meaning —
   what the draft pull request targets and what "ahead" is counted against.
   The card's pull request therefore shows the dependency's commits too until
   the dependency merges.
4. **The start is fixed with the branch.** `board_cards.startBase`,
   `startCardNumber` and `startMissing` are written by round 1 and read by
   every later round, which sends the same `startFrom` (a feedback, Continue
   or CI-fix round never re-branches: the branch exists). A follow-up after
   the card's own merge starts from the base (ADR-0035) and resets them. The
   card sheet shows "Based on C-13 (feat/…)" or "Based on develop", and the
   missing dependencies under it. A card started before this has no start.

## Consequences

- A dependant works on the dependency's code from its first commit and its
  pull request merges cleanly after the dependency's.
- Until the dependency merges, the dependant's pull request also lists the
  dependency's commits; a reviewer reads the dependant's own commits.
- When the dependency's branch changes after the dependant started, the
  dependant is not rebased; when the dependency merges, the dependant's pull
  request shows only its own commits. Rebasing automatically is out of scope.
- Whether Run is allowed while a dependency is open is unchanged.
