# Runner protocol

Status: draft (M1.3). Types live in `packages/shared/src/protocol/` as zod
schemas; this document is their rationale.

## Pairing

1. An admin creates a runner in the UI → the API returns a one-time pairing code
   (10 minutes, single use) and an install command.
2. `agentdock-runner pair --server https://dock.example --code XXXX-XXXX`
3. The API exchanges the code for a long-lived runner token (random 256-bit,
   stored as an argon2id hash) and the runner id. The runner writes both to
   `~/.config/agentdock/runner.json` (mode 0600).
4. Revoking the runner in the UI invalidates the token and closes its socket.

## Transport

- The runner dials `wss://<server>/runner` with `Authorization: Bearer <token>`.
  Never the other way round: a runner behind NAT needs no open port.
- JSON messages, one per WebSocket frame, each `{ type, id?, ... }`.
- Reconnect with exponential backoff (1 s → 60 s, jitter).

## Messages

| Direction | Type | Payload |
|---|---|---|
| R → S | `hello` | runner version, protocol version, hostname, os, capabilities, last acked `seq` |
| S → R | `welcome` | runner id, config (projects to watch, poll intervals), resume-from `seq` |
| R → S | `heartbeat` | every 15 s: load, tmux sessions count, collectors health |
| R → S | `events` | `{ events: Event[] }` batch, ≤ 500 events or 256 KiB |
| S → R | `ack` | highest contiguous `seq` persisted |
| S → R | `command` | `{ id, name, args }` — typed, see below |
| R → S | `command.result` | `{ id, ok, output?, error? }` |
| R → S | `command.progress` | `{ id, chunk }` for streaming commands |
| S → R | `subscribe` / `unsubscribe` | live pane capture for a slot (read-only) |
| R → S | `pane` | `{ slot, lines, cursor }` |

## Capabilities (in `hello`)

```json
{
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
  "codeSentinel": { "version": "1.23.0", "path": "..." },
  "otlp": { "grpc": 4317, "http": 4318 }
}
```

Profiles are defined in the runner config, not on the server: a credential path
is a fact about the machine. The UI lists them and lets a project or a run pick
one.

## Commands (allowlist)

| Name | Args | Min role |
|---|---|---|
| `project.inspect` | `path` | admin |
| `project.refresh` | `projectId` | operator |
| `orchestrator.start` | `projectId, profileId, mode: start\|next` | operator |
| `orchestrator.stop` | `projectId` | operator |
| `orchestrator.status` | `projectId` | viewer |
| `slot.stop` | `projectId, slot` | operator |
| `slot.message` | `projectId, slot, text` | operator |
| `pr.approve` / `pr.requestChanges` | `projectId, pr, note?` | operator |
| `issue.create` | `projectId, title, body, labels` | operator |
| `skill.search` | `query` | operator |
| `skill.install` | `projectId?, source, runtimes[]` | operator |
| `skill.run` | `projectId, skill, args, profileId, model, output: report\|pr` | operator |
| `session.backfill` | `projectId?, since` | admin |
| `terminal.attach` (M3) | `projectId, slot` | admin |

Arguments are validated by schema on both sides. Paths are resolved and must
sit under a registered project root or the runner's worktree parent. No
command takes a shell string.

## Delivery guarantees

- Events: at-least-once; dedupe on `(runnerId, seq)`. A runner keeps unacked
  events in a local append-only spool (`~/.local/state/agentdock/spool/`), capped
  at 100 MB, oldest dropped with a `runner.spool_truncated` event.
- Commands: at-most-once. A command whose result never arrives is marked
  `unknown` after its timeout; the UI shows it, nothing retries a state change
  automatically.
