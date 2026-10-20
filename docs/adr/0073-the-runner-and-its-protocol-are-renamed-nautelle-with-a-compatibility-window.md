# ADR-0073: The runner and its protocol are renamed Nautelle, with a compatibility window

Status: accepted · Date: 2026-10-20 ·
Card: C-297 ·
Spec: [`docs/specs/card-297-rename-to-nautelle-runner-protocol-env-a.md`](../specs/card-297-rename-to-nautelle-runner-protocol-env-a.md)

## Context

ADR-0072 renames the product in four steps; this is step 3, the runner and
its protocol. Unlike the brand and the code identifiers, these names live on
people's machines and in other programs: the npm package and the Homebrew
formula people installed, the binary their systemd unit or launchd agent
starts, the directories that hold their pairing, policy and session-token
secret, the environment variables their scripts set, the tmux sessions that
are running right now, the Claude Code plugin they installed, and the webhook
headers a receiver checks. A runner that upgrades must keep watching its
projects, keep its live sessions and keep its policy.

## Decision

1. **New names.**

   | What | Old | New |
   | --- | --- | --- |
   | npm package | `agentdock-runner`, `agentdock-runner-<os>-<arch>` | `nautelle-runner`, `nautelle-runner-<os>-<arch>` |
   | Homebrew formula | `agentdock-runner` | `nautelle-runner` |
   | Binary | `agentdock-runner` | `nautelle-runner` |
   | Release tarball | `agentdock-runner-<version>-<target>.tar.gz` | `nautelle-runner-<version>-<target>.tar.gz` |
   | systemd user unit | `agentdock-runner.service` | `nautelle-runner.service` |
   | launchd agent | `com.agentdock.runner` | `com.nautelle.runner` |
   | Config dir | `~/.config/agentdock` | `~/.config/nautelle` |
   | State dir | `~/.local/state/agentdock` | `~/.local/state/nautelle` |
   | Socket dir | `$XDG_RUNTIME_DIR/agentdock` | `$XDG_RUNTIME_DIR/nautelle` |
   | Environment | `AGENTDOCK_*` | `NAUTELLE_*` |
   | tmux sessions | `agentdock-card-*`, `agentdock-manual-*`, `agentdock-run-*`, `agentdock-orch-*`, `agentdock-plan-*`, `agentdock-uiprofile-*` | `nautelle-…` with the same suffixes |
   | Claude Code plugin | `agentdock@agentdock`, MCP tools `mcp__plugin_agentdock_agentdock__*` | `nautelle@nautelle`, `mcp__plugin_nautelle_nautelle__*` |
   | MCP server of runner launches | `agentdock` | `nautelle` |
   | Webhook headers | `X-AgentDock-Timestamp`, `-Delivery`, `-Signature`, `-Event` | `X-Nautelle-…` |
   | Webhook User-Agent | `AgentDock-Webhooks/1` | `Nautelle-Webhooks/1` |
   | Pull request marker | `AgentDock-Card: C-12` | `Nautelle-Card: C-12` |
   | Reply header | `… via AgentDock` | `… via Nautelle` |

2. **The compatibility window is runner 0.14 and 0.15.** In it:
   - **Directories** move on the first start of any runner command: a real
     `agentdock` config, state or socket directory is renamed to its
     `nautelle` name, and a symlink is left at the old path pointing to the
     new one. The pairing, the policy in `runner.json`, the spool, the card
     records and the session-token secret move with their directory, so paths
     stored before the move (a card's settings file, a hook's socket) keep
     resolving. When both directories exist, nothing moves and the runner
     says so once; it uses the new one.
   - **Environment variables**: the runner and its hooks read `NAUTELLE_X`
     first and `AGENTDOCK_X` when the new one is unset. The daemon and the
     interactive commands log a deprecation once per variable; hook, filter
     and MCP processes stay silent, since their output belongs to Claude Code.
     The runner sets both names on everything it starts (card sessions, hook
     and filter environments, background claude runs), because programs
     outside the runner still read the old names.
   - **tmux sessions**: the runner names new sessions `nautelle-…` and
     recognises sessions under the old prefix everywhere it parses a name — a
     card record, a terminal attach, the orchestrator's session, a card that
     is run again — so sessions started before the upgrade are attached,
     reported and stopped as before.
   - **npm**: `agentdock-runner` is published one last time per release as a
     deprecated package that depends on the same version of
     `nautelle-runner`; its `agentdock-runner` command runs the new runner and
     prints a notice on a terminal. **Homebrew**: the tap renames the formula
     (`formula_renames.json`), and `nautelle-runner` also installs an
     `agentdock-runner` link, so a unit or a hook that still names the old
     binary keeps working.
   - **Service**: `install-service` writes the new unit or agent and removes
     the old one, disabling it first. The daemon warns while the old unit
     file still exists.
   - **Plugin**: the plugin moves to `plugins/nautelle`. Claude Code keys a
     plugin by its name and its marketplace, so the old id cannot keep
     working; `nautelle-runner setup claude` installs the new one, and the
     upgrade notes say to uninstall `agentdock@agentdock`. The runner counts
     either plugin as installed and allows MCP tools of either server name.
   - **Protocol**: the API sends both header sets on every webhook and reads
     the new header first, the old one second, on inbound hooks. The runner
     recognises both pull request markers and both reply headers.

3. **The window ends with runner 0.16.0.** That release drops the old
   environment variables, the old tmux prefixes, the old plugin's detection,
   the directory migration, the `agentdock-runner` npm package and Homebrew
   link, and the old headers and marker in the API's release that ships with
   it. A runner that skips from 0.13 to 0.16 is set up again by hand.

4. **What stays.** The database is still named `agentdock`, as are the
   Redis queue prefix, the advisory lock names, the fenced block tags
   (`agentdock-plan`, `agentdock-design`, `agentdock-cards`), the `.agentdock/`
   directory inside a card's worktree and the HTML data attributes. They are
   internal, no person types them, and renaming them needs a data migration;
   the infrastructure step (ADR-0072 step 4) owns the database and the
   repository.

## Consequences

- An upgraded runner keeps its pairing, policy, projects and sessions with
  no action from the person. A service installed from npm points into the old
  package's directory, which the upgrade removes; the upgrade notes say to run
  `nautelle-runner install-service` once.
- The old names keep working for two minor releases, at the cost of
  dual-name code that 0.16.0 deletes; the code marks each such place as
  legacy.
- `scripts/check-brand.ts` no longer allows the webhook headers or the
  marker in the API and shared sources, except where they are kept as the
  legacy names.
- The card worker's prompt moves to the next version, because it names
  `NAUTELLE_RAW`.
