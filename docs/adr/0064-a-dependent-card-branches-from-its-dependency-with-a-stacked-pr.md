# ADR-0064: A dependent card branches from its dependency's branch with a stacked pull request

Status: accepted · Date: 2026-10-19 · Amends [ADR-0029](0029-accepting-a-board-card-may-merge-its-pull-request-through-the-runner.md) ·
Card: C-268 · Issue: #636 ·
Spec: [`docs/specs/636-branch-a-dependent-card-from-its-depende.md`](../specs/636-branch-a-dependent-card-from-its-depende.md) ·
Amended by [ADR-0065](0065-run-waits-for-every-dependency-to-have-a-ready-pull-request.md) (§1: no `ignoreDependencies`; an open dependency is refused first) ·
Amended by C-299 / [#709](https://github.com/AndreyBegma/AgentDock/issues/709) (§5–§7: the base read from GitHub, the forward PR, Completed means landed;
spec [`docs/specs/709-a-stacked-card-can-ship-into-a-dependenc.md`](../specs/709-a-stacked-card-can-ship-into-a-dependenc.md))

## Context

Every Board card's worktree and pull request were cut from the project base.
Card dependencies (#337 D8) and the stages of a stack (ADR-0044) said which
card runs after which, but never touched the branch. In a stack C-1 → C-2,
C-2 was built from `develop` without C-1's code, so its worker could not use
it and its PR conflicted with C-1's.

## Decision

1. **A Run chooses the card's base from its unmerged dependencies.** A
   dependency counts as landed once its PR merged into the project base, or
   once it was accepted with no open PR left. Of the others:
   - none: the card branches from and targets the project base, as before;
   - one with a pushed branch, an open (or draft) PR and no round running:
     the card is cut from that branch and its PR goes into it — a stacked PR.
     An open PR from a finished round is enough; the dependency need not be
     accepted;
   - one without such a PR: 409 `dependency_open`, as before;
   - two or more: 409 `dependencies_unmerged`. A card branches from one
     dependency only; it waits until they are merged and then starts from
     the base.

   `ignoreDependencies` checks nothing and starts the card from the project
   base. The choice is made when a Run opens a new PR; a card that already
   has an open PR keeps its base.
2. **The card stores its base.** `board_cards.prBase` holds the branch and
   `prBaseCardId` the dependency; `null` is the project base. Every later
   round (`card.run`, `card.collect`, a conflict `ci_fix`) uses it, and the
   card sheet and stack page show the target ("into C-1's branch").
3. **Merging the dependency retargets the stacked PRs.** When a card's PR
   merges — Accept's `card.merge` (ADR-0029) or a merge the PR poll finds —
   each open PR stacked on it is moved onto the project base through
   `card.prRetarget`, a typed runner command (ADR-0010) that runs `gh pr
   view` and `gh pr edit --base` with argument arrays; the control plane
   runs no git (ADR-0001). The stored base is then cleared and the move
   audited as `card.pr_retargeted`. A stacked card with no PR and no round
   running is cleared without a command. A retarget the runner could not do,
   and a PR a still-running round opens into the old branch, are retried by
   the PR poll.
4. **A stacked PR is never auto-merged.** Auto-merge (ADR-0035) skips a card
   whose `prBase` is set: its PR would merge into the dependency's branch,
   not the base. It ships once it has been retargeted.
5. **The base is read from GitHub, not only from `mergedAt` (#709).**
   `mergedAt` comes from the PR poll, which can lag a merge made by hand.
   Whenever the Board is about to rely on a dependency being unmerged — a
   Run choosing the base, a later round keeping a stored base, a merge on
   Accept, the PR poll of a stacked card — it reads that dependency's open
   PR live through `card.checks` (which now also returns the PR's `base`
   and `mergedAt`). A PR merged there is recorded as merged on the spot (and
   its stacked PRs retargeted, §3); a closed one counts as no PR, so the
   card starts from the project base. Before Accept's `card.merge` of a
   stacked PR whose dependency has merged, the PR is retargeted first; if
   it cannot be, the merge is refused with `merge_failed` reason
   `base_merged` and nothing is sent to GitHub.
6. **A merge into a dead dependency branch is carried forward.** A stacked
   PR found merged (`mergedAt` set, its base not the project base) at or
   after its dependency's own PR merged never reached the base. AgentDock
   opens a forward PR `<card branch> → <project base>` through `card.prOpen`,
   a typed runner command (ADR-0010) that reuses an open PR of that branch
   into the base or runs `gh pr create`, then reads `mergeable`. The card
   takes the forward PR as its PR (open, CI pending, base cleared), keeps
   the old PR in its PR history, and the move is audited as
   `card.pr_forwarded` with both numbers. A forward PR that conflicts with
   the base marks the card `needsPerson` (`forward_conflict`, also found by
   the PR poll later); one that cannot be opened marks it `forward_failed`.
   GitHub's "no commits between" means the work already landed: the base
   is cleared and nothing is opened. A stacked PR that merged before its
   dependency did lands with it and is left alone. The card's own
   dependants stay stacked until the forward PR merges.
7. **Completed means landed.** Accept without `merge` or `closePr` of a
   card whose work is not in the project base — an open PR, a PR merged
   into a dead dependency branch, a closed PR, or a failed collect with no
   PR — is refused with 409 `not_landed` and one sentence naming the
   missing landing. The person may confirm with `confirmUnlanded: true`;
   the web Accept dialog shows the sentence and offers "Accept anyway".
   Bulk complete sends no confirmation, so such a card is that card's
   `not_landed` error. A PR merged into a dependency branch that is still
   live counts as landed: it reaches the base with the dependency. The card
   sheet shows a stacked target prominently, and warns once that
   dependency's own PR has merged (`prTarget.stackedOn.merged`).

## Consequences

- A stack's later stages build on the code of the earlier ones, and each PR
  shows only its own card's diff.
- New commits on the dependency's branch reach the dependant only when its
  next round merges or rebases onto it; nothing is automatic.
- Merging the dependency with `deleteBranch` deletes the stacked PR's base;
  GitHub retargets or closes such a PR on its own, and `card.prRetarget`
  then finds it already on the base or not open.
- A card with several unmerged dependencies waits; merging several
  dependency branches into one card's branch is out of scope.
- (#709) A Run, a merge and the poll of a stacked card cost one `card.checks`
  call per open dependency PR. A runner that does not serve `card.checks`
  falls back to the stored `mergedAt`, as before; one that does not serve
  `card.prOpen` leaves a dead-branch merge to the person (`forward_failed`).
- (#709) No column records the forward: the audit entry `card.pr_forwarded`
  is what tells the poll that the card's open PR is a forward PR.
