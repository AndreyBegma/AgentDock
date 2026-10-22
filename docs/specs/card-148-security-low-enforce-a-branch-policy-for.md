# C-148: Security [Low]: Enforce a branch policy for runner pushes and keep CI, deploy and plugin changes out of auto-merge

> Security audit 2026-10-16 · **WI-46** · severity **Low** · size **L** · findings: L-31 (Z5 L2, Z9 P2-04); D-12 implementation
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-31.** A card, run or skill branch is any `gitRefSchema` value (`packages/shared/src/protocol/commands/cards.ts:188`), so it may name the repository's default branch, and collect pushes to it (`apps/runner/src/cards/git.ts:499`, `apps/runner/src/skills/run/collect.ts:180-191`). Card auto-merge is on unless the base is the default branch; the API knows the default only when the project's base came from a default source (`apps/api/src/board/board-work.ts:272`), otherwise it falls back to the names `main`/`master` (`packages/shared/src/board/shipping.ts:70-83`).

**D-12.** Fleet and card workers can change `.woodpecker/`, `deploy/`, `plugins/` and `.claude-plugin/` and have the PR auto-merge on green with no human review.

**Attacker.** A prompt-injected card worker or skill run (through card text, issue text or repository content).

**Scenario.** The worker edits a CI or deploy file, or pushes straight to a default branch with another name, and the change merges unattended.

**Impact.** CI and deploy run attacker-chosen code with the host's privileges (see WI-03); the released runner or plugin can be altered.

## Fix
1. **Branch policy (runner and contract).** Card, run and skill branches must start with a fixed prefix (`card/`, `run/`, `skill/`). The runner refuses to push to the repository's default branch or to a branch GitHub reports as protected, with a typed `branch_refused`.
2. **Real default branch.** The API stores the repository's default branch (`Project.defaultBranch`, refreshed on `project.inspect`/`refresh`) and passes it to `cardAutoMergeDefault`; unknown means auto-merge **off**.
3. **Protected paths (D-12).** Add `.github/CODEOWNERS` covering `.woodpecker/`, `deploy/`, `plugins/` and `.claude-plugin/`. Before a runner push, a pre-push guard diffs the branch against its base; when it touches a protected path, the runner still pushes, but reports `protectedPaths: string[]` in the result. The API marks the card's PR as needing a human: auto-merge is never enabled for it, whatever the card or project setting, and the card shows why. The required review itself is a GitHub setting (person-only P-03).

## Acceptance criteria
- A schema test refuses `card.run {branch:'main'}` and any branch without the fixed prefix (regression test).
- A runner test refuses a push to the repository's default branch with `branch_refused`.
- A shipping test: a `trunk` default with base `trunk` gives auto-merge off; an unknown default gives off.
- A runner test: a card push changing `.woodpecker/pipeline.yml` reports `protectedPaths` containing it.
- An API e2e test: a card whose push reports protected paths never has auto-merge enabled, even with `autoMerge: true`, and the card view says why.
- `.github/CODEOWNERS` lists the four paths; ADR-0045 is linked from the CODEOWNERS header comment.

## Touches
- packages/shared/src/protocol/commands/cards.ts
- packages/shared/src/board/shipping.ts
- packages/shared/src/board/*.spec.ts
- apps/runner/src/cards/git.ts
- apps/runner/src/skills/run/collect.ts
- apps/runner/src/git/protected-paths.ts
- apps/runner/src/projects/inspect.ts
- apps/api/src/board/board-mapper.ts
- apps/api/src/board/board-work.ts
- apps/api/src/board/board-shipping.ts
- apps/api/src/projects/**
- apps/api/prisma/schema.prisma
- apps/api/prisma/migrations/20261210000000_project_default_branch/**
- apps/web/src/components/board/card-sheet.tsx
- .github/CODEOWNERS

## Decision
D-12 — CODEOWNERS on .woodpecker/, deploy/, plugins/, .claude-plugin/ plus a runner pre-push guard; such PRs never auto-merge (00-decisions.md, ADR-0045)

## Must not run in parallel with
- WI-24
- WI-25


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
