# Interactive terminal attach (admin, audited)

Issue: [#29](https://github.com/AndreyBegma/AgentDock/issues/29) · Roadmap: M3.6 ·
Decisions: [ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md),
[ADR-0008](../adr/0008-local-accounts-with-admin-approved-registration.md),
[runner-protocol.md](../architecture/runner-protocol.md) (`terminal.attach`), [security.md](../architecture/security.md) (terminal attach)

## Summary

#18 lets members watch a worker. Sometimes a person has to type in that pane:
- a launch dialog sits on it (`PROMPT`);
- a permission prompt cannot be routed (orchestrator Phase 7);
- an agent is stuck.

Today that means SSH plus `tmux attach`. This item lets an **admin** attach to
three kinds of session from the browser, through a PTY that the runner spawns:
- a slot session `cs-<slot>`;
- the project's orchestrator session (#17);
- a skill-run session (#24).

Every attach is audited, with start, end, duration and byte counts. Nothing is
recorded. Read-only watching stays #18 and is available to every member.

## Scope

### In scope

- Runner: PTY spawn of `tmux attach-session` for an allowed target, a byte stream both ways, resize, detach, idle and maximum-duration limits.
- Protocol: the `terminal.attach` command (admin) and the streaming messages `terminal.data`, `terminal.resize` and `terminal.close`.
- API: one-time attach tickets, a dedicated WebSocket `/terminal`, relay, audit.
- Web: an **Attach** action in the slot sheet, the orchestrator card and the run detail, opening a full-screen terminal sheet.

### Out of scope

- Arbitrary shells or commands. Only the three tmux targets above, resolved by the runner (ADR-0010).
- Session recording (open question; off).
- Operators or viewers attaching. They have #18's read-only pane.
- Creating or killing sessions. Detaching never kills the target session.

## Decisions

The person delegated all decisions on 2026-10-07. Each row below is the default
taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | **Admin only.** `terminal.attach` has minimum role `admin` in the allowlist (already listed in runner-protocol.md). The API checks it again, and the user must also be able to see the project (admins see all, #10). There is no operator variant: operators keep the read-only pane (#18). | ADR-0010; runner-protocol.md; security.md |
| D2 | **Targets.** The request names `{ kind, projectId, slot? \| runId? }`, and the runner resolves the tmux session name itself:<br>• `slot` resolves to `cs-<slot>`, but only if `.wt-<repo>-<slot>` belongs to that project (#10 D10);<br>• `orchestrator` resolves to the project's `orchestratorSession` (#17 D1);<br>• `skill_run` resolves to `agentdock-run-<shortid>` of a live run of that project (#24 D7).<br>A missing session returns `not_found`. The client never sends a session name. | ADR-0010 |
| D3 | **PTY.** The runner spawns `tmux attach-session -t <name>` as an argv, with `Bun.spawn({ terminal: { cols, rows, name: "xterm-256color", data } })`. This PTY API needs Bun ≥ 1.3.5 and runs on POSIX only. The runner checks its Bun version and reports `terminal: false` in capabilities when the API is missing. | Bun `SpawnOptions.terminal`, v1.3.5 release notes [Confirmed — docs]; runner built with Bun 1.4 [Confirmed] |
| D4 | **Read-only by default.** An attach opens with `tmux attach-session -r -f ignore-size`: read-only, and the agent's window size is left alone. The admin must click **Take control** to reopen it read-write, with the plain `attach-session` (which resizes the window to the admin's terminal). Taking control is a second, separately audited attach. | tmux `attach-session -r`, client flag `ignore-size` (tmux ≥ 3.2) [Confirmed — man page]; plugin prerequisite tmux ≥ 3.2 |
| D5 | **Transport.** The browser uses a dedicated WebSocket at `/terminal` on the API port, not `/live`. Traffic is bidirectional and binary-heavy, and its auth differs. Opening it takes three steps:<br>1. `POST /terminal/tickets { kind, projectId, slot?, runId?, mode }` returns a ticket: 32 random bytes, single use, valid 30 s, bound to user, target, mode and session id. The request needs a session cookie and CSRF (#3 D7).<br>2. The WebSocket upgrade must carry `?ticket=…`; its `Origin` must equal `WEB_URL`; the session cookie must be valid and belong to the same user.<br>3. The ticket is consumed. | security.md; #3 D5/D7; #9 D-origin check |
| D6 | **Frames.**<br>• Browser ↔ API: binary WS frames for data, and JSON text frames `{ type: "resize", cols, rows }` / `{ type: "close" }`.<br>• API ↔ runner: messages `terminal.data { id, b64 }` (≤ 64 KiB decoded, both directions), `terminal.resize { id, cols, rows }`, `terminal.close { id, reason }`.<br>• In read-only mode the runner drops all input bytes. The API drops them too, so there is defence in depth. | runner-protocol.md message style |
| D7 | **Limits.**<br>• Idle timeout: 15 minutes without input bytes in read-write mode, or without any traffic in read-only mode.<br>• Maximum attach: 4 hours.<br>• At most 2 concurrent attaches per runner and 1 read-write attach per target. A second read-write attempt returns `busy` and names the admin who holds it.<br>• When the WS or runner socket drops, the runner kills the `tmux attach` client process with SIGHUP; the target session is never killed. | new |
| D8 | **Audit, no recording.** Audit actions are `terminal.attached` (target, mode, ticket id) and `terminal.detached` (reason, durationMs, bytesIn, bytesOut). Input and output bytes are never stored. When nobody is attached, input keystrokes never appear in logs; while attached, the runner logs only byte counts. | security.md ("every attach audited with duration"); #8 |
| D9 | **No table.** Live attaches are kept in memory on the API (to enforce D7 and to show "attached by …" in the UI). History comes from audit. | ADR-0007 (no table without a query need) |
| D10 | **Disabling.** The runner's `disabledCommands` may list `terminal.attach`. The machine then refuses attaches, and the UI hides the action, because capabilities report `terminal: false`. | #5 D3 |
| D11 | Slot session names: the runner accepts both `cs-<slot>` (current) and `cs-<prefix>--<slot>` (code-sentinel P11, [plugin#11](https://github.com/AndreyBegma/claude-code-plugin/issues/11)), parsing them in one shared helper `apps/runner/src/fleet/session-name.ts` owned by #11 (import it); a session belongs to a project only when its worktree path does. Other issues import the helper, never re-parse | #11 D12, plugin#11 |

## Data / Schema

None. No migration.

## Protocol

New file `packages/shared/src/protocol/terminal.ts`; the `terminal.*` message types are appended to the `messages.ts` union; `commands/terminal.ts` defines the `terminal.attach` contract; there is one registration line in `commands.ts` and one export line in `index.ts`.

| Direction | Type | Payload |
|---|---|---|
| S → R | `command` `terminal.attach` | `{ id, target: { kind: "slot" \| "orchestrator" \| "skill_run", projectId, root, slot?, runId? }, mode: "read" \| "write", cols, rows }` → result `{ attached: true, session }` or error `not_found` \| `busy` \| `unsupported` \| `disabled` |
| S ↔ R | `terminal.data` | `{ id, b64 }` |
| S → R | `terminal.resize` | `{ id, cols, rows }` |
| S ↔ R | `terminal.close` | `{ id, reason: "client" \| "idle" \| "max_duration" \| "session_ended" \| "socket" }` |

Capabilities (#5 D5) gain `terminal: boolean`.

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| POST | `/terminal/tickets` | admin | D5 → `{ ticket, expiresAt }` |
| GET | `/terminal/active?projectId=` | admin | current attaches (in memory): target, mode, admin, since |
| WS | `/terminal?ticket=` | admin with a matching session cookie | D5–D7 |

## UI

- An **Attach** button, admin only and hidden when the runner reports `terminal: false`, appears in three places:
  - the slot sheet (#11/#17);
  - the orchestrator card (#17);
  - the skill-run detail (#24).
- The button opens a full-screen glass-ui `SheetRoot`. Inside, the terminal is glass-ui `Terminal` from [AndreyBegma/glass-ui#74](https://github.com/AndreyBegma/glass-ui/issues/74) when released; until then it is `@xterm/xterm` with the fit addon, themed with token values read from CSS variables. The sheet contains:
  - a header with the target, a mode chip (`read-only` / `in control`) and a **Take control** / **Release** toggle;
  - a danger `Banner` while in control: "Your keystrokes go to a live agent session";
  - **Detach**.
- When another admin holds control, the button reads "Attached by <name>" and only read-only attach is allowed.

## Configuration

| Key | Where | Meaning |
|---|---|---|
| `terminal.idleTimeoutSec` / `terminal.maxDurationSec` | API env (`TERMINAL_IDLE_TIMEOUT_SEC`, `TERMINAL_MAX_DURATION_SEC`) | 900 / 14400 |
| `terminal.maxAttachesPerRunner` | runner config | 2 |
| `disabledCommands: ["terminal.attach"]` | runner config | refuse on this machine |

## Acceptance criteria

- [ ] With a fixture tmux session `cs-i42`, a read-only attach streams the pane to the browser, and typed characters do not reach the session (asserted with `tmux capture-pane` showing no input).
- [ ] **Take control** opens a read-write attach. A typed command appears in the session, and the audit trail shows two attaches with their modes.
- [ ] Closing the sheet, closing the browser tab or killing the API ends the `tmux attach` client within 5 s, and `cs-i42` keeps running.
- [ ] The session is never killed by any terminal path (asserted with `tmux has-session` after every close reason).
- [ ] A read-write attach idle for longer than the configured timeout (shortened in tests) closes with `idle`. The maximum duration closes with `max_duration`.
- [ ] A second read-write attach to the same target returns `busy`. The third attach on a runner (cap 2) returns `busy`.
- [ ] A ticket is single use and expires after 30 s. An upgrade with a reused or expired ticket, a ticket from another user, or a foreign `Origin` is refused.
- [ ] Targets are resolved only by the runner. A request naming a slot of project B under project A's id returns `not_found`. No message lets the client pass a raw session name or a command.
- [ ] `terminal.detached` audit records carry duration and byte counts. No terminal bytes are found in `events`, `audit_records` or API logs.
- [ ] A runner listing `terminal.attach` in `disabledCommands` refuses with `disabled`, and its capabilities report `terminal: false`.
- [ ] **Authorization:**
  - an operator and a viewer get 403 on `POST /terminal/tickets` and `GET /terminal/active`;
  - an anonymous upgrade to `/terminal` is refused;
  - a non-member of the project is refused (admins are members of all projects by role).
- [ ] `bun run check`, `bun run test`, `bun run build` pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i29-protocol | terminal messages and command contract, runner-protocol.md rows | packages/shared/src/protocol/terminal.ts, packages/shared/src/protocol/commands/terminal.ts, packages/shared/src/protocol/messages.ts, packages/shared/src/protocol/commands.ts, packages/shared/src/protocol/index.ts, packages/shared/src/protocol/capabilities.ts, docs/architecture/runner-protocol.md | — | yes | opus |
| i29-runner | PTY attach, target resolution, limits | apps/runner/src/terminal/**, the runner command handler registry and message dispatcher from #5 | i29-protocol | no | opus |
| i29-api | tickets, `/terminal` gateway, relay, audit actions | apps/api/src/terminal/**, apps/api/src/app.module.ts, apps/api/.env.example, packages/shared/src/audit/actions.ts | i29-protocol | no | opus |
| i29-web | terminal sheet and Attach actions | apps/web/src/components/terminal/**, apps/web/src/app/(app)/projects/[projectId]/fleet/**, apps/web/src/app/(app)/projects/[projectId]/skills/runs/**, apps/web/package.json, bun.lock | i29-api | no | sonnet |

i29-runner and i29-api run in parallel after the protocol lead merges.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/shared/src/protocol/messages.ts, commands.ts, index.ts, capabilities.ts | i29-protocol | append-only unions and registries; keep both on conflict |
| runner command handler registry and message dispatcher (#5) | i29-runner | append-only; keep both |
| apps/api/src/app.module.ts | i29-api | append-only; keep both imports |
| packages/shared/src/audit/actions.ts | i29-api | append-only union from #8; keep both |
| apps/web/src/app/(app)/projects/[projectId]/fleet/** | i29-web | also edited by #16, #17, #18 web slots; one open PR at a time (the orchestrator's Phase 2 holds the others as `BLOCKED — work`) |
| apps/web/src/app/(app)/projects/[projectId]/skills/runs/** | i29-web | owned by #24's i24-web; i29-web adds only the Attach action, after #24 merges, or skips it if #24 has not merged (then a follow-up) |
| bun.lock | regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) | — |

The following registries are shared across issues and append-only (keep both on conflict):
- `apps/api/src/app.module.ts`
- `packages/shared/src/protocol/commands.ts` + `commands/<area>.ts`
- `packages/shared/src/protocol/index.ts`
- the runner command handler registry
- `apps/runner/src/collectors/index.ts`
- `apps/web/src/components/shell/nav.ts`
- `packages/shared/src/audit/actions.ts`

`apps/api/prisma/schema.prisma` is not touched. Non-member responses are 404 per #10 D12.

Cross-repository: this item prefers glass-ui `Terminal` from AndreyBegma/glass-ui#74, but it is not a blocking dependency.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| A stolen admin session becomes keystrokes into a `bypassPermissions` agent | high | admin only; one-time ticket + Origin check + cookie; read-only by default; take-control audited; runner-local disable |
| Read-write attach resizes the agent's window, breaking pane parsing (#11) | low | read-only uses `ignore-size`; resize only while in control |
| Bun PTY API differs between versions | medium | capability check (D3); a test of attach on the runner's Bun version |
| Secrets appear on screen | medium | admin only; nothing recorded or logged (D8) |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Record sessions (encrypted) for later review? | No — off, not built in this item |
| Allow operators read-write on their own projects? | No — ADR-0010 keeps it admin-only |

## Notes

### From i29-protocol

- **Where the schemas are.** The three stream messages, the browser text
  frames (`terminalClientFrameSchema`) and the D5–D7 numbers are in
  `packages/shared/src/protocol/terminal.ts`. The command, its target union
  and `terminalCommands` are in `commands/terminal.ts`. Import the constants
  (`TERMINAL_TICKET_TTL_MS`, `TERMINAL_IDLE_TIMEOUT_SEC_DEFAULT`,
  `TERMINAL_MAX_DURATION_SEC_DEFAULT`, `TERMINAL_MAX_ATTACHES_PER_RUNNER`,
  `TERMINAL_MAX_DATA_BYTES`, `TERMINAL_WS_PATH`, `TERMINAL_COLS`,
  `TERMINAL_ROWS`) rather than repeating the numbers.
- **`terminal.attach` is not in the `commands` map.** It is exported as
  `terminalCommands`. The runner's `CommandHandlers`
  (`apps/runner/src/commands/dispatcher.ts`) requires a handler for every key
  of `commands`, so a map entry without its handler breaks the runner build
  (#12's trap). i29-runner adds `...terminalCommands` to `commands` in
  `commands.ts` together with the handler.
- **`id` in the args is the stream id.** The server picks it per attach
  (`[A-Za-z0-9_-]{1,128}`), and every `terminal.data`, `terminal.resize` and
  `terminal.close` of that attach carries it. It is not the `command` message
  id, which the `command.result` echoes as usual.
- **`target` is a union on `kind`.** `slot` requires `slot` (the shared
  `slotNameSchema`), `skill_run` requires `runId` (`[A-Za-z0-9_-]{1,64}`,
  because it lands in a path), and `orchestrator` takes neither. Every object
  is strict, so `session`, `command` or any other extra field fails with
  `invalid_args`.
- **The terminal messages are strict**, unlike the rest of the protocol,
  where unknown fields are dropped. `terminal.data` checks padded base64 and
  caps it at 64 KiB *decoded*, not just by string length. Resize is bounded to
  10–500 columns and 2–200 rows, on attach and on resize. Control sequences
  are not filtered; the spec names none, and the safety is D1 + D4 + D6.
- **`terminal.data` and `terminal.close` go both ways.** They are in both
  `runnerMessageSchema` and `serverMessageSchema`; `messageSchema` lists each
  once. `terminal.resize` is server → runner only. The reason `socket` is for
  the audit record: nobody can send it over a dropped socket.
- **`capabilities.terminal` is optional.** Absent means `false`; read it with
  `terminalAvailable(caps)`. A required field would break
  `detectCapabilities` (runner) and the API test fixtures in this slot, and a
  runner older than this feature does not send it anyway. i29-runner fills it
  in `apps/runner/src/detect/capabilities.ts`: `true` only with Bun's PTY API,
  POSIX, tmux ≥ 3.2, and `terminal.attach` not in `disabledCommands`.
- **New error codes** in `commandErrorCodeSchema`: `not_found`, `busy`,
  `unsupported` (`disabled` already existed). The runner's `busy` covers its
  own limits; naming the admin who holds control is the API's job, from its
  in-memory attach list (D9).
- **Adding the messages needs no app edit.** The runner's and the API's
  message switches have no exhaustiveness guard, so the new types compile and
  are ignored until i29-runner adds `case 'terminal.data' / 'terminal.resize'
  / 'terminal.close'` in `apps/runner/src/connection.ts`, and i29-api adds
  `case 'terminal.data' / 'terminal.close'` in
  `apps/api/src/runners/runner.gateway.ts`.

### From i29-runner

- **Command registration trap (#12).** `CommandHandlers` in
  `apps/runner/src/commands/dispatcher.ts` needs a handler for every key of
  `commands`. A protocol or API slot therefore defines and exports a command
  in its own file without adding it to the map. The runner slot adds the map
  entry and the handler in the same commit. `terminal.attach` landed that way.
- **Where it lives.** The code is in `apps/runner/src/terminal/`:
  - `resolve.ts` resolves the target (D2). It reuses `watchedProject` /
    `resolveSlot` from `control/target.ts` and the shared
    `orchestratorSessionName`, and it maps their `path_not_allowed` /
    `not_a_repository` to `not_found`.
  - `pty.ts` builds the argv and does the Bun PTY spawn (D3, D4). It strips
    `TMUX` / `TMUX_PANE` from the environment, so a runner started inside tmux
    can still attach.
  - `manager.ts` holds the limits and the streams (D6–D8).
- **Read-only.** On a `read` attach the runner never writes to the PTY. Input
  is only counted (`bytesDropped`).
- **Limits on the runner.** Idle and maximum duration are enforced as a
  backstop at the shared defaults (900 s / 4 h), with `terminal.close` sent
  with the reason. The API's configured values are the primary limits. A
  value above the defaults is capped by the runner.
- **Follow-up: `terminal.maxAttachesPerRunner`** (Configuration). The runner
  uses the constant `TERMINAL_MAX_ATTACHES_PER_RUNNER` (2), which can be
  injected in tests. The runner config key is not added yet: `config.ts` was
  outside this slot.
- **Follow-up: `skill_run`** answers `unsupported` until #24's runner can
  resolve `agentdock-run-<shortid>` of a live run of the project.
- **Two names for one slot.** When both `cs-<slot>` and `cs-<prefix>--<slot>`
  are live, the attach goes to the one that sorts first.
- **`capabilities.terminal`** is added by the daemon's re-detection: it covers
  both `hello` and `runner.describe`. The probe itself is
  `terminalCapability()` in `detect/capabilities.ts`.
- **Orphans.** Resolving can outlive the 10 s command timeout. In that case
  no PTY is spawned, because the server has already given up on the command.
  Ending an attach sends SIGHUP, then SIGKILL after 2 s, to the attach client
  only.

Depends on #8

Depends on #18
