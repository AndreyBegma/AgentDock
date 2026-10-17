# C-134: Security [Medium]: Cap request bodies, add headers at the staging proxy, and support Cloudflare Access service tokens in the runner

> Security audit 2026-10-16 · **WI-32** · severity **Medium** · size **M** · findings: F-32 (Z9 M5), repo part
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**F-32.** Staging is a public control plane with no access layer: login, register, pairing, hooks and the WebSockets are reachable from the internet through the tunnel (`deploy/staging/docker-compose.yml:98-122`). The Caddyfile (`deploy/staging/Caddyfile:20-35`) proxies `/api/*` and everything else with no `request_body` limit and no security headers. The runner cannot pass an access layer: it sends only `Authorization: Bearer` on the WebSocket (`apps/runner/src/connection.ts:54`) and only `content-type` on pairing (`apps/runner/src/pairing.ts:44`).

**Attacker.** Anyone on the internet.

**Scenario.** Unauthenticated callers reach every pre-auth surface of the API that drives the agent host's runners, and can send arbitrarily large bodies through the proxy.

**Impact.** The full pre-auth attack surface of a machine that executes what the API tells it, plus resource exhaustion.

## Fix
Per D-07 (staging behind Cloudflare Access with service tokens; `/hooks/*` stays open; setup is person-only P-04):
- Caddy: `request_body { max_size 10MB }`, HSTS, `X-Content-Type-Options`, and no caching for `/api/runners/pair` and `/api/hooks/*`.
- Runner: optional Cloudflare Access service-token support. `agentdock-runner pair --access-client-id <id> --access-client-secret <secret>` (or the secret from stdin/env) stores both in `runner.json` (0600); the runner sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` on the pairing request and on every WebSocket connect. The secret is never printed (status shows `access token: set`).
- `deploy/README.md`: the Access application, which paths need service tokens (`/api/runner`, `/api/runners/pair`), which stay open (`/api/hooks/*`), and how to pair a runner behind Access.

## Acceptance criteria
- `caddy validate` passes on the new Caddyfile (a CI step or a documented local check)
- On staging, a 20 MB POST to `/api/…` gets 413
- A runner unit test: with access credentials configured, the pairing request and the WebSocket upgrade carry both `CF-Access-*` headers; without them, neither header is sent
- A runner test: `status` and logs never contain the access secret; `runner.json` is written 0600
- `deploy/README.md` documents the Access policy, the service-token paths and the open `/api/hooks/*` path

## Touches
- deploy/staging/Caddyfile
- deploy/README.md
- apps/runner/src/connection.ts
- apps/runner/src/pairing.ts
- apps/runner/src/config.ts
- apps/runner/src/cli.ts

## Decision
D-07 — staging behind Cloudflare Access with service tokens for runners and pairing, `/hooks/*` open; the Access setup itself is person-only P-04 (00-decisions.md)

## Must not run in parallel with
- WI-20
- WI-06
- WI-03
- WI-04
- WI-40


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
