---
description: Hand the current work off to the Nautelle fleet as an issue a person approves for the queue
argument-hint: [short title]
---

Hand this work off to the Nautelle fleet by calling the `handoff` tool of the
`agentdock` MCP server (`mcp__plugin_agentdock_agentdock__handoff`).

1. Title: `$ARGUMENTS` if given, otherwise a short title you derive from the work so far.
2. Body: what is done, what remains, and what a fresh agent must know to continue. Self-contained; no references to this conversation.
3. Branch: the current git branch (`git rev-parse --abbrev-ref HEAD`).

Call the tool once, then report the issue it created and that the fleet takes it
only after a person approves the request it returns (`actionRequestId`) in
Nautelle or Telegram — do not label or queue it another way. If the tool returns an error
(`runner_offline`, `no_project`, `forbidden`), say so plainly and do not retry.
