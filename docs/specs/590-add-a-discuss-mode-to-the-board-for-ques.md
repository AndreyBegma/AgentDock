# C-233: Add a Discuss mode to the Board for questions and analysis

Issue: #590

## What to do
Add a **Discuss** button next to **New work** on the Board (`apps/web/src/app/(app)/projects/[projectId]/board/page.tsx`). It opens a free-form conversation with the planning model about the project. The person can ask questions about the code and architecture, or ask for an analysis (security, performance, architecture). Unlike the New work intake (ADR-0037), a discussion has no round limit and no required result: it does not have to end in a card.

Run it on the existing Planner turn machinery as a new plan mode, `discuss`, alongside `batch`, `dialogue` and `card` (`PlanMode` in `apps/api/prisma/schema.prisma`; the migration goes through `prisma migrate dev`). Give it its own prompt and output contract in `apps/api/src/planner/plan-prompt.ts` and `plan-turn-projector.ts`. Each turn answers with a markdown reply and, optionally, proposed cards. Each proposal is a short title and a brief. The repository is read on the runner only, read-only (ADR-0001, ADR-0010).

When the discussion starts, the person may pick one or several of the project's installed skills (for example cs-security, cs-perf, cs-arch). This works as the design generate panel does (`apps/web/src/components/design/generate-panel.tsx`, `installedSkillsApi`). The chosen skills are passed into the discussion's turns.

Under each proposed card, a **Make a card** action opens New work with What to do prefilled from the proposal, through the existing `?brief=` prefill (ADR-0037 §5).

Discussions are stored. They appear in the Drafts strip (`apps/web/src/components/board/drafts-strip.tsx`) with **Resume** and **Discard**, as intake drafts do. Discard archives the discussion.

Record the decision as a new ADR in the same pull request.

## Acceptance criteria
- [ ] The Board shows a **Discuss** button next to **New work**. It opens a discussion dialog, not the intake.
- [ ] The person can send messages and get replies, with no limit on the number of turns and no requirement to produce a card.
- [ ] When starting a discussion, the person can choose zero or more installed project skills from a picker. The chosen skills are stored on the discussion and passed to its turns.
- [ ] Asking for a security review with a security skill selected produces a report in the conversation, and no file in the project changes.
- [ ] A reply may include proposed cards. **Make a card** on a proposal opens New work with What to do prefilled from it.
- [ ] A discussion is persisted. It appears in Drafts with Resume, which reopens it with its full history, and Discard, which archives it.
- [ ] A failed or running turn shows the existing running and failed states, with cancel and retry.
- [ ] The `discuss` mode's output contract is validated by the API. A malformed turn fails with an error and changes nothing.
- [ ] API specs cover creating a discussion, a turn with a reply, a turn with proposals and archiving.
- [ ] A new ADR records the Discuss mode.

## Out of scope
- Creating cards directly from a discussion. Cards only come through New work.
- Questions about board, fleet, budget or session state.
- Any change to the New work intake contract or to how intake drafts become cards.
- Writing to the repository from a discussion.

## Open questions
None.
