# Agent rules: the details

`CLAUDE.md` at the repository root carries only the rules that are never
traded: every agent session reads it on every turn, so each line costs tokens
on every round (ADR-0068). The details an agent looks up when it needs them
live here.

## Structure

Fullstack monorepo — Bun workspaces + Turborepo.

```
apps/
  api/        — NestJS 11 API, Prisma 7 (PostgreSQL, pg driver adapter)   :8180
  web/        — Next.js 16 (App Router, Turbopack), React 19, Tailwind 4   :3517
packages/
  shared/     — @agentdock/shared — code shared by api and web
docker/       — docker-compose: PostgreSQL 16 :5421, Redis 7.4 :6421
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
