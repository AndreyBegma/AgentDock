# C-381: Board misses a card session's question: waitingOnQuestion stays false while the worker sits on a selector

Issue: #913

## What happened
On 2026-10-24, C-369's card session (tmux `nautelle-card-g0fip5uo`, worktree `.wt-AgentDock-card-g0fip5uo`) showed an AskUserQuestion selector from about 10:30Z to 12:50Z. The question was "C-368 hasn't landed yet… How should C-369 go ahead?", with 3 options plus "Type something" and "Chat about this". For those 2 h 20 min:
- `board_card 369` returned `waitingOnQuestion: false` and `question: null`, with `roundPhase` running;
- `board_wait` never emitted a question event;
- the round did not move, and no commits landed after 10:30.

Nobody saw the question until the orchestrator opened the tmux pane by hand. The person's session had no way to answer it either: `card_message` with kind `option` needs a `questionKey`, which only comes from a detected question. The round was stopped and restarted as a feedback round to get past it.

## Expected
When a card session shows a question selector, the card reports `waitingOnQuestion: true` with the question text, its options and a `questionKey`. `board_wait` emits the question event, and the web app and Telegram show it (ADR-0083 / the question relay). Answering through `card_message` with kind `option` or `other` reaches the selector.

## Where to look
The runner's question detection for card sessions, whether it is fed by a hook or by parsing the pane. Compare it against this pane's layout: a long multi-line question, 3 numbered options with descriptions, then "4. Type something.", a separator line, then "5. Chat about this". Also check whether detection is skipped while a background task runs. The same card showed `roundPhase: background` earlier in the round.

## Done when
A selector of this exact shape is detected: a regression test with the captured pane text, or with the hook payload. Plus an e2e test where the round reports the question, `board_wait` emits it, and an answer through `card_message` reaches it.

Related runner policy: `commands.session.message` is off on the person's machine, so `card_message` is refused anyway. Say in the card UI and MCP error which policy blocks answering, and how to enable it.
