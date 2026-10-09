# Runner pairing, gateway and runners admin

Issue: [#6](https://github.com/AndreyBegma/AgentDock/issues/6) · Roadmap: M1.3 (part b) ·
Decisions: [ADR-0001](../adr/0001-control-plane-and-per-machine-runner.md),
[ADR-0006](../adr/0006-runtime-adapters-and-runtime-profiles.md),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md),
[runner-protocol.md](../architecture/runner-protocol.md), [security.md](../architecture/security.md)

## Summary

The server half of the runner: an admin creates a runner and gets a one-time
pairing code, the runner from #5 exchanges it for a token, connects to the
`/runner` WebSocket gateway, and appears in an admin page with its status,
capabilities and runtime profiles; the admin can ping, rename and revoke it.
Events received are stored. This closes the loop M1.4+ builds on.

## Scope

### In scope

- Tables `runners`, `runner_pairing_codes`, `runtime_profiles`, `events`.
- Pairing endpoints; `/runner` WebSocket gateway (auth, hello/welcome, heartbeat,
  events + ack, command round-trip).
- A `RunnerCommandService` other modules call to send typed commands and await
  results.
- Admin API and the `/admin/runners` page.

### Out of scope

- Projects (M1.4), collectors and their projections (M1.5+).
- UI live updates over WebSocket (M1.8) — the page polls every 10 s.
- Audit records — M1.2 retrofits: runner created, paired, revoked, renamed,
  command sent.

## Decisions

