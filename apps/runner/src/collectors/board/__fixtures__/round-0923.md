# Round 2026-10-08 0923 · acme/widget · base develop · occupied 3/5 · free 2

Orchestrator: widget-46. Resumed after the stop at 0335 (2026-10-07 board). PR #45 (i12-api) merged meanwhile as 6c89605.

## Dispatching
| Slot | Issue | Title | Kind | Model | Why that model | Lead | Owns | Worktree | Branch |
|---|---|---|---|---|---|---|---|---|---|
| i12-adapters | #12 | agent sessions | feature | opus | parallel plan; first runtime adapter, new runner command end to end | yes | apps/runner/**, shared commands/sessions | ../.wt-widget-i12-adapters | feat/12-session-adapters |
| i12-web | #12 | agent sessions | feature | sonnet | parallel plan; API merged, pages with siblings | i12-api (merged #45) | web sessions/**, nav.ts | ../.wt-widget-i12-web | feat/12-sessions-web |

Briefs: copies of 2026-10-07 round-2226 briefs with the orchestrator name updated.

## Held for a lead
| Slot | Waiting on | Dispatch when |
|---|---|---|
| i11-runner (opus) | i11-api | its PR merges |
| i11-web (sonnet) | i11-api | its PR merges |

## Not dispatching
| Issue | State | Why | What would clear it |
|---|---|---|---|
| #13 | BLOCKED — work | depends on #12 | i12-adapters + i12-web merge |
| #16–#22 | BLOCKED — work | chain through #11/#12/#17 | upstream closed |

## Already in flight
| Slot / PR | Issue | Where it got to |
|---|---|---|
| i11-api | #11 | done locally (f465a48, checks green), blocked on push |

## Log
- 0926 i11-api: blocked on push. `ssh -T` now authenticates.
- 0928 DISPATCHED i12-adapters · #12 · opus · Part of #12.
| not | a | decision table |
