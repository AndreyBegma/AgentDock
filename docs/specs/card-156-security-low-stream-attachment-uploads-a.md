# C-156: Security [Low]: Stream attachment uploads and cap pending uploads per user

> Security audit 2026-10-16 · **WI-54** · severity **Low** · size **M** · findings: L-26 (Z4 D-08)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-26.** An upload is read whole into memory (`apps/api/src/attachments/attachments.service.ts:166`, `readFile(file.path)`) to sniff and hash it, and pending uploads count against the project's shared quota for 24 h (`:178-186`).

**Attacker.** A project member (operator) with upload rights.

**Scenario.** Many large uploads that are never claimed by a card.

**Impact.** API memory spikes, and the project's quota is held so others cannot upload.

## Fix
Sniff the type from the first bytes and hash while streaming the file to storage. Cap pending bytes per user (in addition to the project quota) and answer 413 above it.

## Acceptance criteria
- A test shows the upload path never reads the whole file into memory (no `readFile` of the upload).
- A user whose pending uploads exceed the per-user cap gets 413; another user can still upload (regression test).
- Existing type-sniffing and quota tests pass.

## Touches
- apps/api/src/attachments/attachments.service.ts
- apps/api/src/attachments/upload-storage.ts
- apps/api/src/attachments/*.spec.ts
- apps/api/.env.example

## Decision
none needed

## Must not run in parallel with
- WI-50


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
