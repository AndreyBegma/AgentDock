# Cost model

AgentDock shows **API-equivalent cost**: what the recorded tokens would cost at
public API prices. It is shown even when the runtime runs on a subscription,
because it is the only number comparable across runtimes, models and months.

## Inputs

Tokens are recorded per LLM request in buckets, each token in exactly one:
`input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`, `reasoning`.

Sources, in order of preference:

1. **OTel** from sessions the runner launched (`claude_code.api_request`,
   `codex.api_request` / `codex.sse_event`). Claude Code does not split cache
   writes by TTL; such writes go to `cacheWrite5m` and are flagged.
2. **Transcripts** (`~/.claude*/projects/**/*.jsonl`, `$CODEX_HOME/sessions`)
   for everything else and for backfill.

The runtime's own `cost_usd` is stored for reference but never used: Anthropic
labels it approximate.

## Price table

`ModelPrice` rows are versioned. Each has a regex `matchPattern` against the
model id and ordered `tiers`, each with conditions (e.g. input > 200k tokens →
long-context price) and per-bucket USD prices. The first seed is derived from
Langfuse's public price file (MIT) with attribution; later edits happen in the
admin UI.

## Computation

- `costUsd` is computed at ingest with the current price version and stored
  with `priceVersion`.
- Changing prices creates a new version; an admin can recompute a date range.
  Nothing is frozen forever (unlike Langfuse).
- A request whose model matches no pattern gets `costUsd = null` and shows as
  "unpriced" — never zero.

## Rollups

`UsageRollup` per hour × project × model × runtime × (slot | run | none) feeds
the dashboards and budget checks; raw `LlmRequest` stays queryable for drill-down.
