# C-217: Open the new work intake full screen on phones

Issue: #517

## What to do
The New work flow opens in a centred glass-ui `Dialog` (`apps/web/src/components/board/new-card-dialog.tsx:82-89`). This covers both the interview in `intake-view.tsx` and the split, stack and accept reviews (`split-review.tsx`, `accept-dialog.tsx`). On a phone the dialog is `100vw-2rem` wide and capped in height, and with the keyboard open the questions, options and input barely fit. Its `className="sm:max-w-2xl"` is also likely a no-op, because the base width is a fixed `min(32rem, …)`.

Below the shell's phone/tablet breakpoint (`lg`, where the bottom tab bar appears), open this flow full screen:
- The content (questions, options, card preview, split or stack review) scrolls.
- The text input and the primary actions stay pinned at the bottom and stay visible above the on-screen keyboard. Use `dvh` units and safe-area insets.
- Tap targets in the flow are at least 44px. This includes the reorder and remove buttons in `split-review.tsx:345-363`, which are `size-3.5` today.

On desktop the dialog stays as it is; fix the no-op width override while you are there. Per ADR-0011, if glass-ui has no full-screen variant of `Dialog` (or a `Sheet` that fits this), add it to glass-ui rather than building one locally.

## Acceptance criteria
- [ ] At 375×812, New work opens full screen with no visible page behind it.
- [ ] With the on-screen keyboard open (iOS Safari or Chrome Android, or emulation with a reduced viewport height), the input and the send button stay visible and the content above scrolls.
- [ ] A full intake works end to end at 375px: write a request, answer a round of questions (single and multiple choice), review a split, accept.
- [ ] Every button and option in the flow is at least 44px tall on touch, including split-review reorder and remove.
- [ ] At 1440px the dialog is centred as before, at the intended width.
- [ ] The PR contains screenshots of the question round and of the split review at 375px.
- [ ] `bun run check` and `bun run build` pass.

## Out of scope
- Changes to the intake contract, the questions or the API.
- The card detail sheet and the Board itself.

## Open questions
None.
