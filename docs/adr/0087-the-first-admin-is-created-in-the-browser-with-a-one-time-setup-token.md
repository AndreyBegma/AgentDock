# ADR-0087: The first admin is created in the browser with a one-time setup token

Status: accepted · Date: 2026-10-24 ·
Card: C-367 ·
Spec: [`docs/specs/card-367-first-run-setup-page-create-the-first-ad.md`](../specs/card-367-first-run-setup-page-create-the-first-ad.md) ·
Amends: ADR-0008, spec 3 D2

## Context

ADR-0008 and spec 3 D2 create the first admin only from the command line, with `bun run admin:create`. After `docker compose up` the person has to `docker exec` into the API container before they can sign in. Installs like Woodpecker or Gitea just open the browser. A browser path, though, opens a race: on a fresh instance reachable from a public tunnel or domain, whoever reaches the page first would own the server.

## Decision

1. **`GET /setup/status`** (public) answers `{ needsSetup }`, true while the `users` table is empty.
2. **A one-time setup token.** On boot, while no user exists, the API generates a random token, keeps only its SHA-256 hash in process memory, and logs `Open <WEB_URL>/setup?token=…`. The token is never written to the database. A restart issues a new one; a successful setup spends it.
3. **`POST /setup/admin`** (public, per-IP request limit as for login) takes the token, email, password and an optional name, with the same rules as `createAdmin`. Once any user exists it answers 409 `setup_done`, with or without a token. A missing or wrong token is 403 `setup_token_invalid`. Otherwise it creates an active admin through `createAdmin` and signs them in with a normal session.
4. **One winner.** The user count and the insert run in one transaction under a PostgreSQL advisory lock, so of two concurrent posts only one creates a user; the other gets 409.
5. **Headless boot.** When `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set and no user exists, the API creates that admin on boot instead of logging the link. If they break the account rules, the error is logged and the link is logged as usual.
6. **The web app** sends `/login` to `/setup` while setup is needed and `/setup` to `/login` once it is not; when the API cannot answer, neither page redirects.
7. `bun run admin:create` stays, for recovery and for further admins.

## Consequences

- A fresh install is usable from the browser; the person only needs the API log to get the link.
- A stranger who reaches the instance first cannot create the admin without the token, which only the log shows. Anyone who can read the API log can.
- The audit log records the setup as `user.create` with `meta.via: "setup"` (actor: the new admin) or `"env"` (actor: system), and the sign-in as `auth.login` with `meta.via: "setup"`.
- With several API processes, each logs its own token, which works only on the process that issued it. The documented install runs one API process.
