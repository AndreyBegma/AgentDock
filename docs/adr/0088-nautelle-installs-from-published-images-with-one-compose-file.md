# ADR-0088: Nautelle installs from published images with one compose file

Status: accepted · Date: 2026-10-24 ·
Card: C-365 ·
Spec: [`docs/specs/card-365-install-in-one-command-published-images.md`](../specs/card-365-install-in-one-command-published-images.md) ·
Amends [ADR-0071](0071-the-product-is-released-by-version-with-a-changelog-and-release-notes.md) (its consequence that `vX.Y.Z` tags trigger nothing in CI) ·
Keeps: [ADR-0016](0016-staging-on-the-agent-host-behind-a-cloudflare-tunnel.md), [ADR-0053](0053-pull-request-pipelines-are-untrusted.md), [ADR-0087](0087-the-first-admin-is-created-in-the-browser-with-a-one-time-setup-token.md) ·
Amended by [ADR-0090](0090-release-images-are-multi-arch-signed-with-a-cosign-key-and-published-as-a-github-release.md) (multi-arch signed images; the tag pipeline creates the GitHub Release)

## Context

The only way to run Nautelle was the staging setup of ADR-0016: clone the
repository, build both images on the host, write two env files by hand and
pick a topology in `TRUST_PROXY`. Nobody outside the project can do that in a
minute, and nobody should need the source tree to run a release. The web
image also baked its live socket URL at build time (`NEXT_PUBLIC_LIVE_URL`),
so one built image served one host only.

## Decision

1. **A product tag publishes the images.** `vX.Y.Z` on `main` runs
   `.woodpecker/release-images.yml`, which builds
   `ghcr.io/andreybegma/nautelle-api` and `nautelle-web` and pushes them as
   `:X.Y.Z` and `:latest` (a pre-release tag gets no `:latest`). The tag must
   equal `APP_VERSION`. Images are amd64 only for now: they are built on the CI
   host's own daemon, without buildx or emulation.
2. **The release follows ADR-0053.** The push secret `ghcr_token` is
   restricted to the tag event; a manual run with `[image-release]` in its
   message is a dry run that builds and pushes nothing; pull requests never
   run the workflow; `v*` tags join the protected tag ruleset. The bases stay
   digest-pinned and every build runs with `--pull`.
3. **One web image serves any host.** `NEXT_PUBLIC_LIVE_URL` may be a path;
   the browser puts it on the page's own origin (`ws` or `wss`, with its
   port). The published image is built with `/api/live`, which the default
   CSP `connect-src 'self'` already allows, and reaches the API from the
   server as `http://api:8180`.
4. **One compose file, three modes.** `deploy/compose/docker-compose.yml`
   runs the published images with PostgreSQL, Redis and Caddy, which sends
   `/api/*` to the API (prefix stripped) and everything else to the web app.
   The mode is a compose profile chosen by `COMPOSE_PROFILES` in `.env`, so a
   mode change edits no file:
   - `local`: Caddy on `${NAUTELLE_BIND:-127.0.0.1}:${NAUTELLE_PORT:-8000}`;
   - `tunnel`: `cloudflared` with `TUNNEL_TOKEN`, Caddy published nowhere;
   - `tls`: Caddy on 80 and 443 with automatic HTTPS for `NAUTELLE_DOMAIN`.
   Each mode has its own Caddy service, all reachable as `proxy`. The
   Caddyfile is inline in the compose file (`configs.content`), so an install
   is two files. This needs Docker Compose 2.24 or newer.
5. **One required setting.** `NAUTELLE_URL` (default `http://localhost:8000`)
   gives `API_URL`, `WEB_URL`, `APP_URL` and `PUBLIC_URL`, each overridable.
   The API runs with `TRUST_PROXY=uniquelocal`, since Caddy is always the
   peer on a private network. Passwords have no default: compose refuses to
   start without them. The API's keys are not settings at all: it generates
   them on its first boot into `secrets.json` in the named `data` volume at
   `/data` (C-366), which also holds the attachments. Anything else the API
   reads goes in an optional `api.env` next to the compose file.
6. **`install.sh` is the install.** It checks Docker and Compose, fetches the
   two files into `./nautelle`, writes `.env` with random Postgres and Redis
   passwords, applies `--url`, `--tunnel-token` or `--domain`, starts the
   stack, waits for the API health check and prints the address and the
   one-time setup link the API logged (ADR-0087). `--admin-email` and
   `--admin-password` create the first administrator headlessly instead; they
   reach the API through that start's environment and are never written to
   `.env`. A re-run keeps every password in `.env` and changes only what a flag
   names, so it is also the upgrade and the mode switch.
7. **Plain HTTP is a development install.** For an `http://` address
   `install.sh` writes `APP_ENV=development` (a browser drops `Secure`
   cookies on plain HTTP away from localhost) and an empty `PUBLIC_URL`
   (GitHub cannot deliver to it). An `https://` address runs as
   `production`.
8. **Nautelle's own images are pinned by tag.** `scripts/check-images.ts`
   still requires a digest for every other image, and allows
   `ghcr.io/andreybegma/nautelle-api` and `nautelle-web` by tag, because the
   install follows `NAUTELLE_VERSION`.

## Consequences

- ADR-0071's consequence that `vX.Y.Z` tags trigger nothing no longer holds;
  a product release now also publishes images, and its `APP_VERSION` must be
  right before the tag.
- The packages must be public on GHCR before an install can pull them without
  a login (deploy/README.md, one-time setup).
- A backup is the database and the `data` volume together: without
  `secrets.json` a restored database cannot unseal its secrets, and an API
  started before `secrets.json` is restored generates keys that do not fit.
- Staging keeps its own build and setup (ADR-0016); the public install shares
  no file with it.
- arm64 hosts cannot run the images yet; adding them means a multi-platform
  build in the workflow.
