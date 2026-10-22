# C-142: Security [Low]: Validate TRUST_PROXY at boot and document it per topology

> Security audit 2026-10-16 · **WI-40** · severity **Low** · size **S** · findings: L-46 (Z6 W-6, Z3 P2-4)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-46.** `TRUST_PROXY` is parsed into Express's `trust proxy` (`apps/api/src/configure-app.ts:8-23`). With `true`, or with a hop count that does not match the topology, and the Next.js `/api` rewrite in front (`apps/web/next.config.ts`), the API trusts a client-forged `X-Forwarded-For`.

**Attacker.** Any client of the API.

**Scenario.** A forged `X-Forwarded-For` changes the IP the API sees.

**Impact.** Per-IP throttles (login) and audit IPs can be evaded or poisoned.

## Fix
- Refuse `TRUST_PROXY=true` at boot when `APP_ENV=production`; require a hop count or an address list.
- Document the value for each topology (single host, nginx in front of Next, staging behind Caddy and cloudflared) in `apps/api/.env.example` and `deploy/README.md`.

## Acceptance criteria
- A `configure-app` unit test: boot fails with `TRUST_PROXY=true` in production and succeeds with a hop count
- `apps/api/.env.example` and `deploy/README.md` list the value per topology

## Touches
- apps/api/src/configure-app.ts
- apps/api/.env.example
- deploy/README.md

## Decision
none needed

## Must not run in parallel with
- WI-32
- WI-49


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
