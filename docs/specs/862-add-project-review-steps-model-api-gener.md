# C-348: Add project review steps: model, API, generated peer review and ADR

Issue: #862

## What to do
Add per-project review configuration in `apps/api` (Prisma via `PrismaService`, a migration created with `prisma migrate dev`, shared types in `packages/shared`):
- A project-level switch `reviewEnabled` and a switch `publishReviewComments` (off by default), stored next to `autoMergeCards` in the project board settings that `board-shipping.ts` reads.
- A `ProjectReviewStep` model: project, position, enabled, name, `type` (`peer_review` | `skill`), `instructions` (markdown, for `peer_review`), `skillName` (for `skill`), and timestamps. Each project has exactly one `peer_review` step, created on first enable; it cannot be deleted but can be disabled.
- Generating the peer review instructions: when review is first enabled, and on an explicit "Regenerate", produce instructions tailored to the repository (conventions, ADRs, test rules). Generation reads code only through the project runner (ADR-0001, ADR-0063) and goes through the existing LLM gateway (ADR-0059). Regenerating overwrites the instructions only after the person confirms in the UI; the API takes an explicit regenerate call.
- REST endpoints with `class-validator` DTOs to list, create, update, reorder, enable/disable and delete steps and to regenerate the peer review instructions. A `skill` step's `skillName` is validated against the skills the project's runner reports (`projects/[projectId]/skills`).
- A shared findings type: `{ stepId, severity: 'blocking' | 'nit', file?, line?, title, body }`. The engine card stores findings in this shape.
- A new ADR (next free number, after `docs/adr/0082-…`): "A card passes its review steps before Finished". It amends ADR-0035 §3–4 (Finished means CI green and review passed; review fix rounds are capped at 3 per PR), says publishing to GitHub is opt-in, and says review sessions are runner sessions started by typed commands (ADR-0010).

## Acceptance criteria
- [ ] The migration adds the review settings and `ProjectReviewStep`; `bun run check` and API tests pass.
- [ ] Enabling review on a project creates exactly one `peer_review` step with generated, non-empty instructions; enabling it again does not duplicate the step.
- [ ] Regenerate replaces the peer review instructions; editing persists the person's text unchanged.
- [ ] A `skill` step can be added, reordered, disabled and deleted; an unknown `skillName` is rejected with 400.
- [ ] The `peer_review` step cannot be deleted (409) but can be disabled.
- [ ] `publishReviewComments` defaults to false; existing projects keep `reviewEnabled = false` after the migration.
- [ ] The findings type is exported from `packages/shared`, which stays framework-free.
- [ ] The new ADR is added and linked from `docs/adr/README.md`.
- [ ] Endpoint specs (`*.spec.ts` / e2e) cover the cases above.

## Out of scope
- Running review steps, fix rounds and gating Finished (the engine card).
- Any web UI.
- Publishing comments to GitHub.

## Open questions
- Should review be on for new projects? Default: off for every project, existing and new, until a person enables it in settings.
