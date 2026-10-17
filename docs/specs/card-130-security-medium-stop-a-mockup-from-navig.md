# C-130: Security [Medium]: Stop a mockup from navigating its frame or opening the pin composer on its own

> Security audit 2026-10-16 · **WI-28** · severity **Medium** · size **S** · findings: F-28 (Z6 W-2, Z8 W8-02, Z9 L9, Z6 P2-B4-4), L-48 (Z8 W8-03)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**F-28.** A mockup runs in `iframe sandbox="allow-scripts"` (`apps/web/src/components/design/mockup-frame.tsx:94`). The validator forbids only `top/parent.location` and `postMessage` (`packages/shared/src/design/validate.ts:48-65`), so a mockup can still navigate its own frame (`location.assign`, `self.location`, a meta refresh) to any page, which then renders inside the AgentDock design viewer. UI-profile kit and snippets saved through `PUT /projects/:id/ui-profile` skip the validator. **L-48.** The viewer accepts the frame's `pin` message while pin mode is off (`design-viewer.tsx`, `pinMode` at :107), so a mockup can open the pin composer and plant a `selector`.

**Attacker.** Whoever controls mockup HTML: a prompt-injected design run, or a project member editing the UI profile.

**Scenario.** The mockup navigates its frame to a look-alike login page shown inside the trusted viewer, or opens the comment composer with attacker text.

**Impact.** Credential phishing inside the app's own chrome; misleading pins on a design.

## Fix
- In `mockup-frame.tsx`, track the iframe's `onLoad`; a second load for the same `src` blanks the frame and shows "The mockup tried to leave this page".
- Add `location` assignment and `location.assign/replace`, `self.location`, `window.location` and `<meta http-equiv=refresh>` patterns to `FORBIDDEN_SCRIPT` as a tripwire.
- Run the mockup validator on the UI-profile kit and snippets in `apps/api/src/design/{dto,design.service}.ts`.
- Accept `pin` messages only while pin mode is on and within a short window after a pointer event on the stage; cap the `selector` length and characters (`apps/web/src/lib/design/frame-messages.ts`).

## Acceptance criteria
- A component test simulates a second `load` of the mockup iframe and the frame is reset with a visible notice
- A validator test refuses `location.assign(`, `self.location=` and a meta refresh, and still accepts the existing fixtures
- An API e2e test: `PUT /projects/:id/ui-profile` with a snippet containing `location.href=` gives 400/422
- A viewer test: a `pin` message while pin mode is off does not open the composer; an over-long selector is refused

## Touches
- apps/web/src/components/design/mockup-frame.tsx
- apps/web/src/components/design/design-viewer.tsx
- apps/web/src/lib/design/frame-messages.ts
- packages/shared/src/design/validate.ts
- apps/api/src/design/dto.ts
- apps/api/src/design/design.service.ts

## Decision
none needed

## Must not run in parallel with
- WI-27
- WI-66


**Delta audit (DW-01):** a mockup can drive the design viewer zoom without a gesture via the new `wheel` message (#441) — drop non-`isTrusted` events in the pin helper, throttle, coalesce per animation frame (`mockup-frame.tsx:66-69`, `design-viewer.tsx:139-143`, `packages/shared/src/design/pin.ts:141-145`). The iframe-reload tripwire must work per frame.

Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
