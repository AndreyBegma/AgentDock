# Nautelle API image (ADR-0016). Built from the repository root:
#
#   docker build -t agentdock-api:staging -f apps/api/Dockerfile .
#
# The runtime stage carries production dependencies only: no ts-node, jest or
# Nest CLI. The entrypoint migrates with the Prisma CLI (a dependency for that
# reason) and seeds from the compiled dist/prisma/seed.js.
# deploy/staging/check-api-image.sh fails the build if dev tooling comes back.

# The base is pinned by digest (ADR-0053): a moved tag cannot change what is
# built. Bump it together with deploy/ci-image/Dockerfile and the app
# Dockerfiles: `docker buildx imagetools inspect node:<version>-bookworm-slim`.
ARG NODE_IMAGE=node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
# bun comes from the official image, pinned by digest, not from an install
# script (its own stage: `COPY --from` takes no variable): `docker buildx
# imagetools inspect oven/bun:<version>`.
ARG BUN_IMAGE=oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6

FROM ${BUN_IMAGE} AS bun

# ─── base ────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

WORKDIR /app

# Every workspace manifest, not only the API's: `--frozen-lockfile` refuses a
# workspace set that differs from bun.lock.
COPY package.json bun.lock bunfig.toml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/runner/package.json apps/runner/
COPY packages/shared/package.json packages/shared/

# ─── deps (everything the build needs) ───────────────────────────────────────
FROM base AS deps

RUN bun install --frozen-lockfile

# ─── prod-deps (what the runtime ships) ──────────────────────────────────────
# The API and its workspace dependencies only, without dev dependencies.
FROM base AS prod-deps

RUN bun install --frozen-lockfile --production --filter @nautelle/api

# ─── builder ─────────────────────────────────────────────────────────────────
FROM deps AS builder

COPY tsconfig.json turbo.json ./
COPY packages/shared/ packages/shared/
COPY apps/api/ apps/api/

RUN cd apps/api && bunx prisma generate
RUN bunx turbo run build --filter=@nautelle/api...

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8180
# The Prisma CLI the entrypoint calls.
ENV PATH=/app/node_modules/.bin:$PATH

COPY --from=builder --chown=node:node /app/package.json /app/tsconfig.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules node_modules/
# The client `prisma generate` wrote in the builder (prisma-client-js output).
COPY --from=builder --chown=node:node /app/node_modules/.prisma node_modules/.prisma/
COPY --from=builder --chown=node:node /app/packages/shared packages/shared/
COPY --from=builder --chown=node:node /app/apps/api apps/api/
# The attachments volume's mount point (ADR-0031): a new named volume takes
# this directory's owner, so the API (uid node) can write into it.
RUN mkdir -p /data/attachments && chown node:node /data/attachments

USER node
WORKDIR /app/apps/api

EXPOSE 8180

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8180)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["sh", "docker-entrypoint.sh"]
CMD ["node", "dist/src/main"]
