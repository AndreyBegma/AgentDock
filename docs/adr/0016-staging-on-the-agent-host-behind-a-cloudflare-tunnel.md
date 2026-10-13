# ADR-0016: Staging on the agent host behind a Cloudflare tunnel

Status: accepted · Date: 2026-10-13

## Context

AgentDock had no deployed environment and no CI. The owner already runs a
staging environment for another project (Denitsa) on the Hetzner server that
also hosts the Woodpecker CI agents, reachable through a Cloudflare tunnel at
`staging-denitsa.luna-realm.com`. On 2026-10-13 the owner asked for the same
arrangement for AgentDock at `staging-agentdock.luna-realm.com`, with
Woodpecker running the checks.

[overview.md](../architecture/overview.md) already names the first deployment
target: the control plane in Docker Compose behind a TLS reverse proxy.

## Decision

1. **Woodpecker runs CI** (`.woodpecker/pipeline.yml`) on every pull request
   and on pushes to `develop` and `main`. The check steps run on
   `agentdock-ci:node-bun`, built by the pipeline itself from
   `deploy/ci-image/`.
2. **A push to `develop` deploys staging.** The images are built on the agent
   host's Docker daemon and tagged `:staging`, with no registry. The compose
   stack in `/home/archi/stacks/agentdock-staging` is then replaced. That
   directory is not a git checkout: `deploy/staging/refresh.sh` copies the
   stack files in, and the env files and volumes stay put.
3. **One public origin.** cloudflared (token tunnel `agentdock-staging`,
   remote-managed) sends every request to a Caddy container. Caddy routes
   `/api/*` to the API with the prefix stripped, WebSockets included, and
   everything else to the web app. Cookies stay first-party. The browser's
   live socket is `wss://<host>/api/live`, and a runner pairs with
   `https://<host>/api`. Nothing is published on the host.
4. **The API migrates and seeds in its entrypoint.** Deploying means replacing
   containers, and there is no separate migration step.
5. **Secrets live only on the host.** `refresh.sh` generates the random ones on
   the first run. The tunnel token is the one value a person supplies.
   Woodpecker holds no deployment secrets.

## Consequences

- The repository is public, and the deploy steps mount the host's Docker
  socket. The Woodpecker repository must be *trusted → volumes*, with
  approval required for pull requests from forks.
- Staging shares a daemon with other stacks. `down.sh` and image pruning touch
  only `agentdock-staging` resources.
- The API image keeps dev dependencies, for the Prisma CLI and the ts-node
  seed, so it is about 2 GB. A slim image is left to production.
- `NEXT_PUBLIC_LIVE_URL` is baked into the web image, so the staging host name
  is fixed at build time (`build-staging.sh`).
