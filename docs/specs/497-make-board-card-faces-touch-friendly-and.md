# C-215: Make Board card faces touch-friendly and align the phone breakpoint

Issue: #497

## What to do
Make the Board readable and tappable on a phone (375–430px wide). Today a phone user can watch the Board and open cards, but the interactive bits on card faces are tiny. The header row is `h-4` with `size-3` icons and the text links are `text-xs` (`apps/web/src/components/board/card-face.tsx:49,106-132`). The count pill is `h-5` (`card-face.tsx:425`). The stack expand chevron is `size-3.5` (`apps/web/src/components/board/stack-face.tsx:114`).

On coarse pointers, give every interactive element on a card face and a stack face a hit area of at least 44×44px, for example with the `pointer-coarse:` variant or padding around the hit area. Do not change how the desktop looks.

Also fix the breakpoint mismatch. `apps/web/src/components/board/board-layout.ts:3-4` treats below 768px as phone, and its comment says the tab bar shows below that width. The app shell actually swaps the rail for the bottom `TabBar` below `lg`, 1024px (`apps/web/src/components/shell/app-shell.tsx:76,90`). Pick one threshold, use it in both places, and correct the comment. Do not let the Board's columns or the Completed strip end up hidden behind the bottom tab bar or the safe area: pad the bottom when the tab bar is shown.

Per ADR-0011, a change that belongs inside a glass-ui component (`Board`, `RowActions`) goes to glass-ui, not into a local override.

## Acceptance criteria
- [ ] At 375×812 with touch emulation, every interactive element on a card face and a stack face has a hit area of at least 44×44px.
- [ ] At 1440px wide, the card and stack faces look as they do on `develop`, in a screenshot compared side by side.
- [ ] The Board's phone threshold and the shell's tab-bar threshold are one value, and the comment in `board-layout.ts` states it correctly.
- [ ] At 375px, the last card of the longest column and the Completed strip can be scrolled fully above the bottom tab bar.
- [ ] The PR contains screenshots of the Board at 375px and at 1440px.
- [ ] `bun run check` and `bun run build` pass.

## Out of scope
- Moving cards between columns, including touch drag-and-drop.
- Bulk selection and the hover-only selection checkbox (`selection-box.tsx`).
- The card sheet, the new-card dialog and anything in design.

## Open questions
None.
