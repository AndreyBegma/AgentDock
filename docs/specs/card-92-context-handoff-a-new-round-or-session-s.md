# C-92: Context handoff: a new round or session starts in context, at the cheapest cost

## What to do
Implement issue #449 — spec `docs/specs/449-context-handoff.md`, ADR-0041. Run by the orchestrator as a wave of 4 slots in 3 waves (lead i449-contract), after the #445 and #447 slots it shares files with. This card tracks it.

## Acceptance criteria
- [ ] Every slot of #449 merged; #449 closed.
- [ ] Runner released with the handoff lifecycle and restart decision, and installed.
- [ ] Live check: stop a card, come back after the cache is cold, Run — the round starts fresh from the note and the card shows `resumed from handoff · saved ≈ $x`; a terminal session in the card worktree starts with the note.

## Out of scope
- Fleet slots (plugin).
