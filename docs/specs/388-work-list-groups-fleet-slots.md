# Group fleet slot cards by issue in the Work list and add a Fleet source

Issue: #388 · Board card: C-49 · Kind: bug

## What to do

The Work list (`apps/web/src/components/work/work-table.tsx`) shows each fleet slot of a parallel issue as its own row. Every row has the same title, the same issue number and the source "Card", so people read them as duplicates. Example: issue #359 shows as C-36, C-37 and C-38, which are the slots `i359-api`, `i359-runner` and `i359-web`, plus C-32 (`i359-contract`, Finished). Per ADR-0030 §4 these are correct: one `fleet` card per `(project, issue, slot)`. The list just never says which slot a row is.

Change the Work list as follows:

- **Group by issue.** When fleet cards share a project and `fleetIssue`, show one row for that issue. The row has an expand control. Expanding it shows one sub-row per slot with the slot name (`fleetSlot`), stage (`fleetStage`), status, PR and "Slot gone" when it applies. Reuse the wording of `fleetSummary` / `FleetFace` (`apps/web/src/components/board/card-face.tsx`, `apps/web/src/lib/board/format.ts`). A fleet issue with a single card stays a plain row.
- **Fleet source.** Add `fleet` to `WORK_SOURCES` (`packages/shared/src/work/types.ts`) with the label "Fleet" (`WORK_SOURCE_LABEL`, `apps/web/src/lib/work/format.ts`). `apps/api/src/work/work-query.service.ts` reports cards with `source: fleet` as `fleet` rather than `card`. The `source` query filter accepts `fleet`: `card` no longer includes fleet cards, and `fleet` returns only them. The Source dropdown (`work-filters.tsx`) offers "Fleet".

## Acceptance criteria

- [ ] With issue #359 dispatched as several slots, the Work list (filter Project: AgentDock) shows one row for #359, not one row per slot with the same title.
- [ ] Expanding the #359 row lists each slot (contract, api, runner, web) with its slot name, stage, status and PR. Collapsing it hides them again.
- [ ] The group row's status is the least advanced status among its visible slots (e.g. In progress while any slot is In progress). Its Updated time is the latest of its slots.
- [ ] With a status filter on, the group shows only the slots that match the filter. A group with no matching slot is hidden.
- [ ] Fleet rows show "Fleet" in the Source column. Person, terminal and planner cards still show "Card".
- [ ] The Source filter offers "Fleet". Choosing it shows only fleet rows, and choosing "Card" no longer shows fleet rows.
- [ ] Search by title, `C-n` or `#issue` still finds a fleet slot and shows it inside its group.
- [ ] An API spec in `work-query.service` covers the `fleet` source mapping and filter. A web test covers grouping (several slots of one issue → one group, a single-slot issue → a plain row).

## Out of scope

- Changing the fleet mirror model of ADR-0030 §4. Each slot stays its own `fleet` card on the Board and in the database, and nothing is merged or deleted.
- The Board view's card faces and columns.
- The Fleet page and the orchestrator.

## Open questions

- Should the expanded/collapsed state of each group persist across reloads? Default: groups start collapsed and the state is not persisted.
- Should the group row link to the issue's Fleet workspace? Default: the issue number links as it does today, and each slot sub-row opens its own card.
