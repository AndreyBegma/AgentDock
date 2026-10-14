# ADR-0025: A design has exactly one owner — a plan task or a board card

Status: accepted · Date: 2026-10-14 ·
Issue: [#243](https://github.com/AndreyBegma/AgentDock/issues/243) ·
Amends [ADR-0022](0022-design-stage-html-mockups-from-a-ui-profile.md) §3

## Context

ADR-0022 §3 made the design stage a step of the Planner: every design belongs
to a plan task, and spec 223 put "a design outside a plan" out of scope. The
Board (#242, ADR-0024) then added work items that never pass through a plan —
a card goes from To Do straight to a dedicated worker. People want the same
mockup, comments, pins, revise and approve on a card before its worker starts,
and the approved mockup in the card's branch.

The design stage's storage is keyed by the plan: `task_designs` by
`(planId, taskKey)`, every `design_revisions` row points at the `plan_turns`
row that drew it, and the runner's `plan.turn` executes a design turn in a
read-only worktree it keeps per `planId`.

Two ways were weighed on 2026-10-14:

- **A hidden one-task plan per card.** No schema change in the design tables,
  but the plan would leak into plan lists, `/tasks`, plan visibility rules and
  the write-turn chaining that approving a task's design triggers (#223 D1),
  and every one of those would need a "but not this kind of plan" exception.
- **A second owner on the design itself.** The design, its revisions and its
  comments stay one model; only what owns a design and a design turn changes.

## Decision

1. **A design has exactly one owner**: a plan task (`planId` and `taskKey`) or
   a board card (`cardId`, unique). The database enforces it with a CHECK on
   `task_designs`; the unique `(planId, taskKey)` stays. A card's design is
   deleted with the card.
2. **A design turn has exactly one owner too**: a `plan_turns` row has a
   `planId` or a `cardId`, never both (CHECK). Revisions keep pointing at
   `plan_turns`, so revisions, comments, the validator and the turn projector
   are shared unchanged.
3. **The runner sees no difference.** A card's design turn is the unchanged
   `plan.turn` command with `planId = card.id`; the runner mints a worktree for
   any unknown `planId`, and `plan.close {planId: card.id}` removes it. The
   card keeps its own design session (`designSessionId`), separate from its
   worker session.
4. **The API reaches the owner through one seam** (`DesignOwner`: read rule,
   open check, gate, turn, approval, publication), so the design flow is one
   module with two hosts. The view says which: `owner: {kind:'task', planId,
   taskKey} | {kind:'card', cardId, number}`.
5. **What an approved design leads to depends on the owner.** A task's chains
   the plan's write turn and is published in the docs pull request (ADR-0022
   §3, unchanged). A card's chains nothing; its approved variant is committed
   into the card's branch when the card runs, and the worker prompt carries a
   `## Design` section. A card's switch, **Continue after design**, decides
   whether approving starts the worker.

## Consequences

- `task_designs.planId` / `taskKey` and `plan_turns.planId` are nullable, so
  every reader of them handles the card case; the CHECKs keep a half-owned row
  out of the database whatever the code does.
- The name `TaskDesign` now also covers a card's design. It is kept: renaming
  the model and the table would touch every design query for no behaviour.
- A design cannot move between a plan task and a card, and a card's design
  freezes once the card has a round.
- Rejected: a hidden one-task plan per card (see Context).
