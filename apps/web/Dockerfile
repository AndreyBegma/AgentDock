# AgentDock web image (ADR-0016). Built from the repository root:
#
#   docker build -t agentdock-web:staging -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_LIVE_URL=wss://dock.example.com/api/live .
#
# NEXT_PUBLIC_LIVE_URL is baked into the client bundle and API_URL into the
# routes manifest (next.config.ts rewrites run at build time): both are build
# arguments, and changing either means rebuilding the image.

# The base is pinned by digest (ADR-0049): a moved tag cannot change what is
# built. Bump it together with deploy/ci-image/Dockerfile and the app
# Dockerfiles: `docker buildx imagetools inspect node:<version>-bookworm-slim`.
ARG NODE_IMAGE=node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

# ─── deps ────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0"
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

COPY package.json bun.lock bunfig.toml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/runner/package.json apps/runner/
COPY packages/shared/package.json packages/shared/

RUN bun install --frozen-lockfile

# ─── builder ─────────────────────────────────────────────────────────────────
FROM deps AS builder

ARG NEXT_PUBLIC_LIVE_URL
RUN test -n "$NEXT_PUBLIC_LIVE_URL" \
  || (echo "NEXT_PUBLIC_LIVE_URL build arg is required — the client bundle bakes it in." && exit 1)
ENV NEXT_PUBLIC_LIVE_URL=${NEXT_PUBLIC_LIVE_URL}

ARG API_URL=http://api:8180
ENV API_URL=${API_URL}
ENV NEXT_TELEMETRY_DISABLED=1

COPY tsconfig.json turbo.json ./
COPY packages/shared/ packages/shared/
COPY apps/web/ apps/web/

RUN bunx turbo run build --filter=@agentdock/web...

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3517
# The standalone server binds 127.0.0.1 unless told otherwise.
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

RUN mkdir -p /app/apps/web/.next/cache && chown -R node:node /app/apps/web/.next

USER node

EXPOSE 3517

# Signed-out pages redirect; any answer under 500 means the server is up.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3517)+'/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
