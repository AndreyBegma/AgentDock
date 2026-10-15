# ADR-0030: Terminal work and fleet work appear on the Board

Status: accepted · Date: 2026-10-15 · Amends
[ADR-0024](0024-board-cards-and-dedicated-card-workers.md) §1 and §6,
extends [ADR-0026](0026-card-capture-reads-opt-in-session-content.md) ·
Issue: [#282](https://github.com/AndreyBegma/AgentDock/issues/282) · Spec:
[282-terminal-and-fleet-work-on-the-board](../specs/282-terminal-and-fleet-work-on-the-board.md)

## Context

The product owner wants the site and the terminal to be equally usable.
Work they ask for in their own Claude Code terminal must end up as a task on
the project's Board, the same as work started from the site. Today three
things stand in the way:

- Capture ([ADR-0026](0026-card-capture-reads-opt-in-session-content.md))
  only *suggests* cards into the Inbox, and a person must accept them.
- Worker sessions are never read.
- Work the code-sentinel orchestrator runs from GitHub issues never reaches
  the Board, because ADR-0024 §1 keeps cards and the fleet apart.

The plugin, session content and capture are prerequisites. #281 covers them.

## Decision

1. **Explicit tracking from the terminal.** A new local method `card.track`
   ([ADR-0020](0020-claude-code-integration-through-the-runner.md) §4) and
   its MCP tool `track_card`. The agentdock plugin's skill tells the model
   to call the tool once per piece of work the person asks for.
   - The tool creates a card **In progress**, with `source: terminal`,
     linked to the calling session.
   - A second call from the same session updates that card; it never
     creates a second one.
   - No worker is started.
   - Capture (ADR-0026) stays for implicit "later" items. It skips the
     content of a session that tracks a card.
2. **Tracked cards finish with their session.** When the session ends, or
   `finish_card` runs, the card moves to **Finished**. Only a person moves
   it to **Completed**, after checking that the work is really done and
   good. This is the rule of ADR-0024 §6. Nothing reaches Completed
   automatically.
3. **Collecting is opt-in for tracked cards.**
   - A tracked card is collected only when its *automatic work* option
     (`autoCollect`) is on. Collecting means commit the leftovers, push,
     and open a PR, as `card.collect` does.
   - The option defaults from a new board setting, `autoCollectTracked`,
     which is off by default. The person may also toggle it on the card.
   - With the option off, nothing is pushed: the session is the person's
     own work on their own branch.
   - Card workers keep ADR-0024 §6: they always collect on Finished.
4. **The fleet is mirrored on the Board, and the mirror is editable.**
   - Every slot the orchestrator dispatches shows as a card with
     `source: fleet`, keyed by `(project, issue, slot)`.
   - Its column follows the slot:

     | Slot state | Column |
     |---|---|
     | dispatched or working | In progress |
     | PR open, or merged | Finished |

   - A person moves the card to Completed. The orchestrator never does.
   - A `cs:ready` issue that has not been dispatched yet shows as one fleet
     card in **To Do**.
   - Title, body and comments are editable, like any card. An edit reaches
     the running slot through the existing `slot.message` control command,
     worded as the next-round prompt of
     [ADR-0029](0029-accepting-a-board-card-may-merge-its-pull-request-through-the-runner.md)'s
     lifecycle (#273). The GitHub issue is not rewritten.
   - While the slot runs, moves are refused (`fleet_slot`). The one move a
     person may make is Finished → Completed.
5. **Amends ADR-0024 §1.** "A card is not a GitHub issue" still holds for
   the person's cards. Fleet cards are a mirror of the fleet, not a second
   queue: the orchestrator does not read them, and editing one does not
   create work. It only talks to the slot that already runs.

## Consequences

- One Board shows the person's cards, terminal work and fleet work. The
  Fleet page stays the place for slot internals.
- A model that tracks too eagerly fills the Board with noise. The skill
  defines "work" (questions and explanations are not work), one card per
  session is the default, and a person can dismiss a tracked card.
- Fleet cards depend on the slot projection
  ([spec 160](../specs/160-agent-workspace.md)). When a slot disappears from
  the projection, its card keeps its last column and shows "slot gone".
- Rejected:
  - **Auto-accepting capture** (amend ADR-0026 §7). A wrong card in To Do
    costs a worker run.
  - **A read-only fleet mirror.** The owner wants edits to reach the
    worker.
  - **Unifying cards and issues.** It would reverse ADR-0024 §1 for the
    person's own cards.
