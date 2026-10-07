# GitHub App — issue, PR and check events

Issue: [#27](https://github.com/AndreyBegma/AgentDock/issues/27) · Roadmap: M3.4 ·
Decisions: [ADR-0004](../adr/0004-github-issues-are-the-task-queue.md),
[ADR-0007](../adr/0007-postgresql-only.md),
[ADR-0010](../adr/0010-typed-command-allowlist-on-the-runner.md),
[security.md](../architecture/security.md), [event-schema.md](../architecture/event-schema.md)

## Summary

Today every project's issues and pull requests are polled by its runner every
60 s (#11 D3, #19 D1): slow to notice, and one `gh` call per project per minute
forever. A GitHub App pushes the same facts the moment they happen. This item
registers one read-only App for the AgentDock instance, maps its installations
to projects by repository, verifies `POST /hooks/github`, and turns each
relevant delivery into an immediate **poll-now** on the project's runner — the
existing collectors fetch and emit exactly as before, so #11's and #19's
projections stay the only writers of fleet and queue state. While the App is
healthy for a project, the runner relaxes those collectors to 10 minutes. When
GitHub cannot reach the server (home network behind NAT), nothing breaks:
polling stays at 60 s. All actions still go through the runner's `gh`
(ADR-0004); the App only reads.

## Scope

### In scope

- App registration from the admin UI through GitHub's manifest flow, with a manual-entry fallback.
- Encrypted storage of the App private key and webhook secret.
- Installations and their repositories, mapped to projects by `owner/repo`.
- `POST /hooks/github`: `X-Hub-Signature-256` verification, delivery dedupe by `X-GitHub-Delivery`.
- Event handling: `issues`, `pull_request`, `pull_request_review`, `check_suite`, `check_run`, `status`, `push` (base branch only), `installation`, `installation_repositories`, `ping`.
- Runner command `collector.poll` and the App-health flag in the runner's watch list; the `issues` and `prs` collectors honour it.
- Raw GitHub events stored as `events` rows with `source: github` (for #21's activity and #26's outbound catalogue).
- Admin page and a per-project App status chip.

### Out of scope

- Writing to GitHub through the App (comments, labels, merges). Actions stay on the runner's `gh` (ADR-0004).
- Logging in with GitHub (OAuth) — rejected in ADR-0008.
- `issue_comment` events — the queue does not read comments (#19). Can be added to the handler list later.
- GitLab and other forges (ADR-0004).
- Several Apps per instance.

## Decisions

The person delegated all decisions on 2026-10-07. Each row is the default taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | **Registration: manifest flow first, manual entry as fallback.** The admin clicks *Create GitHub App*. The API builds a manifest (name `AgentDock <host>`, read-only permissions D2, events D2, `hook_attributes.url = <PUBLIC_URL>/hooks/github`, `redirect_url = <APP_URL>/admin/integrations/github/callback`) and the browser posts it to `https://github.com/settings/apps/new` (or the organization variant). GitHub redirects the **browser** back with a `code`; the API exchanges it with `POST https://api.github.com/app-manifests/<code>/conversions` (outbound only) and receives app id, slug, private key, webhook secret and client secret. Only the browser must reach AgentDock, so this works on a home server. Manual entry (app id, slug, private key PEM, webhook secret) covers an App created by hand. | GitHub manifest flow docs [Confirmed — endpoint name to be re-checked by i27-api]; first deployment behind NAT (PRD Constraints) |
| D2 | **Permissions, all read-only:** Metadata, Issues, Pull requests, Checks, Commit statuses, Contents (needed for `push` events). **Events:** `issues`, `pull_request`, `pull_request_review`, `check_suite`, `check_run`, `status`, `push`. `installation*` and `ping` arrive without subscribing. | ADR-0004 |
| D3 | **Secrets.** Private key, webhook secret and client secret are stored as AES-256-GCM ciphertext through #22's helper (`apps/api/src/common/crypto/**`). Without `APP_ENCRYPTION_KEY` registration returns 409 `encryption_key_missing`. The client secret is stored but unused (no OAuth). | #22 D8; security.md |
| D4 | **Server-side GitHub API use is limited to reading App metadata:** the App JWT (RS256, signed with `node:crypto`, no new dependency, 9-minute lifetime) and installation tokens are used only for `GET /app`, `GET /app/installations`, `GET /installation/repositories` and `GET /app/hook/deliveries` (D11). Nothing is written. Issue and PR data still comes from the runner's `gh` through the collectors. | ADR-0004 |
| D5 | **Shared hook infrastructure, separate verification.** `/hooks/github` reuses #26's raw-body capture (`rawBody: true` in `main.ts`) and its public-route conventions, but not its signature scheme or tables: GitHub signs with `X-Hub-Signature-256: sha256=HMAC-SHA256(webhook secret, raw body)` and identifies deliveries with `X-GitHub-Delivery`. Hence `Depends on #26` (for `main.ts`) and an own `github_deliveries` dedupe table. | #26 D8 |
| D6 | **Verification.** `timingSafeEqual` on the hex digest; missing or wrong signature → 401 with no body, nothing stored beyond a counter. A `X-GitHub-Delivery` already stored → 200 `duplicate` (GitHub redelivers on its own; answering 409 would mark it failed). Body limit 25 MB is GitHub's; AgentDock accepts up to 5 MB and answers 413 beyond. The handler answers within 2 s: verification, dedupe insert and enqueue only; work happens after the response. | GitHub webhook docs (10 s timeout) |
| D7 | **Mapping to projects.** A delivery's `repository.full_name` is matched case-insensitively to `projects.repo` (#10). One repo may map to several projects (same repo on two runners, #10 D14); each gets the poll. A repo with no project is counted and ignored. | #10 D14 |
| D8 | **Event → action.**<br>• `issues` (opened, edited, closed, reopened, labeled, unlabeled, assigned, unassigned) → `collector.poll { collectors: ["issues"] }`;<br>• `pull_request` (opened, synchronize, closed, reopened, ready_for_review, edited, labeled, unlabeled), `pull_request_review` (submitted, dismissed), `check_suite`, `check_run`, `status` → `collector.poll { collectors: ["prs"] }`;<br>• `push` to the project's base branch → `collector.poll { collectors: ["prs", "worktrees"] }` (ahead/behind of slots changes);<br>• `installation`, `installation_repositories` → resync installations (D10);<br>• `ping` → health only.<br>Polls are debounced per project and collector: at most one per 5 s, the last one wins. | #11 D3; #19 D1 |
| D9 | **Raw events for the record.** Every handled delivery also writes one `events` row (`source: github`, `runnerId` null — through a narrow API-side insert helper, not #6's gateway) with `type` from event-schema.md's GitHub list (`issue.labeled`, `issue.closed`, `pr.opened`, `pr.checks_changed`, `pr.closed`) and a small `data` (number, action, sender login, state). Projections do **not** read these rows; they exist for activity (#21) and outbound webhooks (#26). Payload bodies are not stored. | event-schema.md; #21 D2; #26 D11 |
| D10 | **Installations.** On registration, on `installation*` events, and on a manual *Resync*, the API lists installations and their repositories (D4) into `github_installations` / `github_installation_repos`. A project shows *covered* when its repo is in an active installation. | new |
| D11 | **Health per project:** `healthy` when (a) its repo is covered (D10), (b) a verified delivery for any repo of that installation arrived within the last 60 minutes **or** the installation was resynced within the last 60 minutes with a successful `ping`-style check (`GET /app/hook/deliveries?per_page=1` shows a 2xx `status_code` on the latest delivery), and (c) no signature failure since the last success. Otherwise `unhealthy`. Health is recomputed every 5 minutes. | new |
| D12 | **Polling back-off.** The API adds `githubApp: "healthy" \| "unhealthy"` per project to the runner's watch list (`welcome` and updates, #10). The `issues` and `prs` collectors poll every **10 minutes** while `healthy` and every 60 s otherwise; `collector.poll` makes them poll immediately in either state. When health flips to `unhealthy`, the runner returns to 60 s on the next tick — the fallback is automatic. | #11 D3; #19 D1 |
| D13 | **`collector.poll`** is a new runner command `{ projectId, collectors: ("issues" \| "prs" \| "worktrees")[] }`, minimum role `admin` in the allowlist (#5's role union has no `system` value and is not changed here); it is sent only by the API's GitHub module as the system actor, and no user-facing route exposes it. The runner restarts the named collectors for that project through #10's registry (`stop()` then `start()` — each collector polls on start), which needs no change to the `Collector` interface. | #10 D16; ADR-0010 |
| D14 | **Reachability.** GitHub must reach `<PUBLIC_URL>/hooks/github` over HTTPS. Documented options, in `docs/architecture/github-app.md` written by this item: a reverse proxy with a public TLS endpoint; Tailscale Funnel; Cloudflare Tunnel. Without `PUBLIC_URL`, the manifest sets the hook **inactive**, the admin page explains it, and every project stays `unhealthy` (60 s polling). | PRD Constraints |
| D15 | **Who manages.** Admin only: register, re-enter credentials, resync, delete the App registration. Project members (viewer+) see their project's App status (covered / healthy / unhealthy and why) on the project settings page. Non-member → 404 (#10 D12). | ADR-0008; #10 D12 |
| D16 | **Audit.** New actions in #8's union: `github_app.register`, `github_app.update_credentials`, `github_app.resync`, `github_app.delete`. Deliveries are not audited; signature failures increment a counter and are visible on the admin page. | #8 D5 |
| D17 | **Retention.** `github_deliveries` older than 14 days are deleted daily (`@nestjs/schedule`, listed by #25). | #25 D13 |

## Data / Schema

Migration directory: `apps/api/prisma/migrations/20261102000000_github_app/`. New tables only.

| Table | Fields |
|---|---|
| `github_app` | `id` (single row `"app"`), `appId` Int, `slug`, `ownerLogin`, `privateKey` (ciphertext), `webhookSecret` (ciphertext), `clientSecret?` (ciphertext), `hookActive` Bool, `signatureFailures` Int default 0, `lastDeliveryAt?`, `registeredById` → users, `createdAt`, `updatedAt` |
| `github_installations` | `id` Int (GitHub installation id) PK, `accountLogin`, `accountType`, `suspended` Bool, `syncedAt`, `createdAt` |
| `github_installation_repos` | `installationId` → github_installations (cascade delete), `fullName` (lower-cased), `repoId` Int; PK `(installationId, repoId)`; index `(fullName)` |
| `github_deliveries` | `deliveryId` PK, `event`, `action?`, `fullName?`, `installationId?` Int, `receivedAt`, `handled` Bool, `projectsMatched` Int |
| `github_project_health` | `projectId` PK → projects (cascade delete), `covered` Bool, `state` (`healthy` \| `unhealthy`), `reason?`, `checkedAt` |

## Protocol

New file `packages/shared/src/protocol/commands/github.ts`, one registration line
in `commands.ts`, one export line in `index.ts`:

| Command | Args | Min role | Result |
|---|---|---|---|
| `collector.poll` | `{ projectId, collectors: ("issues" \| "prs" \| "worktrees")[] }` | admin (API-only, D13) | `{ restarted: string[] }` |

The watch-list project entry (#10) gains an optional `githubApp: "healthy" \| "unhealthy"`
field (absent = `unhealthy`), added in `packages/shared/src/protocol/projects.ts`
as an optional key.

## API

| Method | Path | Who | Behaviour |
|---|---|---|---|
| POST | `/hooks/github` | public, signed | D5–D9 → 200 / 401 / 413 |
| GET | `/admin/github-app` | admin | registration, hook state, counters, installations with repos and matched projects |
| POST | `/admin/github-app/manifest` | admin | `{ owner?: org login }` → `{ postUrl, manifest, state }` for the browser form |
| GET | `/admin/github-app/callback?code=&state=` | admin (session) | D1 code exchange; redirects to the admin page |
| PUT | `/admin/github-app` | admin | manual credentials (D1 fallback) |
| POST | `/admin/github-app/resync` | admin | D10 |
| DELETE | `/admin/github-app` | admin | removes the registration and installations from AgentDock (the App on GitHub is left; the page links to it) |
| GET | `/projects/:projectId/github-app` | viewer | `{ covered, state, reason, checkedAt }` |

## UI

- **`/admin/integrations/github`** — empty state with *Create GitHub App* (user or organization owner) and *Enter credentials manually*; after registration: app slug and link, hook active/inactive with the D14 explanation, last delivery, signature failure count, *Install on repositories* (link to `https://github.com/apps/<slug>/installations/new`), installations table with repos and the project each maps to, *Resync*, *Delete*.
- **Project settings** (#10's page) — a *GitHub App* row: covered / healthy / unhealthy with reason ("no delivery for 2 h — polling every 60 s").
- Nav: the admin section gains *GitHub* (one line in `nav.ts`).

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `PUBLIC_URL` | `apps/api` | public HTTPS base GitHub can reach; absent → hook inactive (D14) |
| `APP_URL` | `apps/api` (exists from #22) | browser-facing base for the manifest redirect |
| `APP_ENCRYPTION_KEY` | `apps/api` (exists) | required (D3) |

## Acceptance criteria

- [ ] The manifest built for `PUBLIC_URL=https://dock.example` contains exactly the D2 permissions (all `read`), the D2 events, the hook URL and the redirect URL; without `PUBLIC_URL` the hook is `active: false`.
- [ ] The callback exchanges the code (against a mocked GitHub endpoint), stores the private key, webhook secret and client secret as ciphertext, and none of them appear in any response, log or audit `after` value.
- [ ] **Signature:** a delivery signed with the stored secret is accepted; a wrong signature, a modified body, or a missing header returns 401 and triggers no poll; the same `X-GitHub-Delivery` twice returns 200 `duplicate` and triggers one poll in total.
- [ ] An `issues.labeled` delivery for `AndreyBegma/AgentDock` sends `collector.poll { collectors: ["issues"] }` to the runner of every project with that repo, within 5 s, and writes one `events` row with `source: github`; a `check_run` burst of 20 deliveries in 3 s produces one poll (debounce).
- [ ] A `push` to the base branch polls `prs` and `worktrees`; a push to another branch polls nothing.
- [ ] On the runner, `collector.poll` restarts exactly the named collectors for that project and no others (fake collectors in the registry).
- [ ] With health `healthy`, the `issues` and `prs` collectors poll every 10 minutes (fake clock); switching to `unhealthy` restores 60 s on the next tick without a runner restart.
- [ ] A project whose repo is not in any installation shows `covered: false`, `unhealthy`; installing the App and receiving `installation_repositories` makes it covered after resync.
- [ ] The handler answers within 2 s even when the runner is offline (the poll is attempted after the response and simply fails).
- [ ] Register, manual credentials, resync and delete each write an audit record.
- [ ] **Authorization:** operators and viewers get 403 on every `/admin/github-app*` route; a non-member gets 404 on `/projects/A/github-app`; `collector.poll` cannot be sent from any user-facing route (no endpoint exposes it; asserted by a test over the route table).
- [ ] `bun run check`, `bun run test`, `bun run build` pass.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i27-api | tables, App JWT and installation reads, manifest flow, hook endpoint, mapping, debounce, health, command contract, watch-list field, audit actions, reachability doc | apps/api/prisma/schema.prisma, apps/api/prisma/migrations/20261102000000_github_app/**, apps/api/src/github-app/**, apps/api/src/app.module.ts, packages/shared/src/protocol/commands/github.ts, packages/shared/src/protocol/commands.ts, packages/shared/src/protocol/index.ts, packages/shared/src/protocol/projects.ts, packages/shared/src/audit/actions.ts, docs/architecture/github-app.md | — | yes | opus |
| i27-runner | `collector.poll` handler; interval back-off in `issues` and `prs` collectors | apps/runner/src/commands/github/**, apps/runner/src/collectors/issues/**, apps/runner/src/collectors/prs/**, the runner command handler registry from #5 | i27-api | no | sonnet |
| i27-web | admin page, project status row | apps/web/src/app/admin/integrations/github/**, apps/web/src/app/(app)/projects/[projectId]/settings/**, apps/web/src/lib/github-app/**, apps/web/src/components/shell/nav.ts | i27-api | no | sonnet |

i27-runner and i27-web run in parallel after the lead merges.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/prisma/schema.prisma | i27-api | distinct new tables only; keep both blocks on conflict (#25, #26, #28 run nearby) |
| apps/api/src/app.module.ts | i27-api | append-only registration; keep both imports |
| apps/api/src/main.ts | #26 (i26-core) | not edited here — `rawBody` comes from #26 |
| packages/shared/src/protocol/commands.ts, protocol index.ts | i27-api | append-only registries; keep both |
| packages/shared/src/protocol/projects.ts | i27-api | one optional key added to the watch-list entry; keep both on conflict |
| runner command handler registry (#5) | i27-runner | append-only; keep both |
| apps/runner/src/collectors/issues/**, apps/runner/src/collectors/prs/** | i27-runner | owned by #19 / #11, merged before this item; only the interval read is changed |
| packages/shared/src/audit/actions.ts | i27-api | #8's closed union; appended members only, keep both |
| apps/web/src/app/(app)/projects/[projectId]/settings/** | i27-web | #17's and #10's tabs exist; this item adds one row in its own component file plus one import line; keep both |
| apps/web/src/components/shell/nav.ts | i27-web | one line per entry; keep both |
| bun.lock | regenerated per [#5's rule](5-runner-daemon-and-protocol.md#contention) | — |

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| The home server is not reachable from GitHub, so the App never helps | medium | automatic fallback to 60 s polling (D12); documented tunnel options (D14) |
| A health false-positive slows polling to 10 minutes while events are not arriving | medium | health requires recent verified deliveries (D11); recomputed every 5 minutes; any signature failure flips it |
| Leaked webhook secret lets an attacker trigger polls | low | polls are read-only and debounced; rotate by re-entering credentials |
| Manifest-flow endpoint details change | low | manual credentials fallback; i27-api verifies the endpoints against current GitHub docs |
| Two projects on one repo double the polls | low | debounce is per project; polls are cheap and read-only |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Use the App's installation token on the runner instead of `gh` for reads? | No — the runner keeps its own `gh` (ADR-0004); revisit if rate limits bite |
| Subscribe to `issue_comment` for spec discussions? | No — not read by the queue (#19) |

Depends on #19

Depends on #11

Depends on #26
