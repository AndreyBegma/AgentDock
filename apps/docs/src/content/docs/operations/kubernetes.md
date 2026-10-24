---
title: Kubernetes
description: The state of running Nautelle on Kubernetes with a Helm chart.
---

The supported install today is the compose file on one host
([Install](../../getting-started/install/)). A Helm chart for Kubernetes is
being built in card C-376 and
[pull request #911](https://github.com/AndreyBegma/Nautelle/pull/911); this
page will describe it once it ships.

Until then, the pieces a chart has to cover are the same as in the compose
file, `deploy/compose/docker-compose.yml`:

- the API (`ghcr.io/andreybegma/nautelle-api`) with a persistent volume at
  `/data` for `secrets.json` and the attachments, and the settings of
  [Environment variables](../../configuration/environment/);
- the web app (`ghcr.io/andreybegma/nautelle-web`), reaching the API as
  `http://api:8180`;
- PostgreSQL 16 and Redis 7 with a password;
- an ingress that sends `/api/*` to the API with the prefix stripped,
  everything else to the web app, passes WebSockets and accepts 100 MiB bodies
  (see [Reverse proxy](../reverse-proxy/)).

Runners stay on the machines that hold your repositories; they do not run in
the cluster.
