# C-263: A card session stuck on Claude Code's workspace trust dialog shows Running for hours

Issue: #624

C-248, 2026-10-17: the round started at 19:22 and its session sat on Claude Code's "Accessing workspace … Is this a project you created or one you trust?" dialog (it named a pre-approved `Bash(git show *)` in .claude/settings.local.json) until 21:36. The Board showed the card In progress with no signal; nobody was asked.

Expected: the runner pre-trusts the card worktree it created (hasTrustDialogAccepted for the worktree path in the profile's project config, or the launch flag that skips the dialog), and if any blocking startup dialog is still on screen after N seconds the card shows Waiting for you with the reason (like the Teach auto mode case, C-80/#435). Add a test for the trust pre-seed.
