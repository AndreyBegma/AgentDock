# Deployment

Decisions: [ADR-0016](../docs/adr/0016-staging-on-the-agent-host-behind-a-cloudflare-tunnel.md),
[ADR-0018](../docs/adr/0018-pull-requests-test-what-changed.md),
[ADR-0053](../docs/adr/0053-pull-request-pipelines-are-untrusted.md).

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

A pull request is **untrusted** (ADR-0053). Its pipeline runs the pipeline file
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

The `secrets` step runs gitleaks, pinned by digest, over the commits the clone
holds, with `.gitleaks.toml`, on every event. It mounts nothing and reads no
secret, and `--redact` keeps a value it finds out of the public log.
`bun run check:secrets` runs the same scan locally. A false positive gets a
narrow allowlist entry in `.gitleaks.toml`, with a comment: name the file and,
where possible, the rule.

The `helm` step checks the Helm chart in `helm/nautelle` (ADR-0091) on every
event: `helm/check-chart.sh` lints it with each value set in
`helm/nautelle/ci`, renders them into `.helm-out`, checks that contradictory
settings (a database bundled and external, two tunnel tokens…) are refused
and that every third-party image is pinned by digest. `kubeconform` then
validates the rendered manifests against the Kubernetes schemas. Both images
are pinned by digest; neither step mounts anything or reads a secret. Run the
same check locally with:

```sh
docker run --rm -v "$PWD":/w -w /w --entrypoint sh alpine/helm:3.19.0 deploy/helm/check-chart.sh .helm-out
```

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

### `TRUST_PROXY` per topology

`TRUST_PROXY` is Express's `trust proxy` for the API: which hops' `X-Forwarded-For`
it believes when it works out the client IP, which the login throttle and the
audit log use. A value that trusts too many hops lets a client forge its IP. The
API refuses to boot with `TRUST_PROXY=true` when `APP_ENV=production`; set a hop
count or an address list.

| Topology | Value |
|---|---|
| Development, or a single host (browser → Next `/api` rewrite → API) | `loopback` (the default) |
| nginx in front of Next (browser → nginx → Next → API) | `2`, and make nginx overwrite `X-Forwarded-For` with `$remote_addr` instead of appending to the client's |
| Staging (Cloudflare → cloudflared → Caddy → API, all on the private bridge) | `uniquelocal` (`deploy/staging/env/api.env.example`) |

Count every proxy between the client and the API. A count that is too high
trusts a forged header; one that is too low shows the proxy's own address.

### One-time setup

1. **Cloudflare.** Create the tunnel `agentdock-staging` in Zero Trust. Give it
   the public hostname `staging-agentdock.luna-realm.com` → `HTTP` `proxy:80`.
   Save the token as `~/.agentdock/cloudflared-staging.env`, mode 600, with one
   line: `TUNNEL_TOKEN=...`.
