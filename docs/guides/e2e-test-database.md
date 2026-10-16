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
  worktree can copy the main checkout's `apps/api/.env` as it is. It also
  bounds the card's pools (#487): `connection_limit=5` and `pool_timeout=10`,
  unless the URL sets its own.
- `AGENTDOCK_CARD_PORT` — a port for a server the worker starts, from
  20000–29999, derived from the short id: the same on every round. The e2e
  suite needs none: its apps listen on port 0.

The card worker's prompt (`CARD_WORKER_PROMPT_VERSION` 7) names both. Since
version 13 (#487) it also limits a card to the e2e suites it touched
(`--testPathPatterns`); CI runs the whole suite.

## What a run does to its database

The e2e global setup (`apps/api/src/test/global-setup.ts`):

1. checks the server has room for the run — one pool of `connection_limit`
   (pg's 10 without it) per Jest worker — and fails at once, saying so, when
   it does not; a connect that fails or takes over 10 s fails the same way;
2. creates the database if it is missing — a new card needs no setup step;
3. ends every other session on it (`pg_terminate_backend`): the connections a
   killed run left, which would otherwise hold the next step forever;
4. drops and recreates the `public` schema under a 10 s `lock_timeout` — a lock
   still held after that fails the run with a message naming the database,
   never a hang;
5. applies every migration (`prisma migrate deploy`);
6. drops and re-clones the per-worker databases from it.

Step 3 ends another run of the suite on the same database too. That run was
going to be wiped anyway; give each checkout its own database instead.

## Connections

Card workers run their e2e suites on one dev server at once. Three of them —
one running the whole e2e project — once filled its `max_connections`
(`sorry, too many clients already`) and failed all three (#487). So a card
runs only the suites it touched, each of its Jest workers holds a pool of at
most 5 connections, and a query waits at most 10 s for one. Prisma's
`connection_limit` and `pool_timeout` are read by `pgPoolConfig`
(`apps/api/src/database/pool-config.ts`): the pg driver adapter ignores them
in the URL, so they work for any `DATABASE_URL` too.

## Waiting for another process

Never wait for another process with `pgrep -f <pattern>`: the pattern is on the
waiting shell's own command line, so it always matches and the wait never
ends. Use a lock file, or a pattern that cannot match itself
(`pgrep -f '[j]est'`). A worktree with its own database never needs to wait on
another worktree's run.
