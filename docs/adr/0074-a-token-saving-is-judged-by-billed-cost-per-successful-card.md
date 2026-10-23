# ADR-0074: A token saving is judged by billed cost per successful card, in a per-card A/B test

Status: accepted · Date: 2026-10-21 ·
Epic: [#745](https://github.com/AndreyBegma/Nautelle/issues/745) ·
Issue: [#746](https://github.com/AndreyBegma/Nautelle/issues/746) ·
Spec: [`docs/specs/746-per-run-cache-metrics-per-card-a-b-flags.md`](../specs/746-per-run-cache-metrics-per-card-a-b-flags.md) ·
Amends: [`docs/specs/445-token-saver.md`](../specs/445-token-saver.md) D12 and D13, [ADR-0068](0068-the-token-saver-targets-context-residency-and-is-judged-by-cost-per-round.md) §2 (and §1's one-hour TTL, §3's register and §5's effort as techniques, see §7), [ADR-0039](0039-token-saver.md) §6 ·
Builds on: [ADR-0003](0003-usage-from-opentelemetry-transcripts-as-backfill.md), [ADR-0009](0009-api-equivalent-cost-from-a-versioned-price-table.md) ·
Keeps: ADR-0068 §4 and §6; §1's compaction and prefix target

## Context

Board cards show `saved ≈ <$0.01` next to a round's cost, even on cards where the token saver cut a lot of output. There are four reasons, all confirmed in code:

- `estimateUsdSaved` (`packages/shared/src/token-saver/estimate.ts:19-25`) prices saved tokens once, at the uncached input price.
- `/cs-eco` rows are stored with `runId: null` and `runKind: 'manual'` (`apps/runner/src/filter/eco.ts:119-123`). A row without a run is priced at $0 (`apps/api/src/token-saver/token-saver-facts.ts:186`) and never reaches a card.
- Since #616, card launches set `CS_ECO=off` (`apps/runner/src/launch/token-saver.ts:376`). That turned off the plugin's MCP cut along with its read guard.
- The web formats any figure under one cent as `<$0.01` (`apps/web/src/lib/format/index.ts:161-167`).

The pricing is also wrong in kind, not only in size. A token removed from a tool result is never read once at the input price. It is written to the prompt cache once, then read back from the cache on every later turn until a compaction or the end of the session. The following figures were [Reported] by a research agent from primary sources and have not been confirmed here:

- In Claude Code, about 87 % of billed cost is cache traffic: 44 % cache writes, 35 % cache reads, about 10 % output and about 1 % uncached input (arXiv 2607.12161).
- In the same study, cutting tool output by 38 % raised cost by 6.8 %. Bash-output filters of the RTK kind came to about −2.7 % of billed cost. Proxies that rewrite the prompt came to +48 %, because they break the cache.
- A 5-minute cache write costs 1.25× input, a 1-hour write 2×, and a cache read 0.1× (Anthropic prompt-caching docs).

So a smaller tool result can still cost more. It can add turns, cause a retry, or break the cache.

ADR-0068 §2 already moved the headline to cost per round, comparing before a change with after it. A before/after split is a split by date, and the person ruled that out (445 amendment 1). It also has no quality side. A technique that lowers the cost of a round but adds rounds, CI fixes or retries looks like a saving in that metric.

## Decision

1. **The headline is billed cost per successful card.**
   - "Billed" is cache-aware: input, output, cache writes (5-minute and 1-hour apart) and cache reads, each at its own price from the versioned price table (ADR-0009). It is summed from the card's requests as ingested today (ADR-0003), including the requests of subagent sessions the card's session spawned.
   - A successful card is one whose pull request merged.
   - The figure is per card, never per round. It sums every round of the card, CI-fix rounds included.

2. **Each technique is proven by an A/B test randomised per card.**
   - Every saving technique has its own flag.
   - A card is assigned to arm A (technique off) or arm B (technique on) when it first launches, separately for each technique. The assignment is sticky for all the card's rounds.
   - The share of cards in arm B is a project setting.
   - No comparison is ever split by date. This keeps 445 amendment 1 and replaces ADR-0068 §2's before/after.

3. **A result did not suffer only if all four quality signals hold,** compared per arm:
   - the PR checks were green on the first push;
   - the card took no more rounds;
   - the card merged without a review return;
   - the card's runs had no retries. A retry is a command re-run unfiltered, or a read repeated after a guard refused it.

   A technique that worsens any of the four signals is rolled back.

4. **A person enables a technique for everyone; nothing is enabled automatically.** The Token saver dashboard shows, for each technique and arm:
   - $/successful card;
   - the four quality signals;
   - a confidence interval for each figure;
   - a marker for whether the arm has enough data.

   A project admin enables the technique for all cards from that report.

5. **The filter estimate stays, re-priced, as a detail.** A saved token is priced as one cache write plus one cache read for each turn left until the next compaction or the end of the session, taken from the run's usage:

   saved $ = tokens × (cache-write price + cache-read price × turns remaining)

   When per-turn data is missing, the run's average is used instead. The card shows this estimate with tokens first, `saved ≈ 42k tok · $0.13`. The dashboard's headline is $/successful card (§1).

6. **Scope.** This covers card runs, and manual and `/cs-eco` sessions; their estimate is priced the same way. Planner, spec and assess runs are out of scope: their output is a document for people, and no merge measures it.

7. **What ADR-0068 shipped unconditionally becomes a technique.** Three behaviours are on for every card round today. Each keeps its current behaviour as the default when no flag is sent, and becomes an A/B technique of its own:
   - the one-hour cache TTL of ADR-0068 §1 → `cache-ttl-1h` ([#749](https://github.com/AndreyBegma/Nautelle/issues/749)); the control arm pins 5 minutes;
   - the terse register of ADR-0068 §3 → `terse-register` ([#747](https://github.com/AndreyBegma/Nautelle/issues/747)); the control arm gets the earlier two-register text;
   - the effort recommended with the model (ADR-0068 §5) stays in the control arm; the class mapping of [ADR-0076](0076-a-cards-model-and-effort-follow-its-class-and-stay-fixed-per-session.md) is technique `model-by-type` ([#750](https://github.com/AndreyBegma/Nautelle/issues/750)).

   ADR-0068 §1's 150k compaction and 25k prefix target are not techniques and stay on.

## Consequences

- **The cost of this decision:**
  - Cards in arm A run without a technique that may already save money. That gives up part of the saving while each test runs: with a 50 % B share, half of it.
  - A verdict waits for enough merged cards in both arms. A project with few cards waits weeks for one.
  - The schema grows: per-card assignments, per-technique modes, a project B share, and per-run snapshots of the techniques in force.
  - Every new technique must ship behind a flag and be wired into the assignment.
- Per-card randomisation removes the drift that a date split confounds: model releases, runner releases, the kind of work in a given week.
- Techniques are randomised independently, so one card can be in arm B of several tests. Each report compares its own arms and averages over the other techniques' arms. Strong interactions between techniques show only as a wider interval.
- The four signals are proxies taken from what Nautelle already records: rounds and their triggers, `prState` and the CI state. A review return that happens outside Nautelle is not seen.
- The estimate on a card can now rise above its old figure by an order of magnitude. That is intended: it was priced wrongly before. It remains an estimate and keeps its "≈".
- Before/after views that already exist (`runs.tokenSaver` on Usage, cost per round on the Token saver page) stay as context. They no longer decide whether a technique stays on.
- Planner, spec and assess runs keep their current metrics. For them, ADR-0068 §2 is unchanged.
