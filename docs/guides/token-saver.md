# Token saver

Token saver ([#445](https://github.com/AndreyBegma/Nautelle/issues/445),
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
  `[nautelle filter: 412 lines hidden · full output: <path> · NAUTELLE_RAW=1 to bypass]`.
- **Only the MCP servers you allow are loaded.** Every other server's tool
  schemas cost no tokens (see [the allowlist](#the-mcp-allowlist)).
- **The history is compacted at about 150k tokens**, on every model. On a 1M
  window a session used to grow to about 600k before compacting, and every
  turn re-reads what it holds.
- **Reads are trimmed too.** The runner guards `Read` itself, whatever
  plugins the profile has: a whole read of a file over 64 KB or 1,500 lines is
  refused once with a hint (read a range with `offset`/`limit`, find the line
  with `Grep`, or ask the `scout` agent), and a repeated read of an unchanged
  range is refused once with a reminder. Repeating the same call reads the
  file. The launch sets `CS_ECO=off`, so the code-sentinel plugin's `/cs-eco`
  hooks never guard the same read a second time. On a card under test with
  `read-guard-400` (see [techniques under test](#techniques-under-test)) the
  limit is 400 lines, and the refusal carries an outline of the file.
- **Broad searches go to a cheaper helper**, and the worker prompt is ordered
  so the model's cache hits. Claude Code's built-in `Explore` agent runs on
  `haiku` too, instead of the session's own model.
- **The fixed prefix is smaller.** Every turn re-reads the system prompt, the
  tools and the instruction files, so the launch trims them (see
  [the launch prefix](#the-launch-prefix)).

The setting is per project, **on by default**, and an administrator of the
project can switch it off under **Settings › Token saver**. Off launches every
agent exactly as it was launched before the feature.

## Techniques under test

Card and CI-fix rounds carry one flag per saving technique, drawn per card
and kept for all its rounds ([#746](https://github.com/AndreyBegma/Nautelle/issues/746),
[ADR-0074](../adr/0074-a-token-saving-is-judged-by-billed-cost-per-successful-card.md)).
An administrator tests each one on a share of the cards, then enables it for
all or stops it, under **Settings › Token saver**. These come from
[#747](../specs/747-cut-large-mcp-grep-and-webfetch-results.md):

| Flag | On | Off |
|---|---|---|
| `mcp-cut` | An MCP result over 16,000 characters keeps its first 6,000 and last 2,000; the middle becomes a marker naming the file with the full text. Images in the result are kept. The runner's own `nautelle` server is never cut. | The result reaches the agent whole. |
| `grep-cut` | The same cut on a `Grep` result. | Whole. |
| `webfetch-cut` | The same cut on a `WebFetch` result. | Whole. |
| `read-guard-400` | A whole read over 400 lines (or 64 KB) is refused once, with an outline of the file: Markdown headings, or a code file's top-level declarations. | The 1,500-line guard, no outline. |
| `terse-register` | The worker prompt's terse working register. | The earlier two-register lines: terse for what only the worker reads, full sentences for what a person reads. |

The cut marker reads
`[… Nautelle token saver: <cut> of <total> characters cut from the middle. Full output: <path> — Read it with offset/limit or Grep it for the part you need …]`.
The full text is under the run's `raw/` directory, like a filtered command's
([reading the raw output](#reading-the-raw-output)). Each cut writes a
`tool/mcp-cut`, `tool/grep-cut` or `tool/webfetch-cut` row to
[the savings](#where-the-savings-show).

A launch without flags (an older API, a planner, design or assistant launch)
behaves as before: no cuts, the 1,500-line guard and the terse register. Only
`terse-register` changes the prompt, so cards of one arm share a cached
prefix; the other flags explain themselves in the tool output.

Internally, the runner passes the flags that are on to its hooks as
`NAUTELLE_TECHNIQUES=<comma-separated keys>`, and runs the `tool-hook`
subcommand only after the tools whose cut is on.

## The launch prefix

[#663](https://github.com/AndreyBegma/Nautelle/issues/663),
[ADR-0068](../adr/0068-the-token-saver-targets-context-residency-and-is-judged-by-cost-per-round.md).
Cache reads are almost all of what a session spends, and the fixed prefix is
re-read on every turn. The runner sets these on each launch; every name was
checked against Claude Code 2.1.303 (`apps/runner/src/launch/token-saver.ts`).

| What | How | Launches |
|---|---|---|
| Compact at 150k | `CLAUDE_CODE_AUTO_COMPACT_WINDOW=183000` (the window less Claude Code's output reserve and summary buffer is 150k); `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=100` neutralises a percentage a profile carries | all |
| No built-in commit and pull request instructions | `includeGitInstructions: false` in the launch settings | all |
| Shorter skill listing | `skillListingMaxDescChars: 200` in the launch settings | all |
| `Explore` on `haiku` | an `Explore` entry in `--agents`, which replaces the built-in of that name | all with tools |
| One-hour prompt cache | `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` | card and CI-fix rounds |
| Prefix shared across rounds and runners | `--exclude-dynamic-system-prompt-sections` (cwd, env, memory paths and git status move to the first message) | card and CI-fix rounds |

Two levers are deliberately not set:

- **Deferred MCP tools.** Claude Code already defers them when
  `ENABLE_TOOL_SEARCH` is unset and the host is Anthropic's own. An explicit
  value would also force deferral through a proxy that may not support it.
- **`disableBundledSkills`.** Measured, it made the prefix about 4k tokens
  larger.

The effect is measured, not assumed: a wrongly named flag does nothing
silently. `apps/runner/src/launch/fixtures/first-turn.json` records a first
turn with these settings (about 23k tokens, against about 28.5k without them),
and a test holds it to the 25k target and to the settings it was recorded
with. Re-record it when the settings, the launch agents or the Claude Code
version change.

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

- the session runs in `bypassPermissions`, in `auto` (Board card sessions do)
  or in `plan` (planner and design runs do). In `auto` and `plan` the hook
  makes no decision, and Claude Code's own rules still judge the wrapped
  command; **and**
- no `deny` or `ask` rule matches it; **and**
- the call is made of simple commands joined by `|`, `&&`, `||` or `;` — no
  redirect other than `2>&1`, no subshell, heredoc or substitution — and is
  not in the background. In a pipeline only the first command is filtered
  (`bun run test 2>&1 | tail -50` filters `bun run test`, and `tail` reads the
  filtered output); in a list each covered command is filtered on its own. A
  dev server or a watch mode runs as written.

In any other session the command runs unfiltered, and the dashboard counts it
as "returned the original". When no filter matched, the dashboard and the card
sheet say why:

| Label | Means |
|---|---|
| Compound command (not filtered) | a redirect, a subshell, a heredoc, a substitution or a background `&` — something other than simple commands joined by `\|`, `&&`, `\|\|` or `;` |
| No filter for this command | no filter family covers the first command of any of its pipelines |
| Not filtered in this permission mode | the session's mode is not `bypassPermissions`, `auto` or `plan` |
| No filter (uncovered command) | recorded before the reasons above existed |

The exact rules are in
[the filter guide](token-saver-filter.md#permissions-the-rewrite-never-changes-what-is-allowed).

## Reading the raw output

Every filtered command's **complete** output is kept, byte for byte, in the
run's directory: `<run dir>/raw/<n>.log`. The path is in the footer the agent
sees, and an agent can read it when it needs a hidden line. The file is on the
runner's machine; the control plane never reads it (ADR-0001).

## Bypass: `NAUTELLE_RAW=1`

To run one command with no filtering, put the variable in front of it:

```sh
NAUTELLE_RAW=1 bun run test
```

The worker prompt tells agents about it. You can use it too when you drive a
session by hand, or tell an agent: *"re-run that with `NAUTELLE_RAW=1`"*. A
bypassed command is counted, so a high **bypass rate** on the dashboard means
the filter is getting in the way.

## The MCP allowlist

Under **Settings › Token saver** the list **MCP servers agents load** has one
checkbox per server the runner reports for the project's profiles.

- `nautelle` is always loaded and is not in the list.
- An **empty list means `nautelle` only**. Every unticked server is not loaded
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
