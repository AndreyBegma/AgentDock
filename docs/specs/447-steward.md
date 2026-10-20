# Steward — detect stuck agent work, fix the safe cases, tell the person in one line

Issue: [#447](https://github.com/AndreyBegma/Nautelle/issues/447) · Decision: [ADR-0040](../adr/0040-steward.md)

## Summary

Today a person keeps the fleet alive by watching terminals. On 2026-10-16 the orchestrator session caught all of the following by hand:
- a wait loop that matched its own `pgrep -f` and blocked a card for 7.5 hours;
- false **Waiting for you** states;
- a `finish_card` lost to a brief disconnect;
- a Claude Code dialog blocking a session;
- an `API Error: Connection lost mid-response` that left a worker idle;
- a commit with a Claude attribution trailer;
- a duplicate issue for a card that already had one;
- fleet cards stuck in a column.

Some of these are already fixed: #390 (background phase), #424 and #433 (fleet cards), #434 (`finish_card` retry), #435 (one known dialog), #389 (test database), and the artifact guard in #445. Steward is the layer that covers the rest. It watches every card and runner run, fixes the safe cases itself within limits, and tells the person in one line only when a person is needed. It also sends a digest.

Steward is not a chat assistant and not a second orchestrator (ADR-0005).

## Scope

### In scope
- **Stall detection** for card rounds and runner runs (skills, design, planner, assess, capture, normalize):
  - immediate signals read from the session's pane and transcript: an API error, an interrupted response, a modal dialog, a permission prompt, the quota banner;
  - a silence threshold.
- **Classification:** rules for every known case, and a local haiku for an unknown stall.
- **Safe actions**, each with limits:
  - nudge after an API or network error;
  - dismiss a known no-decision dialog (the #435 list);
  - resume a dead card session.
- **Escalation:** one notification per incident through the existing notification rules (web and Telegram).
- **Trailer guard:** the runner does not push a card's commits that carry a Claude attribution trailer; the worker is told to rewrite them.
- **Issue link:** a card can be linked to an existing issue. Run then creates no new one, and the PR says `Closes #n`.
- **Digest:** daily and on leaving away mode, in Telegram and on the web Overview.
- **UI:**
  - incidents in Activity, with a Steward filter;
  - a chip on the card and the history in the card sheet;
  - a Steward tab in project settings.

### Out of scope
- Acting on fleet slots. They are the orchestrator's (ADR-0005). Steward observes them, escalates and includes them in the digest.
- Chat or Q&A with an assistant, and team or tenant roles. These are for the cloud version.
- Answering permission prompts, merging, or changing code. Never.
- Carrying context between rounds. That is a separate spec.

## Decisions

| # | Decision | Source |
|---|---|---|
| D1 | v1 contains stall detection with actions and escalation, dead-session resume, the trailer guard with issue linking, and the digest | person, Q1 |
| D2 | **The runner observes and acts locally**: it reads panes and transcripts and does nudge, dismiss and resume (ADR-0001, ADR-0010: each action is a typed command). **The API decides and reports**: rules, incident lifecycle, notifications and the digest | person, Q2 |
| D3 | Rules classify the known cases. An unknown stall is classified by **haiku run locally by the runner** through the launch profile, which returns a one-line reason. haiku also writes the digest prose | person, Q3, Q11 |
| D4 | Autonomy: Steward performs the safe actions (D9–D11) itself and records each one. Anything else goes to the person | person, Q4 |
| D5 | Steward acts on Board cards and runner runs. **The fleet is observe-only**: its incidents are escalated and included in the digest, and Steward never sends a slot a command | person, Q5; ADR-0005 |
| D6 | **Stalled** means a round or run in `running` or `waiting` with no hook event and no live background task (#390) for the project's **silence threshold** (default 10 min). An API error, dialog, permission prompt or quota banner in the pane is detected at the next pane poll, without waiting for the threshold | person, Q6 |
| D7 | **Trailer guard:** before the runner pushes a card's commits (#359 draft push and collect), it checks every new commit message for `Co-Authored-By: Claude` / `Claude-Session:` / `Generated with Claude Code`. On a hit it does not push, and it gives the worker the list of commits to rewrite (no automatic rebase). The worker prompt states the rule | person, Q7 |
| D8 | **Issue link:** the card's existing `issueNumber` / `issueUrl` become editable in the card sheet. The field is validated: the issue exists in the project's repository and is open. If the card text has `Closes #n` or `GitHub issue: #n`, the link is suggested. A linked card's Run creates no issue, and its PR body has `Closes #n` | person, Q8 |
| D9 | **Nudge** after an API error or interrupted response: at most 2 per round, the first at once and the second 2 minutes later. The text is "The previous response was cut off by an API/network error. Continue from where you stopped." A third error escalates | person, Q9 |
| D10 | **Resume** of a dead card session (tmux session gone, host reboot): automatic, at most 2 per round, only when the round's worktree exists. It uses `--resume <session id>` in the same worktree with "The session was restarted after a crash. Continue from where you stopped." A round a person stopped is never resumed. Past the limit, or with no worktree, Steward escalates | person, Q10 |
| D11 | **Dismiss** only the dialogs in the #435 list, which needs no decision. Unknown dialogs and permission prompts escalate at once with "open the terminal" | person, Q4; #435 |
| D12 | **Privacy:** pane and transcript text stays on the runner. The API receives the incident kind, the one-line reason and the action taken. A pane tail goes with the notification only when the project has session content on (ADR-0021) | person, Q11; ADR-0021 |
| D13 | **Escalation:** one notification per incident. A changed reason notifies again. Recovery closes the incident with a "resolved" Activity entry and no push. A new notification kind is `steward.incident` | person, Q15 |
| D14 | **Digest:** daily at the project's digest time (default 09:00, the person's timezone) and when away mode is switched off ("while you were away"). It goes to Telegram and to a panel on Overview. Content: done (merged and finished), stuck with the reason, waiting on the person, spend. It runs as a schedule on BullMQ (ADR-0015) | person, Q12 |
| D15 | **UI:** Activity shows each incident (reason, action, result) with a **Steward** filter; the card shows a chip, e.g. `Stuck: API error · nudged 1/2`; the card sheet lists the card's incidents | person, Q13 |
| D16 | **Settings:** Steward is on by default; the project settings tab holds the switch, the silence threshold, the digest time, and an on/off for each automatic action (nudge, dismiss, resume, trailer guard); haiku spend counts against the project budget | person, Q14 |

## Data / Schema

- `steward_settings`:
  - `projectId` PK/FK;
  - `enabled` (default true);
  - `silenceMinutes` (default 10);
  - `digestTime` (default `09:00`);
  - `autoNudge`, `autoDismiss`, `autoResume`, `trailerGuard` (all default true);
  - `updatedAt`.

  A missing row means the defaults.
- `steward_incidents`:
  - `id`, `projectId`;
  - `subjectKind` (`card_round` | `run` | `fleet_slot`), `subjectId`;
  - `kind` (`api_error` | `dialog` | `permission_prompt` | `quota` | `silent` | `dead_session` | `trailer` | `unknown`);
  - `reason` (text, one line);
  - `actions` (jsonb array of `{ action, at, result }`);
  - `status` (`open` | `resolved` | `escalated`);
  - `openedAt`, `resolvedAt`, `notifiedReason`.

  Indexes: `(projectId, openedAt)` and `(subjectKind, subjectId, status)`.
- Migration: `apps/api/prisma/migrations/20261203000000_steward/`. The newest already assigned are `20261130000000_design_frames` (#441), `20261201000000_card_auto_run` (#443) and `20261202000000_token_saver` (#445).
- `board_cards.issueNumber` / `issueUrl` exist already [Confirmed], so the issue link adds no column.

## API

- Runner → API events:
  - `steward.observed`: subject, kind, reason, pane-tail-if-allowed;
  - `steward.acted`: subject, action, result.
- API → runner typed commands (ADR-0010): `session.nudge` (card round or run, text), `session.dismiss` (dialog id from the #435 list) and `card.resume` (round). Each is allowlisted and capability-gated, the same way `tokenSaver` is in #445.
- `GET/PUT /projects/:id/steward` returns the settings (admin for PUT).
- `GET /projects/:id/steward/incidents?status&from&to`.
- `GET /projects/:id/steward/digest/latest`.
- `PATCH /board/cards/:n` accepts `issueNumber` (validated as in D8). The card's Run skips issue creation when `issueNumber` is set. [Unknown] Whether today's Run already skips creation when `issueNumber` is set; the API slot confirms it and makes it so.
- **Authorization:** a member of project A never reads project B's settings, incidents or digest. This is an e2e acceptance criterion.

## UI

- Activity gets a **Steward** filter. Incident rows show the reason, the actions taken (`nudged 1/2`, `resumed`, `dismissed dialog`) and the status.
- The card face shows a chip while an incident is open. The card sheet has a **Steward** section with the card's incidents and an editable **Issue** field (D8).
- Overview gets a **Digest** panel with the latest digest.
- Project settings get a **Steward** tab (D16). Use glass-ui components only (ADR-0011).

## Acceptance criteria

- [ ] **API error:**
  - a pane fixture with `API Error: Connection lost mid-response` and an idle prompt is nudged within one pane poll, and again 2 minutes later on a repeat;
  - a third error escalates with one `steward.incident` notification (runner and API tests).
- [ ] **Silence:**
  - a round with no hook event and no background task for the threshold opens a `silent` incident;
  - haiku is called only when no rule matched, and its one-line reason is stored;
  - a round with a live background task never opens a `silent` incident.
- [ ] **Dialogs:** a known dialog is dismissed; an unknown dialog or a permission prompt is never answered and escalates at once.
- [ ] **Resume:**
  - a killed card tmux session with its worktree present is resumed with `--resume` at most twice per round;
  - a round stopped by a person is never resumed;
  - a missing worktree escalates.
- [ ] **Trailer guard:**
  - a card commit with `Co-Authored-By: Claude …` is not pushed;
  - the worker receives the commit list;
  - after the rewrite the push goes through (runner test with a fake `git`/`gh`).
- [ ] **Issue link:**
  - a card linked to open issue #n runs without creating an issue, and its PR body has `Closes #n`;
  - linking to a closed or missing issue is refused;
  - `Closes #n` in the text is suggested.
- [ ] **Dedupe:** one notification per incident; a changed reason notifies again; recovery writes "resolved" to Activity without a push.
- [ ] **Privacy:** with session content off, no pane or transcript text reaches the API (asserted on the `steward.observed` payload).
- [ ] **Fleet observe-only:** a stalled fleet slot opens an incident and a notification, and no command is sent to its session.
- [ ] **Digest:**
  - at the configured time, and when away mode is switched off, a digest with done / stuck / waiting / spend is delivered to Telegram (when configured) and shown on Overview;
  - with the runner offline, a template digest without haiku prose is used.
- [ ] **Settings:**
  - every automatic action can be switched off and is then not performed (it escalates instead);
  - Steward off means no incidents and no actions;
  - haiku spend appears in the project budget.
- [ ] **Authorization:** project A's member gets 403/404 for project B's Steward settings, incidents and digest (e2e).
- [ ] **UI:** the Activity filter, the card chip and sheet section, the Overview panel and the settings tab work, with screenshots in the PR.
- [ ] `docs/architecture/runner-protocol.md` documents the events and commands, and `docs/guides/steward.md` explains what Steward does by itself and what it escalates.

## Parallel plan

Three waves:
1. i447-contract.
2. i447-runner, i447-api, i447-digest.
3. i447-web.

Every slot that touches files of the #445 wave waits for that slot's PR to merge.

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i447-contract | schema + migration, shared types (incident kinds, settings, events, commands, capability, notification kind), runner-protocol doc, compile stubs | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261203000000_steward/**, packages/shared/src/steward/**, packages/shared/src/index.ts, packages/shared/src/protocol/messages.ts, packages/shared/src/protocol/commands/steward.ts, packages/shared/src/protocol/commands.ts, packages/shared/src/protocol/capabilities.ts, packages/shared/src/notifications/kinds.ts, docs/architecture/runner-protocol.md | #445 i445-contract merged | yes | opus |
| i447-runner | pane and transcript observers and rules, local haiku classifier, the nudge / dismiss / resume commands, the trailer guard on push, the worker-prompt trailer rule | apps/runner/src/steward/**, apps/runner/src/cards/push.ts, apps/runner/src/cards/executor.ts, apps/runner/src/cards/push*.spec.ts, apps/runner/src/commands/handlers.ts, packages/shared/src/board/worker-prompt.ts | i447-contract, #445 i445-launch merged | no | opus |
| i447-api | incident lifecycle and dedupe, escalation, settings and incidents API, command dispatch gated by the settings, issue link validation and Run skip, card view chip field, authorization e2e | apps/api/src/steward/**, apps/api/src/app.module.ts, apps/api/src/notifications/event-mapping.ts, apps/api/src/board/board-mapper.ts, apps/api/src/board/board-rounds.service.ts, apps/api/src/board/dto.ts, apps/api/src/board/board.service.ts | i447-contract, #445 i445-api merged | no | sonnet |
| i447-digest | daily schedule and away-off trigger, digest composition (haiku prose through the runner, template fallback), Telegram delivery | apps/api/src/steward-digest/** | i447-contract | no | sonnet |
| i447-web | Activity filter, card chip and sheet section with the Issue field, Overview digest panel, Steward settings tab, guide and screens | apps/web/src/app/(app)/activity/**, apps/web/src/app/(app)/page.tsx, apps/web/src/components/overview/**, apps/web/src/components/board/card-face.tsx, apps/web/src/components/board/card-sheet.tsx, apps/web/src/app/(app)/projects/[projectId]/settings/**, apps/web/src/lib/steward/**, docs/ui/screens.md, docs/guides/steward.md | i447-api, #445 i445-web merged | no | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma, migration `20261203000000_steward` | i447-contract | do not open it |
| packages/shared/src/protocol/**, packages/shared/src/index.ts | i447-contract | do not open it |
| packages/shared/src/board/worker-prompt.ts | i447-runner, after #445 i445-launch | do not open it |
| apps/api/src/board/board-mapper.ts, board-rounds.service.ts | i447-api, after #445 i445-api | do not open them |
| apps/web/src/components/board/card-face.tsx, card-sheet.tsx | i447-web, after #445 i445-web | do not open them |

## Risks

- **High — an automatic action does harm.** Mitigations:
  - only nudge (fixed text), dismiss (a fixed list) and resume (same session, same worktree);
  - limits per round;
  - never a person-stopped round, never a permission prompt;
  - each action can be switched off.
- **Medium — false stalls on long silent steps.** Mitigations:
  - live background tasks exclude a round (#390);
  - the threshold is a setting;
  - a `silent` incident only escalates and takes no action.
- **Medium — haiku cost or latency.** Mitigations: it runs only on unknown stalls and for the digest, and counts against the budget.
- **Low — notification noise.** Mitigation: dedupe per incident (D13).

## Open questions

- The digest timezone. Default: the person's profile timezone, else the server's.
- The pane-poll interval. Default: the runner's existing card poll (#435 uses it).

Depends on #445
