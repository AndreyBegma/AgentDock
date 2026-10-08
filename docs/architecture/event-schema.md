# Event schema

Status: draft. Version `1`. One schema for what Code Sentinel writes to
`events.jsonl` and what the runner sends to the API, so the runner forwards
plugin events with minimal mapping.

## Envelope

```json
{
  "v": 1,
  "seq": 18234,
  "ts": "2026-10-07T18:36:02.335Z",
  "type": "slot.checkpoint",
  "source": "code-sentinel | runner | otel | transcript | github",
  "project": { "repo": "AndreyBegma/denitsa-app", "root": "/home/archi/dev/denitsa-app" },
  "slot": "i42-api",
  "issue": 42,
  "session": { "runtime": "claude", "id": "8f0c…", "name": "cs-i42-api" },
  "data": { }
}
```

`seq` is assigned by the runner. Plugin events carry `seq` absent; the runner
assigns it on ingest. Unknown `type`s are stored and shown raw, never dropped.

## Types

### Orchestrator (source `code-sentinel`)

| Type | `data` |
|---|---|
| `orchestrator.started` | `session`, `config` (resolved `base`, `maxSlots`, …) |
| `orchestrator.stopped` | `reason` |
| `round.started` | `round` (`HHMM`), `occupied`, `max`, `free` |
| `round.decided` | rows: `{ issue, state, why, clears }` |
| `slot.dispatched` | `slot, issue, branch, worktree, runtime, model, modelWhy, owns[], never[], lead?` |
| `slot.resumed` | `slot, reason` |
| `slot.redispatched` | `slot, fromModel, toModel, reason` |
| `slot.checkpoint` | `slot, checkpoint` (`picked_up` · `plan_ready` · `implementation_done` · `pr_open` · `blocked` · `misclassified`), `summary`, `pr?` |
| `slot.message_sent` | `slot, text` |
| `slot.fence_widened` | `slot, added[]` |
| `slot.stopped` | `slot, by` |
| `pr.merged` | `pr, slot, issue, method` |
| `issue.blocked` | `issue, kind: work\|person, why` |
| `person.needed` | `issue?, slot?, question, recommendation` |

### Runner-observed (source `runner`)

| Type | `data` |
|---|---|
| `session.appeared` / `session.vanished` | `name, pid?` |
| `pane.prompt` | `slot` — a launch dialog waits for a key |
| `pane.idle` | `slot, polls` |
| `pane.quota_hit` | `slot` |
| `commit.trailer_found` | `slot, sha` |
| `worktree.changed` | `slot, ahead, behind, dirty` |

### Usage (source `otel` / `transcript`)

