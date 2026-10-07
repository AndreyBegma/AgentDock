# ADR-0004: GitHub issues are the task queue

Status: accepted · Date: 2026-10-07

## Context

The orchestrator already treats open issues with the ready label as its queue and labels as state. A second queue in AgentDock would diverge.

## Decision

The database caches issues, labels, PRs and checks; GitHub stays the source of truth. Creating a task in the UI creates an issue (directly or by running cs-spec / cs-issue). Actions run through the runner's `gh`; events arrive via a GitHub App (M3) and runner polling before that.

## Consequences

No sync conflicts. Works only for GitHub-hosted projects; GitLab (e.g. cockpit) is out of scope until an adapter exists.
