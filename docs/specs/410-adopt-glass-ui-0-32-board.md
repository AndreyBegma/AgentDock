# Adopt glass-ui 0.32.0 on the Board: collapsible columns per the C-29 mockup, plan tasks not movable

Issue: #410 · Board cards: C-43 (AgentDock half) and C-44 (AgentDock half)

## What to do

glass-ui 0.32.0 is published (`@andrewbehma/glass-ui`, release PR AndreyBegma/glass-ui#153). It adds:
- a per-item `movable` flag on the kanban `Board` (glass-ui #146);
- collapsible columns, a fixed column header with a scroll shadow, a fixed column footer slot, a scroll region per column and a count slot that can show `1/3` (glass-ui #149);
- `ResizableFrame` keeping the dragged edge under the pointer when a drag crosses the centred/left-aligned boundary (glass-ui #151; AgentDock #394 left this as a known limit).

Bump the exact pinned version in `apps/web/package.json` (and `bun.lock`) from 0.31.0 to 0.32.0 and use the new parts:

1. **Plan tasks are not movable (C-44).** Plan-task items on the Board (ADR-0028: read-only, their column is derived from the plan) pass `movable: false`, so they show no drag handle and no move entries; the API's refusal toast for them can no longer be reached from the UI.
2. **The Board matches the C-29 mockup (C-43).** Use the new column parts per `docs/specs/card-29-change-board/design/1.html`: collapsible columns, the fixed header with the scroll shadow, the footer slot (e.g. "Show older completed cards"), the per-column scroll region, and the `filtered/total` count where a filter is on. Keep the per-column scroll fixed in #384 (C-39) working.
3. **Design viewer.** No code change expected; check that a frame drag across the centred/left-aligned boundary now keeps the edge under the pointer.

## Acceptance criteria

- [ ] `apps/web/package.json` pins `@andrewbehma/glass-ui` to `0.32.0` exactly; `bun.lock` updated with `bun install`.
- [ ] A plan-task item on the Board cannot be dragged and shows no move entries in its menu; Board cards move as before (web test).
- [ ] Board columns can be collapsed and expanded (mouse and keyboard); the header stays fixed with a shadow while the column scrolls; the footer shows "Show older completed cards" where it applies; with a filter on, the count shows `n/total`.
- [ ] Every column still scrolls on its own and the page body does not scroll on a desktop window (the C-39 check).
- [ ] Before/after screenshots of the Board in the PR.
- [ ] `bun run check` and the web tests pass.

## Out of scope

- The card face redesign (C-35).
- Changing column widths, density modes or the toolbar.
