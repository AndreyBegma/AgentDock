# ADR-0067: Run stack queues a stack's cards and starts them within the agent limit

Status: accepted · Date: 2026-10-19 · Amends [ADR-0044](0044-stacks-staged-cards-under-one-shared-design.md) ·
Card: C-269 · Issue: #652 ·
Spec: [`docs/specs/652-add-a-run-stack-button-that-queues-cards.md`](../specs/652-add-a-run-stack-button-that-queues-cards.md)

## Context

A stack (ADR-0044) could only be run card by card. The per-card "Auto-run when
ready" switch (#443) fires once, on acceptance, and stores a refused start such
as `max_running` on the card instead of trying again. Stacked branches
(ADR-0064) made it possible to start a stage-2 card as soon as its dependency
has an open pull request, but nothing did so on its own.

## Decision

1. **Run stack is a persisted queue.** `POST board/stacks/:number/run`
   (operator) writes the stack's To Do cards into `board_stack_run_cards`
   under one `board_stack_runs` row per stack. The run holds the person who
   pressed it and their role; the queued cards start as them. It is refused
   with `stack_design_not_approved` while the stack design gates the stack
   (ADR-0044 §6).
2. **One scheduler starts queued cards through the card Run.** Every
   `board.changed` of a card (`BoardWork.publish`) re-evaluates the project's
   running stack runs, one evaluation per project at a time; bootstrap and a
   60-second sweep resume them after a restart. A queued card is ready when
   `assertRunnable` allows it under ADR-0064 — a single dependency with an
   open PR from a finished round, or every dependency landed. A card with
   several dependencies waits until all of them are merged and is never
   stacked on the one left. Ready cards start through `BoardRoundsService.run`
   in stack, stage, then number order while the project's active rounds stay
   below `BoardSettings.maxRunning`, so every guard of a manual Run applies.
3. **Only `max_running` and an absent runner wait.** A `max_running`
   refusal leaves the card queued; it starts when a slot frees. While the
   project's runner is not connected — after an API restart, say — nothing
   starts and nothing pauses; the runner's `hello` resumes the run. Any other
   refusal (budget, profile,
   design, runner) or a round the run started that ends `failed` or `ended`
   pauses the run with the reason (`pausedCode`, `pausedMessage`,
   `pausedCardId`). A refused start is also stored on the card
   (`autoRunFailure` with `stack`). A paused run starts nothing until Run
   stack is pressed again, which clears the pause and continues from the
   cards left.
4. **Stop removes the queue only.** `POST board/stacks/:number/stop` deletes
   the queued and waiting entries; cards the run already started keep
   running. Start, pause and stop are audited as `stack.run_started`,
   `stack.run_paused` and `stack.run_stopped`.
5. **The limit is the Board's.** Only `maxRunning` counts; orchestrator fleet
   slots do not.

## Consequences

- The stack page has Run stack / Resume stack and Stop, the run's state and a
  pause banner; each card row and the Board stack face show the run state.
- A card a person starts or moves out of To Do while it is queued leaves the
  queue (or counts as started by the run when its round is active).
- The per-card Auto-run when ready switch is unchanged.
