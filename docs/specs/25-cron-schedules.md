# Cron schedules for skills and orchestrator commands

Issue: [#25](https://github.com/AndreyBegma/AgentDock/issues/25) · Roadmap: M3.2 ·
Decisions: [ADR-0005](../adr/0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md),
[ADR-0007](../adr/0007-postgresql-only.md),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md),
[data-model.md](../architecture/data-model.md), [security.md](../architecture/security.md)

## Summary

PRD feature area *Cron*: a schedule runs a skill or an orchestrator command on a
project at fixed times — `cs-security` every night, `orchestrator next` every
hour, without anyone at a keyboard. A schedule is a row: project, target, cron
expression, timezone, missed-run policy. The scheduler lives in the API and is
table-driven on PostgreSQL (ADR-0007). Each firing sends the same typed runner
command a person would send (`skill.run` from #24, `orchestrator.start` from
#17), so a scheduled run is an ordinary run in history (#21), with the schedule
as its trigger. The same screen lists the API's own system jobs (audit chain
verification, usage rollups, notification digests) as read-only rows.

## Scope

### In scope

- `schedules` and `schedule_firings` tables.
- The scheduler: tick loop, leader election by advisory lock, `SKIP LOCKED` claiming, missed-run policy, runner-offline handling.
- Firing a target: `skill.run` (#24) or `orchestrator.start` with `mode: start | next` (#17).
- Cron parsing, validation and next-runs preview.
- Read-only listing of system jobs registered with `@nestjs/schedule`.
- API endpoints, audit, events, live updates.
- Web `/projects/[projectId]/schedules` and `/admin/schedules`.

### Out of scope

- Inbound webhook triggers — #26. They fire the same targets, through their own module.
- Moving the existing system jobs (#8, #13, #22) onto `schedules`. They stay in their modules on `@nestjs/schedule`; this item only lists them.
- Budget checks before firing — M3.5 (#28) adds a pre-fire hook; this item leaves a single call site for it (D12).
- Natural-language schedule entry ("every weekday at 9").
- Schedules that span several projects. One schedule, one project.

## Decisions

The person delegated all decisions on 2026-10-07. Each row is the default taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | **Targets** are a closed union stored as Json and validated with the protocol schemas:<br>• `{ kind: "skill", skill, args, profileId?, model?, output: "report" \| "pr" }` — fires `skill.run` (#24);<br>• `{ kind: "orchestrator", mode: "start" \| "next" }` — fires `orchestrator.start` (#17) with the project's orchestrator settings (#17 D3).<br>`profileId` defaults to the project's default profile (#10 D13). `model` defaults to the skill run default from #24. Nothing else can be scheduled: no shell, no arbitrary runner command (ADR-0010). | ADR-0010; #17 D2–D3; #24 |
| D2 | **Cron library: `cron-parser`** (MIT, pure TypeScript, widely used; licence and current maintenance [Unknown — i25-api confirms before adding it]). It parses 5-field expressions, computes next/previous dates in an IANA timezone, and handles DST. 6-field (seconds) expressions are rejected: a minute is the resolution. Macros `@hourly`, `@daily`, `@weekly`, `@monthly` are accepted. Rejected alternatives: `croner` (also fine; `cron-parser` was picked for its explicit `prev()`/`next()` iteration with timezones, which D6 needs), the `cron` package behind `@nestjs/schedule` (built to run jobs, not to enumerate occurrences), hand-rolled parsing. | new |
| D3 | **Minimum interval** between two firings of one schedule is 5 minutes (checked over the next 10 occurrences on save). `* * * * *` is refused with `interval_too_short`. Agent runs are long and costly; a minute-level schedule is a mistake. | new |
| D4 | **Timezone** is an IANA name stored per schedule, default the creating user's browser timezone, validated against `Intl.supportedValuesOf('timeZone')`. Fire times are stored in UTC. DST: a skipped local time does not fire that day; a repeated local time fires once. | new; `cron-parser` behaviour [Unknown — the i25-api slot verifies with tests] |
| D5 | **Scheduler loop.** One loop in the API, ticking every 15 s:<br>1. Only the instance holding `pg_try_advisory_lock(hashtext('agentdock.scheduler'))` on a dedicated connection runs ticks. Others retry every 30 s.<br>2. `SELECT … FROM schedules WHERE enabled AND "nextRunAt" <= now() ORDER BY "nextRunAt" LIMIT 20 FOR UPDATE SKIP LOCKED`.<br>3. For each row, in the same transaction: insert a `schedule_firings` row (`due`), advance `nextRunAt` per D6, commit.<br>4. After commit, send the runner command for each `due` firing (D8).<br>No Redis, no external queue. | ADR-0007; #22 D7 (advisory-lock pattern) |
| D6 | **Missed-run policy**, applied when `nextRunAt` is more than 2 minutes in the past at claim time (API down, runner offline, tick backlog):<br>• `skip` — record one `skipped` firing for the newest missed occurrence, fire nothing, set `nextRunAt` to the next future occurrence;<br>• `catch_up` — fire **once** for the newest missed occurrence (no burst for every missed one), mark older missed occurrences as a single `skipped` firing with `missedCount`, then set `nextRunAt` to the next future occurrence.<br>Catch-up is capped at 24 hours: a run missed by more than that is `skipped` whatever the policy. Default policy: `skip`. | new |
| D7 | **Overlap.** If the previous firing of the same schedule is still `running` (its run not finished), the new occurrence is recorded as `skipped` with reason `previous_still_running`. One schedule never has two live runs. | new |
| D8 | **Firing.** A `due` firing sends the target's command through `RunnerCommandService` (#6 D8) as the system actor with the schedule's creator recorded as `onBehalfOf`. Outcomes:<br>• command accepted → firing `started`, linked to the `runs` row the command created (`runs.triggeredByType = schedule`, `triggeredById = scheduleId`, #21);<br>• runner offline or command `error` / `unknown` → firing `failed` with the error; no retry inside the same occurrence;<br>• `orchestrator.start` answering `already_running` → firing `noop` (not an error).<br>The firing moves to `succeeded` / `failed` when its run ends (projector on `runs.updatedAt`, as #21 D7). | #6 D8; #17 D1; #21 D7 |
| D9 | **Runner offline** is checked before sending: if the project's runner is not `online` (#6 D5), the firing is `failed` with `runner_offline` immediately, and D6 applies to the next tick only if the policy is `catch_up` (the occurrence counts as missed, retried once within the 24-hour cap when the runner returns). | #6 D5 |
| D10 | **Authority of the creator.** A schedule fires with the authority its creator has **at fire time**: if the creator is no longer an active operator+ member of the project, the firing is `failed` with `creator_not_authorized` and the schedule is disabled with a notification to admins. Schedules do not outlive the people who made them. | ADR-0008 |
| D11 | **Auto-disable.** Five consecutive `failed` firings disable the schedule (`disabledReason: "failing"`) and emit `schedule.disabled`. | new |
| D12 | **Pre-fire hook.** One function, `beforeFire(schedule, firing)`, returns `allow \| deny(reason)`. It allows everything in this item; #28 (budgets) plugs in there. | #28 |
| D13 | **System jobs** are listed read-only from `@nestjs/schedule`'s `SchedulerRegistry.getCronJobs()`: name, cron expression, next date, last date. Modules that own them (#8 audit verification, #13 rollups, #22 digests) are not edited. A job without a name shows as `unnamed`. | #8 D6; #13; #22 |
| D14 | **Roles.** Viewer: list schedules and firings. Operator of the project: create, edit, enable/disable, delete, "run now". Admin: everything, plus `/admin/schedules` across projects and the system jobs list. Non-member → 404 (#10 D12). | ADR-0008; #10 D12 |
| D15 | **Run now** fires one occurrence immediately (firing `manual`), respecting D7 and D10, and does not move `nextRunAt`. | new |
| D16 | **Audit.** Recorded through #8's `AuditService` with new actions in its closed union: `schedule.create`, `schedule.update`, `schedule.enable`, `schedule.disable`, `schedule.delete`, `schedule.run_now`. Each firing is **not** audited (it is in `schedule_firings` and `runs`); auto-disable is audited as `schedule.disable` with actor `system`. | #8 D5 |
| D17 | **Events and live.** The API writes events `schedule.fired`, `schedule.skipped`, `schedule.failed`, `schedule.disabled` (source `api`) and publishes `schedule.updated` / `schedule_firing.updated` on `project:<id>` through #9's `LiveService`. #22 may add a notification kind for `schedule.disabled` later; not in this item. | #9 D11; event-schema.md |
| D18 | **UI.** The cron field uses glass-ui `CronInput` from [AndreyBegma/glass-ui#74](https://github.com/AndreyBegma/glass-ui/issues/74) once tagged. Until then: a plain `Input`, a human-readable description (`cronstrue`, MIT) and the next 5 run times from `GET …/preview`. | ADR-0011 |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261031000000_schedules/`. New tables only.

| Table | Fields |
|---|---|
| `schedules` | `id` cuid, `projectId` → projects (cascade delete), `name`, `target` Json (D1), `cron`, `timezone`, `missedPolicy` (`skip` \| `catch_up`), `enabled` Bool default true, `disabledReason?` (`manual` \| `failing` \| `creator_not_authorized`), `nextRunAt?` timestamptz, `lastRunAt?`, `consecutiveFailures` Int default 0, `createdById` → users, `updatedById?` → users, `createdAt`, `updatedAt`; index `(enabled, nextRunAt)`, `(projectId)` |
| `schedule_firings` | `id` BigInt autoincrement, `scheduleId` → schedules (cascade delete), `scheduledFor` timestamptz, `firedAt?`, `kind` (`cron` \| `catch_up` \| `manual`), `status` (`due` \| `started` \| `noop` \| `skipped` \| `failed` \| `succeeded`), `reason?`, `missedCount` Int default 0, `runId?` → runs, `commandRunId?`, `error?` Json, `finishedAt?`; unique `(scheduleId, scheduledFor, kind)`; index `(scheduleId, scheduledFor)` |

`runs` (#21) and `skill_runs` (#24) are not altered: a scheduled run is created
by `skill.run` / `orchestrator.start` with `triggeredByType = schedule`, which
#21 already defines.

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| GET | `/projects/:projectId/schedules` | viewer | schedules with next run, last firing status |
| POST | `/projects/:projectId/schedules` | operator | `{ name, target, cron, timezone, missedPolicy, enabled }`; 422 `invalid_cron`, `interval_too_short`, `invalid_timezone`, `invalid_target` |
| GET | `/projects/:projectId/schedules/:id` | viewer | detail + last 50 firings |
| PATCH | `/projects/:projectId/schedules/:id` | operator | partial update; recomputes `nextRunAt`; re-enabling resets `consecutiveFailures` |
| DELETE | `/projects/:projectId/schedules/:id` | operator | delete schedule and firings (runs remain) |
| POST | `/projects/:projectId/schedules/:id/run-now` | operator | D15 → firing |
| POST | `/schedules/preview` | signed-in | `{ cron, timezone }` → `{ description, next: [5 ISO dates] }` or 422 |
| GET | `/admin/schedules?projectId=&enabled=` | admin | all schedules across projects |
| GET | `/admin/system-jobs` | admin | D13 |

## UI

- **`/projects/[projectId]/schedules`** — table: name, target (skill name + args summary, or `orchestrator next`), cron with its description, timezone, next run, last firing status (`Badge`), enabled `Toggle`. Row actions: Edit, Run now, Delete (confirm).
- **Schedule dialog** — name; target kind (`SegmentedControl` skill / orchestrator); for skill: skill picker from the project's installed skills (#24), args, profile, model, output report/PR; cron field (D18) with description and next 5 times; timezone `Combobox`; missed policy with a one-line explanation of each.
- **Schedule detail sheet** — firings timeline with status, reason, link to the run (#21 run detail).
- **`/admin/schedules`** — the same table across projects with a project column, plus a read-only *System jobs* section (D13).
- Nav: the project section gains *Schedules*; the admin section gains *Schedules* (one line each in `nav.ts`).

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `SCHEDULER_ENABLED` | `apps/api` | `false` disables the tick loop on this instance (tests, maintenance); default `true` |

## Acceptance criteria

- [ ] A schedule `0 3 * * *` in `Europe/Kyiv` stores `nextRunAt` equal to the next 03:00 Kyiv time in UTC; the preview returns the same five times and a description.
- [ ] `* * * * *` and `*/2 * * * *` are refused with `interval_too_short`; a 6-field expression with `invalid_cron`; `Mars/Olympus` with `invalid_timezone`.
- [ ] With a fake clock, a due schedule produces exactly one `schedule_firings` row and one `skill.run` (or `orchestrator.start`) command; `nextRunAt` advances.
- [ ] Two API instances against one database: only one ticks (advisory lock); killing it lets the other take over within 30 s; no occurrence fires twice (unique `(scheduleId, scheduledFor, kind)`).
- [ ] Missed by 3 occurrences with `skip`: one `skipped` firing, no command. With `catch_up`: one command for the newest occurrence and one `skipped` firing with `missedCount: 2`. Missed by more than 24 hours with `catch_up`: `skipped` only.
- [ ] A firing while the previous run of the same schedule is `running` is `skipped` with `previous_still_running`.
- [ ] Runner offline at fire time → `failed` with `runner_offline`; five consecutive failures disable the schedule and emit `schedule.disabled`.
- [ ] A schedule whose creator was disabled (or lost operator membership) fails with `creator_not_authorized` and is disabled.
- [ ] `orchestrator.start` answering `already_running` records `noop`, not `failed`, and does not count toward D11.
- [ ] A scheduled run appears in project history (#21) with `triggeredByType: schedule` and links back to the schedule.
- [ ] `/admin/system-jobs` lists the jobs registered by #8, #13 and #22 with their next dates, without any edit in those modules.
- [ ] Create, update, enable, disable, delete and run-now each write an audit record; auto-disable writes one with actor `system`.
- [ ] **Authorization:** a viewer gets 403 on create, update, delete and run-now; a non-member gets 404 on every `/projects/A/schedules*` route even when a member of project B; `/admin/schedules` and `/admin/system-jobs` return 403 to operators.
- [ ] **Authorization:** an operator of project A cannot create a schedule whose `profileId` belongs to a runner other than project A's (422 `invalid_target`).
- [ ] `bun run check`, `bun run test`, `bun run build` pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i25-api | tables, scheduler, firing, preview, system jobs listing, endpoints, audit actions | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261031000000_schedules/**, apps/api/src/schedules/**, apps/api/src/app.module.ts, apps/api/package.json, packages/shared/src/schedules/**, packages/shared/src/index.ts, packages/shared/src/audit/actions.ts, bun.lock | — | yes | opus |
| i25-web | project schedules page, dialog, detail, admin page | apps/web/src/app/(app)/projects/[projectId]/schedules/**, apps/web/src/app/admin/schedules/**, apps/web/src/lib/schedules/**, apps/web/src/components/shell/nav.ts, apps/web/package.json, bun.lock | i25-api | no | sonnet |

The runner gets no new code: `skill.run` (#24) and `orchestrator.start` (#17)
already exist. Honestly two slots in sequence.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i25-api | distinct new tables only; keep both blocks on conflict (#26, #27, #28 run nearby) |
| apps/api/src/app.module.ts | i25-api | append-only registration; keep both imports |
| packages/shared/src/index.ts | i25-api | one export line; keep both |
| packages/shared/src/audit/actions.ts | i25-api | #8's closed union; appended members only, keep both |
| apps/web/src/components/shell/nav.ts | i25-web | one line per entry; keep both |
| protocol commands.ts, commands/<area>.ts, protocol index.ts, runner command handler registry | — | not touched by this item |
| bun.lock | regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) | — |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| A schedule burns the subscription unattended (hourly `next` on a big queue) | high | 5-minute minimum interval; overlap skip (D7); auto-disable on failures; budgets plug into D12 (#28) |
| A former teammate's schedules keep acting on their behalf | medium | authority re-checked at fire time (D10) |
| DST or timezone bugs fire twice or never | medium | UTC storage; unique `(scheduleId, scheduledFor, kind)`; DST cases in tests |
| Clock skew between API and runner | low | the API decides when to fire; the runner only executes |
| `@nestjs/schedule` jobs without names make the system list useless | low | listed as `unnamed`; owners can name them later |

## Notes

Decided while landing the API slot (i25-api); the orchestrator approved each one on 2026-10-09.

- **Q1 — an orchestrator target has no `runs` row.** `orchestrator.start` (#17) writes a `command_runs` row; nothing creates a `runs` row for it. An orchestrator firing links `commandRunId`, is `succeeded` when the command returns ok, `noop` on `already_running`, and is never `started`. The orchestrator's rounds are in history as their slots' runs (`triggeredByType: orchestrator`). The history criterion — `triggeredByType: schedule`, `triggeredById` = the schedule — holds for skill targets. D7 for an orchestrator target is `already_running → noop`.
- **Q2 — no `events` rows.** The `events` table is runner-scoped (`runnerId` required, unique `(runnerId, seq)`) and has no API-sourced path. `schedule.fired` / `.skipped` / `.failed` / `.disabled` are published live on `project:<id>` beside `schedule.updated` / `schedule_firing.updated`; `schedule_firings` is the durable record. Follow-up: an API event source.
- **Q3 — system jobs.** Only jobs on `SchedulerRegistry` are listed: today `audit-verification` (#8) and `activity-retention` (#21). Usage rollups (#13) and the notification loops (#22) run on plain timers and appear once their modules register them. Cron jobs carry their expression and dates; named intervals carry their name only. Follow-up: #13/#22 register with the registry.
- **Q4 — leader election is tested in-process.** Two `SchedulerService` instances, each with its own lock connection: the second cannot lead while the first holds the lock, and takes over once the first's connection closes (a follower retries every 30 s).
- **D8 `onBehalfOf`.** `AuditActor` has no `onBehalfOf`. Commands are sent as the `system` actor with the creator's project role; the person is reached through `runs.triggeredById → schedules.createdById` (skill) and `command_runs.userId` = creator (orchestrator). Follow-up: `onBehalfOf` on `AuditActor`.
- **D10 admin notification.** Auto-disable is audited (`schedule.disable`, actor `system`) and published live; the admin notification is #22's follow-up, as D17 says for `schedule.disabled`.
- **D11 counter.** +1 when a firing becomes `failed` (refused at fire time, or its run ends failed); reset to 0 only by a `succeeded` firing; `started`, `noop` and `skipped` leave it alone.
- **D9 retry under `catch_up`.** A `cron` firing failed `runner_offline` rewinds `nextRunAt` to its occurrence. While the runner stays offline later ticks leave it (no new firing, no new failure); once it is back, D6 applies with that occurrence already recorded: it fires once as `catch_up`, or a newer one does. Past 24 hours it is skipped. A `catch_up` firing that fails offline is not retried again.
- **D6 "missed by more than 24 hours"** is measured on the newest occurrence up to now: the one a `catch_up` would fire.
- **D4 timezone validation.** On Node, `Intl.supportedValuesOf('timeZone')` lists canonical names only — it lacks `UTC` and has `Europe/Kiev` but not `Europe/Kyiv`. A name it does not list is accepted when it has the IANA shape (`Area/Location`, or `UTC`) and `Intl.DateTimeFormat` resolves it; offsets such as `+02:00` are refused.
- **D4 DST.** `cron-parser` moves a local time a spring-forward skips to the next hour; the API drops that occurrence instead. A local time a fall-back repeats fires the first time only.
- **D2 library versions.** `cron-parser` 5.10.1 (MIT) and `cronstrue` 3.27.0 (MIT, the preview's `description`), pinned exactly.
- **D1 model default.** A skill target without `model` fires with `opus` (`SCHEDULE_DEFAULT_MODEL`) — #24 has no server-side default; it matches the orchestrator default.
- **Stale `due`.** A firing still `due` ten minutes after its occurrence (the API stopped between commit and send) is `failed` with error `not_sent`, never resent (at-most-once, as runner commands are).

## Open questions

| Question | Default if nobody answers |
|---|---|
| Should a schedule pause automatically while its project's orchestrator is stopped? | No — schedules are independent; `orchestrator next` simply starts it |
| Notify the creator on every failed firing? | No — only on auto-disable (via an event #22 can subscribe to later) |

Depends on #24

Depends on #17
