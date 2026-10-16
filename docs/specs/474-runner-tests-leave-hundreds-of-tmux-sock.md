# C-195: Runner tests leave hundreds of tmux sockets in /tmp/tmux-<uid>

Issue: #474

## What happened
`/tmp/tmux-1000/` holds hundreds of sockets named `agentdock-test-*`, `agentdock-plan-test-*`, `agentdock-uiprofile-test-*` left by `apps/runner` test runs (seen 2026-10-16). Each test run adds more; the servers may also keep running.

## Expected
Every test that starts a tmux server with `-L <name>` kills it (`kill-server`) and removes the socket in its teardown, also when the test fails.

## Acceptance criteria
- [ ] After `bun run --cwd apps/runner test`, no new `agentdock-*test*` socket remains in `/tmp/tmux-$UID` (a check in the suite teardown).
- [ ] A one-off cleanup note in the PR for existing sockets.
