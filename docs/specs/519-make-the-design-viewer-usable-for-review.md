# C-218: Make the design viewer usable for review and pin comments on phones

Issue: #519

## What to do
The design viewer already works on a phone for viewing: it is a full-screen layer, zoom fits by default, and comments live in a bottom `Sheet` below `lg`. Make reviewing, pinning comments and approving comfortable there too:
- **Pin composer.** It is a `w-80` popover anchored `side="right"` (`apps/web/src/components/design/pin-composer.tsx:71-76`) and gets clipped on a 375px screen. Below `lg`, open it in a glass-ui `Sheet side="bottom"` instead. Keep the input visible above the keyboard and show which pin it belongs to.
- **Toolbar.** Below `lg`, show only the viewport presets (Desktop / Mobile from `packages/shared/src/design/types.ts:59-62`, or the project's own presets) and zoom. Hide the typed width and the drag-to-resize frame edges, which are pointer-based (`viewer-toolbar.tsx:83-120`, `ResizableFrame` in `design-viewer.tsx:407-448`). Toolbar controls are `h-8` today; make them at least 44px on touch.
- **Pins.** Placing a pin with a tap on the mockup works at the fitted zoom, and existing pins are at least 44px to tap.
- **Frame strip and Approve.** Both can be reached and used at 375px. This covers the frame strip (`frame-strip.tsx`) and the Approve design flow (`approve-dialog.tsx`).

Per ADR-0011, a fix inside `ResizableFrame` or `Toolbar` goes to glass-ui. Spec references: `docs/specs/223-design-stage.md` (D11, viewport presets, pins) and `docs/specs/335-design-viewer-zoom.md`.

## Acceptance criteria
- [ ] At 375×812 with touch emulation, tapping the mockup places a pin, and its comment composer opens as a bottom sheet that is not clipped.
- [ ] With the keyboard open, the comment input and the send button stay visible.
- [ ] Below `lg`, the toolbar shows the viewport presets and zoom but not the typed width or the resize handles. At 1440px both are present as before.
- [ ] Toolbar controls and pins are at least 44×44px on touch.
- [ ] Switching between Desktop and Mobile presets at 375px fits the mockup to the screen.
- [ ] A design can be approved from the phone through the existing approve flow.
- [ ] The PR contains screenshots at 375px: a mockup with pins, the open composer, and the comments sheet.
- [ ] `bun run check` and `bun run build` pass.

## Out of scope
- Generating a design and the stack page preview.
- Typed or dragged custom viewport widths on phones.
- Changes to how comments, pins or approvals are stored.

## Open questions
None.
