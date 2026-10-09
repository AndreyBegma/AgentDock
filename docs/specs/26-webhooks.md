# Webhooks — inbound triggers and outbound deliveries

Issue: [#26](https://github.com/AndreyBegma/AgentDock/issues/26) · Roadmap: M3.3 ·
Decisions: [ADR-0007](../adr/0007-postgresql-only.md),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md),
[security.md](../architecture/security.md), [data-model.md](../architecture/data-model.md),
[event-schema.md](../architecture/event-schema.md)

## Summary

PRD feature area *Webhooks*, both directions. **Inbound triggers** let an
outside system start work: a signed `POST /hooks/<id>` runs a skill or
`orchestrator next` on one project — a CI failure starts `cs-debug`, a deploy
starts `cs-ux-test`. **Outbound webhooks** push AgentDock's own events to a URL
the admin chooses (n8n, Slack, a custom bot): signed, retried with backoff, held
by a circuit breaker when the target is down, with a delivery log, redeliver and
test. Both are admin-managed, audited, and built on PostgreSQL tables with
`SKIP LOCKED` (ADR-0007). Nothing a webhook carries ever reaches a shell
(ADR-0010).

## Scope

### In scope

- Inbound: `inbound_triggers`, `inbound_deliveries`; the public endpoint; HMAC + timestamp verification, replay window, nonce store; payload → argument templating with an allowlist; firing `skill.run` (#24) or `orchestrator.start` (#17).
- Outbound: `webhooks`, `webhook_deliveries`; event selection by type and project; dispatcher over `events`; delivery worker with retries, jitter, circuit breaker; SSRF guard; delivery log, redeliver, test.
- Raw request body capture for signature verification (shared with #27).
- Admin endpoints, audit, live updates on the `admin` topic.
- Web `/admin/integrations/webhooks` and `/admin/integrations/triggers`.

### Out of scope

- GitHub App events — #27. It reuses this item's raw-body capture, not its signature scheme.
- Telegram — #22 (its own channel).
- Per-project management by operators. Admin only in this item (D16).
- Outbound payload templating (custom JSON shapes per target). The payload is AgentDock's fixed envelope.
- Inbound triggers that run arbitrary runner commands. Only the two targets of D3.

## Decisions

The person delegated all decisions on 2026-10-07. Each row is the default taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | **Inbound URL** is `POST /hooks/<triggerId>` where `triggerId` is a 24-character random id (not the database cuid). Unknown or disabled triggers answer 404 with an empty body, so the endpoint does not reveal which ids exist. The route is `@Public()` (#3) and exempt from CSRF; it accepts `application/json` only, at most 256 KB. | security.md; #3 D7 |
| D2 | **Inbound signature.** Headers `X-AgentDock-Timestamp: <unix seconds>`, `X-AgentDock-Delivery: <unique id, ≤ 64 chars>`, `X-AgentDock-Signature: sha256=<hex>` where the hex is `HMAC-SHA256(secret, "<timestamp>.<delivery>.<raw body>")`. Compared with `timingSafeEqual`. Timestamp outside ±5 minutes → 401. Delivery id already seen for this trigger → 409 `replayed` (nonce store = unique `(triggerId, deliveryId)` in `inbound_deliveries`, kept 24 hours). Any signature failure → 401 with no detail. | security.md |
| D3 | **Inbound actions** are a closed union, stored as Json and validated with the protocol schemas (`inboundTriggerActionSchema` in `packages/shared/src/webhooks/actions.ts`):<br>• `{ kind: "skill", skill, args, profileKey?, model?, output: "report" \| "pr" }` → `skill.run` (#24) through `SkillRunService.start`; `profileKey` absent = the project's default profile, `model` absent = `ORCHESTRATOR_DEFAULTS.model`;<br>• `{ kind: "orchestrator", mode: "next" }` → `orchestrator.start` with `mode: next` (#17).<br>`orchestrator stop` and `slot.*` cannot be triggered from outside. | ADR-0010; #17; #24 |
| D4 | **Argument templating.** A skill action's `args` may contain placeholders `{{payload.<dotted.path>}}` and nothing else — no expressions, filters, defaults or code. Each referenced path must appear in the trigger's `allowedPaths` list. At fire time each value must be a string, number or boolean; it is stringified, must be ≤ 500 characters and must match the trigger's `valuePattern` (default `^[\w .,:/#@+-]*$`). A missing path, a disallowed path, an object, or a pattern mismatch → 422 `invalid_payload`, nothing fires. The rendered args are passed to `skill.run` as data; the runner never interpolates them into a shell (ADR-0010). | ADR-0010; security.md |
| D5 | **Authority.** A trigger fires as actor `webhook:<triggerId>` on behalf of its creator, re-checked at fire time like #25 D10: creator no longer an active admin → the request is accepted (202) but the firing is `failed` with `creator_not_authorized` and the trigger is disabled. | #25 D10; ADR-0008 |
| D6 | **Inbound limits.** 30 accepted deliveries per trigger per hour (token bucket in the database row) → 429 beyond. One live run per trigger: a delivery while the previous run is still `running` is recorded as `skipped` with `previous_still_running` and answers 202. The pre-fire hook `beforeFire()` from #25 D12 is called the same way, so #28's budgets apply to triggers too. | #25 D7, D12 |
| D7 | **Inbound response.** 202 `{ deliveryId, status }` once the delivery is verified and recorded; the runner command is sent after the response (the caller never waits for an agent). The delivery links to the `runs` row created by the command (`runs.triggeredByType = webhook`, `triggeredById = triggerId`, #21). | #21 D7 |
| D8 | **Raw body capture.** `rawBodyMiddleware` (`apps/api/src/webhooks/common/raw-body.ts`), registered in `configureApp` so the API and the e2e app behave alike, reads `POST` `application/json` bodies on the paths in `RAW_BODY_ROUTES` (`/hooks`) as bytes into `req.rawBody`, up to 256 KB (413 beyond; a compressed body → 415), and consumes the stream so Nest's parsers skip it. The body is **not** parsed: the hook controller verifies the signature over `req.rawBody`, then calls `parseRawJson`. Every other route keeps Nest's parsers unchanged. #27 appends its route to `RAW_BODY_ROUTES`. | Notes |
| D9 | **Outbound event catalogue** is a closed list in `packages/shared/src/webhooks/events.ts`: `orchestrator.started`, `orchestrator.stopped`, `slot.dispatched`, `slot.checkpoint`, `slot.stopped`, `pr.opened`, `pr.checks_changed`, `pr.merged`, `pr.closed`, `issue.blocked`, `person.needed`, `pane.prompt`, `pane.quota_hit`, `schedule.failed`, `schedule.disabled`, `webhook.test`. `llm.request`, `tool.call` and `pane` text are never sent. | event-schema.md; #21 D3 |
| D10 | **Outbound payload** is a fixed envelope: `{ id, type, ts, project: { id, repo } \| null, slot?, issue?, data }`. `data` is built per type from an allowlist of keys (e.g. `slot.checkpoint` → `checkpoint`, `summary` truncated to 1000 chars, `pr?`), never the raw event `data`. | security.md |
| D11 | **Outbound dispatcher.** A cursor over `events` by `id`, stored in `webhook_dispatcher_state`, polled every 2 s; for each event in the catalogue it inserts one `webhook_deliveries` row per matching enabled webhook (event type ∈ `webhook.events`, project ∈ `webhook.projectIds` or `projectIds` empty = all). Idempotent through unique `(webhookId, eventId)`. It never edits #6's ingest. | #22 D4 (same cursor pattern) |
| D12 | **Delivery worker.** Every 5 s it claims up to 20 due deliveries (`status = pending AND nextAttemptAt <= now() … FOR UPDATE SKIP LOCKED`). POST with a 10 s timeout, redirects **not** followed, response body stored up to 2 KB. 2xx → `succeeded`. Otherwise retry at 30 s × 2^(attempt−1) with ±20 % jitter, at most 8 attempts (about two hours), then `failed`. Leader by advisory lock as #25 D5, so one worker runs. | ADR-0007; Mission Control webhook delivery (inspiration) |
| D13 | **Outbound signature.** Headers `X-AgentDock-Event`, `X-AgentDock-Delivery` (the delivery id), `X-AgentDock-Signature: t=<unix>,v1=<hex>` where hex = `HMAC-SHA256(secret, "<t>.<body>")`. The receiving side can verify with the same recipe as D2; the docs page shows a code sample. | security.md |
| D14 | **Circuit breaker.** 10 consecutive failed attempts on one webhook open its circuit for 15 minutes: deliveries stay `pending` and are not attempted. After 15 minutes one delivery is tried (half-open); success closes the circuit, failure reopens it for 15 more minutes. An admin can close it by hand. The state is shown on the webhook. | Mission Control (inspiration) |
| D15 | **SSRF guard.** Outbound URLs must be `https://` unless the host is on the admin allowlist. The host is resolved at **send time**, and every resolved address is checked; any address in loopback, link-local (incl. `169.254.169.254`), private (`10/8`, `172.16/12`, `192.168/16`), CGNAT `100.64/10` (Tailscale), ULA `fc00::/7`, or unspecified ranges is refused (`blocked_address`) unless that host or CIDR is in the `webhooks.allowedPrivateTargets` setting. The first deployment is a home server, so an admin can allow e.g. a local n8n by name. The connection is made to the checked address (no second lookup). | security.md; first deployment on a home network (PRD Constraints) |
| D16 | **Who manages.** Admin only: create, edit, delete, rotate secret, test, redeliver, close circuit — for both triggers and webhooks. Viewers and operators see neither. Project scoping is a field of each webhook/trigger, not a permission boundary. | ADR-0008 |
| D17 | **Secrets.** 32 random bytes, base64url, shown once on create and on rotate. Stored as AES-256-GCM ciphertext via #22's helper in `apps/api/src/common/crypto/**`. Rotation keeps the previous secret valid for 24 hours for inbound verification (both are tried) and switches outbound signing immediately. Without `APP_ENCRYPTION_KEY` creation returns 409 `encryption_key_missing` (#22). | #22 D8; security.md |
| D18 | **Retention.** `webhook_deliveries` and `inbound_deliveries` older than 30 days are deleted daily (registered with `@nestjs/schedule`, so #25's system job list shows it). | #25 D13 |
| D19 | **Audit.** New actions in #8's union: `webhook.create`, `webhook.update`, `webhook.delete`, `webhook.rotate_secret`, `webhook.test`, `webhook.redeliver`, `webhook.circuit_close`, `trigger.create`, `trigger.update`, `trigger.delete`, `trigger.rotate_secret`, and `settings.webhooks` (a change of `allowedPrivateTargets`, written by `WebhookSettingsService`). Individual deliveries are not audited (they have their own log). A trigger auto-disabled by D5 is audited with actor `system`. | #8 D5 |
| D20 | **Live.** Delivery and trigger status changes publish `webhook_delivery.updated` / `inbound_delivery.created` on the `admin` topic (#9). | #9 D11 |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261101000000_webhooks/`. New tables only.

| Table | Fields |
|---|---|
| `inbound_triggers` | `id` cuid, `publicId` unique (D1), `name`, `projectId` → projects (cascade delete), `action` Json (D3), `allowedPaths` String[], `valuePattern?`, `secret` (ciphertext), `previousSecret?` (ciphertext), `previousSecretUntil?`, `enabled` Bool, `disabledReason?`, `bucketTokens` Int, `bucketRefilledAt`, `createdById` → users, `createdAt`, `updatedAt` |
| `inbound_deliveries` | `id` BigInt autoincrement, `triggerId` → inbound_triggers (cascade delete), `deliveryId`, `receivedAt`, `status` (`accepted` \| `skipped` \| `rejected` \| `started` \| `failed`), `reason?`, `renderedArgs?` Json, `runId?` → runs, `commandRunId?`, `sourceIp?`; unique `(triggerId, deliveryId)`; index `(triggerId, receivedAt)` |
| `webhooks` | `id` cuid, `name`, `url`, `events` String[], `projectIds` String[], `secret` (ciphertext), `enabled` Bool, `circuitState` (`closed` \| `open` \| `half_open`), `circuitOpenedAt?`, `consecutiveFailures` Int, `createdById` → users, `createdAt`, `updatedAt` |
| `webhook_deliveries` | `id` cuid, `webhookId` → webhooks (cascade delete), `eventId?` BigInt → events, `eventType`, `payload` Json, `status` (`pending` \| `succeeded` \| `failed`), `attempts` Int, `nextAttemptAt`, `lastAttemptAt?`, `responseCode?`, `responseBody?` (≤ 2 KB), `error?`, `createdAt`; unique `(webhookId, eventId)`; index `(status, nextAttemptAt)`, `(webhookId, createdAt)` |
| `webhook_dispatcher_state` | `id` (single row `"webhooks"`), `eventsCursor` BigInt, `updatedAt` |

`webhooks.allowedPrivateTargets` lives in `settings` (#3) as a list of hosts and
CIDRs.

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| POST | `/hooks/:publicId` | public, signed | D1–D7 → 202 `{ deliveryId, status }`; 401, 404, 409, 413, 422, 429 |
| GET / POST | `/admin/triggers` | admin | list / create `{ name, projectId, action, allowedPaths, valuePattern? }` → includes secret once |
| GET / PATCH / DELETE | `/admin/triggers/:id` | admin | detail with last 100 deliveries / update / delete |
| POST | `/admin/triggers/:id/rotate-secret` | admin | D17 |
| POST | `/admin/triggers/:id/dry-run` | admin | `{ payload }` → rendered args or the D4 error, nothing fires |
| GET / POST | `/admin/webhooks` | admin | list / create `{ name, url, events, projectIds }` → secret once; 422 `blocked_address`, `https_required` |
| GET / PATCH / DELETE | `/admin/webhooks/:id` | admin | detail / update / delete |
| GET | `/admin/webhooks/:id/deliveries?status=&cursor=` | admin | delivery log |
| POST | `/admin/webhooks/:id/deliveries/:deliveryId/redeliver` | admin | new attempt now (same payload, new signature timestamp) |
| POST | `/admin/webhooks/:id/test` | admin | enqueue a `webhook.test` delivery |
| POST | `/admin/webhooks/:id/close-circuit` | admin | D14 |
| POST | `/admin/webhooks/:id/rotate-secret` | admin | D17 |
| GET / PUT | `/admin/settings/webhooks` | admin | `allowedPrivateTargets` |

## UI

- **`/admin/integrations/triggers`** — list (name, project, action summary, enabled, last delivery status). Create dialog: project, action kind, skill fields, args with `{{payload.…}}` placeholders, allowed paths, value pattern. After create: the URL, the secret (copy, shown once) and a `curl` example that signs a request. Detail sheet: deliveries log, dry-run box (paste a payload, see rendered args).
- **`/admin/integrations/webhooks`** — list (name, URL host, events count, circuit state `Badge`, last delivery). Create dialog: URL, events (multi-select from D9), projects (multi-select, empty = all). Detail: delivery log with status, code, attempts, next attempt; actions Test, Redeliver, Close circuit, Rotate secret; signature verification sample.
- Private-target allowlist editor on the webhooks page (admin settings section).
- Nav: admin section gains *Webhooks* and *Triggers* (one line each in `nav.ts`).

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `APP_ENCRYPTION_KEY` | `apps/api` (exists from #22) | required to store secrets |
| `WEBHOOKS_WORKER_ENABLED` | `apps/api` | `false` disables dispatcher and delivery worker on this instance; default `true` |

## Acceptance criteria

- [ ] A correctly signed delivery to an enabled trigger returns 202 and sends exactly one `skill.run` with the rendered args; the resulting run shows `triggeredByType: webhook` in history (#21).
- [ ] **Signature:** a wrong signature, a body changed by one byte, a missing header, or a timestamp 6 minutes old each return 401 and fire nothing; the same delivery id twice returns 409 `replayed` the second time.
- [ ] An unknown `publicId` and a disabled trigger both return 404 with an empty body.
- [ ] A payload whose referenced path is not in `allowedPaths`, is an object, exceeds 500 characters, or contains a backtick or `$(` (fails the default pattern) returns 422 and fires nothing; the dry-run endpoint returns the same verdict.
- [ ] The rendered args reach the runner as a JSON value; a fake runner asserts no shell was spawned with them (ADR-0010).
- [ ] The 31st accepted delivery in one hour returns 429; a delivery while the previous run is `running` is recorded `skipped`.
- [ ] A trigger whose creator is no longer an active admin records `failed` / `creator_not_authorized` and is disabled, audited with actor `system`.
- [ ] **Signature (outbound):** a test receiver verifies `X-AgentDock-Signature` with the documented recipe for a `webhook.test` delivery; after rotation, the new secret verifies and the old one does not.
- [ ] A receiver answering 500 gets attempts at ~30 s, ~60 s, ~120 s… (±20 %), and after 8 failures the delivery is `failed`; 10 consecutive failures open the circuit, deliveries stay `pending`, and a success after 15 minutes closes it.
- [ ] One event matching two webhooks creates two deliveries; replaying the dispatcher creates no duplicates.
- [ ] `llm.request`, `tool.call` and pane text never produce a delivery; a `slot.checkpoint` payload contains only the allowlisted keys.
- [ ] **SSRF:** URLs resolving to `127.0.0.1`, `10.0.0.5`, `169.254.169.254`, `100.100.1.1` and `[::1]` are refused with `blocked_address` (at create and at send time, including a DNS name that changes to a private address after create); after an admin adds `n8n.lan` to the allowlist, `http://n8n.lan/hook` is delivered; a 302 response is recorded as a failure, not followed.
- [ ] Secrets are stored as ciphertext and never appear in any list/detail response after creation, in logs, or in audit `after` values.
- [ ] Every admin action of D19 writes an audit record.
- [ ] **Authorization:** operators and viewers get 403 on every `/admin/triggers*`, `/admin/webhooks*` and `/admin/settings/webhooks` route; anonymous gets 401 on them; only `/hooks/:publicId` is public.
- [ ] `bun run check`, `bun run test`, `bun run build` pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i26-core | tables, shared types and catalogue, signature helpers, SSRF guard, raw body, audit actions, module skeleton | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261101000000_webhooks/**, apps/api/src/webhooks/common/**, apps/api/src/configure-app.ts, apps/api/src/app.module.ts, packages/shared/src/webhooks/**, packages/shared/src/index.ts, packages/shared/src/audit/actions.ts | — | yes | opus |
| i26-inbound | `/hooks/:publicId`, templating, firing, triggers admin API | apps/api/src/webhooks/inbound/** | i26-core | no | opus |
| i26-outbound | dispatcher, delivery worker, circuit breaker, webhooks admin API, retention job | apps/api/src/webhooks/outbound/** | i26-core | no | opus |
| i26-web | triggers and webhooks admin pages | apps/web/src/app/admin/integrations/triggers/**, apps/web/src/app/admin/integrations/webhooks/**, apps/web/src/lib/webhooks/**, apps/web/src/components/shell/nav.ts | i26-inbound, i26-outbound | no | sonnet |

i26-inbound and i26-outbound run in parallel after the core lead merges. No
runner change: `skill.run` and `orchestrator.start` exist.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i26-core | distinct new tables only; keep both blocks on conflict (#25, #27, #28 run nearby) |
| apps/api/src/configure-app.ts | i26-core | one line registering `rawBodyMiddleware` (D8); `main.ts` is not edited. #27's `/hooks/github` is under `/hooks`, so it is captured raw (and left unparsed) with no further change |
| apps/api/src/app.module.ts | i26-core | append-only registration; keep both imports |
| packages/shared/src/index.ts | i26-core | one export line; keep both |
| packages/shared/src/audit/actions.ts | i26-core | #8's closed union; appended members only, keep both |
| apps/api/src/common/crypto/** | #22 | used, never edited |
| apps/web/src/app/admin/integrations/** | #22 created the folder (Telegram) | this item adds sibling folders only; never edits #22's pages |
| apps/web/src/components/shell/nav.ts | i26-web | one line per entry; keep both |
| protocol commands.ts, commands/<area>.ts, protocol index.ts, runner command handler registry | — | not touched by this item |
| bun.lock | regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) | — |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| A leaked trigger secret lets anyone start agent runs | high | per-trigger secret, rotation, rate limit, one live run, budgets hook, admin-only creation, audit |
| Payload text reaches a prompt as instructions (prompt injection through args) | medium | allowlisted paths, short values, strict default pattern; the skill receives args as data; documented in the trigger dialog |
| Outbound webhooks reach internal services (SSRF) on the home network | high | D15: send-time resolution, private ranges denied by default, explicit allowlist, no redirects |
| A dead receiver fills the deliveries table | medium | circuit breaker, 8-attempt cap, 30-day retention |
| Raw body capture changes body handling for other routes | low | the middleware matches `/hooks` and `/hooks/*` only and passes everything else through; covered by `raw-body.spec.ts` and the existing e2e suite |

## Notes

Recorded while building the core slot (i26-core).

- **D3 (corrected).** The action named `profileId?`, and `model?` as optional; `SkillRunService.start` (#24) takes `SkillRunRequest` with `profileKey?` and a required `model`. The action now uses `profileKey`, and the inbound slot fills an absent `model` with `ORCHESTRATOR_DEFAULTS.model`.
- **D8 (corrected).** `rawBody: true` in `main.ts` would not reach the e2e app (`createNestApplication` is called without it), would capture every route's body, and keeps Nest's 100 KB JSON limit, below D1's 256 KB. A path-scoped middleware in `configureApp` does all three right; `main.ts` is unchanged.
- **Creators.** `inbound_triggers.createdById` and `webhooks.createdById` are nullable with `ON DELETE SET NULL`, like every other `createdById` in the schema. A trigger whose creator was deleted fires as `creator_not_authorized` (D5).
- **Statuses** are PostgreSQL enums: `InboundDeliveryStatus`, `WebhookDeliveryStatus`, `WebhookCircuitState`. `webhook_deliveries.status` defaults to `pending`, `nextAttemptAt` to `now()`.
- **Extra indexes** `inbound_deliveries (receivedAt)` and `webhook_deliveries (createdAt)` serve D18's daily retention delete; `inbound_triggers (projectId)` serves the project cascade and per-project listing.
- **Firing actor.** As #25 D8, a trigger fires as the `system` audit actor with the creator in `meta.onBehalfOf`; `SkillRunTrigger` carries `type: webhook`, `id: <triggerId>`. No new audit actor type.
- **Outbound envelope.** `buildWebhookEnvelope` (shared) is the D10 allowlist: `slot.checkpoint` → `checkpoint`, `summary` (≤ 1000), `pr: { number?, url? }`; free text (`why`, `question`, `recommendation`) ≤ 1000; any other string ≤ 500; objects, arrays and filesystem paths (`worktree`, `briefPath`) are never copied. `id` is `evt_<events.id>`. The `schedule.*` builders read `scheduleId`, `name`, `reason` — #25 owns those event shapes.
- **D4 grammar.** A placeholder is exactly `{{payload.<path>}}`, `<path>` = 1–10 dotted segments of `[A-Za-z0-9_-]`, a numeric segment indexing an array; any other `{{` or `}}` is `bad_placeholder`. Lookup uses own properties only. Rendered args must also fit `skill.run`'s 4096-byte limit (`args_too_long`). `renderArgsTemplate` (shared) is the one verdict for the hook and the dry run.
- **D15 details.** Besides the listed ranges, multicast, reserved `240/4`, benchmarking `198.18/15`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16` are refused; an IPv4-mapped IPv6 address is checked as its IPv4 address. `guardedPost` connects through a `lookup` pinned to the checked address with no connection pooling, keeps Host and TLS SNI, and records a 3xx as `redirect`.
- **Who owns `GET/PUT /admin/settings/webhooks`.** The outbound slot (its controller); the core ships `WebhookSettingsService`.
- **Module layout.** `WebhooksModule` imports `WebhooksCommonModule` and the `InboundWebhooksModule` / `OutboundWebhooksModule` stubs, which the inbound and outbound slots fill in without editing the parent module.

## Open questions

| Question | Default if nobody answers |
|---|---|
| Let operators manage webhooks for their own projects? | No — admin only in this item |
| Batch several events into one outbound delivery? | No — one event, one delivery |
| Accept form-encoded inbound payloads? | No — JSON only |

Depends on #24

Depends on #17

Depends on #21

Depends on #8

Depends on #22
