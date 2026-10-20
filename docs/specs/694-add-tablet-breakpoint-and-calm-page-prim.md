# C-281: Add tablet breakpoint and calm page primitives to glass-ui

Issue: #694

## What to do
Extend the glass-ui package (`@andrewbehma/glass-ui`, pinned at 0.35.0, see `docs/ui/glass-ui.md`) with what the redesign needs, then publish a new version and bump the exact pin in `apps/web`. Per ADR-0011 missing components are added to glass-ui, not to Nautelle, and the person allowed changing glass-ui itself.

Add:
- A tablet breakpoint (640–1024px) next to the existing phone/desk ones, exposed as tokens and a hook-friendly constant.
- An icon-only collapsed variant of the rail for tablets, and a way to visually emphasise one nav entry as the main one.
- Page primitives: `PageHeader` (title, one primary action, overflow menu), `Section` (titled content block on `surface-content`), `EmptyState`, and a responsive list/detail layout (list then detail on phone, side by side from tablet up).
- A quieter default: lower glass intensity and fewer borders on content surfaces, following the approved stack mockup.

## Acceptance criteria
- [ ] A new glass-ui version is published and `apps/web` pins it exactly (bunfig convention).
- [ ] The tablet breakpoint and the collapsed rail variant exist and are documented in `docs/ui/glass-ui.md`.
- [ ] `PageHeader`, `Section`, `EmptyState` and the list/detail layout exist, import by subpath, and use tokens only (no raw colours).
- [ ] Existing Nautelle pages still render without visual breakage after the bump.
- [ ] `bun run check` passes.

## Out of scope
- Changing Nautelle pages to use the new primitives (later cards).
- A new palette or visual language; the navy glass style stays.
- Any change to the Board components.

## Open questions
None.
