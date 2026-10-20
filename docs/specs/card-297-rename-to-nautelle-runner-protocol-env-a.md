# C-297: Rename to Nautelle: runner, protocol, env and plugin with a compatibility window

## What to do
Rename what lives on people's machines, with a transition period so nothing breaks on upgrade:
- npm: publish `nautelle-runner` (+ platform packages); `agentdock-runner` becomes a deprecated shim that depends on it and prints a notice; the Homebrew formula and the installers follow;
- binary `nautelle-runner`, systemd unit `nautelle-runner` (the installer migrates the old unit);
- config and state dirs `~/.config/nautelle`, `~/.local/state/nautelle`: migrated on first start from the `agentdock` ones (move, keep a symlink back), including the policy in `runner.json` and the session-token secret;
- env vars `NAUTELLE_*`: the runner and the hooks read the new name first and the old `AGENTDOCK_*` as a fallback for two minor releases;
- tmux session prefixes (`nautelle-card-*` …), recognising the old prefixes for running sessions;
- the Claude Code plugin `nautelle` (MCP tool names change; keep the old plugin id working or document the reinstall);
- the database name stays `agentdock` (invisible to users).
Record it in an ADR (compatibility window and its end).

## Acceptance criteria
- [ ] Upgrading a runner from the `agentdock` names keeps watching its projects, keeps live sessions and keeps its policy (a runner spec covers the migration).
- [ ] Old env vars still work and log a deprecation once.
- [ ] `agentdock-runner` on npm installs the new runner.
- [ ] `bun run check` passes; CI is green.

## Context
The product is renamed from **AgentDock** to **Nautelle** (the person's decision, 2026-10-20). "AgentDock" appears about 5,000 times in 1,800 files. The rename runs in four cards, in order: brand → code identifiers → runner and protocol → infrastructure. Run it only when no other card is open: the identifier codemod conflicts with every open PR.

Do **not** create a fallback `AgentDock` repository: GitHub redirects the old name after a rename only while no repository takes that name.
