# Token economy: measure billed cost per successful card, and prove each saving in an A/B test

Issue: [#745](https://github.com/AndreyBegma/Nautelle/issues/745) (epic) ·
Decision records: [ADR-0074](../adr/0074-a-token-saving-is-judged-by-billed-cost-per-successful-card.md) (measurement and A/B),
[ADR-0075](../adr/0075-agent-instruction-files-may-be-stored-as-prefix-overlays.md) (overlays, design memory),
[ADR-0076](../adr/0076-a-cards-model-and-effort-follow-its-class-and-stay-fixed-per-session.md) (model and effort by class)

## Summary

The token saver claims savings it cannot show, and it prices them wrongly. Cards show `saved ≈ <$0.01`, even where the filter cut a lot of output. The reasons, [Confirmed] in code:

- **The estimate is priced as uncached input, once.** `estimateUsdSaved` (`packages/shared/src/token-saver/estimate.ts:19-25`) does this. Yet in Claude Code a removed token would have been written to the prompt cache and then read back on every later turn.
- **`/cs-eco` savings are lost.** Its rows are stored as `runId: null, runKind: 'manual'` (`apps/runner/src/filter/eco.ts:119-123`). A row without a run prices at $0 (`apps/api/src/token-saver/token-saver-facts.ts:186`) and never reaches a card, even when the session is tracked to one (`board_cards.trackedSessionId`).
- **Card runs lost two savers in #616.** They launch with `CS_ECO=off` (`apps/runner/src/launch/token-saver.ts:376`), so the plugin's MCP cut is gone, and so is the terse register it injected. The runner has no PostToolUse cut for MCP, Grep or WebFetch, and its read guard only fires at 1,500 lines / 64 KB, with no file outline.
- **Sub-cent figures are rounded away.** The web shows anything under a cent as `<$0.01` (`apps/web/src/lib/format/index.ts:161-167`).
- **The plugin's correction row is rejected.** In AndreyBegma/claude-code-plugin, the correction row written when a session repeats a refused read (`hooks/eco_hook.py:271-272`) has `keptBytes > rawBytes` and `bypassed: true`. Both of `filterStatRowSchema`'s refines reject it (`packages/shared/src/token-saver/contracts.ts:225-235`).
- **No quality join.** The before/after (`runs.tokenSaver`) and the cost per round (ADR-0068 §2) compare cost only. Neither looks at whether the work still succeeded.

External evidence ([Reported] by a research agent; not verified here):
- About 87 % of Claude Code's billed cost is cache traffic: 44 % writes, 35 % reads (arXiv 2607.12161).
- Cutting tool output 38 % raised cost 6.8 % in that study. Bash filters came to about −2.7 %, and prompt-rewriting proxies to +48 %.
- Prices relative to input: a 5-minute cache write is 1.25×, a 1-hour write 2×, a cache read 0.1×.
- Context editing roughly halves cost at an equal solve rate (arXiv 2508.21433).
- A Sonnet executor with an Opus advisor is about 12 % cheaper than Opus alone.
- Changing the model, the MCP servers or the tool set mid-session breaks the cache.

## Principles

- **The judge is billed (cache-aware) cost per successful card,** randomised A vs B per card (ADR-0074). The filter estimate stays as a detail, priced again as one cache write plus a cache read per turn remaining.
- **A saving counts only if the work did not suffer.** All four signals hold per arm:
  - checks green on the first push;
  - no more rounds;
  - merged without a review return;
  - no retries.
- **Every technique has its own flag.** A card is assigned an arm at its first launch and keeps it for every round. The B share is a project setting. Comparisons are never split by date.
- **A person enables a technique for everyone,** from the report. Nothing is enabled automatically.
- **The cache is protected.** The model, effort, MCP servers and tool set are chosen at launch only, never mid-session.

## Issues

| # | Spec | Scope | Depends on |
|---|---|---|---|
| [#746](https://github.com/AndreyBegma/Nautelle/issues/746) | [746](746-per-run-cache-metrics-per-card-a-b-flags.md) — **measurement and A/B (lead)**, ADR-0074 | Per-run usage facts: cache writes split 5m/1h, cache reads, input, output, compactions, peak context, retries. Per-technique flags with sticky per-card assignment and a project B share. Quality join. Dashboard report per technique with confidence intervals, an enough-data marker and "Enable for all". Re-priced estimate. Token-first card badge. | — |
| [#747](https://github.com/AndreyBegma/Nautelle/issues/747) | [747](747-cut-large-mcp-grep-and-webfetch-results.md) — runner savers | Bring the following into the runner, each behind its own A/B flag: an MCP result cut (> 16,000 chars → head + tail, full text saved, path shown); the same cap for Grep and WebFetch; a read guard at 400 lines with a file outline; the terse register behind a flag. | #746 |
| [#748](https://github.com/AndreyBegma/Nautelle/issues/748) | [748](748-count-cs-eco-savings-on-the-card-a-sessi.md) — `/cs-eco` attribution | Rows from a `/cs-eco` session tracked to a card count for that card. Untracked manual sessions are priced by the session's model and shown on Usage. The plugin's invalid correction row and its `RUN_KIND = "skill"` are fixed in AndreyBegma/claude-code-plugin, as a separate issue there. | #746 |
| [#749](https://github.com/AndreyBegma/Nautelle/issues/749) | [749](749-start-a-fresh-session-for-a-long-card-ro.md) — sessions | Rounds by size: a short session continues with `--resume`; one above a threshold starts a fresh session from the handoff. The 1-hour prompt-cache TTL for card sessions goes behind A/B. | #747 |
| [#750](https://github.com/AndreyBegma/Nautelle/issues/750) | [750](750-choose-model-and-effort-by-card-class-es.md) — model and effort by class, ADR-0076 | Extend the #322 recommendation to a class → model + effort mapping, with a person's override on the card. When unsure, Opus. A Sonnet round that gives up or reports the card misclassified is re-launched on Opus. Both are chosen at launch only. | #749 |
| [#751](https://github.com/AndreyBegma/Nautelle/issues/751) | [751](751-measure-the-launch-prefix-select-it-per.md) — the prompt prefix, ADR-0075 | Prefix measured by part on every launch. Per-card-type selection of rules, skills and MCP servers. Haiku compression of injected rules. Admin-approved overlays that go stale when their original changes. | #750 |
| [#752](https://github.com/AndreyBegma/Nautelle/issues/752) | [752](752-the-ui-profile-remembers-approved-screen.md) — design memory, ADR-0075 §6 | After a design is approved, the UI profile learns an approved-screen library, style rules from comments and new snippets; the design prompt reads them when the project turns it on. | — |

### Order

The chain avoids two specs editing the same files at once (`apps/runner/src/launch/token-saver.ts`, `apps/api/src/board/board-rounds.service.ts`, `apps/runner/src/handoff/service.ts`, `packages/shared/src/board/worker-prompt.ts`, `schema.prisma`):

```
#746 ─┬─> #747 ──> #749 ──> #750 ──> #751
      └─> #748
#752 (independent)
```

- #748 depends only on #746, and runs in parallel with #747.
- #752 depends on nothing: design runs are not in the card A/B, so design memory is a project setting, not an A/B technique.
- #747, #749, #750 and #751 each add their techniques to the registry #746 creates. None of them ships a technique outside A/B.

### Migrations

Each spec that changes the schema names its own directory, ordered along the chain:

| Issue | Migration |
|---|---|
| #746 | `20261231000007_token_economy_metrics` |
| #748 | `20261231000008_token_saver_stat_session` |
| #750 | `20261231000009_card_model_by_type` |
| #751 | `20261231000010_prefix_parts_and_overlays` |
| #752 | `20261231000011_ui_profile_memory` |

#747 and #749 have no schema change. If `develop` already has a later stamp when a branch is cut, that slot takes the next free stamp after it and keeps its name.

## What ADR-0068 shipped unconditionally, now behind flags

ADR-0068 / #663 are on `develop` and turned three things on for every card round. ADR-0074 §7 makes each one a technique; the default without a flag is today's behaviour:

- **1-hour cache TTL** (ADR-0068 §1, `apps/runner/src/launch/token-saver.ts:375`) → `cache_ttl_1h` in #749. The control arm pins `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`.
- **Terse register** (ADR-0068 §3, `packages/shared/src/token-saver/register.ts`) → `terse_register` in #747. The control arm gets the #445 D7 two-register lines.
- **Effort recommended with the model** (ADR-0068 §5, `board_cards.recommendedEffort` / `effort`) → stays as arm A of `model_by_type` in #750; arm B uses the class mapping of ADR-0076.

Also already on `develop`, and not a technique:
- ADR-0068 §1's fixed-prefix target of 25k tokens or less. #751 turns it into a per-project budget measured on every launch.
- Context handoff (#449, ADR-0042, card C-92, `docs/specs/card-92-context-handoff-a-new-round-or-session-s.md`). #749 adds a size rule on top of it, and #750 reuses its fresh start.

## Out of scope

- Planner, spec and assess runs. Their output is a document for people, and they keep their current metrics.
- Compression through an API proxy. Rewriting the prompt in transit breaks the prompt cache: +48 % [Reported].
- Enabling a technique automatically.
