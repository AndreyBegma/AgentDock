# In-app notifications and Telegram bot

Issue: [#22](https://github.com/AndreyBegma/Nautelle/issues/22) · Roadmap: M2.7 ·
Decisions: [ADR-0005](../adr/0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md),
[ADR-0007](../adr/0007-postgresql-only.md), [ADR-0046](../adr/0046-the-telegram-bot-acts-on-the-board-through-a-command-router.md), [security.md](../architecture/security.md),
[PRD — notifications](../product/prd.md)

## Summary

The orchestrator runs unattended, and its whole contract is that a person hears
about exactly the things only a person can clear. Those things are a question,
a launch dialog, a quota wall, an empty queue, a PR waiting for approval, and a
runner gone dark. This item delivers them in two places: an in-app notification
centre that is live, and a Telegram bot linked per user. Each user controls
which kinds they get and can mute a project. Delivery is rate-limited and
digested so a bad hour does not become two hundred messages.

## Scope

### In scope

- Notification kinds, per-user rules, per-project mutes, defaults.
- Matcher over runner events plus a runner-status watcher.
- In-app notifications: list, unread count, mark read, live push on `user:<id>`.
- Telegram:
  - admin configures the bot (token encrypted at rest);
  - users link and unlink via a one-time deep link;
  - delivery with retries, rate limit and digest.
- `APP_ENCRYPTION_KEY` helper (AES-256-GCM), the first secret stored by Nautelle.
- Web: bell + panel in the shell top bar, `/account/notifications`, admin `/admin/integrations/telegram`.

### Out of scope

- Telegram inline approve / request-changes buttons. They are optional and conditional on #20 (D12); otherwise a follow-up.
- Budget alerts (M3.5): the kind is reserved, never emitted here.
- Email, Slack and browser push. Outbound webhooks are M3.3.
- Digest scheduling beyond the rate-limit window (daily summaries).

## Decisions

The person delegated all decisions on 2026-10-07. Each row is the default taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | **Kinds** form a closed union in `packages/shared/src/notifications/kinds.ts`. Each kind lists its source and default for the in-app / Telegram channels:<br>• `person.needed` — from `person.needed`; on / on;<br>• `slot.blocked` — from a blocked checkpoint still standing 15 min after it arrived, once per checkpoint (note 23), or `issue.blocked kind=person`; on / on;<br>• `pane.prompt` — from `pane.prompt`; on / on;<br>• `quota.hit` — from `pane.quota_hit`; on / on;<br>• `queue.dry` — from `round.decided` with no READY row and no running slot, at most once per project per 6 h; on / off;<br>• `pr.awaiting_approval` — from `pr.awaiting_approval`, emitted by #20 / plugin P8 and never fired before they exist; on / on for operator+, on / off for viewers;<br>• `runner.offline` — D5; on / on, admins only;<br>• `budget.exceeded` — reserved, M3.5. | PRD "Notifications"; orchestrator "What to say, and when" [Confirmed]; event-schema.md |
| D2 | **Recipients.** A project kind goes to every member of the project (effective role ≥ viewer, #10), and admins are members of everything. `runner.offline` goes to admins. Disabled and pending users get nothing. | #10 D11; ADR-0008 |
| D3 | **Rules.**<br>• `notification_rules` holds one row per user × kind with `inApp` and `telegram` booleans. A missing row means the D1 default, so nothing is seeded.<br>• `notification_mutes` holds a user × project with an optional `until`. A mute silences every project kind for that user on both channels; in-app items are still recorded but marked `muted` and do not count as unread. | new |
| D4 | **Matcher input** is a cursor over `events` by `id` stored in `notification_matcher_state`, polled every 2 s. It never touches #6's ingest or #11's projector. It is idempotent through a unique `(eventId, userId, kind)` on `notifications`. Project resolution is `(runnerId, projectRoot)` → `projects` (unique), with `(runnerId, projectRepo)` only as a fallback when exactly one project of the runner has that repo — amended, see note 3. The cursor is gap-aware — note 2. | #6 `events` [Confirmed]; same approach as #21 D2, independent tables |
| D5 | **Runner offline.** A watcher checks #6's derived status every 60 s. A runner `stale`/`offline` for more than 5 minutes produces one `runner.offline` notification. A later return to `online` produces a resolving in-app item (no Telegram). There is one open incident per runner at a time. | #6 D5 |
| D6 | **Dedupe and rate limit.** The same `(user, kind, project, slot)` within 15 minutes is folded into the existing notification (`count++`, `lastAt`) instead of a new one. Telegram is capped at 20 messages per user per 10 minutes; beyond that, items queue into a single digest message sent at the end of the window. Telegram API 429 honours `retry_after`. | new |
| D7 | **Long polling, not a webhook.** The first deployment is a home server that may sit behind NAT without a public HTTPS endpoint, and the API is a single instance (ADR-0007). Long polling (`getUpdates`, 30 s timeout) needs only outbound HTTPS. A webhook mode can be added later behind config. Exactly one poller runs, guarded by a Postgres advisory lock. | overview.md deployment; ADR-0007 |
| D8 | **Bot configuration.**<br>• An admin sets the bot token at `/admin/integrations/telegram`. The API verifies it with `getMe` and stores it in `settings` (#3) under `telegram.botToken` as AES-256-GCM ciphertext (`v1:<iv>:<tag>:<ct>`, base64) with `APP_ENCRYPTION_KEY` (32 bytes, base64).<br>• The token is never returned and never logged; the UI shows only the bot username.<br>• A missing key disables the integration with a clear error. | security.md "Secrets at rest" |
| D9 | **Linking.**<br>• A user clicks "Link Telegram" and the API creates a one-time code (10 minutes, single use, stored hashed) and returns `https://t.me/<bot>?start=<code>`.<br>• The bot receives `/start <code>` and records the chat as a **pending** link. Only the user's confirmation in the app makes it active (C-147, note 27). Only private chats are accepted.<br>• `/stop` in the chat or "Unlink" in the UI removes the binding.<br>• One chat per user. A chat already linked to another user is refused. | new |
| D10 | **Message content** is plain text with a Nautelle link (`APP_URL`). It names the project and slot / issue and gives a one-line reason. It never includes pane text, prompts, code or secrets. It uses Telegram `MarkdownV2` with strict escaping. | security.md |
| D11 | **In-app** notifications are stored rows. `GET` returns the newest first with unread counts. New rows publish `notification.new` on `user:<id>` (#9's own-id authorizer). Read state is per row, with mark-all. | #9 D11 |
| D12 | **Optional inline actions.** Only if #20 has merged when `i22-telegram` is cut, `pr.awaiting_approval` messages carry Approve / Request changes buttons. A callback re-checks that the linked user is an active operator+ member of the project, calls #20's approval service and writes an audit record (`telegram.approval`, actor the user, `meta.via = "telegram"`). Request changes asks for the note as a reply. Otherwise this is filed as a follow-up issue and the message links to the approvals page. | #20; #8 D5; ADR-0010 spirit (typed actions only) |
| D13 | **Audit.** The following are recorded through #8's `AuditService`, with new actions added to its closed union:<br>• bot configured / cleared;<br>• Telegram linked / unlinked;<br>• rules changed. | #8 D5 |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261024000000_notifications/`. New tables only.

| Table | Fields |
|---|---|
| `notifications` | `id` BigInt autoincrement, `userId` → users (cascade), `kind`, `projectId?` → projects (cascade), `runnerId?` → runners, `slot?`, `issue?` Int, `title`, `body`, `link?`, `eventId?` BigInt, `count` Int default 1, `firstAt`, `lastAt`, `readAt?`, `muted` Bool default false; unique `(eventId, userId, kind)`; index `(userId, readAt, lastAt)` |
| `notification_rules` | `userId` → users, `kind`, `inApp` Bool, `telegram` Bool, `updatedAt`; primary key `(userId, kind)` |
| `notification_mutes` | `userId` → users, `projectId` → projects, `until?`, `createdAt`; primary key `(userId, projectId)` |
| `notification_deliveries` | `id`, `notificationId` → notifications, `channel` (`telegram`), `status` (`pending` \| `sent` \| `digested` \| `failed` \| `skipped`), `attempts` Int, `nextAttemptAt?`, `lastError?`, `digestId?`, `sentAt?`; index `(status, nextAttemptAt)` |
| `telegram_links` | `userId` → users (unique), `chatId` BigInt unique, `username?`, `linkedAt` |
| `telegram_link_codes` | `id`, `userId` → users, `codeHash` unique, `expiresAt`, `usedAt?` |
| `notification_matcher_state` | `id` (single row), `eventsCursor` BigInt, `telegramUpdateOffset` BigInt, `updatedAt` |

`settings` (#3) gets a row `telegram.botToken`, which is data and not schema.

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| GET | `/notifications?unread=&cursor=` | signed-in | own notifications, newest first; `{ items, unreadCount }` |
| POST | `/notifications/:id/read` | owner | marks one read; another user's id → 404 |
| POST | `/notifications/read-all` | signed-in | marks all own read |
| GET / PUT | `/notifications/rules` | signed-in | own rules for every kind (defaults filled in) |
| GET / PUT / DELETE | `/notifications/mutes/:projectId` | project member | own mute for a project |
| GET | `/notifications/telegram/link` | signed-in | own link: `{ linked, username, linkedAt, botConfigured }` — added in implementation, note 15 |
| POST | `/notifications/telegram/link` | signed-in, bot configured | `{ url, expiresAt }` |
| DELETE | `/notifications/telegram/link` | signed-in | unlink |
| GET | `/admin/integrations/telegram` | admin | `{ configured, botUsername?, polling, linkedUsers }` |
| PUT / DELETE | `/admin/integrations/telegram` | admin | set (verified via `getMe`) / clear token |
| POST | `/admin/integrations/telegram/test` | admin | sends a test message to the admin's own linked chat |

## UI

- **Bell in the shell top bar** shows the unread count (`Badge`) and opens a panel (`Popover`) with the latest 20 notifications. Each row has a kind icon, title, project and time, and can be marked read. "See all" links to `/account/notifications`.
- **`/account/notifications`** — tabs for All / Unread. A Rules section shows a table of kinds × channel `Toggle`s, with the Telegram column disabled until linked. A Mutes section lists projects with an until-date. The Telegram card shows link / unlink and the linked username.
- **`/admin/integrations/telegram`** — token field (write-only), status, bot username, linked users count, test button.
- **Nav:** the Admin → Integrations entry flips to `enabled`.

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `APP_ENCRYPTION_KEY` | `apps/api` | 32 random bytes, base64; required for Telegram (D8) |
| `APP_URL` | `apps/api` | public URL used in message links |
| `TELEGRAM_POLL_TIMEOUT_S` | `apps/api` | default 30 |
| `TELEGRAM_API_BASE` | `apps/api` | default `https://api.telegram.org`; tests point it at a mock |

Add each to `apps/api/.env.example`.

## Acceptance criteria

- [ ] A fixture `pane.prompt` event for project A produces one in-app notification for every member of A and none for non-members. Replaying the event produces nothing new.
- [ ] Five `pane.prompt` events for the same slot within 15 minutes produce one notification with `count = 5`.
- [ ] A user who muted project A gets the in-app item marked `muted` (not counted as unread) and no Telegram message.
- [ ] Turning off `quota.hit` for Telegram stops Telegram delivery of that kind while in-app continues.
- [ ] A runner offline for 5 minutes produces exactly one `runner.offline` per admin. Coming back produces a resolving in-app item and no second Telegram message.
- [ ] Against a mock Telegram API:
  - linking via `/start <code>` and the confirmation in the app binds the chat;
  - a reused or expired code is refused;
  - a group chat is refused;
  - `/stop` unlinks.
- [ ] Against the mock: 30 notifications in 10 minutes produce 20 messages plus one digest message. A 429 with `retry_after` is retried after that delay.
- [ ] The bot token is stored as `v1:` ciphertext, decrypts with the configured key, and never appears in any response, log line or audit `after` value. Without `APP_ENCRYPTION_KEY`, configuring the bot returns 409 `encryption_key_missing`.
- [ ] Only one Telegram poller runs when the API is started twice against one database (advisory lock).
- [ ] A new notification updates an open page's bell count within 5 s without reload.
- [ ] **Authorization:** marking another user's notification read returns 404. `GET /notifications` never returns another user's rows. Subscribing to `user:<other id>` is refused (#9). Muting a project the caller is not a member of returns 404. `/admin/integrations/telegram*` returns 403 to operators and viewers.
- [ ] (Only if D12 applies) An Approve button pressed by a linked viewer is refused with an explanatory reply and an audit record `result: denied`. Pressed by an operator member, it approves through #20 and writes an audit record with `meta.via = "telegram"`.
- [ ] `bun run check`, `bun run test` and `bun run build` pass. Telegram is tested only against the mock base URL.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i22-api | schema, migration, kinds, rules, matcher, runner watcher, in-app API, encryption helper | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261024000000_notifications/**, apps/api/src/notifications/**, apps/api/src/common/crypto/**, apps/api/src/app.module.ts, apps/api/.env.example, packages/shared/src/notifications/**, packages/shared/src/index.ts, packages/shared/src/audit/actions.ts | — | yes | opus |
| i22-telegram | bot client, long-poll loop, linking, delivery, digest, optional inline actions | apps/api/src/telegram/** | i22-api | no | opus |
| i22-web | bell, account notifications page, admin Telegram page | apps/web/src/components/shell/**, apps/web/src/app/account/notifications/**, apps/web/src/app/admin/integrations/**, apps/web/src/lib/notifications/** | i22-api | no | sonnet |

`i22-telegram` and `i22-web` run together after `i22-api` merges. This issue may
run in parallel with #21 (distinct tables and modules).

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i22-api | distinct new tables only; keep both blocks on conflict (shared with #21) |
| apps/api/src/app.module.ts | i22-api | append-only registration; keep both imports |
| packages/shared/src/index.ts | i22-api | one export line; keep both |
| packages/shared/src/audit/actions.ts | i22-api | #8's union; appended members only, keep both |
| apps/web/src/components/shell/nav.ts | i22-web (via `shell/**`) | one-line flag flips; keep both (#21 flips its own entries) |
| apps/web/src/components/shell/** other files | i22-web | the top bar gets one bell insertion; #9 has merged before this issue starts |
| bun.lock | regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) | — |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Notification storm from a flapping pane classifier | high | D6 dedupe + rate limit + digest; tests with 30 events |
| Bot token leak | high | D8 encryption, write-only field, redaction test; `opus` on i22-api and i22-telegram |
| Telegram buttons become an approval path that bypasses the UI's checks | high | D12: optional, same service as the UI, role re-check per press, audited |
| `queue.dry` is noisy on quiet projects | low | in-app only by default, at most once per 6 h per project |
| Long-poll loop dies silently | medium | the poller logs a heartbeat; `/admin/integrations/telegram` shows `polling: false` with the last error |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Quiet hours per user? | No — mutes cover it for now |
| Should viewers receive `pr.awaiting_approval` at all, since they cannot act on it? | Yes in-app; Telegram off by default for viewers (D1) |

## Notes from implementation

i22-api, decided with the orchestrator on 2026-10-08:

1. **`runner.online` and `runner_incidents` (D1, D5 amended).** D1's union gains `runner.online`: the resolving in-app item of a `runner.offline` incident, admins only, channels `inApp` only — it is never sent to Telegram and a rule cannot turn it on there. "One open incident per runner" is a row in `runner_incidents` (`resolvedAt` null while open), decided under an advisory lock. The watcher alarms when a paired, unrevoked runner is not `online` and its `lastSeenAt` (heartbeat-updated) is more than 5 minutes old; status is #6's in-memory derivation, so it assumes the single API instance of ADR-0007.
2. **Gap-aware cursor (D4).** `events.id` is a sequence, and two runners' inserts can commit out of id order, so a plain `id > cursor` could skip a row forever. The matcher advances only over a contiguous run of ids and matches in the same transaction that moves the cursor, so each event is matched once. At a hole it waits `holeWaitMs` (10 s) for the missing id, then takes it as a rolled-back insert and moves on — an insert that commits later than that is never notified (the ingest's `createMany` is short, so in practice a hole that old is a rollback). On first start the cursor is placed at the sequence's last value, not `max(id)`, so history is not replayed and pruned ids do not read as a hole.
3. **Project resolution (D4 amended).** `(runnerId, projectRoot)` first — unique on `projects`; `projectRepo` is not unique per runner, so it is used only when exactly one project of the runner has that repo; otherwise the event notifies nobody.
4. **Replays.** Besides the unique `(eventId, userId, kind)`, a notification keeps `lastEventId`, the newest event folded into it. The matcher works in id order, so an event at or below it is a replay and is not folded again — a replay never inflates `count`.
5. **What notifies (D1).** `pane.prompt` / `pane.quota_hit` from the runner (the plugin's `code-sentinel` copies of `session.*`, `pane.*`, `worktree.changed` and `commit.trailer_found` are skipped, as in `FleetProjector`); `person.needed`; `issue.blocked` with `kind = person` → `slot.blocked` (a blocked `slot.checkpoint` notifies from the sweep instead — note 23); `pr.awaiting_approval`; `round.decided` whose `dispatching` and `inFlight` are both empty → `queue.dry`, only when no slot of the project is in a status other than `ended` and the project had no `queue.dry` in 6 h. `events.duplicate` and `events.unparsed` never notify. `person.needed`, `issue.blocked` and `pr.awaiting_approval` have no shared `data` schema; the matcher reads `question` / `why` / `pr` defensively. A blocked checkpoint seen both scraped and from the plugin lands on one checkpoint row and notifies once (note 23).
6. **Content (D10).** Titles and bodies name the slot / issue / PR and give a fixed one-line reason. A `person.needed` question and an `issue.blocked` reason contribute their first line (≤ 200 characters), and so does a blocked checkpoint's heading (note 23); a checkpoint's summary is never copied.
7. **Fold (D6).** The window is 15 minutes from the notification's `firstAt`, over event `ts`. A fold sets `lastAt`, `count + 1`, and makes the row unread again; it creates no second delivery.
8. **Rules × channels.** In-app off with Telegram on still stores the row — already read — because the delivery hangs off it. A rule for a kind the caller cannot receive (`runner.*` for a non-admin, reserved `budget.exceeded`) or for a channel the kind lacks is `400 invalid_rule`.
9. **Mutes.** `GET /notifications/mutes` (the caller's mutes, for the Mutes section) is added to the API table; `GET /notifications/mutes/:projectId` answers `{ projectId, mute: NotificationMuteView | null }`. A `PUT` with an `until` in the past is `400`. A project the caller cannot see is `404 project_not_found` on every mute route.
10. **Live.** `notification.new` carries `{ notification, unreadCount }` for a new row and for a fold. `notification.read` (`{ ids | null, unreadCount }`) keeps other tabs' bells in step after a read or mark-all.
11. **Timers.** The matcher (2 s) and watcher (60 s) start at bootstrap except under `APP_ENV=test`, where the e2e suites call `tick()`; both take a `pg_try_advisory_xact_lock`, so a second API instance skips the pass.
12. **Delivery rows.** One Telegram delivery is written per new notification for a user with a linked chat: `pending`, or `skipped` with `lastError` `muted` / `rule_off`. No link, no row. `unlinked` is set later when the chat was unlinked before sending.
13. **Command registration trap (from #12, recorded for later slots).** `CommandHandlers` in `apps/runner/src/commands/dispatcher.ts` requires a handler for every key of `commands`: a protocol or API slot defines and exports its command schemas but does not add them to the map; the runner slot adds the entry with its handler. This item adds no runner command.
14. **Follow-up — duplicated cursor logic.** #21 (merged first) has the same gap-aware cursor over `events` in `apps/api/src/activity/event-frontier.ts`, and the same root-then-repo project lookup in `apps/api/src/activity/resolve-project.ts`. The notification matcher keeps its own (`NotificationMatcher.holeExpired`, `ProjectCache`) so that this pull request does not refactor across modules. A follow-up should extract one shared frontier and resolver and have both projectors use them. Their state stays separate (`activity_projector_state`, `notification_matcher_state`): each consumer keeps its own cursor.

### What `i22-telegram` builds on

The Telegram slot owns `apps/api/src/telegram/**`: the bot client, long polling (the update offset is `notification_matcher_state.telegramUpdateOffset`), linking via `telegram_links` / `telegram_link_codes`, sending, and the controllers `POST|DELETE /notifications/telegram/link` and `GET|PUT|DELETE /admin/integrations/telegram`, `POST /admin/integrations/telegram/test`. It imports `NotificationsModule` (`apps/api/src/notifications`), which exports:

- **`BotTokenStore`** — `status(): { configured, botUsername, encryptionAvailable }`; `read(): { ok: true, token, botUsername } | { ok: false, reason: 'not_configured' | 'encryption_key_missing' | 'undecryptable' }`; `set(token, botUsername, userId, ctx)` seals with `APP_ENCRYPTION_KEY`, stores under `settings['telegram.botToken']`, audits `telegram.configure` with `{ configured, botUsername }` only, and throws `409 encryption_key_missing` without a key; `clear(ctx)` audits `telegram.clear`. Verify the token with `getMe` before `set`.
- **`SecretCipher`** (via `CryptoModule`, `apps/api/src/common/crypto`) — `available`, `encrypt`, `decrypt` (`v1:<iv>:<tag>:<ct>`); `SecretCipherError` messages are fixed text, safe to log.
- **`TelegramDeliveryLedger`** — `claim(now)` → `{ messages: ClaimedDelivery[], digests: ClaimedDigest[] }` under the 20-per-10-minutes limit; each item carries `chatId` and `DeliveryContent` (`kind, title, body, link, projectName, slot, issue, count`). Report each result: `markSent(id)`, `markFailed(id, error, { retryAfterS?, permanent? })`, `markDigestSent(digestId)`, `markDigestFailed(digestId, error, …)`. A claim leases its rows for `TELEGRAM_CLAIM_LEASE_MS` (60 s); `retryAfterS` is honoured exactly; `TELEGRAM_MAX_ATTEMPTS` (5) then `failed`. Never put the token in an error passed here.
- **`NotificationsService`**, **`NotificationRulesService`** — for the test message and the "Telegram column disabled until linked" rule.
- **Audit actions** in `packages/shared/src/audit/actions.ts`: `telegram.link`, `telegram.unlink`, `telegram.approval` (D12) are declared for this slot.
- **Env** in `.env.example` and turbo `passThroughEnv`: `APP_URL`, `TELEGRAM_POLL_TIMEOUT_S`, `TELEGRAM_API_BASE` (read by this slot), `APP_ENCRYPTION_KEY`.

i22-telegram, decided with the orchestrator on 2026-10-08:

15. **Link status route (API amended).** `GET /notifications/telegram/link` answers the caller's own `TelegramLinkStatus` `{ linked, username, linkedAt, botConfigured }`, always 200. The web needs it for the Telegram card and for "Telegram column disabled until linked". The HTTP types (`TelegramLinkStatus`, `TelegramLinkCode`, `TelegramIntegrationStatus`, `TelegramBotTokenUpdate`) and the error codes `telegram_not_configured` (409), `telegram_not_linked` (409), `telegram_token_invalid` (400) and `telegram_unavailable` (502) are in `packages/shared/src/notifications/contracts.ts`.
16. **One poller (D7).** The leader holds a session-level `pg_try_advisory_lock` on a `pg` connection of its own, not a transaction lock. The lock lives exactly as long as that connection, so a crashed instance frees it, and the 30 s long poll never pins a pooled Prisma connection inside a transaction. A follower retries every 30 s. Only the leader runs the `getUpdates` loop and the 2 s delivery timer. `GET /admin/integrations/telegram` reports `polling` (this instance leads and its loop runs), `lastError` (redacted) and `lastPollAt`. A heartbeat is logged every 60 polls. Nothing starts under `APP_ENV=test`: the suites call `acquire()`, `pollOnce()` and `deliverOnce()`.
17. **Update offset.** It is written to `notification_matcher_state.telegramUpdateOffset` after each handled update, with `updateMany` only: the poller never creates the row, because a row created here would hand the matcher an `eventsCursor`. Until the matcher has created it (the first seconds of a fresh database), the offset lives in memory.
18. **Linking (D9).**
    - A code is 24 random bytes in base64url, and only its SHA-256 is stored. A new code deletes the user's older unused ones.
    - Single use is a conditional `updateMany` (`usedAt` null, not expired) in the same transaction as the bind.
    - A user disabled since the code was made gets the same answer as a bad code.
    - A group chat is refused before the code is touched, so it stays usable.
    - A chat linked to another user is refused. A user who links a second chat moves to it (one chat per user).
    - The bot's replies are fixed text, sent without `parse_mode`. Anything that is not `/start` or `/stop` is ignored.
    - `telegram.link` and `telegram.unlink` are audited with the user as actor and `meta.via` = `telegram` or `app`. The chat id is not stored in the audit.
19. **Delivery (D6, D10).**
    - Messages are MarkdownV2 with every reserved character escaped. A link target escapes only `)` and `\`. The message is built only from the stored title, body, project, slot and issue, plus an `APP_URL` link to the item's app path; links that are not a path are dropped.
    - A 429 is reported with its `retry_after` and ends the pass: the limit is per bot, and the rest of the claim waits out its lease.
    - 400 and 403 (blocked, chat gone) are permanent.
    - A refused token (401/404) ends the pass without touching the rows, so nothing is lost while an admin fixes the bot.
    - Every error text — `lastError`, logs, the admin's 502 — goes through `redactToken`. It removes the token and anything shaped like one, and a network error is reported in fixed words, never with its URL.
20. **Bot replaced (D8 amended).**
    - The settings row `telegram.linksBot` records which bot the links belong to; clearing the token keeps it.
    - A `PUT` whose `getMe` username differs from it does three things in one transaction, after `BotTokenStore.set`: it deletes every `telegram_links` row and every open `telegram_link_codes` row, and zeroes the update offset. It then writes a second audit record, `telegram.unlink` on `setting:telegram.botToken`, with `after: { botUsername, previousBotUsername, unlinkedUsers }` and `meta.reason = 'bot_changed'`, and answers `unlinkedUsers`.
    - The same username (a token rotation) keeps the links.
    - `telegram.configure` itself is written by `BotTokenStore.set` with its fixed `after`. A crash between `set` and the transaction leaves stale links, which fail with 403 until an admin saves again.
21. **D12, built by #82.** #20 had not merged when `i22-telegram` was cut, so the buttons came in the follow-up #82, decided with the orchestrator on 2026-10-12:
    - **Head.** `pr.awaiting_approval` carries no head SHA, so the delivery reads the PR from the notification's newest event and the head through #20's `ApprovalsService.inspect` as the system (its 60 s cache). The message shows `Head <short sha>` and carries Approve / Request changes bound to that head. A PR not open, or a runner that cannot answer, sends the message without buttons — a delivery never waits on, or fails for, them.
    - **Buttons** go to every recipient, viewers included; the press is what is checked. `callback_data` is `a|r:<notification id>:<pr>:<sha, base64url>` (≤ 64 bytes) and is treated as untrusted.
    - **Every press, and every note,** re-checks: the chat's link, that the notification was sent to that user, that the user is active, and `ProjectAccessService` role ≥ operator. It then calls `ApprovalsService` at the head from the button, so a moved head is `head_moved` as in the UI. Each outcome — refusal, #20's refusal, success — is audited as `telegram.approval` (actor the user, `meta.via = "telegram"`, `meta.reason` on a refusal); #20 audits the decision itself as well. A press from an unlinked chat has no actor and is only logged.
    - **Request changes** answers with a force-reply prompt whose last line carries the notification, PR and full head. The reply's `reply_to_message` — authored by the bot, in the same private chat — brings it back, so no state is kept. A reply without text is refused (`note_required`).
    - The keyboard stays on the message after a decision; a second press is refused by #20 (`not_waiting`).
22. **`schedule.disabled` (D1, spec 25 D10), built by #103.** D1's union gains `schedule.disabled`: an automatic schedule disable, on / on.
    - **Source.** The `events` row the API records inside the disable transaction (`type` `schedule.disabled`, `source` `api`, `dedupeKey` `schedule.disabled:<firingId>`). The matcher accepts it only with `source = api`; a runner or plugin row of that type notifies nobody.
    - **Recipients.** A project kind (D2) narrowed to users whose effective role on the project is `admin`; an override only lowers a role (#10), so these are the active global admins. Operators and viewers get nothing. The kind carries `adminsOnly` in `NOTIFICATION_KIND_SPECS`.
    - **Once per disable.** One event row per disable gives one notification per recipient. The kind is not folded (D6): a schedule that is re-enabled and disabled again by a later firing is a new item, even within 15 minutes. A replayed event adds nothing (`(eventId, userId, kind)` is unique).
    - **Link** opens the project's schedules page; the text names the schedule and the reason, nothing else.
23. **Blocked checkpoints: once, delayed, with the heading (D1, notes 5–6 amended), built by #216.** On staging 32 blocked checkpoints became 22 notifications and almost none needed a person: a runner restart re-emitted whole reply files, and most "blocked" checkpoints were questions the orchestrator answered within minutes.
    - **Once per checkpoint.** A blocked checkpoint notifies at most once per `(slot, position)` — the `slot_checkpoints` row. The matcher no longer drafts from `slot.checkpoint` events. A runner restart re-emitting the reply file, a plugin copy of the same checkpoint, or a body edited under the same heading lands on the same row and never notifies again; the runner keeps no durable sent-state and does not need to, since the API decides. Only a new heading at that position (the reply file started over) is a new checkpoint.
    - **Delayed.** The blocked-checkpoint sweep runs every minute beside the runner watcher, single-flight under its own advisory lock. A blocked checkpoint notifies only if it is still its slot's latest 15 min after it arrived (`BLOCKED_CHECKPOINT_DELAY_MS`; its `at`, or when the sweep first saw a new heading at that position) and the slot is not `ended`. If the orchestrator answers and the worker moves on, nothing is sent. `issue.blocked` with `kind = person` stays immediate, from the matcher.
    - **State.** `blocked_checkpoint_notices`, one row per blocked checkpoint the sweep has looked at: the heading it is about, `since`, `notifiedAt`. Rows are cascaded with the checkpoint. The migration backfills every blocked checkpoint that existed before as already notified, so the first sweep fires nothing old.
    - **Content (D10).** The body is the heading's first line (≤ 200 characters); a heading that is just "blocked" keeps "The worker reported a blocked checkpoint." The summary is still never copied. The item is not folded (D6) — the notice already makes it one per checkpoint.

24. **The bot acts on the Board (ADR-0046), built by #500.** This widens the scope above: the bot is no longer only a notification channel. Board commands from stack S-1 (`/new`, `/board`, card actions) are in scope, each delivered by its own card. D7 (long polling), D10 (no pane text, prompts, code or secrets in messages) and D12 (typed actions through the web app's services, a role re-check per press, an audit row) still hold for every one of them.
    - **Router.** `TelegramRouter` routes commands (`/cmd args`, `/cmd@Bot args`), `callback_data` prefixes and replies to the bot's prompts. The `/start`, `/stop`, D12, spec 201 D18 and #489 handlers moved onto it unchanged. An unknown command in a private chat gets a pointer to `/help`; other text is still ignored.
    - **Callback data.** New buttons use `callbackCodec`, which refuses at definition a payload that could pass 64 bytes and decodes malformed data to null. `a`, `r`, `x`, `y` and `q` stay reserved for the existing buttons.
    - **Current project.** `telegram_links.currentProjectId` is set by `/project` (buttons, one per project the linked user is an active member of, with their role), by `/project <name>`, or automatically for a user with one project. Every choice is audited as `telegram.project`. Board replies name their project first. Buttons carry their own project and never read the current one.
    - **Guard.** `TelegramGuard` checks the linked user, that the user is active, membership (spec 10 D11) and role: a read needs any active member, a write needs operator or higher. D12's buttons, spec 201's buttons and #489's buttons and replies use it.
    - **Menu.** `/help` and `setMyCommands` (private chats) come from one list, `BOT_COMMANDS`. The menu is set when the bot is configured, and once more by the poller for a bot it has not set it for.
25. **`/new` runs the New work intake (#337, #409, #480), built by #574.** `/new <text>`, or `/new` and then the description as the next message, creates a `card` plan for the chat's current project through `PlanService` — in process, as the linked user, after `TelegramGuard` checked operator or higher. The plan is the author's private draft, so the web Board's drafts strip shows it, and the web and the chat move the same plan.
    - **State.** `telegram_intakes`, one row per link: the plan, the last phase the chat showed (`shown`), the thinking message, the message with the buttons, the open round's question messages and the answers picked on them. The row goes when the cards exist or the intake is discarded.
    - **Rounds.** Each question is its own message — title, question, the recommendation with its why — with one button per option (★ marks the recommended one); a multiple-choice question toggles options (✓) and has Done. A reply to a question message is its own answer. The round's last message has Send answers, Enough — generate and Discard; Send answers fills an unanswered question with its recommendation, as the web does. A press is taken only from the message that is the intake's current one.
    - **Turn ends.** `PlanStore.watch` hands the bot every plan live event of its process; the bot reads the plan again and, when its phase is new, claims it in `shown` and edits the single "Thinking…" message into the round header, the proposal, the cards or the failure. Nothing polls.
    - **Results.** One card: its label, title and kind, linked to `/projects/<id>/board?card=<n>`. A split or stack: the cards with their summaries (by stage for a stack), Create all (the split / stack confirm), Keep one card, Discard, and an Open in app link to the intake. A failed turn: Retry and Cancel (Cancel discards the plan).
    - **D10.** Only the questions, their options and recommendations, and the cards' titles, kinds and summaries are sent — never the brief, the prompt, a turn's error or output, a split's reason or a stack's body.
26. **A Mini App opens the Board inside Telegram (ADR-0055), built by #580.** The web app's `/tg` page loads Telegram's Web App script and signs in with `POST /auth/telegram`, which checks the `initData` HMAC and its `auth_date` (`TELEGRAM_INIT_DATA_MAX_AGE_S`, default 1 hour), maps the Telegram user to the linked chat (D9) and issues the ordinary web session. An unlinked or inactive account gets 403 `telegram_not_linked`, and the page explains how to link. The page then opens the target the bot passed (`start_param`, or `?start=` from a Web App button, both `<projectId>` or `<projectId>_<card>`), else the chat's current project (#500), else home. The Board, the card sheet and the stack page are the web's own phone layout, so every role check is the web's; Telegram's light or dark theme becomes the app's theme.
    - **Bot.** With an `https` `APP_URL`, the menu button of private chats opens `/tg` (`setChatMenuButton`, set with the command menu), and a message whose link is a card (`/projects/<id>/board?card=<n>`) gets an "Open in app" Web App button below its own buttons, as do the cards `/new` makes. With any other `APP_URL`, the menu button stays Telegram's default and messages keep only their plain links.
27. **A link waits for the app's confirmation (D9 amended, D-16), built by C-147.** Before, the first chat to redeem a code was linked at once, so anyone who saw the code first could take the user's notifications and press their buttons (L-18).
    - **Pending.** `/start <code>` claims the code as before, then stores a `telegram_pending_links` row — one per user, with the chat id, the `@username` and the code's `expiresAt` — and replies that the chat must be confirmed in the app. A new `/start` replaces the row with a new id. A chat that already is the user's link is told it is linked; a chat linked to another user is refused as before.
    - **Nothing reaches it.** `telegram_links` is untouched until the confirmation, so the writer queues no Telegram delivery, the ledger sends nothing, and every press or reply from the chat is refused as `not_linked`.
    - **Telling the user.** The redeemed code writes an in-app `telegram.link_pending` notification (an `account` kind: only that user, in-app only) linking to `/account/notifications#telegram`. `GET /notifications/telegram/link` reports it as `pending` `{ id, username, createdAt, expiresAt }`.
    - **Confirm.** `POST /notifications/telegram/link/confirm { id }` claims the row with a conditional delete and links the chat, replacing an older one. An expired, replaced or declined request is 404 `telegram_link_request_not_found`; a chat another user linked meanwhile is 409 `telegram_chat_taken`. The chat is then told it is linked. `DELETE /notifications/telegram/link/pending` turns the chat away; `/stop` in the waiting chat withdraws it.
    - **Expiry.** Reads and the confirmation ignore a row past `expiresAt`; a job removes such rows every minute. A bot change drops pending rows with the links.
    - **Audit.** `telegram.link_request` (`meta.via = telegram`) at `/start`, `telegram.link` with `meta = { via: 'app', confirmed: true }` and `after.replacedChat` at the confirmation, `telegram.link_decline` (`meta.via = app`) when turned away. The chat id is still never stored in the audit.

Depends on #9

Depends on #10

Depends on #11

Depends on #8
