# Planner — from a brief to reviewed tasks, grilled per task, sent to the fleet

Issue: [#172](https://github.com/AndreyBegma/AgentDock/issues/172) · Roadmap: M3.7 ·
Decisions: [ADR-0019](../adr/0019-planner-instructions-live-in-agentdock.md),
[ADR-0004](../adr/0004-github-issues-are-the-task-queue.md),
[ADR-0005](../adr/0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md),
[ADR-0008](../adr/0008-local-accounts-with-admin-approved-registration.md),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md) ·
Builds on: [#19](19-task-queue.md), [#21](21-activity-feed-and-history.md), [#24](24-skills.md), [#28](28-budgets.md)

## Summary

Today a person turns an idea into work for the fleet by hand: run
`/code-sentinel:spec` in a terminal, answer its rounds, then file and label the
issue. The task queue (#19) explicitly deferred "Specify with cs-spec" from the
UI. The Planner moves that whole loop into AgentDock.

1. The person writes a free-text **brief** to a project.
2. The planner, a headless Claude session on the project's runner, **splits it
   into draft tasks**. Each task is a bug or a feature.
3. Where a task needs decisions, the person **talks it through** in numbered
   rounds of questions. Each question has options and a recommendation, the
   way `/code-sentinel:spec` grills. Then the planner writes the task's
   document.
4. The person **approves, rejects or asks for a rewrite** of each task, and can
   revise the whole plan in one pass.
5. **Send to fleet** files every approved task as a GitHub issue, with real
   `Depends on #` links, and queues them.
6. A **graph** shows the plan's tasks and their dependencies. After sending, it
   shows live progress: queued, in flight, PR open, merged.

All tasks of all plans are also listed on one **Tasks** page.

## Scope

### In scope

- **Shared contract** (`packages/shared/src/planner/`):
  - the planner output contract, versioned, with a parser and validator;
  - the plan, task, question and turn types;
  - the default planner instructions.
- **Schema:** `planner_instructions`, `planner_settings`, `plans`, `plan_tasks`,
  `plan_turns`. The `RunKind` enum gains `plan`.
- **Runner commands:**
  - `plan.turn` and `plan.cancel`: a headless turn in the plan's worktree, with
    session resume and fork;
  - `plan.close`: remove the plan's worktree;
  - `plan.publish_specs`: the docs pull request;
  - `plan.queue_issues`: add the ready label.
- **API:**
  - plans, turns, task review, revise, visibility, send to fleet;
  - `GET /tasks` across projects;
  - instructions and settings at the global and project level;
  - audit records and live pushes.
- **Web:**
  - `/projects/[projectId]/planner`: brief, plans, task review, question
    cards, chat, plan graph;
  - `/tasks`: the cross-project table;
  - the instructions editors: `/admin/planner`, plus a Planner section in
    project settings;
  - nav entries.

### Out of scope

- **File upload in the brief.** The brief is text only; attachments are a later item.
- **A code-sentinel skill for the planner.** ADR-0019 keeps the instructions in
  AgentDock. Moving them into the plugin later is allowed and not planned.
- **The "Plan this" action on the Fleet canvas.** It lands with #160 as one
  link to `/projects/[projectId]/planner?brief=`, so #160 does not depend on
  this item.
- **Notifications** when a turn finishes (#22 rules). The live page updates;
  pushing to Telegram or email is a follow-up.
- **Codex as the planner runtime.** `plan.turn` with a codex profile returns
  `unsupported_runtime`, as `skill.run` does (#24).
- **Per-task privacy** (Q14): privacy is per plan only.

## Decisions

The person answered each round on 2026-10-13. Rows marked *default* follow an
existing record and were read back and confirmed.

| # | Decision | Source |
|---|---|---|
| D1 | **The flow.** Brief → **decompose** into draft tasks → per task, **grill** in rounds when needed → **write** the task's document → **review** (approve / reject / rewrite) → **revise** the plan → **send to fleet**. | Q1, Q5, Q7 |
| D2 | **Two modes, chosen when the plan starts.**<br>• **Batch:** the first turn decomposes the brief straight away.<br>• **Dialogue:** the first turns ask plan-level questions in rounds, and decompose once those are settled.<br>Both modes run in one Claude session per plan. | Q1 (a and b) |
| D3 | **A turn is one headless run, never a long-lived process.**<br>• The first turn runs `claude -p --session-id <uuid>`; every later plan-level turn runs `claude -p --resume <uuid>`.<br>• A task's conversation is a **fork** of the plan session: its first turn runs `--resume <plan session> --fork-session`, and later turns resume the fork's own id. Every task's conversation sees the plan's context, and no task's conversation leaks into another's.<br>• A turn survives a runner or server restart, because the session is on disk. | Q5; Claude Code CLI `--session-id`, `--resume`, `--fork-session` [Confirmed in `claude --help`] |
| D4 | **A task is one issue, of one of two kinds.**<br>• **bug:** reproduction, expected, actual, scope. It passes #19 D3's completeness rule for a bug.<br>• **feature:** a full specification in the shape `/code-sentinel:spec` writes (summary, scope, decisions, acceptance criteria). It carries a `## Parallel plan` and `## Contention` when it is large enough to split into slots. | Q2 |
| D5 | **Drafts live only in AgentDock's database.** Nothing reaches GitHub before *Send to fleet*. A rejected task never becomes an issue. | Q3; ADR-0004 (GitHub is the queue, a draft is not queue yet) |
| D6 | **The planner decides whether a task needs a conversation.** Every question carries `blocking: boolean`.<br>• A **blocking** question has no safe default. While one is unanswered, the task is `needs_talk` and cannot be approved.<br>• A **non-blocking** question has a default. The task is `ready` and can be approved as it is; the defaults taken are written into the document's `## Open questions`. | Q11 |
| D7 | **Question cards.** A grill round is a list of questions. Each has a number, a title, the question, 0–6 options, a recommendation (an option or free text) and the one line of why. For each card the person can accept the recommendation, pick another option, or answer in their own words. The whole round goes back as **one turn**. A free-text chat message is also a turn. When the planner reports the conversation `done`, the API chains a **write** turn, which produces the task's document. | Q11; the `/code-sentinel:spec` grilling shape |
| D8 | **Send to fleet is per plan, never per task.** It runs only when the plan has at least one approved task and no task in `needs_talk`. In one action it:<br>• creates an issue for every approved task (`issue.create`, #19 D7). Kind `bug` gets the `bug` label, kind `feature` gets `enhancement`;<br>• rewrites each body's `Depends on <task key>` lines into `Depends on #<number>`, ordered by the dependency graph;<br>• queues the issues as D10 says.<br>A cycle in `dependsOn` is refused with `dependency_cycle` and names the tasks. | Q6 (b) |
| D9 | **Revise is batched.** Rewrite comments accumulate on tasks (`rewrite_requested`). **Revise plan** runs one plan-level turn with every comment and the current task list. It produces the next **plan version**:<br>• approved tasks are **frozen** and passed through unchanged;<br>• rejected tasks are dropped;<br>• new or changed tasks come back as drafts.<br>Earlier versions stay readable. | Q7 (a) |
| D10 | **How a feature's specification is published is set per project** (`planner_settings.specOutput`).<br>• **`docs_pr`**, the default when the project has a `specDir` (#10):<br>&nbsp;&nbsp;– Send to fleet first runs `plan.publish_specs`: one docs pull request on branch `docs/plan-<shortid>`, with `<specDir>/<issue>-<slug>.md` per feature task;<br>&nbsp;&nbsp;– the issue body is a summary that links the file;<br>&nbsp;&nbsp;– bugs are queued at once;<br>&nbsp;&nbsp;– feature issues are queued (`plan.queue_issues`) when #11's PR polling sees that docs pull request merged.<br>• **`issue_body`**, the default with no `specDir`: the issue body is the whole specification, and every issue is queued at once.<br>This keeps cs-spec's rule that documentation lands first. | Q8; `/code-sentinel:spec` Phase 6; docs/specs/README.md |
| D11 | **The planner's instructions live in AgentDock and are editable, in two layers** (ADR-0019).<br>• **Output contract:** in code (`packages/shared/src/planner/contract.ts`), versioned (`contractVersion: 1`), not editable. It is always appended after the instructions.<br>• **Instructions:** how to split work, how to ask, the spec rules. A global default (seeded from `default-instructions.md`) is edited by a site **admin**; a project override is edited by the project's **admin**. Each save is a new version, and each plan records the instructions version it ran with. | Q10, Q13, Q15 |
| D12 | **Privacy is per plan, private by default.**<br>• `visibility: private` means only its author sees it, including in `/tasks`. Site admins are not an exception (see Open questions).<br>• **Share with project** sets `visibility: project`: every member of the project sees it, and operators act on it.<br>• Send to fleet makes a private plan `project` first, after a confirmation that says why: the issues are visible to everyone with access to the repository.<br>• Tasks inherit their plan's visibility. | Q12, Q14 |
| D13 | **Roles** (*default*, following #24 D14 and ADR-0008):<br>• **Read a plan:** its author, or a member (viewer) of a `project`-visible plan.<br>• **Start a plan, write turns, review tasks, revise, share, send to fleet:** project operator or higher, and only on plans the person can read.<br>• **Edit instructions and settings:** a project override needs project admin; the global default needs site admin.<br>**Audit actions:** `plan.created`, `plan.shared`, `plan.revised`, `plan.sent`, `plan.task_reviewed`, `planner.instructions_updated`, `planner.settings_updated`. | ADR-0008; #24 D14 |
| D14 | **Model, runtime and cost** (*default*).<br>• Model `opus` and the project's default runtime profile (#10). Both can be changed when the plan starts, and they apply to every turn of the plan.<br>• Every turn is a `runs` row of kind **`plan`** (#21), so its sessions, tokens and cost are recorded (#12, #13), and budgets (#28) may refuse it like a skill run. | #24 D9, #28 |
| D15 | **One worktree per plan, read-only** (*default*).<br>• The first turn creates `<parent>/.wt-<repo>-plan-<shortid>` from `origin/<base>`, detached. It is kept for the plan's life, because `--resume` needs the session's original directory.<br>• Turns run with `--permission-mode plan`, so the planner reads the code and writes nothing.<br>• `plan.close` removes the worktree when the plan is archived or sent. The runner's cleanup job also removes worktrees of plans idle for 14 days.<br>• Before every turn the runner fast-forwards the worktree to `origin/<base>`. | #24 D7; Claude Code `--resume` keys sessions by directory [Confirmed] |
| D16 | **The prompt reaches the runner as data, never as a shell string** (ADR-0010).<br>• The API assembles: the instructions; the contract; the action (`decompose`, `clarify`, `grill`, `write`, `revise`); the brief; the plan state; the answers.<br>• `plan.turn` carries the assembly as a field. The runner writes it to `<runDir>/prompt.md` and passes it to `claude -p` on stdin.<br>• The allowlist gains only the typed `plan.*` commands. | ADR-0010; #24 D7 |
| D17 | **A turn's result is parsed by the API, not the runner.** The runner returns the final `result` text and the session id. The API extracts the one fenced block tagged `agentdock-plan` and validates it against the contract. A turn whose output does not validate fails with `contract_violation`, and its raw text is kept on the turn for inspection. No partial state is applied. | new |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261107000000_planner/`. Five
new tables and one enum value: `RunKind` gains `plan`, an alteration owned by
the lead slot.

| Table | Fields |
|---|---|
| `planner_instructions` | `id`, `projectId?` → projects (null = global), `version` Int, `body` Text, `authorId` → users, `createdAt`; unique `(projectId, version)` |
| `planner_settings` | `projectId` PK → projects, `specOutput` (`docs_pr` \| `issue_body`), `updatedById` → users, `updatedAt` |
| `plans` | `id`, `projectId` → projects, `authorId` → users, `title`, `brief` Text, `mode` (`batch` \| `dialogue`), `visibility` (`private` \| `project`), `status` (`clarifying` \| `drafting` \| `reviewing` \| `sending` \| `sent` \| `archived`), `version` Int, `sessionId` Uuid, `instructionsId` → planner_instructions, `contractVersion` Int, `profileKey`, `model`, `worktree?`, `docsPrNumber?`, `docsPrUrl?`, `createdAt`, `updatedAt`, `sentAt?` |
| `plan_tasks` | `id`, `planId` → plans, `key` (stable within a plan, e.g. `t3`), `planVersion` Int, `kind` (`bug` \| `feature`), `title`, `summary` Text, `dependsOn` String[] (task keys), `status` (`draft` \| `needs_talk` \| `ready` \| `approved` \| `rejected` \| `rewrite_requested` \| `issued`), `questions` Json, `document` Text?, `rewriteComment` Text?, `frozen` Boolean, `sessionId?` Uuid (the fork), `issueNumber?`, `issueUrl?`, `queuedAt?`; unique `(planId, key, planVersion)` |
| `plan_turns` | `id`, `planId` → plans, `taskId?` → plan_tasks, `runId` → runs, `action` (`decompose` \| `clarify` \| `grill` \| `write` \| `revise`), `authorId` → users, `input` Json (message and answers), `output` Json?, `resultText` Text?, `phase` (`queued` \| `running` \| `succeeded` \| `failed` \| `cancelled`), `error?`, `createdAt`, `finishedAt?` |

**After an issue exists, its live status is not stored.** `/tasks` and the
plan graph join `plan_tasks.issueNumber` with #19's issue cache and queue
state, and #11's slots and pull requests:

| Status | Comes from |
|---|---|
| `queued` | the issue carries the ready label |
| `in_flight` | #19 D3 `IN FLIGHT` |
| `pr_open` | an open pull request says `Closes #n` |
| `merged` | that pull request merged |
| `closed` | the issue is closed |

## Output contract (v1)

Every turn's final message must contain exactly one fenced block tagged
`agentdock-plan`, holding JSON. The shape depends on the action:

```
Question  = { id, title, question, options: [{ id, label, detail? }] (0–6),
              recommendation: { optionId? , text, why }, blocking: boolean }
Answer    = { questionId, optionId? , text? }          // in the turn input

clarify   → { action: "clarify", questions: Question[], done: boolean }
decompose → { action: "decompose", title, tasks: [{ key, kind, title, summary,
              dependsOn: key[], questions: Question[] }] }
grill     → { action: "grill", taskKey, questions: Question[], done: boolean }
write     → { action: "write", taskKey, document: markdown, assumptions: string[] }
revise    → { action: "revise", tasks: [ …as decompose, plus unchanged keys of frozen tasks ] }
```

The parser in `packages/shared/src/planner/contract.ts` rejects:

- unknown keys;
- a `dependsOn` naming a key that does not exist;
- more than 12 tasks per plan, or more than 8 questions per round;
- a feature document without `## Acceptance criteria`;
- a bug document without `## Reproduction`.

## Protocol

New file `packages/shared/src/protocol/commands/planner.ts`, with one
registration line in `commands.ts` and one export line in `index.ts`.

| Command | Args | Min role | Result |
|---|---|---|---|
| `plan.turn` | `{ planId, turnId, runId, projectId, root, base, session: { id, resume: boolean, forkFrom?: uuid }, prompt (≤ 256 KiB), profileKey, model, timeoutSec }` | operator | `{ phase: "queued" \| "running" }`; progress as events `plan_turn.phase_changed`, `plan_turn.finished { resultText, sessionId, exitCode }` |
| `plan.cancel` | `{ planId, turnId }` | operator | `{ cancelled }` |
| `plan.close` | `{ planId, projectId }` | operator | `{ removed }` |
| `plan.publish_specs` | `{ planId, projectId, root, base, branch, files: [{ path, content }], title, body }` (each `path` under the project's `specDir`; no `..`) | operator | `{ prNumber, prUrl }` — commit without trailers, push, `gh pr create` into base |
| `plan.queue_issues` | `{ projectId, numbers: int[] }` (≤ 50) | operator | `{ labelled: int[] }` — `gh issue edit --add-label <readyLabel>` |

Concurrency: plan turns share #24's per-runner cap (`skills.maxConcurrentRuns`).
A turn over the cap waits as `queued`.

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| POST | `/projects/:projectId/plans` | operator | `{ brief, mode, model?, profileKey? }`. Creates the plan (`private`) and its first turn (`clarify` in dialogue mode, `decompose` in batch mode) |
| GET | `/projects/:projectId/plans` | viewer | plans the caller may read |
| GET | `/projects/:projectId/plans/:planId` | reader of the plan | plan, current-version tasks, turns, graph |
| POST | `/projects/:projectId/plans/:planId/turns` | operator + reader | plan-level `{ message?, answers? }`. Refused while a turn is running (`turn_in_progress`) |
| POST | `/projects/:projectId/plans/:planId/tasks/:key/turns` | operator + reader | task-level grill `{ message?, answers? }`. When the result says `done`, a `write` turn is chained |
| POST | `/projects/:projectId/plans/:planId/tasks/:key/review` | operator + reader | `{ decision: approve \| reject \| rewrite, comment? }`. `approve` is refused while a blocking question is open (`needs_talk`) |
| POST | `/projects/:projectId/plans/:planId/revise` | operator + reader | the D9 revise turn |
| POST | `/projects/:projectId/plans/:planId/visibility` | author | `{ visibility }` |
| POST | `/projects/:projectId/plans/:planId/send` | operator + reader | D8 + D10. Idempotent per plan version: a retry continues where it stopped |
| POST | `/projects/:projectId/plans/:planId/archive` | author or project admin | `plan.close` and status `archived` |
| POST | `/projects/:projectId/plans/:planId/turns/:turnId/cancel` | operator + reader | `plan.cancel` |
| GET | `/tasks?projectId=&kind=&status=&planId=&q=&cursor=` | any member | tasks of readable plans in the caller's projects only, with the derived live status |
| GET / PUT | `/admin/planner/instructions` | site admin | global instructions; PUT writes a new version |
| GET / PUT | `/projects/:projectId/planner/settings` | GET: viewer; PUT: project admin | `{ specOutput, instructionsOverride? }`; a non-empty override writes a new project version, an empty one clears it |

**Live:** every turn phase change, review, revise and send publishes
`{ kind: "planner", projectId, planId }` on `project:<id>`. The message carries
ids only, so a client refetches, and the refetch is authorized.

## UI

All of it is glass-ui (ADR-0011) and dark-first, following #163's look.

- **`/projects/[projectId]/planner`**
  - **Composer:** a large textarea for the brief, the mode (`SegmentedControl`:
    Batch · Dialogue), and model and profile (`Select`). **Plan** is the
    primary action.
  - **Plan list:** title, author, visibility chip, status, task counts by
    status, updated time. A private plan shows a lock.
  - **Plan view:**
    - **Left:** the task list as cards. Each card shows kind (bug / feature
      icon and colour), title, summary, status pill, open-question count
      ("2 blocking"), and approve, reject and rewrite actions.
    - **Centre:** the **plan graph** (`FlowGraph`, layered left to right). Its
      nodes are tasks coloured by kind, and its edges are `dependsOn`. After
      sending, each node shows its live status and links its issue and pull
      request.
    - **Right panel** (opened by clicking a task):
      - **Conversation:** question cards for the current round. Each card has
        a recommendation badge, option radios, a free-text answer, and
        **Accept all recommendations**. Earlier rounds collapse. A chat
        composer sits below.
      - **Document:** the task's markdown through the shared `<Markdown>`.
      - **History:** the plan versions this task appeared in.
    - **Header:** plan title, version, visibility with **Share with project**,
      **Revise plan** (enabled when a rewrite is pending), and **Send to
      fleet** (enabled per D8; it shows a confirmation that lists the issues
      it will create and the publication mode).
  - **Dialogue mode before decomposition:** the centre shows plan-level
    question rounds in place of the graph.
  - **A running turn:** a `Spinner` and the live log line (#24 D13 relay with
    kind `run_log`), and a Cancel action.
  - **A failed turn:** the error, with **Retry turn**. For a
    `contract_violation`, the raw output sits in a `Disclosure`.
- **`/tasks`:** a `DataTable` of tasks across the caller's projects. Columns:
  project, plan, key and title, kind, status (draft through merged), issue,
  pull request, updated time. It has filters (`Select`s, collapsed into a
  sheet at 390 px) and clickable rows that open the task in its plan.
- **Instructions editors:**
  - **`/admin/planner`:** the global instructions, with a version list, a diff
    against the previous version, and restore.
  - **Project settings → Planner:** `specOutput` and the override editor, with
    the same version list.
  - Both show the fixed output contract read-only, so the editor knows what
    must not be asked of the model.
- **Nav:** Workspace gets **Tasks**; the project section gets **Planner**.

## Configuration

No new environment variables. Runner config reuses
`skills.maxConcurrentRuns` and `skills.defaultTimeoutSec`. A plan turn's
default timeout is 20 min.

## Acceptance criteria

### Contract and schema (`i172-contract`)
- [ ] `packages/shared/src/planner/` exports:
  - the contract types and `parsePlannerOutput(text, action)`;
  - `default-instructions.md`.

  Unit tests cover every action's valid fixture, and each rejection listed
  under *Output contract*: unknown key, dangling `dependsOn`, too many tasks
  or questions, a feature without acceptance criteria, a bug without
  reproduction, zero or two `agentdock-plan` blocks.
- [ ] The migration `20261107000000_planner` creates the five tables and adds
  `plan` to `RunKind`. The global instructions are seeded as version 1 from
  `default-instructions.md`.
- [ ] `packages/shared/src/protocol/commands/planner.ts` defines the five
  commands with schemas. A `plan.publish_specs` path outside `specDir`, or
  one containing `..`, fails the schema.

### Runner (`i172-runner`)
- [ ] `plan.turn` behaves as D3, D15 and D16:
  - the first turn creates the worktree and runs with `--session-id`;
  - later turns use `--resume`;
  - a task's first turn uses `--resume <plan session> --fork-session` and
    reports the new session id;
  - the prompt goes in on stdin from `prompt.md`;
  - the permission mode is `plan`;
  - the worktree is fast-forwarded before each turn.

  This is tested against a fake `claude` binary that records its argv, its
  stdin and its cwd.
- [ ] `plan.cancel` kills the turn's tmux session. `plan.close` removes the
  worktree. The idle cleanup removes worktrees of plans idle for 14 days.
- [ ] `plan.publish_specs` opens one pull request with exactly the given
  files, and the commit carries no `Co-Authored-By` or `Claude-Session`
  trailer.
- [ ] `plan.queue_issues` adds the project's ready label. A codex profile
  returns `unsupported_runtime`.

### API (`i172-api`)
- [ ] The full flow passes in an e2e test, with a stubbed runner that returns
  contract fixtures. A batch plan:
  - is created;
  - decomposes into 3 tasks, one of which has a blocking question;
  - refuses `approve` on that task with `needs_talk`;
  - grills it until `done`, after which the `write` turn is chained;
  - approves 2 tasks and rejects 1;
  - is sent: it creates 2 issues with `Depends on #<real number>`, and queues
    them as D10 says for both `specOutput` values.
- [ ] Revise behaves as D9: frozen tasks pass through unchanged, rejected
  tasks are dropped, and `version` increments. A `dependsOn` cycle on send
  returns `dependency_cycle`.
- [ ] A turn whose output does not validate ends `contract_violation`, keeps
  `resultText`, and changes no task.
- [ ] **Authorization:** user B, an operator of the same project, gets 404 for
  user A's private plan on every path:
  - `GET` plan;
  - plan list;
  - turns;
  - review;
  - send;
  - `/tasks`.

  After **Share with project**, B can read the plan and act on it. A
  non-member gets 404 everywhere. A viewer can read a shared plan and gets
  403 on every write. A project operator gets 403 on `PUT` settings; a
  project admin gets 200.
- [ ] Every audit action in D13 is written, with the plan id and the issue
  numbers where they apply.
- [ ] Plan turns appear as `runs` of kind `plan`, with cost, and a budget
  that refuses runs (#28) refuses a plan turn too.

### Planner page (`i172-web-planner`)
- [ ] The composer, plan list, plan view (task cards, graph, right panel) and
  dialogue mode work as described under *UI*.
- [ ] Question cards:
  - each card shows the recommendation;
  - **Accept all recommendations** fills every card;
  - one submit sends the whole round;
  - the cards are keyboard operable.
- [ ] After sending, the plan graph shows each node's live status and its
  issue and PR links.
- [ ] The running, failed and `contract_violation` states render as
  described.
- [ ] The page is checked with the Playwright MCP at 1440 and 390 px, in both
  themes, with screenshots in the pull request.

### Tasks, editors, nav (`i172-web-tasks`)
- [ ] `/tasks`:
  - shows only readable tasks;
  - its filters are kept in the URL;
  - rows open the task in its plan;
  - nothing scrolls horizontally at 390 px.
- [ ] The `/admin/planner` editor and the project settings Planner section:
  - save new versions;
  - list and diff versions;
  - restore an older version;
  - show the fixed contract read-only.
- [ ] Nav: Workspace has **Tasks**, the project section has **Planner**, and
  exactly one nav item is active on each.
- [ ] `docs/ui/screens.md` has rows for every new screen, the planner screens
  included.

### All slots
- [ ] `bun run check`, the web tests and the build pass. The api e2e suite
  runs only in `i172-api`, and the runner suite only in `i172-runner`.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i172-contract | contract, types, default instructions, schema, migration, protocol commands | packages/shared/src/planner/**, packages/shared/src/protocol/commands/planner.ts, packages/shared/src/protocol/commands.ts, packages/shared/src/index.ts, apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261107000000_planner/** | — | yes | opus |
| i172-runner | the `plan.*` commands on the runner | apps/runner/src/planner/**, apps/runner/src/commands/handlers.ts | i172-contract | no | opus |
| i172-api | the planner API module | apps/api/src/planner/**, apps/api/src/app.module.ts | i172-contract | no | opus |
| i172-web-planner | the Planner page | apps/web/src/app/(app)/projects/[projectId]/planner/**, apps/web/src/lib/planner/**, apps/web/src/components/planner/** | i172-contract | no | opus |
| i172-web-tasks | `/tasks`, the instruction editors, nav, screen docs | apps/web/src/app/(app)/tasks/**, apps/web/src/lib/tasks/**, apps/web/src/app/admin/planner/**, apps/web/src/app/(app)/projects/[projectId]/settings/**, apps/web/src/components/shell/nav.ts, apps/web/src/components/shell/nav.test.ts, docs/ui/screens.md | i172-contract | no | sonnet |

**What cannot be parallelised:** the lead goes first. The other four run
together once it has merged. The web slots build against the shared types and
the documented API, with fixtures, and do not wait for `i172-api`.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| `apps/api/prisma/schema.prisma`, the migration, `RunKind` | i172-contract | do not open |
| `packages/shared/src/protocol/commands.ts`, `packages/shared/src/index.ts` | i172-contract | do not open |
| `apps/runner/src/commands/handlers.ts` | i172-runner | do not open |
| `apps/api/src/app.module.ts` | i172-api | do not open |
| `apps/web/src/components/shell/nav.ts` | i172-web-tasks (adds both Tasks and Planner) | do not open |
| `docs/ui/screens.md` | i172-web-tasks (rows for every new screen, planner included) | do not open; report your screens in `.orchestrator-reply.md` |
| `docs/specs/README.md` status row | the last slot to merge | — |

## Risks

- **High — output quality depends on prompts in a database.** A bad
  instructions edit degrades every new plan. Mitigation: the contract layer is
  fixed, so a bad edit cannot break the UI. Versions can be restored. Each
  plan records its version, so a regression is traceable.
- **Medium — `--fork-session` and `--resume` behaviour across Claude Code
  versions.** Mitigation: the runner tests pin the argv; a turn fails loudly
  with the CLI's error, not silently.
- **Medium — cost.** Every round is an opus turn over the repository.
  Mitigation: the turns are `runs` with cost and budgets (#28); the per-runner
  cap applies.
- **Medium — the docs pull request (D10) delays the queue.** Mitigation:
  bugs are queued at once, and the docs PR is one per plan. The orchestrator
  merges a green docs pull request.
- **Low — 14-day worktrees accumulate on disk.** Mitigation: idle cleanup and
  `plan.close` on archive or send.

## Open questions

- **Can a site admin read private plans?** Default: no. Privacy is the
  author's. An admin can still see the issues once a plan is sent.
- **A cap on tasks per plan.** Default: 12, enforced by the contract parser.
  A bigger brief is two plans.
- **Do sent plans accept a new revise turn?** Default: no. A sent plan is
  read-only. Follow-up work is a new plan, which can link the old one in its
  brief.

Depends on #163
Depends on glass-ui#94 (FlowGraph, released and adopted in apps/web)
