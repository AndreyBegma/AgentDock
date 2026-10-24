# ADR-0082: A design follows a frame template, and its frames are typed

Status: accepted · Date: 2026-10-22 ·
Issue: [#833](https://github.com/AndreyBegma/Nautelle/issues/833) ·
Spec: [`docs/specs/833-standard-design-frame-templates.md`](../specs/833-standard-design-frame-templates.md) ·
Amends: [ADR-0041](0041-a-design-revision-holds-named-frames.md) §1–2 ·
Keeps: [ADR-0062](0062-a-design-revise-sends-only-the-frames-it-changes.md) ·
Amended by [ADR-0085](0085-a-design-stores-its-devices-and-draws-responsive-frames.md) (§1: no `mobile` frame in page and flow; every frame is one responsive page)

## Context

ADR-0041 let a revision hold any number of named frames "in the order the turn
drew them". The contract gives the model one heuristic for choosing them: one
frame, or one per page plus one per component. Nothing checks what comes back.
In practice the same card yields:

- a single page in one run;
- a page and an explanation frame in another;
- a page with annotation text drawn around it in a third.

The variants of one card can differ in frame sets. Reviewers cannot predict
what they will see, and they cannot compare variants frame by frame.

## Decision

1. **Every new design follows a frame template.** A template is an ordered list
   of frames. Each frame has:
   - a **kind**;
   - a name;
   - an instruction that says what to draw;
   - a required or optional flag;
   - an optional repeat range, used for flow steps.

   Three templates are built in, in `packages/shared`:
   - **page**: screen → breakdown → states and mobile (optional);
   - **component**: in context → anatomy and props → variants × states;
   - **flow**: map → steps 1…N (up to 6 by default) → breakdown → mobile (optional).

   ADR-0085 removed the `mobile` frame from page and flow; every frame is one
   page that works at the design's devices.
2. **Frames are typed.** `design_frames.kind` holds one value of a fixed enum
   (`screen`, `breakdown`, `states`, `in_context`, `anatomy`, `state_grid`,
   `flow_map`, `flow_step`, `mobile`, `custom`, `legacy`). The `design` plan
   block names `{ name, kind }` per frame. A plain name still parses as `legacy`.
   The contract version does not change.
3. **The explanation is a frame, in the project's style.** It sits in the
   template's breakdown or anatomy position, never as an overlay. It is drawn
   with the UI profile's kit like every other frame. The revision's
   `rationale` stays.
4. **Every variant follows the whole template in one turn.**
5. **The server enforces the template.**
   1. After each design turn the API checks kinds and order against the
      template in effect.
   2. A mismatch starts one repair turn. The repair turn is a revise under
      ADR-0062 that names what is missing, extra or misplaced.
   3. If the repair turn still mismatches, the revision is stored with
      `conformance.ok = false` and can be completed by hand.

   A revise may not drop a required frame. Such a frame is carried over from
   the previous revision.
6. **The template is chosen per card, plan task and stack.**
   - The model classifies it together with the card kind (#271 D9): the
     source is `auto`.
   - A person may switch it: the source becomes `person`, and the model never
     overrides it again.
7. **Templates are configurable per project.**
   - A project may override a built-in template: toggle its optional frames,
     add custom frames, reorder them, or change the step limit. It may not
     remove a required built-in frame.
   - A project may also define its own templates.
   - Overrides and custom templates live in `design_templates`.
   - There are no instance-wide templates.
8. **Revisions stored earlier are not migrated.** Their frames read as `legacy`
   and are never checked.
9. **The total HTML of a revision rises from 1 MiB to 2 MiB**
   (`DESIGN_TOTAL_MAX_BYTES`). The runner's `PLAN_TURN_RESULT_TOTAL_MAX_BYTES`
   rises with it.

## Consequences

- Reviewers see the same structure on every card of a template. Variants are
  comparable frame by frame, and the viewer gains a Compare mode.
- A design costs more tokens: a template's required frames, times its variants.
  A non-conforming answer costs one more turn.
- The 2 MiB limit takes effect only with a runner release. An older runner
  refuses results over its own cap, and the API reports that as "runner too
  old".
- Service frames styled by the project read differently across projects. This
  was chosen on purpose: the structure is fixed, the style is not.
- ADR-0041's "frames keep the order the turn drew them in" now means "the order
  of the template". A design turn no longer decides how many frames to draw or
  which ones.
