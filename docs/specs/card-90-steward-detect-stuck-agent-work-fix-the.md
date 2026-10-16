# C-90: Steward: detect stuck agent work, fix the safe cases, tell the person in one line

## What to do
Implement issue #447 — spec `docs/specs/447-steward.md`, ADR-0040. Run by the orchestrator as a wave of 5 slots in 3 waves (lead i447-contract), after the #445 slots it shares files with. This card tracks it.

## Acceptance criteria
- [ ] Every slot of #447 merged; #447 closed.
- [ ] Runner released with the Steward observers and commands, and installed.
- [ ] Live check: a card hit by an API error is nudged and continues; a killed card session is resumed; the digest arrives.

## Out of scope
- Chat assistant, team roles (cloud version).
- Carrying context between rounds (separate spec).
