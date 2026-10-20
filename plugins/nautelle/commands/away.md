---
description: Turn Nautelle away mode on or off (permission prompts go to the web app and Telegram)
argument-hint: on|off
---

Set Nautelle away mode by calling the `away` tool of the `nautelle` MCP server
(`mcp__plugin_nautelle_nautelle__away`).

- `$ARGUMENTS` is `on` or `off`. If it is empty or anything else, ask which one; do not guess.
- Call the tool once with that value and report the resulting state.

If the tool returns an error (`runner_offline`, `forbidden`), say so plainly and do not retry.
