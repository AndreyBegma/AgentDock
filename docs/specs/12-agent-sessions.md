# Agent sessions — Claude and Codex transcripts, session tree

Issue: [#12](https://github.com/AndreyBegma/AgentDock/issues/12) · Roadmap: M1.6 ·
Decisions: [ADR-0003](../adr/0003-usage-from-opentelemetry-transcripts-as-backfill.md),
[ADR-0006](../adr/0006-runtime-adapters-and-runtime-profiles.md),
[event-schema.md](../architecture/event-schema.md), [cost-model.md](../architecture/cost-model.md)

## Summary

Every agent session on a runner, whether it is a worker, the orchestrator, a
skill run or a person's own `claude`, should be visible with:
- its turns, LLM requests, tool calls and subagents;
- the tokens each one used.

This item adds the runtime adapter interface to the runner, with a Claude Code
adapter that tails transcripts and a Codex adapter skeleton. The runner turns
the transcripts into usage events. The API stores sessions as a tree, and the
web shows a session list and a session tree view.

Cost columns are created here and filled by #13. OTel ingestion is #13 too;
here transcripts are the only source.

## Scope

### In scope

- `apps/runner/src/adapters/` with:
  - the `RuntimeAdapter` interface;
  - the `claude` adapter (discovery, incremental tailing, parsing);
  - the `codex` adapter (discovery and interface only, parser behind fixtures).
- Correlation of a session to its project (by cwd) and its slot (by worktree path).
- The `session.backfill` command (admin).
- API tables `sessions`, `turns`, `llm_requests`, `tool_calls`, with endpoints for list and tree.
- Web `/sessions` and `/sessions/[id]`.

### Out of scope

- Prices and cost computation, rollups, the OTLP receiver — #13.
- Prompt and response text. Only metadata is stored: tool names, durations, token counts, model, stop reason. Content is not stored or sent (D9).
- Live pane — M2.3.

## Decisions

The person delegated all decisions on 2026-10-07; each below is the default
taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | **Adapter interface.** `RuntimeAdapter { runtime; discover(profile): TranscriptSource[]; tail(source, offset): AsyncIterable<{ events, nextOffset }>; correlate(sessionMeta, projects): { projectId?, slot? } }`. There is one adapter per runtime, registered by `runtime`. | ADR-0006 |
| D2 | **Claude discovery.** Every claude profile is scanned: `<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<sessionId>.jsonl`, plus subagent transcripts under `<…>/<sessionId>/subagents/`. A new file is picked up within 30 s through `fs.watch` with a rescan fallback. | transcript layout observed in a local profile [Confirmed]; directory-name encoding is not decoded — `cwd` is read from the lines instead |
| D3 | **Claude parsing.** Lines are typed by `type`:<br>• `user` lines start a turn, keyed by `promptId`. Tool-result content marks the end of a tool call.<br>• `assistant` lines with `message.usage` become `llm.request`. Keys used: `requestId`, `message.model`, `timestamp`, `isSidechain`, `cwd`, `gitBranch`.<br>• Token buckets map as: `input_tokens` → `input`, `output_tokens` → `output`, `cache_read_input_tokens` → `cacheRead`, `cache_creation.ephemeral_5m_input_tokens` → `cacheWrite5m`, `cache_creation.ephemeral_1h_input_tokens` → `cacheWrite1h`, `output_tokens_details.thinking_tokens` → `reasoning` (counted inside `output`, so stored separately and not added twice).<br>• `tool_use` content blocks become `tool.call`, closed by the matching `tool_result`.<br>• A Task/agent tool call links the subagent transcript as a child.<br>• Other line types (`system`, `attachment`, `mode`, snapshots…) are ignored. | key names observed in a local transcript [Confirmed]; reasoning-inside-output [Unknown — verify against API docs in i12-adapters] |
| D4 | **Dedupe.** One API request can appear on several `assistant` lines, one per content block, each repeating `usage`. Requests are deduped by `requestId` (or `message.id` when there is no `requestId`), and the last usage seen wins. | [Confirmed] repeated `requestId` per content block; "last wins" is new |
| D5 | **Offsets.** Byte offsets are kept per file in `$XDG_STATE_HOME/agentdock/offsets.json` (written atomically) so a restart resumes without re-sending. Event `seq`/ack (#5) handles transport duplicates. The API also dedupes `llm_requests` on `(sessionId, requestId)`. | runner-protocol.md |
| D6 | **Correlation.** A session belongs to the project whose root equals the line's `cwd` or is an ancestor of it. Its slot is the one whose worktree `.wt-<repo>-<slot>` contains `cwd`, which links to the project of that worktree's main checkout. Sessions with no match keep `projectId = null`. | ADR-0003, `dispatch.sh` worktree rule [Confirmed] |
| D7 | **Codex.** The adapter discovers `<CODEX_HOME>/sessions/**` and parses `*.jsonl` through a parser whose format is [Unknown] because Codex is not installed on the reference machine. The interface is implemented with fixture-driven tests that are skipped until a real fixture is added (`apps/runner/src/adapters/codex/fixtures/`). Until then the adapter reports sessions with `parsed: false`. | ADR-0006; Codex absent [Confirmed] |
| D8 | **Cost columns.** `llm_requests` declares `costUsd`, `priceVersion` and `costSource` as nullable here. #13 only fills and recomputes them and does not alter this table. | delegated cross-issue rule |
| D9 | **No content.** Prompt text, assistant text, thinking, tool inputs and outputs never leave the runner. Only names, ids, timing and counts do. Tool names stay (`Bash`, `Edit`, MCP names), but tool arguments are dropped. | security.md (agent data stays on the machine), new |
| D10 | **Authorization.** Sessions with a project are visible to its members. Sessions without a project (a person's own sessions elsewhere on the machine) are admin-only, as PRD Q19 states: "only connected projects, plus a machine-wide filter for admins". | PRD, ADR-0008 |
| D11 | **Backfill.** `session.backfill { projectId?, since }` is admin-only and re-reads transcripts from offset 0, limited to files modified after `since`. The default is that only files modified after pairing are ingested, so a fresh runner does not upload months of history unasked. | runner-protocol.md commands table |
| D12 | **Protocol export.** Event types go in `packages/shared/src/protocol/events/sessions.ts`, re-exported by one line in `protocol/index.ts`. On conflict with #11, keep both. | delegated rule shared with #11 |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261012000001_sessions/`. New tables only.

| Table | Fields |
|---|---|
| `sessions` | `id`, `runnerId` → runners, `runtime`, `profileKey?`, `externalId` (runtime session id), `projectId?` → projects, `slotName?`, `cwd`, `gitBranch?`, `title?`, `models` Json (distinct models used), `parentSessionId?` → sessions (subagent), `parsed` Bool default true, `startedAt`, `lastEventAt`, `endedAt?`; unique `(runnerId, runtime, externalId)`; index `(projectId, startedAt)` |
| `turns` | `id`, `sessionId` → sessions, `promptId`, `startedAt`, `endedAt?`; unique `(sessionId, promptId)` |
| `llm_requests` | `id`, `sessionId` → sessions, `turnId?` → turns, `requestId`, `ts`, `model`, `querySource` (`main` \| `subagent` \| `auxiliary`), `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`, `reasoning` (Int, default 0), `durationMs?`, `stopReason?`, `costUsd` Decimal?, `priceVersion?` Int, `costSource?` (`computed` \| `ingested`); unique `(sessionId, requestId)`; index `(ts)`, `(model, ts)` |
| `tool_calls` | `id`, `sessionId` → sessions, `turnId?` → turns, `toolUseId`, `name`, `startedAt`, `endedAt?`, `ok?` Bool, `childSessionId?` → sessions; unique `(sessionId, toolUseId)` |

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| GET | `/sessions?projectId=&runtime=&model=&slot=&from=&to=&unassigned=` | member / admin | list with totals per session (token buckets summed, cost when present). `unassigned=true` is admin-only |
| GET | `/sessions/:id` | member of its project / admin | session, plus a tree: turns → llm requests and tool calls, each tool call linked to a child session. Totals per node |
| POST | `/admin/runners/:id/backfill` | admin | sends `session.backfill` through `RunnerCommandService` |

## UI

- **`/sessions`:**
  - filters: project, runtime, model, slot, date range, and "unassigned" for admins only;
  - table: started, project / slot, runtime, model(s), turns, requests, tokens (in / out / cache), cost (blank until #13), duration.
- **`/sessions/[id]`:**
  - header with the key facts;
  - a tree and waterfall of turns, then requests, tools and subagents, with time bars and per-node totals, using glass-ui `TraceTree` / `Waterfall` from [AndreyBegma/glass-ui#67](https://github.com/AndreyBegma/glass-ui/issues/67) when released;
  - until then, a `Tree` + `Table` fallback.

## Configuration

| Key | Where | Meaning |
|---|---|---|
| `sessions.enabled` | runner config | default true |
| `sessions.ingestSince` | runner config | default = pairing time (D11) |

## Acceptance criteria

- [ ] From a fixture Claude transcript (sanitized, committed under `apps/runner/src/adapters/claude/fixtures/`), the adapter emits one turn per user prompt, one `llm.request` per distinct `requestId` with the correct six token buckets, and paired tool calls.
- [ ] A transcript whose `assistant` lines repeat one `requestId` across content blocks yields exactly one request (D4).
- [ ] Appending lines to a watched transcript produces only the new events. Restarting the runner does not re-send old ones.
- [ ] A subagent transcript appears as a child session linked from the tool call that spawned it.
- [ ] A session whose `cwd` is inside `.wt-<repo>-i42` is linked to that project and to slot `i42`. A session in an unrelated directory has no project.
- [ ] No prompt, response, thinking or tool-argument text is present in any event sent by the runner. A test scans emitted events for fixture sentinel strings.
- [ ] The Codex adapter compiles, is registered, reports discovered files as `parsed: false`, and its fixture tests are present and skipped with a reason.
- [ ] The session tree endpoint returns per-node totals that sum to the session total.
- [ ] **Authorization:** a member of project A does not see project B's sessions in the list or by id (404). A non-admin never sees `unassigned` sessions, even with `unassigned=true`. Anonymous gets 401.
- [ ] `bun run check`, `bun run test` and `bun run build` pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i12-api | event types, schema, migration, ingest, endpoints | packages/shared/src/protocol/events/sessions.ts, packages/shared/src/protocol/index.ts, apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261012000001_sessions/**, apps/api/src/sessions/**, apps/api/src/app.module.ts | — | yes | opus |
| i12-adapters | runner adapters and backfill command | apps/runner/src/adapters/**, apps/runner/src/commands/session-backfill.ts | i12-api | no | opus |
| i12-web | sessions pages | apps/web/src/app/(app)/sessions/**, apps/web/src/lib/sessions/**, apps/web/src/components/shell/nav.ts | i12-api | no | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i12-api | shared with #11's i11-api — distinct new tables only, so keep both blocks on conflict |
| packages/shared/src/protocol/index.ts | i12-api | #11 adds its own export line — keep both |
| apps/api/src/app.module.ts | i12-api | #11 registers its module — keep both imports |
| runner command registry (from #5) | i12-adapters adds `session.backfill` | keep both on conflict |
| bun.lock | regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) | — |

Cross-repository: the tree view prefers glass-ui `TraceTree` / `Waterfall` from
AndreyBegma/glass-ui#67. That is not a blocking dependency.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Claude Code changes its transcript format | high | parser keyed on a small set of fields, unknown types ignored, fixture tests, `adapter.version` reported in capabilities |
| Reasoning tokens double-counted or missed | medium | stored as a separate bucket. #13's price tiers decide whether to bill it. Verify against API docs in i12-adapters |
| Codex format unknown | medium | interface plus skipped fixtures. Fill when Codex is installed (M4) |
| Large backfills flood the API | medium | `ingestSince` default, event batches capped by #5's spool |
| Fixture leaks real content | high | fixtures are synthetic or scrubbed, and a test asserts no real paths or emails |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Store per-request duration when the transcript has no explicit timing? | Derive from the timestamp delta to the previous line, and mark it approximate |
| Show the session `customTitle` when present? | Yes, as `title` |

Depends on #10

## Notes from implementation

i12-api, decided with the orchestrator on 2026-10-08:

1. **Runner event sinks.** Session events reach the sessions module through `RunnerEventSinks` (`apps/api/src/runners/runner-event-sinks.ts`), which #11 uses too. `RunnerIngestService.events()` runs `dispatch` → `createMany` → `advanceAck`. A sink skips bad data and throws only for infrastructure failures. A throw fails the whole batch: nothing is stored, the ack holds, the gateway closes 1011 (not terminal for the runner), and the runner resends from `welcome.ackedSeq`. Sinks are idempotent, because a resent or replayed batch is dispatched again.
2. **`session.observed`** is the event that carries a session's metadata and correlation, re-sent when a field changes. It is not `session.appeared`, which is the runner's tmux event. The `data` schemas of every session event are in `packages/shared/src/protocol/events/sessions.ts`, and the wire rules in [runner-protocol.md](../architecture/runner-protocol.md#session-events).
3. **Backfill moved to i12-adapters.** `session.backfill` lands in `commands.ts` together with its runner handler, because `CommandHandlers` fails the runner build for a command without one. `POST /admin/runners/:id/backfill` moves with it. The request type `BackfillRequest` is in `packages/shared/src/sessions`. The `ingestSince` default (D11) is the runner's concern; the API does nothing for it.
4. **`durationApprox`** on `llm_requests` records the open-question default: a duration derived from timestamps is marked approximate.

Also as built:

- **Ingest.** One transaction per batch, with an upsert on each table's natural key: `(runnerId, runtime, externalId)`, `(sessionId, promptId)`, `(sessionId, requestId)` (last usage wins, D4), `(sessionId, toolUseId)`. A `tool.call` re-sent at its result fills in `endedAt`/`ok` and never clears them. An event for a session not yet observed creates a placeholder row (`cwd = ''`) that `session.observed` completes. A malformed event, or one with an unknown runtime, is logged and skipped; its raw row is still stored in `events`.
- **Correlation trust.** `session.observed.projectId` is stored only when that project belongs to the sending runner. Otherwise the session has no project, so a runner cannot place sessions in another runner's project.
- **Subagents.** A child is linked by `parent` on its own `session.observed` or by `childSessionId` on the spawning `tool.call`, whichever arrives first. It takes its parent's project and slot, and a later change to a parent's project reaches all its descendants. So a subagent is always visible to the same people as its root.
- **List.** `GET /sessions` returns root sessions (`parentSessionId` null), newest first, paged by `cursor` (a session id) and `limit` (default 50, max 200). `totals` and `subagents` cover the whole subtree; `turns` and `toolCalls` count the session's own. Without `projectId` it lists every project the caller can see, admins included. Unassigned sessions appear only with `unassigned=true`, which is admin-only: a non-admin gets **403** `forbidden`. `unassigned` together with `projectId` is 400 `invalid_filter`. A `projectId` the caller cannot see is 404.
- **Tree.** `GET /sessions/:id` returns a `SessionTreeNode`: `turns` (each with its `requests` and `tools`), then `unattributed` (requests and tools with no turn), then `subagents` (child sessions no tool call links). A tool call that spawned a subagent carries it as `child`, and the tool call's totals are the child's. Every node's totals are the sum of its children's, so the root's totals equal the list's totals for that session. A session the caller cannot see is 404.
- **Cost.** `costUsd` in totals is a decimal string summed over priced requests, and `null` until #13 prices one.
- **Live.** After each batch, `sessions.changed { sessionIds }` is published on `project:<id>` for project sessions and on `admin` for unassigned ones.
