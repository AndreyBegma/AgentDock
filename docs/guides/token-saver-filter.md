# The command-output filter (Token saver)

Token saver (#445, [ADR-0039](../adr/0039-token-saver.md),
[spec](../specs/445-token-saver.md)) shortens the command output agents read.
It never changes what people read. This guide covers the runner's filter
engine in `apps/runner/src/filter/`. It explains how a Bash call reaches the
filter, what the engine guarantees, and how to add a filter for a command
family. The user-facing guide is `docs/guides/token-saver.md`, which explains
the bypass, the raw files and the MCP allowlist.

## How a Bash call reaches the filter

1. A launch with Token saver on registers `agentdock-runner filter-hook` as a
   Claude Code `PreToolUse` hook for `Bash`. It also adds `filterEnv(…)` to the
   session's environment (`filter/env.ts`).
2. The hook reads Claude Code's PreToolUse JSON. It rewrites `tool_input.command`
   to `<runner> filter -- <command>` only when **all** of these hold:
   - the session's `permission_mode` is `bypassPermissions` (spec amendment 9)
     or `auto` (amendment 10);
   - the command is a **single simple command**: `[NAME=value …] program args…`,
     optionally in one of two forms around it (amendment 11):
     - after `cd <path> &&`, with exactly one literal path word, quoted or not,
       not empty and not starting with `-`;
     - followed by `2>&1`, as the very last token, after an unquoted blank.

     `filter/shell.ts` (`parseHookCommand`) is a whitelist, not a shell.
     Anything it does not understand exactly makes the command not simple:
     - an unquoted `|`, `&`, `;`, `<`, `>`, `(` or `)` other than the two forms
       above: lists, pipes, redirects, heredocs, subshells, process
       substitution. `cd x && y && z`, `cd x; y`, `cd x && y | z`, `cd a b && y`,
       `cd -- x && y`, `y 2>&1 >f`, `y 2>&3`, `y &>f` and `y 1>&2` all pass
       through;
     - `$`, a backtick, `#` or `!` anywhere, quoted or not. That covers every
       expansion and substitution, `$'…'` and `$"…"` quoting, comments and
       history expansion;
     - an unquoted `*`, `?`, `[`, `]`, `{`, `}` or `~`: globs, braces, tilde;
     - a newline, a carriage return, any other control character or any
       non-ASCII character, lookalikes included;
     - a quoted program name, a quoted `NAME=` (it is not an assignment), and
       the words `exec`, `eval`, `source`, `.`, `command`, `builtin`, `env`,
       `sudo`, `nohup`, `xargs` and the compound keywords as the program;
   - the call is not `run_in_background: true`;
   - a filter in the registry matches the program;
   - the command is not a dev server or a watch mode. These count as one:
     `--watch`, `--watchAll`, `--hot` and `--serve`; `npm|pnpm|yarn|bun run dev|start|serve|watch|preview`;
     and anything the filter's own `longRunning` reports;
   - the rewrite changes nothing about the session's permissions (next section).

   Every other Bash call is left as written. It is counted `passedThrough` with
   0 bytes, because the hook never sees its output.
3. The rewrite is built from the parsed words, each re-quoted
   (`wrappedCommand` in `filter/hook.ts`), never from the original text. Bash
   therefore runs exactly the argv the parser saw. `shell.spec.ts` checks this
   against a real `bash`, for the original and for the rewrite. A `cd` target
   is re-quoted the same way and kept in front:
   `cd '/a b' && CI=1 <runner> filter -- bun test 2>&1`. A trailing `2>&1` is
   kept, written by the hook as a constant. When the filter does not compress
   (the bypass, output past the buffer, no filter), it forwards the child's
   stdout and stderr separately, so keeping the redirect gives the wrapped
   command the file descriptors the original had. `shell.spec.ts` also checks
   in `bash` that the original and the rewrite run in the same directory and
   send stderr to the same place.
4. `filter -- <argv…>` runs the command, keeps its raw output, and prints either
   the compressed output or the original.

The hook **fails open**: on any error it prints nothing and exits 0. Claude Code
reads that as "no decision", so the command runs as written. Without the launch's
`AGENTDOCK_FILTER_*` env, the hook does nothing. That is the case when Token
saver is off.

## Permissions: the rewrite never changes what is allowed

