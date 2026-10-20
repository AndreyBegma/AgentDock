# glass-ui in AgentDock

[glass-ui](https://github.com/AndreyBegma/glass-ui) is the only component
library (ADR-0011), consumed from npm as `@andrewbehma/glass-ui`. Releases are tags on `main`, cut from `develop` through a release PR and published to npm; `v0.21.0` ships the M1 desk primitives (glass-ui#67), `v0.22.0` the M2 activity primitives (#70), `0.23.0` the npm package with compiled `dist/` (#89), `0.24.0` the look from the UI audit (canvas, accent, two surface levels, `Select`/`DateInput`, `TabBar` — #93), `0.27.0` the workspace patterns and NavRail groups (#94), `0.28.0` the navy palette, identity hues and status tokens (#109), `0.28.1` the flat navy glass button (glass-ui#127), `0.29.0` the style-system components (glass-ui#130–#135), `0.30.0` `ResizableFrame` (glass-ui#139–#141). `0.34.0` the floating `BottomCapsule` the shell uses below `lg` (#521), `0.35.0` `FloatingWindow` and `Launcher` (glass-ui#161, for the assistant, #600), `0.37.0` the calm page primitives for stack S-7 (glass-ui#172, C-281 / #694). AgentDock is on **0.37.0**.

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

- From `lg` (1024 px) up: `NavRail` — Workspace, the current project's working
  pages (titled with its name: Project, Work, Activity), a **More** group under
  them (Fleet, Queue, Approvals, Token saver, Skills, Schedules,
  Settings) and Admin. More and Admin are `collapsible` groups; inside a
  project Workspace is one too. Each folds by default, unfolds by itself while
  one of its pages is open and remembers its state per browser under its own
  `localStorage` key (`railGroups` in `nav.ts` models the split, C-247).
  Badges: the waiting-approvals count on Approvals, the slots that wait on a
  person on Fleet; while More is folded Fleet's count rides More's title
  ("More · 2").
- Below `lg`: `BottomCapsule` (#521), floating clear of the screen's edges,
  with `tabSizing="content"` so no label is truncated. Three places — Overview
  · Projects · Activity outside a project, Work (the Board) · Fleet · Approvals
  inside one — and `More`, a bottom sheet with the project switcher, a "Needs
  you" `ActionList` carrying the waiting-approvals and Fleet-attention counts
  (while `BottomCapsuleTab` has no `badge`), and the remaining pages as
  `ActionList`s; a navigation closes it. The split is `tabBarSplit` in
  `components/shell/nav.ts`. The tabs never change per page or per role.
- The round `+` beside the capsule is the page's create action. A page
  registers its actions with `usePageActions` (`components/shell/use-page-actions.tsx`);
  `capsuleAction` (`components/shell/page-actions.ts`) decides: one action
  runs directly, two or more open a bottom `Sheet` listing them as an
  `ActionList` (the sheet grows out of the circle through `morphFrom`, and the
  circle is removed while it is open), none inside a project falls back to
  New work on the Board, none outside a project draws no `+`. Operator-only
  actions are dropped for a viewer first; with nothing left there is no `+`.
  Today the Board registers New work, Fleet and Queue New issue, and Schedules
  New schedule.
- The capsule's built-in spacer (6 rem plus the safe area) keeps a page's end
  clear of it; a sticky bottom bar (the planner composer's controls) sits at
  `bottom-[calc(6rem+env(safe-area-inset-bottom))]`, above it. The top bar
  shows the page title and a way up.

## What exists and where it is used

| Need | glass-ui |
|---|---|
| page backdrop | `Canvas` (the aurora, root layout) |
| app navigation | `NavRail` (groups, collapsible, badges, scroll fade), `BottomCapsule` (below `lg`, `tabSizing="content"`, the page-driven `+`), `ActionList` (More's sheet, the `+` sheet), `Breadcrumb`, `CommandPalette` (⌘K) |
| lists / tables | `Table*`, `DataTable`, `Toolbar`, `RowActions` |
| queue board, project Board | `Board` (kanban); the Board page is controlled and declines a move in `onMove` |
| status | `StatusPill` / `StatusDot` (process state), `Badge` (tone, `dot`, `hue`), `Progress`, `Spinner`, `Skeleton`, `EmptyState`, `SectionUnavailable`, `Banner` |
| dashboards | `StatTile` (`hue`), `Sparkline`, `Chart`, `KeyValueList` |
| activity / agents | `Timeline`, `LogViewer`, `TraceTree`, `CodeBlock`, `Terminal`, `CronInput` |
| forms | `Field`, `Input`, `Select`, `Combobox`, `Toggle`, `Checkbox`, `RadioGroup`, `NumberInput`, `DateInput`, `Textarea` |
| overlays | `DialogRoot`, `SheetRoot`, `Menu*`, `ContextMenu*`, `Popover*`, `Tooltip`, `toast`, `FloatingWindow` (0.35.0: a non-modal window dragged by its bar, resized from every edge and corner, minimized by Escape, its geometry persisted under `storageKey`; a bottom `Sheet` below `md`), `Launcher` (0.35.0: the round floating button with a badge that opens it, above the `BottomCapsule` below `lg`) |
| misc | `Card` (`hue`), `Tabs`, `SegmentedControl`, `Disclosure`, `Tree`, `Avatar`, `KeyHint`, `Separator`, `SplitPane`, `ResizableFrame` (0.30.0: a controlled-width frame with splitter edges — the design viewer's mockup) |

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
| `TabBar` `badge` | a count or dot on a tab-bar item, like the rail's (the shell moved to `BottomCapsule` in #521) |

## Added in 0.37.0 (stack S-7)

The calm layout of stack S-7 (approved mockup: `docs/specs/stacks/S-7-simplify-navigation-and-redesign-project/design/1/`). Pages adopt it card by card (C-282 to C-288).

| Component | What it is |
|---|---|
| breakpoints | three bands: phone below 640 px (the base), tablet 640–1023 px (`tablet:`, `max-tablet:`), desktop from 1024 px (`desktop:`, `max-desktop:`); the edges equal `sm` and `lg`. `@andrewbehma/glass-ui/breakpoints` exports `BREAKPOINTS`, the media queries and `breakpointFor(width)`. Prefer the CSS variants. |
| `useBreakpoint(serverFallback = 'desktop')` | `@andrewbehma/glass-ui/use-breakpoint`: the current band, for a difference in *what* renders. The server and the first client render answer the fallback. |
| `NavRail` `collapsed="tablet"` | folds to the 64 px icon strip only in the tablet band, by CSS, so the server HTML is right at every width; `data-collapsed="tablet"`. `collapsed={true \| false}` is unchanged. |
| `NavRailItem.primary` | the one emphasised entry (the Board): accent frame, the glyph on a solid accent tile, 38 px open / 44 px folded. One per rail. |
| `PageHeader` `primaryAction`, `overflow` | the screen's one `solid` action (data `{ label, onClick \| href, icon? }` or a node; `primaryActionOnPhone="hidden"` when the capsule's `+` carries it) and a `…` menu of everything else (`{ id, label, onSelect, icon?, tone?, disabled? }[]`). `actions` still renders before them. |
| `Section` | `@andrewbehma/glass-ui/section`: a titled block, the `SectionHeader` on the page and the body on `surface-content` (`surface="none"` for a body that is already a surface, `pad="none"` for edge-to-edge rows). |
| `ListDetail` | `@andrewbehma/glass-ui/list-detail`: list and detail stacked on a phone (or one of them, `phoneView`), side by side from tablet up at `listWidth` (default 280 px). CSS only. |
| quieter glass | under `data-palette="navy"` the glass keeps scrim, sheen, highlight, blur and shadow and drops the rim, meniscus and refraction layers. Palette colours are unchanged. |

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
| `NavRailGroup` has no `badge` | A folded group cannot carry a count on its heading; the shell appends Fleet's count to More's title ("More · 2") until glass-ui adds a group badge (C-247). |
| `Board` has no `canDrop(card, column)` | The Board page checks `boardMoveRule` in `onMove` and declines there; a refused card snaps back, and the menu's "Move to" items still list every column. |
| `Board`'s card `li` sets `min-h-(--size-row)` without `shrink-0` | In a height-bounded column the cards squash to one row instead of scrolling; `components/board/board-view.tsx` adds `[&_[data-board-card]]:shrink-0` on the board's wrapper (#384, glass-ui#147). |
| `Board`'s card menu always lists one "Move to <column>" item per other column, and `ActionList` rows are 40 px with no current mark | The card menu gets one "Move…" item that opens `components/board/move-picker.tsx` (a bottom `Sheet` of `Button` rows, 52 px, current column marked), also behind the card sheet's and the card page's Move button (#515). glass-ui's own per-column items stay in the menu until `Board` can hide them. |
| `Button`'s coarse-pointer touch target is as wide as the button | An icon button narrower than 44 px stays narrower to a finger; on the Board, the inline card-menu trigger is 20 × 44 px on a phone while every other face control is at least 44 × 44 (#497, glass-ui#160). |
| `BottomCapsuleTab` has no `badge` | The capsule's Approvals and Fleet tabs cannot carry the rail's counts; below `lg` the waiting approvals and the slots that need a person are rows of a "Needs you" `ActionList` at the top of More's sheet (`components/shell/capsule.tsx`, #521). |
| No `PhoneBackBar` (the phone way out of a full-screen layer or sheet, stack S-6) | `components/shell/phone-back-bar.tsx` composes it from `Button` and `glass-strong` with the API proposed for glass-ui (`kind`, `label`, `title`, `subtitle`, `action`, `onExit`): a 44 px Back (named "Back to <destination>") or Close in a bar at the bottom edge, above the safe area and `--keyboard-inset`, below `lg` only; `placement="inline"` puts it in a sheet's footer. `FullScreenLayer` draws it when given `onBack` or `onClose` and pads its end by 6 rem plus the safe area (#675). It moves to the glass-ui primitive once one is released.|
| `Toggle` has no `disabled` | `components/board/card-options.tsx` makes a locked toggle inert and dimmed and drops its change handler. |

`Board` was checked at 390 px for #242: its columns scroll sideways inside the
board and the page does not, so it needs no release for the phone. Below
`lg` the Board lays out for a phone, at the same breakpoint as the capsule
(`components/shell/narrow.ts`, #497), and on a coarse pointer each control on a
card, stack or plan-task face is a 44 px touch target (`components/board/tap.ts`)
while a fine pointer sees the face unchanged.
