# ADR-0034: The Planner lives on the Board and makes cards

Status: accepted · Date: 2026-10-15 · Amends [ADR-0028](0028-one-work-surface-for-cards-and-plan-tasks.md) ·
Issue: [#337](https://github.com/AndreyBegma/AgentDock/issues/337)

## Context

ADR-0028 kept plan tasks and board cards as separate data models. Plan tasks
reach the Board only as read-only projections, and the Planner has its own
page. On 2026-10-15 the product owner decided that the Board is the one place
where work starts:

- a single card is created through an interview;
- a plan ends in real cards.

## Decision

1. **New Card is an interview.** The person writes what they want, in any
   language. A Planner session in a new mode, `card`, asks question rounds in
   that language until the task is clear (at most 4 rounds), or until the
   person says enough. It then writes one card in English: a title, and a
   body that is a mini-spec.
2. **New Plan makes cards.** The Planner runs on the Board. Its result
   becomes board cards, with dependencies mirroring the task graph. Sending
   the plan to the orchestrator fleet as issues stays available.
3. **One engine.** Both use the Planner's turn machinery (`plan.turn`, the
   API-built prompt of ADR-0019). The card mode is a mode, not a new
   subsystem.
4. **The Planner page is retired.** Existing plans stay readable, and their
   tasks keep projecting onto the Board (ADR-0028 §2) until they are closed.
   New plans start only on the Board. ADR-0028 §1 (separate data models)
   still holds for those old plans. New work is board cards.
5. **The planning model is a per-person setting** (default `sonnet`). It can
   be chosen at each start.

## Consequences

- A card starts with a model conversation of 0–4 rounds, which is slower and
  costs more than typing a title. *Enough — generate* is always available.
- Cards gain dependencies. Run warns about an open one but does not block.
- Model-written card text is English by contract, so DeepL normalization
  (ADR-0033) is not involved in generated cards.
- Two kinds of planning output now exist: board cards (worked by card
  workers) and fleet issues (worked by the orchestrator). The person chooses
  per plan.
