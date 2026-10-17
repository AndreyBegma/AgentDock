# C-127: Security [Medium]: Stage only tracked changes when collecting a terminal card

> Security audit 2026-10-16 · **WI-25** · severity **Medium** · size **S** · findings: F-25 (Z5 M8)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
F-25 (Z5 M8). A terminal-card collect runs in the person's own checkout (`apps/runner/src/cards/executor.ts:313-326` → `cards/git.ts:467`, `git add -A`), so every untracked file in that checkout is committed and pushed to the card branch.

**Attacker.** None needed; also a prompt-injected session that drops files.

**Scenario.** A person collects a terminal card while untracked local files (an `.env.local`, credentials, scratch notes) sit in the checkout.

**Impact.** Secrets and private files are pushed to the remote, possibly a public repository.

## Fix
- When `collect` runs with `cwd` (the person's checkout), stage with `git add -u` plus the files the card itself wrote (tracked by the runner).
- Refuse files matching secret patterns (`.env*` except `.env.example`, `*.pem`, `id_*`, `*.key`).
- Return the staged file list in the collect result so the UI can show it.

## Acceptance criteria
- Regression test: a checkout with an untracked `.env.local` and a modified tracked file — collect commits only the tracked file.
- The collect result lists the staged files.
- A card-written file matching a secret pattern is refused with a clear error.
- Worktree collects (fleet cards in their own worktree) keep today's behaviour.

## Touches
- apps/runner/src/cards/executor.ts
- apps/runner/src/cards/git.ts
- packages/shared/src/protocol/commands/cards.ts

## Decision
none needed

## Must not run in parallel with
- WI-24
- WI-46


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
