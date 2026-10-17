# ADR-0037: New work is one intake that can split

Status: accepted · Date: 2026-10-16 · Amends [ADR-0034](0034-the-planner-lives-on-the-board-and-makes-cards.md) §1, §2 ·
Issue: [#409](https://github.com/AndreyBegma/AgentDock/issues/409) ·
Spec: [`docs/specs/409-new-work-intake-can-split.md`](../specs/409-new-work-intake-can-split.md)

## Context

ADR-0034 gave the Board two ways to start work: **New Card**, an interview
that ends in exactly one card, and **New Plan**, the Planner's
decompose–review flow that ends in cards with dependencies. In use, people
dictate several unrelated tasks at once, or one task that is too big for a
single agent, into New Card. The card intake could only write the first task
and say in Open questions that the rest "belong in a New Plan" — so the
person had to start over in a second, heavier flow, for work that needed no
dependency graph at all.

## Decision

1. **One entry point, New work.** The Board and the Work list show one
   button, **New work**, in place of New Card and New Plan. It opens the
   existing intake (a `card`-mode plan, ADR-0034 §1, §3): the same interview,
   the same rounds, the same planning model.
2. **The intake decides how many cards.** Each intake turn answers with a
   question round, one card, or — new — a **split proposal**: 2 to 8 cards,
   each written in full like the single card (English title and body, the
   four sections) with a one-line summary, and a reason in the person's
   language. It proposes a split when the request is several independent
   tasks, or one task too big for one agent; one clear task stays one card.
3. **The person decides the split.** **Keep one card** declines it: the next
   turn must write one card covering the whole request, and another split
   fails that turn (`split_declined`). **Split** opens the proposed list; the
   person edits titles and kinds, removes entries, and **Create N cards**
   makes them all in one step — one confirmation, not one per card.
4. **Split cards are independent.** They land in Todo with the intake plan as
   their origin and no dependency links, no plan tasks, no plan review. Work
   that must happen in order is written as one card, not split. The intake's
   attachments go to the first card.
5. **No new plans.** Nothing on the Board starts a decompose–review plan any
   more. Existing plans stay readable — the Board's plan panel
   (`?planPanel=`), the read-only Planner pages, Drafts Resume — and their
   machinery is unchanged. Old `?newPlan=1` links open New work, with
   `?brief=` prefilling What to do.

## Consequences

- The intake output contract gains a third, additive branch (`split`) and
  the turn input a `keepOne` flag. The contract version stays 3: a stored
  intake output of any earlier turn still reads back, and an intake in
  progress simply sees the new branch on its next turn.
- Confirm is a new route, `POST …/plans/:planId/split`, which names the
  proposing turn; a proposal replaced by a later turn is refused
  (`split_stale`), as is a confirm while a turn runs.
- A title the person edits is stored as typed, with no normalization: the
  API refuses one with a letter outside ASCII, so the card stays English
  (ADR-0027 §6). Bodies are the model's, already English (ADR-0034).
- Dependencies between cards remain possible by hand on a card's sheet; the
  intake never writes them. A request that truly needs a dependency graph
  has no dedicated flow on the Board any more — by choice: the decompose
  machinery stays in the code for the plans that exist.
