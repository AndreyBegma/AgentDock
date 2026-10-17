# C-122: Security [Medium]: Refuse cleartext server URLs in the runner

> Security audit 2026-10-16 · **WI-20** · severity **Medium** · size **S** · findings: F-20 (Z5 M1)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
F-20 (Z5 M1). `apps/runner/src/server-url.ts:13` accepts `http:` as well as `https:`, and `:31-35` derives `ws:` for it. The runner token, prompts, attachments and session content then travel in cleartext to any host.

**Attacker.** Anyone on the network path between a runner and a server configured with `http://` (shared Wi-Fi, a LAN, a compromised router).

**Scenario.** A runner paired over plain http to a non-loopback host; the attacker reads or rewrites the traffic.

**Impact.** Token theft (then RCE through runner commands) and disclosure of code and prompts.

## Fix
- `normalizeServer` requires `https:` (and so `wss:`).
- Plain `http:` is allowed only for loopback hosts: `localhost`, `127.0.0.0/8`, `::1`.
- Any other `http:` host needs `--insecure` at `pair`; it is stored in the runner's local `runner.json` (`insecureServer: true`) and the server cannot set it.
- With `insecureServer`, `run` and `status` print a loud warning on every start.

## Acceptance criteria
- Unit regression test: `http://dock.lan` is refused without `--insecure`.
- Unit: `http://127.0.0.1:8180`, `http://localhost:8180` and `http://[::1]:8180` are accepted with no flag.
- Unit: `pair --insecure http://dock.lan` is accepted, persists `insecureServer: true`, and `run` and `status` output contain the warning.
- No server message can change `insecureServer`.

## Touches
- apps/runner/src/server-url.ts
- apps/runner/src/pairing.ts
- apps/runner/src/config.ts
- apps/runner/src/cli.ts
- docs/guides/**

## Decision
D-06 — https/wss required; plain http only for loopback; other hosts need a local `--insecure` set at pairing, warned on every start (00-decisions.md)

## Must not run in parallel with
- WI-05
- WI-06
- WI-32


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
