# Changes AgentDock needs in code-sentinel

Repository: [AndreyBegma/claude-code-plugin](https://github.com/AndreyBegma/claude-code-plugin).
Each item is a separate pull request there; AgentDock must keep working without
them (markdown fallback) until they land.

| # | Change | Why | Milestone |
|---|---|---|---|
| P1 | `dispatch.sh`, `watch.sh` and the orchestrator append events to `<git-common-dir>/cs-orchestrator/events.jsonl` in the schema of [event-schema.md](../architecture/event-schema.md) (`v: 1`); a small `emit.py` helper does the append atomically | structured, persistent fleet state (ADR-0002) | M2.1 |
| P2 | The orchestrator keeps `<git-common-dir>/cs-orchestrator/state.json` current: config, slots, last checkpoint per slot, held rows | cheap snapshot on runner (re)connect | M2.1 |
| P3 | The worker's reply checkpoints also emit `slot.checkpoint` events (via `emit.py`, allowed by the fence) | checkpoint status without parsing markdown | M2.1 |
| P4 | `dispatch.sh` passes through `OTEL_*` and `AGENTDOCK_*` environment to the session and sets `OTEL_RESOURCE_ATTRIBUTES` with project / slot / issue | usage correlation (ADR-0003) | M1.7 |
| P5 | `dispatch.sh --runtime claude\|codex` with a Codex launch path (`codex` in tmux, `workspace-write` sandbox, brief as first prompt) | Codex workers (ADR-0013) | M4.1 |
| P6 | Pre-merge ownership check: the orchestrator refuses to merge a slot whose diff leaves its `owns:` globs (reuse `fence.py` parsing) | Codex fence; also a safety net for Claude | M4.2 |
| P7 | `orchestrator.specDir` accepts a relative path outside the repository (`../denitsa-documentation/prs`) or a repo URL; cs-spec writes specs there | separate docs repositories (ADR-0012) | M1.4 |
| P8 | Orchestrator respects `orchestrator.mergeApproval: true` (or reuses `autoMerge: false`) by emitting `pr.awaiting_approval` and acting on an approval file / message | merge approval queue | M2.5 |
| P9 | Orchestrator start honours a launcher from the environment (`CS_CLAUDE_BIN`, `CLAUDE_CONFIG_DIR`) for workers it dispatches, so a runtime profile chosen in AgentDock propagates to slots | runtime profiles (ADR-0006) | M2.2 |
| P10 | cs-init template: PostgreSQL password from an env file instead of inline in `docker-compose.yml` | the scaffold commits a password | M1.1 |