The person delegated all decisions on 2026-10-07; each below is the default
taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | Pairing code: 8 characters from an unambiguous alphabet, shown as `XXXX-XXXX`, valid 10 minutes, single use, stored as SHA-256. Creating a runner returns the code once together with the install / pair command | runner-protocol.md |
| D2 | Runner token: 32 random bytes, base64url, returned once by `POST /runners/pair`; stored as argon2id hash plus a non-secret 8-character prefix (`tokenPrefix`) to find the row without scanning | security.md |
| D3 | Gateway: `@nestjs/websockets` with the `ws` adapter on path `/runner`, same port as the API. Auth from `Authorization: Bearer` on the upgrade request. The upgrade itself is accepted and a missing, unknown or revoked token is closed **4401** before any frame is processed — an HTTP 401 on the upgrade reaches the #5 daemon as 1006 and it would reconnect forever; 4401 is the code it stops on. Protocol version mismatch → close 4400 with the supported version. A first frame other than `hello` → close 1008 | runner-protocol.md; amended at implementation |
| D4 | One live socket per runner; a new connection replaces the old one (old closed 4409) | new |
| D5 | Status is derived: `online` while a socket is open and the last heartbeat is < 45 s old, `stale` after that, `offline` with no socket; `lastSeenAt` updated on every heartbeat | new — real connection state, not file mtimes (Mission Control lesson) |
| D6 | Events persisted to `events` with unique `(runnerId, seq)`; duplicates ignored; `ack` sends the highest contiguous persisted `seq`. Partitioning by month is deferred until volume requires it (ADR-0007 allows it) | ADR-0007, runner-protocol.md |
| D7 | `runtime_profiles` mirrors the profiles in each `hello`: upsert by `(runnerId, key)`, rows absent from the latest hello marked `missing`, never deleted (later runs reference them) | ADR-0006 |
| D8 | `RunnerCommandService.send(runnerId, name, args, { timeoutMs })` validates against the protocol allowlist, checks the caller's role against the command's minimum role, returns the result or `unknown` on timeout. At-most-once: no retries | runner-protocol.md |
| D9 | Admin only for everything in this item (create, list, ping, rename, revoke); later items expose runner info to other roles through projects | ADR-0008 |
| D10 | Revoke: sets `revokedAt`, closes the socket with 4401, keeps the row and its events | security.md |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261009000000_runners/`.
New tables only; `runners.createdById` references `users` (from #3).

| Table | Fields |
|---|---|
| `runners` | `id`, `name`, `hostname?`, `version?`, `protocolVersion?`, `os?`, `arch?`, `capabilities` Json?, `tokenHash?`, `tokenPrefix?` unique, `ackedSeq` BigInt default 0, `pairedAt?`, `lastSeenAt?`, `revokedAt?`, `createdById?` → users (on delete set null), `createdAt`, `updatedAt` |
| `runner_pairing_codes` | `id`, `runnerId` → runners, `codeHash` unique, `expiresAt`, `usedAt?`, `createdAt` |
| `runtime_profiles` | `id`, `runnerId` → runners, `key`, `runtime` (`claude` \| `codex`), `label`, `binary?`, `env` Json (paths only), `args` Json, `authenticated` Bool, `missing` Bool default false, `updatedAt`; unique `(runnerId, key)` |
| `events` | `id` BigInt autoincrement, `runnerId` → runners, `seq` BigInt, `ts`, `type`, `source`, `projectRepo?`, `projectRoot?`, `slot?`, `issue?` Int, `session` Json?, `data` Json, `receivedAt`; unique `(runnerId, seq)`; index `(type, ts)` |

Amended at implementation (approved on #6):

- `runners.ackedSeq` holds the ack cursor (`welcome.ackedSeq`, `ack.seq`), advanced with `GREATEST` so a replaced connection finishing late never moves it back. A persisted `runner.spool_truncated` range counts as filled (runner-protocol.md "Delivery guarantees").
- `runners.createdById` is nullable with `ON DELETE SET NULL`: deleting the admin who created a runner must not fail or take the runner with it.
- `runtime_profiles.key` and `label` are both the profile `id` — the merged `runtimeProfileSchema` has no label; `binary` is mirrored because the profile carries it.
- `events.session` and `events.projectRoot` keep the envelope fields the table had dropped; data dropped on ingest cannot be recovered later (M1.5 projections need the session).
- The admin API's response types live in `@agentdock/shared` (`packages/shared/src/runners/`): `AdminRunner`, `AdminRunnerDetail`, `PairingCodeResponse`, `PingResult`, `RunnerStatus`, `RUNNER_ERROR`.
- A runner never paired reads `offline`, with `pairedAt: null`.

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| POST | `/admin/runners` | admin | `{ name }` → `{ runner, pairingCode, expiresAt, command }` |
| POST | `/admin/runners/:id/pairing-code` | admin | new code for an unpaired or re-pairing runner; invalidates earlier unused codes |
| GET | `/admin/runners` | admin | list with derived status, version, profiles count |
| GET | `/admin/runners/:id` | admin | detail: capabilities, profiles, last 50 events |
| PATCH | `/admin/runners/:id` | admin | `{ name }` |
| POST | `/admin/runners/:id/ping` | admin | sends `runner.ping` through `RunnerCommandService` (5 s timeout); `PingResult`: `{ status: 'ok', rttMs, ts }`, `{ status: 'error', error }`, or `{ status: 'unknown' }` — at once when offline or revoked, at the timeout when unanswered |
| POST | `/admin/runners/:id/revoke` | admin | D10 |
| POST | `/runners/pair` | public (`@Public()`), throttled 10/min/IP | `{ code, hostname, version, protocolVersion }` → `{ runnerId, token }`; invalid/expired/used → 400 `invalid_code` |
| WS | `/runner` | runner token | gateway per D3–D7 |

## UI

`/admin/runners` (glass-ui, plain page like #3's admin pages):

- table: name, status dot (`Badge` dot: online ok, stale warn, offline neutral, revoked danger), hostname, version, profiles, last seen;
- "Add runner" dialog → name → shows the pairing code, its expiry countdown and the copyable command `agentdock-runner pair --server <origin> --code XXXX-XXXX`;
- detail sheet: capabilities (key/value), profiles with runtime and authenticated flag, recent events, actions Ping / Rename / New pairing code / Revoke (confirm dialog).

## Acceptance criteria

- [ ] Creating a runner returns a code once; pairing with it returns a token; using the same code again returns 400 `invalid_code`; a code older than 10 minutes returns 400.
- [ ] The #5 daemon pairs and connects against the real API: the runner shows `online` with its capabilities and profiles within 20 s.
- [ ] Stopping the daemon turns the status `stale` after 45 s and `offline` when the socket closes.
- [ ] Events sent by the runner are stored once even when the runner resends after a reconnect; `ack` carries the highest contiguous `seq`.
- [ ] Ping from the admin page returns a round-trip time; pinging an offline runner returns `unknown` after the timeout without hanging the request beyond it.
- [ ] Revoking closes the socket with 4401; the daemon's reconnects are refused; the row and events remain.
- [ ] A WebSocket upgrade with no token, a wrong token or a revoked token is refused; a wrong protocol version closes with 4400.
- [ ] **Authorization:** `operator` and `viewer` get 403 on every `/admin/runners*` route; anonymous gets 401 on them; only `/runners/pair` is public.
- [ ] Tokens and pairing codes never appear in logs or in any response other than the one that creates them; the database holds only hashes.
- [ ] `bun run check`, `bun run test`, `bun run build` pass; gateway and pairing covered by e2e tests that run the #5 runner client (or its protocol client module) against the API.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i6-api | schema, migration, runners module, gateway, command service | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261009000000_runners/**, apps/api/src/runners/**, apps/api/src/app.module.ts, apps/api/src/main.ts, apps/api/package.json, bun.lock | — | yes | opus |
| i6-web | `/admin/runners` page | apps/web/src/app/admin/runners/**, apps/web/src/lib/runners/** | i6-api | no | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i6-api | do not open it |
| apps/api/src/app.module.ts, apps/api/src/main.ts | i6-api | do not open them |
| bun.lock | regenerated per the rule in [#5's spec](5-runner-daemon-and-protocol.md#contention) | — |

Depends on #3

Depends on #5

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Express-based Nest app and `ws` gateway on one port behind a reverse proxy | low | document the proxy's `Upgrade` headers in the deployment notes when M1 ships |
| argon2 verify on every connection is slow under reconnect storms | low | lookup by `tokenPrefix`, one verify per upgrade; throttle upgrades per IP |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Should operators see runners read-only? | Not in this item — they see runner info through projects in M1.4 |
