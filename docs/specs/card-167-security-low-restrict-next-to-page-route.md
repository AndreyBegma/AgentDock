# C-167: Security [Low]: Restrict ?next= to page routes and flag link-prefilled briefs

> Security audit 2026-10-16 · **WI-65** · severity **Low** · size **S** · findings: L-45 (Z6 W-4), Z6 W-5
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
- `apps/web/src/app/login/safe-next.ts:10-19` accepts any same-site path, including `/api/*` and `/_next/*`.
- The board page fills the New work brief from `?brief=` (`app/(app)/projects/[projectId]/board/page.tsx:105-107`) with no sign that the text came from a link.

**Attacker.** Someone who sends a member a crafted login or board link.
**Scenario.** After login the browser lands on a raw API response, or the person submits a brief they did not write, believing it is their own draft.
**Impact.** Confusing landing on API JSON; work queued from attacker-written text.

## Fix
`safeNext` refuses `/api/` and `/_next/` prefixes. A `?brief=` prefill shows a visible "Pre-filled from a link — check before sending" notice above the field.

## Acceptance criteria
- `safe-next.test.ts` refuses `/api/admin/x` and `/_next/static/x` and still accepts `/projects/p/board`.
- Board test: opening the intake with `?brief=` shows the notice; opening it without does not.

## Touches
- apps/web/src/app/login/safe-next.ts
- apps/web/src/app/(app)/projects/[projectId]/board/page.tsx

## Decision
none needed

## Must not run in parallel with
- WI-63


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
