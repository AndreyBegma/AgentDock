# C-265: Bound the Drafts strip height so large proposed stacks don't clip the Board

Issue: #642

## What to do
On the project Board (`apps/web/src/app/(app)/projects/[projectId]/board/page.tsx`) the Drafts strip sits in a `shrink-0` wrapper above the columns: the page itself does not scroll, only the columns do. `DraftsStrip` (`apps/web/src/components/board/drafts-strip.tsx`) renders each intake under review as a `CandidateGroup` (`apps/web/src/components/board/candidate-group.tsx`) whose candidate list grows with every candidate. A proposed stack with many cards (e.g. 8 candidates in 2 stages) makes the strip taller than the viewport: the bottom candidates are cut off and unreachable, and the Board columns, toolbar and everything below are pushed off-screen.

Cap the height of the Drafts area and let the candidate list of each `CandidateGroup` scroll inside it: the group header (title, "Proposed stack · N stages", **Accept all**) stays visible and the candidate list scrolls vertically within a bounded height (about 40% of the viewport, with a sensible minimum). Keep the existing horizontal scroll-snap rail between drafts and the stage numbering/connector line in the list. Use glass-ui components and Tailwind utilities only (ADR-0011); if glass-ui lacks a needed scroll primitive, use a plain overflow container rather than writing a new component here.

## Acceptance criteria
- [ ] With a proposed stack of 8 candidates in Drafts, the full page fits the viewport: the Board toolbar and columns stay visible and usable below the strip.
- [ ] Every candidate in a large group can be reached by scrolling inside the group; none is clipped.
- [ ] The group header with its title, meta line and **Accept all** stays visible while the candidate list scrolls.
- [ ] Small groups (1–3 candidates) and plain draft cards look as they do today, with no extra empty space or scrollbar.
- [ ] Selecting candidates, the selection bar, Open / Accept / Reject and the candidate sheet still work for candidates scrolled into view.
- [ ] Works on desktop and below `sm` (the phone rail of drafts still scroll-snaps horizontally).
- [ ] A test covers the bounded, scrollable candidate list (e.g. a render test asserting the list carries the overflow/height constraint), per the project rule that a bug fix comes with its test.

## Out of scope
- Changing how many cards the intake proposes, or the intake/stack logic and API.
- Redesigning the Drafts strip or candidate rows beyond the height/scroll fix.
- Making the whole Board page scroll instead of the columns.

## Open questions
- Bounded scroll vs. collapsing a long group to the first few candidates with a "Show all N" toggle. Default: a bounded height with internal scroll, since it keeps every candidate one scroll away and doesn't add a new control.
- Exact cap. Default: about 40vh with a minimum that fits at least two candidate rows.
