# ADR-0019: The Planner's instructions live in AgentDock, editable, behind a fixed output contract

Status: accepted · Date: 2026-10-13 · Scopes [ADR-0005](0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md) ·
Issue: [#172](https://github.com/AndreyBegma/AgentDock/issues/172)

## Context

The Planner (#172) turns a brief into reviewed tasks. It does what
`/code-sentinel:spec` does in a terminal: it decomposes the brief, grills in
rounds, and writes specifications. It has to do it headless, turn by turn, and
in a shape the UI can render as question cards and a task graph.

ADR-0005 says AgentDock drives code-sentinel's skills and does not
reimplement them. Read literally, the Planner's logic belongs in a
code-sentinel skill. On 2026-10-13 the owner chose otherwise. The planner's
behaviour should be an internal, editable setting of AgentDock, tuned per
project without a plugin release. Moving it into code-sentinel later stays
possible.

## Decision

1. **ADR-0005 covers the orchestrator and its workers**
   (`cs-orchestrator`, `cs-worker`), and skills AgentDock runs as they are
   (#24). It does not cover the Planner.
2. **The Planner's prompt has two layers.**
   - The **output contract** is code: a versioned JSON shape inside one fenced
     `agentdock-plan` block, with a parser and validator in
     `packages/shared/src/planner/`. It is appended to every prompt and is not
     editable.
   - The **instructions** are data: how to split work, how to ask, and the
     specification rules. A global default is edited by a site admin, and a
     per-project override by the project's admin.
3. **Instructions are versioned.** Every save is a new row. Each plan records
   the instructions version and the contract version it ran with. Old
   versions can be restored.
4. **The seed copies cs-spec's rules.** The default instructions are seeded
   from `packages/shared/src/planner/default-instructions.md`, written from
   `/code-sentinel:spec`'s rules: evidence before questions, rounds of a
   decision frontier, contention map, parallel plan, acceptance criteria.

## Consequences

- **The cost: the rules exist twice.** They live in the cs-spec skill and in
  AgentDock's default instructions. A change to cs-spec does not reach the
  Planner on its own; someone has to port it to the default instructions.
- A bad instructions edit degrades the quality of new plans, but it cannot
  break the UI: the contract is fixed and validated, and a turn whose output
  does not validate fails without changing state.
- **The runner's trust boundary is unchanged** (ADR-0010). The assembled
  prompt travels as a field of the typed `plan.turn` command. The runner
  writes it to a file and passes it on stdin, never as a shell string.
- If the Planner moves into code-sentinel later, the contract stays in
  `packages/shared`, and the skill must emit it. This ADR is then superseded.
