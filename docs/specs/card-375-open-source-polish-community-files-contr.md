# C-375: Open-source polish: community files — CONTRIBUTING, SECURITY, Code of Conduct, issue and PR templates

Standard GitHub community health files, written for this repo (not boilerplate):
- `CONTRIBUTING.md`: dev setup (Bun, `docker/docker-compose.yml`, `bun run check`, tests), branch model (PRs into `develop`), ADR/spec process from `docs/`, glass-ui rule, commit style, how agent-written PRs are reviewed.
- `SECURITY.md`: supported versions, private reporting via GitHub Security Advisories, response targets, scope (runner execution boundary, ADR-0010/0053).
- `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1, contact address from the person — leave a clear TODO if unknown).
- `.github/ISSUE_TEMPLATE/` (bug with version/runner/OS fields, feature, config.yml pointing questions to Discussions/docs), `.github/pull_request_template.md`.
- `SUPPORT.md`; check `LICENSE` is present and matches package.json `license` fields; add `FUNDING.yml` only if the person has a funding link (else skip).
GitHub's Community Standards page for the repo shows all items checked.
