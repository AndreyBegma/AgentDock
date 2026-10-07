# ADR-0007: PostgreSQL only

Status: accepted · Date: 2026-10-07

## Context

Langfuse splits storage across PostgreSQL, ClickHouse, Redis and S3 for billions of observations. AgentDock's volume is thousands of requests a day per machine.

## Decision

PostgreSQL 16 for everything, with `Event` and `LlmRequest` partitioned by month and hourly rollups for dashboards. Queues (webhook deliveries, schedules) are tables polled with `SKIP LOCKED`.

## Consequences

One dependency to run and back up. Revisit if event volume passes ~50M rows a month.
