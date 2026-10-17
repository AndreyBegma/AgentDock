# C-219: Make design generation and the stack design preview work on phones

Issue: #526

## What to do
Make starting and following a design generation comfortable from a phone. This covers the stack page (`apps/web/src/app/(app)/projects/[projectId]/board/stacks/[number]/page.tsx`) and the card design block (`apps/web/src/components/board/card-design.tsx`), which hold the generate panel (`components/design/generate-panel.tsx`), the run progress (`design-progress.tsx`) and the design preview.
- **Preview.** It is an unscaled `MockupFrame` in an `aspect-[4/3]` box (`stacks/[number]/page.tsx:693-700`), so on a phone the mockup lays out at about 340px instead of at a real viewport. Below `lg`, render it at the Mobile preset width (or the project's mobile preset) and scale it to fit, as the design viewer's fit zoom does (`lib/design/viewer-state.ts`). Tapping the preview opens the full viewer.
- **Generate panel.** Every control, prompt field and option is usable at 375px with tap targets of at least 44px, and the start button can be reached with the keyboard open.
- **Progress.** The run log bottom sheet and the progress state can be read at 375px.
- **Approve design.** The Approve design and open-viewer actions (`stacks/[number]/page.tsx:243`) can be reached on a phone without scrolling past the whole stack. For example, put them first in the phone layout or in a sticky footer.

Per ADR-0011, use glass-ui components only.

## Acceptance criteria
- [ ] At 375×812 a design generation can be started from the stack page and from a card, and its progress followed until it finishes.
- [ ] Below `lg`, the stack page preview renders the mockup at the mobile preset width, scaled to fit, not at the container width.
- [ ] Tapping the preview opens the design viewer.
- [ ] Approve design and open viewer can be reached on the stack page at 375px.
- [ ] Controls in the generate panel are at least 44px tall on touch.
- [ ] At 1440px the stack page looks as it does on `develop`, including the sticky `lg` preview.
- [ ] The PR contains screenshots of the stack page and the generate panel at 375px.
- [ ] `bun run check` and `bun run build` pass.

## Out of scope
- The design viewer itself: pins, comments, toolbar.
- Changes to the generation pipeline or the API.

## Open questions
None.
