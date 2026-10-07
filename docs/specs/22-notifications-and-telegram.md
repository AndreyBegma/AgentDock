# In-app notifications and Telegram bot

Issue: [#22](https://github.com/AndreyBegma/AgentDock/issues/22) · Roadmap: M2.7 ·
Decisions: [ADR-0005](../adr/0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md),
[ADR-0007](../adr/0007-postgresql-only.md), [security.md](../architecture/security.md),
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
- `APP_ENCRYPTION_KEY` helper (AES-256-GCM), the first secret stored by AgentDock.
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
| D1 | **Kinds** form a closed union in `packages/shared/src/notifications/kinds.ts`. Each kind lists its source and default for the in-app / Telegram channels:<br>• `person.needed` — from `person.needed`; on / on;<br>• `slot.blocked` — from `slot.checkpoint` with `checkpoint=blocked`, or `issue.blocked kind=person`; on / on;<br>• `pane.prompt` — from `pane.prompt`; on / on;<br>• `quota.hit` — from `pane.quota_hit`; on / on;<br>• `queue.dry` — from `round.decided` with no READY row and no running slot, at most once per project per 6 h; on / off;<br>• `pr.awaiting_approval` — from `pr.awaiting_approval`, emitted by #20 / plugin P8 and never fired before they exist; on / on for operator+, on / off for viewers;<br>• `runner.offline` — D5; on / on, admins only;<br>• `budget.exceeded` — reserved, M3.5. | PRD "Notifications"; orchestrator "What to say, and when" [Confirmed]; event-schema.md |
| D2 | **Recipients.** A project kind goes to every member of the project (effective role ≥ viewer, #10), and admins are members of everything. `runner.offline` goes to admins. Disabled and pending users get nothing. | #10 D11; ADR-0008 |
| D3 | **Rules.**<br>• `notification_rules` holds one row per user × kind with `inApp` and `telegram` booleans. A missing row means the D1 default, so nothing is seeded.<br>• `notification_mutes` holds a user × project with an optional `until`. A mute silences every project kind for that user on both channels; in-app items are still recorded but marked `muted` and do not count as unread. | new |
| D4 | **Matcher input** is a cursor over `events` by `id` stored in `notification_matcher_state`, polled every 2 s. It never touches #6's ingest or #11's projector. It is idempotent through a unique `(eventId, userId, kind)` on `notifications`. Project resolution is `(runnerId, projectRepo)` → `projects`, as in #21 D4. | #6 `events` [Confirmed]; same approach as #21 D2, independent tables |
| D5 | **Runner offline.** A watcher checks #6's derived status every 60 s. A runner `stale`/`offline` for more than 5 minutes produces one `runner.offline` notification. A later return to `online` produces a resolving in-app item (no Telegram). There is one open incident per runner at a time. | #6 D5 |
| D6 | **Dedupe and rate limit.** The same `(user, kind, project, slot)` within 15 minutes is folded into the existing notification (`count++`, `lastAt`) instead of a new one. Telegram is capped at 20 messages per user per 10 minutes; beyond that, items queue into a single digest message sent at the end of the window. Telegram API 429 honours `retry_after`. | new |
| D7 | **Long polling, not a webhook.** The first deployment is a home server that may sit behind NAT without a public HTTPS endpoint, and the API is a single instance (ADR-0007). Long polling (`getUpdates`, 30 s timeout) needs only outbound HTTPS. A webhook mode can be added later behind config. Exactly one poller runs, guarded by a Postgres advisory lock. | overview.md deployment; ADR-0007 |
| D8 | **Bot configuration.**<br>• An admin sets the bot token at `/admin/integrations/telegram`. The API verifies it with `getMe` and stores it in `settings` (#3) under `telegram.botToken` as AES-256-GCM ciphertext (`v1:<iv>:<tag>:<ct>`, base64) with `APP_ENCRYPTION_KEY` (32 bytes, base64).<br>• The token is never returned and never logged; the UI shows only the bot username.<br>• A missing key disables the integration with a clear error. | security.md "Secrets at rest" |
| D9 | **Linking.**<br>• A user clicks "Link Telegram" and the API creates a one-time code (10 minutes, single use, stored hashed) and returns `https://t.me/<bot>?start=<code>`.<br>• The bot receives `/start <code>` and binds `chatId` to the user. Only private chats are accepted.<br>• `/stop` in the chat or "Unlink" in the UI removes the binding.<br>• One chat per user. A chat already linked to another user is refused. | new |
| D10 | **Message content** is plain text with an AgentDock link (`APP_URL`). It names the project and slot / issue and gives a one-line reason. It never includes pane text, prompts, code or secrets. It uses Telegram `MarkdownV2` with strict escaping. | security.md |
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
  - linking via `/start <code>` binds the chat;
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

Depends on #9

Depends on #10

Depends on #11

Depends on #8
