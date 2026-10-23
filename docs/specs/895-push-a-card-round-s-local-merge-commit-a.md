# C-361: Push a card round's local merge commit at collect

Issue: #895

## What happens
When a round's only work is `git merge origin/develop` to resolve a PR conflict, the Board's collect does not push the resulting merge commit. On 2026-10-23, C-346's `ci_fix` round (round 2) merged develop into `feat/886-…` locally (`881c209e`) and the card moved to Finished, but the PR head stayed at `d97806dc` and PR #889 stayed `CONFLICTING` until the orchestrator pushed the branch by hand from the card worktree. Likely cause: collect decides "nothing new to push" from the round's own commits / diff against the base and ignores a merge commit, or treats a round with no non-merge commits as `round_pushed_nothing`.

## Expected
Collect pushes whenever the worktree's branch head is ahead of the remote branch head, including when the only new commit is a merge commit.

## Where to look
The runner's `card.collect` handling (`apps/runner`) and the API side that interprets its result (`board-collect`, `round_pushed_nothing`).

## Acceptance criteria
- [ ] A round whose only new commit is a merge of the base is pushed at collect, and the PR head moves to it.
- [ ] A round with no new commits at all still reports `round_pushed_nothing` and pushes nothing.
- [ ] Runner tests cover merge-only, normal and nothing-new rounds; the API e2e `board-collect` covers the merge-only report.
- [ ] `bun run check` passes.

## Findings
The runner does push a merge-only round. It pushed C-346's merge commit `881c209e` at 17:18:20Z, 15 seconds after the commit, and both the mid-round push and `card.collect` count `origin/<base>..HEAD`, where a merge commit counts. GitHub's PR #889 kept showing `d97806dc` until about 17:32, and the orchestrator's hand push at 17:31 changed nothing. Nautelle read the lagging PR at about 17:21 and finished the card on the old head's green checks. The person rescoped the card to that defect: the API waits while GitHub shows the head the round started from instead of the head it pushed ([ADR-0086](../adr/0086-a-card-pr-is-read-only-once-github-shows-the-pushed-head.md)).

## Added acceptance criteria
- [ ] While GitHub shows a card's PR at the head its latest round started from, and the round pushed another head, the API does not fix, finish or merge the card on that PR's checks or mergeability. API e2e tests cover it.

## Out of scope
- Force-pushing or rewriting history.
