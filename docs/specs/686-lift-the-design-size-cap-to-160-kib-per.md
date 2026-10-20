# C-289: Lift the design size cap to 160 KiB per frame for multi-frame mockups

Issue: #686

## What to do
A stack design with several frames (e.g. S-7 "Simplify navigation and redesign project pages around the Board") fails with `contract_violation: design_too_large: the frames are 175677 bytes together; at most 163840`. The cap is checked on the sum of all frames in `parseDesignBlocks` (`packages/shared/src/planner/contract.ts`, ~line 509) against `DESIGN_HTML_MAX_BYTES = 160 * 1024` (`packages/shared/src/design/limits.ts`). It exists because the whole turn result travels in one `plan_turn.finished` event capped at `PLAN_TURN_RESULT_MAX_BYTES = 192 KiB` (`packages/shared/src/protocol/events/planner.ts`; the runner truncates in `apps/runner/src/planner/result.ts` `turnOutcome`).

Make the 160 KiB limit apply to each frame, and add a separate, larger cap for the whole design: a new `DESIGN_TOTAL_MAX_BYTES`, 1 MiB by default. Change the transport so a result larger than 192 KiB reaches the API intact. Recommended approach: the runner sends the result text in ordered chunk events (or some equivalent typed protocol extension per ADR-0010), and the API reassembles them before parsing. Keep the old single-event path working for small results. Update the design contract prompt text ("At most … KiB of HTML, all frames together" in `contract.ts`) so it states the per-frame and total limits. Update spec `docs/specs/223-design-stage.md` (D7) to match. If the transport change is an architectural decision, record it as an ADR.

## Acceptance criteria
- [ ] A design turn whose frames are 175 KiB together, each under 160 KiB, is parsed and stored as a revision instead of failing with `design_too_large`.
- [ ] A single frame over 160 KiB still fails with `design_too_large`, and the message names the frame.
- [ ] Frames over the new total cap fail with `design_too_large`, and the message states the total limit.
- [ ] A result larger than 192 KiB travels from the runner to the API without `resultTruncated`. A runner spec and an API e2e spec cover this.
- [ ] Non-design turns and small design results behave exactly as before; the existing specs in `contract.spec.ts`, `design.e2e.spec.ts` and `executor.tmux.spec.ts` pass (updated where the limit semantics changed).
- [ ] The design prompt and spec 223 state the new limits.
- [ ] `bun run check` passes.

## Out of scope
- Passing the failure reason into Retry (a separate card).
- Changing the D6 mockup rules (allowlisted hosts, forbidden features).
- The UI-profile kit limit (`UI_PROFILE_KIT_MAX_BYTES`).

## Open questions
- Total cap for all frames together. Default: 1 MiB.
- Transport mechanism. Default: ordered chunk events from the runner, reassembled by the API; the agent may pick an equivalent typed approach if it fits the protocol better.
