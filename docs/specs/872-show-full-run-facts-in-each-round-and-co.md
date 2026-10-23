# C-332: Show full run facts in each round and collapse long blocks

Issue: #872

## What to do
Rework the round item built by `roundItems` in `apps/web/src/components/board/card-sheet.tsx` (shown in the Rounds tab) to the approved design. Each round shows, compactly: model and effort (`CardRoundView` model/effort/class), duration from `startedAt` to `finishedAt`/`endedAt` plus time spent waiting (`waitingAt`, `backgroundAt`), tokens and token-saver savings on one line (`tokenSaved`, `tokenSaverFilters` total), cost, the round's PR / head commit / CI state (new fields from the API card), and exit code, restart mode and warmup (`exitCode`, `restartMode`, `restartEstimate`, `warmupTokens`, `warmupMs`). The agent summary is clamped to 3–4 lines with a "Show all" toggle; the per-filter `FilterBreakdown` is collapsed behind the one-line token total and expands on click. Fields that are null are omitted, not shown as empty.

## Acceptance criteria
- [ ] A finished round shows model, effort, duration, waiting time, tokens with savings, cost, PR + CI, exit code, restart mode and warmup when present.
- [ ] A round's null fields are not rendered; an in-progress round shows a running duration.
- [ ] The round summary is clamped by default and expands with "Show all"; the token-saver breakdown is collapsed to one line and expands on click.
- [ ] With three finished rounds like C-61's, all three round headers fit on one desktop screen.
- [ ] Feedback text, attachments, errors, blocking dialog, finish-refused and background command still render as today.
- [ ] Tests cover the new fields, null omission and both collapse toggles.
- [ ] `bun run check` passes.

## Out of scope
- Changing the tabs/header layout.
- Adding new fields to the API beyond those of the PR/CI card.

## Open questions
- Does the round item on the standalone card page start expanded? Default: no, it uses the same collapsed default as the sheet; the page card decides extra detail.
