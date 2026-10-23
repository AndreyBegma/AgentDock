# C-346: Show designs as frame tabs on a device canvas in the design viewer

Issue: #886

## What to do
Replace the single-frame view in `apps/web/src/components/design/design-viewer.tsx` with the glass-ui canvas.

- **Tabs.** Each frame of the revision is a tab, named by its kind or name (Screen, Breakdown, States…). This replaces the frame strip as the navigation (`frame-strip.tsx`).
- **Canvas.** A tab's canvas renders the frame's HTML once per device stored on the design (`mockup-frame.tsx`, at the device's width and height).
- **Old designs.** A design with no stored devices uses the project's presets, or the built-in devices. A legacy `mobile` frame is just another tab.
- **Toolbar.** Remove the Mobile/Desktop switch and the custom width from `viewer-toolbar.tsx` and `apps/web/src/lib/design/viewer-state.ts`. Theme, variant, revision and Compare stay.
- **URL.** It keeps the tab, zoom and pan, so a link reopens the same view. Old `vp`/`w` params are ignored.
- **Pins and comments.** They work on each device frame. A screen or pin comment records the device's name in `viewport`, as today. An existing comment opens on the tab and device it names.
- **Fullscreen.** The full-screen layer (`full-screen-layer.tsx`) hosts the same canvas.

## Acceptance criteria
- [ ] Opening a design shows one tab per frame. Each tab shows every device of the design side by side, each labelled with its name and size.
- [ ] The canvas pans and zooms. `Fit all` and `100%` work.
- [ ] The Mobile/Desktop switch and the custom width control are gone.
- [ ] Dropping a pin on a device frame creates a comment anchored to that frame, device and position.
- [ ] Selecting an existing comment opens its tab, and the pin is centred on its device.
- [ ] A copied viewer link reopens the same tab, zoom and pan.
- [ ] An earlier revision with a `mobile` frame and no stored devices opens with the project's presets.
- [ ] The viewer tests (`viewer-state.test.ts`, `viewer-toolbar.test.tsx`, `frame-strip.test.tsx`) are updated or replaced.

## Out of scope
- The device picker in the generate panel.
- The phone layout of the viewer and its cropped preview (`mobile-preview.ts`), beyond keeping them working.
- Any API change.

## Open questions
None.
