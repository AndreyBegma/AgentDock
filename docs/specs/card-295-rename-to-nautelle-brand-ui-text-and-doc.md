# C-295: Rename to Nautelle: brand, UI text and docs

## What to do
Change every user-visible "AgentDock" to "Nautelle":
- web app: page titles (`· AgentDock`), the wordmark, the sign-in and onboarding text, emails and Telegram bot texts the API sends, the PWA manifest and favicon/app icon (a placeholder Nautelle mark, a sail or a knot, until the person sends a logo);
- docs: README, `docs/**`, CLAUDE.md and AGENTS.md (product name only; ADR file names and historical ADR text stay, each ADR gets no rewrite of history: add a note in a new ADR that records the rename);
- the plugin's user-facing strings in `plugins/agentdock`.
Keep code identifiers, package names, env vars, paths and URLs unchanged here; later cards handle them.

## Acceptance criteria
- [ ] No user-visible "AgentDock" remains in the web app or in API-sent messages (a test greps the built web output and the API message templates).
- [ ] Docs and README say Nautelle; a new ADR records the rename and the four-step plan.
- [ ] `bun run check` passes.

## Context
The product is renamed from **AgentDock** to **Nautelle** (the person's decision, 2026-10-20). "AgentDock" appears about 5,000 times in 1,800 files. The rename runs in four cards, in order: brand → code identifiers → runner and protocol → infrastructure. Run it only when no other card is open: the identifier codemod conflicts with every open PR.

Do **not** create a fallback `AgentDock` repository: GitHub redirects the old name after a rename only while no repository takes that name.
