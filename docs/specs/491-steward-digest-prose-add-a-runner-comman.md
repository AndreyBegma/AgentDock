# C-197: Steward digest prose: add a runner command that writes it with haiku

Issue: #491

## What
Spec #447 D3/D14 says haiku writes the digest prose through the runner. The protocol has no command for it, so i447-digest (PR #463) shipped the template digest only (`prose = null`).

## Do
- A typed command (ADR-0010), e.g. `digest.compose`, with bounded structured input (done / stuck / waiting / spend) and a strict, length-capped single-paragraph output; capability-gated; counted against the project budget (`RunKind steward`).
- The API digest uses it when a runner is online and falls back to the template.

## Acceptance criteria
- [ ] With a runner online the stored digest has prose; offline it is the template.
- [ ] Output is bounded, single-line-per-item, and contains no raw pane text (delta audit DA-12/DA-13).
