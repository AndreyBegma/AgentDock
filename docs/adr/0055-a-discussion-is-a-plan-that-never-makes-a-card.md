# ADR-0055: A discussion is a plan that never makes a card

Status: accepted · Date: 2026-10-17 · Extends [ADR-0034](0034-the-planner-lives-on-the-board-and-makes-cards.md), [ADR-0037](0037-new-work-is-one-intake-that-can-split.md) ·
Issue: [#590](https://github.com/AndreyBegma/AgentDock/issues/590) ·
Spec: [`docs/specs/590-add-a-discuss-mode-to-the-board-for-ques.md`](../specs/590-add-a-discuss-mode-to-the-board-for-ques.md)

## Context

The Board has one way to talk to the planning model: **New work**
(ADR-0037), an interview that must end in one or more cards and gives up
after four rounds. People also want to ask the model about the project
without committing to work — "how does the runner pick a worktree?", "review
how runner tokens are checked", "why does the board re-render on every
event?" — often with one of the project's installed review skills
(cs-security, cs-perf, cs-arch). Squeezing that into New work fails it: the
intake keeps asking until it can write a card, and its contract has no place
for a free answer.

## Decision

1. **A discussion is a `discuss` plan.** `PlanMode` gains `discuss`, and
   `PlanTurnAction` gains `discuss`: every turn of a `discuss` plan is a
   `discuss` turn. It runs on the existing Planner turn machinery —
   `plan.turn` on the runner, the plan's session resumed turn after turn, the
   plan's own worktree under `--permission-mode plan` (spec 172 D15) — so the
   repository is read on the runner only, read-only (ADR-0001, ADR-0010). The
   control plane reads nothing of the project.
2. **No round limit and no required result.** The first turn answers the
   opening question the discussion was started with (its `brief`); each later
   turn answers one message. A discussion stays open (`clarifying`) until it
   is discarded; it is never `done`.
3. **Its own prompt and contract.** A discussion turn runs on the discussion
   instructions (`DISCUSS_INSTRUCTIONS`), not the planner's; a project's own
   Planner instructions apply, as to an intake. The answer is one
   `agentdock-plan` block:
   `{ "action": "discuss", "title"?: string, "reply": markdown,
   "proposals"?: [ { "title", "brief" } ] }` — at most 8 proposals, each a
   one-line title (at most 80 characters) and a brief, in the person's
   language. The API validates it like every planner contract: a malformed
   turn fails `contract_violation`, keeps its raw text, and changes nothing —
   not even the title. A valid `title` renames the discussion.
4. **Skills are chosen once.** Starting a discussion takes zero or more of the
   project's installed skill invocations (`skills`, at most 12), stored on the
   plan (`plans.skills`). Every turn names those still installed in its
   prompt, as design turns name their skills; an uninstalled one is skipped,
   not refused. Another mode refuses `skills` (`409 wrong_mode`).
5. **Cards only through New work.** A discussion never makes a card. Create
   cards refuses a `discuss` plan (`409 wrong_mode`). Under each proposal,
   **Make a card** opens New work with What to do prefilled through the
   existing `?brief=` link (ADR-0037 §5); the intake then writes the card as
   it does for any request.
6. **Discussions are drafts.** A discussion is listed in the Board's Drafts
   strip beside intake drafts, with **Resume** — the dialog at `?discussion=`,
   with its whole history — and **Discard**, which archives it like any plan.
   The person's words are kept as typed, as an intake keeps them: the model
   replies in the person's language.

## Consequences

- One migration: two enum values and a `skills` column with an empty
  default. The planner contract version stays 3: the `discuss` shapes are
  additive and only `discuss` plans see them.
- A discussion's turns cost what any planner turn costs and count against
  the same budgets; a long discussion is many turns.
- Board, fleet, budget and session state stay out of a discussion: the
  instructions send such questions elsewhere, and the turn has no access to
  them anyway.
- The read-only guarantee is the plan worktree's, not the prompt's: a skill
  that tries to write is stopped by the permission mode, whatever it says.
