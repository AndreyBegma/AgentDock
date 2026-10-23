# C-184: Security [Medium]: Mark a person's lines in a handoff note outside the agent-writable text

> Security audit 2026-10-16 · severity **Medium** · findings: DA-05 (delta audit)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
`packages/shared/src/handoff/person-lines.ts:222,424-438`: person lines are marked with a `<!-- person -->` suffix inside the file the agent writes, so a prompt-injected agent can promote its own lines to "instructions from the person"; they persist across rounds and reach the person's terminal session.

## Fix
Keep person-line ranges server-side (`personLines` jsonb, already in the schema) as the only source of truth; strip any marker the agent writes; re-anchor ranges by content hash on update.

## Acceptance criteria
- [ ] An agent-written `<!-- person -->` line is never shown or injected as the person's.
- [ ] A person's edit survives an agent rewrite of other sections.

## Decision
none needed

Full audit material: orchestrator scratchpad `security/10-delta-runner.md`, `11-delta-api-shared.md`, `12-delta-web.md`.
