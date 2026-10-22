# ADR-0077: Runner pushes follow a branch policy, and a change to a protected path needs a person

Status: accepted · Date: 2026-10-22 ·
Card: C-148 (security audit 2026-10-16, WI-46, finding L-31 and decision D-12; the audit calls the decision "ADR-0045") ·
Spec: [`docs/specs/card-148-security-low-enforce-a-branch-policy-for.md`](../specs/card-148-security-low-enforce-a-branch-policy-for.md)

## Context

A card, run or skill branch was any valid git ref, so a command could name the repository's default branch, and collect would push the worker's commits to it. Card auto-merge was on unless the base was the default branch, but the API knew the default branch only when the project's base had been read from `origin/HEAD` or `gh`; for a configured base it guessed from the names `main` and `master`. A repository whose default branch is `trunk`, with base `trunk`, therefore shipped cards into its default branch without a person.

Fleet and card workers can also change the files that decide what CI, deploys and plugins run — `.woodpecker/`, `deploy/`, `plugins/`, `.claude-plugin/` — and such a pull request was merged on green like any other (D-12). ADR-0053 already treats pull-request pipelines as untrusted; this decision keeps the same files from being merged without a person.

## Decision

1. **Fixed branch prefixes.** A board card's branch starts with `card/`, `feat/` or `fix/` (the issue cards' `feat|fix/<issue>-` of #201 stays valid); a skill run's with `run/`, which the runner checks again before it pushes; a skill install's branch is built by the runner itself (`skillInstallBranch`). The shared protocol schemas refuse a card branch without its prefix, so `card.run {branch: 'main'}` never reaches a runner. A terminal card's collect (`cwd`) pushes the person's own session branch and is exempt from the prefix, not from item 2.
2. **The runner never pushes to the default branch or a protected branch.** Before every card, run and skill-install push the runner asks GitHub for the repository's default branch and whether the target branch is protected, and refuses with the typed failure `branch_refused` when either holds. When GitHub cannot be read the push fails as an ordinary, retryable error: the guard fails closed. The docs publish (`docs/…` branches, schema-constrained) is not guarded.
3. **The API stores the real default branch.** `Project.defaultBranch` is what the last `project.inspect` reported (`gh repo view`, else `origin/HEAD`), refreshed with the project. An older runner's base counts only when it came from one of those sources. Unknown — `null` — means auto-merge defaults to off; the `main`/`master` name rule is gone.
4. **Protected paths.** A fixed list in shared code — `.github/`, `.woodpecker/`, `.woodpecker.yml`, `.woodpecker.yaml`, `deploy/`, `plugins/`, `.claude-plugin/` — not read from the repository, so a branch cannot shorten it. Before a card push the runner diffs the branch against `origin/<base>` and reports the protected paths it changes as `protectedPaths` on the `card.collect` result and the `card_run.pushed` event. It still pushes: a person reviews the pull request.
5. **Such a card is never auto-merged.** The API stores the latest report on the card (`BoardCard.protectedPaths`; an empty list clears it, an absent field from an older runner leaves it) and never auto-merges a card whose list is non-empty, whatever the project's or card's auto-merge setting. The card shows a "Protected paths changed" badge and a sheet banner listing the paths. It does not set `needsPerson`: CI fixes and follow-up rounds still run; only the merge waits for Accept.
6. **CODEOWNERS.** `.github/CODEOWNERS` assigns the protected directories to the repository owner, with a header comment linking this ADR. Requiring that review — branch protection with *Require review from Code Owners* — is a GitHub setting only a person can change (audit P-03).

## Consequences

- Items 1–5 stop the board's own automation. A worker that pushes by itself with `git push`, outside the runner, is not stopped by the runner's guard; the boundary for that is GitHub's branch protection and the required code-owner review of item 6.
- A project whose default branch the runner cannot read (no `gh`, no `origin/HEAD`) no longer auto-merges until an inspection reports it; the person can still switch auto-merge on in the board settings, except for cards that changed protected paths.
- Every card, run and skill-install push costs two extra GitHub API calls.
- Changing the protected list needs a code change in `packages/shared` and a runner release.
