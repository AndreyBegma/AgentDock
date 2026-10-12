# ADR-0015: Schedules run on BullMQ (Redis)

Status: accepted · Date: 2026-10-12 · Amends [ADR-0007](0007-postgresql-only.md) ·
Spec: [123-schedules-on-bullmq](../specs/123-schedules-on-bullmq.md)

## Context

ADR-0007 keeps every queue in PostgreSQL: "Queues (webhook deliveries,
schedules) are tables polled with `SKIP LOCKED`." Cron schedules (#25,
[spec 25](../specs/25-cron-schedules.md)) were built that way. In
`apps/api/src/schedules/` the scheduler does four things that a job queue
already provides:

- **Leader election.** One API instance holds `pg_try_advisory_lock` on a
  dedicated `pg` connection outside Prisma's pool. Only that instance ticks.
  Followers retry every 30 s, so a dead leader stops all firings for up to
  30 s plus a tick.
- **Polling granularity.** The leader ticks every 15 s. A schedule fires up to
  15 s after its time, and every tick queries `schedules` whether anything is
  due or not.
- **Timers kept by hand.** `nextRunAt` is advanced in the claim transaction,
  and an offline-runner retry under `catch_up` rewinds it (spec 25 D9). A
  `due` firing whose instance died before sending is found by a sweep ten
  minutes later (`failStaleDue`).
- **No visibility.** What is about to fire, what is late and what failed to
  run are visible only in `schedule_firings` after the fact.

On 2026-10-12 the person chose to move schedules to BullMQ. The reasons above
are read from the code. The person did not state them, so they are recorded
as the case for the change, not as a reported incident.

## Options

| Option | For | Against |
|---|---|---|
| **Keep the current scheduler** | It works, it is tested (firing, missed runs, leader election, authorization), and it needs no new infrastructure | The hand-rolled leader election and tick loop stay ours to maintain. Failover takes ~30 s, firing lags up to 15 s, and nothing shows what is pending |
| **pg-boss or graphile-worker** (PostgreSQL-backed, no ADR break) | No new service. pg-boss has per-name cron with a timezone, singleton jobs and retries. graphile-worker has crontab with backfill | pg-boss cron is evaluated by its own ~30 s monitor (minute resolution, the same lag class as today) and its schedules are keyed by name, so per-row reconciliation is still ours. graphile-worker's crontab is static configuration, not per-row and dynamic. It uses the server timezone, not one per schedule. Either keeps queue load on the one database every other feature uses |
| **BullMQ + Redis** (chosen) | Delayed jobs fire at their millisecond on whichever instance is free. Concurrency is safe without a leader lock. Stalled-job recovery, retries with backoff, and queue introspection (counts, delayed, failed) come built in. Queue polling moves off PostgreSQL | Redis is a second stateful service for every self-hoster to run. Every firing now crosses two stores, so PostgreSQL must stay the authority and Redis must be rebuildable from it |

pg-boss would have removed the leader election with no new service. BullMQ was
chosen over it for sub-second delayed jobs and its tooling, and because the
person chose it. The cost is the extra service, stated below.

## Decision

1. **Schedules run on BullMQ** (`bullmq` via `@nestjs/bullmq`) against Redis.
   This exception covers schedules and the schedule maintenance job only.
2. **PostgreSQL stays the source of truth.** `schedules` (cron, timezone,
   `enabled`, `nextRunAt`) and `schedule_firings` are unchanged. A BullMQ job
   is a timer that says "look at schedule X for occurrence T". The worker
   decides inside a PostgreSQL transaction, against the row, whether anything
   fires. A job that disagrees with the row is dropped. A row with no job gets
   one from the reconciler. Drift is repaired, never trusted.
3. **One delayed job per enabled schedule**, for its `nextRunAt`. The next one
   is computed by the existing `CronSchedule` (`cron.ts`) and has a
   deterministic job id. BullMQ's own cron (`upsertJobScheduler` with
   `pattern` / `tz`) is **not** used for schedules. It would second-guess
   spec 25's DST rules and missed-run policy, and it would make two stores
   disagree about the next run.
4. **No leader election.** Any API instance with the scheduler enabled runs a
   worker. The row lock on `schedules`, the `nextRunAt` equality check and the
   unique `(scheduleId, scheduledFor, kind)` key make a duplicated or replayed
   job a no-op.
5. **Redis holds no data that cannot be rebuilt.** It runs with AOF
   persistence so a restart does not lose pending timers, but it is not backed
   up. After a wipe, the reconciler re-adds every timer from PostgreSQL. The
   missed-run policy (spec 25 D6) covers whatever fell due in between.
6. **Everything else stays on PostgreSQL.** Webhook deliveries (#26) keep
   their `SKIP LOCKED` table. Each delivery is a row with per-attempt history,
   written in the same transaction as the event that causes it, and moving it
   would split that outbox for no gain. Moving any other queue to Redis needs
   its own ADR.

## Consequences

- Self-hosters run three services instead of two: `api`, `web`, `postgres`,
  plus `redis`. The compose file ships it pinned, with a password, AOF and
  `noeviction`. Backups still cover PostgreSQL only.
- **Redis down:** the API keeps serving and schedule edits still save. Nothing
  fires until Redis is back. Then the reconciler re-adds the timers, and late
  occurrences follow the missed-run policy as if the API had been down. This
  is the same as ADR-0007's single point of failure, scoped to schedules.
- `bun run test` needs a reachable Redis, as it already needs PostgreSQL.
- The Redis image's licence (Redis 7.4+ is RSALv2/SSPLv1) allows self-hosting
  it unmodified. Valkey is a drop-in replacement for anyone who prefers BSD,
  because BullMQ speaks the same protocol to both.
- ADR-0007's Status line points here. Its decision stands for everything
  except schedules.
