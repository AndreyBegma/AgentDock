# Token economy 1: billed cost per successful card, per-technique A/B, and a re-priced estimate

Issue: #746 (lead) · Epic: [#745](745-token-economy.md) · ADR: [ADR-0074](../adr/0074-a-token-saving-is-judged-by-billed-cost-per-successful-card.md)

## Summary

The token saver cannot tell whether a technique saves money, and the figure it shows is priced wrongly. This issue builds the measurement that #747–#751 build on; #748 and #747 start right after it (ADR-0074). Design memory (#752) does not depend on it.

1. **Per-run usage facts.** For every card run, and every manual or `/cs-eco` session:
   - cache writes, split 5-minute and 1-hour;
   - cache reads, input and output;
   - compactions and peak context;
   - retries.
2. **An A/B framework.**
   - Every technique has its own flag.
   - A card is assigned an arm at its first launch, and the arm is sticky for all its rounds.
   - The share of cards in arm B is a project setting.
3. **A quality join.** Each card's billed cost is joined with four signals:
   - checks green on the first push;
   - rounds;
   - review returns;
   - retries.
4. **A report per technique** on the Token saver page:
   - $/successful card and the four signals for each arm;
   - confidence intervals;
   - an "enough data" marker;
   - an admin's **Enable for all**.
5. **The re-priced filter estimate,** shown on the card tokens first: `saved ≈ 42k tok · $0.13`.

Most raw data already exists. [Confirmed] The runner already parses every number the metric needs except retries:

- **The transcript usage.** `apps/runner/src/adapters/claude/parse.ts:126-141` (`tokenBuckets`) reads `input`, `output` and `cache_read_input_tokens`, with `cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` apart. Without a split, all cache writes go to 5m.
- **OTel `claude_code.api_request`.** `apps/runner/src/otlp/map.ts:178-200` reads one cache-write count without a TTL. It is flagged `cacheWriteTtlUnknown`, and the transcript copy splits it later.
- **Compactions.** `compact_boundary` lines (`parse.ts:249-260`, `:387-388`) become `session_compactions` rows, with `trigger` and `preTokens`.
- **Storage.** The API stores the usage in `llm_requests` (`input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`, `costUsd`; `apps/api/prisma/schema.prisma`, model `LlmRequest`). A run's requests are its session's requests within the run's time window (`apps/api/src/history/run-usage.ts:50-114`, `RUN_SESSIONS` / `RUN_REQUESTS`).
- **Retries.** The runner already writes a `bypassed` stats row for:
  - a command run with `NAUTELLE_RAW=1` (`token_saver_stats.bypassed`);
  - the read that follows a read-guard refusal (`apps/runner/src/filter/read-guard.ts:30`, `:223`).

What this issue adds on the runner is applying technique flags at launch. The rest is the API and the web.

## Scope

### In
- `packages/shared`:
  - the technique registry and A/B contracts;
  - the re-priced estimate (`token-saver/estimate.ts`);
  - `techniques` on the card launch command;
  - a capability.
- Schema:
  - `token_economy_settings`, `token_economy_techniques` and `card_technique_arms`;
  - `runs.techniques` and `runs.retries`;
  - a materialised `run_usage_facts`.
- API:
  - assignment at a card's first launch;
  - per-run usage facts, subagent sessions included;
  - the quality join;
  - the report endpoint and the admin mode/share endpoints;
  - the re-priced estimate in `token-saver-facts.ts`.
- Runner: accept `techniques` on `card.run` and pass them to the launch helper (`TokenSaverLaunchInput`). No technique changes behaviour in this issue.
- Web:
  - the card badge, tokens first;
  - the per-technique report on the Token saver page;
  - the B share on the Token saver settings tab;
  - `docs/ui/screens.md` rows.
- The amendment note in `docs/specs/445-token-saver.md` (D12 and D13 amended by ADR-0074). ADR-0074 itself and its index row land with this spec's docs pull request.

