# ADR-0078: Only sessions inside watched roots are reported

Status: accepted · Date: 2026-10-22 ·
Card: C-170 (security audit 2026-10-16, WI-68, finding L-37 and decision D-14) ·
Spec: [`docs/specs/card-170-security-low-report-only-sessions-inside.md`](../specs/card-170-security-low-report-only-sessions-inside.md)

## Context

A runtime profile holds the transcripts of every directory on the machine, not only those of watched projects. Spec 12 D10 reported all of them: a session outside every project reached the server with its `cwd`, git branch and title, and was shown to admins as "unassigned". That is the person's unrelated private work — paths, branch names, session titles — on a server that anyone with read access to the control plane, or a compromised API, can read. It is not the control plane's business.

## Decision

1. **The runner reports a session only while its `cwd` is inside a watched root**, which is exactly when the adapter's correlation (`correlateCwd`, D6) gives it a project: the project's checkout or one of its `.wt-<repo>-*` worktrees. This is the behaviour, not an option.
2. **Nothing of any other session leaves the machine** — no `session.observed`, and none of the events that follow it. The session watcher gates every event on the file state's correlated `session.observed`; a file that has none yet sends nothing. The gate is in the watcher, so it holds for every runtime adapter, Codex included.
3. **The offset still moves.** The runner keeps reading such a transcript, so a session that later enters a watched root (the watch list gains a project covering its `cwd`) is reported from then on: its current `session.observed` is sent at once and its new events after it. What happened before the move is not sent; a backfill sends it only for a session that is inside a root at the time of the backfill.
4. **A session that leaves every watched root** (its project is removed from the watch list) is sent once more without a project, so the server unlinks it. That event carries nothing the server did not already have; nothing after it is sent.

## Consequences

- Amends spec 12 D10: new unassigned sessions no longer arrive. The API keeps its `unassigned` filter and admin-only visibility for the sessions it already stored and for older runners.
- A Codex transcript reports its own directory as `cwd`, so it is reported only when `CODEX_HOME` lies inside a watched root — in practice, not until the Codex adapter parses a real `cwd`.
- The machine-wide view of a person's sessions is gone from the control plane; it was only ever the admin's.
