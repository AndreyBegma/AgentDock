# ADR-0029: Accepting a board card may merge its pull request through the runner

Status: accepted · Date: 2026-10-15 · Amends
[ADR-0024](0024-board-cards-and-dedicated-card-workers.md) §6 ·
Issue: [#273](https://github.com/AndreyBegma/AgentDock/issues/273)

## Context

A board card ([ADR-0024](0024-board-cards-and-dedicated-card-workers.md))
ends in Finished with a pull request into the project's base, opened by
`card.collect` with `Closes #n` and an `AgentDock-Card: C-n` marker. ADR-0024
§6 says that only a person moves a card to Completed, and that doing so
"closes the worker and removes the worktree, and never merges".

The UX review of 2026-10-15 found that Accept therefore only moves the card:
the person then has to open GitHub, merge the PR, and close the issue by hand
— because `Closes #n` closes an issue only when a PR merges into the
repository's **default** branch, and cards target `project.base` (often
`develop`, not `main`). The product owner decided that Accept may merge.

Every write AgentDock makes to GitHub goes through the runner's `gh`
([ADR-0004](0004-github-issues-are-the-task-queue.md); spec 27 D4 keeps the
GitHub App read-only), the control plane never reads a project's filesystem
([ADR-0001](0001-control-plane-and-per-machine-runner.md)), and the runner
accepts typed commands only
([ADR-0010](0010-typed-command-allowlist-on-the-runner.md)).

## Decision

1. **A person's Accept may merge the card's PR.** The accept dialog offers
   *Merge pull request* when the card's PR is open and the runner serves the
   command, and *Accept without merging*, which keeps ADR-0024's behaviour
   exactly (move only; PR and issue untouched). Automation still never
   completes a card, and never merges one.
2. **The merge is a typed runner command, `card.merge`** (operator, 90 s): a
   strict object `{ cardId, projectId, root, pr, headSha, method, issue,
   comment }`. The runner checks `root` against the watched project and runs
   `gh pr merge <pr> --<method> --match-head-commit <headSha>` against the
   project's GitHub repository, with an argument array, never a command text.
   The merge is bound to the head the person saw in the dialog: a moved head
   is refused (`head_changed`) without merging.
3. **The method is the project's own.** `orchestrator.mergeMethod`
   (`merge | squash | rebase`) from the project's code-sentinel config — the
   setting the fleet merges with. When it is absent or invalid the API sends
   `method: null`, and the runner takes the repository's first allowed method
   in GitHub's button order: merge → squash → rebase.
4. **The card's issue is closed by the runner** after the merge, when it is
   still open: `gh issue close <n> --reason completed --comment "Completed as
   C-n on the AgentDock board; merged in #<pr>."`. A failed close does not
   undo the accept; the response says `issueClosed: false`. An already merged
   PR is not an error (`alreadyMerged`), and its issue is closed the same way.
5. **A refused merge is a result, not a command error**
   (`{ merged: false, error: head_changed | not_mergeable | closed | gh_failed,
   message }`); the API answers 409 `merge_failed` with that `reason`, and the
   card stays in Finished. Only on success does the card move to Completed,
   which schedules `card.close` as before.
6. **The branch is not AgentDock's to delete.** No `--delete-branch`: the
   worktree holds the branch until `card.close`, and the repository's own
   auto-delete setting applies.

## Alternatives rejected

- **Merging with the GitHub App's installation token on the server.** Spec 27
  keeps the App read-only; it would be the first server-side GitHub write and
  would bypass the runner's `gh`, which is the one identity AgentDock writes
  to GitHub as (ADR-0004).
- **Signalling the orchestrator to merge** (spec 20's approval queue). Cards
  are outside the fleet (ADR-0024 §4): no slot, no brief, no orchestrator that
  watches them. Routing a card's merge through it would couple the board to
  the fleet's protocol for a PR the fleet never opened.
- **Relying on `Closes #n`.** It does nothing when the base is not the
  repository's default branch, which is the common case for cards.

## Consequences

- ADR-0024 §6 now reads: only a person moves a card to Completed; that closes
  the worker and removes the worktree, and — when the person chose *Merge
  pull request* — first merges the card's PR through the runner and closes
  its issue.
- A merge from the board bypasses the fleet's approval queue. It is a
  person's explicit action, bound to the head they saw; GitHub's branch
  protection and required checks still apply (`not_mergeable`).
- A runner without `card.merge` (older than this change) is detected by its
  advertised commands (ADR-0023); the dialog offers *Accept without merging*
  only.
- Three audit actions: `card.merged`, `card.merge_failed`,
  `card.auto_run_failed` (the last from the same issue's approve-and-continue
  change).
- The same change makes each round store the card text its prompt was built
  from (`board_card_rounds.cardTitle`, `cardBody`, `cardKind`), so edits reach
  the next round's prompt; rounds that existed before the migration are
  backfilled from the card's text at migration time, so edits made before it
  are not sent.
