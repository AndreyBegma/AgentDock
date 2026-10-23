# C-159: Security [Low]: Enforce field limits on translated text

> Security audit 2026-10-16 · **WI-57** · severity **Low** · size **S** · findings: L-29 (Z4b P2-03)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-29.** `TextNormalizer.apply` writes the translated text back with `writes.set(field.field, result.english)` (`apps/api/src/text/text-normalizer.ts:662`) and `writeOwnerText`, without the field's length limit (title, body, …) that the DTOs enforce on input.

**Attacker.** Whoever controls the translation output (a misbehaving model or a crafted original that expands).

**Scenario.** A short title translates into a very long English text.

**Impact.** Stored fields exceed their limits, breaking prompts, PR titles and UI layouts downstream.

## Fix
Look up each field's limit (from the same constants the DTOs use) and, before the write, mark a translation over the limit as `too_long` and keep the original (or clip at a word boundary for body fields).

## Acceptance criteria
- A normalizer test with a 96 KiB translation of a title stores at most the title limit and records the outcome (regression test).
- Translations within the limit are applied unchanged.

## Touches
- apps/api/src/text/text-normalizer.ts
- apps/api/src/text/text-columns.ts
- apps/api/src/text/*.spec.ts

## Decision
none needed


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
