# ADR-0011: glass-ui is the component library

Status: accepted · Date: 2026-10-07

## Context

The owner maintains glass-ui (Liquid Glass design system) and wants it to grow into a reusable constructor across projects.

## Decision

AgentDock imports glass-ui by subpath from the npm package `@andrewbehma/glass-ui`, pinned to an exact version, with `data-scale="desk"`. A missing component is designed and added to glass-ui (own spec, own PR, new release), not written inside AgentDock. App-specific compositions stay in `apps/web`.

## Consequences

Slower first screens, a richer shared library. The package ships compiled `dist/`, so Next needs no `transpilePackages` entry for it.

Amended: until glass-ui 0.22 the dependency was a GitHub tag (`github:AndreyBegma/glass-ui#<tag>`) that shipped TypeScript source and required `transpilePackages: ['glass-ui']`. Since 0.23.0 it is the npm package.
