# C-103: Security [High]: Fix catastrophic backtracking in the issue-body heading regex

> Security audit 2026-10-16 · **WI-01** · severity **High** · size **S** · findings: F-01 (Z4b P2-01, Z9 P2-01, the body part of Z4 D-09)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
`HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/` in `packages/shared/src/queue/rules.ts:28` backtracks cubically on a heading line followed by a long run of whitespace and a non-hash character. It runs on every issue body the API reads: `apps/api/src/queue/queue.service.ts`, `queue-state.ts`, `apps/api/src/local/local-handlers.ts` (`issue.create`, `handoff.create`), `fleet/graph.ts` and the web `lib/queue/format.ts`. The `body` field of `apps/api/src/queue/dto.ts:37` has no `@MaxLength`.

**Attacker.** An operator, an agent session through the MCP `handoff` / `create_issue` tools, or any issue author on a public repository (the snapshot projector reads every issue body).

**Scenario.** One issue body with a few dozen such heading lines is enough; the API's event loop spins for minutes on each recompute.

**Impact.** The whole API freezes (single Node process): every user, every runner connection, every webhook.

## Fix
- Replace `HEADING` with a linear pattern, `^ {0,3}(#{1,6})(?:[ \t]+(.*))?$`, and strip the closing `#`s and whitespace in code (`trimEnd` → drop trailing `#+` → `trimEnd`).
- Skip heading detection on lines longer than 1 KiB.
- Add `@MaxLength` (the protocol body cap) to `body` in `apps/api/src/queue/dto.ts`.

## Acceptance criteria
- Regression test in `packages/shared/src/queue/rules.spec.ts`: 50 headings of the form `# a` + 64 KiB of spaces and tabs + `b`; `specGap` and `sections` return in under 50 ms
- The existing heading tests pass unchanged (closing hashes, ATX levels 1-6, up to 3 leading spaces)
- A line longer than 1 KiB is never treated as a heading (unit test)
- e2e: `POST /projects/:id/issues` with a body over the cap answers 400

## Touches
- packages/shared/src/queue/rules.ts
- packages/shared/src/queue/rules.spec.ts
- apps/api/src/queue/dto.ts

## Decision
none needed

## Must not run in parallel with
- WI-55


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
