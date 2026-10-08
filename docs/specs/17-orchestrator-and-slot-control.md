# Orchestrator and slot control from the UI

Issue: [#17](https://github.com/AndreyBegma/AgentDock/issues/17) · Roadmap: M2.2 ·
Decisions: [ADR-0005](../adr/0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md),
[ADR-0006](../adr/0006-runtime-adapters-and-runtime-profiles.md),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md),
[runner-protocol.md](../architecture/runner-protocol.md), [security.md](../architecture/security.md)

## Summary

Goal 3 of the PRD: steer the fleet without a terminal. Operators of a project
can start the Code Sentinel orchestrator (`start` or `next`) through a runtime
profile, stop it, ask for its status, stop one slot, and send a worker a
message — using exactly the mechanisms the orchestrator skill itself uses, so
the orchestrator sees the effect on its next wake (ADR-0005). Every action is a
typed runner command, authorized by project role, audited, and recorded as an
event.

## Scope

### In scope

- Runner commands `orchestrator.start`, `orchestrator.stop`, `orchestrator.status`, `slot.stop`, `slot.message`.
- A `command_runs` log of every command sent from the UI, with outcome.
- API endpoints, role checks, audit records (#8), events.
- Per-project settings: default orchestrator profile, model, permission mode.
- Web controls on the fleet page and the slot sheet, with confirmation dialogs.

### Out of scope

- Approving or rejecting merges — M2.5 (#20).
- Dispatching a specific issue or changing a slot's model by hand — the orchestrator decides (ADR-0005).
- Propagating the chosen profile to the workers the orchestrator dispatches — plugin [#6](https://github.com/AndreyBegma/claude-code-plugin/issues/6) (P9). Until it lands, workers inherit `CLAUDE_CONFIG_DIR` from the orchestrator's environment, which this item sets.
- Live pane text — #18. Interactive terminal — M3.6.
- Codex orchestrator — M4.3. `orchestrator.start` refuses a `codex` profile in this item.

## Decisions

The person delegated all decisions on 2026-10-07; each below is the default
taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | **Session name.** `orchestrator.start` creates tmux session `agentdock-orch-<project-slug>`, where the slug is `owner-name` lower-cased with non-`[a-z0-9-]` replaced by `-`. Never a `cs-` prefix — `watch.sh` treats every `cs-*` session as a slot. The project's `orchestratorSession` setting (#11 D6) is set to this name on first start so presence detection follows | plugin `watch.sh` [Confirmed]; #11 D6 |
| D2 | **Launch.** `tmux new-session -d -s <name> -c <project root> <argv>` where argv is the profile's binary and args, then `--remote-control <name> -n <name> --model <model> --permission-mode <mode> '/code-sentinel:orchestrator <start\|next>'`. The profile's `env` (e.g. `CLAUDE_CONFIG_DIR`) is passed with tmux `-e KEY=VALUE`, never by invoking a shell function or `sh -c` string. A live session of that name → `already_running` | ADR-0006; the owner's manual launch on 2026-10-07 [Confirmed] |
| D3 | **Defaults.** Model `opus`; permission mode `auto`; profile = the project's default profile (#10 D13). Each overridable per project (`orchestrator.model`, `orchestrator.permissionMode` ∈ `auto \| acceptEdits \| bypassPermissions \| manual`) and per start request. `bypassPermissions` requires an **admin** to set it on the project | security.md (bypass is high-risk) |
| D4 | **Stop.** `orchestrator.stop` = `tmux kill-session -t <name>`. It never touches worktrees, slots or branches; the workers keep running (the orchestrator skill's own `stop` does not kill them either) | orchestrator SKILL "stop" [Confirmed] |
| D5 | **Status.** `orchestrator.status` returns tmux presence, the #11 pane classification (`running`/`idle`/`prompt`/`quota`) and the session's start time. It does **not** type `/code-sentinel:orchestrator status` into the session — that would interrupt it | ADR-0005 |
| D6 | **Slot stop.** `slot.stop` = `tmux kill-session -t cs-<slot>` for a slot of this project (checked against the `.wt-<repo>-<slot>` worktree, #10 D10). Worktree, branch and commits are left alone; the orchestrator resumes or cleans up per its Phase 7c | orchestrator SKILL "stop <slot>", Phase 7c [Confirmed] |
| D7 | **Slot message.** `slot.message { text }` writes `text` to `<worktree>/.orchestrator-msg.md` (atomic write, max 16 KB, prefixed with `From: <user email> via AgentDock` and a timestamp), then runs `tmux send-keys -t cs-<slot> -l "Read ./.orchestrator-msg.md and reply into ./.orchestrator-reply.md"` and, as a **separate** call, `tmux send-keys -t cs-<slot> Enter` | orchestrator SKILL Phase 6.5 [Confirmed] |
| D8 | **Message etiquette.** A message to a worker bypasses the orchestrator. The API also writes an `slot.message_sent` event so the orchestrator's next board read (and #16) sees it; the UI warns that the orchestrator normally speaks to workers | ADR-0005 |
| D9 | **Roles.** `orchestrator.status`: viewer. `orchestrator.start`, `orchestrator.stop`, `slot.stop`, `slot.message`: operator of the project (#10 D11). These minimum roles are written into the protocol allowlist and checked by `RunnerCommandService` (#6 D8) and again by `ProjectAccessGuard` | runner-protocol.md, ADR-0008 |
| D10 | **Log.** Every command sent by this item gets a `command_runs` row (`requested` → `ok` / `error` / `unknown`), so the UI shows "Stopping…" and the outcome, and history (#21) can list them. Audit (#8) records the same actions with actor and result: `orchestrator.start`, `orchestrator.stop`, `slot.stop`, `slot.message` (message text stored hashed in audit, full text only in `command_runs`) | #8 D5, security.md |
| D11 | **Timeouts.** start 30 s (until the tmux session exists — not until Claude is ready), stop/slot.stop 10 s, message 10 s, status 5 s | #6 D8 |
| D12 | Slot session names: the runner accepts both `cs-<slot>` (current) and `cs-<prefix>--<slot>` (code-sentinel P11, [plugin#11](https://github.com/AndreyBegma/claude-code-plugin/issues/11)), parsing them in one shared helper `apps/runner/src/fleet/session-name.ts` owned by #11 (import it); a session belongs to a project only when its worktree path does. Other issues import the helper, never re-parse | #11 D12, plugin#11 |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261020000000_control/`. New table only.

| Table | Fields |
|---|---|
| `command_runs` | `id`, `projectId` → projects, `runnerId` → runners, `userId` → users, `command`, `args` Json (message text included), `slot?`, `status` (`requested` \| `ok` \| `error` \| `unknown`), `error?` Json, `result?` Json, `requestedAt`, `finishedAt?`; index `(projectId, requestedAt)` |

Project settings (#10's `projects` row) are not altered: orchestrator settings
live in a new `project_orchestrator_settings` table to avoid altering
`projects` in parallel with other issues:

| Table | Fields |
|---|---|
| `project_orchestrator_settings` | `projectId` PK → projects, `profileId?` → runtime_profiles, `model` default `opus`, `permissionMode` default `auto`, `updatedById` → users, `updatedAt` |

## Protocol

New file `packages/shared/src/protocol/commands/control.ts`, one registration line in
`commands.ts` and one export line in `index.ts`.

| Command | Args | Min role | Result |
|---|---|---|---|
| `orchestrator.start` | `{ projectId, root, profileId, model, permissionMode, mode: "start" \| "next" }` | operator | `{ session, startedAt }` |
| `orchestrator.stop` | `{ projectId, root }` | operator | `{ stopped: boolean }` |
| `orchestrator.status` | `{ projectId, root }` | viewer | `{ present, state, session?, startedAt? }` |
| `slot.stop` | `{ projectId, root, slot }` | operator | `{ stopped: boolean }` |
| `slot.message` | `{ projectId, root, slot, text, from }` | operator | `{ written: true, delivered: boolean }` |

`slot` matches `^[a-z0-9-]+$` (same rule as `dispatch.sh`).

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| POST | `/projects/:id/orchestrator/start` | operator | `{ mode, profileId?, model?, permissionMode? }` → `command_run` |
| POST | `/projects/:id/orchestrator/stop` | operator | → `command_run` |
| GET | `/projects/:id/orchestrator/status` | viewer | live status via the runner |
| GET / PUT | `/projects/:id/orchestrator/settings` | viewer / operator (admin for `bypassPermissions`) | D3 |
| POST | `/projects/:id/slots/:slot/stop` | operator | → `command_run` |
| POST | `/projects/:id/slots/:slot/message` | operator | `{ text }` → `command_run` |
| GET | `/projects/:id/command-runs` | viewer | paginated log |

`command_run` status changes are published on `project:<id>` (#9) as
`command_run.updated`.

## UI

On `/projects/[projectId]/fleet`:

- Orchestrator card: **Start** (split button: start / next; profile, model and permission mode shown, editable for operators), **Stop** (confirm dialog: "workers keep running"), status refresh.
- Slot sheet: **Message worker** (textarea, warning from D8, send), **Stop slot** (confirm dialog: "the worktree and branch are kept; the orchestrator will resume or clean up").
- Pending commands show a glass-ui `Spinner` (#67) and resolve to a toast with the outcome.
- Project settings (#10's page) gains an *Orchestrator* tab for D3.

## Configuration

| Key | Where | Meaning |
|---|---|---|
| `disabledCommands` | runner config (#5 D3) | a machine can refuse any of these commands locally |

## Acceptance criteria

- [ ] With a fake profile whose binary is a test script that records its argv and env and sleeps, `orchestrator.start` creates `agentdock-orch-<slug>` in the project root with exactly the argv of D2 and the profile's env; no `sh -c` is involved (asserted on the recorded argv).
- [ ] A second start while the session lives returns `already_running`; stop kills only that session; `cs-*` sessions and all worktrees are untouched (asserted in a fixture with two fake slots).
- [ ] `slot.stop` on `i42` kills `cs-i42` only; its worktree, branch and commits remain.
- [ ] `slot.message` writes `.orchestrator-msg.md` with the `From:` header and sends the two `send-keys` calls in order (`-l` text, then `Enter`) — asserted against a fake tmux shim.
- [ ] A slot name with `/`, `..` or uppercase is rejected as `invalid_args` before anything runs; a slot whose worktree belongs to another project is rejected.
- [ ] Every action creates a `command_runs` row and an audit record with actor and result; a runner that never answers leaves the run `unknown` after its timeout.
- [ ] Setting `permissionMode: bypassPermissions` as an operator returns 403; as an admin succeeds and is audited.
- [ ] `orchestrator.start` with a `codex` profile returns `unsupported_runtime`.
- [ ] **Authorization:** a viewer gets 403 on start, stop, slot stop and message; a non-member gets 404 on every route of this item; an operator of project A cannot stop a slot of project B by passing B's slot name to A's route.
- [ ] `bun run check`, `bun run test`, `bun run build` pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i17-protocol | command schemas | packages/shared/src/protocol/commands/control.ts, packages/shared/src/protocol/commands.ts, packages/shared/src/protocol/index.ts | — | yes | opus |
| i17-runner | handlers and the tmux shim used by tests | apps/runner/src/control/**, the runner command handler registry from #5 | i17-protocol | no | opus |
| i17-api | tables, endpoints, audit actions | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261020000000_control/**, apps/api/src/control/**, apps/api/src/app.module.ts, packages/shared/src/audit/actions.ts | i17-protocol | no | opus |
| i17-web | controls and settings tab | apps/web/src/app/(app)/projects/[projectId]/fleet/**, apps/web/src/app/(app)/projects/[projectId]/settings/**, apps/web/src/lib/control/** | i17-api | no | sonnet |

i17-runner and i17-api run in parallel after the protocol lead merges.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/shared/src/protocol/commands.ts, index.ts | i17-protocol | append-only registries — #18, #19, #20 add lines; keep both on conflict |
| runner command handler registry (#5) | i17-runner | append-only; keep both |
| apps/api/prisma/schema.prisma | i17-api | distinct new tables only; keep both blocks on conflict |
| apps/api/src/app.module.ts | i17-api | append-only; keep both imports |
| packages/shared/src/audit/actions.ts | i17-api | append-only union from #8; keep both |
| apps/web/src/app/(app)/projects/[projectId]/fleet/** | i17-web | #16's i16-web and #18's i18-web also edit this page. One writer at a time: the orchestrator keeps i17-web `BLOCKED — work` while another open unmerged PR touches this folder (its Phase 2 rule), so the three web slots land one after another |
| bun.lock | regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) | — |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| A UI button launches an unattended agent with broad permissions | high | operator role minimum; `bypassPermissions` admin-only; audit; runner-local `disabledCommands` |
| `send-keys` text lands in a busy prompt and is mangled | medium | exactly the skill's two-call pattern; message text lives in the file, not in keys |
| Workers dispatched by the started orchestrator use another profile | medium | env passed to the orchestrator is inherited by `dispatch.sh`; plugin#6 makes it explicit |
| Two users start the orchestrator at the same moment | low | tmux session name is the lock; the second gets `already_running` |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Allow `stop all slots` in one click? | No — per slot; `orchestrator.stop` plus individual stops |
| Restart the orchestrator automatically when it dies? | No — the UI shows `absent`; a schedule (M3.2) can do `next` |

## Notes from implementation

i17-protocol, decided with the orchestrator on 2026-10-08:

1. **Registration.** The schemas live in `packages/shared/src/protocol/commands/control.ts` as `controlCommands`, and are **not** spread into `commands` in `commands.ts`. The runner's `CommandHandlers` (`apps/runner/src/commands/dispatcher.ts`) requires a handler for every key of `commands`, so a command added there without its handler breaks the runner build. i17-runner adds `...controlCommands` to `commands` in the same change as the handlers. Any later protocol slot follows the same rule: define and export, let the runner slot register.
2. **Error codes.** `commandErrorCodeSchema` gains `already_running` (D2), `unsupported_runtime` (a `codex` profile) and `unknown_profile` (a `profileId` that is not in the runner config — the schema cannot know it). A slot whose worktree belongs to another project answers the existing `path_not_allowed`.
3. **One slot-name rule.** `slotNameSchema` is `^[a-z0-9][a-z0-9-]*$`, at most 64 characters: no `/`, `.`, `:`, uppercase or leading `-`, so it is never a path, a tmux target expression or a flag. #18's `subscribe`/`unsubscribe`/`pane` import it rather than define their own.
4. **`permissionMode: manual`** stays the protocol's word for the runtime's default, prompting mode; i17-runner maps it to the CLI's value. `model` is a model alias or id that never starts with `-`, because it lands in argv after `--model`.
5. **`slot.message.text`** is at most 16 KB counted in UTF-8 bytes, non-blank; `from` is an email. The `From:` header and timestamp are added by the runner, outside that limit.
6. **`orchestrator.status.state`** is the pane classification (`running | idle | prompt | quota`) or `absent`, which holds exactly when `present` is false. `orchestratorSessionName(repo)` is the D1 slug, shared by the runner (session name) and the API.
7. **Presence detection.** #11 note 9 left `orchestratorSession` out of the project settings; the collector recognises the orchestrator by the `agentdock-orchestrator` session name *or* a `code-sentinel:orchestrator` command line in the project root. D2's argv carries the latter, so an `agentdock-orch-<slug>` session started here is detected without that setting.

i17-runner, decided with the orchestrator on 2026-10-08:

8. **Registration landed.** `commands` spreads `controlCommands`; the five handlers are in `apps/runner/src/control/` and registered in `createHandlers` in the same commit. The runner reads profiles through `HandlerContext.profiles` (the runner config's `profiles`).
9. **Exact tmux targets.** Every `-t` the runner sends is `=<session>` (`=<session>:` for a pane). A bare name falls back to tmux's prefix match: with only `cs-i42` alive, `kill-session -t cs-i4` kills `cs-i42` (verified on tmux 3.7c).
10. **`slot.message` reports delivery.** The result is `{ written: true, delivered }`. The message file is always written; `delivered` is true only when the worker's session was live and both `send-keys` calls ran. With no live session the file waits for the worker to be resumed, and the UI should say so rather than "sent".
11. **`manual` → `--permission-mode default`.** The other three modes pass through unchanged. A profile without `binary` launches its runtime's name (`claude`).
12. **The session name's `repo` (for i17-api).** The runner names the session `orchestratorSessionName(repo)` where `repo` is `owner/name` parsed from the root's `origin` remote, else the root's basename (#11's `resolveFleetProject`). The API should take the session name from the start result or `orchestrator.status`, not recompute it: for a project without a GitHub origin its idea of `repo` may differ.
13. **Slot ownership.** A slot is this project's only when `git -C <root> worktree list` lists its `.wt-<repo>-<slot>` worktree (not prunable); otherwise `path_not_allowed`, before any tmux call. Its sessions are those `ownedSlot` (#11 D12) attributes to it, so `cs-<slot>` and this repository's `cs-<prefix>--<slot>` count, and another repository's prefix never does. `slot.stop` kills every session the slot owns and answers `{ stopped: false }` when none is live.
14. **Atomic message write.** A temp file beside the target is opened with `wx` (mode 0600) and renamed over `.orchestrator-msg.md`, so a symlink at that path is replaced, never written through.

i17-api, decided with the orchestrator on 2026-10-08:

15. **D8 amended — `slot.message_sent` is a live event, not a stored one.** The `events` table holds runner envelopes keyed by `(runnerId, seq)`; the API cannot append to it honestly. After a message is written, the API publishes `slot.message_sent` (`{ projectId, slot, commandRunId, userId, delivered, at }`) on `project:<id>`; the durable record is the `slot.message` row in `command_runs`.
16. **The message text never reaches the audit log (D10).** `RunnerCommandService.send` takes an optional `auditArgs` that its `runner.command` record shows instead of the args sent. `slot.message` passes the args with `text` as `sha256:<hex>` and `textBytes`; the `slot.message` audit record carries the same. Only `command_runs.args` holds the text.
17. **Synchronous POSTs.** Each command route waits for the runner (at most the D11 timeout) and answers with the finished `CommandRunView` (201), or with the mapped error whose body carries `commandRunId`. `command_run.updated` is published when the row is created (`requested`) and when it finishes; its data omits `args`, which a 16 KB message could push past the live frame limit once escaped.
18. **Error map.** As `ProjectInspector`: the runner's presence is checked first (409 `runner_offline`); no answer in time is 504 `runner_timeout` and leaves the run `unknown`; `already_running` 409; `unknown_profile` / `unsupported_runtime` 422; `path_not_allowed` 403 (a slot of another project — the API always sends its own project's root); a runner `timeout` answer 504 with the run `error`; anything else 502 `runner_error`. A `:slot` that fails `slotNameSchema` is 400 `invalid_args`, after the access guard (a non-member still gets 404).
19. **Refusals decided by the API still leave a run.** Runner offline, no profile anywhere (422 `no_profile`), a profile not on the project's runner or `missing` (422 `unknown_profile`), a `codex` profile (422 `unsupported_runtime`, before sending) and a `bypassPermissions` override from a non-admin (403, audited `denied`) each create a `command_runs` row that ends `error`. Input validation (a blank message, a model that reads as a flag) is 400 with no row.
20. **Profiles.** Settings and start requests name a `runtime_profiles.id`; the API sends the runner its `key`. Precedence: request → project settings → the project's default profile (#10 D13). A `codex` profile is refused at `PUT …/settings` too.
21. **`bypassPermissions`.** Setting it on the project and sending it as a start override need admin; an operator's start that inherits it from the project settings is allowed — an admin chose it. `PUT …/settings` changes only the fields sent and is audited as `orchestrator.settings` with before and after.
22. **`orchestrator.status` has no run.** It is a read the UI polls; `RunnerCommandService` still audits it as `runner.command`.
23. **Migration order.** `20261020000000_control` sorts before the already-merged `20261021000000_queue`. A database that applied `_queue` first gets `_control` applied out of order by `prisma migrate deploy`; the two touch distinct tables.

Depends on #8

Depends on #10

Depends on #11
