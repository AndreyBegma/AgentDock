# C-250: Filter pipelines and command chains in the Token saver hook

Issue: #610

## What to do
The Token saver hook rewrites only a single simple command (`apps/runner/src/filter/shell.ts` `parseHookCommand`, `apps/runner/src/filter/hook.ts` `decideHook`). Anything with `|`, `&&`, `;` or a redirect is classed compound and passes through. Agents almost always write `bun run test 2>&1 | tail -50`, `git log --oneline | head -20` or `cd x && a && b`. That is why the Token saver dashboard shows 3,601 of 3,638 commands unfiltered.

Extend the parser and the hook, the way rtk (rtk-ai/rtk) does:
- In a pipeline, wrap the **first** segment when a filter covers it, and keep the rest of the pipe (`head`, `tail`, `grep`, `wc`, `sort`) unchanged.
- In an `&&` / `;` list, wrap each covered segment on its own.

The rewrite must stay permission-equivalent (`apps/runner/src/filter/permissions.ts`). It still fails open. Exit codes are unchanged.

## Acceptance criteria
- [ ] `bun run test 2>&1 | tail -50` in `auto` / `bypassPermissions` is rewritten so `bun run test` runs through `agentdock-runner filter` and `| tail -50` still applies to the filtered output.
- [ ] `cd apps/api && bun run lint && git status` wraps each covered segment; uncovered segments run as written.
- [ ] Heredocs, subshells, command substitutions and background calls still pass through untouched.
- [ ] The exit code of every rewritten list or pipeline equals the original's (spec tests cover `&&` short-circuit and a failing first pipe segment).
- [ ] A rewrite never changes the permission outcome: `permissions.ts` tests cover chains whose segments match different allow/deny rules.
- [ ] The p95 hook overhead stays ≤ 50 ms (`bench.spec.ts` with `RUN_BENCH=1`).
- [ ] Spec amendment recorded in `docs/specs/445-token-saver.md`.

## Out of scope
- New command families or changes to existing filters' output.
- Rewriting in permission modes other than `auto` and `bypassPermissions`.

## Open questions
None.
