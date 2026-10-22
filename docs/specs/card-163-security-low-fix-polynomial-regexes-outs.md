# C-163: Security [Low]: Fix polynomial regexes outside the queue rules

> Security audit 2026-10-16 · **WI-61** · severity **Low** · size **S** · findings: L-39 (Z4b P2-06, Z7 L3, I4, Z9 P2-06, P2-07)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
- `packages/shared/src/planner/contract.ts:344-345` (`hasHeading`) and `:357-360` (`SECTION_LINE`) use `[ \t]*#*[ \t]*$` after a heading, applied to up to 100 KB of LLM output.
- `apps/web/src/lib/design/viewer-state.ts:51` parses `?zoom=` with `/^\d*\.?\d+$/`.
- `apps/web/src/lib/activity/format.ts:402` `TRAILING_PR_URL` runs `\S+?\/pull\/(\d+)\S*\s*$` on whole activity titles.
- `packages/shared/src/text/mask.ts:85-86`: the URL alternative of `maskText` can backtrack on long token runs.

**Attacker.** A model producing planner output, a person crafting a link, or a runner/agent writing an activity title or text to be masked.
**Scenario.** A long run of whitespace, digits or non-space characters makes the regex take quadratic or worse time.
**Impact.** The API event loop (planner contract, mask) or the browser tab (zoom, activity) stalls.

## Fix
- `planner/contract.ts`: match `^##[ \t]+<heading>` and strip trailing `#` and whitespace in code (`trimEnd` → drop trailing `#+` → `trimEnd`), as WI-01 does for the queue rules.
- `?zoom=`: `/^(?:\d+|\d*\.\d+)$/` with a length check (at most 8 characters) before the test.
- `TRAILING_PR_URL`: slice the last 300 characters of the title before matching.
- `maskText`: anchor the URL alternative with a lookbehind so it cannot restart inside a token.

## Acceptance criteria
- One perf test per regex with an adversarial 100 KB input that finishes in under 50 ms (planner headings, `?zoom=`, activity title, `maskText`).
- Existing tests of `missingCardSections`, the viewer state, the activity formatter and `maskText` pass unchanged.

## Touches
- packages/shared/src/planner/contract.ts
- packages/shared/src/text/mask.ts
- apps/web/src/lib/design/viewer-state.ts
- apps/web/src/lib/activity/format.ts

## Decision
none needed

## Must not run in parallel with
- WI-01
- WI-62


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
