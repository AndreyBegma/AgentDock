---
title: Kubernetes (Helm)
description: Run the Nautelle control plane on a Kubernetes cluster from the Helm chart.
---

The Helm chart runs the Nautelle control plane on a Kubernetes cluster: the
published `ghcr.io/andreybegma/nautelle-api` and `nautelle-web` images, a Caddy
proxy that gives both one address, and optionally its own PostgreSQL and Redis
([ADR-0092](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0092-nautelle-runs-on-kubernetes-from-a-helm-chart-published-with-each-release.md)).
It is the same install as the compose file of [Install](../../getting-started/install/),
in Kubernetes objects.

The chart is the control plane only. Runners stay on the machines that hold
your repositories, a developer's laptop or a build host, and pair against the
chart's address ([Pairing a runner](#pairing-a-runner)).

You need:

- Kubernetes 1.25 or newer, with amd64 or arm64 nodes;
- Helm 3.8 or newer, for OCI charts;
- a default StorageClass that provides `ReadWriteOnce` volumes, unless you
  bring your own claims;
- to reach it from outside the cluster: an Ingress controller, a Cloudflare
  tunnel or a `LoadBalancer` Service.

## Quick start

```sh
helm install nautelle oci://ghcr.io/andreybegma/charts/nautelle \
  --version X.Y.Z --namespace nautelle --create-namespace
kubectl -n nautelle rollout status deploy/nautelle-api
kubectl -n nautelle port-forward svc/nautelle 8000:80
```

Then open <http://localhost:8000>. The chart's version is the product's: chart
`X.Y.Z` runs the images of release `X.Y.Z`. The releases are listed in
[docs/releases](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/releases/README.md).

On its first start the API waits for the database, migrates it and generates
its encryption and audit keys into the `/data` volume; the startup probe gives
it five minutes. The bundled PostgreSQL and Redis get random passwords, which
the chart keeps in the Secret `nautelle-bundled` across upgrades.

From a checkout of the repository, `helm install nautelle deploy/helm/nautelle`
installs the chart as it is on that branch, with the `:latest` images.

## First run

Open the one-time setup link the API logs and create the first administrator
there ([ADR-0087](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0087-the-first-admin-is-created-in-the-browser-with-a-one-time-setup-token.md)).
Each start of the API logs a new link; to find the current one:

```sh
kubectl -n nautelle logs deploy/nautelle-api | grep -o 'http[^ ]*/setup?token=[^ ]*' | tail -n 1
```

The link starts with `nautelleUrl`. Behind a port-forward it is
`http://localhost:8000/setup?token=…`, which is the default.

For an install nobody opens a browser on, put `ADMIN_EMAIL` and
`ADMIN_PASSWORD` in the API's Secret ([Secrets](#secrets)); the API creates
that account on its first start. Remove them from the Secret afterwards.

## Reaching it

`nautelleUrl` is the address people open. The API's `API_URL`, `WEB_URL`,
`APP_URL` and `PUBLIC_URL` derive from it, as `NAUTELLE_URL` does in the
compose install. An `https://` address runs the API as `APP_ENV=production`
(Secure cookies, the GitHub App webhook on); an `http://` one as
`development`, because a browser drops Secure cookies on plain HTTP. `appEnv`
overrides that.

The Service `nautelle` (port 80) is the proxy: `/api/*` goes to the API with
the prefix stripped, WebSockets included, and everything else to the web app.
Requests are limited to 10 MB. Whatever you put in front of it points at that
Service and nothing else.

### Ingress

```yaml
# values.yaml
nautelleUrl: https://dock.example.com
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: 10m
    nginx.ingress.kubernetes.io/proxy-read-timeout: '3600'
    nginx.ingress.kubernetes.io/proxy-send-timeout: '3600'
  tls:
    enabled: true
    certManager:
      clusterIssuer: letsencrypt
```

```sh
helm install nautelle oci://ghcr.io/andreybegma/charts/nautelle --version X.Y.Z \
  -n nautelle --create-namespace -f values.yaml
```

The host is taken from `nautelleUrl` unless `ingress.host` names another.
With an issuer set, the chart adds cert-manager's
`cert-manager.io/cluster-issuer` (or `cert-manager.io/issuer`) annotation, and
cert-manager writes the certificate into `ingress.tls.secretName` (default
`nautelle-tls`). Without one, that Secret must already exist. TLS ends at the
Ingress controller. The long timeouts keep the runners' WebSockets open; any
controller works, these annotations are ingress-nginx's.

### Cloudflare tunnel

