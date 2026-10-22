# C-170: Security [Low]: Report only sessions inside watched roots

> Security audit 2026-10-16 · **WI-68** · severity **Low** · size **S** · findings: L-37 (Z5 L9)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
`apps/runner/src/adapters/watcher.ts` (around `:118`, `:212`, `:259`) and `adapters/claude/parse.ts` send `session.observed` with cwd, branch and title for every Claude session on the machine, including ones outside any watched project.

**Attacker.** Anyone with read access to the control plane (any member, or a compromised API).
**Scenario.** The person's unrelated private work (paths, branch names, session titles) appears on the server.
**Impact.** Privacy leak of work that is not the control plane's business.

## Fix
The watcher drops `session.observed` (and everything that follows for that session) when its cwd is not inside a watched root. This is the behaviour, not an option (D-14). A session that later moves into a watched root is reported from then on.

## Acceptance criteria
- Watcher test: a session with cwd `/home/u/private` (no watched root) sends nothing.
- Watcher test: a session inside a watched root is reported as before; one that moves into a root is reported after the move.

## Touches
- apps/runner/src/adapters/watcher.ts
- apps/runner/src/adapters/claude/parse.ts

## Decision
D-14 — only sessions inside watched roots are reported (00-decisions.md)

## Must not run in parallel with
- WI-05


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
