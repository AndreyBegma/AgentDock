# Work the Board from a Claude Code session

Issue: [#845](https://github.com/AndreyBegma/Nautelle/issues/845) · ADR: [ADR-0083](../adr/0083-a-persons-session-may-work-the-board-through-mcp.md)

## Summary
A person's own Claude Code session can drive the Nautelle Board through the
`nautelle` MCP plugin: read the board, create cards, run them, move them,
answer their questions, send feedback, take a card to work on itself, and wait
for the board to change. "Do C-42" makes the session do the card itself;
"finish everything in To Do" makes it a conductor that runs cards within
`maxRunning`, watches them to Finished, sends red ones back, merges green ones by
the project's policy, and asks the person to accept. Today this needs the web
app, or a Playwright driver holding a CSRF cookie — the fleet runs of
2026-10-16 to 2026-10-22 were driven that way.

## Scope
### In scope
- New MCP tools on the runner's MCP server, each a typed `local.request` (ADR-0020).
- Local-request handlers in the API over the existing Board services.
- `take_card` / `release_card`: an existing card worked by the calling manual session.
- `board_wait`: a cursor-based long-poll of board changes.
- A new action-request kind `card_accept` (Finished → Completed, optional merge) that a person approves.
- A project Board setting `cardMergePolicy` (`ask` | `agent` | `person`, default `ask`).
- A plugin skill `nautelle:board` with the conductor's instructions.
- ADR-0083.

### Out of scope
- Any agent path to Completed without a person's approval.
- Control tools for card sessions or fleet slots (they keep `finish_card`, `escalate_card`, `resume_context`).
- The `move`-to-Completed landing gap (filed separately, see Risks).
- Replacing cs-orchestrator; it may use these tools later.

## Decisions
Every decision below is the person's answer in the 2026-10-23 interview unless it cites a record.

- **D1 Who executes.** One card named by the person ("do C-42") is done by the calling session itself on its own branch in its current checkout; it pushes and opens the pull request itself. Several cards, or "everything in To Do", go through Board Run — a dedicated worktree and card session each (ADR-0024 §3–4) — and the calling session conducts. The person can override in words ("run C-42", "do these two yourself").
- **D2 Several cards "yourself"** are taken one at a time: one active taken card per session; the others carry a `queuedForSessionId` marker in board order. The existing one-card-per-session uniqueness of `trackedSessionId` stays [Confirmed: schema.prisma `trackedSessionId @unique`].
- **D3 Conductor loop** is full: run up to `maxRunning`, wait, on Finished check the pull request and CI, send `card_feedback` on red, apply the merge policy on green, request acceptance, run the next. Board refusals (`dependency_open`, `design_not_approved`, `stack_design_not_approved`, `budget_exceeded`, `max_running`) are obeyed, never worked around.
- **D4 Merge policy.** `BoardSettings.cardMergePolicy`: `ask` (default) — the conductor asks the person once at the start of a run, by selector, and keeps the answer for that run; `agent` — the conductor merges a green, `CLEAN` pull request without a Claude attribution trailer itself; `person` — it never merges. Pull requests touching `.woodpecker/**` or carrying a `Gate:` always go to the person.
- **D5 Completed stays a person's** (ADR-0024 §6, ADR-0030). The agent files `request_action` kind `card_accept` (`{card, merge?: boolean}`); the person approves in the web app or Telegram, and the API runs the existing `accept` (with `merge` when the pull request is still open and policy is `person`). `card_move` to `completed` is refused `completed_needs_person`.
- **D6 Creating cards.** On the person's explicit request a card goes to To Do; a card the agent proposes on its own goes to the Inbox as a candidate (ADR-0058).
- **D7 Card questions.** The conductor answers a waiting card session via `card_message` when the card, its spec or the code settles it; a product decision goes to the person in the chat with a recommendation.
- **D8 Waking.** `board_wait(cursor?, cards?, timeoutSec ≤ 300)` returns the events after `cursor` — column change, round ended, CI state changed, pull request merged, card waiting on a question (with its text and options) — on the first event or at the timeout, plus the next cursor. The cursor is opaque and survives a context compaction.
- **D9 Who may call.** Control tools (`card_create`, `card_run`, `card_move`, `card_feedback`, `card_message`, `card_stop`, `take_card`, `release_card`) only from a manual session (`AgentSession.origin = manual`), refused `not_a_manual_session` otherwise [Confirmed: board-terminal.service.ts]. Read tools (`board_list`, `board_card`, `board_wait`) from any session of the project.
- **D10 Abandoned take.** A session that ends without finishing leaves the card In progress, marked session-gone, with its branch recorded on the card; Run is offered again, another session may `take_card` it, a person may move it back. `release_card` returns it to To Do at once.
- **D11** The conductor's instructions live in a plugin skill `nautelle:board`, modelled on cs-orchestrator.

## Data / Schema
Migration `apps/api/prisma/migrations/20261231000015_board_from_a_session/`:
- `board_settings.card_merge_policy` — enum `CardMergePolicy { ask agent person }`, default `ask`.
- `board_cards.queued_for_session_id` — nullable FK to `agent_sessions`, `ON DELETE SET NULL` (D2).
- `board_cards.taken_branch` — nullable text, the branch a taken card is worked on (D10).
Session-gone is derived from the tracked session's state, not stored [Unknown: confirm `trackingAlive` in packages/shared/src/board/moves.ts covers a taken card; the lead decides].

## API
Local-request methods (packages/shared/src/protocol/local.ts method table, `needsProject: true`):

| MCP tool | Method | minRole | Notes |
|---|---|---|---|
| board_list | board.list | viewer | columns with card number, title, kind, column, running, PR state, CI state; optional `column` filter |
| board_card | board.card | viewer | one card: body, dependencies, rounds summary, PR, CI, pending question |
| board_wait | board.wait | viewer | D8 |
| card_create | card.create | operator | `{title, body?, kind?, candidate?: boolean}` — `candidate` puts it in Inbox (D6) |
| card_run | card.run | operator | `{card, model?, effort?}` → Board Run; refusals passed through verbatim |
| card_move | card.move | operator | `{card, column, index?}`; `completed` refused `completed_needs_person` |
| card_feedback | card.feedback | operator | `{card, text}` |
| card_message | card.message | operator | `{card, kind: text|option|other, text?, questionKey?}` (ADR-0045) |
| card_stop | card.stop | operator | `{card}` |
| take_card | card.take | operator | `{card}` — To Do (or session-gone In progress) → In progress, bound to the caller; if the caller already holds one, the card is queued (D2) and the answer says so |
| release_card | card.release | operator | `{card}` → To Do, clears binding and queue marker |

`finish_card` gains an optional `pullRequestUrl` for a taken card: it records the pull request, moves the card to Finished, and promotes the session's next queued card. `request_action` gains kind `card_accept` (packages/shared/src/action-requests/contracts.ts).

`board.wait` holds the request until an event or the timeout. [Unknown: the runner's local relay timeout for one request — the lead measures it and caps `timeoutSec` below it.] [Unknown: whether board changes are already published on an in-process bus the handler can subscribe to (apps/api/src/live, server-events) or must be diffed from `updated_at`; the lead decides and records it in ADR-0083.]

## UI
- Project settings → Board: a "Merge pull requests of finished cards" select — Ask at the start of each run / The agent merges / A person merges.
- Approvals page and Telegram: `card_accept` renders as "Accept C-<n> <title>" with the pull request link and, when `merge` is set, "and merge #<pr>".
- Card: "taken by <session>" on a taken card, "queued for <session>" on a queued one, "session ended" when gone (D10).

## Acceptance criteria
- [ ] From a manual session, `board_list` returns this project's cards; called with another project's context it returns none of the first project's cards (authorization).
- [ ] A card session calling `card_run`, `card_move` or `take_card` is refused `not_a_manual_session`.
- [ ] A viewer-role runner user is refused `forbidden` on every control tool.
- [ ] `card_move` to `completed` is refused `completed_needs_person`; the card does not move.
- [ ] `card_run` on a card with an open dependency returns `dependency_open` unchanged.
- [ ] `take_card` binds the card to the caller and moves it to In progress; a second `take_card` from the same session queues the card and says so; `finish_card {pullRequestUrl}` moves the first to Finished with the PR recorded and takes the queued one.
- [ ] A session that ends holding a taken card leaves it In progress with "session ended" and Run offered; `release_card` returns a card to To Do.
- [ ] `card_create` without `candidate` lands in To Do; with `candidate: true` in Inbox.
- [ ] `board_wait` with a cursor returns within 2 s of a card changing column, with a new cursor; with nothing changing it returns empty at its timeout; the same cursor twice returns the same events.
- [ ] `board_wait` reports a card session waiting on a question with the question text and options; `card_message {kind: option}` answers it.
- [ ] `request_action {kind: card_accept}` creates a pending approval; approving it moves the card to Completed (and merges when `merge` is set and the PR is open); declining leaves the card in Finished.
- [ ] `cardMergePolicy` defaults to `ask`, is editable in project settings by an admin, and is returned by `board_list`.
- [ ] The `nautelle:board` skill states D1–D7 and is listed by the plugin.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i845-contract | protocol methods, shared types, schema and migration, action kind | packages/shared/src/protocol/local.ts, packages/shared/src/board/**, packages/shared/src/action-requests/**, apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261231000015_board_from_a_session/** | — | yes | opus |
| i845-api | handlers, take/release/wait, card_accept execution, merge-policy setting | apps/api/src/local/**, apps/api/src/board/**, apps/api/src/approvals/** | i845-contract | no | opus |
| i845-runner | MCP tools and the long-poll relay | apps/runner/src/mcp/**, apps/runner/src/local/** | i845-contract | no | sonnet |
| i845-plugin | the conductor skill | plugins/nautelle/skills/board/**, plugins/nautelle/skills/track-work/** | i845-contract | no | sonnet |
| i845-web | merge-policy select, card_accept approval, taken/queued badges | apps/web/** | i845-contract | no | sonnet |

Merge order: contract → api, runner, plugin → web after api (a UI must not call a missing endpoint, as #332 did).

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma, the migration | i845-contract | do not open it |
| packages/shared/src/protocol/local.ts | i845-contract | do not open it |
| apps/api/src/board/** | i845-api | do not open it |
| apps/web/** | i845-web | do not open it |

## Risks
- **High — `board.wait` holding a request across the runner relay.** A relay timeout below `timeoutSec` turns every wait into an error. Mitigation: the lead measures it; `timeoutSec` is capped below it; the tool returns empty, not an error, at the cap.
- **Medium — the conductor merging the wrong thing.** Board auto-merge shipped a spec-only PR (#520). Mitigation: D4 checks green, `CLEAN`, no trailer, no `.woodpecker/**`, no gate; `person` and `ask` exist.
- **Medium — `move` reaches Completed without the landing check** (board.service.ts move path vs `accept` → `not_landed`). Not fixed here: `card_move` refuses Completed outright. Filed as a separate bug.
- **Low — a taken card and a Board Run on the same card.** Mitigation: `card.take` refuses a running card; Run is refused while the taking session is alive (`trackingAlive`).

## Open questions
- Whether `board_wait` diffs `updated_at` or subscribes to a bus — default: the lead picks the bus if one exists, else the diff, and records why in ADR-0083.
