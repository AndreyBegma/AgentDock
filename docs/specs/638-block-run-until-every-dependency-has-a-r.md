# C-266: Block Run until every dependency has a ready PR, with no override

Issue: #638

## What to do
Today a dependency is open until it reaches Completed, and Run only warns: the API answers `409 dependency_open` and the UI offers "Run anyway", which re-sends with `ignoreDependencies` (#337 D8). Stack stages are plain dependencies (ADR-0044 §2), so a person can run stage 3 while stage 2 has no pull request yet (see the Board stack view: C-17 "after C-13, C-14 +2" shows an enabled Run).

Make dependencies a hard gate with a lower threshold:
- A dependency is satisfied once its card is in **Finished** (the agent's pull request is ready) or **Completed**. Update `isOpenDependency` in `apps/web/src/lib/board/dependencies.ts` and `openDependencies` / `assertRunnable` in `apps/api/src/board/board-dependencies.service.ts` to the same rule; keep one shared definition in `packages/shared` if both sides need it.
- Remove the override: drop `ignoreDependencies` from the Run DTO (`apps/api/src/board/dto.ts`) and from `board-rounds.service.ts`, so `assertRunnable` always refuses an unsatisfied dependency with `409 dependency_open`.
- In the web app, disable the Run button on the card face, the card sheet and the stack face (`apps/web/src/components/board/stack-face.tsx`, `card-dependencies.tsx`), with the reason as a tooltip/hint ("Waits for C-13, C-14 and C-16"); remove the "Run anyway" path. Use glass-ui components only (ADR-0011).
- Auto-run when ready (`apps/api/src/board/board-auto-run.ts`, #443) currently fires on acceptance; make it also fire when a dependency moves into Finished and that leaves no unsatisfied dependency.
- A dependency that leaves Finished (sent back with feedback, moved back) makes its dependants blocked again; a dependant already running is not stopped.
- Record the decision as a new ADR amending #337 D8 and ADR-0044 §2's "Run's warning".

## Acceptance criteria
- [ ] A To Do card with a dependency in To Do or In Progress shows a disabled Run with the waiting cards named; it cannot be started from any surface.
- [ ] `POST …/run` for such a card returns `409 dependency_open` naming the open dependencies, and a request carrying `ignoreDependencies` is rejected by validation (the field no longer exists).
- [ ] Once every dependency is in Finished or Completed, Run is enabled and starts the card.
- [ ] Sending a Finished dependency back with feedback disables Run on its dependants again.
- [ ] A card with Auto-run on starts by itself when its last dependency reaches Finished, and still when it is accepted, never twice.
- [ ] The dependency chip on card faces reads a Finished dependency as satisfied (not warn).
- [ ] Stack design gating (`stack_design_not_approved`, ADR-0044 §6) still applies before the dependency check.
- [ ] Api specs cover `assertRunnable` and auto-run on Finished; web tests cover `isOpenDependency` and the disabled Run.
- [ ] A new ADR records the change.

## Out of scope
- Which branch the dependant starts from (a separate card).
- Blocking Move or Accept on dependencies — they stay unblocked.
- Stopping a dependant that is already running when its dependency goes back.

## Open questions
None.
