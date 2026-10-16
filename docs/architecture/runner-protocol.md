# Runner protocol

Status: draft (M1.3), protocol version `1`. Types live in
`packages/shared/src/protocol/` as zod schemas, imported as
`@agentdock/shared/protocol`; this document is their rationale.

Every ` ```json ` block in this document is a complete wire message and is
parsed by the schemas in the package's tests — an example that drifts from the
schemas fails the build.

## Pairing

1. An admin creates a runner in the UI → the API returns a one-time pairing code
   (10 minutes, single use) and an install command.
2. `agentdock-runner pair --server https://dock.example --code XXXX-XXXX`
3. The runner posts `{ code, hostname, version, protocolVersion }` to
   `POST <server>/runners/pair` (`PAIRING_PATH`). The API exchanges the code
   for a long-lived runner token and the runner id: `{ runnerId, token }`. An
   invalid, expired or used code is a `400 { "error": "invalid_code" }`. The
   runner writes both to `~/.config/agentdock/runner.json` (mode 0600).
4. Revoking the runner in the UI invalidates the token and closes its socket.

**Pairing code.** Eight characters from `PAIRING_CODE_ALPHABET`
(`ABCDEFGHJKMNPQRSTUVWXYZ23456789` — no `0 O 1 I L`, so a person reads it back
unambiguously), shown as `XXXX-XXXX`. The server generates codes from the same
constant. Input is trimmed and upper-cased before validation: a person types it.

**Token.** 32 random bytes, base64url without padding (43 characters). The
server stores only its hash.

## Transport

`<server>` is the API origin (in production the reverse proxy exposes it); the
runner never goes through the web app's `/api` rewrite. Pairing and the socket
both sit at the root of that origin.

- The runner dials `wss://<server>/runner` with `Authorization: Bearer <token>`.
  Never the other way round: a runner behind NAT needs no open port.
- JSON messages, one per WebSocket frame, each `{ type, id?, ... }`. A message
  whose `type` is not in the tables below is rejected. Unknown *fields* are
  ignored, so a field can be added without breaking the other side.
- Reconnect with exponential backoff (1 s → 60 s, jitter).
- Close codes the server uses (`RUNNER_CLOSE_CODES`):

| Code | Meaning |
|---|---|
| `4400` | `hello.protocolVersion` unsupported; the close reason names the supported version |
| `4401` | missing, unknown or revoked token |
| `4409` | a newer connection of the same runner replaced this one |

## Messages

| Direction | Type | Payload |
|---|---|---|
| R → S | `hello` | runner version, protocol version, hostname, os, arch, capabilities, `lastAckedSeq` |
| S → R | `welcome` | runner id, config (projects to watch, poll intervals), `ackedSeq` |
| S → R | `config` | the same config as `welcome`, sent when it changes mid-connection |
| R → S | `heartbeat` | every 15 s: load, tmux sessions count, collectors health |
| R → S | `events` | `{ events: Event[] }` batch, ≤ 500 events and ≤ 256 KiB |
| S → R | `ack` | `seq`: highest contiguous `seq` persisted |
| S → R | `command` | `{ id, name, args }` — typed, see below |
| R → S | `command.result` | `{ id, ok, output?, error? }` |
| R → S | `command.progress` | `{ id, chunk }` for streaming commands |
| S → R | `subscribe` | `{ id, kind: "pane", projectId, root, slot }` — start streaming a slot's pane, read-only |
| S → R | `subscribe` | `{ id, kind: "run_log", projectId, runId }` — start tailing a skill run's rendered log |
| S → R | `unsubscribe` | `{ id }` |
| R → S | `pane` | `{ id, frame: { type: "full", lines, cursor } \| { type: "patch", from, lines } \| { type: "ended" } }` |
| R → S | `run_log` | `{ id, frame: { type: "lines", backlog, lines: [{ kind, text }] } \| { type: "ended", phase } }` |
| R → S | `subscribe.error` | `{ id, code: "not_found" \| "too_many_viewers" \| "forbidden" }` |
| S ↔ R | `terminal.data` | `{ id, b64 }` — PTY bytes of an attach, ≤ 64 KiB decoded; S → R only on a `write` attach |
| S → R | `terminal.resize` | `{ id, cols, rows }` |
| S ↔ R | `terminal.close` | `{ id, reason: "client" \| "idle" \| "max_duration" \| "session_ended" \| "socket" }` |
| R → S | `local.request` | `{ id, method, args, projectId?, session?, via }` — a runner-initiated request from the `agentdock` plugin, see below |
| S → R | `local.response` | `{ id, ok, data?, error? }` |

### Sequence numbers

`seq` is assigned by the runner, starts at `1` and never repeats, across
restarts. Every cursor — `hello.lastAckedSeq`, `welcome.ackedSeq`, `ack.seq` —
means *the highest contiguous `seq` persisted by the server*, `0` when nothing
is. After `welcome` the runner resends every spooled event with
`seq > ackedSeq`, in order; events at or below it are deleted from the spool.

### `hello`

The capabilities object reports what the runner found on the machine. A tool
that is not installed is `null`, never an error — a runner without `codex`
still connects.

```json
{
  "type": "hello",
  "runnerVersion": "0.1.0",
  "protocolVersion": 1,
  "hostname": "archi-desktop",
  "os": "linux",
  "arch": "x64",
  "lastAckedSeq": 18233,
  "capabilities": {
    "tmux": "3.5a",
    "git": "2.55.0",
    "gh": { "version": "2.80.0", "authenticated": true, "user": "AndreyBegma" },
    "runtimes": {
      "claude": { "version": "2.3.1" },
      "codex": null
    },
    "profiles": [
      { "id": "claude-blacktoorroot", "runtime": "claude",
        "env": { "CLAUDE_CONFIG_DIR": "~/.claude-profiles/blacktoorroot" },
        "args": [], "authenticated": true }
    ],
    "codeSentinel": { "version": "1.23.0", "path": "~/.claude-profiles/blacktoorroot/plugins/code-sentinel" },
    "otlp": { "grpc": 4317, "http": 4318 },
    "terminal": true,
    "commands": [
      "collector.poll", "issue.create", "issues.refresh",
      "orchestrator.message", "orchestrator.start", "orchestrator.status", "orchestrator.stop",
      "plan.cancel", "plan.close", "plan.turn",
      "pr.approve", "pr.inspect", "pr.requestChanges", "pr.voidApproval",
      "project.inspect", "project.refresh",
      "runner.describe", "runner.ping", "session.backfill",
      "skill.cancel", "skill.inspect", "skill.install", "skill.list",
      "skill.run", "skill.search", "skill.uninstall",
      "slot.message", "slot.stop", "terminal.attach",
      "uiprofile.build", "uiprofile.fingerprint", "worktree.status"
    ],
    "disabledCommands": ["pr.approve"]
  }
}
```

`terminal` says whether the runner serves `terminal.attach`: it has Bun's PTY
API (Bun ≥ 1.3.5, POSIX), tmux ≥ 3.2, and the command is not in
`disabledCommands`. An absent `terminal` means `false`, because a runner older
than the feature never sends it; read it with `terminalAvailable()`. It stays
the machine fact even with `commands` below: `terminal.attach` can be served by
the build and still have no PTY or tmux to run on.

