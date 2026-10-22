# C-168: Security [Low]: Tighten the mockup CDN allowlist to exact package paths

> Security audit 2026-10-16 · **WI-66** · severity **Low** · size **S** · findings: L-49 (Z9 L9)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
`packages/shared/src/design/cdn.ts:31-32` allows any path under `cdn.jsdelivr.net/npm/` and `unpkg.com/`, and `design/csp.ts:15-20` puts those prefixes into the mockup `script-src` and `style-src`.

**Attacker.** Anyone who can publish an npm package, combined with a model or person writing a mockup.
**Scenario.** A mockup loads a script from an arbitrary npm package that the CSP allows because it sits under an allowed CDN prefix.
**Impact.** Attacker code runs in the sandboxed mockup frame (phishing inside the design viewer; see WI-28).

## Fix
Replace the host/prefix entries with exact `package@version/path` entries for the libraries the UI profiles use, and generate both the CSP sources and the validator allowlist from that list.

## Acceptance criteria
- CSP test: the generated `script-src` lists exact paths, not bare CDN prefixes.
- Validator test: a `<script src>` for an unlisted package on an allowed CDN is refused; the listed ones are accepted.

## Touches
- packages/shared/src/design/cdn.ts
- packages/shared/src/design/csp.ts
- packages/shared/src/design/validate.ts

## Decision
none needed — if exact paths prove impractical for the libraries in use, accept the residual risk and record it in the PR

## Must not run in parallel with
- WI-28


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
