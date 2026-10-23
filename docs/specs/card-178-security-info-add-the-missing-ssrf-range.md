# C-178: Security [Info]: Add the missing SSRF ranges to the outbound guard

> Security audit 2026-10-16 · **WI-76** · severity **Info** · size **S** · findings: Z2 INT-14
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
`apps/api/src/webhooks/common/ssrf-guard.ts:42-65` blocks the usual private ranges but not `fec0::/10` (site-local), `64:ff9b:1::/48` (local NAT64), `2001::/32` (Teredo), `100::/64` (discard) or the TEST-NETs.

**Attacker.** An admin configuring an outbound webhook, or anyone who controls DNS for its host.
**Scenario.** A webhook host resolves to an address in an unlisted range that routes to an internal network.
**Impact.** Requests from the API to internal services.

## Fix
Add `fec0::/10`, `64:ff9b:1::/48`, `2001::/32`, `100::/64`, `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24` to the blocklist.

## Acceptance criteria
- Guard test: an address in each new range is refused; a public address is still allowed.

## Touches
- apps/api/src/webhooks/common/ssrf-guard.ts

## Decision
none needed


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
