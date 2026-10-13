# Run cron schedules on BullMQ (Redis)

Issue: [#123](https://github.com/AndreyBegma/AgentDock/issues/123) · Roadmap: M3.2 (rework) ·
Decisions: [ADR-0015](../adr/0015-schedules-run-on-bullmq.md) (amends
[ADR-0007](../adr/0007-postgresql-only.md)),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md) ·
Builds on: [spec 25](25-cron-schedules.md) (#25, PRs #98 and #104), #99

## Summary

Cron schedules (#25) work today on a PostgreSQL scheduler. One API instance
wins an advisory lock and ticks every 15 s. It claims due rows with
`FOR UPDATE SKIP LOCKED`, and it keeps every timer in the `schedules.nextRunAt`
column. This item replaces the tick loop and the leader election with BullMQ
on Redis. Each enabled schedule has one delayed job for its next occurrence,
and any API instance may process it. PostgreSQL stays the source of truth: the
schedule row, the firing rows, audit, live updates and #99's events.

What a schedule does does not change. Spec 25 stays in force for targets,
cron/DST rules, missed runs, overlap, authority, auto-disable and
authorization. Only the machinery that wakes the API up at the right moment
changes. The person chose this on 2026-10-12. The reasons are in ADR-0015.

## Scope

### In scope

- A Redis service in `docker/docker-compose.yml`: pinned, password, AOF, `noeviction`.
- A BullMQ module in `apps/api/src/bullmq` (`@nestjs/bullmq`) and its configuration (`REDIS_URL`).
- The `schedules` queue:
  - a `fire` job per enabled schedule;
  - two repeatable maintenance jobs: settle finished runs and fail stale `due` firings, and reconcile timers with PostgreSQL;
  - the processor that replaces `SchedulerService.tick()`.
- Timer sync on create, update, enable, disable, auto-disable and delete.
- Removal of the advisory-lock leader election, the 15 s `setInterval`, and the dedicated `pg` lock connection.
- The admin system-jobs listing shows the two maintenance jobs.
- Tests: unit tests for the processor and the reconciler, e2e tests against a real Redis, and an updated leader-election test (now: two workers, one firing).

### Out of scope

- Any change to `schedules` / `schedule_firings`. No migration.
- Webhook deliveries (#26). They stay on PostgreSQL `SKIP LOCKED` (ADR-0015 §6).
- The `@nestjs/schedule` system jobs of other modules, and #119's other bullets.
- A queue dashboard (Bull Board) or queue metrics in the UI. See Open questions.
- Using Redis for anything else: cache, rate limiting, live fan-out.
- `run now` (spec 25 D15). It stays a synchronous call to `ScheduleFirer.fire` from the request and never touches the queue.

## Decisions

Delegated: the person confirmed the direction on 2026-10-12 and answered every
open question with "take your recommendation". Each row is a default taken
here unless it names another source. Rows marked *(A)* are listed again under
*Assumptions*.

| # | Decision | Source |
|---|---|---|
| B1 | **Library.** `bullmq` through `@nestjs/bullmq` (both MIT), pinned exactly per `bunfig.toml`. BullMQ 6 declares `ioredis` an optional peer, so it is a direct dependency. Pinned: `bullmq` 6.3.9 (2026-09-25), `@nestjs/bullmq` 11.0.5 (2026-08-07; 12.0.0 is ESM-only and the API is CommonJS under Jest) and `ioredis` 5.11.1 (2026-06-04), the newest stable releases at least two weeks old when the i123-queue slot ran. | ADR-0015 |
| B2 | **Authority.** `schedules.nextRunAt` is the only next-run time. A BullMQ job only says "check schedule *S* for occurrence *T*". The processor acts only when it holds the row lock and finds `enabled` and `nextRunAt = T`. Otherwise it completes the job and does nothing, and logs `stale timer` at debug. | ADR-0015 §2 |
| B3 | **One delayed job per occurrence, computed by `CronSchedule`.** On queue `schedules`, job name `fire`, data `{ scheduleId, scheduledFor }` (ISO). Job id `fire-<scheduleId>-<scheduledFor epoch ms>`; no `:`, which BullMQ forbids in custom ids. Delay `max(0, nextRunAt − now)`. BullMQ job schedulers (`upsertJobScheduler` with `pattern` + `tz`) are not used for schedules. *(A)* | ADR-0015 §3 |
| B4 | **DST and timezone.** `cron.ts` (`CronSchedule`) is untouched and stays the only place an occurrence is computed. A spring-forward-skipped local time does not fire, and a fall-back-repeated one fires once (spec 25 D4). BullMQ never sees a cron pattern or a timezone, only an absolute timestamp. `cron.spec.ts` keeps passing unchanged. | spec 25 D4; B3 |
| B5 | **The processor** (`ScheduleFireProcessor`, replacing `SchedulerService.tick` / `claimOne`), for one `fire` job:<br>1. In one PostgreSQL transaction, `SELECT … FROM schedules s JOIN projects p … WHERE s.id = $1 FOR UPDATE OF s`. This waits for the lock and never skips: two workers on one row serialize.<br>2. Apply B2. If the row is missing, disabled, or has a different `nextRunAt`, commit and complete.<br>3. D9 wait: if the occurrence has a `cron` firing `failed / runner_offline`, the policy is `catch_up`, the runner is still offline, and the occurrence is ≤ 24 h old, then commit with no writes and **re-delay this same job** (B7).<br>4. Otherwise run `planClaim` (`missed.ts`, unchanged) with `now` = processing time. Write the `skipped` / `due` firings with `skipDuplicates` on the unique key, advance `nextRunAt`, and write #99's `schedule.skipped` events. All of this goes in the same transaction, exactly as `claimOne` does today.<br>5. After commit, add the `fire` job for the new `nextRunAt` (B8).<br>6. Publish the skipped firings live, then call `ScheduleFirer.fire(dueId)` for the `due` firing.<br>7. If `fire` rewound `nextRunAt` to this occurrence (D9, `catch_up` with the runner offline), re-delay this same job (B7). The job added in step 5 is now stale and is removed. If its removal fails, B2 drops it. | spec 25 D5–D9; `scheduler.service.ts`, `missed.ts` |
| B6 | **Runner commands stay at-most-once.** A job that runs twice (stalled-job recovery, a retry, a duplicate add) finds `nextRunAt` already advanced and does nothing. A `due` firing left by an instance that died between commit and send is still failed as `not_sent` after 10 minutes, never resent (spec 25 notes, "Stale `due`"). BullMQ's at-least-once delivery is absorbed by B2 and the unique key. It never reaches the runner. | spec 25 notes; ADR-0010 |
| B7 | **D9 offline retry** is the same job moved back to delayed (`job.moveToDelayed` + `DelayedError`). The job keeps its id, so it cannot collide with a re-add. Delays: 30 s, 60 s, 120 s, 240 s, then every 300 s, until the occurrence is older than 24 h. After that, step 4's `planClaim` claims it. The occurrence already holds its `failed / runner_offline` row, so nothing new is recorded, no command is sent, and `nextRunAt` moves to the next occurrence (`missed.ts`, `dueRecorded`). This replaces "later ticks leave it" with no change in behaviour. *(A)* | spec 25 D9 + notes |
| B8 | **Timer sync** (`ScheduleTimers.sync(scheduleId, previousNextRunAt?)`). It removes the job for the previous `nextRunAt`, if any, and adds the job for the current one, if enabled. It is called after commit by `SchedulesService` create / update / enable / disable / delete, by `ScheduleFirer.disable` (auto-disable), and by B5 step 5. A failed sync (Redis down) is logged at `warn` and never fails the HTTP request or the firing. The reconciler repairs it within one period. *(A)* | ADR-0015 §2 |
| B9 | **Reconciler**, a repeatable job `reconcile` every 60 s, plus once on bootstrap of each instance with the scheduler enabled:<br>(a) For every enabled schedule with `nextRunAt`, if job `fire-<id>-<ms>` is missing, or is `completed` / `failed` while the row still points at it, remove it and add it again. Delayed, waiting and active jobs are left alone.<br>(b) Remove every delayed `fire` job whose `(scheduleId, scheduledFor)` no longer matches a row.<br>It pages through rows and the delayed set in batches of 500 and logs counts (`added`, `removed`) at `info` when non-zero. Every repair is idempotent: deterministic ids make a racing double add a no-op. | ADR-0015 §2 |
| B10 | **Maintenance job** `settle`, a repeatable job every 15 s: `settleFinishedRuns` and `failStaleDue` from today's tick, unchanged. Both repeatables are registered with `upsertJobScheduler` (`every`) on bootstrap. This is idempotent across instances, and BullMQ hands each repetition to one worker. This is the only use of BullMQ job schedulers. | spec 25 D8; notes |
| B11 | **No leader election.** `lead()`, `release()`, `LEADER_LOCK`, the `pg` `Client`, `leaderRetryMs` and `isLeader` are deleted, and so is the `pg` import in `schedules/`. Every instance with the scheduler enabled runs a `schedules` worker with concurrency 5 and BullMQ's default lock renewal. | ADR-0015 §4 |
| B12 | **Job retention and retries.** `fire`: `attempts: 5`, `backoff: { type: 'exponential', delay: 5000 }`. This is for errors thrown before commit, such as PostgreSQL being unreachable. `removeOnComplete: { age: 86400 }`, `removeOnFail: { age: 604800 }`. A `fire` job that exhausts its attempts leaves `nextRunAt` unchanged, and B9(a) re-adds it. | new *(A)* |
| B13 | **`beforeFire` and the budget gate.** Unchanged: `ScheduleFirer.fire` still calls `BeforeFire.check` first. #106 lands in `before-fire.ts` with no conflict in design. | spec 25 D12; #106 |
| B14 | **Audit and live.** Unchanged. CRUD audit (spec 25 D16) is written by `SchedulesService` and auto-disable by `ScheduleFirer.disable`. Live `schedule.updated` / `schedule_firing.updated` go out through `ScheduleLive`. No audit or live call moves into a BullMQ event handler (`completed`, `failed`, `stalled`). | spec 25 D16–D17 |
| B15 | **#99 events stay exactly-once.** Every `schedule.*` row in `events` is written inside the PostgreSQL transaction of the transition that causes it:<br>• the B5 step-4 claim writes `skipped`;<br>• `ScheduleFirer.settle` writes `fired` / `skipped` / `failed`;<br>• `disable` writes `disabled`.<br>Each is keyed `<type>:<firingId>` with `ON CONFLICT DO NOTHING`. A replayed job writes no firing (B2) and so no event. Nothing BullMQ does is a source of an event. | #99 plan (issue comment 6120856430) |
| B16 | **Redis deployment.** Compose service `redis`, image `redis:7.4.11-alpine` (the newest 7.4 patch tag verified with `docker manifest inspect`; later patches carry security fixes), `container_name: agentdock-redis`, port `6421:6379`. `command: redis-server --requirepass ${REDIS_PASSWORD:?set it in docker/.env} --appendonly yes --appendfsync everysec --maxmemory-policy noeviction`, volume `redis_data:/data`, healthcheck `redis-cli -a $REDIS_PASSWORD ping`. `noeviction` is what BullMQ requires. *(A)* | ADR-0015 §5 |
| B17 | **Persistence and backup.** AOF (`everysec`) keeps pending timers across a Redis restart. Redis is not backed up. A lost or wiped Redis is rebuilt by B9 from PostgreSQL. Occurrences that fell due in between follow spec 25 D6, the same as an API outage. | ADR-0015 §5 |
| B18 | **Redis down.** The API boots and keeps serving. `ioredis` reconnects forever (`maxRetriesPerRequest: null` on the worker connection, as BullMQ requires). Schedule CRUD succeeds, with B8 logging the failed sync. Nothing fires. When Redis returns, B9 runs within 60 s, or at once on the next boot. Each late occurrence is planned by `planClaim` (D6: within the 2-minute grace it fires as `cron`; otherwise `skip` or `catch_up`). The bootstrap reconcile retries in the background and never blocks boot. | ADR-0015 consequences *(A)* |
| B19 | **Configuration.** `REDIS_URL` is required when the scheduler is enabled. Without it, the API fails to boot with `REDIS_URL is required unless SCHEDULER_ENABLED=false`. With `SCHEDULER_ENABLED=false` and no `REDIS_URL`, the instance runs no worker and syncs no timers, and logs that once. Under `APP_ENV=test` no worker or repeatable autostarts, the same as the current loop. Tests drive the processor, and the one Redis e2e starts its worker itself. Prefix `agentdock` (BullMQ's default is `bull`). *(A)* | `scheduler-options.ts`; CLAUDE.md (env documented in `.env.example`) |
| B20 | **System jobs (spec 25 D13).** `SystemJobs.list()` also returns the two BullMQ job schedulers, from `queue.getJobSchedulers()`: `schedules.settle` and `schedules.reconcile`, `kind: 'interval'`, `nextRunAt` from the scheduler's `next`, `lastRunAt` null. `SystemJobView` does not change. If Redis is unreachable, they are omitted and the rest still list. | spec 25 D13; #119 |
| B21 | **Cutover.** No schema change, so deploying is just the new image. On first boot, B9 adds a timer for every enabled schedule from its `nextRunAt`. During a rolling deploy an old instance's tick (`FOR UPDATE … SKIP LOCKED`) and a new instance's processor (`FOR UPDATE`, B2) both act through the row lock and the `nextRunAt` advance. Whichever commits first fires. The other skips the locked row (old) or finds `nextRunAt` moved (new). The unique `(scheduleId, scheduledFor, kind)` backs both. Occurrences due while nothing ran are handled by D6. | B2; spec 25 D5 |
| B22 | **Rollback.** Redeploy the previous image. Its tick reads `nextRunAt` from PostgreSQL and carries on, and D6 covers the gap. Jobs left in Redis have no worker and are inert. Remove them with the `agentdock:schedules:*` keys or by stopping the `redis` service. A later roll-forward's B9 deletes any stale ones. | B2 |
| B23 | **Other queues.** The webhook delivery queue (#26) and every other `setInterval` job stay where they are. | ADR-0015 §6 |

### Effect on open issues

| Issue | Effect |
|---|---|
| #99 API-sourced events | **Ordering, not design.** i99 edits `scheduler.service.ts` and `schedule-firer.ts`, which i123-schedules rewrites, so i123-schedules is cut after #99 merges. B15 keeps i99's transaction placement as is: the claim-time `skipped` events move with the claim into the processor. |
| #102 `onBehalfOf` on system audit actors | **Leaves.** `ScheduleFirer.send` is unchanged, and #102 still sets `onBehalfOf` there. |
| #103 `schedule.disabled` notification | **Leaves.** Auto-disable stays in `ScheduleFirer.disable` (B8 only adds a timer sync after it). |
| #106 budget gate skips instead of failing | **Leaves.** `BeforeFire.check` is the same single call site (B13). It must not be confused with B7: a budget `skipped` is final and is never re-delayed. |
| #107 `schedule.*` to outbound webhooks | **Leaves.** It depends on #99's `events` rows, which B15 keeps. |
| #119 plain `setInterval` jobs to `SchedulerRegistry` | **Changes.** Its last bullet, the scheduler tick, is absorbed: the tick is deleted (B11), and the maintenance jobs are listed through B20. The other bullets stay with #119. |

### Implementation notes (i123-schedules)

These are choices the decisions above leave open. Each was approved by the orchestrator.

- **The queue is registered only with a `REDIS_URL`.** `BullModule.registerQueue` builds the Queue eagerly, and BullMQ connects on construction. `schedules.module.ts` therefore wraps it in `ConditionalModule.registerWhen(…, env => !!env.REDIS_URL)`. The timers, reconciler, worker and system-jobs listing inject it `@Optional()` and do nothing without it (B19).
- **The worker is created by hand** (`ScheduleWorker`), not with `@Processor`. `@nestjs/bullmq`'s explorer builds, and so connects, a Worker for every `@Processor` at init, even with `autorun: false`.
- **Calls to Redis are bounded.** With `maxRetriesPerRequest: null`, a call waits as long as Redis is down. Timer sync and the system-jobs read therefore race a 2 s timeout, then log at `warn` with the schedule id (B8, B18). Every Queue and Worker has an `error` listener. On shutdown the worker gets 10 s to close gracefully and is then force-closed, because `Worker.close()` never returns while Redis is unreachable.
- **`ensure` treats a `completed` or `failed` job with the target id as missing.** It removes it and adds it again, the B9(a) rule, so changing a cron and changing it back re-arms the timer at once.

## Data / Schema

None. `schedules` and `schedule_firings` (spec 25, migration
`20261031000000_schedules`) are unchanged, and no migration is added.
`nextRunAt` keeps its meaning and its index `(enabled, nextRunAt)`, which B9
uses.

## Redis keys

All under the prefix `agentdock`: queue `schedules`, job names `fire`,
`settle`, `reconcile`. Nothing else is written to Redis.

## API

No route changes. `GET /admin/system-jobs` lists two more rows (B20).

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `REDIS_URL` | `apps/api/.env.example` | `redis://:change-me@localhost:6421/0`. Required unless `SCHEDULER_ENABLED=false` (B19) |
| `TEST_REDIS_URL` | `apps/api/.env.example` | Redis the e2e tests use, `redis://:change-me@localhost:6421/1`. Each run uses its own prefix, `agentdock-test-<pid>-<ts>`, and obliterates it in teardown |
| `REDIS_PASSWORD` | `docker/.env.example` | `requirepass` of the compose service. Must match `REDIS_URL` |
| `SCHEDULER_ENABLED` | `apps/api/.env.example` (existing) | `false`: this instance runs no `schedules` worker and registers no repeatables. Its comment is updated. Default `true` |

`scripts/db-start-docker.sh` waits for `redis-cli ping` as it waits for
`pg_isready`. Root `README.md` and `CLAUDE.md` gain Redis in the prerequisites
and the structure table (`docker/ — PostgreSQL 16, Redis 7.4 :6421`).

## Test strategy

- **Unit** (no Redis): the processor's decision for one job, with a fake queue
  and a fake clock:
  - stale timer → no write;
  - on time → one `due` firing and the next job added;
  - missed by three with `skip` / `catch_up` / over 24 h → the spec 25 D6 outcomes;
  - D9 → re-delayed with B7's delays.

  Also the reconciler's diff (missing, completed, orphan). `cron.spec.ts` is unchanged.
- **e2e** (PostgreSQL + Redis, `bun run test`): the existing
  `schedules.e2e.spec.ts` cases drive `ScheduleFireProcessor.process(job, now)`
  in place of `tick(now)`, with the same assertions. New:
  - a real worker with a schedule whose `nextRunAt` is 1 s ahead → exactly one firing within 10 s;
  - two workers, one job added twice plus a stalled replay → one firing, one command;
  - Redis flushed → after `reconcile`, every enabled schedule has its job again;
  - Redis unreachable → `POST …/schedules` still 201, and the next `reconcile` adds the job;
  - #99's `events` rows are not duplicated by a replayed job.
- `bun run test` fails with a clear message when `TEST_REDIS_URL` is
  unreachable, as it does for PostgreSQL. No silent skip.

**As built (i123-schedules).** The e2e cases drive
`ScheduleFireProcessor.handle(data, now)`, not `process(job, now)`.
`process(job, token)` needs a real job and its lock token to call
`moveToDelayed`, so it is a thin wrapper. `handle` returns the decision as
`stale`, `redelay` with its delay, or `fired`, and the real-worker cases
exercise `process`. "Old `tick` against the new processor" (Risks) is tested
with a row lock held in a second transaction that advances `nextRunAt`. The
`tick` code is deleted, so that is the shape it can take.

## Acceptance criteria

- [ ] `docker compose -f docker/docker-compose.yml up -d` starts `postgres` and `redis`. `docker exec agentdock-redis redis-cli -a "$REDIS_PASSWORD" CONFIG GET appendonly` prints `yes`, and `CONFIG GET maxmemory-policy` prints `noeviction`.
- [ ] `grep -rn "pg_try_advisory_lock\|setInterval" apps/api/src/schedules` finds nothing.
- [ ] Creating an enabled schedule creates exactly one delayed job, `fire-<id>-<nextRunAt ms>`, on queue `agentdock:schedules`. Disabling or deleting it removes the job. Changing its cron replaces the job with one for the new `nextRunAt`.
- [ ] With a worker running, a schedule due in 1 s produces exactly one `schedule_firings` row and one `skill.run` (or `orchestrator.start`) command. `nextRunAt` advances, and the job for the new `nextRunAt` exists.
- [ ] Two API instances, with no advisory lock anywhere: a job processed twice (added twice, or replayed after a killed worker) yields one firing, one command, and one `events` row per #99 type and firing.
- [ ] A `fire` job whose `scheduledFor` differs from the row's `nextRunAt` (stale) writes nothing and completes.
- [ ] After `FLUSHALL` on Redis, the next `reconcile` (≤ 60 s) re-adds a job for every enabled schedule and none for disabled ones. An orphan delayed job for a deleted schedule is removed.
- [ ] With Redis stopped: the API answers HTTP, a schedule can be created (201), and nothing fires. Once Redis is back, a schedule missed by more than 2 minutes follows its policy: `skip` gives one `skipped` firing, and `catch_up` gives one command for the newest occurrence.
- [ ] All spec 25 firing criteria still pass, unchanged: missed runs (`skip`, `catch_up`, over 24 h), overlap, runner offline with auto-disable after five, `creator_not_authorized`, `already_running` → `noop`, `run now`.
- [ ] D9 under `catch_up`: with the runner offline, the occurrence is retried by the same job (B7) and fires once as `catch_up` when the runner returns. It is never retried after 24 h.
- [ ] DST: a `30 2 * * *` schedule in `Europe/Berlin` does not fire on the spring-forward day, and fires once on the fall-back day (spec 25 D4, through B4).
- [ ] `GET /admin/system-jobs` lists `schedules.settle` and `schedules.reconcile` with a `nextRunAt`.
- [ ] **Authorization:** the spec 25 authorization tests pass unchanged. A viewer gets 403 and a non-member 404 on every `/projects/:projectId/schedules*` route, including when a member of another project. `/admin/system-jobs` returns 403 to operators.
- [ ] `apps/api/.env.example` documents `REDIS_URL` and `TEST_REDIS_URL`, and `docker/.env.example` documents `REDIS_PASSWORD`. The API refuses to boot without `REDIS_URL` unless `SCHEDULER_ENABLED=false`.
- [ ] `bun run check`, `bun run test` (with compose up) and `bun run build` pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i123-queue | Redis service, queue module (connection, prefix, config check, test helpers), env, test infra | docker/docker-compose.yml, docker/.env.example, scripts/db-start-docker.sh, apps/api/src/bullmq/**, apps/api/src/app.module.ts, apps/api/src/test/**, apps/api/.env.example, apps/api/package.json, bun.lock, README.md, CLAUDE.md | — | yes | sonnet |
| i123-schedules | processor, timers, reconciler, maintenance jobs, leader-election removal, system-jobs rows, tests | apps/api/src/schedules/** | i123-queue, #99 | no | opus |

Honestly two slots in sequence. `i123-queue` is mergeable alone: Redis runs
and the module connects, and nothing uses it yet. `i123-schedules` rewrites
the files #99 is editing, so it is cut after #99 and i123-queue merge.

What `i123-queue` exports for `i123-schedules`:

- `BullmqModule` in `apps/api/src/bullmq/` (not `src/queue/`: that is the task-queue module of #19), global, built on `BullModule.forRootAsync` from `REDIS_URL` with prefix `agentdock` (overridable by `QUEUE_PREFIX`, which the e2e suite sets per run);
- `QUEUE_ENABLED`, a boolean provider: false when `SCHEDULER_ENABLED=false` and `REDIS_URL` is unset;
- `testQueuePrefix()` and `obliterateQueues()` for e2e teardown (`src/bullmq/bullmq-testing.ts`), and `TEST_REDIS_URL` wiring in `src/test/`.

`i123-schedules` registers its own queue with `BullModule.registerQueue({ name: 'schedules' })` inside `schedules.module.ts`.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/src/schedules/** | i123-schedules | #99 (i99) is in it now. i123-schedules starts after #99 merges |
| apps/api/package.json, bun.lock | i123-queue | i123-schedules adds no dependency. `bun.lock` is regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) |
| apps/api/src/app.module.ts | i123-queue | one import line; keep both on conflict |
| apps/api/.env.example | i123-queue | i123-schedules does not open it. The `SCHEDULER_ENABLED` comment is written by i123-queue as given in Configuration |
| docker/docker-compose.yml | i123-queue | — |
| CLAUDE.md, README.md | i123-queue | one line each |
| apps/api/prisma/** | — | not touched |
| docs/adr/README.md (ADR-0015 row), docs/specs/25-cron-schedules.md (cross-link) | this docs item, after #99 merges | i99 is editing both now |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Two stores disagree, so a schedule silently stops firing | high | B2 makes Redis advisory. B9 runs every 60 s and on boot. An acceptance criterion flushes Redis and checks the repair |
| A replayed job sends a runner command twice | high | B2/B6: no command without a fresh `due` firing written under the row lock. A two-worker replay test |
| Self-hosters miss the new service or its password, and schedules stop | medium | Boot fails loudly without `REDIS_URL` (B19). Compose, `db:setup` and `.env.example` ship it |
| Redis eviction drops jobs | medium | `noeviction` (B16). B9 repairs anything lost anyway |
| Rolling deploy double-fires | medium | B21: the row lock and unique key hold across old and new code. Tested by running the old `tick` and the new processor against one row |
| `bun run test` gets slower or flaky on Redis timing | low | Only the e2e cases in Test strategy use a real worker. The rest drive the processor directly with a fake clock |
| Redis licence (RSALv2/SSPLv1 for 7.4+) | low | Self-hosting unmodified is allowed. Valkey is a drop-in (ADR-0015) |

## Assumptions (confirm in review)

Taken by the specification under the person's standing answer (2026-10-12).
Each one gives the decision, the alternative, and why.

- **B3: delayed job per occurrence, not BullMQ's cron.** Alternative: `upsertJobScheduler({ pattern, tz })` per schedule. Rejected because BullMQ's cron moves spring-forward times instead of dropping them, has no `skip` / `catch_up` / 24 h notion, and would keep a second `nextRunAt`.
- **Why move at all.** The case is read from the code (ADR-0015 Context): leader election, ~30 s failover, 15 s lag, hand-kept timers, no queue visibility. Alternative: pg-boss, with no new service. Rejected because the person chose BullMQ. The cost is recorded in ADR-0015.
- **B7: D9 retry by re-delaying the same job** with 30 s → 5 min backoff. Alternative: fire on the runner's reconnect event. Rejected because it couples schedules to the runner gateway for one edge case.
- **B8: a failed timer sync does not fail the request.** Alternative: return 503 when Redis is down. Rejected because PostgreSQL is the authority and B9 repairs within 60 s.
- **B9: a 60 s reconcile period.** Alternative: boot-only reconcile. Rejected because a Redis restart without AOF, or a wipe, would then stop schedules until the next deploy.
- **B12: retries and retention** (5 attempts, 24 h completed, 7 days failed). Alternative: BullMQ defaults (1 attempt, keep forever). Rejected because a transient PostgreSQL error should not wait for the reconciler, and Redis memory should stay bounded.
- **B16: `redis:7.4.11-alpine`, host port 6421, password, AOF everysec.** Alternative: Valkey 8 (BSD). Rejected because the person asked for Redis. Port 6421 follows the repository's 5421 pattern.
- **B18 / B19: the API boots while Redis is down, but not without `REDIS_URL`.** Alternative: make Redis optional and fall back to the PostgreSQL tick. Rejected because two schedulers would have to be kept correct forever.
- **B20: maintenance jobs listed as `kind: 'interval'`.** Alternative: a new `kind: 'queue'` in `SystemJobView`. Rejected because it would touch `packages/shared` and the web table for a label.
- **B23: the webhook delivery queue stays on PostgreSQL.** This is the brief's default, and it is recorded in ADR-0015 §6.
- **Run now stays synchronous.** Alternative: enqueue an immediate job. Rejected because the HTTP response would lose the firing it returns today.

## Open questions

| Question | Default if nobody answers |
|---|---|
| Expose queue state (delayed / failed counts, a Bull Board) to admins? | No. A later item if needed. Logs and `/admin/system-jobs` only |
| Move webhook deliveries (#26) to BullMQ as well? | No (ADR-0015 §6). It needs its own ADR |
| Should `/health` (if added) report Redis? | Yes, as `degraded`, not `down`: the API serves everything except firings without it |

Depends on #99
