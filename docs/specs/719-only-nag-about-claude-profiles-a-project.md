# C-302: Only nag about Claude profiles a project actually uses in the terminal-setup check

Issue: #719

## What happens
The runner detects every Claude Code profile under `~/.claude-profiles` (`agentdock-runner profiles`). On 2026-10-20 the person created a profile `claude-hatkom` that is not used for any Nautelle project. Because it has no agentdock plugin, the terminal-setup checklist (Settings → Sessions) has 3 "To do" steps for it, and Overview's "Needs you" shows "Terminal sessions don't reach the Board" for **every** project on the runner (`apps/web/src/lib/setup/format.ts` `terminalSetupNeed`).

## What to do
- Count a profile in a project's terminal-setup checklist only if it is relevant to that project: the project's default runtime profile, a profile chosen in the project's settings, or a profile that has run a session in that project (manual or card) in the last 30 days.
- Other detected profiles are listed under "Other profiles on this runner" as optional, never as required steps, and never raise an Overview "Needs you" entry.
- Let a person hide a profile from Nautelle on a runner (a per-runner "ignored profiles" list kept by the server; the runner's local policy is unchanged).

## Acceptance criteria
- [ ] A detected profile without the plugin that the project never uses does not create required steps or an Overview entry. API e2e and web tests cover it.
- [ ] The project's default profile without the plugin still does.
- [ ] A person can ignore a profile; it disappears from the checklist and Overview. API e2e covers it.
- [ ] `bun run check` passes.
