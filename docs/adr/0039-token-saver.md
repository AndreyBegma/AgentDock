# ADR-0039: Token saver — the runner compresses what agents read, not what people read

Status: accepted · Date: 2026-10-16 ·
Issue: [#445](https://github.com/AndreyBegma/AgentDock/issues/445) ·
Spec: [`docs/specs/445-token-saver.md`](../specs/445-token-saver.md)

## Context

Most of an agent's input tokens are re-reads of things nobody needs in full:
- full test logs where one test failed;
- verbose VCS output;
- tool schemas of MCP servers a task never calls;
- a history that grows for the whole round.

rtk (rtk-ai/rtk) shows the approach works: a PreToolUse hook rewrites Bash commands, and the output is filtered, grouped, truncated and deduplicated, for 60–90 % less command output. Its engine is BUSL-1.1, and AgentDock is self-hosted by others.

Only the card launch passes `--settings` and `--mcp-config` today. The other seven Claude launches of the runner inherit every MCP server of the profile.

## Decision

1. **The runner owns a command-output filter.** It ships as the `agentdock-runner filter` / `filter-hook` subcommands and uses no rtk code (ADR-0017: one binary). It covers as many command families as rtk does. Uncovered or unclassifiable output passes through unchanged.
2. **The filter never costs quality.**
   - The exit code is unchanged, and error, failure and warning lines are never removed.
   - The raw output is always kept in a file the compressed output points to.
   - `AGENTDOCK_RAW=1` bypasses the filter.
   - A regression corpus proves that every error line survives.
   - The hook fails open.
3. **Every runner launch goes through one wiring helper:**
   - the hook;
   - a haiku `scout` subagent for broad searches;
   - an earlier compaction threshold;
   - `--strict-mcp-config` with `agentdock` plus a per-project allowlist, taken from the launch profile's own config (ADR-0001, ADR-0006).
4. **Two registers for card workers.** Work is terse. Anything a person reads is written in full: questions, PR description, `finish_card` summary, specs, reply files, design. A guard on `finish_card` returns an incomplete artifact up to twice, then accepts it with a visible **Description incomplete** flag.
5. **A project setting, on by default.** Off means exactly today's launches.
6. **Savings are shown honestly:** the filter's estimate (labelled ≈) next to the measured cost per round before and after (ADR-0003, ADR-0009), on the card, on Usage and on a Token saver dashboard.
7. **The hook rewrites only where it cannot widen a decision.** In `bypassPermissions` it allows the wrapped command; in `auto` and `plan` it returns no decision, so Claude Code's own rules (and classifier) judge the wrapped command; in `default`, `acceptEdits` and `dontAsk` it never rewrites, because a person would see the wrapped command in a prompt (spec #445, amendments 9, 10 and 14).
8. **Fleet slots stay the plugin's (ADR-0005).** A follow-up in the plugin repository wires the same hook when the runner is installed.

## Consequences

- Every Bash call of every agent passes through the runner binary. The overhead ceiling is p95 ≤ 50 ms, measured in CI.
- A project that relied on a profile MCP server must allow it in the setting.
- A filter bug can hide information. The bypass, the raw files, the corpus and the dashboard's bypass and pass-through rates are the safety net.
