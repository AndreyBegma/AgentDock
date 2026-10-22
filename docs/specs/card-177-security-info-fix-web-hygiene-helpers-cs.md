# C-177: Security [Info]: Fix web hygiene helpers: CSV guard, curl quoting, webhook URL masking, shell quoting, send-dialog bodies

> Security audit 2026-10-16 · **WI-75** · severity **Info** · size **M** · findings: Z7 I6, Z7 I7, Z6 P2-B1-2, Z8 W8-09, Z8 W8-10, Z8 W8-08
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
- `apps/web/src/lib/workflows/export.ts:20` CSV formula guard misses cells starting with `\n` and full-width `=+-@`.
- `apps/web/src/lib/webhooks/format.ts:449-458` `curlExample` does not quote the secret and URL safely.
- The inbound webhook sheet shows the full URL, which is a bearer secret (Z6 P2-B1-2).
- `apps/web/src/lib/board/format.ts:518-522` builds a setup command with `profileKey` unquoted (mitigated by the schema).
- The Send-to-fleet dialog shows titles only, so the person cannot see the bodies they send (`components/planner/send-dialog.tsx`).
- xterm auto-replies are forwarded in write mode (W8-08): document only.

**Attacker.** Someone who controls exported cell text, or who can see a screen or screenshot.
**Scenario.** A spreadsheet runs a formula from an exported cell; a screenshot leaks a webhook URL; a copied command breaks or does more than shown.
**Impact.** Small, local; each is defence in depth.

## Fix
Extend the CSV guard to leading whitespace/newlines and full-width characters; quote values in `curlExample` with a `shellWord` helper; mask the webhook URL path until "Reveal"; `shellWord`-quote `profileKey`; show bodies (collapsed) in the send dialog; document the xterm auto-reply behaviour in the terminal guide.

## Acceptance criteria
- One unit test per helper: CSV guard (`\n=1+1`, full-width `＝`), `curlExample` with a quote in the secret, `profileKey` quoting.
- Component test: the webhook sheet masks the URL path until "Reveal" is pressed.
- Component test: the send dialog can expand each body.

## Touches
- apps/web/src/lib/workflows/export.ts
- apps/web/src/lib/webhooks/format.ts
- apps/web/src/lib/board/format.ts
- apps/web/src/app/admin/integrations/webhooks/**
- apps/web/src/components/planner/send-dialog.tsx
- docs/guides/*terminal*

## Decision
none needed

## Must not run in parallel with
- WI-64


**Delta audit (DW-04):** `?newWork=1&brief=` prefills New work from a link — show that it was prefilled from a link.

Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
