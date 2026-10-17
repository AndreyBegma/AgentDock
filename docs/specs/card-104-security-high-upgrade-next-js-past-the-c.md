# C-104: Security [High]: Upgrade Next.js past the critical advisories

> Security audit 2026-10-16 · **WI-02** · severity **High** · size **S** · findings: F-02 (Z1 I7, Z6 hardening #6, promoted after `bun audit`)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
`apps/web/package.json:28` pins `next` at `16.2.3`. `bun audit` reports 3 critical advisories for it (RCE in `next/og` ImageResponse, which `apps/web/src/app/apple-icon.tsx` uses; RCE in Image Optimization with AVIF; a Windows RCE) and 19 high ones (proxy-bypass variants, SSRF in rewrites, which the `/api` rewrite in `apps/web/next.config.ts` uses, and DoS). `sharp@0.34.5` is high too.

**Attacker.** Any unauthenticated internet client that can reach the web app (staging is public).

**Scenario.** Known, published advisories against the exact version in use.

**Impact.** Code execution on the web container, bypass of the `proxy.ts` auth gate, SSRF through the rewrite.

## Fix
- Bump `next` to the latest 16.x at or above the fixed release (exact pin, no caret), and `sharp` with it.
- Run `bun install` to update `bun.lock` and re-run `bun audit`.

## Acceptance criteria
- `bun audit` lists no `next` or `sharp` advisory
- `bun run build` and the web tests pass
- `/apple-icon` still renders
- Smoke test: login works through the `/api` rewrite and an unauthenticated page redirects to `/login` (`proxy.ts` gating)

## Touches
- apps/web/package.json
- bun.lock

## Decision
none needed

## Must not run in parallel with
- WI-27
- WI-71


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
