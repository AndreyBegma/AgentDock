---
title: Stacks
description: Groups of cards in ordered stages, for work too large for one card.
---

A stack is a group of cards in ordered stages, numbered per project as `S-1`,
`S-2` and so on. It is how Nautelle splits work too large for one card into
pieces that can be reviewed and merged one at a time.

- Cards in the same stage are independent and may run in parallel.
- Every card in a stage depends on every card of the stage before it. A
  dependent card branches from its dependency, so its pull request is stacked
  on the one before and shows only its own change.
- **Run** on a card waits until each card it depends on has a ready pull
  request.
- **Run stack** queues the stack's cards stage by stage, within the project's
  limit of agents running at once.

A card belongs to at most one stack. The planner may propose a stack when new
work is large, two to eight cards in two or more stages; a person can also
group existing cards into a stack by hand on the Board.

## Where the reasoning lives

- [ADR-0044](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0044-stacks-staged-cards-under-one-shared-design.md): stacks, staged cards under one shared design.
- [ADR-0054](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0054-a-person-may-group-board-cards-into-a-stack.md): a person may group board cards into a stack.
- [ADR-0064](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0064-a-dependent-card-branches-from-its-dependency-with-a-stacked-pr.md): a dependent card branches from its dependency with a stacked pull request.
- [ADR-0065](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0065-run-waits-for-every-dependency-to-have-a-ready-pull-request.md): Run waits for every dependency to have a ready pull request.
- [ADR-0067](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0067-run-stack-queues-a-stacks-cards-within-the-agent-limit.md): Run stack queues a stack's cards within the agent limit.
