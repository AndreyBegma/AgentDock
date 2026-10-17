# C-113: Security [Medium]: Authenticate local-socket callers instead of trusting `cwd` and `sessionId`

> Security audit 2026-10-16 · **WI-11** · severity **Medium** · size **L** · findings: F-12 (Z5 M4)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
The runner's unix socket (`apps/runner/src/local/server.ts:56`, `Bun.listen`, no peer credentials) accepts `cwd` and `sessionId` from the client. `apps/runner/src/local/service.ts:109-111,132,155-177,189-190` correlates the project from the claimed `cwd` and acts as the claimed session.

**Attacker.** Any process running as the same user: an agent session in another project, a build script, a dependency's postinstall.

**Scenario.** The process connects to the socket and claims the `cwd` of another watched project or the id of another session, then calls MCP methods (create issues, request actions, `card.finish`) in that project's or session's name.

**Impact.** Cross-project actions and impersonation of sessions, including finishing someone else's card round.

## Fix
- Per-session capability token: the runner mints a random token per session it launches or first sees through `SessionStart`, injects it into the hook and MCP environment (`AGENTDOCK_SESSION_TOKEN`), and requires it on every local request; the token maps to (sessionId, cwd, projectId) on the runner.
- Where available, also read the peer pid (`SO_PEERCRED` on Linux, `LOCAL_PEERPID` on macOS) and check it descends from the session's `claude` process; refuse a mismatch.
- Refuse a request whose claimed `cwd` or `sessionId` does not match the token's binding.
- Sessions the runner did not launch get their token at `SessionStart` through the hook's response and keep it for the session.

## Acceptance criteria
- Regression unit test: a request claiming `cwd` of project B with the token of a session in project A is refused
- `card.finish` with another session's id is refused
- A request without a token is refused, except `SessionStart` registration
- The hook and MCP happy paths pass (existing tests plus a token round-trip)
- On Linux, a peer whose pid does not descend from the session process is refused (skipped on platforms without peer credentials)

## Touches
- apps/runner/src/local/server.ts
- apps/runner/src/local/service.ts
- apps/runner/src/local/types.ts
- apps/runner/src/local/session-tokens.ts
- apps/runner/src/mcp/index.ts
- apps/runner/src/hooks/**
- apps/runner/src/cards/launch.ts
- apps/runner/src/launch/**

## Decision
none needed

## Must not run in parallel with
- WI-12
- WI-67


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
