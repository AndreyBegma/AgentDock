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

| Type | `data` |
|---|---|
| `llm.request` | `model, requestId, tokens: { input, output, cacheRead, cacheWrite5m, cacheWrite1h, reasoning }, durationMs, ttftMs?, querySource: main\|subagent\|auxiliary, agentName?` |
| `tool.call` | `tool, durationMs, ok, decision?` |
| `turn.started` / `turn.finished` | `promptId` |
| `skill.activated` | `skill` |

### GitHub (source `github`)

`issue.labeled`, `issue.closed`, `pr.opened`, `pr.checks_changed`
(`rollup: pending|green|red`), `pr.closed`.

## Correlation

Sessions launched by the runner get
`OTEL_RESOURCE_ATTRIBUTES=agentdock.project=…,agentdock.slot=…,agentdock.issue=…,agentdock.run=…`
so usage maps to a slot or run without guessing. Sessions found only by
transcript are matched by working directory → worktree → slot.
