# C-185: Security [Low]: Bound and single-line the new Steward, handoff and design-frame text fields

> Security audit 2026-10-16 · severity **Low** · findings: DA-06, DA-07, DA-08, DA-09, DA-13, DA-17 (delta audit)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
Trailer-guard regexes in `packages/shared/src/steward/contracts.ts:232-240` are quadratic (80k newlines: 13 s) and will run in the push guard; designs accept any number of frames incl. empty ones (>255 breaks first run and spec publication, `planner/types.ts:413`); frame names and Confirm-split titles can span lines (prompt/header injection); haiku-written Steward reasons reach Telegram with only NUL/newline stripped and the digest prose has no contract; frame slugs are O(n²).

## Fix
Use `[ \t]*` instead of `\s*`; cap frames (e.g. 32) and refuse empty; single-line + length-cap frame names, split titles, steward reasons; a strict digest prose schema with length cap; linear slugging.

## Acceptance criteria
- [ ] Regex timing test under 50 ms on 100k chars.
- [ ] 33 frames refused.
- [ ] Multi-line frame name refused.

## Decision
none needed

Full audit material: orchestrator scratchpad `security/10-delta-runner.md`, `11-delta-api-shared.md`, `12-delta-web.md`.
