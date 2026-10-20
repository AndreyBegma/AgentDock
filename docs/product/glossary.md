# Glossary

| Term | Meaning |
|---|---|
| **Control plane** | `apps/api` + `apps/web` + PostgreSQL. Stores everything, serves the UI, never touches a project's filesystem |
| **Runner** | `apps/runner`, a daemon on each machine that hosts projects and agents. Observes and executes on behalf of the control plane |
| **Pairing** | exchanging a one-time code for a runner token |
| **Project** | a git repository on a runner, connected by path |
| **Docs source** | where a project's specs / ADRs / roadmap live — in-repo folder or a separate repository |
| **Runtime** | an agent CLI: `claude` or `codex` |
| **Runtime profile** | how to launch a runtime on a runner: binary, environment (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), extra args. E.g. `claude-blacktoorroot` |
| **Adapter** | runner code that launches, observes and parses one runtime |
| **Orchestrator** | a session running `/code-sentinel:orchestrator` for one project |
| **Round** | one orchestrator pass that writes `round-<HHMM>.md` |
| **Slot** | one unit of dispatched work: `i<issue>` or `i<issue>-<part>`, one worktree, one tmux session `cs-<slot>` |
| **Worker** | the session in a slot (`/code-sentinel:worker`) |
| **Brief** | the slot's assignment, `.orchestrator-brief.md` |
| **Checkpoint** | a worker report heading: picked up · plan ready · implementation done · pull request open · blocked · misclassified |
| **Fence** | a slot's `owns:` / `never:` globs, enforced by `fence.py` for Claude workers |
| **Ready label** | `cs:ready` (configurable); marks an issue dispatchable |
| **Skill run** | a headless session running one skill on one project |
| **Board** | a project's own work board (`/projects/<id>/board`): To Do → In progress → Finished → Completed. Not the Queue's board view, which shows GitHub issues for the fleet (ADR-0024) |
| **Card** | a work item on the Board, numbered `C-<n>` per project and stored by Nautelle, not GitHub. Run starts a dedicated interactive worker for it, outside the orchestrator |
| **Card round** | one Run or one feedback of a card: a resumed turn of the card's Claude session with its own `runs` row. Not an orchestrator **Round** |
| **Schedule** | a cron rule that creates skill runs or orchestrator commands |
| **API-equivalent cost** | what the recorded tokens would cost at public API prices, regardless of subscription |
| **Budget** | spend limit per project or user per period; alert or hard stop |
