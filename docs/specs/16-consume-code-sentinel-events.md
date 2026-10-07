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
| D2 | **Tailing.** `fs.watch` plus a 5 s poll fallback. The byte offset and the file's inode are persisted in `$XDG_STATE_HOME/agentdock/offsets.json` under key `events:<projectId>` (same file as #12, written atomically). If the inode changes or the file is shorter than the offset, the collector restarts from 0 and relies on dedupe (D5) | #12 D5 |
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
| Offsets file shared with #12 written concurrently | low | single writer module in the runner with atomic rename; both collectors go through it |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Turn off markdown scraping when events are present? | No — keep both; pane and worktree state only come from scraping |

Depends on #11
