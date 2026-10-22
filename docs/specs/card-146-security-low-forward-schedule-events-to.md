# C-146: Security [Low]: Forward `schedule.*` events to outbound webhooks only when the API emitted them

> Security audit 2026-10-16 · **WI-44** · severity **Low** · size **S** · findings: L-16 (Z2 INT-04)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-16.** The outbound dispatcher forwards every event whose type is a webhook event type (`apps/api/src/webhooks/outbound/webhook-dispatcher.ts:160-165`) without checking its source. `schedule.*` types are API-originated (ADR-0014), but a runner can write an event with the same type into `events`.

**Attacker.** A compromised or misbehaving runner.

**Scenario.** The runner reports a `schedule.disabled`-typed event; subscribers receive it as if the API had disabled a schedule.

**Impact.** Forged notifications to external systems that act on webhooks.

## Fix
In the dispatcher, require `event.source === API_EVENT_SOURCE` for API-originated types, as `draftFor` does, and keep runner-originated types as they are.

## Acceptance criteria
- A dispatcher test: a runner-sourced `schedule.disabled` creates no delivery; an API-sourced one does (regression test).
- Existing dispatcher tests pass.

## Touches
- apps/api/src/webhooks/outbound/webhook-dispatcher.ts
- apps/api/src/webhooks/outbound/*.spec.ts

## Decision
none needed


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
