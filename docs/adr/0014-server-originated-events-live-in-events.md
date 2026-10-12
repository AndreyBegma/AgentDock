# ADR-0014: Server-originated events live in `events`

Status: accepted · Date: 2026-10-12

## Context

`events` was written by runners only: `runnerId` required, unique `(runnerId, seq)`, and the runner's ack cursor reads `seq > ackedSeq ≥ 0`. Some facts are not observed by any runner. The API observes them itself: a schedule firing (spec 25 D17), a GitHub delivery (spec 27 D9). Every consumer that turns events into product, such as the activity feed (#21), outbound webhooks (#26) and the notification matcher (#22), tails `events` and resolves a project through `runnerId`. A fact kept anywhere else is invisible to all of them. Spec 25 shipped `schedule.*` as live-only for that reason (its Q2), and spec 27 D9 (corrected) introduced a one-off path for `github.*` rows.

## Decision

A server-originated event is an ordinary `events` row:

- **Anchor.** It carries the `runnerId`, `projectRoot` and `projectRepo` of the project it is about. `runnerId` stays required, so no consumer's types or project resolution change. `source` names the server-side origin: `api` for what the API decides itself, such as schedules, and `github` for a GitHub delivery. `api` (`API_EVENT_SOURCE`) is deliberately absent from the runner's `eventSourceSchema`, so a runner can never send a row that claims it.
- **Ordering.** `seq = -nextval('server_event_seq')`. All server sources draw from that one sequence. Two sequences would both hand out -1, -2, … on the same runner and collide on `(runnerId, seq)`. Runner seqs are positive and the ack cursor never reads below zero, so the two series never meet. `events.id` stays the global order consumers tail. The migration renames spec 27's `github_event_seq` to `server_event_seq`.
- **Idempotency.** `events.dedupeKey` is a nullable column with unique `(source, dedupeKey)`. Because NULLs are distinct, runner rows and keyless server rows are unaffected. A row is written by `recordServerEvent`, inside the transaction that makes the change it reports, so the two commit together. The writer looks the key up before inserting, because a conflicting insert would still consume an `events.id`, and the activity projector waits out every hole in `id` (spec 21 notes).
- **`schedule.*`.** Firing events use the key `<type>:<firingId>`. `schedule.disabled` is keyed by the firing that caused it. A firing that is `started` and later `succeeded` is therefore one `schedule.fired`.
- **Consumers opt in by type, as before.** Activity shows `schedule.*` only from `source` `api`, with actor `system`.

## Consequences

- No new table, and no change to how existing consumers read `events`. #22 and #26 can map `schedule.*` by type when they want it.
- A server-originated event about something with no project has no anchor. It would need `runnerId` to become nullable, which is a new decision.
- GitHub rows stay keyless: their idempotency is `github_deliveries`, unchanged.
