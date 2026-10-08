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

This table is what the plugin writes. What the runner forwards is in
[Code Sentinel `events.jsonl`](#code-sentinel-eventsjsonl-spec-16).

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
| `llm.request` | `requestId, model, tokens: { input, output, cacheRead, cacheWrite5m, cacheWrite1h, reasoning }, querySource: main\|subagent\|auxiliary, promptId?, durationMs?, durationApprox?, ttftMs?, stopReason?, agentName?` |
| `tool.call` | `toolUseId, tool, startedAt, promptId?, endedAt?, ok?, durationMs?, decision?, childSessionId?` |
| `turn.started` / `turn.finished` | `promptId` |
| `skill.activated` | `skill` |

None of these carries prompt, response, thinking or tool-argument text
([spec 12](../specs/12-agent-sessions.md) D9).

`tokens.reasoning` is counted inside `tokens.output`, never on top of it.
Claude transcripts report it as `output_tokens_details.thinking_tokens` (see
spec 12's implementation notes), so a consumer that sums buckets must leave
`reasoning` out of the total.

### GitHub (source `github`)

`issue.labeled`, `issue.closed`, `pr.opened`, `pr.checks_changed`
(`rollup: pending|green|red`), `pr.closed`.

### Fleet (spec 11)

The schemas live in `packages/shared/src/protocol/events/fleet.ts`
(`fleetEventDataSchemas`, `parseFleetEvent`); the API projects them into
`rounds`, `slots`, `slot_checkpoints` and `fleet_orchestrators`. The runner's
collectors emit them: from tmux, git and `gh` with source `runner`, from
markdown (boards, briefs, reply files) with source `scraped` (ADR-0002), and
from Code Sentinel's `events.jsonl`, normalized, with source `code-sentinel`
(spec 16; see below). Where a row above names the same type, this table is the
shape the runner and the API agree on. Fields marked "markdown only" are absent
from `code-sentinel` events.

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
| `round.started` | — | `date` (`YYYY-MM-DD`), `round` (`HHMM`), `base?` (markdown only; else the project's base), `occupied, max, free, boardPath` |
| `round.decided` | — | `date?, round?` (markdown only; without both, the project's latest round), `decisions: { dispatching, heldForLead, notDispatching, inFlight }`, each an array of rows keyed by column header as written |
| `board.unparsed` | — | `file, line?, reason` — a board or brief that did not parse |
| `slot.dispatched` | required | `date?, round?` (markdown only — without them the run is matched by `dispatchedAt`, spec 16 Q3), `briefPath?, branch?, worktree?, runtime (claude), model?, modelWhy?, owns[], never[], lead?` |
| `slot.redispatched` | required | `fromModel?, toModel, reason?` — the slot's model becomes `toModel` |
| `slot.checkpoint` | required | `checkpoint` (`picked_up` · `plan_ready` · `implementation_done` · `pr_open` · `blocked` · `misclassified` · `other`), `heading?`, `summary` (≤ 4 KB), `position?` (0-based index of the heading in the reply file — the reply collector always sends it; a `code-sentinel` checkpoint has none and claims the next heading of its kind, else is appended), `prUrl?`, `prNumber?` |
| `pr.opened` | optional | `number, branch, url, title, checks: pending\|green\|red, mergeable?` |
| `pr.checks_changed` | optional | `number, branch, checks, mergeable?` |
| `pr.closed` | optional | `number, branch, merged?` — without `merged` the PR state is unchanged |
| `pr.merged` | optional | `number, branch?, method?` |
| `orchestrator.started` | — | `session` |
| `orchestrator.stopped` | — | `session?, reason?` |
| `orchestrator.snapshot` | — | `state` — Code Sentinel's `state.json` (`codeSentinelStateSchema`), see below |
| `events.unparsed` | — | `file, line` (raw, ≤ 4096 chars), `offset?` (byte offset of the line), `reason` — a line of `events.jsonl` that was not applied. Source `runner`; stored only |
| `commit.trailer_found` | required | `sha` |

A PR event without a `slot` is matched to the latest slot on its `branch`;
`pr.merged` first to the latest slot with its `number`.
`rollupChecks` and `checkpointFromHeading` in `@agentdock/shared` are the D3 and
D5 rules, for the collectors to share.

### Code Sentinel `events.jsonl` (spec 16)

The plugin writes `<git-common-dir>/cs-orchestrator/events.jsonl` and
`state.json` (plugin `skills/orchestrator/EVENTS.md`, checked at
claude-code-plugin@`bdce2e0`). Its type names are the ones above; several
`data` shapes are not. The runner's `events` collector does not map lines
itself. For each complete line it calls

```ts
normalizeCodeSentinelLine(line: string, project: { repo: string; root: string })
  : { ok: true; event: UnsequencedEvent } | { ok: false; reason: string }
```

from `@agentdock/shared`. It then adds `seq` and sends the event. A rejected
line becomes `events.unparsed` (`eventsUnparsedData(file, line, reason,
offset?)`), and the collector reads on.

| The normalizer | |
|---|---|
| refuses | malformed JSON, a non-object, `v` ≠ 1, a missing `type`, `ts` or `eid` |
| envelope | `source: "code-sentinel"`; `project` is the watched project (the plugin's `repo` can be null); `slot` and `issue` are kept; the plugin's `session` (no `id`) is dropped |
| `eid` | kept as `data.pluginEventId` — the API's dedupe key, per project root |
| `slot.dispatched` | `brief` → `briefPath`; `runtime` defaults to `claude`; `base`, `reusedWorktree` kept raw |
| `round.started` | `board` → `boardPath`; `date` from the board path `…/<YYYY-MM-DD>/round-<HHMM>.md`, else from `ts` |
| `round.decided` | `rows` → `decisions`: `READY` → `dispatching`, `IN_FLIGHT` → `inFlight`, the rest → `notDispatching`; keys capitalised, `issue` as `#N` |
| `slot.checkpoint` | `url` → `prUrl`, `pr` → `prNumber`; an unknown checkpoint → `other` with the value as `heading` |
| `pr.checks_changed` / `pr.closed` / `pr.merged` | `pr` → `number`, `rollup` → `checks` |
| any other type | forwarded as written, plus `pluginEventId`; stored raw |

The plugin's own keys stay next to the mapped ones: the fleet schemas drop
them, and the `events` table keeps them.

**Snapshot.** On every (re)connect, and whenever `state.json` changes, the
collector sends one `orchestrator.snapshot { state }`. Its source is
`code-sentinel`, its `ts` is the state's `updatedAt` (else the read time), and
it has no `eid`.
`state` is the file as read, and it must pass `codeSentinelStateSchema`
(`v: 1`; every field optional, unknown fields dropped). The API upserts every
live slot it lists, and never ends a slot from it.

**API side.** A `code-sentinel` event whose `(project.root, pluginEventId)` is
already stored — or that appears earlier in the same batch — is not projected
again. It is stored as `events.duplicate { pluginEventId, type }`, so its
`seq` still advances the ack. The plugin's `session.*`, `pane.*` and
`commit.trailer_found` (`via: "watch"`) are stored only, because the runner
observes those itself. For the same field, a `code-sentinel` value is never
overwritten by a `scraped` one (spec 16 D7).

### Queue (spec 19)

The schemas live in `packages/shared/src/protocol/events/queue.ts`
(`queueEventDataSchemas`, `parseQueueEvent`); the API projects them into
`issues_cache` and `issue_feeds` and recomputes `queue_states`. The runner's
`issues` collector emits them with source `runner`. Every one needs the
envelope `project`; none takes a `slot`. Where the GitHub row above names
`issue.closed`, this table is the shape.

| Type | `data` |
|---|---|
| `issues.snapshot` | `snapshotId, fetchedAt, part, parts, open[], issues[], pullRequests[]` — see below |
| `issue.closed` | `number, closedBy: pr\|manual, pr?, closedAt?` — `pr` only with `closedBy: pr` |
| `issues.unavailable` | `reason` (≤ 500 chars, the `gh` error) — the listing could not be read |

**`issues.snapshot`** is emitted only when the listing changed: the collector
polls `gh api -H 'If-None-Match: <etag>' 'repos/<owner>/<repo>/issues?state=open&per_page=100'`
(paginated) every `queue.pollSeconds` (60), and a `304` emits nothing.

- `issues[]`: `{ number, title, labels[], assignees[], body, updatedAt, url }`
  for every open issue, ready-labelled or not (a `Depends on` may name any).
  `body` is trimmed to 64 KB (`ISSUE_BODY_MAX_BYTES`); a `null` body is `""`.
- `pullRequests[]`: the items of the same listing that carry a `pull_request`
  key — `{ number, title, body, updatedAt, url }`, body trimmed to 16 KB
  (`PULL_REQUEST_BODY_MAX_BYTES`). The API reads only their `Closes #n` /
  `Fixes #n` / `Resolves #n` (`parseClosingRefs`).
- `open[]`: every open issue **and** pull request number of the whole listing.
- **Parts.** A listing whose `data` would exceed 192 KB
  (`ISSUES_SNAPSHOT_PART_MAX_BYTES`, under the 256 KB batch cap) is split into
  `parts` events sharing `snapshotId` and `fetchedAt`, `part` 0-based; each
  issue and pull request is in exactly one part, and **every part carries the
  complete `open[]`**. The API closes whatever is absent from `open[]` on each
  part, so it never reassembles.

**`issue.closed`** is emitted for every issue named in a `Depends on` line of
an open issue that is not itself open, once per runner start: the collector
reads `repos/<owner>/<repo>/issues/<n>/timeline` and reports `closedBy: pr`
with the pull request's number when a merged pull request closed it, else
`manual`. A dependency whose closure is not reported stays `BLOCKED — work`.

`specGap`, `parseDependsOn`, `parseGate`, `parseClosingRefs` and
`parseParallelPlan` in `@agentdock/shared` are the D3 body rules; the runner's
`issue.create` handler uses the same `specGap`.

## Correlation

Sessions launched by the runner get
`OTEL_RESOURCE_ATTRIBUTES=agentdock.project=…,agentdock.slot=…,agentdock.issue=…,agentdock.run=…`
so usage maps to a slot or run without guessing. Sessions found only by
transcript are matched by working directory → worktree → slot.
