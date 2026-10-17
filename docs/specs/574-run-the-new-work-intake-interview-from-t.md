# C-210: Run the New work intake interview from Telegram with /new

Issue: #574

## What to do
Let a linked operator create Board work from Telegram through the same intake the web uses.

The web flow lives in `apps/web/src/components/board/new-card-dialog.tsx`, `intake-view.tsx`, `split-review.tsx` and `apps/web/src/lib/board/intake.ts`. The API side is `apps/api/src/planner/plans.controller.ts`, `plan.service.ts` and `plan-turn.service.ts`. The bot calls the planner services in-process as the linked user, after the router's role guard (operator+). It does not go through HTTP.

1. **Start.** `/new <text>`, or `/new` followed by the description as the next message, creates a plan with `mode: 'card'` for the current project. If no runner is online for the planner, the bot says so, the way `runnerGate(project, 'planner')` reports it.
2. **Rounds.** When a round arrives, the bot sends each question as its own message:
   - the title, the question, and the recommendation with its why;
   - single choice: one button per option;
   - multiple choice: toggle buttons plus Done;
   - a text reply to the question message is taken as the person's own answer.
   The round message has "Send answers" and "Enough — generate" buttons, which map to `PlanTurnDto` (`apps/api/src/planner/dto.ts`). Unanswered questions take the recommendation, as on the web.
3. **Progress.** While a turn is thinking, the bot shows a single "thinking…" message and edits it when the turn finishes (add `editMessageText` to `telegram-client.ts`). It learns about turn completion from the events / plan state the web already uses, not from a tight per-chat loop.
4. **Result.**
   - Single card: the bot replies with the card title, kind and a link to it.
   - Split or stack: it lists the cards with their summaries and offers "Create all" (the split / stack confirm) and "Keep one card". It also offers "Open in app" for editing the draft.
   - Failed turn: Retry / Cancel. The bot can also discard the plan.

Messages follow spec 22 D10 and the MarkdownV2 escaping in `markdown-v2.ts`. A plan started in Telegram is visible in the web drafts strip, and the other way round.

## Acceptance criteria
- [ ] `/new Add CSV export` in a linked chat with a selected project creates a plan visible on the web Board's drafts.
- [ ] A round is shown with one message per question, the recommendation and option buttons. Multiple-choice questions allow several options before Done.
- [ ] Replying with text to a question message records it as that question's answer.
- [ ] "Enough — generate" produces a card, split or stack without another round.
- [ ] A single-card result is announced with a working link. A split or stack can be created from Telegram, and the cards appear on the Board.
- [ ] "Keep one card" on a split yields one card.
- [ ] A failed turn offers Retry and Cancel, and both work.
- [ ] A viewer, or an unlinked chat, cannot start `/new`. There is an e2e spec on the Telegram fake client (`apps/api/src/telegram/testing`).
- [ ] No planner prompt, pane text or code is sent to Telegram beyond the questions and card titles and summaries (D10).

## Out of scope
- Photo and voice attachments to `/new`: a separate card.
- Editing the body of a card draft in chat: "Open in app" covers it.
- Changing the intake prompt or the output contract.

## Open questions
- How the bot learns that a turn finished. Default: a per-turn subscription to the existing plan events / outbox, not polling `GET plans/:id`.
