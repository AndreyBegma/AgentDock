# C-258: Flaky e2e: /live gateway keepalive drops a socket that stops answering pings

Issue: #558

`/live gateway (e2e) › keepalive › drops a socket that stops answering pings` failed with "closed before open" (live/testing/live-e2e.ts:91) in pipeline 1170 (PR #549) and passed on a rerun of the same head (pipeline 1204), while two CI pipelines ran at once. Make the test deterministic: wait for the socket to open before shortening the keepalive, or drive the ping timer with fake timers / an injected clock, so host load cannot close it before open. No production change unless the gateway itself races.
