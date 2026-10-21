# Measure the launch prefix, select it per card type, and shorten it with approved overlays

Issue: #751 · Epic: [#745](745-token-economy.md) · Technique keys:
`prefix-select`, `rules-compressed`, `prefix-overlays` ·
Builds on: [#586](586-inject-enabled-project-rules-into-agent.md),
[#445](445-token-saver.md) (ADR-0039), [#663](663-token-saver-v2.md) (ADR-0068) ·
Decision record: [ADR-0075](../adr/0075-agent-instruction-files-may-be-stored-as-prefix-overlays.md)
(landed with this spec's docs pull request) — amends ADR-0063 §1; see "ADR impact"

## Summary

Every card launch carries a fixed prefix that the agent re-reads on every turn:
`CLAUDE.md`, the injected coding rules (#586), the skill listing and MCP tool
schemas. Nobody measures it. ADR-0068 set a 25k-token target but checks it only
on a recorded fixture. This issue covers four parts:

- (b) the runner measures the prefix by part on every launch, and the
  dashboard shows the top parts and warns over a budget;
- (c) rules, skills and MCP servers are selected per card type at launch;
- (d) the injected rules are compressed with Haiku once per rules version;
- (e) Nautelle stores optimised **overlays** of `CLAUDE.md`, project skills
  and the injected rules. A project admin approves each one from a diff, and the
  runner uses it instead of the original. The project repository is never
  edited automatically.

The letters follow the epic's original draft; part (a), design memory, was
split out as #752 and shares no logic with this issue.

## Scope

### In
- (b) A runner report of the prefix by part on every card launch and every
  launch through the wiring helper. It is stored per run, and shown on the Token
  saver page with a budget warning.
- (c) A per-card-type selection of rules, skills and MCP servers, applied at
  session start and frozen for the session.
- (d) A Haiku compression of the enabled rules, once per rules version, which an
  admin approves before it is used.
- (e) Overlays for the project `CLAUDE.md`, project skills and the injected rules:
  proposal, admin approval from a diff with before/after size, A/B, stale
  detection by hash, and re-proposal. A pull request is opened only on the
  person's consent.

### Out
- Editing any file of a project repository automatically (decisions, Q-prefix).
- Design, Planner, spec and assess launches as *targets* of (c)–(e). They are
  measured by (b) only.
- Design memory (#752).
- Overlays for the user-level (`~/.claude/CLAUDE.md`) and plugin files. They
  belong to the person's profile, not to the project.
- The plugin's `/cs-eco` and manual sessions. They are not launched by the
  runner, so overlays and selection cannot reach them. They are measured only when
  issue #748's attribution brings their usage in.
- Automatic enablement. A person enables each technique for everyone from the
  report (decisions, Q-rollout).

## Decisions

### Shared

| # | Decision | Source |
|---|---|---|
| S1 | Each technique has its own A/B flag from #746, with a sticky per-card arm, delivered to the runner in the launch command's `tokenSaver.techniques`: `prefix-select` (c), `rules-compressed` (d), `prefix-overlays` (e) — kebab-case, as the technique registry's key pattern requires. Measurement (b) has no flag: it runs in both arms. Per #746, prefix measurement belongs to this issue. | decisions Q-proof; #746 |
| S2 | **Frozen per session.** The selection (c), the compressed rules version (d) and the overlays (e) a session started with stay with it. A resumed round reuses them, and a change applies to the next fresh session. [Reported] Claude Code 2.1.306's `--system-prompt-snapshot` is `on` by default: it records the system prompt on the first request and reuses it on resume, so a mid-session change would not take effect anyway. | decisions (cache stability); `claude --help` |

### The prefix

| # | Decision | Source |
|---|---|---|
| B1 | **Measured by the runner, on every launch** (ADR-0001: the runner reads the files, the API does not). The runner computes the parts and reports them in a new event `prefix.measured`: run id, launch kind, and one row per part. It never sends the content. Each row has a `kind`, a `name`, a `path`, an `origin` (`repo`, `profile`, `plugin` or `nautelle`), `bytes`, `estTokens` (≈ bytes/4, labelled ≈), and a `sha256`. The `path` is relative to the worktree, or to `~` for profile files. The parts are: every `CLAUDE.md` in Claude Code's load chain (the profile's user file, the repo root, `.claude/CLAUDE.md`, `CLAUDE.local.md`, and the files they import with `@`); the injected rules block in the prompt; Nautelle's own prompt and register; one row per skill, sized as its listing line (name and description cut to `skillListingMaxDescChars`, `apps/runner/src/launch/token-saver.ts:138`); one row per MCP server; and the `--agents` JSON. | person, 2026-10-21 (Q-prefix); ADR-0001 |
| B2 | **The total is the fact; the parts are estimates.** The run's first-turn input (input + cache read + cache write of turn 1, from #746's per-run usage) is the measured prefix. `other` is the total minus the sum of the parts: the system prompt and built-in tools. [Unknown] An MCP server's real cost when its tools are deferred (ADR-0068: deferred by default on a first-party host). The row then counts the tool names only. The runner slot checks it once against a recorded first turn with and without one server, as `apps/runner/src/launch/fixtures/first-turn.json` was recorded, and fixes the estimate rule. | ADR-0068 Consequences ("tests measure the effect") |
| B3 | **Dashboard and budget.** The Token saver page gets a **Prefix** section with these parts: the median first-turn prefix per launch kind; the top 10 parts by ≈tokens × launches in the period; and each part's origin and its overlay state (e). A budget per project, `prefixBudgetTokens`, defaults to 25,000 (ADR-0068 §1). A launch kind whose median is over budget shows a warning on the page and in Project settings › Token saver. Warnings never block a launch. | person (Q-prefix); ADR-0068 §1 |
| B4 | **Card type**, for selection. It is computed when a card session starts and stored with the session (S2): `ci_fix` for a CI-fix round; else `ui` for a card with an approved design; else the card's kind, `bug` or `feature`. It is deterministic, and it uses only fields the card already has. | *default* (Open question QB1) |
| B5 | **Selection per card type (c)**, in the `prefix-select` B arm: (1) **rules**: each `ProjectRule` gains `appliesTo` (card types; empty means all), and the rules block includes only the rules for the session's type; (2) **MCP servers**: `mcpAllow` stays the superset, and a per-type subset `mcpByType` narrows it; (3) **skills**: a per-type list of skills hidden with Claude Code's `skillOverrides` setting `"off"`, written into the launch's `--settings`. [Confirmed] `skillOverrides` is in the settings schema of the installed Claude Code 2.1.306, described as "Per-skill listing overrides keyed by skill name … \"off\" hides it from both [model and /name]". A project admin edits the selection. Nautelle **suggests** the MCP subsets from usage: an allowed server none of whose tools a card round of that type called in the last 50 rounds (`tool_calls.name` `mcp__<server>__*` [Confirmed] `ToolCall.name`, `schema.prisma:850-868`). [Unknown] Skill usage: `ToolCall` stores the tool name `Skill` but not which skill. Until the runner reports it, skills have no suggestion. | person (Q-prefix); *default* for suggestions |
| B6 | **Rules compression (d).** When the enabled rules change (the rules version is the SHA-256 of the ordered `(id, title, description, appliesTo)`), the API runs a typed command `rules.compress` on the runner: `haiku`, no tools, the `card.assess` pattern. It answers one compressed text per rule. It is a `runs` row of kind `rules_compress`. The result waits for a project admin to approve it from a per-rule diff with before/after bytes and ≈tokens. The approved version is used in the `rules-compressed` B arm, and a changed rules version makes it inapplicable at once: launches use the originals until the next one is approved. At most one compression runs per project, and it runs once per rules version. | person (Q-prefix) |
| B7 | **Overlays (e).** An overlay is stored text that replaces one prefix part for a launch. It has these properties: `part` (`claude_md` for the repo root `CLAUDE.md` or `.claude/CLAUDE.md`, `skill:<name>` for a project skill under `.claude/skills/`, and `rules` for the injected rules, whose overlay is B6's approved compression); `originalSha256` and `originalBytes`; `content`; `state` (`proposed`, `approved`, `rejected`, `stale`); and the approver. Only `approved` overlays whose hash matches are used, in the `prefix-overlays` B arm. | person (Q-prefix) |
| B8 | **Proposal.** The API asks the runner for a proposal with a typed command `prefix.propose { projectId, root, part }`. The runner reads the file itself. It refuses secret names and `code.deny` paths (ADR-0063 §4, ADR-0047) and files over 64 KiB (ADR-0075 §2). It runs a headless no-tools call (model `sonnet`, Open question QB3) with an instruction to keep every rule and drop only repetition and prose. It answers `{ originalSha256, originalText, proposedText }`. A proposal is made automatically for the largest `repo`-origin part of a launch kind over budget (B3), when it has no open proposal. It is also made on an admin's **Propose** on the dashboard, and after a stale mark (B10). There is at most one open proposal per part. | person (Q-prefix); ADR-0063 |
| B9 | **Approval and use.** A project admin approves or rejects a proposal from a side-by-side diff with before/after bytes and ≈tokens. An approved overlay enters A/B (S1). It never applies to a card whose session already started (S2). | person (Q-prefix) |
| B10 | **Stale.** At every launch that would use an overlay, the runner hashes the original in the round's worktree. A different hash means it launches with the **original**, never with a stale overlay, and reports `prefix.overlay_stale { overlayId, sha256 }`. The API then marks the overlay `stale` and enqueues a new proposal (B8). | person (Q-prefix) |
| B11 | **How an overlay replaces the original without touching the worktree.** [Unknown] It is unverified end to end, and the runner slot verifies it on the installed Claude Code first. Findings so far, from Claude Code 2.1.306's `--help` and its settings schema: **`CLAUDE.md`**: [Confirmed in schema] `claudeMdExcludes`, described as "Glob patterns or absolute paths of CLAUDE.md files to exclude from loading … Only applies to User, Project, and Local memory types". [Unknown] It is honoured from `--settings`: the binary lists it among keys it strips from some setting sources. The overlay text would go in through `--append-system-prompt-file` [Reported: present in the binary, not in `--help`], or through `--add-dir <run dir>` with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` [Reported]. `--bare` would skip `CLAUDE.md` discovery, but it also stops OAuth and keychain auth [Confirmed `--help`], so it is rejected. **Skills**: `skillOverrides: { <name>: "off" }` hides the project skill [Confirmed in schema], and a generated plugin in the run dir, passed with `--plugin-dir`, carries the overlay skill [Confirmed flag; Reported: plugin skills are namespaced, so the overlay is `nautelle-overlay:<name>`]. **Rules**: the API substitutes them in the prompt, so they need no Claude Code support. The test is the effect, as ADR-0068 requires: a recorded first turn whose prefix shrinks by the overlay's difference, and a session that answers from the overlay and not the original. **Default if impossible:** overlays apply to the injected rules and skills only. For `CLAUDE.md`, Nautelle warns on the dashboard and offers a pull request (B12). | person (Q-prefix) |
| B12 | **The project repo is never edited automatically.** For an approved overlay of a `repo` part, a project admin may choose **Open a pull request**. Nautelle then creates a Board card whose body says to replace the file with the attached overlay verbatim, with the overlay attached (#309). The person runs it like any card. No new runner command. | person (Q-prefix: "a PR only if the person agrees"); mechanism *default* |
| B13 | **Authorization.** Prefix rows, the dashboard section and overlay reads are visible to project viewers, as the Token saver summary is. Proposing, approving, rejecting, editing the selection and opening the PR card require **project admin**. Overlay content is never returned for another project. | #445 API; *default* |

## Data / Schema

`apps/api/prisma/schema.prisma`, migration
`apps/api/prisma/migrations/20261231000014_prefix_parts_and_overlays/`.
`develop` had `…13` (#750) when the branch was cut, so this issue takes the
next free stamp; an older one would break `prisma migrate dev` history.

- `enum RunKind`: add `rules_compress`, `prefix_propose`.
- `run_prefix_parts`: `id`, `runId` → runs (cascade), `projectId` → projects
  (cascade), `launchKind`, `kind`, `name`, `path`, `origin`, `bytes`,
  `estTokens`, `sha256`, `createdAt`. Indexed `(projectId, createdAt)` and
  `(runId)`.
- `runs`: `prefixTokens Int?` (B2 total), `cardType String?` (B4, for a card
  session's first round).
- `board_cards`: `sessionCardType String?`, `sessionPrefix Json?`: the
  selection, rules version and overlay ids frozen for the current session
  (S2).
- `project_rules`: `appliesTo String[] @default([])`.
- `token_saver_settings`: `prefixBudgetTokens Int @default(25000)`,
  `mcpByType Json @default("{}")`, `skillsOffByType Json @default("{}")`.
- `prefix_overlays`: `id`, `projectId` (cascade), `part`, `originalSha256`,
  `originalBytes`, `originalText` (for the diff; ADR-0075),
  `content`, `contentBytes`, `state`, `runId?`, `rulesVersion?` (for
  `part = rules`), `decidedById?` → users, `decidedAt?`, `pullRequestCardId?`
  (B12's one card), `createdAt`, `updatedAt`. A partial unique index on
  `(projectId, part)` where `state IN ('proposed','approved')`. For
  `part = rules`, `content` is the compressed rules as JSON
  (`{ rules: [{ id, title, description }] }`) and `originalText` the rendered
  original block; the sizes are of the rendered blocks.
- `run_prefix_parts` is unique on `(runId, kind, name)`, so a resent
  `prefix.measured` inserts nothing twice.

## API

`apps/api/src/prefix/` (new module):
- A sink for `prefix.measured` and `prefix.overlay_stale`. It resolves the run
  and project from the envelope, never from the payload.
- `GET /projects/:projectId/token-saver/prefix?from&to` (viewer): per launch
  kind, the median prefix and the over-budget flag; the top parts; and the overlay
  state per part.
- `GET /projects/:projectId/prefix/overlays` (viewer: metadata only) and
  `GET …/overlays/:id` (admin: content and original for the diff).
- `POST …/overlays/propose { part }`, `POST …/overlays/:id/approve`,
  `POST …/overlays/:id/reject`, `POST …/overlays/:id/pull-request` (admin).
  `propose` answers `202 { queued }`: the proposal is a job, and `409` while
  the part has an open overlay. B6's compression is a `rules` overlay, so it
  is reviewed and approved through the same endpoints. Each action is audited
  as `project.prefix_overlay` with `meta.change` and `meta.part`, never the
  content.
- `PUT /projects/:projectId/token-saver` gains `prefixBudgetTokens`,
  `mcpByType` and `skillsOffByType`, validated against the reported servers and
  skills.
- `PATCH` on a project rule accepts `appliesTo` (the `CARD_TYPES` enum).
- The rules-compression job: on a rules change, debounced 60 s, one per
  project.
- Card launch (`apps/api/src/board/board-rounds.service.ts`): at session start,
  the API computes the card type and the frozen prefix (S2). In B arms it builds the
  rules block from the type's rules, or from the approved compressed version.
  It sends `tokenSaver.prefix: { cardType, mcpAllow, skillsOff, overlays:
  [{ id, part, originalSha256, content }] }` to a runner that advertises
  `prefixOverlays`.

## UI

glass-ui components only (ADR-0011). Missing parts, such as a side-by-side diff
viewer, go to glass-ui first.

- The Token saver page (`apps/web/src/app/(app)/projects/[projectId]/token-saver/page.tsx`)
  gets a **Prefix** section, a new component in
  `apps/web/src/components/token-saver/prefix-section.tsx`. It shows a budget
  bar per launch kind, the top-parts table with origin and ≈tokens, the overlay
  state badges, and for admins the **Propose**, **Review** and **Open a pull
  request** actions.
- An overlay review sheet shows the diff, the before → after size, and
  Approve / Reject.
- Project settings › Token saver (`token-saver-tab.tsx`) gets the budget and
  a per-card-type matrix of MCP servers and skills, with **Apply suggestion**.
- Project settings › Rules (`settings/rules/rule-sheet.tsx`) gets an
  **Applies to** multi-select. It also shows the compressed-rules proposal with
  its diff.
- `docs/ui/screens.md`: rows for each.

## Configuration

No new environment variables. `prefixBudgetTokens` is a project setting.
Models are code defaults (B6, B8).

## Acceptance criteria

- [ ] Every card launch emits `prefix.measured`, with a row for the repo `CLAUDE.md` (hash equal to the file's SHA-256), the rules block, each skill and each MCP server. `runs.prefixTokens` equals turn 1's input + cache read + cache write.
- [ ] The dashboard lists the top parts, and it flags a launch kind whose median prefix exceeds `prefixBudgetTokens`. Changing the budget changes the flag.
- [ ] In the `prefix-select` B arm, a `bug` card's session gets only the rules whose `appliesTo` is empty or contains `bug`, only the MCP servers in `mcpByType.bug`, and `skillOverrides` "off" for `skillsOffByType.bug`. A resumed round reuses the frozen selection after the settings change.
- [ ] Changing an enabled rule creates one `rules_compress` run. Until an admin approves it, B-arm launches use the original rules. After approval, they use the compressed texts. The A arm always uses the originals.
- [ ] A `prefix.propose` for `CLAUDE.md` stores a `proposed` overlay with its original text and hash. A path in `code.deny`, or a secret name, is refused `policy_refused`.
- [ ] An approved `CLAUDE.md` overlay in the B arm launches with the original excluded and the overlay loaded. The test records a first turn whose prefix shrinks by the overlay's difference (B11 effect). If B11 proves impossible, the slot records that in the spec, ships the default, and the `CLAUDE.md` row shows **Open a pull request** only.
- [ ] An original whose hash differs at launch: the session runs with the original, `prefix.overlay_stale` is emitted, the overlay becomes `stale`, and a new proposal is enqueued. A stale overlay is never sent again.
- [ ] **Open a pull request** creates one Board card with the overlay attached. No runner command writes to the worktree outside a card round.
- [ ] **Authorization:** a member of project B gets `404` from A's prefix summary and overlays. A viewer of A gets overlay metadata but `403` on overlay content, propose, approve, reject and pull-request (e2e in `apps/api/src/prefix/prefix.e2e.spec.ts`). A `prefix.measured` event naming another project's run is dropped.
- [ ] `bun run check` and `bun run test` pass. The runner release advertises `prefixMeasure`, `prefixOverlays`, `rules.compress` and `prefix.propose`.


## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i751-core | schema and migration, shared prefix contracts, events and commands, the API prefix module, rules selection and compression, the launch payload | apps/api/prisma/schema.prisma (Part B models and fields, RunKind rules_compress and prefix_propose), apps/api/prisma/migrations/20261231000014_prefix_parts_and_overlays/**, packages/shared/src/prefix/**, packages/shared/src/protocol/events/prefix.ts, packages/shared/src/protocol/commands/prefix.ts, packages/shared/src/protocol/commands.ts, packages/shared/src/protocol/index.ts, packages/shared/src/protocol/capabilities.ts, packages/shared/src/token-saver/contracts.ts, packages/shared/src/token-economy/techniques.ts (registers `prefix-select`, `rules-compressed`, `prefix-overlays`, default mode `ab`), packages/shared/src/project-rules/**, apps/api/src/prefix/**, apps/api/src/project-rules/**, apps/api/src/token-saver/dto.ts, apps/api/src/token-saver/token-saver.service.ts, apps/api/src/board/board-rounds.service.ts, apps/api/src/app.module.ts | #750 merged (chain order) | yes | opus |
| i751-runner | measurement, selection and overlay wiring, B11 verification, `rules.compress` and `prefix.propose` handlers | apps/runner/src/prefix/**, apps/runner/src/launch/token-saver.ts, apps/runner/src/launch/token-saver.spec.ts, apps/runner/src/launch/fixtures/**, apps/runner/src/cards/launch.ts, apps/runner/src/commands/handlers.ts, apps/runner/src/detect/capabilities.ts | i751-core | no | opus |
| i751-web | Prefix section, overlay review, selection matrix, rule Applies to | apps/web/src/components/token-saver/prefix-section.tsx, apps/web/src/components/token-saver/overlay-review.tsx, apps/web/src/app/(app)/projects/[projectId]/token-saver/page.tsx, apps/web/src/app/(app)/projects/[projectId]/settings/token-saver-tab.tsx, apps/web/src/app/(app)/projects/[projectId]/settings/rules/**, apps/web/src/lib/token-saver/**, apps/web/src/lib/project-rules/**, docs/ui/screens.md | i751-core | no | sonnet |

`i751-web` is `sonnet`: the endpoints, states and actions are fixed above.
`i751-runner` is `opus` because B11 is a live check whose outcome decides
the shipped default. The command allowlist (`packages/shared/src/protocol/commands.ts`)
is i751-core's alone, so i751-runner only imports the new commands. No file is
in two slots of this plan.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma, migrations | i751-core | #752 (independent) adds `RunKind` `ui_profile_learn` and other models in parallel: the second to merge runs `git merge origin/develop` and keeps every enum value |
| packages/shared/src/protocol/commands.ts, capabilities.ts | i751-core | #746 and #750 edited them earlier in the chain; #752 appends one entry in parallel |
| packages/shared/src/token-saver/contracts.ts | i751-core | #746 owns `techniques` in it and merged earlier in the chain; #748 edits it in a parallel branch: cut after #748 merges if it is still open |
| apps/api/src/token-saver/**, apps/web/src/lib/token-saver/** | i751-core, i751-web | #748 edits these folders in a parallel branch: cut after #748 merges if it is still open |
| apps/runner/src/launch/token-saver.ts | i751-runner | #746, #747 (i747-launch) and #749 (i749-ttl) edited it earlier in the chain |
| apps/runner/src/cards/launch.ts, apps/runner/src/detect/capabilities.ts | i751-runner | #750 i750-runner-web edited both earlier in the chain |
| apps/runner/src/commands/handlers.ts | i751-runner | #752 appends one `uiprofile.learn` line in parallel |
| apps/api/src/board/board-rounds.service.ts | i751-core | #746, #747 and #750 edited it earlier in the chain |
| apps/web/src/app/(app)/projects/[projectId]/token-saver/page.tsx | i751-web | #746's dashboard owns the page: i751-web adds one section import |
| apps/api/src/app.module.ts | i751-core | #752 adds one import line in parallel |
| docs/ui/screens.md | i751-web | append rows only |

## Risks

- **High: an overlay or a compression drops a rule that mattered.**
  *Mitigation:* admin approval from a diff with sizes, the A/B quality
  signals per technique with rollback, and stale detection. The original is
  never deleted.
- **High: B11 does not work as hoped.** `claudeMdExcludes` from `--settings`
  may be stripped, and plugin skill names differ. *Mitigation:* verified first,
  with a defined default (rules and skills only, PR for `CLAUDE.md`).
- **Medium: selection removes an MCP server or skill a card needs.**
  *Mitigation:* suggestions only from usage, admin applies them, and A/B quality
  signals (retries, rounds).
- **Medium: the prefix estimate misleads** (bytes/4, deferred MCP tools).
  *Mitigation:* the total is the fact (B2). Parts are labelled ≈, and the
  "other" remainder is shown.
- **Low: storage.** One `run_prefix_parts` row per part per run. *Mitigation:*
  the same retention as `token_saver_stats`.

## Open questions

- **QB1: Card types.** Default: `ci_fix | ui | bug | feature` (B4). #750's
  work class (`mechanical | deciding | unsure`) could refine it later. It is not
  used here; this issue follows #750 in the epic's chain only because both edit
  the same launch files.
- **QB2: Automatic proposals.** Default: only for the largest repo part of an
  over-budget launch kind, at most one open per part.
- **QB3: The proposal model.** Default: `sonnet` for `CLAUDE.md` and skills, and
  `haiku` for rules (decided, B6).
- **QB4: Measure non-card launches too?** Default: yes, every launch through the
  wiring helper. Only card sessions are targets of (c)–(e).

## ADR impact

- **ADR-0001: kept.** The runner reads `CLAUDE.md`, skills and their sizes. The
  API stores only what the runner reports, as for `uiprofile.build` (ADR-0022)
  and `project.scan_rules` (#584).
- **ADR-0063 §1: amended by ADR-0075.** An overlay proposal stores the text of a
  repository's `CLAUDE.md` or `SKILL.md` and its optimised version. ADR-0075
  allows agent instruction files only (`CLAUDE.md`, `SKILL.md`, the injected
  rules), each at most 64 KiB, never a secret-named or `code.deny` path; no
  other repository file is stored.
- **ADR-0010: kept.** Two new typed commands: `rules.compress` and
  `prefix.propose`.
- **ADR-0068 §1: kept.** The budget defaults to its 25k target, and the
  measurement replaces the fixture-only check with a per-launch fact.
- **ADR-0039 §3: kept.** Selection and overlays are wired through the one
  launch helper.

Depends on #750