`tokenSaver` (#445) says whether the runner accepts `tokenSaver` on its launch
commands. An absent `tokenSaver` means `false`; read it with
`tokenSaverAvailable()`. See [Token saver](#token-saver).

`steward` (#447) says whether the runner serves Steward: it reads
`projects[].steward`, sends `steward.observed` and `steward.acted`, and handles
`session.nudge`, `session.dismiss` and `card.resume`. An absent `steward` means
`false`; read it with `stewardAvailable()`. See [Steward](#steward).

`handoff` (#449) says whether the runner serves Context handoff: it keeps the
handoff notes, picks how each round starts, sends `handoff.updated`,
`round.restart` and `round.warmup`, and handles `card.handoff.set`. An absent
`handoff` means `false`; read it with `handoffAvailable()`. See
[Context handoff](#context-handoff).

`commands` lists every command the runner build serves — its handler keys,
sorted — and `disabledCommands` the subset its config switches off (#233,
ADR-0023). Both are plain strings, not an enum of the allowlist: a runner newer
than the API serves names the API does not know, and an enum would fail its
whole hello. **An absent `commands` means unknown, never none** — a runner
older than the field. An absent `disabledCommands` means none. Read them with
`runnerCommandsOf()` and decide per command with `commandSupport()` /
`commandsSupport()`: a feature checks the commands it needs, never the runner
version. `protocolVersion` stays `1`; the fields are additive and optional.

A profile is runtime + optional `binary` (the runtime's own name when absent) +
`env` + `args` + `authenticated` (ADR-0006).

Profiles are defined in the runner config, not on the server: a credential path
is a fact about the machine. The UI lists them and lets a project or a run pick
one.

### `welcome`

```json
{
  "type": "welcome",
  "runnerId": "rn_01J9Z6Q4X8",
  "config": {
    "projects": [{ "id": "prj_agentdock", "root": "/home/archi/dev/AgentDock" }],
    "pollIntervalsMs": { "tmux": 2000, "worktrees": 10000 }
  },
  "ackedSeq": 18230
}
```

`config.projects` is the runner's **watch list**: the projects whose roots it
may refresh and whose collectors it runs, one instance per collector per
project. `welcome` carries the authoritative list on every connect; the runner
caches it in its config file so collectors run before the first connect.

### `config`

Sent when the config changes while the runner is connected — a project was
connected or deleted. It carries the same object as `welcome.config` and is
applied exactly like it; it does not touch the ack cursor. A reconnect's
`welcome` still carries the full list, so a lost `config` heals there.

```json
{
  "type": "config",
  "config": {
    "projects": [
      { "id": "prj_agentdock", "root": "/home/archi/dev/AgentDock" },
      { "id": "prj_denitsa", "root": "/home/archi/dev/denitsa-app" }
    ],
    "pollIntervalsMs": { "tmux": 2000, "worktrees": 10000 }
  }
}
```

Two optional fields belong to the Claude Code integration
([spec 201](../specs/201-claude-code-integration.md)):
- `projects[].shipContent` — the project ships hook content (ADR-0021).
  Absent means false, and the runner strips every content field before the
  spool.
- `config.awayMode` — the runner's `PermissionRequest` hook routes permission
  prompts to action requests (D17). Absent means off.

One optional field belongs to [Steward](#steward) (#447):
- `projects[].steward` — `{ enabled, silenceMinutes, trailerGuard }`, the part
  of the project's Steward setting the runner applies itself. Absent means
  Steward is off on the runner: it observes nothing and guards no push.

### `heartbeat`

`load` is the 1, 5 and 15 minute load average; `collectors` is keyed by
collector name.

`profiles` is optional: each Claude profile id mapped to its `agentdock` state
(`{ plugin, telemetry }`, the same shape as `capabilities.profiles[].agentdock`
in `hello`). The runner sends it on every heartbeat, not only on change, so a
lost heartbeat heals on the next one. Codex profiles are never listed. The
server merges it into the stored capabilities by profile id and ignores an id
it does not know, since `hello` owns the profile list. A heartbeat without
`profiles` (an older runner) leaves the stored value untouched, and an older
server strips the unknown field. Added in #348 within protocol v1.

```json
{
  "type": "heartbeat",
  "ts": "2026-10-07T18:36:15.000Z",
  "load": [0.42, 0.51, 0.6],
  "tmuxSessions": 4,
  "collectors": {
    "tmux": { "ok": true },
    "transcripts": { "ok": false, "error": "permission denied" }
  },
  "profiles": {
    "work": { "plugin": "0.9.0", "telemetry": true },
    "personal": { "plugin": null, "telemetry": false }
  }
}
```

### `events` and `ack`

Each event is the envelope from [event-schema.md](event-schema.md), with `seq`
always present on the wire.

```json
{
  "type": "events",
  "events": [
    {
      "v": 1,
      "seq": 18234,
      "ts": "2026-10-07T18:36:02.335Z",
      "type": "slot.checkpoint",
      "source": "code-sentinel",
      "project": { "repo": "AndreyBegma/AgentDock", "root": "/home/archi/dev/AgentDock" },
      "slot": "i5-protocol",
      "issue": 5,
      "session": { "runtime": "claude", "id": "8f0c2a", "name": "cs-i5-protocol" },
      "data": { "checkpoint": "plan_ready", "summary": "plan written" }
    },
    {
      "v": 1,
      "seq": 18235,
      "ts": "2026-10-07T18:36:03.001Z",
      "type": "runner.spool_truncated",
      "source": "runner",
      "data": { "fromSeq": 1, "toSeq": 9120, "bytes": 10485760 }
    }
  ]
}
```

```json
{ "type": "ack", "seq": 18235 }
```

`runner.spool_truncated` (source `runner`) is emitted when the spool cap drops
its oldest segment: `data` is `{ fromSeq, toSeq, bytes }` of what was lost.

### Fleet events

The fleet collectors (spec 11) send the types of
[event-schema.md → Fleet](event-schema.md#fleet-spec-11) in ordinary `events`
batches; their `data` schemas are `fleetEventDataSchemas` in
`@agentdock/shared/protocol`. Markdown-derived events carry source `scraped`.
The API projects each batch before storing it, so a fleet event whose `data`
does not fit is stored but projects nothing; it never fails the batch.

```json
{
  "type": "events",
  "events": [
    {
      "v": 1,
      "seq": 18240,
      "ts": "2026-10-08T14:30:05.000Z",
      "type": "session.appeared",
      "source": "runner",
      "project": { "repo": "AndreyBegma/AgentDock", "root": "/home/archi/dev/AgentDock" },
      "slot": "i11-api",
      "issue": 11,
      "data": { "name": "cs-i11-api" }
    },
    {
      "v": 1,
      "seq": 18241,
      "ts": "2026-10-08T14:31:10.000Z",
      "type": "slot.checkpoint",
      "source": "scraped",
      "project": { "repo": "AndreyBegma/AgentDock", "root": "/home/archi/dev/AgentDock" },
      "slot": "i11-api",
      "data": {
        "checkpoint": "pr_open",
        "heading": "pull request open — https://github.com/AndreyBegma/AgentDock/pull/46",
        "summary": "Projector and routes.",
        "position": 3,
        "prUrl": "https://github.com/AndreyBegma/AgentDock/pull/46"
      }
    },
    {
      "v": 1,
      "seq": 18242,
      "ts": "2026-10-08T14:31:15.000Z",
      "type": "pane.idle",
      "source": "runner",
      "project": { "repo": "AndreyBegma/AgentDock", "root": "/home/archi/dev/AgentDock" },
      "data": { "target": "orchestrator", "polls": 3 }
    },
    {
      "v": 1,
      "seq": 18243,
      "ts": "2026-10-08T14:32:00.000Z",
      "type": "slot.message_seen",
      "source": "scraped",
      "project": { "repo": "AndreyBegma/AgentDock", "root": "/home/archi/dev/AgentDock" },
      "slot": "i11-api",
      "issue": 11,
      "data": {
        "body": "## From the orchestrator (agentdock-fd): plan approved\n\nGo ahead.",
        "sender": "the orchestrator (agentdock-fd)",
        "mode": "appended",
        "fileHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      }
    }
  ]
}
```

`slot.message_seen` (#160, [spec 160](../specs/160-agent-workspace.md)) is the
orchestrator's side of a slot's conversation: each change of the worktree's
`.orchestrator-msg.md` is one event. A file that grew by appending yields the
appended suffix (`mode: appended`), any other change the whole file
(`replaced`); `body` is at most 16 KB. `fileHash` is the sha256 of the whole
file after the change: the runner keeps what it read in memory only, so after
a restart it sends the unchanged file once more and the API keeps the first
entry per `fileHash` in a slot's run.

### Session events

Schemas in `events/sessions.ts`; the rules are [spec 12](../specs/12-agent-sessions.md).
Source `transcript`. Every one carries the envelope `session: { runtime, id }`,
where `id` is the runtime's own session id. They hold names, ids, timing and
token counts only: no prompt, response, thinking or tool-argument text (D9).

| Type | `data` | Sent |
|---|---|---|
| `session.observed` | `cwd, startedAt, parsed, profileKey?, gitBranch?, title?, projectId?, slot?, parent?: { sessionId, toolUseId? }` | when the adapter first reads a transcript, and again when a field changes |
| `turn.started` / `turn.finished` | `promptId` | per user prompt; the envelope `ts` is the moment |
| `llm.request` | `requestId, model, tokens: { input, output, cacheRead, cacheWrite5m, cacheWrite1h, reasoning }, querySource, promptId?, durationMs?, durationApprox?, ttftMs?, stopReason?, agentName?` | once per `requestId`; re-sent with newer usage, the last wins (D4) |
| `tool.call` | `toolUseId, tool, startedAt, promptId?, endedAt?, ok?, durationMs?, decision?, childSessionId?` | at the `tool_use`, and again with `endedAt`/`ok` at its result |
| `session.compacted` | `compactionId, trigger: auto\|manual, preTokens?` | once per compaction of the conversation (Claude `compact_boundary`); `compactionId` is the line's id (#161) |
| `session.error` | `errorId, kind, status?, promptId?` | once per request the runtime gave up on (Claude `isApiErrorMessage`); `kind` is the error code, `[a-z_]` only, never a message (#161) |

- `projectId` and `slot` are the adapter's correlation (D6). `projectId` comes
  from the watch list; the API stores it only when that project belongs to the
  sending runner, otherwise the session has no project.
- A subagent is linked by `parent` on its own `session.observed`, by
  `childSessionId` on the spawning `tool.call`, or both. It takes its parent's
  project and slot.
- The API projects these into `sessions`, `turns`, `llm_requests` and
  `tool_calls` with upserts on each table's natural key, so a resent event
  changes nothing. A malformed one is skipped and logged; the raw event is
  still stored.

```json
{
  "type": "events",
  "events": [
    {
      "v": 1,
      "seq": 18240,
      "ts": "2026-10-07T18:40:00.000Z",
      "type": "session.observed",
      "source": "transcript",
      "session": { "runtime": "claude", "id": "0f6c1e2a-5d1b-4c4e-9a51-7f1d2b8e9c30" },
      "data": {
        "profileKey": "claude-blacktoorroot",
        "cwd": "/home/archi/dev/.wt-AgentDock-i12-api",
        "gitBranch": "feat/12-sessions-api",
        "startedAt": "2026-10-07T18:40:00.000Z",
        "parsed": true,
        "projectId": "prj_agentdock",
        "slot": "i12-api"
      }
    },
    {
      "v": 1,
      "seq": 18241,
      "ts": "2026-10-07T18:40:01.000Z",
      "type": "turn.started",
      "source": "transcript",
      "session": { "runtime": "claude", "id": "0f6c1e2a-5d1b-4c4e-9a51-7f1d2b8e9c30" },
      "data": { "promptId": "6c0d9a1e-0b47-4f0e-8f6e-2a7d4c1b9e55" }
    },
    {
      "v": 1,
      "seq": 18242,
      "ts": "2026-10-07T18:40:04.120Z",
      "type": "llm.request",
      "source": "transcript",
      "session": { "runtime": "claude", "id": "0f6c1e2a-5d1b-4c4e-9a51-7f1d2b8e9c30" },
      "data": {
        "requestId": "req_011CTkq7dZ3vH8YbXw4c2N1m",
        "promptId": "6c0d9a1e-0b47-4f0e-8f6e-2a7d4c1b9e55",
        "model": "claude-opus-5-5",
        "tokens": { "input": 12, "output": 845, "cacheRead": 48211, "cacheWrite5m": 0, "cacheWrite1h": 3120, "reasoning": 210 },
        "durationMs": 3120,
        "durationApprox": true,
        "stopReason": "tool_use",
        "querySource": "main"
      }
    },
    {
      "v": 1,
      "seq": 18243,
      "ts": "2026-10-07T18:40:09.500Z",
      "type": "tool.call",
      "source": "transcript",
      "session": { "runtime": "claude", "id": "0f6c1e2a-5d1b-4c4e-9a51-7f1d2b8e9c30" },
      "data": {
        "toolUseId": "toolu_01FqY1v3Lr8m2bJx7KcN4tHd",
        "promptId": "6c0d9a1e-0b47-4f0e-8f6e-2a7d4c1b9e55",
        "tool": "Task",
        "startedAt": "2026-10-07T18:40:04.200Z",
        "endedAt": "2026-10-07T18:40:09.500Z",
        "ok": true,
        "durationMs": 5300,
        "childSessionId": "agent-a3f9c2"
      }
    },
    {
      "v": 1,
      "seq": 18244,
      "ts": "2026-10-07T19:12:30.000Z",
      "type": "session.compacted",
      "source": "transcript",
      "session": { "runtime": "claude", "id": "0f6c1e2a-5d1b-4c4e-9a51-7f1d2b8e9c30" },
      "data": {
        "compactionId": "edafb60c-3517-4cfd-980d-def95e7646eb",
        "trigger": "auto",
        "preTokens": 167000
      }
    },
    {
      "v": 1,
      "seq": 18245,
      "ts": "2026-10-07T19:20:02.000Z",
      "type": "session.error",
      "source": "transcript",
      "session": { "runtime": "claude", "id": "0f6c1e2a-5d1b-4c4e-9a51-7f1d2b8e9c30" },
      "data": {
        "errorId": "1ca4b4bf-990b-43e8-8fa6-d599a983ba5a",
        "kind": "rate_limit",
        "status": 429,
        "promptId": "6c0d9a1e-0b47-4f0e-8f6e-2a7d4c1b9e55"
      }
    }
  ]
}
```

### `command`, `command.result`, `command.progress`

`name` is any string on the wire: an unknown command is answered, not dropped.

```json
{ "type": "command", "id": "cmd_7", "name": "runner.ping", "args": {} }
```

```json
{ "type": "command.result", "id": "cmd_7", "ok": true,
  "output": { "pong": true, "ts": "2026-10-07T18:36:20.000Z" } }
```

```json
{ "type": "command.result", "id": "cmd_8", "ok": false,
  "error": { "code": "unknown_command", "message": "unknown command: shell.exec" } }
```

```json
{ "type": "command.progress", "id": "cmd_9", "chunk": "Cloning into 'repo'...\n" }
```

`error` is present exactly when `ok` is `false`. Error codes:

| Code | When |
|---|---|
| `unknown_command` | the name is not in the allowlist |
| `disabled` | the runner config lists it in `disabledCommands` |
| `invalid_args` | the args fail the command's schema |
| `timeout` | the handler did not finish within the command's timeout (default 30 s) |
| `internal` | the handler threw; `message` never carries a stack trace |
| `path_not_found` | a path argument does not exist or is not a directory |
| `path_not_allowed` | a path argument is outside what the command may touch: a symlink out of its root, or a root not on the watch list under that project |
| `not_a_repository` | a path argument is not inside a git working tree |
| `already_running` | the tmux session the command would create already exists |
| `unsupported_runtime` | the profile's runtime cannot run the command (a `codex` orchestrator) |
| `unknown_profile` | `profileId` names no profile in the runner config |
| `not_found` | the target the runner would resolve does not exist, or does not belong to that project: a terminal target, a skill, a run |
| `busy` | a limit is reached: the runner's attach cap, or a `write` attach already holds the target |
| `unsupported` | the machine cannot run the command: no PTY API, not POSIX, or tmux older than 3.2 |
| `already_exists` | the target already exists: a `skills/<name>` branch, or a profile skill directory |
| `changed_since_preview` | the skill's content at `commit` no longer hashes to the inspected `contentHash`; nothing was written |
| `not_runnable` | the skill is refused as a run: the orchestrator or a worker |
| `too_large` | a skill is over `SKILL_MAX_FILES` (500) or `SKILL_MAX_TOTAL_BYTES` (5 MiB) |
| `upstream_unavailable` | the catalog (skills.sh) or the forge (GitHub) did not answer |

The API answers the three path codes with an HTTP error of the same name in
the body: `path_not_found` and `not_a_repository` → **422** (the request is
well-formed, the path is not usable), `path_not_allowed` → **403**. On
`project.refresh`, `path_not_allowed` means the runner's watch list does not
hold that project: the API resends `config` before the caller retries.

### `subscribe`, `unsubscribe`, `pane`, `subscribe.error`

Live read-only view of a slot's tmux pane ([spec 18](../specs/18-live-worker-pane.md)).
The server picks the `id` for each subscription. Every `pane` and
`subscribe.error` for that subscription carries the same `id`, and
`unsubscribe` names it. The API holds at most one runner subscription per slot
and fans its frames out to browsers. The runner runs one capture loop per slot
and stops it within `PANE_UNSUBSCRIBE_STOP_MS` (2 s) of the last `unsubscribe`.
No message in either direction carries input to the pane.

```json
{
  "type": "subscribe",
  "id": "pane_7f3a",
  "kind": "pane",
  "projectId": "prj_agentdock",
  "root": "/home/dev/agentdock",
  "slot": "i5-protocol"
}
```

`root` must be an absolute path the runner's watch list holds. `slot` follows
`^[a-z0-9][a-z0-9-]*$` (max 64), because it ends up in a tmux target
(`cs-<slot>`), where `:` and `.` have meaning. The runner also checks that the
slot's worktree belongs to `root` (`.wt-<repo>-<slot>`).

```json
{ "type": "unsubscribe", "id": "pane_7f3a" }
```

The runner captures every `PANE_CAPTURE_INTERVAL_MS` (1 s) while the
subscription lives:

- **`full`**: the first frame of a subscription, then again every 60 s. It
  holds up to `PANE_HISTORY_LINES` (2000) lines of history and the cursor.
- **`patch`**: replaces the previous frame's lines from index `from` to the end
  with `lines`. The runner sends no frame when the pane has not changed.
- **`ended`**: the `cs-<slot>` session is gone. The runner drops the
  subscription after sending it, and the viewer keeps the last frame on screen.

Lines keep their ANSI colour escapes (`capture-pane -e`). Before sending, the
runner masks strings that look like secrets with `•••`; this is best-effort. A
serialized frame stays under `PANE_MAX_FRAME_BYTES` (256 KiB); to fit, the
runner drops lines from the top. The server never persists frames.

```json
{
  "type": "pane",
  "id": "pane_7f3a",
  "frame": {
    "type": "full",
    "lines": ["$ bun run test", "\u001b[32m42 pass\u001b[0m"],
    "cursor": { "x": 0, "y": 2 }
  }
}
```

```json
{
  "type": "pane",
  "id": "pane_7f3a",
  "frame": { "type": "patch", "from": 1, "lines": ["43 pass", "$ "] }
}
```

```json
{ "type": "pane", "id": "pane_7f3a", "frame": { "type": "ended" } }
```

`subscribe.error` refuses a subscription; the runner sends nothing more for
that `id`. Its codes:

- `not_found`: no `cs-<slot>` session, or the slot is not in that project.
- `too_many_viewers`: the runner already holds `PANE_MAX_SUBSCRIPTIONS` (10).
- `forbidden`: `root` is not on the watch list.

```json
{ "type": "subscribe.error", "id": "pane_7f3a", "code": "too_many_viewers" }
```

### `subscribe` with `kind: "run_log"`, `run_log`

A skill run's live log ([spec 24](../specs/24-skills.md) D13). It uses the same
`subscribe`, `unsubscribe` and `subscribe.error` messages as a pane; `subscribe`
is a union on `kind` (`anySubscribeMessageSchema`), and
`subscribeMessageSchema` stays the pane variant. The browser's topic is
`run:<projectId>:<runId>` (`runTopic`); the API holds at most one runner
subscription per run and relays its frames as `run_log.lines` and
`run_log.ended`.

```json
{
  "type": "subscribe",
  "id": "run_91c2",
  "kind": "run_log",
  "projectId": "prj_agentdock",
  "runId": "cmg1run0001"
}
```

The runner checks that `runId` is a run of `projectId` (`not_found`
otherwise), then tails the run's `stream.jsonl` and sends it **rendered**:

- `assistant`: assistant text;
- `tool`: a tool call, as a one-line summary;
- `result`: the final result;
- `system`: a note from the runner itself.

The raw stream never leaves the runner. The first frames replay the newest
`RUN_LOG_BACKLOG_LINES` (500) lines with `backlog: true`; live lines follow
with `backlog: false`. A line is at most `RUN_LOG_LINE_MAX_CHARS` (4000)
characters, and a serialized frame stays under `RUN_LOG_MAX_FRAME_BYTES`
(48 KiB) — the browser socket's 64 KiB, less the relay envelope. `ended` is
sent once the run is in a terminal phase, and nothing follows it. The server
never persists frames: the D10 report fields arrive in `skill_run.finished`.

```json
{
  "type": "run_log",
  "id": "run_91c2",
  "frame": {
    "type": "lines",
    "backlog": false,
    "lines": [
      { "kind": "assistant", "text": "Reading the issue and the spec." },
      { "kind": "tool", "text": "Read docs/specs/24-skills.md" }
    ]
  }
}
```

```json
{ "type": "run_log", "id": "run_91c2", "frame": { "type": "ended", "phase": "succeeded" } }
```

### `terminal.data`, `terminal.resize`, `terminal.close`

The byte stream of an interactive attach ([spec 29](../specs/29-terminal-attach.md)).
The `terminal.attach` command opens it (see [Terminal](#terminal)), and its
`id` arg names the stream: every message below carries that `id`. Schemas in
`terminal.ts`. Unlike the rest of the protocol, these messages are **strict**:
an unknown field fails to parse rather than being dropped, so nothing rides
along with bytes headed for a live PTY.

`terminal.data` carries PTY bytes as padded base64, 1 to
`TERMINAL_MAX_DATA_BYTES` (64 KiB) decoded. Runner → server is the PTY's
output. Server → runner is input, and only on a `write` attach: on a `read`
attach the API drops input and the runner drops it again. Bytes are not
filtered for control sequences; an attach is a raw terminal by design. Neither
side stores or logs them; the runner logs byte counts only.

```json
{ "type": "terminal.data", "id": "term_4c1d", "b64": "G1szMm0kIBtbMG0=" }
```

`terminal.resize` resizes the PTY, within 10–500 columns and 2–200 rows. A
`read` attach runs with `ignore-size`, so the agent's window keeps its size.

```json
{ "type": "terminal.resize", "id": "term_4c1d", "cols": 160, "rows": 48 }
```

`terminal.close` ends an attach, from either side. The runner then sends
SIGHUP to the `tmux attach` client; no terminal path kills the target session.
Nothing more is sent for that `id`. When the socket itself drops, the runner
closes every attach of that connection, and the API audits the reason `socket`.
The runner also enforces the idle and maximum-duration limits itself, at the
shared defaults (`TERMINAL_IDLE_TIMEOUT_SEC_DEFAULT`,
`TERMINAL_MAX_DURATION_SEC_DEFAULT`), and sends `terminal.close` with that
reason when it gets there first. An API configured above the defaults is
therefore capped by the runner.

| Reason | Sent by | When |
|---|---|---|
| `client` | server | the admin detached, or the browser socket closed |
| `idle` | server; runner as backstop | no input (`write`) or no traffic (`read`) for `TERMINAL_IDLE_TIMEOUT_SEC` (900 s) |
| `max_duration` | server; runner as backstop | the attach reached `TERMINAL_MAX_DURATION_SEC` (4 h) |
| `session_ended` | runner | the `tmux attach` client exited |
| `socket` | — | the API ↔ runner socket dropped; recorded, never sent |

```json
{ "type": "terminal.close", "id": "term_4c1d", "reason": "idle" }
```

### `local.request`, `local.response`

The runner asks, and the server answers
([ADR-0020](../adr/0020-claude-code-integration-through-the-runner.md),
[spec 201](../specs/201-claude-code-integration.md) D6–D8). This is the only
runner-initiated request in the protocol. The `agentdock` Claude Code plugin's
hook and MCP processes reach the daemon over its local unix socket, and the
daemon relays their request. Schemas are in `local.ts`.

- **The allowlist.** `method` must be a key of `localMethods`, and `args` must
  match that method's schema. Otherwise the answer is `unknown_method` or
  `invalid_args`, audited as `local.request` with result `denied`.
- **Authority.** The server acts as the runner's **local user** with
  `min(role on the project, operator)`. With no local user, a non-member, or a
  role below the method's `minRole`, the answer is `forbidden`.
- **The project.** The project is never an argument. `projectId` is the daemon's
  correlation of the session's cwd. The server checks that this runner watches
  the project. A project method without one is `no_project`.
- **Not spooled.** When the WSS is down, the daemon answers `runner_offline`
  itself. A write is never delayed and replayed later. Both sides give up after
  `LOCAL_REQUEST_TIMEOUT_MS` (15 s).

| Method | Min role | Args | Result |
|---|---|---|---|
| `context.sessionStart` | viewer | `gitBranch?` | `{ text }` ≤ 2 000 chars, printed by the `SessionStart` hook |
| `fleet.status` | viewer | — | orchestrator state and slots |
| `queue.list` | viewer | `limit` ≤ 50 | open issues with ready / in-flight flags |
| `budget.remaining` | viewer | — | enabled budgets with `limitUsd`, `spentUsd`, `remainingUsd` |
| `approvals.list` | viewer | — | PRs awaiting approval and pending action requests |
| `activity.recent` | viewer | `limit` ≤ 50 | recent activity items |
| `sessions.recent` | viewer | `limit` ≤ 50 | recent sessions with origin and live state |
| `action.status` | viewer | `id` | the action request |
| `issue.create` | operator | `title, body, labels?, queue` | `{ number, url, queued }` |
| `activity.note` | operator | `text` ≤ 2 000 | records the server event `manual.note` |
| `handoff.create` | operator | `title, body, branch` | an issue queued for the fleet, plus `manual.handoff` |
| `action.request` | operator | `kind, args, summary` | a pending action request (spec 201 D18) |
| `away.set` | operator | `on` | the runner's away mode; needs no project |
| `card.finish` | operator | `summary` (≤ 4 000), `artifactIncomplete?` (#445 D8, set by the runner's artifact guard) | `{ number, finished: true }`; the card is the one whose session uuid is the request's `session.id`, else `not_a_card_session` (issue #242 D6). An MCP caller's session is the one whose `claude` pid a `SessionStart` reported, else (#482) the session of the live card round whose worktree holds the caller's cwd — read from the card store on disk, so it survives a daemon restart — else the one live session in that cwd. A refused `card.finish` from a live round's worktree is also sent as `card_run.finish_refused` |

```json
{
  "type": "local.request",
  "id": "lr_7f3a",
  "method": "issue.create",
  "args": { "title": "Flaky pairing test on macOS", "body": "Seen twice today.", "queue": true },
  "projectId": "prj_agentdock",
  "session": { "runtime": "claude", "id": "0c9e2f4a-5b1d-4e8a-9c3f-2a7b6d1e8f90" },
  "via": "mcp"
}
```

```json
{
  "type": "local.response",
  "id": "lr_7f3a",
  "ok": true,
  "data": { "number": 214, "url": "https://github.com/AndreyBegma/AgentDock/issues/214", "queued": true }
}
```

```json
{ "type": "local.response", "id": "lr_7f40", "ok": false, "error": { "code": "forbidden", "message": "viewer on prj_agentdock" } }
```

## Commands (allowlist)

Only commands with status *implemented* exist in the `commands` object of the
package; the rest are planned, and each lands with the item that implements its
handler.

| Name | Args | Min role | Status |
|---|---|---|---|
| `runner.ping` | — | viewer | implemented: → `{ pong: true, ts }` |
| `runner.describe` | — | viewer | implemented: → `{ runnerVersion, hostname, os, arch, capabilities }` |
| `project.inspect` | `path` | admin | implemented: → `ProjectInspection`, timeout 45 s |
| `project.refresh` | `projectId, root` | operator | implemented: → `ProjectInspection`, timeout 45 s |
| `orchestrator.start` | `projectId, root, profileId, model, permissionMode, mode: start\|next` | operator | implemented (`commands/control.ts`): → `{ session, startedAt }`, timeout 30 s |
| `orchestrator.stop` | `projectId, root` | operator | implemented: → `{ stopped }`, timeout 10 s |
| `orchestrator.status` | `projectId, root` | viewer | implemented: → `{ present, state, session?, startedAt? }`, timeout 5 s |
| `orchestrator.message` | `projectId, root, body, from` | operator | implemented (#189): → `{ delivered, reason?: absent\|prompt }`, timeout 10 s |
| `slot.stop` | `projectId, root, slot` | operator | implemented: → `{ stopped }`, timeout 10 s |
| `slot.message` | `projectId, root, slot, text, from` | operator | implemented: → `{ written: true, delivered }`, timeout 10 s |
| `pr.inspect` | `projectId, root, pr` | viewer | defined (`commands/approvals.ts`): → `PrInspection` (head SHA, diff stats, ≤ 300 files, checks, mergeable), timeout 30 s |
| `pr.approve` | `projectId, root, pr, headSha, by, at` | operator | defined (`commands/approvals.ts`): → `{ written: true }`, timeout 10 s |
| `pr.requestChanges` | `projectId, root, pr, headSha, by, at, note` | operator | defined (`commands/approvals.ts`): → `{ written: true }`, timeout 10 s |
| `pr.voidApproval` | `projectId, root, pr, headSha, at` | operator | defined (`commands/approvals.ts`): → `{ written: true }`, timeout 10 s |
| `issue.create` | `projectId, title, body, labels, queue, readyLabel?` | operator | defined (`commands/queue.ts`), not in the map yet: → `{ number, url, queued, reason? }`, timeout 45 s |
| `issues.refresh` | `projectId` | operator | defined (`commands/queue.ts`), not in the map yet: → `{ changed, fetchedAt }`, timeout 45 s |
| `skill.search` | `query` | operator | defined (`commands/skills.ts`), not in the map yet: → `{ items: [{ id, source, skillId, name, installs }] }`, timeout 15 s |
| `skill.inspect` | `source, skillId?, ref?` | operator | defined, not in the map yet: → `{ commit, skills: [{ skillId, path, frontmatter, files, contentHash }] }`, timeout 120 s |
| `skill.install` | `source, skillId, commit, contentHash, target: { scope: project, projectId, root, base, runtime } \| { scope: profile, profileKey, runtime }` | operator; admin for profile scope | defined, not in the map yet: → `{ path, prUrl? }`, timeout 180 s |
| `skill.uninstall` | `profileKey, runtime, name` | admin | defined, not in the map yet: → `{ removed: true }`, timeout 10 s |
| `skill.list` | `projectId?, root?` | viewer | defined, not in the map yet: → `{ items: InstalledSkill[] }`, timeout 60 s |
| `skill.run` | `runId, projectId, root, base, skill, args, profileKey, model, permissionMode, output: report\|pr, timeoutSec` | operator | defined, not in the map yet: → `{ phase: queued\|preparing, tmuxSession? }`, timeout 30 s |
| `skill.cancel` | `runId, projectId` | operator | defined, not in the map yet: → `{ cancelled }`, timeout 15 s |
| `session.backfill` | `projectId?, since` | admin | implemented: → `{ files, events }`, timeout 600 s |
| `terminal.attach` | `id, target: { kind: slot\|orchestrator\|skill_run\|manual\|card, projectId, root, slot?\|runId?\|sessionId?\|cardId? }, mode: read\|write, cols, rows` | admin | implemented: → `{ attached: true, session }`, timeout 10 s; `skill_run` answers `unsupported` until #24's runner lands |
| `worktree.status` | `projectId, root, slot, base?` | viewer | implemented (`commands/worktree.ts`): → `{ slot, branch, head, base, ahead, behind, changed, untracked, files (≤ 200), filesTruncated, commits (≤ 5) }`, timeout 10 s |

Arguments are validated by schema on both sides (`parseCommand`). Commands
without arguments take `{}` and reject any field. Paths are resolved and must
sit under a registered project root or the runner's worktree parent. No
command takes a shell string.

### Projects

Schemas in `projects.ts`; the rules are [spec 10](../specs/10-projects.md)
D2–D8 and D10.

- `project.inspect { path }` takes any existing absolute directory and is
  admin-only. It never refuses a git checkout that is not the main one: it
  reports `isMainCheckout: false` with `root` set to the main checkout to
  connect instead, and skips docs detection. The API turns that into
  `409 not_main_checkout`.
- `project.refresh { projectId, root }` re-inspects a root only when the
  watch list holds it under that `projectId`.
- `remote.forge` is `github` for an `origin` on github.com, else
  `unsupported` (also when there is no `origin`, `url: null`). The API refuses
  to connect `unsupported` (`422 unsupported_forge`).
- `docs.candidates` lists every place the D6 rules looked, in order, up to and
  including the hit. `localPath` is absolute for every kind and `null` for
  `remote_repo` and `none`; `classified` paths are relative to it.
- `warnings` are sentences for the connect preview.

```json
{
  "type": "command.result",
  "id": "cmd_12",
  "ok": true,
  "output": {
    "root": "/home/archi/dev/AgentDock",
    "gitCommonDir": "/home/archi/dev/AgentDock/.git",
    "isMainCheckout": true,
    "remote": {
      "url": "git@github.com:AndreyBegma/AgentDock",
      "forge": "github",
      "repo": "AndreyBegma/AgentDock"
    },
    "baseBranch": "develop",
    "baseSource": "config",
    "codeSentinelConfig": {
      "orchestrator": { "base": "develop", "readyLabel": "cs:ready", "specDir": "docs/specs" }
    },
    "hasClaudeMd": true,
    "hasAgentsMd": false,
    "docs": {
      "kind": "in_repo",
      "localPath": "/home/archi/dev/AgentDock/docs",
      "repo": "AndreyBegma/AgentDock",
      "isGitRepo": true,
      "detectedBy": "spec_dir",
      "evidence": [{ "file": "/home/archi/dev/AgentDock/.code-analyzer-config.json", "line": 28 }],
      "classified": { "specs": ["specs"], "adr": ["adr"], "roadmap": [], "reports": [] },
      "candidates": [
        { "rule": "spec_dir", "target": "/home/archi/dev/AgentDock/docs/specs", "hit": true }
      ]
    },
    "warnings": []
  }
}
```

### Orchestrator and slot control

Schemas in `commands/control.ts` (`controlCommands`); the rules are
[spec 17](../specs/17-orchestrator-and-slot-control.md) D1–D12. `commands`
spreads them in; the runner handlers live in `apps/runner/src/control/`.

- `slot` is `slotNameSchema`: `^[a-z0-9][a-z0-9-]*$`, at most 64 characters —
  the one slot-name rule; `subscribe`, `unsubscribe` and `pane` reuse it. A slot
  whose worktree is not under the command's project answers `path_not_allowed`.
- `model` never starts with `-`; `permissionMode` is
  `auto | acceptEdits | bypassPermissions | manual`, where `manual` is the
  runtime's default, prompting mode.
- `slot.message.text` is at most 16 KB in UTF-8 and is written to the
  worktree's `.orchestrator-msg.md`, never typed into the pane; `from` is the
  requesting user's email. The file is always written; `delivered` is true
  only when the worker's session was live and the prompt was typed into it.
- `orchestrator.message` (#189) is `slot.message`'s twin for the orchestrator:
  the same 16 KB cap on `body`, the same `From:` header, operator role. Its args
  never name a session or argv — the runner resolves the orchestrator's session
  from the project, and the strict schema refuses any other field. The body is
  never typed into the pane: it is written atomically to a file of its own,
  `<git-common-dir>/cs-orchestrator/agentdock/msg-<time>-<rand>.md` (inside
  `.git`, never committed, one file per message), then a fixed `Read <file>: …`
  prompt is typed with `-l` and submitted with `C-m` in a separate call. With
  no session (`reason: absent`), or with a dialog on its pane (`reason:
  prompt`, where the submit would answer the dialog), nothing is written or
  typed and `delivered` is false.
- Every tmux target the runner sends is exact (`-t =<session>`): a bare name
  falls back to a prefix match, so `cs-i4` would hit `cs-i42`.
- `orchestrator.status.state` is `running | idle | prompt | quota`, or
  `absent` exactly when `present` is false.

### Sessions

Schemas in `events/sessions.ts`; the rules are [spec 12](../specs/12-agent-sessions.md)
D11.

- `session.backfill { projectId?, since }` re-reads every transcript modified
  after `since` (an ISO date-time in UTC) from its first line, ignoring the
  runner's `sessions.ingestSince`. The events go out as usual session events,
  and the API's upserts absorb the ones it already has.
- With `projectId`, only sessions correlated to that project are sent. A
  `projectId` that is not on the runner's watch list is `path_not_allowed`. A
  runner with `sessions.enabled: false` answers `disabled`.
- It answers when the re-read is done, with how many files matched and how
  many events were spooled. The 600 s timeout covers a profile holding
  gigabytes of transcripts. Choose `since` so the events fit the spool's
  100 MB cap. Past the cap, the oldest unacked events are dropped
  (`runner.spool_truncated`).
- `POST /admin/runners/:id/backfill` (admin) sends it. A runner without a
  connection is `409 runner_offline`, no answer within the timeout is
  `504 runner_timeout` (the re-read may still finish), a refusal is
  `409 runner_refused`, and a failure is `502 runner_error`.

### Queue

Schemas in `commands/queue.ts`; the rules are [spec 19](../specs/19-task-queue.md)
D1 and D7. Both are exported as `issueCreateCommand` and
`issuesRefreshCommand` (and together as `queueCommands`) but are **not** in
the `commands` map: the runner's `CommandHandlers` needs a handler for every
entry, so the map entry lands with the handler.

- `issue.create { projectId, title, body, labels[], queue, readyLabel? }` runs
  `gh issue create --repo <owner/repo> --title … --body-file <tmp> --label …`
  in the project's root (a `projectId` not on the watch list is
  `path_not_allowed`). With `queue: true` it adds the ready label only when
  `specGap(body, labels)` is null, and otherwise answers `queued: false` with
  `reason: no_acceptance_criteria | no_parallel_plan`. `body` is at most
  64 KB, `labels` at most 20. `readyLabel` (optional, 1–100 characters) is the
  project's effective ready label, which the API always sends; absent, the
  runner uses `orchestrator.readyLabel` from its config, else `cs:ready`.
- `issues.refresh { projectId }` runs the `issues` collector's poll for that
  project now. A changed listing goes out as `issues.snapshot` events as
  usual; the result says whether it changed (`false` on a `304`).
- The API sends them from one place, `apps/api/src/queue/queue-commands.ts`,
  which answers `503 command_unavailable` until they are in the map.

### Merge approval

Schemas in `commands/approvals.ts`; the rules are
[spec 20](../specs/20-merge-approval-queue.md) D4–D7. Exported together as
`approvalCommands` and spread into the `commands` map together with the
runner's handlers (`apps/runner/src/commands/approvals/`).

- `pr.inspect { projectId, root, pr }` runs `gh pr view <pr> --json
  additions,deletions,changedFiles,files,statusCheckRollup,mergeable,mergeStateStatus,url,title,body,state,headRefOid`
  in the project's root. → `{ number, url, title, body (≤ 64 KB), state
  open|merged|closed, headSha, additions, deletions, changedFiles, files[] (≤ 300,
  filesTruncated), checks (the `rollupChecks` rollup), checkList[] { name, state
  pass|wait|fail, url? }, mergeable, mergeStateStatus, fetchedAt }`.
- `pr.approve { …, headSha, by, at }` and `pr.requestChanges { …, headSha, by,
  at, note ≤ 4 KB }` write the approval signal the orchestrator reads
  (plugin#8). `pr.voidApproval { …, headSha, at }` withdraws the signal for a
  head that has been superseded (D6). The args carry the decision's **intent**;
  the signal's file format and path live only in the runner's
  `commands/approvals/signal.ts` (D5), and nothing these commands write is
  outside `<git-common-dir>/cs-orchestrator/approvals/`.
- The runner takes `root` only if it equals the watched project's root
  (`path_not_allowed` otherwise), and `pr.inspect` runs `gh pr view <n> --repo
  <owner/name>` with fixed argv. A `gh` that is missing, fails or prints
  something unexpected answers `upstream_unavailable`.
- The API sends all four from `apps/api/src/approvals/approval-commands.ts`
  through `RunnerCommandService`; a runner that does not answer is `503
  command_unavailable`, a runner error `502 command_failed`. The API
  re-reads the head with `pr.inspect` before every decision; a decision never
  reaches the runner for a head other than the one the person saw.

### Skills

Schemas in `commands/skills.ts` (`skillCommands`) and `events/skills.ts`; the
rules are [spec 24](../specs/24-skills.md). `skillCommands` is spread into the
`commands` map, and the runner serves it from `apps/runner/src/skills/`.

Every value can come from the public catalog and ends up in a path, an argv
or a git ref, so every field is patterned and bounded. Nothing starts with
`-`, nothing contains `..`, and no field is a URL or a shell string:

- `source` is `owner/repo` on GitHub — `^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_][A-Za-z0-9._-]*$`,
  with no `..`. The runner clones only `https://github.com/<source>.git`, and
  the catalog host is fixed in the runner config. A host or URL argument is an
  unknown key, so it fails as `invalid_args`.
- `skillId` / `name` (`skillNameSchema`) is the skill's directory name in every
  install path and in the `skills/<name>` branch. `skill` (`skillInvocationSchema`)
  is `<name>` or `<plugin>:<name>`. `ref` and `base` (`gitRefSchema`) are a
  `git check-ref-format` subset. `commit` is a full SHA, and `contentHash` /
  `sha256` are lower-case hex.
- File paths in results are relative, with no `.`/`..`/empty segment and no
  leading `/`.
- `contentHash` is the SHA-256 of `skillContentHashInput(files)`: one
  `path:sha256\n` line per file, sorted by path.
- `skill.run.args` is at most 4 KiB with no NUL. It becomes part of one argv
  element, `-p "/<skill> <args>"`, never a shell string. `model` reuses
  `orchestratorModelSchema`, `permissionMode` reuses
  `orchestratorPermissionModeSchema`, and `timeoutSec` is 60–21600.
- `skill.install` has a static `minRole` of `operator`, because a definition
  carries one role. A profile install needs admin: the API checks
  `skillInstallMinRole(args)` before it sends the command.
- `skill.cancel` carries `projectId`, and the runner answers `not_found` for a
  run of another project.
- `isRunnableSkill` refuses `code-sentinel:orchestrator`, `code-sentinel:worker`
  (and their `cs-` names) with `not_runnable`.
- A run's tmux session is `agentdock-run-<shortid>` (`skillRunSessionName`),
  never `cs-`. Its branch is `run/<shortid>-<skill>`, with a plugin's `:`
  written as `-` (`skillRunBranch`).

A run outlives `skill.run`. Its progress is two event types (`source: "runner"`):

| Type | `data` | Sent |
|---|---|---|
| `skill_run.phase_changed` | `runId, projectId, phase, at, tmuxSession?, worktree?, branch?` | on every phase transition, `queued` included |
| `skill_run.finished` | `runId, projectId, phase (terminal), finishedAt, exitCode, reportText?, reportTruncated, changedFiles[] { status, path }, changedFilesTotal, patch?, patchTruncated, prNumber?, prUrl?, error?` | once, at a terminal phase |

`skill_run.finished` must fit an `events` batch:

- `patch` is at most 128 KiB;
- `reportText` is at most 32 KiB;
- `changedFiles` holds at most 200 entries;
- the whole `data` is at most 224 KiB.

Each cut is flagged. The full patch stays in the run directory on the runner.
`skillPhaseToRunStatus` maps phases onto #21's `runs.status`.

How the runner serves them:

- **Network.** Search fetches only `https://skills.sh/api/search`. Inspect
  and install fetch only `https://github.com/<source>.git`, with no
  credential helper, no prompt and no LFS filter. A missing repository, ref
  or skill is `not_found`; a forge or catalog failure is
  `upstream_unavailable`.
- **What a skill is.** A directory holding `SKILL.md`, at most three levels
  below the repository root. A `SKILL.md` at the root itself is not offered,
  because a skill's `path` must be a non-empty directory. Only regular files
  are listed, hashed and copied. Symlinks are never followed, and an
  upstream `.agentdock-skill.json` is ignored.
- **Install.** Install fetches exactly `commit` and recomputes `contentHash`.
  A commit the forge no longer serves, or a different hash, is
  `changed_since_preview`, and nothing is written.
  - A project install fails with `already_exists` when `skills/<name>` exists
    locally or on origin, or the skill is already on `origin/<base>`.
  - A profile install fails with `already_exists` when the directory exists.
    Its runtime must match the profile's (`unsupported_runtime`).
- **Inventory.** `skill.list` reads project skills from git on the
  project's `origin/HEAD`. Plugin skills come from each claude profile's
  `plugins/installed_plugins.json`, which names the active install.
- **Run checks.** `skill.run` answers `not_found` unless the skill is
  installed for that project and profile: on the base, in the profile, or in
  the profile's plugins. A reused `runId` is `already_exists`. `timeoutSec`
  is cut to the runner's `skills.maxTimeoutSec`.
- **Run ends.** Cancel, timeout and failure collect the report fields
  (`reportText`, `changedFiles`, `patch`) but never push or open a PR. Only
  a `succeeded` `pr` run does.
- **Run log.** `run_log` subscriptions are refused `not_found` for a run of
  another project. Each one replays at most `RUN_LOG_BACKLOG_LINES` and
  then tails `stream.jsonl` every 500 ms. Lines are redacted like pane
  frames, and so is `reportText`.

### Board cards

Schemas in `commands/cards.ts` (`cardCommands`) and `events/cards.ts`; the
rules are issue [#242](https://github.com/AndreyBegma/AgentDock/issues/242)
and [ADR-0024](../adr/0024-board-cards-and-dedicated-card-workers.md).
`cardCommands` is defined but enters the `commands` map only together with
its runner handlers (`apps/runner/src/cards/`).

A card's worker is an interactive Claude Code session in its own worktree
`<parent>/.wt-<repo>-card-<shortId>` and tmux session
`agentdock-card-<shortId>` (`cardSessionName`), outside the orchestrator.
Every command needs an operator.

| Command | Args | Result |
|---|---|---|
| `card.run` | `cardId, runId, projectId, root, base, shortId (^[a-z0-9]{8}$), branch, session { id (uuid), resume }, prompt (≤ 64 KiB, no NUL), files? ([{ path, content }] ≤ 4, repository-relative, each ≤ 192 KiB), profileKey, model, permissionMode` | `{ phase: starting\|running, tmuxSession }`, timeout 60 s |
| `card.stop` | `cardId, projectId` | `{ stopped }`, timeout 15 s |
| `card.collect` | `cardId, projectId, root, base, branch, number, title (one line), body (≤ 16 KiB)` | `{ ahead, pushed, prNumber?, prUrl? }`, timeout 180 s |
| `card.close` | `cardId, projectId, removeWorktree` | `{ stopped, worktreeRemoved, branchDeleted }`, timeout 30 s |

- **Run.** Round 1 (`session.resume: false`) creates the worktree from
  `origin/<base>` on `branch`, or checks out `origin/<branch>` when it exists,
  commits `files` as the branch's first commit, writes `launch.json` with
  `interactive: true` and starts tmux running `agentdock-runner exec-run`.
  `exec-run` launches `claude --session-id <id>` (later rounds
  `claude --resume <id>`) with `--model` and `--permission-mode`; the prompt is
  one argv element, never a shell string. An interactive `exec-run` inherits
  stdio (the tmux pane is the terminal) and still writes `exit.json`.
- **Collect.** Commits leftovers as `chore: card C-<number> work in progress`,
  pushes, and opens a PR into `base` when none is open for `branch` (else
  pushes only). `ahead: 0` is "No changes".
- **Close.** Kills tmux; with `removeWorktree`, removes the worktree and
  deletes the local branch only when it is pushed. Never merges.
- A card of another project is `not_found`.

A round outlives `card.run`. Its progress is one event type (`source: "runner"`):

| Type | `data` | Sent |
|---|---|---|
| `card_run.phase_changed` | `cardId, runId, projectId, phase: starting\|running\|ended\|failed, at, tmuxSession?, worktree?, exitCode?, error?` | on every transition; `ended` when the tmux session is gone (polled every 10 s) |

What Claude does inside the session arrives as `hook.*` events whose
`session.id` is the card's session uuid; the worker's `finish_card` MCP tool
is the `card.finish` local method.

### Terminal

Schemas in `commands/terminal.ts`; the rules are [spec 29](../specs/29-terminal-attach.md)
D1–D7 and D10. It is exported as `terminalCommands` and spread into the
`commands` map; the runner serves it from `apps/runner/src/terminal/`.

- `terminal.attach { id, target, mode, cols, rows }` is admin only. `id` is
  the stream id the server picked (`[A-Za-z0-9_-]`, at most 128), distinct
  from the `command` message id.
- `target` names a session by what it is, never by name, and an unknown field
  fails to parse. The runner resolves it:
  - `slot { projectId, root, slot }` → `cs-<slot>` (or
    `cs-<prefix>--<slot>`), when the slot's worktree belongs to `root`;
  - `orchestrator { projectId, root }` → the project's orchestrator session;
  - `skill_run { projectId, root, runId }` → `agentdock-run-<shortid>` of a
    live run of that project. Until #24's runner lands this answers
    `unsupported`.
  - `card { projectId, root, cardId }` → `agentdock-card-<shortid>` of that
    project's board card (issue #242). Until the card executor lands this
    answers `unsupported`.
- A target that does not resolve, or resolves into another project, is
  `not_found`. When both `cs-<slot>` and `cs-<prefix>--<slot>` are live, the
  runner attaches to the one that sorts first.
- `mode: read` spawns `tmux attach-session -r -f ignore-size -t <session>`;
  `write` spawns the plain `attach-session`. Both are argv, never a shell
  string. Taking control is a second, separately audited attach.
- `busy`: the runner already holds `TERMINAL_MAX_ATTACHES_PER_RUNNER` (2)
  attaches, or a `write` attach already holds the target. `unsupported`: no
  PTY API or tmux older than 3.2. `disabled`: the runner config lists
  `terminal.attach`, and its capabilities report `terminal: false`.
- The command answers once the PTY is running; the stream then outlives it
  as `terminal.*` messages. An attach still resolving its target counts
  against the cap; a `terminal.close` for it, or a dropped socket, cancels it
  before anything is spawned.
- Ending an attach sends SIGHUP to the `tmux attach` client, then SIGKILL
  after 2 s if it has not exited. The target session is never signalled.
  The runner logs byte counts per attach (`bytesIn`, `bytesOut`,
  `bytesDropped` for refused input on a `read` attach), never the bytes.

```json
{
  "type": "command",
  "id": "cmd_31",
  "name": "terminal.attach",
  "args": {
    "id": "term_4c1d",
    "target": {
      "kind": "slot",
      "projectId": "prj_agentdock",
      "root": "/home/dev/agentdock",
      "slot": "i42"
    },
    "mode": "read",
    "cols": 160,
    "rows": 48
  }
}
```

```json
{
  "type": "command.result",
  "id": "cmd_31",
  "ok": true,
  "output": { "attached": true, "session": "cs-i42" }
}
```

### Worktree

Schemas in `commands/worktree.ts` (`worktreeCommands`); the rules are
[spec 160](../specs/160-agent-workspace.md). The runner serves it from
`apps/runner/src/commands/worktree/`.

- `worktree.status { projectId, root, slot, base? }` is a read for any member
  (`viewer`). `projectId` and `root` must be an entry of the watch list; the
  worktree is the `.wt-<repo>-<slot>` one git lists for that root, else
  `path_not_allowed`. No argument names a path, a ref range or a git flag.
- `base` is a ref name (`gitRefSchema`). The runner tries `origin/<base>`,
  then `<base>`, then the project's default branch, each with
  `rev-parse --verify`; `base` in the result is the one that resolved, or null.
- `files` are the paths that differ from the merge base with the base —
  committed, staged and unstaged, with `--numstat` line counts (null for a
  binary file) — then the untracked ones; at most 200, the rest counted in
  `filesTruncated`. `commits` are the last 5 of HEAD. `changed` and
  `untracked` count the working tree's uncommitted paths.
- Every git call is a fixed argv (`worktree list`, `status --porcelain=v2`,
  `rev-parse`, `rev-list`, `merge-base`, `diff`, `log`); nothing is written.

```json
{
  "type": "command",
  "id": "cmd_44",
  "name": "worktree.status",
  "args": {
    "projectId": "prj_agentdock",
    "root": "/home/dev/agentdock",
    "slot": "i42",
    "base": "develop"
  }
}
```

```json
{
  "type": "command.result",
  "id": "cmd_44",
  "ok": true,
  "output": {
    "slot": "i42",
    "branch": "feat/42-api",
    "head": "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    "base": "origin/develop",
    "ahead": 3,
    "behind": 0,
    "changed": 1,
    "untracked": 0,
    "files": [
      { "path": "apps/api/src/fleet/graph.ts", "status": "added", "additions": 120, "deletions": 0 }
    ],
    "filesTruncated": 0,
    "commits": [
      {
        "sha": "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        "subject": "feat(api): fleet graph",
        "author": "Archi",
        "at": "2026-10-14T09:12:00+02:00"
      }
    ]
  }
}
```

### Token saver

Schemas in `packages/shared/src/token-saver/contracts.ts`; the rules are
[spec 445](../specs/445-token-saver.md) and
[ADR-0039](../adr/0039-token-saver.md). The runner compresses what agents
read, never what people read.

**On the launch commands.** Each of the eight commands that start a Claude
session takes an optional `tokenSaver: { enabled, mcpAllow }`. The eight are
`card.run`, `skill.run`, `plan.turn`, `card.assess`, `cards.extract`,
`uiprofile.build`, `text.normalize` and `orchestrator.start`.

- `mcpAllow` lists the MCP servers, by name, that the launch loads besides
  `agentdock`. There are at most 32, with no duplicates, each matching
  `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`. The runner takes each server's
  definition from the launch profile's own config (D6).
- An absent `tokenSaver`, or `enabled: false`, launches exactly as before #445.
- Every launch args schema is strict, so a runner older than the field
  refuses it as `invalid_args`. The runner advertises the field with the
  capability `tokenSaver: true` in `hello`; read it with
  `tokenSaverAvailable()`. The API sends `tokenSaver` only to a runner that
  advertises it, as with `terminal`. An absent capability means `false`.
- The API fills the field from `token_saver_settings`. A project with no row
  gets `TOKEN_SAVER_DEFAULT` (`{ enabled: true, mcpAllow: [] }`).
- The API records on the run whether the launch carried
  `tokenSaver.enabled: true` (`runs.tokenSaver`). The before/after of D12
  compares runs with `false` against runs with `true`, by run kind.

**MCP servers per profile.** Each Claude profile in `capabilities.profiles`
may carry `mcpServers`: the names of the MCP servers in that profile's own
Claude config. It holds names only, never a command, env or secret. There are
at most 64 (`PROFILE_MCP_SERVERS_MAX`), each matching the server-name pattern
above. An absent `mcpServers` means unknown: a runner older than the field, or
a Codex profile. The project's **Token saver** tab offers these names as the
allowlist's checkboxes.

**The hook's scope.** The PreToolUse hook rewrites only a single simple
command of a covered family. These pass through unchanged and are counted
`passedThrough`:

- a command with `|`, `&&`, `||`, `;`, a redirect, a heredoc, a subshell or a
  command substitution;
- a Bash call with `run_in_background: true`;
- a dev server or a watch mode.

**Inside the runner.** These are not part of the wire protocol; they are
listed so the slots agree:

- The `filter` subprocess appends one JSONL row per command to the file named
  by `$AGENTDOCK_FILTER_STATS`, in the run dir. The launch sets the variable.
  The daemon reads the file in batches and sends `filter.stats`.
- `/cs-eco` sessions (#475) keep their rows in the plugin's state dir,
  `${XDG_STATE_HOME:-~/.local/state}/cs-eco/sessions/<session id>/filter-stats.jsonl`.
  The daemon sends them as `runKind: manual`, `runId: null`, for the watched
  project whose root holds the session's cwd. See the Token saver guide.
- The raw output of command `n` goes to `<run dir>/raw/<n>.log`. It is removed
  with the run dir. One file is capped at 10 MB with a truncation marker, and
  the compressed output says it was truncated.

**The `filter.stats` event.** The runner reports filtered commands in the
ordinary `events` stream, so stats are spooled, resent and acked like every
other event. Each event has `source: "runner"` and type `filter.stats`
(`FILTER_STATS_EVENT`). The envelope's `project` names the project. The rows
carry no `projectId`: the API resolves the project.

| Field of each row | Meaning |
|---|---|
| `id` | the runner's id for the row (`^[A-Za-z0-9_-]{1,64}$`). The API inserts it as the `token_saver_stats` primary key and skips duplicates, so a resent batch counts once |
| `runId` | the launch's run; `null` exactly when `runKind` is `orchestrator` or `manual` |
| `runKind` | `card`, `skill`, `plan`, `card_assess`, `card_capture`, `ui_profile`, `text_normalize`, `orchestrator` or `manual` — a `/cs-eco` session the runner did not launch (#475) |
| `filter` | `<family>/<command>` (e.g. `js/jest`), or `none` when no filter matched |
| `rawBytes`, `keptBytes` | the output before and after the filter; `keptBytes ≤ rawBytes` |
| `bypassed` | ran with `AGENTDOCK_RAW=1`; `keptBytes = rawBytes` |
| `passedThrough` | the filter returned the original output; `keptBytes = rawBytes` |
| `at` | when the command finished (ISO); stored as `createdAt` |

```json
{
  "type": "events",
  "events": [
    {
      "v": 1, "seq": 18412, "ts": "2026-12-02T10:14:03.000Z",
      "type": "filter.stats", "source": "runner",
      "project": { "repo": "AndreyBegma/AgentDock", "root": "/home/archi/dev/AgentDock" },
      "data": {
        "rows": [
          { "id": "f_9c2e1a", "runId": "cmrun0001", "runKind": "card", "filter": "js/jest",
            "rawBytes": 48211, "keptBytes": 3920, "bypassed": false, "passedThrough": false,
            "at": "2026-12-02T10:14:02.000Z" }
        ]
      }
    }
  ]
}
```

- A batch holds 1 to 200 rows (`FILTER_STATS_MAX_ROWS`).
- An event whose `data` fails `filterStatsDataSchema` is logged and skipped,
  like any bad sink input.
- The savings estimate is `(rawBytes − keptBytes) / 4` tokens
  (`estimateTokensSaved`), priced at the session model's input price
  (ADR-0009). It is always shown with "≈".

**On `card.finish`.** The runner's artifact guard (D8) may send
`artifactIncomplete: true` when it accepts a finish after 2 rejections in the
round. The API stores it as `runs.artifactIncomplete`, and the card shows
**Description incomplete**.

### Steward

Schemas in `packages/shared/src/steward/` (the vocabulary, the setting, the
events) and `packages/shared/src/protocol/commands/steward.ts` (the commands);
the rules are [spec 447](../specs/447-steward.md) and
[ADR-0040](../adr/0040-steward.md). **The runner observes and acts; the API
decides and reports** (D2). Steward acts on card rounds and runner runs; a
fleet slot is observe-only (D5, ADR-0005), and no command schema can name one.

**The subject.** Every event and command names what it is about:

| `subject.kind` | Fields | Acted on |
|---|---|---|
| `card_round` | `cardId`, `runId` (the round's run) | yes |
| `run` | `runId` (a skill, design, planner, assess, capture or normalize run) | yes |
| `fleet_slot` | `slot` | never — events only |

The runner resolves the tmux session from the subject; no field is a session
name or a path.

**What the runner applies itself.** From `projects[].steward`
(`stewardRunnerConfigOf` of the project's `steward_settings`, defaults when it
has no row):

- `enabled: false` — no observation, no `steward.*` event, no guard.
- `silenceMinutes` — a round or run in `running` or `waiting` with no hook
  event and no live background task (#390) for this long is `silent` (D6). A
  pane signal — an API error or an interrupted response, a modal dialog, a
  permission prompt, the quota banner — is reported at the next pane poll,
  without waiting for the threshold.
- `trailerGuard` — before a card's push (#359 draft push and collect), the
  runner checks every new commit message with `hasClaudeTrailer`
  (`Co-Authored-By: Claude`, `Claude-Session:`, `Generated with Claude Code`).
  On a hit it does not push, tells the worker the commits to rewrite (no
  automatic rebase), and reports `steward.acted` with `action: "hold_push"`
  (D7).

Nudge, dismiss and resume are API decisions — the switches, the per-round
limits, a person-stopped round — so their switches stay on the API.

**The `steward.observed` event.** In the ordinary `events` stream,
`source: "runner"`. Sent once per change of `kind` or `reason` for a subject,
not on every poll.

| Field | Meaning |
|---|---|
| `projectId` | the project, repeated from the envelope |
| `at` | when it was seen (ISO) |
| `subject` | see above |
| `kind` | `api_error`, `dialog`, `permission_prompt`, `quota`, `silent`, `dead_session`, `trailer` or `unknown` |
| `reason` | one line, ≤ 200 characters: the rule's, or for `unknown` the one line from haiku, run locally through the launch profile (D3) |
| `dialogId` | with `kind: "dialog"` only, when the dialog is on the #435 list (`STEWARD_DIALOG_IDS`) |
| `paneTail` | the pane's last lines, ≤ 4 KiB — **only** when `projects[].shipContent` is true (D12) |
| `classifierSessionId` | with `kind: "unknown"` only: the Claude session of haiku's classification. The API records it as a run of kind `steward`, so the spend counts against the project budget (D16, ADR-0009) |

With `shipContent` off, no pane or transcript text reaches the API: the
reason is the only text, and a rule's reason quotes no pane content.

**The `steward.acted` event.** Every Steward action the runner performs, the
commanded ones and `hold_push`: `projectId`, `at`, `subject` (never a fleet
slot), `action` (`nudge`, `dismiss`, `resume`, `hold_push`), `result` (`ok`,
`failed`) and an optional one-line `detail` (never pane text). The API appends
it to the subject's open incident; this event, not the command's result, is
the record.

```json
{
  "type": "events",
  "events": [
    {
      "v": 1, "seq": 20117, "ts": "2026-12-03T09:41:07.000Z",
      "type": "steward.observed", "source": "runner",
      "project": { "repo": "AndreyBegma/AgentDock", "root": "/home/archi/dev/AgentDock" },
      "data": {
        "projectId": "prj_agentdock", "at": "2026-12-03T09:41:06.000Z",
        "subject": { "kind": "card_round", "cardId": "cmcard0001", "runId": "cmrun0001" },
        "kind": "api_error", "reason": "API Error: Connection lost mid-response"
      }
    },
    {
      "v": 1, "seq": 20118, "ts": "2026-12-03T09:41:09.000Z",
      "type": "steward.acted", "source": "runner",
      "project": { "repo": "AndreyBegma/AgentDock", "root": "/home/archi/dev/AgentDock" },
      "data": {
        "projectId": "prj_agentdock", "at": "2026-12-03T09:41:09.000Z",
        "subject": { "kind": "card_round", "cardId": "cmcard0001", "runId": "cmrun0001" },
        "action": "nudge", "result": "ok"
      }
    }
  ]
}
```

An event whose `data` fails its schema (`stewardEventDataSchemas`) is logged
and skipped, like any bad sink input.

**The commands.** Each is sent only to a runner whose capabilities say
`steward: true`, needs `operator`, and is entered in the allowlist together
with its runner handler.

| Command | Args | Result |
|---|---|---|
| `session.nudge` | `projectId`, `subject` (card round or run), `text` — exactly `STEWARD_NUDGE_TEXT` | `{ sent }`; `false` when the pane shows no idle prompt or the session is gone — nothing is typed |
| `session.dismiss` | `projectId`, `subject`, `dialogId` from `STEWARD_DIALOG_IDS` | `{ dismissed }`; `false` when the pane no longer shows that dialog |
| `card.resume` | `cardId`, `projectId`, `runId`, `root`, `base`, `shortId`, `branch`, `sessionId`, `profileKey`, `model`, `permissionMode`, `pullRequest?`, `tokenSaver?` — the round's `card.run` facts | `{ outcome: "resumed" \| "alive" \| "no_worktree", tmuxSession? }` |

- **Nudge (D9).** The text is "The previous response was cut off by an
  API/network error. Continue from where you stopped." At most 2 per round
  (`STEWARD_NUDGE_MAX_PER_ROUND`), the first at once and the second 2 minutes
  later (`STEWARD_NUDGE_REPEAT_DELAY_MS`); a third error escalates.
- **Dismiss (D11).** Only the dialogs on the #435 list, with the key that
  changes nothing. An unlisted dialog or a permission prompt is never
  answered: it escalates at once with "open the terminal".
- **Resume (D10).** `claude --resume <sessionId>` in the card's existing
  worktree (`<parent>/.wt-<repo>-card-<shortId>`) with the prompt "The session
  was restarted after a crash. Continue from where you stopped."
  (`STEWARD_RESUME_TEXT`). It never creates a worktree: with none the outcome
  is `no_worktree` and nothing starts. A session still alive is `alive`, left
  alone. At most 2 per round (`STEWARD_RESUME_MAX_PER_ROUND`); the API never
  sends it for a round a person stopped.

**What the API records.** Incidents live in `steward_incidents` (one per stall
of a subject; `actions` holds `{ action, at, result, detail? }`). As one moves
the API records `steward_incident.opened`, `.acted`, `.escalated` and
`.resolved` itself (`source: "api"`, ADR-0014); those are what Activity shows,
under the **Steward** filter (`STEWARD_ACTIVITY_TYPES`). An escalation sends
one `steward.incident` notification; a changed reason sends another
(`notifiedReason`); recovery writes `.resolved` and pushes nothing (D13).

### Context handoff

Schemas in `packages/shared/src/handoff/` (the note, person lines, the events,
the `resume_context` tool) and `packages/shared/src/protocol/commands/handoff.ts`
(the command); the rules are [spec 449](../specs/449-context-handoff.md) and
[ADR-0042](../adr/0042-context-handoff.md). Every card and every design or
planner run keeps a short **handoff note**; the runner starts the next round or
session from `--resume` or from the note, whichever costs less on its first
turn. **Context handoff is on with Token saver**: a launch command's
`tokenSaver.enabled` is the switch — no field of its own.

**The note (D5).** Markdown with these `## ` sections, each once, in this
order: Goal; Done; Next; Decisions and why; Dead ends; Files touched; How to
verify; Checklist status; Open questions. Headings match case-insensitively; a
`# ` title above them is allowed; only the Goal must have text. At most
`HANDOFF_NOTE_MAX_TOKENS` (3 000, estimated at 4 characters a token —
`HANDOFF_NOTE_MAX_CHARS`). `validateHandoffNote` returns every reason at once;
the runner sends a refused note back to the agent with `handoffRejectionText`.

The note lives on the machine always — `.agentdock/handoff.md` in the card's
worktree (git-excluded), `<run dir>/handoff.md` for a run (D4). Its content
reaches the API only when `projects[].shipContent` is true (ADR-0021).

**Person lines (D7).** The lines a person wrote are instructions: the agent
never rewrites them. They travel as `personLines`, sorted 1-based inclusive
`{ from, to }` ranges of `content.split('\n')` that never touch, never covering
a blank line. On disk each carries the suffix ` <!-- person -->`
(`markPersonLines` / `splitPersonMarks`). The runner refuses an agent rewrite
that drops or changes one (`personLinesKept`); the API marks a person's edit
with `markPersonEdit` against the note it holds.

**The `handoff.updated` event.** In the ordinary `events` stream,
`source: "runner"`, sent **only** when the project ships content. The whole
note, not a diff:

| Field | Meaning |
|---|---|
| `projectId` | the project, repeated from the envelope |
| `at` | when the note changed (ISO) |
| `subject` | `{ kind: "card", cardId }` or `{ kind: "run", runId }` (a design or planner run) |
| `updatedBy` | `agent` (the session), `haiku` (from a dead session's transcript, run locally) or `person` (applied from `card.handoff.set`) |
| `content`, `personLines` | the note, valid as above |

**The `round.restart` event (D3).** Sent once when a card round's session
launches:

| Field | Meaning |
|---|---|
| `projectId`, `cardId`, `runId` | the round, resolved from its run |
| `at` | the launch (ISO) |
| `mode` | `resume` (`--resume`), `fresh` (a new session seeded with the note, the diff summary and the checklist status), `first` (the card's first round) |
| `estimate` | `{ resumeTokens, freshTokens, cacheWarm }` — the estimated first-turn input of each; `null` exactly for `first` |
| `sessionId` | the session the round runs in |
| `previousSessionId` | with `fresh` only: the session not resumed |

A fresh start never discards the old session. The API records `sessionId` on
the round and moves the card to it, so `finish_card`, the hooks and the next
`--resume` follow the new session; the earlier round keeps the old one, which
can still be resumed.

**The `round.warmup` event (D9).** Sent once, at a round's first file edit:
`projectId`, `cardId`, `runId`, `at`, `tokens` (input tokens since the round
started) and `ms`. A round that never edits sends none.

```json
{
  "type": "events",
  "events": [
    {
      "v": 1, "seq": 31002, "ts": "2026-12-04T08:02:11.000Z",
      "type": "round.restart", "source": "runner",
      "project": { "repo": "AndreyBegma/AgentDock", "root": "/home/archi/dev/AgentDock" },
      "data": {
        "projectId": "prj_agentdock", "cardId": "cmcard0001", "runId": "cmrun0002",
        "at": "2026-12-04T08:02:10.000Z", "mode": "fresh",
        "estimate": { "resumeTokens": 182000, "freshTokens": 6400, "cacheWarm": false },
        "sessionId": "22222222-2222-4222-8222-222222222222",
        "previousSessionId": "11111111-1111-4111-8111-111111111111"
      }
    },
    {
      "v": 1, "seq": 31007, "ts": "2026-12-04T08:03:40.000Z",
      "type": "round.warmup", "source": "runner",
      "project": { "repo": "AndreyBegma/AgentDock", "root": "/home/archi/dev/AgentDock" },
      "data": {
        "projectId": "prj_agentdock", "cardId": "cmcard0001", "runId": "cmrun0002",
        "at": "2026-12-04T08:03:39.000Z", "tokens": 9100, "ms": 89000
      }
    }
  ]
}
```

An event whose `data` fails its schema (`handoffEventDataSchemas`) is logged
and skipped, like any bad sink input.

**The command.** Sent only to a runner whose capabilities say
`handoff: true`, needs `operator`, and is entered in the allowlist together
with its runner handler.

| Command | Args | Result |
|---|---|---|
| `card.handoff.set` | `projectId`, `cardId`, `shortId`, `content`, `personLines` | `{ outcome: "applied" \| "no_worktree" }` |

The runner writes the note, person lines marked, to the worktree resolved from
`shortId` and reports it as `handoff.updated` with `updatedBy: "person"`. With
no worktree on the machine nothing is written.

**The `resume_context` MCP tool (D6).** A tool of the agentdock MCP server for
a person's own terminal session; the runner answers it from the note on the
machine, without asking the API, so it works with session content off. The
card is resolved from the session — its worktree, or a checkout on the card's
branch — and the tool takes no argument (`resumeContextArgsSchema`). It
returns `{ found: true, card: { number, label }, content, personLines,
updatedBy, updatedAt }`, or `{ found: false, reason }` with
`not_a_card_session` or `no_note` (`resumeContextResultSchema`). The plugin's
`SessionStart` hook and `track_card` hand the same note to a session in a
card's worktree or branch.

## Delivery guarantees

- Events: at-least-once; dedupe on `(runnerId, seq)`. A runner keeps unacked
  events in a local append-only spool (`~/.local/state/agentdock/spool/`), capped
  at 100 MB, oldest dropped with a `runner.spool_truncated` event.
  Those events are gone and will never be resent, so a server that persists a
  `runner.spool_truncated` event treats its `[fromSeq, toSeq]` range as filled
  when it computes the highest contiguous `seq` — otherwise the ack cursor
  stops below the hole forever and the spool never drains.
- Commands: at-most-once. A command whose result never arrives is marked
  `unknown` after its timeout; the UI shows it, nothing retries a state change
  automatically.
