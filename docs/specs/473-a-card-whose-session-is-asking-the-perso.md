# C-194: A card whose session is asking the person a question still shows Running

Issue: #473

## What happened
Board card C-87 (#452) sat for ~90 minutes on a Claude Code question selector (AskUserQuestion: "SelectionBar is missing in glass-ui — what now?"). The card stayed at round phase `running`, `needsPerson: false`, so nobody was told. Found by the orchestrator reading the pane on 2026-10-16.

## Expected
A card whose session shows an interactive question (AskUserQuestion selector, "Enter to select · ↑/↓ to navigate") is **Waiting for you**, and the person is notified once (Telegram / web), with a link to open the session.

## Acceptance criteria
- [ ] The runner detects the question selector in the card pane (fixture from a real pane) and reports the round as waiting.
- [ ] The card shows Waiting for you; the notification fires once per question.
- [ ] Answering clears the waiting state.

## Notes
Related: #390 (background tasks), #435 (known dialogs), Steward #447 (silent stalls).
