# C-376: Open-source polish: Helm chart for Kubernetes installs

Runs after C-365 and C-366 (published images, keys generated on first boot). `deploy/helm/nautelle`:
- Deployments for api and web (published images, version = appVersion), Service, Ingress (class, host, TLS via cert-manager annotations — optional), a PVC for `/data` (attachments + generated keys), probes on the API health endpoint.
- PostgreSQL and Redis: either bundled (simple StatefulSets in the chart, off-able) or external (`externalDatabase.url`, `externalRedis.url` via existing Secrets). No hard dependency on Bitnami charts.
- Values for `NAUTELLE_URL`, secrets via `existingSecret`, resources, nodeSelector/tolerations, Cloudflare tunnel sidecar optional (`tunnel.token`).
- `helm lint` + `helm template` + kubeconform in CI (trusted and PR steps — no secrets needed); chart published as an OCI artifact to ghcr on release.
- Docs page "Kubernetes (Helm)" in the docs site.
Note the person's runner still runs on a developer machine, not in the cluster; the chart is the control plane only.
