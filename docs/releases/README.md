# Releases

AgentDock is released as one product version, `vX.Y.Z`, cut from `develop`
and promoted to `main` by the `release` skill
([`.claude/skills/release/SKILL.md`](../../.claude/skills/release/SKILL.md),
[ADR-0071](../adr/0071-the-product-is-released-by-version-with-a-changelog-and-release-notes.md)).
Each release has one note here and one entry in the shared `CHANGELOG`
(`packages/shared/src/changelog.ts`), which the web app shows on its
What's new page.

The runner is versioned on its own, `runner-vX.Y.Z`, and published to npm and
Homebrew on its own cycle; its notes are
[`apps/runner/CHANGELOG.md`](../../apps/runner/CHANGELOG.md). A product release
names a runner release that shipped in its window.

A released note is never edited. A correction goes into the next release.

| Version | Date | Summary |
|---|---|---|
| [v0.16.0](v0.16.0.md) | 2026-10-24 | One-command install, demo videos of finished cards, review steps, stacks from a Claude Code session; runner 0.16.0 |
| [v0.15.0](v0.15.0.md) | 2026-10-23 | Board from a Claude Code session, design frame templates, two-factor sign-in, token savings per card; runner 0.15.0 |
| [v0.14.0](v0.14.0.md) | 2026-10-20 | The first versioned release: What's new, five-entry project navigation and the calm page layout |
