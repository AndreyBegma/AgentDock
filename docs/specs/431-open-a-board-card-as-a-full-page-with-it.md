# C-75: Open a Board card as a full page with its description rendered

Issue: #431

## What to do
Today a Board card opens only in a side sheet (`CardSheet`, `apps/web/src/components/board/card-sheet.tsx`, through `?card=<number>` built by `boardCardHref` in `apps/web/src/lib/board/href.ts`). Add a full page for one card at `/projects/[projectId]/board/cards/[number]` (new `page.tsx` next to the existing `design/page.tsx`). The page shows everything the sheet shows, at full width: run, design, rounds, pull requests, CI banner, attachments, dependencies, options and the editable card form.

Reuse the sheet's content instead of copying it. Extract and export `CardDetailBody` from `card-sheet.tsx` (or move it to its own module) so the sheet and the page render the same component. Follow the design viewer page (`board/cards/[number]/design/page.tsx`) for loading the card (`fetchCard`), the project role (`useProjectDetail` / `projectRoleAtLeast`), the not-found state (`isNotFound`, `describeBoardError`) and a back link to the board.

The card description ("What to do") is rendered as Markdown by default with the existing `Markdown` component (`apps/web/src/components/markdown/markdown.tsx`, react-markdown + remark-gfm), so headings, checkbox lists, code and links show formatted. Edit switches to the textarea, as the current Preview/Edit toggle does. Apply this default to the sheet too, since both use the same body.

Add an add a link button labelled "Open as page" to the sheet header. It links to the page, so Ctrl/Cmd+click and middle-click open it in a new tab. Add a helper for the page URL in `lib/board/href.ts`. Use only glass-ui components and tokens (ADR-0011).

## Acceptance criteria
- [ ] Visiting `/projects/<id>/board/cards/<number>` shows that card on its own page, with every section the sheet shows, at full width.
- [ ] The description is rendered as Markdown on load: `##` headings, `- [ ]` checklists, inline code, code blocks and links appear formatted, not as raw text.
- [ ] Edit switches the description to the textarea. Saving from the page updates the card, and the change is visible on the board and in the sheet.
- [ ] The sheet also shows the description rendered by default, with the same Edit toggle.
- [ ] The sheet header has an "Open as page" link to the page. Ctrl/Cmd+click and middle-click open it in a new tab.
- [ ] A viewer sees the page read-only, with the same controls disabled as in the sheet. An operator can edit.
- [ ] An unknown card number shows a not-found state with a link back to the board, not a crash.
- [ ] The page has a back link to the board.
- [ ] The sheet and the page render the same shared component. No sheet section is duplicated.
- [ ] Only glass-ui components and tokens are used: no hex, rgb() or Tailwind palette colours.
- [ ] `card-sheet.test.tsx` still passes. New tests cover the page: rendered Markdown, the Edit toggle and not-found.

## Out of scope
- A full page for plan tasks or Inbox suggestions. Board cards only.
- New items in the card's "…" menu on the board (C-35 is redesigning it).
- Changes to the card face, board columns or the API and shared types.
- Markdown rendering anywhere other than the card description.

## Open questions
- Entry points to the page. Default: an "Open as page" link in the sheet header plus opening in a new tab; no new item in the card's "…" menu.
- Markdown in the sheet. Default: the sheet also shows the description rendered by default, with Edit to switch to the textarea.
- Plan tasks. Default: only Board cards get a full page.
