# Design run log stays on "Waiting for output…": a second subscriber to a run topic never gets the backlog

Issue: #426 · Board card: C-76 · Kind: bug

## What to do

While a design is being generated (e.g. C-75, "Step 1/2 · Building the UI profile"), the progress card shows the newest log line ("Writing the profile itself now…"), but **Show log** opens a Run log that stays on **Waiting for output…** for the whole run. The person has never seen any output of a design generation there.

Root cause (`apps/web`):
- `DesignProgress` (`components/design/design-progress.tsx`) already calls `useRunLog(projectId, runId, running)` to show the newest line.
- **Show log** mounts `RunLogPanel` (`components/runs/run-log-panel.tsx`), which calls `useRunLog` again for the same run topic.
- `LiveClient.subscribe` (`lib/live/client.ts`) sends the server `subscribe` only for the **first** subscriber of a topic. The server replays a run's backlog on `subscribe`, so the second subscriber gets no backlog — only lines that arrive after the panel opened. A design run writes lines rarely, so the panel stays empty.

Fix: every subscriber of a run-log topic sees the whole log so far, however late it subscribes. Default approach: one shared run-log store per run topic in the tab (ref-counted with the topic subscription), so `DesignProgress`, `RunLogPanel` and any other `useRunLog` user read the same lines. Alternatively the client replays the topic's buffered frames to a late subscriber. Keep "nothing is stored" across reloads; a reconnect still replaces the lines with the server's backlog.

Also check that the design runner actually streams its output lines into the run log (assistant text and tool steps, the same way skill runs do); if it only reports a status line, make it stream the same rendered log.

## Acceptance criteria
- [ ] With a design generation running, **Show log** shows every line produced so far (the same lines the progress card has seen), then follows new ones live.
- [ ] Opening and closing **Show log** several times during a run shows the full log each time.
- [ ] A skill run's log (the other `RunLogPanel` user) behaves the same when opened late.
- [ ] After a reconnect the panel shows the server backlog once, without duplicates.
- [ ] Web tests cover a second subscriber of the same run topic receiving the earlier lines.
- [ ] `bun run check` and the web tests pass.

## Out of scope
- Persisting run logs across page reloads.
- The terminal attach view.
