# C-299: A stacked card can ship into a dependency branch that already merged

Issue: #709

## What happens
On 2026-10-20 C-282 (stack S-7) was started right after C-281's PR #695 had been merged into develop by hand. The Board had not seen that merge yet (its `mergedAt` comes from the PR poll), so the round stacked C-282 on C-281's branch (`prBase = feat/694-…`, ADR-0064 / #636). C-282's PR #697 opened into that branch, went green, and was merged there — after C-281's branch had already landed. The navigation change never reached develop and staging kept the old navigation; it took a manual PR (#706, `feat/696…` → develop) to land it. The four S-7 page PRs (#701–#705) were then stacked on C-282's branch and had to be retargeted by hand.

Earlier the same day C-278 (stack S-6) reached Completed with no PR and its branch never reached develop (`prTarget.branch` = the dependency's branch); a manual PR (#684) landed it.

## What to do
- **Decide the stack base from GitHub, not only from `mergedAt`.** When a round starts on a card whose dependency has a PR, ask the runner for that PR's live state; if it is merged (or closed), branch from the project base and open the PR into it.
- **Never let a stacked PR merge into a branch whose own PR already merged.** Before the Board's auto-merge of a stacked card, and in the PR poll, retarget first if the dependency merged; if a stacked PR was merged into a dead branch anyway (merged by a person on GitHub), detect it (`mergedAt` set, base ≠ project base, dependency merged earlier) and open a forward PR `<card branch> → <project base>` automatically, flagging the card `needsPerson` if that PR conflicts.
- **Completed means landed.** A card with commits ahead of the project base must not reach Completed without a PR merged into the project base (C-278). Accepting such a card asks for confirmation and names the missing landing.
- Show the PR target on the card sheet prominently when it is not the project base ("into C-281's branch") and warn when that branch's PR is already merged.

## Acceptance criteria
- [ ] Starting a stacked card whose dependency PR merged on GitHub (but not yet seen by the poll) opens its PR into develop. API e2e covers it with a stubbed runner reply.
- [ ] A stacked PR merged into a dead dependency branch gets a forward PR into develop opened automatically. API e2e covers it.
- [ ] A card whose branch is ahead of develop cannot be accepted into Completed without a landed PR unless the person confirms. API e2e and web test cover it.
- [ ] The card sheet warns about a merged dependency branch as the PR target. Web test covers it.
- [ ] ADR-0064 records the rules; `bun run check` passes.
