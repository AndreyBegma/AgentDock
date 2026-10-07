# AgentDock

## Requirements

- [Bun](https://bun.sh) 1.4.0+
- Node.js 24+
- Docker (for PostgreSQL)

## Getting started

```bash
bun install
bun run db:setup     # PostgreSQL on :5421, migrations, seed
bun run start:dev    # api → http://localhost:8180  ·  web → http://localhost:3517
```

Health check: `curl http://localhost:8180/health`

## Workspaces

| Path | Package | Stack |
|---|---|---|
| `apps/api` | `@agentdock/api` | NestJS 11, Prisma 7, PostgreSQL |
| `apps/web` | `@agentdock/web` | Next.js 16, React 19, Tailwind CSS 4 |
| `packages/shared` | `@agentdock/shared` | shared TypeScript |

See `CLAUDE.md` for all commands and conventions.
