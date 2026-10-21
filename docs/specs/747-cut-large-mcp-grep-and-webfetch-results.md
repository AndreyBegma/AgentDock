# Runner savers: cut large MCP, Grep and WebFetch results, a 400-line read guard with an outline, and an A/B-gated terse register

Issue: #747 · Epic: [#745](745-token-economy.md) · Lead: #746 (measurement and A/B flags) · ADR: [ADR-0074](../adr/0074-a-token-saving-is-judged-by-billed-cost-per-successful-card.md) §7

## Summary

Card runs launch with `CS_ECO=off` since #616 (`apps/runner/src/launch/token-saver.ts:376`) [Confirmed]. That turns off the plugin's `/cs-eco` hooks, and with them two savers the runner never took over:
- the cut of large MCP results to head and tail (`claude-code-plugin` `hooks/eco_hook.py:321-380`);
- the 400-line read guard with a file outline (`eco_hook.py:186-242`, `eco_lib.py:29-30`).

The runner's own guard refuses a whole read only over 64 KB or 1,500 lines, and its message has no outline (`apps/runner/src/filter/read-guard.ts:36-38`, `:173`) [Confirmed]. The runner has no PostToolUse hook on MCP, Grep or WebFetch (`filterHookSettings`, `token-saver.ts:230-255`) [Confirmed].

This issue brings these savers into the runner. Each one sits behind its own A/B technique flag from #746:
- a PostToolUse cut of MCP, Grep and WebFetch results over 16,000 characters to head and tail. The full text is saved under the run dir, its path is shown, and a `filter.stats` row is written;
- the read guard at 400 lines, with an outline of the file;
- the terse working register. It is already in the card prompt, unconditionally, since #663 (ADR-0068 D2-D3). This issue only puts it behind its flag.

The static prompt prefix must stay byte-identical across cards of the same arm. The cut and the guard therefore explain themselves in their own tool output and add no prompt lines.

## Scope

### In
- Card and CI-fix rounds (`runKind: 'card'`), the only launches that receive technique flags from #746 (person, 2026-10-21, Q-scope).
- A new `nautelle-runner tool-hook` subcommand for PostToolUse on `mcp__.*`, `Grep` and `WebFetch`.
- The `read-hook` threshold and outline under `read_guard_400`.
- The worker prompt's register under `terse_register`, and the API passing that arm into the prompt.
- Technique flags carried from `tokenSaver.techniques` to the hooks through one launch env variable.

