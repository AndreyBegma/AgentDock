# Audit log with hash chain

Issue: [#8](https://github.com/AndreyBegma/AgentDock/issues/8) · Roadmap: M1.2 ·
Decisions: [ADR-0008](../adr/0008-local-accounts-with-admin-approved-registration.md),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md),
[security.md](../architecture/security.md), [data-model.md](../architecture/data-model.md)

## Summary

Every privileged action in AgentDock — who logged in, who approved whom, who
revoked a runner, who sent a command to a machine — must leave a record that
cannot be quietly rewritten. This adds an append-only audit log whose rows form
a hash chain, a service every module calls to write it, a verification job that
detects tampering, the retrofit of the actions #3 and #6 deferred, and an admin
page to search and export it. Later items (projects, fleet control, skills)
record through the same service.

## Scope

### In scope

- Table `audit_records`, append-only at the database level, hash-chained.
- `AuditService.record(...)` with serialized appends and secret redaction.
- Retrofit of every action listed under *Audited later* in
  [#3's spec](3-auth-and-access.md#audited-later-m12) and the runner actions
  deferred by [#6's spec](6-runner-pairing-gateway-and-admin.md#out-of-scope).
- Chain verification: nightly job, on-demand endpoint, status on the page.
- Admin API: list with filters, single record, verification, CSV export.
- Web page `/admin/audit`.

### Out of scope

- Separate database roles for the application (no UPDATE/DELETE grants) — a
  deployment concern; the trigger below is the development-time guard.
- Signed receipts per tool call (Mission Control's Ed25519 receipts) — rejected
  as overkill in [docs/README.md](../README.md).
- Auditing actions of modules that do not exist yet — each later spec adds its
  own `record` calls.
- Retention and archival — records are kept forever (security.md).

## Decisions

The person delegated all decisions on 2026-10-07; each below is the default
taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | One table, `audit_records`, ordered by a `BigInt` autoincrement `seq`. `hash = sha256(prevHash ‖ canonical(row))` hex, where `canonical` is JSON with sorted keys over `seq, ts, actorType, actorUserId, actorRunnerId, action, targetType, targetId, projectId, before, after, result, meta`. The first row uses `prevHash = "0" × 64` | security.md |
| D2 | Appends are serialized: `record` runs in a transaction that takes `pg_advisory_xact_lock(<constant audit key>)`, reads the last `hash`, inserts the row with `prevHash` and `hash`. No concurrent writer can fork the chain | new — required for D1 to be well-defined |
| D3 | **Database-level append-only:** the migration adds a `BEFORE UPDATE OR DELETE` row trigger and a `BEFORE TRUNCATE` statement trigger on `audit_records` that raise an exception. Justification: separate DB roles are out of scope in development, the trigger costs nothing, stops application bugs and casual edits, and anything that bypasses it (a superuser dropping the trigger) still breaks the hash chain, which D6 detects | security.md ("no UPDATE/DELETE"); new mechanism |
| D4 | The migration is created with `prisma migrate dev --create-only` and the trigger SQL appended to its `migration.sql`; Prisma has no trigger DSL [Confirmed: Prisma supports hand-edited migrations before apply] | CLAUDE.md (never edit an *applied* migration) |
| D5 | `AuditService.record({ actor, action, target, projectId?, before?, after?, result, meta? })`. `actor` is `{ type: "user", userId }`, `{ type: "runner", runnerId }`, `{ type: "system" }` or `{ type: "anonymous" }` (failed logins). `result` is `ok \| denied \| error`. Actions are dotted strings from a closed union in `packages/shared/src/audit/actions.ts` (e.g. `auth.login`, `user.approve`, `runner.revoke`) | data-model.md |
| D6 | Verification walks the chain in `seq` order in batches of 1000, recomputing each hash; it reports `{ ok, checked, firstBrokenSeq?, verifiedAt }`. A nightly job (03:00 server time, `@nestjs/schedule`) stores the last result in the `settings` table under `audit.lastVerification`; a failure is logged at `error` | security.md ("a verification job reports breaks") |
| D7 | Redaction before hashing: keys named `password`, `passwordHash`, `currentPassword`, `newPassword`, `token`, `tokenHash`, `code`, `codeHash`, `secret` (any depth) are replaced by `"[redacted]"` in `before`, `after` and `meta`. The record never contains a secret, so the hash never depends on one | security.md |
| D8 | `record` is called **after** the action's outcome is known and never rolls the action back; if writing the audit row fails, the error is logged at `error` and the request still returns its result. Exception: commands to runners are recorded `requested` before sending and completed with a second record (`runner.command.result`) — overview.md's command path | overview.md (command path); new for the failure rule |
| D9 | Failed logins are recorded with `actor: anonymous`, `target: { type: "email", id: <lower-cased email> }`, `result: denied`, and `meta.reason` (`invalid_credentials`, `locked`, `pending_approval`). The IP and user agent go into `meta` for every user-originated record | new |
| D10 | `projectId` is a nullable string **without** a foreign key — projects arrive in #10 and audit rows must outlive any project | data-model.md; new |
| D11 | Admin only: list, detail, verify, export. No role can modify or delete records through the API | ADR-0008 |
| D12 | CSV export streams rows matching the current filters, UTF-8, RFC 4180 quoting, `before` / `after` / `meta` as JSON strings; capped at 100 000 rows per request. A cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'` (OWASP CSV injection: a failed-login email is anonymous input); JSON columns start with `{`, `[` or `"` and are never altered | new; injection guard added during implementation (orchestrator, 2026-10-07) |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261010000000_audit/` (created
with `--create-only`, trigger SQL appended, then applied).

`AuditRecord` (table `audit_records`) — a new table; it does not alter `users`
or `runners`:

| Field | Type |
|---|---|
| `seq` | BigInt autoincrement, primary key |
| `ts` | DateTime default now |
| `actorType` | enum `AuditActorType` (`user`, `runner`, `system`, `anonymous`) |
| `actorUserId` | String? (plain column, no FK — see below) |
| `actorRunnerId` | String? (plain column, no FK, same reason) |
| `action` | String |
| `targetType` | String |
| `targetId` | String? |
| `projectId` | String? (no FK, D10) |
| `before` | Json? |
| `after` | Json? |
| `result` | enum `AuditResult` (`ok`, `denied`, `error`, `requested`) |
| `meta` | Json? |
| `prevHash` | String (64 hex) |
| `hash` | String (64 hex), unique |

Indexes: `(ts)`, `(action, ts)`, `(actorUserId, ts)`, `(projectId, ts)`,
`(targetType, targetId)`.

`actorUserId` and `actorRunnerId` are stored as plain columns without foreign
keys: deleting a user (#3 allows it) must not cascade into or be blocked by the
audit table, and D3 forbids the `UPDATE` a `SET NULL` would perform.

Trigger SQL (appended to `migration.sql`):

```sql
CREATE FUNCTION audit_records_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_records is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_records_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_records
  FOR EACH ROW EXECUTE FUNCTION audit_records_immutable();

CREATE TRIGGER audit_records_no_truncate
  BEFORE TRUNCATE ON audit_records
  FOR EACH STATEMENT EXECUTE FUNCTION audit_records_immutable();
```

## Retrofit — actions recorded by this item

| Action | Where | Actor | Target | before / after |
|---|---|---|---|---|
| `auth.login` | login, success and failure | user / anonymous | user / email | — ; `meta.reason` on failure |
| `auth.logout` | logout | user | session | — |
| `auth.register` | registration | anonymous | user | after: `{ email, name, status }` |
| `user.approve` | approve | user (admin) | user | status, role |
| `user.reject` | reject | user (admin) | user | status |
| `user.update` | role change, disable/enable | user (admin) | user | changed fields |
| `user.delete` | delete | user (admin) | user | before: `{ email, role, status }` |
| `settings.registration` | registration toggle | user (admin) | setting | `open` |
| `auth.password_change` | own password change | user | user | — |
| `auth.session_revoke` | revoke own session | user | session | — |
| `runner.create` | create runner | user (admin) | runner | after: `{ name }` |
| `runner.pairing_code` | new pairing code | user (admin) | runner | — |
| `runner.pair` | successful / failed pairing | runner / anonymous | runner | after: `{ hostname, version }` |
| `runner.rename` | rename | user (admin) | runner | `name` |
| `runner.revoke` | revoke | user (admin) | runner | `revokedAt` |
| `runner.command` / `runner.command.result` | every `RunnerCommandService.send` | user / system | runner | after: `{ name, args }` / `{ ok, error? }` |
| `user.create` | `bun run admin:create` | system | user | after: `{ email, role, status }`; `meta.via: "cli"` |
| `project.connect` | connect a project ([#10](10-projects.md)) | user (admin) | project | after: `{ runnerId, rootPath, repo, displayName, docsKind }` |
| `project.delete` | delete a project | user (admin) | project | before: `{ runnerId, rootPath, repo, displayName }` |
| `project.update` | project settings | user (admin) | project | changed fields only |
| `project.member_add` | add a member | user (admin) | user | after: `{ userId, roleOverride }` |
| `project.member_update` | change a member's override | user (admin) | user | `roleOverride`; not recorded when unchanged |
| `project.member_remove` | remove a member | user (admin) | user | before: `{ userId, roleOverride }` |
| `project.docs_source_override` | manual docs source | user (admin) | project | `{ kind, localPath, repo, manual }` |
| `project.docs_source_reset` | restore detection | user (admin) | project | `{ kind, localPath, repo, manual }` |

Every `project.*` record carries `projectId`. `project.inspect` and
`project.refresh` are runner commands, recorded as `runner.command` /
`runner.command.result` like every other.

Notes from implementation: failed admin mutations (404 / 409) are not recorded —
only login and pairing record `denied`. A command refused for the caller's role
writes one `runner.command` / `denied`; arguments that fail the command's schema
write nothing. A command with no answer (`unknown`) completes with
`runner.command.result` / `error`, `after.error: "unknown"`.

Admin endpoints of #3 that change nothing (lists, `GET`s) are not recorded.

## API

All admin-only; web reaches them as `/api/...`.

| Method | Path | Behaviour |
|---|---|---|
| GET | `/admin/audit` | filters: `from`, `to`, `action` (prefix match, e.g. `runner.`), `actorUserId`, `targetType`, `targetId`, `projectId`, `result`; cursor pagination on `seq` (newest first), page size ≤ 200 |
| GET | `/admin/audit/:seq` | one record with `prevHash` and `hash` |
| GET | `/admin/audit/verification` | last stored result (D6) |
| POST | `/admin/audit/verification` | run verification now; returns the result (may take seconds; 60 s timeout) |
| GET | `/admin/audit/export.csv` | same filters as the list; streamed (D12) |

## UI

`/admin/audit` (glass-ui, plain admin page like #3's and #6's):

- chain status `Badge` at the top: verified ✓ with time, or broken ✗ with the first broken `seq`; "Verify now" button;
- `Toolbar` with filters: date range (`DateInput`), action prefix (`Select` built from the shared action union), actor (`Combobox` over users), result, project id;
- table: time, actor, action, target, result `Badge` (ok / denied / error / requested); "Load more" by cursor;
- detail `Sheet`: all fields, `before` / `after` / `meta` as formatted JSON, `prevHash` / `hash`;
- "Export CSV" downloads with the current filters.

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `AUDIT_VERIFY_CRON` | `apps/api` | override of the nightly verification schedule (default `0 3 * * *`) |

Add it to `apps/api/.env.example`.

## Acceptance criteria

- [ ] Every action in the retrofit table writes exactly one record (two for runner commands), with the actor, target and result listed there — covered by e2e tests that perform each action and query `audit_records`.
- [ ] A failed login with a wrong password and one with an unknown email both write `auth.login` / `denied` with `actor: anonymous`; neither record contains the password.
- [ ] No record contains any redacted key's value: a test runs every retrofitted action and asserts that no `before` / `after` / `meta` contains a password, password hash, token, token hash or pairing code.
- [ ] `UPDATE audit_records ...`, `DELETE FROM audit_records ...` and `TRUNCATE audit_records` executed directly in PostgreSQL fail with `audit_records is append-only`.
- [ ] 50 concurrent `record` calls produce 50 rows whose chain verifies (`prevHash` of each equals `hash` of the previous by `seq`).
- [ ] After dropping the trigger and editing one row's `after` by hand in a test database, `POST /admin/audit/verification` returns `ok: false` with that row's `seq` as `firstBrokenSeq`.
- [ ] The nightly job stores its result in `settings` (`audit.lastVerification`); `GET /admin/audit/verification` returns it.
- [ ] Filters on the list endpoint return only matching rows; cursor pagination returns every row exactly once.
- [ ] CSV export of a filtered set opens in a spreadsheet with one row per record and JSON columns intact.
- [ ] Deleting a user leaves their audit records intact and still readable with the user id.
- [ ] **Authorization:** `operator` and `viewer` get 403 on every `/admin/audit*` route; anonymous gets 401; no route accepts `PUT`, `PATCH` or `DELETE` on audit records (405 or 404).
- [ ] An audit write failure (simulated) does not change the HTTP result of the action that triggered it and logs at `error`.
- [ ] `bun run check`, `bun run test`, `bun run build` pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i8-api | schema, migration with trigger, audit module, verification job, shared action union, retrofit call sites | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261010000000_audit/**, apps/api/src/audit/**, apps/api/src/auth/**, apps/api/src/runners/**, apps/api/src/app.module.ts, apps/api/package.json, apps/api/.env.example, packages/shared/src/audit/**, packages/shared/src/index.ts, bun.lock | — | yes | opus |
| i8-web | `/admin/audit` page | apps/web/src/app/admin/audit/**, apps/web/src/lib/audit/** | i8-api | no | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i8-api | shared across issues only for **distinct new tables**: a conflict is an append — keep both models. This item adds `AuditRecord` only and alters no existing model |
| apps/api/src/app.module.ts | i8-api | module registration is a one-line append; a conflict is resolved by keeping both imports |
| apps/api/src/auth/**, apps/api/src/runners/** | i8-api (call sites only) | no other live slot may edit these modules while i8-api is live; #9 and #10 do not touch them |
| packages/shared/src/index.ts | i8-api (one re-export line) | append-only; keep both lines on conflict |
| bun.lock | regenerated per the rule in [#5's spec](5-runner-daemon-and-protocol.md#contention) | — |

Depends on #3

Depends on #6

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| The advisory lock serializes every audited write; a slow audit insert slows logins | low | the critical section is one `SELECT` + one `INSERT`; measured in the concurrency test |
| Retrofitting edits auth and runner code merged by other slots — regressions in #3 / #6 behaviour | medium | `opus`; the existing #3 / #6 e2e tests must stay green unchanged |
| A superuser can drop the trigger and rewrite the whole chain from the edited row onward | medium | out of scope for development; production hardening (role without DDL rights, periodic export of the head hash) noted for a later spec |
| Later modules forget to call `record` | medium | each later spec lists its audited actions; `AuditService` is global and the action union makes missing actions visible in review |
| Prisma regenerating the migration might drop the hand-written trigger SQL | low | the migration is created `--create-only` once and never regenerated; acceptance criterion tests the trigger exists |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Should viewers / operators see audit records for their own projects? | No — admin only until per-project access exists (#10) and someone asks |
| Should the head hash be exported somewhere outside the database (e.g. Telegram, a file) for stronger tamper evidence? | No — later hardening |
