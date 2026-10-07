# ADR-0001: Control plane and per-machine runner

Status: accepted · Date: 2026-10-07

## Context

AgentDock must work locally and remotely. The orchestrator's state lives in tmux, git worktrees and files inside `.git` on the machine that runs the fleet; a web server elsewhere cannot read them.

## Decision

Split into a control plane (`apps/api`, `apps/web`, PostgreSQL) and a runner daemon (`apps/runner`) on every machine that hosts projects. The runner dials out over WSS. Local mode is the same runner on the same host.

## Consequences

No inbound port on fleet machines. One code path for local and remote. Cost: a protocol to design and version (runner-protocol.md), and a second deployable. Rejected: a single Next.js monolith reading the local disk (Mission Control) — it cannot see a second machine.
