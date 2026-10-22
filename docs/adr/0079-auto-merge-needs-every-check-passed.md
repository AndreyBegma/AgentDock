# ADR-0079: Auto-merge needs every check passed, and `docker/` is a protected path

Status: accepted · Date: 2026-10-22 ·
Card: C-182 (security audit 2026-10-16, findings DA-03, L-31 and decision D-12) ·
Spec: [`docs/specs/card-182-security-medium-auto-merge-a-card-pr-onl.md`](../specs/card-182-security-medium-auto-merge-a-card-pr-onl.md)

## Context

The board merges a finished card's pull request on its own when the project's auto-merge is on (ADR-0035 D7), and since #359 that merge runs from the API's poller with no person present. The poller decided "green" with `cardCiStateOf`, which ignores cancelled and skipped checks: a head with one passed check and one cancelled check was green and merged. A head with no checks at all, read twice, shipped too in a project whose CI had never reported on a card (#484, ADR-0043) — so a repository without CI, or a pull request that kept its CI from running, was merged without any check. ADR-0077 held back cards that change CI, deploy and plugin files, but its list left out `docker/`, whose images CI builds and deploys run.

## Decision

1. **Every check passed.** Auto-merge ships a head only when `cardCiMergeable(checks)` holds: at least one check, and every check in the `pass` bucket. No checks, a cancelled check, a skipped check, a pending or a failed one is not enough. `gh pr checks` does not say which checks are required, so "every check passed" is the rule; it covers the required ones.
2. **The CI state stays as it was.** `cardCiStateOf` still ignores cancelled and skipped checks: it drives the CI dot, the move to Finished and the `ci_fix` rounds, and a fix round for a cancelled check would spend a worker on nothing. Only the merge asks for more.
3. **A refused head needs a person.** When auto-merge would run but the checks are not all passed, the card gets `needsPerson` with the new reason `ci_not_green`, audited as `card.auto_run_failed`, as a #542 refusal is. It stays in Finished; the poller stops reading it, and the card shows "Not every check passed; not merged". Accept still merges it — the person decides.
4. **A project without CI** still moves a finished card to Finished on a head with no checks (ADR-0043), but never auto-merges it: it is refused with `ci_not_green`.
5. **`docker/` is protected.** `PROTECTED_PATHS` gains `docker/`, and `.github/CODEOWNERS` names it, so a card push that changes it is reported in `protectedPaths` and waits for a person whatever the CI says (ADR-0077 item 5).

## Consequences

- A project whose CI cancels or skips a check on every pull request — a job filtered by a condition, for example — no longer auto-merges; a person accepts each card, or the CI stops reporting the skipped check.
- A project without CI never auto-merges a card.
- The runner reports `docker/` paths only from the release that carries this list; an older runner keeps the old list.
