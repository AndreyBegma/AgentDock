# The Planner moves onto the Board: New Card interviews, New Plan makes cards

Issue: [#337](https://github.com/AndreyBegma/AgentDock/issues/337) ·
Decision: [ADR-0034](../adr/0034-the-planner-lives-on-the-board-and-makes-cards.md) (amends ADR-0028)

## Summary

Today a person creates a card by typing a title and a body. The Planner is a
separate page whose tasks reach the Board only as read-only projections
(ADR-0028). On 2026-10-15 the product owner decided:

- **New Card** has no title field. The person writes only **What to do**, in
  any language. The model **interviews** them in that language, one question
  at a time:
  - each question has options, single or multiple choice, and always "Write
    your own";
  - the interview runs until the task is clear, or until the person presses
    **Enough — generate**.
- The model then **generates the card in English**: a title, and a body that
  is a structured mini-spec. The card appears in **Todo**, and from there
  everything works as today: design, discussion, Run.
- **New Plan** is the Planner, now on the Board. It ends in **several cards**
  that carry their dependencies. **Send to fleet** stays as the alternative
  for a large parallel wave.
- **The Planner page leaves the navigation.** Existing plans stay readable.
- **The model** for interviews and plans defaults to a per-account setting
  (`sonnet` out of the box). It can be chosen at each start (`opus`, `fable`,
  …).

## Scope

### In scope

- Card intake:
  - the New Card dialog;
  - the interview;
  - generation;
  - drafts that survive closing the dialog.
- New Plan on the Board, ending in Create cards (with dependencies) or Send to
  fleet.
- Multiple-choice questions and the always-present free answer, for the intake
  and the Planner alike.
- The account setting "Planning model", and the model picker at start.
- Card dependencies: a "Depends on" link and a warning on Run.
- The Planner page removed from navigation, existing plans read-only.

### Out of scope

- Migrating existing plan tasks into cards. They keep their projection
  (ADR-0028) until their plans are closed.
- Automatic chaining (B runs when A completes).
- Editing the interview after generation. The generated card is edited like
  any card.
- Codex runtimes. The intake and the Planner are Claude-only, as today.

## Decisions

- **D1 — One engine.** The card intake is a **plan in a new mode `card`**.
  - It uses the Planner's turn machinery: `plan.turn` on the runner, the
    session resumed per turn, question rounds, the API-built prompt
    (ADR-0019) [Confirmed: `plan.turn` takes the prompt from the API].
  - A `card` plan ends in exactly one card. A `dialogue` or `batch` plan ends
    in N cards.
  - No new runner command for the conversation itself.
- **D2 — New Card dialog.**
  - One field, **What to do**, a large text area with no title, plus
    attachments (#309) and the model picker (D9).
  - **Start** creates the `card`-mode plan and runs its first turn. The
    dialog becomes the interview view.
  - Closing it keeps the intake as a **draft**: a "Drafts" strip on the Board
    above Todo lists open intakes, each with its state ("2 questions waiting",
    "thinking…") and Resume / Discard.
- **D3 — Questions, one at a time.**
  - A round is shown as a stepper: question *k of n*, Previous / Next, and a
    progress dot per question.
  - Each question shows its title, the question, its options and the
    recommendation (with its "why"), as the Planner's question card does
    today.
  - **Write your own** is always offered, even when the model gives options.
  - A question can be **multiple choice** (`multiple: true`): checkboxes,
    with at least one option or text.
  - **Send answers** submits the round.
  - **Enough — generate** is available at any time, including before the
    first round is answered. Unanswered questions then take their
    recommendation.
- **D4 — Until it is clear.** The model asks another round only while
  something material is unknown, and generates when nothing is.
  - Its instructions say so, and the output contract lets a turn either open
    a round or return the card.
  - A hard cap of **4 rounds** keeps a runaway intake bounded; after the
    fourth, the next turn must generate.
  - Each round has at most `PLANNER_MAX_QUESTIONS` questions.
- **D5 — Languages.** The model writes questions, options and its messages in
  the language of the person's latest text. The generated card (title, body,
  kind) is **English**, written by the model itself. ADR-0027/0033
  normalization does not run on model-written text, and the person's own
  intake text is kept in the plan's turns, as typed.
- **D6 — The generated card.**
  - Title: imperative, ≤ 80 characters.
  - Kind: `bug` or `feature`, `kindSource = auto`.
  - The body is the structured mini-spec:

    ```
    ## What to do
    ## Acceptance criteria   (checkable bullets)
    ## Out of scope
    ## Open questions        (with the default taken)
    ```

  - The card is created in **Todo** with `source = board`, `planId` set (its
    origin) and the intake's attachments claimed onto it.
  - `specOnRun` behaves as today: at Run, the body becomes the spec file.
  - The intake plan closes as `done`.
- **D7 — New Plan on the Board.**
  - **New Plan** opens the Planner conversation (`dialogue` mode, or `batch`
    when the person pastes a list) in a full-height Board panel, not on a
    separate page.
  - At the end, two actions:
    - **Create cards** — one card per task in Todo, each with the D6 body
      shape, its kind, and **Depends on** links mirroring the task graph;
    - **Send to fleet** — today's path: issues plus `cs:ready`. The fleet's
      slots then appear on the Board as fleet cards (#282).
  - A plan's tasks are created once. A second Create cards is refused.
- **D8 — Card dependencies.**
  - Table `board_card_dependencies (cardId, dependsOnId)`, same project, no
    cycles (checked on insert).
  - The card face shows "after C-12". The sheet lists the dependencies with
    their columns.
  - **Run** on a card with a dependency not in Completed answers `409
    dependency_open`, unless the request carries `ignoreDependencies: true`.
    The UI asks "C-12 is not completed yet. Run anyway?".
    *Superseded by [ADR-0064](../adr/0064-run-waits-for-every-dependency-to-have-a-ready-pull-request.md)
    (#638): a dependency is satisfied in Finished or Completed, an open one
    refuses Run with no override, and `ignoreDependencies` is gone.*
  - Moving and Accept are not blocked. A person can add or remove a
    dependency in the sheet.
- **D9 — Planning model.**
  - A new per-user `user_settings` row holds `planningModel` (default
    `sonnet`), edited under Account settings with the shared model catalog
    (#322 D4: aliases with labels).
  - The New Card and New Plan dialogs preselect it and let the person pick
    another for this intake or plan.
  - The plan stores its model, and every turn uses it.
  - A project's Planner instructions (ADR-0019) apply to both modes.
- **D10 — Attachments reach the model.** Files attached in New Card, or in an
  answer, are passed to `plan.turn`.
  - The runner places them in the turn's run directory, as `card.run` does
    (#309 D9: download, size and SHA-256 check).
  - The prompt names them, so the model can read the screenshots.
  - This needs a runner release. An older runner gets the intake without the
    files, and the dialog says "Attachments need runner ≥ X".
- **D11 — Navigation.**
  - The Planner entry leaves the project navigation.
  - `/projects/:id/planner/:planId` stays as a **read-only** view: no new
    turns, no send.
  - Its tasks keep projecting onto the Board (ADR-0028 §2) until the plan is
    closed. New plans are created only from the Board.
- **D12 — Who.** Starting an intake or a plan and creating cards need the
  project's `operator` role, as creating a card does today.

## Data / Schema

`apps/api/prisma/schema.prisma`, migration
`apps/api/prisma/migrations/20261125000000_planner_on_the_board/`:

- `enum PlanMode`: add `card`.
- `model BoardCard`: `planId String?` (origin, `onDelete: SetNull`).
- New `model BoardCardDependency { cardId, dependsOnId, createdAt; @@id([cardId, dependsOnId]) }`,
  with both relations to `BoardCard` (`onDelete: Cascade`).
- New `model UserSettings { userId String @id; planningModel String?; updatedAt }`.
- `plan_tasks`: `cardId String?` (the card Create cards made from it).

## API

- Planner:
  - `POST /projects/:projectId/plans` accepts `mode: 'card'`, `model?` and
    `attachmentIds?`;
  - the card-mode output contract (D4, D6) is parsed into either a question
    round or a `cardDraft`;
  - on a `cardDraft`, the card is created in a transaction with the plan
    closing.
- `POST /projects/:projectId/plans/:planId/cards` is Create cards (D7): once
  per plan, `409 cards_exist` after that.
- Answers: `optionIds: string[]` alongside `optionId` (D3). A
  `multiple: false` question with more than one option is a 400.
- Board:
  - `ignoreDependencies` on run (D8);
  - `GET/POST/DELETE …/cards/:number/dependencies`;
  - the card view gains `dependsOn: { number, column }[]` and `planId`.
- `GET/PUT /me/settings` returns and sets `{ planningModel }` (D9).
- Planner instructions: a card-mode instruction file next to
  `packages/shared/src/planner/default-instructions.md`, with D4–D6 as its
  rules.

## UI

- `apps/web/src/components/board/`:
  - the New Card dialog (D2), replacing the title and body form;
  - the Drafts strip;
  - the New Plan panel (D7);
  - the dependency chip and the Run warning (D8).
- `apps/web/src/components/planner/question-card.tsx`: multiple choice and
  the always-present free answer (D3). The one-at-a-time stepper wraps it.
- Account settings: the Planning model (D9).
- Navigation: the Planner entry removed; the plan page read-only (D11).
- glass-ui components only (ADR-0011). Rows in `docs/ui/screens.md`.

## Acceptance criteria

- [ ] New Card shows one field, What to do, and no title. Start creates a
  `card` plan and a running turn (`plan.turn` sent with the account's
  planning model).
- [ ] A Russian description gets Russian questions. The generated card's
  title and body are English, with the four D6 sections, in Todo, with
  `planId` set. The intake plan is `done`.
- [ ] A question with `multiple: true` accepts two options and sends
  `optionIds`. The free answer is offered on every question, including those
  with options.
- [ ] Enough — generate on an open round makes the next turn generate. The
  unanswered questions are sent as their recommendations.
- [ ] A fifth round is never asked: after four, the next turn generates
  (contract test on the parser/limits).
- [ ] Closing the dialog mid-interview shows the intake in Drafts. Resume
  reopens the current round. Discard closes the plan and creates no card.
- [ ] New Plan, then Create cards, creates one Todo card per task with
  Depends-on links mirroring the graph. A second call is 409. Send to fleet
  behaves as today.
- [ ] Run on a card whose dependency is in Todo answers `409
  dependency_open`; with `ignoreDependencies: true` it starts. A dependency
  cycle is refused on insert.
- [ ] Account settings changes the planning model, and the next New Card
  preselects it. Picking `opus` in the dialog uses `opus` for that intake
  only.
- [ ] A screenshot attached in New Card is in the turn's directory on a
  runner that advertises it, and named in the prompt. An older runner gets
  the turn without it, and the dialog says so.
- [ ] The Planner entry is gone from navigation. An old plan URL renders
  read-only, and its tasks still project onto the Board.
- [ ] **Authorization:**
  - a viewer gets 403 starting an intake, creating cards, or editing
    dependencies;
  - a card of project B cannot be named as a dependency of a card in
    project A (400);
  - `/me/settings` reads and writes only the caller's row.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i337-contract | schema, migration, shared contracts (card mode, cardDraft, multiple choice, dependencies, user settings), compile fixes | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261125000000_planner_on_the_board/**, packages/shared/src/planner/types.ts, packages/shared/src/planner/contracts.ts, packages/shared/src/planner/contract.ts, packages/shared/src/board/**, packages/shared/src/settings/**, packages/shared/src/index.ts | — | yes | opus |
| i337-runner | D10, attachments in `plan.turn` | apps/runner/src/planner/**, packages/shared/src/protocol/commands/planner.ts | i337-contract | no | sonnet |
| i337-api | D1–D9, D11, D12 in the API, the card-mode instructions | apps/api/src/planner/**, apps/api/src/board/**, apps/api/src/settings/**, apps/api/src/auth/**, packages/shared/src/planner/*.md | i337-contract | no | opus |
| i337-web | the whole UI | apps/web/src/components/board/**, apps/web/src/components/planner/**, apps/web/src/app/(app)/projects/[projectId]/**, apps/web/src/app/account/**, apps/web/src/lib/board/**, apps/web/src/lib/planner/**, apps/web/src/components/shell/**, docs/ui/screens.md | i337-contract | no | opus |

i337-web is `opus`: it holds the most new interaction design (the stepper,
the Drafts strip, the plan panel) on top of existing Board code.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| schema.prisma + migration | i337-contract | do not open |
| apps/api/src/board/** | i337-api | #329's i329-api (live) and #322's i322-api also own it: **#337's api slot is cut after #329 merges**, and #322 is serialized against it |
| apps/web/src/components/board/** | i337-web | #322's i322-web: serialize |
| packages/shared/src/protocol/commands/planner.ts | i337-runner | do not open |

## Risks

- **High — the size of the change on the Board.** It moves a whole page into
  the Board and changes card creation. *Mitigation:*
  - four slots with fenced files;
  - the old plan page survives read-only;
  - the dependency rules are warnings, not blocks.
- **Medium — interview cost.** Each turn is a model run. *Mitigation:*
  - the 4-round cap;
  - Enough — generate;
  - `sonnet` by default;
  - the existing budget hard stop on plan turns.
- **Medium — the model drifts into the wrong language,** or writes the card
  in the person's language. *Mitigation:* the output contract checks the
  card fields with the English heuristic of ADR-0027 §6. A non-English card
  is re-asked once, then shown with a "Not English" warning.
- **Low — attachments on old runners** (D10 degradation).

## Open questions

- **Q1 — Turn an intake back into a plan** when the model sees it is really
  several tasks? Default: the model says so in Open questions and the person
  starts a New Plan. No automatic split.
- **Q2 — Suggest "design first"** in the generated card for UI work? Default:
  not in this issue.

Depends on #172 (Planner) · #273 · #309 · #322 (model catalog; if #322 has not
landed, i337-contract adds the catalog it defines)
