# C-118: Security [Medium]: Evict pre-hello runner sockets on re-pair and revoke

> Security audit 2026-10-16 · **WI-16** · severity **Medium** · size **S** · findings: F-16 (Z3 F1)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
F-16 (Z3 F1). The runner token is verified at WebSocket upgrade (`apps/api/src/runners/runner-ingest.service.ts:86-89`), but `hello` later updates the runner with `where: { id: runnerId, revokedAt: null }` (`:102`) and never re-checks the token hash. `PairingService.pair` (`pairing.service.ts:73-130`) writes a new `tokenHash` and `revoke` sets `revokedAt`, but neither closes sockets that upgraded with the old token and have not sent `hello` yet (`runner.gateway.ts:57-63,80`).

**Attacker.** Someone holding a runner token that is about to be rotated (for example one read from `runner.json` by an agent, F-07).

**Scenario.** The holder opens a socket with the old token and stays silent; the owner re-pairs to rotate the token; the stale socket then sends `hello` and becomes the live runner connection.

**Impact.** Re-pairing does not evict a stolen token, so the attacker keeps receiving commands and content meant for the runner.

## Fix
- At upgrade, keep the verified `tokenHash` on the socket context.
- In `ingest.hello`, update with `where: { id, revokedAt: null, tokenHash: verifiedHash }`; zero rows means close with 4401.
- Track pre-hello sockets per runner in `runner-connections.ts` and close them (4401) in `PairingService.pair` and `revoke`.

## Acceptance criteria
- E2e regression test: open a socket with token T1 and send no hello; re-pair (T2); send hello on the old socket — it is closed 4401, and no row is updated.
- The new runner with T2 connects, sends hello and stays live.
- Revoking a runner closes its pre-hello sockets.

## Touches
- apps/api/src/runners/runner-ingest.service.ts
- apps/api/src/runners/runner.gateway.ts
- apps/api/src/runners/runner-connections.ts
- apps/api/src/runners/pairing.service.ts
- apps/api/test/**

## Decision
none needed

## Must not run in parallel with
- WI-06
- WI-35


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
