# Projects — connect by path, detect docs source, membership

Issue: [#10](https://github.com/AndreyBegma/AgentDock/issues/10) · Roadmap: M1.4 ·
Decisions: [ADR-0004](../adr/0004-github-issues-are-the-task-queue.md),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md),
[ADR-0012](../adr/0012-detect-where-a-projects-documentation-lives.md),
[data-model.md](../architecture/data-model.md), [runner-protocol.md](../architecture/runner-protocol.md)

## Summary

Every later screen (fleet, sessions, cost, queue) is scoped to a project. This
item lets an admin connect a git repository that lives on a paired runner by
choosing the runner and an absolute path. The runner inspects the path and
reports the repository, its base branch, its Code Sentinel configuration, and
where its documentation lives: in-repo or in a separate repository. The API
stores the project, its docs source and its members. It also provides the
project-access guard that every later module authorizes with. Admins see every
project; operators and viewers see only projects they are members of.

## Scope

### In scope

- Runner commands `project.inspect` and `project.refresh`, with docs-source detection.
- Registered project roots in the runner config, pushed by the server in `welcome`; path confinement.
- Tables `projects`, `project_members` and `docs_sources`.
- Project CRUD, member management, and a manual docs-source override.
- `ProjectAccessGuard` and the `@ProjectRole()` decorator.
- Default runtime profile, ready label and base override, and the merge-approval flag (stored only).
- Web: the projects list, the connect dialog, and project settings.

### Out of scope

