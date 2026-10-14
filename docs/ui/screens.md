# Screens

Information architecture for `apps/web`. Layout: `NavRail` on the left, project
switcher at its top, `CommandPalette` on ⌘K, live updates everywhere over the
UI WebSocket.

**The shell** (`components/shell/`). A skip link comes first. The rail has three
sections: Workspace (Overview, Projects, Activity, Tasks, Sessions, Usage,
Workflows, Skills), then the open project's pages under its name (Planner among them),
then Admin (its Planner entry opens the instructions editor), folded into one
group. That group unfolds by itself on an admin page and remembers its state
per browser. Exactly one item is active: the longest matching href wins, and
`/` and `/projects` match only exactly. Integrations goes to the hub,
`/admin/integrations`. The active item is scrolled into view, and the rail
fades at whichever edge has more. The project switcher is a button with the
project's name, its runner's status and a chevron. Breadcrumbs come from data
(`crumbsFor`): the project's name, `#155 · i155` for a run, the session's
title. An unknown id is never title-cased. Client pages take the tab title
from the last crumb. Below 1024 px the rail keeps its tooltips, and the top
bar shows the page title with a back link. The palette (⌘K) lists the
project's pages as "Project › Page", Recent sessions and runs, and Admin as a
group of its own, so no group label repeats on its rows. Gaps waiting on
glass-ui: NavRail has no collapsible group, no scroll fade and no badge, so
those are stop-gaps here.