Schemas in `packages/shared/src/protocol/events/sessions.ts`; the wire rules
are in [runner-protocol.md](runner-protocol.md#session-events). The envelope's
`session.id` is the runtime's own session id.

| Type | `data` |
|---|---|
| `session.observed` | `cwd, startedAt, parsed, profileKey?, gitBranch?, title?, projectId?, slot?, parent?: { sessionId, toolUseId? }`. Not `session.appeared`, which is the runner's tmux event |
| `llm.request` | `requestId, model, tokens: { input, output, cacheRead, cacheWrite5m, cacheWrite1h, reasoning }, querySource: main\|subagent\|auxiliary, promptId?, durationMs?, durationApprox?, ttftMs?, stopReason?, agentName?, reportedCostUsd?, cacheWriteTtlUnknown?, source?: transcript\|otel, run?` |
| `tool.call` | `toolUseId, tool, startedAt, promptId?, endedAt?, ok?, durationMs?, decision?, childSessionId?` |
| `turn.started` / `turn.finished` | `promptId` |
| `skill.activated` | `skill` |

None of these carries prompt, response, thinking or tool-argument text
([spec 12](../specs/12-agent-sessions.md) D9).

`tokens.reasoning` is counted inside `tokens.output`, never on top of it.
Claude transcripts report it as `output_tokens_details.thinking_tokens` (see
spec 12's implementation notes), so a consumer that sums buckets must leave
`reasoning` out of the total.

The same request can arrive twice: live from the runner's OTLP receiver
(`source: otel`) and later from the transcript (`source: transcript`, the
default when `source` is absent). Only OTel sends `reportedCostUsd` — the
runtime's own cost estimate, stored for reference and never summed — and
`cacheWriteTtlUnknown: true`, meaning the runtime did not split cache writes by
TTL and all of them are in `cacheWrite5m`. The API keeps one `llm_request` per
`(session, requestId)` and merges the two copies whatever their order: the
transcript's tokens win (they carry the exact cache split), OTel fills only
`reportedCostUsd` and a measured `durationMs`
([spec 13](../specs/13-tokens-and-cost.md) D15). OTel may also send `run`, the
`agentdock.run` resource attribute (D14); runs are a future entity, so the API
accepts it and stores nothing yet.

### GitHub (source `github`)

`issue.labeled`, `issue.closed`, `pr.opened`, `pr.checks_changed`
(`rollup: pending|green|red`), `pr.closed`.

### Fleet (spec 11)

The schemas live in `packages/shared/src/protocol/events/fleet.ts`
(`fleetEventDataSchemas`, `parseFleetEvent`); the API projects them into
`rounds`, `slots`, `slot_checkpoints` and `fleet_orchestrators`. Until
`events.jsonl` exists (M2.1) the runner's collectors emit them: from tmux, git
and `gh` with source `runner`, from markdown (boards, briefs, reply files) with
source `scraped` (ADR-0002). Where a row above names the same type, this table
is the shape the runner and the API agree on.

Slot-scoped events name the slot in the envelope's `slot` (and the issue in
`issue`, when known); `data` does not repeat them. Pane events carry
`target: slot | orchestrator` (default `slot`); a slot target needs the
envelope `slot`.

| Type | Envelope `slot` | `data` |
|---|---|---|
| `session.appeared` / `session.vanished` | required | `name` (tmux session), `pid?` |
| `pane.prompt` | when `target: slot` | `target`, `dialog: trust\|bypass\|credits\|settings\|other` |
| `pane.idle` | when `target: slot` | `target`, `polls` |
| `pane.quota_hit` | when `target: slot` | `target` |
| `pane.busy` | when `target: slot` | `target` — `esc to interrupt` is back: the pane left idle, prompt or quota |
| `worktree.changed` | required | `path, exists, branch?, ahead?, behind?, dirty?` — `exists: false` once the directory is gone |
| `round.started` | — | `date` (`YYYY-MM-DD`), `round` (`HHMM`), `base, occupied, max, free, boardPath` |
| `round.decided` | — | `date, round, decisions: { dispatching, heldForLead, notDispatching, inFlight }`, each an array of rows keyed by column header as written |
| `board.unparsed` | — | `file, line?, reason` — a board or brief that did not parse |
| `slot.dispatched` | required | `date, round, briefPath, branch?, worktree?, runtime (claude), model?, modelWhy?, owns[], never[], lead?` |
| `slot.checkpoint` | required | `checkpoint` (`picked_up` · `plan_ready` · `implementation_done` · `pr_open` · `blocked` · `misclassified` · `other`), `heading?`, `summary` (≤ 4 KB), `position?` (0-based index of the heading in the reply file — the reply collector always sends it; without it the checkpoint is appended), `prUrl?` |
| `pr.opened` | optional | `number, branch, url, title, checks: pending\|green\|red, mergeable?` |
| `pr.checks_changed` | optional | `number, branch, checks, mergeable?` |
| `pr.closed` | optional | `number, branch, merged` |
| `orchestrator.started` | — | `session` |
| `orchestrator.stopped` | — | `session, reason?` |
| `commit.trailer_found` | required | `sha` |

A PR event without a `slot` is matched to the latest slot on its `branch`.
`rollupChecks` and `checkpointFromHeading` in `@agentdock/shared` are the D3 and
D5 rules, for the collectors to share.

## Correlation

Sessions launched by the runner get
`OTEL_RESOURCE_ATTRIBUTES=agentdock.project=…,agentdock.slot=…,agentdock.issue=…,agentdock.run=…`
so usage maps to a slot or run without guessing. Sessions found only by
transcript are matched by working directory → worktree → slot.