Claude Code matches its permission rules against the command a hook *returns*.
A rewritten `agentdock-runner filter -- git push` would therefore slip past
`Bash(git push:*)`. The hook (`permissionFor` in `filter/permissions.ts`)
applies these rules in order (spec #445 amendments 9, 10 and 11):

| Situation | Result |
|---|---|
| The session is neither `bypassPermissions` nor `auto` (`default`, `acceptEdits`, `plan`, `dontAsk`, missing, …) | no rewrite, whatever the allow rules say |
| A `deny` or `ask` `Bash(…)` rule matches the command, at any word | no rewrite (`passedThrough`) |
| A settings file that exists but does not parse, or a `Bash(…)` rule this parser does not understand | no rewrite |
| Anything else, in `bypassPermissions` | rewrite, with `permissionDecision: "allow"` |
| Anything else, in `auto` | rewrite, with **no** `permissionDecision`: only `updatedInput` |

In auto mode the hook returns no decision, so Claude Code's own permission rules
and auto-mode classifier judge the wrapped `agentdock-runner filter -- <argv>`,
just as they would judge any other command. Nothing is approved by the hook. An
`allow` rule written for the original command does not match the wrapped form,
so for that call the classifier decides. This was verified on Claude Code
2.1.301: an `updatedInput` without a decision is applied in auto mode, and a
`deny` rule that matches only the rewritten command denies it.

In `default`, `acceptEdits` and `plan`, Claude Code decides through its prompt
or plan mode's read-only rule, and the hook leaves the command as written.

Deny and ask rules are matched generously. A prefix rule matches without a word
boundary, an exact rule also matches longer commands, and `Bash(x *)` also
matches a bare `x`. Each rule is tried against these texts, with runs of
whitespace collapsed to one space:

- the original command;
- the parsed words, with quotes removed;
- the same with the program's directory dropped (`/usr/bin/git` becomes `git`);
- the same with the leading `NAME=value` words;
- with a leading `cd <path> &&` (amendment 11), `cd <path> && <words>` with
  quotes removed. The parsed words above are the inner command's, so the rules
  meet the command behind the `cd`.

Each text is also tried from every word on, so the rule matches wherever the
command sits in the line. Every mismatch therefore leaves the command alone.
`git  push`, with two spaces, gets no rewrite under `Bash(git push:*)`.

The rules come from the files Claude Code loads:

- the managed settings (`/etc/claude-code/managed-settings.json`, or
  `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS);
- `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`);
- `<project>/.claude/settings.json` and `<project>/.claude/settings.local.json`,
  where `<project>` is `$CLAUDE_PROJECT_DIR`, or the hook's `cwd` when it is unset;
- the launch's own `--settings` file, named by `$AGENTDOCK_LAUNCH_SETTINGS`.

## What the engine guarantees (D4)

- **The exit code is the command's own.** A command killed by a signal exits
  `128 + n`, as in a shell. Signals sent to the filter are forwarded to the command.
- **Errors are never removed.** `filter/classify.ts` marks error, failure,
  warning and stack-frame lines. The rule is deliberately broad: a wrong guess
  only keeps a line that could have gone. After a filter returns, the engine
  checks every marked line of the original against the result (escapes ignored,
  duplicates counted once). The agent gets the original output, counted
  `passedThrough`, when any of these happens:
  - a marked line is missing;
  - the result is not shorter than the original, footer included;
  - the filter throws;
  - the filter returns `null`.
- **The raw output is kept.** Every filtered command's output goes to
  `<run dir>/raw/<n>.log`, byte for byte. Each command gets the next free `n`. A
  file is capped at 10 MB and ends with a truncation marker. The compressed output
  ends with:

  ```
  [agentdock filter: N lines hidden · full output: <path> · AGENTDOCK_RAW=1 to bypass]
  ```

  When the raw file was cut, the footer says `full output (first 10 MB, truncated)`.
- **Raw files are bounded and go with the run.** All raw files of one run dir
  stay under 200 MB together. Before a new file, the oldest `<n>.log` files are
  deleted until there is room for one more at its 10 MB cap. A card deletes its
  earlier rounds' `raw/` when a new round starts, and all of them with the card.
  Stopping the orchestrator deletes its session's `raw/`.
- **What the agent reads is redacted.** The compressed output goes through the
  pane redactor (`pane/redact.ts`): GitHub, OpenAI, Slack and AWS token shapes,
  and private-key blocks. The raw file keeps every byte. The fuller hook-content
  redactor (`local/redact.ts`) is not used here, because it loads the protocol
  schemas, which costs about 140 ms per command.
- **Bypass.** With `AGENTDOCK_RAW=1 <cmd>`, the output streams through unchanged
  and the command is counted `bypassed`.
- **Big outputs.** Output over 10 MB is not filtered. Whatever arrived so far is
  printed and the rest streams through.
- **Without the launch env** (no `AGENTDOCK_FILTER_STATS`), the filter runs the
  command and prints its output. It writes no raw file and no stats.

## The environment a launch sets

`filter/env.ts` is the only source of the names. `tokenSaverLaunch`
(`launch/token-saver.ts`) spreads `filterEnv({ runDir, projectId, runId, runKind })`
into the session's env. It also writes `<run dir>/filter-run.json`,
`{ projectId, runId, runKind }` at mode 0600: the run dir's identity, for the
stats reader.

| Variable | Value |
|---|---|
| `AGENTDOCK_FILTER_STATS` | `<run dir>/filter-stats.jsonl`. Its directory is also where `raw/` goes |
| `AGENTDOCK_FILTER_PROJECT` | the project id |
| `AGENTDOCK_FILTER_RUN` | the run id; unset for the orchestrator session |
| `AGENTDOCK_FILTER_RUN_KIND` | a `TokenSaverRunKind` |
| `AGENTDOCK_LAUNCH_SETTINGS` | the `--settings` file the launch passed |

The orchestrator session has no run dir. It uses a directory of its own,
`<state>/agentdock/orchestrator/<session>/`.

## Stats

Each command appends one JSONL line, `{ "projectId", "row" }`, to
`$AGENTDOCK_FILTER_STATS`. `row` is a `FilterStatRow`. The daemon
(`FilterStatsReader`) scans the executors' base dirs and the orchestrator dir
every 5 s, at most three levels deep (a card's round is
`<cards>/<card>/rounds/<run>`). It reads complete lines from the offset kept
in `filter-stats.offset` beside each file, and sends `filter.stats` events of at
most 200 rows through the events spool.

The project and run come from the run dir's `filter-run.json`, never from the
row. A row whose `projectId`, `runId` or `runKind` differs from that identity is
counted as rejected and never sent, so a session cannot report rows for another
project or run. A stats file without a valid identity is not read. A malformed
row, or one for a project the runner no longer watches, is skipped. A resend
after a crash is harmless, because the API skips row ids it already has.

### Manual sessions (`/cs-eco`, #475)

The code-sentinel plugin's `/cs-eco` runs `agentdock-runner filter-hook` in
sessions the runner did not launch: manual terminals, the orchestrator's own
session and fleet workers. It keeps one directory per Claude session,
`${XDG_STATE_HOME:-~/.local/state}/cs-eco/sessions/<session id>/`, and appends
rows in the same `{ "projectId", "row" }` shape to its `filter-stats.jsonl`.
The daemon reads these files in the same pass (`filter/eco.ts`):

- **The project comes from a watched root, never from the row** (DA-04/DR-05).
  The session's cwd is taken from the plugin hooks' `SessionStart` when the
  daemon saw it, else from the session's Claude Code transcript,
  `<CLAUDE_CONFIG_DIR>/projects/*/<session id>.jsonl`, in `~/.claude` and every
  Claude profile. The cwd is matched to a project like a transcript's
  (`correlateCwd`): the deepest watched root holding it, or a fleet worktree
  `.wt-<repo>-<slot>` beside it.
- A session whose cwd is outside every watched root, or not known yet, is not
  read and nothing of it is sent. Its offset stays where it was.
- A row is sent only when its `projectId` names that project — the project's
  id, its `owner/name` or its root's directory name, in any case — and its
  `runId` is `null` or the session's id. Any other row is counted as rejected.
- Rows go out as `runKind: manual` with `runId: null`, whatever kind the row
  carries; the dashboard shows them as **Manual session**.

## Adding a filter

A family slot edits only `filter/families/<family>/`. The registry
(`families/index.ts`) already lists `js`, `ops` and `lang`.

```ts
import type { Filter } from '../../types';

export const jestFilter: Filter = {
  id: 'js/jest',                       // <family>/<command>, lower case
  matches: (argv) => argv[0] === 'jest' || (argv[0] === 'npx' && argv[1] === 'jest'),
  longRunning: (argv) => argv.includes('--watch'),
  apply: ({ argv, output, exitCode }) => {
    // Return the compressed text, or null when this output is not recognised.
  },
};
```

- `argv[0]` is the bare program name, without its directory. `output` is
  stdout and stderr interleaved in arrival order.
- Keep summaries and every marked line. The engine overrules a filter that
  drops one.
- Return `null` rather than guess.

### The corpus

Every filter comes with real outputs in `families/<family>/corpus/`, one pair per
case:

- `<case>.out` holds the output exactly as the command printed it.
- `<case>.json` holds the metadata:

```json
{ "argv": ["bun", "test"], "exitCode": 1, "category": "test", "outcome": "failing", "expect": "filtered" }
```

`category` is `test`, `typecheck` or `other`. `corpus.spec.ts` runs every family's
cases through the same checks the engine applies, and asserts these:

- every marked line survives;
- each case with `expect: "filtered"` really is filtered;
- per family, the median kept/raw of `test` and `typecheck` cases is ≤ 0.3 for
  failing runs and ≤ 0.1 for passing ones.

## Overhead

Spec D3 sets a ceiling of p95 ≤ 50 ms added per command. `filter` and
`filter-hook` are served by `main.ts` before anything else is imported. The build
uses `bun build --compile --splitting --format=esm` (in `package.json` and in
`scripts/build-release.sh`), so the daemon's module graph is never parsed on this
path, and the binary is still one file.

Measured on a developer machine (Linux x64), median / p95 of 30 runs:

| Command | Before | After |
|---|---|---|
| `agentdock-runner version` (whole CLI) | 213 / 245 ms | 228 / 248 ms |
| `agentdock-runner filter -- true` | — | 21.9 / 25.9 ms |
| `agentdock-runner filter-hook` | — | 14.4 / 15.8 ms |

`filter/bench.spec.ts` runs in CI before the build. It measures the bun entry
(`bun src/main.ts filter -- true`) against `true` and fails above 50 ms at p95.
A sample over the ceiling is measured once more and the faster one counts, so a
CI host busy with another pipeline does not fail it; a real regression fails both.
