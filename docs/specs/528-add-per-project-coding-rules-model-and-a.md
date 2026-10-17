# C-224: Add per-project coding rules model and API

Issue: #528

## What to do
Add a `ProjectRule` model to `apps/api/prisma/schema.prisma` related to `Project` (fields: id, projectId, title, description, enabled default true, position, createdAt, updatedAt; cascade on project delete) with a new migration. Add a NestJS module in `apps/api` with DTO-validated endpoints, guarded like other project endpoints (membership/role checks as existing project routes do): list, create, update (title, description, enabled), delete and reorder rules of a project. Add an endpoint that imports Markdown: each top-level heading (or list item when there are no headings) becomes one rule with its text as description; imported rules are created enabled, and duplicates by title are skipped and reported in the response. Put the Markdown parser as a pure helper in `packages/shared` with unit tests. Add shared types for the rule payloads in `packages/shared`.

## Acceptance criteria
- [ ] A migration adds `ProjectRule`; no applied migration is edited.
- [ ] Endpoints to list, create, update, delete and reorder rules work and reject invalid input (empty title, unknown fields) via DTOs.
- [ ] Only project members with the same permission needed to edit project settings can write; read access follows existing project read rules.
- [ ] The import endpoint turns a Markdown document into rules and returns created and skipped counts.
- [ ] The Markdown parser is a pure function in `packages/shared` with tests covering headings, lists, empty input and duplicates.
- [ ] Service and controller have unit tests next to the code.
- [ ] `bun run check`, `bun run lint` and `bun run test` pass.

## Out of scope
UI, scanning the repository, and prompt injection. Do not store rules in files of the project repository.

## Open questions
- Which role may edit rules? Default: the same role that may edit other project settings.
- Maximum rule size? Default: title 120 characters, description 4000.
