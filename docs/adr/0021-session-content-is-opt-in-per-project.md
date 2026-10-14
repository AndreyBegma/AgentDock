# ADR-0021: Session content is opt-in per project

Status: accepted · Date: 2026-10-14 · Amends [spec 12](../specs/12-agent-sessions.md) D9 and
[security.md](../architecture/security.md) · Issue: [#201](https://github.com/AndreyBegma/AgentDock/issues/201)

## Context

Spec 12 D9 says prompt text, assistant text, and tool inputs and outputs never
leave the runner. On 2026-10-14 the owner asked to have "all the information about
how we work" on the server, including sessions started by hand. They chose
opt-in per project over shipping content always or never.

## Decision

1. **The default does not change.** A project ships metadata only, as D9 says.
2. **An admin can turn content on per project** with
   `Project.shipSessionContent`. The setting is audited as `project.update`.
   Retention is `Project.sessionContentRetentionDays`, default 30 and range
   1–365.
3. **Hooks are the only source of content.** The runner ships content only from
   hook payloads ([ADR-0020](0020-claude-code-integration-through-the-runner.md)),
   and only for sessions it correlates to a project with the flag on. The
   transcript adapter and the OTLP receiver keep D9 unchanged, and
   `OTEL_LOG_USER_PROMPTS` / `OTEL_LOG_TOOL_DETAILS` are never set. A session
   with no project never ships content.
4. **Redaction happens on the runner, before the spool.** It reuses the pane
   redaction rules: tokens, keys, `Authorization` headers, `.env`-style
   assignments and private-key blocks. Each text is capped at 16 KiB and marked
   `truncated`.
5. **Storage and access.** Content lives in its own table, never in `events` or
   `audit_records`. A daily BullMQ job ([ADR-0015](0015-schedules-run-on-bullmq.md))
   deletes rows past retention. Turning the flag off stops shipping, but stored
   rows stay until their retention ends. An admin can purge a project's content at
   once; the purge is audited. Reading content needs `operator` on the project.
   Viewers keep metadata only.

## Consequences

- Prompts and code excerpts sit in PostgreSQL. Redaction is pattern-based and
  will miss some secrets, so the setting's help text says this plainly.
- Content does not count toward a session's tokens or cost. It is a view only.
- Rejected:
  - **Content always.** Secrets from every project would reach the database.
  - **Content from transcripts.** That would ship months of history on backfill.
