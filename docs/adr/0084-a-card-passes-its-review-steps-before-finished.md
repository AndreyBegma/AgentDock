# ADR-0084: A card passes its review steps before Finished

Status: accepted · Date: 2026-10-23 · Amends [ADR-0035](0035-a-card-ships-itself.md) §3–4 ·
Card: C-348 · Issue: [#862](https://github.com/AndreyBegma/Nautelle/issues/862) ·
Spec: [`docs/specs/862-add-project-review-steps-model-api-gener.md`](../specs/862-add-project-review-steps-model-api-gener.md)

## Context

Under ADR-0035 a card is Finished, and auto-merged when the project allows it,
as soon as its pull request's CI is green. Nothing reads the diff before that:
model-written code reaches the base branch reviewed by nobody, unless a
person accepts each card. The fleet's orchestrator already runs a review pass
before it calls work done, and people asked for the same on the Board — a
peer review that knows the repository's conventions, plus the project's own
review skills (security, performance and so on), in an order the project
chooses.

## Decision

1. **A project has ordered review steps.** A step is either the built-in
   `peer_review` step or a `skill` step that runs one skill the project's
   runner reports (`installed_skills`). Each step can be disabled. A project
   has exactly one `peer_review` step, created the first time review is
   turned on; it can be disabled but never deleted. Steps live in
   `project_review_steps`; the switch `reviewEnabled` lives on the project's
   board settings, next to `autoMergeCards`.
2. **The peer review instructions are generated from the repository.** On
   first enable, and when a person asks to regenerate, the project's runner
   reads the repository's guidance files (`repo.read`; ADR-0001, ADR-0063),
   and one LLM gateway call (ADR-0059, feature `review_instructions`) writes
   Markdown instructions from them and the project's coding rules. A person
   can edit them; a regeneration replaces them, edits included, so the UI
   asks first. A failed first generation stores built-in default
   instructions, and the person can regenerate later.
3. **Finished means CI green and review passed** (amends ADR-0035 §4). With
   `reviewEnabled` on, a card whose pull request is green runs its enabled
   review steps in order. Each step reports findings of the shared
   `ReviewFinding` shape, `blocking` or `nit`. The card is Finished — and
   only then auto-merged — when no step reports a blocking finding. With
   review off, ADR-0035 holds unchanged.
4. **Blocking findings start fix rounds, at most three per pull request**
   (amends ADR-0035 §3). A fix round gets the blocking findings and runs in
   the card's session, as a CI fix round does; review then runs again on the
   new head. Review fix rounds are counted apart from CI fix rounds. After
   the third, the card waits for a person.
5. **Review sessions are runner sessions started by typed commands**
   (ADR-0010). The API never runs a review itself and never reads the
   checkout; it asks the project's runner to start the session, and the
   runner reports the findings back.
6. **Publishing to GitHub is opt-in.** Findings are kept on the card. Only
   when the project's `publishReviewComments` switch is on are they also
   posted as pull request review comments. It is off by default.
7. **Review is off until a person turns it on**, for every project, existing
   or new.

## Consequences

- A project with review on spends model time on every green pull request,
  and up to three more rounds per pull request on blocking findings; the
  budget hard stop still bounds it.
- A card takes longer to reach Finished, and a project with auto-merge on
  merges later — but after a review.
- The peer review is only as good as the repository's guidance files; a
  repository without them gets general instructions until a person writes
  better ones.
- This ADR is delivered in stages (stack S-11): the configuration, the
  generated instructions and the findings type first; running the steps,
  the fix rounds and the gate on Finished next; the settings UI last.
  Until the engine ships, turning review on changes nothing a card does.
