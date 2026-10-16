# Card workers share the developer's test database

Issue: #389 · Board card: C-42 · Kind: bug

## What to do
A card worker running the API e2e suite in its worktree uses the shared `TEST_DATABASE_URL`. The e2e global setup drops the `public` schema, so parallel runs wipe each other.
- On 2026-10-15, C-15's worker hit other worktrees' test databases, and its last run hung with no output.
- Give each card worktree its own test database and port, the way orchestrator slots get them (`agentdock_<slot>_test`). Alternatively, tell card workers not to run the API e2e suite when CI covers it.

## Acceptance criteria
- [ ] Two card workers running the API e2e suite at the same time do not touch each other's database.
- [ ] The worker prompt or the worktree setup states which database and port to use.

## Out of scope
- Changing how CI runs the suites.

## Incident 2026-10-16 (C-39 and C-33)

- C-39's worker queued its e2e run behind C-33's worktree with a background `while pgrep -f "card-h74ymwpx/node_modules/.bin/jest"; do sleep 10; done` loop. `pgrep -f` matched the loop's own `zsh -c` command line, so it waited forever: about 7.5 h, three such loops. A person killed them by hand.
- C-33's worker could not run the full API e2e suite: Postgres hung in fsync while the other worktree ran its e2e on the same test database. Its PR (#385) went out with only the related e2e tests run.
- After the loops were killed, C-39's e2e global setup blocked on dropping the test schema: the killed runs had left connections open.

Additional acceptance criteria:

- [ ] A card worker never has to wait for another worktree's e2e run: each worktree's test database is its own. Database creation and schema reset happen in the e2e global setup.
- [ ] The e2e global setup does not hang on connections left by a killed run: it terminates the stale backends of its own test database before dropping the schema, or fails fast with a clear message.
- [ ] The card worker prompt says not to wait for other processes with `pgrep -f <pattern>`, because it matches its own command line. Use a lock file or the `[x]` pattern trick instead.
