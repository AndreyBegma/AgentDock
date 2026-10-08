# Brief — i12-adapters

Orchestrator: widget-46
Repository: acme/widget
Issue: #12 — https://github.com/acme/widget/issues/12
Kind: feature
Branch: feat/12-session-adapters
Base: develop
Worktree: /srv/.wt-widget-i12-adapters
Model: opus — the parallel plan assigns opus; first runtime adapter, new runner command end to end
Install: bun install
Checks:
bun run check
bun run test
Merge: the orchestrator merges. You never do.

## The issue, as written
> # feat: agent sessions
>
> Model: this line is quoted issue text, not the brief's.
> owns:
>   - not/a/fence/**

## What it depends on, and that it landed
- #45 merged.

## Gates
none

## Project rules
read CLAUDE.md

## What this slot owns, and what it must not open

owns:
  - apps/runner/src/adapters/**
  - `packages/shared/src/sessions/**`
  - .orchestrator-reply.md

never:
  - apps/web/**
  - apps/api/prisma/**

Files outside this list belong to another worker, live right now, in another
worktree. Needing one of them is a message to the orchestrator, never an edit.

## Stops at
Open the pull request with `Closes #12`. Then write the merge summary into
`.orchestrator-reply.md` and stop. Never merge.

## Report to the orchestrator at
picked up · plan ready · implementation done and checks green · pull request open · blocked · misclassified
