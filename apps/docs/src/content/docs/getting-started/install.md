---
title: Install
description: Install Nautelle with one command, in one of three exposure modes.
---

Nautelle runs from two published images, `ghcr.io/andreybegma/nautelle-api`
and `ghcr.io/andreybegma/nautelle-web`, with PostgreSQL, Redis and a Caddy
proxy, all from one compose file. Check the [requirements](../requirements/)
first.

## Quick start

```sh
curl -fsSL https://raw.githubusercontent.com/AndreyBegma/Nautelle/main/deploy/compose/install.sh | sh
```

The script creates `./nautelle`, writes `.env` with random database and Redis
passwords, pulls the images, starts everything and waits until the API
answers. On its first start the API migrates the database and generates its
encryption and audit keys into the `data` volume. The script ends with the
address and the one-time setup link: continue with [First run](../first-run/).

An install is two files in `./nautelle`: `docker-compose.yml` and `.env`.
You never edit the compose file; `.env` and an optional `api.env` hold every
setting (see [Configuration](../../configuration/overview/)).

## Options

`install.sh` takes these options; pass them after `sh -s --`, for example
`curl -fsSL …/install.sh | sh -s -- --domain dock.example.com`.

| Option | Meaning |
|---|---|
| `--url <url>` | the address people open (default `http://localhost:8000`) |
| `--tunnel-token <token>` | run behind a Cloudflare tunnel |
| `--domain <domain>` | serve a domain with automatic HTTPS |
| `--admin-email <email>`, `--admin-password <password>` | create the first administrator without the setup page |
| `--port <port>` | the host port in local mode (default 8000, or the `--url` port) |
| `--dir <dir>` | where to install (default `./nautelle`) |
| `--version <X.Y.Z>` | a release instead of `latest` |
| `--no-start` | write the files and `.env`, start nothing |
| `-y` | ask nothing |

Without a flag and with a terminal, a first install asks for the address.

## Exposure modes

The mode is `COMPOSE_PROFILES` in `.env`, and `install.sh` sets it from the
flags. Run `install.sh` again with other flags to switch modes: it stops the
old proxy and keeps every secret.

### Local (default)

Caddy listens on `127.0.0.1:8000`, and only this machine can open Nautelle.

```sh
curl -fsSL …/install.sh | sh -s -- --url http://localhost:8000
```

To open it to your network, give the host's address:
`--url http://192.168.1.20:8000`. Caddy then listens on all interfaces
(`NAUTELLE_BIND=0.0.0.0`).

Over plain HTTP the install runs as `APP_ENV=development`, because a browser
drops `Secure` cookies on plain HTTP, and the GitHub App webhook stays off,
because GitHub cannot reach the host. Use a tunnel or a domain for anything
beyond a trusted network.

### Cloudflare tunnel

No port is opened on the host: `cloudflared` connects out to Cloudflare, and
Caddy is reachable only inside the compose network.

1. In the Cloudflare dashboard, create a tunnel (**Zero Trust › Networks ›
   Tunnels**) and copy its token.
2. Add a public hostname to the tunnel, for example `dock.example.com`, with
   the service `http://proxy:80`.
3. Install:

   ```sh
   curl -fsSL …/install.sh | sh -s -- --tunnel-token <token> --url https://dock.example.com
   ```

### Own domain with HTTPS

Caddy listens on ports 80 and 443 and gets a certificate for the domain from
Let's Encrypt. Point the domain's DNS at the host and open both ports first.

```sh
curl -fsSL …/install.sh | sh -s -- --domain dock.example.com
```

The certificates live in the `caddy-data` volume.

To run Nautelle behind a proxy you already have instead, see
[Reverse proxy](../../operations/reverse-proxy/).
