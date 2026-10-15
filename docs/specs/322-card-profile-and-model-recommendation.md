# Pick the Claude profile and the model when a card runs or designs

Issue: [#322](https://github.com/AndreyBegma/AgentDock/issues/322) ·
Decision: [ADR-0032](../adr/0032-a-cards-model-is-recommended-by-a-runner-side-assessment.md)

## Summary

Today, a board card's work round and its design turns run on a profile and a
model the person never sees at the moment of launch. The profile comes from
the orchestrator settings or the project default. The model comes from a
free-text field buried in the card form, else the project's orchestrator
model. The product owner asked (2026-10-15) that **Run** and **Design**
(Generate / Revise) let the person pick:

- the **Claude runtime profile** that runs it;
- the **model**, from a selector that **defaults to a recommended model**.

The recommendation comes from an analysis of the task, and the selector names
it as a suffix: `Opus 5.5 (recommended)`. The analysis is a `haiku` call on
the project's runner, in the pattern ADR-0027 set for text normalization.

## Scope

### In scope

- A launch popover on **Run** / **Run again** and on the card's design
  **Generate** / **Revise**: a profile select, a model select, and the action
  button.
- The card remembers the person's profile and model choice (overrides). Auto
  starts (#273 auto-run, `continueAfterDesign`) use the remembered choice.
- A runner command `card.assess` and an API job that store one recommendation
  per card for work and one for design, each with a one-line reason.
- A shared model catalog: aliases, display labels, and order.
- The card form's free-text **Model** field becomes the same select.

### Out of scope

- Plan tasks, the Planner composer and skill runs. They already pick a profile
  and a model; adding the recommendation there is a follow-up.
- Codex profiles. Card workers and design turns are Claude-only: the profile
  rule refuses with `not_claude` [Confirmed `packages/shared/src/readiness/pick-profile.ts`].
- Permission mode in the popover. It stays where it is.
- Recommending an effort level or a `[1m]` context variant.
- Re-assessing cards saved before this change, until they are next edited.

## Decisions

- **D1 — Launch popover.** **Run**, **Run again**, **Generate** and **Revise**
  on a card open a small popover:
  - `Profile`: the project runner's Claude profiles from
    `GET /projects/:id/runtime-profiles`, shaped like the skill run dialog
    (`profileOptionLabel`, `defaultProfileOptionLabel`, `runProfileReason`).
  - `Model`: the catalog (D4).
  - The action button.

  One click on the action button with the defaults starts as before. The
  popover adds a click; it does not add a step that blocks anything.
  (Product owner, 2026-10-15; pattern from the skill run dialog
  `apps/web/src/app/(app)/projects/[projectId]/skills/run-dialog.tsx`
  [Confirmed].)
- **D2 — Defaults.**
  - Profile: the card's `profileKey`, else the resolver's pick (#272 D1:
    orchestrator profile, else project default).
  - Model: the card's `model`, else the recommendation for that action (work
    or design), else the project's orchestrator model, else
    `ORCHESTRATOR_DEFAULTS.model`.

  The option that equals the recommendation carries ` (recommended)`. A
  hover or `title` shows its reason.
- **D3 — The choice is remembered only when it differs.** A launch sends
  `profileKey` and `model`. The API stores each on the card **only when it
  differs from what D2 would have picked without the card override**, so a
  card that follows the recommendation keeps following it after an edit
  re-assesses it.
  - Work and design share the card's `profileKey`.
  - The model override is separate: `model` (work, existing column) and
    `designModel` (new).
  - Choosing the default option in the card form clears the override
    (`null`). This is the existing `model: null` semantics [Confirmed
    `apps/api/src/board/dto.ts`].
- **D4 — Model catalog in `packages/shared`.** `CLAUDE_MODELS`, an ordered
  list of `{ alias, label }`:

  | alias | label |
  |---|---|
  | `opus` | Opus 5.5 |
  | `sonnet` | Sonnet 5.5 |
  | `haiku` | Haiku 5.5 |
  | `fable` | Fable 5.1 |

  - What is sent and stored stays the **alias**, as everywhere today
    (`ORCHESTRATOR_DEFAULTS.model = 'opus'`, `SKILL_MODELS`) [Confirmed].
  - The label is display only and is updated when the aliases move.
  - `SKILL_MODELS` in web is replaced by the catalog.
  - A stored value that is not in the catalog (a full id such as
    `claude-opus-5-5`, or `opus[1m]`) is shown as its own option, so nothing
    is silently changed.
- **D5 — Recommendation by a runner-side assessment (ADR-0032).**
  - A new typed command `card.assess` (ADR-0010) runs headless `claude -p` with
    `haiku`, no tools, `--permission-mode plan`, the prompt on stdin, in a run
    directory outside watched roots, `AGENTDOCK_HOOKS=off` — exactly as
    `text.normalize` does. The API builds the prompt and parses the answer;
    the runner does not interpret it [Confirmed pattern
    `packages/shared/src/protocol/commands/text.ts`].
  - It is advertised by the runner (ADR-0023), and each call is a `runs` row
    of new kind `card_assess`, priced through the API-assigned session id
    (ADR-0009).
- **D6 — What is assessed, and when.**
  - Input: the card's title, body, kind, attachment names and kinds (not
    contents), whether a design is approved, and the latest round's feedback
    if any.
  - Answer: strict JSON
    `{ "work": { "model", "reason" }, "design": { "model", "reason" } }`.
  - `model` is one of `opus | sonnet | haiku`. `fable` is never recommended
    (Assumption A1). `reason` is at most 160 characters, in English.
  - The guidance in the prompt follows the fleet's own rule, from the
    `cs-spec` model rule:
    - `opus` when the task still has to **decide** (unclear scope, schema,
      boundaries, cross-module change, a bug without a cause);
    - `sonnet` when it **executes** a clear decision;
    - `haiku` for trivial edits (copy, a constant, a one-file mechanical
      change).

    For design, the prompt chooses between `opus` and `sonnet` only.
  - Trigger: a BullMQ job (ADR-0015) on card create and on any change of the
    hashed input. It is chained **after the save's normalization settles**
    (applied, skipped or failed), so one save costs at most one assessment.
  - The result is applied only if the card still hashes to what was asked
    (the ADR-0027 D4 rule).
