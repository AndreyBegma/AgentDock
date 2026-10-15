# Claude Code integration — hooks observe, MCP acts, through the runner

Issue: [#201](https://github.com/AndreyBegma/AgentDock/issues/201) · Roadmap: M3.8 ·
Decisions: [ADR-0020](../adr/0020-claude-code-integration-through-the-runner.md),
[ADR-0021](../adr/0021-session-content-is-opt-in-per-project.md),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md),
[ADR-0003](../adr/0003-usage-from-opentelemetry-transcripts-as-backfill.md),
[runner-protocol.md](../architecture/runner-protocol.md), [spec 12](12-agent-sessions.md),
[spec 29](29-terminal-attach.md)

## Summary

A person who runs `claude` by hand is seen today only through transcript
tailing: late, without live state, and with no way back. This item adds a
Claude Code plugin `agentdock` whose hooks report the session live through the
runner. When the session starts, the plugin injects context from the server.
Its MCP server gives the model tools to:
- read the fleet, the queue and the budget;
- create and queue issues, and hand the work off to the fleet;
- request actions that a person approves in the web app or in Telegram.

When the person turns on "away" mode, a permission prompt goes to the web app and
Telegram instead of sitting in an unattended terminal.

Manual sessions become first-class:
- they have an origin, a live state, an issue and an owner;
- their cost counts toward the owner's budget;
- if the project opted in, their content is visible;
- started through `agentdock-runner claude`, they can be attached from the
  browser.

## Scope

### In scope

- The runner gets:
  - a local unix socket;
  - the `local.request`/`local.response` relay;
  - the subcommands `hook <event>`, `mcp`, `setup claude`, `claude` and `away`;
  - redaction of hook content;
  - OTLP correlation for sessions it did not launch.
- Protocol: the local method allowlist, `hook.*` events with source `hook`,
  `config` fields, and the terminal target `manual`.
- API: the local request router, hook ingest (origin, issue, owner, live state,
  content), content retention and purge, action requests, Telegram buttons, a
  remaining-budget query, and the runner's local user and away flag.
- Plugin: `plugins/agentdock/` and the repository marketplace.
- Web: the session origin badge and filter, the live state, the content
  timeline, the action-request inbox, project content settings, runner settings
  (local user, away), and Attach for manual sessions.

### Out of scope

- Codex (M4).
- Machines without a runner (ADR-0020 §2).
- Content from transcripts or OTel (ADR-0021 §3).
- Changing how orchestrator sessions are inferred.
- Rewriting prompts or tool inputs from hooks. The hooks observe and decide
  permissions, nothing more.

## Decisions

The owner made D1–D4 on 2026-10-14. The rest are defaults derived from the
docs; per the owner's standing autonomy, they are recorded here instead of asked.

