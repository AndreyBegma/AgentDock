# C-262: Offer the design skills picker before generating a stack design

Issue: #644

## What to do
On the stack page (`apps/web/src/app/(app)/projects/[projectId]/board/stacks/[number]/page.tsx`), the **Generate design** button (desktop header actions and the phone design dock, #526) currently POSTs `…/stacks/:number/design/generate` straight away, so the person never chooses design skills for the stack's shared design. A card's design is generated through `GeneratePanel` (`apps/web/src/components/design/generate-panel.tsx`), which offers the variant count and the **Design skills** picker (up to `DESIGN_SKILLS_MAX`, pre-filled from the project's default skills, installed skills from `installedSkillsApi`). Generating a stack design must offer the same choice.

The backend already supports this: a stack's `TaskDesign` is created with the project's `defaultSkills` (`apps/api/src/board/board-stacks.ts`), and `PATCH projects/:projectId/board/stacks/:number/design` (`apps/api/src/design/stack-design.controller.ts`) accepts `variantCount` and `skills`. The full-screen stack viewer (`stacks/[number]/design/page.tsx`) already renders `GeneratePanel` through `DesignViewer`. Make the stack page's Generate design go through the same choice. Recommended: open the stack design viewer, where `GeneratePanel` already is, or show `GeneratePanel` in a glass-ui dialog or sheet. Do not build a second skills picker. Reuse `GeneratePanel` as it is; a missing primitive goes into glass-ui (ADR-0011).

## Acceptance criteria
- [ ] On a stack whose design has no revision yet, clicking Generate design on the stack page (desktop and the phone dock) shows the Design skills picker and the variant count before any generate request is sent.
- [ ] The picker is pre-filled with the stack design's current skills, which start as the project's default design skills, and lists the project's installed skills.
- [ ] Changed skills or variant count are saved with `PATCH …/stacks/:number/design` before `POST …/generate`, and the design turn uses them (the prompt's `## Design skills` section lists them).
- [ ] Skills that are no longer installed still appear as removable, as for a card's design.
- [ ] A viewer-role user cannot change skills or generate, as today.
- [ ] Revise design and Approve design on the stack page behave as before.
- [ ] A web test covers the stack page's Generate design path showing the skills choice.

## Out of scope
- No API or Prisma schema changes; the stack design PATCH and skills storage already exist.
- Do not change how card or planner task designs choose skills.
- Do not add skills selection to the intake's stack proposal (split review) or change the project's default design skills settings.
- Do not auto-start stack design generation.

## Open questions
- Where the choice appears on the stack page. Default: Generate design opens the stack design viewer, where `GeneratePanel` already shows the skills picker. If a panel fits better on the page, a glass-ui dialog or sheet wrapping `GeneratePanel` is acceptable.
