# Model and effort by card type, with an escalation to Opus

Issue: #750 · Epic: [#745](745-token-economy.md) · Technique key: `model-by-type` ·
Builds on: [#322](322-card-profile-and-model-recommendation.md) (ADR-0032),
[#663](663-token-saver-v2.md) (ADR-0068 §5) ·
Decision record: [ADR-0076](../adr/0076-a-cards-model-and-effort-follow-its-class-and-stay-fixed-per-session.md)
(landed with this spec's docs pull request) — amends ADR-0032 §2 and §4

## Summary

Card rounds run on `opus` unless the #322 assessment or the person says
otherwise, and the #663 assessment already recommends an effort next to the
model [Confirmed `packages/shared/src/assess/contract.ts`,
`apps/api/src/board/launch-choice.ts:24-34`]. The assessment's rule is
free-form ("opus when the task still has to decide …"), and a sonnet round
that turns out to be out of its depth has no way back except a person
noticing.

This issue turns the recommendation into a **classification by card type**
with a fixed list of *deciding* signals, maps the class to a model and an
effort, lets a sonnet round **ask for Opus** (it is then relaunched on Opus in
a fresh session), and makes model and effort **fixed for the life of a Claude
session**. The class mapping and the escalation are a technique behind the
per-card A/B flag `model-by-type` from #746; the session lock applies to both
arms.

## Scope

### In
- The `card.assess` answer gains a class (`mechanical | deciding | unsure`)
  and the deciding signals it found.
- A deterministic class → model + effort mapping in the API, used in the B
  arm of `model-by-type`.
- Shown in the launch popover: the class, the signals and the reason. The
  person can still override model and effort on the card (#322 D3 unchanged).
- An escalation tool for the card worker, `escalate_card`, offered only on a
  non-Opus round in the B arm, and an automatic relaunch of the card on Opus.
- The session lock: a round whose resolved model or effort differs from the
  model or effort its card session was started with starts a fresh session.
  It never resumes that session on another model or effort.
- Card rounds only (work rounds and CI-fix rounds). Manual and `/cs-eco`
  sessions keep the model the person chose.

### Out
- Design turns, Planner, spec and assess runs (decisions, Q-scope). The design
  recommendation of #322 D6 is unchanged.
- `fable`, `[1m]` variants, and the efforts `xhigh` and `max`
  (`CARD_EFFORTS` stays `low | medium | high`
  [Confirmed `packages/shared/src/assess/limits.ts:27`]).
- An advisor pattern (a Sonnet executor that consults Opus). It is cited in
  the evidence but was not decided.
- A person who types `/model` or `/effort` in an attached terminal. Nautelle
  does not control that, and the round's `runs.model` keeps what was launched.
- Retuning the class rule from data. The A/B report (#746) is where that
  happens.

## Decisions

| # | Decision | Source |
|---|---|---|
| D1 | **Classes.** The assessment classifies the card's work as `mechanical` (it executes a clear decision), `deciding` (it still has to decide), or `unsure`. An answer out of contract, a missing assessment (#322 D7), or a stale hash counts as `unsure`. | person, 2026-10-21 (Q-model) |
| D2 | **Deciding signals**, a closed list. Any one of them makes the class `deciding`, whatever the model said: `schema` (a database schema, a migration, or a stored format), `auth` (authentication, authorization, roles), `tenancy` (data isolation between projects, organizations or users), `payments` (billing, prices, budgets that stop spend), `deletion` (deleting or purging stored data, or a destructive git operation), `bug_cause_unknown` (a `bug` card whose root cause is not shown in the card), `no_precedent` (no existing pattern in the project to follow). | person, 2026-10-21 |
| D3 | **Mapping (B arm).** `deciding` → `opus` at `high`. `unsure` → `opus` at `medium`. `mechanical` → `sonnet` at the assessed effort, capped at `medium`. A `ci_fix` round keeps `sonnet` at `low` (ADR-0068 §5, `CARD_CI_FIX_*`) in both arms. `haiku` is never the result of the mapping. A person can still pick it. | person, 2026-10-21 (Q-model: "unsure → Opus"); effort values *default*, Open question Q2 |
| D4 | **The A arm is today.** In the A arm the launch defaults stay exactly as `defaultCardLaunch` computes them now: the recommendation's model and effort, else the project model. The assessment still stores the class in both arms, so the report can compare the arms by class. | decisions Q-proof; *default* |
| D5 | **The person overrides on the card.** The #322 D3 rule holds: a choice in the launch popover is stored only when it differs from what the mapping (B) or the recommendation (A) would pick. An override always wins over the mapping. | person, 2026-10-21; #322 D3 |
| D6 | **Effort is passed at launch with `--effort <level>`.** [Confirmed] `claude --help` of the installed Claude Code 2.1.306 lists `--effort <level>` (low, medium, high, xhigh, max), and the runner already passes it after `--model` (`apps/runner/src/cards/launch.ts:98-99`) to a runner that advertises `cardEffort`. [Reported] The installed binary's settings schema also has `effortLevel` (low, medium, high, xhigh) and a `maxEffortLevel` cap, and it reads an env `CLAUDE_CODE_EFFORT_LEVEL` that "overrides this session". [Unknown] Which of flag, env and profile settings wins when more than one is set. The runner slot checks this on the installed CLI. When the profile's own settings or env could override the flag, the launch also sets `CLAUDE_CODE_EFFORT_LEVEL` to the same value, so the value Nautelle chose is the one that takes effect. | person, 2026-10-21; #663 |
| D7 | **Never mid-session.** Model and effort are chosen when a Claude session starts, and they stay fixed for that session. The API stores the pair the card's current session was started with. A later round whose resolved pair differs starts a **fresh session**, seeded through the existing handoff path (ADR-0042 `fresh` mode: note, diff, checklist). It is never `--resume` with another `--model` or `--effort`. The old session is kept (ADR-0042 §2). This holds in both arms. | person, 2026-10-21 (Q-model); research: model changes break the cache [Reported] |
| D8 | **The escalation signal.** It is explicit and has one source. A non-Opus card round in the B arm gets a runner MCP tool `escalate_card({ reason, note })`, with `reason` ∈ `misclassified` (the task needs decisions the card did not show) or `gave_up` (the worker cannot finish it at this model), and `note` of at most 2,000 characters on what it found and why. The worker prompt tells it to call the tool instead of guessing at a decision in D2's list. Calling it ends the round like `finish_card` does: the runner stops the session after the tool answers. A session that just ends, a crash, a budget stop or a refused `finish_card` is **not** an escalation (Open question Q1). | person, 2026-10-21 ("gives up / reports misclassified"); signal definition *default* |
| D9 | **The relaunch.** On an escalation the API: (1) marks the round `finishedBy: worker` with `escalation` set; (2) sets the card's class to `deciding` and stores the reason and note; (3) unless D10 applies, starts a new round with trigger `escalation`, model `opus`, effort `high`, in a fresh session (D7), with the note added to the round prompt as the previous worker's finding. Branch, worktree and draft PR are kept. The budget gate and the agent limit apply as for any start. A card escalates at most **once**. An Opus round never gets the tool. | person, 2026-10-21; once-only *default* |
| D10 | **A person's override is not overruled.** When the round's model came from a person's override (`board_cards.model` set), the escalation does not relaunch. The card shows "The worker asks for Opus: <reason>" with **Run on Opus**, and waits in Finished. | *default* (Open question Q3) |
| D11 | **Quality is measured, not assumed.** An escalated card counts its escalation round in "rounds per card" (#746 quality signals). The report shows escalations per arm. If `model-by-type` worsens any of the four signals, it is rolled back, as for every technique. | decisions Q-quality |
| D12 | **Authorization.** Launch keeps `ProjectRole('operator')`. **Run on Opus** is a launch and needs the same role. The class and the escalation are read with the card. Nothing new is exposed across projects. | #322 D9 |

## Data / Schema

`apps/api/prisma/schema.prisma`, one migration
`apps/api/prisma/migrations/20261231000009_card_model-by-type/`. The newest on
develop is `20261231000006_project_github_repo_id`; the epic orders the stamps
(#746 `…07`, #748 `…08`, this issue `…09`, #751 `…10`, #752 `…11`). If
`develop` already has a later stamp when the branch is cut, take the next free
one and keep the name.

- `enum CardWorkClass { mechanical deciding unsure }`.
- `enum CardEscalationReason { misclassified gave_up }`.
- `enum CardRoundTrigger`: add `escalation`.
- `model BoardCard`, new nullable columns:
  - `workClass CardWorkClass?`, `workSignals String[] @default([])`: from the
    latest assessment (D1, D2), stored in both arms;
  - `sessionModel String?`, `sessionEffort CardEffort?`: the pair the current
    `sessionId` was started with (D7). They are null for a card with no session, and
    for a session started before this change. A null pair is treated as matching,
    so existing cards keep resuming;
  - `escalatedAt DateTime?`, `escalationReason CardEscalationReason?`,
    `escalationNote String?` (D9).
- `model BoardCardRound`: `escalation CardEscalationReason?` on the round
  that called the tool.

## API

- **Assessment** (`apps/api/src/assess/`):
  - the prompt (`assess-input.ts`, `INSTRUCTIONS`) adds D2's list with one
    line per signal, and asks for `class` and `signals`;
  - the shared contract (`packages/shared/src/assess/contract.ts`) adds to
    `work`: `class: enum`, `signals: enum[]`, with at most 7 signals and no duplicates.
    This is a breaking change of the answer contract. An answer without the fields
    is out of contract and counts as `unsure` (D1), never as failure of the launch;
  - the sink stores `workClass` and `workSignals`. A non-empty `signals` with
    `class: mechanical` is stored as `deciding` (D2).
- **Launch** (`apps/api/src/board/launch-choice.ts`): a pure
  `modelByType(class, assessedEffort, ciFix)` → `{ model, effort }` (D3), used
  by `defaultCardLaunch` when the card's `model-by-type` arm is B (#746's
  per-card arm lookup). It is unit-tested against every class and signal.
- **Session lock** (`apps/api/src/board/board-rounds.service.ts`, around the
  current `resume` computation): when `sessionModel`/`sessionEffort` are set and
  differ from the resolved pair, the round is sent with the handoff's forced
  fresh start (contract field `session.fresh: true`, see the contract slot),
  and the card's session pair is updated when the round starts.
- **Escalation**:
  - a local method `card.escalate` (`packages/shared/src/protocol/local.ts`,
    shaped like `card.finish`: the card comes from the session id, never from
    an argument);
  - `apps/api/src/local/local-handlers.ts` handles it. It ends the round per
    D9, then calls `BoardRoundsService.start` with trigger `escalation`, or
    shows the D10 state;
  - it is refused with `not_escalatable` on an Opus round, on a card that
    already escalated, or in the A arm;
  - an audit/activity entry `card.escalated` with reason and model.
- **Card view** (`board-mapper.ts`): `recommendation.work` gains `class` and
  `signals`; the card gains `escalation: { reason, note, at } | null`.
- **Launch command**: `cardRunArgsSchema` gains `session.fresh?: boolean`
  (sent only to a runner that advertises the capability `cardFreshStart`), and
  `escalate?: true`, which tells the runner to offer `escalate_card`. Both go
  through the runner's capability advert (ADR-0023). An older runner gets neither.
  The lock then degrades to resuming, and the escalation is not offered.

## UI

glass-ui components only (ADR-0011).

- **Launch popover** (`apps/web/src/components/board/launch-popover.tsx`):
  the recommended option's hint reads, e.g., `Opus 5.5 (recommended) ·
  deciding: schema, auth`, or `Sonnet 5.5 (recommended) · mechanical`. When the
  chosen model or effort differs from the card session's, a muted line says "Starts a
  fresh session (the model or effort changed)".
- **Card sheet** (`card-sheet.tsx`): an escalation row: "Escalated to Opus ·
  misclassified · <note>". In the D10 state, it shows a **Run on Opus** action instead.
- **Card face** (`card-face.tsx`): a small `→ Opus` tag on an escalated card.
- `docs/ui/screens.md`: rows for the popover hint and the card sheet row.

## Configuration

None. The A/B share is #746's project setting. The class mapping is code
(D3).

## Acceptance criteria

- [ ] An assessment answer with `class: mechanical, signals: []` on a `feature` card in the B arm gives a Run default of `sonnet` at the assessed effort, capped at `medium`. The same card in the A arm gets today's `defaultCardLaunch` result. A unit test covers both arms.
- [ ] `signals: ["auth"]` with `class: mechanical` is stored as `deciding` and defaults to `opus` at `high`.
- [ ] A missing, failed or out-of-contract assessment in the B arm defaults to `opus` at `medium` (`unsure`).
- [ ] A `ci_fix` round defaults to `sonnet` at `low` in both arms.
- [ ] A person's model choice in the popover wins over the mapping and is stored only when it differs (#322 D3 test extended).
- [ ] The card launch argv carries `--effort <level>` after `--model`. The runner test for D6 also asserts the effect on the installed CLI (the session's reported effort), not only the flag. The env fallback is set only if the check shows the flag can be overridden.
- [ ] A card whose session started on `sonnet`/`low`, run again with `opus`, starts a fresh session (`restart: fresh`, a new session id). It is never resumed with `--model opus`. The old session stays resumable. `sessionModel` becomes `opus`.
- [ ] A card from before this change (null session pair) resumes as before.
- [ ] A sonnet round in the B arm lists `escalate_card`. An opus round, an A-arm round, and a round on a card that already escalated do not.
- [ ] Calling `escalate_card` with `misclassified` ends the round and starts exactly one new round with trigger `escalation` on `opus`/`high`, in a fresh session whose prompt carries the note. A second escalation on that card is refused `not_escalatable`.
- [ ] A card with a person's `sonnet` override does not relaunch. It shows **Run on Opus**, and that action starts an `opus` round.
- [ ] A session that ends without `finish_card` or `escalate_card` does not escalate.
- [ ] **Authorization:** a viewer of the project gets `403` from **Run on Opus**. A `card.escalate` local call from a session that is not a card session is answered `not_a_card_session`. The card of project B is not reachable through project A's routes (e2e).
- [ ] `bun run check` and `bun run test` pass. The worker prompt version is bumped, and the worker-prompt spec asserts that the escalation text appears only when `escalate` is set.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i750-contract | schema, migration, shared assess contract and limits, launch and local contracts, capability names | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261231000009_card_model-by-type/**, packages/shared/src/assess/**, packages/shared/src/protocol/commands/cards.ts, packages/shared/src/protocol/local.ts, packages/shared/src/protocol/capabilities.ts, packages/shared/src/board/contracts.ts, packages/shared/src/board/types.ts, packages/shared/src/token-economy/techniques.ts (registers `model-by-type`, default mode `ab`) | #749 merged (chain order) | yes | opus |
| i750-api | assessment prompt and sink, class mapping, session lock, escalation handling, card view | apps/api/src/assess/**, apps/api/src/board/launch-choice.ts, apps/api/src/board/launch-choice.spec.ts, apps/api/src/board/board-rounds.service.ts, apps/api/src/board/board-mapper.ts, apps/api/src/board/*.e2e.spec.ts, apps/api/src/local/local-handlers.ts | i750-contract | no | opus |
| i750-runner-web | `escalate_card` tool and stop, forced fresh start, effort verification, worker prompt text, popover, sheet and face | apps/runner/src/mcp/tools.ts, apps/runner/src/mcp/server.ts, apps/runner/src/cards/launch.ts, apps/runner/src/cards/launch.spec.ts, apps/runner/src/handoff/service.ts, apps/runner/src/detect/capabilities.ts, packages/shared/src/board/worker-prompt.ts, packages/shared/src/board/worker-prompt.spec.ts, apps/web/src/components/board/launch-popover.tsx, apps/web/src/components/board/card-sheet.tsx, apps/web/src/components/board/card-face.tsx, apps/web/src/lib/board/**, docs/ui/screens.md | i750-contract | no | opus |

`i750-runner-web` is `opus`: D6's precedence check and the forced fresh path
in `handoff/service.ts` need judgement on the installed CLI. The API refuses
`escalate` and `session.fresh` to a runner without the capabilities, so the
merge order of `i750-api` and `i750-runner-web` does not matter. A runner release
follows both.
The runner advertises the new capabilities in
`apps/runner/src/detect/capabilities.ts` [Confirmed: `cardEffort` is advertised
there].

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma + migration | i750-contract | no other slot of #750 opens it. #752 (independent) edits other models in parallel: the second to merge runs `git merge origin/develop` |
| packages/shared/src/protocol/commands/cards.ts | i750-contract | #746 edited it earlier in the chain; #751 i751-core edits the launch payload after this merges |
| packages/shared/src/protocol/capabilities.ts | i750-contract | #751 i751-core after this merges |
| apps/runner/src/handoff/service.ts | i750-runner-web | #749 owns the resume-by-size logic in `apps/runner/src/handoff/**` and has merged before this issue starts (chain). i750-runner-web adds only the forced-fresh branch |
| apps/runner/src/cards/launch.ts, apps/runner/src/detect/capabilities.ts | i750-runner-web | #746 i746-runner earlier in the chain; #751 i751-runner after this merges |
| packages/shared/src/board/worker-prompt.ts (version bump) | i750-runner-web | #747 bumped it earlier in the chain; i750-runner-web bumps it again |
| apps/api/src/board/board-rounds.service.ts | i750-api | #746 and #747 earlier in the chain; #751 i751-core after this merges |
| apps/api/src/board/board-mapper.ts | i750-api | #748 edits it in a parallel branch: if #748 is still open, the second to merge runs `git merge origin/develop` |
| apps/web/src/components/board/card-face.tsx | i750-runner-web | #746 i746-web earlier in the chain |
| docs/ui/screens.md | i750-runner-web | append rows only |

## Risks

- **High: Sonnet under-classifies a deciding task.** It then makes the
  decision itself, badly, instead of escalating. *Mitigation:* the D2 list
  overrides the model's class; `unsure` → Opus; the tool is
  in the prompt; the A/B quality signals (review returns, rounds) catch it,
  and the technique is rolled back.
- **Medium: an escalation costs two rounds.** It can cost more than starting
  on Opus. *Mitigation:* the report's $/successful card per arm includes the
  escalation rounds.
- **Medium: the fresh session loses context.** *Mitigation:* the ADR-0042 seed
  (note, diff, checklist), and the old session is kept.
- **Medium: effort precedence.** A profile's `effortLevel` or env could
  silently win over `--effort` (D6 [Unknown]). *Mitigation:* the runner test
  asserts the effect on the installed CLI.
- **Low: the contract change breaks old answers.** An old-shape answer counts as
  `unsure` → Opus, which is today's default.

## Open questions

- **Q1: Count a silent give-up?** For example, a round that ends `session_end` with no
  commit beyond its base. Default: no. Only the explicit tool escalates. It is
  revisited if the report shows many such rounds in the B arm.
- **Q2: The effort values of D3.** Default: deciding `high`, unsure `medium`,
  mechanical capped at `medium`. They are tuned from the report, not here.
- **Q3: Relaunch over a person's sonnet override?** Default: no (D10). The card
  waits with **Run on Opus**.
- **Q4: Offer the tool in the A arm too, to compare escalation rates?** Default:
  no. The tool is part of the technique.

## ADR impact

- Amends **ADR-0032 §2**. Under `model-by-type` the class mapping replaces the
  free-form rule, and `haiku` is no longer recommended for card work.
- Amends **ADR-0032 §4**. In the B arm, a card with no recommendation defaults to
  `opus` (`unsure`), not to the project's model.
- Keeps **ADR-0068 §5**: effort is recommended with the model, and CI-fix is
  `sonnet`/`low`.
- New: model and effort are fixed per Claude session, and an escalation
  relaunches on Opus once. Recorded in ADR-0076 with the amendments above.

Depends on #749
