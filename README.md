# AgentDock

## Requirements

- [Bun](https://bun.sh) 1.4.0+
- Node.js 24+
- Docker (for PostgreSQL and Redis)

## Getting started

```bash
bun install
bun run db:setup     # PostgreSQL on :5421, Redis on :6421, migrations, seed
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

## CI and staging

Woodpecker runs `.woodpecker/pipeline.yml` on every pull request. A push to
`develop` deploys https://staging-agentdock.luna-realm.com — see
[deploy/README.md](deploy/README.md).