| # | Decision | Source |
|---|---|---|
| D1 | **Transport.** The hook and MCP processes run inside the existing binary and talk to the daemon over a unix socket. There is no standalone npm package and no runner-less mode. | owner; ADR-0020 |
| D2 | **Content.** Metadata only by default. An admin can turn content on per project; it is redacted on the runner and kept for a set retention. | owner; ADR-0021 |
| D3 | **MCP permissions.** Reads, plus safe writes: create an issue, queue it, post a note, hand off. Orchestrator start/stop and PR approval exist only as action requests that a person approves. | owner |
| D4 | **Claude only now.** Codex comes in M4. | owner |
| D5 | **Socket.** The path is `$XDG_RUNTIME_DIR/agentdock/runner.sock`. When that variable is unset, it is `<stateDir>/runner.sock`; on macOS the state dir is used, which keeps the path short. The directory is `0700` and the socket `0600`. The daemon unlinks a stale socket after taking `runner.lock`. The framing is newline-delimited JSON, at most 256 KiB per line: `{id, op, args}` → `{id, ok, data?, error?: {code, message}}`. The ops are `event` (fire-and-forget, spooled), `request` (relayed as `local.request`) and `ping`. Peer authentication is file permissions only, which matches the trust model of `runner.json` (0600). | new; lock.ts; config.ts [Confirmed] |
| D6 | **Wire messages.** Runner → server: `local.request {id, method, args, session?: {runtime, id}}`. Server → runner: `local.response {id, ok, data?, error?}`. The server times out at 15 s; the daemon also gives up at 15 s and answers `timeout`. These requests are **not** spooled: when the WSS is down, the daemon answers `runner_offline` at once, so a write is never delayed and replayed later by surprise. Today no runner-initiated request exists [Confirmed — messages.ts]. | ADR-0020 §4 |
| D7 | **Local method allowlist** (`packages/shared/src/protocol/local.ts`). Each method has a zod schema for args and result and a `minRole`. The server resolves `projectId` from the daemon's correlation and never trusts a path.<br>• `viewer`: `context.sessionStart`, `fleet.status`, `queue.list`, `budget.remaining`, `approvals.list`, `activity.recent`, `sessions.recent`, `action.status`.<br>• `operator`: `issue.create {title ≤256, body ≤20 000, labels?, queue}` (reuses `QueueService.createIssue`), `activity.note {text ≤2 000}`, `handoff.create {title, body, branch}`, `action.request {kind, args, summary ≤500}`, `away.set {on}`. | ADR-0010 mirrored |
| D8 | **Authority.** A new column `Runner.localUserId` (FK User, set null on delete) defaults to `createdById`. An admin changes it in the runner settings, audited as `runner.update`. A local request acts as that user with `min(role on project, operator)`. With no local user, every local request returns `forbidden`. Audit: actor `runner{runnerId}`, with `meta.onBehalfOf = localUserId` and `meta.via = mcp\|hook`. The budget gate applies with that user. | ADR-0020 §5; audit.types.ts [Confirmed] |
| D9 | **Project resolution.** The daemon maps the session's `cwd` to a project with the existing `correlateCwd`, using the hook's `cwd` or the MCP process's `CLAUDE_PROJECT_DIR`. A cwd outside every watched root gets `no_project` for project methods, and its hook events are still sent without a project, as transcript events are. | correlate.ts [Confirmed]; MCP env `CLAUDE_PROJECT_DIR` [Confirmed — Claude Code docs] |
| D10 | **Session identity for MCP.** Claude Code passes no session id to MCP processes [Confirmed — docs list none]. On `SessionStart`, the hook sends its ancestor pids, read on Linux from `/proc/<pid>/stat` and on macOS with `ps -o ppid=`. The daemon keeps `claudePid → sessionId`, where `claudePid` is the nearest ancestor whose command is `claude`. The MCP process sends its `ppid`. If nothing matches, the daemon falls back to the single live session with the same cwd; otherwise the call has no session and still works. Whether Claude spawns hooks through a shell, which adds one ancestor, is [Unknown]; the ancestor walk covers both. | new |
| D11 | **Hook events** (source `hook`; envelope `session: {runtime: 'claude', id: session_id}`):<br>• `hook.session_started {source, cwd, gitBranch?, model?, permissionMode, tmuxSession?}`<br>• `hook.prompt_submitted {chars, content?}`<br>• `hook.tool_finished {toolUseId, toolName, ok, durationMs?, input?, output?}`, from `PostToolUse` and `PostToolUseFailure`<br>• `hook.permission_requested {toolName}`<br>• `hook.notification {notificationType}`<br>• `hook.stopped {response?}`<br>• `hook.session_ended {reason}`<br>`content`, `input`, `output` and `response` are `{text, truncated}` and are present only when D13 allows. Hooks never emit `llm.request`, `turn.*` or `tool.call`; transcripts and OTel keep those (ADR-0020 §7). `gitBranch` is read with `git rev-parse --abbrev-ref HEAD` in the cwd, with a 500 ms timeout. | Claude Code hook fields [Confirmed — docs]; ADR-0003 |
| D12 | **Hook declarations** (`plugins/agentdock/hooks/hooks.json`). Each command is `command -v agentdock-runner >/dev/null 2>&1 && agentdock-runner hook <event> \|\| true`, so a machine without the binary shows no hook errors.<br>• `SessionStart`: sync, timeout 10 s. It prints `additionalContext` (D16).<br>• `PermissionRequest`: sync, timeout 300 s (D17).<br>• `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `SessionEnd`: `async: true`.<br>A hook connects to the socket with a 300 ms timeout. When the daemon is down it exits 0, prints nothing, and its event is lost; the transcript backfill still covers usage. | Claude Code hook timeouts and async [Confirmed — docs] |
| D13 | **Content gate.** `WatchedProject` gains `shipContent: boolean` and `awayMode` comes in `config` (D17). The daemon attaches content only when the correlated project has `shipContent`. Redaction is `apps/runner/src/pane/redact.ts` plus private-key blocks and `.env` assignments, applied before the spool. Each text is capped at 16 KiB. Tool `input` is the JSON of `tool_input`; `output` is `tool_response`, stringified. | ADR-0021 §3–4; pane/redact.ts [Confirmed] |
| D14 | **Session fields on ingest.**<br>• `origin`: `worker` when `slotName` is set; `run` when a Run claims the session; else `manual` once any `hook.*` event arrives; else `unknown`.<br>• `issue`: the slot's issue. Otherwise, the branch matching `^[a-z]+/(\d+)-` (repo convention, for example `feat/184-grill-rounds`) gives the issue number.<br>• `ownerId`: `runner.localUserId` for `manual`.<br>• `liveState`: started → `idle`, prompt → `working`, permission → `waiting`, stopped → `idle`, ended → `ended`, which also sets `endedAt`.<br>• `tmuxSession` comes from D11.<br>A hook event that arrives before the first transcript line creates the session row (`parsed: false`); the transcript later fills the rest. Uniqueness stays `[runnerId, runtime, externalId]`. | sessions-ingest.service.ts [Confirmed]; branch names in git log [Confirmed] |
| D15 | **Budget.** `budget-spend.ts` user scope also sums sessions whose `ownerId` is the user. `BudgetsService.remaining({projectId, userId})` returns `[{scope, period, limitUsd, spentUsd, remainingUsd, action}]` for the enabled budgets, built on `BudgetEvaluator`. | budget-spend.ts:34, budget-evaluator.ts [Confirmed] |
| D16 | **Session-start context.** `context.sessionStart` returns at most 2 000 characters of plain text:<br>• the project name and base branch;<br>• the session's issue title and state (D14);<br>• remaining budget (D15);<br>• the counts of live slots, queued `cs:ready` issues and pending approvals;<br>• whether away mode is on;<br>• one line on the `agentdock` MCP tools.<br>With no project it returns nothing, and the hook prints nothing. | new |
| D17 | **Away mode and remote permission.** `Runner.awayMode` (bool, default false) is set from the web app (operator, owner of the runner's local user, or admin), with `agentdock-runner away on\|off`, or with the `away` MCP tool. It is pushed to the daemon in `config`.<br>When it is off, the `PermissionRequest` hook returns no decision at once, and the local dialog shows as today.<br>When it is on, the daemon sends `action.request {kind: 'tool_use', args: {toolName, input?}}`. `input` is the redacted tool input, ≤ 500 characters, present only if the project ships content; otherwise only the tool name. It polls `action.status` every 2 s for up to 280 s and maps:<br>• approved → `allow`;<br>• denied → `deny` with the approver's note;<br>• expired or offline → no decision, so the local dialog shows.<br>The exact `PermissionRequest` output shape is [Unknown]; the slot verifies it against the Claude Code docs and pins it in a fixture test. | owner (remote approval); hooks docs list `PermissionRequest` [Confirmed], output schema [Unknown] |
| D18 | **Action requests.** The table `action_requests`, with these kinds:<br>• `tool_use` — the decision is returned and nothing is executed;<br>• `orchestrator_start`, `orchestrator_stop` — executed through `ControlService` as the **approver**, so the budget gate and audit apply to them;<br>• `pr_approve` — executed through `ApprovalsService.decide` as the approver.<br>Status: `pending → approved \| denied \| expired`, then `approved → executed \| failed`, with `result`.<br>• `expiresAt` is 5 min for `tool_use` and 24 h for the others. A BullMQ job expires rows every minute.<br>• Deciding needs `operator` on the project, and the requester cannot approve their own non-`tool_use` request unless they are an admin.<br>• Audit actions: `action_request.created`, `.decided`, `.executed`.<br>• A new notification kind `action.requested` gets Telegram inline buttons. The callback is `x\|y:<notifId>:<actionRequestId>`, and the handler re-checks the chat link and the role, as for `pr.awaiting_approval`. | approvals + telegram flow [Confirmed] |
| D19 | **Handoff.** `handoff.create` creates an issue with `queue: true`. Its body is the given body followed by a fixed footer: the source branch, the session id, and "continue from branch `<branch>` if it exists". It also records a `manual.handoff` server event. The orchestrator then picks the issue up as usual (ADR-0004). | ADR-0004; ADR-0005 |
| D20 | **MCP server.** `agentdock-runner mcp` speaks MCP over stdio using `@modelcontextprotocol/sdk`, pinned exactly in `apps/runner/package.json`. The slot picks the newest version that is at least two weeks old [Unknown — not yet in the repo]. Tools map 1:1 to D7: `status`, `queue`, `budget`, `approvals`, `activity`, `sessions`, `create_issue`, `note`, `handoff`, `request_action`, `action_status`, `away`. The plugin server is named `agentdock`, so Claude shows them as `mcp__plugin_agentdock_agentdock__<tool>` [Confirmed — docs]. Errors are MCP tool errors carrying the local error code. | ADR-0020 §1 |
| D21 | **`agentdock-runner setup claude [--profile <key>] [--no-telemetry] [--dry-run] [--uninstall]`.** For each Claude profile in `config.profiles`, with `CLAUDE_CONFIG_DIR` set:<br>1. Runs `claude plugin marketplace add AndreyBegma/AgentDock` and `claude plugin install agentdock@agentdock --scope user`.<br>2. Unless `--no-telemetry`, merges into `<config dir>/settings.json` → `env`: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, and `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<otlp.http>`. It never writes `OTEL_RESOURCE_ATTRIBUTES` (the runner sets that per managed launch) or `OTEL_LOG_*`. User scope is required because Claude Code ignores exporter variables in repository settings [Confirmed — docs]. It writes a `.bak` first, prints the diff, and is idempotent.<br>`--uninstall` reverses both steps. | ADR-0003; launch.ts env [Confirmed] |
| D22 | **OTLP for sessions the runner did not launch.** When a record has no `agentdock.project`, the receiver looks up `session.id` in the daemon's hook session map (D10) and correlates its cwd (D9). Whether the API double-counts a request that arrives from both OTel and the transcript is [Unknown]; acceptance criterion 9 pins it. | otlp/map.ts [Confirmed] |
| D23 | **`agentdock-runner claude [-- <args>]`.** If stdin is a TTY and `tmux` exists, it creates `tmux new-session -d -s agentdock-manual-<8 hex> -c <cwd> -e AGENTDOCK_TMUX_SESSION=<name> claude <args>` and attaches to it. Otherwise it execs `claude <args>` directly. The `SessionStart` hook reports `tmuxSession` from `AGENTDOCK_TMUX_SESSION`. Terminal attach (spec 29) gains the target `{kind: 'manual', sessionId}`; the runner resolves it only to an `agentdock-manual-*` session it knows from D10. Admin only, as spec 29 D1. | spec 29 D1–D2 |

## Data / Schema

Migration `apps/api/prisma/migrations/20261110000000_claude_code_integration/`.

```prisma
enum SessionOrigin { unknown worker run manual }
enum SessionLiveState { idle working waiting ended }
enum SessionContentKind { prompt response tool_input tool_output }
enum ActionRequestKind { tool_use orchestrator_start orchestrator_stop pr_approve }
enum ActionRequestStatus { pending approved denied expired executed failed }