### Out
- Any technique itself (#747–#751 each register their own).
- `/cs-eco` attribution to tracked cards and the plugin fix (#748).
- Planner, spec and assess runs.
- Removing the existing before/after (`runs.tokenSaver`) and cost-per-round views (ADR-0068 §2). They stay as context.

## Decisions

| # | Decision | Source |
|---|---|---|
| D1 | Headline = billed (cache-aware) cost per successful card, A vs B. Billed = Σ `llm_requests.costUsd` of the card's runs, priced by the price table (ADR-0009), including requests of subagent sessions whose `parentSessionId` chain leads to the card's session. Successful = `board_cards.prState = 'merged'`. | person, 2026-10-21 (Q-metric); ADR-0074 §1 |
| D2 | Every technique has its own flag. A card gets an arm per technique at its **first launch**, which is sticky for all its rounds. The B share is a project setting. Never split by date. | person, 2026-10-21 (Q-proof) |
| D3 | "The result did not suffer" means all four signals, per arm: (a) checks green on the first push; (b) rounds per card not up; (c) merged without review returns; (d) no retries. A technique that worsens any signal is rolled back. | person, 2026-10-21 (Q-quality) |
| D4 | The signals come from what Nautelle records: (a) the card had no `ci_fix` round (`board_card_rounds.trigger`); (b) `COUNT(board_card_rounds)`; (c) `prState = 'merged'` and no `feedback` round after the first `run` round; (d) Σ `runs.retries` = 0, where retries per run = `token_saver_stats` rows of the run with `bypassed = true` (unfiltered re-run with `NAUTELLE_RAW=1`, or the read let through after a guard refusal). | spec, from D3; [Confirmed] fields exist |
| D5 | A person enables a technique for everyone from the report. Nothing is enabled automatically. The report shows $/successful card and the four signals per arm, with confidence intervals and an enough-data marker. | person, 2026-10-21 (Q-rollout) |
| D6 | The re-priced estimate = tokens × (cache-write price + cache-read price × turns remaining). Turns remaining are the main-loop requests of the row's session after the row's `createdAt`, up to the next `session_compactions.ts` or the session's last request. The write price is the 1h price when the run's requests wrote with the 1-hour TTL (`cacheWrite1h > 0`), else the 5m price. When per-turn data is missing, the run's average is used. This amends 445 D12. | person, 2026-10-21 (Q-reprice); ADR-0074 §5 |
| D7 | The card leads with tokens: `saved ≈ 42k tok · $0.13`. The dashboard's headline is $/successful card. This amends 445 D13. | person, 2026-10-21 (Q-display, Q-metric) |
| D8 | Scope: card runs, and manual and `/cs-eco` sessions. Planner, spec and assess runs are out. | person, 2026-10-21 (Q-scope) |
| D9 | A technique's mode per project is `off` (nobody), `ab` (randomised) or `on` (every card). Arm A = technique off, arm B = technique on. The registry gives each technique its default mode. Enabling for all sets `on`, and only a project admin can do it. | spec, from D2/D5 |
| D10 | Techniques are randomised independently of each other. The arm is drawn with a seeded hash of `(cardId, technique)` against the B share, so the result is reproducible and needs no lock. | spec, from D2 |
| D11 | The launch snapshots the flags in force on the run (`runs.techniques`). Reports read the snapshot, never the current setting. | spec, from D2 |

## Data / Schema

Migration `apps/api/prisma/migrations/20261231000007_token_economy_metrics/`. The latest on `develop` is `20261231000006_project_github_repo_id`. The epic orders the stamps (#746 `…07`, #748 `…08`, #750 `…09`, #751 `…10`, #752 `…11`); if `develop` already has a later stamp when the branch is cut, take the next free one and keep the name.

- **`TokenEconomySettings`** → `token_economy_settings`
  - `projectId` (PK, FK `projects` cascade)
  - `bSharePercent Int @default(50)`, checked as 0–100 by the DTO
  - `updatedById` (FK `users`, SetNull)
  - `updatedAt`
- **`TokenEconomyTechnique`** → `token_economy_techniques`
  - `projectId`, `technique String` (a registry key), `mode TechniqueMode` (`off | ab | on`)
  - `changedById`, `changedAt`
  - PK `(projectId, technique)`. A missing row uses the registry's default mode.
- **`CardTechniqueArm`** → `card_technique_arms`
  - `cardId` (FK `board_cards` cascade), `technique String`, `arm TechniqueArm` (`a | b`)
  - `mode TechniqueMode`: the mode when the arm was assigned, so cards forced `on` are told apart from randomised B
  - `assignedAt`
  - PK `(cardId, technique)`; index `(technique, arm)`
- **`Run`** gains:
  - `techniques Json?`: `{ [technique]: boolean }` as launched (D11), null for launches without techniques;
  - `retries Int @default(0)`: written by the token-saver sink as bypassed rows of the run arrive.
- **`RunUsageFact`** → `run_usage_facts`, one row per ended card run or manual session, rebuilt when its requests change:
  - `runId` (nullable, unique) or `sessionId` (nullable, unique), exactly one set
  - `projectId`
  - `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h` (BigInt)
  - `costUsd Decimal(14,6)?`, `unpricedRequests Int`
  - `compactions Int`, `peakContext Int` (max of input + cacheRead + cacheWrite5m + cacheWrite1h over one request), `turns Int`
  - `subagentCostUsd Decimal(14,6)?`
  - `builtAt`
  - Index `(projectId, builtAt)`.
  - [Unknown] whether a view or on-demand SQL is fast enough instead. Default: materialised. The rebuild is triggered by the run end and by late `llm_requests`, debounced.
- **Shared** `packages/shared/src/token-economy/`:
  - `TOKEN_ECONOMY_TECHNIQUES` in `packages/shared/src/token-economy/techniques.ts`: a registry of `{ key, label, defaultMode, runKinds }`. It is empty in production in this issue; tests use a fixture technique. #747, #749, #750 and #751 each add their keys to this file, in chain order.
  - contracts for the report, settings and mode bodies;
  - `assignArm(cardId, technique, bSharePercent)`.

## API

- **Assignment** (`apps/api/src/board/board-rounds.service.ts`, beside `this.tokenSaver.launch` at `:663`):
  - At a card's first round, for every registered technique, the API reads the mode. `ab` draws an arm (D10); `on` → `b`; `off` → `a`. It inserts `card_technique_arms` with `ON CONFLICT DO NOTHING`.
  - Later rounds read the stored arms.
  - A technique registered after the card's first launch gets no arm. That card runs it per the current mode and is excluded from that technique's report (Open questions).
  - The launch sends `tokenSaver.techniques` only to a runner advertising `tokenEconomy: true`, and writes `runs.techniques`.
- **`GET /projects/:projectId/token-economy/report?from&to`** (any member). For each technique and arm:
  - settled cards (`prState` merged or closed, or the card archived), merged cards;
  - $/successful card with a 95 % bootstrap CI over cards (D1; see Open questions for the numerator);
  - the rates of signals a, c and d, with Wilson 95 % CIs; mean rounds (b) with a bootstrap CI;
  - `enoughData`: both arms ≥ the threshold of settled cards;
  - `worsens`: the list of signals whose B interval lies entirely on the worse side of A's point estimate.

  Also included: the project's B share and each technique's mode.
- **`PUT /projects/:projectId/token-economy/settings`** (`@ProjectRole('admin')`): `{ bSharePercent }`, validated `@IsInt @Min(0) @Max(100)`.
- **`PUT /projects/:projectId/token-economy/techniques/:technique`** (`@ProjectRole('admin')`): `{ mode: 'off' | 'ab' | 'on' }`. An unknown technique is a 404. Each change writes an audit event.
- **Re-priced estimate:**
  - `inputPricesOfRuns` and `savedOf` in `apps/api/src/token-saver/token-saver-facts.ts:140-190` are replaced by `cachePricesOfRuns`, which gives the `cacheWrite5m`, `cacheWrite1h` and `cacheRead` prices of the session model.
  - A per-row `turnsRemaining` comes from SQL over `llm_requests` and `session_compactions` of the run's session.
  - The shared pure `estimateUsdSaved(tokens, { write, read }, turnsRemaining)` replaces the input-price version in `packages/shared/src/token-saver/estimate.ts:19-25`.
  - Fallback (D6): `turnsRemaining` = half the run's main-loop requests, rounded down. A run with no requests prices at the cache write only.
  - `TokenSavedView` is unchanged in shape (`estimateTokens`, `estimateUsd`).
- **Retries:** `TokenSaverSink.store` (`apps/api/src/token-saver/token-saver-sink.ts:64-94`) increments `runs.retries` by the number of newly inserted `bypassed` rows per known run. It counts only rows actually inserted, never skipped duplicates.

## UI

All components come from glass-ui (ADR-0011).

- **Card badge** (`apps/web/src/components/token-saver/saved-badge.tsx`, label in `apps/web/src/lib/token-saver/format.ts:99-104`):
  - `saved ≈ 42k tok · $0.13`;
  - a sub-cent value stays `<$0.01` after the tokens;
  - the title explains the pricing (cache write + reads over the remaining turns).

  The card face is `apps/web/src/components/board/card-face.tsx:178-192`. PR #739 (C-304), which changed this badge's slot in the card header, **has merged** into `develop` (6b03ff4f), so there is no dependency. The slot keeps #739's `min-w-0 truncate` behaviour.
- **Token saver page** (`apps/web/src/app/(app)/projects/[projectId]/token-saver/page.tsx`): a new top section, "Techniques":
  - one row per technique: its mode, the A/B settled and merged counts, $/successful card A vs B with intervals, and the four signals with intervals;
  - an "Enough data" or "Collecting" badge;
  - a warning on any signal in `worsens`;
  - for admins, **Enable for all** (mode `on`, with a confirmation that names the signals) and **Stop** (mode `off`).

  The existing tiles and cost per round follow below.
- **Settings → Token saver tab** (`apps/web/src/app/(app)/projects/[projectId]/settings/token-saver-tab.tsx`): "Share of cards in test arm B" (0–100 %). An admin edits it; everyone else sees it read-only.
- `docs/ui/screens.md`: update the Board → Card, Project → Token saver and Settings → Token saver rows.

## Configuration

No environment variables. The enough-data threshold is a shared constant, `TOKEN_ECONOMY_MIN_CARDS_PER_ARM` (default 30).

## Acceptance criteria

- [ ] A card's first round writes one `card_technique_arms` row per registered technique. A second round reads them unchanged, even after the B share or a mode changed (fixture technique).
- [ ] With B share 0, every `ab` card is `a`; with 100, every one is `b`. Over 1,000 card ids at 50 %, the split is within 45–55 %.
- [ ] `runs.techniques` holds the flags launched. A runner without `tokenEconomy` gets no `techniques` field, and its launch is not refused.
- [ ] The runner accepts `techniques` on `card.run` and passes them into `TokenSaverLaunchInput`. An unknown key is refused by the strict schema.
- [ ] `run_usage_facts` for a card run matches `usageByRun`, plus its subagent sessions' requests. It has the compactions within the run's window, the peak context and the turns. The 5m and 1h writes are apart.
- [ ] A newly inserted `bypassed` stats row of a known run increments `runs.retries` once. A resent batch does not.
- [ ] The report gives, per technique and arm: settled and merged cards, $/successful card with a CI, and the four signals with CIs. `enoughData` is false below the threshold in either arm, and `worsens` lists a signal whose B interval lies wholly on the worse side.
- [ ] **Authorization:** `GET /projects/:projectId/token-economy/report` for project P, by a member of project Q only, is refused. A member of P never sees cards, runs or arms of Q (e2e).
- [ ] **Authorization:** the settings and technique `PUT`s are refused for an operator and for a viewer of the project, and allowed for its admin. An admin of another project is refused (e2e).
- [ ] A re-priced estimate: 10,000 tokens, write $3.75/M, read $0.30/M and 20 turns remaining give $0.0975, against $0.03 at the old input pricing. Fallback rows use half the run's main-loop requests.
- [ ] The card badge reads `saved ≈ 42k tok · $0.13` for `{ estimateTokens: 42000, estimateUsd: 0.13 }`, and `saved ≈ 900 tok · <$0.01` for a sub-cent one.
- [ ] Enable for all and Stop are visible to admins only. After Enable for all, a new card's arm is `b` with mode `on`.
- [ ] `docs/specs/445-token-saver.md` notes that D12 and D13 are amended by ADR-0074 (landed with the docs pull request).

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i746-api | schema, migration, shared contracts and estimate, assignment, facts, quality join, report and admin endpoints, 445 amendment note | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261231000007_token_economy_metrics/**, packages/shared/src/token-economy/**, packages/shared/src/token-saver/estimate.ts, packages/shared/src/token-saver/contracts.ts, packages/shared/src/protocol/commands/cards.ts, packages/shared/src/protocol/capabilities.ts, packages/shared/src/index.ts, apps/api/src/token-economy/**, apps/api/src/token-saver/token-saver-facts.ts, apps/api/src/token-saver/token-saver-sink.ts, apps/api/src/token-saver/token-saver.service.ts, apps/api/src/history/run-usage.ts, apps/api/src/board/board-rounds.service.ts, apps/api/src/app.module.ts, docs/specs/445-token-saver.md | — | yes | opus |
| i746-runner | accept and pass `techniques`, advertise `tokenEconomy` | apps/runner/src/cards/launch.ts, apps/runner/src/cards/launch.spec.ts, apps/runner/src/launch/token-saver.ts, apps/runner/src/launch/token-saver.spec.ts, apps/runner/src/detect/capabilities.ts | i746-api (contract in `cards.ts`, `capabilities.ts`) | no | sonnet |
| i746-web | badge, Techniques section, B-share field, screens.md | apps/web/src/components/token-saver/**, apps/web/src/lib/token-saver/**, apps/web/src/app/(app)/projects/[projectId]/token-saver/**, apps/web/src/app/(app)/projects/[projectId]/settings/token-saver-tab.tsx, apps/web/src/components/board/card-face.tsx, docs/ui/screens.md | i746-api (contracts in `packages/shared/src/token-economy/`) | no | opus |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma, migrations | i746-api | no other slot of #746 opens them. #752 (independent) edits other models in parallel: the second to merge runs `git merge origin/develop` |
| packages/shared/src/protocol/commands/cards.ts, capabilities.ts | i746-api | runner and web import, never edit |
| packages/shared/src/token-saver/contracts.ts | i746-api | — (#748 edits it after this merges) |
| apps/api/src/token-saver/token-saver-facts.ts | i746-api | — (#748 edits it after this merges) |
| apps/runner/src/launch/token-saver.ts | i746-runner | #747 and #749 add techniques here after this merges |
| apps/web/src/components/board/card-face.tsx | i746-web | — (#750 edits it after the chain reaches it) |
| apps/api/src/board/board-rounds.service.ts | i746-api | #747, #750 and #751 edit it in chain order after this merges |
| apps/api/src/app.module.ts | i746-api | #752 adds one import line in parallel: the second to merge resolves it |
| docs/ui/screens.md | i746-web | append only; merge one PR at a time |

## Risks

- **High: too few cards for a verdict.** A project with a handful of merged cards a week needs weeks to reach 30 per arm. Mitigation: the enough-data marker; no auto-enable; the report states the counts.
- **Medium: arm A forgoes a working saving during the test.** This is the stated cost of ADR-0074. Mitigation: the B share is adjustable, and Enable for all ends a test.
- **Medium: the window join splits requests between rounds by time** (`run-usage.ts:41-42`). Requests between rounds belong to no run. Mitigation: the facts count the same requests `usageByRun` does, so the views agree.
- **Medium: subagent sessions' requests are not in `usageByRun` today.** Mitigation: the facts add them through `parentSessionId` and report `subagentCostUsd` apart, so the two figures can be reconciled.
- **Medium: the signals are proxies.**
  - A `ci_fix` round is also started for a merge conflict, not only a red check. [Unknown] whether a round records which. Default: both count against signal (a).
  - A review return outside Nautelle is invisible.
- **Low: independent randomisation hides interactions** between techniques. Mitigation: the report states the other techniques' arm mix per arm.
- **Low: the estimate rises sharply on existing cards** after the re-pricing. Mitigation: it keeps "≈", and the title explains the pricing.
- **Model.** i746-api and i746-web are opus. The statistics (bootstrap and Wilson intervals, the `worsens` rule), the materialisation trigger and the report layout leave design choices a sonnet run would have to invent.

## Open questions

- **$/successful card numerator.** Default: the total billed cost of all settled cards in the arm ÷ the merged cards in the arm, so failed cards count against the technique. The median cost of merged cards is shown beside it.
- **Enough-data threshold.** Default: 30 settled cards per arm.
- **Rollback on a worsened signal** (D3 "is rolled back"). Default: the report flags it and an admin presses **Stop**. There is no automatic rollback.
- **A technique registered after a card's first launch.** Default: no arm; the card follows the current mode and is excluded from that technique's report.
- **Enable for all on cards already in arm A.** Default: they keep arm A (sticky) until they settle.
- **Default B share.** Default: 50 %.
- **Fallback when a run has no requests.** Default: price at the cache write only (0 turns remaining).
- **"Re-ran unfiltered" includes a first run with `NAUTELLE_RAW=1`.** Default: yes. Every bypassed row counts as a retry.
