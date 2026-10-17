# Deployment

Decisions: [ADR-0016](../docs/adr/0016-staging-on-the-agent-host-behind-a-cloudflare-tunnel.md),
[ADR-0018](../docs/adr/0018-pull-requests-test-what-changed.md),
[ADR-0049](../docs/adr/0049-pull-request-pipelines-are-untrusted.md).

## CI — what each pipeline runs

`.woodpecker/pipeline.yml` runs `check` (Biome) and `build` in full every time.
Which tests run depends on the event:

| Event | `test` |
|---|---|
| pull request | the packages changed since the merge base with the target branch, plus their dependents |
| pull request touching a root file: `package.json`, `bun.lock`, `turbo.json`, `tsconfig.json`, `biome.json`, `.woodpecker/**`, `deploy/ci-image/**` | the full suite |
| pull request touching only `docs/**`, `*.md`, `.github/**` | none, and `build` is skipped too; `check` still gives the status |
| push to `develop` | none: the pull request already tested it (ADR-0018) |
| push to `main`, manual run | the full suite |

The `test` step prints the mode it took (`test mode: affected (…)` or
`test mode: full (<reason>)`). When it cannot find the merge base, it runs the
full suite. To test everything on a branch, run the pipeline by hand.

### Trust levels

A pull request is **untrusted** (ADR-0049). Its pipeline runs the pipeline file
and build scripts of its own branch, and anyone who can push a branch, a card
worker included, can open one. So a step that can run on a pull request gets:

- **no Docker socket**: `ci-image`, `build-staging` and `deploy-staging` run on
  push and manual events only. A pull request runs on the
  `agentdock-ci:node-bun` image the last push built, so a change to
  `deploy/ci-image/` reaches CI once it is merged;
- **no host volume**: no step of any pipeline mounts a host cache. bun's
  install cache lives in the step's container and turbo's in the pipeline's
  workspace; both die with the pipeline;
- **no secret** and no privileged container.

A push to `develop` or `main`, a tag and a manual run are **trusted**: the code
was merged, or a person started the run. The runner release
(`release-runner.yml`) still starts clean: no cache, `bun install
--frozen-lockfile`, and `build-release` ignores turbo's cache. The Node base
image is pinned by digest in `apps/api`, `apps/web` and `deploy/ci-image`, and
every `docker build` runs with `--pull`.

