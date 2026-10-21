# Token economy 3: count `/cs-eco` savings on the card a session is tracked to, and price manual sessions

Issue: #748 · Epic: [#745](745-token-economy.md) · ADR: [ADR-0074](../adr/0074-a-token-saving-is-judged-by-billed-cost-per-successful-card.md) · Plugin issue: [AndreyBegma/code-sentinel-skills#37](https://github.com/AndreyBegma/code-sentinel-skills/issues/37)

## Summary

The plugin's `/cs-eco` saves tokens in sessions the runner did not launch, and today that saving reaches no card and is worth $0 on screen. The cause has three parts:

- **The runner drops the session.** It sends every `/cs-eco` row with `runId: null, runKind: 'manual'` (`apps/runner/src/filter/eco.ts:119-123`). The Claude session id is known only as the directory name, and is dropped.
- **A row without a run is priced at $0.** The API stores the row without a run, and `savedOf` prices such a row at $0 (`apps/api/src/token-saver/token-saver-facts.ts:186`).
- **The card never sees it.** The card's figure sums only its rounds' runs (`apps/api/src/board/board-mapper.ts:368-375`). A card tracked from a terminal session (`source: 'terminal'`, `board_cards.trackedSessionId`, written by `apps/api/src/board/board-terminal.service.ts:125`) has no rounds, so it never shows a saving.

This issue does three things:

1. The runner sends the Claude session id with a `/cs-eco` batch.
2. The API resolves the session and stores it on each stats row.
3. The rows reach two places:
   - **Tracked session:** the rows count for that card, priced with #746's re-priced estimate.
   - **Untracked manual session:** the rows are priced by the session's model and shown on Usage.

The plugin has two defects, in a **different repository** (AndreyBegma/claude-code-plugin). They are a separate issue there and are not a slot of this one (see "Plugin follow-up").

## Scope

### In
- Shared: the `filter.stats` event data gains an optional `session`.
- Runner: `drainEco` / `emitRows` (`apps/runner/src/filter/stats-reader.ts:286-316`) send the session id of a `/cs-eco` batch.
- Schema: `token_saver_stats.sessionId` (FK `sessions`, SetNull).
- API:
  - the sink resolves the session on the project's runner;
  - the card view of a tracked card sums its tracked session's rows;
  - the summary and Usage price `manual` rows from their session, through #746's estimate.
- Web: the Usage token-saver section shows the manual sessions' saving as a priced figure.

