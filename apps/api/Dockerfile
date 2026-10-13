# AgentDock API image (ADR-0016). Built from the repository root:
#
#   docker build -t agentdock-api:staging -f apps/api/Dockerfile .
#
# The runtime stage keeps the full dependency tree, dev dependencies included:
# the entrypoint needs the Prisma CLI for `migrate deploy` and ts-node for the
# seed. A slimmer image is a production concern, not a staging one.

# ─── deps ────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0"
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

# Every workspace manifest, not only the API's: `--frozen-lockfile` refuses a
# workspace set that differs from bun.lock.
COPY package.json bun.lock bunfig.toml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/runner/package.json apps/runner/
COPY packages/shared/package.json packages/shared/

RUN bun install --frozen-lockfile

# ─── builder ─────────────────────────────────────────────────────────────────
FROM deps AS builder

COPY tsconfig.json turbo.json ./
COPY packages/shared/ packages/shared/
COPY apps/api/ apps/api/

RUN cd apps/api && bunx prisma generate
RUN bunx turbo run build --filter=@agentdock/api...

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8180
# The Prisma CLI and ts-node (seed) the entrypoint calls.
ENV PATH=/app/node_modules/.bin:$PATH

COPY --from=builder --chown=node:node /app/package.json /app/tsconfig.json ./
COPY --from=builder --chown=node:node /app/node_modules node_modules/
COPY --from=builder --chown=node:node /app/packages/shared packages/shared/
COPY --from=builder --chown=node:node /app/apps/api apps/api/

USER node
WORKDIR /app/apps/api

EXPOSE 8180

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8180)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["sh", "docker-entrypoint.sh"]
CMD ["node", "dist/src/main"]
