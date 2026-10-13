# Deployment

Decision: [ADR-0016](../docs/adr/0016-staging-on-the-agent-host-behind-a-cloudflare-tunnel.md).

## Staging — https://staging-agentdock.luna-realm.com

Every push to `develop` runs `.woodpecker/pipeline.yml`. If the checks pass,
`build-staging` builds `agentdock-api:staging` and `agentdock-web:staging` on
the agent host. `deploy-staging` then replaces the containers in
`/home/archi/stacks/agentdock-staging`.

```
Cloudflare ──tunnel──▶ cloudflared ──▶ proxy (Caddy :80) ─┬─ /api/* ─▶ api :8180 ─▶ postgres, redis
                                                          └─ /*     ─▶ web :3517
```

Nothing is published on the host. The stack runs on its own compose network
(`agentdock-staging`).

### One-time setup

1. **Cloudflare.** Create the tunnel `agentdock-staging` in Zero Trust. Give it
   the public hostname `staging-agentdock.luna-realm.com` → `HTTP` `proxy:80`.
   Save the token as `~/.agentdock/cloudflared-staging.env`, mode 600, with one
   line: `TUNNEL_TOKEN=...`.
2. **Woodpecker.** Activate `AndreyBegma/AgentDock` and apply these settings:
   - *Trusted → volumes*: on. The steps mount the Docker socket, the stack
     directory and the caches.
   - *Require approval*: forks. The repository is public.
   - *Cancel previous pipelines*: push, pull_request.
   - Timeout: 60 min.
3. **The first run.** Push to `develop`, or run the pipeline by hand on
   `develop`. `refresh.sh` creates the stack directory, copies the examples in
   and generates `POSTGRES_PASSWORD`, `REDIS_PASSWORD` and
   `APP_ENCRYPTION_KEY`. It then stops, because the tunnel token is missing.
4. **Add the token and start the stack:**
   ```sh
   cp ~/.agentdock/cloudflared-staging.env /home/archi/stacks/agentdock-staging/env/cloudflared.env
   /home/archi/stacks/agentdock-staging/up.sh
   ```
5. **Create the first admin.** The seed creates no users.
   ```sh
   docker exec -it agentdock-staging-api node dist/src/cli/admin-create.js
   ```

### Operating

| Command (on the host) | What it does |
|---|---|
| `/home/archi/stacks/agentdock-staging/status.sh` | the deployed commit, containers, image revisions, and the public `/` and `/api/health` |
| `/home/archi/stacks/agentdock-staging/up.sh` | starts the stack from the images already built |
| `/home/archi/stacks/agentdock-staging/down.sh` | stops it; the volumes are kept |
| `sh deploy/staging/refresh.sh` (from a checkout) | what `deploy-staging` runs |

- **Secrets** live only in `/home/archi/stacks/agentdock-staging/.env` and
  `env/*.env`, all mode 600. `refresh.sh` never overwrites them. When an
  example gains a key, `refresh.sh` appends it empty.
- **Migrations and the seed** run in the API's entrypoint, so a failed
  migration keeps the API unhealthy. The deploy fails after 240 s and prints
  the API log.
- **A runner** pairs against the API through the proxy:
  `agentdock-runner pair --server https://staging-agentdock.luna-realm.com/api --code XXXX-XXXX`.
- **`530` / error 1033** from the public URL means the hostname exists but no
  cloudflared connector is running. Check that `TUNNEL_TOKEN` is set and look
  at `docker logs agentdock-staging-cloudflared`.
