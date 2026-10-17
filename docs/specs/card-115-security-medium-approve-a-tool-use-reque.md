# C-115: Security [Medium]: Approve a tool_use request only through a dialog that shows the full input

> Security audit 2026-10-16 · **WI-13** · severity **Medium** · size **S** · findings: F-13, web part (Z8 W8-01)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
F-13 (web part, Z8 W8-01). `apps/web/src/components/approvals/action-requests-panel.tsx:137-141`: `ask()` short-circuits `tool_use` approvals ("approving it is one click") and calls `decide()` without the `ConfirmDialog` used for every other kind. The row renders the input in a `CodeBlock` capped at `maxHeight={120}` (`:55-57`) and the summary is `line-clamp-3` (`:51`), so the approver sees a clipped, unannotated command. Control, bidi and zero-width characters are not made visible.

**Attacker.** A prompt-injected agent session that asks for a dangerous tool call, or content that makes a benign-looking command hide its real tail.

**Scenario.** The session requests a Bash or Write call whose dangerous part sits past the visible lines or behind a bidi override; an operator approves from the list in one click.

**Impact.** A person authorises a tool call they did not read, on a developer machine.

## Fix
- Route `tool_use` Approve through `ConfirmDialog`, like the other kinds.
- The dialog title is the tool name plus the first line of the input; the body shows the full (redacted) input, unclamped and scrollable.
- Render control, bidi (U+202A–U+202E, U+2066–U+2069) and zero-width characters as visible markers, and mark redacted spans.
- When there is no input, or the input is truncated (`truncated: true` from WI-12), require the person to type the tool name before the confirm button enables.
- Deny stays one click.

## Acceptance criteria
- Component test: clicking Approve on a `tool_use` row opens the dialog and does not call `decide()` until confirmed (the regression test for the one-click path).
- Component test: an input containing U+202E renders a visible marker in the dialog.
- Component test: with no input (or `truncated: true`), the confirm button stays disabled until the tool name is typed.
- Deny on a `tool_use` row still decides without a dialog.
- Only glass-ui components are used (ADR-0011); `bun run check` and the web tests pass.

## Touches
- apps/web/src/components/approvals/action-requests-panel.tsx
- apps/web/src/components/approvals/action-requests-panel.test.tsx
- apps/web/src/lib/approvals/**

## Decision
D-08 — always send a redacted head+tail preview; approve only through a dialog showing the full (redacted) input (00-decisions.md)

## Must not run in parallel with
- WI-08
- WI-12


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
