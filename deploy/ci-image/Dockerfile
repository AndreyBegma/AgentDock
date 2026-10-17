# The image the Woodpecker check steps run on: `agentdock-ci:node-bun`.
# The pipeline's first step builds it on the agent host's daemon (no registry),
# so a change here reaches CI with the commit that makes it. Not under
# .woodpecker/: Woodpecker reads every entry there as a workflow.
#
# bun is a literal, the one package.json `packageManager` pins; moving bun is
# one commit touching it, bun.lock, this file and the app Dockerfiles.
# The base is pinned by digest (ADR-0053): a moved tag cannot change what is
# built. Bump it together with deploy/ci-image/Dockerfile and the app
# Dockerfiles: `docker buildx imagetools inspect node:<version>-bookworm-slim`.
ARG NODE_IMAGE=node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
# bun comes from the official image, pinned by digest, not from an install
# script (its own stage: `COPY --from` takes no variable): `docker buildx
# imagetools inspect oven/bun:<version>`.
ARG BUN_IMAGE=oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6

FROM ${BUN_IMAGE} AS bun
FROM ${NODE_IMAGE}

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
