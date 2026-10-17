# ADR-0038: A round waiting on its own background tasks is not waiting for the person

Status: accepted · Date: 2026-10-16 · Amends [ADR-0024](0024-board-cards-and-dedicated-card-workers.md) (round phases) ·
Issue: [#390](https://github.com/AndreyBegma/AgentDock/issues/390) ·
Spec: [`docs/specs/390-card-waiting-on-background-task.md`](../specs/390-card-waiting-on-background-task.md)

## Context

A card round moved to `waiting` (**Waiting for you**) on every `hook.stopped`
and back to `running` only on `hook.prompt_submitted`. A turn that ends with
the worker's own background command still running looks the same to the API
as a turn that ends with a question, and a background task notification wakes
the worker without submitting a prompt. On 2026-10-16 a card showed **Waiting
for you** for 7.5 hours while its worker waited on a background wait loop that
could never end, and nothing noticed.

## Decision

1. **A new active round phase, `background`.** `hook.stopped` carries
   `backgroundTasks`: the session's background tasks still running at the
   stop. More than zero moves the round to `background` (**Running in
   background**), not `waiting`; it raises no `card.waiting`, and the run stays
   `running`. Zero, or a runner that does not report it, is `waiting` as
   before. `background` is in `ACTIVE_CARD_ROUND_PHASES`: it holds the card in
   In progress and counts against `maxRunning`. The Board's **Waiting for you**
   filter does not include it; **Running** does.
2. **The runner reads it from the transcript (ADR-0001).** The Stop hook reads
   the session's `transcript_path`: a task starts with a tool result naming it
   (`backgroundTaskId` of Bash — also a command its timeout moved to the
   background —, `taskId` of Monitor, an `async_launched` `agentId` of Agent)
   and ends with a `<task-notification>` that has a `<status>`. A
   `SessionStart:startup`/`:resume` in the transcript starts over: a new
   Claude Code process owns no earlier task. The process tree was not needed.
3. **The command is content (ADR-0021).** The newest running command,
   shortened to one line of `CARD_BACKGROUND_COMMAND_MAX` characters, rides as
   the content field `background` of `hook.stopped`: gated and redacted on the
   runner, and stored on the round (`backgroundCommand`) only for a project
   that ships content. To let the board sink read it, the content keys are
   now stripped from the batch after every sink ran, in `RunnerIngestService`,
   instead of inside the sessions sink; `events.data` still never holds them.
4. **Any activity is running.** `hook.tool_finished`, like
   `hook.prompt_submitted`, moves a `waiting` or `background` round back to
   `running` and clears the background fields.
5. **A stall warns once.** A sweep (every `CARD_BACKGROUND_SWEEP_MS`) records
   one `card.background_stalled` server event for a round in `background`
   longer than the board setting `backgroundStallMinutes` (default 30, 5–1440)
   and marks the round (`backgroundStalledAt`). The event is a warn activity
   item and a `card.background_stalled` notification linking to the card. A
   new stall — the round left `background` and came back — fires again.

## Consequences

- A worker's background work no longer reads as a question to the person, and
  a stuck background task surfaces after the threshold instead of never.
- A task Claude Code stops tracking without a notification (the process killed
  without a restart) keeps a round in `background` until the next activity;
  the stall warning is what surfaces it. Killing tasks stays out of scope.
- Runners older than this report no `backgroundTasks`; their stops stay
  `waiting`, as before.
