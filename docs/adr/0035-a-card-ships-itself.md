# ADR-0035: A card ships itself

Status: accepted · Date: 2026-10-15 · Amends [ADR-0024](0024-board-cards-and-dedicated-card-workers.md) §6 and [ADR-0029](0029-accepting-a-board-card-may-merge-its-pull-request-through-the-runner.md) ·
Issue: [#359](https://github.com/AndreyBegma/AgentDock/issues/359)

## Context

Today a card worker's work reaches GitHub only when the round ends, with a
one-line PR description, no CI follow-up, and a merge only when a person
accepts. The orchestrator fleet does all of this itself. On 2026-10-15 the
product owner decided that a board card should behave the same way.

## Decision

1. **The PR exists while the work does.** The runner pushes a card's
   committed HEAD and opens a draft PR during the round. The worker still
   never pushes. The PR leaves draft when the worker finishes, with a
   description the worker wrote: a spec link, what changed, and the
   acceptance checklist.
2. **Every card has a spec file. Bugs also have an issue.**
3. **AgentDock watches CI.** A red check, or a conflict with the base, starts
   an automatic fix round in the same session, at most three per PR. After
   that the card waits for a person.
4. **Finished means done and green, and is then merged** when the project's
   auto-merge switch is on. It is on by default for a non-default base, off
   for the default branch. This amends ADR-0029, under which only a person's
   Accept merges.
5. **A merged card stays.** Feedback opens a new round on a fresh branch and
   a new PR. Only a person moves a card to Completed, which cleans up
   (ADR-0024 §6 holds for Completed).

## Consequences

- Model-written code reaches develop without a human review when CI is
  green. This is the fleet's existing posture. A project can turn it off,
  and main is off by default.
- Fix rounds cost model time, bounded by three per PR and the budget hard
  stop.
- A card can own several PRs over its life.
