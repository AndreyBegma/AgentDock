# C-129: Security [Medium]: Add security headers and a nonce-based CSP to the web app

> Security audit 2026-10-16 · **WI-27** · severity **Medium** · size **M** · findings: F-27 (Z6 W-1); primary control for F-28 (`frame-src 'self'`)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**F-27.** The web app sends no security headers. `apps/web/next.config.ts:5-13` only sets `output`, `reactStrictMode`, `transpilePackages` and the `/api` rewrite: there is no `Content-Security-Policy`, no `frame-ancestors` / `X-Frame-Options`, no HSTS, no `Referrer-Policy`, no `Permissions-Policy`, and `X-Powered-By` stays on. The staging proxy (`deploy/staging/Caddyfile:20-35`) adds none either. The theme bootstrap is an inline script (`apps/web/src/app/layout.tsx:55`).

**Attacker.** A third-party page the operator visits, or attacker-controlled content rendered in the app (a mockup, Markdown).

**Scenario.** The app can be framed by another origin (clickjacking on one-click approve or merge buttons), and any injected script or frame has no policy to stop it.

**Impact.** No defence in depth for a control plane whose buttons run code on developer machines.

## Fix
- Generate a per-request nonce in `apps/web/src/proxy.ts` and pass it to the layout.
- Set `Content-Security-Policy`: `default-src 'self'; script-src 'self' 'nonce-…'; frame-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'` (plus `connect-src` for the live/terminal WebSocket origin).
- Set `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera, microphone, geolocation off), `X-Content-Type-Options: nosniff`, HSTS when served over TLS, and `poweredByHeader: false`.
- Nonce the theme bootstrap script in `layout.tsx`.

## Acceptance criteria
- A test (proxy unit test or Playwright check) on `/login` and on a project page asserts every header listed in the fix, including a CSP with a per-request nonce
- `X-Powered-By` is absent from responses
- The theme bootstrap script runs (no flash of the wrong theme) and carries the nonce
- The design viewer still loads a mockup in its sandboxed iframe
- No CSP violation is logged in the browser console on the main pages (login, board, card sheet, design viewer, terminal)

## Touches
- apps/web/next.config.ts
- apps/web/src/proxy.ts
- apps/web/src/proxy.test.ts
- apps/web/src/app/layout.tsx

## Decision
none needed

## Must not run in parallel with
- WI-02
- WI-28


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
