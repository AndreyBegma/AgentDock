# "No pull request" shows a raw runner error with internal ids

Issue: #395 · Board card: C-56 · Kind: bug

## What to do
On a Completed card whose worktree is gone, the "No pull request" banner shows the raw runner failure: "No pull request: card.collect: not found on the runner — card cmv992gb5007u01octdbcbbg9 has no worktree in cmv6o6qkn01h201o9tlib0our" (staging, C-1). Map this failure to a plain sentence (the card's worktree no longer exists on the runner, so a pull request cannot be created from it) and keep the raw text out of the UI.

## Acceptance criteria
- [ ] C-1 on staging shows a plain explanation with no internal ids.
- [ ] Create pull request is hidden or disabled with that reason when the worktree is gone.
- [ ] A web test covers the mapping.

## Out of scope
- Other parts of the screen.

Found by the C-46 staging check on 2026-10-16.