2. **Woodpecker.** Activate `AndreyBegma/Nautelle` and apply these settings:
   - *Trusted → volumes*: on. The trusted steps mount the Docker socket and
     the stack directory, and the postgres service mounts a tmpfs.
   - *Require approval*: forks (`require_approval: "forks"` in the API). The
     repository is public, so a pull request from a fork must wait for a
     maintainer. A pull request from a branch of `AndreyBegma/Nautelle`
     itself — every board card's — must not: *Pull requests* or *All events*
     gates those too (#504). Check the live value with
     `curl -s https://ci.luna-realm.com/api/repos/9 | jq .require_approval`.
     This leaves a known gap (ADR-0053 §7): a same-repository pull request can
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
   (ADR-0053), and pull requests could write to them before.
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

### Access layer and the runner (D-07)

Staging is public, so the control plane sits behind **Cloudflare Access**. Only
a person can set it up (P-04); the repository carries the proxy and the runner
side.

1. **Zero Trust → Access → Applications.** Create a self-hosted application for
   `staging-agentdock.luna-realm.com` with a policy that allows the team (an
   email list or an identity provider group). It covers the web app and the
   login, register and API pages.
2. **Service token.** Create a service token (*Access → Service Auth*) and add
   a *Service Auth* policy to the application that lets it through. Keep the
   Client ID and Client Secret: the secret is shown once.
3. **Paths.**

   | Path | Access |
   |---|---|
   | `/api/runner` (the runner WebSocket) | service token |
   | `/api/runners/pair` (pairing) | service token |
   | `/api/hooks/*` | open — a bypass policy; Claude Code hooks cannot send Access headers and authenticate with their own token |
   | everything else | the team policy |

   Put the open `/api/hooks/*` bypass application first: Access applies the
   most specific path.
4. **Pair a runner behind Access.** The runner sends `CF-Access-Client-Id` and
   `CF-Access-Client-Secret` on the pairing request and on every WebSocket
   connect, and keeps them in `runner.json` (mode 600):
   ```sh
   nautelle-runner pair --server https://staging-agentdock.luna-realm.com/api \
     --code XXXX-XXXX --access-client-id <id>.access --access-client-secret-stdin
   ```
   Give the secret on stdin (`--access-client-secret-stdin`) or in
   `NAUTELLE_ACCESS_CLIENT_SECRET` so that it stays out of the shell history;
   `--access-client-secret <secret>` also works. `nautelle-runner status`
   shows `access token: set` and never the secret. A re-pair without the flags
   clears the stored token. Rotate the token by pairing again.

The proxy also caps request bodies at 10 MB (`413` above it), sets
`Strict-Transport-Security` and `X-Content-Type-Options: nosniff`, and sends
`Cache-Control: no-store` for `/api/runners/pair` and `/api/hooks/*`. Check the
Caddyfile locally:

```sh
docker run --rm -v "$PWD/deploy/staging/Caddyfile:/etc/caddy/Caddyfile:ro" \
  "$(grep -o 'caddy:[^ ]*' deploy/staging/docker-compose.yml | head -1)" \
  caddy validate --config /etc/caddy/Caddyfile
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
- **Generated keys** (C-366): every one of `APP_ENCRYPTION_KEY`,
  `AUDIT_HMAC_KEY` and `LLM_SECRETS_KEY` not set in `env/api.env` is
  generated by the API on first boot into `/data/secrets.json` (mode 600) in
  the `data` volume. Back that volume up: the key file is as important as the
  database — what it seals cannot be decrypted without it. Keep its backup
  apart from the database dump.
- **Volume names are pinned** in `docker-compose.yml` (`name:`):
  `agentdock-staging_pgdata`, `agentdock-staging_redis`,
  `agentdock-staging_attachments` and `agentdock-staging_data`. Without it Docker prefixes a volume with
  the compose project name, and renaming the project would start an empty
  database. Never change a pinned name without copying the volume first.
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
  `nautelle-runner pair --server https://staging-agentdock.luna-realm.com/api --code XXXX-XXXX`.
- **A pull request with no pipeline** (#484): open the repository's
  *Settings → Webhooks → Recent Deliveries* and look for the PR's delivery.
  A 500, 502, 530 or a timeout there is a delivery Woodpecker never
  processed; *Redeliver* it, or close and reopen the PR. Nautelle does the
  close/reopen by itself for a board card's PR after 5 minutes (ADR-0043).
- **A pipeline waits for approval on an own-branch PR** (#504): Woodpecker
  shows "This pipeline is awaiting approval from a maintainer!" for a pull
  request whose head is a branch of `AndreyBegma/Nautelle`, such as a board
  card's. Run `gh pr view <number> --json isCrossRepository`: `false` means
  the PR is not from a fork, so the gate comes from the repository setting.
  `curl -s https://ci.luna-realm.com/api/repos/9 | jq .require_approval`
  then answers `"pull_requests"` or `"all_events"` instead of `"forks"`. Set
  *Settings → General → Require approval* to *Forks* (an admin of the
  Woodpecker repository can do it) and approve the pipelines already waiting
  once; the next pull request starts at once. Nautelle pushes a card's
  branch to `origin` and opens the PR with `gh pr create --head <branch>` in
  the same repository, and the close/reopen retrigger (ADR-0043) acts on that
  same PR, so neither one makes a PR look like a fork.
- **`530` / error 1033** from the public URL means the hostname exists but no
  cloudflared connector is running. Check that `TUNNEL_TOKEN` is set and look
  at `docker logs agentdock-staging-cloudflared`.

## Releasing the runner

Decisions: [ADR-0017](../docs/adr/0017-runner-distribution-homebrew-and-npm.md),
[ADR-0049](../docs/adr/0049-runner-releases-are-signed-and-cut-only-from-protected-tags.md).
A tag `runner-v<version>` runs `.woodpecker/release-runner.yml`. The workflow
tests the runner, builds the four binaries, signs `SHA256SUMS` and creates the
GitHub Release with the tarballs, `SHA256SUMS` and `SHA256SUMS.sig`. It then
publishes the npm packages, the four platform packages before
`nautelle-runner`. Last, it pushes `Formula/nautelle-runner.rb` to
`AndreyBegma/homebrew-tap`. The npm shim and the formula refuse a binary whose
checksum is not in a `SHA256SUMS` signed by `apps/runner/release-key.pub`.

The workflow file is not what keeps the secrets safe: anyone who pushes a
commit can edit it. Two settings that only an administrator can change do
that, and both must be in place before the first release.

### One-time setup

1. Create the public repository `AndreyBegma/homebrew-tap` with a `Formula/`
   directory.
2. **Signing key.** The key pair is Ed25519, and its public half is
   `apps/runner/release-key.pub`. Keep the private half offline, outside the
   repository, with mode 600. To rotate it, generate a new pair with
   `openssl genpkey -algorithm ed25519 -out runner-release-signing-key.pem` and
   `openssl pkey -in runner-release-signing-key.pem -pubout`. Put the public half in
   `release-key.pub` and in the copies the npm shim and the formula template
   embed, which the runner's tests keep equal. The change lands in a pull
   request before the next tag.
3. **Woodpecker secrets (P-02).** Add three secrets to `AndreyBegma/Nautelle`,
   each restricted to the **tag** event only. Do not tick **manual** or any
   other event; a manual run is a dry run and gets no secret.
   - `github_release_token`: a GitHub token with *contents: write* on
     `AgentDock` and on `homebrew-tap`;
   - `npm_token`: an npm automation token for the account that owns
     `nautelle-runner` and `nautelle-runner-{darwin,linux}-{arm64,x64}`;
   - `runner_signing_key`: the PEM private key whose public half is
     `apps/runner/release-key.pub`. A tag run without it fails in
     `build-release`, and a different key is refused.
4. **GitHub tag ruleset (P-03).** In `AndreyBegma/Nautelle` → Settings →
   Rules → Rulesets, add a tag ruleset, *Active*, that targets the tag pattern
   `runner-v*`. Turn on *Restrict creations*, *Restrict updates* and *Restrict
   deletions*, and give the bypass list only the repository administrators.
   Collaborators and fleet identities then cannot push a `runner-v*` tag, so
   they cannot start a run that sees the secrets.

### Each release

1. **Bump** `version` in `apps/runner/package.json` and merge it into `main`.
   The tag must match it exactly, or `build-release` fails.
2. **Rehearse** (optional). Run the pipeline by hand with a message that
   contains `[runner-release]`, for example `runner dry run [runner-release]`.
   It builds everything, signs `SHA256SUMS` with a throwaway key and stops
   before every publish step. It sees no secret. Without that marker in the
   message, a manual run does not start the release workflow. Use a branch
   other than `develop`: a manual run on `develop` also deploys staging
   through `pipeline.yml`. The marker is in the message, not a variable,
   because Woodpecker 3.x does not pass a manual run's variables to a
   workflow's `when`. Locally, `sh apps/runner/scripts/build-release.sh` does
   the same; with `RUNNER_SIGNING_KEY` set to the private key it signs with
   the release key.
3. **Tag and push** a commit on `main`, as an administrator:
   ```sh
   git fetch origin main
   git merge-base --is-ancestor <commit> origin/main && git tag runner-v0.1.0 <commit>
   git push origin runner-v0.1.0
   ```
4. **Verify:**
   - the Release `runner-v<version>` has four tarballs, `SHA256SUMS` and
     `SHA256SUMS.sig`, and the signature verifies:
     ```sh
     openssl pkeyutl -verify -pubin -inkey apps/runner/release-key.pub \
       -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig
     sha256sum -c --ignore-missing SHA256SUMS
     ```
   - `npm view nautelle-runner@<version> optionalDependencies` names the four
     platform packages at that version;
   - `brew update && brew install andreybegma/tap/nautelle-runner` then
     `nautelle-runner version` prints `<version> <os>-<arch>`. Check it on
     Apple Silicon for the first release. If Gatekeeper refuses the binary,
     ad-hoc signing (`codesign --sign -`) goes into `build-release.sh`.

A step that fails can be re-run. The Release assets are replaced, a version
already on npm is skipped, and an unchanged formula is not committed again.
`RUNNER_RELEASE_DRY_RUN=1` in the environment stops a tag run before it
publishes; it is the way to rehearse the signature with the real key.

## Releasing the images

Decisions: [ADR-0088](../docs/adr/0088-nautelle-installs-from-published-images-with-one-compose-file.md),
[ADR-0091](../docs/adr/0091-release-images-are-multi-arch-signed-with-a-cosign-key-and-published-as-a-github-release.md).
A product tag `vX.Y.Z` (ADR-0071) runs `.woodpecker/release-images.yml`. It
calls `deploy/images/release-images.sh`, which:

1. checks that `X.Y.Z` is `APP_VERSION` and that the signing key in the
   `cosign_private_key` secret belongs to `deploy/images/cosign.pub`;
2. registers QEMU for arm64 on the CI host (`tonistiigi/binfmt`, a privileged
   container; the registration stays in the host kernel) and starts a
   throwaway buildx builder (`moby/buildkit`);
3. builds the API image for the host and runs `check-api-image.sh` on it;
4. builds `ghcr.io/andreybegma/nautelle-api` and `nautelle-web` for
   `linux/amd64` and `linux/arm64` with the OCI labels (`source`, `version`,
   `revision`, `created`, `title`, `licenses`), an SBOM and `mode=max`
   provenance, and pushes them as `:X.Y.Z`, `:X.Y`, `:X` and `:latest`. A
   pre-release tag (`vX.Y.Z-rc.1`) is pushed as its own version only;
5. signs each image by digest with cosign and writes the digests to
   `.release/images.json`.

The `github-release` step then creates the `vX.Y.Z` GitHub Release, marked
latest, with a body from `scripts/release-notes.ts`: the "Summary" and "What
changed" sections of `docs/releases/vX.Y.Z.md`, the install command, the image
digests with the verify command, and the runner version of the tree. A re-run
edits the release. Runner releases are created with `--latest=false`, so the
repository's latest release stays the product's.

The public install, `deploy/compose/` and
[docs/guides/install.md](../docs/guides/install.md), pulls these images. The
web image is built with `NEXT_PUBLIC_LIVE_URL=/api/live`, a path the browser
resolves against the page's own origin, and `API_URL=http://api:8180`, the API
service in the compose file. One image therefore serves any host. Staging
keeps building its own images (`build-staging.sh`).

Once both images are pushed, the `chart` step runs
`deploy/helm/release-chart.sh` (ADR-0091). It checks the tag the same way,
stamps the chart's `version` and `appVersion` with `X.Y.Z` (`Chart.yaml` holds
only the placeholders `0.0.0` and `latest`), lints and packages it and pushes
it as `oci://ghcr.io/andreybegma/charts/nautelle:X.Y.Z` with the same
`ghcr_token`. [docs/guides/kubernetes.md](../docs/guides/kubernetes.md)
installs from it.

### One-time setup

1. **Signing key.** Generate the cosign key pair offline, with a strong
   password, outside the repository:
   ```sh
   cosign generate-key-pair
   ```
   Commit `cosign.pub` as `deploy/images/cosign.pub` in a pull request before
   the next tag, and keep `cosign.key` offline with mode 600. To rotate,
   generate a new pair, commit the new public key and replace both secrets;
   images signed before verify with the old public key from git history.
2. **Woodpecker secrets.** Add these to `AndreyBegma/Nautelle`, each restricted
   to the **tag** event only, like the runner secrets above:
   - `ghcr_token`: a GitHub token with *write:packages* for the `andreybegma`
     account;
   - `cosign_private_key`: the content of `cosign.key`;
   - `cosign_password`: its password;
   - `github_release_token`: the runner's token (*contents: write* on the
     repository) also creates the product release.

   A tag run without the cosign secrets, or with a key that does not match
   `cosign.pub`, stops before it builds anything.
3. **GitHub tag ruleset.** Add the pattern `v*` to the tag ruleset of P-03, so
   only administrators can create, move or delete a product tag.
<<<<<<< HEAD
3. **Package visibility.** After the first push, set the three packages,
   `nautelle-api`, `nautelle-web` and the chart `charts/nautelle`, to *Public*
   in the account's package settings, and link them to the repository. An
   install pulls them without a login only once they are public.
=======
4. **Package visibility.** After the first push, set both packages,
   `nautelle-api` and `nautelle-web`, to *Public* in the account's package
   settings, and link them to the repository. An install pulls them without a
   login only once they are public.
>>>>>>> origin/develop

### Each release

The `release` skill tags `vX.Y.Z` on `main` after the release pull request
merges; the tag starts the workflow, and the release note must already have its
"Summary" and "What changed" sections. To rehearse, run the pipeline by hand
with a message that contains `[image-release]` on a branch other than
<<<<<<< HEAD
`develop`: it builds both images on the host as `<APP_VERSION>-dev`, packages
the chart as `<APP_VERSION>-dev` and pushes nothing. Locally,
`sh deploy/images/release-images.sh` and `sh deploy/helm/release-chart.sh` do
the same. `NAUTELLE_IMAGES_DRY_RUN=1` and `NAUTELLE_CHART_DRY_RUN=1` stop a tag
run before it pushes.
=======
`develop`: it builds both images for both platforms as `<APP_VERSION>-dev` and
pushes, signs and releases nothing. Locally, `sh deploy/images/release-images.sh`
does the same. `NAUTELLE_IMAGES_DRY_RUN=1` stops a tag run before it pushes.
The arm64 half builds under emulation and takes several times as long as the
amd64 half.
>>>>>>> origin/develop

To check a release, verify an image and install it on a clean machine:

```sh
cosign verify --key deploy/images/cosign.pub ghcr.io/andreybegma/nautelle-api:X.Y.Z
docker buildx imagetools inspect ghcr.io/andreybegma/nautelle-api:X.Y.Z --format '{{ json .SBOM }}'
curl -fsSL https://raw.githubusercontent.com/AndreyBegma/Nautelle/main/deploy/compose/install.sh | sh -s -- --version X.Y.Z
```
