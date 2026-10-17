# ADR-0052: A remote `tool_use` request always carries a redacted preview of its input

Status: accepted · Date: 2026-10-17 · Amends [ADR-0021](0021-session-content-is-opt-in-per-project.md)
§1, §3 and [spec 201](../specs/201-claude-code-integration.md) D17 · Card: C-114
(security audit 2026-10-16, WI-12, finding F-13, decision D-08)

## Context

In away mode the `PermissionRequest` hook asks a person to approve a tool call
remotely. Until now the request carried the tool input only when the project
shipped session content, and then only its first 500 characters. A person
could approve a Bash command whose harmful part sat after character 500, or —
in a project without content shipping — approve seeing nothing but the tool
name. A prompt-injected session in away mode can exploit both.

## Decision

1. **The preview is a security control, not content.** A `tool_use` action
   request always carries the redacted tool input, independent of
   `Project.shipSessionContent`. The content opt-in of ADR-0021 still governs
   everything else hooks could ship.
2. **Redaction stays on the runner.** The daemon redacts the input with the
   hook content rules (`apps/runner/src/local/redact.ts`) before it leaves the
   machine. What a caller claims about the preview is dropped and recomputed.
3. **Head and tail, never just the head.** When the redacted input is longer
   than `ACTION_REQUEST_TOOL_INPUT_MAX` (1,000 characters, head, marker and
   tail together), the request carries its head and tail with an
   "… [n characters omitted] …" marker between them, `truncated: true`,
   `fullLength` and the `sha256` of the full redacted input. A short input is
   sent whole with `truncated: false`. The hook itself hands the daemon at
   most 32 KiB of raw input, also as head and tail.
4. **No input is said out loud.** A request without any tool input is marked
   `preview: 'none'`.
5. Approving only through a dialog that shows the full redacted input is
   WI-13, a separate change.

## Consequences

- A redacted excerpt of every remotely approved tool call is stored with its
  action request, also for projects that ship no session content. Redaction is
  pattern-based and may miss a secret; the same caveat as ADR-0021 applies.
- Runners from before this change send no preview fields; the new fields are
  optional in the contract, so their requests are still accepted.
- Rejected:
  - **Keep the input behind the content opt-in.** The person approves blind.
  - **Head only, larger.** Any budget leaves the end of a longer command unseen.
