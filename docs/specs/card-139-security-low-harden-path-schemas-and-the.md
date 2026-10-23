# C-139: Security [Low]: Harden path schemas and the in-repo docs-source check

> Security audit 2026-10-16 · **WI-37** · severity **Low** · size **S** · findings: L-08 (Z9 L3, Z1 I5, Z6 P2-B4-5)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-08.** `absolutePathSchema` (`packages/shared/src/protocol/projects.ts:5-8`) only checks a leading `/`: it allows `..` segments, NUL, newlines and any length. `watchedProjectSchema.root` (:20) and the inspection `root` (:123) are plain `z.string().min(1)`. The in-repo docs check is a bare prefix test (`apps/api/src/projects/projects.service.ts:437`), so `<root>/../..` passes.

**Attacker.** A project admin, or a compromised API sending paths to the runner.

**Scenario.** A docs-source override or watched root with `..` points the runner outside the repository.

**Impact.** The runner reads or reports files outside the project; path confusion in logs.

## Fix
- `absolutePathSchema` rejects `..` segments, control characters and anything over 4096 bytes.
- `watchedProjectSchema.root` and the inspection `root` use it.
- `projects.service.ts` normalises with `path.posix.normalize` before the prefix check, and the DTO refuses `..`.

## Acceptance criteria
- Schema tests reject `/a/../b`, a path with a newline, a path with NUL and a 5000-byte path
- An e2e test: a docs override `<root>/../../etc` gives 422
- Existing project fixtures still parse

## Touches
- packages/shared/src/protocol/projects.ts
- apps/api/src/projects/projects.service.ts
- apps/api/src/projects/dto.ts

## Decision
none needed

## Must not run in parallel with
- WI-33
- WI-34
- WI-05


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
