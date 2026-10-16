# Token saver

Token saver ([#445](https://github.com/AndreyBegma/AgentDock/issues/445),
[ADR-0039](../adr/0039-token-saver.md), [spec](../specs/445-token-saver.md))
cuts the tokens an agent spends re-reading things nobody needs in full. It
changes what **agents read**. It never changes what **people read**: questions
to you, specs, pull-request descriptions, `finish_card` summaries and design
output stay complete.

This guide is for the person using it. How the filter engine works, and how to
add a filter, is in [the filter guide](token-saver-filter.md).

## What it does

For every Claude launch the runner makes, with the project's setting on:

- **Command output is shortened.** When an agent runs a covered command (a test
  run, `git log`, a build…), the runner's filter keeps the lines that matter
  and hides the rest. The agent sees a footer such as
  `[agentdock filter: 412 lines hidden · full output: <path> · AGENTDOCK_RAW=1 to bypass]`.
- **Only the MCP servers you allow are loaded.** Every other server's tool
  schemas cost no tokens (see [the allowlist](#the-mcp-allowlist)).
- **Broad searches go to a cheaper helper**, the history is compacted earlier,
  and the worker prompt is ordered so the model's cache hits.

The setting is per project, **on by default**, and an administrator of the
project can switch it off under **Settings › Token saver**. Off launches every
agent exactly as it was launched before the feature.

## What is never hidden

- The **exit code** of a command is the command's own.
- **Errors, failures, warnings and stack frames** are never removed. If the
  filter cannot tell what a line is, or the result would not be shorter, the
  agent gets the output **unchanged**.
- A command no filter covers runs as written.

## When the filter does not apply

The filter rewrites a Bash call only when it can do so without changing what
the session is allowed to run. Claude Code checks permission rules against the
command a hook *returns*, so a rewrite could hide `git push` from a
`Bash(git push:*)` rule. The runner therefore rewrites only when:

- the session runs in `bypassPermissions`, or in `auto` (Board card sessions
  do). In `auto` the hook makes no decision, and Claude Code's classifier
  still judges the wrapped command; **and**
- no `deny` or `ask` rule matches it; **and**
- the call is a single simple command — no pipe, `&&`, redirect or subshell —
  that is not in the background, a dev server or a watch mode.

In any other session the command runs unfiltered, and the dashboard counts it
as "returned the original". The exact rules are in
[the filter guide](token-saver-filter.md#permissions-the-rewrite-never-changes-what-is-allowed).

## Reading the raw output

Every filtered command's **complete** output is kept, byte for byte, in the
run's directory: `<run dir>/raw/<n>.log`. The path is in the footer the agent
sees, and an agent can read it when it needs a hidden line. The file is on the
runner's machine; the control plane never reads it (ADR-0001).

## Bypass: `AGENTDOCK_RAW=1`

To run one command with no filtering, put the variable in front of it:

```sh
AGENTDOCK_RAW=1 bun run test
```

The worker prompt tells agents about it. You can use it too when you drive a
session by hand, or tell an agent: *"re-run that with `AGENTDOCK_RAW=1`"*. A
bypassed command is counted, so a high **bypass rate** on the dashboard means
the filter is getting in the way.

## The MCP allowlist

Under **Settings › Token saver** the list **MCP servers agents load** has one
checkbox per server the runner reports for the project's profiles.

- `agentdock` is always loaded and is not in the list.
- An **empty list means `agentdock` only**. Every unticked server is not loaded
  at all, so a card that used Playwright or GlitchTip needs its checkbox
  ticked.
- A name that is allowed but that no profile reports any more stays visible and
  is marked, so saving never drops it silently.
- Only an operator can read the runner's profiles. A viewer sees the stored
  names, locked. If the list is empty because the runner reports nothing (an
  older runner, or a Codex profile), update the runner.
- Only a **project administrator** can save.

If an agent reports a missing tool after you turned this on, a server was left
unticked: tick it and save. The bypass rate does not show this.

## Where the savings show

All figures from the filter are **estimates**, marked **≈**: the bytes hidden
divided by four is the tokens, priced at the session model's input price. The
fact — what a run of each kind cost on average before and after — comes from
usage.

| Where | What it shows |
|---|---|
| **Card** | `saved ≈ $x` next to the cost; the card sheet lists the round's filters, and shows **Description incomplete** when the artifact guard let a finish through after two rewrites |
| **Usage › Token saver** | for the range and project in view: saved, commands, bypass rate, "returned the original" rate, cost per run before and after by run kind, top filters |
| **Project › Token saver** | the project's dashboard: savings over time, by filter, by run kind, the bypass rate, and the filters that most often returned the original |

"Before" and "after" compare runs launched without and with Token saver, by
run kind; a project that has always had it on has no "before".

## Description incomplete

A worker may not finish a card without a pull-request description that has
`Closes #n` (when the card has an issue), `## What changed and why`,
`## Acceptance criteria` and a summary of at least two sentences. The first two
rejections send the worker back to rewrite it. The third attempt in the round is
accepted, and the card carries **Description incomplete** so you know to read
the description before you accept it.
