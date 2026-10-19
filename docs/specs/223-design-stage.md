# Design stage — a mockup per task, from the project's UI profile, approved before the work

Issue: [#223](https://github.com/AndreyBegma/AgentDock/issues/223) · Roadmap: M3.9 ·
Decisions: [ADR-0022](../adr/0022-design-stage-html-mockups-from-a-ui-profile.md),
[ADR-0019](../adr/0019-planner-instructions-live-in-agentdock.md),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md),
[ADR-0011](../adr/0011-glass-ui-is-the-component-library.md),
[ADR-0001](../adr/0001-control-plane-and-per-machine-runner.md) ·
Builds on: [#172](172-planner.md), [#24](24-skills.md), [#28](28-budgets.md)

> **Amended by [ADR-0025](../adr/0025-a-design-has-one-owner-a-plan-task-or-a-board-card.md)
> ([#243](https://github.com/AndreyBegma/AgentDock/issues/243)).** A design
> now has exactly one owner: a plan task, as this spec describes, or a board
> card. Everything below applies to a task's design unchanged; a card's design
> reuses the profile, mockups, comments, pins, revise and approve, chains no
> write turn, and is committed into the card's branch when the card runs.

## Summary

The fleet implements UI tasks straight from text. The person sees the screen
only when the pull request is open, and a wrong layout costs a second task.
The design stage puts a **mockup between the conversation and the work**.

1. In the Planner (#172), a task that touches UI gets a **design** step. The
   planner suggests it; the person can switch it on or off for any task.
2. The first design in a project builds a **UI profile**: the libraries,
   styling approach, tokens, components and screen patterns the project uses,
   plus a **style kit** — CSS and HTML snippets every mockup reuses. The
   profile is cached in AgentDock and rebuilt only when the files it was
   built from change.
3. A design turn renders the task as a **self-contained HTML mockup** (1–3
   variants, chosen by the planner per task), styled from the profile and the
   design skills the person picked.
4. The person reviews it on a **full-screen viewer** — viewport presets, any
   width, light and dark — and leaves general, per-screen and pinned
   comments. **Revise design** sends them all in one turn.
5. On **approve**, the planner writes the task's document with the design
   decisions. Send to fleet publishes the approved HTML next to the spec, and
   the worker implements against it.

For: operators who give the fleet UI work and want to see it before it is
built.

## Scope

### In scope

- **Shared** (`packages/shared/src/design/`, `packages/shared/src/planner/`):
  - UI profile, style kit, design, revision, comment and settings types;
  - the CDN allowlist, the mockup validator and the CSP builder;
  - the planner output contract **v2**: the `design` action, the
    `agentdock-design` block, and design suggestions on `decompose` / `grill`;
  - the `uiprofile.build` and `uiprofile.fingerprint` commands and their
    events; `plan.publish_specs` accepts design files;
  - default instructions: how to suggest a design and how to draw one.
- **Schema:** `ui_profiles`, `design_settings`, `task_designs`,
  `design_revisions`, `design_comments`. `RunKind` gains `ui_profile`,
  `PlanTurnAction` gains `design`, `PlanTaskStatus` gains `needs_design`.
- **Runner:** `uiprofile.build` (a headless read-only run in a temporary
  worktree) and `uiprofile.fingerprint`; `plan.publish_specs` writes `.html`
  design files.
- **API:** profile read, edit, rebuild; design settings; design toggle,
  variant count, skills, generate, comment, revise, approve; the sandboxed
  mockup endpoint; audit records and live pushes.
- **Web:**
  - the design viewer `/projects/[projectId]/planner/[planId]/tasks/[taskKey]/design`;
  - the design toggle and status on the Planner's task cards;
  - a **Design** tab in project settings: the profile (view, edit, rebuild),
    viewport presets, default design skills.

### Out of scope

- **Figma, Penpot or any external design tool** (ADR-0022).
- **Rendering in the project's own stack** — no dev server, no Playwright on
  the runner (ADR-0022).
- **Checking the implemented screen against the approved mockup.** It needs
  the project's own rendering and is a separate roadmap item.
- **Installing skills from the design dialog.** Skills are installed through
  #24; the dialog lists installed ones.
- **Codex** as the design or profile runtime: `unsupported_runtime`, as in #172.

## Decisions

The person answered each round on 2026-10-14. Rows marked *default* follow an
existing record or a protocol limit and were read back and confirmed.

| # | Decision | Source |
|---|---|---|
| D1 | **The design step lives inside the Planner.** A task's flow becomes: grill → **design** → approve design → write → review → send to fleet. A task that needs a design is `needs_design` until its design is approved, and cannot be approved before that. The write turn is chained after design approval instead of after the grill's `done`. | Q1, Q13 |
| D2 | **The planner suggests, the person decides.** `decompose` and `grill` output a `design` suggestion per task: `{ needed, why, variants }`. The person can switch the design on or off on any task card, at any time before the task is approved. Bugs and features both qualify. | Q2; *default* (bugs) |
| D3 | **Projects without UI.** When the project's profile says `hasUi: false`, the planner never suggests a design and the toggle is hidden behind a "Design anyway" menu item that warns first. With no profile yet, the toggle is shown. | Q23 |
| D4 | **Variants follow the task.** The planner picks 1–3 variants and says why in one line (an unambiguous change is 1; a new screen with real layout choices is 2–3). The person can change the count before generating. **Each variant is its own turn** (D7). On approve the person picks one variant; the others are archived — readable, never published. | Q7, Q18 |
| D5 | **A mockup is one self-contained HTML document.** No dev server, no project build. It is styled from the profile's style kit, so mockups of one project look alike. The viewer marks it as a mockup, not the implementation. | Q3, Q12; ADR-0022 |
| D6 | **What a mockup may contain.**<br>• Inline CSS and JS. JS runs in an iframe sandboxed with `allow-scripts` only — no `allow-same-origin`, so it gets an opaque origin, no cookies, no storage of AgentDock.<br>• External scripts, styles, fonts and images only from a **fixed allowlist in code**: `cdnjs.cloudflare.com`, `cdn.jsdelivr.net/npm/`, `unpkg.com`, `cdn.tailwindcss.com`, `fonts.googleapis.com`, `fonts.gstatic.com`. Adding a host is a code change.<br>• Every script or package URL names an **exact version** (`react@18.3.1`, never `react@18` or `latest`).<br>• No `fetch`, XHR or WebSocket: CSP `connect-src 'none'`. No forms that submit, no top navigation.<br>• Theme switches through `:root[data-theme="light"\|"dark"]`.<br>The validator (`packages/shared/src/design/validate.ts`) refuses a mockup that breaks a rule, and the turn fails as `contract_violation` with the reason. | Q9 (a + c), Q17, Q21 |
| D7 | **How a mockup leaves the turn.** Design turns stay read-only (`--permission-mode plan`, #172 D15). The final message holds the usual `agentdock-plan` JSON block **and** one `agentdock-design` block fenced with four backticks, holding the HTML. The API extracts and validates both (#172 D17). **At most 160 KiB of HTML per variant**, because a turn's whole result travels in one event of at most 192 KiB (`PLAN_TURN_RESULT_MAX_BYTES`) [Confirmed]; one variant per turn keeps it under. | Q10; protocol limit |
| D8 | **The design turn runs in the task's fork session** (#172 D3), so it sees the plan, the task's conversation and the profile. The prompt carries: the instructions, contract v2, the action `design`, the task, the profile summary, the style kit, the chosen skills, the variant number and, on revise, every open comment with its anchor. | *default*; #172 D3, D16 |
| D9 | **Comments, three kinds.**<br>• **general** — on the whole design;<br>• **screen** — on one viewport and theme;<br>• **pin** — on a point: viewport, theme, `x`/`y` relative to the document, and the CSS path of the element under the click.<br>Pins come from a **pin helper** the API injects into the served HTML: in pin mode it reports clicks to the parent by `postMessage`. The helper is never part of a published file. | Q6 (b + c), Q14 |
| D10 | **Revise is batched.** Comments accumulate on the current revision. **Revise design** runs one design turn per variant still in play, with all open comments, and produces the next revision. Earlier revisions stay viewable; a comment records the revision it was left on and the revision that addressed it. | Q19 |
| D11 | **The viewer.** Full screen. Toolbar: viewport presets, a free width (typed, or by dragging the frame's edge), theme light/dark, variant switcher, revision switcher, pin mode. Right panel: comments, **Revise design**, **Approve**. Viewport presets (`name`, `width`, `height`, `theme?`) are edited in project settings; the defaults are Desktop 1440×900 and Mobile 390×844, each in light and dark when the profile reports a dark theme. | Q8, Q20 |
| D12 | **The UI profile lives in AgentDock's database, per project, versioned.** One row per version. It holds:<br>• `hasUi`;<br>• `summary` — markdown: libraries and versions, styling approach, tokens, component inventory with import paths, screen patterns, theme support, icons;<br>• `kit` — the style kit: CSS custom properties for the tokens, base typography, styles for the key components;<br>• `snippets` — HTML for the key components (button, input, card, table, …);<br>• `fingerprintGlobs` — the files the profile was built from, and `fingerprint` — their hash. | Q4, Q12 |
| D13 | **Profile lifecycle.**<br>• The first design in a project builds the profile (`uiprofile.build`) before the design turn.<br>• Before every design turn the API sends `uiprofile.fingerprint` with the stored globs. A different hash marks the profile **stale** and rebuilds it first.<br>• **Rebuild** in settings does the same on demand.<br>• A build is a `runs` row of kind `ui_profile`, with cost and budgets (#28). | Q11; #172 D14 |
| D14 | **People can edit the profile.** An edit (summary, kit, snippets) saves a new version marked `source: manual`. The diff of every manual version since the last agent build is kept as **obligations**: the next rebuild receives them as rules it must keep, so a rebuild never silently undoes a person's fix. | Q22 |
| D15 | **Design skills come from installed skills** (#24). Project settings hold a default set; each design can override it before generating. A design follows the default — resolved when it is shown and when Generate starts — until its skills are edited by hand on its panel or it is generated; a project admin can save the panel's set as the default from the panel (#604). The prompt names the skills and tells the planner to apply them. A default skill that is no longer installed is skipped with a warning on the design. | Q5 |
| D16 | **The approved design reaches the worker through the repository.**<br>• Send to fleet adds the approved variant to the docs pull request as `<specDir>/<issue>-<slug>/design/<variant>.html` (the pin helper is not in it).<br>• The task's document carries a `## Design` section: the file path, what the mockup fixes (layout, states, copy) and what it does not (it is not code to copy — the worker builds it with the project's real components), and the decisions taken in the comments.<br>• A task with a design always goes through the docs pull request, even when the project's `specOutput` is `issue_body` (#172 D10). | Q15; #172 D10 |
| D17 | **Roles and visibility** (*default*, #172 D12–D13). A design inherits its plan's visibility. Reading follows the plan. Toggling, generating, commenting, revising and approving need project operator. The profile is project-wide, not private: every member reads it, an operator rebuilds it, a project admin edits it and the design settings. | #172 D12, D13 |
| D18 | **Model and runtime** (*default*). Design turns use the plan's model and runtime profile. Profile builds use the project's default profile and `opus`. | #172 D14 |
| D19 | **Audit actions:** `design.toggled`, `design.generated`, `design.revised`, `design.approved`, `uiprofile.built`, `uiprofile.edited`, `design.settings_updated`. | *default*; #8 |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261111000000_design_stage/`.
Five new tables; `RunKind` gains `ui_profile`, `PlanTurnAction` gains `design`,
`PlanTaskStatus` gains `needs_design`.

| Table | Fields |
|---|---|
| `ui_profiles` | `id`, `projectId` → projects (cascade), `version` Int, `source` (`agent` \| `manual`), `hasUi` Boolean, `summary` Text, `kit` Text, `snippets` Json (`[{ name, html }]`), `fingerprintGlobs` String[], `fingerprint` String, `obligations` Text? (D14), `runId?` → runs, `authorId?` → users (set null), `createdAt`; unique `(projectId, version)` |
| `design_settings` | `projectId` PK → projects, `viewports` Json (`[{ name, width, height, theme? }]`), `defaultSkills` String[], `updatedById?` → users, `updatedAt`. No row: the defaults of D11 and no skills |
| `task_designs` | `id`, `planId` → plans (cascade), `taskKey`, `needed` Boolean, `suggested` Boolean, `suggestionWhy` Text?, `variantCount` Int (1–3), `skills` String[], `profileId?` → ui_profiles, `status` (`idle` \| `generating` \| `reviewing` \| `revising` \| `approved`), `approvedRevisionId?` → design_revisions, `approvedById?` → users, `approvedAt?`, `createdAt`, `updatedAt`; unique `(planId, taskKey)` |
| `design_revisions` | `id`, `designId` → task_designs (cascade), `variant` Int (1–3), `revision` Int, `title`, `rationale` Text, `html` Text, `turnId` → plan_turns, `archived` Boolean, `createdAt`; unique `(designId, variant, revision)` |
| `design_comments` | `id`, `designId` → task_designs (cascade), `revisionId` → design_revisions, `authorId?` → users (set null), `kind` (`general` \| `screen` \| `pin`), `viewport?`, `theme?`, `x?` Float, `y?` Float, `selector?`, `body` Text, `addressedInRevisionId?` → design_revisions, `createdAt` |

A design is keyed by `(planId, taskKey)`, not by a `plan_tasks` row, because a
task's rows are versioned per plan version (#172 D9) while its design carries
across versions. A frozen (approved) task keeps its approved design.

## Output contract (v2)

`PLANNER_CONTRACT_VERSION` becomes 2. Plans created under v1 keep running under
v1: they get no design suggestions, and the manual toggle still works.

```
DesignSuggestion = { needed: boolean, why, variants: 1 | 2 | 3 }

decompose → tasks[i] gains   design: DesignSuggestion
grill     → output gains     design?: DesignSuggestion     // may update it
design    → { action: "design", taskKey, variant: 1–3, title, rationale,
              addressed: commentId[] }                       // + one agentdock-design block
profile   → { action: "profile", hasUi, summary, kit, snippets: [{ name, html }],
              fingerprintGlobs: glob[] }                     // uiprofile.build's block
```

New violation reasons: `no_design_block`, `multiple_design_blocks`,
`design_too_large`, `design_host_not_allowed`, `design_unpinned_version`,
`design_forbidden_feature` (network calls, form submit, top navigation),
`variant_mismatch`, `unknown_comment`.

## Protocol

- **`uiprofile.build`** `{ projectId, root, base, runId, prompt, profileKey, model, timeoutSec }`
  — creates `<parent>/.wt-<repo>-uiprofile-<shortid>` from `origin/<base>`,
  detached; runs `claude -p --permission-mode plan` with the prompt on stdin
  (ADR-0010, #172 D16); removes the worktree when the run ends. Progress and
  result arrive as `uiprofile_build.phase_changed` / `uiprofile_build.finished`
  events, shaped like `plan_turn.*`. The runner does not parse the result.
  `minRole: operator`.
- **`uiprofile.fingerprint`** `{ projectId, root, base, globs }` → `{ fingerprint, files }`
  — SHA-256 over the sorted `path:sha256` lines of the files matching `globs`
  at `origin/<base>`, read with `git ls-tree` / `git cat-file`, never from the
  working copy. At most 64 globs and 2 000 files; globs are repository-relative
  and confined to the project root. `minRole: operator`.
- **`plan.publish_specs`** accepts `.html` files under
  `<specDir>/<issue>-<slug>/design/`, at most 192 KiB each, and up to 24 files
  (12 specs and 12 designs). A project without a `specDir` publishes design
  files under `docs/design/` (see Open questions).
- **`plan.turn`** is unchanged; the action travels inside the prompt.

## API

Every route but the mockup sits under `/projects/:projectId`, as the
Planner's do (#172), so the project guard resolves the caller's role first.

| Method | Path | Role | What |
|---|---|---|---|
| GET | `/projects/:projectId/ui-profile` | viewer | the current profile and its status (`none`, `fresh`, `stale`, `building`) — `stale`: the newest build after the current version was started because the files changed, and failed |
| GET | `/projects/:projectId/ui-profile/versions` | viewer | the version list, newest first; `?version=` reads one |
| GET | `/projects/:projectId/ui-profile/preview` | viewer | the kit and every snippet of a version (`?version=`, default the current) on one page, served like the mockup (below); 404 without a profile or with no such version |
| PUT | `/projects/:projectId/ui-profile` | project admin | a manual version (D14) |
| POST | `/projects/:projectId/ui-profile/rebuild` | operator | runs `uiprofile.build`; 409 `design_busy` while one runs |
| GET / PUT | `/projects/:projectId/design-settings` | viewer / project admin | viewports, default skills |
| PATCH | `/projects/:projectId/plans/:planId/tasks/:key/design` | operator | `{ needed?, variantCount?, skills? }`; creates the design row when the task has none |
| POST | `/projects/:projectId/plans/:planId/tasks/:key/design/generate` | operator | the first revision of every variant not drawn yet (409 when none is missing); fingerprint check and profile build first |
| POST | `/projects/:projectId/plans/:planId/tasks/:key/design/comments` | operator | a general, screen or pin comment |
| POST | `/projects/:projectId/plans/:planId/tasks/:key/design/revise` | operator | D10 |
| POST | `/projects/:projectId/plans/:planId/tasks/:key/design/approve` | operator | `{ revisionId }`; archives the other variants, chains the write turn |
| GET | `/projects/:projectId/plans/:planId/tasks/:key/design` | plan reader | the design, revisions, comments |
| GET | `/design-revisions/:id/html` | plan reader | the mockup, served for the iframe (below); a revision's `htmlUrl` is `/api/design-revisions/:id/html`, through the web's rewrite |

The design writes answer the design (`TaskDesignView`) as the caller now
sees it.

**The mockup endpoint** — and the profile preview, through the same code —
returns `text/html` with its own headers, overriding helmet's defaults for
that response only:

- `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' <allowlist>; style-src 'unsafe-inline' <allowlist>; font-src <allowlist> data:; img-src <allowlist> data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'`;
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`;
- the pin helper injected before `</body>`.

The web app reaches it through its same-origin `/api` rewrite [Confirmed in
`apps/web/.env.example`]; the `sandbox` directive gives the document an opaque
origin regardless.

Every write emits a live push on the plan's channel, as #172 does.

## UI

glass-ui components only (ADR-0011). Anything missing is added to glass-ui
first; the slot reports it.

- **Planner task card:** a **Design** chip — off / suggested (with the
  planner's one-line why) / on / approved. Toggling asks nothing unless D3
  applies. A `needs_design` task shows **Open design**.
- **Design viewer** (`/projects/[projectId]/planner/[planId]/tasks/[taskKey]/design`):
  - toolbar as D11; the frame is a resizable `iframe sandbox="allow-scripts"`
    pointing at the mockup endpoint;
  - pin mode: the cursor becomes a crosshair, a click opens a comment box at
    the point, and existing pins show as numbered markers for the current
    viewport and theme;
  - right panel: comments grouped as open / addressed, filtered to the
    current revision by default; **Revise design** (disabled with no open
    comment); **Approve** (asks which variant when there are several);
  - a banner: "Mockup — the implementation uses the project's real components."
- **Project settings → Design:**
  - profile: status, version list, rendered summary, kit and snippets in a
    code editor, **Edit** (project admin), **Rebuild** (operator), and a
    preview of the snippets rendered through the mockup endpoint;
  - viewport presets: an editable list (name, width, height, theme);
  - default design skills: a multi-select over the project's and profile's
    installed skills (#24).

The viewer needs a resizable frame and a point-annotation overlay; whether
glass-ui has them is [Unknown] — the web slot checks first.

## Configuration

| Setting | Default | Where |
|---|---|---|
| HTML per variant | 160 KiB | `packages/shared/src/design/limits.ts` |
| Variants per task | 1–3 | contract v2 |
| CDN allowlist | D6 | `packages/shared/src/design/cdn.ts` |
| Profile build timeout | 20 min | `uiprofile.build` `timeoutSec` |
| Viewport presets | D11 | `design_settings` |

No new environment variable.

## Acceptance criteria

- [ ] In a v2 plan, `decompose` returns a `design` suggestion per task, and a UI task in a project with UI shows the chip as suggested with the planner's reason.
- [ ] A task with the design on is `needs_design` and its Approve action is refused (`design_not_approved`) until a design revision is approved; approving the design chains exactly one write turn.
- [ ] The first **Generate** in a project with no profile runs `uiprofile.build` first; the design turn's prompt contains the profile's summary and kit.
- [ ] A second Generate with unchanged fingerprint files runs no build. Changing a file matched by `fingerprintGlobs` on `origin/<base>` marks the profile stale and rebuilds before the next design turn.
- [ ] A manual profile edit, followed by a rebuild, yields a version whose prompt carried that edit as an obligation (visible on the build's run).
- [ ] With variant count 3, Generate runs three design turns and the viewer switches between three variants.
- [ ] A mockup with `<script src="https://evil.example/x.js">` fails with `design_host_not_allowed`; one with `react@18` fails with `design_unpinned_version`; one with `fetch(` fails with `design_forbidden_feature`; one over 160 KiB fails with `design_too_large`. No revision is stored for a failed turn.
- [ ] The mockup endpoint responds with the CSP of "API" including `sandbox allow-scripts` and `connect-src 'none'`; script inside the mockup cannot read `document.cookie` of AgentDock (opaque origin) — covered by an e2e test.
- [ ] Toggling the theme in the viewer flips `data-theme` on the mockup's root without reloading the frame.
- [ ] A pin left at Mobile/dark stores viewport, theme, x, y and selector, shows only at Mobile/dark, and reaches the next design turn's prompt with its selector.
- [ ] **Revise design** with two open comments runs one turn per variant in play; the comments the turn lists in `addressed` are marked addressed in the new revision.
- [ ] Approve with several variants requires picking one; the others become `archived` and are not published.
- [ ] Send to fleet puts the approved HTML at `<specDir>/<issue>-<slug>/design/<variant>.html` in the docs pull request, without the pin helper, and the spec contains `## Design` naming that path — also for a project whose `specOutput` is `issue_body`.
- [ ] In a project whose profile has `hasUi: false`, no suggestion is made and the toggle sits behind "Design anyway" with a warning.
- [ ] A default design skill that is no longer installed is skipped and the design shows a warning naming it.
- [ ] **Authorization:** a user who cannot read a private plan gets 404 from `GET /plans/:planId/tasks/:key/design` and from `GET /design-revisions/:id/html` for its revisions; a viewer gets 403 on generate, comment, revise and approve; only a project admin can `PUT` the profile and design settings.
- [ ] `uiprofile.fingerprint` refuses a glob with `..` or an absolute path, and reads blobs from `origin/<base>`, not the working copy (runner test).
- [ ] Every action of D19 writes its audit record; design turns and profile builds appear as runs with tokens and cost, and a budget hard stop refuses them.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i223-contract | shared design types, validator, CDN allowlist, CSP builder, contract v2, default instructions, `uiprofile.*` commands and events, `plan.publish_specs` change, schema and migration | packages/shared/src/design/**, packages/shared/src/planner/**, packages/shared/src/protocol/commands/uiprofile.ts, packages/shared/src/protocol/commands/planner.ts, packages/shared/src/protocol/events/uiprofile.ts, packages/shared/src/protocol/commands.ts, packages/shared/src/protocol/index.ts, packages/shared/src/audit/actions.ts, packages/shared/src/index.ts, apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261111000000_design_stage/** | — | yes | opus |
| i223-runner | `uiprofile.build`, `uiprofile.fingerprint`, `.html` in publish | apps/runner/src/uiprofile/**, apps/runner/src/planner/publish-specs.ts, apps/runner/src/planner/publish-specs.spec.ts, apps/runner/src/commands/handlers.ts | i223-contract | no | sonnet |
| i223-api | profile, design settings, design flow, mockup endpoint, planner integration | apps/api/src/design/**, apps/api/src/planner/**, apps/api/src/app.module.ts | i223-contract | no | opus |
| i223-web | viewer, task card chip, Design settings tab, screen docs | apps/web/src/app/(app)/projects/[projectId]/planner/**, apps/web/src/app/(app)/projects/[projectId]/settings/**, apps/web/src/components/design/**, apps/web/src/components/planner/**, apps/web/src/lib/design/**, docs/ui/screens.md | i223-contract | no | opus |

**What cannot be parallelised:** the lead goes first — every other slot
builds on its types, contract and schema. After it merges, the three slots run
together. The web slot builds against the shared types and the documented API
with fixtures and does not wait for `i223-api`. If glass-ui lacks the
resizable frame or the pin overlay, the web slot's first step is a glass-ui
release, and it says so in its reply.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| `apps/api/prisma/schema.prisma`, the migration, `RunKind`, `PlanTurnAction`, `PlanTaskStatus` | i223-contract | do not open |
| `packages/shared/src/protocol/commands.ts`, `packages/shared/src/protocol/index.ts`, `packages/shared/src/index.ts` | i223-contract | do not open |
| `packages/shared/src/planner/default-instructions.md` | i223-contract | do not open |
| `apps/runner/src/commands/handlers.ts` | i223-runner | do not open |
| `apps/api/src/app.module.ts` | i223-api | do not open |
| `docs/ui/screens.md` | i223-web | do not open |
| `docs/specs/README.md` status row | the last slot to merge | — |

## Risks

- **High — a mockup is an approximation.** Without the project's own
  rendering, a mockup can promise what the real components cannot do.
  Mitigation: the style kit makes mockups use the project's tokens and
  component shapes; the viewer banner and the `## Design` section say what the
  mockup does and does not fix; the post-implementation check is a named
  follow-up.
- **Medium — profile quality decides mockup quality.** A wrong kit makes every
  mockup wrong. Mitigation: profiles are editable (D14), versioned, and
  rebuilds keep manual fixes as obligations.
- **Medium — third-party CDN code runs in the viewer.** Mitigation: a fixed
  allowlist, exact versions, opaque-origin sandbox, `connect-src 'none'`; the
  mockup cannot reach AgentDock's API or cookies.
- **Medium — cost.** Up to three opus turns per revision, plus profile builds.
  Mitigation: runs with cost and budgets (#28); variants default to 1 unless
  the planner says why; the profile is cached by fingerprint.
- **Low — the 192 KiB event limit.** A large screen may not fit in 160 KiB of
  HTML. Mitigation: the CDN allowlist (Tailwind, libraries) keeps the inline
  part small; the violation names the limit so the planner can split the
  screen.
- **Low — contract v2 alongside v1.** Mitigation: the parser dispatches on the
  plan's `contractVersion`; v1 tests stay.

## Open questions

- **Where a project without a `specDir` keeps design files.** Default:
  `docs/design/<issue>-<slug>/<variant>.html`, and the issue body links the
  path.
- **Comparing two revisions side by side.** Default: not in this item; the
  revision switcher covers it.
- **Snippet preview for very large style kits.** Default: the kit counts
  toward the 160 KiB of each mockup; a profile whose kit is over 64 KiB fails
  the build with a violation that asks for a smaller kit.

## Review of design generation (#606, 2026-10-17)

The design stage was reviewed end to end against ADR-0022, ADR-0025,
ADR-0041, ADR-0044, this spec, and the later design specs (#275 progress and
Stop, #322 launch choice, #441 frames, #480 stacks, #519/#526 viewer and phone
work, #527 stack gate). Decisions those records already made — one variant
per turn, the HTML-mockup approach, the stack's lack of a launch choice, the
CDN allowlist — are not re-proposed. Line numbers are as of the review commit.

### What was reviewed, and what was found

- **Prompt assembly** (`apps/api/src/design/design-prompt.ts`,
  `apps/api/src/planner/plan-prompt.ts`, `apps/api/src/design/design-store.ts`).
  The profile summary, the style kit, the snippets, the installed skills only
  (D15), the variant, the previous revision's frames on a revise (#441) and
  every open comment with its anchor are all carried. Free text is fenced with
  a fence longer than any backtick run inside it. An over-long prompt is
  fitted by dropping snippets from the end, then a stack reference's HTML
  (#480), and says which were left out. The open comments are never trimmed,
  so the fitting does not guarantee the cap — see proposal 4.
- **Turn flow** (`card-design-turn.service.ts`, `plan-turn-design.ts`,
  `stack-design-turn.service.ts`, `design.service.ts` `start`, the projector's
  design paths). One turn per variant, chained by the projector; a contract
  violation fails the turn and stores no revision; `variant` and `addressed`
  are checked against the batch. Two defects were found and fixed (below). A
  chained turn that does not start still ends the batch silently — proposal 1.
- **The UI profile build and its fingerprint** (`ui-profile.service.ts`,
  `ui-profile-projector.ts`). The wait is visible (#275: "Step 1/2 · Building
  the UI profile", the run log, Stop); a failed build ends cleanly and shows
  as the design's last failure; a build is skipped while the fingerprint of
  `fingerprintGlobs` on `origin/<base>` is unchanged. A failed stale rebuild
  is retried on every Generate and blocks the design although an older
  profile exists — proposal 2.
- **The launch panel** (`apps/web/src/components/design/generate-panel.tsx`).
  Variants, skills and (for a card) profile and model are chosen before
  Generate; runner and readiness blockers are said before the click. The
  "builds the profile first" note was wrong for every design not drawn yet —
  fixed below. A busy design with nothing running showed this panel — fixed
  below.
- **Result handling.** Every frame is validated (D6) and the frames together
  are held to 160 KiB (`packages/shared/src/planner/contract.ts:743`, checked
  in `parseDesignBlocks`), under the 192 KiB result event. The mockup endpoint
  serves each frame with `sandbox allow-scripts` and `connect-src 'none'`; the
  viewer's iframe has `sandbox="allow-scripts"` and trusts a message by its
  source window only (`apps/web/src/lib/design/frame-messages.ts:20`).
  Comments record the frame and revision they were left on; the first
  revision to list a comment addresses it. No defect was found here; the size
  budget and the frame endpoint are proposals 3, 6 and 8.

### Fixed in #606

| Defect | Evidence | Fix | Test |
|---|---|---|---|
| Two Generates at once both passed the idle check. The loser's turn start was refused (`turn_in_progress`) and its error path settled the design, so the winner's turn ran while the design read idle, with no progress and no Stop. | `design.service.ts` `start`: the status was read in `drawable` and written after `ensureFresh` | The busy status is claimed with a conditional update from the status read at rest, before the profile check; the loser gets 409 `design_busy`. A profile check that throws puts the design back to rest. | `card-design.e2e.spec.ts` "#606: of two Generates at once…" |
| A design left `generating` / `revising` with no turn and no build (a batch whose next turn never started, e.g. the API stopped between two) refused Generate as busy and Stop as not running — no way out. | `design-stop.service.ts` `stopOf`: `if (!build) throw notRunning()` | Stop puts such a design back to rest and audits `design.stopped` with `stage: null`. | `design-stop.e2e.spec.ts` "puts a design left busy with nothing running back to rest" |
| The generate panel said "This project has no UI profile yet: Generate builds it first" for every design not drawn yet, because it read the design's `profileId`, which stays null until a revision is stored. | `generate-panel.tsx` (`design.profileId === null`) | The note comes from the project's profile status (`GET /projects/:id/ui-profile`): missing, a failed rebuild, or a build running. | `generate-panel.test.tsx`, `format.test.ts` "#606" |
| A busy design between two turns (D1's `null` progress, documented as "Starting the next variant…") showed the Generate panel, with no progress and no Stop. | `design-viewer.tsx`: `design.progress ? null : <GeneratePanel>` | The viewer shows a "Starting the next turn…" status with Stop. | `progress.test.ts`, `design-progress.test.tsx` "#606" |

No architecture changed, so no ADR was needed.

### Proposed improvements

Ordered by value. Sizes: XS (under an hour), S (a small pull request), M (a
pull request with schema or contract work), L (needs an ADR). None of these
is started in the code.

1. **Say why a batch stopped when its next turn did not start.** When the
   next variant's turn, or the first turn after a profile build, cannot start
   (budget hard stop, runner offline, prompt over the cap), the design is put
   back to rest and the reason is only logged. No turn row exists, so
   `lastFailure` shows nothing and the person sees fewer variants than they
   asked for, without a word.
   *Evidence:* `apps/api/src/planner/card-design-turn.service.ts:299-320`,
   `stack-design-turn.service.ts:230`, `plan-turn.service.ts:409`,
   `plan-turn-projector.ts:419` and `:535`, `design.service.ts:609-612`;
   `design-progress.ts:136-157` reads only turns and builds.
   *Benefit:* every ended batch explains itself and offers Retry.
   *Size:* M — store the refusal (a failed `plan_turns` row for the variant,
   or a `lastStartError` on the design) and read it in `lastFailureOf`.
2. **Let a design proceed on the current profile when its stale rebuild
   fails.** A changed fingerprint rebuilds the profile before the turn; when
   that build fails, the waiting design rests, and the next Generate
   fingerprints again, rebuilds again (a 20-minute opus run) and can fail
   again. A project with a working older profile cannot get a mockup until
   the build succeeds.
   *Evidence:* `apps/api/src/design/ui-profile.service.ts:292-296`,
   `ui-profile-projector.ts:118-123` (`afterBuild(waiting, undefined)`).
   *Benefit:* a broken rebuild degrades to a slightly stale style instead of
   blocking the stage; cost stops repeating.
   *Size:* S–M — on a failed `stale` build, start the waiting designs with
   the current version and a warning; skip the rebuild for that fingerprint
   until the files change again. Amends D13.
3. **Stop copying the style kit into every frame.** The prompt tells the
   model to include the kit in a `<style>` (`design-prompt.ts:179`), the kit
   may be 64 KiB (`packages/shared/src/design/limits.ts:17`) and all frames
   together may be 160 KiB (`limits.ts:10`, `contract.ts:743`). A large kit
   leaves under 100 KiB for the mockup itself, and three frames with a 50 KiB
   kit fail as `design_too_large` before drawing anything.
   *Benefit:* multi-frame designs (#441) fit; turns spend fewer output tokens.
   *Size:* L — the API would inject the profile version's kit when it serves
   and publishes a frame, so a mockup is no longer self-contained on its own
   (ADR-0022, ADR-0041 amendment).
4. **Fit the open comments into the prompt cap.** A revise carries up to 100
   open comments (`limits.ts:40-41`, documented as keeping the prompt under
   its cap) of up to 4 000 characters plus a 1 000-character selector each,
   i.e. well over the 256 KiB `plan.turn` cap. The fitting trims only
   snippets and the stack reference (`design-prompt.ts:332-355`,
   `plan-prompt.ts:207-221`), so such a revise fails with a raw
   `invalid_args` schema message.
   *Benefit:* a large review round still revises; the rest stay open for the
   next round.
   *Size:* S — drop the newest comments last-in-first-out until the prompt
   fits, say how many were left open, and fix the limit's comment.
5. **Send each variant's turn only its own comments (and the general
   ones).** Revise gives every variant's turn every open comment
   (`design-rules.ts:183-189`), and the first revision to list a comment
   addresses it (`design-apply.ts:60-70`). A comment left on variant 2 can be
   marked addressed by variant 1's revision, and variant 2 never answers it.
   *Benefit:* comments are answered where they were left; prompts shrink.
   *Size:* S–M — filter by `leftOn.variant` per turn; amends D10.
6. **Tell the model the result's size budget, and name the remedy on
   truncation.** The contract limits the HTML to 160 KiB but says nothing
   about prose outside the blocks; a turn whose whole message passes 192 KiB
   fails as `result_truncated: the result was cut at the event size limit`
   (`plan-turn-projector.ts:320`, `:482`), which tells neither the model nor
   the person what to change.
   *Benefit:* fewer wasted turns near the limit.
   *Size:* S — a contract line ("keep text outside the blocks short") and a
   failure message that names the limit and suggests fewer frames.
7. **Serve one frame without reading every frame.** The mockup endpoint
   loads every frame's HTML of the revision to answer one
   (`design-mockup.controller.ts:78-81`, `design-store.ts:253-269`); a viewer
   with N frames reads N × the revision.
   *Benefit:* less database traffic per view.
   *Size:* S — select the frame by `position`, keep the legacy fallback.
8. **Start one profile build at a time.** `ensureFresh` reads the latest
   build and starts a new one without a lock
   (`ui-profile.service.ts:266-275`), so two designs that Generate at the
   same moment in a project without a profile can start two builds.
   *Benefit:* no doubled opus cost; both designs wait on one build.
   *Size:* S — take the project row lock (as `update` does) around the check
   and the run's creation.
9. **Keep a profile without fingerprint globs, or without a fingerprint,
   honest.** A profile with no `fingerprintGlobs` is never checked again
   (`ui-profile.service.ts:276-278`); one stored without a fingerprint adopts
   whatever the next check returns (`:284-291`), which hides a change made in
   between.
   *Benefit:* the profile status means what it says.
   *Size:* S — show "never refreshed automatically" in Settings → Design, and
   fingerprint at the build's base commit rather than at check time.
10. **Disable the panel's choices while Generate is starting.** The variant
    buttons, skills and "Runs on" are disabled only by `writeBlock`
    (`generate-panel.tsx:185`, `:209`, `:242`), so they can change between
    the patch and the generate call.
    *Benefit:* what starts is what the person saw.
    *Size:* XS.
11. **Decide the trimming order for a card in a stack.** A card's prompt
    drops every snippet before it drops the stack design's HTML
    (`design-prompt.ts:343-353`). The stack design already shows the shared
    look, so the order may be right; it is not recorded anywhere.
    *Benefit:* a deliberate, documented trade-off.
    *Size:* XS — a line in #480's spec, or swap the order.

Depends on #172
Depends on #24
