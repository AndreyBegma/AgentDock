# glass-ui in AgentDock

[glass-ui](https://github.com/AndreyBegma/glass-ui) is the only component
library (ADR-0011), consumed from npm as `@andrewbehma/glass-ui`. Releases are tags on `main`, cut from `develop` through a release PR and published to npm; `v0.21.0` ships the M1 desk primitives (glass-ui#67), `v0.22.0` the M2 activity primitives (#70), `0.23.0` the npm package with compiled `dist/` (#89), `0.24.0` the look from the UI audit (canvas, accent, two surface levels, `Select`/`DateInput`, `TabBar` — #93), `0.27.0` the workspace patterns and NavRail groups (#94), `0.28.0` the navy palette, identity hues and status tokens (#109), `0.28.1` the flat navy glass button (glass-ui#127), `0.29.0` the style-system components (glass-ui#130–#135). AgentDock is on **0.29.0**.

## Consumption

- Dependency: `"@andrewbehma/glass-ui": "<version>"` in `apps/web`, pinned
  exactly; local work via `bun link`.
- Next: no `transpilePackages` entry — the package ships compiled `dist/`.
- CSS: `@import "@andrewbehma/glass-ui/tokens.css";
  @import "@andrewbehma/glass-ui/material.css";
  @import "@andrewbehma/glass-ui/base.css";` — `tokens.css` declares the
  Tailwind `@source` for the package, so nothing else is needed.
- Root: `data-scale="desk"` and `data-palette="navy"` on `<html>`; theme via
  `data-theme`, which follows the system until the person picks one (dark when
  the system says nothing); `data-material="flat"` fallback. `id="main-content"`
  on the main region.
- `<Canvas />` (the aurora) is mounted once in the root layout's `body`, outside
  every `#main-content`, and `body` has no background of its own — `html`
  paints the ground. Every page, signed in or not, sits on it.
- Import by subpath (`@andrewbehma/glass-ui/button`), never the barrel.
- Tokens only — no hex, `rgb()` or Tailwind palette colours. Glass for chrome
  (rail, top bar, tab bar, sheets, dialogs, menus); cards, tables and rows are
  `surface-content` (`Card`'s default variant).
- No hand-written focus ring: `base.css` draws it in the accent.

## Colour: accent, status, identity

Three kinds of colour, each with one job:

| Kind | Tokens / API | Goes on |
|---|---|---|
| **Accent** | `bg-accent text-on-accent`, `bg-accent-soft text-accent-ink` | the primary button, the active rail and tab item, a selected segment or toggle, chart series 1, links (`text-accent-ink underline`). Never a badge, an icon or a status. `--color-accent-ink` is text **on the tint** (since 0.24); text on the solid fill is `--color-on-accent`. |
| **Status** | `StatusPill` / `StatusDot` (`--color-status-*`), mapped from the domain in `apps/web/src/lib/status/pill.ts` | what a running thing is doing now: a slot, a run, the orchestrator |
| **Identity** | `hue` on `Card`, `Badge`, `StatTile`; keys in `apps/web/src/lib/hue.ts` (`projectHue(id)`, `slotHue(name)`) | telling things apart: a project's card and dot, a slot's dot. The same thing wears the same hue on every screen. |

`Badge` tones `ok` / `warn` / `danger` stay for health and checks (runner
online, PR checks green, budget exceeded) — a fact about a record, not a
process state.

## Navigation

- From `lg` (1024 px) up: `NavRail` — Workspace, the current project's pages
  (titled with its name), and Admin as a `collapsible` group that unfolds by
  itself while an admin page is open. Badges: the waiting-approvals count on
  Approvals, the slots that wait on a person on Fleet.
- Below `lg`: `TabBar` with five places (the workspace's outside a project,
  the project's working pages inside one) and `More`, a sheet with the project
  switcher and the remaining pages as `ActionList`s. The top bar shows the
  page title and a way up. The split is `tabBarSplit` in
  `components/shell/nav.ts`.

## What exists and where it is used

| Need | glass-ui |
|---|---|
| page backdrop | `Canvas` (the aurora, root layout) |
| app navigation | `NavRail` (groups, collapsible, badges, scroll fade), `TabBar` (below `lg`), `ActionList` (More's sheet), `Breadcrumb`, `CommandPalette` (⌘K) |
| lists / tables | `Table*`, `DataTable`, `Toolbar`, `RowActions` |
| queue board | `Board` (kanban) |
| status | `StatusPill` / `StatusDot` (process state), `Badge` (tone, `dot`, `hue`), `Progress`, `Spinner`, `Skeleton`, `EmptyState`, `SectionUnavailable`, `Banner` |
| dashboards | `StatTile` (`hue`), `Sparkline`, `Chart`, `KeyValueList` |
| activity / agents | `Timeline`, `LogViewer`, `TraceTree`, `CodeBlock`, `Terminal`, `CronInput` |
| forms | `Field`, `Input`, `Select`, `Combobox`, `Toggle`, `Checkbox`, `RadioGroup`, `NumberInput`, `DateInput`, `Textarea` |
| overlays | `DialogRoot`, `SheetRoot`, `Menu*`, `ContextMenu*`, `Popover*`, `Tooltip`, `toast` |
| misc | `Card` (`hue`), `Tabs`, `SegmentedControl`, `Disclosure`, `Tree`, `Avatar`, `KeyHint`, `Separator`, `SplitPane` |

## Added in 0.29.0

Adopted page by page under #213; until a page moves over it keeps its old
markup.

| Component | What it is |
|---|---|
| `PageHeader` | the page's one header: eyebrow, 28 px h1, `status`, description, `meta` (put `<MetaBar counters />` without `title` there) and `actions`. No back link. |
| `SectionHeader` | a section's 16/600 `h2`, with a description and an actions slot |
| `TabGroup` / `TabList` / `Tab` / `TabPanel` | the WAI-ARIA tabs for panels on one page; manual activation. `NavTabs` / `NavTab` are for destinations. `Tabs` / `TabsItem` are deprecated. |
| `SegmentedControl` `size` | `'sm' \| 'md'`; `sm` sits flush with a `Select` in a toolbar |
| `ConfirmDialog` | `{ open, onOpenChange, title, consequence?, verb, tone?, onConfirm, busy? }` |
| `Badge` axes | `size="md"` (a word, sentence case), `shape="square"` with `hue` (identity swatch), solid fill on `ok` / `warn` / `danger` counts |
| `Toolbar` | `activeFilters` + `onClearAll` draw removable chips; `collapseBelow` folds `filters` into "Filters (n)" and a Sheet |
| `EmptyState` `action` | data form `{ label, onClick }` or `{ label, href }` renders a Button |
| `TabBar` `badge` | a count or dot on a tab-bar item, like the rail's |

## The style system (canonical choice per pattern)

| Pattern | Standard |
|---|---|
| Page header | glass-ui `PageHeader {title, description, status?, meta?, actions?}`, 28 px h1. Fleet and Workflows put MetaBar's counters in `meta`. No in-page back links on desktop; the breadcrumbs do that job. |
| Actions | **One solid per screen**, the page's create or commit action, in `PageHeader` actions. Hub-card CTAs are glass. Filters apply instantly, so there are no Apply or Search buttons. |
| Filters | glass-ui `Toolbar`, with up to 3 instant Selects or a search, "More filters" in a Popover, active filters as removable chips with "Clear all", and **every filter in the URL** (`lib/filters/use-url-filters.ts`). Below `sm` it collapses to "Filters (n)" plus a Sheet. Chips are only for state counts on one dimension. |
| Collections | `DataTable` for lists of the same record; cards only on dashboards and hubs. |
| States | `AsyncSection` everywhere; `EmptyState.action` is a Button; `app/(app)/loading.tsx` and `error.tsx` exist. |
| Status | Process state uses `StatusPill` (sentence case, mapped in `lib/status/pill.ts`). `Badge` is for facts and counts only. One orchestrator vocabulary. |
| Identity | A project's hue is a **square** swatch; dots mean status. |
| Tabs | In-page panels use the ARIA `TabList`/`Tab`/`TabPanel`, plus `?tab=` in the URL. View switches use `SegmentedControl size="sm"`. Navigation uses `NavTabs`. |
| Section headings | glass-ui `SectionHeader` (16/600, with an actions slot). |
| Layout | A 16 px gutter on phone and tablet; `wide` width (max-w-7xl) for data pages. |
| Detail views | A row's detail opens in a `SheetRoot`; a live workspace uses a `SidePanel`. |
| Confirms | glass-ui `ConfirmDialog`: the title is a question, Cancel is ghost on the left, the verb is on the right. |
| Errors | `useErrorToast` everywhere, so every error carries its fix. |
| Live state | Shown only by the top-bar dot; a page shows `LiveStatusBadge` only when the connection is *not* live. |

## Missing in glass-ui

Each is its own spec in glass-ui's queue, its own PR there, and a new release.
Until then AgentDock does without it rather than drawing it here (ADR-0011).

| Gap | Effect in AgentDock |
|---|---|
| none known | `TabBarItem.badge` landed in 0.29.0 and is adopted by the shell unit (A1) |
