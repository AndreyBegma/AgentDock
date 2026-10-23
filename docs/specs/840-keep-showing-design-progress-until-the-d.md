# C-335: Keep showing design progress until the design turn finishes

Issue: #840

## What to do
Near the end of a design run, the design viewer drops its progress card and shows the Generate panel again, with Generate disabled and the note "A design run is under way; wait for it or stop it." A few moments later the revision appears without any action. The screenshot is from the stack design viewer (S-8). Board surfaces that read the design state can show the same stale "Generate design" state.

Root cause: `apps/web/src/components/design/design-viewer.tsx` (~line 497) renders `GeneratePanel` when `design.progress` is null and `isStarting(design)` (`apps/web/src/lib/design/progress.ts`) is false. On the API side, `progressOf` in `apps/api/src/design/design-progress.ts` returns null as soon as the design status leaves `generating`/`revising`. `loadDesignProgress` still reports `activeTurnId` for the queued or running design turn. So there is a window where the turn is still running (it is finishing and writing the revision) and the status is no longer busy. In that window the viewer falls back to the Generate panel, and `designWriteBlock` (`apps/web/src/lib/design/comments.ts`) disables it.

Fix it so a design with an active design turn always reads as busy:
- API: make `progressOf` report the active turn's progress whenever a queued or running design turn exists, not only while the status is busy. Alternatively, make sure the status does not leave `generating`/`revising` until the turn has finished. Pick whichever matches the turn-completion flow in `apps/api/src/design/`, and keep `lastFailureOf` consistent.
- Web: the viewer must not render `GeneratePanel` while `design.activeTurnId !== null`. Show the progress card, or the "Starting…/finishing" state with Stop, instead. Apply the same rule wherever the Board derives the design state label or the "Generate design" link (`apps/web/src/lib/design/format.ts`, `generate-design-link.tsx`).

## Acceptance criteria
- [ ] Reproduction no longer reproduces: through the end of a design run (generate and revise, task, card and stack designs), the viewer never shows the Generate panel while the design turn is queued or running. It shows progress until the revision appears.
- [ ] The Board card shows the design as in progress, not as "Generate design", while a design turn is active.
- [ ] Stop stays available during that final window.
- [ ] API unit test in `design-progress.spec.ts`: a design whose status is no longer busy but whose latest design turn is running yields non-null progress (or the chosen equivalent), and `activeTurnId` is set.
- [ ] Web unit test: the viewer/format rule treats `activeTurnId !== null` with `progress === null` as busy, not as the Generate state.
- [ ] After the turn finishes, the new revision shows. After a failed or cancelled turn, the Generate panel with the last failure shows as before.
- [ ] `bun run check` and the api/web tests pass.

## Out of scope
- Redesigning the progress card or the Generate panel.
- Changing how design turns or profile builds are scheduled.
- Any other design-viewer behaviour.

## Open questions
None.
