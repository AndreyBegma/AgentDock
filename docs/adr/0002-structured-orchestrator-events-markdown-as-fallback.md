# ADR-0002: Structured orchestrator events, markdown as fallback

Status: accepted · Date: 2026-10-07

## Context

Code Sentinel records its state as markdown (`round-HHMM.md`, briefs, `.orchestrator-reply.md`) and an unpersisted stdout stream (`watch.sh`). Parsing prose breaks whenever its wording changes.

## Decision

Extend code-sentinel to append versioned JSON events to `<git-common-dir>/cs-orchestrator/events.jsonl` and keep `state.json` current (see plugin/code-sentinel-changes.md). The runner tails them as the primary source. Markdown collectors stay for older plugin versions and past rounds, and their output is marked `source: scraped`.

## Consequences

Reliable live state; the plugin gains a contract it must keep stable (schema `v`). Until M2.1 lands, M1 runs on the markdown collectors.
