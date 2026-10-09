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
`priceVersion` (the version's `number`, as #12 named it — not
`priceVersionId`), `costSource`. #12 declared no column for the runtime's own
cost, so this migration adds the only alterations of an existing table, all on
`llm_requests`: `reportedCostUsd` Decimal(14,6)?, `source`
(`transcript`\|`otel`, default `transcript`) and `cacheWriteTtlUnknown`
Boolean (default false) — the last two carry D15's merge.

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
| `otlp.enabled`, `otlp.http`, `otlp.codexExperimental` | runner config (`~/.config/agentdock/runner.json`) | receiver switch, port and the experimental Codex mapping (default `true`, `4318`, `false`); `otlp: null` is all defaults. The port key is #5's reserved `http`, not `httpPort` |
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

## Notes from implementation

i13-otlp, decided with the orchestrator on 2026-10-08:

1. **Fixture captured (D13 for Claude Code [Confirmed]).** The capture came from Claude Code 2.1.294 running `claude -p --model haiku` with telemetry exported to a local capture server, one run in protobuf and one in JSON. It ran with `OTEL_LOG_USER_PROMPTS=1`, `OTEL_LOG_TOOL_DETAILS=1` and `agentdock.*` resource attributes. The fixtures are in `apps/runner/src/otlp/fixtures/`:
   - `claude-logs.pb.base64` and `claude-logs.json`: the `user_prompt`, `api_request`, `tool_decision`, `tool_result` and `assistant_response` records of each run;
   - `claude-transcript.jsonl`: the `user`/`assistant` lines of the JSON run's transcript.

   Email, organization, account and user ids are replaced by placeholders. The prompt and tool sentinel strings are kept on purpose, for the D16 test. The scrub script is not in the repository.
