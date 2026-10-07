# Activity feed and execution history

Issue: [#21](https://github.com/AndreyBegma/AgentDock/issues/21) · Roadmap: M2.6 ·
Decisions: [ADR-0005](../adr/0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md),
[ADR-0007](../adr/0007-postgresql-only.md), [data-model.md](../architecture/data-model.md),
[event-schema.md](../architecture/event-schema.md)

## Summary

Two questions are still unanswerable without a terminal: *what has happened
across my projects in the last hour*, and *what did the fleet actually deliver,
at what cost*. This item answers both. The **activity feed** is one curated,
filterable, live stream built from runner events (#6, #11) and audit records
(#8). The **execution history** introduces the `runs` table from the data model,
one row per unit of agent work. In this item that unit is an orchestrator slot,
backfilled from #11's slots. Skill runs and scheduled runs (M3) add rows of the
other kinds later without a schema change. Both are scoped by project
membership.

## Scope

### In scope

- `activity_items` projection, its projector and cursor state, retention.
- `runs` table, the slot → run projector, and the backfill.
- Activity endpoints (global and per project) with keyset pagination, filters and live pushes.
- History endpoints: list and run detail, including tokens and cost when #12 / #13 data exists.
- Web `/activity`, the project Activity tab `/projects/[projectId]/activity`, `/projects/[projectId]/history` and `/projects/[projectId]/history/[runId]`.

### Out of scope

- Skill runs and schedules (M3.1, M3.2). They write `runs` rows of kind `skill` / `schedule` themselves.
- Notifications (#22). It reads events on its own and does not depend on this projection.
- Raw event explorer for every event type. `llm.request` / `tool.call` stay in sessions (#12).
- Export of activity. Audit export exists in #8.

## Decisions

The person delegated all decisions on 2026-10-07. Each row is the default taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | **Materialized projection, not a SQL view.** `activity_items` is written by a projector, for four reasons:<br>• `events` has no `projectId` (only `runnerId` + `projectRepo`) and no actor;<br>• `audit_records` has a different shape and must never be joined into hot queries in a way that tempts an UPDATE;<br>• the feed shows ~25 curated types out of a stream dominated by `llm.request` / `tool.call` / `pane.*`;<br>• membership filtering plus keyset pagination over a `UNION` with a per-row project resolution would be slow and hard to index.<br>One narrow table with `(projectId, ts, id)` indexes is cheap in Postgres. | ADR-0007; #6 `events` shape [Confirmed]; #8 `audit_records` shape [Confirmed] |
| D2 | **Projector input by cursor, not by hooks.** The projector tails `events` by `id` and `audit_records` by `seq`. It polls every 2 s and also wakes on a local signal. It keeps both cursors in `activity_projector_state`. It never edits #6's ingest, #8's `AuditService` or #11's projector, so no other module's files are touched. Replay is idempotent through a unique `(sourceKind, sourceId)`. | new; keeps #6 / #8 / #11 untouched |
| D3 | **Curated type map** in `packages/shared/src/activity/types.ts`, from source type to `{ category, severity, title template, link builder }`. Unmapped types are skipped, not shown raw. Initial set:<br>• **fleet:** `orchestrator.started` / `stopped`, `round.started`, `slot.dispatched`, `slot.resumed`, `slot.redispatched`, `slot.checkpoint`, `slot.stopped`, `slot.message_sent`, `slot.fence_widened`, `pr.opened`, `pr.checks_changed` (only on change to red or green), `pr.merged`, `pr.closed`, `issue.blocked`, `person.needed`, `pane.prompt`, `pane.quota_hit`, `session.vanished` (cs- only), `commit.trailer_found`;<br>• **runner:** `runner.spool_truncated`;<br>• **audit:** user / registration / runner / project actions from #8's closed action union, excluding `auth.login` ok. | event-schema.md; #11 D7; #8 D5 |
| D4 | **Project resolution.** An event's project is found by `(runnerId, projectRepo)` against `projects` (#10). An audit record uses its `projectId`. Items with no project (runner- and user-level audit) get `projectId = null` and are visible to admins only. | #10 D14; ADR-0008 |
| D5 | **Actor.** For audit items: the user (or `runner` / `system`). For runner events: `runner:<id>` plus the slot if present. `person.needed` / `issue.blocked` have actor `orchestrator`. | #8 D5 |
| D6 | **Retention.** `activity_items` older than 180 days are deleted by a daily job. Audit is never deleted, so the feed is rebuildable from source within the `events` retention. | new |
| D7 | **Runs.** `runs` follows data-model.md with `kind` = `orchestrator_slot` \| `skill` \| `schedule`. A slot run is keyed by `slotId` (unique). The projector watches `slots.updatedAt` by cursor (D2 style) and maps:<br>• slot status → run `status` (`running` \| `blocked` \| `waiting_person` \| `succeeded` \| `failed` \| `abandoned`);<br>• `outcome` text = the last checkpoint summary;<br>• `prNumber` / `prUrl`, `startedAt`, `endedAt`, `durationMs`.<br>The `succeeded` state requires the PR to be merged; `failed` covers closed-unmerged, `abandoned` covers ended without PR. Backfill on first start covers every existing slot. | data-model.md; #11 D8 |
| D8 | **Tokens and cost of a run** are computed on read from `llm_requests` joined to `sessions` (#12) by `(projectId, slotName)` within the run's time window. Cost is `SUM(costUsd)`, `null` while #13 has not priced them, and the count of unpriced requests is reported. #13's `usage_rollups` are not required. When `runId` is present on rollups later, the read switches without a schema change. | #12 D8; #13 D8 |
| D9 | **Live.** New items publish `activity.item` on `project:<id>`, or on `admin` for project-less items, through #9's `LiveService`. Run changes publish `run.updated` on `project:<id>`. | #9 D11, D14 |
| D10 | **Authorization.** Per-project routes use `ProjectAccessGuard` (non-member → 404, per #10 D12). The global feed returns only items of the caller's projects, plus project-less items for admins. Read-only, so viewer suffices. | #10 D12; ADR-0008 |
| D11 | **Pagination** is keyset on `(ts DESC, id DESC)` with an opaque cursor, 50 per page, maximum 200. | new |
| D12 | **UI.** The feed uses glass-ui `Timeline` from [AndreyBegma/glass-ui#70](https://github.com/AndreyBegma/glass-ui/issues/70) once tagged. Until then it falls back to a day-grouped list built from `Card`-less rows, `Badge` and `Avatar`. History uses `DataTable` from glass-ui#67, falling back to `Table`. | ADR-0011 |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261023000000_history/`. New tables only.

| Table | Fields |
|---|---|
| `activity_items` | `id` BigInt autoincrement, `ts`, `projectId?` → projects (cascade delete), `category` (`fleet` \| `runner` \| `audit`), `type`, `severity` (`info` \| `ok` \| `warn` \| `danger`), `title`, `actorType` (`user` \| `runner` \| `orchestrator` \| `system`), `actorId?`, `slot?`, `issue?` Int, `prNumber?` Int, `link?`, `data` Json (≤ 4 KB, no secrets), `sourceKind` (`event` \| `audit`), `sourceId` BigInt; unique `(sourceKind, sourceId)`; index `(projectId, ts, id)`, `(ts, id)`, `(type, ts)` |
| `activity_projector_state` | `id` (single row `"activity"`), `eventsCursor` BigInt, `auditCursor` BigInt, `slotsCursor` timestamptz, `updatedAt` |
| `runs` | `id` cuid, `kind` (`orchestrator_slot` \| `skill` \| `schedule`), `projectId` → projects, `slotId?` → slots (unique), `issue?` Int, `title?`, `runtime?`, `model?`, `profileKey?`, `args?` Json, `output?` (`report` \| `pr`), `status`, `outcome?`, `prNumber?` Int, `prUrl?`, `triggeredByType` (`orchestrator` \| `user` \| `schedule` \| `webhook`), `triggeredById?`, `startedAt`, `endedAt?`, `durationMs?` Int, `updatedAt`; index `(projectId, startedAt)`, `(projectId, status)` |

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| GET | `/activity?projectId=&category=&type=&actor=&slot=&from=&to=&cursor=&limit=` | signed-in | items of the caller's projects (plus project-less for admins), newest first |
| GET | `/projects/:projectId/activity?…` | project member | same filters, one project |
| GET | `/projects/:projectId/runs?kind=&status=&issue=&from=&to=&cursor=` | project member | runs, newest first, with `tokens` totals and `costUsd` (D8) |
| GET | `/projects/:projectId/runs/:runId` | project member | run detail: slot fields, checkpoints (#11), PR, sessions (#12) with per-session tokens/cost, activity items for the slot |

## UI

- **`/activity`** — global feed with filter bar (`Toolbar`: project, category, type, actor, date range). Live insertion at the top with a "N new" pill when scrolled. Load more at the bottom.
- **`/projects/[projectId]/activity`** — the same feed component, fixed to one project.
- **`/projects/[projectId]/history`** — runs table with columns:
  - run (issue + slot);
  - kind;
  - runtime / model;
  - status badge;
  - PR (with checks state from the slot);
  - duration;
  - tokens;
  - cost (or "unpriced");
  - started.

  Filters for status and date.
- **`/projects/[projectId]/history/[runId]`** — detail: summary key/values, checkpoints timeline, sessions list linking to `/sessions/[id]`, related activity.
- Nav: Activity (global) and History (project) entries flip to `enabled` in `nav.ts`.

## Configuration

| Key | Where | Meaning |
|---|---|---|
| `ACTIVITY_RETENTION_DAYS` | `apps/api` | default 180 (D6) |
| `ACTIVITY_POLL_MS` | `apps/api` | projector poll interval, default 2000 |

## Acceptance criteria

- [ ] Ingesting a fixture stream with 1 000 `llm.request`, 50 `pane.idle` and 10 curated fleet events creates exactly 10 activity items. Replaying the stream creates none.
- [ ] An audit record `user.approve` appears in the feed as category `audit` with the admin as actor. `auth.login` with result `ok` does not appear.
- [ ] An event from a runner whose `projectRepo` maps to project A is shown under A. An unmapped repo produces no item and does not stall the cursor.
- [ ] Restarting the API mid-stream resumes from the stored cursors with no gaps and no duplicates.
- [ ] Every existing slot gets exactly one `orchestrator_slot` run on first start. A slot whose PR merged maps to `succeeded`, closed-unmerged maps to `failed`, and ended without PR maps to `abandoned`.
- [ ] A run's tokens equal the sum of its slot's `llm_requests` in the window. Cost is `null` with `unpricedRequests > 0` while prices are absent.
- [ ] A new curated event reaches an open `/activity` page within 5 s without reload.
- [ ] Keyset pagination returns stable pages while new items are inserted at the top.
- [ ] **Authorization:** a member of project A only, calling `GET /activity`, receives no item of project B and no project-less item. `GET /projects/B/activity`, `/projects/B/runs` and `/projects/B/runs/:id` return 404 for them.
- [ ] **Authorization:** a non-admin never receives project-less items through the live channel (`admin` topic refused per #9).
- [ ] Items older than the retention are removed by the daily job. Audit records are untouched.
- [ ] `bun run check`, `bun run test` and `bun run build` pass. Projectors are covered by unit tests over fixture rows.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i21-api | schema, migration, type map, projectors, backfill, endpoints | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261023000000_history/**, apps/api/src/activity/**, apps/api/src/history/**, apps/api/src/app.module.ts, packages/shared/src/activity/**, packages/shared/src/index.ts | — | yes | opus |
| i21-web | activity and history pages | apps/web/src/app/(app)/activity/**, apps/web/src/app/(app)/projects/[projectId]/activity/**, apps/web/src/app/(app)/projects/[projectId]/history/**, apps/web/src/lib/activity/**, apps/web/src/lib/history/**, apps/web/src/components/shell/nav.ts | i21-api | no | sonnet |

The web slot is cut after the API contract merges. This issue may run in
parallel with #22, which owns distinct tables and modules.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i21-api | distinct new tables only; keep both blocks on conflict (shared with #22) |
| apps/api/src/app.module.ts | i21-api | append-only registration; keep both imports |
| packages/shared/src/index.ts | i21-api | one export line; keep both |
| apps/web/src/components/shell/nav.ts | i21-web | one-line flag flips; keep both |
| `events`, `audit_records`, `slots` tables | #6, #8, #11 | read only here — never altered |
| bun.lock | regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) | — |

Cross-repository: the feed prefers glass-ui `Timeline` from
AndreyBegma/glass-ui#70 and the history table prefers `DataTable` from
AndreyBegma/glass-ui#67. Neither is a blocking dependency.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Polling projector lags under heavy `llm.request` ingest | medium | cursor scan filtered by `type IN (curated)` on the `(type, ts)` index; batch 1 000; lag metric logged |
| Curated map misses a type users care about | low | the map is data in `packages/shared`; adding a type is one line |
| Run status derived wrong for edge cases (resumed slot, re-dispatch on another model) | medium | `opus` on i21-api; resumed/redispatched keep the same run (same slot id) and record the event in the feed |
| glass-ui#70 not tagged in time | low | fallback list; swap later |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Should operators be able to hide noisy types per user? | Not here — filter bar only; per-user rules are #22's notifications |
| Should a run aggregate several slots of one wave? | No — one run per slot; the issue groups them in the UI |

Depends on #11

Depends on #12

Depends on #8
