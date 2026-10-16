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
   - the command is a **single simple command**: `[NAME=value …] program args…`.
     It must have no `|`, `&&`, `||`, `;`, `&`, redirect, heredoc, subshell,
     `$(…)`, backticks or compound keyword;
   - the call is not `run_in_background: true`;
   - a filter in the registry matches the program;
   - the command is not a dev server or a watch mode. These count as one:
     `--watch`, `--watchAll`, `--hot` and `--serve`; `npm|pnpm|yarn|bun run dev|start|serve|watch|preview`;
     and anything the filter's own `longRunning` reports;
   - the rewrite changes nothing about the session's permissions (next section).

   Every other Bash call is left as written. It is counted `passedThrough` with
   0 bytes, because the hook never sees its output.
3. `filter -- <argv…>` runs the command, keeps its raw output, and prints either
   the compressed output or the original.

The hook **fails open**: on any error it prints nothing and exits 0. Claude Code
reads that as "no decision", so the command runs as written. Without the launch's
`AGENTDOCK_FILTER_*` env, the hook does nothing. That is the case when Token
saver is off.

## Permissions: the rewrite never changes what is allowed

Claude Code matches its permission rules against the command a hook *returns*.
A rewritten `agentdock-runner filter -- git push` would therefore slip past
`Bash(git push:*)`, and an allow rule such as `Bash(bun run test:*)` would stop
matching. This amends spec #445, settled by the orchestrator: the hook
(`permissionFor` in `filter/permissions.ts`) applies these rules in order.

| Situation | Result |
|---|---|
| A `deny` or `ask` `Bash(…)` rule matches the **original** command, or the command without its leading `NAME=value` words | no rewrite (`passedThrough`) |
| The session is `bypassPermissions`, or an `allow` rule already matches the original command | rewrite, with `permissionDecision: "allow"` |
| Anything else | no rewrite |
| A settings file that exists but does not parse, or a `Bash(…)` rule this parser does not understand | no rewrite |

Deny and ask rules are matched generously. A prefix rule matches without a word
boundary, an exact rule also matches longer commands, and `Bash(x *)` also
matches a bare `x`. Allow rules are matched strictly. Every mismatch therefore
leaves the command alone.

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
- **Bypass.** With `AGENTDOCK_RAW=1 <cmd>`, the output streams through unchanged
  and the command is counted `bypassed`.
- **Big outputs.** Output over 10 MB is not filtered. Whatever arrived so far is
  printed and the rest streams through.
- **Without the launch env** (no `AGENTDOCK_FILTER_STATS`), the filter runs the
  command and prints its output. It writes no raw file and no stats.

## The environment a launch sets

`filter/env.ts` exports the names. A launch spreads
`filterEnv({ runDir, projectId, runId, runKind })` into the session's env.

| Variable | Value |
|---|---|
| `AGENTDOCK_FILTER_STATS` | `<run dir>/filter-stats.jsonl`. Its directory is also where `raw/` goes |
| `AGENTDOCK_FILTER_PROJECT` | the project id |
| `AGENTDOCK_FILTER_RUN` | the run id; unset for the orchestrator session |
| `AGENTDOCK_FILTER_RUN_KIND` | a `TokenSaverRunKind` |
| `AGENTDOCK_LAUNCH_SETTINGS` | the `--settings` file the launch passed |

The orchestrator session has no run dir. It uses
`orchestratorFilterDir(<state>/agentdock, repo)`, which is
`<state>/agentdock/orchestrator/<owner>__<name>/`.

## Stats

Each command appends one JSONL line, `{ "projectId", "row" }`, to
`$AGENTDOCK_FILTER_STATS`. `row` is a `FilterStatRow`. The daemon
(`FilterStatsReader`) scans the executors' base dirs and the orchestrator dir
every 5 s, at most two levels deep. It reads complete lines from the offset kept
in `filter-stats.offset` beside each file, and sends `filter.stats` events of at
most 200 rows per project through the events spool. A malformed row, or one for
a project the runner no longer watches, is skipped. A resend after a crash is
harmless, because the API skips row ids it already has.

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
