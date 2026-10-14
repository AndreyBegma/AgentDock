# ADR-0020: Claude Code integration — hooks observe, MCP acts, both through the runner

Status: accepted · Date: 2026-10-14 · Amends [ADR-0010](0010-typed-command-allowlist-on-the-runner.md) ·
Issue: [#201](https://github.com/AndreyBegma/AgentDock/issues/201)

## Context

A person who runs `claude` by hand in a terminal is already seen by AgentDock:
the runner tails every transcript of every profile (spec 12, D2). But the
control plane learns about such a session late, without live state. The session
knows nothing about AgentDock and cannot act on it. On 2026-10-14 the owner asked
for an integration that makes manual sessions first-class. It has three parts:

- live tracking;
- context from the server;
- a way for the session to act on the server: queue work, hand off to the fleet,
  and ask for approvals.

The owner also asked whether this should ship as a separate npm package or
inside the runner.

Two Claude Code mechanisms exist:

- **Hooks** run on every lifecycle event, whatever the model decides.
- An **MCP server** is called only when the model chooses one of its tools.

So tracking cannot rest on MCP.

## Decision

1. **Hooks observe, MCP acts.** A Claude Code plugin `agentdock`, kept in this
   repository under `plugins/agentdock/`, bundles:
   - hooks that report the session's lifecycle;
   - an MCP server that gives the model tools against the control plane;
   - a skill that explains them.
2. **One binary.** The hook commands (`agentdock-runner hook <event>`) and the
   MCP server (`agentdock-runner mcp`, stdio) are subcommands of the existing
   `agentdock-runner` binary ([ADR-0017](0017-runner-distribution-homebrew-and-npm.md)).
   There is no standalone npm package. A machine without a runner is out of
   scope.
3. **The daemon is the only thing that talks to the server.** The hook and MCP
   processes connect to the running daemon over a local unix socket. The socket
   is owned by the user, mode `0600`, and lives in a `0700` directory. The daemon
   relays over its existing WSS. The runner token never leaves the daemon, and
   hook events go through the spool like every other event.
4. **Runner-initiated typed requests (amends ADR-0010).** Until now only the
   server asked and the runner answered. A new pair of wire messages,
   `local.request` and `local.response`, lets the runner ask the server. The
   methods form a closed, typed allowlist in `packages/shared`, as commands do,
   and each method states the minimum role it needs. The server answers only
   allowlisted methods with validated arguments.
5. **Whose authority.** A runner has no user today. Each runner gets a
   **local user**: an admin assigns one, and it defaults to the admin who
   created the runner. Local requests act with that user's role on the project,
   **capped at `operator`**. Every write is audited, with the runner as actor and
   the local user as `onBehalfOf`.
6. **Writes that need a person go through an action request.** Starting or
   stopping the orchestrator, merging, and approving a tool call when the person
   is away are not executed on request. They create an action request that a
   person approves in the web app or in Telegram.
7. **Usage stays where it is.** Hooks never produce `llm.request`. Tokens still
   come from OTel and transcripts ([ADR-0003](0003-usage-from-opentelemetry-transcripts-as-backfill.md)),
   so nothing is counted twice.

## Consequences

- One install (`brew` or `npm`) gives the daemon, the hooks and the MCP server.
  `agentdock-runner setup claude` installs the plugin into each Claude profile.
- Every hook runs a process of the compiled binary. Hooks that need no answer
  are declared `async`, so they never slow the session. Only `SessionStart` and
  `PermissionRequest` wait for an answer.
- When the daemon is down, a hook exits 0 within its connect timeout and the
  session continues untracked. The MCP tools answer with `runner_offline`.
- The runner→server direction is now a second allowlist to maintain. That is the
  deliberate cost ADR-0010 accepted for the other direction.
- Codex is out of scope until M4.
- Rejected:
  - **A standalone Node MCP package with its own token.** It would add a second
    auth channel and need a token in every Claude process.
  - **MCP-only tracking.** It reports only when the model feels like it.
  - **Hooks calling the API directly over HTTP.** The token would sit in every
    process, and there would be no spool.
