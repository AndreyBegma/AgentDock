# A card session blocked by Claude Code’s "Teach auto mode" dialog shows Waiting for you

Issue: #435 · Board card: C-80 · Kind: bug

## What to do
C-75's session (profile `andriybehma`, `--permission-mode auto`) was blocked by a Claude Code modal: "Teach auto mode about your environment? 1. Yes 2. Not now 3. Don't show again". The card showed **Waiting for you**; nobody saw the dialog until a person attached to the tmux pane and pressed Escape.

Claude Code shows it after several auto-mode classifier denials in a profile (the profile's `~/.claude.json` has `autoModeEnvSetup: { denials: 5 }`; dismissing records `dismissedAt`). It is not a permission prompt and needs no decision.

Fix (runner, card sessions): watch the card's pane for known blocking Claude Code dialogs that need no decision — this one first — and answer them with the option that changes nothing ("Not now"/Escape), logging that it did. Prefer pane detection over writing the profile's `.claude.json`. Keep the list of known dialogs in one place, with their exact match text and the key to send.

## Acceptance criteria
- [ ] A card pane showing "Teach auto mode about your environment?" is answered "Not now" within one pane poll, and the session continues (runner unit test with a captured pane fixture).
- [ ] Permission prompts and any unknown dialog are never answered automatically.
- [ ] The runner logs each automatic dismissal with the card and the dialog name.
- [ ] Runner tests pass.

## Out of scope
- Showing unknown dialogs on the card (a follow-up).
- Changing auto mode or the classifier.
