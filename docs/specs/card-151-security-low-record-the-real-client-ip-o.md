# C-151: Security [Low]: Record the real client IP on terminal audits

> Security audit 2026-10-16 · **WI-49** · severity **Low** · size **S** · findings: L-21 (Z3 F7)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-21.** The terminal gateway records `request.socket.remoteAddress` as the audit IP (`apps/api/src/terminal/terminal.gateway.ts:59`), which behind the web rewrite or a proxy is the proxy's address. The `/live` handshake has the same gap.

**Attacker.** Anyone using a terminal session they should not.

**Scenario.** An abuse investigation reads the terminal audit and finds only the proxy address.

**Impact.** Audit trail without the client IP for the most sensitive action (terminal write).

## Fix
Resolve the client IP with `proxy-addr` against `TRUST_PROXY`, as Express does for HTTP, in the terminal and live gateways (one helper).

## Acceptance criteria
- A gateway test with `X-Forwarded-For` from a trusted proxy records the client IP; from an untrusted peer it records the peer (regression test).

## Touches
- apps/api/src/terminal/terminal.gateway.ts
- apps/api/src/live/handshake.ts
- apps/api/src/common/client-ip.ts

## Decision
none needed


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
