# ADR-0085: A design stores its devices, and every frame is one responsive page

Status: accepted · Date: 2026-10-23 ·
Issue: [#863](https://github.com/AndreyBegma/Nautelle/issues/863) ·
Spec: [`docs/specs/863-store-the-chosen-devices-on-a-design-and.md`](../specs/863-store-the-chosen-devices-on-a-design-and.md) ·
Amends: [ADR-0082](0082-a-design-follows-a-frame-template.md) §1 ·
Keeps: [ADR-0082](0082-a-design-follows-a-frame-template.md) §2, §8

## Context

ADR-0082 §1 gave the built-in `page` and `flow` templates an optional `mobile`
frame. The model drew the narrow layout as a separate frame, so one design had
two pages that could drift apart, and a reviewer could not check the widths in
between.

The devices a design is drawn for lived only in the project's viewport presets.
A design did not record them. Editing a preset after Generate silently changed
what an existing design was supposed to fit, and nobody could choose devices
for one design.

## Decision

1. **Three devices are built in.** `DEFAULT_VIEWPORTS` in `packages/shared` is
   Desktop 1440 × 900, Tablet 834 × 1194 and Phone 390 × 844. A project's own
   devices stay presets in `design_settings.viewports`.
2. **Generate takes the devices.** The generate request of a plan task, a
   board card and a stack accepts an optional `devices` list of at most
   `DESIGN_VIEWPORTS_MAX` presets. Without it, the design takes the project's
   presets, or the built-ins when the project has none.
3. **The design stores a snapshot.** `task_designs.devices` holds the devices
   of the last Generate. The API writes it together with the busy claim, so a
   refused Generate leaves a running design's devices alone. Editing or
   deleting a preset later does not change an existing design. A design
   generated before this change holds null. Its view says so, and its prompts
   use the project's presets.
4. **Every frame is one responsive page.** The design prompt lists every device
   by name and size under "Devices". It asks for one page per frame that works
   at every listed width, and never for a separate frame per device.
5. **The built-in `page` and `flow` templates have no `mobile` frame.** This
   amends ADR-0082 §1:
   - **page**: screen → breakdown → states (optional);
   - **flow**: map → steps 1…N → breakdown.

   The `states` frame is named "States" and draws the empty, loading and error
   states. No built-in instruction mentions a width.
6. **The `mobile` kind stays in the enum.** Older revisions and project
   templates that hold a `mobile` frame still parse (ADR-0082 §2, §8). Stored
   revisions are not migrated, and their stored conformance is read, not
   checked again.
7. **An older project override reads in the current shape.** When an override
   of a built-in is resolved:
   - a non-custom frame the built-in no longer has is dropped;
   - a built-in frame takes the built-in's current name;
   - an instruction that is still the built-in's former text takes the
     current text, while a person's own wording stays.

   The listed override therefore saves back without a refusal.

## Consequences

- A design records the devices it was drawn for, and a reviewer can check the
  page against them.
- A design prompt grows by about 70 tokens. The prompt budgets in
  `prompt-budget.spec.ts` grow with it.
- Choosing devices in the web app, and showing a design at each device in the
  viewer, are separate work. Until then Generate from the web takes the
  project's presets or the built-ins.
- Older revisions with a `mobile` frame keep it. New revisions do not draw one.
