# Renaming the repository and infrastructure to Nautelle

This is the ordered checklist for C-298, the last of the four rename cards of
[ADR-0072](../adr/0072-the-product-is-renamed-nautelle-in-four-steps.md):

1. C-295 — brand (merged);
2. C-296 — workspace packages `@nautelle/*` (merged);
3. C-297 — runner, protocol, environment variables and plugin, with a
   compatibility window;
4. **C-298 — the GitHub repository and the infrastructure (this guide).**

Each step names an **owner** and a **check**. *Person* is the repository owner:
the step needs an account, a dashboard or a host only they have. *Orchestrator*
is the fleet: a card worker or the orchestrating session, working through a pull
request or the Woodpecker and GitHub APIs it already has.

> **Never re-create a repository named `AndreyBegma/AgentDock`.** GitHub
> redirects the old name — web links, `git clone`, `git push`, the API and the
> plugin marketplace source — only while no repository takes it. A new
> `AgentDock` repository, even an empty fork or a placeholder, kills every
> redirect at once, and the old links break for good. ADR-0072 rules out a
> fallback repository for this reason.

## Before you start

| # | Step | Owner | Check |
|---|---|---|---|
| 0.1 | C-297 is merged into `develop`, and a runner release with the new package names is out (or the person decided to rename the repository first and release later). | Orchestrator | `gh pr list --state open --search "C-297"` is empty |
| 0.2 | No other card or pull request is open (ADR-0072 rule 1). | Orchestrator | `gh pr list --state open` is empty, or only this card's |
| 0.3 | No pipeline is running or queued on Woodpecker repository 9. | Orchestrator | `curl -s https://ci.luna-realm.com/api/repos/9/pipelines \| jq '[.[] \| select(.status=="running" or .status=="pending")] \| length'` prints `0` |
| 0.4 | Record the state the rename must keep: the Woodpecker repository, its secrets and crons, and the GitHub webhook. | Orchestrator | the output of the three commands below is saved in the card |

```sh
curl -s https://ci.luna-realm.com/api/repos/9 | jq '{full_name, forge_remote_id, require_approval, trusted, timeout, cancel_previous_pipeline_events}'
gh api repos/AndreyBegma/AgentDock/hooks/696544399 --jq '{id, active, events, url: .config.url}'
# secrets and crons: the Woodpecker MCP (list_secrets, list_crons) or the repository's Settings page
```

On 2026-10-20 repository 9 had `forge_remote_id` `1409193522`,
`require_approval: "forks"`, trusted volumes on, a 60-minute timeout, three
secrets (`github_release_token`, `npm_token`, `runner_signing_key`) and no
crons.

## 1. GitHub repository

| # | Step | Owner | Check |
|---|---|---|---|
| 1.1 | *Settings → General → Repository name*: rename `AgentDock` to `Nautelle`. | Person | `gh api repos/AndreyBegma/AgentDock --jq .full_name` prints `AndreyBegma/Nautelle` (the redirect answers) |
| 1.2 | The wiki moves with the repository (`AgentDock.wiki` → `Nautelle.wiki`). | Person | `https://github.com/AndreyBegma/Nautelle/wiki` opens |
| 1.3 | The tag ruleset for `runner-v*` (deploy/README.md, P-03) survived. | Person | `gh api repos/AndreyBegma/Nautelle/rulesets --jq '.[].name'` lists it |
| 1.4 | The webhook (hook id `696544399`) still points at Woodpecker and delivers. | Orchestrator | `gh api repos/AndreyBegma/Nautelle/hooks/696544399/deliveries --jq '.[0] \| {event, status_code, delivered_at}'` shows a `2xx` after the next push |
| 1.5 | The Nautelle GitHub App (spec 27) is still installed on the repository. The installation follows the repository id, not its name. | Person | *Settings → GitHub Apps* lists it; the project's GitHub health in the web app is green |

## 2. Git remotes on the devbox and in worktrees

