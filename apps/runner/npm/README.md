# nautelle-runner

The per-machine daemon of [Nautelle](https://agentdock.luna-realm.com/),
a self-hosted control plane for Claude Code and Codex agent fleets. It pairs
with a Nautelle server, reports the machine's runtimes and answers typed
commands.

```sh
npm i -g nautelle-runner        # or: bun add -g nautelle-runner
nautelle-runner pair --server https://<nautelle-host>/api --code XXXX-XXXX
nautelle-runner install-service
```

`install-service` writes a systemd user unit on Linux and a launchd agent on
macOS, and prints the command that starts it.

The package holds a small Node shim. The runner itself is a prebuilt binary
in one of `nautelle-runner-darwin-arm64`, `-darwin-x64`, `-linux-x64` or
`-linux-arm64`, which npm installs from `optionalDependencies` for the current
machine. Nothing is downloaded at install time, so it works with npm, bun and
pnpm. Installing with optional dependencies turned off leaves no binary to run.

Before it runs the binary, the shim checks that the binary's SHA-256 is listed
in the release's `SHA256SUMS`, shipped in this package, and that the file is
signed by the Nautelle release key
([`release-key.pub`](https://github.com/AndreyBegma/AgentDock/blob/main/apps/runner/release-key.pub)).
It refuses a binary that fails either check.

**Upgrading from 0.12 or earlier:** 0.13 watches only projects under a
folder you allow on the machine, and allows none by default. Run
`nautelle-runner policy allow-root --watched` (the folders it watched
before, after asking) or `nautelle-runner policy allow-root <dir>`. See the
[release notes](https://github.com/AndreyBegma/AgentDock/blob/main/apps/runner/CHANGELOG.md).

On macOS, Homebrew is the other way in:

```sh
brew install andreybegma/tap/nautelle-runner
brew services start nautelle-runner
```

- Website: [agentdock.luna-realm.com](https://agentdock.luna-realm.com/).
- Source: [github.com/AndreyBegma/AgentDock](https://github.com/AndreyBegma/AgentDock).
- Documentation: [apps/runner](https://github.com/AndreyBegma/AgentDock/tree/main/apps/runner).
