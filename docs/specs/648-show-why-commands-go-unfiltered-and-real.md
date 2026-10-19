# C-256: Show why commands go unfiltered and real cache savings on Token saver

Issue: #648

## What to do
The Token saver screen (`apps/web/src/components/token-saver/`, `apps/web/src/lib/token-saver/format.ts`) lumps everything into "No filter (uncovered command)". Runners released so far (≤ 0.12.2) write a plain `none`; the `none:compound` / `none:uncovered` / `none:mode` reasons from amendment 12 are merged but unreleased. Nobody can tell from the page why savings are ≈ $0.

- Add the program name (argv[0] plus the subcommand, e.g. `git log`, never arguments) to the filter stat row: runner `stats.ts`, `packages/shared/src/token-saver/contracts.ts`, API storage.
- On the dashboard:
  - Split "No filter" by reason, with the legacy `none` labelled "No filter (runner too old to say why)".
  - Add a table of the most frequent unfiltered programs.
  - Add a tile with the measured prompt-cache read share and input tokens per run kind, from the usage data already stored (ADR-0003, ADR-0009).
- Note on the page when the reporting runner is older than the version that sends reasons.

## Acceptance criteria
- [ ] Stat rows carry an optional `program` field (no arguments, max 64 chars); old rows without it are still accepted.
- [ ] "No filter" shows separate rows for compound, uncovered, mode and legacy `none`.
- [ ] A "Most frequent unfiltered programs" table lists the top 10 programs with command counts.
- [ ] A tile shows cache read share and average input tokens per run for the selected period, per run kind, from usage records — not the filter estimate.
- [ ] Built only with glass-ui components (ADR-0011); format and summary tests updated.

## Out of scope
- Changing filters or the hook.
- Cutting a runner release (tags are protected, ADR-0049; a person does it).

## Open questions
None.