### Out
- Changing the plugin repository (a separate issue there; see below).
- Attributing an orchestrator or fleet worker's `/cs-eco` rows to a card. Those sessions are not `trackedSession`s.
- The A/B report for manual sessions. A/B is per card (#746 D2); an untracked session has no card.

## Decisions

| # | Decision | Source |
|---|---|---|
| D1 | Rows from a `/cs-eco` session tracked to a card (`board_cards.trackedSessionId`) count for that card. | person, 2026-10-21 (Q-eco-attribution) |
| D2 | A terminal card has no `runs` row and no rounds [Confirmed: `board-terminal.service.ts:110-130` creates the card with `trackedSessionId` and no round]. So "that card's run" is carried by the stats row's `sessionId`. The card's figure is the sum of its rounds' rows plus the rows of its tracked session. | spec, from D1 |
| D3 | Untracked manual sessions are priced by the session's model (the session's last request's model, else the first of `sessions.models`). They use the re-priced estimate of #746 D6 with the session's own requests and compactions, and are shown on Usage. | person, 2026-10-21 (Q-eco-attribution); ADR-0074 §5–6 |
| D4 | The runner never trusts the row for the project or the session. The session is the `/cs-eco` directory name the rows were read from (`eco.ts:21-22, 94-131`), and the project is still the watched root (DA-04/DR-05). The API stores a session only when it resolves to a session of the same runner whose `projectId` is the envelope's project. Otherwise `sessionId` stays null. | spec, keeps #475 |
| D5 | The session id travels once per batch, as `filterStatsDataSchema.session` (optional, `^[A-Za-z0-9_-]{1,128}$`), not on each row. It is valid only when every row of the batch is `manual`. `drainEco` already emits one batch per session. | spec |
| D6 | The plugin's invalid correction row and its `RUN_KIND = "skill"` are fixed in the plugin repository. | person, 2026-10-21 (Q-eco-attribution) |

## Data / Schema

Migration `apps/api/prisma/migrations/20261231000008_token_saver_stat_session/`. It follows #746's `…000007` in the epic's order; if `develop` already has a later stamp when the branch is cut, take the next free one and keep the name.

- `TokenSaverStat` gains:
  - `sessionId String?`, with relation `session AgentSession? @relation(fields: [sessionId], references: [id], onDelete: SetNull)`;
  - `sessionExternalId String?`: the Claude session id as sent, kept so a session the API learns about after the batch can still be joined at read time;
  - `@@index([sessionId])` and `@@index([projectId, sessionExternalId])`.
- `AgentSession` gains the back-relation `tokenSaverStats TokenSaverStat[]`.

No backfill: rows stored before this change keep `sessionId = null`.

## API

- **`TokenSaverSink.handle` / `store`** (`apps/api/src/token-saver/token-saver-sink.ts:39-94`):
  - When `data.session` is present, the sink looks up `sessions` by `(runnerId, runtime 'claude', externalId = session)`. It keeps the id only if `session.projectId` equals the resolved project.
  - The sink writes `sessionId` on the batch's rows.
  - A batch with `session` and any non-`manual` row is malformed: the sink skips it and logs a warning, as today.
- **Card view** (`apps/api/src/board/board.service.ts:393`, `board-mapper.ts:368-375`, `:416`):
  - `tokenSaverFactsOf` also takes the tracked session ids of the cards in view (`board.service.ts:315` already collects them).
  - It returns `tokenSavedBySession`.
  - `cardTokenSaved` adds the tracked session's figure to the rounds' figures.
- **Pricing** (`apps/api/src/token-saver/token-saver-facts.ts`, after #746): a stat group of a `manual` row with a `sessionId` is priced with:
  - its session's cache prices and turns remaining (#746 D6);
  - for the fallback, the session's average instead of the run's.

  A row without a session still prices at 0, and is shown as tokens only.
- **Summary / Usage** (`apps/api/src/token-saver/token-saver-summary.service.ts:65-123`): "By run kind" `manual` and the totals include the priced manual rows. The response shape is unchanged (`estimateUsd` is no longer 0 for `manual`).

## UI

- **Board card:** a terminal card shows the `SavedBadge` (tokens first, after #746) once its tracked session saved something. Its sheet lists the session's filters (`FilterBreakdown`). The components are unchanged; only the data is new.
- **Usage → Token saver section** (`apps/web/src/app/(app)/usage/token-saver-section.tsx`): the "Manual session" row shows its priced saving, with a hint that it is priced from each session's own model and turns.
- `docs/ui/screens.md`: one line on the Board → Card and Usage → Token saver rows.

## Configuration

None.

## Acceptance criteria

- [ ] The runner sends a `/cs-eco` batch with `session` = the directory's session id. A row whose own `runId` names another session is still rejected (`eco.ts:114`).
- [ ] A batch whose `session` resolves to a manual session of the same project stores that `sessionId` on every row. A `session` of another runner, of another project, or unknown stores null.
- [ ] **Authorization:** a `/cs-eco` batch from project Q's root that names a session tracked to a card of project P never reaches P's card. That card's `tokenSaved` and its sheet's filters stay unchanged (e2e: two projects, one runner).
- [ ] **Authorization:** `GET /projects/:projectId/token-saver/summary` for P, read by a member of Q only, is refused. P's manual figure never includes Q's sessions (extend `token-saver.e2e.spec.ts`).
- [ ] A terminal card whose tracked session saved 42k tokens shows `saved ≈ 42k tok · $…` on its face, and its sheet lists the session's filters.
- [ ] An untracked manual session's rows show on Usage with a non-zero `estimateUsd`, priced at the session's model.
- [ ] A batch with `session` and a non-`manual` row is skipped with a warning, and nothing is stored.
- [ ] An older runner's batch (no `session`) is stored exactly as before.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i748-api | contract field, schema, sink, card view, pricing, summary | packages/shared/src/token-saver/contracts.ts, apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261231000008_token_saver_stat_session/**, apps/api/src/token-saver/**, apps/api/src/board/board.service.ts, apps/api/src/board/board-mapper.ts | #746 merged | yes | sonnet |
| i748-runner | send the session id | apps/runner/src/filter/stats-reader.ts, apps/runner/src/filter/stats-reader.spec.ts, apps/runner/src/filter/eco.ts, apps/runner/src/filter/eco.spec.ts | i748-api (contract) | no | sonnet |
| i748-web | Usage manual row, screens.md | apps/web/src/app/(app)/usage/token-saver-section.tsx, apps/web/src/lib/token-saver/**, docs/ui/screens.md | i748-api | no | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/shared/src/token-saver/contracts.ts | i748-api | runner and web import only |
| apps/api/prisma/schema.prisma, migrations | i748-api | #752 (independent) edits other models in parallel: the second to merge runs `git merge origin/develop` |
| apps/api/src/token-saver/token-saver-facts.ts | i748-api (after #746 merged) | — |
| apps/api/src/token-saver/**, packages/shared/src/token-saver/contracts.ts, apps/web/src/lib/token-saver/** | i748 slots | #751 edits these folders at the end of the chain. #748 is expected to merge long before; if it has not, #751's slots cut after it merges |
| apps/web/src/lib/token-saver/** | i748-web | — (#746's i746-web merged earlier) |
| docs/ui/screens.md | i748-web | append only; #747 runs in parallel but does not touch it |
| apps/runner/src/filter/** | i748-runner (`stats-reader.ts`, `eco.ts` only) | #747 runs in parallel in other files of this folder (`env.ts`, `main.ts`, `read-guard.ts`, `tool-cut.ts`, `outline.ts`): no file is shared |
| apps/api/src/board/board-mapper.ts | i748-api | #750 i750-api edits it later in the chain |

## Risks

- **Medium: a new runner talks to an older API.** The `filter.stats` data schema is strict, so an API without `session` drops the whole batch as malformed. Mitigation: release order. The API change ships first, and the runner change goes into the next runner release. Optionally, the runner sends `session` only when the API advertises it. [Unknown] whether the API advertises features to the runner; default is release order only.
- **Medium: the session is not known yet when the rows arrive.** The API learns about a manual session from its hooks and transcript, and may not have the `sessions` row when the batch comes in. Mitigation: `sessionExternalId` is always stored. Reads join on `(project's runner, externalId)` when `sessionId` is null, still requiring the session's `projectId` to equal the row's project.
- **Low: the correction row stays invalid until the plugin issue ships.** Its rows keep being rejected by the runner and counted in its `rejected` warning.

## Open questions

- **Backfill `sessionId` on late rows.** Rows stored before their session was known keep `sessionId` null. Should a job fill it in later? Default: no; reads join by `sessionExternalId` instead.
- **Which model prices a session with several.** Default: per stat row, the model of the session's last request before the row.

## Plugin follow-up (separate issue in AndreyBegma/claude-code-plugin)

These are not Nautelle slots. They are filed as [AndreyBegma/code-sentinel-skills#37](https://github.com/AndreyBegma/code-sentinel-skills/issues/37) (the plugin repository, formerly `claude-code-plugin`). Line numbers are from `main` at 6539a5f, [Confirmed].

- **`hooks/eco_lib.py:34` `RUN_KIND = "skill"`.** Set it to `"manual"`, which the runner accepts since #475, and drop the TODO above it (`:31-33`). The runner already overrides the kind (`eco.ts:121-122`), so this is hygiene with no change in behaviour.
- **`hooks/eco_hook.py:271-272`, the correction row written when a soft denial is repeated.** It writes `rawBytes = hint` and `keptBytes = bytes + hint` with `bypassed = True`, which breaks two refines of `filterStatRowSchema` (`packages/shared/src/token-saver/contracts.ts:225-235`):
  - `keptBytes > rawBytes`;
  - a bypassed row must keep every byte.

  Fix: follow the runner's own convention (#616 Decisions, "Stats"; `apps/runner/src/filter/read-guard.ts:30`). Write a `bypassed` row with the denial's filter id and `rawBytes = keptBytes = 0`. The schema has no negative correction. #746 counts that row as a retry.
- **Tests:** the correction row passes `filterStatRowSchema`, checked against a fixture copied from the shared schema's refines.

Depends on #746
