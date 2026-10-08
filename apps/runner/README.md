# agentdock-runner

The per-machine daemon of AgentDock ([ADR-0001](../../docs/adr/0001-control-plane-and-per-machine-runner.md)).
It pairs with the API, connects out over WebSocket, reports the machine's
capabilities and runtime profiles, spools events and answers typed commands
([runner-protocol.md](../../docs/architecture/runner-protocol.md),
[spec #5](../../docs/specs/5-runner-daemon-and-protocol.md)).

## Commands

| Command | What it does |
|---|---|
| `pair --server <api-origin> --code XXXX-XXXX [--no-detect]` | exchanges a pairing code for a runner id and token; when the config has no profiles yet, also detects and writes them (`--no-detect` skips it, existing profiles are never overwritten) |
| `run` | the daemon, in the foreground |
| `status` | config, spool and whether the server answers |
| `profiles [--detect [--write]]` | configured profiles; `--detect` proposes them, `--write` stores the proposal |
| `install-service` | writes the systemd user unit and prints how to enable it |
| `version` | prints the version |

`<api-origin>` is the API, not the web app: pairing is `POST <api-origin>/runners/pair`,
the socket `<api-origin>/runner`.

Exit codes: `0` ok, `1` failure, `2` usage, `78` the server closed for good
(protocol mismatch, revoked token, replaced) — the unit does not restart it.

## Files and environment

| What | Where |
|---|---|
| Config (mode 0600) | `$XDG_CONFIG_HOME/agentdock/runner.json`, default `~/.config/agentdock/runner.json` |
| Event spool | `$XDG_STATE_HOME/agentdock/spool/`, default `~/.local/state/agentdock/spool/` |
| Transcript offsets | `$XDG_STATE_HOME/agentdock/offsets.json`: how far each agent transcript was read |
| systemd unit | `$XDG_CONFIG_HOME/systemd/user/agentdock-runner.service` |

| Variable | Effect |
|---|---|
| `AGENTDOCK_LOG` | `debug` \| `info` (default) \| `warn` \| `error`; logs are JSON lines on stderr, the token redacted |
| `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` | where the files above live |
| `CODEX_HOME` | the codex profile `profiles --detect` proposes |

Agent sessions ([spec 12](../../docs/specs/12-agent-sessions.md)) are read from
the transcripts of every profile in the config and sent as metadata only, with
no prompt or tool text. `sessions.enabled` (default `true`) in `runner.json`
turns this off. `sessions.ingestSince`, which `pair` sets, skips transcripts
last modified before it. An admin backfill re-reads older ones.

### OTLP receiver

The daemon listens for OpenTelemetry logs on `127.0.0.1:4318`
([spec 13](../../docs/specs/13-tokens-and-cost.md) D11–D16), so a session with
telemetry on reports each LLM request as it happens, before its transcript is
read. It speaks OTLP/HTTP only (`application/x-protobuf` or
`application/json`, optionally gzip) on `POST /v1/logs`. `/v1/metrics` and
`/v1/traces` are accepted and discarded. Connections from anything but
loopback are refused, and so are bodies over 4 MiB.

Only `claude_code.api_request` records are read. Each one becomes one
`llm.request` carrying model, request id, token counts, duration and the
runtime's own cost. Prompts, tool input and output, responses, email and
account or organization ids are never sent, even with
`OTEL_LOG_USER_PROMPTS=1`.

To point a Claude Code session at it:

```sh
CLAUDE_CODE_ENABLE_TELEMETRY=1 \
OTEL_LOGS_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_RESOURCE_ATTRIBUTES=agentdock.project=<id>,agentdock.slot=<slot>,agentdock.issue=<n>,agentdock.run=<run> \
claude
```

The `agentdock.*` attributes are optional. `agentdock.project` is used only
when it is a project on this runner's watch list. Without them, the request is
matched to its session by `session.id`.

`runner.json` key `otlp`, every field optional:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | start the receiver |
| `http` | `4318` | port; the host is always `127.0.0.1` |
| `codexExperimental` | `false` | also map `codex.*` records, whose attribute names are not verified yet |
| `grpc` | — | reserved; gRPC is not served |

If the port is already taken, the error is logged and the runner keeps running
without the receiver. `runner.describe` then reports `otlp: null`.

## Development

```sh
bun run src/main.ts version        # run from source
bun run test                       # typecheck + bun test (mock server, fake clock)
bun run build                      # dist/agentdock-runner, a single binary
```
