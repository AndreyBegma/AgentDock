# Recorded `tool_response` shapes (#747 D6)

The PostToolUse `tool_response` objects that `tool-hook` rewrites, recorded
from Claude Code 2.1.306 with a hook that dumped its stdin. `tool-hook` cuts
only these shapes; any other gets no output.

| File | Tool | Field the hook cuts |
|---|---|---|
| `grep-content.json` | Grep, `output_mode: content` | `content` |
| `grep-count.json` | Grep, `output_mode: count` | `content` |
| `grep-files-with-matches.json` | Grep, `output_mode: files_with_matches` | `filenames` (entries) |
| `webfetch.json` | WebFetch | `result` |
| `mcp-text-and-image.json` | an MCP tool returning text and an image | the text blocks, as one |

Replaying each shape through `updatedToolOutput`, with only that field
changed, reached the model with no `hook_error_during_execution`. In the MCP
fixture the text was shortened and the image path neutralised; the spec pads
the text past the limit.
