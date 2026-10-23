---
name: track-work
description: Track the work a person asks for as a card on the Nautelle Board. Use when the person asks you to implement, fix, change or build something in this repository; not for questions, explanations or reading code.
---

# Track work on the Nautelle Board

When the person asks you to **do work** — implement a feature, fix a bug,
change or refactor code — call the `track_card` tool of the `nautelle` MCP server
(`mcp__plugin_nautelle_nautelle__track_card`) **once**, before you start. It
puts the work on the Nautelle Board as a card In progress, linked to this
session.

## What counts as work

Track:

- "add an export button", "fix the login redirect", "refactor the billing module".

Do **not** track:

- Questions, explanations, code reading, reviews, brainstorming, or running a
  command the person asked for.
- A follow-up that is part of the work you already track.
- Work you were not asked to do.

When in doubt, do not track: a card for every message fills the Board with noise.

## How

- **One card per session** is the default. Call the tool once, with:
  - `title` — a short title, like an issue title (up to 200 characters).
  - `body` — what is being done and why, in a few lines of markdown (optional).
  - `kind` — `feature` or `bug`, only when it is obvious (optional).
- If the scope of the same work changes, call the tool again from this
  session: it updates the same card (title, body, kind) and never creates a
  second one. Do not call it again for unrelated work in the same session.
- If the work is a card that **already exists** ("do C-42"), do not create a
  second one: use `take_card` (see the `board` skill).
- Do not start, stop or move anything else on the Board from here; the card follows the
  session. When the session ends the card moves to Finished, and only the
  person moves it to Completed.

## Errors

If the tool returns an error (`not_a_manual_session`, `runner_offline`,
`no_project`, `forbidden`), say so in one line and carry on with the work
without retrying. `not_a_manual_session` means this is not the person's own
terminal session (for example a board card worker), which needs no card of
its own.
