# Architecture overview

```
┌──────────────────────────── Control plane ────────────────────────────┐
│  apps/web (Next.js 16, glass-ui)                                       │
│        │ HTTPS (cookie session) + WebSocket (live updates)             │
│  apps/api (NestJS 11)                                                  │
│    auth · projects · fleet · sessions · usage · skills · schedules     │
│    webhooks · notifications (in-app, Telegram) · audit · GitHub App    │
│        │ Prisma 7                                                      │
│  PostgreSQL 16                                                         │
└────────▲───────────────────────────────────────────▲──────────────────┘
         │ WSS /runner (runner dials out, token auth) │ HTTPS webhooks
┌────────┴──────────── Runner (one per machine) ─────┐   GitHub, Telegram,
│ apps/runner (Bun, single compiled binary)          │   inbound triggers
│  collectors                                        │
│   · orchestrator: events.jsonl / state.json        │
│     (fallback: round-*.md, briefs, reply files)    │
│   · tmux: cs-* sessions, pane state, capture       │
│   · git: worktrees, branches, ahead/behind         │
│   · sessions: ~/.claude*/projects/*.jsonl,         │
│     $CODEX_HOME/sessions                           │
│   · OTLP receiver (127.0.0.1) for live usage       │
│   · gh: issues, PRs, checks (runner's own auth)    │
│  executor: typed command allowlist                 │
│  adapters: claude | codex  (runtime profiles)      │
└────────────────────────────────────────────────────┘
          │ launches / observes
   tmux cs-<slot> sessions · git worktrees · orchestrator session
```

## Principles

1. **The control plane never touches a project's filesystem.** Everything it
   knows came from a runner; everything it changes goes through a runner
   command. Local mode is the same runner on the same machine (ADR-0001).
2. **Observe the orchestrator, do not replace it.** AgentDock starts the
   `cs-orchestrator` skill in a session and reads what it writes (ADR-0005).
3. **Structured first, scraped second.** Code Sentinel emits
   `events.jsonl`; markdown parsing exists for old rounds and older plugin
   versions (ADR-0002).
4. **Usage from telemetry, transcripts as truth of last resort.** The runner
   receives OTel from sessions it launched and backfills from transcripts for
   everything else (ADR-0003).
5. **GitHub is the queue.** Issues and labels are the state; the database
   caches them (ADR-0004).
6. **The runner obeys a schema, not a shell.** Commands are typed and
   allowlisted (ADR-0010).
7. **One database.** PostgreSQL holds transactional data and the event /
   usage time series, partitioned by month (ADR-0007).

## Apps and packages

| Path | Role |
|---|---|
| `apps/api` | NestJS; REST for the UI, `/runner` WebSocket gateway, `/live` WebSocket for live updates (session cookie + origin check, authorized topics — [spec 9](../specs/9-application-shell-and-live-updates.md)), webhook endpoints, schedulers |
| `apps/web` | Next.js App Router; talks only to `apps/api` |
| `apps/runner` | Bun daemon; compiled with `bun build --compile`; config in `~/.config/agentdock/runner.json` |
| `packages/shared` | protocol types: runner messages, event schema, command schema (zod), shared enums |

## Live data path

1. A collector on the runner sees a change (file append, tmux list diff, OTLP
   batch, `gh` poll diff).
2. It normalizes it to an `Event` ([event-schema.md](event-schema.md)) with a
   runner-local monotonic `seq`.
3. The runner sends batches over the WebSocket; on reconnect it resends from the
   last `seq` the API acknowledged (at-least-once; the API dedupes on
   `(runnerId, seq)`).
4. The API persists, updates projections (slot state, session tree, usage
   rollups), evaluates budgets and notification rules, and fans out to UI
   subscribers of that project through `LiveService.publish` on the
   `project:<id>` topic of `/live`.

## Command path

1. A user with the right role triggers an action in the UI.
2. The API authorizes it (role × project membership), writes an audit record
   `requested`, and sends a typed command to the runner.
3. The runner validates against its schema and its local policy, executes, and
   replies `ok | error` with output.
4. The API completes the audit record with the result.

## Deployment (first target)

The owner's server runs the control plane in Docker Compose (api, web,
postgres) behind a TLS reverse proxy, and the runner as a systemd user service
on the same host, so it sees the same tmux server, worktrees and agent configs
as the person.
