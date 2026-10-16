# C-232: Let the person scroll back through a terminal attach's history

Issue: #522

## What to do
The web terminal (`apps/web/src/components/terminal/terminal-view.tsx`, shown by `terminal-sheet.tsx`) cannot be scrolled. The runner spawns `tmux attach-session` (`apps/runner/src/terminal/pty.ts`) and tmux redraws the whole screen, so xterm's `scrollback: 5000` never fills. A wheel or touch swipe moves nothing. This is worst on a phone, where read-only attach is the usual mode.

Add inline scrollback that works the same in `read` and `write` mode, on every surface that mounts `TerminalView`: the card terminal on the Board, Fleet slots and the orchestrator, manual sessions, and skill runs.

1. **Protocol** (`packages/shared/src/protocol/terminal.ts`): add a browser text frame `{ type: 'history' }` to `terminalClientFrameSchema`, plus a matching server→runner message and a runner→server reply that carries the captured lines. Keep every schema strict and size-bounded, like the existing ones. The runner accepts only this typed message for the attach `id` it already holds (ADR-0010). It never takes a session name or a shell argument from the client.
2. **Runner** (`apps/runner/src/terminal/manager.ts`): answer by running `tmux capture-pane -p -e -J -S -5000` on the attached session's pane. Reuse the approach of `apps/runner/src/pane/streamer.ts` (`historyLines`) and the `=` exact-target rule from `pty.ts`. The reply carries the last 5,000 lines at most, with their ANSI colours kept.
3. **API** (`apps/api/src/terminal/terminal-relay.ts`, `terminal.gateway.ts`): relay the request and the reply for that attach only. A `read` attach is allowed to ask for history, because asking is not input.
4. **Web**: when the person scrolls up (wheel, or a touch swipe down) while at the live bottom, request history once. Show it in a scrollable, read-only xterm (or the same xterm in a history state) layered over the live view, with ANSI colours rendered. While the history view is open, live output keeps arriving and is applied to the live terminal underneath. Scrolling back to the bottom, or tapping a "Back to live" control, returns to the live view. A visible marker tells the person they are looking at history and not the live screen. Use glass-ui components for any control (ADR-0011).

## Acceptance criteria
- [ ] On a read-only card terminal on a 375 px phone, swiping down on the terminal shows earlier output, with colours, from up to 5,000 lines back.
- [ ] Mouse-wheel up does the same on desktop, in both read-only and Take-control mode.
- [ ] Scrolling back to the bottom, or the "Back to live" control, returns to the live terminal. Nothing that the agent printed in the meantime is lost.
- [ ] While history is shown, a visible indicator says it is history, not live.
- [ ] Scrolling through history sends no input to the PTY: keystrokes are not forwarded in history state, and the agent's session is never put into tmux copy-mode.
- [ ] Other viewers of the same session see no change while one person scrolls.
- [ ] It works on every TerminalView surface: Board card, Fleet slot, orchestrator, manual session, skill run.
- [ ] The new frames are strict zod schemas with tests. A history request for an `id` the runner does not hold, or a frame with extra fields, is rejected.
- [ ] The runner caps the reply at 5,000 lines, and tests cover the capture command arguments (`manager.spec.ts`) and the API relay (`terminal-relay.spec.ts`).
- [ ] `docs/specs/29-terminal-attach.md` and `docs/architecture/runner-protocol.md` describe the new messages.

## Out of scope
- Enabling tmux `mouse on` or copy-mode, or changing `history-limit` in any session.
- Search inside the history, or exporting or copying it to a file.
- Changing the live pane streamer (`apps/runner/src/pane/`) or the card's live pane preview.
- Persisting history on the API.

## Open questions
None.
