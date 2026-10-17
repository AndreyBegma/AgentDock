# C-248: Always apply the project's default design skill set

Issue: #604

## What to do

The person picks the same design skills (for example `web-design-guidelines`, `frontend-design`, `high-end-visual-design`, `design-taste-frontend`) on every card's "Draw the mockup" panel. A project-level default already exists (`DesignSettings.defaultSkills`, edited in Settings → Design by `design-settings-section.tsx`), but it is easy to miss and it is only *copied* into a design row once, when the design is created (`defaultSkillsOf` in `apps/api/src/design/design-store.ts`, `DesignService` in `apps/api/src/design/design.service.ts`, stack designs in `apps/api/src/board/board-stacks.ts`). A later change to the default never reaches an existing, not-yet-generated design, and an empty default means every card starts blank.

Make one saved set that is always applied:

- In `apps/web/src/components/design/generate-panel.tsx`, add a "Save as project default" action next to the skills field (project admins only, the same permission as the Settings → Design write), so the set can be saved straight from the panel the person is already in. Reuse the existing settings update and its audit entry (`DesignSettingsService.update`).
- Show the panel's skills as the project defaults until the person edits them by hand, and offer a "Use defaults" reset for the skills, like the existing one for profile and model.
- For a design that has not been generated yet and whose skills were never edited by hand, resolve the skills from the project default at generation time, so a change to the default reaches cards that already exist. A design whose skills were edited by hand keeps its own set. This applies to card designs, plan-task designs and stack designs alike.
- Skills that are no longer installed stay filtered out by the existing check; the panel keeps showing them as warnings as it does today.

## Acceptance criteria

- [ ] With a project default set, a new card's "Draw the mockup" panel opens with that set pre-filled and nothing has to be entered to generate.
- [ ] Changing the project default changes the skills used by an existing design that has not been generated and was never hand-edited.
- [ ] A design whose skills were edited by hand on its own panel is not overwritten by a later change of the project default.
- [ ] A project admin can save the panel's current skills as the project default from the panel; the change is audited like a save from Settings → Design.
- [ ] A non-admin sees no "Save as project default" action.
- [ ] Stack designs and plan-task designs use the same resolution as card designs.
- [ ] Tests cover the resolution (default vs. hand-edited vs. empty default) and the save-as-default permission.
- [ ] The UI uses glass-ui components only (ADR-0011).

## Out of scope

- A per-user or global (cross-project) skill set; the set stays per project.
- Changing how skills are installed or listed, or the 12-skill cap.
- Changes to the design prompt itself.
- Changing the skills of an already approved design.

## Open questions

- Should the set be per project or global? Default: per project, as `DesignSettings` already is.
- Should a hand-edited design keep its own set when the default changes? Default: yes, a manual edit wins.
