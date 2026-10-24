---
title: Troubleshooting
description: Common problems with an install and a runner, and how to fix them.
---

Every command below runs in the install directory, `nautelle/`.
`docker compose ps` shows which service is not healthy, and
`docker compose logs <service>` shows its log: `api`, `web`, `postgres`,
`redis`, and the proxy of your mode (`proxy`, `proxy-tunnel` or `proxy-tls`).

## Install

**The install stops at "Waiting for the API".** It prints the API's log.
`docker compose logs api` shows it again. A database the API cannot reach, or
a `data` volume it cannot write its keys to, stops it at start-up with the
reason.

**Compose says a password must be set.** `.env` lost `POSTGRES_PASSWORD` or
`REDIS_PASSWORD`. Run `install.sh` again: it fills an empty password and never
replaces one. If the database already exists, put the old password back
instead; a new one does not open it.

**The images cannot be pulled on an ARM host.** The published images are
amd64 only for now.

## Signing in

**The setup link says the token is invalid.** The API restarted since the link
was printed; take the current one from the log
([First run](../../getting-started/first-run/)).

**Signing in does nothing on an `http://` address.** The browser dropped the
`Secure` session cookie. Check that `.env` says `APP_ENV=development`;
`install.sh --url http://…` writes it. For anything beyond a trusted network,
use HTTPS instead.

## Exposure modes

**Domain mode has no certificate.** `docker compose logs proxy-tls` shows
Caddy's attempts. The domain's DNS must point at the host, and ports 80 and
443 must be reachable from the internet.

**A tunnel answers 502.** The tunnel's public hostname must point at
`http://proxy:80`. `docker compose logs cloudflared` shows the connection.

**The page loads but never updates live.** A proxy in front of Nautelle does
not pass WebSockets; see [Reverse proxy](../reverse-proxy/).

## Runners

**`pair` refuses the server.** The server address is `NAUTELLE_URL` followed
by `/api`. A runner refuses plain HTTP to any host but localhost; use HTTPS,
or `--insecure` on a trusted network.

**A runner is offline.** On its machine, `nautelle-runner status` says whether
the server answers. `systemctl --user status nautelle-runner` (Linux) or
`~/Library/Logs/nautelle-runner.log` (macOS) shows the daemon. A daemon that
exits with code 78 was told by the server to stop for good — its token was
revoked, another runner took its place, or its protocol is too old — and is
not restarted: pair it again or upgrade it.

**A project shows a policy refusal.** The runner is not allowed to work in the
project's folder. On the runner machine:
`nautelle-runner policy allow-root <folder>`. The server cannot do this for
you ([Runner security](../../concepts/runner-security/)).

**GitHub events arrive late.** Without a working GitHub App webhook, projects
are polled every 60 seconds. **Admin › Integrations › GitHub App** shows why
the webhook is not delivering.

## Still stuck

Search the [issues](https://github.com/AndreyBegma/Nautelle/issues) or open
one with the output of `docker compose ps` and the relevant log, without
secrets.