- **D7 — Without a recommendation, nothing waits.** In each of these cases
  the card has no recommendation, the selector has no `(recommended)` option,
  and D2 falls through to the project model:
  - the runner is offline;
  - the runner is older than the command;
  - the project has no Claude profile;
  - a budget's hard stop;
  - the call failed or answered out of contract.

  The popover shows "No recommendation yet" in muted text. Launch is never
  blocked on an assessment.
- **D8 — Bounds.** At most two assessments run per project at once (the
  normalization bound). A card is not re-assessed while a round of it is
  active. No per-project switch in this issue (Open question Q1).
- **D9 — Authorization.**
  - `profileKey` must name a profile of the project's runner. The resolver's
    explicit-key path (`RuntimeProfileResolver.resolve({ key })`) already
    refuses an unknown key or a non-Claude one with `422 no_profile`
    [Confirmed `apps/api/src/readiness/runtime-profile.resolver.ts`].
  - Launch keeps `ProjectRole('operator')`.
  - The recommendation is read with the card; nothing new is exposed across
    projects.

## Data / Schema

`apps/api/prisma/schema.prisma`, one migration
`apps/api/prisma/migrations/20261122000000_card_profile_and_model_recommendation/`:

- `enum RunKind`: add `card_assess`.
- `model BoardCard`, new columns (all nullable):
  - `profileKey String?` — D3 override, shared by work and design.
  - `designModel String?` — D3 design override.
  - `recommendedModel String?`, `recommendedReason String?` — D6 work.
  - `recommendedDesignModel String?`, `recommendedDesignReason String?` — D6
    design.
  - `assessmentHash String?`, `assessedAt DateTime?`, `assessRunId String?`
    — D6 hash gate and the last call.