The redirect keeps the old remote working, but every place that writes the URL
somewhere else (`gh` defaults, scripts, the runner's project inspection) should
see the new name.

| # | Step | Owner | Check |
|---|---|---|---|
| 2.1 | In the main checkout: `git remote set-url origin git@github.com:AndreyBegma/Nautelle.git` (or the HTTPS form if SSH is refused). | Person | `git remote get-url origin` ends in `Nautelle.git`; `git fetch origin` succeeds |
| 2.2 | Worktrees share the main checkout's `.git/config`, so 2.1 covers `.claude/worktrees/*`, the orchestrator slots `.wt-AgentDock-<slot>` and the board cards `.wt-AgentDock-card-<id>`. A separate clone (another machine, `/tmp`) needs its own `set-url`. | Person | `git -C <worktree> remote get-url origin` ends in `Nautelle.git` |
| 2.3 | Refresh the project in Nautelle so the stored `Project.repo` becomes `AndreyBegma/Nautelle`. GitHub App webhooks are routed by `repository.full_name` (`apps/api/src/github-app/github-routing.ts`); until the project is refreshed, events for the renamed repository match no project. Use *Project → Refresh* or `POST /api/projects/<id>/refresh` (`ProjectsService.refresh`). | Person or orchestrator | the project page shows `AndreyBegma/Nautelle`; the next pull request event updates the board |
| 2.4 | The local directory `~/dev/AgentDock` and the `.wt-AgentDock-*` worktree names may stay. Renaming the directory changes every worktree path, the Claude Code project memory path and the runner's `rootPath`; do it only on purpose, as a separate step. | Person | — |

## 3. Woodpecker (ci.luna-realm.com, repository 9)

Woodpecker keys the repository by GitHub's id (`forge_remote_id`), so it keeps
the repository, its settings, secrets and crons. It needs a *Repair* to pick up
the new name and clone URL and to re-register the webhook.

| # | Step | Owner | Check |
|---|---|---|---|
| 3.1 | *Repository 9 → Settings → Repair* (or the API: `POST /api/repos/9/repair`, the Woodpecker MCP `repair_repository`). | Orchestrator | `curl -s https://ci.luna-realm.com/api/repos/9 \| jq -r .full_name,.clone_url` prints `AndreyBegma/Nautelle` and `https://github.com/AndreyBegma/Nautelle.git` |
| 3.2 | Settings survived: `require_approval: "forks"`, trusted volumes, timeout 60, cancel previous on push and pull_request (deploy/README.md, *One-time setup*). | Orchestrator | compare with the record from 0.4 |
| 3.3 | Secrets survived: `github_release_token`, `npm_token`, `runner_signing_key`, with their events. Update the notes that say "AgentDock". | Orchestrator | `list_secrets` (repository 9) shows all three |
| 3.4 | Crons survived. There were none on 2026-10-20; if one was added since, it must still be listed. | Orchestrator | `list_crons` (repository 9) matches 0.4 |
| 3.5 | The webhook delivers: if Repair created a new hook, the old id `696544399` may be gone — use the new id from then on. | Orchestrator | push to a branch and open a pull request: a pipeline starts within a minute |
| 3.6 | A push to `develop` builds and deploys staging (`.woodpecker/pipeline.yml`). | Orchestrator | the pipeline is green; `/home/archi/stacks/agentdock-staging/status.sh` shows the new commit |

Note for 3.3: deploy/README.md says the release secrets are for the **tag**
event only, but on 2026-10-20 `github_release_token` and `npm_token` also allow
`manual`. Fix that while you are here (Person, in the Woodpecker UI), or record
why it is needed.

## 4. npm and the Homebrew tap

C-297 introduces `nautelle-runner` and its platform packages
`nautelle-runner-{darwin,linux}-{arm64,x64}`; `agentdock-runner` becomes a
deprecated shim. The release workflow is `.woodpecker/release-runner.yml`; the
package sources are `apps/runner/npm/package.json`,
`apps/runner/npm/platform-package.template.json` and
`apps/runner/homebrew/agentdock-runner.rb.template`.

| # | Step | Owner | Check |
|---|---|---|---|
| 4.1 | The CI `npm_token` can publish the new names. An npm *granular* token is limited to the packages it lists: widen it to `nautelle-runner*` (or create a new one) and update the Woodpecker secret `npm_token`. An *automation* token of the owning account needs no change. | Person | a release dry run with the real token (`RUNNER_RELEASE_DRY_RUN=1`, deploy/README.md) passes; after the release, `npm view nautelle-runner@<version> optionalDependencies` names the four platform packages |
| 4.2 | Deprecate the old packages once the shim is published: `npm deprecate agentdock-runner "renamed to nautelle-runner"`, and the same for the four platform packages. | Person | `npm view agentdock-runner deprecated` prints the message |
| 4.3 | `github_release_token` can still write to the renamed repository and to `AndreyBegma/homebrew-tap`. A fine-grained token follows the repository id, a classic token the account; both survive a rename. | Orchestrator | the `github-release` and `homebrew-tap` steps of the next `runner-v*` tag pass |
| 4.4 | The tap gets `Formula/nautelle-runner.rb` from the release, and `Formula/agentdock-runner.rb` stays as the shim or gets a `deprecate!`. Add `tap_migrations.json` only if the tap itself is renamed (it is not part of this card). | Orchestrator | `brew update && brew install andreybegma/tap/nautelle-runner && nautelle-runner version` |
| 4.5 | The release's GitHub Release and the formula's download URLs use `AndreyBegma/Nautelle` (step 8 changes them; the redirect serves the old ones meanwhile). | Orchestrator | `brew fetch --force andreybegma/tap/nautelle-runner` succeeds |

## 5. Telegram bot

| # | Step | Owner | Check |
|---|---|---|---|
| 5.1 | Rename the bot and its descriptions in @BotFather (`/setname`, `/setdescription`, `/setabouttext`), or with the Bot API `setMyName`, `setMyDescription`, `setMyShortDescription`. The username (`@…bot`) cannot be renamed; a new username means a new bot and a new token, which this card does not do. | Person | `curl -s "https://api.telegram.org/bot$TOKEN/getMyName"` prints `Nautelle`; the chat header shows the new name |

## 6. GlitchTip, containers and compose projects

| # | Step | Owner | Check |
|---|---|---|---|
| 6.1 | GlitchTip: rename the product's project if one exists. On 2026-10-20 the `luna` organization had no AgentDock project, so there may be nothing to do. | Person | GlitchTip *Projects* shows no `agentdock` project |
| 6.2 | Staging compose project `agentdock-staging` (`deploy/staging/docker-compose.yml`: `name:`, `container_name: agentdock-staging-*`, images `agentdock-api:staging` / `agentdock-web:staging`), the stack directory `/home/archi/stacks/agentdock-staging`, and the scripts that name them (`deploy/staging/*.sh`, `.woodpecker/pipeline.yml`, deploy/README.md). **Docker prefixes volumes with the compose project name**: renaming the project to `nautelle-staging` starts an empty database. Copy `agentdock-staging_pgdata`, `_redis` and `_attachments` into the new volumes first, or pin the old volume names with `name:` in the compose file. | Orchestrator (pull request) and Person (host) | after the deploy, `docker ps --format '{{.Names}}' \| grep staging` shows the new names and the staging board still has its cards |
| 6.3 | The CI image `agentdock-ci:node-bun` (`deploy/ci-image/Dockerfile`, both pipeline files). A push must build the new tag before a pull request can use it (deploy/README.md, *Trust levels*). | Orchestrator | a pull request after the push runs on the new image |
| 6.4 | Local development: `docker/docker-compose.yml` (`name: agentdock`, `agentdock-postgres`, `agentdock-redis`) and `scripts/db-start-docker.sh`. The same volume warning applies: `agentdock_postgres_data` holds every developer's local database. Database names (`agentdock`, `agentdock_test`, `agentdock_<slot>_test`) are not part of this card. | Orchestrator (pull request) | `bun run db:setup` on a fresh machine works; on an existing one the data is still there |
| 6.5 | The landing site: separate repository `agentdock-landing`, Cloudflare tunnel `agentdock-landing`, domain `agentdock.luna-realm.com`. The domain stays for now. Rename the repository and the tunnel only together with the domain (step 7). | Person | `curl -sI https://agentdock.luna-realm.com/` answers `200` |

## 7. Staging domain — deferred

The person decided on 2026-10-20 to keep `staging-agentdock.luna-realm.com` and
`agentdock.luna-realm.com` for now. When a Nautelle host is chosen, all of the
following change together, and the old host redirects to the new one:

| What | Where |
|---|---|
| Cloudflare tunnel public hostname | Zero Trust → Networks → Tunnels → `agentdock-staging` (deploy/README.md, *One-time setup* step 1; `deploy/staging/env/cloudflared.env.example`) |
| Redirect from the old host | a Cloudflare redirect rule, old host → new host, keeping the path |
| Cloudflare Access applications and the `/api/hooks/*` bypass | deploy/README.md, *Access layer and the runner* |
| `WEB_URL` (also the CORS origin), `APP_URL`, `API_URL`, `PUBLIC_URL` | `/home/archi/stacks/agentdock-staging/env/api.env` and `deploy/staging/env/api.env.example` |
| Health checks and the deployed host | `deploy/staging/status.sh`, `deploy/staging/build-staging.sh` (`HOST=`), `.woodpecker/pipeline.yml` comment |
| Runner server URL | each runner's `runner.json` — re-pair with `pair --server https://<new host>/api` |
| Claude Code hooks' endpoint | written by the runner's setup into each profile; rerun setup after re-pairing |
| GitHub App URLs | the App's *Homepage*, *Callback* (`/admin/github-app/callback`) and *Webhook* URLs in its GitHub settings |
| Telegram Mini App URL | BotFather, and `WEB_URL` (`apps/api/.env.example` explains it) |
| Docs | deploy/README.md, `docs/README.md`, README.md badges, `homepage` in the npm and Homebrew packages |

Check, when it happens: the old host answers `301` to the new one, a runner
reconnects, a Claude Code hook reaches `/api/hooks/*`, and a GitHub App event
reaches the API.

## 8. Replace the repository URLs in the repository

Only after step 1. One pull request into `develop`, and after C-297 has merged
(several of these files are in its area).

| # | Step | Owner | Check |
|---|---|---|---|
| 8.1 | Replace `github.com/AndreyBegma/AgentDock` and `AndreyBegma/AgentDock` with `…/Nautelle`. The places on 2026-10-20: `README.md`, `docs/README.md`, `docs/architecture/{data-model,runner-protocol}.md`, `docs/product/roadmap.md`, `docs/guides/{context-handoff,steward,token-saver}.md`, `deploy/README.md`, `.claude-plugin/marketplace.json`, `plugins/agentdock/.claude-plugin/plugin.json`, `apps/runner/npm/package.json`, `apps/runner/npm/platform-package.template.json`, `apps/runner/npm/bin/agentdock-runner.js`, `apps/runner/npm/README.md`, `apps/runner/README.md`, `apps/runner/homebrew/agentdock-runner.rb.template`, `apps/runner/src/setup/claude.ts` (`MARKETPLACE_SOURCE`), `apps/web/src/lib/runners/install.ts`, `.woodpecker/release-runner.yml` (`--repo`), `.claude/skills/release/SKILL.md`, and the tests and fixtures that pin them (`apps/runner/scripts/render-formula.spec.ts`, `scripts/check-brand.test.ts`, `scripts/fixtures/release-runner-before-c105.yml`, the `*.e2e.spec.ts` and `*.spec.ts` that use the name as sample data). Leave alone: ADRs, `docs/specs/`, `docs/releases/` and recorded corpora under `apps/runner/src/filter/**/corpus/` (ADR-0072 decision 2). | Orchestrator | `git grep -n 'AndreyBegma/AgentDock' -- ':!docs/adr' ':!docs/specs' ':!docs/releases' ':!**/corpus/**'` prints nothing; `bun run check` and `bun run test` pass |
| 8.2 | Add "formerly AgentDock" to README.md, under the title. | Orchestrator | `grep -n 'formerly AgentDock' README.md` |
| 8.3 | Plugin marketplace: Claude Code profiles that added the marketplace as `AndreyBegma/AgentDock` keep working through the redirect; new installs use the new source from 8.1. | Orchestrator | `claude plugin marketplace update` succeeds in a profile set up before the rename |
| 8.4 | The relative links still resolve. | Orchestrator | `bun scripts/check-readme-links.ts README.md docs/README.md` exits 0 |

## Rollback and notes

- **Renaming the repository back** (`Nautelle` → `AgentDock`) is the only
  rollback for step 1, and it works while no other repository took either
  name. Then repeat 3.1 (Repair) and 2.3 (refresh the project). Remotes set to
  `Nautelle.git` keep working through the reverse redirect.
- **Never** create `AndreyBegma/AgentDock` as a new repository — not as a
  mirror, a fork, a placeholder or a test. It ends the redirect for every old
  link, clone, plugin source and npm `repository` field already published.
- Woodpecker after Repair: if pipelines stop starting, look at *GitHub →
  Settings → Webhooks → Recent Deliveries* first (deploy/README.md, *A pull
  request with no pipeline*). A second hook left behind by Repair delivers
  twice; delete the one whose URL Woodpecker no longer serves.
- Staging volumes: never `docker compose down -v` while moving to a new
  compose project name. `down.sh` keeps the volumes; keep it that way until
  the copy is checked.
- npm names cannot be taken back once published and deprecated packages stay
  installable; deprecation is the rollback-safe choice, `npm unpublish` is
  not.
- Published runner releases keep their URLs: GitHub redirects
  `…/AgentDock/releases/download/…`, so formulas and shims already installed
  keep verifying and downloading.
- The environment variables, headers and the pull request marker are C-297's
  compatibility window, not this card's. Close that window only after every
  runner in use is on a release with the new names.
