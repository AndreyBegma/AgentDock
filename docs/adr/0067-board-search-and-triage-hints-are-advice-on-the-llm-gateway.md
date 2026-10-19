# ADR-0067: Board search and triage hints are advice on the LLM gateway

Status: accepted · Date: 2026-10-19 ·
Card: C-243 (stack S-3, stage 4) ·
Issue: [#660](https://github.com/AndreyBegma/AgentDock/issues/660) ·
Spec: [`docs/specs/660-add-natural-language-board-search-and-ai.md`](../specs/660-add-natural-language-board-search-and-ai.md) ·
Builds on: [ADR-0059](0059-the-api-calls-llm-providers-directly-for-assistant-features.md) ·
Keeps: [ADR-0032](0032-a-cards-model-is-recommended-by-a-runner-side-assessment.md), [ADR-0058](0058-new-work-cards-are-candidates-until-accepted.md)

## Context

Stack S-3 stage 4 adds two AI features on the gateway of ADR-0059:

- **Ask the Board.** A question in any language, asked from the command
  palette, answered from cards, pull requests and activity.
- **Triage hints.** Advice on a card the intake or the assistant has just
  made: possible duplicates, a kind and a priority.

Both spend provider money, so they must respect the caps. Neither may reach
a project the person cannot access. Neither may change a card on its own.

Board cards have no priority field. The order of a column is the queue
order: To Do is worked from the top, and a new card lands at its top
(ADR-0058).

## Decision

1. **Both features use the instance default model.** Calls go through
   `LlmGateway` and are tagged `search` or `triage`. The gateway's checks
   apply unchanged: disabled provider, missing key, unpriced model and the
   monthly cap. There is no default model per feature yet. Without a default
   model, Ask the Board answers `409 ai_no_model` and no triage runs.
2. **A question becomes a structured query, never SQL.**
   - The first call turns the question into a fixed JSON shape: project
     names, English keywords, columns, kind, PR state, checks, a window in
     days, and sources (`BoardAskQuery`). The parser keeps only the values
     the search knows.
   - Project names are matched against the projects the person can access.
     A name that matches none of them matches nothing.
   - The API runs the query with Prisma over those projects only.
   - A second call writes at most three sentences in the language of the
     question, citing hits as `[C-12]` and `[PR #34]`. The web links only
     references that match a returned hit.
   - The query is returned with the hits and shown as chips. Removing a chip
     runs the query again through `POST /board/search`, with no model call.
3. **Triage runs after the card exists and never holds up its creation.**
   - It starts when the intake accepts candidates (`POST …/candidates/accept`)
     and when the assistant's `queue_card` makes a card. It does not run on a
     manual create. The intake's interview and contract are unchanged.
   - One call is made per card. The model sees the card and at most ten open
     cards of the same project (To Do, In progress, Finished), picked by word
     overlap. It answers duplicates, a kind and a priority.
   - Only duplicates it was shown are kept. A kind equal to the card's is
     dropped, and so is a `normal` priority.
   - The result is stored in `board_card_triage`, one row per card.
4. **Hints are advice.**
   - Each hint can be dismissed. A dismissed or applied hint is stamped and
     never shown again.
   - **Apply kind** goes through the card's ordinary edit, so `kindSource`
     becomes `person`.
   - **Apply priority** moves the card to the top (`high`) or the bottom
     (`low`) of its current column through the ordinary move.
   - Duplicates are links. They are never applied.
   - Viewers read hints. Dismissing and applying need operator.
5. **At the cap, hints are hidden.** A triage the gateway refuses
   (`LlmError`) is stored as `hidden`. A ready triage is also hidden while
   the provider that made it is at its cap. Search at the cap answers the
   gateway's `429 llm_cap_reached` with `provider` and `resetsAt`, and the
   dialog names the provider and the reset day.
6. **The model recommendation stays ADR-0032's.** Triage never asks for,
   writes or reads `recommendedModel`, the assessment or the card's model.

## Consequences

- A card the intake or the assistant makes costs one more gateway call,
  metered as `triage`. A question costs two calls, metered as `search`.
- Priority is not a stored attribute. It reads as an order, so for a fresh
  To Do card a `high` hint usually changes nothing. A real priority field
  would need its own decision.
- Search matches English keywords against titles. A question about wording
  that is only in a card's body does not find the card.
- Rejected:
  - **Letting the model write SQL or Prisma filters.** These cannot be
    checked against access.
  - **Hints on intake candidates.** These would change the intake contract,
    which is out of scope.
  - **A `priority` column.** The person chose to map priority to the column
    order instead.
