---
title: Runner security
description: What the server can and cannot make a runner do.
---

The runner is the only part of Nautelle that touches your code and your
agents. The server is a control plane: it never reads a project's files
itself, and it can ask a runner only for what the runner agrees to do.

## Connection and pairing

- **The runner dials out.** It connects to the server over a WebSocket; a
  runner machine opens no port.
- **Pairing is a one-time code.** An administrator creates a code valid for
  10 minutes and usable once. The runner exchanges it for its own token: 32
  random bytes, of which the server keeps only a hash. The token is never
  logged, and revoking the runner stops it at once.
- **HTTPS only.** A runner refuses a plain `http://` server other than
  localhost unless paired with `--insecure`.

## Typed commands only

The server cannot send a shell command. A runner accepts only the commands
defined in Nautelle's shared protocol — start a card worker, read a project's
state, open a pull request and so on — validates every argument, and refuses
a path outside the project roots it serves.

## A policy the server cannot change

Each runner has a local policy in `~/.config/nautelle/runner.json`, written
only by the runner's own command line on that machine:

- **Allowed roots.** The runner works only inside folders you allowed
  (`pair --allow-root`, `policy allow-root`). The list starts empty.
- **Permission mode ceiling.** The most permissive mode a session may start
  in; `auto` by default.
- **Switches** for writing to a terminal from the web app, installing skills,
  and other commands, most of them off by default.

A refused command fails with `policy_refused`, and the web app shows the
command that would allow it. The policy is not a sandbox — the agents
themselves run with your user's rights — but it bounds what the server, or
anyone who takes it over, can start on your machine.

## Credentials stay on the machine

Claude Code, Codex and GitHub credentials stay on the runner machine; the
server never stores or transmits them. Session content — prompts and tool
output — reaches the server only for projects where you turned it on; by
default the runner reports metadata and usage only.

## Where the reasoning lives

- [ADR-0001](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0001-control-plane-and-per-machine-runner.md): control plane and per-machine runner.
- [ADR-0010](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0010-typed-command-allowlist-on-the-runner.md): typed command allowlist on the runner.
- [ADR-0021](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0021-session-content-is-opt-in-per-project.md): session content is opt-in per project.
- [ADR-0047](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0047-a-runner-local-security-policy-the-server-cannot-change.md): a runner-local security policy the server cannot change.
- [ADR-0049](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0049-runner-releases-are-signed-and-cut-only-from-protected-tags.md): runner releases are signed and cut only from protected tags.
- [ADR-0077](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0077-runner-pushes-follow-a-branch-policy-and-protected-paths-need-a-person.md): runner pushes follow a branch policy, and protected paths need a person.
- [Security architecture](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/architecture/security.md).