2. **`api_request` attributes as captured.** `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd` (double), `cost_usd_micros`, `duration_ms`, `ttft_ms`, `request_id` (the same `req_…` as the transcript's `requestId`, which is the D15 key), `client_request_id`, `prompt.id`, `session.id`, `query_source`, `speed`, `effort`, `event.timestamp`.
   - Every record repeats the resource attributes, `agentdock.*` included, and carries `user.email`, `organization.id`, `user.account_uuid`, `user.account_id` and `user.id`.
   - The same key can be typed differently per event: `duration_ms` is an `intValue` on `api_request` and a `stringValue` on `tool_result`.
   - No `agent.name` was seen, because the capture has no subagent.
3. **Mapping as built.**
   - `ttftMs` is sent as well.
   - `reasoning` is 0, since OTel has no thinking split. The transcript copy fills it (D15).
   - `cache_creation_tokens` → `cacheWrite5m`, with `cacheWriteTtlUnknown: true` when it is non-zero. The capture shows why: for the same request (`req_011CfpSesVaEqnspJvvovFo5`) OTel reports 155 cache-write tokens with no TTL, while the transcript has them as `ephemeral_1h_input_tokens`.
   - `querySource` [Inferred]: `sdk`, `repl_main_thread`, `main` or absent → `main`; `agent.name` present or `query_source` starting with `agent` → `subagent`; anything else → `auxiliary`. Only `sdk` was observed.
   - A record without `session.id`, `request_id` or `model` is dropped and counted in a warning.
4. **Correlation (D14).** `agentdock.project` is a project id. It sets the envelope `project` only when it is on the runner's watch list (the same trust rule as `session.observed`). It is then resolved through git once per project, like the fleet collectors (`resolveFleetProject`), so `repo` is `owner/name`, else the root's basename. `agentdock.slot` → envelope `slot`. `agentdock.issue` → envelope `issue` when it is a positive integer. `agentdock.run` → `data.run` (at most 128 characters, as the shared schema allows). The #12 adapters do not set the envelope `project`; they put `projectId` on `session.observed`. The API reads the envelope `project` of an `llm.request` for a placeholder session, under the same watch-list trust rule (i13-api's notes).
5. **Contract fields**, from i13-api's extension of `llmRequestDataSchema`: `reportedCostUsd`, `cacheWriteTtlUnknown`, `source: 'otel'` and `run`. What gets spooled is the shared schema's parsed output of the whitelist-built object, so the runner and the API agree on the shape by construction.
6. **Receiver.**
   - `Bun.serve` on `127.0.0.1` only, plus a peer-address check (403 otherwise).
   - 413 when the declared length, the streamed body, or the gzip-inflated size exceeds 4 MiB. `Content-Encoding` other than gzip or identity is 415.
   - 503 when the spool throws, so the exporter retries.
   - `/v1/metrics` and `/v1/traces` answer 200 and are not read.
   - A port that cannot be bound is logged and the runner runs without the receiver. Capabilities then report `otlp: null`, otherwise `{ grpc: null, http: <bound port> }`. The daemon passes these to `detectCapabilities`, and `detect/` is unchanged.
7. **Codex (D13 [Unknown]).** Codex is not installed on the reference machine, so no capture exists. The mapping reads D13's names (`input_tokens`, `output_tokens`, `cached_input_tokens`, `reasoning_output_tokens`), with session `conversation.id`/`session.id` and request `request_id`/`response.id`, all unverified. It is off unless `otlp.codexExperimental` is set, and its tests are `it.skip` with the reason.
8. **End-to-end dedupe (acceptance criterion).** This slot ships the runner half: the OTel and transcript copies of the captured requests carry the same `(session.id, requestId)` key, tested through the Claude adapter. Both orders through ingest are i13-api's.
9. **Protobuf decoding.** `protobufjs` 8.8.0 (`protobufjs/light`) reads `otlp/proto/logs.json`, the JSON descriptor of opentelemetry-proto v1.11.1 (Apache-2.0, `otlp/proto/ATTRIBUTION.md`). OTLP/JSON is read directly, without `fromObject`, because it sends hex trace ids where protobufjs expects base64.
10. **Command registration trap**: recorded once, in i13-api's notes below. This slot adds no command either.

i13-api, decided with the orchestrator on 2026-10-08:

1. **Column names (D6).** #12 named the version column `priceVersion` and it
   holds `price_versions.number`, not an id. #12 declared no column for the
   runtime's cost, so `20261013000000_cost` adds `llm_requests.reportedCostUsd`,
   plus `source` and `cacheWriteTtlUnknown` for note 6. These are the only
   alterations of an existing table. An unpriced request stores
   `costUsd = null`, `costSource = null`, and the version it was tried
   against.
2. **Rollups are rebuilt, not incremented (deviates from D8's mechanism).** Two
   things make an increment wrong. #12's D4 lets a re-sent request replace its
   usage, so an increment counts it twice. A request also often arrives before
   its `session.observed`, and `propagateProject` moves whole subtrees to a
   project later, so an increment leaves usage under the wrong project. So
   every ingest batch collects the UTC hours it changed: the hours of the
   requests it upserted (the old hour too, if a re-send moved the request),
   and every hour holding requests of a session whose project or slot changed,
   subtree included. It then rebuilds those hours from `llm_requests` with
   `DELETE` + `INSERT … SELECT … GROUP BY`, inside the batch transaction
   (`RollupService.rebuildHours`). Recompute uses the same call, per batch.
   Concurrent rebuilds of one hour take `pg_advisory_xact_lock(13013, hour)` in
   ascending order; under READ COMMITTED the statements after the lock see
   the previous holder's commit. The table, the keys and the
   `(hour, dimensionKey)` unique index are as D8 says. `dimensionKey` is
   `json_build_array(projectId, runtime, model, slot, runId, issue)::text`.
3. **Run and issue dimensions.** Runs are a future entity (data-model.md), so
   `runId` is always empty and `dimension=run` returns the one empty group.
   `issue` is the `issue` of the `slots` row matching the session's
   `(projectId, slotName)` with the latest `startedAt <= request.ts`, read only
   from those columns. A slot row created after its requests were rolled up
   shows up after the next rebuild of those hours, for example a recompute.
4. **Converter (D4).** The key map adds plain synonyms the file uses:
   `input_tokens` → input; `output_tokens` → output; `input_cache_creation`,
   `cache_write_tokens`, `input_cache_write_tokens` → cacheWrite5m;
   `reasoning_tokens` → reasoning. D4's keys come first per bucket. A synonym
   with a different price is reported as a conflict (none in the snapshot).
   Langfuse tiers conditioned on request parameters (`service_tier`, `speed`:
   fast, flex, priority) cannot be evaluated from usage and are dropped (122).
   Its usage-detail thresholds (`(input|prompt|cached)`, `(input|cache_write)`,
   `(input)`, all `gt`) become `{ bucket: "totalInput", op: "gt" }`. Tiers keep
   Langfuse's priority order. A leading `(?i)` is stripped, and patterns
   compile with the `i` flag. Model priority is 0 for every seeded price.
   Snapshot: langfuse@`734cc86` (2026-10-07), 178 models → 161 prices. 17
   models priced only by modality or as completions/embeddings (`text-*`,
   `textembedding-*`, `gpt-4o-audio/realtime-*`, `gemini-live-*`) have no
   input/output price and are dropped.
5. **Unknown usage keys** in the snapshot, reported and dropped:
   `cached_content_token_count`, `candidatesTokenCount`,
   `candidates_token_count`, `groundingQueries`, `grounding_queries`,
   `input_audio`, `input_audio_tokens`, `input_cached_audio_tokens`,
   `input_cached_text_tokens`, `input_image`, `input_modality_1`, `input_text`,
   `input_text_tokens`, `output_audio`, `output_audio_tokens`,
   `output_modality_1`, `output_text`, `output_text_tokens`,
   `promptTokenCount`, `prompt_token_count`, `thoughtsTokenCount`,
   `thoughts_token_count`, `total`, `webSearchQueries`, `web_search_queries`.
   `langfuse.spec.ts` fails when a new snapshot adds a key that is not listed
   here.
6. **Bucket fallbacks and reasoning (D5).** Checked against #12: `reasoning` is
   `output_tokens_details.thinking_tokens`, already inside `output`. Cost is
   `input·p_in + cacheRead·p_cr + cacheWrite5m·p_5m + cacheWrite1h·p_1h +
   (output − reasoning)·p_out + reasoning·p_reasoning`. A bucket without a
   price falls back: reasoning → output, cacheWrite1h → cacheWrite5m → input,
   cacheWrite5m → input, cacheRead → input. Arithmetic is decimal, rounded
   half-up to 6 places.
7. **The `llm.request` contract and D15 merge are owned here.**
   `llmRequestDataSchema` gains optional `reportedCostUsd` (≥ 0),
   `cacheWriteTtlUnknown`, `source` (`transcript`\|`otel`, absent =
   transcript) and `run` (1–128 chars, accepted and not stored, see note 3).
   Merge per `(sessionId, requestId)`:
   - Same producer: the last copy wins (#12 D4).
   - Transcript after OTel: the transcript's tokens win (exact cache split),
     `cacheWriteTtlUnknown` is cleared and the request is re-priced. OTel's
     `reportedCostUsd` is kept, and so is its measured `durationMs` when the
     transcript's is approximate or absent.
   - OTel after transcript: the tokens and cost stay. Only `reportedCostUsd`
     is filled, plus a measured duration where the transcript's was
     approximate.
8. **D14 envelope attribution.** `parseSessionEvent` now carries the
   envelope's `project` and `slot`. On `llm.request`, a session with no
   project takes the envelope project only when its `root` is the `rootPath`
   of a project of the sending runner (the trust rule of
   `session.observed`), together with the envelope `slot`. A later
   `session.observed` still decides.
9. **Recompute** runs in the API process, ordered by `(ts, id)` in batches of
   `USAGE_RECOMPUTE_BATCH`. Each batch transaction re-prices its rows and
   rebuilds their hours. A recompute left `queued` or `running` by a restart is
   marked `failed` at boot. The one-at-a-time check (409) holds an advisory
   lock. The range is `from <= ts < to`.
10. **Usage API.** `from` is widened to the start of its UTC hour, because
    rollups are hourly. `interval=hour` takes at most 31 days, other routes
    400. Every bucket of the range is returned, empty ones as zero. `tokens`
    in a point is input + output + cacheRead + cacheWrite5m + cacheWrite1h:
    reasoning is inside output. For an admin, project-less usage is the `null`
    group.
11. **Command registration trap (from #12).** `CommandHandlers` in
    `apps/runner/src/commands/dispatcher.ts` needs a handler for every key of
    `commands` in `packages/shared/src/protocol/commands.ts`. A protocol or API
    slot defines and exports its command definitions in its own file and does
    not add them to the `commands` map. The runner slot of the same issue adds
    the map entry together with the handler. This item adds no command.
13. **Web (i13-web).** `/usage` follows the project filter into the URL
    (`/usage?projectId=…`); a `projectId` the API answers 404 for shows
    "Project not found". Charts are plain bars: cost per bucket stacked by
    runtime. `interval` is `hour` for a range of up to two days, `day` beyond.
    A group whose requests are all unpriced shows a blank cost, never `$0`.
    The breakdown offers project, model, runtime, issue and slot (`run` has no
    data, note 3).
14. **Pattern tester (web).** `POST /admin/prices/test` evaluates the saved
    current version only, so the "New version" editor checks a pattern against
    a sample model id in the browser, and the test calculator is for the
    version already saved. Seeded patterns start with the inline `(?i)` flag
    (note 4 strips it only when the API compiles them); the browser drops it
    the same way before building a `RegExp`. A stored pattern that is left
    unchanged is not re-validated in the browser.
15. **Snapshot formatting.** The vendored JSON is byte-identical to upstream.
    `apps/api/prisma/seed-data/biome.json` turns Biome off for that directory,
    so `bun run check` does not ask for it to be reformatted.
