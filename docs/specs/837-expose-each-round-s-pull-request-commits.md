# C-331: Expose each round's pull request, commits and CI in CardRoundView

Issue: #837

## What to do
`CardRoundView` (`packages/shared/src/board/contracts.ts`) carries no pull-request data per round, and `BoardCardRound` in `apps/api/prisma/schema.prisma` stores none. Add to each round the pull request it pushed to (number, URL), the head commit SHA (and commit count) it left, and that commit's CI state (pending / passed / failed, with a link to the checks), so the card detail can show them per round. Record the PR and head SHA when the round finishes (from the runner's report / the card's PR tracking already used for `pullRequests`), and derive CI state from the existing CI tracking for that SHA. Schema change through `prisma migrate dev` with a descriptive name; new fields are optional/null in the shared contract so older fixtures stay valid.

## Acceptance criteria
- [ ] A finished round that pushed to a PR returns `pullRequest`, `headSha` and `ci` in `GET` card detail; a round that pushed nothing returns null for them.
- [ ] CI state updates for the round's head SHA as checks complete.
- [ ] Rounds recorded before the migration return null without errors.
- [ ] Shared contract fields are optional and documented with the issue number, matching the style of `CardRoundView`.
- [ ] API specs (`*.spec.ts`) cover recording and returning the fields.
- [ ] `bun run check` passes.

## Out of scope
- Showing the fields in the UI (the round item card).
- Backfilling PR/CI data for old rounds.
- Reading the project filesystem from the control plane (ADR-0001).

## Open questions
- If a round pushed several commits, which CI state to show? Default: the state of the round's last pushed commit.
