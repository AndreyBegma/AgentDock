# A staging deploy does not drop requests

Issue: [#368](https://github.com/AndreyBegma/AgentDock/issues/368)

## Summary

Every merge into `develop` replaces the staging API container (ADR-0016).
While the new container migrates, seeds and boots (20–60 s), Caddy answers
502 `dial tcp: lookup api: no such host`. On 2026-10-15 there were six
deploys in one hour, and each one:

- dropped the runner's socket (`Connection ended`, then `Expected 101` while
  reconnecting);
- dropped the person's terminal attach;
- lost a click on Stop or Delete.

#353 makes the web recover; this issue makes the proxy not fail in the first
place.

## Decisions

- **D1 — Caddy waits for the API.** `reverse_proxy api:8180` gets `lb_try_duration
  60s` and `lb_try_interval 250ms`, plus an active health check on `/health`
  (`health_uri /health`, `health_interval 2s`). A request or WebSocket upgrade
  that arrives during a restart is held and retried until the API answers,
  instead of a 502. The same applies to `web:3517`.
- **D2 — Restart order.** `refresh.sh` restarts `api` and waits for healthy
  (`docker compose up -d --wait api`) before `web`, so the two are never down
  together.
- **D3 — Open sockets still close.** A WebSocket open at the moment the old
  container stops cannot survive. The runner reconnects as today, and the
  browser reconnects through #353. D1 makes those reconnects succeed on the
  first try, instead of failing for 20–60 s.

## Acceptance criteria

- [ ] On staging, `curl` to `/api/health` in a loop during `refresh.sh`
  never gets a 502. The worst case is one slow response of up to the boot
  time.
- [ ] During a deploy, the runner log shows **one** disconnect and one
  successful reconnect, with no `Expected 101` series.
- [ ] A terminal attach open across a deploy reconnects by itself (with #353),
  and no click made during the restart is lost: it completes when the API is
  back.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i368-deploy | D1, D2 | deploy/staging/Caddyfile, deploy/staging/refresh.sh, deploy/README.md | — | yes | sonnet |

## Open questions

- **Q1 — True zero-downtime (blue/green):** drop `container_name`, start a
  second API, switch, then stop the old one. Default: not now. D1 hides most
  of the gap, and blue/green needs migration discipline (expand/contract) the
  project does not keep yet.
