# ADR-0003: Usage from OpenTelemetry, transcripts as backfill

Status: accepted · Date: 2026-10-07

## Context

Tokens per agent are needed for cost tracking. Claude Code and Codex both export OTel (logs, metrics, traces) when enabled, and both write session transcripts.

## Decision

The runner hosts an OTLP receiver on 127.0.0.1 and launches every session with telemetry enabled and `OTEL_RESOURCE_ATTRIBUTES` carrying project / slot / issue / run. Sessions it did not launch, and history, come from transcript parsing.

## Consequences

Exact correlation for managed sessions without path heuristics. Two parsers to maintain per runtime. Rejected: mtime-based liveness and transcript-only ingestion as the primary path.
