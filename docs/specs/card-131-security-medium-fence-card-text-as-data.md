# C-131: Security [Medium]: Fence card text as data in the worker prompt

> Security audit 2026-10-16 · **WI-29** · severity **Medium** · size **S** · findings: F-29 (Z9 M1), L-47 (Z9 L5, Z9 P2-08 draft title)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**F-29.** The card worker prompt inlines card-supplied text as Markdown with no data fence: the title in the heading (`packages/shared/src/board/worker-prompt.ts:358` `## Card ${label}: ${card.title}`), the body under `## The card` (:371), the feedback round text (:379-380), and the design text. Only check names are `oneLine`d (:408). **L-47.** Card titles may contain newlines (`packages/shared/src/protocol/local.ts`, `apps/api/src/board/dto.ts`, `cardDraftSchema` in `packages/shared/src/planner/types.ts`).

**Attacker.** Anyone who can write card text: a project member, an imported issue author, a prompt-injected planner or capture run.

**Scenario.** Card text that contains its own `##` sections (for example a fake "How to work" block) reads to the worker as part of Nautelle's instructions; a newline in the title starts a new prompt section.

**Impact.** Instruction injection into an agent that commits and pushes code, and may auto-merge (see D-12, implemented by WI-46).

## Fix
- Wrap card-supplied text (title, body, feedback, design rationale and comments, project checks text) in `<card>…</card>` with one line saying it is data, not instructions; neutralise `<card>`/`</card>` inside the text as `capture-prompt.ts` does.
- `oneLine()` the title.
- Refuse `\r` and `\n` in card titles at the contract level: `protocol/local.ts`, `apps/api/src/board/dto.ts`, `cardDraftSchema`.
- Bump `CARD_WORKER_PROMPT_VERSION`.

## Acceptance criteria
- A prompt test: a body containing `</card>` followed by a `## How to work` heading stays inside the fence, with the tag neutralised
- A prompt test: feedback text and design text are fenced the same way
- A title with a newline is rejected by the board DTO (400), by the local protocol schema and by `cardDraftSchema`
- Existing worker-prompt snapshot tests are updated and the prompt version is bumped

## Touches
- packages/shared/src/board/worker-prompt.ts
- packages/shared/src/board/worker-prompt.spec.ts
- packages/shared/src/protocol/local.ts
- packages/shared/src/planner/types.ts
- apps/api/src/board/dto.ts

## Decision
D-12 (context only) — fleet changes to CI/deploy/plugin files need a human; that gate is implemented by WI-46 (ADR-0045). This item only fences the text.

## Must not run in parallel with
- WI-46


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