## API

- `POST /board/cards/:number/run` (`RunBoardCardDto`): add optional
  `profileKey` (`profileKeySchema` shape). `model` exists. D3 decides what is
  stored.
- Card design **generate** / **revise**
  (`apps/api/src/design/card-design.controller.ts`): their request DTOs gain
  optional `profileKey` and `model`. `CardDesignTurnService.start` takes them,
  falling back per D2 with `designModel` and the design recommendation.
  Today it reads `card.model` and the resolver default [Confirmed
  `apps/api/src/planner/card-design-turn.service.ts`].
- `BoardRoundsService.start`: `profiles.require(project, { key })` with the
  request key ?? `card.profileKey`. Today it passes `{}` [Confirmed].
- Auto-run and `continueAfterDesign` starts use the card's overrides, then D2.
- The board card view (`board-mapper.ts`) gains:
  - `profileKey`, `designModel`;
  - `recommendation: { work: { model, reason } | null, design: { model, reason } | null, assessedAt }`.
- `AssessModule` (`apps/api/src/assess/`): the BullMQ queue, the job, the
  prompt builder and the parser.
  - It is **`@Global()` and imported only by `AppModule`, late in its list**,
    per the TextModule pattern. If a feature module imports a
    `ConditionalModule.registerWhen` queue, e2e boots fail with the 5 s
    config timeout (seen on #302, #320).
  - It listens for the normalization-settled signal of a card save.
- Error words: the existing `no_profile` and `runner_outdated`. Nothing new.

## UI

- `apps/web/src/components/board/`:
  - a `LaunchPopover` used by the card sheet's Run section and by the design
    viewer's Generate / Revise when the design's owner is a card;
  - the card form's **Model** text input becomes the catalog select, whose
    first option is "Recommended — Opus 5.5" or "Project default — …";
  - a **Profile** select is added next to it.
- Plan-task designs keep their current controls: the Planner owns them
  (ADR-0025).
- Labels follow glass-ui: popover, select, hint. A missing glass-ui part is
  added to glass-ui, not here (ADR-0011).
- `docs/ui/screens.md`: rows for the popover and the card form change.

## Configuration

None. The assessment uses the project's Claude profile (D2 resolver) and
`haiku`.

## Acceptance criteria

- [ ] On a card with no overrides and a recommendation `sonnet`:
  - Run opens a popover whose model select shows `Sonnet 5.5 (recommended)`
    selected and whose profile select shows the resolver's profile;
  - starting it records `runs.model = 'sonnet'` and leaves `board_cards.model`
    null.
- [ ] Choosing `Opus 5.5` instead stores `board_cards.model = 'opus'`. The next
  round, including an auto-run, uses `opus` even after the recommendation
  changes.
- [ ] Choosing a non-default Claude profile starts the round with that
  `profileKey` (`card.run` args and `runs.profileKey`) and stores it on the
  card. A design Generate afterwards defaults to that profile.
- [ ] A `profileKey` of a Codex profile, or a key not on the project's runner,
  is refused `422 no_profile`. Nothing is stored and no run row is created.
- [ ] Design Generate defaults to the design recommendation. Picking a model
  stores `designModel` and leaves `model` untouched.
- [ ] Editing a card's body enqueues exactly one `card_assess` run after its
  normalization settles. An edit made while it runs makes its answer
  discarded (hash gate).
- [ ] An answer that is not the JSON contract, or names a model outside
  `opus|sonnet|haiku`, stores nothing. The `runs` row ends `failed` and the
  popover shows "No recommendation yet".
- [ ] With the runner offline, or older than `card.assess`, Run and Generate
  still start, defaulting to the card or project model.
- [ ] A stored model outside the catalog (e.g. `claude-opus-5-5`) appears
  selected as its own option and is not rewritten on save.
- [ ] **Authorization:** a viewer without operator role on the project gets
  `403` from run, generate and revise with `profileKey`. A card of project B
  is not reachable through project A's routes.
- [ ] Runner: `card.assess` is advertised. Its handler runs `claude -p --model
  haiku` with no tools and plan mode, in a run directory outside watched
  roots, and returns the stdout as `card_assess.finished`. Unit-tested like
  `normalize/executor.spec.ts`.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i322-contract | schema, migration, shared contracts, model catalog, compile fixes | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261122000000_card_profile_and_model_recommendation/**, packages/shared/src/models/**, packages/shared/src/protocol/commands/assess.ts, packages/shared/src/protocol/events/assess.ts, packages/shared/src/protocol/index.ts, packages/shared/src/board/**, packages/shared/src/index.ts, packages/shared/src/design/contracts.ts | — | yes | opus |
| i322-runner | `card.assess` handler and its allowlist entry | apps/runner/src/assess/**, apps/runner/src/commands/handlers.ts, packages/shared/src/protocol/commands.ts | i322-contract | no | sonnet |
| i322-api | assessment job, launch overrides, design turn overrides | apps/api/src/assess/**, apps/api/src/app.module.ts, apps/api/src/board/**, apps/api/src/planner/card-design-turn.service.ts, apps/api/src/design/card-design.controller.ts, apps/api/src/design/dto.ts, apps/api/src/text/** | i322-contract | no | opus |
| i322-web | launch popover, card form selects, catalog in web | apps/web/src/components/board/**, apps/web/src/components/design/design-viewer.tsx, apps/web/src/lib/design/use-design.ts, apps/web/src/lib/board/**, apps/web/src/lib/skills/format.ts, apps/web/src/components/planner/composer.tsx, apps/web/src/app/(app)/projects/[projectId]/skills/run-dialog.tsx, docs/ui/screens.md | i322-contract | no | sonnet |

`i322-api` and `i322-runner` run in parallel. The API refuses `card.assess` on
an old runner (ADR-0023), so the order of their merges does not matter.
After both land: runner release 0.8.0.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma + the migration | i322-contract | do not open it |
| packages/shared/src/protocol/commands.ts (allowlist) | i322-runner | do not open it |
| apps/api/src/app.module.ts | i322-api | do not open it |
| docs/ui/screens.md | i322-web | do not open it |
| apps/web/src/lib/skills/format.ts (`SKILL_MODELS` → catalog) | i322-web | do not open it |

## Risks

- **Medium — labels drift from aliases.** `opus` resolves on the runner's
  Claude Code version; the label `Opus 5.5` is a display claim. *Mitigation:*
  one table in shared, updated in the change that moves the default
  generation; the stored value stays the alias.
- **Medium — cost of assessments.** One `haiku` call per content-changing
  save. *Mitigation:*
  - the hash gate;
  - chaining after normalization;
  - two at a time per project;
  - the budget hard stop;
  - Q1 adds a switch if needed.
- **Low — a bad recommendation.** It is a default, never a constraint, and it
  carries its reason.
- **Medium — ConditionalModule boot timeout** if `AssessModule` is imported by
  a feature module. *Mitigation:* D-API note above; put it in the api brief.
- **Low — normalization chaining.** If the normalization-settled signal is
  not a clean seam in `apps/api/src/text/`, i322-api owns that seam. That is
  why it owns `apps/api/src/text/**` and is `opus`.

## Open questions

- **Q1 — A per-project switch for the assessment?** Default: none. The budget
  hard stop is the brake. Add `assessEnabled` to project settings if the cost
  shows up.
- **Q2 — Recommend in the Planner and skill runs too?** Default: not in this
  issue. The catalog and popover are built to be reused.
- **A1 (assumption) — `fable` is selectable but never recommended.** Its
  cost/benefit for card work is not established in `docs/`.

Depends on #282 (closed) · #309 (closed)
