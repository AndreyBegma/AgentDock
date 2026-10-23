# C-333: Make the standalone card page the full-detail view

Issue: #874

## What to do
The person wants the sheet to stay compact and the standalone card page ("Open as page", `boardCardPageHref`, `apps/web/src/app/(app)/projects/[projectId]/board/cards/…`) to be where all the detail lives. On the page at desktop width, render the approved design's wide layout: the header across the top, the rounds timeline as the main column with rounds expanded by default (summary unclamped, token-saver breakdown visible), and a side column with Overview content (status, dependencies, PR list, attachments, steward, handoff); the Edit form stays a tab or a section below. On phones the page falls back to the same header + tabs as the sheet. Make the "Open as page" link prominent in the sheet header.

## Acceptance criteria
- [ ] At ≥1280px the card page shows header, expanded rounds and the side column together, without tabs hiding rounds.
- [ ] On the page, round summaries and token-saver breakdowns are expanded by default and can still be collapsed.
- [ ] Below the desktop breakpoint the page uses the sheet's header + tabs layout.
- [ ] "Open as page" in the sheet header opens this page for the same card.
- [ ] Tests cover the wide layout and the expanded-by-default rounds on the page.
- [ ] `bun run check` passes.

## Out of scope
- Changing the sheet's compact behaviour.
- New API fields.

## Open questions
- None.
