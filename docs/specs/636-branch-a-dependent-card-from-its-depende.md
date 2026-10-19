# C-268: Branch a dependent card from its dependency's branch with a stacked PR

Issue: #636

## What to do
Today every board card's worktree and pull request are cut from the project base (`base = baseOverride ?? baseBranch` in `BoardWork.project()`, `apps/api/src/board/board-work.ts:277`, passed as `base` to `card.run` in `apps/api/src/board/board-rounds.service.ts` ~573/625). Dependencies (`BoardCardDependency`, written per stage by `stageLinks` in `apps/api/src/board/board-stacks.ts:139-160`) never affect the branch. So in a stack C-1 → C-2, C-2 is built from `develop` without C-1's code.

Change how the base for a card's Run is chosen:
- **No open dependency, or every dependency merged:** base is the project base, as today.
- **Exactly one open dependency whose round has a pushed branch and an open PR:** base is that dependency's branch. The runner already cuts the worktree from `origin/<base>` and opens the PR with `--base <base>` (`apps/runner/src/cards/git.ts`, `apps/runner/src/cards/push.ts`), so passing the dependency's branch produces a stacked PR. Store the chosen base on the card so later rounds and the UI use it.
- **More than one open dependency:** the card is not runnable until all of them are merged into the project base, then it branches from the base. `assertRunnable` (`apps/api/src/board/board-dependencies.service.ts:155`) must report this as a distinct reason. The person's `ignoreDependencies` override still starts it from the project base.

When a dependency's PR is merged (`card.merged`, ADR-0029), retarget every open dependant PR stacked on it to the project base through a new typed runner command (ADR-0010; the control plane never runs git itself, ADR-0001). Record the dependant's base as the project base from then on. A follow-up round of a dependant whose dependency has merged starts from the updated base, as follow-up rounds do today.

The card page and the stack page show the PR's actual target ("into C-1's branch" vs the base).

## Acceptance criteria
- [ ] In a stack C-1 → C-2 where C-1 has an open PR, running C-2 cuts its branch from C-1's branch and opens C-2's PR with base = C-1's branch (it no longer branches from `develop`).
- [ ] A card with no dependencies, or whose dependencies are all merged, still branches from and targets the project base.
- [ ] A card with two or more unmerged dependencies is refused by `assertRunnable` with its own reason until all are merged, then branches from the project base. `ignoreDependencies` starts it from the project base.
- [ ] A card whose single dependency has no pushed branch or PR yet is refused as not ready, as today.
- [ ] Merging C-1's PR retargets C-2's open PR to the project base through a typed runner command, and C-2's stored base is updated.
- [ ] The card and stack pages show which branch each card's PR targets.
- [ ] API tests cover base selection for zero, one (open PR / merged) and several dependencies, and retarget on merge. A runner test covers the retarget command.

## Out of scope
- The "Run stack" button and any run queue.
- Merging several dependency branches into one card's branch.
- Changing how dependencies or stages are created.
- Orchestrator fleet issues outside the Board.

## Open questions
- Does a stacked card need its dependency to be accepted (Completed), or only to have an open PR? Default: an open PR from a finished round is enough.
- What if the dependency's branch gets new commits after the dependant started? Default: nothing automatic; the dependant's next round rebases onto the current dependency branch.
