# ADR-0089: A person's session may work stacks, designs and dependencies; Approve stays a person's

Status: accepted · Date: 2026-10-24 · Card: C-377 ·
Spec: [`docs/specs/card-377-mcp-stack-and-dependency-tools-for-a-per.md`](../specs/card-377-mcp-stack-and-dependency-tools-for-a-per.md) ·
Extends: [ADR-0083](0083-a-persons-session-may-work-the-board-through-mcp.md) ·
Amends: [ADR-0054](0054-a-person-may-group-board-cards-into-a-stack.md) §1, §4 ·
Keeps: [ADR-0044](0044-stacks-staged-cards-under-one-shared-design.md) §4, [ADR-0067](0067-run-stack-queues-a-stacks-cards-within-the-agent-limit.md)

## Context

ADR-0083 lets a person's own Claude Code session run, move and answer cards
through MCP, but not group them into a stack, name a stage, set a dependency or
drive a design. Grouping C-368..372 into S-12 and starting its design had to go
through the web app's REST API from a browser session. A stack made by hand
also has only one stage (ADR-0054 §1), and no route can name a stage.

## Decision

1. **Stacks, designs and dependencies are typed local requests** served by the
   services the web routes use (`BoardStacks`, `BoardStackRuns`,
   `BoardDependencies`, `DesignService`): `stack.create`, `stack.addCard`,
   `stack.removeCard`, `stack.update`, `stack.run`, `stack.stop`,
   `stack.design`, `card.design`, `card.depend`, `card.undepend`, and the reads
   `stack.designView`, `card.designView`. `board.list` also answers the
   project's stacks with their stages, card numbers, design status and run.
2. **The writes follow ADR-0083 §2.** They answer only a manual session and an
   operator or better, are audited as `local.request` on behalf of the local
   user, and the design views answer any session of the project. The Board's
   and the design page's refusals pass through by name: `stack_refused`,
   `dependency_cycle`, `invalid_dependency`, `stack_design_not_approved`,
   `design_off`, `design_busy`, `no_open_comments`, `design_approved`,
   `task_frozen`.
3. **A stack may be made with stages in one call.** `stack.create` takes the
   stages in order; every card of a stage depends on every card of the stage
   before, as ADR-0044 §2 says for an intake stack. The stack, its stages and
   the dependencies are written in one transaction, and a stage order that
   closes a dependency cycle refuses the whole request with `dependency_cycle`.
   ADR-0054's one-stage stack is the one-stage case of the same path.
4. **A stage may be named.** `stack.update` and `PATCH …/board/stacks/:number`
   take `stages: [{ position, title }]`; an empty title clears the name, and a
   position that is no stage is `stack_refused`.
5. **Approving a design is a person's.** Generate and Revise from any session
   but a manual one are `not_a_manual_session`; Approve from such a session is
   `needs_person`, so a card worker is told to leave it to a person. A manual
   session is the person's own, and the web app lets any operator approve, so
   a manual session may approve. Approve without a revision takes the newest
   revision of the only variant still in play; with several variants in play
   it is `invalid_args` naming them, because choosing one is the person's.
6. **The MCP design tools take one `action`.** `stack_design` and
   `card_design` send `status` to the read method and the other actions to the
   write method, so a read is never audited as a write.

## Consequences

- A conversation can group, stage, name, run and stop a stack, and set
  dependencies, without the web app or a browser credential.
- A card worker can read a design but never move it forward, and cannot
  approve one even by asking.
- ADR-0054 §4's "later changes use the existing routes" now includes stage
  titles; the web app may offer stage names later on the same route.
- `stack.removeCard` takes the stack and the card only: the card's stage is
  known.
