# ADR-0036: Specs may be written to an external docs repository through its own pull request

Status: accepted · Date: 2026-10-16 · Builds on [ADR-0012](0012-detect-where-a-projects-documentation-lives.md) ·
Issue: [#379](https://github.com/AndreyBegma/AgentDock/issues/379)

## Context

ADR-0012 records where a project's documentation lives — in the repository,
in a sibling `<name>-documentation` clone, or in a remote repository. Board
cards ("spec on Run") and the planner's `docs_pr` still wrote specs only to
a repository-relative `orchestrator.specDir`. A project whose docs live
elsewhere (denitsa-app → denitsa-documentation) could not run a card with a
spec, and setting the docs source, as the error advised, changed nothing.

## Decision

1. **The docs source decides where specs go.** It gains a **Spec folder**,
   relative to the docs root, set in Settings › Docs source (prefilled from
   the classified specs folder). One resolver (`resolveSpecTarget`) reads it:
   in-repo docs → a repository-relative directory, committed on the card's
   branch or in the plan's docs PR as before; a sibling or remote docs
   repository with a local clone → that clone. Without a Spec folder, a
   repository-relative `orchestrator.specDir` is the fallback.
2. **An external docs repository gets its own pull request.** The spec is
   committed on `docs/card-<shortId>` (a card) or `docs/plan-<shortId>` (a
   plan) of the docs repository and opened as a PR into its default branch.
   Specs are reviewed like any other change; nothing is pushed to the docs
   repository's default branch. The card's code PR and the docs PR link to
   each other (`Spec: <url>`, `owner/repo#n`).
3. **The runner writes it, through a typed command.** `docs.publish_specs`
   and `docs.pr_state` (ADR-0010) are advertised like every command
   (ADR-0023); an older runner is refused before anything is written. The
   API names the clone; it never reads or writes it (ADR-0001). The runner
   accepts the clone only when it is the top of a git repository with a
   GitHub origin, other than the code repository, works in a worktree of it,
   and writes only `.md` files under the Spec folder.
4. **No clone, no spec.** A remote docs repository without a local clone path
   refuses Run and `docs_pr` with `no_docs_clone`. AgentDock does not clone.
5. **Gating.** A card's worker does not wait for its docs PR. A plan's
   issues keep today's rule: they queue once the docs PR merges. Approved
   plan designs stay in the code repository (spec 223 fallback directory),
   in a design PR of their own, and a task with a design also waits for it.
   The runner's PR collector watches only the code repository, so the API
   polls a docs-repository PR with `docs.pr_state`.

## Alternatives rejected

- **Committing straight to the docs repository's default branch.** Specs
  would land unreviewed, and a protected branch would refuse it.
- **Letting the API write the files.** Breaks ADR-0001.
- **Cloning a remote docs repository automatically.** Disk, credentials and
  freshness become AgentDock's problem; a path set by a person is enough.
- **A path outside the repository in `orchestrator.specDir`.** It is the
  code-sentinel plugin's setting, a string with no repository behind it, and
  the docs source already knows the repository.

## Consequences

- One more PR per card or plan for such projects, in another repository.
- A docs repository's PR merge is seen within the poll interval (2 min), not
  at once.
- Design mockups do not move to the docs repository; that is a later
  decision.
