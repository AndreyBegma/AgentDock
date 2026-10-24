---
title: Requirements
description: What the server and the runner machines need.
---

Nautelle has two parts, and they can run on the same machine or on different
ones:

- **The server** (control plane): the web app, the API, PostgreSQL, Redis and
  a Caddy proxy, installed with one compose file.
- **A runner** on each machine where your repositories live and your agents
  work. It connects out to the server; the server never reaches into it.

## Server

- A Linux host on **amd64** (x86-64). The published images are amd64 only for
  now.
- **Docker** with **Docker Compose 2.24** or newer, and a user that can run
  `docker` (root, or a member of the `docker` group). The install checks both.
- `curl` or `wget`, to fetch the install script.
- Memory: the compose file caps the services at about 3 GB together
  (PostgreSQL 1 GB, API 1 GB, web 512 MB, Redis 256 MB, Caddy 128 MB). These are
  limits, not what an idle install uses; a host with 4 GB is comfortable.
- Network, depending on the [exposure mode](../install/#exposure-modes):
  nothing for local mode, outbound HTTPS for a Cloudflare tunnel, or ports 80
  and 443 reachable from the internet for your own domain with HTTPS.

## Runner machines

- **macOS** (arm64 or x64) or **Linux** (arm64 or x64). Windows is not
  supported.
- **git** and **tmux**: every card and every fleet slot runs in its own
  worktree and tmux session.
- **Claude Code** (and **Codex**, if you use Codex workers), signed in on that
  machine. Their credentials never leave it.
- The **GitHub CLI** (`gh`) signed in with `gh auth login`, for pull requests
  and checks.
- Your repositories cloned on the machine. Only GitHub repositories can be
  connected.

The runner itself is a single binary from Homebrew, or an npm package that
needs Node. See [Pair a runner](../pair-a-runner/).
