# C-212: Give feedback, accept, finish and message sessions from Telegram

Issue: #578

## What to do
Add the review-side card actions to the bot. They appear as buttons on a card message, and on the card notifications the bot already sends (`card.waiting` and the PR notifications in `apps/api/src/telegram/`). The services behind `board.controller.ts` do the work:
- **Feedback** (`POST .../feedback`): the bot asks for the text as a reply to its message (force-reply), like Request changes in `approval-actions.ts`.
- **Message the session** (`POST .../message`): text as a reply, reusing the session-message path from #489 (`telegram-session-message.service.ts`, ADR-0045).
- **Accept** (`POST .../accept`) and **Finish** (`POST .../finish`): each asks for a confirm tap.
- **Collect** (`POST .../collect`): where the web offers it.
- **Inbox suggestions**: accept-suggestion and dismiss, for cards in the inbox.
- **`/card <n>`**: opens a card even before the browse card lands. Keep a minimal detail view here, or reuse the browse card's view if it is already merged.

Show only the actions the card's state allows, using the web's rules in `apps/web/src/lib/board/actions.ts`. All actions need operator+ and are audited like the web actions. After an action, the message is edited in place to the result.

## Acceptance criteria
- [ ] Feedback: tap Feedback, reply with text, and the feedback appears on the card in the web app.
- [ ] Message session: tap it, reply, and the running session receives the message. The orchestrator is told, per ADR-0045.
- [ ] Accept and Finish need a confirm tap, change the card's state, and the web Board shows the change.
- [ ] Accept and dismiss work on an inbox suggestion.
- [ ] Actions the card's state does not allow are not offered. A forged callback for them is refused server-side.
- [ ] A viewer gets no review buttons and is refused server-side.
- [ ] There are e2e specs on the Telegram fake client for feedback, message, accept and finish.

## Out of scope
- Changing PR approve / request changes or away-mode buttons: they stay as they are.
- Browse lists, move, run and stop: a separate card.
- Editing card text.

## Open questions
None.
