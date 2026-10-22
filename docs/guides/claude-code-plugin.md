# The Claude Code plugin and what it trusts

The `nautelle` Claude Code plugin (`plugins/nautelle/`) forwards every hook
event of a session — prompts and tool input included — to the local
`nautelle-runner`, and runs `nautelle-runner mcp` as the session's `nautelle`
MCP server. `nautelle-runner setup claude` installs it per Claude profile
(spec 201 D21). This guide says which copy of the plugin is installed and
which binary its hooks reach (C-162, security finding L-36).

## Which plugin revision is installed

`setup claude` adds the repository marketplace pinned to the release tag of
the runner that runs it:

```
claude plugin marketplace add AndreyBegma/Nautelle#runner-v<runner version>
claude plugin install nautelle@nautelle --scope user
```

A change that lands on the default branch therefore reaches a machine only
through a runner release, whose `runner-v*` tags are protected
(`.woodpecker/release-runner.yml`). When the marketplace is already added
from another source — the default branch, as before C-162, or an older tag —
`setup claude` removes it first, because `claude plugin marketplace add`
refuses a second source under the same name. After upgrading the runner, run
`nautelle-runner setup claude` again to move the pin to the new tag.

## Which binary the hooks and the MCP server run

`setup claude` writes the absolute path of the running runner binary into
the profile's `settings.json` → `env.NAUTELLE_RUNNER_BIN`. Claude Code passes
that environment to hook commands and MCP servers, and the plugin runs:

1. `$NAUTELLE_RUNNER_BIN`, when it is an absolute path to an executable file;
2. otherwise the `nautelle-runner` found on `PATH`.

The path written is the `nautelle-runner` on `PATH` when that resolves to the
very same binary (a package manager's stable symlink survives an upgrade; its
versioned target does not), and the binary's own path otherwise. A runner
started from source under Bun has no single binary to name, so `setup claude`
writes nothing and says the plugin falls back to `PATH`. `setup claude
--uninstall` removes the key again.

The MCP server is started as `/bin/sh -c '…'` so that the same fallback
applies to it; its script avoids the `${VAR}` form, which Claude Code would
expand itself.

## The PATH trust assumption

The fallback trusts `PATH`: whoever can put an executable named
`nautelle-runner` in a directory earlier on the `PATH` of a Claude Code
session receives every hook payload of that session and serves its
`nautelle` MCP tools. This is the case when:

- `NAUTELLE_RUNNER_BIN` is unset — `setup claude` never ran for the profile,
  or the runner runs from source;
- the path in `NAUTELLE_RUNNER_BIN` no longer exists or is not executable,
  for example after the binary was moved or reinstalled elsewhere; run
  `setup claude` again to repair it.

`NAUTELLE_RUNNER_BIN` itself is trusted: anyone who can edit the profile's
`settings.json`, or replace the binary it names, controls the session
already. The `/bin/sh` that starts the MCP server and the shell Claude Code
runs hook commands in are trusted the same way.
