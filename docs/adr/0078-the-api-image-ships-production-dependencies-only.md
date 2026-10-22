# ADR-0078: The API image ships production dependencies only

Status: accepted · Date: 2026-10-22 · Amends [ADR-0016](0016-staging-on-the-agent-host-behind-a-cloudflare-tunnel.md) (its consequence that the API image keeps dev dependencies)

## Context

ADR-0016 let the staging API image keep its whole dependency tree, dev
dependencies included, because the entrypoint needed the Prisma CLI for
`migrate deploy` and ts-node for the seed. The security audit of 2026-10-16
(WI-70, findings L-41 and L-42) flagged both halves of that trade: ts-node,
jest and the Nest CLI shipped in the image and widened what code running in
the container can execute, and `.dockerignore` let local data, screenshots,
runner release artefacts and `.env.*` variants into the build context.

## Decision

1. **The runtime stage installs production dependencies only.** A
   `prod-deps` stage runs `bun install --frozen-lockfile --production --filter
   @nautelle/api`; the runtime copies its `node_modules` plus the Prisma client
   the builder generated (`node_modules/.prisma`).
2. **The Prisma CLI is a production dependency of the API.** `migrate deploy`
   runs at container start (ADR-0016 §4), so the CLI is runtime tooling.
3. **The image seeds from compiled JavaScript.** `prisma/seed.ts` is part of
   the Nest build (`dist/prisma/seed.js`) and the entrypoint runs it with
   `node`. Local development keeps `prisma db seed` through ts-node
   (`prisma.config.ts`).
4. **The build checks the image.** `deploy/staging/check-api-image.sh` runs
   after the staging build and fails it when `ts-node`, `jest` or
   `@nestjs/cli` is under `node_modules`, when a `data` directory from the
   context is in `/app`, or when the compiled seed is missing.
5. **`.dockerignore` excludes local state**: `data`, `**/data`,
   `.playwright-mcp`, `apps/runner/release` and every `**/.env.*` except
   `.env.example`.

## Consequences

- No source directory may be named `data`: `**/data` keeps it out of every
  image.
- A module the seed imports that reads a file next to itself must resolve the
  path so it works from both `src/` and `dist/src/` (see
  `src/prices/seed-prices.ts`).
- Inside the image every script runs compiled, as admin creation already did
  (`node dist/src/cli/admin-create.js`, deploy/README.md).
