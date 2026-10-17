# C-220: Stop Woodpecker asking approval for card PRs from AgentDock

Issue: #504

## What to do
Pipelines for pull requests that AgentDock opens for board cards (for example PR #501, pipeline #982) stop at "This pipeline is awaiting approval from a maintainer" in Woodpecker 3.18, so a person has to click Approve on every card. `deploy/README.md` (CI setup, step 2) and the header of `.woodpecker/pipeline.yml` both say *Require approval* must be `forks` only, so same-repository PRs should run at once.

Find out why the approval is requested and remove the cause:
- Check the repository's Woodpecker settings (via the Woodpecker API or UI): the *Require approval* value. It is most likely `pull_requests` or `all_events` instead of `forks`.
- Check where the card branch is pushed: it must be a branch of `AndreyBegma/AgentDock` itself, not a fork and not another account. Look at how the runner and the API create the card branch and PR (search `apps/runner` and `apps/api` for the PR creation and push code, and ADR-0043 for the close/reopen retrigger) and confirm the PR head repository equals the base repository.
- Check that the close/reopen retrigger from ADR-0043 does not itself cause the approval gate (a reopened PR from a bot or another actor).
- Fix the cause: set the setting to `forks` if that is the cause, or fix the push/PR code if the head is not the base repository.
- Update `deploy/README.md` with the verified setting and a troubleshooting entry: "A pipeline waits for approval on an own-branch PR".

The repository is public and the pipeline mounts the host Docker socket, so unapproved PRs from real forks must still wait for approval (ADR-0016).

## Acceptance criteria
- [ ] The cause of the approval request on PR #501 / pipeline #982 is identified and written down in the PR description.
- [ ] A new card PR opened from an AgentDock branch in the same repository starts its pipeline without a manual Approve.
- [ ] A pull request from a fork still waits for approval (*Require approval: forks* stays in force).
- [ ] `deploy/README.md` and the header of `.woodpecker/pipeline.yml` match the real configuration, and a troubleshooting entry for this symptom is added.
- [ ] If the cause was in the push/PR code, a test next to it (`*.spec.ts`) covers the head and base repository.
- [ ] `bun run check` passes.

## Out of scope
- Auto-approving pipelines through the Woodpecker API on behalf of a person.
- Disabling the approval gate for forks.
- Changes to the pipeline steps, staging deploy or the ADR-0043 retrigger timing.

## Open questions
- If the agent has no access to the Woodpecker settings, should it only document the exact setting for the person to change? Default: yes, document it in `deploy/README.md` and in the PR description, and fix any code-side cause.
