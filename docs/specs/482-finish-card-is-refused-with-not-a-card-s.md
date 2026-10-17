# C-205: finish_card is refused with not_a_card_session after the runner restarts mid-round

Issue: #482

## What happened
On 2026-10-16 the runner unit was restarted at 18:27 (upgrade to 0.12.1) while card C-194 (#473) had a round running. When the worker later called `finish_card`, the local socket refused it with `not_a_card_session`. The round stayed in **waiting** until the orchestrator told the worker to call it again; the second call succeeded.

## Expected
A card session started before a runner restart is still recognised afterwards. The runner rebuilds its session-to-card map from the persisted round records and tmux on start. A `finish_card` that is refused shows the reason on the card (needs attention) instead of leaving it silently waiting.

## Acceptance criteria
- [ ] Runner test: start a card round, restart the daemon (new process, same state dir), and `finish_card` from that session succeeds.
- [ ] A refused `finish_card` surfaces on the card with the reason.

## Notes
Related: #434 (finish_card retry after runner_offline), Steward #447 (silent stall).
