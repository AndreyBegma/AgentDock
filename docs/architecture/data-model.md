# Data model

Status: draft — entities and relations; field-level detail is settled in each
milestone's spec and lands as Prisma migrations.

```
User ─< ProjectMember >─ Project >─ Runner ─< RuntimeProfile
  │                        │
  │                        ├─< Slot ─< SlotCheckpoint
  │                        ├─< Round
  │                        ├─< Session ─< Turn ─< LlmRequest / ToolCall
  │                        ├─< Run (orchestrator | skill | schedule)
  │                        ├─< Schedule
  │                        ├─< InstalledSkill
  │                        ├─< Budget
  │                        └─  DocsSource
  ├─< UserSession (login sessions)
  ├─< AuditRecord
  ├─< Notification ─< NotificationDelivery
  ├─< NotificationRule · NotificationMute (>─ Project)
  └─  TelegramLink · TelegramLinkCode
Runner ─< RunnerIncident · NotificationMatcherState (one row)
Event (partitioned by month) · UsageRollup (hour × project × model × runtime)
ModelPrice (versioned) · Webhook ─< WebhookDelivery · InboundTrigger
Setting (key/value: registration open/closed, Telegram, …)
```

`Session` is the agent runtime session. A login session is `UserSession`, so
the two never share a name.

