# Replace New card and New plan with one New work intake that can split

Issue: #409 · Board card: C-40

## What to do
Replace the two Board buttons, **New plan** and **New card**, with one entry point named **New work**. It opens the existing intake dialog (`apps/web/src/components/board/new-card-dialog.tsx`, `intake-view.tsx`). Its title, description and the Board button (`apps/web/src/app/(app)/projects/[projectId]/board/page.tsx`) change from "New card" to "New work". The Work list button (`apps/web/src/app/(app)/work/page.tsx`) changes the same way.

The intake decides by itself how many cards the request makes:
- One clear task: the interview and the single card work as they do today.
- Several tasks dictated together, or one task that is too big for a single agent: the intake proposes a split. The person can accept it or decline it and keep one card.
- On accept, the intake shows the list of proposed cards (title, kind, short summary). The person edits the list and confirms, and then several independent cards are created on the Board at once. They have no plan and no dependencies between them.

This needs three changes:
- The intake prompt (`apps/api/src/planner/plan-prompt.ts`, `plan-intake.ts`) must stop saying "write the first card and send the rest to New Plan" and instead propose the split.
- The intake output contract (`packages/shared/src/planner/contracts.ts`, `packages/shared/src/board/contracts.ts`) must be able to carry a split proposal and several card drafts.
- The API must create the cards from a confirmed split (`apps/api/src/planner/plan-cards.service.ts`, `apps/api/src/board/board-plan-cards.ts`).

The user-facing copy that names New card or New Plan is updated to match: `planner/page.tsx`, `planner/[planId]/page.tsx`, `fleet/first-project-checklist.tsx`, `drafts-strip.tsx`, `account/planning-model-card.tsx`. Record the decision as a new ADR in the same PR, next to ADR-0034 (the planner lives on the Board).

## Acceptance criteria
- [ ] The Board and the Work list show one button, **New work**. The **New plan** and **New card** buttons are gone.
- [ ] The dialog title and description say "New work". The screenshot's copy "New card" no longer appears anywhere in the UI.
- [ ] A single clear task gives one card with no split proposal, as it does today.
- [ ] A dictation of several unrelated tasks makes the intake propose a split into several cards. The person can decline and keep one card.
- [ ] A single oversized task makes the intake propose a split into several cards. The person can decline and keep one card.
- [ ] Accepting a split shows the list of proposed cards. The person can edit or remove entries before confirming.
- [ ] Confirming creates all listed cards on the Board in one step. They carry no plan or dependency links, and each follows the usual card rules (English title and body, the four sections).
- [ ] Closing the dialog mid-interview still keeps the intake as a draft, and Resume from the Drafts strip works for the new flow.
- [ ] Existing plans stay readable. Old links, `?intake=` and `?newPlan=` URLs do not break.
- [ ] Copy that mentioned New card or New Plan now points to New work.
- [ ] Tests are added or updated for the split proposal, the multi-card creation and the single-card path (api: `*.spec.ts` next to the code, web: `intake.test.ts`).
- [ ] A new ADR records the change. `bun run check`, `bun run lint` and `bun run test` pass.

## Out of scope
- Plans with dependencies between tasks. The plan machinery (`plan.service.ts`, the plan workspace, task dependencies) stays as it is, even if the button that started it goes away.
- Changing how a card is executed, assessed or shipped.
- Adding new glass-ui components. Use the existing ones (ADR-0011).
- Changing the model picker or the planning-model setting.

## Open questions
- Should the Planner be reachable from anywhere once New plan is gone? Default: no new entry. Existing plans stay readable through their current links, and no new plans are started.
- Maximum number of cards in one split. Default: the intake proposes at most 8, in line with the 1-8 question limit of a round.
- Does a confirmed split need one approval per card? Default: no, one confirmation creates all cards.
