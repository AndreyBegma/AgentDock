# Installing Nautelle

Nautelle runs from two published images, `ghcr.io/andreybegma/nautelle-api`
and `nautelle-web`, with PostgreSQL, Redis and a Caddy proxy, all from one
compose file ([ADR-0088](../adr/0088-nautelle-installs-from-published-images-with-one-compose-file.md)).
This guide is for running Nautelle. To work on its code, follow the quick
start in the [README](../../README.md); the staging deployment has its own
setup in [deploy/README.md](../../deploy/README.md).

You need a Linux host (amd64) with Docker and Docker Compose 2.24 or newer,
and `curl` or `wget`.

## Quick start

```sh
curl -fsSL https://raw.githubusercontent.com/AndreyBegma/Nautelle/main/deploy/compose/install.sh | sh
cd nautelle
docker compose exec api node dist/src/cli/admin-create.js
```

The first command creates `./nautelle`, writes `.env` with random passwords
and keys, pulls the images, starts everything and waits until the API answers.
The API migrates the database on its first start. The last command creates
the first administrator; it asks for an email and a password. Then open
<http://localhost:8000> and sign in.

`install.sh` takes these options; pass them after `sh -s --`:

| Option | Meaning |
|---|---|
| `--url <url>` | the address people open (default `http://localhost:8000`) |
| `--tunnel-token <token>` | run behind a Cloudflare tunnel |
| `--domain <domain>` | serve a domain with automatic HTTPS |
| `--port <port>` | the host port in local mode (default 8000, or the `--url` port) |
| `--dir <dir>` | where to install (default `./nautelle`) |
| `--version <X.Y.Z>` | a release instead of `latest` |
| `--no-start` | write the files and `.env`, start nothing |
| `-y` | ask nothing |

Without a flag and with a terminal, a first install asks for the address.

## Modes

The mode is `COMPOSE_PROFILES` in `.env`. `install.sh` sets it from the flags,
so you never edit the compose file. Run `install.sh` again with other flags to
switch modes: it stops the old proxy and keeps every secret.

### Local (default)

Caddy listens on `127.0.0.1:8000`, and only this machine can open Nautelle.

```sh
curl -fsSL …/install.sh | sh -s -- --url http://localhost:8000
```

To open it to your network, give the host's address:
`--url http://192.168.1.20:8000`. Caddy then listens on all interfaces
(`NAUTELLE_BIND=0.0.0.0`). Over plain HTTP the install runs as
`APP_ENV=development`, because a browser drops `Secure` cookies on plain HTTP,
and the GitHub App webhook stays off, because GitHub cannot reach the host.
Use a tunnel or a domain for anything beyond a trusted network.

### Cloudflare tunnel

No port is opened on the host: `cloudflared` connects out to Cloudflare, and
Caddy is reachable only inside the compose network.

1. In the Cloudflare dashboard, create a tunnel (Zero Trust → Networks →
   Tunnels) and copy its token.
2. Add a public hostname to the tunnel, for example `dock.example.com`, with
   the service `http://proxy:80`.
3. Install:

   ```sh
   curl -fsSL …/install.sh | sh -s -- --tunnel-token <token> --url https://dock.example.com
   ```

### Domain with HTTPS

Caddy listens on ports 80 and 443 and gets a certificate for the domain from
Let's Encrypt. Point the domain's DNS at the host and open both ports first.

```sh
curl -fsSL …/install.sh | sh -s -- --domain dock.example.com
```

The certificates live in the `caddy-data` volume.

## Settings

`nautelle/.env` holds every setting; [`.env.example`](../../deploy/compose/.env.example)
explains each one. The one that matters is `NAUTELLE_URL`, the address people
open. `API_URL`, `WEB_URL`, `APP_URL` and `PUBLIC_URL` derive from it; add one
to `.env` to override it.

Anything else the API reads, such as `DEEPL_API_KEY`, the Telegram bot or the
GitHub App, goes in `nautelle/api.env`, one `KEY=value` per line. See
[`apps/api/.env.example`](../../apps/api/.env.example) for the list. Apply a
change with `docker compose up -d`.

Keep `.env` safe and never change its keys once set: `APP_ENCRYPTION_KEY`,
`AUDIT_HMAC_KEY` and `LLM_SECRETS_KEY` seal stored secrets, and a database
cannot be read without them.

## Upgrading

```sh
cd nautelle
docker compose pull
docker compose up -d
```

The API applies new migrations when it starts. To stay on a release, set
`NAUTELLE_VERSION=X.Y.Z` in `.env`. Running `install.sh` again also upgrades:
it fetches the current compose file, keeps `.env` and pulls the images.

## Backup

Back up three things: the database, the attachments and `.env`.

```sh
cd nautelle
docker compose exec -T postgres pg_dump -U nautelle nautelle > nautelle.sql
docker compose exec -T api tar -cf - -C /data/attachments . > attachments.tar
cp .env env-backup
```

Store `env-backup` apart from the dump: it holds the keys that unseal the
secrets in the database. Redis holds only job queues and is not part of the
backup; a restored install starts with empty queues.

To restore on a new host, run `install.sh --no-start`, put the saved `.env`
in place of the new one, then:

```sh
docker compose up -d postgres
docker compose exec -T postgres psql -U nautelle nautelle < nautelle.sql
docker compose up -d
docker compose exec -T api tar -xf - -C /data/attachments < attachments.tar
```

The volumes are `nautelle_pgdata`, `nautelle_attachments`, `nautelle_redis`
and, in domain mode, `nautelle_caddy-data`, if you prefer to back them up
with your own tooling while the stack is stopped.

## Pairing a runner

The runner works on the machine that holds your repositories, which can be
this host or another one. In Nautelle, open **Admin › Runners › Add runner**,
copy the code, then on that machine:

```sh
brew install andreybegma/tap/nautelle-runner      # or: npm i -g nautelle-runner
nautelle-runner pair --server <NAUTELLE_URL>/api --code XXXX-XXXX --allow-root ~/dev
nautelle-runner install-service
```

The server address is `NAUTELLE_URL` followed by `/api`, for example
`https://dock.example.com/api` or `http://localhost:8000/api`. A runner
refuses plain HTTP to any host but localhost unless `pair` gets `--insecure`
([apps/runner](../../apps/runner/README.md)).

## Troubleshooting

- **The install stops at "Waiting for the API".** It prints the API's log.
  `docker compose logs api` shows it again; `docker compose ps` shows which
  service is not healthy.
- **Signing in does nothing on an http:// address.** Check that `.env` says
  `APP_ENV=development`; `install.sh --url http://…` writes it.
- **Domain mode has no certificate.** `docker compose logs proxy-tls` shows
  Caddy's ACME attempts; DNS must point at the host and ports 80 and 443 must
  be reachable from the internet.
- **A tunnel answers 502.** The tunnel's public hostname must point at
  `http://proxy:80`. `docker compose logs cloudflared` shows the connection.
