# C-327: feat(runner): check npm for a newer nautelle-runner on every interactive run and offer to install it

The person asked for the same update prompt DemoFlow gets in AndreyBegma/DemoFlow#166 (spec `docs/specs/166-cli-update-prompt.md` in that repository — read it and mirror its behaviour), for `nautelle-runner` (https://www.npmjs.com/package/nautelle-runner).

Decided with the person for DemoFlow, apply the same here: check on **every** interactive run; ask **after** the command finishes; answer **Y/n** (default yes) and install.

## Behaviour
After an interactive `nautelle-runner` CLI command finishes, the CLI checks npm for a newer version and asks `Update nautelle-runner 0.14.0 → 0.15.0? [Y/n/never for this version]`. Yes runs the global install with the package manager that installed it.

## Acceptance criteria
- Every interactive CLI run checks the registry concurrently with the command. The check never delays or changes the command's output or exit code. Timeout 1.5 s.
- It prompts only after the command finished and only when stdin and stdout are both a TTY. Silent under CI, inside the daemon (`nautelle-runner` run by the systemd/launchd unit or any non-interactive start), under MCP, under npx / bunx / pnpm dlx, and with `NAUTELLE_NO_UPDATE_CHECK=1`.
- A version counts as available only when the meta package **and** the platform package for this host (`nautelle-runner-<os>-<arch>`) both report it on the registry — the meta package can be published minutes before the 38 MB platform binary, and installing early removes the binary the service unit points at.
- Yes runs the global install for the detected manager (npm / bun / pnpm / yarn; fnm-managed node counts as npm). When the manager is unknown, print the command instead of guessing. A failed install prints the error, and the exit code stays the command's own.
- After a successful install, when a runner service unit is installed and active, say that the daemon still runs the old version and print the exact restart command for this platform (do not restart it automatically).
- "never for this version" is remembered under the runner's config directory (`~/.config/nautelle`) and asked again for the next version.
- Unit tests cover each case; they never hit the real registry (the fetch is injected).
- Document the prompt and `NAUTELLE_NO_UPDATE_CHECK` in the runner's README / docs.
