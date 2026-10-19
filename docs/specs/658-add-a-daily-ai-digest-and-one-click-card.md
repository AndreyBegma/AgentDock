# C-242: Add a daily AI digest and one-click card, PR and session summaries

Issue: #658

## What to do
Build both features on the LLM gateway. Usage is tagged `digest` and `summary`, and the caps apply.

**Daily digest.**
- Each project has a toggle and a time, defaulting to off and 09:00 in the project's timezone.
- A BullMQ schedule (ADR-0015) builds it from the last day's activity, Board changes, merged and failing PRs, and Steward incidents.
- It separates what got done, what is stuck and what waits for a person.
- It is sent to the linked Telegram chats and shown in the web activity view.

**Summaries.**
- A Summarize button on card detail summarizes the card and its PR: changes, CI, review state and what remains.
- A Summarize button on an agent session works only for projects with session content opted in (ADR-0021).
- Summaries are cached until their source changes, and written in the reader's language.

## Acceptance criteria
- [ ] An enabled digest arrives at the configured time in Telegram and the web; a disabled one sends nothing.
- [ ] The digest separates done, stuck and waiting items, with links.
- [ ] A repeat card summary with no changes comes from the cache, with no new usage row.
- [ ] The session Summarize button is hidden without session content.
- [ ] When the cap is reached, the button shows the cap message, and the digest is skipped with an event recorded.

## Out of scope
- Search and triage hints.
- Weekly digests.

## Open questions
None.
