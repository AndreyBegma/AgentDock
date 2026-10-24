---
title: Reverse proxy
description: Run Nautelle behind Caddy, nginx or Traefik you already have.
---

The install brings its own Caddy, which already splits one origin: `/api/*`
goes to the API and everything else to the web app. If the host already runs a
reverse proxy that holds ports 80 and 443, keep the install in **local mode**
and let your proxy forward the whole site to it.

## Install behind your proxy

```sh
curl -fsSL https://raw.githubusercontent.com/AndreyBegma/Nautelle/main/deploy/compose/install.sh | sh -s -- --url https://dock.example.com --port 8000
```

This writes `NAUTELLE_URL=https://dock.example.com` (so cookies are `Secure`
and the GitHub App webhook is on) and starts the bundled Caddy on
`127.0.0.1:8000` only. Your proxy terminates TLS and forwards everything to
`http://127.0.0.1:8000`.

What your proxy must do:

- Forward **every path**, including `/api/*`, to the one upstream. Do not strip
  `/api`: the bundled Caddy does that.
- Pass **WebSocket upgrades**. The browser's live updates (`/api/live`), the
  terminal and the runners' connection (`/api/runner`) are WebSockets, and the
  runner connection stays open for days.
- Send `X-Forwarded-For` and `X-Forwarded-Proto`. The bundled Caddy trusts
  them from private addresses, which is where a proxy on the same host
  connects from.
- Accept request bodies up to **100 MiB**: a runner uploads a card's demo video
  in one request. Everything else stays under 10 MB.

If your proxy runs on another machine, bind the bundled Caddy to an address
it can reach: `NAUTELLE_BIND=0.0.0.0` in `nautelle/.env` (and a firewall that
lets only the proxy in), then `docker compose up -d`.

## Caddy

```text title="Caddyfile"
dock.example.com {
	request_body {
		max_size 100MiB
	}
	reverse_proxy 127.0.0.1:8000
}
```

Caddy passes WebSockets and the forwarded headers by default.

## nginx

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name dock.example.com;

    ssl_certificate     /etc/letsencrypt/live/dock.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dock.example.com/privkey.pem;

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        # Long-lived WebSockets: the runner connection stays open.
        proxy_read_timeout 1d;
        proxy_send_timeout 1d;
        proxy_buffering off;
    }
}
```

## Traefik

With Traefik in Docker, attach a router to the bundled proxy instead of
publishing a port. Add an override file next to the compose file,
`nautelle/compose.override.yml`, which Docker Compose reads automatically:

```yaml
services:
  proxy:
    ports: !reset []
    labels:
      - traefik.enable=true
      - traefik.http.routers.nautelle.rule=Host(`dock.example.com`)
      - traefik.http.routers.nautelle.entrypoints=websecure
      - traefik.http.routers.nautelle.tls.certresolver=letsencrypt
      - traefik.http.services.nautelle.loadbalancer.server.port=80
      - traefik.docker.network=traefik
    networks: [nautelle, traefik]

networks:
  traefik:
    external: true
```

Replace `traefik`, `websecure` and `letsencrypt` with the network, entry point
and certificate resolver of your Traefik. Traefik passes WebSockets and the
forwarded headers by default and sets no body size limit. `install.sh` never
touches `compose.override.yml`, so the file survives upgrades.

## Without the bundled Caddy

Pointing your proxy straight at the API and web containers is possible but not
supported: you would have to reproduce the `/api` prefix strip, the body
limits and the cache headers of the bundled Caddyfile. Keep the bundled proxy
and forward to it.
