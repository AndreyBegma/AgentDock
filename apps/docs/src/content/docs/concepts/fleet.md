---
title: Fleet
description: The Code Sentinel orchestrator and the agents it runs on a project.
---

The Board runs one worker per card. The **fleet** is the other way to work: an
orchestrator that takes issues from a queue and runs several agents in
parallel on one project. Nautelle does not reimplement the orchestrator; it
starts the Code Sentinel orchestrator on the project's runner and shows what
it does.

## The pieces

| Term | Meaning |
|---|---|
| **Orchestrator** | A Claude Code session running `/code-sentinel:orchestrator` for one project, in a tmux session in the project root. |
| **Queue** | GitHub issues labelled `cs:ready`. Nautelle creates no agent by itself: queue an issue and the orchestrator dispatches it. |
| **Round** | One pass of the orchestrator over the queue and its running slots. |
| **Slot** | One dispatched issue: its own worktree and tmux session, named after the issue (`i42`). |
| **Worker** | The Claude Code or Codex session in a slot. |
| **Fence** | The paths a worker may and may not touch, set in its brief and enforced for Claude workers. |

## The Fleet page

**Fleet** on a project shows the orchestrator and every live slot: its issue,
branch, worktree, runtime and model, its last checkpoint, its pull request and
checks, and whether it is idle, out of quota or waiting at a prompt. **Start**
launches the orchestrator on the project's machine; you can message a running
session, and approve what it asks from the web app or Telegram. Work the fleet
does also appears on the Board.

A project needs the orchestrator configuration in its repository
(`.code-analyzer-config.json` with an `orchestrator` block) before the fleet
can run on it; **Connect project** shows whether it is there.

## Where the reasoning lives

- [ADR-0004](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0004-github-issues-are-the-task-queue.md): GitHub issues are the task queue.
- [ADR-0005](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md): drive the orchestrator skill, do not reimplement it.
- [ADR-0013](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0013-codex-workers-and-their-fence.md): Codex workers and their fence.
- [ADR-0030](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0030-terminal-work-and-fleet-work-appear-on-the-board.md): terminal work and fleet work appear on the Board.
- [ADR-0045](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0045-a-person-may-message-a-running-session-the-orchestrator-is-told.md): a person may message a running session.
