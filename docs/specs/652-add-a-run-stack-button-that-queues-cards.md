# C-269: Add a Run stack button that queues cards within the agent limit

Issue: #652

## What to do
There is no way to start a whole stack. The stack routes in `apps/api/src/board/board.controller.ts:105-158` only create and edit it, bulk card actions (`BULK_CARD_ACTIONS`, `packages/shared/src/board/contracts.ts:598`) have no `run`, and the per-card "Auto-run when ready" switch (`apps/api/src/board/board-auto-run.ts`) fires only on acceptance and never retries a refused start such as `max_running`.

Add `POST board/stacks/:number/run` and a "Run stack" button for operators on the stack page (`apps/web/src/app/(app)/projects/[projectId]/board/stacks/[number]/page.tsx`), using glass-ui only (ADR-0011). Disable the button while the stack design is required but not approved (ADR-0044 §6).

Running a stack puts its not-yet-started To Do cards in a persisted stack run queue. A scheduler starts queued cards through the existing `BoardRoundsService.run`, so the existing guards for slots, budget, profile and design all apply. Start rules:
- A queued card is **ready** when `assertRunnable` allows it under the stacked-branch rules: every dependency has finished its round with an open PR (single dependency, stacked branch), or all its dependencies are merged (several dependencies).
- Ready cards start in stage then number order, in parallel, while active rounds stay below the project's `BoardSettings.maxRunning` (the `assertRoom` limit in `board-rounds.service.ts:1041-1065`).
- The scheduler re-evaluates when a round finishes, a PR opens, a card merges or is accepted, and a slot frees. A `max_running` refusal leaves the card queued instead of failing it.
- Any other refusal (budget, profile, error) or a failed round pauses the stack run and shows the reason on the card and the stack page.

The stack page and the Board stack face (`apps/web/src/components/board/stack-face.tsx`) show the run state: running, queued, waiting for a dependency, paused with a reason, done. Add a Stop control that removes the remaining queue without stopping cards already running. Audit start, pause and stop.

## Acceptance criteria
- [ ] An operator presses "Run stack" and every stage-1 card starts, up to `maxRunning`. Extra ready cards stay queued and start as slots free.
- [ ] A stage-2 card with one dependency starts automatically once that dependency's round finishes with an open PR, branching per the stacked-branch rules.
- [ ] A card with several dependencies starts only after all of them are merged.
- [ ] A `max_running` refusal never fails a queued card; it starts when a slot frees.
- [ ] A budget, profile or round failure pauses the stack run, and the reason is visible on the stack page.
- [ ] Stop clears the queue and leaves running cards untouched. Pressing Run stack again resumes from the remaining cards.
- [ ] The button is disabled for viewers and while the stack design gate is closed.
- [ ] API tests cover parallel start within `maxRunning`, queueing on `max_running`, dependency-driven start, pause on failure and stop. Only glass-ui components are used.

## Out of scope
- Changing branch or PR base selection (stage 1 does that).
- Running cards that are not in a stack, or several stacks as one batch.
- Changing `maxRunning` defaults or the per-card Auto-run switch.
- Sending stacks to the orchestrator fleet (ADR-0044).

## Open questions
- Does the agent limit count only Board card workers (`maxRunning`) or also orchestrator fleet slots? Default: only `maxRunning`, the existing Board limit.
- Should a stack run survive an API restart? Default: yes, the queue is persisted and the scheduler resumes on start.
