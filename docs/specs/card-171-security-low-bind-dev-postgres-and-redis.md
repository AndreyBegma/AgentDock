# C-171: Security [Low]: Bind dev Postgres and Redis to loopback and generate dev passwords

> Security audit 2026-10-16 · **WI-69** · severity **Low** · size **S** · findings: L-40 (Z9 L6)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
`docker/docker-compose.yml:13` (`"5421:5432"`) and `:38` (`"6421:6379"`) publish Postgres and Redis on all interfaces; `docker/.env.example:2,4` suggests `change-me` passwords.

**Attacker.** Anyone on the same network as a developer machine.
**Scenario.** A developer copies the example env, and the dev database is reachable on the LAN with a known password.
**Impact.** Read and write access to dev data, which can include runner tokens and sealed secrets of a dev install.

## Fix
Bind `127.0.0.1:5421:5432` and `127.0.0.1:6421:6379`. Leave the example passwords empty and have `scripts/db-start-docker.sh` generate random ones into `docker/.env` (and the matching `apps/api/.env` URLs) when they are missing.

## Acceptance criteria
- `docker compose -f docker/docker-compose.yml config` shows loopback binds only.
- `bun run db:setup` from a clean clone generates passwords and completes.
- No `change-me` remains in any `.env.example`.

## Touches
- docker/docker-compose.yml
- docker/.env.example
- apps/api/.env.example
- scripts/db-start-docker.sh

## Decision
none needed

## Must not run in parallel with
- WI-38
- WI-40


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
