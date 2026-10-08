# Claude transcript fixtures

Synthetic, not copied from a real session. `profile/` is laid out like a
`CLAUDE_CONFIG_DIR`: one main transcript, and one subagent spawned by its
`Agent` call. Line shapes and key names follow real Claude Code transcripts,
which were inspected by keys and counts only.

Everything that is content in a real transcript — prompts, responses,
thinking, tool inputs and outputs, the AI title, the agent description — holds
a string starting with `SENTINEL_`. The adapter tests assert that none of them
reaches an emitted event (D9).

Paths are under `/srv/dev`, which is not a real home directory. Never commit a
real transcript here.
