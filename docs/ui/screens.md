# Screens

Information architecture for `apps/web`. Layout: `NavRail` on the left, project
switcher at its top, `CommandPalette` on ⌘K, live updates everywhere over the
UI WebSocket.

| Screen | Content | Milestone |
|---|---|---|
| **Overview** | across projects: running slots, blocked on a person, merged today, cost today/7d (StatTiles), runner health | M1 |
| **Project → Fleet** | orchestrator status + controls; slots table (slot, issue, runtime/model, checkpoint, PR + checks, age); slot detail: brief, fence, checkpoints, live pane, sessions, cost | M1 / M2 |
| **Project → Queue** | ready issues with computed state and reason; held-for-lead; Board view; create issue | M2 |
| **Project → Approvals** | green PRs awaiting a person when merge approval is on | M2 |
| **Project → History** | rounds, slots, runs with outcome, duration, PR, cost | M2 |
| **Project → Skills** | installed skills, run a skill (profile, model, args, report/PR), runs | M3 |
| **Project → Schedules** | cron rules, next runs, last results | M3 |
| **Project → Settings** | docs source, base, ready label, default profile, merge approval, runtime policy, budget, members | M1+ |
| **Sessions** | all sessions (filtered by access): runtime, model, project/slot, tokens, cost; session detail with TraceTree | M1 |
| **Activity** | global feed with filters (project, type, actor) | M2 |
| **Usage** | cost/tokens by project, model, runtime, user, day; price table (admin) | M1 / M3 |
| **Skills catalog** | skills.sh search, details, install | M3 |
| **Runners** (admin) | pair, status, capabilities, profiles, revoke | M1 |
| **Users** (admin) | pending approvals, roles, disable, registration toggle | M1 |
| **Integrations** (admin) | GitHub App, Telegram bot, webhooks + delivery log, inbound triggers | M2 / M3 |
| **Audit** (admin) | filterable log, chain verification status | M1 |
| **Notifications** | in-app centre; Telegram link | M2 |
