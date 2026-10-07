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
  └─< Notification
Event (partitioned by month) · UsageRollup (hour × project × model × runtime)
ModelPrice (versioned) · Webhook ─< WebhookDelivery · InboundTrigger
Setting (key/value: registration open/closed, Telegram, …)
```

`Session` is the agent runtime session. A login session is `UserSession`, so
the two never share a name.

| Entity | Key fields |
|---|---|
| `User` | email, passwordHash (argon2id), name, `status: pending\|active\|rejected\|disabled`, `role: admin\|operator\|viewer`, approvedBy, approvedAt, failedLoginCount, lockedUntil, telegramChatId? |
| `UserSession` | userId, tokenHash (sha256 of the cookie token), createdAt, lastSeenAt, expiresAt, ip, userAgent — table `user_sessions` |
| `Setting` | key (primary key), value (json), updatedBy — table `settings` |
| `ProjectMember` | userId (cascade), projectId (cascade), roleOverride? — effective role is `min(global role, override)`, so an override only lowers it; admins need no row — addedBy? (`SET NULL` when that user is deleted), createdAt; unique `(projectId, userId)` — table `project_members` ([spec 10](../specs/10-projects.md)) |
| `Runner` | name, hostname, version, protocolVersion, os, arch, capabilities (json), tokenHash (argon2id), tokenPrefix (unique, first 8 chars), ackedSeq (highest contiguous event seq persisted), pairedAt, lastSeenAt, revokedAt, createdBy? — table `runners`; status is derived from the live socket, never stored |
| `RunnerPairingCode` | runnerId, codeHash (sha256, unique), expiresAt, usedAt — table `runner_pairing_codes` |
| `RuntimeProfile` | runnerId, key (the profile `id` in the runner config), runtime, label (= key until the protocol carries one), binary?, env (paths only), args, authenticated, missing — mirrored from runner config, never deleted; unique `(runnerId, key)` — table `runtime_profiles` |
| `Project` | runnerId (restrict — runners are revoked, never deleted), rootPath (the main checkout), repo (`owner/name`), displayName, baseBranch, baseSource `config\|origin_head\|gh\|default`, baseOverride?, readyLabelOverride?, defaultProfileId? (`SET NULL`; must be a profile of the same runner), mergeApproval (bool), codeSentinelConfig (json: the `orchestrator` block of `.code-analyzer-config.json` and/or its parse error), hasClaudeMd, hasAgentsMd, lastInspectedAt, createdBy? (`SET NULL` when that user is deleted) — unique `(runnerId, rootPath)` — table `projects` |
| `DocsSource` | projectId (cascade, unique), kind `in_repo\|sibling_repo\|remote_repo\|none`, localPath?, repo?, isGitRepo, detectedBy?, evidence (json), classified (json: specs/adr/roadmap/reports paths), candidates (json), manual (an admin override, kept across refreshes) — table `docs_sources` |
| `Round` | projectId (cascade), date, label `HHMM`, base, occupied, max, free, decisions (json: `dispatching`, `heldForLead`, `notDispatching`, `inFlight` rows keyed by column header), source `scraped\|events`, boardPath, lastSeq, createdAt, updatedAt — unique `(projectId, date, label)` — table `rounds` ([spec 11](../specs/11-fleet-observation.md)) |
| `Slot` | one run of a slot: projectId (cascade), name, issue?, branch?, worktree, runtime, model?, modelWhy?, owns / never (json globs), lead?, round? (`YYYY-MM-DD/HHMM` of its brief), status `dispatched\|running\|idle\|prompt\|quota\|stale\|ended` (derived from sessionAlive?, pane?, worktreeExists, prState?), ahead?, behind?, dirty?, prNumber?, prUrl?, prChecks `pending\|green\|red`?, prMergeable?, lastCheckpoint?, lastSeq, startedAt, endedAt?, updatedAt — unique `(projectId, name, startedAt)`, index `(projectId, status)` — table `slots` |
| `SlotCheckpoint` | slotId (cascade), kind, heading, summary, position (index of the heading in the reply file), at (first seen) — unique `(slotId, position)` — table `slot_checkpoints` |
| `FleetOrchestrator` | projectId (primary key, cascade), status `running\|idle\|absent`? (null: never observed — `unknown`), session?, since?, boardError? (json: the last unparsed board or brief), lastSeq, updatedAt — table `fleet_orchestrators`. Fleet rows are projections of events: `lastSeq` is the highest event `seq` applied and timestamps come from event `ts`, so replaying events leaves them unchanged |
| `Session` | Prisma model `AgentSession`. runnerId (cascade), runtime, profileKey?, externalId (the runtime's session id), projectId? (`SET NULL`; null = admins only), slotName?, cwd (`''` on a placeholder created by an event that came before its `session.observed`), gitBranch?, title?, models (json: distinct, in order of first use), parentSessionId? (subagent, `SET NULL`), parsed, startedAt, lastEventAt, endedAt? — unique `(runnerId, runtime, externalId)`, index `(projectId, startedAt)`; a subagent takes its parent's project and slot — table `sessions` ([spec 12](../specs/12-agent-sessions.md)); `runId` arrives with runs |
| `Turn` | sessionId (cascade), promptId, startedAt, endedAt? — unique `(sessionId, promptId)` — table `turns` |
| `LlmRequest` | sessionId (cascade), turnId? (`SET NULL`), requestId, ts, model, querySource `main\|subagent\|auxiliary`, input, output, cacheRead, cacheWrite5m, cacheWrite1h, reasoning (inside `output`, never added twice), durationMs?, durationApprox, stopReason?, costUsd? (decimal 14,6), priceVersion?, costSource? `computed\|ingested` — the cost columns are filled by #13 — unique `(sessionId, requestId)`, index `(ts)`, `(model, ts)` — table `llm_requests` |
| `ToolCall` | sessionId (cascade), turnId? (`SET NULL`), toolUseId, name, startedAt, endedAt?, ok?, childSessionId? (the subagent it spawned, `SET NULL`) — no arguments or output — unique `(sessionId, toolUseId)` — table `tool_calls` |
| `Run` | kind, projectId, profileId, model, args, output `report\|pr`, status, result, prNumber?, triggeredBy (user / schedule / webhook) |
| `Schedule` | projectId, cron, timezone, target (skill or orchestrator command), args, profileId, model, missedPolicy `skip\|catch_up`, enabled |
| `Budget` | scope `project\|user`, scopeId, period `day\|week\|month`, limitUsd, action `alert\|stop` |
| `ModelPrice` | version, modelName, matchPattern (regex), tiers (json), validFrom |
| `AuditRecord` | seq (BigInt, chain order), ts, actorType, actorUserId?, actorRunnerId?, action, targetType, targetId?, projectId?, before, after, result, meta, prevHash, hash — actor and project ids are plain columns without foreign keys, so records outlive users and projects ([spec 8](../specs/8-audit-log.md)) |
| `Webhook` / `WebhookDelivery` | url, secret, events[], status, attempts, nextAttemptAt, responseCode |
| `InboundTrigger` | name, secret, action (skill run / orchestrator next), projectId |
| `Event` | runnerId, seq, ts, type, source, projectRepo?, projectRoot?, slot?, issue?, session? (json), data, receivedAt — unique `(runnerId, seq)`, index `(type, ts)`; projectId is added when projects land (M1.4) — table `events` |
