# C-213: Add a Telegram Mini App that opens the Board inside Telegram

Issue: #580

## What to do
Add a Telegram Mini App (Web App) so the full Board can be used inside Telegram, mainly for what the chat does badly: editing card text, deleting / archiving, dependencies and stacks.

- **API sign-in.** Add an endpoint that takes Telegram `initData`.
  - It validates the HMAC with the bot token, per Telegram's Web App rules, and checks `auth_date` freshness.
  - It maps the Telegram user to the linked Nautelle user (a private chat id is the user id).
  - It issues the normal web session, the same cookie the web app uses (`apps/api/src/auth/`).
  - An unlinked Telegram user is refused with a hint to link in Account → Notifications.
  - Add any new variable to `.env.example`.
- **Web.** Add an entry route in `apps/web` for the Mini App.
  - It loads `telegram-web-app.js` and performs the sign-in.
  - It then opens the Board of the project the bot passed in `start_param`, or the last-used project.
- **Mobile layout.** Make the Board, the card detail and the card edit / dependencies / stack views usable at Telegram's viewport width.
  - Use only glass-ui components (ADR-0011); a missing component is added to glass-ui.
  - Respect Telegram's theme (light / dark) through glass-ui tokens.
- **Bot.**
  - Set the chat menu button to the Mini App.
  - Add an "Open in app" Web App button on card messages, deep-linking to that card.
  - Mini Apps need an HTTPS `APP_URL`. When it is not HTTPS, the bot falls back to a plain link.

## Acceptance criteria
- [ ] Opening the Mini App from the bot's menu button signs a linked user in without a password and shows the Board.
- [ ] Tampered or expired `initData` is refused. The HMAC check has unit tests.
- [ ] An unlinked Telegram user sees a clear "link your account first" screen.
- [ ] "Open in app" on a card message opens that card.
- [ ] At a 375px-wide viewport, a user can edit a card's title and body, delete / archive a card, add and remove a dependency, and view and edit a stack.
- [ ] Role checks are the web's own: a viewer cannot edit in the Mini App.
- [ ] No new non-glass-ui component exists in `apps/web`.
- [ ] With a non-HTTPS `APP_URL`, the bot sends plain links and does not crash.

## Out of scope
- New Board features that do not exist on the web.
- Chat-side commands: the other cards cover them.
- A native mobile app.

## Open questions
None.
