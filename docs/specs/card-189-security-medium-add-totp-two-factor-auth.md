# C-189: Security [Medium]: Add TOTP two-factor authentication

> Security audit 2026-10-16 · severity **Medium** · findings: D-05 follow-up
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
Accounts are protected by password only; D-05 settled lockout as an exponential delay without a hard lock, with 2FA as a later card.

## Fix
TOTP (RFC 6238) enrolment with recovery codes, required for admins optionally per instance; remember-device is out of scope.

## Acceptance criteria
- [ ] Enrol, verify, disable with password + code.
- [ ] Login asks for a code when enrolled.
- [ ] Recovery codes single-use, hashed.

## Decision
D-05.

Full audit material: orchestrator scratchpad `security/10-delta-runner.md`, `11-delta-api-shared.md`, `12-delta-web.md`.
