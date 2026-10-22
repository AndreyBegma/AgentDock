# C-145: Security [Low]: Dedupe GitHub deliveries on the body hash, and scope the App's token

> Security audit 2026-10-16 · **WI-43** · severity **Low** · size **S** · findings: L-15 (Z2 INT-03), Z2 INT-12, Z2 INT-13
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-15.** `GitHubHookService` dedupes and routes on the `X-GitHub-Delivery` header, which the signature does not cover (`apps/api/src/github-app/github-hook.service.ts:118-150`). A captured signed body can be replayed under a new delivery id, and `installation` replays force resyncs (`:202`).

**INT-12.** Installation tokens are minted with the App's full permissions (`apps/api/src/github-app/github-client.ts:154`). **INT-13.** The manual webhook secret only needs to be non-empty (`apps/api/src/github-app/dto.ts:65-68`).

**Attacker.** Anyone who observed one signed delivery (proxy logs, a misconfigured relay), or who can guess a weak secret.

**Scenario.** Replaying a delivery under fresh ids stores it again and triggers repeated resyncs.

**Impact.** Duplicate state, GitHub API quota burn, and a broader blast radius for any leaked installation token.

## Fix
Dedupe on `sha256(rawBody)` as well as the delivery id. Debounce delivery-triggered resyncs to one a minute. Check `installation.id` against known installations before routing. Mint installation tokens with the minimum permissions each call needs (`{"permissions":{"metadata":"read"}}` for health, explicit sets otherwise). Require `@MinLength(20)` on the manual webhook secret.

## Acceptance criteria
- An e2e test replays the same signed body with a new delivery id; it is stored once (regression test).
- Two `installation` replays within a minute cause one resync.
- The DTO refuses a webhook secret shorter than 20 characters (400).
- A client test shows the access-token request carries an explicit `permissions` object.

## Touches
- apps/api/src/github-app/github-hook.service.ts
- apps/api/src/github-app/github-client.ts
- apps/api/src/github-app/dto.ts
- apps/api/src/github-app/*.spec.ts

## Decision
none needed

## Must not run in parallel with
- WI-14


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
