# C-296: Rename to Nautelle: workspace packages and code identifiers

## What to do
Codemod the internal names:
- the `@agentdock` package scope → `@nautelle`: `shared` (about 1,700 imports), `web`, `api` and `runner` workspace names, turbo filters, tsconfig paths;
- type, class, constant and test names that carry the product name, where renaming is safe;
- `.woodpecker/**` and scripts that name the workspaces.
Leave env vars, runner paths, the npm runner package, the plugin name, tmux prefixes and the database name to the next card.

## Acceptance criteria
- [ ] `git grep -i` for the old package scope (`@agentdock` followed by a slash) is empty.
- [ ] Build, typecheck, tests and `bun run check` pass; CI is green.

## Context
The product is renamed from **AgentDock** to **Nautelle** (the person's decision, 2026-10-20). "AgentDock" appears about 5,000 times in 1,800 files. The rename runs in four cards, in order: brand → code identifiers → runner and protocol → infrastructure. Run it only when no other card is open: the identifier codemod conflicts with every open PR.

Do **not** create a fallback `AgentDock` repository: GitHub redirects the old name after a rename only while no repository takes that name.
