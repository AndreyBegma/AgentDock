# ADR-0063: A dependent card branches from its dependency's branch with a stacked pull request

Status: accepted · Date: 2026-10-19 · Amends [ADR-0029](0029-accepting-a-board-card-may-merge-its-pull-request-through-the-runner.md) ·
Card: C-268 · Issue: #636 ·
Spec: [`docs/specs/636-branch-a-dependent-card-from-its-depende.md`](../specs/636-branch-a-dependent-card-from-its-depende.md)

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
