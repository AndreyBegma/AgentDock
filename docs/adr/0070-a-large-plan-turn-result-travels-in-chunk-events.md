# ADR-0070: A large plan turn result travels in chunk events

Status: accepted · Date: 2026-10-20 ·
Card: C-289 ·
Issue: [#686](https://github.com/AndreyBegma/AgentDock/issues/686) ·
Spec: [`docs/specs/686-lift-the-design-size-cap-to-160-kib-per.md`](../specs/686-lift-the-design-size-cap-to-160-kib-per.md) ·
Amends [ADR-0041](0041-a-design-revision-holds-named-frames.md) §1 ·
Keeps: [ADR-0010](0010-typed-command-allowlist-on-the-runner.md)

## Context

A plan turn's final `result` text travels to the API in one
`plan_turn.finished` event. That event is capped at 192 KiB
(`PLAN_TURN_RESULT_MAX_BYTES`), because one event batch is at most 256 KiB
(`MAX_EVENTS_BATCH_BYTES`) and the runner's spool refuses a larger event.
The runner cut a longer result and set `resultTruncated`, and the API failed
the turn as a `contract_violation`.

ADR-0041 therefore held all frames of a design revision to 160 KiB together
(`DESIGN_HTML_MAX_BYTES`). Multi-frame mockups, such as a stack design with
one frame per page, outgrow that: the S-7 design failed at 175 KiB.

## Decision

1. **The 160 KiB limit is per frame.** `DESIGN_HTML_MAX_BYTES` bounds one
   frame. A new `DESIGN_TOTAL_MAX_BYTES`, 1 MiB, bounds every frame of a
   revision together. Both fail the turn with `design_too_large`; the
   per-frame message names the frame, the total message states the limit.
2. **A plan turn result over one event travels in ordered chunk events.**
   - The runner cuts the result at `PLAN_TURN_RESULT_TOTAL_MAX_BYTES`
     (2 MiB) instead of 192 KiB.
   - A result whose JSON-encoded size fits `PLAN_TURN_RESULT_MAX_BYTES`
     stays `resultText` in `plan_turn.finished`, exactly as before.
   - A larger one is split into pieces whose JSON-encoded size is at most
     `PLAN_TURN_RESULT_CHUNK_BYTES` (128 KiB), never inside a surrogate
     pair. Each piece goes out as a `plan_turn.result_chunk` event
     (`{ planId, turnId, runId, projectId, index, text }`) before the
     turn's `plan_turn.finished`. That event then carries
     `resultChunks: n` and no `resultText`.
3. **The API joins the chunks before it parses.**
   - The planner sink collects the chunks of the current batch. It reads
     chunks of earlier batches from the `events` table, matched by runner,
     turn and run.
   - Pieces `0 … n - 1`, joined in `index` order, become `resultText`.
     Parsing and storage are unchanged from there.
   - A missing piece fails the turn as a truncated result does.
4. **No new channel.** Chunks are ordinary typed events in the same spool,
   sequence and acknowledgement as every other event. Ordering and
   redelivery come from the event stream. Commands are not involved
   (ADR-0010 is unchanged).

## Consequences

- A design of several frames, each up to 160 KiB and up to 1 MiB together,
  reaches the API intact.
- The `events` table keeps the chunk events as it keeps any other event, so
  a large result is stored there once more beside `plan_turns.resultText`.
- A runner with this change, connected to an API without it, sends a
  `plan_turn.finished` with no `resultText` for a large result. That API
  fails such a turn, as it would have failed the truncated result before.
- UI profile builds, assessments, captures and text normalization keep
  their one-event results and caps.
