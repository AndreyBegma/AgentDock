# GitHub App

How AgentDock learns about issue, pull request and check changes the moment
they happen, and what happens when GitHub cannot reach it. Decisions:
[spec 27](../specs/27-github-app.md); actions on GitHub stay on the runner's
`gh` ([ADR-0004](../adr/0004-github-issues-are-the-task-queue.md)).

## What it does, and what it does not

Each project's runner polls its issues and pull requests every 60 s. A GitHub
App registered for the instance pushes the same facts as webhook deliveries.
The API verifies each delivery, maps its repository to projects, and asks each
project's runner to **poll now** (`collector.poll`). The runner's collectors
fetch and emit exactly as before, so they stay the only writers of fleet and
queue state.

The App is **read-only** (Metadata, Issues, Pull requests, Checks, Commit
statuses, Contents — all `read`). The API uses its credentials only to list
installations and their repositories and to check the hook's recent deliveries.
It never writes to GitHub and never reads issue or pull request content through
the App.

```
GitHub ──POST /hooks/github──▶ API ──verify, dedupe, map──▶ 200
                                 │
                                 └─ after the response: debounced
                                    collector.poll ──▶ runner ──gh──▶ GitHub
```

## Reachability

GitHub must reach `<PUBLIC_URL>/hooks/github` over HTTPS. Only that one path
needs to be public; everything else can stay on the private network. The
browser-based registration (manifest flow) needs only the browser to reach
AgentDock, so it works on a home server either way.

| Option | When | Notes |
|---|---|---|
| **Reverse proxy** with a public TLS endpoint (Caddy, nginx, Traefik) | the host has a public IP or port forwarding | expose `POST /hooks/github` only; keep the rest of the API behind the private network or authentication |
| **Tailscale Funnel** | the host is already on a tailnet | `tailscale funnel` a path to the API's port; the `*.ts.net` URL is `PUBLIC_URL` |
| **Cloudflare Tunnel** | no inbound ports at all | `cloudflared` route for one hostname to the API; a path rule can restrict it to `/hooks/github` |

Set `PUBLIC_URL` in `apps/api/.env` to the public HTTPS base **before**
creating the App: the manifest's hook URL is built from it. Created without
`PUBLIC_URL`, the App's hook is **inactive**; enable it later in the App's
settings on GitHub, and re-enter the credentials so AgentDock records the
hook as active.

## When GitHub cannot reach AgentDock

Nothing breaks. A project is `healthy` only while verified deliveries arrive
for its installation (or a resync just confirmed that GitHub's latest delivery
attempt succeeded) and no forged delivery was seen since. Otherwise it is
`unhealthy`, and the runner keeps its 60 s polling. While a project is
`healthy`, the runner relaxes its `issues` and `prs` collectors to 10 minutes;
a `collector.poll` makes them poll immediately in either state. Health is
recomputed every 5 minutes and pushed to the runner in its watch list
(`githubApp: "healthy"`, absent meaning `unhealthy`), so the fallback is
automatic.

## Security

- **Signature.** `X-Hub-Signature-256` is `HMAC-SHA256(webhook secret, raw
  body)`, compared in constant time over the bytes as received, before the body
  is parsed. A missing or wrong signature is `401` with no body; it bumps a
  counter shown on the admin page and makes every project `unhealthy` until the
  next verified delivery.
- **Replay.** `X-GitHub-Delivery` ids are stored for 14 days; a repeat is
  `200 duplicate` and polls nothing. A leaked secret can at most trigger
  read-only, debounced polls; rotate it by re-entering the credentials.
- **Secrets at rest.** The private key, webhook secret and client secret are
  AES-256-GCM ciphertext under `APP_ENCRYPTION_KEY`. Without the key the App
  cannot be registered (`409 encryption_key_missing`). No response, log line
  or audit value carries them.
- **Body size.** Up to 5 MB on `/hooks/github` (`413` beyond); compressed
  bodies are refused.
- **Who manages it.** Admins register, re-enter credentials, resync and delete
  the registration — each audited. Project members see their project's status;
  `collector.poll` is sent only by the API, never from a user route.
