# Screens

Information architecture for `apps/web`. Layout: `NavRail` on the left, project
switcher at its top, `CommandPalette` on ⌘K, live updates everywhere over the
UI WebSocket.

| Screen | Content | Milestone |
|---|---|---|
| **Overview** | across projects: running slots, blocked on a person, merged today, cost today/7d (StatTiles), runner health | M1 |
| **Project → Fleet** | the project's runner banner when it is offline; orchestrator status + controls (Start and Stop say why they are off and link to the fix: runner offline, no runtime profile, already running, not running); slots table (slot, issue, runtime/model, checkpoint, PR + checks, age); an empty fleet explains slots and rounds; slot detail: brief, fence, checkpoints, live pane, sessions, cost, with a hint under each term | M1 / M2 |
| **Project → Queue** | runner banner; ready issues with computed state and reason; an unreadable queue is a banner naming the cause; an empty queue says how an issue gets in; held-for-lead and the round footer are explained; Board view; create issue | M2 |
| **Project → Approvals** | runner banner; green PRs awaiting a person when merge approval is on; with approval off the empty state says so and links to Settings; the mismatch banner links to Settings; a decision that cannot be taken says why | M2 |
| **Project → History** | runner banner; rounds, slots, runs with outcome, duration, PR, cost; filtered by kind (`?kind=skill`), status and dates, with unapplied changes shown; "no matches" and "nothing yet" are different | M2 |
| **Project → Skills** | runner banner; installed skills, run a skill (profile, model, args, report/PR); Run says why it is off when the project has no default profile; Rescan on the empty state; Recent runs link; runs | M3 |
| **Project → Schedules** | runner banner; cron rules, next runs, last results; a disabled schedule says why in a sentence; the empty state carries New schedule | M3 |
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
