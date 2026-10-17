# C-206: Parallel card workers exhaust the dev Postgres connections running the api e2e suite

Issue: #487

## What happened
On 2026-10-16, three card workers (C-86, C-196, C-205) ran api tests at the same time on the shared dev Postgres. C-196 ran the whole e2e project by mistake. Postgres refused new connections (`sorry, too many clients already`), and the e2e suites of all three failed with unrelated errors, wasting rounds. The same storm crashed the host on 2026-10-13.

## Expected
- A card worker runs only the e2e suites it touched; the full suite runs in CI.
- Each card worker gets a bounded Prisma pool (`connection_limit` in its `TEST_DATABASE_URL`), so N parallel workers stay under `max_connections`.

## Do
- Card worker prompt (stable "how to work" section): never run the whole api e2e project locally; run `--testPathPatterns <your suites>`; CI runs the rest.
- The runner, when it writes a card worker's `TEST_DATABASE_URL`, adds `connection_limit=<n>` (e.g. 5) and `pool_timeout`.
- The e2e global setup fails fast with a clear message when the DB has no free connections, instead of 9-minute timeouts.

## Acceptance criteria
- [ ] Three card workers running their own e2e suites at once never hit `too many clients`.
- [ ] The worker prompt carries the rule (`worker-prompt.spec.ts`).
- [ ] `TEST_DATABASE_URL` of a card worker contains `connection_limit` (runner test).
