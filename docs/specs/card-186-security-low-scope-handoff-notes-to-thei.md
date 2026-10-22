# C-186: Security [Low]: Scope handoff notes to their project, delete them with the card, and keep raw content out of events.data

> Security audit 2026-10-16 · severity **Low** · findings: DA-11, DA-12 (delta audit)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
`handoff_notes` is unique on (subjectKind, subjectId) without the project and outlives its card; pane tails and note content are stored raw in `events.data`, breaking ADR-0021's content rule.

## Fix
Unique (projectId, subjectKind, subjectId) + cascade on card delete; store content only in the content tables under the session-content opt-in, never in `events.data`.

## Acceptance criteria
- [ ] Deleting a card deletes its note.
- [ ] No note/pane text in `events.data` (test).

## Decision
D-03 (viewers may read content) still requires the opt-in for storing it.

Full audit material: orchestrator scratchpad `security/10-delta-runner.md`, `11-delta-api-shared.md`, `12-delta-web.md`.
