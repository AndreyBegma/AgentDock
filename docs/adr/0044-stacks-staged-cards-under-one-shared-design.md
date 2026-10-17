# ADR-0044: Stacks — staged cards under one shared design

Status: accepted · Date: 2026-10-16 · Amends [ADR-0037](0037-new-work-is-one-intake-that-can-split.md) §4,
[ADR-0025](0025-a-design-has-one-owner-a-plan-task-or-a-board-card.md) §1–§4 ·
Issue: [#480](https://github.com/AndreyBegma/AgentDock/issues/480) ·
Spec: [`docs/specs/480-add-card-stacks-staged-cards-sharing-one.md`](../specs/480-add-card-stacks-staged-cards-sharing-one.md)

## Context

ADR-0037 §4 made the cards of a split independent and said that work which
must happen in order is written as one card. Some work is bigger than one
card and still ordered: redesigning a page means building its components
first and then composing the page from them, and every part has to share one
look. Written as one card, it is too big for one agent; written as a split,
the order and the shared look are lost, and each card's design is drawn
without the others.

ADR-0025 gave a design exactly one owner, a plan task or a board card. A
design of the whole result — the full page that several cards build — has
no such owner.

## Decision

1. **A stack is a group of cards in ordered stages.** `board_stacks` holds a
   per-project number (`S-<n>`), an English title and a Markdown body;
   `board_stack_stages` holds its stages in order, each with a short title.
   A card belongs to at most one stack and one stage (`board_cards.stageId`).
   Cards of one stage may run in parallel.
2. **Stages are ordinary dependencies.** Every card of stage N+1 gets a
   `board_card_dependencies` row on every card of stage N, written when the
   stack is made and when a card joins or leaves a stage. Everything that
   reads dependencies — Run's warning, Ready / Waiting, Auto-run when ready —
   applies to stacks without knowing about them. Nested stacks and arbitrary
   graphs inside a stack are not modelled.
3. **The intake may propose a stack** (amends ADR-0037 §4). The intake output
   contract gains a fourth, additive branch `stack`: a reason, a title, a
   body, a `design` suggestion and 2 or more stages holding 2–8 cards in all,
   each written in full like a split card. The intake proposes a stack when
   the request is one larger piece of work whose parts must happen in order
   and share one look, and a plain split when the parts are independent.
   Several UI changes to one surface or form factor — one screen, one page,
   the Board on phones — share one look too, so they are a stack with a
   design, staged foundations first (the shared layout and primitives, then
   the per-feature cards), even when they have no natural order (#524). The
   contract version stays 3: a stored output of an earlier turn still reads
   back. In the review the person switches between **Split** and **Stack**
   (a split turned into a stack opens with a shared design and an empty
   "Foundations" stage before "Features"), moves cards between stages, and confirms in one step; Confirm
   (`POST …/plans/:planId/split` with `stack`) creates the stack, its stages,
   its cards in To Do, the stage dependencies and — when asked — its design
   row in one transaction. Split cards stay independent as before.
4. **A design has exactly one owner: a plan task, a board card, or a stack**
   (amends ADR-0025 §1, §2). `task_designs.stackId` and `plan_turns.stackId`
   join the owner CHECKs. A stack's design is drawn for the whole result and
   runs through the same flow — Generate, comments, Revise, Stop, Approve —
   as the unchanged runner command `plan.turn` with `planId = stack.id`
   (ADR-0025 §3). Its turns use the project's profile and model; a stack has
   no launch choice of its own.
5. **A card's design stays its own.** A card of a stack that needs a design
   keeps its own `task_designs` row; the two designs are never merged. A
   card's design turn reads the stack's approved design as reference, and
   round 1 of a stack card commits the stack's approved frames into the
   card's branch (`<specDir>/stacks/S-<n>-<slug>/design/<variant>/…`) and
   names them under `## Stack` in the worker prompt, beside the card's own
   `## Design`.
6. **Design first.** While a stack's design is needed and not approved, Run
   on any card of the stack is refused (`409 stack_design_not_approved`) and
   disabled in the UI with the reason. Generate and Revise of a card's own
   design are refused and disabled the same way (#527): until the stack
   design is approved, a card's design turn has no reference to read (§5).
   A stack without a design — the person switched it off — holds nothing.
7. **On the Board a stack is one face.** It sits in the column of its least
   advanced unfinished card (Completed once every card is), shows its
   progress (accepted / total) and current stage, and expands in place to its
   cards by stage. A card of the stack in another column shows its stack
   label on its own face. Opening a stack goes to its own page.

## Consequences

- `DesignKey`, the design view's `owner` and the live events carry a third
  kind, `stack`; every reader of a design's owner handles it.
- Stages are not stored as an order on the dependency rows: removing a card
  from a stage removes the rows that tied it to the stages beside it, and a
  stage left empty closes its gap only while no card of the stack has run.
  Once one has, stages are not reordered.
- Editing a stage dependency by hand on a card's sheet is still possible; the
  stack does not re-check it.
- A stack is not sent to the orchestrator fleet; its cards are board cards.
