# C-133: Security [Medium]: Verify the Bun download and pin base images by digest

> Security audit 2026-10-16 · **WI-31** · severity **Medium** · size **S** · findings: F-31 (Z9 M4)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**F-31.** The build toolchain is fetched unverified: `RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0"` in `deploy/ci-image/Dockerfile:14`, `apps/api/Dockerfile:16` and `apps/web/Dockerfile:17`. The app images build `FROM node:24-bookworm-slim` (`apps/api/Dockerfile:10,42`, `apps/web/Dockerfile:11,49`), a floating tag; the CI image pins a version but not a digest (`deploy/ci-image/Dockerfile:8`). The staging compose pins tags, not digests (`deploy/staging/docker-compose.yml:22,42,98,113`).

**Attacker.** Whoever can change what the install script or a floating tag serves (a compromised CDN, registry or upstream account).

**Scenario.** A changed install script or base image is pulled into the next CI or staging build without any check.

**Impact.** Supply-chain compromise of the CI image, the released runner and staging.

## Fix
- Install Bun with `COPY --from=oven/bun:1.4.0@sha256:… /usr/local/bin/bun …`, or download the release zip and verify its SHA256, in all three Dockerfiles.
- Pin `node:24.x-bookworm-slim@sha256:…` in both app Dockerfiles and the CI image.
- Digest-pin postgres, redis, caddy and cloudflared in `deploy/staging/docker-compose.yml`.
- Let Renovate own the digests (`pinDigests` for the docker managers).
- Add a check (script in `bun run check`) that fails on a `FROM` without `@sha256:` and on `curl … | bash`.

## Acceptance criteria
- A check script run by `bun run check` fails on any `FROM` without `@sha256:` and on any `curl … | bash` / `| sh` in a Dockerfile, and passes on the fixed files
- The CI image, API image and web image build
- The staging compose file has every third-party image digest-pinned
- `renovate.json` pins and updates docker digests

## Touches
- deploy/ci-image/Dockerfile
- apps/api/Dockerfile
- apps/web/Dockerfile
- deploy/staging/docker-compose.yml
- renovate.json
- scripts/check-images.ts

## Decision
none needed

## Must not run in parallel with
- WI-03
- WI-70
- WI-71


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
