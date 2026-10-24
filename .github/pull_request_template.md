## What changed and why

<!-- Short, by module. Link the issue or spec: Closes #123 -->

## How you checked it

<!-- Commands you ran and what you saw. -->

## Checklist

- [ ] The pull request targets `develop`.
- [ ] `bun run check` passes.
- [ ] `bun run test` passes, and a bug fix comes with the test that would have caught it.
- [ ] An architectural change records a new ADR in this pull request (next number from `origin/develop`).
- [ ] UI changes use glass-ui components only (ADR-0011).
- [ ] A new environment variable is documented in the matching `.env.example`.
- [ ] A schema change is a new `prisma migrate dev` migration; no applied migration is edited.
- [ ] No secrets, tokens or private paths in the diff.
- [ ] Docs are updated where behavior changed.

## Acceptance criteria

<!-- Copy the spec's checklist. [x] with how you checked it, [ ] with why not. -->
