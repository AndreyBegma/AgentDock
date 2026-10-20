# agentdock-runner (deprecated)

`agentdock-runner` is now [`nautelle-runner`](https://www.npmjs.com/package/nautelle-runner).
This package depends on the same version of `nautelle-runner` and runs it
under the old `agentdock-runner` command, so an existing install keeps
working while you move over. It is published for runner 0.14 and 0.15 only;
0.16.0 is not published under this name.

```sh
npm i -g nautelle-runner
npm rm -g agentdock-runner
nautelle-runner install-service   # replaces the agentdock-runner unit or agent
nautelle-runner setup claude      # replaces the agentdock plugin with nautelle
```

On its first start, `nautelle-runner` moves `~/.config/agentdock` and
`~/.local/state/agentdock` to their `nautelle` names and leaves a symlink
behind, so the pairing, the policy, the watched projects and the running
sessions carry over. `AGENTDOCK_*` environment variables are still read until
0.16.0. See the
[release notes](https://github.com/AndreyBegma/AgentDock/blob/main/apps/runner/CHANGELOG.md)
and ADR-0073.
