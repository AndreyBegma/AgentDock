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

**Status.** The repository was renamed on 2026-10-20 at 16:50. A step marked
**Done** says what was observed when it was checked; every other step is still
open, and most of those belong to the person.

> **Never re-create a repository named `AndreyBegma/AgentDock`.** GitHub
> redirects the old name — web links, `git clone`, `git push`, the API and the
> plugin marketplace source — only while no repository takes it. A new
> `AgentDock` repository, even an empty fork or a placeholder, kills every
> redirect at once, and the old links break for good. ADR-0072 rules out a
> fallback repository for this reason.

## Before you start

| # | Step | Owner | Check |
|---|---|---|---|
| 0.1 | C-297 is merged into `develop`, and a runner release with the new package names is out (or the person decided to rename the repository first and release later). | Orchestrator | **Done** — C-297 merged (#725) before the rename |
| 0.2 | No other card or pull request is open (ADR-0072 rule 1). | Orchestrator | **Done** — the board was cleared for the rename |
| 0.3 | No pipeline is running or queued on Woodpecker repository 9. | Orchestrator | `curl -s https://ci.luna-realm.com/api/repos/9/pipelines \| jq '[.[] \| select(.status=="running" or .status=="pending")] \| length'` prints `0` |
| 0.4 | Record the state the rename must keep: the Woodpecker repository, its secrets and crons, and the GitHub webhook. | Orchestrator | **Done** — recorded below |

```sh
curl -s https://ci.luna-realm.com/api/repos/9 | jq '{full_name, forge_remote_id, require_approval, trusted, timeout, cancel_previous_pipeline_events}'
gh api repos/AndreyBegma/AgentDock/hooks/696544399 --jq '{id, active, events, url: .config.url}'
# secrets and crons: the Woodpecker MCP (list_secrets, list_crons) or the repository's Settings page
```

On 2026-10-20 repository 9 had `forge_remote_id` `1409193522`,
`require_approval: "forks"`, trusted volumes on, a 60-minute timeout, three
secrets (`github_release_token`, `npm_token`, `runner_signing_key`) and no
crons. The old webhook was hook `696544399`; Repair (3.1) replaced it with
`700905813`.

## 1. GitHub repository

| # | Step | Owner | Check |
|---|---|---|---|
| 1.1 | *Settings → General → Repository name*: rename `AgentDock` to `Nautelle`. | Person | **Done** — `gh api repos/AndreyBegma/AgentDock --jq .full_name,.id` prints `AndreyBegma/Nautelle` and `1409193522`; `https://github.com/AndreyBegma/AgentDock` answers `301` to `…/Nautelle`, for the web and for git |
| 1.2 | The wiki moves with the repository (`AgentDock.wiki` → `Nautelle.wiki`). | Person | **Done** — `https://github.com/AndreyBegma/Nautelle/wiki` answers `200` |
| 1.3 | The tag ruleset for `runner-v*` (deploy/README.md, P-03) survived. | Person | `gh api repos/AndreyBegma/Nautelle/rulesets --jq '.[].name'` lists it. **Open**: on 2026-10-20 it listed only `Protect main and develop` — no `runner-v*` tag ruleset, so either it was never created or it lives elsewhere; the person decides whether to add it (deploy/README.md, P-03) |
| 1.4 | The webhook (hook id `696544399`) still points at Woodpecker and delivers. | Orchestrator | **Done** — Repair re-created the hook as `700905813`; `gh api repos/AndreyBegma/Nautelle/hooks/700905813/deliveries --jq '.[0] \| {event, status_code, delivered_at}'` showed a `pull_request` delivered with `202` at 14:49 UTC |
| 1.5 | The Nautelle GitHub App (spec 27) is still installed on the repository. The installation follows the repository id, not its name. | Person | *Settings → GitHub Apps* lists it; the project's GitHub health in the web app is green |

## 2. Git remotes on the devbox and in worktrees

The redirect keeps the old remote working, but every place that writes the URL
somewhere else (`gh` defaults, scripts, the runner's project inspection) should
see the new name.

| # | Step | Owner | Check |
|---|---|---|---|
| 2.1 | In the main checkout: `git remote set-url origin git@github.com:AndreyBegma/Nautelle.git` (or the HTTPS form if SSH is refused). | Person | **Done** — the main checkout's origin is `https://github.com/AndreyBegma/Nautelle.git` |
| 2.2 | Worktrees share the main checkout's `.git/config`, so 2.1 covers `.claude/worktrees/*`, the orchestrator slots `.wt-AgentDock-<slot>` and the board cards `.wt-AgentDock-card-<id>`. A separate clone (another machine, `/tmp`) needs its own `set-url`. | Person | **Done** — the card worktrees report `https://github.com/AndreyBegma/Nautelle.git` |
| 2.3 | Nothing to do: the project follows the rename by itself. GitHub App deliveries route by the repository id (`Project.githubRepoId`, spec 27 D7, `apps/api/src/github-app/github-hook.service.ts`), so the first delivery after the rename — the `repository` `renamed` event, or any pull request or push — stores `AndreyBegma/Nautelle` in `Project.repo` and audits `project.repo_rename`. The id is backfilled by the migration that added it (from the installation's repository list) or learnt from the first delivery matched by name; before step 1.1, check that `githubRepoId` is set on the project (a push or pull request event sets it). An App registered before the `repository` event was added must have *Repository* ticked under *App settings → Permissions & events → Subscribe to events* for the `renamed` event to arrive; without it the next other event still renames. Fallback, if the project page still shows `AndreyBegma/AgentDock` after the next event: after 2.1, *Project → Refresh* or `POST /api/projects/<id>/refresh` (`ProjectsService.refresh`) — refresh only after 2.1, since it stores whatever the origin remote names. | Person or orchestrator | **Done** — the board project shows repository `AndreyBegma/Nautelle` and display name Nautelle after a refresh. Generic check: the project page shows `AndreyBegma/Nautelle`; *Admin → Audit* has `project.repo_rename`; the next pull request event updates the board |
| 2.4 | The local directory `~/dev/AgentDock` and the `.wt-AgentDock-*` worktree names may stay. Renaming the directory changes every worktree path, the Claude Code project memory path and the runner's `rootPath`; do it only on purpose, as a separate step. | Person | — |

## 3. Woodpecker (ci.luna-realm.com, repository 9)

Woodpecker keys the repository by GitHub's id (`forge_remote_id`), so it keeps
the repository, its settings, secrets and crons. It needs a *Repair* to pick up
the new name and clone URL and to re-register the webhook.

| # | Step | Owner | Check |
|---|---|---|---|
| 3.1 | *Repository 9 → Settings → Repair* (or the API: `POST /api/repos/9/repair`, the Woodpecker MCP `repair_repository`). | Orchestrator | **Done** — `curl -s https://ci.luna-realm.com/api/repos/9 \| jq -r .full_name,.clone_url` prints `AndreyBegma/Nautelle` and `https://github.com/AndreyBegma/Nautelle.git` |
| 3.2 | Settings survived: `require_approval: "forks"`, trusted volumes, timeout 60, cancel previous on push and pull_request (deploy/README.md, *One-time setup*). | Orchestrator | **Done** — unchanged against the record from 0.4 |
| 3.3 | Secrets survived: `github_release_token`, `npm_token`, `runner_signing_key`, with their events. Update the notes that say "AgentDock". | Orchestrator | **Done** — all three listed, unchanged and tag-only. The "AgentDock" notes are still open |
| 3.4 | Crons survived. There were none on 2026-10-20; if one was added since, it must still be listed. | Orchestrator | `list_crons` (repository 9) matches 0.4 |
| 3.5 | The webhook delivers: if Repair created a new hook, the old id `696544399` may be gone — use the new id from then on. | Orchestrator | **Done** — the new hook is `700905813` and delivers (see 1.4). Generic check: push to a branch and open a pull request: a pipeline starts within a minute |
| 3.6 | A push to `develop` builds and deploys staging (`.woodpecker/pipeline.yml`). | Orchestrator | the pipeline is green; `/home/archi/stacks/agentdock-staging/status.sh` shows the new commit |

Note for 3.3: deploy/README.md says the release secrets are for the **tag**
event only. Before the rename `github_release_token` and `npm_token` also
allowed `manual`; after Repair the orchestrator saw all three secrets as
tag-only, which matches deploy/README.md.

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
| 6.2 | Staging compose project `agentdock-staging` (`deploy/staging/docker-compose.yml`: `name:`, `container_name: agentdock-staging-*`, images `agentdock-api:staging` / `agentdock-web:staging`), the stack directory `/home/archi/stacks/agentdock-staging`, and the scripts that name them (`deploy/staging/*.sh`, `.woodpecker/pipeline.yml`, deploy/README.md). **Volume names are pinned** with `name:` in the compose file (`agentdock-staging_pgdata`, `_redis`, `_attachments` — the names Docker gave them under the old project), so renaming the project to `nautelle-staging` keeps the same volumes and the same data. Leave those `name:` values alone. Compose warns once that each volume "was created for project agentdock-staging"; that warning is expected. | Orchestrator (pull request) and Person (host) | after the deploy, `docker ps --format '{{.Names}}' \| grep staging` shows the new names, `docker volume ls \| grep agentdock-staging_` still lists the three volumes, `docker inspect -f '{{range .Mounts}}{{.Name}} {{end}}' <new postgres container>` shows `agentdock-staging_pgdata`, and the staging board still has its cards |
| 6.3 | The CI image `agentdock-ci:node-bun` (`deploy/ci-image/Dockerfile`, both pipeline files). A push must build the new tag before a pull request can use it (deploy/README.md, *Trust levels*). | Orchestrator | a pull request after the push runs on the new image |
| 6.4 | Local development: `docker/docker-compose.yml` (`name: agentdock`, `agentdock-postgres`, `agentdock-redis`) and `scripts/db-start-docker.sh`. Its volumes are pinned the same way (`agentdock_postgres_data`, `agentdock_redis_data`), so renaming the project keeps every developer's local database; leave those `name:` values alone. Database names (`agentdock`, `agentdock_test`, `agentdock_<slot>_test`) are not part of this card. | Orchestrator (pull request) | `bun run db:setup` on a fresh machine works; on an existing one the data is still there |
| 6.5 | The landing site: separate repository `agentdock-landing`, Cloudflare tunnel `agentdock-landing`. Its primary domain is now `nautelle.luna-realm.com`, and `agentdock.luna-realm.com` redirects to it with path and query (Cloudflare, by the person). The links in this repository point at the new domain (step 8). Renaming the landing repository and the tunnel is still open. | Person | **Done** for the domain — `curl -sI https://nautelle.luna-realm.com/` answers `200`; `curl -sI 'https://agentdock.luna-realm.com/x?y=1'` answers `301` to `https://nautelle.luna-realm.com/x?y=1` |

## 7. Staging domain — deferred

The person decided on 2026-10-20 to keep `staging-agentdock.luna-realm.com` for
now (the landing domain moved, see 6.5). When a Nautelle host is chosen, all of the
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
| 8.1 | Replace `github.com/AndreyBegma/AgentDock` and `AndreyBegma/AgentDock` with `…/Nautelle` everywhere: README.md, the docs (specs and release notes included — their links redirect, but the current name reads better), the npm `repository` fields (`apps/runner/npm/package.json`, `platform-package.template.json`, `legacy/package.json`), the Homebrew template's download URLs, the npm shim's messages, `MARKETPLACE_SOURCE` and the marketplace and plugin manifests, the web app's install link, `.woodpecker/release-runner.yml` (`--repo` and the release notes link), the release skill, and the tests that pin them. The landing links move with it to `nautelle.luna-realm.com` (README badge, `PRODUCT_SITE_URL`, npm and Homebrew `homepage`). Kept on purpose: ADRs (historical text, ADR-0072 decision 2), recorded corpora under `apps/runner/src/filter/**/corpus/` (byte-exact), `scripts/fixtures/*-before-c105.yml` (a snapshot of an old pipeline), the GitHub App routing tests that use the old name as sample data or as the name before a rename (`apps/api/src/github-app/`), the `check-brand` allow-list test, this guide and the C-298 spec, which talk about the old name. | Orchestrator | **Done** — `git grep -n 'AndreyBegma/AgentDock' -- ':!docs/adr' ':!**/corpus/**' ':!scripts/fixtures' ':!apps/api/src/github-app' ':!scripts/check-brand.test.ts' ':!docs/guides/rename-to-nautelle.md' ':!docs/specs/card-298-*'` prints nothing; `bun run check`, typecheck and the affected tests pass |
| 8.2 | Add "formerly AgentDock" to README.md, under the title. | Orchestrator | **Done** — `grep -n 'formerly AgentDock' README.md` |
| 8.3 | Plugin marketplace: Claude Code profiles that added the marketplace as `AndreyBegma/AgentDock` keep working through the redirect; new installs use the new source from 8.1. | Orchestrator | `claude plugin marketplace update` succeeds in a profile set up before the rename |
| 8.4 | The relative links still resolve. | Orchestrator | `bun scripts/check-readme-links.ts README.md docs/README.md` exits 0 |

## Rollback and notes

- **Renaming the repository back** (`Nautelle` → `AgentDock`) is the only
  rollback for step 1, and it works while no other repository took either
  name. Then repeat 3.1 (Repair) and check 2.3 (the project follows the rename back on its own; refresh only as a fallback). Remotes set to
  `Nautelle.git` keep working through the reverse redirect.
- **Never** create `AndreyBegma/AgentDock` as a new repository — not as a
  mirror, a fork, a placeholder or a test. It ends the redirect for every old
  link, clone, plugin source and npm `repository` field already published.
- Woodpecker after Repair: if pipelines stop starting, look at *GitHub →
  Settings → Webhooks → Recent Deliveries* first (deploy/README.md, *A pull
  request with no pipeline*). A second hook left behind by Repair delivers
  twice; delete the one whose URL Woodpecker no longer serves.
- Staging volumes: the compose files pin the volume names, so a new compose
  project name reuses them. Never `docker compose down -v` around the rename,
  and never change a volume's `name:` without copying its data first. After
  the first `up` under the new name, `docker volume ls` must show the same
  `agentdock-staging_*` volumes in use and no new `nautelle-staging_*` ones.
- npm names cannot be taken back once published and deprecated packages stay
  installable; deprecation is the rollback-safe choice, `npm unpublish` is
  not.
- Published runner releases keep their URLs: GitHub redirects
  `…/AgentDock/releases/download/…`, so formulas and shims already installed
  keep verifying and downloading.
- The environment variables, headers and the pull request marker are C-297's
  compatibility window, not this card's. Close that window only after every
  runner in use is on a release with the new names.
