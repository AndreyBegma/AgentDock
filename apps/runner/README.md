# agentdock-runner

The per-machine daemon of AgentDock ([ADR-0001](../../docs/adr/0001-control-plane-and-per-machine-runner.md)).
It pairs with the API, connects out over WebSocket, reports the machine's
capabilities and runtime profiles, spools events and answers typed commands
([runner-protocol.md](../../docs/architecture/runner-protocol.md),
[spec #5](../../docs/specs/5-runner-daemon-and-protocol.md)).

## Commands

| Command | What it does |
|---|---|
| `pair --server <api-origin> --code XXXX-XXXX` | exchanges a pairing code for a runner id and token |
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
| systemd unit | `$XDG_CONFIG_HOME/systemd/user/agentdock-runner.service` |

| Variable | Effect |
|---|---|
| `AGENTDOCK_LOG` | `debug` \| `info` (default) \| `warn` \| `error`; logs are JSON lines on stderr, the token redacted |
| `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` | where the files above live |
| `CODEX_HOME` | the codex profile `profiles --detect` proposes |

## Development

```sh
bun run src/main.ts version        # run from source
bun run test                       # typecheck + bun test (mock server, fake clock)
bun run build                      # dist/agentdock-runner, a single binary
```
