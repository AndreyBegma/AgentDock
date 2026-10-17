# C-251: Rewrite filtered commands in plan-mode runner launches

Issue: #612

## What to do
`decideHook` (`apps/runner/src/filter/hook.ts`) rewrites only in `bypassPermissions` and `auto` (amendments 9 and 10). The planner (`apps/runner/src/planner/launch.ts`), design and UI-profile runs (`apps/runner/src/uiprofile/executor.ts`) and other headless launches use `--permission-mode plan`, so all of their Bash calls are recorded as `none:mode`. The dashboard shows ≈ $0.00 saved for Planner (159 commands) and Design (68).

Allow the rewrite in `plan` mode, with **no** permission decision, as in auto mode: Claude Code's own rules still judge the wrapped command. This applies only to commands whose rewrite `permissions.ts` proves equivalent. `default` and `acceptEdits` keep passing through, because a person would see the wrapped command in a prompt.

## Acceptance criteria
- [ ] A `plan`-mode PreToolUse input for a covered command (e.g. `git log`, `rg foo`) is rewritten with no `permissionDecision`.
- [ ] `default` and `acceptEdits` still pass through as `none:mode`.
- [ ] A planner run and a design run on a test project record filter rows with real filter ids, not only `none:*` (covered by `launch-e2e.spec.ts` or an equivalent test).
- [ ] ADR-0039 / spec #445 amended with the plan-mode rule and its reasoning.

## Out of scope
- Compound-command parsing.
- Changing which permission mode any launch uses.

## Open questions
None.
