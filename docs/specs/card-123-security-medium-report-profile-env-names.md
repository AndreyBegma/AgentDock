# C-123: Security [Medium]: Report profile env names only, never values

> Security audit 2026-10-16 · **WI-21** · severity **Medium** · size **S** · findings: F-21 (Z5 M2, Z9 M3, Z9 P2-08)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
F-21 (Z5 M2, Z9 M3, Z9 P2-08). `packages/shared/src/protocol/capabilities.ts:35` types a runtime profile's `env` as a record of names to **values**, and the runner fills it from the profile config (`apps/runner/src/detect/capabilities.ts`, around `:284`). The values go to the server in `hello` and `runner.describe`, are stored (`runners.capabilities`, `runtime_profiles`) and returned by `GET /admin/runners` (`apps/api/src/runners/runners.service.ts`, around `:148`). `apps/runner/src/control/tmux.ts:84-87` also passes them as `-e K=V` argv, visible in the process list. This contradicts ADR-0006.

**Attacker.** Anyone who can read the API database, admin responses, or the process list on the runner host.

**Scenario.** A person puts an API key in a profile's env; it is shipped, stored and shown.

**Impact.** Credential disclosure to the server and to other local users.

## Fix
- `env` in capabilities becomes names only (`{ name, set: true }`), except an allowlist of path variables whose values are not secret (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
- Bound `args`, `binary` and the record size in the schema.
- Pass the orchestrator env through a 0600 file or `tmux set-environment`, not `-e K=V` argv.
- Migration `20261207000000_scrub_profile_env_values` strips stored env values from `runners.capabilities` and `runtime_profiles`.

## Acceptance criteria
- Runner regression test: a profile env containing a secret-looking value (`ANTHROPIC_API_KEY=sk-ant-x`) produces `hello.capabilities` without the value.
- Tmux test: the launch argv contains no `-e` with a value.
- Migration test: after `20261207000000_scrub_profile_env_values`, no stored row holds an env value outside the allowlist.
- Shared schema test: an env entry with a value is rejected (except allowlisted names); oversize `args`/`binary` are rejected.

## Touches
- packages/shared/src/protocol/capabilities.ts
- apps/runner/src/detect/capabilities.ts
- apps/runner/src/detect/profiles.ts
- apps/runner/src/control/tmux.ts
- apps/runner/src/control/orchestrator.ts
- apps/api/src/runners/**
- apps/api/prisma/migrations/20261207000000_scrub_profile_env_values/**

## Decision
none needed (ADR-0006 already says env values stay on the runner)

## Must not run in parallel with
- WI-05


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
