# C-86: Add card stacks: staged cards sharing one design, grouped on the Board

Issue: #480

## What to do
Add **stacks**: a group of cards that make one larger piece of work (e.g. redesigning a page: first its components, then the page itself), ordered in **stages**, under one shared design. This amends ADR-0037 §4 (split cards are independent) and ADR-0025 (a design has one owner); write a new ADR for both in the same PR. Build in this order:

1. **Model.** A `BoardStack` per project (title, body, ordered stages). Each card belongs to at most one stack and one stage. Cards in a stage may run in parallel. Every card of stage N+1 gets an ordinary `BoardCardDependency` on every card of stage N, so existing dependency handling applies.
2. **Intake.** Extend the card-intake contract (`packages/shared/src/planner/contract.ts`, `apps/api/src/planner/plan-intake.ts`, `plan-prompt.ts`) with an additive `stack` branch: a stack title and body plus 2–8 cards grouped into stages. The intake proposes a stack when the request is one larger piece of work whose parts must happen in order and share a look, and a plain split when the parts are independent. In the split review (`apps/web/src/components/board/split-review.tsx`, `intake-view.tsx`) the person can switch a proposal between **Split** (independent) and **Stack**, move cards between stages, and confirm in one step. Keep the contract version backward compatible, as ADR-0037 did.
3. **Shared design.** A stack can have its own design (a new design owner kind, `stack`, alongside task and card), drawn for the whole result, e.g. the full page. Each card of the stack that needs a design keeps its own separate design. The two are not merged. The card's design turn and worker prompt receive the stack's approved design as reference.
4. **Design-first gate.** While the stack has a design that is not yet approved, Run is disabled on every card of the stack, with the reason shown. Nothing writes project code before the stack design is approved.
5. **Board.** A stack appears in a column as one collapsed stack face showing the stack title, its progress (accepted / total) and the current stage. It sits in the column of its least advanced unfinished card. It expands in place to show its cards grouped by stage, each with its own column state. `board-view.tsx`, `card-face.tsx`.
6. **Stack page.** Opening a stack goes to a full page, built the way the card page from #431 is (`apps/web/src/app/(app)/projects/[projectId]/board/cards/[number]/page.tsx`): the stack description rendered, the stages with their cards and the links between them, and the stack's design.

## Acceptance criteria
- [ ] A new ADR records stacks and amends ADR-0037 §4 and ADR-0025; `docs/adr/README.md` lists it.
- [ ] An intake for a multi-part redesign can return a `stack` proposal, and an intake for unrelated tasks still returns a plain `split`. A stored intake output of an earlier turn still reads back.
- [ ] In the review the person can switch between Split and Stack and move cards between stages; confirming creates the stack, its cards in To Do, and dependencies from every card of a stage to every card of the previous stage, in one transaction.
- [ ] A stack design can be generated, revised and approved with the existing design flow. A card of the stack can have its own design alongside it, and both are stored separately.
- [ ] While the stack design is not approved, Run on any card of the stack is refused by the API and disabled in the UI with the reason; after approval it works.
- [ ] The card's design turn prompt and worker prompt include the approved stack design as reference.
- [ ] The Board shows a stack as one collapsed face with title, progress and current stage. Expanding it shows its cards by stage, and collapsing it restores the face.
- [ ] The stack page renders the stack description, stages, cards with their state, and the stack design.
- [ ] Schema changes use `prisma migrate dev` with a descriptive name. API tests cover stack creation from a proposal, the stage dependencies and the gate.

## Out of scope
- Ready / Waiting marking and auto-run of cards whose dependencies are accepted (stage dependencies are ordinary dependencies, so that behaviour applies to stacks automatically once it exists).
- Multiple frames per design.
- Arbitrary dependency graphs or nested stacks.
- Sending a stack to the orchestrator fleet as issues.

## Open questions
- Whether every stack must have a design. Default: no — the intake suggests one for UI work and the person can switch it off; with no stack design the gate does not apply.
- Which column holds a collapsed stack. Default: the column of its least advanced unfinished card; a fully accepted stack sits in Done.
- Whether stacks can be edited after creation (add or remove cards, change stages). Default: cards can be removed from or added to a stage on the stack page; stages cannot be reordered once any card of the stack has run.
