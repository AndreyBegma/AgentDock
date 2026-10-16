# ADR-0043: A card PR that CI never reported on is retriggered once, then needs a person

Status: accepted · Date: 2026-10-16 ·
Issue: [#484](https://github.com/AndreyBegma/AgentDock/issues/484) ·
Spec: [`docs/specs/484-woodpecker-sometimes-creates-no-pipeline.md`](../specs/484-woodpecker-sometimes-creates-no-pipeline.md)

## Context

On 2026-10-16 PR #455 and PR #465 got no Woodpecker pipeline. GitHub's webhook delivery log shows why: Woodpecker answered the `pull_request` `opened` deliveries of both PRs, and the `synchronize` delivery of #465's empty commit, with HTTP 500 within one or two seconds. GitHub never redelivers a failed delivery on its own. The same log has about thirty failed deliveries between 2026-10-13 and 2026-10-16, for every event kind (`push`, `opened`, `synchronize`, `closed`):

- HTTP 500 with the body `database is locked`, or with an empty body: Woodpecker's SQLite database is busy while pipelines are running;
- HTTP 502, 530 and Cloudflare error 1033: the tunnel to `ci.luna-realm.com` was down or the server was restarting;
- timeouts after 10 s.

The fault is in the CI server and the tunnel in front of it, which are infrastructure (deploy/README.md). But a lost event is invisible to AgentDock: `card.checks` sees "no checks", and a card that ships itself (ADR-0035) treats a head with no checks on its second read as green. A lost webhook could therefore merge a card PR that CI never ran on.

## Decision

1. **No checks in a project with CI is a lost event, not "no CI".** A project has CI once any of its cards' PRs had a check (`ciState` `pending`, `green` or `red`). In a project without that evidence, a head with no checks ships as before (#359 D5).
2. **The API waits, then retriggers once per head.** The card stores since when its head has had no checks (`ciNoneSince`). After `CARD_CI_MISSING_MS` (5 minutes) the API sends the runner `card.ciRetrigger`, a typed command (ADR-0010). The runner checks that the PR is open and still at that head, then runs `gh pr close` and `gh pr reopen --comment …`. A reopened PR is an event every pull-request CI listens to, it adds no commit, and it is what brought #465's pipeline back. The head is stored as `ciRetriggeredSha` and the retrigger is audited as `card.ci_retriggered`.
3. **Still no checks: a person.** When the head has no checks `CARD_CI_MISSING_MS` after its retrigger, or the runner cannot retrigger it (an older runner, a PR left closed), the card gets `needsPerson`. This is audited as `card.auto_run_failed` with reason `ci_not_reported`, and the card goes to Finished unmerged. The board shows "CI reported no checks".

## Consequences

- A lost webhook now costs about five minutes and one closed/reopened pair in the PR timeline, instead of a PR with no checks or an unchecked merge.
- The first card PR of a project whose CI is down ships unchecked, as before: until then there is no evidence the project has CI.
- The infrastructure cause stays a person's job. Woodpecker on PostgreSQL instead of SQLite, and a steadier tunnel, are listed in the pull request for #484.
- Fleet PRs (`source: fleet`) are watched by the cs-orchestrator, outside this repository. It needs the same check of its own.
