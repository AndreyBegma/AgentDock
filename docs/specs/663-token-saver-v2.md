# Token saver v2: save where the cost is, and prove it per round

## Summary

The token saver (ADR-0039) saves about 0.002 % of what the fleet spends. Over seven days it saved about 168k tokens against about 8.8B processed. The reason is not the idea. The fixes were never released (runner 0.12.2 lacks #610, #612, #614 and #616), and the cost sits somewhere the saver does not reach.

Cache reads are 98–99 % of tokens and 70–87 % of cost. Sessions run to 300–845k of context without compacting. The fixed prefix is about 48–50k tokens and is re-read on every turn. cs-orchestrator workers (41 % of cost) are outside the runner's saver. Files are read with `cat`/`sed` in Bash (2,871 calls against 259 `Read`), which bypasses both the read guard and Claude Code's own Read dedup.

This wave moves the saver to those levers and measures cost per round instead of estimating saved bytes. It covers every session kind: Board card and CI-fix rounds, design, Planner, the AI assistant chat, and cs-orchestrator workers (in the plugin repository, as a follow-up). Workers also switch to a terse ("caveman") register in the terminal. Everything a person reads stays in full prose.

Expected effect, estimated from the audit and to be confirmed by this wave's own metric:
- card and worker cost falls by about 30–35 %;
- with compaction for the conductor sessions too, the whole bill falls by about 35–40 %;
- the terse register alone is worth about 1 %.

## Scope

### In scope
- The runner launch helper (`apps/runner/src/launch/token-saver.ts`) and every launch through it: card rounds, CI-fix rounds, design and stack design, Planner, UI profile, skill runs.
- One terse working register, owned by the runner and used by every launch and by the plugin.
- A PreToolUse refusal of whole-file reads through Bash, pointing to `Read`.
- Fixes and a per-rule switch for the command filter, with reasons recorded on pass-through rows.
- Effort per card next to the model (ADR-0032).
- Cost per round by session kind, shown on the Token saver page.
- Prompt caching and a bounded history for the AI assistant chat.
- A slimmer fixed prefix, including a shorter `CLAUDE.md`.

### Out of scope
- Compressing the *input* side (LLMLingua-style). Research shows it raises net cost.
- `opusplan`: each plan-mode toggle rebuilds the cache.
- Bundling Serena or claude-context (licence and egress; see `docs/research/token-saving-survey.md`).
- The Security cards on the Board.

## Decisions

Every decision below is the person's answer from the interview of 2026-10-19 unless a record is named. They are recorded as ADR-0068, which amends ADR-0039 and ADR-0032.

1. **Coverage.** Card and CI-fix rounds, design and Planner, the AI assistant chat, and cs-orchestrator workers.
2. **Two registers, sharper.** In the terminal, workers write in full caveman: fragments, no articles, no preamble, no restating. The following stay in normal prose, as ADR-0039 §4 already requires; the `finish_card` guard stays:
   - pull request descriptions, specs, ADRs and docs;
   - commit messages and code comments;
   - questions to the person;
   - the `finish_card` summary, design artifacts, and Planner messages to the person.
3. **One register text.** It lives in `packages/shared` and the runner prints it with `agentdock-runner register`. The plugin uses that output when the runner is installed, and its own copy only when it is not.
4. **Compaction at an absolute 150k** for every runner launch, through `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Never through a percentage on a 1M window. [Confirmed] `COMPACT_AT_TOKENS = 150_000` is on develop at `apps/runner/src/launch/token-saver.ts:33` and unreleased in 0.12.2.
5. **Cost per round is the metric.** For each round and session kind:
   - real cost before/after the release;
   - the cache-read share;
   - peak context and turns.

   The tokens-saved counter stays as a secondary figure. Pass-through (`none`) rows record a reason and a program.
6. **Runner release now**, separate from this wave: 0.13.0 ships what is already on develop.
7. **Routing.** The ADR-0032 assessment recommends an effort next to the model.
   - CI-fix rounds and mechanical rounds default to `sonnet` at `low` effort.
   - Design and Planner stay at `medium`.
   - Every launch overrides the `Explore` subagent to `haiku`; it otherwise inherits the main model.
8. **Whole-file reads go through `Read`.** The Bash PreToolUse hook refuses plain `cat`, `head`, `tail` and `sed -n` on a single file, with the hint "use Read with offset/limit". Pipelines and processing (`… | grep`, `wc`, `jq`) pass.
9. **The filter stays and is fixed, then judged by the metric.** Each rule family gets a switch, and families that add turns or do not save are switched off.
10. **Assistant chat.**
    - Prompt caching covers the stable part: system prompt and tools.
    - The last 20 messages are sent verbatim; older ones go as a stored summary.
    - Replies to the person stay in normal language.
11. **The prefix target is 25k tokens or less.**
    - `includeGitInstructions: false` for runner launches.
    - Deferred MCP tools.
    - Only the skills a launch kind needs.
    - `CLAUDE.md` shrinks to the never-traded rules; details move to `docs/` and skills.
12. **Cache.** Card and CI-fix rounds use the one-hour prompt-cache TTL and exclude dynamic system-prompt sections, so the prefix is shared across rounds and runners.

## Data / Schema

- `BoardCard` gains `recommendedEffort` and `effort` (nullable enum `low | medium | high`), next to the model fields of ADR-0032. Migration `apps/api/prisma/migrations/20261230000001_card_effort/`.
- `AssistantConversation` gains `summary` (text, nullable) and `summaryUpTo` (the id of the last summarised message). Migration `apps/api/prisma/migrations/20261230000002_assistant_summary/`.
- The metric needs no schema change. [Confirmed] `Turn` already stores `cacheRead` per turn (`schema.prisma:801`). Peak context is the maximum per round of input + cache read + cache write, and turns is the count. [Unknown] whether every session kind writes `Turn` rows. The metric slot checks this and reports any kind that does not.

## API

- `POST /projects/:projectId/board/cards/:number/run` accepts an optional `effort`, validated with `@IsIn`.
- The card launch command (`packages/shared/src/protocol/commands/cards.ts`) and the assess contract (`packages/shared/src/assess/contract.ts`) carry `effort`.
- `GET /projects/:projectId/token-saver/summary` adds, per session kind and per week: rounds, median and p90 cost per round, the cache-read share, median peak context and median turns.
- The assistant chat sends `cache_control` on the system prompt and tools, plus the history window and the summary.

## UI

- The card run dialog shows the recommended effort next to the model, and the person can change it (ADR-0032 pattern).
- The Token saver page leads with cost per round by session kind, before/after the 0.13.0 release. Saved bytes move below. Pass-through reasons are listed.

## Configuration

- Runner launch env and settings in `apps/runner/src/launch/token-saver.ts`. [Unknown] the exact name of each flag; verify against the Claude Code changelog for the installed CLI before wiring. The flags:
  - `CLAUDE_CODE_AUTO_COMPACT_WINDOW`;
  - the one-hour cache TTL switch;
  - exclude dynamic system-prompt sections;
  - `includeGitInstructions`;
  - deferred MCP tool search;
  - the `Explore` agent override.
- No new API environment variables.

## Acceptance criteria

- [ ] Every launch kind runs with `CLAUDE_CODE_AUTO_COMPACT_WINDOW=150000`: card, CI-fix, design, stack design, Planner, UI profile and skill run. None sets a percentage override. A unit test per kind.
- [ ] On the card, design and Planner launches, the first-turn input (system prompt + tools + `CLAUDE.md`) is 25k tokens or less, measured from a recorded first turn in an e2e or fixture test.
- [ ] `agentdock-runner register` prints the register, and the card worker prompt contains the same text: one source, enforced by a test.
- [ ] A card worker's PR description, spec, commits and `finish_card` summary are in full sentences. The existing guard still returns an incomplete artifact.
- [ ] `cat file.ts`, `head -50 file.ts` and `sed -n 1,80p file.ts` are refused with a hint naming `Read`. `cat a | grep x`, `wc -l file` and `jq . file.json` pass. The hook fails open on a parse error.
- [ ] Every `none` row of `token_saver_stats` has a reason and a program. Each filter family can be switched off per project.
- [ ] The assessment recommends an effort. A CI-fix round launches `sonnet` at `low` unless the card overrides it. The run dialog shows and changes it.
- [ ] Every launch sets the `Explore` subagent to `haiku`.
- [ ] Assistant chat: the second request of a conversation reports cache reads above zero on the stable part. A 60-message conversation sends 20 messages plus the summary. Replies are not terse.
- [ ] The Token saver page shows cost per round, cache-read share, peak context and turns per session kind. A member of another project cannot read them (authorization test on the summary endpoint).
- [ ] `CLAUDE.md` is 200 lines or less; no rule is lost (moved rules are linked).

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i663-launch | launch wiring, prefix, cache, `CLAUDE.md` | apps/runner/src/launch/**, CLAUDE.md, docs/guides/agent-rules.md | — | yes | opus |
| i663-hooks | register text and subcommand, Bash read refusal, filter fixes and switches | packages/shared/src/token-saver/register.ts, packages/shared/src/token-saver/index.ts, packages/shared/src/board/worker-prompt.ts, packages/shared/src/planner/**, apps/runner/src/cli.ts, apps/runner/src/filter/** | — | no | sonnet |
| i663-routing | effort per card | apps/api/prisma/schema.prisma (BoardCard only), apps/api/prisma/migrations/20261230000001_card_effort/**, packages/shared/src/assess/**, packages/shared/src/protocol/commands/cards.ts, packages/shared/src/protocol/commands/assess.ts, apps/api/src/assess/**, apps/runner/src/assess/**, apps/runner/src/cards/**, apps/api/src/board/**, apps/web/src/components/board/launch-popover.tsx | — | no | opus |
| i663-metric | cost per round and the page | packages/shared/src/token-saver/contracts.ts, apps/api/src/token-saver/**, apps/api/src/history/**, apps/web/src/app/(app)/projects/[projectId]/token-saver/**, apps/web/src/components/token-saver/**, apps/web/src/lib/token-saver/** | — | no | opus |
| i663-chat | assistant caching, window, summary | apps/api/prisma/schema.prisma (AssistantConversation only), apps/api/prisma/migrations/20261230000002_assistant_summary/**, apps/api/src/assistant/** | — | no | sonnet |

Follow-up, in AndreyBegma/code-sentinel-skills (one issue, after the 0.14.0 runner release that carries i663-hooks):
- cs-eco and `/cs-orchestrator` workers take the register from `agentdock-runner register`;
- compact at an absolute 150k window instead of `PCT=70`;
- get the Bash read refusal through `agentdock-runner filter-hook`;
- **the conductor session gets the same compaction** (see Open questions).

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i663-routing (BoardCard), i663-chat (AssistantConversation) | distinct models: keep both sides on conflict. No one else opens it |
| apps/api/prisma/migrations/ | i663-routing `20261230000001_card_effort`, i663-chat `20261230000002_assistant_summary` | no other migration in this wave |
| apps/runner/src/cli.ts | i663-hooks | do not open it |
| apps/runner/src/launch/token-saver.ts | i663-launch | i663-routing passes effort through the existing launch input, not by editing this file |
| packages/shared/src/protocol/commands/cards.ts | i663-routing | do not open it |
| CLAUDE.md | i663-launch | do not open it |
| packages/shared/src/token-saver/index.ts | i663-hooks | i663-metric edits contracts.ts only (already exported) |
| docs/ui/screens.md | i663-routing, then i663-metric | append rows; merge one PR at a time and `git merge origin/develop` the rest |

## Risks

- **High: caveman leaks into files.** Terse text lands in code comments, commits or docs. Mitigation: the register names those exemptions explicitly, the `finish_card` guard stays, and the review checks one PR per slot for it.
- **Medium: low effort skips verification on CI-fix rounds.** Mitigation: the metric shows CI-fix attempts per card. Revert the default if attempts rise.
- **Medium: the Bash read refusal adds turns.** Mitigation: only the plain single-file forms are refused, and the metric shows turns per round before/after.
- **Medium: wrong flag names silently do nothing.** Mitigation: [Unknown] flags are verified against the installed CLI, and the acceptance test measures the first-turn prefix and the compaction env, not the flags.
- **Medium: `CLAUDE.md` slimming drops a rule.** Mitigation: a moved rule stays linked, and the slot lists every removed line and its new home in the PR.
- **Low: the one-hour TTL costs more per write (2× against 1.25×).** Mitigation: the cache-read share per round shows whether it pays. Card and CI-fix rounds only.

## Open questions

- **Conductor compaction.** Should the interactive cs-orchestrator conductor session also compact at 150k? It is 38 % of cost, with 59 % of its tokens above 150k. Default: yes, in the plugin follow-up.
- **History window.** The chat sends 20 verbatim messages. Default: 20.
- **Design and Planner effort.** Default: `medium`.

Depends on #662 (runner 0.13.0 release)
