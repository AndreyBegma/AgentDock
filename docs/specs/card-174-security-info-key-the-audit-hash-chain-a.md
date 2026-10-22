# C-174: Security [Info]: Key the audit hash chain and broaden audit redaction

> Security audit 2026-10-16 · **WI-72** · severity **Info** · size **S** · findings: Z1 I1, Z1 I2
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
- `apps/api/src/audit/canonical.ts:82-102`: the chain hash is `sha256(prevHash ‖ canonical(record))` with no key, so anyone with DB write access can rewrite a row and recompute every later hash.
- `apps/api/src/audit/audit.service.ts:54,87-88` redacts a short fixed list of key names.

**Attacker.** Someone with database write access (a leaked DB password, a compromised API).
**Scenario.** Rows are edited and the chain recomputed; secrets under unlisted key names are stored in `before`/`after`.
**Impact.** Tamper evidence does not hold; secrets in audit rows.

## Fix
Use HMAC-SHA256 with a key from the environment (not the DB) for new rows, keeping the old hash for rows before the switch, or anchor a nightly head hash outside the DB. Redact by pattern (keys matching `token|secret|password|key|authorization|cookie`, case-insensitive) in addition to the list.

## Acceptance criteria
- Verification test: rewriting a row and every later hash without the key makes verification fail.
- Redaction test: `{ apiToken: "x", clientSecret: "y" }` is stored redacted.
- The new env variable is documented in `apps/api/.env.example`.

## Touches
- apps/api/src/audit/canonical.ts
- apps/api/src/audit/audit.service.ts
- apps/api/src/audit/audit-verification.service.ts
- apps/api/.env.example

## Decision
none needed

## Must not run in parallel with
- WI-07


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
