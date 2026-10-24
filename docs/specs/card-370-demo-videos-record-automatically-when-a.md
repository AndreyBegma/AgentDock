# C-370: Demo videos: record automatically when a UI card turns green, and "Record again"

Stack "Demo videos of finished cards", stage 2 (Features). Needs both stage-1 cards.

## What
- When a **feature** card's PR is green (and review passed, if on — ADR-0084) and the PR changes files matching the project's `demoUiPaths`, the Board creates a `card_demos` row (`auto`) and sends `card.demo` to the project's runner. Bugs and non-UI cards get no auto demo.
- **Never blocking:** the card moves to Finished as before. Auto-merge (when the project has it) waits for the demo to be `ready`/`failed`/`skipped` with a 15-minute cap, so the person can watch before an auto-merge; with merge policy `ask` nothing changes.
- A new head after a fix round supersedes a running demo; the new head gets a new demo.
- **"Record again"** (`POST …/demos`, manual) works on any card with a PR, any column except Completed.
- Runner offline / DemoFlow not ready → `skipped` with the reason; no retries loop.
- Activity entries for demo ready/failed; the card's `needsPerson` is not set by a failed demo.

Tests: trigger rules (feature vs bug, path match), supersede on new head, auto-merge wait and cap, manual on any column.

## Design (as built)

The decisions are recorded in [ADR-0095](../adr/0095-auto-merge-waits-up-to-fifteen-minutes-for-a-cards-demo-video.md).

- **Shared** (`packages/shared/src/demos`): `touchesDemoUiPaths` matches a PR's
  changed files against `demoUiPaths` (`**`, `*`, `?`). `DEMO_MERGE_WAIT_MS`
  (15 minutes) caps the merge wait; `DEMO_STALE_MS` (30 minutes) marks a demo
  the runner never finished. `card.demo_ready` and `card.demo_failed` are
  activity rules. Two error codes: `no_pull_request`, `card_completed`.
- **Data**: `card_demos.headSha` (migration `20261231000024_card_demo_head`) —
  the PR head a demo records. One `auto` demo per head.
- **API** (`apps/api/src/demos`): `DemoRunner` sends `card.demo` and says why a
  runner cannot take it (offline, not served, disabled, no `cardDemo`
  capability). `CardDemosService` gains `autoRecord`, `supersede`,
  `holdsMerge` and `onSettled`; "Record again" now dispatches, and refuses a
  card without a PR or in Completed.
- **Board** (`apps/api/src/board/board-shipping.ts`): the shipping check asks
  for a demo of the head that ships (before auto-merge, and for a Finished green
  card that is not merged automatically), supersedes older demos on a new head,
  and returns from auto-merge while a demo younger than 15 minutes is active. A
  demo ending re-checks the card; the poll keeps reading a Finished green card
  with a recent demo.
- **Runner** (`apps/runner/src/demos/recorder.ts`): DemoFlow not ready is
  `skipped`, with the reason.
- **Tests**: `apps/api/src/board/board-demos.e2e.spec.ts` (trigger rules,
  supersede, merge wait and cap, policy off), `apps/api/src/demos/demos.e2e.spec.ts`
  (manual in every column but Completed, PR required, runner skip and refusal,
  activity, no `needsPerson`), `packages/shared/src/demos/ui-paths.spec.ts`.
