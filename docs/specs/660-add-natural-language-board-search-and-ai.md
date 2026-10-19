# C-243: Add natural-language Board search and AI triage hints for new cards

Issue: #660

## What to do
Build both features on the LLM gateway. Usage is tagged `search` and `triage`, and the caps apply.

**Ask the Board.** An entry in the glass-ui command palette. A question in any language becomes a structured query over cards, PRs and activity in the projects the person can access. The answer is a short reply with links.

**Triage hints.** When a card is created, through the intake or the assistant, show non-blocking hints:
- possible duplicates, with links;
- a suggested kind;
- a suggested priority.

The model recommendation stays with ADR-0032. Every hint can be dismissed, and none changes the card without the person accepting it.

## Acceptance criteria
- [ ] A plain-language question returns linked cards and PRs, only from accessible projects.
- [ ] A Russian question gets a Russian answer.
- [ ] A card similar to an open one shows a duplicate hint linking to it.
- [ ] Kind and priority hints can be dismissed and never apply on their own.
- [ ] The ADR-0032 behaviour is unchanged.
- [ ] When the cap is reached, search shows the cap message and hints are hidden.

## Out of scope
- The assistant chat.
- Changes to the intake interview or its contract.

## Open questions
None.
