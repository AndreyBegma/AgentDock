# glass-ui in AgentDock

[glass-ui](https://github.com/AndreyBegma/glass-ui) is the only component
library (ADR-0011). Releases are tags on `main`, cut from `develop` through a release PR; `v0.21.0` ships the M1 desk primitives (glass-ui#67), `v0.22.0` the M2 activity primitives (#70), the next minor the M3 automation primitives (#74).

## Consumption

- Dependency: `"glass-ui": "github:AndreyBegma/glass-ui#<tag>"`; local work via
  `bun link`.
- Next: `transpilePackages: ['glass-ui']` (it ships TypeScript source).
- CSS: `@import "glass-ui/tokens.css"; @import "glass-ui/material.css";
  @import "glass-ui/base.css";`
- Root: `data-scale="desk"`, theme via `data-theme` (dark default),
  `data-material="flat"` fallback. `id="main-content"` on the main region.
- Import by subpath (`glass-ui/button`), never the barrel.
- Tokens only — no hex, `rgb()` or Tailwind palette colours. Glass for chrome
  (header, bars, sheets, dialogs, menus); rows and cards stay solid.

## What exists and where it is used

| Need | glass-ui |
|---|---|
| app navigation | `NavRail`, `AppRail`, `SidePanel`, `Breadcrumb`, `CommandPalette` (⌘K) |
| lists / tables | `Table*` (styled markup), `Toolbar`, `RowActions` |
| queue board | `Board` (kanban) |
| status | `Badge` (tone, `dot`), `Progress` (determinate), `Skeleton`, `EmptyState`, `SectionUnavailable` |
| forms | `Field`, `Input`, `Select`, `Combobox`, `Toggle`, `Checkbox`, `RadioGroup`, `NumberInput`, `DateInput`, `Textarea` |
| overlays | `DialogRoot`, `SheetRoot`, `Menu*`, `ContextMenu*`, `Popover*`, `Tooltip`, `toast` |
| misc | `Tabs`, `SegmentedControl`, `Disclosure`, `Tree`, `Avatar`, `KeyHint`, `Separator` |

## Components to add to glass-ui

Each is its own spec in this repository's queue (or glass-ui's), its own PR in
glass-ui, and a new tag. Ordered by first milestone that needs it.

| Component | Purpose | First needed |
|---|---|---|
| `Spinner` | indeterminate activity (running slot, pending command) | M1 |
| `StatTile` | KPI tile: value, delta, caption, optional sparkline slot | M1 |
| `Sparkline` | tiny inline trend (tokens/cost over time) | M1 |
| `DataTable` | on top of `Table`: sortable columns, selection, sticky header, virtualization, column visibility | M1 |
| `TraceTree` / `Waterfall` | nested turn → request/tool/subagent tree with time bars and per-node totals | M1 |
| `KeyValueList` | dense label/value pairs for detail panels | M1 |
| `CodeBlock` | monospace block, copy button, wrapping toggle | M1 |
| `LogViewer` | streaming monospace lines, ANSI colours, follow-tail with pause, virtualization, search | M2 |
| `Timeline` / `ActivityFeed` | time-grouped event list with icons, actors, links | M2 |
| `Banner` | inline alert (info / warn / danger) with action | M2 |
| `SplitPane` | two-way resizable split (list + detail, log + metadata) | M2 |
| `Chart` primitives | area/bar series for usage dashboards, token-styled | M3 |
| `CronInput` | cron expression editor with human-readable preview and next runs | M3 |
| `Terminal` | xterm.js wrapper, themed by tokens | M3 |
