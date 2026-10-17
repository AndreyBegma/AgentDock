# ADR-0041: A design revision holds any number of named frames

Status: accepted · Date: 2026-10-16 ·
Issue: [#441](https://github.com/AndreyBegma/AgentDock/issues/441) ·
Amends [ADR-0022](0022-design-stage-html-mockups-from-a-ui-profile.md) §1

## Context

ADR-0022 §1 made a mockup one self-contained HTML document, and a revision of
a variant held exactly one. A task that touches two pages, or a page whose
components are worth reviewing on their own, had to squeeze everything into
one document or leave part of it undrawn.

## Decision

1. **A revision of a variant holds one or more frames.** A frame is a named,
   separately rendered, self-contained HTML document under the rules of
   ADR-0022 §1. The frames keep the order the turn drew them in and are
   addressed by position. There is no limit on their number; the HTML of all
   frames of a turn together stays under `DESIGN_HTML_MAX_BYTES`, because the
   turn's result still travels in one event.
2. **The design contract stays one shape.** A design turn answers one
   `agentdock-design` block per frame and names them, in order, in the plan
   block's optional `frames`. A turn that names none answers one block, a frame
   named "Mockup". A plan's contract version does not change.
3. **Frames are stored in `design_frames`; nothing is migrated.** A revision
   stored before keeps its one mockup in `design_revisions.html` and reads as
   one frame named "Mockup"; its comments sit on frame 0.
4. **A comment is left on a frame**, and the frame's name travels with it to
   the next Revise turn and into the approved design's decisions.
5. **Revise and Approve act on the whole revision.** Revise redraws every frame
   of the variant; Approve approves the variant with all its frames, and
   publication commits each as `design/<variant>/<frame-slug>.html` — in the
   card's branch or the plan's docs pull request — and lists every one in the
   worker's and the write turn's `## Design`.

## Consequences

- `card.run` and `plan.publish_specs` take one file per frame, so their file
  limits rose. A runner built before this change refuses a design with more
  frames than its old limit (`card.run`: 4 files with the spec; the docs PR:
  12 designs) until it is released again.
- A single-frame design moves from `design/<variant>.html` to
  `design/<variant>/<frame>.html`; designs already published stay where they
  are.
- Each frame is fetched and rendered on its own, so the viewer shows one at a
  time behind a tab strip; pins live on the frame they were made on.
