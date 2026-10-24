# C-383: Record demos of Nautelle itself: demoflow.config.json, a smoke scenario and UI paths

## Why
Demo videos (S-12, ADR-0090) are on for this project, but the repository has no `demoflow.config.json`. Until it has one, the runner skips every demo and says so on the card.

## What
1. Add `demoflow.config.json` at the root:
   - `baseUrl`: the web app (dev port 3517).
   - `devCommand` and `readyUrl`: start what the web app needs in a fresh card worktree — the API and the web app against the dev Postgres (:5421) and Redis (:6421). `apps/api/.env` is copied in by the orchestrator or the person.
   - `readyUrl`: the web app's page, once the API health check answers.
   - `allowedOrigins`: the web app and API origins.
   
   The runner passes `--base-url http://127.0.0.1:<port>` and `PORT=<port>`. Make the web dev server honour `PORT`, and pick the API port so it does not clash between cards: one card at a time until DemoFlow#337 lands.
2. Add `demoflow/smoke.demo.json`:
   - sign in with `valueFrom: { env: DEMO_LOGIN_EMAIL / DEMO_LOGIN_PASSWORD }`, which are set in Demo env and are the shared dev admin (`~/.config/agentdock/ux-screens.cred`; never commit them);
   - open the Board;
   - assert its heading.
   
   Run it locally with `npx demoflow@0.4.0 run demoflow/smoke.demo.json` and attach the MP4 to the PR.
3. Say in the PR whether the default UI paths (`apps/web/**`, `**/*.tsx`, `**/*.css`) are right for this repository. `packages/glass-ui` is not here; glass-ui comes from npm.
4. Add a short "Demo videos" section to the docs site's card guide: how a project turns them on, and what the config and a scenario look like.
