# The image the Woodpecker check steps run on: `agentdock-ci:node-bun`.
# The pipeline's first step builds it on the agent host's daemon (no registry),
# so a change here reaches CI with the commit that makes it. Not under
# .woodpecker/: Woodpecker reads every entry there as a workflow.
#
# bun is a literal, the one package.json `packageManager` pins; moving bun is
# one commit touching it, bun.lock, this file and the app Dockerfiles.
FROM node:24.20.0-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip git \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0"
ENV PATH=/root/.bun/bin:$PATH
