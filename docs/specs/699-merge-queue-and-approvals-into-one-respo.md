# C-284: Merge Queue and Approvals into one responsive Queue page

Issue: #699

## What to do
Merge `projects/[projectId]/queue` and `projects/[projectId]/approvals` into one Queue page with two tabs: "Queue" and "Approvals", the latter showing a pending count. `/projects/:projectId/approvals` redirects to the Approvals tab. Redesign the page with the glass-ui primitives and the approved stack mockup: approve/deny actions within thumb reach on phone, list/detail from tablet up. Update notification links and the nav entry to the new URL.

## Acceptance criteria
- [ ] One Queue page shows both tabs, and the Approvals tab shows a pending count.
- [ ] The old `/approvals` URL (with any query) redirects to the Approvals tab.
- [ ] Links from notifications, Telegram and the Board to approvals land on the new tab.
- [ ] Approving and denying works at 375px, 820px and 1440px.
- [ ] `bun run check` passes.

## Out of scope
- Changing approval or queue behaviour or the API.
- The Board page.

## Open questions
None.
