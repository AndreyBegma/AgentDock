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
| `ProjectMember` | userId, projectId, role override (≤ global role) |
| `Runner` | name, hostname, version, protocolVersion, os, arch, capabilities (json), tokenHash (argon2id), tokenPrefix (unique, first 8 chars), ackedSeq (highest contiguous event seq persisted), pairedAt, lastSeenAt, revokedAt, createdBy? — table `runners`; status is derived from the live socket, never stored |
| `RunnerPairingCode` | runnerId, codeHash (sha256, unique), expiresAt, usedAt — table `runner_pairing_codes` |
| `RuntimeProfile` | runnerId, key (the profile `id` in the runner config), runtime, label (= key until the protocol carries one), binary?, env (paths only), args, authenticated, missing — mirrored from runner config, never deleted; unique `(runnerId, key)` — table `runtime_profiles` |
| `Project` | runnerId, rootPath, repo (`owner/name`), baseBranch, readyLabel, defaultProfileId, mergeApproval (bool), config (json snapshot of `.code-analyzer-config.json`) |
| `DocsSource` | projectId, kind `in_repo\|sibling_repo\|remote_repo`, path/repo, detectedBy, specs/adr/roadmap paths, isGitRepo |
| `Round` | projectId, startedAt, label `HHMM`, occupied, max, decisions (json) |
| `Slot` | projectId, name, issue, branch, worktree, runtime, model, modelWhy, status, prNumber, checks, lastCheckpoint, startedAt, endedAt |
| `Session` | runtime, externalId, projectId?, slotId?, runId?, cwd, model(s), startedAt, endedAt |
| `LlmRequest` | sessionId, ts, model, token buckets, durationMs, costUsd, priceVersion, costSource `computed\|ingested` |
| `Run` | kind, projectId, profileId, model, args, output `report\|pr`, status, result, prNumber?, triggeredBy (user / schedule / webhook) |
| `Schedule` | projectId, cron, timezone, target (skill or orchestrator command), args, profileId, model, missedPolicy `skip\|catch_up`, enabled |
| `Budget` | scope `project\|user`, scopeId, period `day\|week\|month`, limitUsd, action `alert\|stop` |
| `ModelPrice` | version, modelName, matchPattern (regex), tiers (json), validFrom |
| `AuditRecord` | seq (BigInt, chain order), ts, actorType, actorUserId?, actorRunnerId?, action, targetType, targetId?, projectId?, before, after, result, meta, prevHash, hash — actor and project ids are plain columns without foreign keys, so records outlive users and projects ([spec 8](../specs/8-audit-log.md)) |
| `Webhook` / `WebhookDelivery` | url, secret, events[], status, attempts, nextAttemptAt, responseCode |
| `InboundTrigger` | name, secret, action (skill run / orchestrator next), projectId |
| `Event` | runnerId, seq, ts, type, source, projectRepo?, projectRoot?, slot?, issue?, session? (json), data, receivedAt — unique `(runnerId, seq)`, index `(type, ts)`; projectId is added when projects land (M1.4) — table `events` |
