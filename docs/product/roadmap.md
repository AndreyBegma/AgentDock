# Roadmap

Milestones ship in order. Each row becomes one spec (`docs/specs/`) and one
GitHub issue via `/code-sentinel:spec`; large rows split into waves there.

## M1 — See the fleet

| # | Item | Notes |
|---|---|---|
| M1.1 | Auth: admin seed, login, registration toggle, approval with role, roles, project membership | ADR-0008 |
| M1.2 | Audit log foundation (hash chain) | every later privileged action writes here |
| M1.3 | Runner skeleton: `apps/runner`, pairing, WebSocket, heartbeat, capabilities, runtime profiles | ADR-0001, ADR-0006, [runner protocol](../architecture/runner-protocol.md) |
| M1.4 | Projects: connect by path, detection (origin, config, base, docs source) | ADR-0012 |
| M1.5 | Fleet observation: tmux / worktree / board / reply-file collectors (markdown fallback) | ADR-0002 |
| M1.6 | Sessions: Claude + Codex transcript ingestion, session tree view | ADR-0003 |
| M1.7 | Tokens & API-equivalent cost: price table seed, OTel receiver in runner | ADR-0003, ADR-0009 |
| M1.8 | Shell UI: NavRail, project switcher, fleet overview, session view | glass-ui gaps: Spinner, StatTile, DataTable, TraceTree |

## M2 — Steer the fleet

| # | Item | Notes |
|---|---|---|
| M2.1 | code-sentinel: `events.jsonl` + `state.json` | [plugin changes](../plugin/code-sentinel-changes.md) |
| M2.2 | Orchestrator control: start / stop / next / status, stop slot, message worker | runner commands |
| M2.3 | Live pane (read-only) | glass-ui LogViewer |
| M2.4 | Task queue from GitHub + create issue | ADR-0004 |
| M2.5 | Merge approval queue | per-project switch |
| M2.6 | Activity feed + execution history | glass-ui Timeline |
| M2.7 | In-app notifications + Telegram bot | |

## M3 — Automate

| # | Item | Notes |
|---|---|---|
| M3.1 | Skills: skills.sh catalog, install, run with profile + model, report-or-PR | |
| M3.2 | Cron schedules + missed-run policy | |
| M3.3 | Webhooks: inbound triggers, outbound deliveries | |
| M3.4 | GitHub App: issue / PR / check events | ADR-0004 |
| M3.5 | Budgets: per project / per user, alert or hard stop | |
| M3.6 | Interactive terminal attach (admin only, audited) | |

## M4 — Codex

| # | Item | Notes |
|---|---|---|
| M4.1 | code-sentinel: `dispatch.sh --runtime codex` | ADR-0013 |
| M4.2 | Codex worker fence: worktree + sandbox + pre-merge ownership check | ADR-0013 |
| M4.3 | Codex as orchestrator (skill port) | |
