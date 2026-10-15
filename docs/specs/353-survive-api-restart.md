# Survive an API restart in the web app

Issue: [#353](https://github.com/AndreyBegma/AgentDock/issues/353)

## Summary

Every merge into `develop` redeploys staging (ADR-0016). For 10–30 seconds,
the proxy cannot reach the API container: Caddy logs `dial tcp: lookup api:
no such host`. On 2026-10-15 the product owner hit four symptoms of this
window in one evening:

- a terminal attach stuck on **Connecting…** forever;
- a click on Delete or Stop that silently did nothing (the request died with a
  5xx, and no audit row was written);
- a toast saying "That card or project no longer exists" for what was a
  missing route;
- a board showing stale data until a manual reload.

The web app should treat "the server is restarting" as a state of its own:
say so, retry what is safe to retry, and never hang.

## Scope

### In scope

- One detector for "the API is unreachable or restarting".
- A visible banner while it lasts.
- Automatic retry of idempotent reads, and a clear failure for writes.
- A terminal attach that times out and reconnects instead of hanging.

### Out of scope

- Zero-downtime deploys (a deploy-side change, ADR-0016).
- Offline queueing of writes.
- The runner's reconnect, which already works.

## Decisions

- **D1 — What counts as restarting.**
  - `fetch` rejects with a network error;
  - the API answers 502, 503 or 504;
  - the live socket (`lib/live/client.ts`) closes abnormally.

  Each of these marks the app **unreachable**. The first successful response
  or live reconnect clears it.
- **D2 — The banner.** While unreachable, a slim app-shell banner (glass-ui)
  says "Reconnecting to AgentDock… (the server may be restarting)". It reuses
  `components/shell/live-status.ts`'s state, so there is one source. It
  appears after 1.5 s, so a blip does not flash it.
- **D3 — Reads retry; writes do not.**
  - In `lib/api.ts`, `GET`/`HEAD` requests that fail per D1 are retried with
    backoff (0.5, 1, 2, 4, 8 s, capped at 30 s in all). When the app becomes
    reachable again, the current page's queries refetch.
  - `POST/PUT/PATCH/DELETE` are **not** retried automatically. They fail with
    one message, "AgentDock was restarting — nothing was changed. Try again",
    and keep the form's input. A 404 from a known route family is not
    reinterpreted. Only D1 conditions get this text.
- **D4 — Terminal attach.** The terminal view (`terminal-view.tsx`) times out
  `connecting` after 10 s. It then reconnects with the same backoff while the
  sheet is open, showing "Reconnecting… (attempt n)". After 30 s it shows
  "Could not connect" with **Retry**. It never sits on Connecting
  indefinitely.
- **D5 — Live events after a gap.** After a live reconnect that followed an
  unreachable period, the board and the open card sheet refetch once, so
  state missed during the gap is not shown stale.

## UI

- `components/shell/`: the banner.
- `lib/api.ts`: D1 detection, D3 retry, and the write error.
- `lib/live/`: the unreachable state and the refetch on recovery (D5).
- `components/terminal/terminal-view.tsx`, `lib/terminal/format.ts`: D4.
- glass-ui components only (ADR-0011). A row in `docs/ui/screens.md` for the
  banner.

## Acceptance criteria

- [ ] With the API stopped (a test double returns 502, then a network error),
  a `GET` used by the board is retried and succeeds once the double answers
  200. The page shows fresh data without a reload.
- [ ] A `DELETE` card during the outage is not retried. It shows "AgentDock was
  restarting — nothing was changed. Try again", and the card is still there.
- [ ] The banner appears after 1.5 s of unreachability and disappears on the
  first success. A 300 ms blip does not show it.
- [ ] A terminal attach whose socket never opens leaves Connecting after 10 s,
  retries, and after 30 s shows Could not connect with Retry.
- [ ] After the live socket reconnects from an outage, the board refetches
  once.
- [ ] A real 404 (an unknown card number) still shows the not-found message.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i353-web | the whole change | apps/web/src/lib/api.ts, apps/web/src/lib/api.test.ts, apps/web/src/lib/live/**, apps/web/src/components/shell/**, apps/web/src/components/terminal/**, apps/web/src/lib/terminal/**, docs/ui/screens.md | — | yes | sonnet |

This is one slot.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| apps/web/src/components/shell/** | i353-web | #337's i337-web also touches the shell (navigation): serialize |

## Risks

- **Low — a retried read hides a real outage.** *Mitigation:* the banner
  shows during retries, and the 30 s cap ends in an error.
- **Low — refetch storms after recovery.** *Mitigation:* one refetch per
  page, debounced.
