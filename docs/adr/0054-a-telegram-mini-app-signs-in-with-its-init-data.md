# ADR-0054: A Telegram Mini App signs in with its `initData`

Status: accepted · Date: 2026-10-17 ·
Card: C-213 (stack S-1) ·
Spec: [`docs/specs/580-add-a-telegram-mini-app-that-opens-the-b.md`](../specs/580-add-a-telegram-mini-app-that-opens-the-b.md) ·
Widens: spec 3 (a second way to get the web session), spec 22 D9

## Context

Spec 3 has one way to sign in: an email and a password, which issue the `ad_session` cookie. Stack S-1 puts the Board inside Telegram as a Mini App (a Web App), so a person can edit card text, delete cards and change dependencies and stacks from the chat. Asking for a password inside Telegram would make the Mini App much less useful, and Telegram already proves who opened it: a Mini App receives `initData`, signed by Telegram with the bot's token. Spec 22 D9 binds a private chat, whose id is the Telegram user's id, to exactly one AgentDock account.

## Decision

1. **`POST /auth/telegram` takes `initData` and issues the ordinary web session**: the same `ad_session` and `ad_csrf` cookies as a password sign-in, with the same lifetime and the same `auth.login` audit record (with `meta.via: "telegram"`). From then on, every route, role check and CSRF check is the web's own. The Mini App has no API or permissions of its own.
2. **The credential is the HMAC.** The route checks the hash the way Telegram's Web App rules require: `HMAC_SHA256(HMAC_SHA256("WebAppData", bot token), data-check-string)`, compared in constant time. It refuses `initData` that has a field twice, that has no user, or whose `auth_date` is more than 60 s in the future, with 401 `telegram_init_data_invalid`. It refuses data older than `TELEGRAM_INIT_DATA_MAX_AGE_S` (default 1 hour) with 401 `telegram_init_data_expired`. The bot token is the stored one (spec 22 D8); without it, the route answers 409 `telegram_not_configured`.
3. **Only a linked account signs in.** The Telegram user id is looked up as `telegram_links.chatId`. When no link exists, or the linked user is not active, the route answers 403 `telegram_not_linked` with a hint to link in Account → Notifications. It says nothing about which of the two is the case.
4. **Refusals are throttled and folded like password refusals.** The route has the per-IP request limit of login (10 a minute), and a refused sign-in is a folded, denied `auth.login` (ADR-0048 §6) whose reason is `telegram_invalid` or `telegram_not_linked`.
5. **Mini App buttons only over HTTPS.** Telegram opens a Mini App only from an `https` URL. With an `https` `APP_URL`, the bot's menu button opens `/tg`, and card messages get an "Open in app" Web App button to `/tg?start=<project>_<card>`. With any other `APP_URL`, the menu button stays Telegram's default and messages keep only their plain links.

## Consequences

- Anyone who holds a fresh `initData` of a linked user can sign in as that user until it expires. That is Telegram's own trust model: the string reaches only the Mini App's page, over TLS. Unlinking the chat (`/stop`, or Account → Notifications) ends that path at once. Sessions already issued stay until they are signed out or revoked, as password sessions do.
- `/tg` is a public page and loads `https://telegram.org/js/telegram-web-app.js`. The CSP allows that origin on `/tg` only.
- Telegram's web client (web.telegram.org) shows a Mini App in a third-party iframe. The app keeps `frame-ancestors 'none'`, and its `SameSite=Lax` cookies would not be sent there, so the Mini App works in the mobile and desktop apps only.
