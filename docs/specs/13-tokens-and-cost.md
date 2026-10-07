# Tokens and API-equivalent cost

Issue: [#13](https://github.com/AndreyBegma/AgentDock/issues/13) · Roadmap: M1.7 ·
Decisions: [ADR-0003](../adr/0003-usage-from-opentelemetry-transcripts-as-backfill.md),
[ADR-0009](../adr/0009-api-equivalent-cost-from-a-versioned-price-table.md),
[cost-model.md](../architecture/cost-model.md), [event-schema.md](../architecture/event-schema.md)

## Summary

#12 records every LLM request an agent made, with its token buckets, and leaves
its cost empty. This item puts a price on each request: a versioned price
table (seeded from Langfuse's public model prices), cost computed when a request
is ingested, hourly rollups for dashboards, and a `/usage` screen that answers
"what did this project, issue, slot, model or runtime cost". It also gives the
runner an OTLP receiver, so sessions it launches report usage live instead of
waiting for transcript parsing. The figure is the **API-equivalent cost** —
what the tokens would cost at public API prices — because the owner runs on
subscriptions (cost-model.md).

## Scope

### In scope

- Tables `price_versions`, `model_prices`, `usage_rollups`; seed from a vendored
  snapshot of Langfuse's `default-model-prices.json`.
- Cost computation at ingest, filling the cost columns #12 declares on
  `llm_requests`; "unpriced" stays `null`.
- Admin price editing (as new versions) and recompute of a date range.
- Hourly rollups and the usage API, authorized by project membership.
- Runner OTLP/HTTP receiver mapping Claude Code and Codex request events to
  `llm.request` events, deduplicated against transcript-derived requests.
- Web: `/usage` and `/admin/prices`.

### Out of scope

- Injecting `OTEL_*` / `OTEL_RESOURCE_ATTRIBUTES` into the sessions the
  orchestrator dispatches — plugin change **P4** in
  [code-sentinel-changes.md](../plugin/code-sentinel-changes.md). Until it
  lands, only sessions the runner itself launches (later items) and sessions a
  person starts with telemetry on reach the receiver; everything else arrives
  through #12's transcript ingestion.
- Budgets, alerts and hard stops — M3.5.
- Tokenizer-based estimation of usage (cost-model.md: the runtimes report exact
  usage; we never infer tokens).
- OTLP metrics and traces — logs only in this item.

## Decisions

The person delegated all decisions on 2026-10-07; each below is the default
taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | Token buckets are exactly those of #12's `llm_requests`: `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`, `reasoning`. Every token is in one bucket | cost-model.md |
| D2 | A **price version** is an immutable snapshot of every model price. Editing prices creates a new version cloned from the current one with the edits applied; the newest version is current. Rows are never updated in place | ADR-0009 |
| D3 | A model price is `modelName`, `matchPattern` (case-insensitive regex against the request's model id), `priority` (lower wins when several match), and ordered `tiers`. A tier has `name`, `isDefault`, `conditions[]` (`{ bucket \| "totalInput", op: gt\|gte\|lt\|lte, value }`) and `prices` (USD per token per bucket). The first tier whose conditions all hold applies; otherwise the default tier | Langfuse model definitions (inspiration); cost-model.md |
| D4 | Seed: a JSON snapshot of Langfuse's `worker/src/constants/default-model-prices.json` committed under `apps/api/prisma/seed-data/langfuse-model-prices.json` with an `ATTRIBUTION.md` (source URL, commit, MIT licence). A converter maps Langfuse usage keys to our buckets: `input` → input; `output` → output; `cache_read_input_tokens`, `input_cached_tokens`, `input_cache_read` → cacheRead; `input_cache_creation_5m`, `cache_creation_input_tokens` → cacheWrite5m; `input_cache_creation_1h` → cacheWrite1h; `output_reasoning_tokens`, `output_reasoning` → reasoning. Unknown keys are reported by the converter and dropped. The seed creates price version 1 (`source: "langfuse-seed"`) only when no version exists | ADR-0009; Langfuse licence MIT for the open-source core [Confirmed by research 2026-10-07] |
| D5 | Reasoning tokens are priced at the `output` price when a model has no explicit reasoning price, and counted once — a request's `output` bucket from #12 must not already include them | [Unknown — #12 owns the bucket split; i13-api verifies against #12's parsers and records the finding in this spec] |
| D6 | Cost is computed at ingest, in the same transaction that stores the `llm_request`, with the current version: `costUsd = Σ bucket × price`, stored with `priceVersionId` and `costSource = "computed"`. No matching model → `costUsd = null`, counted as "unpriced", never zero. The runtime's own `cost_usd` (Claude Code OTel) is stored as `reportedCostUsd` for reference and never used for totals | cost-model.md |
| D7 | Recompute: an admin picks a date range and a version; a background job re-prices `llm_requests` in batches of 1 000, rebuilds the affected rollup hours, and records progress in `price_recomputes`. One recompute runs at a time | ADR-0009 |
| D8 | Rollups: one row per hour × project × runtime × model × slot × run × issue (absent dimensions empty), keyed by a computed `dimensionKey` string so the unique index has no nullable columns. Updated by upsert-increment at ingest; rebuilt by recompute. Columns: request count, every token bucket, `costUsd`, `unpricedRequests` | cost-model.md |
| D9 | Authorization: a non-admin sees usage only for projects they are a member of (#10's project-access guard). A `projectId` the caller is not a member of returns 404. Usage with no project (machine-wide sessions) is admin-only. Price administration and recompute are admin-only | ADR-0008; #10 |
| D10 | Time: all buckets are UTC hours; the API takes `from`/`to` as ISO instants and a `tz` for day grouping (default `UTC`) | new |
| D11 | OTLP receiver: OTLP/HTTP only, on `127.0.0.1:4318` (configurable in the runner config's reserved `otlp` key from #5), `POST /v1/logs` accepting `application/x-protobuf` and `application/json`. `/v1/metrics` and `/v1/traces` answer 200 and discard. gRPC is not implemented: both runtimes can export OTLP/HTTP, and it avoids an HTTP/2 server in the runner | ADR-0003; Claude Code supports `http/protobuf` and `http/json` [Confirmed by research]; Codex `otlp-http` [Confirmed by research] |
| D12 | Protobuf decoding uses `protobufjs` with the OTLP `logs/v1` definitions vendored as a JSON descriptor under `apps/runner/src/otlp/proto/` (Apache-2.0, attribution file) — no OpenTelemetry SDK dependency | new |
| D13 | Mapping: Claude Code `claude_code.api_request` log records → `llm.request` with `model`, `requestId` (`request_id`), tokens `input_tokens` → input, `output_tokens` → output, `cache_read_tokens` → cacheRead, `cache_creation_tokens` → cacheWrite5m (flagged `cacheWriteTtlUnknown: true`), `duration_ms`, `cost_usd` → `reportedCostUsd`, `session.id`, `query_source`, `agent.name`. Codex `codex.api_request` / `codex.sse_event` (token counts) → `llm.request` with `input_tokens`, `output_tokens`, `cached_input_tokens` → cacheRead, `reasoning_output_tokens` → reasoning. Attribute names are verified against a captured fixture of each runtime before the mapping is final | event-schema.md; Claude Code names [Confirmed by research]; Codex attribute names [Unknown — capture a fixture with codex installed, else ship Claude only and mark Codex mapping experimental] |
| D14 | Correlation: resource attributes `agentdock.project`, `agentdock.slot`, `agentdock.issue`, `agentdock.run` (from `OTEL_RESOURCE_ATTRIBUTES`) are copied onto the event envelope (`project`, `slot`, `issue`, `data.run`). Without them, the API attaches the request to the session #12 already knows by `session.id` | event-schema.md |
| D15 | Dedupe: an `llm_request` is unique per `(sessionId, requestId)` — #12's unique index. OTel `claude_code.api_request` carries `session.id`, the same UUID as the transcript session [Confirmed: event-schema / Claude Code monitoring docs]; for Codex the mapping is [Unknown] until fixtures exist. OTel arrives first for live sessions; the transcript copy of the same request updates only fields OTel lacks (e.g. splits `cacheWrite5m`/`cacheWrite1h`) and recomputes cost. Requests without an id are not deduplicated | ADR-0003, #12 D5 |
| D16 | The receiver accepts only loopback connections and rejects bodies over 4 MiB; it never forwards prompt or tool content even when a runtime sends it (`OTEL_LOG_USER_PROMPTS`): only the attributes in D13 leave the runner | security.md |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261013000000_cost/`. New
tables only; `llm_requests` (from #12) is written, not altered.

| Table | Fields |
|---|---|
| `price_versions` | `id`, `number` Int unique, `source` (`langfuse-seed` \| `admin`), `note?`, `createdById?` → users, `createdAt` |
| `model_prices` | `id`, `versionId` → price_versions, `modelName`, `matchPattern`, `priority` Int, `tiers` Json; unique `(versionId, modelName)` |
| `usage_rollups` | `id`, `hour` (timestamptz, truncated), `dimensionKey`, `projectId?`, `runtime`, `model`, `slot?`, `runId?`, `issue?` Int, `requests` Int, `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`, `reasoning` (BigInt each), `costUsd` Decimal(14,6), `unpricedRequests` Int; unique `(hour, dimensionKey)`; index `(projectId, hour)` |
| `price_recomputes` | `id`, `versionId`, `from`, `to`, `status` (`queued`\|`running`\|`done`\|`failed`), `processed`, `total`, `error?`, `createdById`, `createdAt`, `finishedAt?` |

Columns this item fills on `llm_requests` (declared by #12): `costUsd`,
`priceVersionId`, `costSource`, `reportedCostUsd`. If #12 named them
differently, i13-api uses #12's names and updates this table.

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| GET | `/usage/summary?from&to&projectId?` | member / admin | totals: cost, each bucket, requests, unpriced requests, by runtime |
| GET | `/usage/timeseries?from&to&interval=hour\|day&groupBy=none\|project\|model\|runtime&projectId?&tz?` | member / admin | series of `{ t, costUsd, tokens, requests }` per group |
| GET | `/usage/breakdown?from&to&dimension=project\|model\|runtime\|issue\|slot\|run&projectId?&limit?` | member / admin | top rows by cost, with unpriced counts |
| GET | `/admin/prices` | admin | current version and its model prices |
| GET | `/admin/prices/versions` | admin | versions with source, note, author, date |
| POST | `/admin/prices/versions` | admin | `{ note, upsert: ModelPrice[], remove: modelName[] }` → new version cloned from current; patterns validated as regexes |
| POST | `/admin/prices/test` | admin | `{ model, tokens }` → which model price and tier match and the cost — for checking a pattern before saving |
| POST | `/admin/prices/recompute` | admin | `{ from, to, versionId }` → recompute job; 409 when one is running |
| GET | `/admin/prices/recompute/:id` | admin | progress |

Ingest path (no new endpoint): the gateway from #6 receives `llm.request`
events; #12's ingestion stores them; this item's `CostService.price()` is called
inside that transaction and the rollup upsert follows it.

## Runner

`apps/runner/src/otlp/` — started by the daemon when `otlp.enabled` (default
true) in the runner config:

- HTTP server on loopback (D11), decoding per D12, mapping per D13–D14,
  emitting `llm.request` events into the #5 spool (so they survive a server
  outage like every other event).
- `runner.describe` reports the receiver's port and status in capabilities
  (`otlp: { http: 4318 }` already reserved by #5).
- Fixtures: one captured `claude_code.api_request` export (protobuf and JSON)
  in `apps/runner/src/otlp/fixtures/`, scrubbed of email and organization ids.

## UI

`/usage` (all roles, scoped by membership; reached from the shell's navigation
from #9):

- range picker (24 h · 7 d · 30 d · custom) and project filter;
- StatTiles: cost, requests, tokens, unpriced requests — each with a Sparkline
  of the range;
- cost over time (stacked by runtime) — rendered as a bar series with
  existing tokens; the chart primitives proper are M3 (ui/glass-ui.md);
- breakdown tables (DataTable): by project, model, runtime, issue, slot — sortable,
  each row linking to its project / session list;
- a visible note "API-equivalent cost — what these tokens would cost at public
  API prices", and an "unpriced" chip that links to `/admin/prices` for admins.

`/admin/prices` (admin): current version table (model, pattern, default tier
prices per bucket), version history, "New version" sheet with a pattern tester
(`/admin/prices/test`), recompute dialog with progress.

The StatTile, Sparkline and DataTable components come from
[glass-ui#67](https://github.com/AndreyBegma/glass-ui/issues/67).

## Configuration

| Variable / key | Where | Meaning |
|---|---|---|
| `otlp.enabled`, `otlp.httpPort` | runner config (`~/.config/agentdock/runner.json`) | receiver switch and port (default `true`, `4318`) |
| `USAGE_RECOMPUTE_BATCH` | `apps/api` | recompute batch size (default 1000) |

## Acceptance criteria

- [ ] On a fresh database the seed creates price version 1 from the vendored snapshot; `ATTRIBUTION.md` names the source commit and licence; the converter's unknown-key report is empty or listed in this spec.
- [ ] A request with model `claude-sonnet-4-5-20250929` and known buckets is priced to the cent against a hand-computed expectation in a test; the same for a GPT/Codex model with reasoning tokens.
- [ ] A request with input above a model's long-context threshold uses the long-context tier (test with a tiered model from the seed).
- [ ] A request whose model matches no pattern stores `costUsd = null`, increments `unpricedRequests`, and the summary shows it as unpriced, not $0.
- [ ] Creating a new price version leaves earlier requests' cost and `priceVersionId` unchanged; recompute over a range re-prices exactly the requests in it and the rollups for those hours equal a from-scratch aggregation (test compares both).
- [ ] Rollups equal `SUM` over `llm_requests` for any hour × project × model in a randomized test of 500 requests.
- [ ] **Authorization:** a member of project A gets 404 for `projectId=B` on every `/usage/*` route, and project B's cost is absent from their unfiltered summary and breakdowns; a non-admin never sees machine-wide (project-less) usage; operator and viewer get 403 on every `/admin/prices*` route.
- [ ] The runner receiver accepts a captured Claude Code protobuf export and a JSON export, emits one `llm.request` per `api_request` with the D13 fields and the `agentdock.*` correlation, and refuses a non-loopback connection and a body over 4 MiB.
- [ ] The same request delivered by OTel and later by transcript produces one `llm_request`, not two (end-to-end test through runner → API).
- [ ] No prompt text, tool content, email or organization id from an OTel payload reaches the API (asserted on the emitted event).
- [ ] `/usage` shows tiles, series and breakdowns for a seeded dataset; the range and project filters change all of them; an operator sees only their projects.
- [ ] `bun run check`, `bun run test`, `bun run build` pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i13-api | price tables, seed + converter, cost service, rollups, usage + admin price API, recompute job | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261013000000_cost/**, apps/api/prisma/seed-data/**, apps/api/prisma/seed.ts, apps/api/src/usage/**, apps/api/src/prices/**, apps/api/src/app.module.ts, packages/shared/src/usage/**, apps/api/package.json, bun.lock | — | yes | opus |
| i13-otlp | runner OTLP receiver and mapping | apps/runner/src/otlp/**, apps/runner/src/main.ts, apps/runner/package.json, bun.lock | — | no | opus |
| i13-web | `/usage`, `/admin/prices` | apps/web/src/app/(app)/usage/**, apps/web/src/app/admin/prices/**, apps/web/src/lib/usage/**, apps/web/src/components/shell/nav.ts | i13-api | no | sonnet |

i13-api and i13-otlp run together: the receiver emits the `llm.request` events
#12 already ingests, so it needs nothing from i13-api. i13-api also hooks
`CostService` into #12's ingestion — one call site in #12's module, named here
when #12 merges.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i13-api | do not open it |
| apps/api/prisma/seed.ts | i13-api | — |
| apps/api/src/app.module.ts | i13-api | — |
| apps/runner/src/main.ts | i13-otlp | — |
| #12's ingestion module (one call site) | i13-api | — |
| bun.lock | regenerated per the rule in [#5's spec](5-runner-daemon-and-protocol.md#contention) | — |

Depends on #12

Depends on #10

Depends on #9

Cross-repository dependency, not tracked by the orchestrator:
AndreyBegma/glass-ui#67 (StatTile, Sparkline, DataTable), released as a tag
and pinned in `apps/web` before i13-web starts.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Codex OTel attribute names differ from the research notes | medium | D13: fixture first; without one, Codex mapping ships behind `otlp.codexExperimental` and transcripts remain its source |
| Double counting reasoning tokens or cache writes between OTel and transcripts | high | D5 and D15; the randomized rollup test and the end-to-end dedupe test |
| Langfuse snapshot goes stale; new models appear unpriced | low | unpriced is visible, not zero; admins add a version; refreshing the snapshot is a future seed version |
| glass-ui#67 not released when i13-web is due | medium | the orchestrator cannot see it: i13-web reports `blocked` naming the missing component; fallback is existing `Table` / `Card` / `Progress` primitives with a follow-up issue to swap — never components written inside AgentDock (ADR-0011) |
| Rollup upsert under concurrent ingestion | medium | `INSERT … ON CONFLICT (hour, dimensionKey) DO UPDATE SET x = x + excluded.x`; a test runs parallel ingests |
| Plugin change P4 not landed, so dispatched workers send no OTel | low | transcripts (#12) still price everything; only latency differs |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Show a "subscription" view (plan limits, quota usage) next to API-equivalent cost? | No — M3 with budgets |
| Currency other than USD? | No — USD only, as API prices are published |
| Keep raw OTLP payloads for debugging? | No — only mapped events leave the runner (D16) |
