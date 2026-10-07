# ADR-0010: Typed command allowlist on the runner

Status: accepted · Date: 2026-10-07

## Context

A runner can launch agents in bypass-permissions mode. A generic 'run this shell' command would make a stolen token or session equal to remote code execution.

## Decision

The runner accepts only commands defined in `packages/shared` schemas, validates arguments, confines paths to registered roots, and can disable commands locally.

## Consequences

Every new capability needs a schema change on both sides — deliberate friction.
