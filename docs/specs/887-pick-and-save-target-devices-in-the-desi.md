# C-347: Pick and save target devices in the design generate panel

Issue: #887

## What to do
In `apps/web/src/components/design/generate-panel.tsx`, add a multi-select of target devices.

- **List.** Desktop, Tablet and Phone, then the project's custom devices from Settings → Design. On first open all are preselected; after that the last choice is remembered per project.
- **Request.** The chosen devices go in the generate request. At least one device is required.
- **Custom size.** `Custom size` takes a name, width and height, validated with `viewportPresetSchema` and `DESIGN_VIEWPORT_MIN_PX`/`MAX_PX`.
- **Save as device.** Saving adds the size to the project's presets through the existing audited settings write. This is the same PUT as the Settings → Design editor (#604), so it appears there and is offered next time.
- **Unsaved custom size.** It can also be used for one generation without saving.
- **Limits.** Respect `DESIGN_VIEWPORTS_MAX`. Use the row validation of `apps/web/src/lib/design/viewports.ts`.
- **Stack and plan task.** The same picker is used where those designs are generated.

## Acceptance criteria
- [ ] The generate panel lists Desktop, Tablet, Phone and the project's custom devices as a multi-select. Generation is disabled with none selected.
- [ ] Generating sends exactly the selected devices.
- [ ] A custom size can be used once without saving, and is not added to the project.
- [ ] Saving a custom device with a name adds it to the project's presets. It shows in Settings → Design and in the picker on the next generation.
- [ ] An invalid name or size, or a full preset list, shows an inline error and saves nothing.
- [ ] The same picker appears for card, plan task and stack designs.
- [ ] `generate-panel.test.tsx` covers selection, one-off custom sizes and saving.

## Out of scope
- The viewer canvas.
- Per-person devices.
- Editing or deleting presets from the panel; that stays in Settings → Design.

## Open questions
None.
