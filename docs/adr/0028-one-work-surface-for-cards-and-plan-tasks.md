# ADR-0028: One work surface for cards and plan tasks

Status: accepted · Date: 2026-10-15 · Scopes
[ADR-0024](0024-board-cards-and-dedicated-card-workers.md) §2 ·
Issue: [#270](https://github.com/AndreyBegma/AgentDock/issues/270)

## Context

AgentDock has two kinds of work item. A **plan task** is written by the
Planner, issued as a GitHub issue and worked by the fleet
([ADR-0004](0004-github-issues-are-the-task-queue.md),
[ADR-0005](0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md)).
A **board card** is AgentDock's own entity, worked by a dedicated card worker
outside the orchestrator
([ADR-0024](0024-board-cards-and-dedicated-card-workers.md)). A design has
exactly one owner, one or the other
([ADR-0025](0025-a-design-has-one-owner-a-plan-task-or-a-board-card.md)).

For the person they are the same thing — a bug or a feature to do — but they
live on two surfaces with no link between them: the cross-project **Tasks**
page (read-only, plan tasks only, every row leads to the Planner) and the
per-project **Board** (cards only). The UX review of 2026-10-15 found that
the person cannot see a project's work in one place, and the product owner
decided on one **Work** surface.

## Decision

1. **The data models stay separate.** A plan task is never a `BoardCard` row
   and nothing links the two (no conversion, no foreign key). ADR-0024 and
   ADR-0025 are unchanged: plan tasks still run through the fleet via GitHub
   issues; cards still run a dedicated card worker. No schema change.
2. **Plan tasks are projected onto the project Board on read**, read-only.
   Their column is derived by one pure function,
   `planTaskBoardColumn(status, liveStatus)` in
   `packages/shared/src/work/`:

   | Plan task | Column |
   |---|---|
   | `draft`, `needs_talk`, `needs_design`, `ready`, `approved`, `rewrite_requested` | To Do |
   | `issued`, not queued yet; live `queued`, `in_flight` | In progress |
   | live `pr_open` | Finished |
   | live `merged`, `closed` | Completed |
   | `rejected` | not on the board |

   A plan task never enters the Inbox. The board shows the tasks of the
   current version of the plans the caller may read; tasks of an `archived`
   plan only once issued. Within a column the cards come first, in their own
   order, and the plan tasks after them, newest first.
3. **A plan task is not movable.** Its column is a fact about its plan and
   GitHub, not a person's choice. `boardMoveRule` takes
   `item: 'card' | 'plan_task'` (default `card`) and refuses every move of a
   plan task — between columns or within one, by a person or by automation —
   with `plan_task_derived`. No route moves a plan task, so the refusal is the
   web's pre-check and the documented rule; every change to a plan task stays
   in the Planner.
4. **One List across projects replaces Tasks.** `GET /work` lists cards, plan
   tasks and — per project, for an operator or above only — Inbox
   suggestions, with one status vocabulary for every source: the board
   column, plus `rejected` for a plan task. `/tasks` redirects to it, and the
   navigation has one **Work** entry instead of Tasks and Board.
5. **The reads live in their own `work` module**, beside the board's and the
   Planner's, which they import without editing: `GET /work` and
   `GET /projects/:projectId/work/plan-tasks`. `GET /board` keeps returning
   cards only.

## Alternatives rejected

- **Merging `PlanTask` and `BoardCard` into one entity.** Their lifecycles
  differ by design — one is a fleet issue the orchestrator drives, the other
  a worker AgentDock drives (ADR-0024 §4) — and a merge would be a migration
  of both models and of everything that reads them, for a need the
  projection meets on read.
- **Mirroring plan tasks into `board_cards` rows.** A copy goes stale: a plan
  task's state changes in the Planner, in the queue and on GitHub, none of
  which writes the board.
- **Extending `GET /board` with plan tasks.** Its card paging
  (`completedBefore`) does not fit plan tasks, and a second route lets the
  board and the plan tasks change independently.
- **Letting a person drag a plan task.** The drag would have to mean an
  action on the plan or the issue (approve, queue, close), which the Planner
  already owns with its own gates.

## Consequences

- ADR-0024 §2 now reads: the board's columns hold cards **and** read-only
  plan-task projections; `boardMoveRule` decides every move of a card and
  refuses every move of a plan task.
- glass-ui's `Board` has no per-card "not movable" flag (ADR-0011): until it
  gains one, a plan task shows the move menu, and the web refuses its moves
  with the `plan_task_derived` text.
- Plan tasks have no per-project number; on the board a plan task is named
  `<key> · <plan title>`.
- `GET /tasks` stays for one release, deprecated, and is removed in a
  follow-up.
- Both new routes are reads: no audit action and no notification.
