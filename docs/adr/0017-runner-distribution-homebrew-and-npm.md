# ADR-0017: The runner ships as prebuilt binaries through Homebrew and npm

Status: accepted · Date: 2026-10-13 · Amended by [ADR-0073](0073-the-runner-and-its-protocol-are-renamed-nautelle-with-a-compatibility-window.md) (the package, binary and formula are renamed `nautelle-runner`)

## Context

`agentdock-runner` ([ADR-0001](0001-control-plane-and-per-machine-runner.md))
could not be installed. It existed only as `bun build --compile` output in
`apps/runner/dist/`, so a user had to clone the monorepo, install Bun and build
it. On 2026-10-13 the owner ran `agentdock-runner pair …` on a Mac and got
`command not found`.

The runner uses Bun APIs in about ten files, so it cannot ship as plain
JavaScript for Node. `install-service` wrote a systemd user unit only, so macOS
had no supported way to keep the daemon running. The owner decided to ship the
runner through Homebrew and npm (issue #131).

## Decision

1. **Names.** The binary is `agentdock-runner`. The npm package is
   `agentdock-runner`, because `agentdock` belongs to an unrelated package. The
   Homebrew tap is `AndreyBegma/homebrew-tap`, and the install command is
   `brew install andreybegma/tap/agentdock-runner`.
2. **Targets.** The targets are `darwin-arm64`, `darwin-x64`, `linux-x64` and
   `linux-arm64`. All four are cross-compiled from Linux with
   `bun build --compile --target=bun-<os>-<arch>`
   (`apps/runner/scripts/build-release.sh`, which needs only Bun). Windows is
   not a target.
3. **Releases.** Pushing the git tag `runner-v<semver>` runs
   `.woodpecker/release-runner.yml`. The tag must equal the `version` in
   `apps/runner/package.json`, and the build refuses a mismatch. The workflow
   creates a GitHub Release on `AndreyBegma/AgentDock` with one
   `agentdock-runner-<version>-<os>-<arch>.tar.gz` per target and a
   `SHA256SUMS`. It then publishes to npm and pushes the formula to the tap. A
   manual run whose message contains `[runner-release]` is a dry run that
   builds everything and stops before every publish step. The gate is a
   message marker because Woodpecker 3.x passes a manual run's variables to
   the steps only, never to a workflow's `when` (issue #135). `RUNNER_RELEASE_DRY_RUN=1` also stops a tag
   run before it publishes. Pull requests never run the workflow, and its
   secrets are restricted to the `tag` and `manual` events.
4. **npm, esbuild-style.** The wrapper package `agentdock-runner` holds a small
   Node shim (`apps/runner/npm/bin/agentdock-runner.js`). The shim finds
   `agentdock-runner-<os>-<arch>` and runs its binary with `execFileSync` and
   inherited stdio, passing the exit code through. The wrapper's
   `optionalDependencies` pin the four platform packages at the same exact
   version. Each platform package declares `os` and `cpu` and contains only the
   binary. There is no `postinstall` download, so npm, bun and pnpm all work.
   When no platform package matches, the shim prints the supported targets
   and the Homebrew and source alternatives. Platform packages are published
   before the wrapper.
5. **Homebrew.** The tap's `Formula/agentdock-runner.rb` is rendered from
   `apps/runner/homebrew/agentdock-runner.rb.template` by
   `scripts/render-formula.sh <version> <SHA256SUMS>`. The formula has
   `on_macos`/`on_linux` × `on_arm`/`on_intel` blocks, and each block holds a
   Release asset URL and its sha256. Its `service do` block runs
   `agentdock-runner run` and logs to `var/log/agentdock-runner.log`.
   `brew services start agentdock-runner` is the supported way to keep the
   runner running on macOS.
6. **`install-service` on macOS.** The platform is chosen by `process.platform`.
   On macOS, the command writes
   `~/Library/LaunchAgents/com.agentdock.runner.plist` with `RunAtLoad`,
   `KeepAlive.SuccessfulExit=false`, a 5 s `ThrottleInterval`, logs in
   `~/Library/Logs/agentdock-runner.log` and the `PATH` of the shell that ran
   it. launchd's own default `PATH` has only the system directories, so it
   would miss runtimes installed by Homebrew or in `~/.local/bin`. The command
   then prints the `launchctl bootstrap gui/$UID …` line. On Linux, the systemd
   user unit is unchanged.
7. **Exit 78 is not restarted, under any service manager.** The issue named
   `KeepAlive.SuccessfulExit=false` (and `keep_alive true` in the formula). That
   alone does not honour the exit code, because launchd restarts every non-zero
   exit, 78 included, and has no equivalent of systemd's
   `RestartPreventExitStatus`. So both the launchd agent and the formula's
   service run the daemon through
   `/bin/sh -c '"$@"; c=$?; [ "$c" -eq 78 ] && exit 0; exit "$c"'`. A
   terminal close becomes a clean exit, which `SuccessfulExit=false` (in
   Homebrew, `keep_alive successful_exit: false`) does not restart. Every other
   exit code passes through unchanged. The systemd unit keeps
   `RestartPreventExitStatus=78`.
8. **`agentdock-runner version`** prints the version and the target:
   `0.1.0 darwin-arm64`.

## Consequences

- A release needs three things a person sets up once: the public repository
  `AndreyBegma/homebrew-tap` with a `Formula/` directory, and the Woodpecker
  secrets `github_release_token` and `npm_token`, both restricted to the `tag`
  and `manual` events (`deploy/README.md`).
- The darwin binaries are cross-compiled and are neither notarized nor signed
  with a Developer ID. If Gatekeeper refuses the cross-compiled `darwin-arm64`
  Mach-O, the fix is ad-hoc signing (`codesign --sign -`) in
  `build-release.sh`. The first release is checked on an Apple Silicon Mac by a
  person.
- Each platform package carries a whole Bun runtime, so a package is about
  70–85 MB and a tarball about 26–37 MB.
- Under launchd and `brew services`, a terminal close is logged by the runner
  itself. The service manager records it as exit 0.
- Installing with optional dependencies turned off (`--omit=optional`) leaves
  the shim with no binary. It says so and exits 1.
