# Nautelle in one container (ADR-0097): the API, the web app and Caddy under
# tini, on port 8000. Without DATABASE_URL / REDIS_URL it also starts an
# embedded PostgreSQL 16 and Redis with their data under /data (demo mode).
#
#   docker run -p 8000:8000 -v nautelle:/data ghcr.io/andreybegma/nautelle
#
# It is assembled from the published API and web images, not rebuilt from
# source: deploy/images/release-images.sh passes the digests it has just pushed
# as API_IMAGE and WEB_IMAGE. Built from the repository root:
#
#   docker build -f deploy/all-in-one/Dockerfile \
#     --build-arg API_IMAGE=ghcr.io/andreybegma/nautelle-api:X.Y.Z \
#     --build-arg WEB_IMAGE=ghcr.io/andreybegma/nautelle-web:X.Y.Z .

# Third-party bases are pinned by digest (ADR-0053); Nautelle's own images are
# selected by release, as in deploy/compose/ (ADR-0088). NODE_IMAGE is the one
# apps/api/Dockerfile and apps/web/Dockerfile run on: bump them together.
# PostgreSQL is the base for its Debian packages, its entrypoint's conventions
# and gosu; `docker buildx imagetools inspect <image>:<tag>` gives a digest.
ARG POSTGRES_IMAGE=postgres:16.5-bookworm@sha256:53f3e608f9475ce120ced2d0f430b89458d7faa28530e0b0977a6af64d294877
ARG NODE_IMAGE=node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
ARG REDIS_IMAGE=redis:7.4.11-bookworm@sha256:44960b3100c48159a66d28c18b0588c193492e25f7551d60e51dd464fc3eca5b
ARG CADDY_IMAGE=caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
ARG API_IMAGE=ghcr.io/andreybegma/nautelle-api:latest
ARG WEB_IMAGE=ghcr.io/andreybegma/nautelle-web:latest

# `COPY --from` takes no variable: each source is its own stage.
FROM ${NODE_IMAGE} AS node
FROM ${REDIS_IMAGE} AS redis
FROM ${CADDY_IMAGE} AS caddy
FROM ${API_IMAGE} AS api
FROM ${WEB_IMAGE} AS web

FROM ${POSTGRES_IMAGE} AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# Node is one binary on the same Debian release; Caddy is a static Go binary.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=redis /usr/local/bin/redis-server /usr/local/bin/redis-cli /usr/local/bin/
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy

# The API, the web app, Redis and Caddy run as `nautelle`; PostgreSQL as
# `postgres`, the base image's user. A binary that misses a library fails here.
RUN groupadd --gid 1000 nautelle \
    && useradd --uid 1000 --gid nautelle --home-dir /opt/nautelle --no-create-home nautelle \
    && node --version && redis-server --version && caddy version && postgres --version

COPY --from=api --chown=nautelle:nautelle /app /opt/nautelle/api
COPY --from=web --chown=nautelle:nautelle /app /opt/nautelle/web
COPY deploy/all-in-one/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0755 deploy/all-in-one/start.sh /usr/local/bin/nautelle-start

# /data holds everything that must survive the container: the API's
# secrets.json and attachments, and in demo mode the databases. Back it up:
# without secrets.json the encrypted data is lost.
RUN mkdir -p /data && chown nautelle:nautelle /data
VOLUME ["/data"]

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The start script stops the services itself, in order: tini passes it the
# signal and reaps whatever is left. The base image's SIGINT and `postgres`
# command are not ours.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/nautelle-start"]
CMD []