### Out
- Planner, spec, assess, design and other launch kinds. They receive no technique flags, so they behave exactly as today.
- `/cs-eco` sessions and the plugin repository. That is issue #748, and the plugin already has these savers.
- The A/B assignment, the per-arm metrics and the dashboard (#746).
- Changing the Bash filter or the Bash read refusal (#663).
- Rounds and sessions (#749).

## Decisions

| # | Decision | Source |
|---|---|---|
| D1 | Bring into the runner: the MCP result cut (>16,000 chars → head + tail, full text saved, path shown); Grep and WebFetch capped the same way; the read guard at 400 lines with a file outline; a terse working register in the stable prompt prefix. Each sits behind its own A/B flag | person, 2026-10-21 (Q-runner-savers) |
| D2 | Technique keys: `mcp_cut`, `grep_cut`, `webfetch_cut`, `read_guard_400`, `terse_register`. They arrive per card, sticky across rounds, in the launch command's `tokenSaver.techniques: { <key>: boolean }` | #746; person, 2026-10-21 (Q-proof) |
| D3 | **A key that is absent means behaviour as before this issue**: no cuts, a 1,500-line guard with no outline, and the terse register on (today's unconditional #663 text). So a launch without the payload (an older API, a non-card launch) is unchanged | spec (compatibility) |
| D4 | The runner passes the flags to its hooks as `NAUTELLE_TECHNIQUES=<comma-separated keys that are on>`. The parser is import-free in `apps/runner/src/filter/env.ts`, mirroring `switchedOffFamilies` (#663 D9). The PostToolUse matcher is built only from the techniques that are on, so an arm that is off spawns no process | spec |
| D5 | **Cut mechanics, ported from the plugin.** The threshold is 16,000 characters; the hook keeps the first 6,000 and the last 2,000. The middle becomes a marker: `[… Nautelle token saver: <cut> of <total> characters cut from the middle. Full output: <path> — Read it with offset/limit or Grep it for the part you need …]`. The full text goes to `<run dir>/raw/<n>.log` through the existing `RawFile` (10 MB file cap, 200 MB dir cap, `apps/runner/src/filter/raw-store.ts`). Non-text MCP blocks such as images are kept (plugin `_reshape`) | person (16,000); plugin `eco_hook.py:321-380` |
| D6 | **How the result is replaced.** MCP results use `hookSpecificOutput.updatedMCPToolOutput`, in the tool's own shape, as the plugin does. Grep and WebFetch use `hookSpecificOutput.updatedToolOutput`, which is the same object as `tool_response` with only its text field cut. [Confirmed] Claude Code 2.1.306 accepts both. `updatedToolOutput` is described as "Replaces the tool output before it is sent to the model … works for all tools". The hook's object is validated against the tool's `outputSchema`; on a mismatch Claude Code keeps the original output and adds a `hook_error_during_execution` message (strings in the installed binary). [Unknown] The exact `tool_response` fields of Grep (per `output_mode`) and of WebFetch; slot i747-cut records them as fixtures | spec; installed CLI |
| D7 | The runner's own MCP server (`nautelle`, and `agentdock` before the rename; `isRunnerMcpServer`) is never cut. Its replies are instructions such as `finish_card` guards | spec |
| D8 | Stats rows: `tool/mcp-cut`, `tool/grep-cut` and `tool/webfetch-cut`. `rawBytes` is the UTF-8 size of the full text, and `keptBytes` the size of the replacement. [Confirmed] The ids pass `filterIdSchema` (`packages/shared/src/token-saver/contracts.ts`). The `tool` family switch in `NAUTELLE_FILTER_OFF` does not govern these cuts; the technique flag does | spec |
| D9 | **Read guard under `read_guard_400`.** Lines over 400, or bytes over 64 KB as today. The message adds the plugin's outline, ported as is: Markdown headings outside code fences for `.md/.mdx/.markdown/.rst`; for code, unindented lines starting with the plugin's declaration prefixes; each entry `<line>: <text>` cut to 120 characters; at most 40 entries, sampled evenly, plus `(N more, sampled)`; or `No outline (no headings or top-level declarations found).` The size reads "at least" when the file is over the 8 MB scan. Dedup, the one-retry bypass and the stats ids are unchanged. Off: today's 1,500 lines, no outline | person; plugin `eco_hook.py:186-242` |
| D10 | **The terse register exists.** `TERSE_REGISTER_LINES` (`packages/shared/src/token-saver/register.ts:26`) is in every card prompt (`packages/shared/src/board/worker-prompt.ts:431,496`), from #663 [Confirmed]. Under `terse_register`: on, it stays as is (one source, ADR-0068 D3). Off, the prompt carries the #445 D7 two-register lines that #663 replaced, so the control arm still has the audience-prose rule of ADR-0039 §4 | person (A/B per technique); ADR-0068 |
| D11 | **Prefix stability.** Only `terse_register` changes prompt bytes. For each value of it, the static prefix of two different cards is byte-identical. The other four techniques change no prompt byte: their outputs explain themselves | #626 (C-254); spec |

## Data / Schema

None. `tokenSaver.techniques` and the technique registry belong to #746. i747-launch adds the five keys of D2 to that registry (`packages/shared/src/token-economy/techniques.ts`), each with default mode `ab` (ADR-0074 §2, §7: a project tests each technique on its B share until an admin presses Enable for all or Stop). For `terse_register`, which every card has today, that means arm A cards get the control text while the test runs; this is the cost ADR-0074 accepts.

## API

- No new endpoint and no new command. `card.run`'s `tokenSaver` gains `techniques` in #746.
- `apps/api/src/board/board-rounds.service.ts:610` passes the card's `terse_register` arm, from #746's arm lookup, into `cardWorkerPrompt` as `terseRegister`. An absent arm leaves the field out, which means on (D3). [Confirmed] Today this call passes no `tokenSaver` at all, so card workers never get `TOKEN_SAVER_LINES` or `HANDOFF_LINES`. See Open questions.

## Configuration

- New runner launch env: `NAUTELLE_TECHNIQUES`. It is set by `tokenSaverLaunch` from `config.techniques` and read only by the `read-hook` and `tool-hook` subcommands. It is internal to the runner, so it does not go in `.env.example`.
- Runner constants: `TOOL_CUT_MAX_CHARS = 16_000`, `TOOL_CUT_HEAD_CHARS = 6_000`, `TOOL_CUT_TAIL_CHARS = 2_000`, `READ_GUARD_LINES_TIGHT = 400`, `OUTLINE_MAX = 40`.
- No project setting. The B share and the arms are #746's.

## Acceptance criteria

- [ ] **Launch:**
  - with `techniques` absent, the launch settings and env are byte-identical to today (snapshot test in `token-saver.spec.ts`);
  - with `mcp_cut`, `grep_cut` and `webfetch_cut` on, a PostToolUse entry with matcher `mcp__.*|Grep|WebFetch` runs `tool-hook`, and `NAUTELLE_TECHNIQUES` lists exactly the keys that are on;
  - a key that is off is not in the matcher.
- [ ] **MCP cut:**
  - a 40,000-character MCP text result becomes 6,000 + marker + 2,000 characters, and the marker names an existing `<run dir>/raw/<n>.log` that holds the full text;
  - an image block in the same result is kept;
  - one `tool/mcp-cut` row is written with `rawBytes` greater than `keptBytes`, and `filterStatRowSchema` accepts it;
  - results at or under 16,000 characters, and results from the runner's own MCP server, are untouched.
- [ ] **Grep and WebFetch:**
  - with fixtures of real `tool_response` objects recorded from Claude Code 2.1.306, the hook returns `updatedToolOutput` that passes the same shape and differs only in the cut text field;
  - a shape the hook does not recognise gets no output;
  - an e2e on the installed CLI shows the model receiving the cut text with no `hook_error_during_execution`.
- [ ] **Read guard:**
  - with `read_guard_400` on, a whole read of a 401-line file is refused once with the outline and the immediate repeat runs;
  - a 400-line file is read;
  - the outline matches the plugin's on shared fixtures (Markdown with a fenced `#` line, a TypeScript file, a file with more than 40 declarations sampled, a file with none);
  - with the flag off, the 1,500-line behaviour and message are unchanged.
- [ ] **Register:**
  - with `terseRegister` absent or true, the round-1 prompt contains `TERSE_REGISTER_LINES`; with false, it contains the #445 D7 lines and not the terse ones;
  - for each value, the static prefix of two different cards is byte-identical (`packages/shared/src/board/prompt-budget.spec.ts`), within the existing budget;
  - `CARD_WORKER_PROMPT_VERSION` is bumped.
- [ ] **Fail open:** malformed hook input, an unwritable raw dir or any thrown error prints nothing and exits 0, so the original output reaches the model.
- [ ] **Hot path:** `tool-hook` is served from `main.ts` without loading the daemon, like `read-hook`, and `cli.ts` lists it.
- [ ] `docs/guides/token-saver.md` describes the three cuts, the 400-line guard and the flags. `docs/specs/616-guard-whole-reads-and-repeated-reads-in.md` and `docs/specs/663-token-saver-v2.md` get an amendment line pointing to this spec.

## Parallel plan

Two waves:
1. i747-launch.
2. i747-cut and i747-guard, in parallel.

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i747-launch | technique env and parser, hook wiring and matcher, the `tool-hook` dispatch (calls `runToolHook` from `filter/tool-cut.ts`, created as a fail-open stub), register flag in the prompt and the API call, prefix tests, docs | apps/runner/src/launch/token-saver.ts, apps/runner/src/launch/token-saver.spec.ts, apps/runner/src/filter/env.ts, apps/runner/src/filter/env.spec.ts, apps/runner/src/filter/main.ts, apps/runner/src/main.ts, apps/runner/src/cli.ts, apps/runner/src/cli.spec.ts, apps/runner/src/filter/tool-cut.ts (stub only), packages/shared/src/token-economy/techniques.ts, packages/shared/src/board/worker-prompt.ts, packages/shared/src/board/worker-prompt.spec.ts, packages/shared/src/board/prompt-budget.spec.ts, apps/api/src/board/board-rounds.service.ts, docs/guides/token-saver.md, docs/specs/616-guard-whole-reads-and-repeated-reads-in.md, docs/specs/663-token-saver-v2.md | #746 merged (`tokenSaver.techniques`, arm lookup in the API) | yes | opus |
| i747-cut | `tool-hook` body: MCP, Grep and WebFetch cut, raw file, stats rows, recorded `tool_response` fixtures, e2e on the installed CLI | apps/runner/src/filter/tool-cut.ts, apps/runner/src/filter/tool-cut.spec.ts, apps/runner/src/filter/fixtures/tool-response/** | i747-launch | no | opus |
| i747-guard | 400-line threshold and outline port | apps/runner/src/filter/read-guard.ts, apps/runner/src/filter/read-guard.spec.ts, apps/runner/src/filter/outline.ts, apps/runner/src/filter/outline.spec.ts, apps/runner/src/filter/fixtures/outline/** | i747-launch | no | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/runner/src/launch/token-saver.ts | i747-launch; then #749 i749-ttl, then #751 i751-runner | do not open it |
| apps/runner/src/filter/tool-cut.ts | i747-launch creates the fail-open stub; then i747-cut owns it | i747-cut starts only after i747-launch merges |
| packages/shared/src/board/worker-prompt.ts | i747-launch | #750 i750-runner-web edits it later in the chain and bumps the version again |
| apps/runner/src/filter/env.ts | i747-launch | read `techniqueOn` / `techniquesFrom` only |
| apps/api/src/board/board-rounds.service.ts | #746 first, then i747-launch; then #750, #751 | do not open it |
| packages/shared/src/token-saver/contracts.ts (technique keys) | #746 | do not open it |
| docs/specs/663-token-saver-v2.md | i747-launch; then #749 i749-ttl | append amendment lines only |

## Risks

- **High: a cut or a guard hides what the agent needed, so it re-reads or re-runs and the arm costs more.** Mitigations:
  - the marker names the full-output file and how to read it;
  - #746 counts re-reads after a refusal or cut as retries, per arm;
  - a technique that worsens any quality signal is rolled back (person, Q-quality).
- **Medium: a wrong `updatedToolOutput` shape adds a hook error to the context on every Grep or WebFetch call.** Mitigations:
  - the hook rewrites only shapes recorded from the installed CLI and is silent otherwise;
  - the e2e checks that no hook error reaches the model.
- **Medium: a Claude Code older than 2.1.306 does not know `updatedToolOutput`.** [Unknown] which version added it, and whether an older version rejects the unknown field. Mitigations:
  - i747-cut checks the runner's detected Claude Code version (`apps/runner/src/detect/`);
  - below the verified version, `grep_cut` and `webfetch_cut` are treated as off;
  - the MCP cut keeps the plugin's proven `updatedMCPToolOutput`.
- **Medium: arms split the cross-card prompt cache.** Mitigation: only `terse_register` changes prompt bytes, so there are two prefixes, not 32.
- **Low: raw files pruned or removed with the run dir before the agent reads them.** Mitigation: the 200 MB cap prunes oldest-first. The path is valid for the round that produced it.
- **Low: hook latency on every MCP, Grep or WebFetch call.** Mitigation: the hot-path dispatch, as for `read-hook`, and the matcher only for techniques that are on.

## Open questions

- **The card prompt never gets `tokenSaver: true`.** [Confirmed] `board-rounds.service.ts:610-654` calls `cardWorkerPrompt` without it, and `saver` is computed afterwards (`:663`). So the scout, `NAUTELLE_RAW`, one-command and handoff-note lines (#445, #449) never reach card workers, and #749's fresh restart depends on the note. Default: i747-launch passes `tokenSaver: saver.on` in the same edit, with a test; recorded as a bug fix in the PR.
- **Grep `files_with_matches` and `count` modes over 16,000 characters.** Default: cut the list to the first and last entries that fit, with a marker entry, only if the recorded schema accepts it; otherwise leave it uncut.
- **The `terse_register` control text.** Default: the #445 D7 two-register lines (git history of `worker-prompt.ts` before #663), not an empty section.
- **Whether this needs its own ADR.** Default: no. #746's ADR-0074 records that every token-saver technique is A/B-gated; this spec amends #616's threshold and ADR-0068 D2 under that.
- **The byte threshold under `read_guard_400`.** Default: keep 64 KB next to 400 lines. The plugin has lines only, but the runner guards minified single-line files by bytes.

Depends on #746
