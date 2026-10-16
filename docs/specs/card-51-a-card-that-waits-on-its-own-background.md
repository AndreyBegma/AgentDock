# C-51: A card that waits on its own background task shows Waiting for you

GitHub issue: #390 — the pull request description starts with `Closes #390`. Spec: `docs/specs/390-card-waiting-on-background-task.md`.

## What to do

A card shows **Waiting for you** when the worker is not waiting for a person but for one of its own background tasks. Nothing notices when that task never ends.

Incident on 2026-10-16 (C-39, #384):

- the worker started a background Bash wait loop for another worktree's jest and ended its turn: "I'll be notified when it finishes";
- the loop matched its own command line (`pgrep -f`) and never ended;
- the card showed **Waiting for you** for about 7.5 hours until a person found the stuck process by hand.

Later, while the worker's full e2e run was going in the background, the card again showed **Waiting for you** (`waitingAt` 07:33).

Why: `BoardSink` (`apps/api/src/board/board-sink.ts`) sets the round to `waiting` on `hook.stopped`. It moves back to `running` only on `hook.prompt_submitted`. A turn that ends with background work still running looks the same as a turn that ends with a question. And when a background task notification wakes the worker, no prompt is submitted, so the card can stay `waiting` while the worker is busy.

Make the card tell these apart:

1. **Waiting on a background task.** When the turn stops and the session still has background tasks running, the round shows a distinct state, e.g. **Running in background**, not **Waiting for you**. It names what is running if that is known (the command, shortened). The runner reads this; the control plane never inspects the project machine (ADR-0001).
2. **Back to running on any activity.** Activity after a stop (`hook.tool_finished`, a new turn started by a task notification) moves the round back to `running`, not only `hook.prompt_submitted`.
3. **Stall signal.** A round that has been waiting on its background tasks longer than a threshold (default 30 min, a board setting) raises an activity event with severity warn and a notification: "C-39 has been waiting on its own background task for 30 min". It links to the card. It fires once per stall, not every minute.

Adding a round phase or sub-state changes the shared types (`CARD_ROUND_PHASES` in `packages/shared/src/board/types.ts`). If it changes the round model, record the decision in an ADR in the same PR.

## Acceptance criteria

- [ ] A worker that ends its turn with a background command running shows **Running in background** (or the chosen wording), not **Waiting for you**. The **Waiting for you** filter on the Board does not include it.
- [ ] A worker that ends its turn with a question and no background work still shows **Waiting for you**.
- [ ] When a background task notification wakes the worker and it runs tools, the card shows **Running** without a person typing anything.
- [ ] A background wait longer than the threshold produces one warn activity event and one notification for the card. After the worker resumes and stalls again, it fires again.
- [ ] Tests cover the phase transitions in `BoardSink` (stop with background work, stop without, tool activity after a stop) and the stall timer.
- [ ] `bun run check` and `bun run test` pass.

## Out of scope

- Killing or restarting stuck background tasks automatically.
- Fleet slots (orchestrator workers); only Board card rounds.
- How workers wait for each other's e2e runs (C-42).

## Open questions

- How the runner learns that background tasks are running. Default: the session's transcript records each background task start and its completion notification, and the runner already reads it. If the transcript is not enough, use the process tree of the session's `claude` process: shell children other than its MCP servers. State the chosen source in the PR.
- The exact label. Default: **Running in background**.
