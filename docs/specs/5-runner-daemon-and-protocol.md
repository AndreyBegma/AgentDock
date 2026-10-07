# Runner daemon and runner protocol

Issue: [#5](https://github.com/AndreyBegma/AgentDock/issues/5) · Roadmap: M1.3 (part a) ·
Decisions: [ADR-0001](../adr/0001-control-plane-and-per-machine-runner.md),
[ADR-0006](../adr/0006-runtime-adapters-and-runtime-profiles.md),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md),
[runner-protocol.md](../architecture/runner-protocol.md)

## Summary

The runner is the only part of AgentDock that touches a machine: it will
observe fleets and execute commands. This item builds its skeleton and the
contract it speaks — the protocol schemas shared with the API, a Bun daemon that
pairs, connects out over WebSocket, announces its capabilities and runtime
profiles, sends heartbeats, spools events, and dispatches typed commands. It
ships no collectors (M1.5) and no server side (#6); it is tested against a mock
server. It runs in parallel with #3.

## Scope

### In scope

- `packages/shared/src/protocol/` — zod schemas and TypeScript types for every
  message, the command allowlist, the event envelope, capabilities, profiles,
  and the pairing HTTP contract; exported as `@agentdock/shared/protocol`.
- `apps/runner` — the daemon: CLI, config, pairing client, WebSocket client
  with reconnect and resume, capability and profile detection, heartbeat, event
  spool, command dispatcher, systemd user unit installer, compiled binary.

### Out of scope

- The API side: pairing endpoint, `/runner` gateway, tables, admin page — #6.
- Collectors (tmux, worktrees, boards, transcripts, OTLP) — M1.5–M1.7.
- Any command beyond `runner.ping` and `runner.describe` — each later item adds
  its own handler to the allowlist.

## Decisions

The person delegated all decisions on 2026-10-07; each below is the default
taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | Runtime: Bun; distributed as one binary via `bun build --compile` (`agentdock-runner`); also runnable with `bun run apps/runner/src/main.ts` in development | overview.md |
| D2 | Protocol schemas are zod, in `packages/shared/src/protocol/`, exported through a `./protocol` subpath in `packages/shared/package.json` (not the root barrel, which #3 owns). Protocol version constant `PROTOCOL_VERSION = 1`; the server may refuse other versions | runner-protocol.md; contention with #3 |
| D3 | Config file `~/.config/agentdock/runner.json` (`$XDG_CONFIG_HOME` honoured), mode 0600: `server`, `runnerId`, `token`, `profiles[]`, `projects[]` (empty for now), `disabledCommands[]`, `otlp` ports (reserved). Written atomically (temp file + rename) | runner-protocol.md |
| D4 | Runtime profiles come from config. When the config has none, `agentdock-runner profiles --detect` proposes: one `claude` profile per directory in `~/.claude-profiles/*` with `CLAUDE_CONFIG_DIR` set, one for the default `~/.claude`, and one `codex` profile for `$CODEX_HOME` (default `~/.codex`) — and writes them only with `--write`. A profile is `authenticated` when `<CLAUDE_CONFIG_DIR>/.credentials.json` is non-empty (claude) or `<CODEX_HOME>/auth.json` exists (codex). Shell functions are never invoked | ADR-0006; the owner's `claude rc` zsh function [Confirmed]; codex auth file [Unknown — verify against installed codex when available] |
| D5 | Capabilities: versions of `tmux`, `git`, `gh` (+ `gh auth status` user), `claude`, `codex` (null when absent), installed code-sentinel version (read from the plugin cache of each claude profile when present, else null), hostname, os, arch. Detection runs each binary with a 5 s timeout and never fails the daemon | runner-protocol.md |
| D6 | Transport: Bun's built-in WebSocket client to `<server>/runner` (`http→ws`, `https→wss`), header `Authorization: Bearer <token>`. Reconnect backoff 1 s doubling to 60 s with ±20 % jitter; reset after 60 s connected | runner-protocol.md |
| D7 | Event spool: append-only JSONL files under `$XDG_STATE_HOME/agentdock/spool/` (default `~/.local/state/agentdock/spool/`), one segment per 10 MB, `seq` monotonic and persisted across restarts; acked segments deleted; total cap 100 MB, oldest dropped with a `runner.spool_truncated` event | runner-protocol.md |
| D8 | Commands: a registry keyed by the allowlist in the protocol; args validated with the same zod schema; unknown or disabled command → `command.result { ok: false, error: { code: "unknown_command" \| "disabled" } }`; handler exceptions → `{ code: "internal", message }` with no stack trace sent. Timeout per command (default 30 s) → `{ code: "timeout" }` | ADR-0010 |
| D9 | Handlers in this item: `runner.ping` → `{ pong, ts }`; `runner.describe` → current capabilities + profiles. Both added to the allowlist table in runner-protocol.md | new |
| D10 | Pairing client: `agentdock-runner pair --server <url> --code <code>` → `POST <server>/api/runners/pair` with `{ code, hostname, version, protocolVersion }` → `{ runnerId, token }`; stores them per D3. The HTTP contract is a zod schema in the protocol package so #6 implements the same shape | runner-protocol.md |
| D11 | CLI commands: `pair`, `run` (foreground daemon), `status` (config, connectivity, spool size), `profiles [--detect] [--write]`, `install-service` (writes `~/.config/systemd/user/agentdock-runner.service` and prints the `systemctl --user enable --now` command — it does not run it), `version` | new |
| D12 | Logging: JSON lines to stderr, level from `AGENTDOCK_LOG` (default `info`); the token is redacted everywhere | security.md |

## Protocol (in `packages/shared/src/protocol/`)

| File | Content |
|---|---|
| `version.ts` | `PROTOCOL_VERSION` |
| `envelope.ts` | event envelope from [event-schema.md](../architecture/event-schema.md) (`v`, `seq`, `ts`, `type`, `source`, `project?`, `slot?`, `issue?`, `session?`, `data`) — `data` is `unknown` for unknown types |
| `messages.ts` | discriminated union on `type`: `hello`, `welcome`, `heartbeat`, `events`, `ack`, `command`, `command.result`, `command.progress`, `subscribe`, `unsubscribe`, `pane` |
| `capabilities.ts` | capabilities and runtime profile schemas |
| `commands.ts` | allowlist: name → args schema, result schema, minimum role (`admin` \| `operator` \| `viewer` as a string union, so the package does not import #3) |
| `pairing.ts` | pairing request / response |
| `index.ts` | re-exports |

## Acceptance criteria

- [ ] `@agentdock/shared/protocol` exports schemas that parse every example message in runner-protocol.md and reject a message with an unknown `type` at the top level.
- [ ] `agentdock-runner pair` against a mock server stores `runnerId` and `token` in a 0600 config file; the token never appears in stdout, stderr or logs (asserted by a test capturing output).
- [ ] `agentdock-runner run` connects to a mock WebSocket server, sends `hello` with protocol version, capabilities and profiles, and sends `heartbeat` every 15 s (test with an injected clock).
- [ ] Killing the mock server and restarting it: the runner reconnects with backoff and, after `welcome`, resends every spooled event with `seq` above the last acked one — no gaps, no duplicates above the ack.
- [ ] Spool survives a daemon restart: `seq` continues from the last value; acked segments are deleted; exceeding the cap drops the oldest segment and emits `runner.spool_truncated`.
- [ ] `command` `runner.ping` returns `ok: true`; an unknown command returns `unknown_command`; a command listed in `disabledCommands` returns `disabled`; invalid args return `invalid_args`; none of them crash the daemon.
- [ ] `profiles --detect` on a machine with `~/.claude-profiles/{a,b}` proposes three claude profiles with the right `CLAUDE_CONFIG_DIR` and correct `authenticated` flags (tested with a temporary HOME).
- [ ] Capability detection with `codex` absent reports `codex: null` and still connects.
- [ ] `bun build --compile` produces a working `agentdock-runner` binary (`version` prints the package version); a `build` script wires it into turbo.
- [ ] `bun run check`, `bun run test`, `bun run build` pass at the root.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i5-protocol | the protocol package | packages/shared/src/protocol/**, packages/shared/package.json, docs/architecture/runner-protocol.md, bun.lock | — | yes | opus |
| i5-daemon | the runner app | apps/runner/**, bun.lock | i5-protocol | no | opus |

i5-daemon is cut after i5-protocol merges (it imports the schemas). The whole
issue runs in parallel with #3.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/shared/src/index.ts | #3 (i3-api) | not touched here — the protocol is a subpath export |
| packages/shared/package.json | i5-protocol | do not open it |
| bun.lock | shared with #3 — see rule below | — |

**bun.lock rule (amends the contention of #3):** a lockfile is regenerated, not
merged. A slot whose branch conflicts on `bun.lock` merges `origin/develop`,
takes the base's `bun.lock`, runs `bun install`, and commits the result. Each
slot changes dependencies only in its own workspace `package.json`.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Protocol designed before the server exists may need changes in #6 | medium | `opus` on the lead; #6 may amend schemas, bumping nothing until a release exists |
| Bun WebSocket client header support differs from Node `ws` | low | if `Authorization` headers are unsupported, send the token as the first message (`auth`) and record that in runner-protocol.md |
| Detecting the code-sentinel version per profile is brittle | low | report `null` rather than guess |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Should the runner support several servers at once? | No — one server per runner config |
| Windows/macOS support? | Linux first; nothing Linux-only except `install-service` |
