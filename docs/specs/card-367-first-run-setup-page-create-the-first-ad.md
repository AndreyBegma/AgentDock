# C-367: First-run setup page: create the first admin in the browser

## Why
After `docker compose up` the person must `docker exec` into the API and run `bun run admin:create` (`apps/api/src/cli/admin-create.ts`) before they can log in. Woodpecker/Gitea-style installs just open the browser. Part of the one-command install (see the "Install in one command" card).

## What
- API: `GET /setup/status` → `{ needsSetup: boolean }` (true while no user exists). `POST /setup/admin` (DTO with class-validator: name, email, password with the same rules as `createAdmin`) creates the first admin through the existing `createAdmin` and logs them in. Refused with 409 once any user exists — checked inside one transaction so two concurrent posts cannot both win.
- **Setup token:** on boot, while no user exists, the API generates a one-time token and logs `Open <WEB_URL>/setup?token=…` (the token is never stored in plain text beyond process memory/hash). `POST /setup/admin` requires it. This blocks a stranger who reaches a fresh instance on a public tunnel/domain before the owner does. `ADMIN_EMAIL`/`ADMIN_PASSWORD` env (already read by the CLI) may still create the admin headlessly at boot.
- Web: `/setup` page built from glass-ui components only (ADR-0011); the login page redirects to `/setup` when `needsSetup`, and `/setup` redirects to login when not. Add it to `docs/ui/screens.md`.
- `admin:create` CLI stays for recovery.

## Tests
e2e: needsSetup true on an empty DB; wrong/missing token → 403; first post creates the admin and a session; second post → 409; status false afterwards. Web test for the redirect logic.
