# C-164: Security [Low]: Use one URL-safety module in the web app

> Security audit 2026-10-16 · **WI-62** · severity **Low** · size **S** · findings: L-02 (Z7 L1, L2, Z8 W8-07, Z6 P2-B2-4, P2-B3-1), the web part of L-01
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
- Planner issue, PR and docs links go to `href` unchecked: `apps/web/src/components/planner/issue-links.tsx:17,27`, `plan-header.tsx:149`.
- `apps/web/src/components/markdown/safe-href.ts:12` refuses `//host` but accepts `/\host`, which browsers treat as protocol-relative; `lib/activity/format.ts:381` and `lib/notifications/format.ts:191` have the same gap.
- `safeHttpsUrl` exists twice (`lib/fleet/format.ts:178`, `lib/queue/format.ts:209`) and neither checks the host.

**Attacker.** Anyone who can put text into an issue, PR, plan, Markdown body or runner-reported URL.
**Scenario.** A link that looks internal or looks like GitHub sends the person to another site from inside the app.
**Impact.** Phishing from a trusted UI; with a `javascript:` URL in an unchecked `href`, script in the app origin where React does not block it.

## Fix
Add `apps/web/src/lib/url.ts` with `internalHref(link)` (resolve with `new URL(link, location.origin)`, same origin only, refuse `\` and control characters) and `externalHttpsUrl(url, { hosts })` (https only, exact host match). Delete the local copies and use the module in `IssueLinks`, `plan-header`, activity, notifications, fleet, queue and the Markdown `safeHref`.

## Acceptance criteria
- Unit tests: `/\evil.example` and `/\t/evil.example` give `undefined` from `internalHref`; `https://github.com.evil.example/x` is refused for the GitHub host; `https://github.com/o/r/pull/1` is accepted.
- Markdown regression test: `[x](/\evil.com)` renders without a link.
- No other `safeHttpsUrl` definition remains (grep in the test or `check`).

## Touches
- apps/web/src/lib/url.ts
- apps/web/src/lib/activity/format.ts
- apps/web/src/lib/notifications/format.ts
- apps/web/src/lib/fleet/format.ts
- apps/web/src/lib/queue/format.ts
- apps/web/src/components/planner/issue-links.tsx
- apps/web/src/components/planner/plan-header.tsx
- apps/web/src/components/markdown/safe-href.ts

## Decision
none needed

## Must not run in parallel with
- WI-61
- WI-33
- WI-64


**Delta audit (DW-02):** card bodies are now rendered as Markdown on the card sheet and the full card page (#431), so the `/\host` gap in `safeHref` reaches every member: `card-description.tsx:36-41`, `markdown.tsx:51-63`, `safe-href.ts:12`. Add a regression test on the card description. Consider showing the real host for external links.

Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
