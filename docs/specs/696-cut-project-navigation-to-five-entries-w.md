# C-282: Cut project navigation to five entries with the Board first

Issue: #696

## What to do
Rework the app shell (`apps/web/src/components/shell/`: `nav.ts`, `rail.tsx`, `capsule.tsx`, `app-shell.tsx`, `narrow.ts`) so the navigation is short and the Board is clearly the main place of work.

- Inside a project, show at most 5 primary entries, in this order: Board (renamed from "Work", visually emphasised with the glass-ui main-entry style), Fleet, Queue (Queue + Approvals, merged by a later card), Activity (Activity + History, merged by a later card), Settings. Everything else (Project home, Planner, Schedules, Skills, Token saver) goes under "More".
- The phone capsule (`capsule.tsx`) respects `primary` and shows the same primary set, with Board in the centre.
- Shrink the Workspace group to its primary entries (Overview, Projects, Work), with the rest under More.
- Move the 10 Admin entries out of the rail into an Admin entry in the account menu that opens the admin area with its own sub-navigation.
- Three layouts: phone (<640, capsule), tablet (640–1024, collapsed icon rail from glass-ui) and desktop (≥1024, full rail). Update `useNarrow` / `usePhone` so tablets no longer get the phone layout. The Board's own column logic in `board-layout.ts` must keep working.
- Overview stays the landing page after sign-in.

## Acceptance criteria
- [ ] Inside a project the rail and the capsule show at most 5 primary entries, Board first and emphasised, labelled "Board".
- [ ] Hidden entries are reachable through More in at most two taps or clicks.
- [ ] Admin pages are reachable from the account menu and no longer listed in the rail.
- [ ] At 375px, 820px and 1440px widths the shell renders the phone, tablet and desktop layouts respectively.
- [ ] Breadcrumbs (`crumbs.ts`) and page actions still work in all three layouts.
- [ ] Sign-in still lands on Overview.
- [ ] `bun run check` passes.

## Out of scope
- Redesigning page contents.
- Merging pages (done by the page cards; until then the Queue and Activity entries point to the existing pages).
- Any change to the Board page itself.

## Open questions
None.
