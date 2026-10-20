# C-291: Reject a design frame whose inline script cannot run

Issue: #690

## What happens
Stack S-7's first design revision (cmvgcp51w00og01pnntrzxcce) was accepted and stored, but every frame renders empty below its header. Each frame's inline script declares a top-level `const top`. Inside the mockup iframe that collides with the read-only `window.top`, so the browser throws `SyntaxError: Identifier 'top' has already been declared`. The whole script never runs, and the content kept in `<template>` elements is never inserted. Nothing in the pipeline noticed. The person found it only by opening the viewer.

## What to do
- When a design turn's frames are parsed (`parseDesignBlocks`, `packages/shared/src/planner/contract.ts`; or in the API right after it, if the check needs Node), check each inline `<script>` of each frame:
  - it parses as a classic script (for example `vm.Script` compile without running, or an ES parser);
  - it declares no top-level `const`/`let`/`class` named after a non-configurable window global (`top`, `window`, `self`, `parent`, `frames`, `location`, `document`, `name`, `status`, `length`, `opener`, `closed`).
- A failing frame fails the turn with a new `contract_violation: design_script_invalid` that names the frame and quotes the parser message. The planner's retry then gets the reason (C-290 / #687 passes it into the retried turn).
- Add one rule to the design contract prompt: wrap mockup scripts in an IIFE, and never declare top-level names after window globals.
- Update spec `docs/specs/223-design-stage.md` (D6) with the new rule.

## Acceptance criteria
- [ ] A frame whose script declares top-level `const top` fails with `design_script_invalid`, and the message names the frame.
- [ ] A frame with a JavaScript syntax error fails the same way.
- [ ] Frames without scripts, and frames with valid scripts (including the injected pin helper), pass unchanged; the existing contract and design e2e specs pass.
- [ ] The design prompt and spec 223 state the rule.
- [ ] `bun run check` passes.

## Out of scope
- Running the mockup in a headless browser to catch runtime errors.
