# C-144: Security [Low]: Fence untrusted text in SessionStart context and MCP results

> Security audit 2026-10-16 · **WI-42** · severity **Low** · size **S** · findings: L-14 (Z1 L6, Z9 L4, Z5 L11)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-14.** The SessionStart context built by `local-handlers.ts` inlines the GitHub issue title as `This session's issue: #n <title> (state)` (`apps/api/src/local/local-handlers.ts:216`, clipped to 200 characters but not one-lined or marked as data). MCP tool results are returned as raw JSON text (`apps/runner/src/mcp/server.ts:78-79`), including issue titles and bodies from GitHub.

**Attacker.** Anyone who can author or edit an issue on the project's repository (on a public repo, anyone).

**Scenario.** An issue title carries a newline and instruction-like text; it lands in the agent's session context as if it were AgentDock's own guidance.

**Impact.** Prompt injection into a manual or card session, with whatever permissions that session has.

## Fix
`oneLine()` and cap the issue title, and render it quoted as data (`Issue title (untrusted): «…»`). Prefix MCP results that carry GitHub-authored text with a one-line note that the content is untrusted data, and neutralise fence-like tags as `capture-prompt.ts` does.

## Acceptance criteria
- A handler test with an issue title containing a newline and `## Instructions` renders exactly one quoted line (regression test).
- An MCP server test shows a result with GitHub text starts with the untrusted-data note.
- Existing SessionStart and MCP tests pass.

## Touches
- apps/api/src/local/local-handlers.ts
- apps/api/src/local/local-handlers.spec.ts
- apps/runner/src/mcp/server.ts
- apps/runner/src/mcp/*.spec.ts

## Decision
none needed

## Must not run in parallel with
- WI-08
- WI-09
- WI-10


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
