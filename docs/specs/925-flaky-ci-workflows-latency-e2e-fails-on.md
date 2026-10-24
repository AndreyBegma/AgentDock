# C-385: Flaky CI: workflows-latency e2e fails on a loaded agent (viewer call 311 ms)

Issue: #925

## What happened
`apps/api/src/workflows/workflows-latency.e2e.spec.ts:116` (`expect(slow).toEqual([])`) failed on Woodpecker pipeline 2640 (PR #919, which changes no API code) with `[{ caller: 'viewer', ms: 311 }]`. The rest of the suite passed (3401/3402). The CI host runs three agents and the full api suite takes 12–13 minutes, so a single wall-clock budget per call trips under load.

## Fix
Keep the test's purpose (no endpoint regresses to slow), but make it robust to a loaded host:
- measure each caller several times and judge the median, or the p90 of N runs, not a single call;
- warm up first;
- take the budget from an env-overridable constant, with a higher default when `CI` is set;
- on failure keep printing who was slow.

Check that a real regression still fails it: add an artificial `setTimeout` to one handler locally and see the test go red.
