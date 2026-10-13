# Screens

Information architecture for `apps/web`. Layout: `NavRail` on the left, project
switcher at its top, `CommandPalette` on ⌘K, live updates everywhere over the
UI WebSocket.

| Screen | Content | Milestone |
|---|---|---|
| **Overview** | for an admin, the Getting started checklist until setup is done (see "First run"); your projects with their runner's status; later: running slots, blocked on a person, merged today, cost today/7d (StatTiles) | M1 |
| **Project → Fleet** | the project's runner banner when it is offline; orchestrator status + controls (Start and Stop say why they are off and link to the fix: runner offline, no runtime profile, already running, not running); slots table (slot, issue, runtime/model, checkpoint, PR + checks, age); an empty fleet explains slots and rounds; slot detail: brief, fence, checkpoints, live pane, sessions, cost, with a hint under each term | M1 / M2 |
| **Project → Queue** | runner banner; ready issues with computed state and reason; an unreadable queue is a banner naming the cause; an empty queue says how an issue gets in; held-for-lead and the round footer are explained; Board view; create issue | M2 |
| **Project → Approvals** | runner banner; green PRs awaiting a person when merge approval is on; with approval off the empty state says so and links to Settings; the mismatch banner links to Settings; a decision that cannot be taken says why | M2 |
| **Project → History** | runner banner; rounds, slots, runs with outcome, duration, PR, cost; filtered by kind (`?kind=skill`), status and dates, with unapplied changes shown; "no matches" and "nothing yet" are different | M2 |
| **Project → Skills** | runner banner; installed skills, run a skill (profile, model, args, report/PR); Run says why it is off when the project has no default profile; Rescan on the empty state; Recent runs link; runs | M3 |
| **Project → Schedules** | runner banner; cron rules, next runs, last results; a disabled schedule says why in a sentence; the empty state carries New schedule | M3 |
| **Project → Settings** | docs source, base, ready label, default profile, merge approval, runtime policy, budget, members | M1+ |
| **Sessions** | all sessions (filtered by access): runtime, model, project/slot, tokens, cost; session detail with TraceTree. A failed load is "Sessions are not answering" with Try again, never an empty list; no matches offers Clear filters, nothing yet points to Runners (admin) or Projects; unapplied filter changes are flagged; "not yet read" explains an unparsed transcript | M1 |
| **Activity** | global feed with filters (project, type, actor); same load-failure, no-matches and nothing-yet states as Sessions | M2 |
| **Usage** | cost/tokens by project, model, runtime, user, day; price table (admin). Unpriced requests say an administrator fixes them under Admin › Prices; an empty range for one project offers "Show all projects" | M1 / M3 |
| **Skills catalog** | skills.sh search, details, install. With no project an admin sees "Connect a project first"; project options show the runner's state and an offline runner gets the shared banner | M3 |
| **Account** | profile, password, signed-in devices | M1 |
| **Install** (`/install`, public) | no shell, works signed out: what the runner is and what it needs (tmux, git, signed-in `gh`, Claude Code and/or Codex); install (Homebrew, npm or Bun, from source; macOS and Linux, arm64 and x64) and `agentdock-runner version`; pair with this server (the command built from the page's origin + `/api`, the code's 10-minute TTL; an admin gets Add runner → `/admin/runners?add=1`); keep it running; profiles; troubleshooting. Every command comes from `lib/runners/install.ts`. Linked from Login, Getting started, the pairing dialog, the Connect dialog's runner banner, the Runners empty state and the runner-offline banner | M1 |
| **Runners** (admin) | pair (numbered install / pair / keep-online steps), status with the next step for a runner that is not online, capabilities, profiles, revoke | M1 |
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
| **Notifications** | in-app centre; Telegram link; rules (the Telegram column links to the link card until a chat is linked); muted projects (Mute states why it is off). Each card shows its own load failure with Try again | M2 |

## States every screen follows

A user who has never read `docs/` always knows why something cannot be done and
where to fix it (issue #132). The shared pieces live in `apps/web`:

| Rule | Piece |
|---|---|
| A disabled control has a visible reason, written as the next step | `DisabledReason` under the button row (`components/prerequisites/`); never a `Tooltip` on a disabled `Button` |
| A section is loading, unavailable or empty — never an error shown as "no data" | `useSection` (`lib/section/`) keeps the last data on error and exposes `retry`; `AsyncSection` renders `Skeleton` / `SectionUnavailable` + Try again / `EmptyState` |
| A missing prerequisite is a banner with a link | `PrerequisiteBanner { tone, title, body, href, cta }`; facts from `usePrerequisites()` (`lib/prerequisites/`); `RunnerOfflineBanner` under a project page's h1; `serverEnvRemedy` for a server variable |
| An error toast carries its fix | a `describe…Error` helper may return `{ text, href?, cta? }`; `useErrorToast()` adds an action that navigates |

## Look and feel (issue #159)

Every screen builds on the same shared pieces. A screen does not write its own
version of one of them.

| Rule | Piece |
|---|---|
| One page title shape | `PageHeader { title, description?, actions?, eyebrow?, id? }` (`components/page-header/`): the h1 is 28 px, semibold, with tight tracking, and the actions sit on the right and wrap below on a phone. The browser title comes from the root template `%s · AgentDock` |
| Dates and numbers are formatted in one place, in one locale (`en-US`, the browser's timezone) | `lib/format`: `formatDate(v, 'date' \| 'day' \| 'datetime' \| 'time')`, `formatRelative`, `formatAbsolute`, `formatDuration`, `formatNumber`, `formatCost` (blank when unpriced, `<$0.01`), `formatTokens` (k/M/B) and `pluralize`. A missing value is `''`, never "Invalid Date". `<Time value format?>` (`lib/format/time`) shows relative text, puts the exact instant in `title` and `dateTime`, and updates every minute |
| Figures line up | the `num` class (tabular numerals, right-aligned in a `td`/`th`). glass-ui `Table` is already tabular |
| Nothing scrolls the page sideways at 390 px | `ScrollX { edgeClassName?, label? }` (`components/scroll-x/`) wraps a wide table. It is glass-ui `ScrollHintRow`, with a fade only on the side that has more. Use `from-surface` inside a card |
| Agent-written text is rendered, never dumped | `Markdown { children, compact? }` (`components/markdown/`): react-markdown with GFM. Raw HTML is dropped, links pass `safeHref` (http(s), mailto, in-app paths), bare URLs become links, fenced code goes to glass-ui `CodeBlock`, tables sit in `ScrollX`, and headings are demoted below the page h1 |
| The brand is one mark | `Logomark { size, accent?, title? }` and `Wordmark { size, accent? }` (`components/brand/`). `app/icon.svg` and `app/apple-icon.tsx` draw the same geometry (`LOGOMARK_PATH`) |
| Type | Inter (`--font-inter`, after SF Pro in glass-ui's `--font-sans`) and JetBrains Mono (`--font-mono`), both through `next/font` in the root layout. Code, ids and commands use `font-mono` |

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
