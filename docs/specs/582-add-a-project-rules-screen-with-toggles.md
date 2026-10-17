# C-225: Add a project rules screen with toggles and Markdown import

Issue: #582

## What to do
In `apps/web`, add a Rules section to the project settings area. Using only glass-ui components (ADR-0011; add any missing component to glass-ui, not locally), show the project's rules as a list with title, description and an enabled toggle; allow adding, editing, deleting and reordering a rule, and importing rules from pasted or uploaded Markdown, showing how many were created and skipped. Talk to the rules API over HTTP only. Follow the approved shared design for the stack.

## Acceptance criteria
- [ ] A project's rules are listed with their enabled state.
- [ ] A rule can be created, edited, toggled, deleted and reordered; changes persist after reload.
- [ ] Markdown can be imported by paste or file upload; the result shows created and skipped counts.
- [ ] Empty, loading and error states are handled.
- [ ] Only glass-ui components are used; the screen matches the approved design.
- [ ] Users without edit permission see the list read-only.
- [ ] `bun run check` and `bun run build` pass.

## Out of scope
The scan of the repository on project connection, prompt injection, and API changes.

## Open questions
- Where in navigation does the screen live? Default: a Rules tab in project settings.
