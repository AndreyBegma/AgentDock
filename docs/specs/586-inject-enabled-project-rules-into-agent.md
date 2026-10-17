# C-227: Inject enabled project rules into agent prompts

Issue: #586

## What to do
Find where prompts for agents that write code on a project are assembled (the card worker flow of ADR-0024 and the instruction handling of ADR-0019) and add a section containing the project's enabled rules, in rule order, as a clearly delimited block (for example `## Project coding rules`) telling the agent to follow them in all code it writes. Fetch the rules at dispatch time so edits apply to the next run. Skip the block entirely when the project has no enabled rules. Keep the block size bounded and truncate with a clear marker, never silently.

## Acceptance criteria
- [ ] A worker prompt for a project with enabled rules contains each enabled rule's title and description in order.
- [ ] Disabled rules never appear; a project with no enabled rules gets no rules block.
- [ ] Editing or toggling a rule changes the prompt of the next dispatched run without restart.
- [ ] An oversized rule set is truncated with an explicit marker and a logged warning.
- [ ] Unit tests cover the prompt builder with zero, one, many and oversized rules.
- [ ] `bun run check` and `bun run test` pass.

## Out of scope
Verifying generated code against the rules in review or before the PR; planner or intake prompts unless they share the same builder.

## Open questions
- Which agents get the rules? Default: all agents that write code for the project (card workers and fleet workers), not the planner.
