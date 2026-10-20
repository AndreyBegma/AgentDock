# 282 — Terminal work and fleet work on the Board

Issue: [#282](https://github.com/AndreyBegma/AgentDock/issues/282) · ADR: [0030](../adr/0030-terminal-work-and-fleet-work-appear-on-the-board.md)

## Summary

The product owner (2026-10-15) wants the site and the terminal to be equally usable. Whatever they ask for in their own Claude Code terminal should end up as a task on the project's Board, in the store, the same as work started from the site. Work the orchestrator runs should be on the Board too.

The decision is [ADR-0030](../adr/0030-terminal-work-and-fleet-work-appear-on-the-board.md) (accepted). #281 covers the prerequisites: the plugin, session content and capture.

## Decisions

The owner answered Q1–Q4 on 2026-10-15.

- **D1 `track_card` (Q1: explicit tracking, and the Inbox stays).**
  - A new local method, `card.track { title, body?, kind? }`. It is operator level and capped like every local request (ADR-0020 §5). The new MCP tool `track_card` calls it.
  - The card is resolved by the calling session (`session.id`, as `card.finish` resolves its card). The method creates card C-n **In progress**, with `source: terminal` and `trackedSessionId` set, and returns `{ number, label, url }`.
  - A second call from the same session updates the title and body of that card; it never creates a second card. A session that is not `manual` (worker, run, planner, extraction) gets `not_a_manual_session`.
  - A new plugin skill (`plugins/agentdock/skills/track-work/SKILL.md`) and the tool description tell the model:
    - call it once per piece of work the person asks for;
    - questions and explanations are not work;
    - pass `kind` only when it is obvious.
  - Title and body go through #271's text normalization like any card.
  - The card shows "Tracked from a terminal session", with the session link. It starts no worker; Run, Stop and feedback are hidden while the session lives.
- **D2 End of session (Q3).** When the tracked session ends (the `SessionEnd` hook, or the session going stale as in ADR-0024 D6), or the session calls `finish_card`, the card moves to **Finished**. A person checks the work and moves it to **Completed**, as ADR-0024 §6 requires. Nothing reaches Completed automatically.
- **D3 Automatic work (Q4).**
  - A tracked card is collected on Finished only when `autoCollect` is on. Collecting runs the existing `card.collect`: commit the leftovers, push, open a PR into the project's base.
  - It runs in the session's own `cwd` and branch, not in a card worktree. The project's runner runs it.
  - `autoCollect` is a per-card boolean ("Automatic work: push and open a pull request when it finishes"). It defaults from a new board setting `autoCollectTracked`, which is off.
  - With it off, nothing is pushed and the card only records the branch and the session.
  - Card workers are unchanged: they always collect (ADR-0024 §6). There is no existing per-card "automatic" option that means this: `continueAfterDesign` means "start round 1 on design approval", so a new field is defined.
- **D4 Fleet mirror (Q2: editable).**
  - The fleet projector keeps one `source: fleet` card per dispatched slot, keyed by `(projectId, issue, slotName)`. A `cs:ready` issue of the project that has no slot yet shows as one fleet card in **To Do**, keyed by `(projectId, issue, null)`. When its first slot appears, that card becomes the lead slot's card.
  - Column from the slot (`Slot.status`, `prState`):
    - dispatched or working → In progress;
    - PR open or merged → Finished.
  - Only a person moves a fleet card to Completed, through the existing Accept. Accept on a fleet card never merges: the orchestrator merges.
  - **Editable.**
    - Title, body and comments are edited like any card. An edit while the slot runs is sent with the existing `slot.message` control command (operator), worded by `cardNextRoundPrompt({ label, change, feedback })` from #273.
    - The GitHub issue is not rewritten.
    - A moving refusal `fleet_slot` covers every drag or menu move, except Finished → Completed.
  - The card shows the issue, the slot, its stage (`FLEET_STAGES`), the PR, and a link to the Fleet node.
  - When the slot leaves the projection, the card keeps its last column and shows "Slot gone".
- **D5 Capture stays (Q1, the Inbox part).** Inbox suggestions remain for implicit "later" items. Capture skips the content of a session that has a tracked card, so it never suggests a duplicate. The skip reason is `tracked`.
- **D6 Card sources.** `BOARD_CARD_SOURCES` becomes `manual | captured | terminal | fleet`. `BoardCardView` gains:
  - `tracking: { sessionId, alive } | null`;
  - `fleet: { issue, slot, stage, slotGone } | null`;
  - `autoCollect: boolean`.

### Assumptions (the orchestrator's, from docs/ and the owner's words — confirm if wrong)

- A1. "Mirror can be edited" means the content and comments are edited, and edits reach the running worker through `slot.message`. Columns still follow the slot, and only Finished → Completed is manual.
- A2. "The automatic work checkbox" is a new per-card `autoCollect` with a project default `autoCollectTracked` (off). No existing field means "push and open a PR".
- A3. Fleet cards are created only for projects whose runner reports slots (the `Slot` projection, spec 160). Issues outside a Nautelle project are not mirrored.

## Code facts

All on `develop` at 94cd446. [Confirmed]

- Local methods (`packages/shared/src/protocol/local.ts:227-306`) include `card.finish`, resolved from the request's `session.id`, with error `not_a_card_session`. The API handles them in `apps/api/src/local/local-handlers.ts`.
- The MCP tools are in `apps/runner/src/mcp/tools.ts` (`finish_card` at :128). The plugin (`plugins/agentdock/`) has `commands/`, `hooks/hooks.json` and `.mcp.json`, and no `skills/` yet.
- `BOARD_CARD_SOURCES = ['manual', 'captured']` (`packages/shared/src/board/types.ts:30`). `BoardCardView` is at `packages/shared/src/board/contracts.ts:46`. Per-card toggles today: `continueAfterDesign`, `issueOnRun`, `specOnRun`.
- `card.collect` (`packages/shared/src/protocol/commands/cards.ts:155-195`) commits leftovers, pushes and opens a PR. A session end of a card worker is handled in `apps/api/src/board/board-sink.ts:153`.
- `Slot` (`apps/api/prisma/schema.prisma:525`) carries `issue`, `status`, `prNumber`, `prState`; the fleet projector is `apps/api/src/fleet/fleet-projector.service.ts`. `slot.message` exists (`packages/shared/src/protocol/commands/control.ts:255`, operator, 10 s).
- `BoardSettings` (`schema.prisma:2767`): `issueOnRun`, `specOnRun`, `maxRunning`, `captureEnabled`, `captureModel`.

## Acceptance criteria

- [ ] `card.track` from a manual session creates one In progress `terminal` card linked to the session; a second call updates it; a worker session gets `not_a_manual_session`; a runner whose local user is not a project member gets 404 (authorization) — `apps/api/src/board/board-terminal.e2e.spec.ts`.
- [ ] The tracked session's end moves the card to Finished; with `autoCollect` off no command is sent; with it on, `card.collect` runs once in the session's cwd and the card gets the PR — same e2e.
- [ ] Only a person moves a `terminal` or `fleet` card to Completed — `packages/shared/src/board/moves.spec.ts` + e2e.
- [ ] A dispatched slot gets one `fleet` card in In progress; PR open → Finished; a drag to To Do is refused `fleet_slot`; a `cs:ready` issue with no slot is one To Do card — `apps/api/src/board/board-fleet.e2e.spec.ts`.
- [ ] Editing a running fleet card's body sends one `slot.message` with the next-round prompt; the GitHub issue is not called — same e2e.
- [ ] Capture skips a session that tracks a card (`tracked`) — `apps/api/src/capture/capture-run.e2e.spec.ts`.
- [ ] The `track_card` tool and the skill ship in the plugin; `plugin.test.ts` validates the manifest — `plugins/agentdock/test/plugin.test.ts`, `apps/runner/src/mcp/server.spec.ts`.
- [ ] The card sheet shows the tracking/fleet header, the Automatic work toggle (terminal cards), and Settings › Board shows `autoCollectTracked` — `apps/web/src/lib/board/*.test.ts`; screenshots 390/1440 both themes.

## Parallel plan

| Slot | What | Owns (globs) | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i282-contract | sources, view fields, `card.track` local method, `not_a_manual_session`, `fleet_slot` refusal, `autoCollect` + `autoCollectTracked`, capture skip reason `tracked`, schema + migration | packages/shared/src/board/types.ts, packages/shared/src/board/contracts.ts, packages/shared/src/board/moves.ts, packages/shared/src/board/moves.spec.ts, packages/shared/src/board/capture-limits.ts, packages/shared/src/protocol/local.ts, packages/shared/src/protocol/local.spec.ts, apps/api/prisma/schema.prisma, apps/api/prisma/migrations/*_board_terminal_fleet/** | — | yes | opus |
| i282-plugin | `track_card` MCP tool, plugin skill, manifest | apps/runner/src/mcp/tools.ts, apps/runner/src/mcp/server.spec.ts, plugins/agentdock/skills/**, plugins/agentdock/.claude-plugin/plugin.json, plugins/agentdock/test/** | i282-contract | no | sonnet |
| i282-api-terminal | `card.track` handler, session end → Finished, `autoCollect` collect, capture skip, settings | apps/api/src/local/local-handlers.ts, apps/api/src/board/board-terminal.service.ts, apps/api/src/board/board-terminal.e2e.spec.ts, apps/api/src/board/board-sink.ts, apps/api/src/board/board.service.ts, apps/api/src/board/board.module.ts, apps/api/src/board/board-mapper.ts, apps/api/src/board/dto.ts, apps/api/src/board/board-settings*.ts, apps/api/src/capture/capture-input.ts, apps/api/src/capture/capture.service.ts, apps/api/src/capture/capture-run.e2e.spec.ts | i282-contract | no | opus |
| i282-api-fleet | fleet mirror projector, edits → `slot.message`, `cs:ready` To Do card | apps/api/src/fleet/board-fleet.service.ts, apps/api/src/fleet/fleet-projector.service.ts, apps/api/src/fleet/fleet.module.ts, apps/api/src/board/board-fleet.e2e.spec.ts | i282-contract | no | opus |
| i282-web | card face/sheet for terminal and fleet sources, Automatic work toggle, settings toggle, refusal texts, screens doc | apps/web/src/components/board/**, apps/web/src/lib/board/**, apps/web/src/app/(app)/projects/[projectId]/settings/board-tab.tsx, docs/ui/screens.md | i282-contract | no | sonnet |

The four follow-on slots run in parallel once the contract merges. `i282-api-fleet` reaches the board through Prisma and its own service in the fleet module, so it does not open `board.module.ts` or `board.service.ts`. The edit path is the one shared seam: `BoardService.update` calls an optional `FleetCardEdits` port that `i282-api-fleet` provides. The contract defines the port's type in `packages/shared/src/board/contracts.ts`.

## Live contention

The fleet is empty and develop is at 94cd446. No open PR touches these files.

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i282-contract | do not open it |
| apps/api/src/board/board-mapper.ts | i282-api-terminal | i282-api-fleet maps fleet fields through its service, not this file |
| docs/ui/screens.md | i282-web | do not open it |

## Risks

- **A model that tracks too eagerly** fills the Board with noise (medium). Mitigation: the skill's definition of work, one card per session by default, and Dismiss on a tracked card.
- **`slot.message` lands while a worker is mid-turn** (low). It queues in Claude Code like any typed prompt. The orchestrator's two-call tmux send is the runner's concern, as today.
- **A fleet card and a person's card for the same issue** (low). The fleet card shows the issue link. No dedupe across sources.

Depends on #281 (closed).
