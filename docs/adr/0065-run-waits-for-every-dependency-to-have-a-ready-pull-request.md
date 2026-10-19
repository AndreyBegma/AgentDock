# ADR-0065: Run waits for every dependency to have a ready pull request

Status: accepted · Date: 2026-10-19 ·
Issue: [#638](https://github.com/AndreyBegma/AgentDock/issues/638) ·
Amends [#337 D8](../specs/337-planner-on-the-board.md),
[ADR-0044](0044-stacks-staged-cards-under-one-shared-design.md) §2 and
[ADR-0064](0064-a-dependent-card-branches-from-its-dependency-with-a-stacked-pr.md) §1

## Context

#337 D8 made a card dependency a warning. Run on a card whose dependency was
not in Completed answered `409 dependency_open`, and the web app asked
"Run anyway?", which sent the Run again with `ignoreDependencies: true`.
ADR-0044 §2 made the stages of a stack ordinary dependencies, so "Run's
warning" was the only thing between stage 2 and stage 3. A person could start
stage 3 while stage 2 had no pull request at all: its worker branched from a
base that lacked the work it was meant to build on, and the warning was easy
to click through.

At the same time Completed was a needlessly high bar. A dependency is in
Completed only after a person accepted it, but a dependant can start as soon
as the dependency's pull request is ready for review, which is what Finished
means.

## Decision

1. **A dependency is satisfied in Finished or Completed.** Finished means the
   agent's pull request is ready; Completed means the card was accepted. Any
   other column — Inbox, To Do, In progress — leaves the dependency open.
   The one definition is `isDependencySatisfied` in `@agentdock/shared`; the
   API's Run check, the auto-run claim, readiness, the face's dependency chip
   and the web app's Run all read it.
2. **An open dependency blocks Run, with no override.** `POST …/run` on a card
   with an open dependency answers `409 dependency_open`, naming the open
   ones, for every Run — the first one and a Run again. `ignoreDependencies`
   is removed from the Run request; a request that carries it fails
   validation (`400`). The stack design gate (`stack_design_not_approved`,
   ADR-0044 §6) is still checked first.
3. **The web app shows Run disabled with the reason** wherever it offers Run:
   the card menu ("Run — waits for C-13"), the card sheet's launch popover
   (with "Waits for C-13 and C-14." under the button row), the stack face
   (a tooltip, like the design gate) and the "Run the worker?" question of a
   drag into In progress. The "Run anyway?" dialog is removed.
4. **Auto-run when ready (#443) fires on Finished too.** A card moving into
   Finished, and a card being accepted, both try to start every To Do
   dependant with the switch on and no open dependency left. The one-row
   claim that turns the switch off keeps the start to exactly once, so a
   dependency's Finished and its later Accept never start the dependant
   twice. A dependency that reaches Finished automatically (the worker's
   `finish_card`, CI going green) starts the dependant as AgentDock
   (`BOARD_SYSTEM_ACTOR`); a refusal is stored on the card as before.
5. **Leaving Finished opens the dependency again.** Feedback, Run again or a
   move back to In progress or To Do makes its dependants wait again; their
   faces are refreshed through `board.changed`. A dependant that is already
   running is not stopped.
6. Moving and Accept stay unblocked by dependencies.
7. **The gate runs before the stacked base (ADR-0064).** `assertRunnable`
   first refuses an open dependency (this ADR), then chooses the base among
   the dependencies not landed in the project base, as ADR-0064 §1 says:
   none — the base; one with an open PR from a finished round — stacked on
   its branch; one without such a PR — `dependency_open`; two or more —
   `dependencies_unmerged`. ADR-0064 §1's "`ignoreDependencies` checks
   nothing and starts the card from the project base" no longer holds:
   `dependencies_unmerged` is a refusal like `dependency_open`, with no
   "Run anyway", and the web app names the cards in the toast.

ADR-0044 §2 now reads "Everything that reads dependencies — Run's gate,
Ready / Waiting, Auto-run when ready — applies to stacks without knowing about
them."

## Consequences

- A card cannot start before the cards it depends on have a pull request.
  When a person truly needs to start it anyway, they remove the dependency in
  the sheet — a visible, audited change — instead of clicking past a warning.
- A dependant may start from a dependency whose pull request is still in
  review and may change; ADR-0064 stacks it on that branch.
- A card that waits for two or more Finished, unmerged dependencies shows
  Run enabled (every dependency is satisfied) and is refused with
  `dependencies_unmerged` until all but one are merged. An Auto-run that
  meets this refusal stores it on the card, like any refused auto-run.
- `CardReadiness.accepted` is renamed `satisfied`: it counts dependencies in
  Finished or Completed.
- Auto-run after an automatic Finished runs as AgentDock, so the project's
  permission mode must not need an admin (`bypassPermissions`) for it to
  start; otherwise the card shows "Didn't start" with the reason, as for any
  refused auto-run.
