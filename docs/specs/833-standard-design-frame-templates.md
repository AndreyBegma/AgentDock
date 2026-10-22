# Standard design frame templates: page, component and flow, with typed frames

Issue: [#833](https://github.com/AndreyBegma/Nautelle/issues/833) ·
Decision: [ADR-0082](../adr/0082-a-design-follows-a-frame-template.md) ·
Amends [ADR-0041](../adr/0041-a-design-revision-holds-named-frames.md) §1–2 ·
Keeps [ADR-0062](../adr/0062-a-design-revise-sends-only-the-frames-it-changes.md)

## Summary

A design turn currently picks its own frame structure. Three runs of the same
card can come back in three shapes:

- one finished page;
- a page and an explanation frame;
- a page in the middle with annotation text around it.

The model chooses alone. The contract gives it one heuristic sentence, and nothing
checks the result, so reviewers cannot predict what they will get, and the
variants of one card cannot be compared frame by frame.

This change fixes the **structure** of every generation with a **frame
template**:

- each frame has a **kind**;
- the frames come in a fixed order;
- each frame is required or optional.

The **visual style** still comes from each project's UI profile. Three
templates are built in: page, component and flow. A project can configure them
or add its own. The server checks every new revision against its template.

## Scope

### In scope

- Typed frames (`DesignFrame.kind`) and a shared definition of a frame template.
- The three built-in templates, defined in code.
- Project templates, stored in the database and edited in the project's design
  settings:
  - toggle optional frames;
  - add custom frames;
  - reorder frames;
  - create whole new templates.
- Choosing a template for a card, a plan task and a stack:
  - the model classifies it automatically;
  - a person can switch it.
- The design contract and the turn prompt draw by the template.
- A server-side conformance check, with one automatic repair turn.
- A "not per template" state, with a "Complete" action.
- Viewer changes:
  - each frame tab shows its kind;
  - the same frame can be compared across variants;
  - a "not per template" badge.
- Size limits:
  - at most 2 MiB per revision;
  - at most 6 flow steps by default.

### Out of scope

- Instance-wide templates. Templates are per project only (person, Q-level).
- Migrating existing revisions. Their frames read as `legacy` and are never
  validated.
- A neutral "spec chrome" stylesheet. Service frames use the project style.
- Drawing a variant in several turns. Each variant stays one turn.
- Changing how variants are counted (1–3, `TaskDesign.variantCount`).

## Prior art

| Source | What we take |
|---|---|
| [Storybook autodocs](https://storybook.js.org/docs/writing-docs/autodocs) — Primary → Controls → Stories | The component template's order: in context → anatomy & props → variants × states |
| [uSpec](https://github.com/redongreen/uSpec) — an agent renders fixed spec frames (anatomy, properties, structure, states) from a component contract | Frames with a fixed kind, each with a stated content |
| [shadcn registry item `type`](https://ui.shadcn.com/docs/registry/registry-item-json) — `registry:page` / `registry:block` / `registry:component` | Classify the task first, then pick the layout from the class |
| [llamacoder prompts](https://github.com/Nutlope/llamacoder/blob/main/lib/prompts.ts), bolt.new `<boltArtifact>` | Every artifact sits in a tagged envelope, and output outside the contract is rejected. The prompt alone does not hold the structure |
| [tldraw make-real prompt](https://github.com/tldraw/make-real/blob/main/app/prompt.ts) | Reasoning stays outside the artifact. Here the `rationale` stays on the revision and explanation goes in its own frame |
| Google Stitch `DESIGN.md` | Style (the project) is kept separate from structure (the template) |

Material, GOV.UK Design System and Polaris all document a component in the same
order: live example → anatomy → variants and states → usage. That order backs
the component template.

## Decisions

The person settled these in the interview of 2026-10-22, unless the line cites
a record.

- **D1 — Three built-in templates.** `page`, `component` and `flow`. "Repeat" means
  the frame appears once per step.

  | Template | # | Frame (kind) | Required | Draws |
  |---|---|---|---|---|
  | `page` | 1 | Screen (`screen`) | yes | The finished page at desktop width, with realistic content and no explanatory text |
  | | 2 | Breakdown (`breakdown`) | yes | The screen with numbered zones and a legend: what is new or changed, which components, interactions, and why |
  | | 3 | States and mobile (`states`) | no | Empty, loading and error states, and the narrow width |
  | `component` | 1 | In context (`in_context`) | yes | The component on a realistic sample page |
  | | 2 | Anatomy and props (`anatomy`) | yes | Numbered parts, a props table, and spacing labelled with token names |
  | | 3 | Variants × states (`state_grid`) | yes | A grid. Rows are sizes or kinds; columns are default, hover, focus, active, disabled, loading and error. A cell that does not apply reads "n/a" and is never dropped |
  | `flow` | 1 | Flow map (`flow_map`) | yes | A thumbnail of every step, with arrows and branches (error, back, skip) |
  | | 2…N+1 | Step *k* (`flow_step`, repeat 1–6) | yes | Each step as a full screen |
  | | N+2 | Breakdown (`breakdown`) | yes | Shared components, states and logic |
  | | N+3 | Mobile (`mobile`) | no | The steps at the narrow width |

- **D2 — The explanation is a frame.** It always sits at its template position.
  It is never an overlay or a side panel. `DesignRevision.rationale` stays as it
  is.
- **D3 — Frames are required or optional.** An optional frame appears only when
  it is enabled and the turn has something to show in it. It always appears in
  its own slot.
- **D4 — Service frames use the project's style.** These are the breakdown,
  anatomy, state grid and flow map. They are drawn with the UI profile's kit, the
  same as the screen. There is no neutral chrome.
- **D5 — Every variant follows the whole template.** Variants 1–3 have the same
  frame kinds in the same order.
- **D6 — One turn per variant**, as today. A turn draws every frame of its
  template.
- **D7 — Conformance is enforced by the server.**
  1. After a design turn (draw or revise), the API compares the frames' kinds
     and order with the template that is in effect.
  2. On a mismatch it starts **one** repair turn. The repair turn is a revise
     (ADR-0062) whose instruction names the missing, extra or misplaced frames.
  3. If the repair turn is still off, the revision is stored and marked
     `conformance: off`, with the list of differences. The viewer then offers
     **Complete**, which starts the same repair turn by hand.
- **D8 — Who chooses the template.**
  - The text normalizer classifies a card's template in the same step that
    classifies `kind` (#271 D9; `apps/api/src/text/text-normalizer.ts`). The
    choice is stored as `designTemplate` with `designTemplateSource: auto | person`.
  - A person's choice is never overwritten, the same rule as `kindSource`
    `[Confirmed]`.
  - The template shows on the card before the design runs, and the card can
    switch it.
  - A plan task gets the template from the planner's `design` suggestion; a
    person can switch it on the task.
  - A stack design gets its own template, chosen the same way. The stack's cards
    keep receiving the stack's approved frames as their reference, as today.
- **D9 — Everything is configurable per project.**
  - The three built-in templates live in code (`packages/shared`).
  - A project can override a built-in template:
    - toggle its optional frames;
    - add custom frames, each with a name and an instruction that says what to
      draw;
    - reorder its frames;
    - change the maximum number of flow steps.
  - A project can also create entirely new templates, such as `landing` or
    `email`.
  - Overrides and custom templates are stored in the database and edited in the
    project's design settings.
  - A custom frame has kind `custom` and a key that is unique within its
    template.
- **D10 — Existing designs are not migrated.**
  - Frames stored before this change read `kind = legacy` and are never
    validated.
  - Every new revision follows its template.
  - A revise still draws only the frames it changes (ADR-0062), but it may not
    drop a required frame. A required frame that is missing from a revise's
    answer is carried over from the previous revision.
- **D11 — Viewer.**
  - Each frame tab shows the frame's kind label, and the template name is shown
    once above the tabs.
  - A **Compare** mode shows the same frame of every variant side by side.
  - The **not per template** badge lists what is missing and offers Complete.
- **D12 — Limits.**
  - `DESIGN_TOTAL_MAX_BYTES` rises from 1 MiB to 2 MiB. The runner limit rises
    with it (`PLAN_TURN_RESULT_TOTAL_MAX_BYTES`). It takes effect only with a
    runner release (see Risks).
  - A flow has at most 6 steps by default, and a template can configure the
    number.
  - If a card's flow needs more steps, the turn draws the first ones. The
    revision is marked `conformance: off` with the reason `too_many_steps`, and
    the viewer suggests splitting the card into a stack.
- **D13 — The plan block names kinds.**
  - Each entry of the `design` plan block's `frames` becomes
    `{ "name", "kind" }`.
  - A plain string is still accepted. It reads as kind `legacy` and fails
    conformance on a templated design.
  - The contract version does not change, per ADR-0041 §2.

## Data / Schema

One migration, `apps/api/prisma/migrations/20261231000018_design_frame_templates/`.
It is the only migration in this wave.

- `DesignFrameKind` enum, with the values `screen`, `breakdown`, `states`,
  `in_context`, `anatomy`, `state_grid`, `flow_map`, `flow_step`, `mobile`,
  `custom`, `legacy`.
- `DesignFrame` (table `design_frames`) gets two columns:
  - `kind DesignFrameKind NOT NULL DEFAULT 'legacy'`;
  - `templateFrameKey String?`, the key of the template frame it fills, which
    distinguishes custom frames and steps.
- `DesignRevision` (table `design_revisions`) gets three columns:
  - `templateKey String?`, the template in effect when it was drawn;
  - `conformance Json?`, holding `{ ok: boolean, missing: string[], extra: string[], misplaced: string[], reason?: 'too_many_steps' }`;
  - `repairTurnId String?`, so a revision gets at most one automatic repair.
- New table `design_templates` (model `DesignTemplate`):
  - `id`
  - `projectId` (FK to project, cascade on delete)
  - `key`, unique per project. A built-in key such as `page`, `component` or
    `flow` means an override of that built-in.
  - `name`
  - `definition Json`, validated by the shared `designTemplateSchema`
  - `updatedById`
  - `updatedAt`
- `DesignTemplateChoice` enum: `auto`, `person`.
- `BoardCard` gets two columns:
  - `designTemplate String?`
  - `designTemplateSource DesignTemplateChoice NOT NULL DEFAULT 'auto'`
- `TaskDesign` gets two columns:
  - `templateKey String?`
  - `templateSource DesignTemplateChoice NOT NULL DEFAULT 'auto'`

  Together they cover the template of a plan task and of a stack, since
  `TaskDesign` has exactly one owner (ADR-0025) `[Confirmed]`.

`packages/shared/src/design/templates.ts` holds the shared definition:

```ts
type DesignTemplateFrame = {
  key: string;            // unique within the template
  kind: DesignFrameKind;
  name: string;           // tab label, ≤ 60 chars (DESIGN_FRAME_NAME_MAX)
  instruction: string;    // what to draw, ≤ 1000 chars
  required: boolean;
  enabled: boolean;       // only optional frames can be disabled
  repeat?: { min: number; max: number };  // flow_step: { min: 1, max: 6 }
};
type DesignTemplate = { key: string; name: string; frames: DesignTemplateFrame[] };
```

It also exports `BUILTIN_DESIGN_TEMPLATES`, `designTemplateSchema`,
`resolveDesignTemplate(builtin, override?)` and
`checkConformance(template, frames)`. All of them are pure and free of any
framework.

## API

All routes are under `projects/:projectId`. They use `@ProjectRole`, and their
DTOs use `class-validator`.

- `GET design/templates` returns the resolved templates: the three built-ins
  with the project's overrides merged in, and then the custom templates.
  Requires `viewer`.
- `PUT design/templates/:key` creates or replaces an override or a custom
  template. Requires `admin` (as `PUT design-settings`).
  - The definition is validated by `designTemplateSchema`.
  - A built-in key may change only `enabled`, `instruction`, the order, its
    custom frames and `repeat.max`. It may not remove a required built-in frame.
- `DELETE design/templates/:key` deletes a custom template, or resets an
  override to the built-in. Requires `admin` (as `PUT design-settings`).
- `PATCH board/cards/:number` accepts `designTemplate`. Setting it sets
  `designTemplateSource = person`.
- Plan tasks and stacks take `templateKey` on their existing design settings
  route. The design store already exposes variant count there.
- `POST …/design/complete` (on the card, plan-task and stack design routes, e.g. `board/cards/:number/design/complete`) starts the repair turn (D7). Requires
  `operator`.
- An audit record is written for every template create, update and delete, and
  for every manual Complete.

## Prompt and contract

- `PLANNER_DESIGN_CONTRACT` (`packages/shared/src/planner/contract.ts:777-807`):
  - replace the "one frame unless…" heuristic (line 794) with the D13 shape;
  - add the rule "draw exactly the frames of the template in the turn, in that
    order".
- `designTurnSections` (`apps/api/src/design/design-prompt.ts:347-379`) renders a
  **"# Frames to draw"** section from the resolved template. For each frame it
  gives:
  - the frame's number;
  - its name;
  - its kind;
  - whether it is required or optional;
  - its instruction.

  It also gives the step limit for `flow_step`, and the line "service frames
  use the same kit and custom properties as the screen" (D4).
- `parseDesignBlocks` (`contract.ts:435-527`) reads `kind`. Conformance runs in
  the API, after the parse, through `checkConformance`.
- `fitDesignPrompt` must never drop the "Frames to draw" section.

## UI

All of it uses glass-ui only (ADR-0011). A component that glass-ui lacks is
added to glass-ui first.

- **Project settings → Design → Templates** (new section beside the profile
  sections in `apps/web/src/app/(app)/projects/[projectId]/settings/design/`):
  - a list of the templates;
  - an editor for frames, with toggle, reorder, name, instruction and add
    custom;
  - "Reset to built-in";
  - "New template".
- **Card**: the design template shows beside the kind, with a select to switch
  it and an "auto" tag while `designTemplateSource = auto`.
- **Plan task and stack design**: the same select, placed with variant count.
- **Viewer** (`apps/web/src/components/design/`):
  - `frame-strip` tabs show the kind label;
  - the template name is shown above the tabs;
  - a **Compare** toggle renders the same frame position of every variant side
    by side;
  - a "Not per template" badge lists the differences, with a **Complete**
    button.

## Configuration

No new environment variables. `DESIGN_TOTAL_MAX_BYTES` (shared) and
`PLAN_TURN_RESULT_TOTAL_MAX_BYTES` (shared, used by the runner) rise together
(D12).

## Acceptance criteria

- [ ] **Card defaults.** A new card with `designTemplateSource = auto` gets
      `designTemplate` set by the normalizer:
  - a card titled "Settings page for webhooks" gets `page`;
  - a card titled "Date range picker component" gets `component`;
  - a card titled "Three-step onboarding wizard" gets `flow`.

  Covered by unit tests of the normalizer with a stubbed model answer.
- [ ] **Person's choice wins.** After a person switches the template on a card,
      a later normalization does not change it.
- [ ] **Built-in page template.** A design turn for a card on the built-in
      `page` template, answered with frames `screen`, `breakdown`:
  - is stored with kinds `screen`, `breakdown`;
  - is stored at positions 0, 1;
  - has `conformance.ok = true`.
- [ ] **One automatic repair.** A turn that answers only `screen` for `page`:
  - starts exactly one repair turn whose prompt names `breakdown` as missing;
  - if the repair answers correctly, the result is conforming;
  - if the repair answers wrongly again, the revision has `conformance.ok = false`
    with `missing: ["breakdown"]` and no further repair turn starts.

  Covered by an e2e test with the test runner.
- [ ] **All variants follow the template.** All three variants of one
      `component` design are stored with kinds `in_context`, `anatomy`,
      `state_grid` in that order.
- [ ] **Revise keeps required frames.** A revise that answers only `anatomy`
      keeps the previous `in_context` and `state_grid` frames (ADR-0062), and
      the revision is conforming.
- [ ] **Flow steps.** A `flow` template with `repeat.max = 6`:
  - accepts 1–6 `flow_step` frames;
  - an answer with 7 is stored with `conformance.reason = too_many_steps`.
- [ ] **Legacy revisions.** A revision stored before this change reads its
      frames with `kind = legacy` and shows no "not per template" badge.
- [ ] **Template validation.** `PUT design/templates/page`:
  - returns 400 when it removes a required built-in frame;
  - succeeds when it disables `states`;
  - on success, the next `page` turn's prompt has no states frame.
- [ ] **Custom templates.** `PUT design/templates/landing` with a custom
      template:
  - makes it selectable on a card;
  - its custom frames reach the prompt with their instructions.
- [ ] **Authorization:**
  - a member of project A gets 404 on `GET` and `PUT design/templates` of
    project B;
  - an `operator` gets 403 on `PUT`.
- [ ] **Audit.** Every template create, update and delete writes an audit
      record, and so does every manual Complete.
- [ ] **Size limit.** A revision with 1.5 MiB of HTML in total is accepted, and
      one with 2.1 MiB is refused with the existing size error.
- [ ] **Viewer:**
  - tabs show kind labels;
  - Compare shows frame *k* of every variant side by side;
  - a non-conforming revision shows the badge, and Complete starts a repair
    turn.
- [ ] **Old runner.** A runner older than the release that raises
      `PLAN_TURN_RESULT_TOTAL_MAX_BYTES` and returns a truncated result makes
      the turn fail with a message naming the runner version. It never stores a
      half revision.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i833-core | Shared template types and built-ins, contract and prompt, schema and migration, parse, conformance, repair turn, limits | packages/shared/src/design/**, packages/shared/src/planner/**, packages/shared/src/index.ts, apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261231000018_design_frame_templates/**, apps/api/src/design/**, apps/api/src/planner/**, apps/runner/src/planner/** | — | yes | opus |
| i833-choose | Template choice: normalizer classification, the card field and DTO, plan task and stack choice | apps/api/src/text/**, apps/api/src/board/** | i833-core | no | sonnet |
| i833-templates | Project templates API module and the settings editor | apps/api/src/design-templates/**, apps/api/src/app.module.ts, apps/web/src/app/(app)/projects/[projectId]/settings/design/** | i833-core | no | sonnet |
| i833-viewer | Viewer kinds, Compare, the not-per-template badge and Complete, the card template select | apps/web/src/components/design/**, apps/web/src/components/board/**, apps/web/src/lib/design/**, apps/web/src/app/(app)/projects/[projectId]/board/** | i833-core | no | sonnet |

Everything else waits for i833-core because the schema, the shared types and
the conformance shape are one decision. Once it merges, the other three run in
parallel.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma and the migration `20261231000018_design_frame_templates` | i833-core | do not open it; no other migration in this wave |
| packages/shared/src/index.ts (barrel) | i833-core | import from the subpath the core exports |
| apps/api/src/app.module.ts | i833-templates | — |
| apps/api/src/planner/** (design turn services) | i833-core | i833-choose reads the template through the design store, it does not edit the turn services |
| `docs/ui/screens.md` (screens registry) | i833-viewer | i833-templates lists its screens in its PR body; i833-viewer adds the rows after it merges |
| glass-ui | whichever slot first needs a missing component | it is added in glass-ui first and released before use |

## Risks

- **High — runner release for 2 MiB.** The runner caps a turn's result with
  `PLAN_TURN_RESULT_TOTAL_MAX_BYTES` (`apps/runner/src/planner/executor.ts:564`)
  `[Confirmed]`. Until a runner with the new limit is released and installed,
  results over 1 MiB are refused by the runner.
  - Mitigation: the API keeps accepting up to 2 MiB, and a truncated result
    fails with a "runner too old" message (acceptance criterion).
  - The release is a person's step: develop → main, then the tag.
- **Medium — cost.** Three or more frames per variant, at three variants, cost
  more tokens per design than one frame. The optional frames are off by
  default, except where the template says otherwise.
- **Medium — the model keeps drifting.** The prompt alone did not hold the
  structure, which is the reason for this change. The automatic repair turn and
  the badge contain the drift but add a turn. Check the repair rate after a
  week through the `conformance` field.
- **Low — service frames styled by the project can read differently across
  projects** (D4, the person's choice). Accepted.
- **Low — the classification picks the wrong template.** The person switches
  it, and that choice sticks (D8).

## Open questions

- Should a custom template be able to omit a breakdown frame entirely? Default:
  yes. Only the built-in templates have mandatory frames.
