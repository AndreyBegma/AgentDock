# nautelle-runner release notes

Each release's GitHub release links here. A release with an upgrade note says
what to do on every machine that runs the runner.

## 0.14.0

**Upgrade note — the runner is renamed `nautelle-runner`
([ADR-0073](../../docs/adr/0073-the-runner-and-its-protocol-are-renamed-nautelle-with-a-compatibility-window.md)).**
Releases before this one are listed under their old name, `agentdock-runner`.

- The binary, npm package, Homebrew formula, systemd unit and launchd agent
  are now `nautelle-runner`. On first start the runner moves
  `~/.config/agentdock`, `~/.local/state/agentdock` and its runtime directory
  to their `nautelle` names and leaves a symlink at each old path, so the
  watched projects, the policy in `runner.json` and the session-token secret
  carry over.
- Every `AGENTDOCK_*` variable is still read when its `NAUTELLE_*` name is
  unset, and logs a deprecation once. Runner 0.16.0 stops reading the old
  names.
- tmux sessions started under the old `agentdock-*` prefixes keep being
  recognised, so live cards and the orchestrator survive the upgrade.
- Run `nautelle-runner install-service` once: it stops and removes the old
  `agentdock-runner` unit or agent and installs the new one. After an npm
  install this is required, because the old unit points into a package that
  is gone.
- npm: `npm i -g nautelle-runner`, then `npm rm -g agentdock-runner`. The
  `agentdock-runner` package is now a deprecated shim that installs
  `nautelle-runner` and runs it.
- Homebrew: `brew upgrade` follows the formula rename, and the formula keeps
  an `agentdock-runner` link to the new binary. Swap the service with
  `brew services stop agentdock-runner` and
  `brew services start nautelle-runner`.
- The Claude Code plugin is now `nautelle`, and its MCP tools are
  `mcp__plugin_nautelle_nautelle__*`. `nautelle-runner setup claude` replaces
  `agentdock@agentdock` with it; by hand: `claude plugin uninstall
  agentdock@agentdock`, `claude plugin marketplace remove agentdock`,
  `claude plugin marketplace add AndreyBegma/Nautelle` and
  `claude plugin install nautelle@nautelle`.
- Hooks already written into a running card's settings call the old binary
  path; the `agentdock-runner` link (npm shim or Homebrew) keeps them working
  until the card ends.
- Webhooks are sent and accepted under both `X-Nautelle-*` and the old
  `X-AgentDock-*` headers until runner 0.16.0.

- A runner started on a `runner.json` with no `policy` block — one written
  before 0.13 — logs and prints an upgrade notice: it watches no project,
  which projects it watched before, and the commands that allow them. It
  allows nothing itself ([ADR-0047](../../docs/adr/0047-a-runner-local-security-policy-the-server-cannot-change.md)),
  and the daemon no longer writes a default `policy` block into that file, so
  the notice repeats on every start until you set a policy (#691).
- `agentdock-runner policy allow-root --watched [--yes]` allows the roots of
  the projects in the cached watch list, after showing them and asking.
- The runner reports the projects its policy refuses
  (`runner.watch_refused`), and the web app shows on each such project why and
  the exact command to run on the runner's machine. A refusal of a root now
  names that root in its command instead of `<dir>`.

## 0.13.0

### Upgrade note

0.13 adds the runner-local security policy
([ADR-0047](../../docs/adr/0047-a-runner-local-security-policy-the-server-cannot-change.md)):
a `policy` block in `runner.json` that only the CLI on the machine writes. Its
`allowedRoots` is empty by default, and the runner watches only projects whose
root is inside an allowed root. **A runner upgraded from 0.12 or earlier
therefore watches no project until you allow their folders**: the Board, card
collect and the Planner stop for every project of that runner.

On every machine that runs the runner, after the upgrade:

```sh
agentdock-runner policy allow-root --watched   # the roots it watched before (from the next release)
# or name the folders yourself:
agentdock-runner policy allow-root ~/dev
agentdock-runner policy show
```

A running daemon picks the change up within 5 s; no restart is needed. The
server cannot do this for you: no message from it changes the policy.
