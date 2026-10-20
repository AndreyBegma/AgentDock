# agentdock-runner release notes

Each release's GitHub release links here. A release with an upgrade note says
what to do on every machine that runs the runner.

## Unreleased

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
