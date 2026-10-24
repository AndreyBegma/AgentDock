# ADR-0083: A person's own Claude Code session may work the Board through MCP; Completed stays a person's

Status: accepted; extended by [ADR-0089](0089-a-persons-session-may-work-stacks-designs-and-dependencies.md) (stacks, designs, dependencies) · Date: 2026-10-23 ·
Issue: [#845](https://github.com/AndreyBegma/Nautelle/issues/845) ·
Spec: [`docs/specs/845-board-from-a-session.md`](../specs/845-board-from-a-session.md) ·
Extends: [ADR-0020](0020-claude-code-integration-through-the-runner.md) §3, [ADR-0030](0030-terminal-work-and-fleet-work-appear-on-the-board.md) ·
Keeps: [ADR-0024](0024-board-cards-and-dedicated-card-workers.md) §6, [ADR-0058](0058-new-work-cards-are-candidates-until-accepted.md)

## Context

The `nautelle` MCP plugin lets a session read the fleet, track its own work as a new card (`track_card`) and report a card done (`finish_card`). Everything else on the Board — run a card, move it, send feedback, answer its question, accept it — exists only in the web app. Driving the Board from a conversation ("finish everything in To Do") has been done with a Playwright tab holding the person's CSRF cookie: fragile, invisible to the API as an agent's action, and refused by the auto-mode classifier more than once.

The API already acts on MCP calls as the runner's local user, capped at `operator` (ADR-0020 §3). Accepting a card is an `operator` action in the API; that Completed is a person's (ADR-0024 §6) is held only by the web app offering the button to people.

## Decision

1. **Board control is a set of typed local requests** (`board.*`, `card.*`) exposed as MCP tools, served by the existing Board services. No new path into the API.
2. **Control tools answer only a manual session** (`AgentSession.origin = manual`); card sessions and fleet slots are refused `not_a_manual_session`. Read tools and `board.wait` answer any session of the project.
3. **Completed is reached only through a person's approval.** `card.move` to `completed` is refused `completed_needs_person`; an agent files an action request `card_accept` and the approval runs `accept`. This makes ADR-0024 §6 an API rule for agents rather than a UI convention.
4. **A manual session may take an existing card** (`card.take`): the card is bound to the session like a tracked card (ADR-0030), one active per session, further takes queued for that session in board order. A taken card the session leaves keeps its branch and is offered Run again.
5. **Merging a finished card's pull request follows `BoardSettings.cardMergePolicy`** — `ask` (default), `agent`, `person`. `ask` means the session asks the person once per run. A pull request touching `.woodpecker/**` or carrying a gate is always a person's.
6. **An agent's own proposal of a card is a candidate** (Inbox, ADR-0058); a card the person asked for is created in To Do.
7. **The session waits with `board.wait`,** a long-poll over an opaque cursor, capped below the runner relay's request timeout:
   - **The cap.** One local request has 15 s end to end (`LOCAL_REQUEST_TIMEOUT_MS`), enforced by the API (`RunnerLocalRequests`), by the daemon (`connection.ts`) and, plus a second, by the plugin's local client. The server holds one `board.wait` for at most **10 s** (`LOCAL_BOARD_WAIT_HOLD_MAX_SEC`) and then answers empty, never `timeout`. The MCP tool keeps the spec's `timeoutSec ≤ 300` (`BOARD_WAIT_TIMEOUT_MAX_SEC`) by looping server calls, each passing on the cursor. The relay is not changed: raising its deadline for one method would touch three processes and every older runner, to save a round trip every 10 s.
   - **A diff, woken by the bus.** The cursor is a compact snapshot of what the conductor waits on, per card — column, latest round and its phase, CI state, merged, the pending question's key (`encodeBoardWaitCursor`); the server compares it with the board now (`diffBoardWatch`). Board changes are already signalled in process — `BoardWork.publish` emits `board.changed` with the card id — but that signal is best effort, reaches only the API instance that made the change, and carries no history, so it cannot replay what happened between two calls. It only wakes a held request early; a re-diff every 2 s covers a missed signal or another instance. A diff makes the same cursor answer the same changes twice, loses nothing when an answer is lost, and needs no new table; `updated_at` alone could not say *what* changed. A malformed or another project's cursor is answered like none: at once, no events, a fresh cursor.
8. **A live taking session withholds Run** (`trackingAlive`, extended from `terminal` cards to any card with a live tracked session). When the session ends, the card stays In progress, "session ended", with `takenBranch` kept, and Run or another `card.take` is offered (spec D10). Session-gone is derived from the session row, never stored. Releasing the held card, like finishing it, takes the session's next queued card.
9. **The Board's own refusals pass through by name.** The local error codes include the `BOARD_ERROR` codes a conductor must obey (`dependency_open`, `max_running`, `design_not_approved`, …; `LOCAL_BOARD_REFUSALS`), so a tool answers `dependency_open`, not a generic failure.
10. **`card_accept` may be approved by the person whose session asked** — the gate is a person, not a second one, as for `issue_queue`. Its stored args bind the card's title and pull request when it is filed; nothing the approver is shown comes from the session.

## Consequences

- A conversation can run the Board end to end without the web app or a browser credential; every action is an MCP call the API attributes to the runner's user and audits.
- An agent cannot complete a card on its own, even where a person could by dragging it.
- The person answers one merge question per run under `ask`, or none once the project chooses `agent` or `person`.
- A long-poll holds one relay request per waiting session, for at most 10 s, of the runner's 32 concurrent local requests.
- The cursor grows with the open board — about 20 characters a card, capped at 64 KiB — and Inbox and Completed cards are outside it unless named.
