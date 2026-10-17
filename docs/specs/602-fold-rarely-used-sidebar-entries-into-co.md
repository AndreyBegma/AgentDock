# C-247: Fold rarely used sidebar entries into collapsible More groups

Issue: #602

## What to do
The desktop sidebar (`NavRail`) shows 28 entries inside a project (see the attached screenshot), and most of them are rarely opened. Shorten it so only the working pages stay visible. Reuse the mechanism Admin already uses: a collapsible `NavRailGroup` whose open state is remembered in `localStorage`.

Changes, in `apps/web/src/components/shell/nav.ts` and `apps/web/src/components/shell/rail.tsx`:
- **Project section:** only **Project** (`project-home`), **Work** (`board`) and **Activity** (`project-activity`) stay always visible. Fleet, Queue, Approvals, History, Token saver, Skills, Schedules and Settings move into a collapsible **More** group placed directly under the project section. The order inside More stays as today.
- **Workspace section inside a project:** when the URL is under `/projects/[projectId]`, render the whole Workspace section as one collapsible group, folded by default, as Admin is. Outside a project, Workspace renders exactly as it does today.
- **Auto-open:** a folded group (project More, Workspace in a project, Admin) opens on its own when the active page is one of its entries. Use `activeEntryId` so the active entry is never hidden.
- **Remembered state:** each group's open/closed state is stored in `localStorage` under its own key (e.g. `agentdock.nav.projectMore.open`, `agentdock.nav.workspace.open`). Follow `ADMIN_OPEN_KEY` in `rail.tsx`, including the fallback to folded when storage is blocked. Pull the Admin hook into a small reusable hook rather than copying it.
- Model the split in `nav.ts` as data (for example a `primary` flag or a list of primary ids per section) so `visibleNav` and its tests describe it. Keep `tabBarSplit` and the phone `BottomCapsule` unchanged.
- Update the navigation notes in `docs/ui/glass-ui.md` / `docs/ui/screens.md` to describe the new rail.

## Acceptance criteria
- [ ] Inside a project, with every group folded, the project section shows exactly Project, Work and Activity, followed by a folded More group.
- [ ] Unfolding More shows Fleet, Queue, Approvals, History, Token saver, Skills, Schedules and Settings, each linking to its existing page; the Fleet badge (slots needing attention) still shows on Fleet. While More is folded, the badge is still visible on the More group header or the folded group.
- [ ] Inside a project, the Workspace section is one folded group by default; outside a project it is unchanged and not collapsible.
- [ ] Opening a page that lives in a folded group (e.g. `/projects/:id/history`, `/sessions` while inside a project, `/admin/users`) shows that group unfolded with the entry marked active.
- [ ] Each group's fold state persists across reloads in the same browser and is independent of the other groups; with `localStorage` blocked the rail still renders, with groups folded.
- [ ] The icon-only collapsed rail (C-14) still works and every entry stays reachable.
- [ ] Role filtering is unchanged: a viewer never sees operator- or admin-only entries in any group, and a group with no visible entries is not rendered.
- [ ] The phone `BottomCapsule` tabs and its More sheet are unchanged (`tabBarSplit` tests still pass).
- [ ] `nav.test.ts` covers the primary/More split and Workspace collapsing inside vs. outside a project; `bun run check` and `bun run test` pass.
- [ ] Only glass-ui components are used (ADR-0011); if `NavRail` cannot render a group this way, the gap is raised as a glass-ui change rather than built locally.

## Out of scope
- Removing or renaming any page, route or nav entry, or merging pages into tabs.
- Per-user pinned or favourite entries stored on the server.
- Changes to the phone navigation (`BottomCapsule`, `tabBarSplit`).
- Reordering or regrouping the Admin section (it is already collapsible).
- The command palette (⌘K) and breadcrumbs.

## Open questions
None.
