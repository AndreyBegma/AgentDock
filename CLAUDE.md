# AgentDock

Self-hosted control plane for Claude Code and Codex agent fleets driven by the
Code Sentinel orchestrator. Fullstack monorepo — Bun workspaces + Turborepo.

**The authority is [`docs/`](docs/README.md)** — product, architecture, ADRs,
specs. Read the relevant ADRs before changing architecture; record a new
decision as a new ADR in the same pull request. Everything in the repository is
written in English.

- UI: only [glass-ui](docs/ui/glass-ui.md) components; a missing one is added to
  glass-ui, not written here (ADR-0011).
- The control plane never reads a project's filesystem — that is the runner's
  job (ADR-0001). The runner accepts typed commands only (ADR-0010).

## Structure

```
apps/
  api/        — NestJS 11 API, Prisma 7 (PostgreSQL, pg driver adapter)   :8180
  web/        — Next.js 16 (App Router, Turbopack), React 19, Tailwind 4   :3517
packages/
  shared/     — @agentdock/shared — code shared by api and web
docker/       — docker-compose: PostgreSQL 16                             :5421
scripts/      — db-start-docker.sh (up → migrate → seed)
```

## Commands

| Command | What it does |
|---|---|
| `bun install` | install all workspaces |
| `bun run db:setup` | start PostgreSQL, apply migrations, seed |
| `bun run start:dev` | api + web in watch mode |
| `bun run build` | build everything (turbo, cached) |
| `bun run lint` / `bun run test` | lint (Biome) / tests (Jest in api) |
| `bun run check` | Biome lint + format + import order, no writes |
| `bun run db:migrate` | `prisma migrate dev` — create and apply a migration |
| `bun run db:generate` | regenerate the Prisma client |
| `bun run db:studio` | Prisma Studio |

## Conventions

- **Bun** is the package manager; versions are pinned exactly (`bunfig.toml`). Never `npm install` / `yarn`.
- **Biome** is the only linter and formatter — single quotes, trailing commas, 2 spaces. No ESLint / Prettier.
- **Prisma is imported only by `apps/api`** — through `PrismaService` (`src/database/`). The web app talks to the API over HTTP, never to the database.
- Schema changes go through `prisma migrate dev` with a descriptive name; never edit an applied migration.
- Shared types and pure helpers go in `packages/shared`; it must stay framework-free.
- API: global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`) — every input is a DTO with `class-validator` decorators. `helmet` and CORS (`WEB_URL`) are on.
- Environment: `apps/*/.env` (git-ignored), documented in `.env.example`. Add a variable to the example in the same change that reads it.
- TypeScript strict everywhere; no `any`.
- Tests: `*.spec.ts` next to the code (api). A bug fix comes with the test that would have caught it.
