# C-84: Let a design hold any number of named frames

Issue: #441

## What to do
Today a design revision is one HTML mockup per variant (`DesignRevision`, `apps/api/src/design/design-store.ts`, ADR-0022, ADR-0025). Let one revision of a variant contain any number of **frames**: each frame is a named, separately rendered HTML mockup. This lets a design show a whole page in one frame and each of its components in their own frames, or cover two separate pages in one design.

- The design turn's contract and prompt (`apps/api/src/design/`) allow the model to return several frames, each with a short name. The prompt tells it to use one frame unless the task touches several pages or the components benefit from being shown on their own.
- Storage keeps frames per revision in order. Existing single-mockup revisions read back as one frame.
- The design viewer (`apps/web/src/components/board/card-design.tsx`, `board/cards/[number]/design/page.tsx`, and the plan-task design view) shows the frames of the selected variant as tabs or a strip. Comments and pins attach to a frame.
- Revise can target the whole revision. Approve approves the variant with all its frames.
- Publication commits every frame of the approved variant into the card's branch (or the plan's docs PR), e.g. `design/<n>/<frame-slug>.html`. The worker prompt's `## Design` section lists every frame.

## Acceptance criteria
- [ ] A design turn can return 1 or more named frames, with no fixed upper limit, and they are stored in order.
- [ ] A revision stored before this change opens as a single frame with no data migration visible to the person.
- [ ] The design viewer lets the person switch between frames of a variant, and the frame name is visible.
- [ ] A comment or pin made on a frame stays on that frame after reload and is passed to the next Revise turn with its frame name.
- [ ] Approving a variant publishes every one of its frames into the card branch and lists them in the worker prompt's `## Design` section.
- [ ] API tests cover a multi-frame turn, a legacy single-mockup revision, and publication of several frames.

## Out of scope
- Stacks or a design shared between several cards.
- Changing the 1–3 variant limit.
- Any change to glass-ui beyond adding a component the viewer truly needs (ADR-0011).

## Open questions
- How many frames the prompt suggests by default. Default: one frame unless the task touches several pages or several standalone components, then one frame per page plus one per component that matters.
- Frame switcher shape. Default: tabs above the mockup, using an existing glass-ui tabs component.

## Migration name
Name the schema migration exactly `20261130000000_design_frames` (create it with `prisma migrate dev --create-only --name ...` and rename the folder if needed). The repository's migrations use fixed future timestamps; the newest on develop is `20261129000000_card_round_background`. Another card (C-85) runs in parallel and owns `20261201000000_card_auto_run` on a different table.
