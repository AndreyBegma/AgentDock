# ADR-0011: glass-ui is the component library

Status: accepted · Date: 2026-10-07

## Context

The owner maintains glass-ui (Liquid Glass design system) and wants it to grow into a reusable constructor across projects.

## Decision

AgentDock imports glass-ui by subpath, pinned to a tag, with `data-scale="desk"`. A missing component is designed and added to glass-ui (own spec, own PR, new tag), not written inside AgentDock. App-specific compositions stay in `apps/web`.

## Consequences

Slower first screens, a richer shared library. Requires `transpilePackages: ['glass-ui']` in Next.
