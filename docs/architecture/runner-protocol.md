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
   `POST <server>/api/runners/pair` (`PAIRING_PATH`). The API exchanges the code
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
| R → S | `heartbeat` | every 15 s: load, tmux sessions count, collectors health |
| R → S | `events` | `{ events: Event[] }` batch, ≤ 500 events and ≤ 256 KiB |
| S → R | `ack` | `seq`: highest contiguous `seq` persisted |
| S → R | `command` | `{ id, name, args }` — typed, see below |
| R → S | `command.result` | `{ id, ok, output?, error? }` |
| R → S | `command.progress` | `{ id, chunk }` for streaming commands |
| S → R | `subscribe` / `unsubscribe` | live pane capture for a slot (read-only) |
| R → S | `pane` | `{ projectId, slot, lines, cursor }` |

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
    "otlp": { "grpc": 4317, "http": 4318 }
  }
}
```

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

### `subscribe`, `unsubscribe`, `pane`

```json
{ "type": "subscribe", "projectId": "prj_agentdock", "slot": "i5-protocol" }
```

```json
{ "type": "unsubscribe", "projectId": "prj_agentdock", "slot": "i5-protocol" }
```

```json
{
  "type": "pane",
  "projectId": "prj_agentdock",
  "slot": "i5-protocol",
  "lines": ["$ bun run test", "42 pass"],
  "cursor": { "x": 0, "y": 2 }
}
```

## Commands (allowlist)

Only commands with status *implemented* exist in the `commands` object of the
package; the rest are planned, and each lands with the item that implements its
handler.

| Name | Args | Min role | Status |
|---|---|---|---|
| `runner.ping` | — | viewer | implemented: → `{ pong: true, ts }` |
| `runner.describe` | — | viewer | implemented: → `{ runnerVersion, hostname, os, arch, capabilities }` |
| `project.inspect` | `path` | admin | planned |
| `project.refresh` | `projectId` | operator | planned |
| `orchestrator.start` | `projectId, profileId, mode: start\|next` | operator | planned |
| `orchestrator.stop` | `projectId` | operator | planned |
| `orchestrator.status` | `projectId` | viewer | planned |
| `slot.stop` | `projectId, slot` | operator | planned |
| `slot.message` | `projectId, slot, text` | operator | planned |
| `pr.approve` / `pr.requestChanges` | `projectId, pr, note?` | operator | planned |
| `issue.create` | `projectId, title, body, labels` | operator | planned |
| `skill.search` | `query` | operator | planned |
| `skill.install` | `projectId?, source, runtimes[]` | operator | planned |
| `skill.run` | `projectId, skill, args, profileId, model, output: report\|pr` | operator | planned |
| `session.backfill` | `projectId?, since` | admin | planned |
| `terminal.attach` (M3) | `projectId, slot` | admin | planned |

Arguments are validated by schema on both sides (`parseCommand`). Commands
without arguments take `{}` and reject any field. Paths are resolved and must
sit under a registered project root or the runner's worktree parent. No
command takes a shell string.

## Delivery guarantees

- Events: at-least-once; dedupe on `(runnerId, seq)`. A runner keeps unacked
  events in a local append-only spool (`~/.local/state/agentdock/spool/`), capped
  at 100 MB, oldest dropped with a `runner.spool_truncated` event.
- Commands: at-most-once. A command whose result never arrives is marked
  `unknown` after its timeout; the UI shows it, nothing retries a state change
  automatically.