`bun run check` runs `scripts/check-ci.ts`, which fails when a pull-request
step mounts a volume, is privileged or reads a secret, when a tag step mounts
anything but the Docker socket, or when `bun install` lacks
`--frozen-lockfile`. A pull request can edit the check along with the
pipeline, so it stops mistakes, not an attacker. The real boundary is on the
CI server: a separate Woodpecker agent for pull requests, without the Docker
socket and trusted volumes, or *Require approval: pull requests* — settings
only a person can change (P-01). Neither is in place yet: same-repository pull
requests start without approval (#504), so a pull request that edits its
pipeline file can still reach the Docker socket. See the setup below.

The CI PostgreSQL is throwaway. Its data directory is on tmpfs, and it runs
with `fsync`, `synchronous_commit` and `full_page_writes` off. The `test` step
prints those three settings.

## Staging — https://staging-agentdock.luna-realm.com

Every push to `develop` runs `.woodpecker/pipeline.yml`. Once `check` and
`build` pass, `build-staging` builds `agentdock-api:staging` and
`agentdock-web:staging` on the agent host. `deploy-staging` then replaces the
containers in `/home/archi/stacks/agentdock-staging`. On a manual run on
`develop`, the deploy also waits for the full test suite.

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
   - *Trusted → volumes*: on. The trusted steps mount the Docker socket and
     the stack directory, and the postgres service mounts a tmpfs.
   - *Require approval*: forks (`require_approval: "forks"` in the API). The
     repository is public, so a pull request from a fork must wait for a
     maintainer. A pull request from a branch of `AndreyBegma/AgentDock`
     itself — every board card's — must not: *Pull requests* or *All events*
     gates those too (#504). Check the live value with
     `curl -s https://ci.luna-realm.com/api/repos/9 | jq .require_approval`.
     This leaves a known gap (ADR-0049 §7): a same-repository pull request can
     edit its own pipeline file and mount the Docker socket again, because
     trusted volumes are on for the repository. It stays open until pull
     requests run on a separate Woodpecker agent without the Docker socket and
     without trusted volumes. To close it before then, set *Pull requests*
     and accept that every card's pipeline waits for an Approve.
   - *Cancel previous pipelines*: push, pull_request.
   - Timeout: 60 min.
   - Run the Woodpecker server on PostgreSQL
     (`WOODPECKER_DATABASE_DRIVER=postgres`), not the default SQLite. Under a
     busy fleet SQLite answers GitHub's webhooks with HTTP 500
     `database is locked`, and GitHub never redelivers them: the pull request
     gets no pipeline (#484, ADR-0043).
3. **Delete the old CI caches** once, on an existing host:
   `rm -rf /home/archi/ci-cache/agentdock`. No pipeline reads them any more
   (ADR-0049), and pull requests could write to them before.
4. **The first run.** Push to `develop`, or run the pipeline by hand on
   `develop`. `refresh.sh` creates the stack directory, copies the examples in
   and generates `POSTGRES_PASSWORD`, `REDIS_PASSWORD` and
   `APP_ENCRYPTION_KEY`. It then stops, because the tunnel token is missing.
5. **Add the token and start the stack:**
   ```sh
   cp ~/.agentdock/cloudflared-staging.env /home/archi/stacks/agentdock-staging/env/cloudflared.env
   /home/archi/stacks/agentdock-staging/up.sh
   ```
6. **Create the first admin.** The seed creates no users.
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
- **Attachments** of board cards (ADR-0031) live in the `attachments`
  volume, not in the database. Back the volume up together with `pgdata`:
  the database alone no longer restores everything.
- **Migrations and the seed** run in the API's entrypoint, so a failed
  migration keeps the API unhealthy. The deploy fails after 240 s and prints
  the API log.
- **A deploy does not drop requests** (#368). `refresh.sh` restarts `api` and
  waits for it to be healthy before it touches `web`, so the two are never
  down together. Caddy holds a request or WebSocket upgrade that arrives
  meanwhile and retries it for up to 60 s (`lb_try_duration`) instead of
  answering 502; the API also has an active `/health` check. A socket open at
  the moment the old container stops still closes: the runner and the browser
  reconnect, and the reconnect succeeds on the first try. It is not
  blue/green: one request may be slow by up to the API's boot time.
- **A runner** pairs against the API through the proxy:
  `agentdock-runner pair --server https://staging-agentdock.luna-realm.com/api --code XXXX-XXXX`.
- **A pull request with no pipeline** (#484): open the repository's
  *Settings → Webhooks → Recent Deliveries* and look for the PR's delivery.
  A 500, 502, 530 or a timeout there is a delivery Woodpecker never
  processed; *Redeliver* it, or close and reopen the PR. AgentDock does the
  close/reopen by itself for a board card's PR after 5 minutes (ADR-0043).
- **A pipeline waits for approval on an own-branch PR** (#504): Woodpecker
  shows "This pipeline is awaiting approval from a maintainer!" for a pull
  request whose head is a branch of `AndreyBegma/AgentDock`, such as a board
  card's. Run `gh pr view <number> --json isCrossRepository`: `false` means
  the PR is not from a fork, so the gate comes from the repository setting.
  `curl -s https://ci.luna-realm.com/api/repos/9 | jq .require_approval`
  then answers `"pull_requests"` or `"all_events"` instead of `"forks"`. Set
  *Settings → General → Require approval* to *Forks* (an admin of the
  Woodpecker repository can do it) and approve the pipelines already waiting
  once; the next pull request starts at once. AgentDock pushes a card's
  branch to `origin` and opens the PR with `gh pr create --head <branch>` in
  the same repository, and the close/reopen retrigger (ADR-0043) acts on that
  same PR, so neither one makes a PR look like a fork.
- **`530` / error 1033** from the public URL means the hostname exists but no
  cloudflared connector is running. Check that `TUNNEL_TOKEN` is set and look
  at `docker logs agentdock-staging-cloudflared`.

## Releasing the runner

Decision: [ADR-0017](../docs/adr/0017-runner-distribution-homebrew-and-npm.md).
A tag `runner-v<version>` runs `.woodpecker/release-runner.yml`. The workflow
tests the runner, builds the four binaries and creates the GitHub Release with
the tarballs and `SHA256SUMS`. It then publishes the npm packages, the four
platform packages before `agentdock-runner`. Last, it pushes
`Formula/agentdock-runner.rb` to `AndreyBegma/homebrew-tap`.

### One-time setup

1. Create the public repository `AndreyBegma/homebrew-tap` with a `Formula/`
   directory.
2. Add two Woodpecker secrets to `AndreyBegma/AgentDock`, each restricted to the
   **tag** and **manual** events:
   - `github_release_token`: a GitHub token with *contents: write* on
     `AgentDock` and on `homebrew-tap`;
   - `npm_token`: an npm automation token for the account that owns
     `agentdock-runner` and `agentdock-runner-{darwin,linux}-{arm64,x64}`.

### Each release

1. **Bump** `version` in `apps/runner/package.json` and merge it. The tag must
   match it exactly, or `build-release` fails.
2. **Rehearse** (optional). Run the pipeline by hand with a message that
   contains `[runner-release]`, for example `runner dry run [runner-release]`.
   It builds everything and stops before every publish step. Without that
   marker in the message, a manual run does not start the release workflow.
   Use a branch other than `develop`: a manual run on `develop` also deploys
   staging through `pipeline.yml`. The marker is in the message, not a
   variable, because Woodpecker 3.x does not pass a manual run's variables to
   a workflow's `when`. Locally, `sh apps/runner/scripts/build-release.sh` does
   the same.
3. **Tag and push** the merged commit:
   ```sh
   git tag runner-v0.1.0 <commit>
   git push origin runner-v0.1.0
   ```
4. **Verify:**
   - the Release `runner-v<version>` has four tarballs and `SHA256SUMS`;
   - `npm view agentdock-runner@<version> optionalDependencies` names the four
     platform packages at that version;
   - `brew update && brew install andreybegma/tap/agentdock-runner` then
     `agentdock-runner version` prints `<version> <os>-<arch>`. Check it on
     Apple Silicon for the first release. If Gatekeeper refuses the binary,
     ad-hoc signing (`codesign --sign -`) goes into `build-release.sh`.

A step that fails can be re-run. The Release assets are replaced, a version
already on npm is skipped, and an unchanged formula is not committed again.
`RUNNER_RELEASE_DRY_RUN=1` in the environment stops a tag run before it
publishes.
