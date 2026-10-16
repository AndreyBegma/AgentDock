# C-196: Woodpecker sometimes creates no pipeline for a newly opened pull request

Issue: #484

## What happened
On 2026-10-16 PR #455 and PR #465 were opened by fleet workers and Woodpecker created no pipeline at all ("no checks reported"); other PRs opened minutes apart were fine. An empty commit retriggered both.

## Expected
Every opened PR gets a pipeline. If the forge webhook is lost, the system notices.

## Acceptance criteria
- [ ] Find the cause (Woodpecker logs for the PR-opened deliveries; GitHub webhook delivery log for those two PRs).
- [ ] Either fix the cause or add a check: the orchestrator watch / card shipping marks a PR with no pipeline after N minutes and retriggers once.

## Notes
Part of this is infrastructure (person-only: Woodpecker / GitHub webhook settings).

**Update 2026-10-16:** for #465 an empty commit did NOT create a pipeline either; closing and reopening the PR did (pipeline 861). So the missing event is on the PR-opened path, not push.
