# ADR-0012: Detect where a project's documentation lives

Status: accepted · Date: 2026-10-07

## Context

Specs and decisions may live in-repo (`docs/`) or in a separate repository (denitsa-app → denitsa-documentation, luna-studio → luna-studio-documentation); today the link exists only in prose.

## Decision

On connect, the runner resolves a docs source by priority: `orchestrator.specDir` (path or repo URL) → sibling `<name>-documentation` / `<name>-docs` → same-owner remote repo → links in AGENTS.md / CLAUDE.md / README → back-link from a docs README → in-repo `docs/`. It classifies folders (specs, ADRs, roadmap, reports) and records whether the source is a git repo. The user can override.

## Consequences

Works for every existing project without edits; code-sentinel gains `specDir` outside the repo (plugin changes).