No Ingress and no open port: `cloudflared` runs beside Caddy in the proxy pod
and connects out to Cloudflare.

1. In the Cloudflare dashboard, create a tunnel (Zero Trust → Networks →
   Tunnels) and copy its token.
2. Add a public hostname to the tunnel, for example `dock.example.com`, with
   the service `http://localhost:8080`.
3. Install with the token and the tunnel's address:

   ```sh
   helm install nautelle oci://ghcr.io/andreybegma/charts/nautelle --version X.Y.Z \
     -n nautelle --create-namespace \
     --set nautelleUrl=https://dock.example.com \
     --set tunnel.token=<token>
   ```

To keep the token out of Helm's release history, put it in a Secret of your
own and set `tunnel.existingSecret` (key `TUNNEL_TOKEN`, or
`tunnel.existingSecretKey`) instead of `tunnel.token`.

### LoadBalancer

`--set service.type=LoadBalancer` exposes the proxy directly, over plain
HTTP. Set `nautelleUrl` to the address it gets. Use an Ingress with TLS or a
tunnel for anything beyond a trusted network.

## Secrets

`existingSecret` names a Secret whose every key becomes an environment
variable of the API. It is the place for anything in
[`apps/api/.env.example`](https://github.com/AndreyBegma/Nautelle/blob/develop/apps/api/.env.example) that is a secret:
`DEEPL_API_KEY`, `SPEECH_TO_TEXT_API_KEY`, `ADMIN_EMAIL` and
`ADMIN_PASSWORD`. The Telegram bot, the GitHub App and the LLM provider keys
are set in the web app and need none of this.

```sh
kubectl -n nautelle create secret generic nautelle-api \
  --from-literal=DEEPL_API_KEY=… \
  --from-literal=SPEECH_TO_TEXT_API_KEY=…
helm upgrade nautelle oci://ghcr.io/andreybegma/charts/nautelle --version X.Y.Z \
  -n nautelle --reuse-values --set existingSecret=nautelle-api
```

Settings that are not secret go in `api.env`, a map
(`--set api.env.APP_TIMEZONE=Europe/Berlin`). A value there wins over the one
the chart derives from `nautelleUrl`.

The API generates `APP_ENCRYPTION_KEY`, `AUDIT_HMAC_KEY` and `LLM_SECRETS_KEY`
on its first start and keeps them in `secrets.json` on the `/data` volume. A
key set in `existingSecret` wins over the generated one; never change one once
set. The API reads a changed Secret only when it restarts:
`kubectl -n nautelle rollout restart deploy/nautelle-api`.

## Database and Redis

By default the chart runs PostgreSQL 16 and Redis 7 as one-pod StatefulSets
with their own volumes (8 GiB and 1 GiB). To use your own instead, turn the
bundled one off and give the URL, either directly or in a Secret:

```yaml
postgresql:
  enabled: false
externalDatabase:
  existingSecret: nautelle-database   # a key DATABASE_URL, or existingSecretKey
redis:
  enabled: false
externalRedis:
  url: redis://:password@redis.example.internal:6379/0
```

`externalDatabase.url` and `externalRedis.url` work too; the chart then keeps
them in the Secret `nautelle-external`. The bundled database is PostgreSQL
16; yours should be the same or newer, and its user must be able to create
tables: the API migrates on every start. Redis holds BullMQ's queues and must not evict keys
(`maxmemory-policy noeviction`).

The chart refuses to render a bundled and an external database at once, or
neither, and the same for Redis.

## Settings

The full list, with comments, is
[`values.yaml`](https://github.com/AndreyBegma/Nautelle/blob/develop/deploy/helm/nautelle/values.yaml). The ones you are most
likely to set:

| Value | Default | Meaning |
|---|---|---|
| `nautelleUrl` | `http://localhost:8000` | the address people open |
| `appEnv` | from `nautelleUrl` | `production` or `development` |
| `existingSecret` | none | a Secret of extra API environment |
| `api.env`, `web.env` | `{}` | plain extra environment |
| `api.image.tag`, `web.image.tag` | the chart's `appVersion` | another release's images |
| `web.replicaCount`, `proxy.replicaCount` | 1 | more pods of the stateless parts |
| `ingress.*` | off | see [Ingress](#ingress) |
| `tunnel.token`, `tunnel.existingSecret` | none | see [Cloudflare tunnel](#cloudflare-tunnel) |
| `persistence.size`, `persistence.storageClass`, `persistence.existingClaim` | 5 GiB, the default class | the API's `/data` volume |
| `postgresql.enabled`, `externalDatabase.*` | bundled | see [Database and Redis](#database-and-redis) |
| `redis.enabled`, `externalRedis.*` | bundled | see [Database and Redis](#database-and-redis) |
| `nodeSelector`, `tolerations`, `affinity` | none | every pod; each component's own wins |
| `<component>.resources` | small requests, memory limits | per component |

The API always runs as one pod and is replaced, not rolled: it holds the
runners' WebSockets and the schedules in process, and its `/data` volume is
`ReadWriteOnce`. An upgrade therefore has a short gap while the new API pod
starts; the proxy holds requests for up to a minute meanwhile instead of
answering 502.

## Upgrading

```sh
helm upgrade nautelle oci://ghcr.io/andreybegma/charts/nautelle --version X.Y.Z \
  -n nautelle --reuse-values
```

The API applies new migrations when it starts. The generated passwords stay
as they are. Read the release note of each version you skip.

## Uninstalling

`helm uninstall nautelle -n nautelle` removes the workloads and keeps the
data: the `nautelle-data` volume and the `nautelle-bundled` Secret are marked
to be kept, and Kubernetes keeps the StatefulSets' volumes
(`data-nautelle-postgresql-0`, `data-nautelle-redis-0`). Installing again
with the same release name in the same namespace picks them up. Delete them,
or the namespace, to remove everything.

## Backup

Back up two things together: the database and the `/data` volume. `/data`
holds `secrets.json`, the keys that unseal the secrets in the database, and
the board card attachments; a dump without it cannot be read back. Keep the
values you installed with as well.

```sh
kubectl -n nautelle exec nautelle-postgresql-0 -- pg_dump -U nautelle nautelle > nautelle.sql
kubectl -n nautelle exec deploy/nautelle-api -- tar -cf - -C /data . > data.tar
```

With an external database, dump it with your own tooling. Store `data.tar`
apart from the dump, and as safely: whoever holds both can read every stored
secret. Redis holds only job queues and is not part of the backup.

To restore into a new install, put `/data` back first, then stop the API,
replace the database and start the API again, so it reads the restored keys:

```sh
kubectl -n nautelle exec -i deploy/nautelle-api -- tar -xf - -C /data < data.tar
kubectl -n nautelle scale deploy/nautelle-api --replicas=0
kubectl -n nautelle exec nautelle-postgresql-0 -- psql -U nautelle nautelle -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
kubectl -n nautelle exec -i nautelle-postgresql-0 -- psql -U nautelle nautelle < nautelle.sql
kubectl -n nautelle scale deploy/nautelle-api --replicas=1
```

## Pairing a runner

In Nautelle, open **Admin › Runners › Add runner**, copy the code, then on the
machine that holds your repositories:

```sh
brew install andreybegma/tap/nautelle-runner      # or: npm i -g nautelle-runner
nautelle-runner pair --server <nautelleUrl>/api --code XXXX-XXXX --allow-root ~/dev
nautelle-runner install-service
```

The runner connects out to `<nautelleUrl>/api` and keeps a WebSocket open; it
needs no access to the cluster. A runner refuses plain HTTP to any host but
localhost unless `pair` gets `--insecure`
([apps/runner](https://github.com/AndreyBegma/Nautelle/blob/develop/apps/runner/README.md)). A runner behind a
`kubectl port-forward` stops when the port-forward does, so pair long-lived
runners against an Ingress or a tunnel.

## Troubleshooting

- **The API pod stays in `Init`.** It waits for the bundled PostgreSQL and
  Redis; `kubectl -n nautelle get pods` shows whether they are running and
  `kubectl -n nautelle describe pod nautelle-postgresql-0` why not, usually a
  volume that cannot be provisioned.
- **The API restarts during the first start.** `kubectl -n nautelle logs
  deploy/nautelle-api --previous` shows why. With an external database, check
  `DATABASE_URL` and that the user can create tables.
- **Signing in does nothing on an http:// address.** `nautelleUrl` must be the
  address in the browser, and an `http://` one runs as `development`; check
  `appEnv`.
- **Uploads fail with 413.** The Ingress controller has a body limit of its
  own; raise it to 10 MB (`proxy-body-size` with ingress-nginx).
- **Runners disconnect every minute.** The Ingress controller closes idle
  WebSockets; raise its read and send timeouts.
- **A tunnel answers 502.** The tunnel's public hostname must point at
  `http://localhost:8080`. `kubectl -n nautelle logs deploy/nautelle-proxy -c
  cloudflared` shows the connection.
