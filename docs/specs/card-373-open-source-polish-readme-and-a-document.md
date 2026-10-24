# C-373: Open-source polish: README and a documentation site (install, configure, upgrade, backup)

Runs after C-365 (one-command install). Bar: the READMEs and docs of top self-hosted OSS (Woodpecker, Gitea, Plausible, Immich).

## README.md
Centered hero (logo, one-line pitch, light/dark SVG like DemoFlow's), badges (release, CI, license, Docker pulls/ghcr, docs, Discord if any), a 20–30 s product video/GIF of the Board (record it with DemoFlow once C-371 lands; a screenshot until then), "Features" table, "Quick start" in 3 commands (`curl … install.sh | sh` → open URL → create admin), "How it works" mermaid diagram (control plane ↔ runner ↔ Claude Code/Codex), links to docs, "Contributing", "License". No internal staging details in the README.

## Docs site
Astro Starlight under `apps/docs` (Bun, Biome; static build, light/dark, search), deployed by the release pipeline to GitHub Pages (or the staging host — choose in the ADR of C-365 if it says otherwise). Sections:
- Getting started: Requirements, Install (compose, the three exposure modes: localhost, Cloudflare tunnel, own domain with HTTPS), First run (setup page), Pair a runner, Connect a project/GitHub App.
- Configuration: every env var in one generated table (source of truth: `.env.example` files — a script generates the page, `bun run check` fails when they drift).
- Operations: Upgrade, Backup & restore (Postgres + `/data` volume incl. the generated key file), Reverse proxy examples (Caddy, nginx, Traefik), Kubernetes/Helm (link to the chart card), Troubleshooting, Telemetry/privacy statement.
- Concepts: Board, cards, stacks, fleet, runner security model (links to ADRs).
Move `docs/guides/install.md` from C-365 into the site; keep `docs/` (ADRs/specs) as the engineering authority.
