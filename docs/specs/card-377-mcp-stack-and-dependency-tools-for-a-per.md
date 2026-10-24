# C-377: MCP: stack and dependency tools for a person's session (stack_create, stack_add_card, stack_design, card_depend)

## Why
A person's Claude Code session works the Board through MCP (ADR-0083, `apps/runner/src/mcp/tools.ts` → local methods in `packages/shared/src/protocol/local.ts` → `apps/api/src/local/local-board-handlers.ts`). It can create and run cards but cannot group them into a stack, set stages, add a dependency or start/approve a stack design. On 2026-10-24 grouping C-368..372 into S-12 and starting its design had to go through the web app's REST API from a browser session with the CSRF header — a workaround, not a path.

## What
New local methods + MCP tools, same rules as the existing `card.*` (manual session only, operator or better, audited with the person as actor, Board refusals returned unchanged):
- `stack_create` → `stack.create { title, body?, design?: boolean, stages: [{ title?, cards: number[] }] }` — one call makes the stack with every stage and its dependencies (wraps `BoardStacks.group` + `addCard`, one transaction).
- `stack_add_card` / `stack_remove_card` → `{ stack, card, stage }`.
- `stack_update` → title/body, and **stage titles** (the REST API has no way to name a stage today; add it to `PATCH board/stacks/:n` too, so S-12's stages can be called Foundations / Features).
- `stack_run` / `stack_stop` (ADR-0067).
- `stack_design` → `{ stack, action: 'generate' | 'status' | 'approve' | 'revise', comments? }` and the same for a card's own design (`card_design`). Approve stays a person's gate: the tool returns `needs_person` unless the session is the person's own and the project allows it (match the web rules exactly).
- `card_depend` / `card_undepend` → `{ card, dependsOn }` (`POST /board/cards/:n/dependencies`).
- `board_list` returns stacks (number, title, stages with card numbers, design status).
Update the nautelle plugin skill `nautelle:board` to mention the tools. Tests: tools.spec (schemas), local handler e2e for each method incl. refusals and the manual-only rule.

## Decisions
Recorded in [ADR-0089](../adr/0089-a-persons-session-may-work-stacks-designs-and-dependencies.md). `status` is a read method of its own (`stack.designView`, `card.designView`), so the MCP design tools route it there; Approve from any session but a manual one is `needs_person`; `stack_remove_card` takes `{ stack, card }`, since the card's stage is known.
