# Task queue from GitHub issues + create issue

Issue: [#19](https://github.com/AndreyBegma/AgentDock/issues/19) · Roadmap: M2.4 ·
Decisions: [ADR-0004](../adr/0004-github-issues-are-the-task-queue.md),
[ADR-0005](../adr/0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md),
[runner-protocol.md](../architecture/runner-protocol.md)

## Summary

The orchestrator's queue is the project's open GitHub issues carrying the ready
label (ADR-0004). This item lets a project member see that queue the way the
orchestrator sees it: every ready issue with its state (`IN FLIGHT`, `READY`,
`BLOCKED — work`, `BLOCKED — person`, `NO SPEC`), the reason, and what would
clear it, plus slots held for a lead. When the orchestrator has written a fresher
verdict on a round board, that verdict wins over AgentDock's own computation. An
operator can also file a new issue from the UI, and it is queued only when its
body is complete enough to dispatch.

## Scope

### In scope

- Runner collector `issues`: polls the project's open issues through the runner's `gh`.
- Issue snapshot event types in `packages/shared/src/protocol/events/queue.ts`.
- API: issue cache table, queue-state computation, endpoints, live pushes.
- Runner command `issue.create` (operator+).
- Web `/projects/[projectId]/queue`: list view and Board view, plus a create-issue dialog.

### Out of scope

- Writing a specification from the UI ("Specify with cs-spec"), which is a skill run in M3.1.
- Editing, labelling, closing or reprioritising existing issues from the UI. GitHub stays the editor.
- GitHub App webhooks (M3.4). This item polls.
- Dispatching anything. The orchestrator dispatches (ADR-0005).

## Decisions

The person delegated all decisions on 2026-10-07; each below is the default
taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | **Polling.** The runner collector `issues` runs every 60 s per project, through the runner's own `gh`:<br>`gh api -H 'If-None-Match: <etag>' 'repos/<owner>/<repo>/issues?state=open&per_page=100'` (paginated), keeping the ETag per project. A `304` costs no rate limit and emits nothing. This returns every open issue, not only ready ones, because a blocking `Depends on #m` may point at an issue without the label. Pull requests in the response (`pull_request` key) are skipped. | ADR-0004; GitHub REST conditional requests [Confirmed in GitHub docs] |
| D2 | **Snapshots, not diffs.** On a changed response the collector emits one `issues.snapshot` event per project: `{ fetchedAt, issues: [{ number, title, state, labels[], assignees[], body, updatedAt, url }] }`. Bodies are trimmed to 64 KB. Closed-since-last-snapshot issues are detected server-side by absence. Closure *reason* (merged PR vs. closed) is fetched only for issues named in a `Depends on` line: `gh api repos/<o>/<r>/issues/<n>/timeline` once per newly closed dependency, emitted as `issue.closed { number, closedBy: pr \| manual, pr? }`. | event-schema.md (`issue.closed`) |
| D3 | **State computation mirrors the orchestrator's Phase 2 exactly.** For each open issue with the ready label (project's `readyLabelOverride`, else `orchestrator.readyLabel` from the config snapshot, else `cs:ready`):<br>• `IN FLIGHT`: an open PR says `Closes #n` (from #11's PR polling), or a branch `*/<n>-*` has a live slot, or label `cs:in-flight`.<br>• `BLOCKED — person`: label `cs:needs-person`, or a `Gate:` line in the body (quoted).<br>• `BLOCKED — work`: a `Depends on #m` whose `m` is open, or closed without a merged PR. The blocker is named.<br>• `NO SPEC`: the body has no acceptance criteria (no `## Acceptance criteria` section with at least one `- [ ]` item and no `Acceptance criteria` checkbox list) and no reproduction for a `bug`-labelled issue (`## Steps to reproduce` / `## Reproduction`); or a `size: XL`/`size: XXL` label without `## Parallel plan`.<br>• `READY`: none of the above.<br>The precedence is the order above. | orchestrator SKILL.md Phase 2 [Confirmed] |
| D4 | **The orchestrator's verdict wins when fresher.** The latest `round.decided` (from #11's board parser, or from #16's `events.jsonl`) carries one row per issue with `state`, `why` and `clears`. When that round is newer than the issue's last snapshot change, its row is shown as the state, with `source: orchestrator`. Otherwise AgentDock's computed state is shown, with `source: computed`. When both exist and disagree, the UI shows the orchestrator's verdict and a muted "AgentDock computes X" note. | ADR-0005 (one brain); #11 D4 |
| D5 | **Held for a lead** comes only from the orchestrator's latest round (`Held for a lead` table). AgentDock does not recompute waves. A `## Parallel plan` in a body is parsed only to list slot names, lead and model under the issue. | ADR-0005; orchestrator Phase 2 wave rule |
| D6 | **Priority order** in the list follows the orchestrator's: `priority: critical` > `high` > `medium` > none, then lowest number. | orchestrator Phase 3 [Confirmed] |
| D7 | **Create issue.** Runner command `issue.create { projectId, title, body, labels[], queue: boolean }` (operator+, ADR-0010). The runner runs `gh issue create --repo <owner/repo> --title … --body-file <tmp> --label …`. With `queue: true` it adds the ready label **only** if the body passes the same completeness rule as D3's `NO SPEC` check, mirroring `/code-sentinel:issue --ready`. Otherwise it creates the issue unlabelled and returns `{ queued: false, reason: "no_acceptance_criteria" }`. The API validates the same rule before sending, so the UI explains it up front. Labels are restricted to labels that exist on the repository (from the snapshot's label set), plus `enhancement`/`bug`. | cs-issue `--ready` rule [Confirmed]; ADR-0010 |
| D8 | **Audit.** `issue.create` writes an audit record (#8) with the title, labels, queue flag and resulting issue number. Reading the queue is not audited. | security.md, #8 |
| D9 | **Live updates.** Each snapshot or state change publishes `{ kind: "queue", projectId }` on `project:<id>` through #9's `LiveService`, and clients refetch. | #9 |
| D10 | **Authorization.** Reading needs project membership (`ProjectAccessGuard`, viewer). Creating an issue needs effective project role operator or higher (`@ProjectRole('operator')`). | ADR-0008, #10 |
| D11 | **Board view** uses glass-ui `Board` with five fixed read-only columns, one per state. Drag is disabled: state comes from GitHub and the orchestrator, never from the UI. | glass-ui README (Board exists) [Confirmed] |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261021000000_queue/`. New tables only.

| Table | Fields |
|---|---|
| `issues_cache` | `id`, `projectId` → projects, `number` Int, `title`, `state` (`open` \| `closed`), `labels` Json, `assignees` Json, `body` (≤ 64 KB), `url`, `ghUpdatedAt`, `closedBy?` (`pr` \| `manual`), `closingPr?` Int, `snapshotAt`; unique `(projectId, number)` |
| `queue_states` | `id`, `projectId` → projects, `issueNumber` Int, `state` (`in_flight` \| `ready` \| `blocked_work` \| `blocked_person` \| `no_spec`), `why`, `clears?`, `source` (`computed` \| `orchestrator`), `orchestratorState?`, `blockers` Json (issue numbers / files), `waveSlots` Json?, `computedAt`; unique `(projectId, issueNumber)` |

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| GET | `/projects/:id/queue?state=` | project member | ready issues with state, why, clears, source, priority, wave slots; held-for-lead rows from the latest round; `snapshotAt` |
| GET | `/projects/:id/queue/:number` | project member | one issue: body (rendered by the web as markdown), state history from the latest rounds, blockers with links |
| POST | `/projects/:id/issues` | project operator+ | `{ title, body, labels[], queue }` → sends `issue.create`; returns `{ number, url, queued, reason? }`; `422 no_acceptance_criteria` when `queue: true` and the body fails D7 |
| POST | `/projects/:id/queue/refresh` | project operator+ | asks the runner for an immediate poll (command `project.refresh` from #10, scoped to issues) |
| — | event ingest | runner gateway (#6) | `issues.snapshot`, `issue.closed` → cache → state computation |

## UI

`/projects/[projectId]/queue` (nav entry "Queue", flipped to `enabled: true` in
`apps/web/src/components/shell/nav.ts`):

- **Toolbar** (glass-ui `Toolbar`): List / Board segmented switch, state filter chips, "Refresh", "New issue" (operator+ only).
- **List** (glass-ui `DataTable` from AndreyBegma/glass-ui#67 when released, else `Table`): number, title, state badge (ready ok, in flight neutral, blocked work warn, blocked person danger, no spec muted), why, clears, source dot, priority.
- **Board**: five columns per D11, cards with number, title, why.
- **Held for a lead**: a section under the list, from the latest round.
- **Issue sheet**: body, blockers, wave slots, link to GitHub.
- **New issue dialog**: title, body (`Textarea`), labels (`Combobox`, multiple), "Queue for the orchestrator" toggle with the completeness hint inline. Disabled toggle and explanation when the body has no acceptance criteria.

## Configuration

| Key | Where | Meaning |
|---|---|---|
| `queue.pollSeconds` | runner config, per project | default 60 |

## Acceptance criteria

- [ ] With a fixture snapshot, each issue lands in the state D3 prescribes: a body with `Depends on #m` where `m` is open → `BLOCKED — work` naming `#m`; `Gate:` line → `BLOCKED — person` quoting it; no acceptance criteria → `NO SPEC`; `size: XL` without `## Parallel plan` → `NO SPEC`; an open PR with `Closes #n` → `IN FLIGHT`; otherwise `READY`. One table-driven test per row.
- [ ] A dependency closed **by a merged PR** unblocks its dependants; one closed manually keeps them `BLOCKED — work`.
- [ ] When a `round.decided` newer than the snapshot says `BLOCKED — work` for an issue AgentDock computes as `READY`, the API returns the orchestrator's state with `source: orchestrator` and the computed state alongside.
- [ ] The collector sends `If-None-Match`; a `304` produces no event (asserted with a stubbed `gh`).
- [ ] Creating an issue with `queue: true` and a body containing `## Acceptance criteria` + a `- [ ]` item creates it with the ready label; without them the API returns 422 and nothing is sent to the runner.
- [ ] A new issue appears on an open queue page without reload within 5 s of the next snapshot.
- [ ] **Authorization:** a non-member of project A gets 404 (per #10 D12) on every `/projects/A/queue*` and `/projects/A/issues` route even when a member of project B; a viewer member gets 403 on `POST /projects/A/issues` and `POST /projects/A/queue/refresh`; anonymous gets 401.
- [ ] `issue.create` writes an audit record with actor, project, title, labels and result.
- [ ] `bun run check`, `bun run test`, `bun run build` pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i19-api | event types, schema, migration, state computation, endpoints, `issue.create` command contract | packages/shared/src/protocol/events/queue.ts, packages/shared/src/protocol/commands/queue.ts, packages/shared/src/protocol/commands.ts, packages/shared/src/protocol/index.ts, apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261021000000_queue/**, apps/api/src/queue/**, apps/api/src/app.module.ts | — | yes | opus |
| i19-runner | `issues` collector and `issue.create` handler | apps/runner/src/collectors/issues/**, apps/runner/src/collectors/index.ts, apps/runner/src/commands/queue/** | i19-api | no | sonnet |
| i19-web | queue page, board, new-issue dialog | apps/web/src/app/(app)/projects/[projectId]/queue/**, apps/web/src/lib/queue/**, apps/web/src/components/shell/nav.ts | i19-api | no | sonnet |

i19-runner and i19-web are cut after i19-api merges and run together. The runner
handler registers in #5's command registry with one line; the exact registry file
is whatever #5 created ([Unknown] until #5 merges — the slot adds it to its fence
if it is outside `apps/runner/src/commands/queue/**`).

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i19-api | distinct new tables only — keep both blocks on conflict |
| packages/shared/src/protocol/commands.ts, index.ts | i19-api | append-only registry — keep both lines on conflict |
| apps/api/src/app.module.ts | i19-api | append-only — keep both imports |
| apps/runner/src/collectors/index.ts, runner command handler registry | i19-runner | append-only — keep both |
| apps/web/src/components/shell/nav.ts | i19-web | one-line flag flip — keep both |
| bun.lock | regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) | — |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| AgentDock's computed state drifts from the orchestrator's rules | medium | D4: the orchestrator's verdict wins; disagreements are shown, not hidden; table-driven tests cite Phase 2 |
| Acceptance-criteria detection is heuristic | medium | the same rule in API and runner, shared from `packages/shared`; the UI shows why the toggle is disabled |
| Large repositories (>100 open issues) cost several pages per change | low | ETag on page 1; full pagination only when page 1 changed |
| `gh` auth missing on the runner | low | collector reports `issues.unavailable` with the `gh` error; the page shows it |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Show non-ready open issues too? | Yes, behind an "All open" filter, without a state |
| Let operators add the ready label to an existing issue? | No in this item — GitHub stays the editor |

Depends on #10

Depends on #11
