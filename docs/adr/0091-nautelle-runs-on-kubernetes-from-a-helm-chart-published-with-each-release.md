# ADR-0091: Nautelle runs on Kubernetes from a Helm chart published with each release

Status: accepted · Date: 2026-10-24 ·
Card: C-376 ·
Spec: [`docs/specs/card-376-open-source-polish-helm-chart-for-kubern.md`](../specs/card-376-open-source-polish-helm-chart-for-kubern.md) ·
Keeps: [ADR-0001](0001-control-plane-and-per-machine-runner.md), [ADR-0053](0053-pull-request-pipelines-are-untrusted.md), [ADR-0071](0071-the-product-is-released-by-version-with-a-changelog-and-release-notes.md), [ADR-0087](0087-the-first-admin-is-created-in-the-browser-with-a-one-time-setup-token.md), [ADR-0088](0088-nautelle-installs-from-published-images-with-one-compose-file.md)

## Context

ADR-0088 made Nautelle installable from published images with one compose
file. Teams that already run a Kubernetes cluster do not want a second kind of
host for one service; they expect a Helm chart they can review, configure with
values and upgrade with the rest of their workloads. The web image bakes a
server-side rewrite of `/api/*` to `http://api:8180`, and the browser expects
the API under `/api` on the page's own origin (ADR-0088 §3). An Ingress can
strip a path prefix only with controller-specific annotations, so the routing
that Caddy does in the compose file has no portable Ingress equivalent.

## Decision

1. **The chart is the control plane only.** `deploy/helm/nautelle` runs the
   API, the web app and a proxy. Runners stay on the machines that hold the
   repositories (ADR-0001) and pair against `<nautelleUrl>/api`; the chart has
   no runner and mounts no project.
2. **A Caddy proxy in the chart gives one origin.** It sends `/api/*` to the
   API with the prefix stripped (WebSockets included, 10 MB bodies) and
   everything else to the web app, as the compose file's Caddy does. The
   Service and the optional Ingress point at the proxy with a single `/` path,
   so any Ingress controller works. The web app's `API_URL` is the API's
   Service.
3. **The API is one replica with `Recreate`.** Its `/data` (`secrets.json`
   and the attachments, ADR-0031) is a `ReadWriteOnce` claim, and the API's
   scheduler and live sockets assume a single process. The claim, like the
   database claims, outlives `helm uninstall`. The startup probe waits for the
   migration that runs before the API listens; liveness and readiness use
   `/health`.
4. **PostgreSQL and Redis are bundled or external, never both.** Bundled,
   each is a plain StatefulSet on the official image, with no chart
   dependency. External, `externalDatabase` and `externalRedis` take a URL or
   a Secret that holds it. A render with both, or neither, fails. Generated
   passwords are read back with `lookup` and kept in a Secret with
   `helm.sh/resource-policy: keep`, so an upgrade never changes them.
5. **One required value, as in compose.** `nautelleUrl` gives `API_URL`,
   `WEB_URL`, `APP_URL` and `PUBLIC_URL`, and the Ingress host when none is
   set; an `https://` address runs as `production`. `existingSecret` adds
   every key of a Secret to the API's environment, for the secrets of
   `apps/api/.env.example` and the headless first administrator (ADR-0087).
6. **A Cloudflare tunnel is a sidecar of the proxy.** `tunnel.token` or
   `tunnel.existingSecret` starts `cloudflared` in the proxy pod, so a cluster
   without an Ingress controller or a public address can still be reached.
7. **The chart is versioned with the product.** `Chart.yaml` holds the
   placeholders `0.0.0` and `latest`: `APP_VERSION` stays in one place
   (ADR-0071). `deploy/helm/release-chart.sh` stamps both versions with
   `X.Y.Z` and, on the tag `vX.Y.Z`, pushes the package to
   `oci://ghcr.io/andreybegma/charts/nautelle` from
   `.woodpecker/release-images.yml`, once the images are pushed. It uses the
   same tag-only `ghcr_token` secret as the images; the manual dry run
   packages the chart and pushes nothing.
8. **Pull requests check the chart without secrets.** The `helm` step of
   `.woodpecker/pipeline.yml` lints every value set in
   `deploy/helm/nautelle/ci`, renders them and checks that contradictory
   settings are refused (`deploy/helm/check-chart.sh`); `kubeconform` checks
   the rendered manifests against the Kubernetes schemas. Neither step mounts
   a volume or reads a secret (ADR-0053). Every third-party image the chart
   renders is pinned by digest, and `check-chart.sh` fails on one that is not.

## Consequences

- The chart package must be made public on GHCR, like the images, before an
  install can pull it without a login (deploy/README.md, one-time setup).
- A release now publishes a chart too; a failed chart push leaves the images
  of that release published without a chart, and the step can be re-run.
- An upgrade stops the API before the new one starts, so the board is
  unavailable for the migration and the start (single replica, `Recreate`).
- A backup is the database and the API's claim together, as in ADR-0088.
- The images are amd64 only (ADR-0088), so the chart runs on amd64 nodes only.
- The API process does not handle `SIGTERM`, so a pod waits the whole grace
  period before it stops; the compose install has the same delay.
