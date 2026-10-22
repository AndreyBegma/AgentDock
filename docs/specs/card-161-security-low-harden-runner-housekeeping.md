# C-161: Security [Low]: Harden runner housekeeping: atomic daemon lock, bounded buffers, private file modes, project-checked cancels

> Security audit 2026-10-16 · **WI-59** · severity **Low** · size **M** · findings: L-33, L-34, L-35, L-38 (Z5 L5, L6, L7, L10)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
- **L-33** `apps/runner/src/lock.ts:20-35`: a stale lock is taken over by unlink + `writeFileSync(..., { flag: 'wx' })` (`:23`). Two daemons starting at once can both see the stale pid and both end up holding the spool.
- **L-34** `apps/runner/src/adapters/lines.ts:24-35`, `capture/executor.ts`, `collectors/board/board.ts`, `collectors/events/events.ts`: lines and files are accumulated without a cap; `uiprofile/fingerprint.ts` turns server-supplied globs into backtracking regexes.
- **L-35** `apps/runner/src/cards/attachments.ts:151` and `cards/git.ts:250` write attachments and card files with mode `0644`; `skills/discover.ts` copies skills world-readable.
- **L-38** `uiprofile.cancel` / `plan.cancel` (`uiprofile/executor.ts`, `planner/executor.ts`) cancel by run id without checking the project.

**Attacker.** Another local user (file modes), an agent writing huge transcripts or event files (buffers), the server or a compromised API (globs, cancels).
**Scenario.** A single agent-written file with a very long line grows daemon memory without bound; a server-supplied glob stalls the fingerprint step; a cancel names another project's run.
**Impact.** Runner denial of service, two daemons corrupting one spool, attachment contents readable by other local users, cross-project cancel.

## Fix
- Lock takeover by writing a temp file and `rename`-ing it into place, then re-reading and comparing pid plus process start time; the loser exits.
- Cap line length (drop the line with a warning) and whole-file reads in the listed readers; replace server globs with a non-backtracking matcher (picomatch-style compile or a hand-written segment matcher).
- Write attachments, card files and skill copies `0600` (files) / `0700` (directories).
- Add `projectId` to the `uiprofile.cancel` and `plan.cancel` args and refuse a cancel whose run belongs to another project.

## Acceptance criteria
- Lock test: two concurrent takeovers of a stale lock leave exactly one holder; the other exits non-zero.
- Lines test: a 64 MiB line is dropped with a warning and the reader continues with the next line.
- Fingerprint test: an adversarial glob against a long path completes in under 50 ms.
- Attachment and card-file tests assert mode `0600` on created files.
- Cancel tests: `uiprofile.cancel` and `plan.cancel` with a foreign `projectId` are refused; the run keeps going.

## Touches
- apps/runner/src/lock.ts
- apps/runner/src/adapters/lines.ts
- apps/runner/src/capture/executor.ts
- apps/runner/src/collectors/board/board.ts
- apps/runner/src/collectors/events/events.ts
- apps/runner/src/uiprofile/fingerprint.ts
- apps/runner/src/cards/attachments.ts
- apps/runner/src/cards/git.ts
- apps/runner/src/skills/discover.ts
- apps/runner/src/uiprofile/executor.ts
- apps/runner/src/planner/executor.ts
- packages/shared/src/protocol/commands/uiprofile.ts
- packages/shared/src/protocol/commands/planner.ts

## Decision
none needed

## Must not run in parallel with
- WI-23
- WI-24
- WI-25
- WI-46
- WI-67
- WI-77


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
