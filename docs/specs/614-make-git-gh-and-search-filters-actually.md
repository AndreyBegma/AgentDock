# C-252: Make git, gh and search filters actually shorten their output

Issue: #614

## What to do
On the Token saver dashboard, `ops/git` returned the original in 12 of 13 runs, `lang/search` in 19 of 19 and `ops/gh` in 5 of 5. Local stats show `rawBytes == keptBytes` for every matched row.

Find out why each filter gives up: a minimum-size cutoff, a classifier that rejects the shape, or a mode that is never compact. Then make the filters compress the common agent invocations, borrowing rtk's strategies (group, truncate, dedup):
- `git status` (summary), `git diff` (stat header plus hunks, with long context collapsed), `git log` (one line per commit).
- `gh pr view` / `gh pr checks` / `gh run view --log` (failed steps only, plus a tail).
- `grep` / `rg` (group by file, cap matches per file with a count of what was dropped).

Error and warning lines are never removed. The raw file pointer is always printed (ADR-0039 D2).

## Acceptance criteria
- [ ] Each of the three filters has corpus fixtures for the invocations above, at realistic sizes, with kept/raw ratio ≤ 0.5 on the large fixtures.
- [ ] `corpus.spec.ts` still proves every error/warning line survives.
- [ ] Small outputs below the filter's threshold still pass through unchanged, and the threshold is a named constant with a comment explaining it.
- [ ] Output that is not shortened is still counted honestly (raw == kept) in stats.

## Out of scope
- Hook parsing of pipes and chains.
- New families beyond git, gh and search.

## Open questions
None.
