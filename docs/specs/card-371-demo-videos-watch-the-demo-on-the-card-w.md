# C-371: Demo videos: watch the demo on the card with luna-player, and project demo settings

Stack "Demo videos of finished cards", stage 2 (Features). Needs the stage-1 cards and the stack design (the person generates it before this runs). glass-ui components only (ADR-0011); a missing one goes to glass-ui.

## What
- **Card view:** a "Demo" section at the top of a Finished card: the latest video in the player, status (recording… / failed + reason / skipped + reason), round and date, scenario path (link to the file in the PR), "Record again", and earlier demos of the card in a short list. The PR's Merge action sits right under the video, so watch → merge is one place.
- **Board card tile:** a small demo state chip (recording / ready / failed).
- **Player:** a `VideoPlayer` adapter in `apps/web` with two implementations — luna-player's player component (exact pin, once luna-player ships it: a card in the luna-player project lifts it from luna-watch, target 0.2.0) and native `<video>` fallback used until then and whenever Luna fails to load. Streams `…/attachments/:id/content` with Range.
- **Project settings → Demo videos:** the switch; UI path globs; Telegram on/off; "Demo env" secrets editor (names visible, values write-only, replace/delete); DemoFlow status of the project's runner (version, ready, reason) with what to do when not ready; a hint when the repo has no `demoflow.config.json` (the first demo card's worker creates it).
- Add the screens to `docs/ui/screens.md`; screenshots light/dark and phone width.

Web tests for the adapter fallback, status rendering, secrets form never shows values.
