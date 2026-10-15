# ADR-0022: The design stage draws HTML mockups from a cached UI profile — no external design tool, no dev server

Status: accepted · Date: 2026-10-14 ·
Issue: [#223](https://github.com/AndreyBegma/AgentDock/issues/223)

## Context

UI tasks reach the fleet as text, and the person sees the result only in the
pull request. A mockup before the work catches a wrong layout for the price of
one turn instead of one task.

Three ways to produce a mockup were weighed on 2026-10-14:

- **Figma.** The official MCP server's write-to-canvas needs a paid Full or Dev
  seat and is announced as a usage-based paid feature. The free route is the
  Plugin API behind a WebSocket bridge, which needs Figma open with the plugin
  started by hand. The REST API on the Starter plan is limited to a handful of
  requests a month. Figma draws generic shapes, not the project's components.
- **The project's own stack.** The mockup would be real code, rendered by the
  project's dev server on the runner and photographed. Highest fidelity, but
  every stack needs its own way to start, many projects do not start without a
  database or secrets, and the runner would have to run project code for a
  preview.
- **A self-contained HTML mockup** styled from a description of the project's
  UI. No tool, no seat, no project code running. An approximation of the real
  components.

## Decision

1. **A mockup is one self-contained HTML document**, drawn by a read-only
   planner turn and rendered by the person's browser in a sandboxed iframe
   (`allow-scripts`, opaque origin, `connect-src 'none'`). External resources
   come only from a fixed CDN allowlist in code, at exact versions.
2. **Fidelity comes from a UI profile**: per project, cached in AgentDock's
   database, versioned and editable. It holds a description of the UI (libraries,
   tokens, components, patterns) and a **style kit** of CSS and HTML snippets
   every mockup reuses. It is rebuilt when a fingerprint of the files it was
   built from changes on the base branch.
3. **The design stage is a step of the Planner** (#172): a task that needs a
   design cannot be approved before its design is. The approved HTML is
   published next to the spec in the docs pull request, so the worker reads it
   from the repository.
4. **No external design tool** is part of the flow. An exporter to one can be
   added later as an adapter without changing this stage.

## Consequences

- **The cost: the mockup is not the implementation.** What the person approves
  is a picture in the project's style, and the worker still has to build it
  from real components. The spec's `## Design` section states what the mockup
  binds and what it does not; checking the built screen against the mockup is
  a separate item that will need the project's own rendering after all.
- The runner gains two typed commands (`uiprofile.build`,
  `uiprofile.fingerprint`, ADR-0010) and runs no project code for a preview.
  The control plane still never reads the project's files (ADR-0001): the
  fingerprint is computed on the runner.
- Third-party CDN code runs in the viewer's browser, confined by the sandbox
  and the allowlist. Adding a host is a code change with review.
- Mockups and profiles are stored as text in PostgreSQL (ADR-0007); one
  mockup is capped by the 192 KiB turn-result event.
