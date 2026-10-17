# C-126: Security [Medium]: Disable repository hooks and fsmonitor on every runner git call

> Security audit 2026-10-16 · **WI-24** · severity **Medium** · size **S** · findings: F-26 (Z5 M9), L-50 (Z5 L3)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
F-26 (Z5 M9). `apps/runner/src/cards/git.ts` applies `NO_HOOKS` to some calls (`:259`, `:474`) but not to `worktree add` (`:107-133`, `:576-581`), and neither do the planner, skills, uiprofile and publish-specs worktree paths. A `post-checkout` hook from the repository (for example via `core.hooksPath=.husky`) then runs in the runner. L-50 (Z5 L3): `core.fsmonitor` in an agent-writable `.git/config` is run by every `git status` the collectors make on a 15 s poll.

**Attacker.** Whoever can change a watched repository's hooks or a worktree's git config: a malicious contributor, or a prompt-injected agent.

**Scenario.** A hook or fsmonitor setting is planted; the runner's own git calls execute it outside any agent sandbox or permission prompt.

**Impact.** Code execution in the runner daemon as the developer.

## Fix
Set `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.file.allow=never -c submodule.recurse=false` once in `GitAuth.wrap` / `withGitConfig` (`apps/runner/src/git-auth.ts:52`), so every runner git invocation gets them, `worktree add` and `checkout` included. Remove the per-call `NO_HOOKS` spreading once the wrapper covers it.

## Acceptance criteria
- Regression test: a test repo with a `post-checkout` hook (via `core.hooksPath`) that touches a marker file — card, skill, planner and uiprofile worktree creation do not create the marker.
- A collector `git status` in a worktree with `core.fsmonitor` pointing at a script does not run it.
- Existing runner git tests pass.

## Touches
- apps/runner/src/git-auth.ts
- apps/runner/src/cards/git.ts
- apps/runner/src/skills/run/executor.ts
- apps/runner/src/planner/executor.ts
- apps/runner/src/planner/publish-specs.ts
- apps/runner/src/uiprofile/executor.ts
- apps/runner/src/skills/project-install.ts
- apps/runner/src/collectors/worktrees/worktrees.ts
- apps/runner/src/commands/worktree/status.ts

## Decision
none needed

## Must not run in parallel with
- WI-25
- WI-46


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
