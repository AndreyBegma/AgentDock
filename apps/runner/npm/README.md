# agentdock-runner

The per-machine daemon of [AgentDock](https://agentdock.luna-realm.com/),
a self-hosted control plane for Claude Code and Codex agent fleets. It pairs
with an AgentDock server, reports the machine's runtimes and answers typed
commands.

```sh
npm i -g agentdock-runner        # or: bun add -g agentdock-runner
agentdock-runner pair --server https://<agentdock-host>/api --code XXXX-XXXX
agentdock-runner install-service
```

`install-service` writes a systemd user unit on Linux and a launchd agent on
macOS, and prints the command that starts it.

The package holds a small Node shim. The runner itself is a prebuilt binary
in one of `agentdock-runner-darwin-arm64`, `-darwin-x64`, `-linux-x64` or
`-linux-arm64`, which npm installs from `optionalDependencies` for the current
machine. Nothing is downloaded at install time, so it works with npm, bun and
pnpm. Installing with optional dependencies turned off leaves no binary to run.

On macOS, Homebrew is the other way in:

```sh
brew install andreybegma/tap/agentdock-runner
brew services start agentdock-runner
```

- Website: [agentdock.luna-realm.com](https://agentdock.luna-realm.com/).
- Source: [github.com/AndreyBegma/AgentDock](https://github.com/AndreyBegma/AgentDock).
- Documentation: [apps/runner](https://github.com/AndreyBegma/AgentDock/tree/main/apps/runner).
