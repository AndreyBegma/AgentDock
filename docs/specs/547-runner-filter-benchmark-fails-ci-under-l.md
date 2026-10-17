# C-246: Runner filter benchmark fails CI under load (bench.spec.ts p95 ≤ 50 ms)

Issue: #547

Issue #529. `filter overhead (#445 D3) > adds at most 50 ms per command at p95` in apps/runner fails on Woodpecker when two pipelines run at once (pipeline 1140, PR #508: 1965 ms). A wall-clock benchmark must not gate CI. Keep it as a local benchmark (skipped unless an env flag such as RUN_BENCH=1 is set) or measure relative to a baseline run in the same process; CI must stay deterministic. Closes #529.
