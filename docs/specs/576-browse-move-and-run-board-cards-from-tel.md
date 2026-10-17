# C-211: Browse, move and run Board cards from Telegram

Issue: #576

## What to do
Give the bot read and basic control of the Board for the current project (the project picker comes from the router card). The bot calls the board services in-process as the linked user (`apps/api/src/board/`, the routes in `board.controller.ts`).

- **`/board`** shows the columns with card counts as buttons.
  - Tapping a column lists its cards, 10 per page with Prev / Next.
  - Each row shows the card number, title and state.
  - `/board <column>` jumps straight to a column.
- **`/card <n>`**, or tapping a card, shows the card detail:
  - title, kind, column, the agent / session state and the pull request, if any;
  - a short summary of the body, trimmed to Telegram's limit;
  - an "Open in app" link.
- **Card buttons** follow the rules the web uses. Show only the actions the card's current state allows, using the same rules as `apps/web/src/lib/board/actions.ts`.
  - **Move** opens a column picker and calls the move endpoint's service. Error messages match the web's: for example a column that is not allowed.
  - **Run** dispatches the card, the same as `POST .../run`.
  - **Stop** stops it, the same as `POST .../stop`, after a confirm tap.
- Write actions need operator+. Read actions need any active member.
- Every action is audited the same way the web action is.
- After an action, the card message is edited in place to the new state.

## Acceptance criteria
- [ ] `/board` shows the columns and counts of the current project. They match the web Board.
- [ ] A column with more than 10 cards pages correctly.
- [ ] `/card <n>` shows the detail for an existing card. An unknown number gets a clear reply.
- [ ] Move changes the card's column on the web Board. A move the board refuses shows the board's reason.
- [ ] Run and Stop are offered only when the card's state allows them, and they work. Stop asks for confirmation.
- [ ] A viewer sees cards but gets no write buttons. A forged callback from a viewer is refused server-side.
- [ ] Callback payloads stay within 64 bytes (the router's codec).
- [ ] There are e2e specs on the Telegram fake client for list, detail, move, run and stop.

## Out of scope
- Feedback, accept, finish and session messages: a separate card.
- Editing, deleting, dependencies and stacks: the Mini App covers them.
- Bulk actions.

## Open questions
None.
