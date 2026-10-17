# C-136: Security [Low]: Bound runner-to-server strings and arrays in shared contracts

> Security audit 2026-10-16 · **WI-34** · severity **Low** · size **M** · findings: L-04 (Z9 L2, Z9 P2-08 L2, Z3 F8, Z3 P2-1)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-04.** Runner-to-server strings and arrays are bounded only by the frame size (`maxPayload: MAX_EVENTS_BATCH_BYTES * 2`, `apps/api/src/runners/runner.gateway.ts:264`). `messages.ts` caps the event count (`packages/shared/src/protocol/messages.ts:62`) but not the hello, heartbeat or `error.message` strings; `envelope.ts:40` takes `slot: z.string().min(1)` without `slotNameSchema`; `pairing.ts`, `events/fleet.ts`, `events/queue.ts`, `events/hooks.ts`, `commands/approvals.ts` and `commands/github.ts` have unbounded stored strings. The API stores and projects them (`apps/api/src/fleet/slot-projection.ts`).

**Attacker.** A compromised or buggy runner.

**Scenario.** A runner sends very long slot names, messages or arrays that are stored, indexed and rendered.

**Impact.** Database bloat and slow pages; UI breakage.

## Fix
- Add a shared `boundedText(max)` helper.
- Add `.max()` to the stored strings and arrays in `messages.ts` (hello, heartbeat, `error.message` 1000), `pairing.ts`, `envelope.ts` (slot through `slotNameSchema`), `events/fleet.ts`, `events/queue.ts`, `events/hooks.ts` (`gitBranch` charset), `commands/approvals.ts` and `commands/github.ts`.
- The slot projection skips fleet events whose slot fails `slotNameSchema`.

## Acceptance criteria
- Schema tests: each bounded field rejects max+1 and accepts max
- A projector test ignores an event with a 200 KiB slot name
- Existing protocol fixtures still parse

## Touches
- packages/shared/src/protocol/**
- apps/api/src/fleet/slot-projection.ts

## Decision
none needed

## Must not run in parallel with
- WI-33
- WI-35
- WI-37


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
