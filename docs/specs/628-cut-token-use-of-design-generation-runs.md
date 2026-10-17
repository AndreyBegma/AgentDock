# C-255: Cut token use of design generation runs

Issue: #628

## What to do
Design generation and design revisions (ADR-0025, ADR-0041, ADR-0044) re-send screenshots, attachments and the previous revision to a large model on every round.

Using per-run cost on Usage as the measure, audit a design run end to end in the runner's design / UI-profile launch code (`apps/runner/src/uiprofile/`, the design launch) and reduce it:
- Downscale and re-encode images to the size the model needs before attaching them.
- Send only the frames a revision changes, plus a short summary of the rest, instead of the whole previous revision.
- Keep the instructions as a stable prefix so they are cached.
- Make sure the launch goes through the Token saver wiring helper (strict MCP list, scout, compaction).

## Acceptance criteria
- [ ] Images attached to a design run are downscaled to a documented maximum edge and size; a test covers the conversion.
- [ ] A revision run sends the changed frames and a summary of the others, not the full prior revision (test on the prompt builder).
- [ ] Design launches use the Token saver wiring helper when the project setting is on (launch spec test).
- [ ] The PR description reports the measured input tokens of one design run and one revision, before and after, on the same project.

## Out of scope
- Changing the design viewer UI or how designs look.
- Changing which model generates designs.

## Open questions
- Maximum image edge. Default: 1568 px longest edge, the size the model uses natively.
