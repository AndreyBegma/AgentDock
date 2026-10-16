# Context handoff — a new round or session starts in context, at the cheapest cost

Issue: [#449](https://github.com/AndreyBegma/AgentDock/issues/449) · Decision: [ADR-0042](../adr/0042-context-handoff.md)

## Summary

A card round already resumes the card's Claude session (`--resume card.sessionId`, `apps/api/src/board/board-rounds.service.ts` D5) [Confirmed]. Context is still lost or paid for in four cases:
- **Cache-cold resume.** Returning after an hour or the next morning makes `--resume` re-read the whole history at full input price.
- **Compaction.** Autocompaction keeps a summary and drops the decisions, dead ends and reasons.
- **New sessions.** A dead or killed session, a person's own terminal session (`track_card`), or a re-run design or planner run starts from zero and spends tokens re-learning the task.
- **Person-guided restarts.** A person who wants to steer the next round can only write feedback.

Context handoff gives every unit of work a short, structured **handoff note** that the agent keeps current. The runner then starts the next round or session the cheapest way: `--resume` while that is cheap, or a fresh session seeded with the note, the git diff and the checklist status when the resume would be expensive. Both the "warm-up" cost and the money saved are visible.

## Scope

### In scope
- Card rounds of every trigger: Run, feedback, CI fix, retry, and a Steward resume (#447).
- A person's own terminal sessions on a card: `track_card` and sessions started in a card's branch or worktree.
- Long runner runs: design (`uiprofile`) and planner turns.
- The handoff note, kept by the agent, with a haiku fallback, a freshness check, a viewer and person edits in the card sheet, and the restart decision.
- Measuring the warm-up and showing it on the #445 Token saver dashboard and on the card.

### Out of scope
- Fleet slots (the plugin's, ADR-0005). The #445 plugin follow-up can reuse the note later.
- Changing how Claude Code compacts.
- Sharing notes between different cards.

## Decisions

| # | Decision | Source |
|---|---|---|
| D1 | Applies to card rounds, a person's terminal sessions on a card, and design and planner runs | person, Q1, Q10 |
| D2 | **The agent keeps the note** at key moments: after the plan, after a decision, after a commit, before stopping. The prompt asks for it. If a session died without a fresh note, the runner writes one from the transcript with a **local haiku** (session content stays on the machine) | person, Q2 |
| D3 | **Restart decision by the estimated cost of the first turn.** The runner knows the transcript size and the time of the last turn. Resume cost is the history in tokens, priced as a cache read while the cache is warm and as uncached input once it is cold. Fresh cost is the note plus the diff summary plus the checklist plus the card prompt. The runner picks the cheaper one, records the decision and both estimates on the round, and keeps the old session for a later `--resume` | person, Q3, Q6 |
| D4 | **Storage:** `.agentdock/handoff.md` in the worktree (git-excluded) always, `<run dir>/handoff.md` for runs; a copy in the API **only when the project has session content on** (ADR-0021) | person, Q4; ADR-0021 |
| D5 | **Format:** fixed sections — Goal; Done; Next (ordered); Decisions and why; Dead ends (what was tried and why not); Files touched; How to verify (commands); Checklist status; Open questions — at most ~3k tokens. The runner validates it, and an oversize note is sent back to be shortened | person, Q5 |
| D6 | **A person's terminal session:** the agentdock plugin's existing `SessionStart` hook [Confirmed: `plugins/agentdock/hooks/hooks.json`] adds the card's note to the session's context when the session starts in a card's branch or worktree; `track_card` on a card with a note returns it; a new MCP tool `resume_context` returns it on demand | person, Q7 |
| D7 | **Person edits:** the note is shown in the card sheet and editable there (with session content on). A person's edit is marked as an instruction from the person, and the agent never rewrites those lines | person, Q8 |
| D8 | **Freshness:** at `Stop` [Confirmed hook] and before compaction, the runner checks that the note is newer than the last commit and the last decision. If it is stale, the agent is asked once to update it. If the session is dead, haiku updates it from the transcript. [Unknown] Claude Code `PreCompact` is not in the plugin's hooks today; the runner slot confirms the hook exists and adds it, else the check runs at `Stop` only | person, Q9 |
| D9 | **Measure the warm-up:** tokens and time from a round's start to its first file edit, split by resume and fresh, before and after; shown on the Token saver dashboard (#445); on the card: `resumed from handoff · saved ≈ $x` | person, Q11 |

## Data / Schema

- `handoff_notes`:
  - `id`;
  - `subjectKind` (`card` | `run`), `subjectId`, `projectId`;
  - `content` (text);
  - `personLines` (jsonb ranges marked as the person's);
  - `updatedBy` (`agent` | `haiku` | `person`), `updatedAt`.

  Unique `(subjectKind, subjectId)`. Rows exist only for projects with session content on.
- New nullable columns on `board_card_rounds`:
  - `restartMode` (`resume` | `fresh` | `first`);
  - `restartEstimate` (jsonb: `{ resumeTokens, freshTokens, cacheWarm }`);
  - `warmupTokens`, `warmupMs`.
- Migration: `apps/api/prisma/migrations/20261204000000_context_handoff/`. The newest already assigned are `20261202000000_token_saver` (#445) and `20261203000000_steward` (#447).

## API

- Runner → API:
  - `handoff.updated` with the content, only with session content on;
  - `round.restart` with the mode and the estimates;
  - `round.warmup` with the tokens and ms.
- `GET /board/cards/:n/handoff` returns the note, with session content on.
- `PUT /board/cards/:n/handoff` (operator) applies a person's edit. The API sends it to the runner as a typed command, `card.handoff.set` (ADR-0010).
- The card view gets `restartMode` and `warmupSavedUsd` for the latest round.
- **Authorization:** project A's member cannot read or write project B's notes (e2e).

## UI

- The card sheet gets a **Handoff** section: the note's sections, who updated it and when, an **Edit** button for operators (person lines highlighted), and an empty state when session content is off ("kept on the machine").
- The card gets a chip: `resumed from handoff · saved ≈ $x`, or `resumed session`.
- The Token saver dashboard gets a **Warm-up** chart: resume vs fresh, before and after.

## Configuration

- Context handoff is on with Token saver (#445): the same project setting, with no new switch.

## Acceptance criteria

- [ ] **Note:**
  - the worker prompt asks for the note;
  - a round that commits and stops with a stale note gets exactly one update request;
  - a dead session's note is written by haiku from the transcript (runner tests with fixtures).
- [ ] **Format:** a note missing a section or over the size limit is rejected with the reason, and the agent rewrites it.
- [ ] **Restart decision:**
  - with a warm cache and a short history the next round uses `--resume`;
  - with a cold cache and a long history it starts a fresh session whose first prompt contains the note, a diff summary and the checklist status;
  - both estimates and the decision are stored on the round.
- [ ] **Old session kept:** after a fresh start, the previous session id is still recorded and can be resumed.
- [ ] **Terminal:**
  - a Claude Code session started in a card's worktree gets the note through `SessionStart`;
  - `track_card` on that card returns it;
  - `resume_context` returns it.
- [ ] **Person edit:** an operator edit appears in the next round's note, marked as the person's; the agent's next update keeps those lines.
- [ ] **Privacy:** with session content off, no note content reaches the API, and the card sheet shows the empty state.
- [ ] **Runs:** an interrupted design generation restarted for the same revision starts from its run's note, not from zero.
- [ ] **Measure:** warm-up tokens and ms are recorded per round and charted (resume vs fresh); the card shows `resumed from handoff · saved ≈ $x`.
- [ ] **Authorization:** project A's member gets 403/404 for project B's notes (e2e).
- [ ] `docs/guides/context-handoff.md` explains the note, the restart decision and how to steer a round by editing the note.

## Parallel plan

Three waves:
1. i449-contract.
2. i449-runner, i449-api.
3. i449-web.

Slots that share files with #445 and #447 start after those slots merge.

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i449-contract | schema + migration, shared note schema and validation, events, the `card.handoff.set` command, the `resume_context` MCP contract, card view fields, docs | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261204000000_context_handoff/**, packages/shared/src/handoff/**, packages/shared/src/index.ts, packages/shared/src/protocol/messages.ts, packages/shared/src/protocol/commands/handoff.ts, packages/shared/src/protocol/commands.ts, packages/shared/src/protocol/capabilities.ts, packages/shared/src/board/contracts.ts, docs/architecture/runner-protocol.md | #447 i447-contract merged | yes | opus |
| i449-runner | note lifecycle (freshness at Stop and PreCompact, haiku fallback, validation), restart decision and fresh seeding, design and planner run notes, SessionStart injection, `track_card` / `resume_context`, worker prompt section | apps/runner/src/handoff/**, apps/runner/src/cards/executor.ts, apps/runner/src/cards/launch.ts, apps/runner/src/hooks/**, apps/runner/src/mcp/tools.ts, apps/runner/src/uiprofile/executor.ts, apps/runner/src/planner/launch.ts, plugins/agentdock/hooks/hooks.json, packages/shared/src/board/worker-prompt.ts | i449-contract, #447 i447-runner merged | no | opus |
| i449-api | note copy and person edits, restart and warm-up ingest, card view fields, authorization e2e | apps/api/src/handoff/**, apps/api/src/app.module.ts, apps/api/src/board/board-mapper.ts, apps/api/src/board/board-rounds.service.ts | i449-contract, #447 i447-api merged | no | sonnet |
| i449-web | card sheet Handoff section and editor, restart chip, Warm-up chart on the Token saver dashboard, guide | apps/web/src/components/board/card-sheet.tsx, apps/web/src/components/board/card-face.tsx, apps/web/src/components/board/handoff/**, apps/web/src/app/(app)/projects/[projectId]/token-saver/**, apps/web/src/lib/handoff/**, docs/ui/screens.md, docs/guides/context-handoff.md | i449-api, #447 i447-web merged | no | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma, migration `20261204000000_context_handoff` | i449-contract | do not open it |
| packages/shared/src/protocol/**, packages/shared/src/index.ts, packages/shared/src/board/contracts.ts | i449-contract | do not open them |
| packages/shared/src/board/worker-prompt.ts, apps/runner/src/cards/executor.ts | i449-runner, after #445 i445-launch and #447 i447-runner | do not open them |
| apps/api/src/board/board-mapper.ts, board-rounds.service.ts | i449-api, after #447 i447-api | do not open them |
| apps/web/src/components/board/card-sheet.tsx, card-face.tsx, token-saver page | i449-web, after #447 i447-web | do not open them |

## Risks

- **High — a fresh start misses something the old session knew.** Mitigations:
  - the fixed sections include Dead ends and Decisions;
  - the freshness check runs at `Stop` and before compaction;
  - the old session is kept and can be resumed;
  - the warm-up metric shows whether fresh starts re-explore (a high warm-up means the note is thin).
- **Medium — the cost estimate is wrong**, for example because the cache TTL is unknown. Mitigations: both estimates are recorded and compared with the real usage of the turn (ADR-0003), and the rule can be tuned from data.
- **Medium — note upkeep costs tokens.** Mitigation: the note is capped at ~3k tokens and updated at key moments only. Its cost appears in the warm-up comparison.
- **Low — privacy.** Mitigation: note content leaves the machine only with session content on (ADR-0021).

## Open questions

- The cache TTL the estimate assumes. Default: 5 minutes unless the session's usage shows 1-hour cache writes; the runner reads it from the transcript's usage.
- The fresh-start diff size. Default: `git diff --stat` plus the full diff of up to 300 lines, else the stat only.

Depends on #445
Depends on #447
