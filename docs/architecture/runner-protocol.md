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
| S → R | `unsubscribe` | `{ id }` |
| R → S | `pane` | `{ id, frame: { type: "full", lines, cursor } \| { type: "patch", from, lines } \| { type: "ended" } }` |
| R → S | `subscribe.error` | `{ id, code: "not_found" \| "too_many_viewers" \| "forbidden" }` |
| S ↔ R | `terminal.data` | `{ id, b64 }` — PTY bytes of an attach, ≤ 64 KiB decoded; S → R only on a `write` attach |
| S → R | `terminal.resize` | `{ id, cols, rows }` |
| S ↔ R | `terminal.close` | `{ id, reason: "client" \| "idle" \| "max_duration" \| "session_ended" \| "socket" }` |

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
    "terminal": true
  }
}
```

`terminal` says whether the runner serves `terminal.attach`: it has Bun's PTY
API (Bun ≥ 1.3.5, POSIX), tmux ≥ 3.2, and the command is not in
`disabledCommands`. An absent `terminal` means `false`, because a runner older
than the feature never sends it; read it with `terminalAvailable()`.

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

### `heartbeat`

`load` is the 1, 5 and 15 minute load average; `collectors` is keyed by
collector name.

```json
{
  "type": "heartbeat",
  "ts": "2026-10-07T18:36:15.000Z",
  "load": [0.42, 0.51, 0.6],
  "tmuxSessions": 4,
  "collectors": {
    "tmux": { "ok": true },
    "transcripts": { "ok": false, "error": "permission denied" }
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
    }
  ]
}
```

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
| `not_found` | the target the runner would resolve does not exist, or does not belong to that project |
| `busy` | a limit is reached: the runner's attach cap, or a `write` attach already holds the target |
| `unsupported` | the machine cannot run the command: no PTY API, not POSIX, or tmux older than 3.2 |

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
| `slot.stop` | `projectId, root, slot` | operator | implemented: → `{ stopped }`, timeout 10 s |
| `slot.message` | `projectId, root, slot, text, from` | operator | implemented: → `{ written: true, delivered }`, timeout 10 s |
| `pr.approve` / `pr.requestChanges` | `projectId, pr, note?` | operator | planned |
| `issue.create` | `projectId, title, body, labels, queue` | operator | defined (`commands/queue.ts`), not in the map yet: → `{ number, url, queued, reason? }`, timeout 45 s |
| `issues.refresh` | `projectId` | operator | defined (`commands/queue.ts`), not in the map yet: → `{ changed, fetchedAt }`, timeout 45 s |
| `skill.search` | `query` | operator | planned |
| `skill.install` | `projectId?, source, runtimes[]` | operator | planned |
| `skill.run` | `projectId, skill, args, profileId, model, output: report\|pr` | operator | planned |
| `session.backfill` | `projectId?, since` | admin | implemented: → `{ files, events }`, timeout 600 s |
| `terminal.attach` | `id, target: { kind: slot\|orchestrator\|skill_run, projectId, root, slot?\|runId? }, mode: read\|write, cols, rows` | admin | implemented: → `{ attached: true, session }`, timeout 10 s; `skill_run` answers `unsupported` until #24's runner lands |

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

- `issue.create { projectId, title, body, labels[], queue }` runs
  `gh issue create --repo <owner/repo> --title … --body-file <tmp> --label …`
  in the project's root (a `projectId` not on the watch list is
  `path_not_allowed`). With `queue: true` it adds the ready label only when
  `specGap(body, labels)` is null, and otherwise answers `queued: false` with
  `reason: no_acceptance_criteria | no_parallel_plan`. `body` is at most
  64 KB, `labels` at most 20.
- `issues.refresh { projectId }` runs the `issues` collector's poll for that
  project now. A changed listing goes out as `issues.snapshot` events as
  usual; the result says whether it changed (`false` on a `304`).
- The API sends them from one place, `apps/api/src/queue/queue-commands.ts`,
  which answers `503 command_unavailable` until they are in the map.

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
