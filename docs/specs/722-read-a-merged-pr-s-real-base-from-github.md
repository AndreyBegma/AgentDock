# C-303: Read a merged PR's real base from GitHub, not the stored stack base

Issue: #722

## What happens
On 2026-10-20 the S-7 page cards (C-283, C-284, C-286, C-287, C-288) and C-293/C-294 had PRs opened into C-282's branch (`prBase = feat/696-…`). Those PRs were retargeted to `develop` on GitHub by hand (`gh pr edit --base develop`) and merged there, so their code is in develop. The Board still stores `prBase = feat/696-…` and `prTarget.branch` shows it; with the C-299 rule "Completed means landed", running C-295 (which depended on them) was refused with `dependencies_unmerged` ("C-283, C-284, C-286, C-287, C-288, C-293 are not merged yet").

## What to do
- When the PR poll or a merge sees a card's PR, read the PR's actual `baseRefName` from GitHub (the runner's `card.checks`/PR state reply) and store it: if it is the project base, clear `prBase`/`prBaseCardId` (and record an audit `card.pr_retargeted` with `by: github`).
- A dependency counts as landed when its PR merged into the project base according to GitHub, whatever the stored base said.
- Backfill: on deploy, recompute the base of every card with a merged PR and a non-null `prBase`.

## Acceptance criteria
- [ ] A stacked card whose PR is retargeted to develop on GitHub and merged there counts as landed; a dependent card runs. API e2e covers it with a stubbed runner reply.
- [ ] The card sheet shows the real target after a manual retarget. Web test covers it.
- [ ] The backfill fixes existing cards (C-283…C-294 on this Board). Covered by an API e2e of the backfill.
- [ ] `bun run check` passes.
