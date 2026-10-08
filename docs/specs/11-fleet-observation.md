# Fleet observation — slots, rounds, worker checkpoints

Issue: [#11](https://github.com/AndreyBegma/AgentDock/issues/11) · Roadmap: M1.5 ·
Decisions: [ADR-0002](../adr/0002-structured-orchestrator-events-markdown-as-fallback.md),
[ADR-0005](../adr/0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md),
[event-schema.md](../architecture/event-schema.md), [runner-protocol.md](../architecture/runner-protocol.md)

## Summary

This answers the first goal of the PRD: what every slot on a project is doing
right now, on which model, and what is blocked. The runner gains collectors that
read what the Code Sentinel orchestrator already leaves behind:
- tmux `cs-*` sessions and their panes;
- `.wt-<repo>-<slot>` worktrees;
- round boards and briefs inside `.git`;
- `.orchestrator-reply.md` checkpoints;
- open pull requests and their checks.

Plugin `events.jsonl` does not exist yet (plugin P1, M2.1), so this is the
markdown fallback path of ADR-0002. Its events are marked `source: scraped`. The
API projects them into rounds, slots and checkpoints, and the web shows a live
fleet page per project.

## Scope

### In scope

- Runner collectors `tmux`, `worktrees`, `board`, `replies`, `prs`, `orchestrator`, per registered project.
- Fleet event types in `packages/shared/src/protocol/events/fleet.ts`.
- API tables `rounds`, `slots`, `slot_checkpoints` and their projections.
- Fleet, slot and round endpoints, with live pushes on topic `project:<id>`.
- Web `/projects/[projectId]/fleet`.

### Out of scope

- Controlling the fleet (stop slot, message worker, start orchestrator) — M2.2.
- Live pane streaming — M2.3. This item shows the last captured pane state only (prompt / idle / quota flags), not pane text.
- Reading `events.jsonl` / `state.json` — M2.1 adds that collector and demotes these to fallback.
- Queue states of ready issues (READY / BLOCKED …) — M2.4.

## Decisions

The person delegated all decisions on 2026-10-07; each below is the default
taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | **Slot discovery.** Slots are discovered exactly as `watch.sh` does it: `tmux ls` names starting `cs-`, slot = name minus `cs-`. The worktree path is `<parent of repo>/.wt-<repo basename>-<slot>`, matching `dispatch.sh`'s rule. A slot belongs to a project when that worktree exists for the project's root. | plugin `watch.sh`, `dispatch.sh` [Confirmed] |
| D2 | **Pane classifier.** Ports `watch.sh`'s `classify_pane` (dialog patterns, `esc to interrupt` means busy, three empty polls means idle) and the quota banner (`hit your weekly limit`). Emits `pane.prompt`, `pane.idle` and `pane.quota_hit` on change, not on every poll. The dialog patterns live in one exported constant, with a fixture test per dialog. | `watch.sh` [Confirmed] |
| D3 | **Polling intervals.** Panes, sessions and worktrees: 15 s. Board and reply files: `fs.watch` with a 60 s rescan fallback. PRs: `gh pr list --json number,headRefName,statusCheckRollup,mergeable,title,url` every 60 s per project, through the runner's own `gh`. Checks roll up to `pending` / `green` / `red`, with `green` only when every conclusion is success, neutral or skipped. | ADR-0004; `watch.sh` rollup query [Confirmed] |
| D4 | **Board parser.** Reads `<git-common-dir>/cs-orchestrator/<YYYY-MM-DD>/round-<HHMM>.md`:<br>• the header line: date, repo, base, occupied/max, free;<br>• the tables *Dispatching*, *Held for a lead*, *Not dispatching*, *Already in flight* (columns per orchestrator Phase 5).<br>Briefs `round-<HHMM>-<slot>.md` give Model, the `Model:` reason line, and the `owns:` / `never:` globs. Unknown columns are kept raw. A parse failure emits `board.unparsed` with the file and line, and is never fatal. | orchestrator SKILL.md Phase 5–6 [Confirmed] |
| D5 | **Reply parser.** Reads the `##` headings of `.orchestrator-reply.md` and maps them to checkpoints: `picked up`, `plan ready`, `implementation done`, `pull request open — <url>`, `blocked`, `misclassified`. The body under each heading becomes `summary`, trimmed to 4 KB. Unknown headings become checkpoint `other`. | worker SKILL.md Step 3 [Confirmed] |
| D6 | **Orchestrator presence.** A tmux pane in a non-`cs-` session counts when either holds:<br>• its `pane_current_path` is the project root and its command line contains `code-sentinel:orchestrator`;<br>• it is the session the project config names (`orchestratorSession`, default `agentdock-orchestrator`).<br>Status is `running`, `idle` (classifier) or `absent`. Plain `claude` sessions started by hand without tmux are `unknown`. | new — AgentDock launches it in tmux `agentdock-orchestrator` [Confirmed in practice]; detection outside tmux [Unknown] |
| D7 | **Event shape.** Fleet events use the envelope from event-schema.md with types:<br>• `session.appeared` / `session.vanished`<br>• `pane.prompt` / `pane.idle` / `pane.quota_hit`<br>• `worktree.changed`<br>• `round.started` / `round.decided`<br>• `slot.dispatched` (from a brief) / `slot.checkpoint`<br>• `pr.opened` / `pr.checks_changed` / `pr.closed`<br>• `orchestrator.started` / `orchestrator.stopped`<br>• `commit.trailer_found`<br>Markdown-derived events carry `source: "scraped"`. | ADR-0002 |
| D8 | **Projections.** Projections are pure functions of events and idempotent, so replaying the same events gives the same rows. A slot is `ended` when its session vanished and either its PR merged or its worktree is gone. `stale` is when the session vanished but the branch has unmerged work (the orchestrator's dead-slot case). | orchestrator Phase 1 classification [Confirmed] |
| D9 | **Live updates.** The web receives pushes through #9's `LiveService` on topic `project:<id>`. Each projection change publishes `{ kind: "slot" \| "round" \| "orchestrator", id }`, and clients refetch. | #9 |
| D10 | **Authorization.** Every endpoint requires membership in the project (#10's project-access guard). No role beyond viewer is needed, because this item is read-only. | ADR-0008, #10 |
| D11 | **Protocol export.** Each issue adds its own export line to `packages/shared/src/protocol/index.ts`. A conflict there is resolved by keeping both lines. | delegated rule shared with #12 |
| D12 | Slot session names: the runner accepts both `cs-<slot>` (current) and `cs-<prefix>--<slot>` (code-sentinel P11, [plugin#11](https://github.com/AndreyBegma/claude-code-plugin/issues/11)), parsing them in one shared helper `apps/runner/src/fleet/session-name.ts` owned by #11; a session belongs to a project only when its worktree path does. Other issues import the helper, never re-parse | plugin#11 |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261012000000_fleet/`. New tables only.

| Table | Fields |
|---|---|
| `rounds` | `id`, `projectId` → projects, `date` (date), `label` (`HHMM`), `base`, `occupied`, `max`, `free`, `decisions` Json (rows of the four tables), `source` (`scraped` \| `events`), `boardPath`, `createdAt`; unique `(projectId, date, label)` |
| `slots` | `id`, `projectId` → projects, `name`, `issue?` Int, `branch?`, `worktree`, `runtime` (`claude` \| `codex`, default `claude`), `model?`, `modelWhy?`, `owns` Json, `never` Json, `lead` Bool?, `status` (`running` \| `idle` \| `prompt` \| `quota` \| `stale` \| `ended`), `ahead?`, `behind?`, `dirty?` Bool, `prNumber?`, `prUrl?`, `prChecks?` (`pending` \| `green` \| `red`), `prMergeable?`, `lastCheckpoint?`, `startedAt`, `endedAt?`, `updatedAt`; unique `(projectId, name, startedAt)`; index `(projectId, status)` |
| `slot_checkpoints` | `id`, `slotId` → slots, `kind` (`picked_up` \| `plan_ready` \| `implementation_done` \| `pr_open` \| `blocked` \| `misclassified` \| `other`), `heading`, `summary`, `at`; unique `(slotId, heading, at)` |

`rounds` and `slots` do not reference each other. A slot's round is derived from
its brief's file name, `roundLabel` Json inside `decisions`.

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| GET | `/projects/:id/fleet` | project member | orchestrator status, base, occupied / max, slots with `status != ended`, latest round header |
| GET | `/projects/:id/slots?status=&issue=` | project member | slots, newest first, paginated |
| GET | `/projects/:id/slots/:slot` | project member | the latest slot by that name: brief fields, fence globs, checkpoints, PR and checks, worktree state |
| GET | `/projects/:id/rounds?date=` | project member | rounds with decisions |
| — | event ingest | runner gateway (#6) | fleet events go into `events`, then the projector |

## UI

`/projects/[projectId]/fleet`:

- **Orchestrator card:** status (running / idle / absent) with a status dot, base, `occupied / max`, last round time.
- **Slots table:** slot, issue (link), runtime / model with a tooltip for the reason, status badge, last checkpoint, PR number and checks dot, ahead / behind, age. Uses glass-ui `DataTable` from [AndreyBegma/glass-ui#67](https://github.com/AndreyBegma/glass-ui/issues/67) once released, and falls back to glass-ui `Table` until then.
- **Slot detail sheet:** brief header, `owns` / `never` globs, checkpoints as a list (a timeline once glass-ui adds one), PR link with checks and mergeable.

## Configuration

| Key | Where | Meaning |
|---|---|---|
| `fleet.pollSeconds` | runner config (`runner.json`), every project (note 16) | default 15, min 5 |
| `fleet.prPollSeconds` | runner config (`runner.json`), every project (note 16) | default 60, min 15 |
| `orchestratorSession` | project settings (#10) | tmux session name used for presence, default `agentdock-orchestrator` |

## Acceptance criteria

- [ ] `session-name.ts` parses `cs-i42-api` and `cs-agentdock--i42-api` to slot `i42-api`, ignores sessions whose worktree belongs to another repository, and is covered by unit tests.
- [ ] With a fixture project (a temp git repo, a `.wt-<repo>-i42` worktree, a `cs-i42` tmux session running `sleep`), the fleet endpoint lists slot `i42` as `running` within 30 s, and as `stale` within 30 s after the session is killed while its branch has an unmerged commit.
- [ ] Each pane fixture (trust dialog, bypass acceptance, credits menu, settings pre-approval, busy, empty prompt, quota banner) classifies to the same result as `watch.sh` on the same text.
- [ ] Parsing a real-format `round-HHMM.md` and brief fixture yields the round header, every table row, the slot's model and reason, and the `owns:` / `never:` globs. A malformed board emits `board.unparsed` and the daemon keeps running.
- [ ] Appending `## plan ready` then `## pull request open — <url>` to a reply file creates two checkpoints in order, and sets `lastCheckpoint` and `prUrl` on the slot.
- [ ] A PR whose checks go from pending to all-success flips `prChecks` to `green`. One failure makes it `red`.
- [ ] The orchestrator card shows `running` while `agentdock-orchestrator` runs in the project root and `absent` after it exits.
- [ ] Replaying the same events twice produces identical `rounds`, `slots` and `slot_checkpoints` rows.
- [ ] Projection changes reach an open fleet page without reload, within 5 s of ingest.
- [ ] **Authorization:** a user who is not a member of project A gets 404 (per #10 D12) on every `/projects/A/fleet`, `/slots*` and `/rounds` route, even when they are a member of project B. Anonymous gets 401.
- [ ] `bun run check`, `bun run test` and `bun run build` pass. Collectors are covered by fixture tests that need no real Claude session.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i11-api | event types, schema, migration, projector, endpoints | packages/shared/src/protocol/events/fleet.ts, packages/shared/src/protocol/index.ts, apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261012000000_fleet/**, apps/api/src/fleet/**, apps/api/src/app.module.ts | — | yes | opus |
| i11-runner | collectors | apps/runner/src/collectors/tmux/**, apps/runner/src/fleet/session-name.ts, apps/runner/src/collectors/worktrees/**, apps/runner/src/collectors/board/**, apps/runner/src/collectors/replies/**, apps/runner/src/collectors/prs/**, apps/runner/src/collectors/orchestrator/**, apps/runner/src/collectors/fleet.ts | i11-api | no | opus |
| i11-web | fleet page | apps/web/src/app/(app)/projects/[projectId]/fleet/**, apps/web/src/lib/fleet/**, apps/web/src/components/shell/nav.ts | i11-api | no | sonnet |

i11-runner and i11-web are cut after i11-api merges (event types and API
contract), and then run together.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i11-api | shared with #12's i12-api — distinct new tables only, so keep both blocks on conflict |
| packages/shared/src/protocol/index.ts | i11-api | #12 adds its own export line — keep both |
| apps/api/src/app.module.ts | i11-api | #12 registers its module too — keep both imports |
| apps/runner collector registry (`apps/runner/src/collectors/index.ts`) | #10 created it | i11-runner registers through its own `fleet.ts`; it adds one line to the registry, keep both on conflict |
| bun.lock | regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) | — |

Cross-repository: the web table prefers glass-ui `DataTable` from
AndreyBegma/glass-ui#67. That is not a blocking dependency.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Board and brief markdown wording changes in the plugin | high | fixture tests copied from the plugin's documented shapes. `board.unparsed` is visible. M2.1 replaces it with `events.jsonl` |
| Pane heuristics miss a new dialog | medium | one constant, fixture per dialog, kept in step with `watch.sh` |
| `gh` rate limits with many projects | low | 60 s interval, one call per project. The GitHub App (M3.4) replaces polling |
| glass-ui#67 not released in time | low | fall back to `Table`, then swap in a follow-up |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Show pane text snippets in the slot sheet before M2.3? | No — flags only |
| Keep ended slots forever? | Yes, they are history (M2.6 builds on them) |

## Notes from implementation

i11-api, decided with the orchestrator on 2026-10-08:

1. **Envelope source `scraped`.** `eventSourceSchema` gains `scraped`; until then the gateway would have rejected every markdown-derived event.
2. **Event types beyond D7.** `pane.busy` (the pane shows `esc to interrupt` again — without it a slot never leaves `idle` or `prompt`) and `board.unparsed` (named by D4). Pane events carry `data.target: slot | orchestrator`, so the orchestrator's idle state has a carrier. Slot-scoped events name the slot in the envelope's `slot`; `data` does not repeat it. The shapes are in [event-schema.md → Fleet](../architecture/event-schema.md#fleet-spec-11).
3. **`slot.checkpoint` carries `position`**, the index of the heading in the reply file. The file has no timestamps, so a rescan after a runner restart would otherwise duplicate every checkpoint; `slot_checkpoints` is unique on `(slotId, position)` instead of `(slotId, heading, at)`, and `at` is when the runner first saw it. `heading` and `position` are optional so a plugin `events.jsonl` checkpoint (M2.1) still parses; without a position it is appended.
4. **Status is derived, never stored on its own.** `slots` keeps the inputs — `sessionAlive` (null until the session is first seen), `pane`, `worktreeExists`, `prState` — and `status` is a pure function of them (`deriveSlotStatus`). A new status, `dispatched`, covers a slot whose brief exists and whose session has not appeared yet. `round` (`YYYY-MM-DD/HHMM`) records the brief a run came from.
5. **Runs.** A slot name is reused: an event belongs to the run whose `startedAt` is the latest at or before its `ts`. Only `session.appeared` (when the covering run is ended or absent) and `slot.dispatched` (for a round no run of that name carries, when the covering run already has a brief and has started, or is ended) start a new run. A brief that is rescanned updates the run that already carries its round.
6. **Replays.** Every fleet row keeps `lastSeq`, the highest event `seq` applied; an event at or below it is skipped. Timestamps (`startedAt`, `endedAt`, `updatedAt`, `createdAt`, `at`, `since`) come from event `ts`, never the clock. Replaying the same events — in one batch or one at a time — leaves every row identical.
7. **`fleet_orchestrators`** holds the orchestrator's presence (status null until observed, so the API reports `unknown`) and the last `board.unparsed`, shown on `GET /fleet` as `boardError` until the next board parses. Pane events for the orchestrator only count while it is `running` or `idle`: `pane.busy` → `running`, any other pane state → `idle`.
8. **Ingest.** The projector is a runner event sink (`RunnerEventSinks`, owned by #12): each batch is projected before it is stored, in one transaction under a per-runner advisory lock. Data that does not fit is logged and skipped; a database failure fails the batch and the runner resends it. Changes publish `fleet` `{ kind, id }` on `project:<id>` after commit.
9. **`orchestratorSession` is not a project setting yet.** It would alter `projects` and the watch list; the runner uses `agentdock-orchestrator`. Follow-up.
10. **No audit actions.** The module only reads, so spec 8's retrofit table is unchanged.

i11-web, decided with the orchestrator on 2026-10-08:

11. **The project landing is the fleet page.** `/projects/[projectId]` redirects to `/fleet` (it was `/settings`); Settings stays in the project navigation.
12. **`Table`, not `DataTable`.** glass-ui is pinned at v0.20.6, which has no `DataTable` (glass-ui#67). The slots table and the checkpoint list use `Table` and a plain list; swap them when the pinned version has them.
13. **Active slots from `/fleet`, history from `/slots`.** The default view is `FleetView.slots` (not ended). "Show ended" switches to the paged `GET /slots` with `status` and `issue` filters. A `fleet` frame on `project:<id>` triggers one debounced (300 ms) refetch of the fleet, the history page and the open slot.
14. **Issue links are derived, not stored.** A project has no repository URL yet, so `#N` links to `<repo of the slot's PR>/issues/N` when the slot has a PR URL and is plain text otherwise. Follow-up: link from the project's `repo` once the web has a GitHub base URL for it. Only `https:` URLs from events are rendered as anchors.

i11-runner, decided with the orchestrator on 2026-10-08:

15. **One `fleet` collector per project** (`apps/runner/src/collectors/fleet.ts`) composes the tmux, worktree, board, reply, PR and orchestrator watchers, so they share one slot book (briefs and worktrees) and one order per pass: briefs, then worktrees and sessions, then panes and the orchestrator, then reply files, then PRs. `CollectorFactory` now receives a `CollectorContext` (`exec`, `clock`, `log`, `fleet` intervals); the daemon passes it.
16. **Intervals are global**, `runner.json` → `fleet.pollSeconds` (15) / `fleet.prPollSeconds` (60), not per project: the per-project list is the server's watch list, which the runner caches and overwrites. Board and reply files are rescanned every 60 s and on `fs.watch` of the board directory and each slot worktree.
17. **The runner keeps no fleet state across restarts**, so the first pass decides:
    - an owned worktree with no live session *and* an `.orchestrator-reply.md` (its worker ran) gets `session.vanished`; without a reply file nothing is said — it may be a brief whose session has not launched;
    - no orchestrator found → `orchestrator.stopped` (`absent`, not `unknown`);
    - every reply section and open PR is re-sent; the projector's `(slotId, position)` and replay rules make that a no-op.
18. **Boards: the last 7 days of `cs-orchestrator/<date>/` only, and only the newest brief per slot name.** A first start would otherwise replay a year of rounds and leave every historical slot `dispatched`. A newest brief older than 10 minutes whose worktree does not exist gets `worktree.changed { exists: false }`, so the slot reads `ended`.
19. **Session ownership** (D12, plugin#11 D4): a `cs-<slot>` or `cs-<prefix>--<slot>` session is the project's only when `.wt-<repo>-<slot>` is one of the root's `git worktree list` entries, and a prefixed name also needs this repository's prefix (plugin#11 D2 slug, or `.code-analyzer-config.json` → `orchestrator.sessionPrefix`).
20. **Orchestrator presence** (D6): both rules also require the pane's current path to be the project root or inside it — otherwise one `agentdock-orchestrator` session would mark every watched project `running`. The command-line rule checks `pane_start_command`, then the pane's process tree (`ps -eo pid=,ppid=,args=`).
21. **tmux prints a tab in a format as `_` without a UTF-8 locale** (a systemd user service has none), so `list-panes` fields are separated by `|:|`, with the free-form path and start command last. Found by the real-tmux test (private `-L` socket).
22. **Known limit:** a PR merged while the runner was down is never seen as `pr.closed` — the runner no longer knows its number. Removing the slot's worktree still ends the slot.

Depends on #10
