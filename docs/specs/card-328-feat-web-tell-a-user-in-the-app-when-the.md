# C-328: feat(web): tell a user in the app when their runner is older than the latest nautelle-runner release

The person asked: when a user's runner is older than the latest published `nautelle-runner` (https://www.npmjs.com/package/nautelle-runner), the web app tells them to update it. Companion of C-327 (the CLI's own update prompt); this card does not depend on it.

Today the runner's version is only shown as text on `/admin/runners` (apps/web/src/app/admin/runners/page.tsx), and `apps/web/src/lib/planner/runner-support.ts` gates single features as `outdated`. There is no "a newer release exists" signal.

## Behaviour
- The API learns the latest released runner version from the npm registry (`registry.npmjs.org`, through the existing outbound guard), cached (e.g. refreshed hourly, last good value kept on failure; no request per page view). A version counts as released only when the meta package **and** the platform packages report it — the meta package can be published minutes before the platform binaries.
- It compares that with the version each runner reports on connect, and exposes the result (current, latest, outdated: boolean) on the existing runner read the web app already uses. No new place the control plane reads a project's filesystem (ADR-0001).
- The web app shows a dismissible notice to a user whose own runner is outdated: `Your runner <hostname> is on 0.14.0 — 0.15.0 is out.` with the copyable update command (`npm i -g nautelle-runner@0.15.0`, then restart the service) and a link to the release notes / changelog. Dismissing hides it until the next version. Admins also see an "update available" marker per runner on `/admin/runners`.
- Offline runners are judged by their last reported version; a runner that never reported a version shows nothing.
- Only glass-ui components (ADR-0011); a missing one is added to glass-ui.

## Acceptance criteria
- API unit/e2e tests: version comparison (semver, prerelease ignored), cache refresh and failure fallback with the registry fetch injected — tests never hit the real registry.
- Web tests for the notice: shown when outdated, hidden when current or unknown, dismissal per version.
- Document the behaviour in docs/ (runner docs and the screens list).
