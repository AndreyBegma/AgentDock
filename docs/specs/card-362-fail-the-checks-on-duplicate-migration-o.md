# C-362: Fail the checks on duplicate migration or ADR numbers

## What to do
Parallel cards pick the next migration and ADR number from the same base, so they collide. On 2026-10-23 three PRs used `apps/api/prisma/migrations/20261231000020_*` and two used `docs/adr/0084-*`; each was caught only by hand. Add a small script (e.g. `scripts/check-numbering.ts`, run by `bun run check` so CI gets it without touching `.woodpecker/**`) that fails when:
- two directories in `apps/api/prisma/migrations/` share the same timestamp/number prefix;
- two files in `docs/adr/` share the same four-digit number;
- `docs/adr/README.md` has an index row whose number has no file, or a file with no row.

PR pipelines build the merge ref, so a PR that collides with an already-merged number turns red before it can merge. The error names the colliding paths and says to take the next free number from `origin/develop`.

## Acceptance criteria
- [ ] `bun run check` fails with a clear message naming both paths on a duplicate migration prefix, and on a duplicate ADR number.
- [ ] It fails on an ADR README row without a file and on an ADR file without a row.
- [ ] It passes on the current develop.
- [ ] Unit tests cover each failure and the clean case.
- [ ] No change under `.woodpecker/**`.

## Out of scope
- Reserving numbers on the Board.
- Renumbering existing migrations or ADRs.
