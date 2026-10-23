# ADR-0077: A person's own Claude Code session may work the Board through MCP; Completed stays a person's

Status: accepted · Date: 2026-10-23 ·
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
7. **The session waits with `board.wait`,** a long-poll over an opaque cursor, capped below the runner relay's request timeout. Whether it reads an in-process bus or diffs `updated_at` is recorded here by the contract slot.

## Consequences

- A conversation can run the Board end to end without the web app or a browser credential; every action is an MCP call the API attributes to the runner's user and audits.
- An agent cannot complete a card on its own, even where a person could by dragging it.
- The person answers one merge question per run under `ask`, or none once the project chooses `agent` or `person`.
- A long-poll holds one relay request per waiting session.
