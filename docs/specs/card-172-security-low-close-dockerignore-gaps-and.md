# C-172: Security [Low]: Close .dockerignore gaps and drop dev dependencies from the API image

> Security audit 2026-10-16 · **WI-70** · severity **Low** · size **M** · findings: L-41 (Z9 L7), L-42 (Z9 L8)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
- `.dockerignore` (`:1-32`) excludes `.env` files and build output but not `data/`, `.playwright-mcp/`, `apps/runner/release/` or `**/.env.*` variants other than `.env.local`.
- `apps/api/Dockerfile:29` installs all dependencies and `:52` copies the full `node_modules` into the runtime stage, so ts-node, jest and the Nest CLI ship in production.

**Attacker.** Anyone who can pull the image, or code running in the API container.
**Scenario.** Local data, screenshots or release artefacts end up in a layer; extra tooling widens what an attacker can run inside the container.
**Impact.** Data disclosure through image layers; a larger attack surface and image.

## Fix
Add `data`, `**/data`, `.playwright-mcp`, `apps/runner/release`, `**/.env.*` and `!**/.env.example` to `.dockerignore`. Run migrate and seed from compiled JS (or an init stage) and prune dev dependencies in the runtime stage.

## Acceptance criteria
- The built API image has no `ts-node`, `jest` or `@nestjs/cli` under `node_modules` (a CI or script check).
- Migrate plus seed still run on staging start.
- A test file under `data/` in the context does not appear in the image.

## Touches
- .dockerignore
- apps/api/Dockerfile
- apps/api/docker-entrypoint.sh
- apps/api/prisma/seed*
- apps/api/package.json

## Decision
D-12 — fleet changes to deploy files need a human review and never auto-merge (00-decisions.md; ADR-0045)

## Must not run in parallel with
- WI-31
- WI-71


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
