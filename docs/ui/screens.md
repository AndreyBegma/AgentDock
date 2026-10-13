# Screens

Information architecture for `apps/web`. Layout: `NavRail` on the left, project
switcher at its top, `CommandPalette` on ⌘K, live updates everywhere over the
UI WebSocket.

| Screen | Content | Milestone |
|---|---|---|
| **Overview** | for an admin, the Getting started checklist until setup is done (see "First run"); your projects with their runner's status; later: running slots, blocked on a person, merged today, cost today/7d (StatTiles) | M1 |
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
| **Runners** (admin) | pair (numbered install / pair / keep-online steps), status with the next step for a runner that is not online, capabilities, profiles, revoke | M1 |
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

## First run

A fresh install has an admin and nothing else. The path to a first project
(issue #132):

- **Login** goes to `?next=` when it is a same-origin path (one leading `/`),
  else to Overview. The route guard adds `next` when it sends a signed-out
  visitor to `/login`.
- **Overview → Getting started** (admins, until steps 1–5 are done; "N of 5"):
  1. admin account — always done;
  2. install the runner (`brew install andreybegma/tap/agentdock-runner` or
     `npm i -g agentdock-runner`; building from source: `apps/runner/README.md`);
  3. pair a runner — done when a runner that is not revoked has paired;
  4. keep it online — done when any runner is online; the hint is
     `agentdock-runner run`, then a service by install method (ADR-0017):
     `brew services start agentdock-runner` for Homebrew,
     `agentdock-runner install-service` (systemd on Linux, launchd on macOS)
     for npm;
  5. connect a project — done when one exists.

  Optional, not counted: install the GitHub App, invite teammates. The step in
  progress shows its commands. A non-admin with no projects is told to ask an
  administrator.
- **Runners → Add runner → pairing dialog**: install, the pair command, keep it
  online. The `--server` value is `<page origin>/api`; the API's own `API_URL`
  is offered as well when it differs and is not localhost, and comes first
  when the page itself is on localhost (in development `<origin>/api` is the
  Next rewrite, not the API — runner-protocol.md "Transport"). When the runner
  comes online the dialog says so and links to `/projects?connect=1`.
- **Projects**: with no project, an admin with no online runner is sent to pair
  one; otherwise the empty state opens Connect. `?connect=1` opens the Connect
  dialog.
- **Connect dialog**: when no runner is online, a banner above the form says
  whether none is paired (link to Runners) or which one is offline and the
  command to start it; it re-reads the runners every 10 s while open. Inspect
  and Connect say why they are disabled.
