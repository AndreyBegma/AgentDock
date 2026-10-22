# C-176: Security [Info]: Redact secrets and userinfo in runner error text shown to viewers

> Security audit 2026-10-16 · **WI-74** · severity **Info** · size **S** · findings: Z1 I3, Z7 I8, Z5 I1
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
`apps/api/src/approvals/approval-commands.ts` and `approvals-query.service.ts:23,117-118` pass the runner's error text through to every reader of the approvals view, including viewers. That text can hold local paths and, before WI-22, URLs with userinfo.

**Attacker.** A project member, or anyone the error text is shown to.
**Scenario.** A failed git or gh command echoes a credential-bearing URL or a token in its error.
**Impact.** A credential reaches the UI. Local paths are visible too, which D-03 accepts.

## Fix
Keep the runner's error text for viewers (D-03: viewers see everything), but pass it through the shared redactor (URL userinfo, token shapes) before it is stored or returned. Known error codes still get their fixed copy as the headline, with the redacted raw text as detail.

## Acceptance criteria
- Mapper test: an error containing `https://user:tok@github.com/o/r` is returned as `https://github.com/o/r` with a redaction marker, for viewer and operator alike.
- A known error code renders its fixed headline plus the redacted detail.

## Touches
- apps/api/src/approvals/approval-commands.ts
- apps/api/src/approvals/approvals-query.service.ts
- packages/shared/src/text/redact*.ts

## Decision
D-03 — viewers see everything (00-decisions.md; ADR-0043); this item keeps raw text for viewers and only redacts secrets

## Must not run in parallel with
- WI-22
- WI-41


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
