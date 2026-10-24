---
title: Board and cards
description: How a card goes from an idea to a merged pull request.
---

Each project has a Board, and the Board holds cards. A card is one piece of
work — a feature, a fix, a chore — written by a person, or proposed by the
planner and accepted by a person. Cards are numbered per project, `C-1`,
`C-2` and so on, and live in Nautelle, not in GitHub issues.

## Columns

| Column | What it means |
|---|---|
| **Inbox** | Suggestions waiting for a person. A suggestion leaves the Inbox only when someone accepts it. |
| **To Do** | Accepted work, ready to run. |
| **In progress** | A worker is on it. |
| **Finished** | The worker is done and the checks are green. |
| **Completed** | A person accepted the result. Only a person completes a card. |

## Running a card

**Run** starts a dedicated Claude Code worker for that card on the project's
runner:

1. The runner creates a git worktree next to the repository, on a branch
   named after the card (`card/c42-short-title`), and opens a tmux session in
   it.
2. The worker writes or follows the card's spec, implements it, runs the
   project's checks and commits as it goes. A draft pull request opens during
   the round.
3. When the worker finishes, the pull request leaves draft. Nautelle watches
   CI and sends the worker back to fix a failure, up to three times.
4. The card is **Finished** when the work is done and every check passed. If
   the project has auto-merge on, Nautelle merges the pull request then.

Each Run or piece of feedback is a **round**, with its own phase: Queued,
Starting, Running, Waiting for you, Running in background, Finished, Ended,
Failed or Stopped. While a round runs you can watch the session, answer its
questions, approve what it asks to do from the web app or Telegram, and send
it a message.

**Feedback** on a finished card starts a new round on a new branch and pull
request. **Completed** closes the worker and removes its worktree; it never
merges anything by itself.

## Where the reasoning lives

- [ADR-0024](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0024-board-cards-and-dedicated-card-workers.md): Board cards and dedicated card workers.
- [ADR-0035](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0035-a-card-ships-itself.md): a card ships itself — draft pull request, CI fix rounds, auto-merge.
- [ADR-0058](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0058-new-work-cards-are-candidates-until-accepted.md): new work cards are candidates until accepted.
- [ADR-0080](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0080-auto-merge-needs-every-check-passed.md): auto-merge needs every check passed.
- [ADR-0084](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0084-a-card-passes-its-review-steps-before-finished.md): a card passes its review steps before Finished.
- [All decisions](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/README.md).
