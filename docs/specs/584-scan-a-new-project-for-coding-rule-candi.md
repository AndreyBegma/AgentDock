# C-226: Scan a new project for coding rule candidates on connect

Issue: #584

## What to do
When a project is connected, propose an initial set of rules. The control plane never reads project files (ADR-0001), so add a typed runner command (ADR-0010, advertised per ADR-0023) that reads the conventions the project already documents (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, lint/format configs such as Biome or ESLint, `.editorconfig`) and returns candidate rules as title plus description. Reuse the existing inspection flow that already detects `hasClaudeMd`/`hasAgentsMd` in `apps/runner` and `apps/api`. The API exposes the candidates to the web app, which shows them in the project connect flow and on the Rules screen as suggestions; nothing is saved or enabled until the person accepts it. Candidate text must go through the existing English normalization of stored text (ADR-0027) when saved.

## Acceptance criteria
- [ ] A new typed runner command returns rule candidates; unknown or oversized files are ignored safely.
- [ ] The command is added to the runner's advertised command list and the allowlist.
- [ ] After connecting a project the person sees the candidates and can accept all, some, or none; accepted ones become rules via the rules API.
- [ ] No rule is created or enabled without the person's confirmation.
- [ ] A rescan can be triggered later from the Rules screen without duplicating existing rules.
- [ ] Runner command and API handler have tests; `bun run check` and `bun run test` pass.

## Out of scope
LLM-generated rule inference beyond extracting what the files already state; prompt injection; building the rule list UI itself.

## Open questions
- Extraction method? Default: deterministic parsing of headings and bullet lists from docs plus a small mapping of well-known lint options, no model call.
