# ADR-0009: API-equivalent cost from a versioned price table

Status: accepted · Date: 2026-10-07

## Context

The owner uses subscriptions, so real spend per run is not observable; a comparable figure is still needed.

## Decision

Compute cost from recorded token buckets and a versioned `ModelPrice` table (regex match, tiers), seeded from Langfuse's public price file. Store `priceVersion`; allow recompute. Unmatched models are 'unpriced', not zero.

## Consequences

Comparable numbers across runtimes and time; budgets are defined in the same unit.
