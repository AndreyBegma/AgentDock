# Token saver — compress what agents read, keep what people read

Issue: [#445](https://github.com/AndreyBegma/AgentDock/issues/445) · Decision: [ADR-0039](../adr/0039-token-saver.md)

## Summary

Agents spend most of their input tokens re-reading things nobody needs in full:
whole test logs where one test failed, `git log` with every trailer, the tool
schemas of MCP servers the task never calls, and a history that grows until the
end of the round. Token saver cuts that on every Claude launch of the runner
without touching the quality of what people get. Questions to the person, specs,
PR descriptions, `finish_card` summaries and design output stay complete and
readable. The result shows up as money on the card, on Usage and on a Token saver
dashboard.

The parts:
- an own command-output filter in the runner, using rtk's ideas but no rtk code;
- a strict MCP list per project;
- two registers in the worker prompt, with an artifact guard;
- a haiku scout for broad searches;
- earlier compaction and a stable prompt prefix.

## Scope

### In scope
- Every Claude launch the runner makes:
  - card workers (`apps/runner/src/cards/launch.ts`);
  - skills (`skills/run/launch.ts`);
  - planner (`planner/launch.ts`);
  - assess (`assess/executor.ts`);
  - capture (`capture/executor.ts`);
  - design (`uiprofile/executor.ts`);
  - normalize (`normalize/executor.ts`);
  - the orchestrator session (`control/orchestrator.ts`).

  [Confirmed] Today only the card launch passes `--settings` and `--mcp-config`.
- A command-output filter: the `agentdock-runner filter` subcommand and a PreToolUse rewrite hook.
- Filters for as many command families as rtk covers (Q6: "as much as possible").
- A strict MCP allowlist per project.
- Worker prompt v8: two registers, a stable prefix, guidance for built-in Read/Grep.
- An artifact guard on `finish_card`.
- A haiku scout subagent.
- An earlier autocompact threshold.
- A project setting, on by default.
- Measuring the savings, and showing them on the card, on Usage and on a new Token saver dashboard.

### Out of scope
- Fleet slots launched by the code-sentinel plugin (`dispatch.sh`, ADR-0005). They get a follow-up issue in the plugin repository that wires the same hook when the runner is installed (Q16).
- Using or bundling rtk. Its engine is BUSL-1.1 and AgentDock is self-hosted by others.
- Changing which model a card runs on (#322 recommendation stays).
- Compressing output tokens (what the model writes) beyond the working-register instructions.

## Decisions

| # | Decision | Source |
|---|---|---|
| D1 | Applies to all eight runner launches; the fleet is a follow-up in the plugin repository | person, Q1, Q16; ADR-0005 |
| D2 | Own filter, rtk's approach (rewrite Bash at PreToolUse, filter / group / truncate / dedupe), no rtk code | person, Q2 |
| D3 | The filter is an `agentdock-runner` subcommand: `filter -- <argv…>` runs and compresses, `filter-hook` is the PreToolUse hook that rewrites the Bash command. One binary and one distribution (ADR-0017). Overhead ceiling: p95 ≤ 50 ms added per command, measured in CI | person, Q10 |
| D4 | Safety, all mandatory: (a) the raw output always goes to `<run dir>/raw/<n>.log` and the compressed output ends with `[agentdock filter: N lines hidden · full output: <path> · AGENTDOCK_RAW=1 to bypass]`; (b) the exit code is unchanged, and error, failure, warning and stack lines are never removed — a filter that cannot classify the output returns it unchanged; (c) bypass with `AGENTDOCK_RAW=1 <cmd>`, which the prompt explains; (d) a regression corpus of real outputs where every error line must survive | person, Q5 |
| D5 | Coverage is as wide as rtk's families: JS/TS, VCS and CI, containers and cloud, Python, Go, Rust, Ruby, JVM, .NET, PHP, and file tools. Commands not covered pass through unchanged | person, Q6 |
| D6 | MCP: every runner launch uses `--strict-mcp-config` with `agentdock` (where the launch uses it) plus the servers the project allows. The runner takes each allowed server's definition from the launch profile's own config (ADR-0001, ADR-0006). An empty allowlist means agentdock only | person, Q3 |
| D7 | Two registers in the card worker prompt (v8). Working register: no narration of what you are about to do, no restating the plan, short status lines. Audience register, used for anything a person reads (questions, `.agentdock/pull-request.md`, the `finish_card` summary, specs, the reply file, design HTML): full sentences, the required sections, nothing omitted. Other launches get D3/D6/D10 only, because their output is the person-facing product | person, Q4; default |
| D8 | Artifact guard: `finish_card` checks that `.agentdock/pull-request.md` exists with `Closes #n` (when an issue exists), `## What changed and why` and `## Acceptance criteria`, and that the summary is at least 2 sentences. On a miss the tool returns what is missing and the worker rewrites. After 2 rejections in one round the finish is accepted with `artifactIncomplete: true`, and the card shows **Description incomplete** | person, Q11, Q13 |
| D9 | A `scout` subagent on haiku, defined in the launch's settings, for broad codebase searches and reading many files. Decisions and code stay on the session model. The prompt says when to use it | person, Q7 |
| D10 | Context: an earlier autocompact threshold for worker sessions, and a worker prompt ordered from stable sections (how to work, rules) to variable ones (the card, the round), so the prompt cache hits | person, Q12 |
| D11 | A project setting **Token saver**, on by default, which an admin can switch off. It holds the MCP allowlist. Off means today's launches exactly | person, Q9 |
| D12 | Savings are counted two ways: the filter's estimate (raw vs compressed, ≈ bytes/4, labelled "≈"), reported per command; and the fact from usage (ADR-0003, ADR-0009), the average cost per round of runs launched without and with the token saver (`runs.tokenSaver`), by run kind — never split by a date (amended 2026-10-16) | person, Q8, Q14 |
| D13 | Shown in three places: the card (next to its cost: `$0.88 · saved ≈ $0.41`, with details in the sheet); the Usage page (period total, before/after, top filters by savings, bypass rate); and a **Token saver** dashboard per project (savings over time, by filter, by run kind, bypass rate, the filters that most often returned the original) | person, Q15 |
| D14 | Built-in Read, Grep and Glob are not covered by the Bash hook. The prompt asks for `offset`/`limit` on big files and for the scout on broad searches | default |

## Data / Schema

- New table `token_saver_settings` (`projectId` PK/FK, `enabled` boolean default true, `mcpAllow` text[] default `{}`, `updatedAt`). A missing row means enabled with an empty allowlist.
- New table `token_saver_stats`, one row per filtered command and aggregated by the API:
  - `id`, `projectId`, `runId`, `runKind`;
  - `filter` (family/command id), `rawBytes`, `keptBytes`, `bypassed` (bool), `passedThrough` (bool: the filter returned the original);
  - `createdAt`, indexed `(projectId, createdAt)` and `(runId)`.
- `runs.tokenSaver` boolean, not null, default false: whether the launch carried `tokenSaver.enabled` (amended 2026-10-16).
- `board_card_rounds` gets no column. `artifactIncomplete` lives on the run's finish record (the existing finish path; the contract slot names the field).
- One migration: `apps/api/prisma/migrations/20261202000000_token_saver/`. The newest on develop is `20261129000000`; #441 owns `20261130000000_design_frames` and #443 owns `20261201000000_card_auto_run`.

## API

- `GET/PUT /projects/:id/token-saver` (admin for PUT) returns `{ enabled, mcpAllow }`.
- The runner reports filter stats in batches over the existing runner connection: a new runner event `filter.stats`, defined in the contract, carrying the rows above without `projectId`. The API resolves the project and run.
- `GET /projects/:id/token-saver/summary?from&to` returns totals, before/after per run kind (by `runs.tokenSaver`), top filters, bypass rate and pass-through rate.
- The board card view gets `tokenSaved: { estimateUsd: number; estimateTokens: number } | null` and the finish's `artifactIncomplete: boolean`.
- Authorization: a member of project A never reads project B's settings, stats or summary. This is an e2e acceptance criterion.

## UI

- Project settings get a **Token saver** tab: the switch and the MCP allowlist, picked from the servers the runner reports for its profiles (`mcpServers` on each runtime profile, shown as checkboxes; amended 2026-10-16).
- The card face shows `saved ≈ $x` next to the cost. The card sheet shows the per-filter breakdown for the round and the **Description incomplete** badge when it applies.
- The Usage page gets a Token saver section (D13).
- A new page `/projects/[projectId]/token-saver`: the dashboard (D13), built from glass-ui components only (ADR-0011).

## Configuration

- No new env for the API.
- The runner reads the project setting from the existing run commands. The contract adds `tokenSaver: { enabled, mcpAllow }` to every launch command the API sends.

## Acceptance criteria

- [ ] **Filter, safety:**
  - for every corpus case, the compressed output keeps every error, failure and warning line and the exit code;
  - the raw file exists and matches the original byte for byte;
  - `AGENTDOCK_RAW=1` returns the original.
- [ ] **Filter, pass-through:** an uncovered command, or output the filter cannot classify, is returned unchanged and counted as `passedThrough`.
- [ ] **Filter, savings:** on the corpus, the median `keptBytes/rawBytes` for test runners with failures is ≤ 0.3, for type checkers and linters with failures ≤ 0.8 (amendment 8), and for passing runs ≤ 0.1.
- [ ] **Overhead:** p95 added latency per command ≤ 50 ms on the CI runner, measured by a benchmark test.
- [ ] **Hook:** with Token saver on, a Bash tool call `bun run test` is executed as `agentdock-runner filter -- bun run test` (hook unit test with Claude Code's PreToolUse input shape). With it off, nothing is rewritten.
- [ ] **All eight launches:** each passes `--settings` (hook, scout, compaction) and `--strict-mcp-config` with the allowed servers when on, and each launches exactly as today when off (runner unit tests per launch).
- [ ] **MCP:** a project allowlist of `[playwright]` gives a card session exactly `agentdock` and `playwright`; an empty list gives `agentdock` only.
- [ ] **Worker prompt v8:**
  - it carries the two registers, the scout guidance and the Read/Grep guidance;
  - the stable sections come before the card's variable ones;
  - `CARD_WORKER_PROMPT_VERSION` is 8.
- [ ] **Artifact guard:**
  - a `finish_card` without `## Acceptance criteria` is refused with the missing items listed;
  - the third attempt in the round is accepted with `artifactIncomplete: true`;
  - the card shows **Description incomplete**.
- [ ] **Stats:** `filter.stats` rows reach `token_saver_stats`, and the card view's `tokenSaved` equals the sum of the round's estimates priced with the session model's input price (ADR-0009).
- [ ] **Authorization:** project A's member gets 403/404 for project B's token-saver settings and summary (e2e).
- [ ] **UI:**
  - the settings tab saves the switch and the allowlist;
  - the card shows `saved ≈`;
  - Usage shows the section;
  - the dashboard renders all D13 views, with screenshots in the PR.
- [ ] **No quality loss:** the person-facing artifacts of three cards run with Token saver on (PR description, `finish_card` summary, any questions) contain every required section. This is checked by the guard and listed in the wave's final PR.
- [ ] `docs/architecture/runner-protocol.md` documents `filter.stats` and `tokenSaver` on launch commands. A guide `docs/guides/token-saver.md` explains the bypass, the raw files and the allowlist.

## Parallel plan

Three waves. A slot starts when every slot it depends on has merged.

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i445-contract | schema + migration, shared contracts, protocol event, launch-command field, compile stubs (ADR-0039 lands with this spec) | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261202000000_token_saver/**, packages/shared/src/token-saver/**, packages/shared/src/protocol/messages.ts, packages/shared/src/protocol/messages.spec.ts, packages/shared/src/protocol/commands.ts, docs/architecture/runner-protocol.md | — | yes | opus |
| i445-engine | filter engine, raw store, bypass, pass-through, stats batching, `filter` / `filter-hook` subcommands, family registry with one stub per family, corpus harness, overhead benchmark | apps/runner/src/filter/**, apps/runner/src/cli.ts, apps/runner/src/cli.spec.ts | i445-contract | no | opus |
| i445-launch | one shared launch-wiring helper (settings with hook, scout, compaction; strict MCP from the allowlist and the profile config) used by all eight launches; worker prompt v8; artifact guard on `card.finish` | apps/runner/src/launch/**, apps/runner/src/cards/launch.ts, apps/runner/src/cards/wiring.ts, apps/runner/src/cards/finish-guard.ts, apps/runner/src/cards/*.spec.ts, apps/runner/src/skills/run/launch.ts, apps/runner/src/planner/launch.ts, apps/runner/src/assess/executor.ts, apps/runner/src/capture/executor.ts, apps/runner/src/uiprofile/executor.ts, apps/runner/src/normalize/executor.ts, apps/runner/src/control/orchestrator.ts, apps/runner/src/mcp/tools.ts, packages/shared/src/board/worker-prompt.ts, packages/shared/src/board/worker-prompt.spec.ts | i445-contract | no | opus |
| i445-api | settings and summary endpoints, `filter.stats` ingest, card view `tokenSaved` and `artifactIncomplete`, `tokenSaver` on launch commands, authorization e2e | apps/api/src/token-saver/**, apps/api/src/app.module.ts, apps/api/src/runners/runner-ingest.service.ts, apps/api/src/board/board-mapper.ts, apps/api/src/board/board-rounds.service.ts, apps/api/src/board/*.spec.ts | i445-contract, #443 merged (board-mapper) | no | sonnet |
| i445-filters-js | JS/TS family: bun/npm/pnpm/yarn, jest, vitest, bun test, tsc, biome, eslint, prettier, next build, prisma, turbo | apps/runner/src/filter/families/js/** | i445-engine | no | sonnet |
| i445-filters-ops | VCS, CI and ops: git, gh, glab, docker / compose, kubectl, helm, terraform, aws, gcloud, make, curl / http | apps/runner/src/filter/families/ops/** | i445-engine | no | sonnet |
| i445-filters-lang | other languages and files: pytest, ruff, mypy, pip / uv / poetry, go test / build / vet, cargo, rspec / rubocop / bundler, maven / gradle, dotnet, phpunit / composer, ls / find / grep / rg / cat / tree / wc | apps/runner/src/filter/families/lang/** | i445-engine | no | sonnet |
| i445-web | settings tab, card `saved ≈` and sheet breakdown, **Description incomplete** badge, Usage section, Token saver dashboard and its nav entry | apps/web/src/app/(app)/projects/[projectId]/settings/**, apps/web/src/app/(app)/projects/[projectId]/token-saver/**, apps/web/src/app/(app)/usage/**, apps/web/src/components/board/card-face.tsx, apps/web/src/components/board/card-sheet.tsx, apps/web/src/lib/token-saver/**, apps/web/src/components/shell/nav.ts, docs/ui/screens.md, docs/guides/token-saver.md | i445-api, #443 merged (card-face) | no | sonnet |

Waves:
1. i445-contract.
2. i445-engine, i445-launch, i445-api.
3. i445-filters-js, i445-filters-ops, i445-filters-lang, i445-web.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma, migration `20261202000000_token_saver` | i445-contract | do not open it |
| packages/shared/src/protocol/** | i445-contract | do not open it |
| apps/runner/src/filter/families/index.ts (the registry) | i445-engine — it lists every family with a stub | family slots edit only their own folder |
| packages/shared/src/board/worker-prompt.ts | i445-launch | do not open it |
| apps/api/src/board/board-mapper.ts | i445-api, after #443 merges | do not open it |
| apps/web/src/components/board/card-face.tsx, card-sheet.tsx | i445-web, after #443 merges | do not open them |

## Risks

- **High — a filter hides the line the agent needed.** Mitigations:
  - errors are never removed (D4b);
  - unclassified output passes through;
  - the raw file and the bypass exist;
  - the corpus test runs per family;
  - the dashboard's bypass and pass-through rates show where a filter gets in the way.
- **Medium — a hook bug breaks every Bash call of every agent.** Mitigations:
  - the hook fails open: any error in `filter-hook` leaves the command unchanged;
  - the project switch turns it off at once.
- **Medium — strict MCP removes a tool a project relied on.** Mitigation: the allowlist UI lists the profile's servers, and the guide explains it. The bypass rate does not show this, so the risk is noted for the person.
- **Low — the ≈ bytes/4 estimate overstates savings.** Mitigation: it is labelled "≈" and shown next to the fact from usage (D12).
- **Low — the artifact guard loops.** Mitigation: it accepts after 2 rejections (D8).

## Amendments (2026-10-16)

Settled by the person (1–3) and by the orchestrator (4–7) while the contract slot was open. They override the lines above where they differ.

1. **`runs.tokenSaver`.** A new column `runs.tokenSaver boolean NOT NULL DEFAULT false`, in migration `20261202000000_token_saver`. The API sets it at launch to whether the launch carried `tokenSaver.enabled`. D12's before/after compares runs with `tokenSaver = false` against runs with `true`, by run kind. It never splits by `token_saver_settings.updatedAt` or any other date.
2. **`mcpServers` on runtime profiles.** `runtimeProfileSchema` gets `mcpServers?: string[]`: the names of the MCP servers in that profile's own Claude config. It holds names only, never a command, env or secret. There are at most 64, each matching the server-name pattern. Absent means unknown (an older runner, or a Codex profile). The **Token saver** tab lists these as checkboxes.
3. **Hook scope.** The PreToolUse hook rewrites only a single simple command of a covered family. These pass through unchanged and are counted `passedThrough`:
   - a command with `|`, `&&`, `||`, `;`, a redirect, a heredoc, a subshell or a command substitution;
   - a Bash call with `run_in_background: true`;
   - a dev server or a watch mode.
4. **Capability gate.** The runner advertises `tokenSaver: true` in its capabilities. Every launch args schema is strict, so the API sends `tokenSaver` only to a runner that advertises it, as with `terminal`. i445-launch makes the runner advertise it.
5. **Stats transport.** The `filter` subprocess appends JSONL rows to `$AGENTDOCK_FILTER_STATS`, a file in the run dir. The launch sets the variable next to the other run-dir variables. The runner daemon reads the file in batches and sends `filter.stats` in the ordinary `events` stream. i445-engine owns the writer and the reader; i445-launch owns the env.
6. **Raw files.** The raw output goes to `<run dir>/raw/<n>.log` and is removed with the run dir. One file is capped at 10 MB with a truncation marker, and the compressed output says it was truncated.
7. **Who fills what.**
   - i445-launch reports `mcpServers` per profile and the capability.
   - i445-api sets `runs.tokenSaver`, ingests the stats and gates on the capability.
   - i445-web shows the checkboxes from `mcpServers`.
8. **Savings ceilings by category.** The failing-run ceiling is split: test runners ≤ 0.3, type checkers and linters ≤ 0.8. D4b keeps every error line, and a type-check or lint failure report is almost entirely error lines, so it cannot shrink to 0.3. Only the source snippets, underlines, notes and fix diffs go. Measured on the JS corpus: `tsc` 0.98 (plain) and 0.67 (`--pretty`), `biome check` 0.61. The passing ceiling (≤ 0.1) is unchanged.
9. **The hook rewrites only in bypass mode** (settled by the orchestrator after the delta security review, slot i445-harden). This narrows the earlier decision on the hook's permissions, decision (a), which also let the hook rewrite outside bypass mode when an `allow` rule already matched the original command.
   - The hook rewrites, and returns `permissionDecision: "allow"`, only when the PreToolUse input's `permission_mode` is `bypassPermissions`. In every other mode (`default`, `acceptEdits`, `auto`, `plan` and any later one) it passes the command through unchanged and counts it `passedThrough`. In those modes Claude Code decides through its prompt, its auto-mode classifier or plan mode's read-only rule, and a hook `allow` would skip that decision. The hook also cannot see every policy source, such as server-delivered managed settings or MDM.
   - In bypass mode, `deny` and `ask` `Bash(…)` rules still block a rewrite. They are matched generously: on the command with whitespace collapsed and quotes removed, with the program's directory dropped, with and without the leading assignments, and starting at every word. Any doubt means no rewrite.
   - The rewrite is built from the parsed argv, each word re-quoted, never from the original text. Amendment 3's "single simple command" is a whitelist. A command that contains `$`, a backtick, `#`, `!`, a newline or a non-printable or non-ASCII character anywhere passes through, and so does one with an unquoted glob, brace or tilde.
   - The stats reader takes a row's project, run and kind from the run dir's `filter-run.json`, which the launch writes. It rejects rows that disagree with it.
   - Amendment 6 holds for every launch. A card drops its earlier rounds' `raw/` when a new round starts, and the orchestrator's `raw/` goes when it stops. One run dir's raw files stay under 200 MB together, and the oldest go first. The compressed output the agent reads is redacted, and the raw file keeps every byte.
10. **The hook also rewrites in auto mode, with no decision** (decided by the person on 2026-10-16). Board card sessions run in `auto`, so under amendment 9 Token saver saved nothing on them. This widens amendment 9 by one mode and changes nothing else.
    - When the PreToolUse input's `permission_mode` is `auto`, the hook rewrites and returns only `hookEventName` and `updatedInput`. It returns no `permissionDecision` (neither `allow` nor `ask`) and no reason. Claude Code evaluates its permission rules and runs its auto-mode classifier on the input the hook returns, so the classifier judges `agentdock-runner filter -- <argv>` as it would any other command, and the hook skips nothing. Verified on Claude Code 2.1.301: in `auto` an `updatedInput` without a decision is applied, and a `deny` rule that matches only the rewritten command denies it.
    - Every amendment-9 pass-through rule holds in auto exactly as in bypass. The rewrite needs a single simple command a filter covers, not in the background and not a dev or watch mode. A `deny` or `ask` rule that matches the original command, matched generously, means no rewrite, and so does any doubt (unreadable settings, an unparsed rule). The original-command check is still needed: rules are evaluated on the rewrite, so without it `Bash(git push:*)` would miss `agentdock-runner filter -- git push`.
    - `bypassPermissions` is unchanged: rewrite plus `permissionDecision: "allow"`. `default`, `acceptEdits`, `plan`, `dontAsk`, a missing mode and any later one never rewrite.
    - Effect in auto: an `allow` rule written for the original command no longer matches the wrapped form, so the classifier decides that call instead. That costs a classifier round-trip and may, rarely, block a command an allow rule would have let through. It never approves anything the original would not have been offered for.

## Open questions

- The exact Claude Code setting for an earlier autocompact threshold, and the shape for defining the `scout` subagent with a model in `--settings`, are [Unknown]. The launch slot confirms both against the installed Claude Code. Default: if no documented setting exists, skip that half of D10 and say so in the PR.
- The compaction threshold. Default: 60 % of the context window for worker sessions.

Depends on #443
