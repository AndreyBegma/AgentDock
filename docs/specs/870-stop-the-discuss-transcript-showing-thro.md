# C-334: Stop the Discuss transcript showing through the message composer

Issue: #870

## What to do
In the Board's Discuss dialog, the composer is pinned to the bottom of the scrolling transcript with `sticky bottom-0 bg-inherit`. It is the `Composer` form in `apps/web/src/components/board/discuss-dialog.tsx`, around line 546. The glass `DialogContent` has no opaque background, so `bg-inherit` ends up transparent. While the person scrolls, the planner's reply text shows through and overlaps the "Message" label, the textarea, the Send button and the "Ask anything about the code. / ⌘↵ to send" hint. The bottom of the dialog looks broken.

Give the sticky composer a solid surface that matches the dialog, using a glass-ui token or class (ADR-0011), not a hard-coded colour. Add a clear top edge (a border or a short fade), so messages scroll under the composer instead of through it. If glass-ui has no fitting surface token or sticky-footer primitive, add it to glass-ui rather than writing a one-off here. Check both the desktop dialog and the full-screen phone layout, including the safe-area padding.

## Acceptance criteria
- [ ] Scrolling a long Discuss transcript no longer shows any transcript text behind the "Message" label, the textarea, the Send button or the hint line.
- [ ] The composer's background matches the dialog surface in the app's theme(s); no visible seam or colour mismatch.
- [ ] There is a visible separation (border or fade) between the transcript and the composer.
- [ ] The last message can still be scrolled fully into view above the composer.
- [ ] Works on desktop and on a phone-width viewport (full-screen dialog, safe-area inset kept).
- [ ] Only glass-ui tokens/components are used; `bun run check` passes.

## Out of scope
- Redesigning the Discuss dialog, the transcript, or the composer's layout and behaviour (send, ⌘↵, waiting state).
- Changes to other dialogs' composers unless they reuse the same component.

## Open questions
- Separator style between transcript and composer. Default: a 1px `border-line` top border plus a small top padding; use a fade only if it already exists as a glass-ui pattern.
