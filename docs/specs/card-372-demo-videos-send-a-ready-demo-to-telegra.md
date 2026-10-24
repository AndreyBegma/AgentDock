# C-372: Demo videos: send a ready demo to Telegram with Merge and Feedback buttons

Stack "Demo videos of finished cards", stage 2 (Features). Needs the stage-1 cards.

When a demo becomes `ready` and the project's `demoTelegram` is on, the bot sends the MP4 (Telegram bot upload limit is 50 MB: above it, send the first frame as a photo plus a link to the card) with the card title, PR number and CI state, and inline buttons through the command router (ADR-0046): **Merge** (same permission and policy checks as the web; respects stacked PR base, ADR-0064), **Feedback** (starts a feedback reply that becomes the card's next round), **Open card**. A failed demo sends one short text line with the reason, no video. Only to members linked to Telegram who can act on the project.

Tests: size fallback, permission check on Merge, feedback creates a round, no message when the switch is off.
