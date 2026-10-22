# nautelle-runner

The per-machine daemon of AgentDock ([ADR-0001](../../docs/adr/0001-control-plane-and-per-machine-runner.md)).
It pairs with the API, connects out over WebSocket, reports the machine's
capabilities and runtime profiles, spools events and answers typed commands
([runner-protocol.md](../../docs/architecture/runner-protocol.md),
[spec #5](../../docs/specs/5-runner-daemon-and-protocol.md)).

## Install

Prebuilt binaries exist for `darwin-arm64`, `darwin-x64`, `linux-x64` and
`linux-arm64` ([ADR-0017](../../docs/adr/0017-runner-distribution-homebrew-and-npm.md)).

**Homebrew** (macOS and Linux):

```sh
brew install andreybegma/tap/nautelle-runner
nautelle-runner pair --server https://<agentdock-host>/api --code XXXX-XXXX
brew services start nautelle-runner
```

**npm** (or `bun add -g nautelle-runner`):

```sh
npm i -g nautelle-runner
nautelle-runner pair --server https://<agentdock-host>/api --code XXXX-XXXX
nautelle-runner install-service
```

`install-service` writes a systemd user unit on Linux and a launchd agent on
macOS, then prints the command that starts it.

**From source** (needs Bun):

```sh
git clone https://github.com/AndreyBegma/Nautelle && cd AgentDock
bun install && bun run build
apps/runner/dist/nautelle-runner version
```

`sh apps/runner/scripts/build-release.sh` builds all four targets, the
tarballs, `SHA256SUMS` and its signature `SHA256SUMS.sig`, the npm packages
and the Homebrew formula into `apps/runner/release/`, and publishes nothing.
Without `RUNNER_SIGNING_KEY` it signs with a throwaway key, so what it builds
does not install ([ADR-0049](../../docs/adr/0049-runner-releases-are-signed-and-cut-only-from-protected-tags.md)). It builds `@nautelle/shared`
first, so it works on a clean checkout. Releasing is in
[deploy/README.md](../../deploy/README.md#releasing-the-runner).

## Update prompt

While a command you type runs (`pair`, `status`, `profiles`, `policy`,
`install-service`, `setup`, `away`, `version`, `help`), the runner asks npm
for the latest `nautelle-runner` and for the platform package
`nautelle-runner-<os>-<arch>`, with a 1.5 s timeout. A version counts only
when both packages have it. When the command has finished and a newer version
is ready, it asks:

```text
Update nautelle-runner 0.14.0 → 0.15.0? [Y/n/never for this version]
```

Enter or `y` runs the global install with the package manager that installed
the runner: `npm install -g`, `bun add -g`, `pnpm add -g` or
`yarn global add` (a runner installed under fnm counts as npm). For a
Homebrew install it prints `brew upgrade nautelle-runner` instead, and for any
other binary, whose manager is unknown, the npm command. A failed install prints the error. Either way, the
exit code is the command's own. After a successful install, when the runner's
systemd unit or launchd agent is installed and active, it says that the daemon
still runs the old version and prints the command that restarts it; it never
restarts the daemon itself. `never` writes the version to
`~/.config/nautelle/update.json` and asks again only for a newer one.

The check never delays the command or changes its output, and it makes no
request at all unless stdin and stdout are both a terminal. It stays silent
under `CI`, in the daemon (`run`), in the MCP server, hooks and the other
commands Claude Code starts, under `npx`, `bunx` and `pnpm dlx`, and with
`NAUTELLE_NO_UPDATE_CHECK=1`.

## Upgrading to 0.13

0.13 adds the runner-local security policy
([ADR-0047](../../docs/adr/0047-a-runner-local-security-policy-the-server-cannot-change.md)).
Its `allowedRoots` is empty by default, so a runner upgraded from 0.12 or
earlier watches **no** project until you allow their folders, on its machine:

```sh
nautelle-runner policy allow-root --watched   # the roots it watched before; asks first, --yes skips it
nautelle-runner policy allow-root ~/dev       # or name the folders yourself
```

A runner started on a `runner.json` with no `policy` block logs and prints a
notice that lists the projects it watched and these commands, on every start
until you set a policy. It never allows them itself, and the server cannot.
The web app shows the same refusal, with the command, on each project. See
[CHANGELOG.md](CHANGELOG.md).

## Commands

| Command | What it does |
|---|---|
| `pair --server <api-origin> --code XXXX-XXXX [--no-detect] [--insecure]` | exchanges a pairing code for a runner id and token; when the config has no profiles yet, also detects and writes them (`--no-detect` skips it, existing profiles are never overwritten) |
| `run` | the daemon, in the foreground |
| `status` | config, spool and whether the server answers |
| `profiles [--detect [--write]]` | configured profiles; `--detect` proposes them, `--write` stores the proposal |
| `policy show\|set\|allow-root\|deny-root\|deny-path\|allow-path` | the runner-local policy ([ADR-0047](../../docs/adr/0047-a-runner-local-security-policy-the-server-cannot-change.md)); `allow-root --watched [--yes]` allows the roots of the cached watch list after asking |
| `install-service` | writes the systemd user unit (Linux) or the launchd agent (macOS) and prints how to start it |
| `mcp` | the `agentdock` MCP server over stdio, for the Claude Code plugin ([spec 201](../../docs/specs/201-claude-code-integration.md) D20); see below |
| `version` | prints the version and the target, e.g. `0.1.0 darwin-arm64` |

### `mcp`

Twelve tools, each one local method of the daemon's socket (spec 201 D7). Claude
shows them as `mcp__plugin_nautelle_nautelle__<tool>`:

| Tool | Local method | Role |
|---|---|---|
| `status` | `fleet.status` | viewer |
| `queue` `{limit?}` | `queue.list` | viewer |
| `budget` | `budget.remaining` | viewer |
| `approvals` | `approvals.list` | viewer |
| `activity` `{limit?}` | `activity.recent` | viewer |
| `sessions` `{limit?}` | `sessions.recent` | viewer |
| `create_issue` `{title, body, labels?, queue}` | `issue.create` | operator |
| `note` `{text}` | `activity.note` | operator |
| `handoff` `{title, body, branch}` | `handoff.create` | operator |
| `request_action` `{kind, args, summary}` | `action.request` | operator |
| `action_status` `{id}` | `action.status` | viewer |
| `away` `{on}` | `away.set` | operator |

The project comes from `CLAUDE_PROJECT_DIR` (else the working directory), the
session from the parent pid. A failure is an MCP tool error whose text starts
with the local error code (`runner_offline`, `no_project`, `daemon_unavailable`,
`forbidden`, …) and whose `structuredContent.error.code` carries it.

`<api-origin>` must be `https://`. Plain `http://` is accepted only for a
loopback host (`localhost`, `127.0.0.0/8`, `::1`). Any other `http://` host is
refused unless `pair --insecure` is given; that sets `insecureServer: true` in
`runner.json` (only `pair` writes it — the server cannot), and `run` and `status`
print a warning on every start, because the token and session content then travel
in cleartext.

`<api-origin>` is the API, not the web app: pairing is `POST <api-origin>/runners/pair`,
the socket `<api-origin>/runner`.

Exit codes: `0` ok, `1` failure, `2` usage, `78` the server closed for good
(protocol mismatch, revoked token, replaced) — the unit does not restart it.
launchd and `brew services` cannot exclude one exit code, so they run the daemon
through a `/bin/sh` wrapper that turns 78 into 0 and restart only an
unsuccessful exit.

## Files and environment

| What | Where |
|---|---|
| Config (mode 0600) | `$XDG_CONFIG_HOME/agentdock/runner.json`, default `~/.config/nautelle/runner.json` |
| Update prompt | `update.json` beside `runner.json`: the version answered "never" |
| Event spool | `$XDG_STATE_HOME/agentdock/spool/`, default `~/.local/state/nautelle/spool/` |
| Transcript offsets | `$XDG_STATE_HOME/agentdock/offsets.json`: how far each agent transcript was read |
| `events.jsonl` offsets | `$XDG_STATE_HOME/agentdock/events-offsets.json`: byte offset and inode per project ([spec 16](../../docs/specs/16-consume-code-sentinel-events.md)); `fleet.eventsPollSeconds` (default 5) in `runner.json` sets the poll fallback |
| Queue poll | `queue.pollSeconds` in `runner.json` (default 60, minimum 15): how often the `issues` collector polls GitHub for a project's open issues ([spec 19](../../docs/specs/19-task-queue.md)) |
| Skill runs | `$XDG_STATE_HOME/agentdock/runs/<runId>/`: `state.json`, `run.json`, `stream.jsonl`, `stderr.log`, `exit.json`, `patch.diff` ([spec 24](../../docs/specs/24-skills.md)) |
| systemd unit (Linux) | `$XDG_CONFIG_HOME/systemd/user/nautelle-runner.service` |
| launchd agent (macOS) | `~/Library/LaunchAgents/com.nautelle.runner.plist`, logging to `~/Library/Logs/nautelle-runner.log`; it keeps the `PATH` `install-service` ran with |
| Homebrew service logs | `$(brew --prefix)/var/log/nautelle-runner.log` |

| Variable | Effect |
|---|---|
| `NAUTELLE_LOG` | `debug` \| `info` (default) \| `warn` \| `error`; logs are JSON lines on stderr, the token redacted |
| `NAUTELLE_NO_UPDATE_CHECK` | `1` turns the [update prompt](#update-prompt) off; `CI` does too |
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

### Skills

The `skill.*` commands ([spec 24](../../docs/specs/24-skills.md)) search the
public catalog at `https://skills.sh`, a host fixed in the runner. They clone
skills only from `https://github.com/<owner>/<repo>.git`, install them by
copying (never `npx`, never a symlink), and run them headless.

- A project install is a pull request on `skills/<name>`, made from a
  temporary worktree. A profile install writes
  `<CLAUDE_CONFIG_DIR>/skills/<name>/` directly.
- A run gets its own worktree `.wt-<repo>-run-<shortid>` and its own tmux
  session `nautelle-run-<shortid>`. The session executes
  `nautelle-runner exec-run <runDir>`, an internal subcommand that spawns the
  profile binary from `run.json` as an argv. The run survives a runner
  restart.
- The runner's own commits skip the project's hooks and carry no trailer.

`runner.json` key `skills`, every field optional:

| Field | Default | Meaning |
|---|---|---|
| `maxConcurrentRuns` | `2` | runs over the cap wait in `queued`, oldest first |
| `maxTimeoutSec` | `21600` | a run's `timeoutSec` above it is cut to it |
| `keepPatchesLocal` | `false` | the patch stays in the run's directory; `skill_run.finished` carries only the changed-file list and the patch's SHA-256. Set by hand — the daemon and the server never change it |

Every text the runner sends the server — pane frames, run logs, reports,
checkpoints, messages, PR bodies, skill-run patches, hook content — passes
one redactor (`src/pane/redact.ts`): token shapes, private-key blocks,
`.env` and secret-named assignments, `Authorization` headers, secret JSON
members and URL userinfo. It is pattern-based and best-effort.

## Development

```sh
bun run src/main.ts version        # run from source
bun run test                       # typecheck + bun test (mock server, fake clock)
bun run build                      # dist/nautelle-runner, a single binary
```
