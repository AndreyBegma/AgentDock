# ADR-0058: New work cards are candidates until the person accepts them

Status: accepted · Date: 2026-10-17 · Amends [ADR-0037](0037-new-work-is-one-intake-that-can-split.md) §3, §4,
[ADR-0044](0044-stacks-staged-cards-under-one-shared-design.md) §3 ·
Card: C-234 · Issue: [#592](https://github.com/AndreyBegma/AgentDock/issues/592) ·
Spec: [`docs/specs/592-make-new-work-cards-candidates-the-perso.md`](../specs/592-make-new-work-cards-candidates-the-perso.md)

## Context

A New work intake made its board card the moment the model wrote it
(`writeCard`), and a confirmed split or stack made all of its cards in one
step. The person read the result only once it was already in Todo — often
after the orchestrator or Auto-run could pick it up — and fixing a title or a
body meant editing a live card, or deleting it. Cards proposed by two intakes
could not be combined either: each intake made its own cards, or its own
stack, and nothing in between.

## Decision

1. **The intake writes candidates, not cards.** A `cardDraft` and every card
   of a confirmed split or stack become rows of `plan_candidates`: the
   intake plan, the position in the proposal, the title, kind and full body
   the model wrote, and — for a stack — the 0-based stage it was proposed
   in. A stack proposal's title, body, design flag and stage titles are kept
   on the plan (`plans.candidateStack`). No board card is made, and the
   intake moves to `reviewing` (amends ADR-0037 §3, ADR-0044 §3: Confirm of
   a split or a stack still validates the person's edits and shape, but
   writes candidates). Confirming is unchanged for the person: the same
   review, the same route, `POST …/plans/:planId/split`.
2. **A candidate is decided once.** Its state is `pending`, `accepted` or
   `rejected`. A pending candidate may be edited by hand — title, kind,
   body — with `PATCH …/plans/:planId/candidates/:id`; the title stays
   ASCII-English as a split title does (ADR-0027 §6, ADR-0037), and the
   edit names the candidate's `version`, so a stale edit is refused
   (`409 candidate_stale`). Reject (`POST …/candidates/:id/reject`) marks it
   rejected and makes nothing. Deciding a candidate that is already decided
   is refused with `409 candidate_decided`, whose body names the card it
   became, if any.
3. **Accept makes the cards** with `POST /projects/:projectId/candidates/accept`:
   one or more pending candidates of the caller's open intakes — possibly
   of several intakes — each named with its `version`, either as
   **independent cards** (no dependency links, as a split's) or as **one
   stack** with the stage each candidate is placed in. The stack is created
   exactly as Confirm of a stack created it (ADR-0044 §2–§4): its stages in
   order, a dependency from every card of a stage on every card of the stage
   before, and a shared design when the candidates came from a stack
   proposal that asked for one. A stack made of one intake's proposed stack
   keeps its title, body and stage titles; any other stack takes the title
   of its first card and stages named `Stage N`. Every card lands in Todo
   with its own intake plan as its origin. Everything in one request commits
   in one transaction, or nothing does.
4. **Attachments go to the first accepted card of each intake** (keeps
   ADR-0037 §4): the first accept that makes a card of an intake claims the
   plan's attachments onto that card; later accepts find none left.
5. **The intake is `done` once no candidate is pending.** Accept and Reject
   close it in the same transaction as the last decision, so it leaves
   Drafts; an intake whose candidates were all rejected is done with no
   card. Discard (archive) of an intake still drops its pending candidates.
6. **Drafts is where candidates are decided.** The Board's Drafts strip shows
   each intake under review as a group of its candidates — Open, Reject,
   Accept on each, **Accept all** on a proposed split or stack (independent
   cards, or the stack as proposed) — and a selection bar for regrouping
   across intakes. The Inbox column stays for captured suggestions
   (ADR-0026). The intake never proposes regrouping candidates it did not
   write.

## Consequences

- `PlanDetail.intake` carries `candidates` and the proposed `stack`; the
  intake phase gains `review`. `ConfirmSplitResponse` returns the candidates
  made, not cards.
- Telegram's New work (#574) ends where the web's does: after the card is
  written or the split confirmed, the chat says the candidates wait in
  Drafts and stops following the intake.
- Concurrency is per plan: every decision locks the plans it touches, in id
  order, before reading their candidates, so two tabs accepting the same
  candidate make one card and the second gets `candidate_decided`.
- Intakes that were already `done` before this change keep their cards;
  there is nothing to migrate.