| Entity | Key fields |
|---|---|
| `User` | email, passwordHash (argon2id), name, `status: pending\|active\|rejected\|disabled`, `role: admin\|operator\|viewer`, approvedBy, approvedAt, failedLoginCount, lockedUntil — the Telegram chat is a `TelegramLink` row |
| `UserSession` | userId, tokenHash (sha256 of the cookie token), createdAt, lastSeenAt, expiresAt, ip, userAgent — table `user_sessions` |
| `Setting` | key (primary key), value (json), updatedBy — table `settings` |
| `ProjectMember` | userId (cascade), projectId (cascade), roleOverride? — effective role is `min(global role, override)`, so an override only lowers it; admins need no row — addedBy? (`SET NULL` when that user is deleted), createdAt; unique `(projectId, userId)` — table `project_members` ([spec 10](../specs/10-projects.md)) |
| `Runner` | name, hostname, version, protocolVersion, os, arch, capabilities (json), tokenHash (argon2id), tokenPrefix (unique, first 8 chars), ackedSeq (highest contiguous event seq persisted), pairedAt, lastSeenAt, revokedAt, createdBy? — table `runners`; status is derived from the live socket, never stored |
| `RunnerPairingCode` | runnerId, codeHash (sha256, unique), expiresAt, usedAt — table `runner_pairing_codes` |
| `RuntimeProfile` | runnerId, key (the profile `id` in the runner config), runtime, label (= key until the protocol carries one), binary?, env (paths only), args, authenticated, missing — mirrored from runner config, never deleted; unique `(runnerId, key)` — table `runtime_profiles` |
| `Project` | runnerId (restrict — runners are revoked, never deleted), rootPath (the main checkout), repo (`owner/name`), displayName, baseBranch, baseSource `config\|origin_head\|gh\|default`, baseOverride?, readyLabelOverride?, defaultProfileId? (`SET NULL`; must be a profile of the same runner), mergeApproval (bool), codeSentinelConfig (json: the `orchestrator` block of `.code-analyzer-config.json` and/or its parse error), hasClaudeMd, hasAgentsMd, lastInspectedAt, createdBy? (`SET NULL` when that user is deleted) — unique `(runnerId, rootPath)` — table `projects` |
| `DocsSource` | projectId (cascade, unique), kind `in_repo\|sibling_repo\|remote_repo\|none`, localPath?, repo?, isGitRepo, detectedBy?, evidence (json), classified (json: specs/adr/roadmap/reports paths), candidates (json), manual (an admin override, kept across refreshes) — table `docs_sources` |
| `Round` | projectId (cascade), date, label `HHMM`, base, occupied, max, free, decisions (json: `dispatching`, `heldForLead`, `notDispatching`, `inFlight` rows keyed by column header), source `scraped\|events`, boardPath, sources (json: which source last wrote `header` / `decisions`, [spec 16](../specs/16-consume-code-sentinel-events.md) D7), lastSeq, createdAt, updatedAt — unique `(projectId, date, label)` — table `rounds` ([spec 11](../specs/11-fleet-observation.md)) |
| `Slot` | one run of a slot: projectId (cascade), name, issue?, branch?, worktree, runtime, model?, modelWhy?, owns / never (json globs), lead?, round? (`YYYY-MM-DD/HHMM` of its brief), status `dispatched\|running\|idle\|prompt\|quota\|stale\|ended` (derived from sessionAlive?, pane?, worktreeExists, prState?), ahead?, behind?, dirty?, prNumber?, prUrl?, prChecks `pending\|green\|red`?, prMergeable?, lastCheckpoint?, sources (json: which source last wrote `model` / `checkpoint` / `pr`, plus `dispatchedAt` and `checkpoints` for matching plugin events — spec 16 D7), lastSeq, startedAt, endedAt?, updatedAt — unique `(projectId, name, startedAt)`, index `(projectId, status)` — table `slots` |
| `SlotCheckpoint` | slotId (cascade), kind, heading, summary, position (index of the heading in the reply file), at (first seen) — unique `(slotId, position)` — table `slot_checkpoints` |
| `FleetOrchestrator` | projectId (primary key, cascade), status `running\|idle\|absent`? (null: never observed — `unknown`), session?, since?, boardError? (json: the last unparsed board or brief), lastSeq, updatedAt — table `fleet_orchestrators`. Fleet rows are projections of events: `lastSeq` is the highest event `seq` applied and timestamps come from event `ts`, so replaying events leaves them unchanged |
| `Session` | Prisma model `AgentSession`. runnerId (cascade), runtime, profileKey?, externalId (the runtime's session id), projectId? (`SET NULL`; null = admins only), slotName?, cwd (`''` on a placeholder created by an event that came before its `session.observed`), gitBranch?, title?, models (json: distinct, in order of first use), parentSessionId? (subagent, `SET NULL`), parsed, startedAt, lastEventAt, endedAt? — unique `(runnerId, runtime, externalId)`, index `(projectId, startedAt)`; a subagent takes its parent's project and slot — table `sessions` ([spec 12](../specs/12-agent-sessions.md)); `runId` arrives with runs |
| `Turn` | sessionId (cascade), promptId, startedAt, endedAt? — unique `(sessionId, promptId)` — table `turns` |
| `LlmRequest` | sessionId (cascade), turnId? (`SET NULL`), requestId, ts, model, querySource `main\|subagent\|auxiliary`, input, output, cacheRead, cacheWrite5m, cacheWrite1h, reasoning (inside `output`, never added twice), durationMs?, durationApprox, stopReason?, costUsd? (decimal 14,6; null = unpriced), priceVersion? (`price_versions.number`), costSource? `computed\|ingested`, reportedCostUsd? (the runtime's own estimate, never summed), source `transcript\|otel`, cacheWriteTtlUnknown — cost columns filled by #13, OTel and transcript copies merged per spec 13 D15 — unique `(sessionId, requestId)`, index `(ts)`, `(model, ts)` — table `llm_requests` |
| `ToolCall` | sessionId (cascade), turnId? (`SET NULL`), toolUseId, name, startedAt, endedAt?, ok?, childSessionId? (the subagent it spawned, `SET NULL`) — no arguments or output — unique `(sessionId, toolUseId)` — table `tool_calls` |
| `IssueCache` | the project's GitHub issues and open pull requests as the `issues` collector last saw them: projectId (cascade), number, kind `issue\|pull_request` (a pull request is kept only for its `Closes #n`), title, state `open\|closed` (closed when absent from a snapshot's `open` list), labels / assignees (json string arrays), body (≤ 64 KB; 16 KB for a pull request), url, ghUpdatedAt, closedBy `pr\|manual`? / closingPr? / closedAt? (from `issue.closed`), snapshotAt (when the content D3 reads last changed — a comment moves `ghUpdatedAt` only), lastSeq — unique `(projectId, number)`, index `(projectId, state)` — table `issues_cache` ([spec 19](../specs/19-task-queue.md)) |
| `QueueStateRow` | one per open ready issue, recomputed whenever the cache, the slots or the latest round change: projectId (cascade), issueNumber, state / why / clears? (AgentDock's D3 verdict; state `in_flight\|ready\|blocked_work\|blocked_person\|no_spec`), source `computed\|orchestrator` (which verdict is shown, D4), orchestratorState? / orchestratorWhy? / orchestratorClears? (the latest round's verdict, fresher or not), blockers (json: `Depends on` numbers still blocking), waveSlots? (json: `{ slot, lead, model }` of the body's `## Parallel plan`), computedAt (moves only when the row changes) — unique `(projectId, issueNumber)` — table `queue_states` |
| `IssueFeed` | projectId (primary key, cascade), fetchedAt? / snapshotId? (the last snapshot part applied), unavailableReason? / unavailableAt? (the last `issues.unavailable`, cleared by the next snapshot), lastSeq, updatedAt — table `issue_feeds` |
| `CommandRun` | one control command sent from the UI: projectId (cascade), runnerId (cascade), userId? (`SET NULL` when that user is deleted), command (`orchestrator.start\|orchestrator.stop\|slot.stop\|slot.message`), args (json, as sent — a message's full text lives only here), slot?, status `requested\|ok\|error\|unknown` (`unknown`: no answer within the timeout), error? (json `{ code, message }`), result? (json), requestedAt, finishedAt? — index `(projectId, requestedAt)` — table `command_runs` ([spec 17](../specs/17-orchestrator-and-slot-control.md)) |
| `ProjectOrchestratorSettings` | projectId (primary key, cascade), profileId? (`SET NULL`; a profile of the project's runner — null falls back to the project's default profile), model (default `opus`), permissionMode `auto\|acceptEdits\|bypassPermissions\|manual` (default `auto`; `bypassPermissions` set by an admin only), updatedBy? (`SET NULL`), updatedAt — no row means the defaults — table `project_orchestrator_settings` |
| `Notification` | userId (cascade), kind (shared `NotificationKind`), projectId? (cascade), runnerId? (`SET NULL`), slot?, issue?, title, body, link? (web path), eventId? (the event that created it), lastEventId? (the newest event folded in — a replay at or below it is not folded again), count (events folded in, D6), firstAt, lastAt, readAt?, muted (the project was muted when it arrived; never counted as unread) — unique `(eventId, userId, kind)`, index `(userId, readAt, lastAt)`, `(userId, lastAt, id)`, `(userId, kind, firstAt)` — table `notifications` ([spec 22](../specs/22-notifications-and-telegram.md)) |
| `NotificationRule` | userId (cascade), kind, inApp, telegram, updatedAt — primary key `(userId, kind)`; no row means the D1 default — table `notification_rules` |
| `NotificationMute` | userId (cascade), projectId (cascade), until? (null: until removed), createdAt — primary key `(userId, projectId)` — table `notification_mutes` |
| `NotificationDelivery` | notificationId (cascade), userId (for the per-user rate limit), channel `telegram`, status `pending\|sent\|digested\|failed\|skipped`, attempts, nextAttemptAt? (due time, claim lease, 429 `retry_after`, or the digest's window end), lastError? (a skip reason `muted\|rule_off\|unlinked`, or the last send error), digestId?, sentAt?, createdAt — index `(status, nextAttemptAt)`, `(userId, channel, sentAt)`, `(digestId)` — table `notification_deliveries` |
| `TelegramLink` | userId (primary key, cascade), chatId (BigInt, unique), username?, linkedAt — one private chat per user — table `telegram_links` |
| `TelegramLinkCode` | userId (cascade), codeHash (sha256, unique), expiresAt, usedAt? — single use, 10 minutes — table `telegram_link_codes` |
| `NotificationMatcherState` | one row (`id = 1`, checked): eventsCursor (every event with `id <=` it is matched), telegramUpdateOffset, updatedAt — table `notification_matcher_state` |
| `RunnerIncident` | runnerId (cascade), openedAt, resolvedAt? — at most one open per runner (spec 22 D5) — table `runner_incidents` |
| `Run` | kind, projectId, profileId, model, args, output `report\|pr`, status, result, prNumber?, triggeredBy (user / schedule / webhook) |
| `Schedule` | projectId, cron, timezone, target (skill or orchestrator command), args, profileId, model, missedPolicy `skip\|catch_up`, enabled |
| `Budget` | scope `project\|user`, scopeId, period `day\|week\|month`, limitUsd, action `alert\|stop` |
| `PriceVersion` | number (unique; highest is current), source `langfuse-seed\|admin`, note?, createdById? (`SET NULL`), createdAt — immutable; an edit is a new version — table `price_versions` ([spec 13](../specs/13-tokens-and-cost.md)) |
| `ModelPrice` | versionId (cascade), modelName, matchPattern (case-insensitive regex), priority (lower wins), tiers (json: `{ name, isDefault, conditions[], prices }`) — unique `(versionId, modelName)` — table `model_prices` |
| `UsageRollup` | hour (timestamptz, UTC), dimensionKey, projectId?, runtime, model, slot?, runId? (empty until runs exist), issue?, requests, input, output, cacheRead, cacheWrite5m, cacheWrite1h, reasoning (BigInt), costUsd (decimal 14,6), unpricedRequests — a pure aggregate of `llm_requests`, whole hours rebuilt on every write; no foreign keys — unique `(hour, dimensionKey)`, index `(projectId, hour)`, `(hour)` — table `usage_rollups` |
| `PriceRecompute` | versionId (`RESTRICT`), from, to, status `queued\|running\|done\|failed`, processed, total, error?, createdById? (`SET NULL`), createdAt, finishedAt? — table `price_recomputes` |
| `AuditRecord` | seq (BigInt, chain order), ts, actorType, actorUserId?, actorRunnerId?, action, targetType, targetId?, projectId?, before, after, result, meta, prevHash, hash — actor and project ids are plain columns without foreign keys, so records outlive users and projects ([spec 8](../specs/8-audit-log.md)) |
| `Webhook` / `WebhookDelivery` | url, secret, events[], status, attempts, nextAttemptAt, responseCode |
| `InboundTrigger` | name, secret, action (skill run / orchestrator next), projectId |
| `Event` | runnerId, seq, ts, type, source, projectRepo?, projectRoot?, slot?, issue?, session? (json), data, receivedAt, pluginEventId? (a Code Sentinel event's `eid`) — unique `(runnerId, seq)`, unique `(projectRoot, pluginEventId)` (binds plugin events only: NULLs are distinct), index `(type, ts)`, index `(projectRoot, source, receivedAt)`; projectId is added when projects land (M1.4) — table `events` |
