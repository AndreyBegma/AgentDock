# Skills — skills.sh catalog, install, run on a project

Issue: [#24](https://github.com/AndreyBegma/AgentDock/issues/24) · Roadmap: M3.1 ·
Decisions: [ADR-0006](../adr/0006-runtime-adapters-and-runtime-profiles.md),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md),
[runner-protocol.md](../architecture/runner-protocol.md), [security.md](../architecture/security.md)

## Summary

Skills are run by hand today, project by project, with no record (PRD,
*Problem*). This item lets operators do three things from AgentDock:
- search the public [skills.sh](https://skills.sh) catalog;
- install a skill into a project or into a runtime profile;
- run any installed skill on a project, choosing the runtime profile and the model.

Every run executes headless in its own git worktree. It ends either as a report
or as a pull request against the project's base branch, and is recorded as a
`runs` row of kind `skill` (#21) with its sessions, tokens and cost (#12, #13).
Registry access and every write to disk happen on the runner, as typed commands
(ADR-0010).

## Scope

### In scope

- Runner commands:
  - `skill.search`, `skill.inspect`, `skill.install`, `skill.list`;
  - `skill.run`, `skill.cancel`.
- A run executor on the runner:
  - an isolated worktree per run;
  - a headless session launched through a runtime profile;
  - a stream log, a timeout, cancel, and a concurrency limit.
- Tables:
  - `installed_skills`, an inventory cache;
  - `skill_install_previews`;
  - `skill_runs`, 1:1 with #21's `runs`.
- API endpoints, role checks, audit actions.
- Web:
  - `/skills` catalog;
  - `/projects/[projectId]/skills` (installed + run dialog);
  - run detail with a live log.

### Out of scope

- Schedules that create skill runs (M3.2, #25). Webhook-triggered runs (M3.3, #26). This item exposes the run service they call.
- Budgets refusing runs (M3.5, #28).
- Codex runs. `skill.run` with a `codex` profile returns `unsupported_runtime` until M4; the adapter interface leaves room for it.
- Publishing skills to skills.sh. Uninstalling a project skill (it is a file in the repository; remove it with a normal PR). Profile-scope uninstall is in scope.

## Decisions

The person delegated all decisions on 2026-10-07. Each row below is the default
that was taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | **Catalog search goes through the runner.** `skill.search { query }` calls `GET https://skills.sh/api/search?q=<query>`. The host is fixed in the runner; neither the server nor the browser ever passes a URL. The response is `{ query, skills: [{ id, source, skillId, name, installs }], count }`, and the runner maps each item to `{ id, source: "owner/repo", skillId, name, installs }`. Results are cached on the runner for 10 minutes per query. | security.md ("registry calls proxied through the runner"); skills.sh `/api/search` shape [Confirmed 2026-10-07] |
| D2 | **Inspect before install.** `skill.inspect { source, skillId?, ref? }`:<br>• shallow-clones `https://github.com/<owner>/<repo>.git` into a temporary directory. `source` must match `^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$`, and no other host is accepted;<br>• resolves the commit SHA;<br>• locates `SKILL.md` files the way the `skills` CLI does (repository root, `skills/`, agent directories, up to three levels deep);<br>• returns, for each skill: its frontmatter (`name`, `description`, `allowed-tools`, `argument-hint`, `user-invocable`, `disable-model-invocation`), its file list with sizes, its SHA-256 per file, and a `contentHash` (SHA-256 over the sorted `path:hash` lines).<br>The API stores the result as a `skill_install_previews` row that expires in 15 minutes. | vercel-labs/skills discovery rules [Confirmed]; Mission Control "hash and scan before install" (inspiration) |
| D3 | **Install = copy, never `npx`, never symlinks.** `skill.install { previewId, target }` re-clones the same commit and verifies that `contentHash` matches the preview. A mismatch returns `changed_since_preview`. Then it copies the skill directory to the target:<br>• **Project, claude:** `.claude/skills/<name>/`.<br>• **Project, codex:** `.agents/skills/<name>/`.<br>• **Profile, claude:** `<CLAUDE_CONFIG_DIR>/skills/<name>/`.<br>• **Profile, codex:** `<CODEX_HOME>/skills/<name>/` [Unknown — confirm against Codex docs in M4; the `skills` CLI uses `~/.agents/skills` for Codex].<br>Running `npx skills` would execute third-party npm code on the machine; the copy runs nothing. | security.md; `skills` CLI agent paths [Confirmed for Claude Code; Codex Unknown] |
| D4 | **A project install is a pull request.** It never writes into the project's main checkout: it uses a worktree `<parent>/.wt-<repo>-skill-<shortid>`, branch `skills/<name>`, one commit, a push, and `gh pr create` into the project base (#10). The commit has no attribution trailer. The PR body carries the source, SHA, `contentHash` and the file list. The worktree is removed after the push. A profile install writes directly, because nothing there is versioned. | orchestrator principle "the main checkout is not written"; CLAUDE.md git rules |
| D5 | **Provenance.** Each copied skill directory gets `.agentdock-skill.json` with `{ source, skillId, commit, contentHash, installedAt }`. `skill.list` uses it to tell installed-from-catalog skills apart from hand-written ones. | new |
| D6 | **Inventory.** `skill.list { projectId? }` scans these places:<br>• the project's `.claude/skills/*/SKILL.md` and `.agents/skills/*/SKILL.md` on `origin/<base>`, read from git rather than the working tree;<br>• each profile's `<CLAUDE_CONFIG_DIR>/skills/*` and `<CODEX_HOME>/skills/*`;<br>• each claude profile's installed plugins (`<CLAUDE_CONFIG_DIR>/plugins/cache/**/skills/*/SKILL.md`), so code-sentinel skills appear as `plugin: code-sentinel@<version>`.<br>The API upserts `installed_skills`. The scan runs on project connect, after every install, and on demand. | #5 D5 (plugin cache detection) |
| D7 | **Run = headless session in its own worktree.** `skill.run` creates worktree `<parent>/.wt-<repo>-run-<shortid>` from `origin/<base>` on branch `run/<shortid>-<skill>`, then starts tmux session `agentdock-run-<shortid>` (never `cs-`). The session runs `agentdock-runner exec-run <runDir>` as an argv, not a shell string. That subcommand reads `run.json` and spawns the profile binary with:<br>• the profile env;<br>• `-p "/<skill> <args>"`;<br>• `--model <model>`;<br>• `--permission-mode <mode>`;<br>• `--output-format stream-json --verbose`.<br>stdout goes to `<runDir>/stream.jsonl`, stderr to `stderr.log`, and the exit code to `exit.json`. Running inside tmux means a runner restart does not kill the run. `<runDir>` is `$XDG_STATE_HOME/agentdock/runs/<runId>/`. | ADR-0006; #17 D1/D2 naming rule; Claude Code `-p` / `stream-json` [Confirmed in CLI help] |
| D8 | **Skill invocation.** The prompt is `/<skill> <args>` for plugin, project and profile skills alike. `<skill>` is `<plugin>:<name>` for plugin skills. Skills with `disable-model-invocation: true` (e.g. `cs-orchestrator`) are user-invocable and are allowed here. `cs-orchestrator` and `cs-worker` are refused (`not_runnable`): the orchestrator has its own control path (#17), and a worker needs a brief. | plugin SKILL frontmatter [Confirmed]; ADR-0005 |
| D9 | **Telemetry.** The session env gets `OTEL_RESOURCE_ATTRIBUTES=agentdock.project=…,agentdock.run=<runId>`. When the runner's OTLP receiver (#13) is on, it also gets `CLAUDE_CODE_ENABLE_TELEMETRY=1` plus the OTLP endpoint. The transcript collector (#12) links the session to the run by its worktree path. | ADR-0003; event-schema.md correlation |
| D10 | **Output modes.** The mode is chosen per run.<br>**`report`:** when the session exits, the runner collects:<br>• the final `result` message from `stream.jsonl`;<br>• `git status --porcelain`;<br>• `git diff` against the base, stored as `patch` and capped at 128 KiB (see Notes; the full patch stays in the run directory).<br>It then removes the worktree and deletes the branch.<br>**`pr`:**<br>• if the tree has uncommitted changes, the runner commits them as `chore(skill): <skill> run <shortid>`, with no trailer;<br>• if the branch is ahead of the base, it pushes and runs `gh pr create` into the base with the report as the body;<br>• otherwise the run ends `succeeded` with "no changes".<br>In `pr` mode the worktree is kept until the PR closes. The runner's cleanup job removes it once `gh pr view` reports it merged or closed (checked every 10 minutes). | new |
| D11 | **Limits.** Per run: timeout default 60 min, maximum 6 h; on timeout the runner kills the tmux session and the status becomes `timed_out`. Per runner: `skills.maxConcurrentRuns` (default 2); a run over the cap waits in `queued` (FIFO, by runner). `skill.cancel` kills the tmux session; the result is collected as in D10 and the phase becomes `cancelled`. | new |
| D12 | **Status mapping onto #21's `runs`.** `skill_runs.phase` (`queued`, `preparing`, `running`, `collecting`, `succeeded`, `failed`, `cancelled`, `timed_out`) maps to `runs.status` as follows:<br>• `queued` / `preparing` / `running` / `collecting` → `running`;<br>• `succeeded` → `succeeded`;<br>• `failed` / `timed_out` → `failed`;<br>• `cancelled` → `abandoned`.<br>`runs` is written through #21's run service. This item only inserts and updates rows of kind `skill` and never alters the table. | #21 D7 |
| D13 | **Live log.** The run detail page subscribes on `/live` to `run:<projectId>:<runId>`. The runner tails `stream.jsonl` while the API holds a subscription (the same `subscribe`/`unsubscribe` mechanism as #18, with `kind: "run_log"`) and sends rendered lines: assistant text, tool calls as one-line summaries, and the result. The full stream stays on the runner. Only the report fields of D10 are stored in the database. | #18 D3 (fan-out pattern) |
| D14 | **Roles.**<br>• viewer: `skill.list` and reading runs.<br>• operator of the project: `skill.search`, `skill.inspect`, project-scope `skill.install`, `skill.run`, `skill.cancel`.<br>• admin: profile-scope install and uninstall, because they affect every project on that machine.<br>The minimum roles are written into the protocol allowlist (#6 D8). Audit actions: `skill.installed`, `skill.uninstalled`, `skill.run_started`, `skill.run_cancelled`, `skill.run_finished`. | ADR-0008; security.md (install and run are operator+ and audited) |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261030000000_skills/`. New tables only; `runs` (#21) is not altered.

| Table | Fields |
|---|---|
| `installed_skills` | `id`, `runnerId` → runners, `projectId?` → projects, `profileKey?`, `scope` (`project` \| `profile` \| `plugin`), `runtime` (`claude` \| `codex`), `name`, `invocation` (e.g. `code-sentinel:spec`), `path`, `description?`, `source?`, `commit?`, `contentHash?`, `pluginVersion?`, `seenAt`; unique `(runnerId, scope, projectId, profileKey, runtime, name)` |
| `skill_install_previews` | `id`, `runnerId`, `projectId?`, `userId` → users, `source`, `skillId`, `commit`, `contentHash`, `files` Json, `frontmatter` Json, `expiresAt`, `consumedAt?` |
| `skill_runs` | `runId` PK → runs, `skill` (invocation), `args` String, `profileKey`, `model`, `permissionMode`, `output` (`report` \| `pr`), `phase`, `worktree?`, `branch?`, `tmuxSession?`, `timeoutSec`, `exitCode?`, `reportText?`, `changedFiles?` Json, `patch?` Text (≤ 128 KiB), `prNumber?`, `prUrl?`, `queuedAt`, `startedAt?`, `finishedAt?` |

## Protocol

New file `packages/shared/src/protocol/commands/skills.ts`, with one registration line in `commands.ts` and one export line in `index.ts`. The `subscribe` kind `run_log` is added to #18's `pane.ts` union, which is append-only.

| Command | Args | Min role | Result |
|---|---|---|---|
| `skill.search` | `{ query }` (1–100 chars) | operator | `{ items: [{ id, source, skillId, name, installs }] }` |
| `skill.inspect` | `{ source, skillId?, ref? }` | operator | `{ commit, skills: [{ skillId, frontmatter, files: [{ path, size, sha256 }], contentHash }] }` |
| `skill.install` | `{ source, skillId, commit, contentHash, target: { scope: "project", projectId, root, base, runtime } \| { scope: "profile", profileKey, runtime } }` | operator / admin (profile) | `{ path, prUrl? }` |
| `skill.uninstall` | `{ profileKey, runtime, name }` (profile scope only) | admin | `{ removed: true }` |
| `skill.list` | `{ projectId?, root? }` | viewer | `{ items: InstalledSkill[] }` |
| `skill.run` | `{ runId, projectId, root, base, skill, args, profileKey, model, permissionMode, output, timeoutSec }` | operator | `{ phase: "queued" \| "preparing", tmuxSession? }` |
| `skill.cancel` | `{ runId, projectId }` | operator | `{ cancelled: boolean }` |

Run progress after `skill.run` returns arrives as events (`skill_run.phase_changed`, `skill_run.finished` with D10 fields) through the normal event stream, not as `command.progress`. A run outlives the command that started it.

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| GET | `/skills/catalog?q=&runnerId=` | operator of any project on that runner, or admin | `skill.search` via the runner |
| POST | `/skills/inspect` | same | `{ runnerId, source, skillId? }` → preview id + files |
| POST | `/projects/:projectId/skills/install` | operator | `{ previewId, runtime }` → `command_run` (#17) |
| POST | `/runners/:id/profiles/:key/skills/install` | admin | `{ previewId, runtime }` |
| DELETE | `/runners/:id/profiles/:key/skills/:runtime/:name` | admin | uninstall |
| GET | `/projects/:projectId/skills` | viewer | inventory (project + profiles of the project's runner + plugins) |
| POST | `/projects/:projectId/skills/refresh` | operator | `skill.list` rescan |
| POST | `/projects/:projectId/skill-runs` | operator | `{ skill, args, profileKey?, model, permissionMode?, output, timeoutSec? }` → creates `runs` (kind `skill`, `triggeredByType: user`) + `skill_runs`, sends `skill.run` |
| POST | `/projects/:projectId/skill-runs/:runId/cancel` | operator | `skill.cancel` |
| GET | `/projects/:projectId/skill-runs/:runId` | viewer | skill run + #21 run detail |

A `SkillRunService.start(projectId, spec, trigger)` is exported for #25 (schedules) and #26 (webhooks).
`permissionMode` defaults to the project's orchestrator setting (#17 D3). `bypassPermissions` requires admin.

## UI

- **`/skills`** — catalog search:
  - one search field with debounced queries, pressing ⌘K focuses it;
  - result cards show name, `owner/repo` and install count;
  - opening a card runs inspect and shows a sheet with the description, `allowed-tools`, the file list with sizes and `contentHash`, and an "Install to…" control (project + runtime, or profile for admins);
  - confirming the install shows the resulting PR link.
- **`/projects/[projectId]/skills`** — installed skills, grouped by scope (project, profile, plugin), with source and commit. Each row has a **Run** button that opens a dialog:
  - skill and args (with the skill's `argument-hint` as placeholder);
  - runtime profile (default from #10), model (`opus`, `sonnet`, `haiku`, `fable`), output (`report` or `pr`), timeout;
  - a warning when the permission mode is not `auto`.
- **Run detail** (`/projects/[projectId]/skills/runs/[runId]`):
  - phase badge with a glass-ui `Spinner` while running;
  - live log (glass-ui `LogViewer` from glass-ui#70, falling back to a token-styled `<pre>`);
  - when the run finishes: report text, changed files, a patch viewer (`CodeBlock` from glass-ui#67), and the PR link;
  - cancel button for operators.
- Runs also appear in #21's history with kind `skill`.
- The nav registry (#9) gets a **Skills** entry.

## Configuration

| Key | Where | Meaning |
|---|---|---|
| `skills.maxConcurrentRuns` | runner config | default 2 |
| `skills.defaultTimeoutSec` / `skills.maxTimeoutSec` | runner config | 3600 / 21600 |
| `skills.catalogHost` | runner config | fixed `skills.sh`; changing it is a runner-local decision, never sent by the server |

## Acceptance criteria

- [ ] `skill.search "estimate"` against a recorded skills.sh response returns mapped items. A request carrying any host or URL argument is rejected as `invalid_args` by the schema.
- [ ] `skill.inspect` on a fixture repository with two skills returns both skills, with their file hashes and `contentHash`. A `source` containing `..`, a URL or another host is rejected.
- [ ] Install checks the hash: if the fixture repository changes between inspect and install, the install fails with `changed_since_preview` and nothing is written.
- [ ] A project install opens a PR on branch `skills/<name>` containing the skill directory and `.agentdock-skill.json`. The main checkout's working tree and HEAD are unchanged, and the commit has no `Co-Authored-By`/`Claude-Session` trailer.
- [ ] A profile install writes to `<CLAUDE_CONFIG_DIR>/skills/<name>/` of that profile only. An operator attempting it gets 403.
- [ ] `skill.list` reports project, profile and plugin skills (a fixture plugin cache containing `code-sentinel` skills shows as `code-sentinel:<name>`).
- [ ] Report run, with a fake profile binary that writes `stream-json` lines and edits a file:
  - the run ends `succeeded`;
  - `reportText`, `changedFiles` and `patch` are stored;
  - the worktree and branch are gone;
  - the tmux session was named `agentdock-run-*` and launched `exec-run` without `sh -c`.
- [ ] PR run: the same fake binary yields a commit, a push and a PR into the project base, and the worktree remains until the fixture reports the PR closed.
- [ ] `skill.cancel` on a running run ends it `cancelled` → `runs.status = abandoned`. A run exceeding its timeout ends `timed_out` → `failed`.
- [ ] With `maxConcurrentRuns: 1`, a second run stays `queued` until the first finishes.
- [ ] Running `code-sentinel:orchestrator` returns `not_runnable`. A `codex` profile returns `unsupported_runtime`.
- [ ] The live log page receives rendered lines while the run is running. No stream text is stored in the database apart from `reportText`.
- [ ] **Authorization:**
  - a viewer gets 403 on install, run and cancel;
  - a non-member gets 404 on every `/projects/:projectId/skills*` and `/skill-runs*` route (#10 D12);
  - an operator of project A cannot cancel a run of project B by id through A's route (404);
  - subscribing to `run:<B>:<runId>` as a non-member of B is refused.
- [ ] `bun run check`, `bun run test`, `bun run build` pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i24-protocol | command schemas, `run_log` subscribe kind, runner-protocol.md rows | packages/shared/src/protocol/commands/skills.ts, packages/shared/src/protocol/commands.ts, packages/shared/src/protocol/pane.ts, packages/shared/src/protocol/index.ts, docs/architecture/runner-protocol.md | — | yes | opus |
| i24-runner | catalog client, inspect/install, inventory scan, run executor, `exec-run` subcommand, cleanup job | apps/runner/src/skills/**, apps/runner/src/main.ts, the runner command handler registry from #5, the runner message dispatcher from #5 | i24-protocol | no | opus |
| i24-api | tables, endpoints, `SkillRunService`, live topic authorizer, audit actions | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261030000000_skills/**, apps/api/src/skills/**, apps/api/src/app.module.ts, packages/shared/src/audit/actions.ts | i24-protocol | no | opus |
| i24-web | catalog, project skills, run dialog, run detail | apps/web/src/app/(app)/skills/**, apps/web/src/app/(app)/projects/[projectId]/skills/**, apps/web/src/lib/skills/**, apps/web/src/components/shell/nav.ts | i24-api | no | sonnet |

i24-runner and i24-api run in parallel after the protocol lead merges.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/shared/src/protocol/commands.ts, index.ts | i24-protocol | append-only registries; keep both on conflict |
| packages/shared/src/protocol/pane.ts | i24-protocol | #18's subscribe union is extended with one kind, not rewritten; keep both |
| runner command handler registry and message dispatcher (#5) | i24-runner | append-only; keep both |
| apps/runner/src/main.ts | i24-runner | one subcommand registration (`exec-run`); #13's i13-otlp also edits it — keep both on conflict |
| apps/api/prisma/schema.prisma | i24-api | distinct new tables only (`installed_skills`, `skill_install_previews`, `skill_runs`); `runs` belongs to #21 and is not altered; keep both blocks on conflict |
| apps/api/src/app.module.ts | i24-api | append-only; keep both imports |
| packages/shared/src/audit/actions.ts | i24-api | append-only union from #8; keep both |
| apps/web/src/components/shell/nav.ts | i24-web | one entry; keep both on conflict |
| bun.lock | regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) | — |

The following registries are shared across issues and append-only (keep both on conflict):
- `apps/api/src/app.module.ts`
- `packages/shared/src/protocol/commands.ts` + `commands/<area>.ts`
- `packages/shared/src/protocol/index.ts`
- the runner command handler registry
- `apps/runner/src/collectors/index.ts`
- `apps/web/src/components/shell/nav.ts`
- `packages/shared/src/audit/actions.ts`

Non-member responses are 404 per #10 D12.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| A catalog skill carries malicious instructions (prompt injection, exfiltration through tools) | high | inspect shows files and `allowed-tools` before install; project installs go through a reviewed PR; runs are operator+ and audited; permission mode defaults to `auto`, never `bypassPermissions` unless an admin sets it |
| A headless run with a broad permission mode edits outside its worktree | medium | the session's cwd is the run worktree; `pr` mode surfaces every change as a diff; the Claude fence (`fence.py`) is not applied to runs — recorded as a gap (open question) |
| skills.sh API shape changes | low | one mapping module; a recorded-response test fails loudly |
| Runs pile up worktrees | low | the cleanup job; `report` mode removes immediately |

## Notes

Decided while landing the protocol slot (i24-protocol); the orchestrator approved each one on 2026-10-08.

- **Registration trap.** `CommandHandlers` in `apps/runner/src/commands/dispatcher.ts` requires a handler for every key of `commands`. So `commands/skills.ts` defines and exports `skillCommands` but does **not** spread it into `commands`. i24-runner adds the map entry together with the handlers. `parseCommand('skill.*', …)` answers `unknown_command` until then.
- **`skill_run.finished` is bounded (D10).** A 1 MB `patch` cannot cross the runner socket: its `maxPayload` is 512 KiB, an `events` batch is capped at 256 KiB, and the D10 fields travel in that event. The event carries:
  - `patch` ≤ 128 KiB, with `patchTruncated`;
  - `reportText` ≤ 32 KiB, with `reportTruncated`;
  - `changedFiles` ≤ 200 entries, with `changedFilesTotal`;
  - a whole `data` of ≤ 224 KiB.

  The full patch stays in the run directory on the runner. `skill_runs.patch` stores what arrived.
- **`base` on a project install target (D4).** The runner's watch list holds only `{ id, root }`, and the install PR targets the project base. The API sends `base`, as it does for `skill.run`.
- **Per-scope role on `skill.install` (D14).** A command definition has one `minRole`, checked generically by the API. `skill.install` says `operator`. The API **must** also check `skillInstallMinRole(args)` (admin for profile scope) before sending — i24-api.
- **`projectId` on `skill.cancel`.** The runner answers `not_found` for a run of another project. This is defense in depth behind the API's 404.
- **Field rules.** Every argument is a strict object, so a host or URL key is `invalid_args`. `source`, `skillId`, invocations, refs, SHAs, run ids and file paths are patterned and bounded: no `..`, no leading `-`, no URL. The patterns are in `commands/skills.ts` and runner-protocol.md, *Skills*. `contentHash` is the SHA-256 of `skillContentHashInput(files)`. The install directory `<name>` is the `skillId`.
- **New error codes.** `not_found`, `already_exists`, `changed_since_preview`, `not_runnable`, `too_large`, `upstream_unavailable`.
- **Live log wiring (D13).**
  - `subscribe` is now a union on `kind` (`anySubscribeMessageSchema`). `subscribeMessageSchema` / `SubscribeMessage` stay the pane variant, so #18's code keeps its meaning. The runner's connection hands only `kind: "pane"` to the pane streamer, and i24-runner routes `run_log`.
  - The runner→server frame is the new `run_log` message.
  - The live topic is `run:<projectId>:<runId>` (`runTopic`). Until i24-api registers a `run` authorizer, the API answers it `unknown_topic`.
- **Events.** `skill_run.phase_changed` and `skill_run.finished` are in `events/skills.ts`. `skillPhaseToRunStatus` is D12.

Decided while landing the runner slot (i24-runner); the orchestrator approved each one on 2026-10-09.

- **When install reports `changed_since_preview` (D3).** A commit SHA pins the content, so a repository that changes after the preview shows up at install in one of two ways:
  - `commit` can no longer be fetched, because the history was rewritten;
  - the recomputed `contentHash` differs from the preview's.

  Both answer `changed_since_preview`, and nothing is written.
- **Cancel, timeout and failure in `pr` mode (D10, D11).** They collect the report fields (`reportText`, `changedFiles`, `patch`) but never push or open a PR. The worktree and branch are removed, and the full patch stays in the run directory. Only a `succeeded` `pr` run opens a PR.
- **Catalog host (D1).** It is fixed in the runner's code. The runner config has no `skills.catalogHost` key. The configuration table's `skills.defaultTimeoutSec` lives in the API, because `skill.run` always carries `timeoutSec`. The runner keeps `skills.maxConcurrentRuns` and `skills.maxTimeoutSec`.
- **Plugin inventory (D6).** It reads each claude profile's `plugins/installed_plugins.json`, which names the active install of each plugin inside `plugins/cache/`. Globbing the whole cache would also offer stale versions.
- **`skill.run` checks the skill is installed (D8).** It must be one of the project's skills on its base, a skill of the run's profile, or a skill of that profile's plugins. Otherwise the answer is `not_found`.
- **No hooks on the runner's own commits (D4, D10).** Install and run commits use `core.hooksPath=/dev/null` and `--no-verify`. No third-party code runs, and no hook can add an attribution trailer.
- **Run directory (D7).** It is `$XDG_STATE_HOME/agentdock/runs/<runId>/`, beside the spool. It holds `state.json`, which lets a restarted runner resume the run, plus `run.json`, `stream.jsonl`, `stderr.log`, `exit.json` and `patch.diff`.
- **Repository-root skills.** A `SKILL.md` at a repository's root is not offered by `skill.inspect`, because `inspectedSkillSchema.path` must be a non-empty directory. Symlinks inside a skill are never followed nor copied.
- **Follow-ups not built here.**
  - `terminal.attach` with a `skill_run` target still answers `unsupported`. The executor exposes `runSession(projectId, root, runId)` for it.
  - The worktree collector sees `.wt-<repo>-run-*` and `.wt-<repo>-skill-*` as slots named `run-…` and `skill-…`. It should probably exclude them.

## Open questions

| Question | Default if nobody answers |
|---|---|
| Apply `fence.py` to skill runs (owns: `**` in the run worktree)? | No in this item; revisit when plugin P11 lands |
| Pin installed skills and offer "update available" when the source repo moves? | Not in this item — `.agentdock-skill.json` keeps the commit so it can be added later |
| Codex profile skill path | `<CODEX_HOME>/skills` until confirmed in M4 |

Depends on #17

Depends on #21
