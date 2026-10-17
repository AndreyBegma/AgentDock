# C-264: Card collect fails for good when the worker rewrote a pushed commit (non-fast-forward)

Issue: #630

C-241, 2026-10-17: round 1 pushed 56aae6af, then the worker amended it locally (ec3da432, one line different) and kept committing. Every later card.collect failed with "git push … Note about fast-forwards", including after feedback round 2 — the round summary said the fix was pushed, the PR kept its old red head, and the card sat in Finished with collectState failed and no signal on the card face.

Expected: (1) the worker brief forbids amending or rebasing pushed commits; (2) on a non-fast-forward, collect fetches the remote branch and, when it is an ancestor of HEAD after `git merge -s ours` (or the trees differ only by commits already superseded locally), records the merge and pushes without force; otherwise the card goes to Waiting for you with the reason; (3) a failed collect shows on the card face. Add the runner test that reproduces the diverged branch.
