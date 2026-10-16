# C-88: Token saver: compress what agents read, keep what people read

## What to do
Implement issue #445 — spec `docs/specs/445-token-saver.md`, ADR-0039. Run by the orchestrator as a wave of 8 slots in 3 waves (lead i445-contract); this card tracks it and moves to Finished when the wave has merged and the runner release with `filter-hook` is installed.

## Acceptance criteria
- [ ] Every slot of #445 merged; #445 closed.
- [ ] Runner released with `filter` / `filter-hook` and installed.
- [ ] On a live card with Token saver on, the card shows `saved ≈` and the person-facing artifacts are complete.

## Out of scope
- Fleet slots (plugin follow-up issue).
