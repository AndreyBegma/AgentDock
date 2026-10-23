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

## Out of scope
- Force-pushing or rewriting history.
