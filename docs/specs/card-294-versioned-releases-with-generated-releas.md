# C-294: Versioned releases with generated release notes and a What's new page

## What to do
Give the product a real release process, modelled on the `luna-release-log` skill of luna-watch (`/home/archi/dev/luna-projects/luna-watch/.claude/skills/luna-release-log/SKILL.md`; read it, but drop what is Luna-specific: macOS paths, the three-repo promotion chain, BUG-/FEAT- ids, en/ru/uk locales).

1. **Changelog as data.** `packages/shared/src/changelog.ts`: `CHANGELOG: ChangelogEntry[]` with `{ version, date, items: { kind: 'new' | 'improved' | 'fixed', text }[] }`, newest first; `APP_VERSION = CHANGELOG[0].version`. Released entries are never edited.
2. **Release notes in the docs.** Each release also writes `docs/releases/vX.Y.Z.md` (summary, the items, the merged PRs with links) and links it from `docs/releases/README.md`.
3. **What's new in the web app.** A "What's new" page that renders the changelog, the version in the footer or account menu, and a small unread dot for a version the user has not seen (per user, stored server-side, not localStorage).
4. **A `release` skill in this repository** (`.claude/skills/release/SKILL.md`), run by Claude:
   - collect the PRs merged into `develop` since the last release tag (`vX.Y.Z`);
   - classify each as new, improved, fixed or excluded (CI, deps, refactors, tests, docs-only, security hardening without a user-visible change);
   - choose the version with semver on 0.x: any user-visible feature bumps MINOR, only fixes bump PATCH, nothing user-visible means no release;
   - write 3 to 8 one-sentence items, the changelog entry and `docs/releases/vX.Y.Z.md`;
   - open `release/vX.Y.Z` into `develop`, then the release PR `develop` → `main`; tag `vX.Y.Z` after the merge.
5. **The runner keeps its own version** and its `runner-v*` tags (it is published to npm on its own cycle). The product changelog mentions a runner release when one shipped in the window.
6. Record the process as an ADR.

## Acceptance criteria
- [ ] `CHANGELOG` and `APP_VERSION` exist in `packages/shared` with a first entry for the current state.
- [ ] `docs/releases/` holds the first release note and an index.
- [ ] The web app shows the What's new page, the version, and an unread marker that clears once viewed. API e2e and web tests cover them.
- [ ] The `release` skill exists and documents every step above.
- [ ] An ADR records the release process.
- [ ] `bun run check` passes.

## Open questions
- First version number. Default: `0.14.0` for the product (independent of the runner's 0.13.0); the skill decides later bumps.
