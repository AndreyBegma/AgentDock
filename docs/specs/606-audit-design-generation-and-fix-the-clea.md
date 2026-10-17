# C-249: Audit design generation and fix the clear defects it finds

Issue: #606

## What to do

The person asked for a review of how design generation works and for proposals on what to improve. Review the design stage end to end against ADR-0022, ADR-0025, ADR-0041, ADR-0044 and `docs/specs/223-design-stage.md` (and the later design specs, e.g. `526-make-design-generation-and-the-stack-des.md`, so nothing already decided is re-proposed):

- Prompt assembly: `apps/api/src/design/design-prompt.ts` (profile, style kit, skills, variants, open comments; how an over-long prompt is trimmed).
- Turn flow: `apps/api/src/planner/card-design-turn.service.ts`, `plan-turn-design.ts`, `stack-design-turn.service.ts`, and the revise path, including auto-starts.
- The UI profile build and its fingerprint (the panel says that for a project without a profile Generate builds it first and takes a few minutes): is the wait visible, does a failure end cleanly, is the profile rebuilt only when needed?
- The launch panel `apps/web/src/components/design/generate-panel.tsx`: profile and model choice, variants, error and busy states, and what the person sees while a turn runs and after it fails.
- Result handling: the 192 KiB cap, the sandboxed viewer, frames, comments and revisions.

Fix the defects that are clear and small enough for this pull request, each with the test that would have caught it. For everything else, add a "Proposed improvements" section to `docs/specs/223-design-stage.md` (or a new spec under `docs/specs/` if that reads better), each item with the evidence found (file and line), the expected benefit and a rough size, ordered by value, so the person can turn the ones they want into cards. Do not build the larger proposals.

## Acceptance criteria

- [ ] The prompt, turn flow, profile build, launch panel and result handling listed above have each been reviewed, and the written findings say so.
- [ ] Every clear defect that was fixed has a test that fails without the fix.
- [ ] A "Proposed improvements" list exists in the docs with evidence, benefit and size for each item, ordered by value.
- [ ] No proposed improvement is half-implemented in the code.
- [ ] `bun run check`, `bun run lint` and `bun run test` pass.
- [ ] Any architecture change that a fix needs is recorded as a new ADR in the same pull request.

## Out of scope

- The default design skill set (a separate piece of work).
- Building the larger proposed improvements.
- Replacing the HTML-mockup approach decided in ADR-0022.
- Changes to glass-ui components.

## Open questions

- Where should the improvement list live? Default: in `docs/specs/223-design-stage.md`.
- How much may be fixed in this card? Default: only clear defects that fit one pull request; the rest become proposals.
