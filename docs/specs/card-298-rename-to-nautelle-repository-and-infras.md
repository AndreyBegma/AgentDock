# C-298: Rename to Nautelle: repository and infrastructure

## What to do
A checklist card; most steps are the person's or the orchestrator's, not a worker's. The worker writes `docs/guides/rename-to-nautelle.md` with every step and its order, and updates every URL in the repository after the rename:
- GitHub: rename `AndreyBegma/AgentDock` → `AndreyBegma/Nautelle` (redirects keep old links working; never re-create `AgentDock`); update git remotes on the devbox and in worktrees;
- Woodpecker: repair the repository after the rename; check secrets and crons survive;
- staging domain (`staging-agentdock.luna-realm.com` → a Nautelle host, with a redirect from the old one), `WEB_URL`/CORS;
- Telegram bot name and description;
- npm and Homebrew tap (from the previous card);
- GlitchTip project name, docker container and compose project names (`agentdock-staging-*`).

## Acceptance criteria
- [ ] The guide lists every step with an owner (person or orchestrator) and a check.
- [ ] Repository URLs point at `AndreyBegma/Nautelle`.
- [ ] Old GitHub and staging links still reach the product.

## Context
The product is renamed from **AgentDock** to **Nautelle** (the person's decision, 2026-10-20). "AgentDock" appears about 5,000 times in 1,800 files. The rename runs in four cards, in order: brand → code identifiers → runner and protocol → infrastructure. Run it only when no other card is open: the identifier codemod conflicts with every open PR.

Do **not** create a fallback `AgentDock` repository: GitHub redirects the old name after a rename only while no repository takes that name.
