# Application shell and live updates

Issue: [#9](https://github.com/AndreyBegma/AgentDock/issues/9) · Roadmap: M1.8 ·
Decisions: [ADR-0008](../adr/0008-local-accounts-with-admin-approved-registration.md),
[ADR-0011](../adr/0011-glass-ui-is-the-component-library.md),
[overview.md](../architecture/overview.md), [ui/screens.md](../ui/screens.md),
[ui/glass-ui.md](../ui/glass-ui.md)

## Summary

#3 ships plain pages; every later screen (projects, fleet, sessions, usage)
needs a frame to live in and a way to change without reloading. This builds the
application shell — navigation rail, project switcher, command palette, theme,
account menu, an Overview placeholder — and the live-update channel: an API
WebSocket `/live` that pushes typed messages on authorized topics, a
`LiveService` other modules publish to, and a `useLive` hook in the web app.
It ships the frame and the pipe; the content that flows through them arrives
with #10 onwards.

## Scope

### In scope

- API: WebSocket gateway `/live` with session-cookie auth and origin check;
  topic subscriptions; a topic-authorizer registry; `LiveService.publish`.
- Shared: typed live messages in `packages/shared/src/live/`.
- Web: `AppShell` (NavRail, project switcher, command palette ⌘K, theme toggle,
  account menu, connection indicator) applied to every signed-in page; the
  Overview page at `/`; `useLive(topic, onMessage)` with reconnect and
  resubscribe; theme bootstrapping without a flash.

### Out of scope

- Domain publishers. No module publishes real events in this item — #10 (projects),
  #11 (fleet) and #12 (sessions) add theirs. The runners page from #6 keeps polling
  until a later item switches it.
- Overview content (KPI tiles, running slots, cost) — #11 and #13 fill it; the
  glass-ui `StatTile` arrives with [glass-ui#67](https://github.com/AndreyBegma/glass-ui/issues/67).
- Project routes and the projects API — #10.
- Notifications centre (M2.7), Activity page (M2.6).

## Decisions

The person delegated all decisions on 2026-10-07; each below is the default
taken, with its source.

| # | Decision | Source |
|---|---|---|
| D1 | The shell is applied by segment layouts, not by moving #3's pages: a route group `apps/web/src/app/(app)/` holds the Overview at `/` (the scaffold's `apps/web/src/app/page.tsx` is deleted), and `apps/web/src/app/admin/layout.tsx` and `apps/web/src/app/account/layout.tsx` wrap their existing pages in `AppShell`. `/login`, `/register`, `/pending` stay outside the shell. URLs do not change. If #3 already created either layout file, this item edits it | new — keeps #3's, #6's and #8's page paths stable |
| D2 | Project routes are `/projects/[projectId]/...`; the switcher navigates there. #10 creates those routes and the `GET /projects` endpoint | new — fixed now so #10 follows it |
| D3 | The project switcher calls `GET /api/projects` and **renders nothing** on 404 or an empty list; once #10 ships the endpoint it appears without a code change | new |
| D4 | Navigation is a registry, `apps/web/src/components/shell/nav.ts`: sections Overview, Project (Fleet, Queue, History, Settings — shown only under `/projects/[projectId]`), Sessions, Usage, Admin (Runners, Users, Audit, Settings — admins only). Each entry has `href`, `label`, `icon` (lucide), `minRole`, `enabled`. Entries for pages that do not exist yet are present with `enabled: false` and are hidden; the issue that builds a page flips its flag (a one-line edit) | docs/ui/screens.md; ADR-0008 |
| D5 | Role awareness is presentation only: the shell hides what the role cannot use; the API remains the authority (#3 guards) | ADR-0008 |
| D6 | Current user: the shell layout fetches `GET /api/auth/me` once on the server side (cookie forwarded) and passes it down; 401 → redirect `/login`, `pending_approval` → `/pending` (#3's middleware still runs first) | #3 D13 |
| D7 | Theme: `system` (default), `dark`, `light`, stored in `localStorage` key `ad-theme`. The root layout `apps/web/src/app/layout.tsx` gets a tiny inline script that sets `data-theme` on `<html>` before paint (no flash). `data-scale="desk"` stays on the root (set by #3) | glass-ui README theme axes [Confirmed] |
| D8 | Command palette (glass-ui `CommandPalette`, ⌘K / Ctrl+K): one command per enabled nav entry, plus "Switch theme", "Log out", and "Go to project…" when the projects endpoint exists | docs/ui/screens.md |
| D9 | Live transport: a NestJS gateway on path `/live` using the `ws` adapter #6 configures in `apps/api/src/main.ts` — this is why the issue depends on #6. The browser connects to `NEXT_PUBLIC_LIVE_URL` (development default `ws://localhost:8180/live`; production `wss://<origin>/api/live` through the reverse proxy). Cookies are scoped by host, not port, so `ad_session` reaches the API in development [Confirmed: RFC 6265 ignores ports]. Proxying the WebSocket through Next's `/api` rewrite is not relied on [Unknown whether Next 16 rewrites proxy upgrades] | overview.md (UI WebSocket); #3 D12 |
| D10 | Auth on upgrade: the gateway reads `ad_session` from the `Cookie` header and validates it with #3's session service; missing or invalid → close 4401. The `Origin` header must equal `WEB_URL` → otherwise close 4403 (cross-site WebSocket hijacking guard; CSRF tokens do not apply to WebSockets). The session is re-validated every 60 s; a disabled user or revoked session is disconnected with 4401 | security.md |
| D11 | Topics: `admin`, `runner:<id>`, `project:<id>`, `user:<id>`. A `TopicAuthorizer` registry maps a prefix to `authorize(user, topic) → boolean`. This item registers `admin` and `runner:` (admins only) and `user:` (own id only). `project:` has no authorizer yet → subscription refused with `unknown_topic`; #10 registers it with the membership check | new |
| D12 | Messages (zod in `packages/shared/src/live/`, exported from the root barrel `packages/shared/src/index.ts` — not a `package.json` subpath, so this item does not touch `packages/shared/package.json` that #5 owns): client → server `subscribe { topic }`, `unsubscribe { topic }`, `ping`; server → client `subscribed { topic }`, `error { topic?, code }`, `event { topic, type, data, ts }`, `pong`. `type` of `event` is a string; each domain adds its own types with their `data` schemas | new |
| D13 | Limits: 50 subscriptions per connection, 5 connections per session, messages ≤ 64 KiB; server pings every 30 s and drops a connection silent for 75 s | new |
| D14 | `LiveService.publish(topic, type, data)` delivers to every authorized subscriber on this API instance. A single API instance is assumed (ADR-0007, one server); multi-instance fan-out is out of scope | ADR-0007 |
| D15 | `useLive(topic, onMessage)` shares one WebSocket per tab, reconnects with backoff (1 s → 30 s, jitter), resubscribes after reconnect, and exposes connection state; the shell shows it as a status dot (glass-ui `Badge` `dot`: connected ok, reconnecting warn, offline neutral) | new |

## API

| Interface | Who | Behaviour |
|---|---|---|
| WS `/live` | active session, matching origin | D9–D13 |
| `LiveService.publish(topic, type, data)` | server code | D14 |
| `TopicAuthorizerRegistry.register(prefix, authorize)` | server code | D11 |

No new REST endpoints.

### Wire details settled during implementation

Decided with the orchestrator on 2026-10-07 while building the gateway; they
refine D10–D13 and do not change them.

| # | Detail |
|---|---|
| W1 | The `event` frame is `{ type: "event", topic, event, data, ts }`: `type` is already the frame discriminator (as in every other message), so the domain type D12 calls "`type` of `event`" travels in the field **`event`** (`runner.status`, …). `LiveService.publish(topic, type, data)` keeps its signature and fills `event` from `type`. |
| W2 | A topic is `admin` or `<runner\|project\|user>:<id>` with `id` matching `[A-Za-z0-9_-]{1,64}`. |
| W3 | Close codes: 4401 no/invalid session (also on re-validation), 4403 missing or foreign `Origin` (checked first, before the session), **4429** when the session already holds 5 sockets — the *new* socket is refused, the older ones stay. A frame over 64 KiB is closed 1009 by `ws` itself; a socket silent past the idle timeout is terminated. |
| W4 | Error codes: `forbidden`, `unknown_topic`, `too_many_subscriptions`, and **`invalid_message`** — a frame that is not JSON, not a known message, or names a malformed topic. The socket stays open. Subscribing to a topic already held answers `subscribed` again; `unsubscribe` has no reply. |
| W5 | Re-validation calls `SessionService.resolve` once per connected session every 60 s. It refreshes the session's `lastSeenAt` about once a minute, so an open, connected tab keeps its session from idling out: an open tab counts as activity. On a valid session each held subscription is re-authorized; one no longer allowed is dropped with `error { topic, code: "forbidden" }`. |
| W6 | `runner:<id>` is role-only (admins), with no check that the runner exists (D11). |
| W7 | `LiveService.publish` returns how many sockets it reached, and throws on a malformed topic or a frame over 64 KiB. |

## UI

| Part | glass-ui | Behaviour |
|---|---|---|
| Rail | `NavRail` (desk) | sections per D4; collapses to icons below 1024 px wide |
| Project switcher | `Combobox` or `Menu` at the top of the rail | D3 |
| Top bar | glass chrome bar | breadcrumb (`Breadcrumb`) of the current route, connection dot, ⌘K hint (`KeyHint`), account menu |
| Account menu | `Avatar` + `Menu` | name, role, Account, Theme (radio items), Log out |
| Command palette | `CommandPalette` | D8 |
| Overview `/` | `Card`, `EmptyState` | three placeholder sections — "Fleet", "Blocked on you", "Cost today" — each an `EmptyState` naming the issue that fills it (#11, #11, #13) |

Glass only for chrome (rail, top bar, palette, menus); page content stays solid
([ui/glass-ui.md](../ui/glass-ui.md)).

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `NEXT_PUBLIC_LIVE_URL` | `apps/web` | WebSocket URL of `/live` (default `ws://localhost:8180/live`) |
| `WEB_URL` | `apps/api` (exists) | allowed `Origin` for `/live` |

Add `NEXT_PUBLIC_LIVE_URL` to `apps/web/.env.example`.

## Acceptance criteria

- [ ] Signed in as admin, `/`, `/account` and every `/admin/*` page render inside the shell; `/login`, `/register`, `/pending` render without it; no URL from #3, #6 or #8 changed.
- [ ] A viewer sees no Admin section in the rail or in the command palette; an admin sees Runners, Users, Audit, Settings.
- [ ] ⌘K (Ctrl+K on Linux) opens the palette; choosing an entry navigates; "Log out" ends the session.
- [ ] Theme choice persists across reloads and there is no flash of the wrong theme on load (checked with a throttled load in the browser).
- [ ] The project switcher is absent while `GET /api/projects` returns 404.
- [ ] A WebSocket to `/live` with a valid session and the right origin can subscribe to `user:<own id>` and receives an `event` published with `LiveService.publish` in an e2e test.
- [ ] **Authorization:** a connection without a session is closed with 4401; with a foreign `Origin` with 4403; a viewer subscribing to `admin` or `runner:<id>` gets `error { code: "forbidden" }`; any user subscribing to `user:<other id>` gets `forbidden`; `project:<id>` gets `unknown_topic` until #10.
- [ ] Disabling a user (via #3's admin API) closes that user's open `/live` connections within 60 s.
- [ ] The 51st subscription on one connection is refused with `too_many_subscriptions`.
- [ ] Killing and restarting the API: the web client reconnects and resubscribes; the connection dot goes warn → ok.
- [ ] `bun run check`, `bun run test`, `bun run build` pass; the gateway is covered by e2e tests with a real WebSocket client.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i9-live | live gateway, topic authorizers, `LiveService`, shared message schemas | apps/api/src/live/**, apps/api/src/app.module.ts, packages/shared/src/live/**, packages/shared/src/index.ts | — | yes | opus |
| i9-shell | shell, layouts, Overview, theme bootstrap, `useLive` | apps/web/src/app/layout.tsx, apps/web/src/app/page.tsx, apps/web/src/app/(app)/layout.tsx, apps/web/src/app/(app)/page.tsx, apps/web/src/app/admin/layout.tsx, apps/web/src/app/account/layout.tsx, apps/web/src/components/shell/**, apps/web/src/lib/live/**, apps/web/.env.example, apps/web/package.json, bun.lock | i9-live | no | sonnet |

i9-shell is cut after i9-live merges: `useLive` imports the shared message schemas.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/api/src/app.module.ts | i9-live | module registration is a one-line append; a conflict (e.g. with #8's `AuditModule`) is resolved by keeping both imports |
| packages/shared/src/index.ts | i9-live (one re-export line) | append-only; keep both lines on conflict (#8 also appends) |
| apps/api/src/main.ts | #6 (merged before this starts) | not opened here — the `ws` adapter is already set |
| packages/shared/package.json | #5 | not touched here (D12) |
| apps/web/src/app/layout.tsx | i9-shell | #8's i8-web may run at the same time and must not open it; it only adds `apps/web/src/app/admin/audit/**`, which inherits the new admin layout |
| apps/web/src/components/shell/nav.ts | i9-shell | later issues flip their entry's `enabled` flag — one-line edits, keep both on conflict |
| bun.lock | regenerated per the rule in [#5's spec](5-runner-daemon-and-protocol.md#contention) | — |

Depends on #3

Depends on #6

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Depending on #6 for the `ws` adapter serializes this item after the runner work and lengthens the path to #10 | medium | accepted: the alternative (a second WebSocket adapter configured here) would make two slots edit `apps/api/src/main.ts` |
| A WebSocket through the production reverse proxy needs `Upgrade` headers | low | same note as #6's risk; documented with the deployment |
| Theme bootstrap script conflicts with a strict Content-Security-Policy later | low | use a nonce or a hashed inline script when a CSP is introduced |
| glass-ui `NavRail` / `CommandPalette` APIs differ from what D4/D8 assume | low | `sonnet` slot adapts to the real API; a missing capability is filed against glass-ui, not written here (ADR-0011) |

## Open questions

| Question | Default if nobody answers |
|---|---|
| Should the rail remember collapsed / expanded per user on the server? | No — `localStorage` only |
| Should the Overview be customizable (widget grid like Mission Control)? | No — fixed sections; revisit after M2 |
