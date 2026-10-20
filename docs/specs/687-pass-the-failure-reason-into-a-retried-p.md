# C-290: Pass the failure reason into a retried planner turn

Issue: #687

## What to do
`PlanTurnService.retry` (`apps/api/src/planner/plan-turn.service.ts`, ~line 360) re-runs a failed turn with the same action, input and scope. It does not tell the planner why the turn failed, so a deterministic failure such as a `contract_violation` (e.g. `design_too_large`) usually happens again. When a failed turn is retried, take its stored error (the contract violation code and message, or the runner error) and add it to the retried turn's prompt as a short note: "The previous attempt failed: <reason>. Fix this in your answer." This applies to design turns (built through `retriedDesign` / `apps/api/src/design/design-prompt.ts`) and to other planner actions. Follow the existing prompt-building pattern for each action; do not change the turn's input or its audit.

## Acceptance criteria
- [ ] Retrying a design turn that failed with `design_too_large` sends a prompt that contains the violation code and message.
- [ ] Retrying a non-design turn that failed with a contract violation sends a prompt with that reason.
- [ ] A turn that failed with no stored error is retried exactly as today.
- [ ] The note is capped in length so it cannot push the prompt over its byte cap.
- [ ] Specs cover the design case and the non-design case; `bun run check` passes.

## Out of scope
- Automatic retries without the person pressing Retry.
- Changes to the design size limits (a separate card).
- UI changes to the Retry button or the error banner.

## Open questions
None.
