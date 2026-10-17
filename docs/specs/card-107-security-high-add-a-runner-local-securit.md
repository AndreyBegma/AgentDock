# C-107: Security [High]: Add a runner-local security policy the server cannot change

> Security audit 2026-10-16 · **WI-05** · severity **High** · size **L** · findings: F-06 (Z5 H1, Z9 L3 path schemas, Z3 inherited-bypass hardening)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
The typed allowlist (ADR-0010) is not an RCE boundary against the server:
- `card.run` takes the prompt and `permissionMode` from the command args (`apps/runner/src/cards/launch.ts:76-98`); `orchestrator.start` likewise (`apps/runner/src/control/orchestrator.ts:49-63`), so `bypassPermissions` is whatever the server sends.
- `terminal.attach` in write mode sends raw keystrokes to the PTY (`apps/runner/src/terminal/manager.ts:122-195`).
- profile-scope `skill.install` pulls any GitHub repository into the user's Claude profile (`apps/runner/src/skills/install.ts:86`).
- watch-list roots come from the server with only `root: z.string().min(1)` (`packages/shared/src/protocol/projects.ts:20,123`).

**Attacker.** Whoever controls the API: a compromised server, a stolen runner token used against a fake server, or an admin account takeover.

**Scenario.** The server sends a card run with an arbitrary prompt in `bypassPermissions`, a terminal write, or a skill install from a repository it controls.

**Impact.** Arbitrary code execution as the developer on every paired machine.

## Fix
- Add a `policy` block to `runner.json`, written only by the local CLI (`agentdock-runner policy show|set|allow-root|deny-root`), never by any server command:
  - `allowedRoots: string[]` (set at `pair`, default: none until the person adds one);
  - `maxPermissionMode` (default below `bypassPermissions`);
  - `terminal.write: false`;
  - `skills.profileInstall: false`;
  - an explicit list of other dangerous commands, disabled by default.
- Enforce it in `apps/runner/src/commands/dispatcher.ts` before any handler, and in the orchestrator start path. A refusal is a typed `policy_refused` failure naming the rule.
- Validate server roots: absolute, `realpath`, a git main checkout, inside `allowedRoots`.
- Report the effective policy (values only, no paths beyond `allowedRoots`) in `hello` capabilities so the UI can explain refusals.
- The policy follows ADR-0044 (amends ADR-0010).

## Acceptance criteria
- Dispatcher regression tests: `card.run {permissionMode:'bypassPermissions'}`, `orchestrator.start` with bypass, `terminal.attach {mode:'write'}`, profile-scope `skill.install` and a watch-list root outside `allowedRoots` each fail with `policy_refused`, whatever the server sends
- Each of those passes after the policy is changed locally with the CLI
- No server command or `hello` response can change the policy (test: a crafted `runner.describe`/settings command leaves `runner.json` policy unchanged)
- A root that is a symlink to a path outside `allowedRoots`, or not a git main checkout, is refused
- `hello` carries the policy; the web shows the refusal reason on the card, terminal and skill install surfaces
- `agentdock-runner policy show` prints the effective policy; `docs/architecture/runner-protocol.md` documents `policy_refused`

## Touches
- apps/runner/src/config.ts
- apps/runner/src/cli.ts
- apps/runner/src/daemon.ts
- apps/runner/src/commands/dispatcher.ts
- apps/runner/src/commands/handlers.ts
- apps/runner/src/projects/watch-list.ts
- apps/runner/src/cards/launch.ts
- apps/runner/src/control/orchestrator.ts
- apps/runner/src/terminal/manager.ts
- apps/runner/src/skills/install.ts
- apps/runner/src/policy/**
- packages/shared/src/protocol/capabilities.ts
- packages/shared/src/protocol/projects.ts
- packages/shared/src/protocol/commands/failure*
- apps/api/src/runners/**
- apps/web/src/lib/runners/**
- apps/web/src/components/**/policy-*
- docs/architecture/runner-protocol.md

## Decision
D-01 — runner-local security policy in the runner's own config, the server cannot change it, safe defaults for bypassPermissions, terminal write, skill.install and the watched roots (ADR-0044)

## Must not run in parallel with
- WI-20
- WI-21
- WI-37
- WI-68


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
