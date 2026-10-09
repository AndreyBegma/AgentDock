# Budgets — per project and per user, alert or hard stop

Issue: [#28](https://github.com/AndreyBegma/AgentDock/issues/28) · Roadmap: M3.5 ·
Decisions: [ADR-0009](../adr/0009-api-equivalent-cost-from-a-versioned-price-table.md),
[ADR-0005](../adr/0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md),
[cost-model.md](../architecture/cost-model.md), [data-model.md](../architecture/data-model.md),
[security.md](../architecture/security.md)

## Summary

Agents run on the owner's subscriptions, and once operators can start
orchestrators (#17) and skill runs (#24), spend has to be capped by something
other than the owner looking at `/usage`. This item adds budgets. A budget
belongs to a project or a user, covers a day, week or month in a stated time
zone, and has a limit in API-equivalent dollars (#13). Crossing a threshold
sends a notification (#22). A budget with action `stop` additionally refuses
new spend for its scope: new skill runs and orchestrator start/next. An admin
override is audited, and the budget resets automatically at the period
boundary. Workers already running are never killed by a budget; the reason is
in D7.

## Scope

### In scope

- Tables `budgets`, `budget_periods`, `budget_overrides`.
- Spend attribution to projects and users (D3).
- Near-real-time evaluation on rollup updates, plus a sweep at period boundaries.
- Threshold notifications through #22 (`budget.threshold`, `budget.exceeded`).
- A `BudgetGate` consulted by #24 (skill runs) and #17 (orchestrator start/next).
- Admin override (one period, audited); automatic reset.
- Web:
  - a budget tab in project settings;
  - `/admin/budgets`;
  - indicators on `/usage` and the fleet page.

### Out of scope

- Stopping running workers, or killing an orchestrator mid-round (D7).
- Real billing, invoices, or provider-side limits. Budgets use the API-equivalent figure only.
- Per-model or per-runtime budgets. Scope is project or user.
- Forecasting ("at this rate you hit the limit on Thursday"). An open question.

## Decisions

The person delegated all decisions on 2026-10-07; each below is the default
taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | **Shape.** A budget is `scope` (`project` \| `user`), `scopeId`, `period` (`day` \| `week` \| `month`), `timezone` (IANA, default the server's `APP_TIMEZONE`, else `UTC`), `limitUsd` Decimal, `thresholds` (sorted percent list, default `[50, 80, 100]`; 100 is always present), `action` (`alert` \| `stop`), `enabled`. At most one enabled budget per `(scope, scopeId, period)`. Weeks start on Monday | data-model.md `Budget`; thresholds and timezone are new |
| D2 | **Unit.** Spend is the API-equivalent `costUsd` from #13. Unpriced requests (`costUsd = null`) count as zero toward the budget and are shown next to it as "N unpriced requests". A budget never estimates a price | ADR-0009, cost-model.md |
| D3 | **Attribution.**<br>• **Project spend** = every priced request whose session maps to the project (#12 correlation by cwd / worktree): fleet workers, orchestrator sessions, skill runs, sessions a person started in the project.<br>• **User spend** = requests of runs the user started:<br>&nbsp;&nbsp;– skill runs with `runs.triggeredByType = user` and `triggeredById = user` (#21, #24);<br>&nbsp;&nbsp;– an orchestrator session started through #17. It is matched as the #12 session whose cwd is the project root (not a worktree), on that runner, starting within 120 s after an `orchestrator.start` `command_run` of that user. Ties go to the latest start.<br>• Fleet workers (`orchestrator_slot` runs) are **project-only**: the orchestrator chose to dispatch them, not the user.<br>• Scheduled and webhook-triggered runs are project-only.<br>• A request counts toward at most one user budget and its project budget. | directive; the orchestrator-session match is a heuristic [Unknown — verify against real #12 data in i28-api; if the match proves unreliable, orchestrator sessions become project-only and the spec is amended] |
| D4 | **Where the numbers come from.**<br>• Project spend is summed from #13's `usage_rollups` (`projectId`, hour range).<br>• User spend needs request-level attribution, so `budget_periods` keeps a running `spentUsd` updated incrementally (D5).<br>• Both are recomputable from scratch. The recompute job also rebuilds periods after #13's price recompute changes past costs. | #13 D7; new |
| D5 | **Evaluation.**<br>• #13's rollup service calls `BudgetService.onUsage(batch)` after each rollup upsert. This is one call site in `apps/api/src/usage/**`, owned by this item's lead.<br>• It updates the affected `budget_periods`, debounced to at most once per 30 s per budget.<br>• A sweep every 5 min reconciles every open period against the from-scratch sum and closes periods whose end has passed. The sweep is the safety net; the call is the fast path.<br>• Worst-case detection lag is about the rollup latency plus 30 s. | #13 rollups; new |
| D6 | **Thresholds.** Each threshold fires once per period: a `budget.threshold` notification (percent, spent, limit), and at 100 % `budget.exceeded`. Both go through #22, which adds them to its closed kinds union; #22 already reserves `budget.exceeded`. Recipients: for a project budget, the project's operators and admins; for a user budget, the user and admins. Default channels are in-app plus Telegram | #22 D1, D2 |
| D7 | **Stop means "no new spend", not "kill".** When a `stop` budget is exceeded:<br>• `BudgetGate.check(projectId, userId)` refuses new skill runs (#24) and `orchestrator.start` / `next` (#17) for that scope with `409 budget_exceeded`, naming the budget and its reset time.<br>• The project's running orchestrator is **not** killed. It would only be restarted by a person, and a refused start is the stop.<br>• Running workers are **never** killed.<br>• No `slot.message` is sent to workers either; the fleet page shows a banner.<br>Rationale: killing a worker mid-edit leaves a half-written branch that the orchestrator later resumes (Phase 7c) at full cost — the opposite of saving money — and killing the orchestrator stops merges of work already paid for.<br>`orchestrator.stop` and `slot.stop` stay available to operators for a person who wants a harder stop. | ADR-0005; orchestrator skill Phase 7c [Confirmed]; new |
| D8 | **Override.** An admin may lift a `stop` for the current period: `budget_overrides` row (`budgetId`, `periodStart`, `until` ≤ period end, `reason`, `by`). The gate passes while an override is active; thresholds still notify. Every override, budget create/update/delete and enable/disable is audited (#8) with before/after | security.md; #8 |
| D9 | **Reset.** A period is `[start, end)` computed in the budget's timezone (DST-safe: computed with the zone, stored as UTC instants). The sweep opens the next period lazily on the first evaluation after `end`; fired thresholds and overrides do not carry over | new |
| D10 | **Who manages budgets.**<br>• Project budgets: admins, and operators of that project may view but not edit.<br>• User budgets: admins only; a user sees their own.<br>• Non-members get 404 on project budget routes (#10 D12). | ADR-0008; #10 D12 |
| D11 | **Gate contract.** `BudgetGate` lives in `apps/api/src/budgets/` and exports `check({ projectId, userId }) → { allowed: true } \| { allowed: false, budgetId, scope, resetsAt }`. #17's start/next handler and #24's run handler each add one call before sending a runner command. A missing gate (this item not merged) means allowed | new |
| D12 | **Live.** Period updates publish `budget.updated` on `project:<id>` and `user:<id>` (#9's LiveService), so indicators move without reload | #9 |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261103000000_budgets/`. New
tables only.

| Table | Fields |
|---|---|
| `budgets` | `id`, `scope` (`project` \| `user`), `projectId?` → projects, `userId?` → users (exactly one set, check constraint), `period`, `timezone`, `limitUsd` Decimal(14,4), `thresholds` Int[], `action`, `enabled` Bool, `createdById` → users, `createdAt`, `updatedAt`; partial unique `(scope, projectId, userId, period) WHERE enabled` |
| `budget_periods` | `id`, `budgetId` → budgets (cascade), `start`, `end` (timestamptz), `spentUsd` Decimal(14,6), `unpricedRequests` Int, `firedThresholds` Int[], `exceededAt?`, `reconciledAt`; unique `(budgetId, start)` |
| `budget_overrides` | `id`, `budgetId` → budgets, `periodStart`, `until`, `reason`, `byId` → users, `createdAt`, `revokedAt?`, `revokedById?` |

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| GET | `/projects/:id/budgets` | project viewer+ | budgets of the project with current period (spent, percent, fired thresholds, state `ok` \| `warning` \| `exceeded` \| `overridden`, resetsAt) |
| POST / PATCH / DELETE | `/projects/:id/budgets[/:budgetId]` | admin | D1 validation; audited |
| GET | `/me/budgets` | signed-in | the caller's user budgets and state |
| GET | `/admin/budgets` | admin | all budgets, filter scope / state |
| POST / PATCH / DELETE | `/admin/budgets[/:id]` | admin | user and project budgets |
| POST | `/admin/budgets/:id/override` | admin | `{ until, reason }` → D8 |
| DELETE | `/admin/budgets/:id/override` | admin | revoke the active override |
| POST | `/admin/budgets/recompute` | admin | `{ budgetId? }` → rebuilds periods (D4) |

Error from gated actions (#17, #24): `409 { code: "budget_exceeded", budgetId, scope, resetsAt }`.

## UI

- **Project settings → Budget tab** (`/projects/[projectId]/settings/budget`):
  - budgets with a `Progress` bar (tone by state) and threshold markers;
  - "N unpriced requests" hint;
  - edit dialog (admin);
  - override banner with reason and expiry.
- **`/admin/budgets`:** table of all budgets with scope, period, spent / limit, state; create, override and revoke dialogs.
- **`/usage`:** a budget chip per project (and "your budget" for the signed-in user) linking to the tab.
- **Fleet page:** when a stop budget is exceeded, a `Banner` (glass-ui#70) explains that new starts and skill runs are refused until `resetsAt`, and that running workers continue. If #70 is not released, the fallback is the existing `SectionUnavailable` styling.

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `APP_TIMEZONE` | `apps/api` | default budget timezone (IANA); falls back to `UTC` |

Add to `apps/api/.env.example`.

## Acceptance criteria

- [ ] A project budget of $10/day with thresholds 50/80/100 fires exactly one notification at each threshold as priced requests arrive (fixture ingestion), and none again in the same period.
- [ ] With action `stop`, after 100 %: `POST /projects/:id/orchestrator/start` and starting a skill run on that project return `409 budget_exceeded` with `resetsAt`; `orchestrator.stop`, `slot.stop` and `slot.message` still work.
- [ ] Exceeding a stop budget sends no runner command that kills or messages a running worker or orchestrator (asserted on the runner command log).
- [ ] An admin override until a time lets starts through, is audited with reason, and expires on its own; revoking it restores the refusal immediately.
- [ ] A user budget counts a skill run started by that user and an orchestrator session started by that user through #17 (D3 heuristic, fixture), and does not count fleet worker requests of the same project.
- [ ] A request with no price leaves spend unchanged and increments `unpricedRequests`.
- [ ] Period boundaries: a daily budget in `Europe/Berlin` resets at local midnight, including across a DST change (clock-injected test); fired thresholds start empty in the new period.
- [ ] After #13 recomputes prices for a range, `POST /admin/budgets/recompute` makes every affected period equal a from-scratch sum (test compares).
- [ ] Incremental `spentUsd` equals the from-scratch reconciliation after a randomized ingestion of 1 000 requests.
- [ ] **Authorization:** a non-member of project A gets 404 on `/projects/A/budgets*`; an operator of A can read but gets 403 on create/update/delete/override; `GET /me/budgets` never returns another user's budget; `/admin/budgets*` is 403 for non-admins.
- [ ] Every budget create/update/delete, override and revoke writes an audit record with before/after.
- [ ] `bun run check`, `bun run test`, `bun run build` pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i28-api | schema, migration, budget service, periods, sweep, gate, notifications kinds, audit actions, gate call sites | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261103000000_budgets/**, apps/api/src/budgets/**, apps/api/src/app.module.ts, apps/api/.env.example, packages/shared/src/budgets/**, packages/shared/src/index.ts, packages/shared/src/notifications/kinds.ts, packages/shared/src/audit/actions.ts, apps/api/src/usage/rollups.service.ts, apps/api/src/control/orchestrator.service.ts, apps/api/src/skills/runs.service.ts | — | yes | opus |
| i28-web | budget tab, admin page, indicators, banner | apps/web/src/app/(app)/projects/[projectId]/settings/budget/**, apps/web/src/app/(app)/projects/[projectId]/settings/layout.tsx, apps/web/src/app/admin/budgets/**, apps/web/src/lib/budgets/**, apps/web/src/components/budgets/**, apps/web/src/components/shell/nav.ts | i28-api | no | sonnet |

The three call-site files in `i28-api` are named as #13, #17 and #24 lay them
out. If a file is named differently when this issue is cut, the slot touches
the actual file holding that handler and reports the path; it is one inserted
call per file.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i28-api | distinct new tables only; keep both blocks on conflict |
| apps/api/src/app.module.ts | i28-api | append-only registration; keep both imports |
| packages/shared/src/index.ts | i28-api | one export line; keep both |
| packages/shared/src/notifications/kinds.ts | i28-api | #22's union; appended members only, keep both |
| packages/shared/src/audit/actions.ts | i28-api | #8's union; appended members only, keep both |
| #13 rollup service, #17 orchestrator start handler, #24 run handler | i28-api | one inserted call each; those issues have merged before this one starts |
| apps/web/src/app/(app)/projects/[projectId]/settings/layout.tsx | i28-web | one tab entry; keep both (#17 added its own tab) |
| apps/web/src/components/shell/nav.ts | i28-web | one-line flag flips; keep both |
| bun.lock | regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) | — |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Orchestrator-session attribution to a user (D3) misattributes spend | medium | fixture tests; fall back to project-only and amend the spec if real data disagrees |
| Detection lag lets a fleet overshoot a stop budget | medium | stated in the UI ("no new spend"); the overshoot is bounded by already-running workers, which D7 deliberately lets finish |
| Incremental counters drift from truth | medium | 5-min reconciliation sweep (D5); randomized equality test |
| A gate call missing in a later code path (e.g. #25 schedules, #26 webhooks) | high | `BudgetGate` is the documented contract; #25 and #26 go through #24's run handler, which carries the call |
| DST and week-boundary bugs | low | periods computed with the zone, clock-injected tests |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Should exceeding a stop budget also stop the project's orchestrator session? | No (D7) — a refused restart is the stop; operators keep `orchestrator.stop` |
| Spend forecasting on the budget tab? | Not in this item |
| Should viewers see project budgets? | Yes, read-only (D10) |

## Notes from implementation

i28-api, decided with the orchestrator on 2026-10-09:

- **Amends D4 and D5: spend is rebuilt from `llm_requests`.** Every evaluation
  (the debounced fast path, the 5-minute sweep, a gate check, a recompute)
  recomputes the affected period's `spentUsd` and `unpricedRequests` from
  `llm_requests`, using the D3 attribution and bounded by `[start, end)` and
  scope. The figures stay stored on `budget_periods` for the UI. There are
  two reasons:
  - `usage_rollups` are UTC-hour buckets, so they can't cut a period that
    starts at local midnight in a zone off the whole hour (Asia/Kolkata
    +05:30, Australia/Adelaide);
  - a running increment double-counts a re-sent request (spec 12 D4: the last
    usage wins) and misses a session that moves project or slot afterwards.
    That is the same reason #13 rebuilds rollups instead of incrementing them.

  So "incremental equals from-scratch" holds by construction. The randomized
  1 000-request test checks it anyway, with re-sends.
- **409 body (D11, API).** The body follows every other API error:
  `{ statusCode: 409, error: "budget_exceeded", message, budgetId, scope, resetsAt }`
  (shared `BudgetExceededBody`). It uses `error` where this spec wrote `code`.
  The refusal is thrown before a `command_runs` or `runs` row exists, so it is
  not recorded as a command run.
- **D6: one notification per threshold.** A threshold below 100 sends
  `budget.threshold`. The 100 % threshold sends `budget.exceeded` only, not
  both, so each threshold notifies exactly once. `budget.exceeded` is no
  longer reserved, and `budget.threshold` is appended to the kinds.
- **D11 call sites.** On develop they are `apps/api/src/control/control.service.ts`
  (`ControlService.start`, which covers `mode: next` too),
  `apps/api/src/skills/skill-run.service.ts` (`SkillRunService.start`, the
  entry point #25 and #26 call) and `apps/api/src/usage/rollup.service.ts`
  (`RollupService.rebuildHours`).
  - Each injects its dependency `@Optional()`, so without this module the gate
    is absent and everything is allowed.
  - `BudgetsModule` is `@Global()`, so the control and skills modules do not
    import it.
- **D3 matching details.**
  - A skill run's sessions are those on the project's runner whose cwd is the
    run's `skill_runs.worktree` or below it.
  - An orchestrator session matches only an `orchestrator.start` that ran
    (`ok` or `unknown`).
  - Subagent sessions count with their parent.
- **Schedules (#25) go through the same gate.** A firing calls
  `SkillRunService.start` or `ControlService.start`, so a stop budget refuses
  it with the same 409. Spec 25 D12's `beforeFire` hook still allows
  everything.
  - A firing is project-only (D3). For a skill run, `triggeredByType` is
    `schedule`.
  - For an orchestrator start, the actor is `system`, so the gate checks
    no user budget. A session started by a `command_runs` row that a
    `schedule_firings.commandRunId` points to is nobody's, although the row
    carries the creator's id.
- **Gate freshness.** A gate check evaluates the budget itself, so the gate
  has no detection lag. The lag in D5 applies to notifications and indicators
  only.
- **State** comes from the current spend: `exceeded` while spend ≥ limit,
  `overridden` while that holds and an override is active. `firedThresholds`
  is what has notified. If a price recompute lowers spend below a threshold,
  that threshold does not notify again.

Depends on #13

Depends on #22

Depends on #17

Depends on #24
