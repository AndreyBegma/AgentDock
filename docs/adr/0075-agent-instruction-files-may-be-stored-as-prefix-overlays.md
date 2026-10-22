# ADR-0075: Agent instruction files may be stored in the API as prefix overlays

Status: accepted · Date: 2026-10-21 ·
Epic: [#745](https://github.com/AndreyBegma/Nautelle/issues/745) ·
Issues: [#751](https://github.com/AndreyBegma/Nautelle/issues/751) (overlays), [#752](https://github.com/AndreyBegma/Nautelle/issues/752) (design memory) ·
Specs: [`docs/specs/751-measure-the-launch-prefix-select-it-per.md`](../specs/751-measure-the-launch-prefix-select-it-per.md), [`docs/specs/752-the-ui-profile-remembers-approved-screen.md`](../specs/752-the-ui-profile-remembers-approved-screen.md) ·
Amends: [ADR-0063](0063-the-assistant-reads-code-only-through-the-project-runner.md) §1, [`docs/specs/223-design-stage.md`](../specs/223-design-stage.md) D12 and D14 ·
Keeps: [ADR-0001](0001-control-plane-and-per-machine-runner.md), [ADR-0010](0010-typed-command-allowlist-on-the-runner.md), [ADR-0047](0047-a-runner-local-security-policy-the-server-cannot-change.md), [ADR-0022](0022-design-stage-html-mockups-from-a-ui-profile.md) ·
Builds on: [ADR-0074](0074-a-token-saving-is-judged-by-billed-cost-per-successful-card.md)

## Context

Every card launch carries a fixed prefix that the agent re-reads on every turn: the project's `CLAUDE.md`, the injected coding rules (#586), the skill listing and the MCP tool schemas. The token economy epic (#745) measures that prefix and shortens it. The person decided that the project repository is never edited automatically, because a work repository may forbid it. Instead Nautelle keeps an optimised **overlay** of an instruction file, a project admin approves it from a diff, and the runner uses it instead of the original at launch.

An overlay needs its text, and the diff needs the original's text. Both come from the project's checkout. ADR-0063 §1 says: "The control plane does not cache, index or store code". Storing a `CLAUDE.md` and its optimised version in the API contradicts that sentence as written.

Separately, design memory (#752) teaches the UI profile from approved designs: a library of approved screens, style rules from comments, and new snippets. Spec 223 D12 defines what a profile holds, and D14 what a rebuild must keep.

## Decision

1. **A narrow exception to ADR-0063 §1: agent instruction files.** The API may store the text of an agent instruction file, and an optimised version of it, as a prefix overlay or an overlay proposal. An agent instruction file is one of:
   - a `CLAUDE.md` that Claude Code loads for the project (the repository root, `.claude/CLAUDE.md`, `CLAUDE.local.md`);
   - a project skill's `SKILL.md` under `.claude/skills/`;
   - the injected rules block, which the API already holds (#586).

   No other repository file is stored. A file the skill's `SKILL.md` refers to is not an instruction file.

2. **Bounds and refusals stay on the runner.** The runner reads the file and sends its text only when:
   - it is at most 64 KiB;
   - its name is not on the runner's secret-name list;
   - its path is not matched by `code.deny` (ADR-0047, ADR-0063 §4).

   Otherwise the runner refuses with `policy_refused` and sends nothing. The API cannot change these checks (ADR-0047).

3. **ADR-0001 is kept.** The API never reads the project's filesystem. It asks the runner with the typed command `prefix.propose` (ADR-0010), and stores only what the runner answers.

4. **What is stored and who sees it.** An overlay row holds the original's text, its SHA-256 and size, the optimised text, its state (`proposed`, `approved`, `rejected`, `stale`) and who decided. The text is returned only to a project admin of that project; viewers see metadata (part, sizes, state). An overlay is used only while the original's hash at launch matches; a changed original makes it stale, and the runner launches with the original.

5. **ADR-0063 §1 now reads:** "The control plane does not cache, index or store code, except agent instruction files stored as prefix overlays under ADR-0075."

6. **Spec 223 D12 and D14 are amended for design memory.** A UI profile also holds a library of approved screens (`screens`) and style rules taken from design comments (`styleRules`), and gains the version source `memory`. A `memory` version is an obligation of the next agent rebuild, as a `manual` one is (D14), and the API carries `screens` and `styleRules` forward onto every later version. These hold design summaries and HTML snippets the API already stores (ADR-0022); no repository file is stored by them.

## Consequences

- A project's `CLAUDE.md` and skill files can now sit in the Nautelle database. A project that does not want that keeps `prefix_overlays` off (ADR-0074 §4) or lists the files in `code.deny`.
- Overlays apply only to launches the runner makes. The person's own `~/.claude/CLAUDE.md`, plugin files and `/cs-eco` sessions are out of reach and out of scope.
- The 64 KiB bound keeps a row small. A larger instruction file cannot get an overlay; the dashboard still measures it.
- An overlay never edits the worktree. A pull request that applies it to the repository is a Board card a person runs (spec 751 B12).
