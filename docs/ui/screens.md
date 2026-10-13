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
| **Users** (admin) | pending approvals, roles with a one-line hint each, disable, delete (says what goes with the account); a change to or from admin is confirmed; your own row cannot be disabled or deleted; an empty Pending tab says when registration is closed and links to Settings | M1 |
| **Settings** (admin) | registration toggle | M1 |
| **Integrations** (admin) | overview of the four integrations with their status (a failed one reads "Status unavailable"); GitHub App, Telegram bot, webhooks + delivery log, inbound triggers | M2 / M3 |
| **GitHub App** (admin) | without `APP_ENCRYPTION_KEY` a banner, and both register paths off with a reason; the manual card lists permissions, events, the absolute webhook URL and where GitHub shows the App ID and key; an inactive or failing webhook links to the App's Recent deliveries | M2 |
| **Telegram** (admin) | bot status with what "Polling" means; Remove bot is confirmed with who stops getting notifications; the test message links to Account › Notifications for linking | M2 |
| **Webhooks / Triggers** (admin) | Save always shows why it is off; "Delivery paused (receiver failing)" and Resume deliveries; event descriptions; the trigger's absolute URL with copy | M3 |
| **Budgets** (admin) | every budget; "Recompute budget totals", linked to Prices' "Re-price requests" | M3 |
| **Prices** (admin) | price versions, model table, test calculator, "Re-price requests"; with no version, the seed command | M3 |
| **Schedules** (admin) | every project's schedules (created on the project) and the API's system jobs, in UTC | M3 |
| **Audit** (admin) | filterable log with labelled actions; chain verification status — a broken chain says what it means and what to do | M1 |
| **Notifications** | in-app centre; Telegram link | M2 |

## States every screen follows

A user who has never read `docs/` always knows why something cannot be done and
where to fix it (issue #132). The shared pieces live in `apps/web`:

| Rule | Piece |
|---|---|
| A disabled control has a visible reason, written as the next step | `DisabledReason` under the button row (`components/prerequisites/`); never a `Tooltip` on a disabled `Button` |
| A section is loading, unavailable or empty — never an error shown as "no data" | `useSection` (`lib/section/`) keeps the last data on error and exposes `retry`; `AsyncSection` renders `Skeleton` / `SectionUnavailable` + Try again / `EmptyState` |
| A missing prerequisite is a banner with a link | `PrerequisiteBanner { tone, title, body, href, cta }`; facts from `usePrerequisites()` (`lib/prerequisites/`); `RunnerOfflineBanner` under a project page's h1; `serverEnvRemedy` for a server variable |
| An error toast carries its fix | a `describe…Error` helper may return `{ text, href?, cta? }`; `useErrorToast()` adds an action that navigates |

**Live updates.** The header dot reads the UI WebSocket. After more than 5 s
without it, the shell shows a warn banner — "Live updates paused. This page may
be out of date." with Reload. A page that shows the socket's state uses
`LiveStatusBadge`: Live, Reconnecting…, or Live updates paused — never
"Offline", which reads as the runner.