- Anything that reads fleet state, sessions or cost (#11, #12, #13).
- Merge approval behaviour (M2.5). The flag is stored here and nothing reads it yet.
- Non-GitHub projects. They are detected and flagged `unsupported`, not connected (ADR-0004).
- Writing to the docs source (cs-spec does that; plugin P7).
- Audit records. #8 retrofits these actions: project connected, deleted, settings changed, member added/removed/role changed, docs source overridden.

## Decisions

The person delegated all decisions on 2026-10-07. Each entry below is the default taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | Only an admin connects or deletes a project. The admin picks a runner (online) and an absolute path. The API sends `project.inspect`, shows the result as a preview, and stores the project only on confirm | ADR-0010 (inspect is admin-only in runner-protocol.md) |
| D2 | `project.inspect` resolves `git rev-parse --path-format=absolute --git-common-dir` and requires the path to be the **main checkout**: its parent equals the toplevel. A linked worktree (e.g. `.wt-<repo>-<slot>`) is refused with `not_main_checkout` and the main checkout's path is suggested. The runner reports it rather than failing: `isMainCheckout: false` with `root` set to the main checkout, and docs detection skipped. The API refuses to connect it (409 `not_main_checkout`). A subdirectory of the main checkout is reported the same way | orchestrator SKILL "Where things are" [Confirmed] |
| D3 | The repo comes from `origin`: `git@github.com:owner/name(.git)` or `https://github.com/owner/name(.git)` → `owner/name`. Any other host is returned with `forge: "unsupported"` and the API refuses to connect it (`unsupported_forge`). cockpit (`gitlab-fwg`) is the known example | ADR-0004; cockpit remote [Confirmed] |
| D4 | The base branch comes from `orchestrator.base` in `.code-analyzer-config.json`. If that is absent, from `origin/HEAD`. If that is absent, `gh repo view --json defaultBranchRef`. If that fails, `main`. The project stores it and can override it | orchestrator SKILL configuration table [Confirmed] |
| D5 | `.code-analyzer-config.json` is parsed and its `orchestrator` block stored as a JSON snapshot. Invalid JSON is reported (`configError`), not fatal. The presence of `CLAUDE.md` and `AGENTS.md` is reported | data-model.md |
| D6 | Docs-source detection runs in this order and stops at the first hit. Every hit records `detectedBy` and evidence (file + line, or URL). The full list of candidates checked is returned for the preview:<br>1. `orchestrator.specDir`: a relative path inside the repository, a relative path outside it (`../x-documentation/prs`), or a GitHub URL<br>2. sibling folder `<parent>/<name>-documentation`, then `<parent>/<name>-docs`<br>3. same-owner remote `owner/<name>-documentation` or `owner/<name>-docs` via `gh repo view` (marked `remote_repo`, `localPath: null`)<br>4. GitHub URLs or local paths containing `documentation` or `docs` in `AGENTS.md`, `CLAUDE.md`, `README.md` (e.g. denitsa-app's `AGENTS.md` link to `denitsa-documentation`). A GitHub URL counts when it is a same-owner repo or a folder of that name sits beside the project; a local path counts only when it resolves to a direct child of the parent whose name contains `docs` / `documentation`<br>5. back-link: a sibling `*-documentation` / `*-docs` folder whose `README.md` names this repo or its path (luna-studio, cockpit). "Names" means the README contains `owner/name`, the absolute root, or the root's folder name as a whole word (not inside a longer word or hyphenated name)<br>6. in-repo `docs/` | ADR-0012; earlier findings for denitsa / luna / cockpit [Confirmed] |
| D7 | Classification inside the found docs root goes one level deep, plus known nested names:<br>specs ← `specs/`, `prs/`, `stages/`, `docs/specs/`<br>adr ← `adr/`, `decisions/`, `decisions.md`, `*adr*`<br>roadmap ← `roadmap.md`, `ROADMAP.md`, `spec-queue.md`, `docs/roadmap*`<br>reports ← `bug-reports/`, `fixes/`, `verifications/`, `feature-plans/`<br>Each kind keeps every match (relative to the docs root). `isGitRepo` and the docs repo's own `owner/name` (if any) are recorded. Non-git folders (cockpit-docs) are `isGitRepo: false` | ADR-0012; denitsa-documentation and cockpit-docs layouts [Confirmed] |
| D8 | Detection reads only:<br>• under the project root, its parent directory (siblings only, depth 1), and the found docs root (depth 2)<br>• the `README.md` files of sibling folders<br>• `gh repo view` for same-owner candidates<br>Nothing else on disk is read | ADR-0010 path confinement |
| D9 | After a project is connected, the API adds its root to the runner's watch list. The runner keeps `projects[]` in its config (from #5, D3) as a cache. The authoritative list arrives in `welcome` (`{ id, root }[]`) on every connect. While the runner is connected, the API sends the changed list as a `config` message (`{ type: "config", config: <welcome.config> }`), which the runner applies exactly like welcome's and which does not touch the ack cursor. `project.refresh` re-runs inspection for a registered root and is allowed for operators of that project | runner-protocol.md |
| D10 | Path confinement: `project.inspect` accepts any absolute path that exists and is a directory, refuses symlinks that escape it, and is admin-only. Every other command that takes a path accepts only a registered project root, or a path under the root's parent that matches `.wt-<repo>-*` | ADR-0010 |
| D11 | Roles: global role × membership.<br>• admins see and manage every project with no membership row.<br>• operators and viewers see only projects where they have a `project_members` row.<br>• A member's effective role is `min(global role, override)`, so an override can only lower it. Order: viewer < operator < admin | ADR-0008, data-model.md |
| D12 | `ProjectAccessGuard` reads `:projectId` from route params and enforces D11. `@ProjectRole('operator')` sets the minimum effective role for the route. A project the caller cannot see returns **404**, not 403, so its existence is not revealed. Exported from `apps/api/src/projects/` for #11–#13 | new |
| D13 | Project settings stored now:<br>• `defaultProfileId` (FK `runtime_profiles`, must belong to the project's runner)<br>• `baseOverride`, `readyLabelOverride`<br>• `mergeApproval` (bool, default false; used in M2.5)<br>• `displayName` | data-model.md, ADR-0006 |
| D14 | A runner may hold many projects. A `(runnerId, rootPath)` pair is unique. The same `owner/repo` on two runners is two projects | new |
| D15 | Deleting a project removes it, its members and its docs source, and sends the runner an updated watch list in a `config` message (D9). It never touches the disk | new |
| D17 | This item registers the `project:<id>` topic authorizer with #9's `LiveService` (the same membership check as `ProjectAccessGuard`), so live subscriptions to a project follow the same access rule as its REST endpoints; it lives in `apps/api/src/projects/**` | #9 spec |
| D16 | The runner gets a collector registry, `apps/runner/src/collectors/index.ts`: a `Collector` interface (`name`, `start(project, emit)`, `stop()`) and a list started for every project in the watch list and stopped when it leaves. This item registers no collector; #11 and #12 each append one registration line (keep both on conflict) | #11, #12 specs |

## Protocol

Owned by i10-runner, in `packages/shared/src/protocol/projects.ts`, with both commands registered in `packages/shared/src/protocol/commands.ts`.

| Command | Args | Min role | Result |
|---|---|---|---|
| `project.inspect` | `{ path }` | admin | `ProjectInspection` |
| `project.refresh` | `{ projectId, root }` | operator | `ProjectInspection` |

`ProjectInspection`:

- `root`: the absolute main checkout
- `gitCommonDir`
- `isMainCheckout`
- `remote`: `{ url, forge: "github" | "unsupported", repo: "owner/name" | null }`. With no `origin`, `url` is null and `forge` is `unsupported`
- `baseBranch`, plus `baseSource`: `config` | `origin_head` | `gh` | `default`
- `codeSentinelConfig`: `{ orchestrator?: object, error?: string }`
- `hasClaudeMd`, `hasAgentsMd`
- `docs`, with these fields:
  - `kind`: `in_repo` | `sibling_repo` | `remote_repo` | `none`
  - `localPath`: absolute for every kind, including `in_repo`; null when only remote, or `none`
  - `repo` (null when none)
  - `isGitRepo`
  - `detectedBy`: `spec_dir` | `sibling` | `same_owner_remote` | `text_link` | `back_link` | `in_repo`
  - `evidence`: `{ file?, line?, url? }[]`
  - `classified`: `{ specs: string[], adr: string[], roadmap: string[], reports: string[] }`
  - `candidates`: `{ rule, target, hit: boolean }[]`
- `warnings: string[]`: sentences for the connect preview

`welcome.config.projects: { id, root }[]` already existed in the protocol (#5); this item makes the runner act on it. The new S → R message `config` carries the same config mid-connection (D9). It is additive: an older runner logs it as an unknown message and picks the list up at its next `welcome`.

Path refusals answer their own error codes, which the API maps to HTTP: `path_not_found` and `not_a_repository` → 422, `path_not_allowed` → 403. A non-main checkout is a result (`isMainCheckout: false`), not an error (D2). [runner-protocol.md](../architecture/runner-protocol.md#projects) has the details and an example.

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261011000000_projects/`. All tables are new. Foreign keys point to `runners`, `runtime_profiles` (#6) and `users` (#3).

| Table | Fields |
|---|---|
| `projects` | `id`, `runnerId` → runners, `rootPath`, `repo` (`owner/name`), `displayName`, `baseBranch`, `baseSource`, `baseOverride?`, `readyLabelOverride?`, `defaultProfileId?` → runtime_profiles, `mergeApproval` Bool default false, `codeSentinelConfig` Json?, `hasClaudeMd`, `hasAgentsMd`, `lastInspectedAt`, `createdById` → users, `createdAt`, `updatedAt`. Unique `(runnerId, rootPath)` |
| `project_members` | `id`, `projectId` → projects (cascade), `userId` → users (cascade), `roleOverride?` (`Role`), `addedById` → users, `createdAt`. Unique `(projectId, userId)` |
| `docs_sources` | `id`, `projectId` → projects (cascade, unique), `kind`, `localPath?`, `repo?`, `isGitRepo`, `detectedBy?`, `evidence` Json, `classified` Json, `candidates` Json, `manual` Bool default false, `updatedAt` |

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| POST | `/admin/projects/inspect` | admin | `{ runnerId, path }` → `ProjectInspection` (no write). Runner offline → 409 `runner_offline` |
| POST | `/admin/projects` | admin | `{ runnerId, path, displayName? }`. Re-inspects, then stores the project and its docs source, and pushes the watch list. Errors: 409 `not_main_checkout`, 422 `unsupported_forge`, 409 `already_connected` |
| DELETE | `/admin/projects/:projectId` | admin | D15 |
| GET | `/projects` | session | projects visible per D11, with the effective role on each |
| GET | `/projects/:projectId` | member (viewer+) | detail: settings, docs source, runner name and status |
| PATCH | `/projects/:projectId` | admin | D13 fields. `defaultProfileId` must be on the project's runner (422 `profile_not_on_runner`) |
| POST | `/projects/:projectId/refresh` | member (operator+) | `project.refresh`. Updates the stored inspection and the docs source, unless the docs source is `manual` |
| PUT | `/projects/:projectId/docs-source` | admin | manual override: `{ kind, localPath?, repo? }` sets `manual: true`. `DELETE` restores detection |
| GET | `/projects/:projectId/members` | member (viewer+) | members with their effective roles |
| POST | `/projects/:projectId/members` | admin | `{ userId, roleOverride? }`. The user must be `active` |
| PATCH / DELETE | `/projects/:projectId/members/:userId` | admin | change the override / remove the member |

## UI

These pages sit in the application shell from #9 (route group `(app)`):

- **`/projects`**: a table with name, repo, runner (with a status dot), base, docs source kind, and your role. An admin also sees a **Connect project** button.
- **Connect dialog** (admin):
  1. Pick an online runner.
  2. Enter an absolute path.
  3. **Inspect** shows a preview: repo, base and its source, config found, CLAUDE.md/AGENTS.md, the docs source with its evidence, and the candidate checklist (hit/miss), plus any warnings or a refusal reason.
  4. **Connect**.
- **`/projects/[projectId]/settings`** has these tabs:
  - General: display name, base override, ready-label override, merge approval, default runtime profile (from that runner's profiles).
  - Docs source: the detected source with evidence and classification, **Refresh**, and **Override** (admin).
  - Members: add, change override, remove (admin; read-only for others).
- The **project switcher** in #9's shell reads `GET /api/projects`.

## Configuration

None new. The runner's `projects[]` key already exists in its config (#5, D3).

## Acceptance criteria

- [ ] **Authorization:** subscribing to `project:<id>` on `/live` succeeds for a member and is refused for a non-member.
- [ ] The collector registry starts each registered collector once per watched project and stops it when the project is removed from the watch list (tested with a fake collector).
- [ ] Inspecting the main checkout of a GitHub repository returns its `owner/name`, base branch with source, config snapshot, and docs source. Inspecting one of its `.wt-*` worktrees returns `not_main_checkout` with the main path suggested.
- [ ] A fixture repository with an `origin` on a non-GitHub host is reported `forge: unsupported`, and connecting it returns 422.
- [ ] Docs detection is covered by one fixture per rule in D6 (temporary directories with git repos). The fixtures mirror:
  - `specDir: "../x-documentation/prs"` (spec_dir)
  - a sibling `x-documentation` (sibling)
  - a sibling found only through `AGENTS.md` text (text_link)
  - a sibling that is not a git repo and is found by its README back-link (back_link, `isGitRepo: false`)
  - in-repo `docs/` only (in_repo)
  - nothing (`none`)

  Each fixture yields the expected `kind`, `detectedBy`, `classified` and `candidates`.
- [ ] Detection reads no path outside the root, its parent's direct children, and the docs root (asserted by a spy on filesystem access in the runner test).
- [ ] After connect, the runner's `welcome` lists the project. After delete, it no longer does. Disk contents are unchanged in both cases.
- [ ] `project.refresh` by an operator member updates `lastInspectedAt`. A manual docs source survives a refresh.
- [ ] **Authorization:** a viewer who is a member of project A and not of project B gets 404 on `GET /projects/B`, `/projects/B/members` and `POST /projects/B/refresh`. B is absent from their `GET /projects`.
- [ ] **Authorization:** an operator with `roleOverride: viewer` on project A gets 403 on `POST /projects/A/refresh`. A viewer with `roleOverride: operator` stays a viewer (override cannot raise the role).
- [ ] **Authorization:** operator and viewer get 403 on every `/admin/projects*` route, `PATCH /projects/:id`, member writes and docs-source override. An anonymous caller gets 401.
- [ ] Setting `defaultProfileId` to a profile of another runner returns 422.
- [ ] `ProjectAccessGuard` and `@ProjectRole` are exported and covered by unit tests (admin bypass, member, non-member → 404, override lowering).
- [ ] Web: an admin connects a real local repository (this repository on the dev runner) through the dialog and sees its docs source detected as `in_repo` → `docs/`. A viewer sees only member projects in the switcher.
- [ ] `bun run check`, `bun run test` and `bun run build` pass.

## Parallel plan

These slots run in sequence. The API stores and serves exactly what `ProjectInspection` contains, and imports its schema, so it cannot start before the contract has merged. The runner slot owns that contract and is the smaller job, so it leads. Running both in parallel would mean the API slot inventing the schema twice. The web slot needs the API.

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i10-runner | the protocol contract and the inspect / refresh handlers, docs detection, watch list from `welcome` | apps/runner/src/projects/**, apps/runner/src/collectors/index.ts, packages/shared/src/protocol/projects.ts, packages/shared/src/protocol/commands.ts, packages/shared/src/protocol/messages.ts, packages/shared/src/protocol/index.ts | — | yes | opus |
| i10-api | schema, migration, projects module, guard, watch-list push | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261011000000_projects/**, apps/api/src/projects/**, apps/api/src/app.module.ts, apps/api/src/runners/runners.gateway.ts | i10-runner | no | opus |
| i10-web | projects pages, connect dialog, settings, switcher data | apps/web/src/app/(app)/projects/**, apps/web/src/lib/projects/**, apps/web/src/components/shell/nav.ts | i10-api | no | sonnet |

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/shared/src/protocol/commands.ts, messages.ts, index.ts | i10-runner | #11–#13 slots add their commands only after this merges |
| apps/api/prisma/schema.prisma | i10-api, appending new tables only | another issue's slot adding distinct new tables may run alongside: keep both blocks on conflict |
| apps/api/src/app.module.ts | i10-api | conflicts are resolved by keeping both imports |
| apps/api/src/runners/runners.gateway.ts | i10-api (adds `projects` to `welcome`) | do not open it while i10-api is live |
| bun.lock | regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) | — |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Text-link detection (rule 4) yields false positives, e.g. a README linking to an unrelated `docs` site | medium | Rule 4 accepts only targets that resolve to a sibling folder or a same-owner GitHub repo. The preview shows the evidence. Admins can override |
| `gh repo view` for same-owner candidates is slow or rate-limited | low | 5 s timeout per call, at most two calls, and the result is cached in the inspection |
| The project-access guard is the authorization boundary for every later module | high | `opus` on i10-api. Named authorization tests above. 404-not-403 is stated as a rule (D12) |
| Older runners (before this change) ignore `welcome.projects` | low | additive field. The runner config cache keeps working |
| Cross-repo docs (`remote_repo` without a local clone) cannot be classified | low | `classified` empty, with a warning that suggests cloning it beside the project |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Should operators be allowed to connect projects? | No. Admin only (D1) |
| Should a project with no docs source be connectable? | Yes, with `kind: none` and a warning |
| GitLab support? | Not until a forge adapter exists (ADR-0004) |

## Notes from implementation

i10-api, decided with the orchestrator on 2026-10-07:

1. **`projects.createdById` and `project_members.addedById` are nullable, `ON DELETE SET NULL`.** A required foreign key would make deleting a user fail for any admin who ever connected a project or added a member. `runners.createdById` makes the same choice. `projects.runnerId` is `RESTRICT`, because runners are revoked and never deleted. `defaultProfileId` is `SET NULL`.
2. **`DELETE /projects/:id/docs-source` re-inspects.** The schema keeps no copy of the detection an override replaced. So the API clears `manual` and runs inspection on the runner as admin (`project.refresh`), then stores what it detects. If the runner is offline, the answer is 409 `runner_offline` and nothing changes.
3. **Admin bypass is absolute.** An admin's effective role is `admin` on every project, even with a membership row carrying a lower override. D11's `min(global, override)` applies to operators and viewers.
4. **A manual override cannot be checked on disk** (ADR-0001). `isGitRepo` is `true` for `in_repo` and `remote_repo`, and for `sibling_repo` only when `repo` is given; otherwise it is `false`. `detectedBy` is null; `evidence`, `candidates` and `classified` are empty until the next detection. `in_repo` takes a `localPath` under the root and no `repo`. `sibling_repo` takes an absolute `localPath`. `remote_repo` takes a `repo` and no `localPath`. `none` takes neither. Anything else is 422 `invalid_docs_source`.
5. **Member errors:** an unknown user is 422 `user_not_found`, a user who is not `active` is 422 `user_not_active`, and a duplicate is 409 `already_member`. An unknown member on `PATCH` / `DELETE` is 404.

Also as built:

- **Authorization order.** The routes that only an admin may call (`/admin/projects*`, `PATCH /projects/:id`, member writes, docs-source `PUT` / `DELETE`) carry `@Roles('admin')`. The global role guard checks it before membership is looked at, so a non-admin gets 403 whether or not the project exists, and nothing is revealed. Member routes use `ProjectAccessGuard` + `@ProjectRole(min)` (default `viewer`). Both are exported from `apps/api/src/projects/` together with `ProjectAccessService.resolve(user, projectId)` → `{ projectId, role } | null`, `visibleWhere(user)` and the `@ProjectAccess()` parameter decorator. Later modules import `ProjectsModule`.
- **Runner errors on HTTP.** Offline (no open socket, checked before sending) or revoked → 409 `runner_offline`. No result in time → 504 `runner_timeout`. `path_not_found` / `not_a_repository` → 422. `path_not_allowed` → 403; on `refresh` the API first resends `config`. Any other runner error → 502 `runner_error`. An unknown runner on inspect / connect → 404.
- **Connect** stores `rootPath = inspection.root`. `displayName` defaults to the repository name. Refresh updates the base, the config snapshot, `hasClaudeMd` / `hasAgentsMd` and `lastInspectedAt`, and updates `repo` only while `origin` still names one.
- **Watch list.** `RunnerWatchList` in the runners module builds `welcome.config` and the `config` push. It serializes them per runner, so a list read earlier is never sent after one read later. The gateway attaches the socket and sends `welcome` in the same queued step.
- **Audit.** Contrary to "Out of scope" above, this item records its own actions. They are listed in [spec 8's retrofit table](8-audit-log.md#retrofit--actions-recorded-by-this-item).
- **Live.** `project:<id>` is authorized by `ProjectAccessService.resolve`: an id that does not exist is `forbidden`, for admins too.

Depends on #6

Depends on #9
