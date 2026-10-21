# ADR-0076: A card's model and effort follow its class, stay fixed for a session, and a Sonnet round may escalate to Opus once

Status: accepted · Date: 2026-10-21 ·
Epic: [#745](https://github.com/AndreyBegma/Nautelle/issues/745) ·
Issue: [#750](https://github.com/AndreyBegma/Nautelle/issues/750) ·
Spec: [`docs/specs/750-choose-model-and-effort-by-card-class-es.md`](../specs/750-choose-model-and-effort-by-card-class-es.md) ·
Amends: [ADR-0032](0032-a-cards-model-is-recommended-by-a-runner-side-assessment.md) §2 and §4 ·
Keeps: [ADR-0068](0068-the-token-saver-targets-context-residency-and-is-judged-by-cost-per-round.md) §5, [ADR-0042](0042-context-handoff.md) §2 ·
Builds on: [ADR-0074](0074-a-token-saving-is-judged-by-billed-cost-per-successful-card.md)

## Context

A card round runs on `opus` unless the #322 assessment (ADR-0032) or the person says otherwise, and since ADR-0068 §5 the assessment also recommends an effort. The rule given to the assessment is free-form: `opus` when the work still has to decide, `sonnet` when it executes a clear decision, `haiku` for trivial edits. A Sonnet round that turns out to be out of its depth has no way back except a person noticing.

Two more facts matter for cost. Changing the model, or the effort, of a running Claude session breaks its prompt cache [Reported]. And the token economy epic (ADR-0074) requires every saving technique to be proven per card in an A/B test before it is enabled for everyone.

## Decision

1. **The assessment classifies the card** as `mechanical`, `deciding` or `unsure`, and lists the deciding signals it found from a closed list: `schema`, `auth`, `tenancy`, `payments`, `deletion`, `bug_cause_unknown`, `no_precedent`. Any signal makes the class `deciding`, whatever the model said. A missing, failed, stale or out-of-contract assessment is `unsure`.

2. **Class → model and effort (amends ADR-0032 §2),** in arm B of the technique `model_by_type`:
   - `deciding` → `opus` at `high`;
   - `unsure` → `opus` at `medium`;
   - `mechanical` → `sonnet` at the assessed effort, capped at `medium`;
   - a CI-fix round stays `sonnet` at `low` in both arms (ADR-0068 §5).

   The mapping never yields `haiku`; a person can still pick it. In arm A the launch default is today's: the recommendation, else the project's model.

3. **No recommendation means Opus in arm B (amends ADR-0032 §4).** In arm B a card without a usable recommendation defaults to `opus` (`unsure`), not to the project's model. A person's choice on the card still wins over the mapping, and is stored only when it differs (ADR-0032 §4).

4. **Model and effort are fixed for the life of a Claude session,** in both arms. The API stores the pair the card's current session started with. A round whose resolved pair differs starts a fresh session seeded through the handoff (ADR-0042), never `--resume` with another `--model` or `--effort`. The old session is kept (ADR-0042 §2). Effort is passed at launch with `--effort`.

5. **A Sonnet round may escalate to Opus, once.** In arm B a non-Opus card round is offered a runner MCP tool `escalate_card({ reason, note })`, with `reason` `misclassified` or `gave_up`. Calling it ends the round; the API marks the card `deciding` and starts one new round on `opus` at `high` in a fresh session, with the note in its prompt. A card escalates at most once, an Opus round never gets the tool, and when the round's model came from a person's override the card waits with **Run on Opus** instead of relaunching. A session that just ends is not an escalation.

## Consequences

- The model decision becomes testable: the A/B report (ADR-0074) compares arms by class, and escalations are counted in rounds per card.
- An escalated card pays for two rounds. Whether that is cheaper than starting on Opus is what the report shows.
- A changed model or effort on a running card costs a fresh session instead of a broken cache. A card from before this change has no stored pair and resumes as before.
- The assessment's answer contract changes. An old-shape answer counts as `unsure`, which is Opus, the default before ADR-0032.
- A person who types `/model` or `/effort` in an attached terminal is outside this decision; Nautelle records what it launched.
