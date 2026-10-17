# ADR-0052: Pull-request pipelines are untrusted: no Docker socket, no host volume, no secret

Status: accepted · Date: 2026-10-16 ·
Card: C-105 (security audit 2026-10-16, WI-03, findings F-03 and F-04) ·
Spec: [`docs/specs/card-105-security-high-keep-the-docker-socket-and.md`](../specs/card-105-security-high-keep-the-docker-socket-and.md)

## Context

Woodpecker runs `.woodpecker/pipeline.yml` on every pull request from the pull request's own branch: its pipeline file, its build scripts, its `package.json`. Pull requests from forks wait for approval, but pull requests from branches of this repository do not, and card workers push such branches by themselves. A collaborator, or a fleet worker that read a prompt injection, can therefore run any command in CI.

Before this decision a pull request could reach two things on the agent host:

- **The Docker socket (F-03).** The `ci-image` step mounted `/var/run/docker.sock` and had no `when`, so it ran on pull requests. A pull request that edits the step runs anything on the host's daemon: root on the host, which also runs staging, the runners and their credentials.
- **The shared caches (F-04).** `install`, `typecheck`, `build` and `test` mounted `/home/archi/ci-cache/agentdock/{bun,turbo}`, and the runner release mounted the same directories. A pull request could write a poisoned package or turbo artefact that the next push build, staging build or released runner binary restored.

The base images of the app Dockerfiles also floated (`node:24-bookworm-slim`), so a moved tag changed what staging ran.

## Decision

1. **Trust levels.** A pipeline started by a pull request is *untrusted*. A push to `develop` or `main`, a tag and a manual run are *trusted*: their code was merged, or a person started them.
2. **An untrusted step gets no Docker socket, no host volume, no secret and no privilege.** Every step that mounts the socket (`ci-image`, `build-staging`, `deploy-staging`) runs on push and manual events only. A pull request runs on the `agentdock-ci:node-bun` image the last trusted pipeline built; a change to `deploy/ci-image/` reaches CI once it is merged. The image is used by tag, not by digest: it never leaves the host, and a local image has no repository digest. Only a trusted pipeline can move that tag.
3. **No step mounts a host cache.** bun's install cache lives in the step's container and turbo's in the pipeline's workspace; both die with the pipeline. Nothing one pipeline writes is restored by another.
4. **The release starts clean.** `.woodpecker/release-runner.yml` mounts no cache, installs with `--frozen-lockfile` from an empty cache, and builds the binaries with `TURBO_FORCE`, so no turbo cache entry becomes part of a release.
5. **Base images are pinned by digest** (`ARG NODE_IMAGE=node:<version>@sha256:…` in `apps/api`, `apps/web` and `deploy/ci-image`) and every `docker build` uses `--pull`.
6. **A check keeps it so.** `scripts/check-ci.ts`, run by `bun run check`, reads the workflows in `.woodpecker/` and fails when a step that can run on a pull request mounts a volume, is privileged or reads a secret; when a step that can run on a tag mounts anything but the Docker socket; and when a `bun install` lacks `--frozen-lockfile`. A condition it cannot evaluate counts as "may run".
7. **The boundary is the CI server, not the repository.** A pull request can edit the pipeline file and the check together, so items 2–6 stop mistakes, not an attacker. The target is a separate Woodpecker agent for pull requests, without the Docker socket and without trusted volumes (D-11). The audit's interim measure was to make every pull request wait for approval (*Require approval*: pull requests, P-01). The person chose to keep *Require approval*: forks instead (#504), so that card workers' pull requests start at once. Until the separate agent exists, this is an accepted, open risk: a same-repository pull request can still edit its pipeline file and mount the Docker socket. Switching to *pull requests* closes it at the cost of a manual Approve on every pull request; only a person can change either setting (`deploy/README.md`).

## Consequences

- Pull requests stop writing to the host, but pipelines lose the cross-run caches: every `bun install` downloads its packages and every build starts cold. The old cache directories are no longer read and should be deleted, since a pull request may already have written to them.
- A pull request that changes `deploy/ci-image/` is tested on the previous image. Its effect shows on the first push after the merge.
- Until the untrusted agent exists, anyone who can push a branch of this repository, a prompt-injected card worker included, can still reach the Docker socket by editing the pipeline in a pull request. This decision narrows the exposure to deliberate edits; it does not remove it.
- Moving the Node base image means updating the digest in three Dockerfiles in one commit.
