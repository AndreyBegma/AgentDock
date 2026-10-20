# Agent workspace — data contract, runner and API

Issue: [#160](https://github.com/AndreyBegma/AgentDock/issues/160) (slot
`i160-data`, the lead) · Decisions:
[ADR-0001](../adr/0001-control-plane-and-per-machine-runner.md),
[ADR-0005](../adr/0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md),
[runner-protocol.md](../architecture/runner-protocol.md) (`slot.message_seen`,
`worktree.status`)

## Summary

The issue is the specification of the screen. This note records what the data
slot added for the two web slots (`i160-canvas`, `i160-panel`):
- the shared types;
- one fleet event and one runner command;
- three read routes.

It also explains why the new command stays within ADR-0001 and ADR-0010.
No schema change, no new Nest module.

## Shared types (`@agentdock/shared`, `fleet/`)

| Type | File | What it is |
|---|---|---|
| `FleetGraph` | `fleet/graph.ts` | `{ projectId, nodes, edges, generatedAt }` |
| `FleetGraphNode` | `fleet/graph.ts` | `orchestrator` · `slot` · `planned`, each with `pill`, `stage`, `progress` |
| `FleetGraphEdge` | `fleet/graph.ts` | `{ from, to, kind: delegates \| lead \| depends_on }` |
| `buildFleetGraph`, `stageOf`, `pillOf`, `progressOf` | `fleet/graph.ts` | the pure rules below; the API uses them, the web may test against them |
| `SlotConversation`, `ConversationEntry` | `fleet/conversation.ts` | the orchestrator ↔ worker thread of a slot's latest run |
| `SlotWorktreeView` | `fleet/conversation.ts` | `WorktreeStatusResult` + `fetchedAt` |
| `parseWaveDependencies` | `queue/rules.ts` | slot → slots it waits for, from the plan's `Depends on` column |

### Stage and progress

A run's stage is the furthest it reached. A later `blocked` heading never sets
it back.

| Stage | When | Progress |
|---|---|---|
| `picked_up` | a `picked up` heading | 10 |
| `plan_ready` | a `plan ready` heading | 25 |
| `implementation_done` | an `implementation done` heading | 60 |
| `pr_open` | a `pull request open` heading, or an open PR | 80 |
| `checks_green` | an open PR whose checks are green | 90 |
| `merged` | the PR merged | 100 |

A closed, unmerged PR counts for nothing; the checkpoints still do.

### Status pill

Rules, first match wins:

1. `done` — the run ended, or its PR merged.
2. `blocked` — the last checkpoint is `blocked` or `misclassified`, or the checks are red.
3. `running` — status `running`.
4. `paused` — `quota`, or `stale`.
5. `waiting` — `dispatched`, `idle`, `prompt`; and every `planned` node.

The orchestrator node is `running`, `waiting` (idle) or `paused`
(absent / unknown).

### Nodes and edges

- **Nodes.** The orchestrator, always first. Then every slot whose status is
  not `ended`, plus the latest ended run of every other slot of the same
  issues, so a merged sibling stays on its wave as `done`. Then, for each of
  those issues, every slot of its `## Parallel plan` that has no run yet, as
  `planned`. Each slot appears once: its latest run.
- **`lead`.** A wave's lead (the plan's `Lead` column, else `Slot.lead`) →
  each sibling that has no `Depends on` of its own.
- **`depends_on`.**
  - Within a wave: the plan's `Depends on` column, dependency → dependant.
  - Between issues: `Depends on #m` in the issue body. When both issues are
    on the graph, every root slot of `#m` → every root slot of the dependant.
- **`delegates`.** Orchestrator → every slot that no other edge reaches. A
  dependency cycle is broken the same way, so every node is reachable from
  the orchestrator.

Edges come from the database only: `Slot.lead`, and the issue bodies in
`issues_cache`. The runner reports no edges. "Returns result" sinks (build,
tests) are drawn by the client from a node's `prChecks`.

## The conversation

- **Worker side.** The existing `slot_checkpoints`: one per `##` section of
  `.orchestrator-reply.md`.
