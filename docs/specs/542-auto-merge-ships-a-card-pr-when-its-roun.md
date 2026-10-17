# C-245: Auto-merge ships a card PR when its round ended at once with no new commits

Issue: #542

C-218, 2026-10-17: feedback started round 3 at 10:46:43; the session ended 3 s later (finishedBy session_end) without a commit. The card went to Finished, and auto-merge marked draft PR #520 ready and merged it at 10:46:53 on the green CI of the old head — a PR that held only spec files. The card then reached Completed with nothing implemented.

Expected: auto-merge refuses when the round that just finished pushed no commit (head unchanged since the round started) or ended within seconds; the card stays in Finished with needsPerson and a reason. Also: a feedback round whose session dies at start should be marked failed, not finished.

Add the e2e test that would have caught this (board-ships).
