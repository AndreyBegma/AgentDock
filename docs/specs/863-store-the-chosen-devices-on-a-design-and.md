# C-344: Store the chosen devices on a design and drop the mobile template frame

Issue: #863

## What to do
A design gets the set of devices it targets, chosen at generation time. A device is a viewport preset `{ name, width, height, theme? }` (`viewportPresetSchema` in `packages/shared/src/design/types.ts`).

- **Built-in devices.** `DEFAULT_VIEWPORTS` becomes Desktop 1440×900, Tablet 834×1194 and Phone 390×844.
- **Custom devices.** These stay the project's presets in `design_settings.viewports` (Settings → Design, spec 223 D11).
- **Generate request.** The DTO in `apps/api/src/design/dto.ts`, for card, plan task and stack designs, accepts an optional list of devices, at most `DESIGN_VIEWPORTS_MAX`.
- **Snapshot.** The API stores a snapshot of the chosen devices on the design, through a Prisma migration with a descriptive name. Editing or deleting a preset later does not change an existing design.
- **No devices sent.** The API uses the project's presets, or the built-in devices when the project has none.
- **Prompt.** `apps/api/src/design/design-prompt.ts` tells the model to draw one responsive page per frame that works at every chosen width (names and sizes listed). It does not draw a separate frame per device.
- **Templates.** Remove the optional `mobile` frame from the built-in `page` and `flow` templates (`packages/shared/src/design/templates.ts`) and from their instructions.
- **Old data.** Keep the `mobile` kind in the enum, so old revisions and project overrides still parse (ADR-0082 §8).
- **ADR.** Record the change in a new ADR amending ADR-0082 §1 in the same pull request.

## Acceptance criteria
- [ ] A generate request with devices stores exactly those devices on the design. The design view returned by the API includes them.
- [ ] A generate request without devices stores the project's presets, or Desktop/Tablet/Phone when the project has none.
- [ ] Editing the project's presets after generation does not change the devices of an existing design.
- [ ] The design prompt lists every chosen device with its width and asks for one responsive page per frame.
- [ ] The built-in `page` and `flow` templates no longer contain a `mobile` frame. Template conformance passes without it.
- [ ] A revision stored earlier with a `mobile` frame still loads, and its frames are not re-checked.
- [ ] `*.spec.ts` tests cover the DTO validation, the default devices, the snapshot and the template change. A new ADR amends ADR-0082.

## Out of scope
- Any web UI: the viewer and the generate panel.
- Drawing separate HTML per device.
- Per-person devices.
- Migrating stored revisions.

## Open questions
None.
