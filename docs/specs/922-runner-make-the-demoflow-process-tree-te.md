# C-384: Runner: make the DemoFlow process-tree tests deterministic (flaky "kills what DemoFlow left running")

Issue: #922

## What happened
`apps/runner/src/demos/process.spec.ts` › `createDemoflowSpawn > kills what DemoFlow left running when it ends on its own` passed on #906 (C-369), then failed on #919. #919 is the runner 0.16.0 version bump and changes no runner code (Woodpecker pipeline 2622, 3314 ms).

The test starts `sh -c 'setsid sleep 30 & echo $!; sleep 0.3; echo done >&2; exit 2'` and expects the `setsid` child to be gone afterwards.

The `ProcessTree` only learns a descendant by polling (every 20 ms in the test). If the root exits before a poll sees the child, the child has already been re-parented to init (ppid 1). It is then never recorded, so nothing kills it. That is a timing race under CI load. It is also a real runner gap: a demo whose app double-forks fast can leave the app running.

## Fix
- Do not rely on catching the child by poll timing:
  - take the first process-table snapshot right after spawn and again on the root's `exit` before anything else;
  - also kill the root's process group and session (`-pid`; and on Linux, every process whose `/proc/<pid>/stat` session id equals the root's sid, which covers a child that called `setsid` only if it kept the sid… so record sids as they are seen);
  - document what is still not caught.
- Make the test deterministic: have the child write its pid to a file and wait for that file before the root exits. No sleep-based timing.
- Run the spec 50 times in a loop locally under `stress`-like load (e.g. `bun test --rerun-each 50 src/demos/process.spec.ts`) and note the result in the PR.

## What the runner catches now
- Every descendant a listing sees while its parent runs, as before.
- Every process, from `/proc`, in a session the tree owns: the root's session (the root leads it, since it is started `detached`) and the session of every process it has seen. Linux does not reuse a pid while it names a live session, so this is safe after the root exits.
- The root's process group, which is killed even after the root has exited.
- A process that `exec`s another command line after it was seen: on Linux a process is identified by its start time in `/proc/<pid>/stat`, not by its command line.
- The table is listed right after spawn and again on the root's `exit`.

## What is still not caught
- A process that called `setsid` and whose parent exited before any listing saw it. Nothing links it to the tree any more.
- Off Linux (a table from `ps`, without session ids or start times): anything reparented unseen outside the root's process group, and a seen process that `exec`s another command line.
