# C-125: Security [Medium]: Read agent-written reply and message files without following symlinks

> Security audit 2026-10-16 · **WI-23** · severity **Medium** · size **S** · findings: F-23 (Z5 M6)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
F-23 (Z5 M6). `apps/runner/src/collectors/replies/messages.ts:89-98` and `replies.ts:99-108` read `.orchestrator-msg.md` / `.orchestrator-reply.md` in each worktree with `statSync` + `readFileSync`, which follow symlinks, and there is no size cap before the read. The content is shipped to the server as a slot message or reply.

**Attacker.** A prompt-injected agent working in a fleet worktree (it runs as the runner's user).

**Scenario.** The agent replaces the message file with a symlink to a file elsewhere in the user's home.

**Impact.** Any file readable by the runner's user is shipped to the server and shown to project members; a huge file stalls the collector.

## Fix
- One helper `readRegularFileInside(root, rel, maxBytes)` in `apps/runner/src/fs/safe-read.ts`: `lstat` (refuse symlinks), open with `O_NOFOLLOW`, `fstat` must be a regular file, its realpath must be inside the worktree, and the size is capped before reading.
- Use it for `.orchestrator-msg.md`, `.orchestrator-reply.md` and the `existsSync` check in `collectors/tmux/sessions.ts`.

## Acceptance criteria
- Collector regression test: `.orchestrator-msg.md` as a symlink to a file outside the worktree emits no `slot.message_seen`.
- A 10 MiB message file is refused before it is read (assert no full read).
- A regular file inside the worktree is still read.

## Touches
- apps/runner/src/collectors/replies/messages.ts
- apps/runner/src/collectors/replies/replies.ts
- apps/runner/src/collectors/tmux/sessions.ts
- apps/runner/src/fs/safe-read.ts

## Decision
none needed

## Must not run in parallel with
- WI-26
- WI-59


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
