# The API e2e suite's test database

The API e2e suite (`apps/api`, `*.e2e.spec.ts`) owns a PostgreSQL database and
wipes it on every run. Two runs on one database wipe each other, so every
checkout that runs the suite needs a database of its own (#389).

## Which database a checkout uses

| Checkout | Database | Where it comes from |
|---|---|---|
| Main checkout | `agentdock_test` | `TEST_DATABASE_URL` in `apps/api/.env` |
| Orchestrator slot (`.wt-AgentDock-<slot>`) | `agentdock_<slot>_test` | the slot's `apps/api/.env`, written at dispatch |
| Board card (`.wt-AgentDock-card-<id>`) | `agentdock_card_<id>_test` | `TEST_DATABASE_URL`, renamed after `AGENTDOCK_CARD` |

Each of them is the template of one clone per Jest worker:
`agentdock_test` → `agentdock_1_test`, `agentdock_2_test`, …;
`agentdock_card_<id>_test` → `agentdock_card_<id>_1_test`, ….

The runner sets two variables in a board card's session (`apps/runner`,
`cardEnv`), on every round:

- `AGENTDOCK_CARD` — the card's short id (8 characters, `a-z0-9`). With it set,
  `testDatabaseUrl()` (`apps/api/src/test/test-database.ts`) keeps the server
  of `TEST_DATABASE_URL` and names the database after the card. A card's
  worktree can copy the main checkout's `apps/api/.env` as it is.
- `AGENTDOCK_CARD_PORT` — a port for a server the worker starts, from
  20000–29999, derived from the short id: the same on every round. The e2e
  suite needs none: its apps listen on port 0.

The card worker's prompt (`CARD_WORKER_PROMPT_VERSION` 7) names both.

## What a run does to its database

The e2e global setup (`apps/api/src/test/global-setup.ts`):

1. creates the database if it is missing — a new card needs no setup step;
2. ends every other session on it (`pg_terminate_backend`): the connections a
   killed run left, which would otherwise hold the next step forever;
3. drops and recreates the `public` schema under a 10 s `lock_timeout` — a lock
   still held after that fails the run with a message naming the database,
   never a hang;
4. applies every migration (`prisma migrate deploy`);
5. drops and re-clones the per-worker databases from it.

Step 2 ends another run of the suite on the same database too. That run was
going to be wiped anyway; give each checkout its own database instead.

## Waiting for another process

Never wait for another process with `pgrep -f <pattern>`: the pattern is on the
waiting shell's own command line, so it always matches and the wait never
ends. Use a lock file, or a pattern that cannot match itself
(`pgrep -f '[j]est'`). A worktree with its own database never needs to wait on
another worktree's run.
