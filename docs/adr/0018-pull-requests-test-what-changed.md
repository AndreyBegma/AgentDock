# ADR-0018: Pull requests test what changed; develop is not tested twice

Status: accepted · Date: 2026-10-13 · Amends [ADR-0016](0016-staging-on-the-agent-host-behind-a-cloudflare-tunnel.md) ·
Issue: [#140](https://github.com/AndreyBegma/AgentDock/issues/140)

## Context

ADR-0016 runs the whole check suite on every pull request and again on every
push to `develop` and `main`. Most of that time goes to the api e2e suite:
about 40 Jest files, `--runInBand`, against one PostgreSQL. It takes ~18 min on
an idle host. A pull request that touches only `apps/web` pays for it anyway.
After the merge, the push to `develop` runs the same suite again before it
deploys staging. On 2026-10-13, four pull requests in CI at once took 45+ min
each on the shared agent host. One web-only pull request (#136) spent 54 min
in `test`.

There is no production yet, only staging. On 2026-10-13 the owner chose to
give up the post-merge test run for speed, until production exists.

## Decision

1. **A pull request tests only what changed.** `test` runs
   `turbo run test --filter='...[<merge base>]'`: every package changed since
   the merge base with the target branch, plus its dependents. A change to
   `packages/shared` still tests everything that imports it. The Woodpecker
   clone is shallow, so the step first fetches the target branch's history
   (commits only).
2. **Some root files mean the full suite.** These are root `package.json`,
   `bun.lock`, `turbo.json`, `tsconfig.json`, `biome.json`, `.woodpecker/**`
   and `deploy/ci-image/**`. The check is explicit in the step, not in turbo's
   `globalDependencies`, for two reasons. turbo cannot read `bun.lock` v2, and
   a change to a file outside every package marks no package as changed.
   `globalDependencies` would also invalidate the build cache on every CI
   edit.
3. **When the merge base cannot be found, the step runs the full suite**,
   never an empty one. It prints the mode it took.
4. **A push to `develop` does not test again.** `build-staging` depends on
   `check` and `build`. It takes `test` as an optional dependency, so on a
   manual run the deploy still waits for the full suite. A push to `main` and a
   manual run test everything.
5. **A docs-only pull request skips `build` and `test`.** That is a pull
   request whose every file matches `docs/**`, `**/*.md` or `.github/**`.
   `check` still runs, so the pull request still gets a status.
6. **The CI PostgreSQL holds throwaway data.** It runs with `fsync`,
   `synchronous_commit` and `full_page_writes` off, and its data directory is
   on tmpfs. The `test` step prints the three settings.

`check` (~5 s) and `build` (~25 s) stay full on every pipeline.

## Consequences

- What reaches `develop` was tested only as the pull request's head, and only
  for the packages that pull request changed. Two pull requests that pass
  separately can break together after both merge. Until production exists,
  staging is where that shows up. The next pull request that touches the same
  package, or the next push to `main`, catches it.
- The affected set is only as good as the workspace graph. A package that
  reads another one's files without declaring a dependency on it is not
  re-tested when those files change.
- A root file missing from the list in point 2 can change behaviour
  everywhere and test nothing. A new file of that kind joins the list in
  `.woodpecker/pipeline.yml`.
- tmpfs on a service is an undocumented Woodpecker field. It needs the
  repository to be *trusted → volumes*, which ADR-0016 already requires.

## What reverses it

Points 1, 4 and 5 are reverted when the first production environment exists:
then `develop` (or whatever feeds production) tests in full after every merge
again. They are also reverted earlier if a regression reaches `develop` while
its pull request was green, because the affected set missed it. Point 6
stays: CI data is throwaway in either case.
