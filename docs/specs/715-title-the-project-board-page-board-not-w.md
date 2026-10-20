# C-300: Title the project Board page "Board", not "Work"

Issue: #715

## What happens
After C-282 the project navigation, the breadcrumb and the phone top bar call the page **Board**, but the page's own header still says **Work** (`apps/web/src/app/(app)/projects/[projectId]/board/`, the board header / PageHeader title), and the browser title is "Board · AgentDock". Seen on staging at 1440, 820 and 375 px on 2026-10-20.

## What to do
- Make the page header title "Board" inside a project. Keep the workspace-level "Work" page (cross-project) named "Work".
- Check other places that name the project Board "Work" (empty states, command palette entries, notifications, Telegram texts, docs/ui/screens.md) and rename them to "Board" where they mean the project Board.

## Acceptance criteria
- [ ] The project Board page header says "Board" on phone, tablet and desktop. A web test covers the title.
- [ ] The workspace "Work" page keeps its name.
- [ ] `bun run check` passes.
