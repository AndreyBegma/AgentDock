# C-223: Add a switch on the stack page to turn the stack's required design off and on

Issue: #502

## What to do
Today a stack's design can only be chosen at confirm time, with the "Draw a stack design first" switch in `apps/web/src/components/board/split-review.tsx`. After that the stack page (`apps/web/src/app/(app)/projects/[projectId]/board/stacks/[number]/page.tsx`) has no way to change it. The API already supports it: `PATCH /projects/:projectId/board/stacks/:number/design` with `needed` (`StackDesignController.patch` → `DesignService.stackPatch`), which also creates the design row when none exists.

Add a "Stack design required" switch to the stack page for operators, using the glass-ui Switch as split-review does (ADR-0011). Turning it off sets `needed: false`: the design-first gate lifts (ADR-0044 §6) and Run on the stack's cards is no longer refused. Turning it on sets `needed: true`: the gate holds until the design is approved, and Generate design appears. The page header, the design status pill, the gate banner and the stack face on the Board (`stack-face.tsx`) refresh to match.

## Acceptance criteria
- [ ] An operator sees a switch on the stack page that reflects whether the stack design is required; viewers see the state without being able to change it.
- [ ] Switching off calls `PATCH …/stacks/:number/design` with `needed: false`; the gate banner and design chip disappear, and Run on a stack card is no longer refused with `stack_design_not_approved`.
- [ ] Switching on (including for a stack confirmed without a design) calls the same endpoint with `needed: true`; Generate design appears and Run is refused until the design is approved.
- [ ] Switching off keeps the existing revisions and approval; switching back on shows them again.
- [ ] A failed request shows the error and the switch returns to its previous state.
- [ ] The change is audited (the existing `needed` before/after audit in `DesignService.patchOf`); an API test covers turning a stack's design off and on and its effect on `assertRunnable`.
- [ ] Only glass-ui components are used.

## Out of scope
- Changing the confirm-time switch in the split review.
- Card-level design switches.
- Intake behaviour.

## Open questions
- May the design be switched off while a stack design turn is running? Default: no; the switch is disabled while a design turn is active (Stop it first).
- May it be switched on after a card of the stack has already run? Default: yes; it gates only cards that have not started.
