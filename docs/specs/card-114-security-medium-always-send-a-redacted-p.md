# C-114: Security [Medium]: Always send a redacted preview of the tool input with a remote `tool_use` request

> Security audit 2026-10-16 · **WI-12** · severity **Medium** · size **M** · findings: F-13, the runner and contract part (Z5 M5, Z9 M2)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
Remote approval of a permission prompt is blind:
- the hook sends only "Allow <tool> in an unattended Claude Code session" (`apps/runner/src/hooks/permission.ts:50`);
- the input is attached only when the project ships content (`permission.ts:95`, `apps/runner/src/local/service.ts:207-216`);
- and only its first 500 characters (`ACTION_REQUEST_TOOL_INPUT_MAX = 500`, `packages/shared/src/action-requests/contracts.ts:55,66`), so the end of a long command is never shown.

**Attacker.** A prompt-injected session in away mode.

**Scenario.** The session asks to run a long Bash command whose harmful part sits after the first 500 characters, or in a project without content shipping, where the person sees only the tool name.

**Impact.** The person approves a command they could not see.

## Fix
- For `tool_use`, always send the redacted input, independent of `shipSessionContent` (it is a security control, not content).
- Send head + tail with a truncation marker when the input is longer than the shown budget, plus `fullLength`, `truncated: true` and `sha256` of the full redacted input.
- Without any input, mark the request `preview: 'none'`.
- Raise or keep `ACTION_REQUEST_TOOL_INPUT_MAX` as the shown budget (head and tail together).

## Acceptance criteria
- Regression runner test: a 2 KiB Bash command in a project without content shipping produces `input` with head and tail, `truncated: true`, `fullLength` and `sha256`
- A short input is sent whole with `truncated: false`
- A secret in the input is redacted before it leaves the runner (redaction test)
- A request without input carries `preview: 'none'`
- Shared schema test accepts the new fields and rejects an input over the max

## Touches
- apps/runner/src/hooks/permission.ts
- apps/runner/src/local/service.ts
- apps/runner/src/local/redact.ts
- packages/shared/src/action-requests/contracts.ts

## Decision
D-08 — always send a redacted head+tail preview of the tool input, independent of the content opt-in; approve only through a dialog showing the full (redacted) input (dialog: WI-13)

## Must not run in parallel with
- WI-08
- WI-10
- WI-11
- WI-13
- WI-26


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
