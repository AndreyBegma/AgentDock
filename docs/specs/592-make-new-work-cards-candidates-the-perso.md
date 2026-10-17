# C-234: Make New work cards candidates the person reviews in Drafts

Issue: #592

## What to do
Today a New work intake creates its card in Todo the moment the model writes it: `writeCard` in `apps/api/src/planner/plan-turn-projector.ts` calls `planCards.create`. Change this so every card the intake writes is first a **candidate** shown in the Drafts strip (`apps/web/src/components/board/drafts-strip.tsx`). A real board card is created only when the person accepts it. This covers a single `cardDraft` and every card of a `split` or `stack`. Each card is its own candidate. The cards of a proposed split or stack arrive as a group, with the stack's stages kept.

On a candidate, the person can open it, read its title, kind and full body, edit them, then **Accept** or **Reject** it. Accept creates the card in Todo with the intake plan as its origin, and the intake's attachments go to the first accepted card (as ADR-0037 §4 does). Reject drops it, and no card is made.

The person can also regroup candidates. They can select several and accept them together either as independent cards or as one stack, assigning each to a stage in order. The stack is created as `confirmSplit` already creates one (`apps/api/src/planner/plan-cards.service.ts`, ADR-0044): stages, dependencies and the design when the result is UI. A group the intake proposed can be accepted as proposed with **Accept all**, or regrouped.

The intake is `done` once none of its candidates remain undecided. An edited title stays ASCII-English, as split titles are (ADR-0027 §6, ADR-0037). Record the decision as a new ADR (amending ADR-0037 §3–4) in the same pull request.

## Acceptance criteria
- [ ] Finishing a New work intake with one card creates no board card. A candidate appears in Drafts instead.
- [ ] A split or stack proposal creates no board cards when confirmed. Each card appears as its own candidate, grouped, with stages kept for a stack.
- [ ] A candidate opens to show its title, kind and full body, and all three can be edited and saved before deciding.
- [ ] **Accept** creates the card in Todo with the edited text and the plan as origin. Attachments land on the first accepted card.
- [ ] **Reject** removes the candidate and creates nothing.
- [ ] The person can select several candidates and accept them as independent cards (no dependencies) or as one stack with chosen stage order. The stack's dependencies and design follow ADR-0044.
- [ ] **Accept all** on a proposed group creates it as proposed, in one step.
- [ ] An edited title with a non-ASCII letter is refused, as split titles are.
- [ ] The intake leaves Drafts once all its candidates are accepted or rejected.
- [ ] API specs cover accept, reject, edit, accepting as independent cards, accepting as a stack and the stale and concurrent cases.
- [ ] A new ADR records the change.

## Out of scope
- The Discuss mode.
- Showing candidates in the Inbox column. The Inbox stays for captured suggestions (ADR-0026).
- Asking the model to rewrite a candidate. Editing is by hand.
- Changing how the intake interviews or decides between card, split and stack.

## Open questions
- Should the intake itself propose regrouping existing candidates (for example, merge three candidates into a stack)? Default: no. The intake proposes groups only for the request it is writing, and the person regroups by hand.
