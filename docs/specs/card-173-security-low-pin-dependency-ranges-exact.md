# C-173: Security [Low]: Pin dependency ranges exactly and enable security updates

> Security audit 2026-10-16 · **WI-71** · severity **Low** · size **S** · findings: L-43 (Z9 L11)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
- Caret ranges against the exact-pin policy (`bunfig.toml`): `apps/api/package.json:26-39` (for example `"@nestjs/common": "^11.1.0"`), `apps/web/package.json`, `packages/shared/package.json:36`.
- `renovate.json:5-15` enables only the `bun` manager and disables every package except glass-ui, so no security update PR is ever opened.

**Attacker.** A compromised or vulnerable upstream release.
**Scenario.** A lockfile refresh pulls a new minor within the caret range; known advisories stay unpatched because no update PR exists.
**Impact.** Supply-chain exposure and slow patching (F-02 is an example).

## Fix
Replace carets and tildes with the exact versions in `bun.lock` (the lockfile stays unchanged). Enable Renovate vulnerability alerts and security PRs into `develop` for all managers, with no automerge.

## Acceptance criteria
- A check script (wired into `bun run check`) finds no `^` or `~` in any workspace `package.json`.
- `renovate.json` enables `vulnerabilityAlerts` for all managers, targets `develop` and sets `automerge: false`.
- `bun install --frozen-lockfile` passes with the lockfile unchanged.

## Touches
- apps/api/package.json
- apps/web/package.json
- apps/runner/package.json
- packages/shared/package.json
- renovate.json
- scripts/check-pins.ts
- package.json

## Decision
none needed

## Must not run in parallel with
- WI-02
- WI-70
- WI-78


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
