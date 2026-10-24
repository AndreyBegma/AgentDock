# C-370: Demo videos: record automatically when a UI card turns green, and "Record again"

Stack "Demo videos of finished cards", stage 2 (Features). Needs both stage-1 cards.

## What
- When a **feature** card's PR is green (and review passed, if on — ADR-0084) and the PR changes files matching the project's `demoUiPaths`, the Board creates a `card_demos` row (`auto`) and sends `card.demo` to the project's runner. Bugs and non-UI cards get no auto demo.
- **Never blocking:** the card moves to Finished as before. Auto-merge (when the project has it) waits for the demo to be `ready`/`failed`/`skipped` with a 15-minute cap, so the person can watch before an auto-merge; with merge policy `ask` nothing changes.
- A new head after a fix round supersedes a running demo; the new head gets a new demo.
- **"Record again"** (`POST …/demos`, manual) works on any card with a PR, any column except Completed.
- Runner offline / DemoFlow not ready → `skipped` with the reason; no retries loop.
- Activity entries for demo ready/failed; the card's `needsPerson` is not set by a failed demo.

Tests: trigger rules (feature vs bug, path match), supersede on new head, auto-merge wait and cap, manual on any column.
