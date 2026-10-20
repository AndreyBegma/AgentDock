# Security

## Threat model, briefly

Nautelle can start agents that run in `bypassPermissions` mode on machines
holding source code, GitHub credentials and paid model subscriptions. The
assets are those machines. The main threats:

- a stolen user session or runner token turns into code execution on runners;
- a malicious skill from a public registry;
- an inbound webhook forged to trigger runs;
- a teammate spending the owner's subscription.

## Decisions

| Area | Rule |
|---|---|
| **Agent credentials** | Claude / Codex / `gh` credentials stay on the runner. The control plane never stores or transmits them. Runtime profiles reference config dirs by path only |
| **Runner auth** | one-time pairing code → 256-bit token, stored as argon2id hash; WSS only; revocable; token never logged |
| **Runner commands** | typed allowlist (runner-protocol.md); no shell strings; paths confined to registered project roots and their worktree parent; runner-side policy can disable commands per machine |
| **User auth** | email + password (argon2id); httpOnly, Secure, SameSite=Lax cookie session stored server-side; CSRF token on state-changing requests; login rate limit and a per-(email, IP) exponential wait, no account lock (ADR-0048); session revoke on password change |
| **Registration** | first admin via `bun run admin:create` (CLI, interactive or env); public registration off by default, toggled by admin; new users `pending` until an admin approves and assigns a role in one action |
| **Authorization** | global role × project membership, checked in the API on every request and every runner command |
| **Audit** | append-only `AuditRecord`, each row hashes the previous (`hash = sha256(prevHash ‖ canonical(row))`); a verification job reports breaks; a database trigger rejects UPDATE, DELETE and TRUNCATE; secrets are redacted before hashing; in production the app's DB role should also have no UPDATE/DELETE on the table ([spec 8](../specs/8-audit-log.md)) |
| **Webhooks** | inbound: HMAC-SHA256 over timestamp, delivery id and the raw body, verified in constant time before the body is parsed; ±5-minute window; delivery ids remembered 24 h (replay → 409); per-trigger secret; payload values reach a skill only through allowlisted `{{payload.<path>}}` placeholders, ≤ 500 characters and matching a strict pattern, as data — never a shell. GitHub App: `X-Hub-Signature-256` over the raw body, constant time, 401 with no body; `X-GitHub-Delivery` deduped 14 days (repeat → 200 `duplicate`); a delivery only triggers read-only, debounced polls ([github-app.md](github-app.md)). Outbound: HMAC-SHA256 `X-Nautelle-Signature`, retries with jittered backoff, circuit breaker, delivery log, SSRF guard (below) ([spec 26](../specs/26-webhooks.md)) |
| **Outbound SSRF** | `https://` only unless the host is allowlisted; the host is resolved before every attempt and **every** address is checked — loopback, link-local (incl. `169.254.169.254`), RFC 1918, CGNAT `100.64/10`, ULA `fc00::/7`, unspecified, multicast, reserved, NAT64 / 6to4 and IPv4-mapped forms are refused unless `webhooks.allowedPrivateTargets` names the host or a CIDR covering the address; the connection goes to the checked address (no second lookup); redirects are never followed |
| **Skills** | registry calls proxied through the runner; content hashed and stored; install shows the diff of files it adds; install and run are operator+ and audited |
| **Secrets at rest** | webhook secrets, the Telegram bot token and the GitHub App's private key, webhook secret and client secret encrypted with an app key (`APP_ENCRYPTION_KEY`, AES-256-GCM) |
| **Spend** | budgets per project and user with alert or hard stop (M3) |
| **Terminal attach** | M3, admin only, every attach audited with duration |
| **Local socket** | hook and MCP processes reach the runner daemon only through a unix socket (`0600`, directory `0700`); every call carries a per-session capability token (`NAUTELLE_SESSION_TOKEN` for launched sessions, else issued at `SessionStart`) that binds the session and its project, and the daemon checks the peer pid descends from the session's `claude` where the kernel reports it (card 113); the runner token never leaves the daemon; runner-initiated `local.request` methods are a typed allowlist with a minimum role, acting as the runner's local user capped at `operator` ([ADR-0020](../adr/0020-claude-code-integration-through-the-runner.md)) |
| **Session content** | metadata only by default; per-project opt-in ships hook content redacted on the runner, capped at 16 KiB, kept for a set retention, readable by every project member, purgeable by admins ([ADR-0021](../adr/0021-session-content-is-opt-in-per-project.md), [ADR-0050](../adr/0050-viewers-read-session-content-and-action-request-input.md)) |
| **Remote approval** | away mode routes permission prompts to action requests; operator to decide; no self-approval of orchestrator or PR actions except admins; every decision audited |

## Verifying a Nautelle webhook

Every outbound delivery carries `X-Nautelle-Event`, `X-Nautelle-Delivery`
and `X-Nautelle-Signature: t=<unix seconds>,v1=<hex>`, where hex is
`HMAC-SHA256(secret, "<t>.<raw body>")` and the key is the secret exactly as
shown on create or rotate (its base64url text as UTF-8 bytes). The receiver
checks it against the raw body, before parsing it:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export const verify = (header, rawBody, secret, toleranceSec = 300) => {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
};
```

An inbound trigger is called the same way, with the delivery id signed in:
`X-Nautelle-Timestamp: <t>`, `X-Nautelle-Delivery: <id>`,
`X-Nautelle-Signature: sha256=<hex of HMAC-SHA256(secret, "<t>.<id>.<raw body>")>`.

Until the release that ships with runner 0.16.0, an outbound delivery also
carries the same values under the old `X-AgentDock-*` names, and an inbound
trigger accepts them when the `X-Nautelle-*` header is absent
([ADR-0073](../adr/0073-the-runner-and-its-protocol-are-renamed-nautelle-with-a-compatibility-window.md)).

## Known gaps

- Codex workers cannot be file-fenced inside the worktree the way `fence.py`
  fences Claude workers (ADR-0013); the pre-merge ownership check is
  after-the-fact.
- The cs-init template writes the local PostgreSQL password inline into
  `docker/docker-compose.yml`. Nautelle moved it to `docker/.env` (ignored);
  the template fix is P10 in [plugin changes](../plugin/code-sentinel-changes.md).
