# C-188: Security [Info]: Close small trust gaps in token-saver, handoff and finish paths

> Security audit 2026-10-16 · severity **Info** · findings: DR-06, DR-10, DA-15, DA-16, DA-18 (delta audit)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
The filter hook cannot see server-delivered/MDM managed policy (DR-06); the finish guard can be skipped via the local socket directly (DR-10); `card.resume` carries its own permission mode (DA-15); Confirm split credits the plan's author (DA-16); `artifactIncomplete` is set by the caller (DA-18).

## Fix
Hook: no rewrite when a managed policy file exists; run the guard server-side of the socket; derive resume permission mode on the runner from the round; credit the confirming user; compute artifactIncomplete in the runner guard only.

## Acceptance criteria
- [ ] Each item has a test.

## Decision
none needed

Full audit material: orchestrator scratchpad `security/10-delta-runner.md`, `11-delta-api-shared.md`, `12-delta-web.md`.
