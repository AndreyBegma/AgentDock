# C-140: Security [Low]: Make auth cookies Secure by default and tolerate malformed cookies

> Security audit 2026-10-16 · **WI-38** · severity **Low** · size **S** · findings: L-09 (Z1 L1, Z7 L4, Z7 I3)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-09.** Session cookies are `Secure` only when `APP_ENV === 'production'` (`apps/api/src/auth/cookies.ts:7`); the API image sets only `NODE_ENV` (`apps/api/Dockerfile`), so a deployment that forgets `APP_ENV` sends cookies over http. The web CSRF cookie reader calls `decodeURIComponent` without a guard (`apps/web/src/lib/api.ts:25-28`, also `attachments/format.ts`), so a malformed cookie throws. The live and terminal WebSocket URLs default to `ws://` (`apps/web/src/lib/live/client.ts:279`, `terminal/format.ts:17`).

**Attacker.** A network observer on a non-TLS hop; a sibling subdomain that can set cookies.

**Scenario.** A session cookie travels in cleartext on a misconfigured deploy; a planted malformed cookie breaks every API call in the web app.

**Impact.** Session theft; client-side denial of service.

## Fix
- Cookies are `secure: true` unless `APP_ENV` is `development` or `test`. Consider `__Host-` names.
- One web cookie reader with a `decodeURIComponent` try/catch, read at request time.
- Derive the live and terminal WebSocket URL from `location` (`wss:` on `https:`).
- Document `APP_ENV` in `apps/api/.env.example`.

## Acceptance criteria
- An API unit test: with `NODE_ENV=production` and `APP_ENV` unset, the session and CSRF cookies are `Secure`
- A web test: a malformed `csrf` cookie does not throw and the request goes out without it
- A WS-URL test: an https origin gives a `wss:` URL

## Touches
- apps/api/src/auth/cookies.ts
- apps/api/.env.example
- apps/web/src/lib/api.ts
- apps/web/src/lib/attachments/format.ts
- apps/web/src/lib/live/client.ts
- apps/web/src/lib/terminal/format.ts

## Decision
none needed

## Must not run in parallel with
- WI-63


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
