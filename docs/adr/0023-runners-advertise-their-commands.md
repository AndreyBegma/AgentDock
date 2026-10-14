# ADR-0023: Runners advertise their commands; features check commands, never versions

Status: accepted · Date: 2026-10-14 ·
Issue: [#233](https://github.com/AndreyBegma/AgentDock/issues/233)

## Context

The runner releases on its own schedule (ADR-0017), so the API regularly talks
to runners older than itself. A feature that needs a command the runner does
not serve (`plan.turn`, `uiprofile.build`, `worktree.status`) found out only
after the runner answered `unknown_command`; the web matched that text in error
messages, showed a "runner too old" banner after a plan had already failed,
and never cleared it. A command switched off in the runner config
(`disabledCommands`, ADR-0010) answered the same way as a missing one, though
the fix is different: edit the config, not update the runner.

## Decision

1. **The runner advertises what it serves.** Hello `capabilities` carries
   `commands` — every command its build serves, its handler keys — and
   `disabledCommands`, the subset its config switches off. Both are plain
   strings, not an enum of the allowlist, so a runner newer than the API never
   fails its hello.
2. **Absent always means unknown, never none.** A runner older than the field
   sends no `commands`; everything behaves as before for it, and the runner's
   own answers stay authoritative.
3. **Features check the commands they need, never the runner version.** One
   shared pure helper (`commandSupport` / `commandsSupport` with
   `RUNNER_FEATURE_COMMANDS`) decides between `supported`, `disabled`,
   `missing` and `unknown`. The API refuses a `missing` command with 409
   `runner_outdated` before it writes or sends anything; `disabled` and
   `unknown` pass to the runner.
4. **Only names leave the API.** Project members see
   `ProjectDetail.runnerCommands` (`{ commands, disabled }` or `null`), never
   the whole capabilities object.
5. **The protocol version does not change.** The fields are additive and
   optional, which the protocol already allows; `PROTOCOL_VERSION` stays `1`.

## Alternatives rejected

- **A minimum runner version per feature.** Needs a table kept up to date every
  release, dev builds report `0.1.0`, it cannot express `disabledCommands`, and
  the version is admin-only.
- **Per-feature flags** (`planner: true`). A new flag on both sides per feature,
  and flags drift from the handlers; the grouping lives in shared instead.
- **Bumping `PROTOCOL_VERSION`.** A 4400 close would disconnect every older
  runner for a change they can safely ignore.
- **Exposing the whole capabilities object.** Leaks profile `env` and binary
  paths and the code-sentinel path to viewers.
- **A `commands` column.** Duplicates the stored capabilities JSON, already the
  source of truth, and needs a migration for nothing.
- **Advertising only enabled commands.** A disabled command would read as
  "runner too old" — the wrong fix.

## Consequences

- A new command needs no extra flag: it is advertised once the runner registers
  its handler, and a feature that needs it adds it to `RUNNER_FEATURE_COMMANDS`.
- The `unknown_command` text matching in the web stays as the fallback for
  older runners and for a runner that changes between hello and the call.
- `terminal` stays a separate capability: it is a fact about the machine (a
  PTY, tmux), not only about the build.
