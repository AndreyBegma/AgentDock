# Design memory: the UI profile remembers approved screens, comment decisions and new snippets

Issue: #752 · Epic: [#745](745-token-economy.md) ·
Builds on: [#223](223-design-stage.md) D12–D14 (ADR-0022) ·
Decision record: [ADR-0075](../adr/0075-agent-instruction-files-may-be-stored-as-prefix-overlays.md) §6
(landed with this spec's docs pull request) — amends spec 223 D12 and D14

## Summary

A design turn starts from the project's UI profile (#223, ADR-0022): a summary,
a style kit and component snippets. What a person approves in a design, and
what they decide in its comments, is not kept anywhere the next design reads.
Each new design re-discovers the same layout choices and re-argues the same
comments.

After a design is approved, the project's UI profile learns from it:

- a compact summary of the approved screen goes into a **library** the next
  design starts from;
- decisions taken in its comments become **style rules**;
- new component snippets it introduced join the profile's snippets.

This issue was split out of the token economy epic's prefix work (#751). It
shares no logic with it. Design runs are not part of the per-card A/B test
(ADR-0074 covers card runs and manual sessions), so using the library in the
design prompt is a **project setting** a project admin turns on, not an A/B
technique. Learning runs whether the setting is on or off, so the library is
ready when it is turned on.

## Scope

### In
- A typed command `uiprofile.learn` and a `ui_profile_learn` run after each
  approval.
- A UI profile version of source `memory` carrying the library, style rules and
  new snippets. D14 obligations are extended to it.
- A design setting `useMemory`; when on, the design prompt reads the library
  and the style rules.
- The profile editor shows, edits and deletes library entries and style rules.

### Out
- Card runs, the A/B framework and the token-saver dashboard (#746).
- The launch prefix of card sessions: measurement, selection, compression and
  overlays (#751).
- Learning from designs that were not approved.

## Decisions

| # | Decision | Source |
|---|---|---|
| A1 | After an approval (`DesignService.approveOf`, `apps/api/src/design/design.service.ts:558`) the API enqueues one **learn** job for the approved revision. Card, stack and plan-task designs are all learned from. | person, 2026-10-21 (Q-design-memory) |
| A2 | The job runs a typed command `uiprofile.learn` (ADR-0010) on the project's runner. It runs headless, with no tools, in plan mode, prompt on stdin, outside watched roots, with hooks off: the `card.assess` pattern (ADR-0032 §1). Its input is the approved frames' HTML, the profile's current snippet names, and the design's comments with their state. The API holds all of it (ADR-0001 holds). Its output is strict JSON: `{ screen: { name, summary, snippetsUsed[] }, styleRules: [{ text, commentIds[] }], newSnippets: [{ name, html }] }`. Model `sonnet` (Open question Q1). It is a `runs` row of new kind `ui_profile_learn`, priced and budgeted. | person; pattern ADR-0032 |
| A3 | The result is stored as a **new UI profile version** with `source: memory`, under the project row lock (as `UiProfileService.update` does, `apps/api/src/design/ui-profile.service.ts:185-225`). It holds: `screens` (the library, newest first, at most 30 entries, each summary at most 1,500 characters); `styleRules` (at most 50, each at most 300 characters, with the comment ids they came from); and the snippets plus `newSnippets`. A new snippet must pass `validateProfileContent` and must not reuse an existing name. An invalid snippet is dropped and reported on the version. | person; caps *default* |
| A4 | **D14 holds, extended (ADR-0075 §6).** `obligationsOf` (`apps/api/src/design/ui-profile-mapper.ts:163`) treats `memory` versions like `manual` ones: their style rules and new snippets become obligations of the next agent rebuild, so a rebuild never silently drops what an approval taught. `screens` and `styleRules` are carried forward verbatim by the API onto every later version, agent builds included. The build prompt does not produce them. | spec 223 D14; ADR-0075 |
| A5 | A project admin edits or deletes library entries and style rules through the existing profile editor (`PUT /projects/:projectId/ui-profile`). The edit saves a `manual` version (D14 unchanged). | spec 223 D14, D17 |
| A6 | **A project setting, not an A/B technique.** `design_settings.useMemory` (default `true`) is edited by a project admin in Settings › Design. When it is on, the design prompt (`apps/api/src/design/design-prompt.ts`) adds `### Approved screens` (the library) and `### Style rules` after the snippets, for every design of the project (card, stack and plan task). The prompt fitting drops library entries oldest-first **before** it drops snippets. Style rules are never dropped. When it is off, nothing is added; learning still happens. | person, 2026-10-21 (design runs are not in the card A/B); default on (person, 2026-10-21): it only adds what people already approved, and an admin can switch it off |
| A7 | A failed or out-of-contract learn stores nothing, and its `runs` row ends `failed`. The approval itself never waits on learning. | ADR-0032 §4 pattern |
| A8 | **Authorization.** The library and style rules are read with the profile (project viewers). `PUT` of the profile and of `useMemory` need project admin. Nothing is returned for another project. | spec 223 D17 |

## Data / Schema

`apps/api/prisma/schema.prisma`, migration
`apps/api/prisma/migrations/20261231000011_ui_profile_memory/`. The newest on
develop is `20261231000006_project_github_repo_id`; the epic orders the stamps
(#746 `…07`, #748 `…08`, #750 `…09`, #751 `…10`, this issue `…11`). This
issue runs in parallel with the chain: if `develop` already has a later stamp
when the branch is cut, take the next free one and keep the name.

- `enum UiProfileSource`: add `memory`.
- `enum RunKind`: add `ui_profile_learn`.
- `model UiProfile`: `screens Json @default("[]")`
  (`[{ designId, revisionId, name, summary, snippetsUsed[], approvedAt }]`),
  `styleRules Json @default("[]")` (`[{ text, commentIds[], designId }]`),
  `learnedFromRevisionId String?`, `learnNotes String?` (dropped snippets).
- `model DesignSettings`: `useMemory Boolean @default(true)`.

## API

`apps/api/src/design/`:
- `uiprofile.learn` command and `ui_profile_learn` run: the queue, the job,
  the prompt and the parser, next to the profile projector. The module rule of
  #322 holds: a queue module is imported only by `AppModule`.
- `GET /projects/:projectId/ui-profile` and `/versions` return `screens` and
  `styleRules`. `PUT` accepts them (A5).
- The design settings endpoint accepts and returns `useMemory` (admin to write).
- The API sends `uiprofile.learn` only to a runner advertising the capability
  `uiProfileLearn` (ADR-0023); otherwise the job is skipped and logged.

## UI

glass-ui components only (ADR-0011).

- Project settings › Design (`apps/web/src/app/(app)/projects/[projectId]/settings/design/`):
  - the settings section gets a switch, **Use approved screens and style rules
    in new designs** (admin; read-only for others);
  - the profile section gets two new lists, **Approved screens** and **Style
    rules**, each item with its source design and delete/edit for admins;
  - the version list shows `memory` versions.
- `docs/ui/screens.md`: a row for each.

## Configuration

No environment variables. `useMemory` is a project setting. The learn model is a
code default (A2).

## Acceptance criteria

- [ ] Approving a card design enqueues exactly one `uiprofile.learn`. On a valid answer it creates one `memory` version with the screen, the style rules and the new snippets. Under the project row lock, two concurrent approvals give two consecutive versions.
- [ ] A new snippet that fails `validateProfileContent`, or reuses a name, is dropped and listed in `learnNotes`. The version is still stored.
- [ ] An agent rebuild after a `memory` version receives its style rules and new snippets as obligations, and the new agent version still has `screens` and `styleRules` (unit test on `obligationsOf` and the projector).
- [ ] With `useMemory` on, the design prompt contains `### Approved screens` and `### Style rules`. When the prompt is fitted, the library is dropped oldest-first before any snippet. With it off, neither section is present, and learning still stores a `memory` version.
- [ ] A failed learn leaves the profile unchanged, and the approval has already succeeded.
- [ ] A runner without `uiProfileLearn` gets no `uiprofile.learn`; the approval succeeds.
- [ ] **Authorization:** a viewer of project A reads A's library. A member of project B gets `404` for A's profile. A non-admin gets `403` from `PUT` with `screens` and from changing `useMemory`.
- [ ] `bun run check` and `bun run test` pass.

## Parallel plan

One slot. It runs in parallel with the #746 → #747 → #749 → #750 → #751 chain and with #748.

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i752-memory | learn command, profile memory, design setting, prompt, settings lists | apps/api/prisma/schema.prisma (UiProfile, UiProfileSource, DesignSettings, RunKind ui_profile_learn), apps/api/prisma/migrations/20261231000011_ui_profile_memory/**, packages/shared/src/design/**, packages/shared/src/protocol/commands/uiprofile.ts, packages/shared/src/protocol/capabilities.ts, apps/runner/src/uiprofile/**, apps/runner/src/commands/handlers.ts, apps/api/src/design/**, apps/api/src/app.module.ts, apps/web/src/app/(app)/projects/[projectId]/settings/design/**, apps/web/src/lib/design/**, docs/ui/screens.md | — | yes | opus |

## Contention

This issue is the only writer of every file above within its own plan. Across
the epic it runs in parallel, so these files have writers in other specs:

| Resource | Owner here | Other writers | Rule |
|---|---|---|---|
| apps/api/prisma/schema.prisma | i752-memory (UiProfile, DesignSettings, two enum values) | #746, #748, #750, #751 (other models; #751 also adds `RunKind` values) | the second to merge runs `git merge origin/develop` and keeps every enum value |
| apps/api/prisma/migrations/ | `20261231000011_ui_profile_memory` | `…07`–`…10` of the chain | distinct directories; never edit another's |
| packages/shared/src/protocol/capabilities.ts | i752-memory (one entry, `uiProfileLearn`) | #746, #750, #751 | append one entry; resolve by keeping both |
| apps/runner/src/commands/handlers.ts | i752-memory (one `uiprofile.learn` line) | #751 i751-runner | append one entry; resolve by keeping both |
| apps/api/src/app.module.ts | i752-memory (one import line) | #746, #751 | one import line each |
| docs/ui/screens.md | i752-memory | #746, #748, #750, #751 | append rows only |

## Risks

- **Medium: learned style rules contradict a person's edit.** *Mitigation:*
  manual versions win as D14 obligations, and admins edit or delete library items.
- **Medium: the library grows the design prompt.** *Mitigation:* caps (A3), and
  the fitting drops the oldest library entries first (A6).
- **Medium: a bad style rule spreads to every later design.** *Mitigation:* the
  setting is off by default; an admin reviews the lists before turning it on,
  and deletes a rule in the editor.
- **Low: cost of one learn run per approval.** *Mitigation:* one `sonnet` call
  without tools, priced and budgeted like any run.

## Open questions

- **Q1: The learn model.** Default: `sonnet`. The snippets must be valid HTML,
  which haiku gets wrong more often [Unknown].
- **Q2: Should the setting become an A/B technique later?** Default: no. Design
  runs have no merged card to judge them by (ADR-0074 §1). Revisit only if design
  turns gain a quality signal.