// AgentSession (sessions) — new columns
origin       SessionOrigin     @default(unknown)
issue        Int?
ownerId      String?           // FK User, onDelete SetNull
liveState    SessionLiveState?
tmuxSession  String?
@@index([projectId, origin, lastEventAt])

// Runner — new columns
localUserId  String?           // FK User, onDelete SetNull; backfilled from createdById
awayMode     Boolean           @default(false)

// Project — new columns
shipSessionContent          Boolean @default(false)
sessionContentRetentionDays Int     @default(30)   // 1–365, DTO-validated

model SessionContent {          // session_contents
  id        BigInt   @id @default(autoincrement())
  sessionId String   // FK AgentSession, onDelete Cascade
  projectId String   // FK Project, onDelete Cascade
  kind      SessionContentKind
  toolUseId String?
  toolName  String?
  at        DateTime
  text      String
  truncated Boolean  @default(false)
  createdAt DateTime @default(now())
  @@index([sessionId, at])
  @@index([projectId, createdAt])
}

model ActionRequest {           // action_requests
  id            String   @id @default(cuid())
  projectId     String   // FK Project, onDelete Cascade
  runnerId      String   // FK Runner, onDelete Cascade
  sessionId     String?  // FK AgentSession, onDelete SetNull
  requestedById String?  // the runner's local user
  kind          ActionRequestKind
  summary       String
  args          Json
  status        ActionRequestStatus @default(pending)
  decidedById   String?
  decidedAt     DateTime?
  note          String?
  result        Json?
  expiresAt     DateTime
  createdAt     DateTime @default(now())
  @@index([projectId, status, createdAt])
  @@index([status, expiresAt])
}
```

`User`, `Runner`, `Project` and `AgentSession` ids are `String @default(cuid())`
[Confirmed — schema.prisma], so every FK column above is `String`.

## API

- **Runner gateway:** `local.request` → `LocalRequestRouter`:
  1. parse it against the allowlist;
  2. resolve the local user and project role (D8);
  3. call the domain service;
  4. send `local.response`.

  An unknown method, bad args or too low a role returns a typed error and is
  audited as `local.request` with result `denied`.
- **Session sink:** consumes `hook.*` (D14); writes `SessionContent` rows only
  when the project flag is on **at ingest time**, and drops content otherwise.
- **`GET projects/:projectId/sessions/:id/content?cursor`:** operator on the
  project. It returns 404 for non-members and 403 for viewers.
- **`DELETE projects/:projectId/session-content`:** admin purge, audited as
  `session_content.purged`.
- **`PATCH projects/:projectId`:** gains `shipSessionContent` and
  `sessionContentRetentionDays`.
- **`PATCH runners/:id`:** gains `localUserId` (admin) and `awayMode` (admin, or
  the local user themself).
- **Action requests:**
  - `GET projects/:projectId/action-requests?status` — viewer;
  - `POST projects/:projectId/action-requests/:id/approve|deny {note?}` — operator.

  Live events go out on `/live`, and the web shows them without a reload.
- **Jobs on BullMQ:** `session-content-retention`, daily at 03:30; and
  `action-request-expiry`, every minute.

## UI

All UI uses glass-ui (ADR-0011).

- **Sessions list:** an origin badge (`manual`, `worker`, `run`) and an origin
  filter. A live-state dot shows on manual sessions.
- **Session detail:**
  - the issue link and the owner;
  - a content timeline (prompt, tool in/out, response), shown only to operators
    when content exists;
  - an "Attach" button when `tmuxSession` is set (admin).
- **Approvals page:** a second tab, "Action requests", listing pending rows with
  approve and deny. A `tool_use` row shows the tool name and the redacted input,
  if any, plus a countdown to `expiresAt`.
- **Project settings → Sessions:** a content toggle with a plain warning that
  redaction is pattern-based, a retention field, and "Purge content".
- **Runner settings:** a local user selector (admin) and an away toggle.

## Configuration

- `runner.json` stays unchanged. The socket path is derived (D5).
- `apps/api/.env.example` stays unchanged.

## Acceptance criteria

- [ ] 1. **Socket.** With the daemon running, `agentdock-runner hook session-start < fixture.json` prints `additionalContext` JSON for a session in a watched project. With the daemon stopped, it exits 0 within 1 s and prints nothing. The socket file is `0600` and its directory `0700`.
- [ ] 2. **Hook events.** A fixture sequence of hook payloads produces `hook.*` events with source `hook` in the spool. With `shipContent: false` no event carries `content`/`input`/`output`/`response`; with `true` a planted `ghp_…` token and a `-----BEGIN PRIVATE KEY-----` block arrive redacted, and a 20 KiB prompt arrives as 16 KiB with `truncated: true`.
- [ ] 3. **Origin and state.** After hook ingest, a manual session in a watched project shows `origin = manual`, `issue = 184` for branch `feat/184-x`, `ownerId = runner.localUserId`, and `liveState` following started → working → idle → ended, with `endedAt` set. A slot session that also fires hooks stays `origin = worker`.
- [ ] 4. **Local allowlist.** A `local.request` with an unknown method, extra args or a non-member local user returns `invalid_args`/`unknown_method`/`forbidden` and writes a `denied` audit row. A viewer local user calling `issue.create` gets `forbidden`. An operator's local role is never raised above operator even for an admin user (D8).
- [ ] 5. **Authorization — content.** `GET …/sessions/:id/content` returns 404 to a user who is not a member of the project, 403 to a viewer member, and only that project's rows to an operator. A session of project B is never returned through project A's route.
- [ ] 6. **Authorization — action requests.** A user without operator on the project cannot approve or deny (403). The requester cannot approve their own `orchestrator_start` unless admin. Approving executes as the approver: the audit row's actor is the approver, and a hard-stop budget refuses it.
- [ ] 7. **Away mode.** With `awayMode` on, a `PermissionRequest` fixture creates a `tool_use` action request. Approving it in the API within 280 s makes the hook print an allow decision; denying makes it print deny with the note; letting it expire makes it print nothing. With `awayMode` off, the hook prints nothing within 1 s and creates no row. A Telegram callback `x:<notif>:<id>` from a linked operator approves it; from an unlinked chat it is refused and audited.
- [ ] 8. **MCP.** `agentdock-runner mcp` answers `tools/list` with the twelve tools of D20. `create_issue` with `queue: true` results in the runner command `issue.create` with `queue: true`. Every tool returns `runner_offline` when the WSS is down and `no_project` outside watched roots.
- [ ] 9. **No double counting.** A request seen both through OTel (manual session, D22) and the transcript is stored once in `llm_requests`; total cost for the session equals the transcript-only total within 0.1 %.
- [ ] 10. **Setup.** `setup claude --dry-run` prints the plugin commands and the settings diff without writing. A real run is idempotent: run twice, one `.bak`, the same `settings.json`. It never writes `OTEL_RESOURCE_ATTRIBUTES` or `OTEL_LOG_*`. `--uninstall` restores the earlier `env`.
- [ ] 11. **Retention.** Content rows older than the project's retention are deleted by the job. Turning the flag off stops new rows but keeps old ones until retention. Purge deletes all of the project's rows and writes `session_content.purged`.
- [ ] 12. **Budget.** `budget.remaining` returns the enabled budgets with `remainingUsd = limitUsd − spentUsd`. A user-scope budget includes the cost of manual sessions owned by that user.
- [ ] 13. **Attach.** `agentdock-runner claude` in a TTY with tmux creates `agentdock-manual-<hex>`. The session row gets `tmuxSession`, and an admin can attach to it (read-only first, per spec 29 D4). A non-admin gets 403. The runner refuses a `manual` target whose tmux name it did not record.
- [ ] 14. **Plugin.** `claude plugin install agentdock@agentdock` from the repository marketplace succeeds. `hooks.json` validates against the documented shape; on a machine without `agentdock-runner` on PATH, a session runs with no hook error lines.

## Parallel plan

Three waves; a wave starts when everything it depends on has merged.

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i201-protocol | every shared schema and the protocol docs | packages/shared/src/**, docs/architecture/runner-protocol.md, docs/architecture/event-schema.md | — | yes | opus |
| i201-schema | Prisma schema and the migration | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261110000000_claude_code_integration/** | — | no | opus |
| i201-plugin | the Claude Code plugin and the marketplace | plugins/agentdock/**, .claude-plugin/** | — | no | sonnet |
| i201-runner-local | socket, relay, hook/setup/away subcommands, stubs for `mcp` and `claude`, content redaction, OTLP correlation | apps/runner/src/local/**, apps/runner/src/hooks/**, apps/runner/src/setup/**, apps/runner/src/mcp/index.ts, apps/runner/src/claude/index.ts, apps/runner/src/otlp/**, apps/runner/src/cli.ts, apps/runner/src/main.ts, apps/runner/src/daemon.ts, apps/runner/src/connection.ts, apps/runner/src/projects/** | i201-protocol | no | opus |
| i201-api-sessions | hook ingest, origin/issue/owner/live state, content storage, retention job, content and purge endpoints, project settings fields | apps/api/src/sessions/**, apps/api/src/projects/** | i201-protocol, i201-schema | no | sonnet |
| i201-api-local | local request router, action requests, expiry job, Telegram buttons, remaining budget, runner local user / away, module wiring | apps/api/src/runners/**, apps/api/src/local/**, apps/api/src/telegram/**, apps/api/src/budgets/**, apps/api/src/notifications/**, apps/api/src/app.module.ts | i201-protocol, i201-schema | no | opus |
| i201-runner-mcp | the MCP server | apps/runner/src/mcp/**, apps/runner/package.json, bun.lock | i201-runner-local, i201-api-local | no | sonnet |
| i201-manual-attach | `agentdock-runner claude` and the `manual` terminal target | apps/runner/src/claude/**, apps/runner/src/terminal/**, apps/api/src/terminal/** | i201-runner-local, i201-api-sessions | no | sonnet |
| i201-web | all web changes | apps/web/** | i201-api-sessions, i201-api-local | no | sonnet |

Waves:
- **Wave 1:** `protocol` (lead), `schema` and `plugin`.
- **Wave 2:** `runner-local`, `api-sessions` and `api-local`.
- **Wave 3:** `runner-mcp`, `manual-attach` and `web`.

`runner-local` creates `mcp/index.ts` and `claude/index.ts` as stubs that throw
`not_implemented`, wired into `cli.ts`. That way the wave-3 slots own those
directories and never touch `cli.ts`.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/shared/src/** (protocol, audit actions, notification kinds, activity rules) | i201-protocol | import only |
| apps/api/prisma/schema.prisma, migration `20261110000000_claude_code_integration` | i201-schema | do not open; no other migration in this issue |
| apps/runner/src/cli.ts, main.ts, daemon.ts, connection.ts | i201-runner-local | wave 3 implements the stubs only |
| apps/api/src/app.module.ts | i201-api-local | `api-sessions` adds no module; content lives inside `sessions/` |
| apps/runner/package.json, bun.lock | i201-runner-mcp | no other dependency changes |
| docs/architecture/runner-protocol.md, event-schema.md | i201-protocol | — |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Each hook spawns the 70–85 MB Bun binary, adding latency | medium | Only `SessionStart` and `PermissionRequest` are sync. Measure cold start in the `runner-local` PR. If it exceeds 150 ms, a follow-up issue adds a small shell client for async hooks |
| The `PermissionRequest` output schema differs from `PreToolUse` | medium | D17 marks it [Unknown]; `runner-local` is `opus` and pins a fixture test |
| Redaction misses a secret and it lands in PostgreSQL | high | Opt-in per project; operator-only reads; retention; purge; plain warning in the UI (ADR-0021) |
| The pid ancestry walk fails on some shells or macOS versions | low | Cwd fallback (D10); MCP calls work without a session |
| Settings `env` written by `setup` collides with the env of managed launches | low | `setup` writes only exporter keys whose values match the runner's own; never resource attributes |
| OTel and transcript both deliver one request | medium | Acceptance criterion 9; if the API does not dedupe today, `api-sessions` adds a dedupe on `(sessionId, requestId)` |
| Someone approves their own orchestrator start remotely | low | Self-approval refused except for admins (D18) |

## Open questions

| Question | Default |
|---|---|
| Should away mode turn on automatically when the terminal goes idle for N minutes? | No; manual toggle only. A follow-up can add it |
| Should content be searchable (full-text)? | Not in this issue; a GIN index can come later |
| Should the plugin also ship `/agentdock:handoff` and `/agentdock:away` slash commands? | Yes, as thin wrappers over the MCP tools, inside `plugins/agentdock/commands/` (owned by `i201-plugin`) |
