# AgentDock documentation

AgentDock is a self-hosted control plane for AI coding-agent fleets. It connects
projects, watches and steers the Code Sentinel orchestrator and its workers, runs
skills on projects, and records what every agent did, on which model, at what
cost. It works with Claude Code and Codex.

This folder is the authority for what AgentDock is and how it is built. Code
that disagrees with it is either a bug or an undocumented decision — record the
decision (`adr/`) in the same pull request that makes it.

| Folder | What lives there |
|---|---|
| [`product/`](product/) | [PRD](product/prd.md), [glossary](product/glossary.md), [roadmap](product/roadmap.md) |
| [`architecture/`](architecture/) | [overview](architecture/overview.md), [runner protocol](architecture/runner-protocol.md), [event schema](architecture/event-schema.md), [data model](architecture/data-model.md), [security](architecture/security.md), [cost model](architecture/cost-model.md) |
| [`adr/`](adr/) | architecture decision records, numbered, never rewritten — superseded |
| [`specs/`](specs/) | one specification per issue, `<issue>-<slug>.md` (`orchestrator.specDir`) |
| [`ui/`](ui/) | [glass-ui usage and gaps](ui/glass-ui.md), [screens](ui/screens.md) |
| [`plugin/`](plugin/) | [changes AgentDock needs in code-sentinel](plugin/code-sentinel-changes.md) |

## Workflow

1. A feature starts as `/code-sentinel:spec` → a spec in `specs/` and a GitHub
   issue in `AndreyBegma/AgentDock` with acceptance criteria and a
   `## Parallel plan`.
2. The spec PR merges first; then the issue gets `cs:ready`.
3. `/code-sentinel:orchestrator` builds it.

Everything in this folder is written in English.

## References (inspiration only — nothing is copied)

- [Mission Control](https://github.com/builderz-labs/mission-control) — agent
  fleet dashboard; access-request flow, webhook delivery log, skill registry
  proxy. We reject its single-host monolith and mtime-based liveness.
- [Langfuse](https://github.com/langfuse/langfuse) — LLM observability; model
  price definitions with regex match and tiers, trace tree / session views. We
  reject its ClickHouse/Redis/S3 ingestion stack as overkill at our scale.
