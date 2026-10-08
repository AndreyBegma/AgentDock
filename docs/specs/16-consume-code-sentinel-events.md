# Consume code-sentinel events.jsonl and state.json

Issue: [#16](https://github.com/AndreyBegma/AgentDock/issues/16) · Roadmap: M2.1 ·
Decisions: [ADR-0002](../adr/0002-structured-orchestrator-events-markdown-as-fallback.md),
[ADR-0005](../adr/0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md),
[event-schema.md](../architecture/event-schema.md), [plugin changes](../plugin/code-sentinel-changes.md) (P1–P3)

## Summary

#11 sees the fleet by scraping markdown boards, briefs, reply files and tmux
panes. Code Sentinel is gaining a machine-readable channel
([AndreyBegma/claude-code-plugin#5](https://github.com/AndreyBegma/claude-code-plugin/issues/5)):
an append-only `events.jsonl` and a current `state.json`, both under
`<git-common-dir>/cs-orchestrator/`. This item adds a runner collector that
tails `events.jsonl`, snapshots `state.json` on every (re)connect, and feeds the
same projections #11 built. Facts reported by the plugin win over the same facts
scraped from markdown. Projects whose plugin is older keep working on the
markdown collectors.

## Scope

### In scope

- Runner collector `events` (tail `events.jsonl`, persisted offset, rotation-safe).
- `state.json` snapshot on connect and on change, sent as one `orchestrator.snapshot` event.
- Mapping plugin event types to AgentDock's envelope (they share the schema; the runner assigns `seq`).
- Source precedence in the #11 projector: `code-sentinel` over `scraped` for the same fact.
- Per-project indicator of which channel is active (`events` / `scraped` / `both`).

### Out of scope

- Writing `events.jsonl` — that is the plugin's job (plugin#5).
- New projections or tables. This item changes how #11's rows are filled, not their shape.
- Controlling the fleet (#17), live pane (#18).

## Decisions

The person delegated all decisions on 2026-10-07; each below is the default
taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | **Location.** The collector reads `<git-common-dir>/cs-orchestrator/events.jsonl` and `<git-common-dir>/cs-orchestrator/state.json` for each watched project (`git-common-dir` from #10's inspection). It does not read dated board folders — #11's `board` collector keeps doing that | plugin P1/P2 [Confirmed in docs/plugin]; exact path [Unknown until plugin#5 merges] |
| D2 | **Tailing.** `fs.watch` plus a 5 s poll fallback. The byte offset and the file's inode are persisted in `$XDG_STATE_HOME/agentdock/events-offsets.json` under key `events:<projectId>` (same `OffsetStore` class as #12's `offsets.json`, written atomically — but a file of its own, see Notes 11). If the inode changes or the file is shorter than the offset, the collector restarts from 0 and relies on dedupe (D5) | #12 D5 |
| D3 | **Parsing.** Each line is parsed as the envelope from event-schema.md with schema version `v`. Lines with `v` greater than the runner understands, malformed JSON, or a missing `type` emit `events.unparsed { line, reason }` and are skipped; the collector never stops | ADR-0002 |
| D4 | **Mapping.** Plugin events already use AgentDock's type names (`orchestrator.*`, `round.*`, `slot.*`, `pr.merged`, `issue.blocked`, `person.needed`). The runner only adds `seq`, sets `source: "code-sentinel"`, and fills `project` from the watch list. Unknown types are forwarded unchanged and stored raw (event-schema.md) | event-schema.md |
| D5 | **Dedupe.** The plugin writes an `id` (ULID) on every event (plugin#5 requirement, stated in its spec). The API dedupes plugin events on `(projectId, data.pluginEventId)` in addition to `(runnerId, seq)`, so a re-read from offset 0 does not double-apply | new |
| D6 | **Snapshot.** On runner connect and whenever `state.json` changes, the collector sends `orchestrator.snapshot { state }`. The projector reconciles: slots in the snapshot are upserted, open slots missing from it are left to the scraped/tmux collectors to end (the snapshot is not authority on ending) | new |
| D7 | **Precedence.** The projector stores `source` per field group on `slots` and `rounds` (`model/modelWhy/owns/never/lead`, `checkpoint`, `pr`). An update from `scraped` never overwrites a field group last written by `code-sentinel`; `code-sentinel` always overwrites `scraped`. Live state the plugin does not report (pane flags, ahead/behind) stays with the #11 collectors | ADR-0002 |
| D8 | **Channel indicator.** `projects.fleetChannel` (`scraped` \| `events` \| `both`) is derived — `events` once a plugin event arrived in the last 24 h, `both` while scraped events also update fields the plugin covers. Exposed on `GET /projects/:id/fleet` | new |
| D9 | **No new table.** Field-group sources are stored as a `sources` Json column — this is an **alteration of #11's `slots` and `rounds` tables**, so this item serializes after #11 by table (it already depends on #11) | cs-spec contention rule |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261019000000_event_sources/`.

| Table | Change |
|---|---|
| `slots` | add `sources` Json default `{}` |
| `rounds` | add `sources` Json default `{}` |
| `events` | add nullable `pluginEventId` text; partial unique index `(projectRepo, pluginEventId)` where not null |

## API

No new endpoints. `GET /projects/:id/fleet` (from #11) gains `fleetChannel`.
Ingest: the gateway (#6) stores plugin events; the #11 projector applies D7.

## UI

The fleet page's orchestrator card shows a small chip: `events` (ok tone),
`scraped` (neutral), `both` (warn) with a tooltip explaining the channel.

## Configuration

| Key | Where | Meaning |
|---|---|---|
| `fleet.eventsPollSeconds` | runner config, per project | poll fallback interval, default 5 |

## Acceptance criteria

- [ ] With a fixture `events.jsonl` (written per plugin#5's format) appended line by line, slots, checkpoints and rounds appear in the API within 5 s of each append.
- [ ] Restarting the runner resumes from the persisted offset: no event is applied twice, none is missed.
- [ ] Truncating or replacing `events.jsonl` (new inode) re-reads from 0 and still produces no duplicate rows.
- [ ] A malformed line and a line with `v: 99` each emit `events.unparsed` and the following valid lines are applied.
- [ ] When both a scraped brief and a plugin `slot.dispatched` describe the same slot with different models, the slot shows the plugin's model, and a later scraped update does not revert it.
- [ ] A project without `events.jsonl` behaves exactly as under #11 (`fleetChannel: scraped`); creating the file switches it to `events` without a runner restart.
- [ ] `orchestrator.snapshot` from a fixture `state.json` upserts every slot it lists.
- [ ] **Authorization:** `fleetChannel` is returned only through `GET /projects/:id/fleet`, which a non-member of the project cannot read (404 per #10).
- [ ] `bun run check`, `bun run test`, `bun run build` pass; the collector is covered by fixture tests with no running orchestrator.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i16-api | migration, precedence in the projector, `fleetChannel` | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261019000000_event_sources/**, apps/api/src/fleet/** | — | yes | opus |
| i16-runner | `events` collector and snapshot | apps/runner/src/collectors/events/**, apps/runner/src/collectors/index.ts | — | no | sonnet |
| i16-web | channel chip | apps/web/src/app/(app)/projects/[projectId]/fleet/** | i16-api | no | sonnet |

i16-api and i16-runner run in parallel: they share only the event envelope,
which exists since #5/#11.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i16-api | **alters** #11's `slots` and `rounds` — serialized after #11 (dependency below). Other parallel issues add distinct tables only; keep both on conflict |
| apps/api/src/fleet/** | i16-api | #17 and #18 must not open it while i16-api is live |
| apps/runner/src/collectors/index.ts | append-only registry (#10) | one registration line; keep both on conflict |
| apps/web/src/app/(app)/projects/[projectId]/fleet/** | i16-web | #17's i17-web edits the same page — serialized: i17-web after this issue's web slot, see #17 |
| bun.lock | regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) | — |

Append-only registries shared across issues (keep both on conflict):
`apps/api/src/app.module.ts`, `packages/shared/src/protocol/commands.ts`,
`packages/shared/src/protocol/index.ts`, the runner command handler registry
from #5, `apps/runner/src/collectors/index.ts`, `apps/web/src/components/shell/nav.ts`.

Cross-repository: needs
[AndreyBegma/claude-code-plugin#5](https://github.com/AndreyBegma/claude-code-plugin/issues/5)
to produce real files; this item is built and tested on fixtures and does not
wait for it.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| plugin#5 lands a slightly different format than the fixtures | medium | fixtures copied from plugin#5's spec; `events.unparsed` makes drift visible; schema version `v` |
| Two sources disagree and flip-flop | medium | field-group precedence (D7), plugin always wins |
| Offsets file shared with #12 written concurrently | low | not shared: the `events` collector keeps `events-offsets.json` (one store per file per process, atomic rename), because #12's `SessionWatcher` prunes every key that is not a transcript and rewrites the whole file |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Turn off markdown scraping when events are present? | No — keep both; pane and worktree state only come from scraping |

Depends on #11

## Notes from implementation

i16-api, decided with the orchestrator on 2026-10-08. Checked against plugin#5
as merged: `skills/orchestrator/EVENTS.md` at claude-code-plugin@`bdce2e0`.

1. **D4 was wrong about shapes.** The plugin uses AgentDock's type names but
   not every `data` shape. Its envelope `session` has no `id`, and
   `project.repo` can be null. `slot.dispatched` names the brief's worktree
   copy (no date or round). `round.started` has `board` and no date or base.
   `round.decided` has `rows` and no round. Checkpoints carry `url`/`pr`;
   `pr.checks_changed` and `pr.closed` carry `pr`/`rollup` with no `merged`.
   `pr.merged` and `slot.redispatched` are new types. Forwarded unchanged,
   almost every plugin event would have failed `parseFleetEvent`.
   **`normalizeCodeSentinelLine(line, project)`** in `@agentdock/shared`
   (`src/fleet/code-sentinel.ts`) is now the one mapping. The runner's
   `events` collector calls it per line and only adds `seq`; the contract is in
   [event-schema.md → Code Sentinel](../architecture/event-schema.md#code-sentinel-eventsjsonl-spec-16).
   The fleet schemas only got looser (optional fields, new types), so every
   spec 11 event still parses.
2. **D5's key is `eid`, a uuid4**, not a ULID `id`. The normalizer keeps it as
   `data.pluginEventId`. The API dedupes on **`(projectRoot, pluginEventId)`**,
   not `projectRepo`: the repo can be null, the watch list carries only the
   root, and the projector resolves projects by root. The constraint is a plain
   `@@unique` — PostgreSQL's NULLs are distinct, so it binds plugin events
   only. A hand-written partial index would be invisible to Prisma, and the next
   `migrate dev` would drop it.
3. **A duplicate is stored, not dropped.** A re-read gives it a new `seq`; if
   that seq were never stored, the ack cursor would stall for good. It is
   stored as **`events.duplicate { pluginEventId, type }`** and never reaches
   the sinks.
4. **Run matching without a round (Q3).** A plugin `slot.dispatched` updates
   the covering run, unless that run ended or already carries an earlier
   plugin `dispatchedAt` (`slots.sources.dispatchedAt`) — then it starts a run.
   A dispatch older than a known later run of the name is history and changes
   nothing. The snapshot sets `dispatchedAt` from `state.json`'s own
   `dispatchedAt` (the same event's `ts`), so a first read from offset 0 after
   a snapshot does not fork runs.
5. **Field groups (D7).** On slots: `model` (model, modelWhy, owns, never,
   lead), `checkpoint` (lastCheckpoint and the checkpoint rows) and `pr`
   (number, URL, state, checks, mergeable). On rounds: `header` and
   `decisions`. Only `scraped` is held back; the runner's own `gh`/tmux
   observations are not ranked. A round's `base` is outside the groups — the
   plugin never reports it, so the board's counts, else the project's.
6. **Plugin checkpoints have no position.** The worker appends the reply
   heading and then emits the event. So a plugin checkpoint claims the first
   heading of its kind at or after the last position it claimed
   (`slots.sources.checkpoints`), else it is appended. Markdown may still add a
   heading the plugin has not sent, but never rewrites one it did.
7. **Echoes.** `watch.sh`'s `session.*`, `pane.*` and `commit.trailer_found`
   (`via: "watch"`) duplicate what the runner sees. The projector ignores them
   from `code-sentinel`; they stay in `events`.
8. **Snapshot (D6)** upserts every live slot of `state.json`. A slot it lists
   as ended updates an existing run but never creates one.
9. **`fleetChannel` (D8)** is computed per request. It is `events` when a
   `code-sentinel` event for the project's root was received in the last 24 h,
   and `both` when, additionally, a live slot or the latest round has a
   plugin-covered group last written by `scraped`. Index
   `events(projectRoot, source, receivedAt)` keeps that lookup cheap.
10. **Command registration trap (from #12).** `CommandHandlers` in the runner
    requires a handler for every key of `commands` in
    `packages/shared/src/protocol/commands.ts`. A protocol or API slot defines
    and exports a command in its own file but does not add it to the map; the
    runner slot of the same issue adds the entry together with its handler.
    This item adds no command.
11. **Offsets file (i16-runner, decided with the orchestrator on 2026-10-08).**
    D2 said "same file as #12". #12's `SessionWatcher` loads its own
    `OffsetStore`, deletes every key that is not a transcript path and saves its
    whole map, so a second writer's `events:<projectId>` keys would be lost. The
    `events` collector therefore uses the same `OffsetStore` class over
    `events-offsets.json` beside `offsets.json`. `FileState` has no inode field
    and its schema strips unknown keys, so the inode rides in `parser`
    (`{ inode }`). The offset is saved after the batch is emitted: a crash in
    between re-reads, which D5's dedupe absorbs.
12. **Snapshot timing.** Collectors have no reconnect hook, so the snapshot is
    sent when the collector starts and whenever `state.json`'s content changes.
    Events are spooled across a reconnect, so nothing is lost; a literal resend
    per reconnect needs a hook in the connection (follow-up). An invalid
    `state.json` is reported once as `events.unparsed` per distinct content.
13. **Poll.** `fleet.eventsPollSeconds` (default 5, 1–3600) lives in the
    runner's `fleet` config block and in `FleetSettings`. `fs.watch` on the
    `cs-orchestrator` directory (debounced 200 ms) makes a typical append
    visible sooner; the poll also arms the watch once the directory appears.
