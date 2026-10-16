# C-85: Mark a card ready when its dependencies are accepted, with optional auto-run

Issue: #443

## What to do
Cards can already depend on other cards (`BoardCardDependency`, set by hand in `apps/web/src/components/board/card-dependencies.tsx`). Today Run only warns about an open dependency (ADR-0034). Add readiness on top of that:

- A card in To Do with at least one dependency is **ready** when every card it depends on is accepted (its PR merged, ADR-0029/ADR-0035), and **waiting** otherwise. The API computes this and exposes it on the board card view. The card face (`card-face.tsx`) shows a Ready / Waiting badge, and the card sheet lists what it still waits for.
- Add a per-card switch, **Auto-run when ready** (off by default), on the card sheet or its options (`card-options.tsx`). When the last open dependency of a card with the switch on is accepted, the API starts the card's Run as if the person had pressed it. It respects the project's slots and budget: if no slot is free, the card is queued and starts when one frees up, or the Run is refused with a visible reason that matches what a manual Run would do.
- Record the automatic start in the card's activity, showing that the auto-run started it.

## Acceptance criteria
- [ ] A card whose dependencies are all accepted shows Ready, and one with an open dependency shows Waiting with the open ones listed.
- [ ] Readiness updates on the board without a reload when a dependency is accepted (same live update path as other card changes).
- [ ] With Auto-run on, accepting the last open dependency starts the card's Run exactly once, even if acceptances arrive concurrently.
- [ ] With Auto-run off, nothing starts and the manual Run behaves as today.
- [ ] An automatic start that cannot run (no slot, budget) behaves the same as a manual Run in that state and is visible on the card.
- [ ] The switch needs a schema migration created with `prisma migrate dev` and is covered by API tests, including the concurrency case.

## Out of scope
- Creating dependencies automatically (the intake still never writes them in this card).
- Stacks or stages.
- Blocking a manual Run on open dependencies; it keeps warning as today.

## Open questions
- What counts as accepted for a card with several PRs. Default: the card is in Done (accepted), regardless of how many PRs it had.
- Behaviour when no slot is free. Default: use whatever a manual Run does in that state; do not add a new queue.

## Migration name
Name the schema migration exactly `20261201000000_card_auto_run` (create it with `prisma migrate dev --create-only --name ...` and rename the folder if needed). The repository's migrations use fixed future timestamps; the newest on develop is `20261129000000_card_round_background`. Another card (C-84) runs in parallel and owns `20261130000000_design_frames` on a different table.

## Decisions taken in the build
- **Accepted** is the dependency's column: in Completed, however many PRs it had. Readiness exists only for a card in To Do with at least one dependency (`cardReadiness`, shared); the API sends it on every card view as `readiness`.
- **Exactly once.** The switch is consumed: one conditional `UPDATE` turns `autoRunWhenReady` off only while the card is in To Do with the switch on and no open dependency. Every acceptance tries it after its own commit, so the last to commit sees every dependency accepted, and of racing acceptances the row lock lets one through.
- **No new queue.** The automatic start is the manual Run (`BoardRoundsService.run`) as the person who accepted the dependency; a refusal (`max_running`, `budget_exceeded`, a profile, …) is stored on the card like a refused design auto-run (`autoRunError` / `autoRunMessage` / `autoRunFailedAt`, plus `autoRunAfter`) and audited as `card.auto_run_failed`. The person presses Run once it is fixed.
- **Only acceptance fires it.** Turning the switch on for a card that is already ready, or removing its last open dependency, starts nothing.
- The round the auto-run started stores `autoRunAfter` (the accepted dependency's number); the card's Rounds show it as Auto-run.
