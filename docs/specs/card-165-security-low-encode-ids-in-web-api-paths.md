# C-165: Security [Low]: Encode ids in web API paths and refuse traversal in api()

> Security audit 2026-10-16 · **WI-63** · severity **Low** · size **S** · findings: L-03 (Z6 W-3, P2-B2-1, P2-B5-1, Z8 W8-06, Z7 I1), Z6 P2-B4-6
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
- `apps/web/src/lib/planner/href.ts:19` and other helpers interpolate ids into API paths without encoding.
- `apps/web/src/app/(app)/projects/[projectId]/board/page.tsx:109-110` takes `?intake=` and `?planPanel=` from the URL and uses them in API calls, including writes; `/usage?projectId=` and `components/budgets/budget-form-dialog.tsx:108,121` do the same.
- `decodeURIComponent(taskKey)` in the planner design page throws on a malformed key.

**Attacker.** Someone who sends a signed-in member a crafted link.
**Scenario.** An id containing an encoded `../` makes the browser call a different API path than the page intends, with the member's cookies and CSRF token.
**Impact.** A write the person did not intend (for example on another plan or budget path); a crashed page on a malformed key.

## Fix
- `encodeURIComponent` every interpolated id (`planApi`, budget dialog, crumbs, design and board helpers).
- Validate `?planPanel=`, `?intake=` and `?projectId=` against the id format, or against the loaded lists, before use.
- `api()` refuses a path containing `\`, `/../`, or `%2e` / `%2f` segments.
- Wrap `decodeURIComponent(taskKey)` in try/catch and show "Task not found".

## Acceptance criteria
- Unit test: `api('/projects/x/plans/a%2F..%2Fb')` throws before `fetch` is called.
- Board page test: `?planPanel=..%2F..%2FQ` renders no plan panel and makes no request.
- Planner design page test: a malformed `taskKey` shows "Task not found" instead of crashing.

## Touches
- apps/web/src/lib/api.ts
- apps/web/src/lib/planner/href.ts
- apps/web/src/lib/design/href.ts
- apps/web/src/lib/board/actions.ts
- apps/web/src/components/budgets/budget-form-dialog.tsx
- apps/web/src/components/shell/use-crumb-names.ts
- apps/web/src/app/(app)/projects/[projectId]/board/page.tsx
- apps/web/src/app/(app)/projects/[projectId]/planner/**

## Decision
none needed

## Must not run in parallel with
- WI-38
- WI-65


**Delta audit (DW-03):** also `apps/web/src/app/(app)/projects/[projectId]/board/cards/[number]/page.tsx:41-44` → `lib/board/actions.ts:26-28`.

Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