| Screen | Content | Milestone |
|---|---|---|
| **Overview** | for an admin, the Getting started checklist on top until setup is done (see "First run"), the dashboard below it: StatTiles for running slots, cost today, PRs merged today (a merge reported twice counts once) and approvals waiting; a clickable card per project (runner status, orchestrator state, last round, live slots, 7-day cost Sparkline); "Needs you" — blocked slots, slots waiting on a prompt, PRs waiting for approval, oldest first; recent activity. Each section loads and fails on its own; a project that does not answer is named, never counted as zero | M1 |
| **Projects** | one row per project: runner, orchestrator state, slots, last activity and a 7-day cost with a sparkline (from each project's fleet and one usage timeseries; a failed source shows a dash); the whole row opens the project | M1 |
| **Project → Fleet** | the project's runner banner when it is offline; orchestrator status + controls (Start and Stop say why they are off and link to the fix: runner offline, no runtime profile, already running, not running; Stop is hidden while the orchestrator is not running; Refresh is an icon button); an unreadable board is a warn banner with collapsible detail and Copy path; "scraped" is explained in a sentence; slots table (slot, issue, runtime/model, checkpoint, PR + checks, age; the row opens the slot); an empty fleet explains slots and rounds; slot detail: brief, fence, checkpoints, live pane, sessions, cost, with a hint under each term | M1 / M2 |
| **Project → Fleet — agent workspace** (#160, `?open=i42,i43&focus=i42&view=list`) | a `MetaBar`: the project name, the orchestrator as a pill (Live · Active · Not running), counters for agents, worktrees, running, blocked (toned only when non-zero) and completed; New issue (primary, operators; the Queue's dialog in place), fit to view, orchestrator settings, a view menu (Agent tree · All slots, the table above). The tree is a `FlowGraph` (TB): the orchestrator on top, a `NodeCard` per slot in its identity hue (`slotHue`) with the status pill and glow, the issue, runtime · model, progress by stage (picked up 10 → merged 100), `worktree: <branch>` and a one-line prompt that sends "message worker"; planned siblings show as Planned without a prompt; the orchestrator's prompt is disabled with its reason until #189. Clicking a node opens it (`open` + `focus`); the orchestrator opens its card (controls, board error) in a sheet. Below: "Dependencies & Flow" (layered LR, with Build / run and Test results sinks from PR checks, and the legend depends on / delegates to / returns result) beside the quick actions (New issue, Message orchestrator = terminal attach for admins, Open worktree in terminal, View dependencies, Pause all = stop the orchestrator, Stop all = the orchestrator and every live slot, one confirmation listing them, Collapse all). `DockTabs` along the bottom for the opened agents, "N agents running". Empty states: the orchestrator is not running (Start, or why not, and that AgentDock does not create agents itself); the queue is empty (New issue, Plan the next wave → Planner `?brief=`). Below 1024 px the tree is a vertical list of the same cards and the panel a sheet | M3.7 |
| **Project → Fleet → agent panel** (#160, `fleet/slot-panel/`) | from `lg` a resizable `SidePanel` column beside the canvas (width remembered), below `lg` a bottom sheet. Header: identity dot, slot name, status pill, issue and title, close; Stop slot (operators, with a confirmation). Tabs: **Chat** (`ChatThread` of the orchestrator's messages and the worker's reply sections with a checkpoint badge, bodies through the shared `Markdown`; the composer sends "message worker" with an optimistic entry: sending, then delivered until the runner sees it, or "Not sent" with Retry and Discard; off with a reason for a viewer or an ended slot), **Context** (round, issue, model and why, lead, branch, the `owns:` / `never:` fence), **Worktree** (asked of the runner only while open, with Refresh: branch, HEAD, base, ahead/behind, uncommitted counts, last 5 commits, "Change branch" disabled with the reason; runner offline / no answer / refused each say so in a sentence), **Files** (status letter, path, +/−, "N more not shown"), **Tests** (PR, state, checks badge, mergeable; the worker's last "implementation done" section as the local check result), **Settings** (runtime, model, the runtime profile, a link to project settings), **Pane** (the live pane and Attach terminal). Under every tab, Sub-agents and Dependencies (waits for / blocks) from the fleet graph, each opening that slot. A slot on the plan with no run yet says it is not dispatched | M3 |
| **Project → Queue** | runner banner; ready issues with computed state and reason; an unreadable queue is a banner naming the cause; an empty queue says how an issue gets in; filter chips in sentence case with count badges; the row opens the issue; held-for-lead counts slots (not issues) and says so, with the round footer; Board view; New issue is the primary action | M2 |
| **Project → Approvals** | runner banner; green PRs awaiting a person when merge approval is on; with approval off the empty state says so and links to Settings; the mismatch banner links to Settings; a decision that cannot be taken says why; "Recent decisions" appears only once there is one | M2 |
| **Project → History** | runner banner; rounds, slots, runs with outcome, duration, PR, cost; filtered by kind (`?kind=skill`), status and dates, with unapplied changes shown; abandoned runs are hidden by default ("N abandoned runs hidden · Show"); filters collapse behind a button on a phone; "no matches" and "nothing yet" are different. Run detail: outcome and checkpoints render as Markdown, a per-type actor icon (person, runner, orchestrator, system), a title that is never blank | M2 |
| **Project → Skills** | runner banner; installed skills (a plugin skill found in several profiles is one row, "in 5 profiles"), run a skill (profile, model, args, report/PR; Run is an icon button, shown on row hover and focus); Run says why it is off when the project has no default profile; Rescan on the empty state; Recent runs link; runs | M3 |
| **Project → Schedules** | runner banner; cron rules, next runs, last results; a disabled schedule says why in a sentence; the empty state carries New schedule | M3 |
| **Project → Planner** (`/projects/[projectId]/planner`) | the composer on top: a large brief textarea, the mode (`SegmentedControl`: Batch · Dialogue), model and profile (`Select`), Plan as the primary action. Below it the plan list: title, author, a visibility chip (a private plan shows a lock), status, task counts by status, updated time. A plan row opens the plan view; `?brief=` pre-fills the composer (the Fleet link from #160) | M3.7 |
| **Project → Planner → Plan** (`/projects/[projectId]/planner/[planId]`) | header: plan title and version, visibility with Share with project, Revise plan (on only while a rewrite is pending), Send to fleet (on per D8; it confirms with the issues it will create and the publication mode). Left, the task cards (kind icon and colour, title, summary, status pill, "2 blocking", approve / reject / rewrite). Centre, the plan graph (`FlowGraph`, dependencies left to right, coloured by kind; after sending each node shows its live status and links its issue and pull request); in dialogue mode before decomposition the centre shows the plan-level question rounds instead. Right panel for the open task (`?task=<key>`): Conversation (question cards with a recommendation badge, option radios, a free-text answer, Accept all recommendations, one submit per round, earlier rounds collapsed, a chat composer), Document (shared `Markdown`), History (plan versions the task appeared in). A running turn shows a `Spinner`, the live log line and Cancel; a failed turn shows its error with Retry turn, and a `contract_violation` puts the raw output in a `Disclosure` | M3.7 |
| **Tasks** (`/tasks`) | every task of the plans the caller can read, across projects, in a DataTable: project (identity hue), plan, key and title, kind, status pill (draft through merged; an issue not queued yet reads "Issued"), issue and pull request links, relative updated time. Filters (search, project, kind, status) live in the URL (`?projectId=…&kind=bug&status=pr_open&q=…`) and collapse behind one "Filters" button at 390 px; the row opens the task in its plan (`/projects/[projectId]/planner/[planId]?task=<key>`); the table scrolls inside its own box. A failed load is "Tasks are not answering" with Try again, never an empty list; no matches offers Clear filters, nothing yet points to Projects; Load more pages by cursor, and the first page refreshes every 15 s | M3.7 |
| **Planner instructions** (admin, `/admin/planner`) | the global default instructions in a monospace editor; Save new version, Discard changes and Show my changes (a line diff against the current version); a version list with author and date, a Diff against the previous version, and Restore, which loads the old text into the editor so Save writes it as a new version; the fixed output contract, read-only, folded below. A failed load is "The instructions could not be loaded" with Try again | M3.7 |
| **Project → Settings** | docs source, base, ready label, default profile, merge approval, runtime policy, budget, members; a Planner tab with the specification output (Docs pull request · Issue body; project admins change it) and this project's instructions override, with the same editor, versions, diff, Restore and read-only contract as the admin page (an empty override is saved as "Clear override" and falls back to the global instructions); Remove project sits in a Danger zone, the GitHub App card shows one state and links to Admin › Integrations | M1+ |
| **Sessions** | all sessions (filtered by access) in a DataTable whose rows open the session: name, relative start, project/slot, runtime and models, right-aligned tabular turns, requests, tokens, cost, duration; a compact filter bar (Model, Slot, Unassigned under "More filters"; one "Filters" button on a phone). Session detail is a TraceTree — turns, model requests and tool calls interleaved by start time, with waterfall bars and a failed tool in the danger tone — beside a KeyValueList of the selected node's facts and tokens. A failed load is "Sessions are not answering" with Try again, never an empty list; no matches offers Clear filters, nothing yet points to Runners (admin) or Projects; unapplied filter changes are flagged; "not yet read" explains an unparsed transcript | M1 |
| **Activity** | global feed: hairline `Timeline` rows with an icon per category and tinted chips (slot, issue, PR); the event code only in the tooltip; runner actors by name; consecutive items about one slot or PR fold into one row that opens in place. A compact `Toolbar` (project, category) with "More filters" (type by readable name, actor by name, slot, dates) in a `Popover`; the filter state is the URL (`?category=fleet&slot=i154&from=2026-10-01`). Same load-failure, no-matches and nothing-yet states as Sessions. A re-sent reply section is one item (spec 11 note 17) | M2 |
| **Usage** | cost/tokens by project, model, runtime, user, day; price table (admin). "Cost over time" is a stacked glass-ui Chart per day or hour (zero-filled buckets, a $ y-axis, a tooltip per runtime with the total); tile sparklines are clipped to the tile and left out under two non-zero points; the breakdown scrolls inside its box at 390 px and its rows open the project; "No project (machine-wide)" explains itself in a tooltip. Unpriced requests say an administrator fixes them under Admin › Prices; an empty range for one project offers "Show all projects" | M1 / M3 |
| **Workflows** (`/workflows`) | how agents work across sessions, as distinct from Usage's cost. The unit is a root session with its subagent tree. A `MetaBar` header: the Live pill (polls every 35 s while the tab is visible; "Not updating" after a failed load), Sessions · Active · Ended counters, the status segment (All sessions · Active only · Ended — "Ended", not "Completed", because an ended session can also have failed or been abandoned), Refresh, Export (summary, orchestration links and tool transitions as CSV, everything as JSON) and "Updated hh:mm". Filters: range presets or custom days, project, and the runtime profile (operator+, once a project is chosen). Six `StatTile`s, each hint its definition: average depth, average subagents, success rate (completed ÷ ended; abandoned is not a success), top tool flow, average compactions, average duration; no data is "—", never 0. **1. Agent orchestration**, a `Sankey`: Sessions → main agent → subagent type (top 8, "+N more", Unknown type, No subagents) → compactions → outcome. A node click filters the whole page on that node, a second click clears it, and the Sessions node clears every graph filter. Active graph filters are removable chips. **2. Tool execution flow**, a two-column `Sankey` (Tool → Next tool, so loops draw left to right) with the same transitions in a table with count and error share. Every filter is in the URL (`?range=30d&projectId=…&status=ended&agentType=Explore&outcome=error`). Each section loads and fails on its own (`SectionUnavailable` with Try again keeps the data it had); a hidden project is "Project not found"; an empty scope names what narrowed it and offers to undo it. At 390 px the Sankeys scroll inside their card and "Show table" is their table | M3 |
| **Skills catalog** | skills.sh search, details, install. Before typing: suggested searches (one tap fills the field) and the skills installed in the project, each once ("in 5 profiles"), linked to Project → Skills. With no project an admin sees "Connect a project first"; project options show the runner's state and an offline runner gets the shared banner | M3 |
| **Account** | profile (role by name), password, signed-in devices as a list that fits a phone: "Chrome 155 on macOS" with the raw user agent in the tooltip, relative times; Sign out on this device is neutral, Revoke on another is danger | M1 |
| **Runners** (admin) | pair (numbered install / pair / keep-online steps), status with the next step for a runner that is not online; the table shows profiles, capabilities and "load 1/5/15 min" inline, and the whole row opens the sheet (visible Close; Revoke is confirmed and sits in its Danger zone) | M1 |
| **Users** (admin) | opens on Active (or the first tab with accounts), a count on every tab, the registration switch above them; pending approvals, roles with a one-line hint each, disable, delete (says what goes with the account); a change to or from admin is confirmed; your own row cannot be disabled or deleted; an empty Pending tab says when registration is closed and points to the switch above | M1 |
| **Settings** (admin) | no page of its own: the registration toggle is the "Open registration" card on Users, above the tabs it governs; `/admin/settings` redirects to Users | M1 |
| **Integrations** (admin) | overview of the four integrations, each with an icon, its status (a failed one reads "Status unavailable") and one primary action ("Set up …" or "Manage …"); the pages open under their own titles; webhooks loads the project list only when its dialog opens; GitHub App, Telegram bot, webhooks + delivery log, inbound triggers | M2 / M3 |
| **Login / Register / Pending** (public) | a branded, centred hero (logomark, wordmark, one line on what AgentDock is) over the form card (`components/auth-card.tsx`). A signed-in user on `/login` is sent to a safe `next` or `/`, decided on the server from `/auth/me`. A stale cookie or an API that is down still shows the form | M1 |
| **Not found** | branded 404 with Back to Overview and Projects | M1 |
| **Install** (`/install`, public) | no shell, works signed out, and reads like a product page: the value proposition, the system choice (macOS / Linux), then a numbered stepper Install → Pair → Keep running, with 15 px body text. What the runner is and what it needs (tmux, git, signed-in `gh`, Claude Code and/or Codex); install (Homebrew, npm or Bun, from source; macOS and Linux, arm64 and x64) and `agentdock-runner version`; pair with this server (the command built from the page's origin + `/api`, the code's 10-minute TTL; an admin gets Add runner → `/admin/runners?add=1`); keep it running; profiles; troubleshooting. Every command comes from `lib/runners/install.ts`. Linked from Login, Getting started, the pairing dialog, the Connect dialog's runner banner, the Runners empty state and the runner-offline banner | M1 |
| **GitHub App** (admin) | without `APP_ENCRYPTION_KEY` a banner, and both register paths off with a reason; the manual card lists permissions, events, the absolute webhook URL and where GitHub shows the App ID and key; an inactive or failing webhook links to the App's Recent deliveries | M2 |
| **Telegram** (admin) | bot status with what "Polling" means; Remove bot is confirmed with who stops getting notifications; the test message links to Account › Notifications for linking | M2 |
| **Webhooks / Triggers** (admin) | Save always shows why it is off; "Delivery paused (receiver failing)" and Resume deliveries; event descriptions; the trigger's absolute URL with copy | M3 |
| **Budgets** (admin) | every budget; with none, only one primary "New budget" (no filters, no recompute); "Recompute totals", linked to Prices' re-pricing, once a budget exists | M3 |
| **Prices** (admin) | price versions; models grouped by provider — "Models you used" (last 30 days) open first, the rest folded, long tables windowed, patterns in mono and truncated; test calculator, "Re-price requests"; with no version, the seed command | M3 |
| **Schedules** (admin) | every project's schedules (created on the project) and the API's system jobs, in UTC | M3 |
| **Audit** (admin) | filterable log (Action, Result and Actor up front, the rest under "More filters") with labelled actions, targets by name (the id is the tooltip), one-line dates, and rows that open the record; chain verification status, with what "Verify now" does — a broken chain says what it means and what to do | M1 |
| **Notifications** | in-app centre; Telegram link; rules grouped by area (orchestrator and slots, runners, budgets, schedules), each with an example in words ("Slot i19 · luna-watch is blocked") and the source events only in the tooltip; the Telegram column stays off until a chat is linked; muted projects (Mute states why it is off). Each card shows its own load failure with Try again | M2 |

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
