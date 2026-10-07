# Auth and access — admin seed, approved registration, roles

Issue: [#3](https://github.com/AndreyBegma/AgentDock/issues/3) · Roadmap: M1.1 ·
Decisions: [ADR-0008](../adr/0008-local-accounts-with-admin-approved-registration.md),
[security.md](../architecture/security.md)

## Summary

AgentDock starts agents on the owner's machines and subscriptions, so nobody
reaches it without an account an admin has approved. This delivers local
accounts: the first admin is created from the command line, people register
only while an admin has registration open, every new account waits for an admin
to approve it and assign a role, and every API route checks the caller's role.
It is the first milestone item because every later screen and runner command
authorizes against it.

## Scope

### In scope

- User accounts with status and role; server-side cookie sessions.
- `admin:create` CLI for the first (and any further) admin.
- Registration, open/closed by an admin setting (closed by default).
- Approval queue: approve with a role, reject; disable / re-enable; change role.
- Login, logout, current user, change own password, list and revoke own sessions.
- CSRF protection, login rate limiting and lockout.
- Role guard reusable by every later module.
- Web: login, register, pending, account, admin users, admin settings — on
  glass-ui, with a same-origin `/api` proxy.

### Out of scope

- Project membership and per-project roles — the `Project` entity arrives in
  M1.4, which adds `ProjectMember` and a project-access guard on top of this.
- Audit records for these actions — M1.2 adds the audit log and retrofits the
  actions listed under *Audited later*.
- Password reset by email, email verification, 2FA, OAuth/SSO (ADR-0008).
- Notifying admins of pending registrations (M2.7 notifications).
- The application shell / navigation (M1.8). This item ships plain pages.

## Decisions

The person delegated all decisions on 2026-10-07; each below is the default
taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | Roles are global: `admin`, `operator`, `viewer`. Statuses: `pending`, `active`, `rejected`, `disabled`. Only `active` users can hold a session | ADR-0008 |
| D2 | First admin via `bun run admin:create` (interactive prompt, or `ADMIN_EMAIL` / `ADMIN_PASSWORD` env for non-interactive use). It creates an `active` admin; it refuses an email that already exists. The seed creates **no** users | ADR-0008, security.md |
| D3 | Registration is closed by default. Setting `registration.open` (boolean) in a `settings` key/value table, changed only by admins. Closed → `POST /auth/register` answers 403 `registration_closed` | ADR-0008 |
| D4 | Approval is one action that sets status `active` **and** the role. Rejection sets `rejected`; a rejected email cannot register again until an admin deletes the account | ADR-0008; Mission Control access-request flow (inspiration) |
| D5 | Sessions are server-side: a random 32-byte token in an httpOnly, `Secure` (when `APP_ENV=production`), `SameSite=Lax` cookie `ad_session`; the database stores only its SHA-256. Idle expiry 7 days, absolute 30 days, refreshed `lastSeenAt` at most once a minute | security.md |
| D6 | Passwords: argon2id (`argon2` package, library defaults), length 12–256, no composition rules. Emails are trimmed and lower-cased | security.md — length policy is new here |
| D7 | CSRF: double-submit — a non-httpOnly `ad_csrf` cookie set with the session, and every non-GET request must send the same value in `X-CSRF-Token`. Login and register are exempt (no session yet) but require `Content-Type: application/json` | security.md |
| D8 | Rate limit: `@nestjs/throttler`, 10 requests / minute per IP on `/auth/login` and `/auth/register`. Lockout: 10 consecutive failed logins for one account → locked 15 minutes; a correct password during lockout still fails with the same error | security.md — numbers are new here |
| D9 | Errors do not reveal account existence: wrong email and wrong password give the same 401 `invalid_credentials`. A correct password on a `pending` account gives 403 `pending_approval`; on `rejected`/`disabled` gives 401 `invalid_credentials` | new |
| D10 | The last active admin cannot be demoted, disabled or deleted (409 `last_admin`) | new |
| D11 | Disabling a user, changing their role, or changing a password revokes all of that user's sessions (except the current one for a self password change) | security.md |
| D12 | Web reaches the API same-origin: Next rewrites `/api/:path*` → `${API_URL}/:path*`. Cookies are first-party; CORS is not relied on | new — avoids cross-port cookies; matches the reverse-proxy deployment (overview.md) |
| D13 | Route protection in web: a Next `middleware.ts` redirects to `/login` when `ad_session` is absent; pages call `GET /api/auth/me` and redirect on 401 / `pending_approval` | new |
| D14 | Shared contracts (DTO shapes, enums, error codes) live in `packages/shared/src/auth/` so web and api agree | CLAUDE.md (shared types in `packages/shared`) |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261008000000_auth/`.

Reshape `User` (table `users`) — it exists from the scaffold with `email`,
`name`; no real data:

| Field | Type |
|---|---|
| `id` | String cuid (existing) |
| `email` | String unique (existing) |
| `name` | String? (existing) |
| `passwordHash` | String |
| `role` | enum `Role` (`admin`, `operator`, `viewer`), default `viewer` |
| `status` | enum `UserStatus` (`pending`, `active`, `rejected`, `disabled`), default `pending` |
| `approvedById` | String? → `users.id` |
| `approvedAt` | DateTime? |
| `failedLoginCount` | Int default 0 |
| `lockedUntil` | DateTime? |
| `createdAt`, `updatedAt` | existing |

New `UserSession` (table `user_sessions`): `id` cuid, `tokenHash` String unique,
`userId` → `users.id` (cascade delete), `createdAt`, `lastSeenAt`, `expiresAt`,
`ip` String?, `userAgent` String?. Index on `userId`. It is called `UserSession`, not
`Session`, because [data-model.md](../architecture/data-model.md) already uses
`Session` for agent runtime sessions. The API paths (`/auth/sessions`) and the
`ad_session` cookie keep their names.

`approvedById` and `settings.updatedById` are `ON DELETE SET NULL`. Before the
columns are added, the migration deletes the scaffold seed's placeholder user,
because it has no password.

New `Setting` (table `settings`): `key` String primary key, `value` Json,
`updatedAt`, `updatedById` String? → `users.id`.

## API

All under the API root; web reaches them as `/api/...`. Request bodies are DTOs
with `class-validator`; responses never include `passwordHash` or token hashes.

| Method | Path | Who | Behaviour |
|---|---|---|---|
| POST | `/auth/register` | anyone, when open | `{ email, password, name? }` → 201 `{ status: "pending" }`; 403 `registration_closed`; 409 `email_taken` |
| POST | `/auth/login` | anyone | `{ email, password }` → 200 user + sets `ad_session`, `ad_csrf`; errors per D8/D9 |
| POST | `/auth/logout` | session | revokes current session, clears cookies |
| GET | `/auth/me` | session | current user `{ id, email, name, role, status }` |
| PATCH | `/auth/me/password` | session | `{ currentPassword, newPassword }` → revokes other sessions |
| GET | `/auth/sessions` | session | own sessions (current flagged) |
| DELETE | `/auth/sessions/:id` | session | revoke one own session |
| GET | `/auth/registration` | anyone | `{ open: boolean }` (so the login page can show or hide the register link) |
| GET | `/admin/users?status=` | admin | list, filter by status |
| POST | `/admin/users/:id/approve` | admin | `{ role }`; only from `pending` |
| POST | `/admin/users/:id/reject` | admin | only from `pending` |
| PATCH | `/admin/users/:id` | admin | `{ role?, status?: active\|disabled }`; D10, D11 |
| DELETE | `/admin/users/:id` | admin | D10 |
| GET / PUT | `/admin/settings/registration` | admin | `{ open: boolean }` |

Reusable for later modules: `@Roles(...)` decorator + `SessionGuard` (global,
with `@Public()` opt-out) + `RolesGuard`, and a `@CurrentUser()` parameter
decorator, exported from `apps/api/src/auth/`.

`/health` stays public.

## UI

glass-ui is added to `apps/web` (pinned tag ≥ v0.15.0, `transpilePackages`,
CSS imports, `data-scale="desk"` — see [ui/glass-ui.md](../ui/glass-ui.md)).
Pages, plain layout (no app shell yet):

| Route | Content |
|---|---|
| `/login` | email, password, submit; register link only when registration is open; error states for D9 codes |
| `/register` | email, name, password; closed state |
| `/pending` | "waiting for an administrator" with logout |
| `/account` | profile, change password, own sessions with revoke |
| `/admin/users` | tabs Pending / Active / Disabled / Rejected; approve with role picker, reject, change role, disable/enable, delete — confirmation dialog for destructive actions |
| `/admin/settings` | registration open/closed toggle |

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `API_URL` | `apps/web` | target of the `/api` rewrite (default `http://localhost:8180`) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | `admin:create` only | non-interactive admin creation |
| `APP_ENV` | `apps/api` (exists) | `production` → `Secure` cookies |
| `TRUST_PROXY` | `apps/api` | Express `trust proxy` (default `loopback`). The per-IP login limit must see the client's address, not the address of the Next `/api` rewrite or the reverse proxy |
| `TEST_DATABASE_URL` | `apps/api` tests | the database the e2e suite resets; its name must end in `_test` |

Add each to the matching `.env.example`. `NEXT_PUBLIC_API_URL` is removed from
`apps/web/.env.example` (D12).

## Acceptance criteria

- [ ] `bun run admin:create` creates an active admin who can log in; running it again with the same email exits non-zero without changes.
- [ ] With registration closed (fresh database), `POST /auth/register` returns 403 `registration_closed`.
- [ ] After an admin opens registration, a new registration returns 201 and the user is `pending`; logging in with the right password returns 403 `pending_approval`.
- [ ] Approving with role `operator` lets that user log in; `GET /auth/me` returns role `operator`.
- [ ] Wrong email and wrong password return the same status and body.
- [ ] 10 failed logins lock the account for 15 minutes; the 11th attempt with the correct password fails.
- [ ] More than 10 login requests per minute from one IP are throttled (429).
- [ ] A non-GET request with a valid session but missing or mismatched `X-CSRF-Token` returns 403.
- [ ] **Authorization:** an `operator` and a `viewer` each get 403 on every `/admin/*` route; an anonymous caller gets 401 on every route except `/health`, `/auth/login`, `/auth/register`, `/auth/registration`.
- [ ] **Authorization:** `GET /auth/sessions` and `DELETE /auth/sessions/:id` never return or revoke another user's session (revoking a foreign id returns 404).
- [ ] Demoting, disabling or deleting the last active admin returns 409 `last_admin`.
- [ ] Disabling a user ends their existing sessions immediately (next request 401).
- [ ] No response body or log line contains a password, password hash, session token or token hash.
- [ ] The session cookie is httpOnly and SameSite=Lax; `Secure` when `APP_ENV=production`.
- [ ] Web: an unauthenticated visit to `/admin/users` redirects to `/login`; the full flow register → pending → admin approves → login works in the browser against the real API.
- [ ] `bun run check`, `bun run test`, `bun run build` pass; new API behaviour is covered by e2e tests (Nest testing module + supertest against the docker PostgreSQL).

## Parallel plan

Honestly two slots in sequence: both add dependencies (`bun.lock`), and the web
slot builds against the API contract. Parallelism for M1 comes from other
issues (the runner, M1.3), not from splitting this one.

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i3-api | schema, migration, auth + admin modules, CLI, seed, shared contracts, root scripts | apps/api/**, packages/shared/src/auth/**, packages/shared/src/index.ts, package.json, bun.lock | — | yes | opus |
| i3-web | glass-ui setup, `/api` rewrite, middleware, auth and admin pages | apps/web/**, bun.lock | i3-api | no | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i3-api | do not open it |
| apps/api/prisma/migrations/20261008000000_auth/** | i3-api | — |
| package.json (root) | i3-api, then i3-web after it merges | do not open while i3-api is live |
| bun.lock | regenerated, never hand-merged — see [#5's rule](5-runner-daemon-and-protocol.md#contention) | #5 runs in parallel and also changes it |
| packages/shared/src/index.ts | i3-api | i3-web imports, never edits |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Security mistakes in session / CSRF handling | high | `opus` on i3-api; the acceptance criteria test each property; M1.2 adds audit |
| `argon2` native build fails under Bun install scripts (`Blocked 2 postinstalls` seen in the scaffold) | medium | **Resolved:** `@node-rs/argon2`. It ships prebuilt N-API binaries per platform as optional dependencies, so there is no postinstall to trust, and its default algorithm is argon2id |
| glass-ui pinned via GitHub tag needs SSH/HTTPS access in worker worktrees | low | same remote access the workers already use for `git push` |
| Later modules forget the guard | medium | `SessionGuard` is global; routes opt out with `@Public()` |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Should rejected users be allowed to re-register after some time? | No — an admin deletes the account to allow it |
| Should admins get a notification for pending users before M2.7? | No — the admin page shows a pending count |

### Audited later (M1.2)

login success/failure, logout, register, approve, reject, role change,
disable/enable, delete, registration toggle, password change, session revoke.
