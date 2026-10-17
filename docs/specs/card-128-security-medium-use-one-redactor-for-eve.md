# C-128: Security [Medium]: Use one redactor for every runner-to-server text channel

> Security audit 2026-10-16 · **WI-26** · severity **Medium** · size **M** · findings: F-24 (Z5 M7)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
F-24 (Z5 M7). `apps/runner/src/pane/redact.ts:5-13` masks only four token shapes plus PEM blocks, and pane frames, run logs, checkpoints and messages use it; `local/redact.ts` has broader rules (assignments, `Authorization`, JSON members) but only for hook content. Skill-run patches are sent **unredacted**, up to 128 KiB (`apps/runner/src/skills/run/finished.ts:83-84`).

**Attacker.** Any project member (viewers read this content, ADR-0043), or anyone with DB access.

**Scenario.** An agent prints a database URL or a token of a shape the pane redactor does not know, or a skill run's patch adds an `.env` file.

**Impact.** Secrets from developer machines reach the server, are stored and shown.

## Fix
- Merge `pane/redact.ts` into the `local/redact.ts` rules (assignments, `Authorization`, JSON members) and add token shapes: `github_pat_`, `glpat-`, `sk_live_`, `AIza`, JWTs, `xoxe-`, and URL userinfo (reuse the WI-22 helper).
- Apply the one redactor to pane frames, run log, report, checkpoints, messages, PR bodies and skill-run patches.
- Add a runner-local option `skills.keepPatchesLocal` (in `runner.json`, default off): when on, the patch stays on the runner and the server gets only the file list and a hash.

## Acceptance criteria
- Table-driven redaction test covering every listed token shape, assignments, `Authorization` headers, JSON members and URL userinfo.
- Regression test: a skill run whose patch adds `.env` with `DATABASE_URL=postgres://u:pw@h/db` ships it masked.
- Pane test: a frame with `DATABASE_URL=` is masked.
- With `skills.keepPatchesLocal: true`, `skill.finished` carries no patch body, only the file list and hash; the server cannot change the option.

## Touches
- apps/runner/src/pane/redact.ts
- apps/runner/src/local/redact.ts
- apps/runner/src/pane/streamer.ts
- apps/runner/src/skills/run/stream.ts
- apps/runner/src/skills/run/finished.ts
- apps/runner/src/skills/run/collect.ts
- apps/runner/src/collectors/replies/**
- apps/runner/src/config.ts

## Decision
D-15 — skill-run patches are redacted, plus an opt-in to keep them on the runner only (00-decisions.md)

## Must not run in parallel with
- WI-22
- WI-23
- WI-05


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
