# Merge approval queue

Issue: [#20](https://github.com/AndreyBegma/AgentDock/issues/20) · Roadmap: M2.5 ·
Decisions: [ADR-0005](../adr/0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md),
[plugin changes P8](../plugin/code-sentinel-changes.md),
[AndreyBegma/claude-code-plugin#8](https://github.com/AndreyBegma/claude-code-plugin/issues/8)

## Summary

By default the orchestrator merges every green pull request itself. Some projects
want a person to look first. With merge approval on, the orchestrator stops at
"green and mergeable" and waits (plugin change P8). This item gives that person a
queue: every waiting PR with the worker's merge summary, checks and diff size, and
two buttons. **Approve** lets the orchestrator merge it. **Request changes** sends
a note back to the worker through the orchestrator. AgentDock never merges itself
(ADR-0005), and every decision is audited.

## Scope

### In scope

- Detecting "awaiting approval" from #11's PR projection and from the plugin's `pr.awaiting_approval` event (#16).
- API: approval records, queue endpoint, approve and request-changes endpoints.
- Runner commands `pr.approve`, `pr.requestChanges` and `pr.inspect`, with the approval-signal writer isolated in one module.
- Mismatch warning between AgentDock's `mergeApproval` flag and the project's `orchestrator.mergeApproval` config.
- Web `/projects/[projectId]/approvals`.

### Out of scope

- The orchestrator side: waiting, reading the signal, merging or forwarding the note. That is plugin P8, [AndreyBegma/claude-code-plugin#8](https://github.com/AndreyBegma/claude-code-plugin/issues/8).
- Editing `.code-analyzer-config.json` in the project. AgentDock never writes a project's committed files.
- GitHub PR reviews / approvals via the GitHub API (branch protection). The signal goes to the orchestrator, not to GitHub.
- Notifications that a PR is waiting. M2.7 (#22) consumes this item's events.

## Decisions

The person delegated all decisions on 2026-10-07; each below is the default
taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | **Two flags, one truth.** The orchestrator obeys `orchestrator.mergeApproval: true` in the project's `.code-analyzer-config.json` (P8). AgentDock's `projects.mergeApproval` (from #10) is the person's intent. When they differ (from #10's config snapshot), the project settings and the approvals page show a warning telling the person to set the config key. AgentDock never writes that file. | #10 D13; ADR-0010; delegated rule "never edit committed config" |
| D2 | **Awaiting approval.** A PR is listed when **either** the plugin emitted `pr.awaiting_approval { pr, slot, issue }` (#16, source `code-sentinel`) **or**, with no events source, the project's config has `mergeApproval: true` and #11's slot projection shows the slot's PR `green` + mergeable + `pr_open` checkpoint and no merge. An event-sourced row is `source: orchestrator`; a derived one is `source: derived` and labelled as such. | ADR-0002 (events first, scraped fallback) |
| D3 | **Merge summary** is the body of the slot's latest `pull request open — <url>` checkpoint from #11's `slot_checkpoints` (the worker's reply file). Missing → "no summary written". | worker SKILL.md; #11 D5 |
| D4 | **Diff and checks.** On opening a PR row the API calls runner command `pr.inspect { projectId, root, pr }` (viewer) → `gh pr view <n> --json additions,deletions,changedFiles,files,statusCheckRollup,mergeable,mergeStateStatus,url,title,body,state,headRefOid` (`state` and `headRefOid` added for D6 — notes, 3). Result cached 60 s. File list capped at 300 entries. | ADR-0010; `gh` [Confirmed] |
| D5 | **Approval signal (isolated).** `pr.approve` and `pr.requestChanges` write the signal agreed in plugin#8. Working assumption: a JSON file `<git-common-dir>/cs-orchestrator/approvals/<pr>.json` = `{ v: 1, pr, decision: "approved" \| "changes_requested", note?, by, at }`, written atomically (temp + rename). [Unknown — the exact contract is settled in plugin#8.] All knowledge of it lives in `apps/runner/src/commands/approvals/signal.ts`, so a contract change touches one file. If plugin#8 lands a different channel (e.g. `.orchestrator-msg.md` + poke), only that file changes. | P8; ADR-0005 |
| D6 | **Decision is final per head SHA.** An approval records the PR head SHA at decision time. If the PR's head moves afterwards (a new push), the approval is void: the row returns to waiting, and the signal file is rewritten with `decision: "stale"`. | new — an approval of code nobody saw is not an approval |
| D7 | **Request changes** requires a non-empty note (≤ 4 KB). | new |
| D8 | **Audit.** Every approve, request-changes and voided approval writes an audit record (#8): actor, project, PR, head SHA, decision, note. | security.md, #8 |
| D9 | **Authorization.** Listing and inspecting need project membership (viewer). Deciding needs effective project role operator or higher. | ADR-0008, #10 |
| D10 | **Live updates.** Every change publishes `{ kind: "approvals", projectId }` on `project:<id>` through #9's `LiveService`, and emits event `pr.approval_decided` for #21's activity feed and #22's notifications. | #9 |
| D11 | **Command contracts** for `pr.approve` / `pr.requestChanges` were reserved in runner-protocol.md. This item defines their args and result schemas in its own file (`commands/approvals.ts`) and adds `pr.inspect`. #17 owns the control commands; nothing here edits its files. | runner-protocol.md; #17 |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261022000000_approvals/`. New tables only.

| Table | Fields |
|---|---|
| `merge_approvals` | `id`, `projectId` → projects, `prNumber` Int, `slot?`, `issue?` Int, `headSha?`, `source` (`orchestrator` \| `derived`), `status` (`waiting` \| `approved` \| `changes_requested` \| `stale` \| `merged` \| `closed`), `decidedById?` → users, `decidedAt?`, `note?`, `waitingSince`, `createdAt`, `updatedAt`; index `(projectId, prNumber)`; index `(projectId, status)`. At most one *current* row (`waiting` \| `approved`) per PR, enforced in code under a per-project advisory lock — see notes, 4 |

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| GET | `/projects/:id/approvals?status=` | project member | waiting first, then recent decisions; each with PR, slot, issue, checks, summary, source, waitingSince; plus `{ configMismatch: boolean }` |
| GET | `/projects/:id/approvals/:pr` | project member | detail: summary, `pr.inspect` result (diff stats, files, checks) |
| POST | `/projects/:id/approvals/:pr/approve` | project operator+ | `{ headSha }` must equal the current head, else 409 `head_moved`; sends `pr.approve` |
| POST | `/projects/:id/approvals/:pr/request-changes` | project operator+ | `{ headSha, note }`; 422 on empty note |
| — | event ingest | runner gateway (#6) | `pr.awaiting_approval`, `pr.checks_changed`, `pr.closed`, `pr.merged` update rows |

## UI

`/projects/[projectId]/approvals` (nav entry "Approvals", flipped to `enabled: true`
in `apps/web/src/components/shell/nav.ts`; the nav badge shows the waiting count):

- **Banner** when `configMismatch` (glass-ui `Banner` from AndreyBegma/glass-ui#70 when released, else `SectionUnavailable`-style notice): "AgentDock expects approval but the project config does not ask for it", or the reverse.
- **Waiting list**: PR, title, slot, issue, checks dot, `+adds / −dels`, waiting for, source badge (derived rows marked).
- **Detail sheet**: merge summary (markdown), changed files (`Disclosure`), checks list, buttons **Approve** and **Request changes** (dialog with required note). Buttons hidden for viewers.
- **Recent decisions**: who, when, decision, note.

## Configuration

None new. `projects.mergeApproval` already exists (#10).

## Acceptance criteria

- [ ] A `pr.awaiting_approval` event creates a `waiting` row; the PR appears on an open approvals page within 5 s without reload.
- [ ] With no events source, a project whose config has `mergeApproval: true` lists a PR whose slot shows `green` + mergeable + `pr_open` as `source: derived`.
- [ ] Approve with the current head SHA sends `pr.approve`; the runner writes the signal file atomically with `decision: "approved"` (tested in a temp git dir); the row becomes `approved`.
- [ ] Approve with an outdated head SHA returns 409 `head_moved` and sends nothing.
- [ ] A push after approval voids it: the row returns to `waiting` and the signal file is rewritten with `decision: "stale"`.
- [ ] Request changes without a note returns 422; with a note writes `decision: "changes_requested"` and the note.
- [ ] The settings page and the approvals page show the mismatch warning when `projects.mergeApproval` differs from the config snapshot's `orchestrator.mergeApproval`; no request ever writes to the project's files (asserted: the runner has no handler that writes outside `<git-common-dir>/cs-orchestrator/approvals/`).
- [ ] **Authorization:** a non-member of project A gets 404 (per #10 D12) on every `/projects/A/approvals*` route even when a member of project B; a viewer member gets 403 on approve and request-changes; anonymous gets 401.
- [ ] Every decision and every voided approval writes an audit record with actor, PR, head SHA and decision.
- [ ] `bun run check`, `bun run test`, `bun run build` pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i20-api | command contracts, schema, migration, approvals module | packages/shared/src/protocol/commands/approvals.ts, packages/shared/src/protocol/commands.ts, packages/shared/src/protocol/index.ts, apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261022000000_approvals/**, apps/api/src/approvals/**, apps/api/src/app.module.ts | — | yes | opus |
| i20-runner | `pr.inspect`, `pr.approve`, `pr.requestChanges` handlers and the signal writer | apps/runner/src/commands/approvals/** | i20-api | no | sonnet |
| i20-web | approvals page, detail sheet, nav badge | apps/web/src/app/(app)/projects/[projectId]/approvals/**, apps/web/src/lib/approvals/**, apps/web/src/components/shell/nav.ts | i20-api | no | sonnet |

i20-runner and i20-web are cut after i20-api merges and run together. The runner
handler registration is one line in #5's command registry ([Unknown] path until
#5 merges — the slot adds it to its fence).

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i20-api | distinct new tables only — keep both blocks on conflict |
| packages/shared/src/protocol/commands.ts, index.ts | i20-api | append-only registry — keep both lines on conflict |
| apps/api/src/app.module.ts | i20-api | append-only — keep both imports |
| runner command handler registry | i20-runner | append-only — keep both |
| apps/web/src/components/shell/nav.ts | i20-web | one-line flag flip — keep both |
| bun.lock | regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) | — |

Cross-repository: the signal contract comes from
[AndreyBegma/claude-code-plugin#8](https://github.com/AndreyBegma/claude-code-plugin/issues/8).
Until it merges, approvals are recorded and the signal file is written, but no
orchestrator reads it. That is not a blocking dependency for this issue.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| plugin#8 settles a different signal channel | medium | D5 isolates the contract in `signal.ts`; the rest of the item is channel-agnostic |
| Approving without the orchestrator honouring it (config flag off) gives false confidence | high | D1 mismatch warning on both pages; derived rows labelled |
| Approval of a commit that changed after review | high | D6 head-SHA binding, voiding on push |
| `pr.inspect` slow on large PRs | low | 60 s cache, 300-file cap |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Require two approvers for some projects? | No — one operator |
| Let the person approve from Telegram (M2.7)? | Not in this item; #22 links to the page |

## Notes from implementation

i20-api, decided with the orchestrator on 2026-10-08:

1. **plugin#8 is not merged (D5).** Read at
   [claude-code-plugin `develop` `0397e0093a`](https://github.com/AndreyBegma/claude-code-plugin/commit/0397e0093a):
   no `approvals.py` there, and
   [plugin#8](https://github.com/AndreyBegma/claude-code-plugin/issues/8) is
   open. Its issue text already departs from D5's working assumption: the file
   is `{ "decision": "approve" | "request_changes", "note", "by", "at" }`, with
   no `v`, no `pr` and **no `stale`**, and plugin D3 voids an approval itself
   when the file's `at` is older than the head commit's `committedDate`. So the
   command contracts here carry **intent** (`pr.approve`, `pr.requestChanges`,
   `pr.voidApproval`) and never the file's spelling; how a void shows in the
   file (a `stale` decision, or removing it) is `signal.ts`'s call when
   plugin#8 settles. The plugin's `pr.awaiting_approval` is not in
   `normalizeCodeSentinelLine`'s mappers; it arrives raw with `data.pr` and the
   approvals sink reads it as such.
2. **Command registration trap.** `CommandHandlers` in
   `apps/runner/src/commands/dispatcher.ts` needs a handler for every key of
   `commands`, so the four commands are defined and exported from
   `protocol/commands/approvals.ts` (`approvalCommands`) but **not** entered in
   the map. The API sends them from one seam,
   `apps/api/src/approvals/approval-commands.ts`, which answers
   `503 command_unavailable` (audited as `error`) until i20-runner spreads
   `approvalCommands` into `commands` and replaces each body with
   `commandOutput(name, await send(...))`. Both files are outside i20-runner's
   listed fence.
3. **Where the head comes from (D6).** Nothing in AgentDock knew a PR's head
   SHA: not the slot projection, not the runner's `gh pr list` fields, not
   `pr.awaiting_approval`. `pr.inspect` therefore adds `headRefOid` and `state`
   to D4's field list. The API reads the head (a) when a detail opens (cached
   60 s), (b) uncached before every approve and request-changes — the
   authority for `409 head_moved`, which carries the current `headSha` — and
   (c) for voiding: a batch with a `pr.opened`, `pr.checks_changed` or
   `pull request open` checkpoint for a PR with an `approved` row makes the
   sink fire a system-actor `pr.inspect` after its transaction, never blocking
   ingest. With the runner offline the void waits for the next check, and the
   plugin's own freshness rule still refuses the stale approval. Follow-up
   (filed by the orchestrator): the runner's PR collector emits `headSha` on
   `pr.*` events.
4. **No `unique (projectId, prNumber, headSha)`.** A waiting row from
   `pr.awaiting_approval` has no head until someone decides, and "changes
   requested on H, then approved on H without a push" would collide. `headSha`
   is nullable; "at most one current row (`waiting` | `approved`) per PR" is
   kept by the module under `pg_advisory_xact_lock('approvals:<projectId>')`.
   A void (D6) turns the approved row `stale` and opens a new `waiting` row, so
   history keeps who approved which head. `changes_requested` is never
   current: the PR leaves the waiting list until the orchestrator announces it
   again or (derived) its checks move.
5. **A fourth command, `pr.voidApproval` (D6).** D6 rewrites the signal on a
   void, which neither decision command does. It is operator-level and sent by
   the system actor; its outcome is in the `approval.void` record's
   `meta.signal`.
6. **Derived rows (D2) are transition-triggered.** A derived row opens when a
   `pr.opened`, `pr.checks_changed` or `pull request open` checkpoint arrives
   for a PR whose latest slot is open, green, mergeable, not ended and has a
   `pr_open` checkpoint, the config snapshot has `orchestrator.mergeApproval:
   true`, and no `code-sentinel` event for the project arrived within the fleet
   channel window (24 h) or in the batch. A waiting row whose slot leaves green
   is dropped (it was never decided); a plugin event adopts a derived row as
   `orchestrator`. `pr.merged` / `pr.closed` close the current row; a late
   `pr.merged` turns a `closed` row `merged`. A batch resent after a lost ack is
   skipped by `(runnerId, seq)` already in `events`.
7. **422 from the service (D7).** The DTO's `note` is optional so the global
   `ValidationPipe` does not answer 400; the service answers
   `422 note_required` (missing or blank) and `422 note_too_long` (over 4096
   UTF-8 bytes) before anything is sent.
8. **Errors.** `404 approval_not_found` (no row for the PR),
   `409 not_waiting` (no current row, or already approved at that head),
   `409 pr_not_open`, `409 head_moved`, `503 command_unavailable`,
   `502 command_failed`. Every refusal after validation is audited as
   `denied`, a runner failure as `error`.
9. **Audit (D8).** Actions `approval.approve`, `approval.request_changes`
   (actor: the user) and `approval.void` (actor: system), target
   `pull_request:<n>`, `after { pr, headSha, decision, note? }` —
   `approval.void` adds `newHeadSha`.
10. **D10 without the `events` table.** `events` is runner-sourced (unique
    `runnerId, seq`), so the API cannot honestly append `pr.approval_decided`
    there. It is published live on `project:<id>` as `pr.approval_decided`
    `{ projectId, pr, headSha, decision, by, at, note }`, next to the
    `approvals` refetch hint; the `merge_approvals` rows (and the audit log)
    are the durable record #21 and #22 read. `ApprovalsService` is exported
    for #22's approve buttons.
11. **D1 helper.** `mergeApprovalMismatch(project)` and
    `configMergeApproval(config)` in `@agentdock/shared` are what the web
    settings page calls with the project detail it already has; an unread
    config is a mismatch only when AgentDock expects approval.

i20-web:

12. **Nav badge rides the label.** glass-ui's `NavRailItem` has no badge or
    count prop, and ADR-0011 forbids a local component, so the entry reads
    `Approvals · 3` (plain `Approvals` at 0). The count is the number of
    `waiting` rows in `GET /projects/:id/approvals`, refetched (debounced
    300 ms) on the live `approvals` event. Follow-up: a `NavRailItem` badge
    prop in glass-ui, then drop the label suffix.
13. **Merge summary is plain text** (`whitespace-pre-wrap`, as the queue
    sheet shows an issue body): the web app has no markdown renderer.
14. **Decisions need an inspection.** The head SHA a decision binds to (D6)
    is `inspection.headSha` from the detail. While `inspection` is null (the
    runner does not handle `pr.inspect` yet, or could not answer) the sheet
    shows the reason and disables Approve and Request changes; it never
    sends a head it did not get from the API. A `503 command_unavailable`
    on a decision is shown inside the dialog, a `409 head_moved` refetches
    the detail.
15. **D1 on the settings page** is judged on the saved project, not on the
    unsaved toggle, with the same sentence as the approvals page.

Depends on #11

Depends on #17
