# C-253: Guard whole reads and repeated reads in every runner launch

Issue: #616

## What to do
The runner filter sees only Bash. An agent's largest inputs are `Read` of whole big files, repeated `Read`s of the same file and wide search results. Today these are guarded only by the code-sentinel plugin's `/cs-eco` hooks, which runner launches enable through `CS_ECO=1` (`apps/runner/src/launch/token-saver.ts`). That only works when the plugin is installed in the launch profile.

Add these to the runner's own launch settings (`filterHookSettings` / the wiring helper), through a new `agentdock-runner` hook subcommand that fails open:
- A PreToolUse guard on `Read`: a whole read of a file over a size threshold is refused once, with a message suggesting `offset`/`limit`, `Grep` or the `scout` agent. A second identical request is allowed.
- A soft dedup: a re-read of an unchanged file range in the same session gets a short reminder instead of the content.

Every guard decision writes a stats row with its own filter id (e.g. `tool/read-guard`, `tool/read-dedup`) and estimated bytes saved, so it shows on the dashboard. When the runner wires these itself, it must not also double-guard through `/cs-eco`.

## Acceptance criteria
- [ ] A card worker launched with Token saver on, in a profile **without** the code-sentinel plugin, has the read guard and dedup active (launch spec test).
- [ ] A whole `Read` of a file over the threshold is refused once with guidance; the immediate retry succeeds.
- [ ] A repeated read of an unchanged range is deduped; a read after the file changed is not.
- [ ] Guard rows appear in `filter-stats.jsonl` with their own ids and are accepted by the API schema (`packages/shared/src/token-saver/contracts.ts`).
- [ ] With the plugin also present, each read is guarded once, not twice.
- [ ] Any hook error lets the tool call run unchanged.

## Out of scope
- Changing the code-sentinel plugin repository.
- Compressing MCP tool results.

## Open questions
- Size threshold for a guarded whole read. Default: 64 KB or 1,500 lines, whichever comes first.