- **Orchestrator side.** New: the reply collector's sibling, `MessageWatcher`,
  reads `.orchestrator-msg.md` in every slot worktree. Each change of the file
  is one `slot.message_seen` event.

The message file is written in two ways:
- **Replaced.** Orchestrator Phase 6.5 overwrites it, and Nautelle's
  `slot.message` writes it atomically (spec 17 D7).
- **Appended.** The orchestrator also appends a `##` section to the existing
  file.

So:
- if the new content starts with what was read before, the entry is the
  appended suffix (`mode: appended`);
- otherwise it is the whole file (`mode: replaced`);
- whitespace-only growth is no entry.

`sender` and `sentAt` come from Nautelle's `From:` / `Date:` header, or from
the skill's `# From <who>:` title.

The event row in `events` is the store; nothing new is projected. The runner
keeps what it read in memory only. After a restart it sends the unchanged file
once more, whole. `fileHash` (sha256 of the whole file) is the same, so the
API keeps the first entry per `fileHash` in the run.

A message belongs to the run that covers its `ts`: at or after the run's
`startedAt`, the projector's rule (spec 11 D8). The projector publishes
`fleet` `{ kind: 'conversation', id: <slot row id> }` on `project:<id>` for
each message; a new worker section already publishes `{ kind: 'slot' }`.

Entries are oldest first. At the same instant, messages come first, then
reply-file order. At most 500 entries are returned, the newest; `truncated`
counts the rest.

## `worktree.status` — what the runner now reports, and why it is allowed

Until now the control plane saw a slot's worktree only through
`worktree.changed`: exists, branch, ahead / behind, dirty. `worktree.status`
widens that, on request, to:
- the changed and untracked counts;
- the paths that differ from the merge base with the base, with line counts,
  at most 200;
- the last 5 commits: sha, subject, author, date.

The **runner** reads the worktree and answers. The control plane never opens
the project's filesystem (ADR-0001).

The command is a typed, allowlisted read (ADR-0010):
- **Args.** `{ projectId, root, slot, base? }`. `root` comes from the project
  row, never from the HTTP caller, and must be on the runner's watch list. The
  worktree is resolved from the slot: the `.wt-<repo>-<slot>` worktree git
  lists for that root, else `path_not_allowed`.
- **No path, range or flag.** No argument names a path, a ref range or a git
  flag. `base` passes `gitRefSchema`, and the runner checks it with
  `rev-parse --verify` before it is used in a range.
- **Read only.** Every git call is a fixed argv: `worktree list`,
  `status --porcelain=v2`, `rev-parse`, `rev-list`, `merge-base`, `diff`,
  `log`. Nothing is written.
- **Bounded.** 200 files, 5 commits, 200-character subjects, 1024-character
  paths, 10 s timeout.
- **Role `viewer`.** It is a read. Every call is audited as `runner.command`,
  like any command.

File contents and diffs are never returned: only names and counts. A runner
config can disable the command (`disabledCommands`), as any other.

## API

All three routes sit behind `ProjectAccessGuard`. Any member may call them,
and a viewer is enough. A non-member gets 404, an anonymous caller 401. A
`:slot` that is not a slot name is 400 `invalid_slot`; an unknown slot is 404
`slot_not_found`.

| Route | Answer | Notes |
|---|---|---|
| `GET /projects/:id/fleet/graph` | `FleetGraph` | from the database only |
| `GET /projects/:id/slots/:slot/conversation` | `SlotConversation` | the latest run |
| `GET /projects/:id/slots/:slot/worktree` | `SlotWorktreeView` | proxied to `worktree.status`, cached 10 s per slot |

How `/worktree` builds its command and answers:
- **Base.** The latest round's base, else the project's base branch.
- **Concurrency.** Concurrent calls for one slot share one command.
- **Errors.** None is cached:
  - runner offline → 409 `runner_offline`;
  - no answer in time → 504 `runner_timeout`;
  - a runner error → 409 `worktree_unavailable`, with the runner's code in
    `message`.
