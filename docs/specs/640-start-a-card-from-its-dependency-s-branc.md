# C-267: Start a card from its dependency's branch when that PR is not merged

Issue: #640

## Status
Superseded by #636 ([ADR-0064](../adr/0064-a-dependent-card-branches-from-its-dependency-with-a-stacked-pr.md)),
which merged first and implements the same start from the one unmerged
dependency's branch. #640's own implementation was dropped in favour of
it. Where they differ, #636's decisions stand: the pull request is stacked
into the dependency's branch and moved onto the base when the dependency
merges, and a Run with two or more unmerged dependencies is refused
(`dependencies_unmerged`) instead of starting from the base.

## What to do
A board card's round always branches from the project base (`project.base` in `apps/api/src/board/board-work.ts`). When a card depends on a card whose pull request is open but not merged, the agent works without the code it depends on.

When a card starts its first round, pick its base like this:
- Among its dependencies (`board_card_dependencies`), find those whose pull request is not merged (card has `branch` / `prNumber` and the PR is not seen merged).
- **Exactly one** such dependency: the card branches from that dependency's `branch` (fetched from origin by the runner through its existing typed command; the control plane never touches the filesystem, ADR-0001 / ADR-0010).
- **None**: the project base, as today.
- **Two or more**: the project base, and the round's start note / activity says which dependencies' code the agent will not see.
- The card's pull request targets the project base.
- Store the chosen base on the card or round so the card sheet shows "Based on C-13 (feat/…)" and later rounds reuse it.
- Record the decision as a new ADR.

## Acceptance criteria
- [ ] A card whose only dependency is Finished with an open, unmerged PR starts on a branch created from that dependency's branch; its commits include the dependency's commits.
- [ ] A card whose dependencies are all merged starts from the project base as before.
- [ ] A card with two or more unmerged dependencies starts from the project base and the start note names those dependencies.
- [ ] The card sheet shows the base the card was started from.
- [ ] Feedback rounds on the card keep the original base and do not re-branch.
- [ ] The pull request targets the project base.
- [ ] Api specs cover the base selection for zero, one and several unmerged dependencies.
- [ ] A new ADR records the decision.

## Out of scope
- When Run is allowed or blocked (a separate card).
- Merging several dependency branches into one base.
- Rebasing a dependant automatically when its dependency's branch changes or merges.

## Open questions
- Several unmerged dependencies. Default: branch from the project base and name the missing dependencies in the start note.
- Pull request target. Default: the project base, not the dependency's branch (no stacked PRs).
