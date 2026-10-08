# Live read-only worker pane

Issue: [#18](https://github.com/AndreyBegma/AgentDock/issues/18) · Roadmap: M2.3 ·
Decisions: [ADR-0001](../adr/0001-control-plane-and-per-machine-runner.md),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md),
[runner-protocol.md](../architecture/runner-protocol.md) (`subscribe` / `pane`), [security.md](../architecture/security.md)

## Summary

The fleet page (#11) says *what state* a worker is in; this item lets a project
member *watch* it: the terminal pane of a `cs-<slot>` session, streamed
read-only into the slot sheet. The runner captures the pane only while someone
is watching, sends only what changed, and stops when the last viewer leaves.
Nothing can be typed into the pane from the browser — interactive attach is
M3.6, admin-only.

## Scope

### In scope

- Protocol messages `subscribe` / `unsubscribe` (server → runner) and `pane` (runner → server) for a slot, as already sketched in runner-protocol.md.
- Runner pane streamer: `tmux capture-pane` at 1 s while subscribed, diff-only frames, viewer cap, idle stop.
- API relay through `LiveService` on topic `pane:<projectId>:<slot>` with a membership authorizer.
- Web pane panel in the slot sheet.

### Out of scope

- Input of any kind into the pane (M3.6).
- The orchestrator's own session pane (only `cs-*` slots in this item).
- Storing pane text. Frames are relayed, never persisted.

## Decisions

The person delegated all decisions on 2026-10-07; each below is the default
taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | **Capture.** `tmux capture-pane -p -e -J -t cs-<slot> -S -<history>` every 1 s while at least one viewer is subscribed; `-e` keeps ANSI colour escapes, `-J` joins wrapped lines. History depth 2000 lines on the first frame, visible screen afterwards | runner-protocol.md; tmux man page [Confirmed] |
| D2 | **Diff frames.** The first frame per subscription is `full { lines, cursor }`. Later frames are `patch { from, lines }` — replace lines from index `from` to the end — computed against the previous capture; no frame when nothing changed. A `full` is resent every 60 s and on resubscribe | new |
| D3 | **Fan-out.** The runner keeps one capture loop per slot, regardless of how many API subscribers; the API keeps one runner subscription per slot and fans out to browser subscribers. When the last browser unsubscribes, the API sends `unsubscribe`; the runner stops the loop within 2 s | new |
| D4 | **Limits.** Max 10 concurrent pane subscriptions per runner, 20 browser viewers per slot; over the cap → `error { code: "too_many_viewers" }`. Frame size capped at 256 KiB (lines truncated from the top) | new |
| D5 | **Redaction.** Before sending, the runner masks strings that look like secrets (the same patterns as the plugin's trailer/secret guards: `ghp_…`, `sk-…`, `xox…`, `AKIA…`, `-----BEGIN … PRIVATE KEY-----`) with `•••`. Best-effort; documented as such | security.md |
| D6 | **Authorization.** Topic `pane:<projectId>:<slot>` is registered with #9's `TopicAuthorizerRegistry`: allowed for any member of the project (viewer and up, #10 D11) and admins; the slot must belong to that project. The runner-side `subscribe` carries `{ projectId, root, slot }` and is checked against the watch list and the `.wt-<repo>-<slot>` rule (#10 D10) | ADR-0008, #9 D11 |
| D7 | **Session end.** When `cs-<slot>` disappears the runner sends a final `pane { ended: true }` and drops the subscription; the web shows "session ended" with the last frame kept on screen | new |
| D8 | **No persistence.** Frames are not written to `events` or any table. Audit records only `pane.watch_started` / `pane.watch_stopped` per user and slot (#8 action union) | security.md |
| D9 | Slot session names: the runner accepts both `cs-<slot>` (current) and `cs-<prefix>--<slot>` (code-sentinel P11, [plugin#11](https://github.com/AndreyBegma/claude-code-plugin/issues/11)), parsing them in one shared helper `apps/runner/src/fleet/session-name.ts` owned by #11 (import it); a session belongs to a project only when its worktree path does. Other issues import the helper, never re-parse | #11 D12, plugin#11 |

## Data / Schema

None. No migration.

## Protocol

New file `packages/shared/src/protocol/pane.ts`, one export line in `index.ts`.

| Direction | Type | Payload |
|---|---|---|
| S → R | `subscribe` | `{ id, kind: "pane", projectId, root, slot }` |
| S → R | `unsubscribe` | `{ id }` |
| R → S | `pane` | `{ id, frame: { type: "full", lines, cursor } \| { type: "patch", from, lines } \| { type: "ended" } }` |
| R → S | `subscribe.error` | `{ id, code: "not_found" \| "too_many_viewers" \| "forbidden" }` |

These replace the placeholder rows for `subscribe` / `unsubscribe` / `pane` in
runner-protocol.md; i18-protocol updates that table.

## API

No REST endpoints. Browser clients subscribe on `/live` (#9) to
`pane:<projectId>:<slot>` and receive `event` messages of type `pane.frame`
(`data` = the frame) and `pane.ended`.

## UI

Slot sheet on `/projects/[projectId]/fleet` gains a **Pane** tab:

- uses glass-ui `LogViewer` from [AndreyBegma/glass-ui#70](https://github.com/AndreyBegma/glass-ui/issues/70) (ANSI colours, follow-tail with pause, search) when released; until then a `<pre>` styled with tokens (`font-mono`, `bg-raised`, `text-ink-2`) that strips ANSI;
- header: live dot (connected / reconnecting / ended), viewer count, "read-only" chip;
- the panel subscribes when the tab opens and unsubscribes when it closes or the sheet closes.

## Configuration

| Key | Where | Meaning |
|---|---|---|
| `pane.intervalMs` | runner config | capture interval, default 1000 |
| `pane.maxSubscriptions` | runner config | default 10 |

## Acceptance criteria

- [ ] With a fixture tmux session `cs-i42` printing a counter, a subscribed browser receives a `full` frame within 2 s and then only `patch` frames; when output stops, no frames are sent.
- [ ] ANSI colour escapes reach the client unchanged (LogViewer) or are stripped (fallback `<pre>`), never shown as raw `\x1b[` text.
- [ ] Opening the pane from two browsers starts exactly one capture loop on the runner; closing both stops it within 2 s (asserted by counting `capture-pane` invocations through a shim).
- [ ] Killing `cs-i42` delivers `ended` and the last frame stays visible.
- [ ] A frame containing `ghp_` followed by 36 characters is delivered masked.
- [ ] The 11th concurrent subscription on one runner gets `too_many_viewers`.
- [ ] No pane text is found in the database after a session (asserted by querying `events` and `audit_records`).
- [ ] **Authorization:** a non-member of the project cannot subscribe to `pane:<projectId>:<slot>` (`forbidden`); a member of project A cannot subscribe to a slot of project B by naming it under A's id (`not_found`); there is no message type through which a browser can send input to the pane.
- [ ] `bun run check`, `bun run test`, `bun run build` pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i18-protocol | pane messages, runner-protocol.md table | packages/shared/src/protocol/pane.ts, packages/shared/src/protocol/messages.ts, packages/shared/src/protocol/index.ts, docs/architecture/runner-protocol.md | — | yes | opus |
| i18-runner | capture loop, diff, redaction | apps/runner/src/pane/**, the runner message dispatcher from #5 (one registration line for `subscribe` / `unsubscribe`) | i18-protocol | no | sonnet |
| i18-api | relay, authorizer, audit actions | apps/api/src/pane/**, apps/api/src/app.module.ts, packages/shared/src/audit/actions.ts | i18-protocol | no | opus |
| i18-web | Pane tab | apps/web/src/app/(app)/projects/[projectId]/fleet/**, apps/web/src/lib/pane/** | i18-api | no | sonnet |

i18-runner and i18-api run in parallel after the protocol lead merges.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/shared/src/protocol/messages.ts | i18-protocol | the message union is extended, not rewritten; #17 does not touch it. Keep both on conflict |
| packages/shared/src/protocol/index.ts | i18-protocol | append-only; keep both |
| apps/api/src/app.module.ts | i18-api | append-only; keep both imports |
| packages/shared/src/audit/actions.ts | i18-api | append-only union from #8; keep both |
| apps/web/src/app/(app)/projects/[projectId]/fleet/** | i18-web | also edited by #16 and #17 web slots — one open PR at a time (orchestrator Phase 2 holds the others `BLOCKED — work`) |
| bun.lock | regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) | — |

Append-only registries shared across issues (keep both on conflict):
`apps/api/src/app.module.ts`, `packages/shared/src/protocol/commands.ts`,
`packages/shared/src/protocol/index.ts`, the runner command handler registry
from #5, `apps/runner/src/collectors/index.ts`, `apps/web/src/components/shell/nav.ts`.
`apps/api/prisma/schema.prisma` is not touched by this item.

Cross-repository: prefers glass-ui `LogViewer` from AndreyBegma/glass-ui#70;
not a blocking dependency.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Pane shows secrets typed or printed by an agent | high | read-only, members only, best-effort redaction (D5), no persistence (D8) |
| 1 s capture loops load a busy machine | low | only while watched, one loop per slot, caps (D4) |
| Wide ANSI-heavy panes produce large frames | low | patch frames, 256 KiB cap |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Should viewers below operator see panes? | Yes — read-only, same as the rest of the fleet page |
| Stream the orchestrator's own pane too? | Not in this item; candidate for the orchestrator card later |

## Notes

### From i18-protocol

- **Where the schemas are.** All four messages, the frame union and the D1–D4
  limits are in `packages/shared/src/protocol/pane.ts`. Import the constants
  (`PANE_CAPTURE_INTERVAL_MS`, `PANE_MAX_SUBSCRIPTIONS`,
  `PANE_MAX_VIEWERS_PER_SLOT`, `PANE_MAX_FRAME_BYTES`, …) rather than
  repeating the numbers. The API and web share `paneTopic(projectId, slot)`
  and `PANE_LIVE_EVENTS` (`pane.frame`, `pane.ended`). The #5 placeholders for
  `subscribe` / `unsubscribe` / `pane` in `messages.ts` are replaced; the
  exported names are the same.
- **The server owns `id`.** The API picks one `id` per runner subscription,
  meaning one per slot (D3). Every `pane` and `subscribe.error` echoes that
  `id`, and `unsubscribe` carries only the `id`. Frames therefore do not repeat
  `projectId` / `slot`: the API maps `id` back to its topic.
- **`slot` is pattern-checked** with the shared slot-name rule
  (`^[a-z0-9][a-z0-9-]*$`, max 64, the same `slotNameSchema` as the #17
  control commands). The value reaches `tmux … -t cs-<slot>`, where `:` and `.`
  are target syntax. Session-name parsing still goes through #11's
  `session-name.ts` (D9).
- **Adding a message type needs no app edit.** The runner's
  `handle(ServerMessage)` switch (`apps/runner/src/connection.ts`) and the API's
  `handle(RunnerMessage)` switch (`apps/api/src/runners/runner.gateway.ts`)
  have no exhaustiveness guard. The new runner → server `subscribe.error`
  therefore compiles on both sides and is ignored until i18-api handles it.
  Messages are not like commands. Commands have #12's trap: a key in the
  `commands` map without a runner handler breaks the runner build, because
  `CommandHandlers` requires every key. So a protocol slot defines a command
  but does not add it to that map; the runner slot adds the entry together
  with its handler.
- **What each side adds.** i18-runner: replace the `subscribe` /
  `unsubscribe` no-op in `connection.ts` with a call into
  `apps/runner/src/pane/`. i18-api: replace the `case 'pane':` no-op in
  `runner.gateway.ts`, add `case 'subscribe.error':` beside it, and relay both
  to `paneTopic(…)`.

### From i18-api

- **`/live` changes (additive).** `liveTopicSchema` accepts
  `pane:<projectId>:<slot>`, the slot part with `slotNameSchema`'s rule;
  `LiveTopicPrefix` gains `pane`. `LIVE_ERROR_CODES` gains `not_found` (the
  slot is not the project's) and `too_many_viewers` (21st viewer of a slot, or
  the runner's own cap). A non-member gets `forbidden` whether or not the
  project exists.
- **Authorization** (`apps/api/src/pane/pane-authorizer.ts`): the project rule
  of #10 (`ProjectAccessService.resolve` — admins, and members of any role),
  then a `slots` row with that `projectId` and `name`. `LiveMonitor`
  re-checks it every minute, like every topic.
- **A big frame arrives in pieces.** A `/live` message is at most 64 KiB, a
  runner frame up to 256 KiB. The relay splits a frame that does not fit
  using the frame semantics: `full { first lines, cursor }` then
  `patch { from, rest }`, …; a long patch becomes consecutive patches. Applying
  them in order yields the original. **i18-web: a `full` may be followed at
  once by patches — apply every `pane.frame` in order, render after each or
  batch per tick.** A single line over ~64 KiB is truncated.
- **Late joiners.** Every browser that joins a watched slot makes the relay
  `unsubscribe` the current id and `subscribe` a new one, so the runner sends a
  fresh `full` (no frame cache, D8). Every viewer receives that `full`.
  **i18-runner: never expect a second `subscribe` with the same id**; frames
  still sent on the old id are dropped by the API.
- **Runner offline / reconnect.** Watching an offline runner's slot is
  accepted (`subscribed`) and nothing arrives; when the runner completes
  `hello` the relay subscribes every watched slot of it again, with new ids.
- **`ended`** → `pane.ended` (`data: null`); viewers stay on the topic and the
  runner subscription is forgotten. The next viewer to join subscribes again.
- **`subscribe.error`** → every viewer gets `error { topic, code }` and is
  unsubscribed from the topic; no `unsubscribe` goes back.
- **Wiring for later streams.** `RunnerStreams` (`apps/api/src/runners/`) is
  the runner side — send `subscribe`/`unsubscribe`, hear `pane` /
  `subscribe.error`, `connected` / `disconnected`. `LiveTopicHookRegistry`
  (`apps/api/src/live/`) is the browser side — `admit` (cap), `joined`,
  `left` for every way a socket gets on or off a topic.
- **Audit**: `pane.watch_started` / `pane.watch_stopped`, actor the user,
  target `{ type: 'slot', id: <slot name> }`, `projectId`; once per user per
  slot however many tabs. No frame content is logged or stored.
- **Follow-up:** the UI header's viewer count has no event (`PANE_LIVE_EVENTS`
  has only `frame` and `ended`); a `pane.viewers` event is a protocol change
  for a later item.

### From i18-runner

- **Where.** `apps/runner/src/pane/`: `streamer.ts` (subscriptions, one loop
  per slot), `frame.ts` (diff, byte cap), `redact.ts` (D5). The connection
  hands `subscribe` / `unsubscribe` to it and calls `reset()` whenever the
  socket closes: subscriptions do not survive a reconnect, because the API
  resubscribes every watched slot with new ids.
- **History on every tick (deviation from "visible screen after").** A
  patch's `from` indexes the previous frame, and a visible-only capture
  cannot be aligned with a 2000-line buffer once output scrolls. Every tick
  therefore captures `-S -2000`. **Known cost:** once the buffer is full, each
  scroll shifts every index, so a tick's patch is about the whole frame —
  up to 256 KiB/s per watched slot. Follow-up: `#{history_size}`-based
  alignment of a visible-only capture.
- **Authorization.** `(projectId, root)` must be one entry of the watch list
  (`forbidden`). The slot is resolved with the #17 helper `resolveSlot`: no
  `.wt-<repo>-<slot>` worktree, no live session attributed to the slot by
  `ownedSlot`, or an unreadable repository all answer `not_found`. Every tmux
  call targets `=<session>:`.
- **Frames.** A new id is answered with a `full` on the next tick (at most
  one interval); every id gets a `full` again every 60 s. Frames are
  redacted before they are diffed, then capped from the top. The cursor
  comes from `display-message` and is an index into `lines`. A capture that
  times out skips the tick; a capture that fails ends the subscriptions.
- **Limits.** Subscriptions still resolving count toward the 10-per-runner
  cap. A repeated id is ignored; an `unsubscribe` that overtakes its
  `subscribe` cancels it.
- **No config keys yet.** `pane.intervalMs` and `pane.maxSubscriptions`
  need `apps/runner/src/config.ts`; the shared constants are the values.
  Follow-up.
- **Redaction is best-effort.** A token split by an ANSI code, or a private
  key whose `BEGIN` line has scrolled out of the capture, is not masked.

### From i18-web

- **Where.** `apps/web/src/lib/pane/`: `reducer.ts` (pure `applyFrame`: `full`
  replaces, `patch` replaces from `from` to the end, `ended` keeps the lines),
  `use-pane.ts` (subscription + reducer), `format.ts` (error sentences). The
  panel is `fleet/pane-panel.tsx`, mounted by the slot sheet only while its
  **Pane** tab is selected, so switching tab, closing the sheet or leaving the
  page unsubscribes.
- **`useLive` gained topic errors (additive).** `useLive(topic, onMessage,
  { onError })` and `LiveClient.subscribe(topic, handler, onError?)`: an
  `error { topic, code }` message reaches the `onError` of that topic's
  subscribers only. Before, the client dropped everything but `event`
  messages, so `forbidden` / `not_found` / `too_many_viewers` were invisible.
  Existing callers are unchanged.
- **Rendering.** `LogViewer` lines use the line index as `id`: a patch replaces
  the tail, so the same index is the same row. Every `pane.frame` is applied in
  order, so a chunked `full` + `patch`es yields the original frame. ANSI colour
  is rendered by `LogViewer` (no `<pre>` fallback).
- **No viewer count.** There is no event for it (see i18-api follow-up).
- **Not reachable from the UI:** `not_found` (a slot of another project under
  this project's id) — the sheet only opens slots the project lists. Its
  sentence is covered by the format mapping only.

Depends on #9

Depends on #11
